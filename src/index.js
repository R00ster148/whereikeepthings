import { DurableObject } from "cloudflare:workers";

const MAX_PLAYERS = 8;
const MAX_MSG_LEN = 9000; // room for the host's enemy list + level + boss attacks, or a voice chat offer
const COLORS = 8;         // 0 = blue (first player), 1-7 handed out randomly
const NAME_RE = /^[A-Za-z0-9 _-]{3,16}$/;
const MAIN = "MAIN";      // the always-on shared room
// Cosmetics shop: price of every item in each slot (item 0 is free). Keep in sync with COSMETICS in public/index.html.
const SHOP = {
  skin: [0, 15000, 30000, 50000, 80000, 150000, 400000],
  trail: [0, 20000, 40000, 60000, 90000, 200000],
  aura: [0, 25000, 70000, 120000, 250000],
  tag: [0, 60000, 100000, 500000],
};
const shopPrice = (slot, i) => Object.hasOwn(SHOP, slot) && Number.isInteger(i) ? SHOP[slot][i] : undefined;
// Admins are set in wrangler.toml: ADMINS = "Name1,Name2" (account names, not case-sensitive)
const isAdmin = (env, name) => !!name && String(env.ADMINS || "").split(",").map(n => n.trim().toLowerCase()).filter(Boolean).includes(name.toLowerCase());

