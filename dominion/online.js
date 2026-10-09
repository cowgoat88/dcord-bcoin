// DOOMSTAR: DOMINION — online play.
//
// The server stores orders, never the game. A match is a seed and a seat
// list; each round every person posts their draft pick and then their
// plotted orders and vote. Every client re-runs the round itself from the
// same orders, so all clients hold the same galaxy, and the page stays a
// static file. That needs a simulation that is bit-identical in every
// browser (see the math rule in sim.js) and rivals (AI seats) that plan at
// the same moment everywhere: at the start of the plot, before any
// person's orders are in.
//
// Hidden orders are kept hidden by the database, not by the client: a row
// of plotted orders is readable only by its author until every person in
// the match has posted theirs for that round (row-level security; see
// schema.sql). Draft picks are public as soon as they are made.
//
// Storage goes through a small store interface, so the same protocol runs
// against Neon's Data API (neonStore) or in memory (memoryStore, used by
// the tests and for trying the flow without a server):
//   insert(table, row)  -> Promise<row>      (throws on a duplicate key)
//   select(table, eq)   -> Promise<row[]>    (only rows the viewer may see)
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./sim.js"), require("./ai.js"));
  else root.DominionOnline = factory(root.DominionSim, root.DominionAI);
})(typeof self !== "undefined" ? self : this, function (S, A) {
  "use strict";

  // ---- stores ------------------------------------------------------------
  // Neon's Data API speaks PostgREST: GET /table?col=eq.value to read,
  // POST /table to write, a Neon Auth JWT as the bearer token. token() may
  // return a promise.
  function neonStore(url, token, fetchFn) {
    const base = url.replace(/\/+$/, "");
    const f = fetchFn || (typeof fetch !== "undefined" ? fetch.bind(null) : null);
    async function headers(extra) {
      const t = await token();
      return Object.assign({ Accept: "application/json", Authorization: "Bearer " + t }, extra || {});
    }
    async function check(res) {
      if (res.ok) return res.status === 204 ? [] : res.json();
      let msg = res.status + " " + (res.statusText || "");
      try { const j = await res.json(); msg = (j.code ? j.code + " " : "") + (j.message || msg); } catch (e) { /* not JSON */ }
      const err = new Error(msg);
      err.status = res.status;
      err.duplicate = res.status === 409 || /23505/.test(msg);
      throw err;
    }
    return {
      async insert(table, row) {
        const res = await f(base + "/" + table, {
          method: "POST", body: JSON.stringify(row),
          headers: await headers({ "Content-Type": "application/json", Prefer: "return=representation" })
        });
        const rows = await check(res);
        return Array.isArray(rows) ? rows[0] : rows;
      },
      async select(table, eq) {
        const q = Object.keys(eq || {}).map((k) => encodeURIComponent(k) + "=eq." + encodeURIComponent(eq[k])).join("&");
        const res = await f(base + "/" + table + (q ? "?" + q : ""), { headers: await headers() });
        return check(res);
      }
    };
  }

  // The same rules as schema.sql, in memory. One shared database; each
  // viewer is a user id, as auth.user_id() is on the server.
  // With load and save, the database lives somewhere shared, such as
  // localStorage for two tabs of one browser (browserDatabase).
  function memoryDatabase(load, save) {
    let db = { matches: [], seats: [], moves: [], n: 0 };
    const sync = () => { if (load) { const d = load(); if (d) db = d; } };
    const keep = () => { if (save) save(db); };
    const clone = (x) => JSON.parse(JSON.stringify(x));
    function visible(table, row, user) {
      if (table !== "moves" || row.kind !== "plot" || row.user_id === user) return true;
      const posted = db.moves.filter((m) => m.match_id === row.match_id && m.round === row.round && m.kind === "plot").length;
      const people = db.seats.filter((s) => s.match_id === row.match_id).length;
      return posted >= people;
    }
    function storeFor(user) {
      return {
        async insert(table, row) {
          sync();
          const r = clone(row);
          if (table === "matches") { r.id = "m" + (++db.n); r.created_by = user; }
          else r.user_id = user;
          if (table === "seats" && db.seats.some((s) => s.match_id === r.match_id && s.seat === r.seat)) throw Object.assign(new Error("23505 seat taken"), { duplicate: true });
          if (table === "moves") {
            if (!db.seats.some((s) => s.match_id === r.match_id && s.seat === r.seat && s.user_id === user)) throw new Error("42501 not your seat");
            if (db.moves.some((m) => m.match_id === r.match_id && m.round === r.round && m.seat === r.seat && m.kind === r.kind)) throw Object.assign(new Error("23505 already posted"), { duplicate: true });
          }
          db[table].push(r);
          keep();
          return clone(r);
        },
        async select(table, eq) {
          sync();
          return clone(db[table].filter((r) => Object.keys(eq || {}).every((k) => r[k] === eq[k]) && visible(table, r, user)));
        }
      };
    }
    return { get db() { return db; }, storeFor };
  }
  // Online between tabs of this browser, with no server: for trying a
  // match out, or two people at one computer.
  function browserDatabase(key) {
    const k = key || "dominion.localnet.v1";
    return memoryDatabase(
      () => { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
      (db) => { try { localStorage.setItem(k, JSON.stringify(db)); } catch (e) { /* full or blocked */ } });
  }

  // ---- the match -----------------------------------------------------------
  const people = (config) => config.seats.map((s, i) => (s.ai ? 0 : i + 1)).filter(Boolean);

  async function createMatch(store, config) {
    const m = await store.insert("matches", { seed: config.seed, config: { seats: config.seats, draft: true, council: true } });
    await store.insert("seats", { match_id: m.id, seat: people(m.config)[0] });
    return m;
  }
  // Take the first free seat a person may sit in. Returns the seat number.
  async function joinMatch(store, matchId) {
    const [m] = await store.select("matches", { id: matchId });
    if (!m) throw new Error("No such match.");
    for (const seat of people(m.config)) {
      const taken = await store.select("seats", { match_id: matchId, seat });
      if (taken.length) continue;
      try { await store.insert("seats", { match_id: matchId, seat }); return seat; } catch (e) { if (!e.duplicate) throw e; }
    }
    throw new Error("The match is full.");
  }
  async function seatsFilled(store, matchId) {
    const [m] = await store.select("matches", { id: matchId });
    const taken = await store.select("seats", { match_id: matchId });
    return m && taken.length >= people(m.config).length;
  }

  // A fingerprint of the board, posted with every plot so clients that
  // have drifted apart find out at once instead of rounds later.
  function stateHash(game) {
    const s = JSON.stringify([game.round, game.points, game.credits, game.influence,
      game.nodes.map((n) => [n.owner, Math.round(n.garrison * 1000), n.level]), game.tech, game.laws]);
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; }
    return h.toString(16);
  }

  // One client's view of an online match.
  function Client(store, match, seat) {
    this.store = store;
    this.match = match;
    this.seat = seat;
    this.game = S.createGame({ seed: match.seed, seats: match.config.seats, draft: true, council: true });
    this.game.online = true;
    this.people = people(match.config);
    this.planned = 0;        // the round rivals last planned in
    this.desync = null;
  }
  Client.prototype.liveHumans = function () {
    return this.people.filter((id) => S.alive(this.game, id));
  };
  // Bring the draft up to date: rivals pick, people's posted picks are
  // applied in turn order. Returns whose pick it is (null when done).
  Client.prototype.syncDraft = async function () {
    const g = this.game;
    if (g.phase !== "draft") return null;
    const picks = await this.store.select("moves", { match_id: this.match.id, round: g.round, kind: "draft" });
    let guard = 0;
    while (g.phase === "draft" && guard++ < 12) {
      A.runDraft(g);
      const turn = S.draftTurn(g);
      if (!turn) break;
      const mv = picks.find((p) => p.seat === turn);
      if (!mv) return turn;
      const why = S.pickRole(g, turn, mv.payload.role);
      if (why) throw new Error("Seat " + turn + "'s pick does not apply: " + why);
    }
    return S.draftTurn(g);
  };
  Client.prototype.pick = async function (role) {
    const g = this.game;
    if (S.draftTurn(g) !== this.seat) return "It is not your pick.";
    if (S.rolesLeft(g).indexOf(role) === -1) return "That role is taken.";
    await this.store.insert("moves", { match_id: this.match.id, round: g.round, seat: this.seat, kind: "draft", payload: { role } });
    return S.pickRole(g, this.seat, role);
  };
  // Rivals plan once a round, the same way on every client.
  Client.prototype.planRivals = function () {
    const g = this.game;
    if (g.phase !== "plot" || this.planned === g.round) return;
    this.planned = g.round;
    this.hash = stateHash(g);
    A.planAll(g);
  };
  // Post your orders and vote for the round.
  Client.prototype.lock = async function () {
    const g = this.game;
    this.planRivals();
    await this.store.insert("moves", {
      match_id: this.match.id, round: g.round, seat: this.seat, kind: "plot",
      payload: { orders: g.orders[this.seat], vote: g.votes[this.seat], hash: this.hash }
    });
    S.lockOrders(g, this.seat);
  };
  // Once every person has posted, apply everyone's orders and start the
  // resolve. Returns true when the round has begun.
  Client.prototype.tryReveal = async function (beforeResolve) {
    const g = this.game;
    if (g.phase !== "plot") return false;
    this.planRivals();
    const rows = await this.store.select("moves", { match_id: this.match.id, round: g.round, kind: "plot" });
    const live = this.liveHumans();
    if (live.some((id) => !rows.some((r) => r.seat === id))) return false;
    for (const id of live.slice().sort((a, b) => a - b)) {
      const p = rows.find((r) => r.seat === id).payload;
      if (p.hash && p.hash !== this.hash && !this.desync) this.desync = { round: g.round, seat: id };
      if (id !== this.seat) {
        g.orders[id] = [];
        for (const o of p.orders || []) S.addOrder(g, id, o);
        if (p.vote) S.castVote(g, id, p.vote.choice, p.vote.influence);
      }
      S.lockOrders(g, id);
    }
    if (beforeResolve) beforeResolve(g);
    S.beginResolve(g);
    return true;
  };

  return { neonStore, memoryDatabase, browserDatabase, createMatch, joinMatch, seatsFilled, stateHash, Client, people };
});