// ---------- Game room: relays messages ----------
export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    // Keep-alive "p" gets "o" back from Cloudflare without waking the room.
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair("p", "o"));
  }

  // The main room remembers how far everyone got, even when it's empty
  async savedLevel() {
    if (this.lvl === undefined) this.lvl = (await this.ctx.storage.get("level")) || 1;
    return this.lvl;
  }

  async fetch(request) {
    let sockets = this.ctx.getWebSockets();
    const room = request.headers.get("X-Room") || "";
    const main = room === MAIN;
    const name = request.headers.get("X-Player-Name") || "Guest";
    const admin = request.headers.get("X-Admin") === "1";
    // Same account joining again (refresh, dropped Wi-Fi, second tab): drop the old connection so there's no leftover copy
    let keepColor = null;
    if (name !== "Guest") {
      for (const ws of sockets) {
        const a = ws.deserializeAttachment();
        if (!a || a.n !== name) continue;
        keepColor = a.c;
        this.broadcast(ws, JSON.stringify(["l", a.id]));
        ws.serializeAttachment({ ...a, gone: true });
        try { ws.close(4000, "Joined again"); } catch {}
      }
      sockets = sockets.filter(ws => !(ws.deserializeAttachment() || {}).gone);
    }
    const pass = main ? "" : request.headers.get("X-Pass") || "";
    // The first player picks the mode and password; everyone after inherits them
    const wanted = request.headers.get("X-Mode");
    let mode = main ? "coop" : wanted === "pvp" || wanted === "tdm" ? wanted : "coop", roomPass = pass;

    const used = new Set(), snapshot = [];
    let first = true;
    for (const ws of sockets) {
      const a = ws.deserializeAttachment();
      if (!a) continue;
      if (first) { mode = a.m || mode; roomPass = a.p || ""; first = false; }
      used.add(a.c);
      if (a.s) snapshot.push([a.id, a.s, a.c, a.n, a.tm]);
    }
    // Team deathmatch: join whichever team is smaller (0 = blue, 1 = red)
    let team = 0;
    if (mode === "tdm") {
      let blue = 0, red = 0;
      for (const ws of sockets) { const a = ws.deserializeAttachment(); if (a) a.tm === 1 ? red++ : blue++; }
      team = red < blue ? 1 : 0;
    }
    if (sockets.length && roomPass && roomPass !== pass) return new Response("Wrong password", { status: 403 });
    if ((this.kicked || {})[name] > Date.now()) return new Response("Kicked", { status: 403 }); // kicked: 1 minute before you can rejoin
    if (sockets.length >= MAX_PLAYERS) return new Response("Room full", { status: 403 });

    let c = 0;
    if (keepColor !== null && !used.has(keepColor)) c = keepColor; // come back as the same colour
    else if (sockets.length) {
      const all = Array.from({ length: COLORS - 1 }, (_, i) => i + 1);
      const free = all.filter(i => !used.has(i));
      const pool = free.length ? free : all;
      c = pool[Math.floor(Math.random() * pool.length)];
    }

    // Ids sort by join time, so every client agrees on who joined first.
    const id = Date.now().toString(36) + crypto.randomUUID().slice(0, 3);
    const level = main ? await this.savedLevel() : 1;
    const [client, server] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id, c, n: name, m: mode, r: room, p: roomPass, adm: admin, tm: team, mu: request.headers.get("X-Muted") === "1", s: null });
    server.send(JSON.stringify(["hi", id, c, snapshot, mode, level, team]));
    await this.report(null);
    return new Response(null, { status: 101, webSocket: client });
  }

  // Used by the join screen to ask "is this room private, and is this password right?"
  // Called by the Worker for admin moderation commands
  moderate(action, name, text) {
    const lname = String(name || "").toLowerCase();
    let found = false;
    for (const ws of this.ctx.getWebSockets()) {
      const a = ws.deserializeAttachment();
      if (!a || a.gone) continue;
      if (action === "announce") { try { ws.send(JSON.stringify(["a", text])); } catch {} continue; }
      if ((a.n || "").toLowerCase() !== lname) continue;
      found = true;
      if (action === "mute" || action === "unmute") { a.mu = action === "mute"; ws.serializeAttachment(a); continue; }
      // kick or ban: remove them from the room
      this.broadcast(ws, JSON.stringify(["l", a.id]));
      this.broadcast(ws, JSON.stringify(["s", `${a.n} was ${action === "kick" ? "kicked" : "banned"}${text ? ": " + text : ""}`]));
      ws.serializeAttachment({ ...a, gone: true });
      try { ws.close(action === "kick" ? 4001 : 4003, String(text || "").slice(0, 100)); } catch {}
      if (action === "kick") (this.kicked = this.kicked || {})[a.n] = Date.now() + 60000;
    }
    if (found && (action === "kick" || action === "ban")) this.ctx.waitUntil(this.report(null));
    return found;
  }

  check(hash) {
    const s = this.ctx.getWebSockets().filter(ws => !(ws.deserializeAttachment() || {}).gone);
    if (!s.length) return { exists: false };
    const a = s[0].deserializeAttachment() || {};
    return { exists: true, private: !!a.p, ok: !a.p || a.p === hash, mode: a.m };
  }

  // Tell the lobby list who's in this room (only on join/leave/new record, so it costs almost nothing)
  async report(leaving) {
    const open = this.ctx.getWebSockets().filter(s => s !== leaving && s.readyState === 1 && !(s.deserializeAttachment() || {}).gone);
    const any = this.ctx.getWebSockets().map(s => s.deserializeAttachment()).find(Boolean);
    if (!any || !any.r) return;
    const names = open.map(s => (s.deserializeAttachment() || {}).n).filter(Boolean).slice(0, 8);
    const level = any.r === MAIN ? await this.savedLevel() : 0;
    try {
      await this.env.BOARD.get(this.env.BOARD.idFromName("global")).roomUpdate(any.r, open.length, any.m, names, !!any.p, level);
    } catch {}
  }

  async webSocketMessage(ws, msg) {
    if (typeof msg !== "string" || msg.length > MAX_MSG_LEN) return;
    let d;
    try { d = JSON.parse(msg); } catch { return; }

    const a = ws.deserializeAttachment();
    if (!a || a.gone) return;
    // Voice chat setup ["v", toId, payload]: passed straight to that one player (the audio itself goes peer to peer)
    if (Array.isArray(d) && d[0] === "v") {
      if (a.mu || typeof d[1] !== "string" || typeof d[2] !== "string" || d[2].length > 8000) return; // muted players can't talk either
      for (const peer of this.ctx.getWebSockets()) {
        const b = peer.deserializeAttachment();
        if (b && !b.gone && b.id === d[1]) { try { peer.send(JSON.stringify(["v", a.id, d[2]])); } catch {} break; }
      }
      return;
    }
    if (!valid(d)) return;
    if (d.length === 13 && !a.adm) d.length = 12; // only admins can send commands
    if (a.mu && d[9]) d[9] = null;                 // muted: chat is dropped
    a.s = d.slice(0, 5); // last state (no events) for late joiners
    ws.serializeAttachment(a);
    this.broadcast(ws, JSON.stringify(["u", a.id, d, a.c, a.n, a.tm || 0]));

    // Main room: save the level whenever the squad reaches a new one
    if (a.r === MAIN && Array.isArray(d[7]) && Array.isArray(d[7][2]) && Number.isFinite(d[7][2][0])) {
      const lvl = Math.min(9999, Math.floor(d[7][2][0]));
      if (lvl > await this.savedLevel()) {
        this.lvl = lvl;
        await this.ctx.storage.put("level", lvl);
        await this.report(null);
      }
    }
  }

  async webSocketClose(ws) { await this.leave(ws); }
  async webSocketError(ws) { await this.leave(ws); }

  async leave(ws) {
    const a = ws.deserializeAttachment();
    if (a && !a.gone) this.broadcast(ws, JSON.stringify(["l", a.id]));
    try { ws.close(1000, "bye"); } catch {}
    if (a) await this.report(ws);
  }

  broadcast(from, out) {
    for (const peer of this.ctx.getWebSockets()) {
      if (peer !== from && !(peer.deserializeAttachment() || {}).gone) { try { peer.send(out); } catch {} }
    }
  }
}

// [x, y, hp, flags, score, shots[], hits[], world|null, sentAt, chat|null, vx, vy, adminCommand?]
function valid(d) {
  return Array.isArray(d) && (d.length === 12 || (d.length === 13 && typeof d[12] === "string" && d[12].length <= 60)) &&
    d.slice(0, 5).every(Number.isFinite) &&
    Array.isArray(d[5]) && d[5].length <= 4 &&
    Array.isArray(d[6]) && d[6].length <= 16 &&
    (d[7] === null || Array.isArray(d[7])) &&
    Number.isFinite(d[8]) &&
    (d[9] === null || (typeof d[9] === "string" && d[9].length <= 100)) &&
    Number.isFinite(d[10]) && Number.isFinite(d[11]);
}

// ---------- Player profiles, leaderboard and live room list (one shared SQLite database) ----------
export class Board extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.sql = ctx.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY, name TEXT NOT NULL, lname TEXT UNIQUE NOT NULL, token TEXT UNIQUE NOT NULL,
      xp INTEGER NOT NULL DEFAULT 0, best_score INTEGER NOT NULL DEFAULT 0, best_level INTEGER NOT NULL DEFAULT 0,
      created INTEGER NOT NULL)`);
    this.sql.exec("CREATE INDEX IF NOT EXISTS by_score ON players (best_score DESC)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS by_level ON players (best_level DESC, best_score DESC)");
    this.sql.exec("CREATE INDEX IF NOT EXISTS by_xp ON players (xp DESC)");
    try { this.sql.exec("ALTER TABLE players ADD COLUMN pvp_kills INTEGER NOT NULL DEFAULT 0"); } catch {} // already there
    this.sql.exec("CREATE INDEX IF NOT EXISTS by_pvp ON players (pvp_kills DESC)");
    this.sql.exec(`CREATE TABLE IF NOT EXISTS rooms (
      code TEXT PRIMARY KEY, players INTEGER NOT NULL, mode TEXT NOT NULL, names TEXT NOT NULL, updated INTEGER NOT NULL)`);
    try { this.sql.exec("ALTER TABLE rooms ADD COLUMN private INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { this.sql.exec("ALTER TABLE players ADD COLUMN ach TEXT NOT NULL DEFAULT '[]'"); } catch {}
    try { this.sql.exec("ALTER TABLE players ADD COLUMN banned TEXT"); } catch {}         // null = not banned, otherwise the reason
    try { this.sql.exec("ALTER TABLE players ADD COLUMN muted INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { this.sql.exec("ALTER TABLE players ADD COLUMN last_ip TEXT"); } catch {}
    this.sql.exec("CREATE TABLE IF NOT EXISTS ipbans (ip TEXT PRIMARY KEY, name TEXT NOT NULL)");
    try { this.sql.exec("ALTER TABLE rooms ADD COLUMN level INTEGER NOT NULL DEFAULT 0"); } catch {}
    // Credits: points earned in game, spent in the shop. Separate from XP, so buying things never lowers your rank.
    try { this.sql.exec("ALTER TABLE players ADD COLUMN credits INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { this.sql.exec("ALTER TABLE players ADD COLUMN credit_at INTEGER NOT NULL DEFAULT 0"); } catch {}
    try { this.sql.exec("ALTER TABLE players ADD COLUMN owned TEXT NOT NULL DEFAULT '[]'"); } catch {}
    try { this.sql.exec("ALTER TABLE players ADD COLUMN equip TEXT NOT NULL DEFAULT '{}'"); } catch {}
  }

  roomUpdate(code, players, mode, names, priv, level) {
    if (players <= 0 && code !== MAIN) { this.sql.exec("DELETE FROM rooms WHERE code = ?", code); return; }
    this.sql.exec(`INSERT INTO rooms (code, players, mode, names, updated, private, level) VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(code) DO UPDATE SET players = excluded.players, mode = excluded.mode, names = excluded.names,
      updated = excluded.updated, private = excluded.private, level = excluded.level`,
      code, Math.max(0, players), mode, JSON.stringify(names), Date.now(), priv ? 1 : 0, level || 0);
  }
  listRooms() {
    this.sql.exec("DELETE FROM rooms WHERE updated < ? AND code != ?", Date.now() - 12 * 3600 * 1000, MAIN);
    this.sql.exec("INSERT OR IGNORE INTO rooms (code, players, mode, names, updated, private, level) VALUES (?, 0, 'coop', '[]', ?, 0, 1)", MAIN, Date.now());
    return this.sql.exec("SELECT code, players, mode, names, private, level FROM rooms ORDER BY (code = ?) DESC, players DESC, updated DESC LIMIT 20", MAIN)
      .toArray().map(r => [r.code, r.players, r.mode, JSON.parse(r.names), !!r.private, r.level]);
  }

  async register(name) {
    name = String(name || "").trim().replace(/\s+/g, " ");
    if (!NAME_RE.test(name)) return { error: "Use 3-16 letters, numbers, spaces, _ or -" };
    if (this.sql.exec("SELECT 1 FROM players WHERE lname = ?", name.toLowerCase()).toArray().length) {
      return { error: "That name is taken" };
    }
    const token = randomToken();
    this.sql.exec("INSERT INTO players (name, lname, token, created) VALUES (?, ?, ?, ?)",
      name, name.toLowerCase(), await sha256(token), Date.now());
    return { token, profile: { name, xp: 0, bestScore: 0, bestLevel: 0, pvpKills: 0, admin: isAdmin(this.env, name), ach: [], credits: 0, owned: [], equip: {} } };
  }

  async find(token) {
    if (typeof token !== "string" || token.length < 8 || token.length > 64) return null;
    return this.sql.exec("SELECT * FROM players WHERE token = ?", await sha256(token.toUpperCase())).toArray()[0] || null;
  }

  ipBanned(ip) { return !!ip && this.sql.exec("SELECT 1 FROM ipbans WHERE ip = ?", ip).toArray().length > 0; }
  seen(token, ip) { if (ip) this.find(token).then(r => { if (r) this.sql.exec("UPDATE players SET last_ip = ? WHERE id = ?", ip, r.id); }); }

  // Admin moderation. Returns the target's exact name so the Worker can find their rooms.
  async mod(token, action, target, reason, raw) {
    const me = await this.find(token);
    if (!me || !isAdmin(this.env, me.name)) return { error: "Not an admin" };
    if (action === "bans") {
      const rows = this.sql.exec("SELECT name, banned FROM players WHERE banned IS NOT NULL ORDER BY name").toArray();
      const ips = this.sql.exec("SELECT name FROM ipbans").toArray().map(r => r.name);
      return { ok: true, bans: rows.map(r => [r.name, r.banned, ips.includes(r.name)]) };
    }
    if (action === "announce") return { ok: true };
    // Names can contain spaces: if only raw text was sent, use the longest run of words that is a real name
    let who = null, why0 = reason;
    if (raw) {
      const words = String(raw).trim().split(/\s+/);
      for (let k = words.length; k > 0 && !who; k--) {
        who = this.sql.exec("SELECT * FROM players WHERE lname = ?", words.slice(0, k).join(" ").toLowerCase()).toArray()[0] || null;
        if (who) why0 = words.slice(k).join(" ");
      }
      target = raw;
    } else who = this.sql.exec("SELECT * FROM players WHERE lname = ?", String(target || "").toLowerCase()).toArray()[0];
    if (!who) return { error: `No player called ${target}` };
    reason = why0;
    if (action !== "unban" && action !== "unmute" && isAdmin(this.env, who.name)) return { error: "You can't do that to an admin" };
    const why = String(reason || "").slice(0, 100);
    if (action === "ban" || action === "ipban") {
      this.sql.exec("UPDATE players SET banned = ? WHERE id = ?", why || "Banned by an admin", who.id);
      if (action === "ipban" && who.last_ip) this.sql.exec("INSERT OR REPLACE INTO ipbans (ip, name) VALUES (?, ?)", who.last_ip, who.name);
    } else if (action === "unban") {
      this.sql.exec("UPDATE players SET banned = NULL WHERE id = ?", who.id);
      this.sql.exec("DELETE FROM ipbans WHERE name = ?", who.name);
    } else if (action === "mute" || action === "unmute") {
      this.sql.exec("UPDATE players SET muted = ? WHERE id = ?", action === "mute" ? 1 : 0, who.id);
    }
    const rooms = this.sql.exec("SELECT code, names FROM rooms").toArray()
      .filter(r => JSON.parse(r.names).some(n => n.toLowerCase() === who.lname)).map(r => r.code);
    return { ok: true, name: who.name, reason: why, rooms, ipMissing: action === "ipban" && !who.last_ip };
  }

  async login(token) {
    const r = await this.find(token);
    return r ? { name: r.name, xp: r.xp, bestScore: r.best_score, bestLevel: r.best_level, pvpKills: r.pvp_kills,
      admin: isAdmin(this.env, r.name), ach: JSON.parse(r.ach || "[]"), banned: r.banned || null, muted: !!r.muted,
      credits: r.credits || 0, owned: JSON.parse(r.owned || "[]"), equip: JSON.parse(r.equip || "{}") } : null;
  }

  async submit(token, s) {
    const r = await this.find(token);
    if (!r) return null;
    this.sql.exec(`UPDATE players SET best_score = MAX(best_score, ?), best_level = MAX(best_level, ?), xp = MAX(xp, ?),
      pvp_kills = MAX(pvp_kills, ?) WHERE id = ?`,
      clamp(s.score, 1e8), clamp(s.level, 9999), clamp(s.xp, 1e8), clamp(s.pvpKills, 1e7), r.id);
    // Credits earned since the last submit. Capped by time since the last payout, so a tampered client can't mint
    // millions at once. Whatever isn't accepted stays with the client and is sent again next time.
    let accepted = 0;
    const earn = clamp(s.earn, 5e6);
    if (earn > 0) {
      const now = Date.now(), since = Math.min(600, Math.max(0, (now - (r.credit_at || 0)) / 1000));
      accepted = Math.min(earn, Math.floor(since * 6000) + 5000);
      this.sql.exec("UPDATE players SET credits = credits + ?, credit_at = ? WHERE id = ?", accepted, now, r.id);
    }
    return { profile: await this.login(token), accepted };
  }

  async buy(token, slot, i) {
    const r = await this.find(token);
    if (!r) return { error: "Unknown login code" };
    const price = shopPrice(slot, i);
    if (price === undefined) return { error: "That item doesn't exist" };
    const owned = JSON.parse(r.owned || "[]"), key = `${slot}:${i}`;
    if (i === 0 || owned.includes(key)) return { error: "You already own that" };
    if ((r.credits || 0) < price) return { error: "Not enough credits" };
    owned.push(key);
    const equip = JSON.parse(r.equip || "{}");
    equip[slot] = i; // wear it straight away
    this.sql.exec("UPDATE players SET credits = credits - ?, owned = ?, equip = ? WHERE id = ?", price, JSON.stringify(owned), JSON.stringify(equip), r.id);
    return { profile: await this.login(token) };
  }

  async equip(token, slot, i) {
    const r = await this.find(token);
    if (!r) return { error: "Unknown login code" };
    if (shopPrice(slot, i) === undefined) return { error: "That item doesn't exist" };
    if (i !== 0 && !JSON.parse(r.owned || "[]").includes(`${slot}:${i}`)) return { error: "You don't own that yet" };
    const equip = JSON.parse(r.equip || "{}");
    equip[slot] = i;
    this.sql.exec("UPDATE players SET equip = ? WHERE id = ?", JSON.stringify(equip), r.id);
    return { profile: await this.login(token) };
  }

  // Admin only: give (or with a negative amount, take) credits
  async adminCredits(token, target, amount) {
    const r = await this.find(token);
    if (!r || !isAdmin(this.env, r.name)) return { error: "Not an admin" };
    const who = target ? this.sql.exec("SELECT * FROM players WHERE lname = ?", String(target).toLowerCase()).toArray()[0] : r;
    if (!who) return { error: `No player called ${target}` };
    const n = Math.max(-1e9, Math.min(1e9, Math.floor(Number(amount) || 0)));
    this.sql.exec("UPDATE players SET credits = MAX(0, credits + ?) WHERE id = ?", n, who.id);
    return { ok: true, name: who.name, credits: this.sql.exec("SELECT credits FROM players WHERE id = ?", who.id).one().credits };
  }

  async unlock(token, id) {
    const r = await this.find(token);
    if (!r || typeof id !== "string" || !/^[a-z0-9_]{2,24}$/.test(id)) return null;
    const list = JSON.parse(r.ach || "[]");
    if (!list.includes(id) && list.length < 100) { list.push(id); this.sql.exec("UPDATE players SET ach = ? WHERE id = ?", JSON.stringify(list), r.id); }
    return list;
  }

  // Admin only: set anyone's XP exactly (so ranks can go down as well as up)
  async adminSetXp(token, target, xp) {
    const r = await this.find(token);
    if (!r || !isAdmin(this.env, r.name)) return { error: "Not an admin" };
    const who = target ? this.sql.exec("SELECT * FROM players WHERE lname = ?", String(target).toLowerCase()).toArray()[0] : r;
    if (!who) return { error: `No player called ${target}` };
    this.sql.exec("UPDATE players SET xp = ? WHERE id = ?", clamp(xp, 1e8), who.id);
    return { ok: true, name: who.name, xp: clamp(xp, 1e8) };
  }

  top(by) {
    const order = by === "level" ? "best_level DESC, best_score DESC" : by === "xp" ? "xp DESC"
      : by === "pvp" ? "pvp_kills DESC" : "best_score DESC";
    return this.sql.exec(`SELECT name, xp, best_score, best_level, pvp_kills FROM players ORDER BY ${order} LIMIT 25`)
      .toArray().map(r => [r.name, r.xp, r.best_score, r.best_level, r.pvp_kills]);
  }
}

const clamp = (v, max) => Math.max(0, Math.min(max, Math.floor(Number(v) || 0)));
function randomToken() {
  const abc = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789", b = crypto.getRandomValues(new Uint8Array(16));
  return [...b].map(x => abc[x % 32]).join("");
}
async function sha256(t) {
  const h = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(t));
  return [...new Uint8Array(h)].map(x => x.toString(16).padStart(2, "0")).join("");
}
const passHash = async (room, pw) => pw ? sha256(room + ":" + pw) : "";
const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
const roomCode = v => { const r = String(v || "").toUpperCase(); return /^[A-Z0-9]{4,8}$/.test(r) ? r : null; };

// Visitors' IPs are only ever stored hashed
const ipOf = async request => { const ip = request.headers.get("CF-Connecting-IP"); return ip ? sha256("neon-ip:" + ip) : ""; };
const BANNED = reason => json({ error: "banned", reason: reason || "Banned by an admin" }, 403);

async function api(request, url, env, board) {
  let body = {};
  if (request.method === "POST") { try { body = JSON.parse(await request.text()); } catch {} }
  switch (url.pathname) {
    case "/api/register": {
      if (await board.ipBanned(await ipOf(request))) return BANNED();
      const r = await board.register(body.name); return json(r, r.error ? 400 : 200);
    }
    case "/api/login": {
      const p = await board.login(body.token);
      if (!p) return json({ error: "Unknown login code" }, 404);
      const ip = await ipOf(request);
      if (p.banned) return BANNED(p.banned);
      if (!p.admin && await board.ipBanned(ip)) return BANNED();
      await board.seen(body.token, ip);
      return json({ profile: p });
    }
    case "/api/admin/mod": {
      const action = String(body.action || "");
      if (!["kick", "ban", "ipban", "unban", "mute", "unmute", "bans", "announce"].includes(action)) return json({ error: "Unknown action" }, 400);
      const r = await board.mod(body.token, action, body.target, body.reason, body.raw);
      if (r.error) return json(r, 403);
      if (action === "announce") { // every room with people in it
        const text = String(body.reason || "").slice(0, 120);
        const rooms = (await board.listRooms()).filter(x => x[1] > 0).map(x => x[0]);
        await Promise.all(rooms.map(code => env.ROOMS.get(env.ROOMS.idFromName(code)).moderate("announce", "", text).catch(() => {})));
        return json({ ok: true, rooms: rooms.length });
      }
      let hit = 0;
      if (r.rooms) for (const code of r.rooms) {
        const act = action === "ipban" ? "ban" : action;
        if (act === "unban") continue;
        if (await env.ROOMS.get(env.ROOMS.idFromName(code)).moderate(act, r.name, r.reason || "").catch(() => false)) hit++;
      }
      return json({ ...r, online: hit > 0 });
    }
    case "/api/submit": { const r = await board.submit(body.token, body); return r ? json(r) : json({ error: "Unknown login code" }, 404); }
    case "/api/buy": { const r = await board.buy(body.token, String(body.slot || ""), body.i); return json(r, r.error ? 400 : 200); }
    case "/api/equip": { const r = await board.equip(body.token, String(body.slot || ""), body.i); return json(r, r.error ? 400 : 200); }
    case "/api/admin/credits": { const r = await board.adminCredits(body.token, body.target, body.amount); return json(r, r.error ? 403 : 200); }
    case "/api/top": return json({ rows: await board.top(url.searchParams.get("by")) });
    case "/api/rooms": return json({ rooms: await board.listRooms() });
    case "/api/ach": { const l = await board.unlock(body.token, body.id); return l ? json({ ach: l }) : json({ error: "Unknown" }, 400); }
    case "/api/admin/xp": { const r = await board.adminSetXp(body.token, body.target, body.xp); return json(r, r.error ? 403 : 200); }
    case "/api/check": {
      const room = roomCode(url.searchParams.get("room"));
      if (!room) return json({ error: "Bad room code" }, 400);
      if (room === MAIN) return json({ exists: true, private: false, ok: true, mode: "coop" });
      const hash = await passHash(room, url.searchParams.get("pw") || "");
      return json(await env.ROOMS.get(env.ROOMS.idFromName(room)).check(hash));
    }
  }
  return json({ error: "Not found" }, 404);
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const board = env.BOARD.get(env.BOARD.idFromName("global"));
    if (url.pathname.startsWith("/api/")) return api(request, url, env, board);

    if (url.pathname !== "/ws") return new Response("Not found", { status: 404 });
    if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") return new Response("Expected WebSocket", { status: 426 });
    const room = roomCode(url.searchParams.get("room"));
    if (!room) return new Response("Bad room code", { status: 400 });

    // Names come from the server, so nobody can pretend to be someone else
    let name = "Guest", admin = false;
    const t = url.searchParams.get("t");
    let muted = false;
    if (t) {
      const p = await board.login(t);
      if (p) { if (p.banned) return new Response("Banned", { status: 403 }); name = p.name; admin = p.admin; muted = p.muted; }
    }
    if (!admin && await board.ipBanned(await ipOf(request))) return new Response("Banned", { status: 403 });
    const headers = new Headers(request.headers);
    headers.set("X-Player-Name", name);
    headers.set("X-Admin", admin ? "1" : "0");
    headers.set("X-Muted", muted ? "1" : "0");
    headers.set("X-Room", room);
    const m = url.searchParams.get("mode");
    headers.set("X-Mode", m === "pvp" || m === "tdm" ? m : "coop");
    headers.set("X-Pass", await passHash(room, url.searchParams.get("pw") || ""));
    return env.ROOMS.get(env.ROOMS.idFromName(room)).fetch(new Request(request, { headers }));
  },
};
