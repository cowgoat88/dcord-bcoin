// DOOMSTAR: DOMINION — core simulation.
//
// The OUTPOST engine's rules (lanes, garrisons, supply, assaults, lane
// combat, the Doomstar) for any number of seats, wrapped in a round
// structure: everyone plots orders against a frozen board, the orders lock,
// and the simulation runs ROUND_SECONDS with nobody touching it. Then the
// round's status is scored and the next plot begins.
//
// Pure logic: no DOM, no timers, no Math.random. A match is reproducible
// from (seed, seats, orders), which is what makes the forecast and the
// replay honest: both are this same code run forward on a copy.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory();
  else root.DominionSim = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const NEUTRAL = 0;

  // ---- rules carried over from OUTPOST --------------------------------
  const NODE_TYPES = {
    command:  { label: "Command",  units: 0.78, cap: 70, credits: 0.35, radius: 30 },
    factory:  { label: "Factory",  units: 0.40, cap: 45, credits: 0.25, radius: 24 },
    mine:     { label: "Mine",     units: 0.14, cap: 28, credits: 0.90, radius: 22 },
    relay:    { label: "Relay",    units: 0.20, cap: 34, credits: 0.25, radius: 21 },
    // The Doomstar's node. In Dominion it is the Throne at the centre of the
    // galaxy: hold it to fire the weapon and to score.
    doomstar: { label: "Throne",   units: 0.30, cap: 40, credits: 0.30, radius: 27 }
  };
  const TERRAIN = {
    open:     { label: "Open Space",    defence: 1.00 },
    asteroid: { label: "Asteroid Belt", defence: 1.25 },
    well:     { label: "Gravity Well",  defence: 0.78 }
  };
  const FLAT_TYPES = ["command", "doomstar"];
  const MAX_LEVEL = 3;
  const RATE_BONUS = 0.75, CAP_BONUS = 0.25;
  const DEFENDER_EDGE = 1.25;
  const COALESCE_WINDOW = 1.0;
  const FLEET_SPEED = 115;
  const MIN_SEND = 2;
  const TECH = {
    assault: { label: "Assault", perLevel: 0.15, costs: [90, 200, 360] },
    fortify: { label: "Fortify", perLevel: 0.10, costs: [80, 175, 320] }
  };
  const TECH_MAX = 3;
  const DOOM_CHARGE_INTERVAL = 3.0, DOOM_CHARGE_NEEDED = 20, DOOM_DAMAGE = 26, DOOM_LOCK_S = 2.0;

  const MOD_DEFAULTS = {
    speed: 1, cap: 1, units: 1, credits: 1, attack: 1, defence: 1,
    research: 1, doom: 1, chargeRate: 1, relayUnits: 1, cutoff: 0.3
  };
  const OUT_OF_SUPPLY_RATE = MOD_DEFAULTS.cutoff;

  // OUTPOST's doctrines are Dominion's factions. Each keeps its modifiers;
  // the bent rules described in the design doc arrive in a later phase.
  const FACTIONS = {
    standard:    { label: "Free Worlds",      icon: "◆", up: "Balanced", mods: {} },
    vanguard:    { label: "Kestrel Wings",    icon: "➤", up: "Fleets travel 40% faster; build 3% slower", mods: { speed: 1.40, units: 0.97 } },
    logistics:   { label: "Deep Combine",     icon: "●", up: "Cut-off positions keep 90% output and Relays keep charging; income −30%", mods: { cutoff: 0.90, credits: 0.70 } },
    relays:      { label: "Choir of the Array", icon: "★", up: "Relays out-build Factories and charge twice as fast; elsewhere 15% slower", mods: { relayUnits: 2.2, chargeRate: 2, units: 0.85 } },
    prospectors: { label: "Meridian Guild",   icon: "◈", up: "Income +45%, research 25% cheaper; build 10% slower", mods: { credits: 1.45, research: 0.75, units: 0.90 } },
    shock:       { label: "Iron Covenant",    icon: "▲", up: "Assaults land 15% harder; defend 6% worse, build 8% slower", mods: { attack: 1.15, defence: 0.94, units: 0.92 } }
  };
  const FACTION_KEYS = Object.keys(FACTIONS);

  const SEAT_COLORS = ["#22d3ee", "#fb7185", "#fbbf24", "#a78bfa", "#a3e635", "#fb923c"];
  const SECTOR_NAMES = ["Kestrel Reach", "Ashfall", "The Meridian", "Halcyon Drift", "Iron Verge", "Lantern Deep"];

  // ---- the round ---------------------------------------------------------
  const ROUND_SECONDS = 30;       // simulated seconds a round runs for
  const ROUND_LIMIT = 12;         // the season ends after this many rounds
  const THRONE_POINTS = 1;        // scored at status by whoever holds the Throne
  const POINTS_TO_WIN = 10;
  const CP_BASE = 3;              // orders a seat may give in a round
  const CP_PER = 5;               // +1 order for every this many positions held
  const CP_MAX = 8;
  const ORDER_KINDS = ["send", "support", "hold", "upgrade", "research", "fire"];
  const SUPPORT_SHARE = 0.5;      // a supporting position lends this share of its garrison
  const HOLD_BONUS = 1.25;        // a held (dug-in) position defends at this multiple

  // ---- helpers -------------------------------------------------------------
  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function dist(a, b) { return Math.hypot(a.x - b.x, a.y - b.y); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function emit(game, ev) { game.events.push(ev); }

  function factionOf(game, seat) {
    const s = game.seatById[seat];
    return s && FACTIONS[s.faction] ? s.faction : "standard";
  }
  function mod(game, seat, key) {
    if (!seat) return MOD_DEFAULTS[key];
    const v = FACTIONS[factionOf(game, seat)].mods[key];
    return v === undefined ? MOD_DEFAULTS[key] : v;
  }
  function fleetSpeed(game, seat) { return FLEET_SPEED * mod(game, seat, "speed"); }
  function upgradeCost(level) { return Math.round(60 * Math.pow(level + 1, 1.45)); }

  function nodeStats(node, game) {
    const base = NODE_TYPES[node.type];
    const rate = 1 + RATE_BONUS * node.level;
    const held = game && node.owner !== NEUTRAL;
    const u = (held ? mod(game, node.owner, "units") : 1) *
      (held && node.type === "relay" ? mod(game, node.owner, "relayUnits") : 1);
    return {
      unitRate: base.units * rate * u,
      creditRate: base.credits * rate * (held ? mod(game, node.owner, "credits") : 1),
      cap: Math.round(base.cap * (1 + CAP_BONUS * node.level) * (held ? mod(game, node.owner, "cap") : 1)),
      radius: base.radius
    };
  }
  function techLevel(game, seat, track) { return (game.tech[seat] && game.tech[seat][track]) || 0; }
  function techCost(game, seat, track) {
    const lv = techLevel(game, seat, track);
    if (!TECH[track] || lv >= TECH_MAX) return null;
    return Math.round(TECH[track].costs[lv] * mod(game, seat, "research"));
  }
  function assaultMult(game, seat) {
    return (1 + TECH.assault.perLevel * techLevel(game, seat, "assault")) * mod(game, seat, "attack");
  }
  function fortifyMult(game, seat) {
    return (1 + TECH.fortify.perLevel * techLevel(game, seat, "fortify")) * mod(game, seat, "defence");
  }
  function terrainDefence(node) { return (TERRAIN[node.terrain] || TERRAIN.open).defence; }

  function neighbors(game, id) { return game.adjacency[id] || []; }
  function areLinked(game, a, b) { return neighbors(game, a).indexOf(b) !== -1; }
  function nodesOf(game, seat) { return game.nodes.filter((n) => n.owner === seat); }
  function alive(game, seat) {
    return game.nodes.some((n) => n.owner === seat) || game.fleets.some((f) => f.owner === seat);
  }
  // The order seats are processed in when two things happen in the same
  // instant. It turns by one seat every round: with a fixed order, the
  // later seat always got the second, decisive hit on a position two
  // seats reached together, and seats 3 and 4 won 29 of 40 four-seat
  // matches for nothing but their number.
  function seatOrder(game) {
    const ids = game.seats.map((s) => s.id);
    const k = (game.round - 1) % ids.length;
    return ids.slice(k).concat(ids.slice(0, k));
  }
  function liveSeats(game) { return game.seats.filter((s) => alive(game, s.id)).map((s) => s.id); }

  // ---- galaxy generation ---------------------------------------------------
  // One wedge per seat around the Throne, every wedge the same ground turned
  // by 360/N degrees, so no seat starts with a better hand. Lanes are the
  // Gabriel graph of the points: planar (lanes never cross), connected, and
  // symmetric because the points are.
  const GALAXY_R = 1000;
  const WEDGE = [
    // r (fraction of radius), angle (fraction of the wedge, 0..1), type, garrison
    { r: 0.86, a: 0.50, type: "command", g: 30, home: true },
    { r: 0.70, a: 0.32, type: "factory", g: 14, homeSide: true },
    { r: 0.70, a: 0.68, type: "mine", g: 8 },
    { r: 0.97, a: 0.22, type: "relay", g: 8 },
    { r: 0.97, a: 0.78, type: "factory", g: 12 },
    { r: 0.52, a: 0.50, type: "relay", g: 12 },
    { r: 0.58, a: 0.10, type: "factory", g: 16 },
    { r: 0.36, a: 0.30, type: "mine", g: 14 },
    { r: 0.80, a: 0.02, type: "relay", g: 14 }
  ];

  function generateGalaxy(seed, seatCount) {
    const rng = makeRng(seed ^ 0x51ed27);
    const N = clamp(seatCount | 0, 2, 6);
    const W = GALAXY_R * 2.3, H = GALAXY_R * 2.3, cx = W / 2, cy = H / 2;
    // Jitter one wedge, then copy it round.
    const jit = WEDGE.map((p) => ({
      r: p.r + (rng() - 0.5) * 0.06,
      a: clamp(p.a + (rng() - 0.5) * 0.08, 0.02, 0.98),
      terrain: p.type === "command" ? "open" : (rng() < 0.18 ? "asteroid" : rng() < 0.12 ? "well" : "open"),
      p
    }));
    const span = (Math.PI * 2) / N;
    const nodes = [];
    nodes.push({ id: 0, x: cx, y: cy, type: "doomstar", terrain: "open", owner: NEUTRAL, garrison: 30, level: 0, sector: -1, name: "The Throne" });
    for (let s = 0; s < N; s++) {
      // Seat 1's wedge points down: your home is at the bottom of the screen,
      // as it is in OUTPOST, and the other seats follow clockwise.
      const a0 = Math.PI / 2 - span / 2 + s * span;
      for (const j of jit) {
        const ang = a0 + j.a * span, rr = j.r * GALAXY_R;
        nodes.push({
          id: nodes.length, x: cx + Math.cos(ang) * rr, y: cy + Math.sin(ang) * rr,
          type: j.p.type, terrain: j.terrain,
          owner: j.p.home || j.p.homeSide ? s + 1 : NEUTRAL,
          garrison: j.p.g, level: 0, sector: s,
          name: j.p.home ? SECTOR_NAMES[s % SECTOR_NAMES.length] : null
        });
      }
    }
    const lanes = gabrielLanes(nodes, GALAXY_R * 0.62);
    return { nodes, lanes, mapW: W, mapH: H };
  }

  function gabrielLanes(nodes, maxLen) {
    const lanes = [];
    for (let i = 0; i < nodes.length; i++) {
      for (let j = i + 1; j < nodes.length; j++) {
        const a = nodes[i], b = nodes[j];
        const d = dist(a, b);
        if (d > maxLen) continue;
        const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2, r2 = (d / 2) * (d / 2);
        let ok = true;
        for (let k = 0; k < nodes.length && ok; k++) {
          if (k === i || k === j) continue;
          const c = nodes[k];
          // Strictly inside the circle on the lane as diameter, with a little
          // slack so near-ties do not drop a lane on one copy of the wedge
          // and keep it on another.
          if ((c.x - mx) * (c.x - mx) + (c.y - my) * (c.y - my) < r2 * 0.985) ok = false;
        }
        if (ok) lanes.push({ a: i, b: j });
      }
    }
    return lanes;
  }

  // ---- game creation -----------------------------------------------------
  // opts: { seed, seats: [{ faction, ai, name }], map? }
  function createGame(opts) {
    const o = opts || {};
    const seed = (o.seed === undefined ? 12345 : o.seed) >>> 0;
    const seatSpecs = (o.seats && o.seats.length ? o.seats : [{ ai: false }, { ai: true }, { ai: true }]).slice(0, 6);
    const map = o.map || generateGalaxy(seed, seatSpecs.length);
    const nodes = map.nodes.map((n, i) => Object.assign({ level: 0, terrain: "open", sector: -1, name: null }, n, { id: i }));
    for (const n of nodes) if (FLAT_TYPES.indexOf(n.type) !== -1) n.terrain = "open";
    const adjacency = {};
    for (const n of nodes) adjacency[n.id] = [];
    for (const l of map.lanes) { adjacency[l.a].push(l.b); adjacency[l.b].push(l.a); }
    const seats = seatSpecs.map((s, i) => ({
      id: i + 1,
      name: s.name || (s.ai ? "Rival " + (i + 1) : "You"),
      faction: FACTIONS[s.faction] ? s.faction : FACTION_KEYS[(seed + i * 7) % FACTION_KEYS.length],
      ai: !!s.ai,
      color: SEAT_COLORS[i]
    }));
    const perSeat = (v) => { const o2 = {}; for (const s of seats) o2[s.id] = typeof v === "function" ? v(s) : v; return o2; };
    const game = {
      seed, mapW: map.mapW, mapH: map.mapH,
      nodes, lanes: map.lanes, adjacency,
      seats, seatById: {},
      fleets: [],
      credits: perSeat(40),
      tech: perSeat(() => ({ assault: 0, fortify: 0 })),
      charge: perSeat(0),
      points: perSeat(0),
      stats: perSeat(() => ({ sent: 0, captured: 0, lost: 0, fired: 0, taken: 0 })),
      chargeTimer: DOOM_CHARGE_INTERVAL,
      doomShot: null,
      time: 0,
      round: 1,
      phase: "plot",          // plot | resolve | over
      clock: 0,               // seconds into the current resolve
      orders: perSeat(() => []),
      locked: perSeat(false),
      support: [],            // this round's live support orders
      held: {},               // node id -> seat, positions dug in this round
      winner: null,
      events: [],
      history: []             // one entry per finished round: { round, orders, points }
    };
    for (const s of seats) game.seatById[s.id] = s;
    computeSupply(game);
    return game;
  }

  // A full, independent copy, for the forecast and for replays.
  function cloneGame(game) {
    const c = JSON.parse(JSON.stringify(game, (k, v) => (k === "seatById" ? undefined : v)));
    c.seatById = {};
    for (const s of c.seats) c.seatById[s.id] = s;
    return c;
  }

  // ---- supply ------------------------------------------------------------
  function computeSupply(game) {
    for (const n of game.nodes) n.inSupply = n.owner === NEUTRAL;
    for (const s of game.seats) {
      const stack = game.nodes.filter((n) => n.owner === s.id && n.type === "command").map((n) => n.id);
      const seen = new Set(stack);
      while (stack.length) {
        const cur = stack.pop();
        game.nodes[cur].inSupply = true;
        for (const nx of neighbors(game, cur)) {
          if (seen.has(nx) || game.nodes[nx].owner !== s.id) continue;
          seen.add(nx); stack.push(nx);
        }
      }
    }
  }
  function supplyMult(node, game) {
    return node.inSupply !== false ? 1 : mod(game, node.owner, "cutoff");
  }
  function relayCharge(game, node) {
    if (node.type !== "relay" || node.owner === NEUTRAL) return 0;
    if (node.inSupply === false) {
      const keeps = mod(game, node.owner, "cutoff");
      return keeps > OUT_OF_SUPPLY_RATE ? keeps : 0;
    }
    return 1;
  }
  function throneNode(game) { return game.nodes.find((n) => n.type === "doomstar") || null; }
  function canFire(game, seat) {
    const t = throneNode(game);
    return !!t && t.owner === seat && (game.charge[seat] || 0) >= DOOM_CHARGE_NEEDED && !game.doomShot;
  }

  // ---- routing: only through your own ground --------------------------
  function findPath(game, fromId, toId, seat) {
    if (fromId === toId) return null;
    const distTo = { [fromId]: 0 }, prev = {}, done = new Set();
    const queue = [fromId];
    while (queue.length) {
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (distTo[queue[i]] < distTo[queue[bi]]) bi = i;
      const cur = queue.splice(bi, 1)[0];
      if (cur === toId) break;
      if (done.has(cur)) continue;
      done.add(cur);
      for (const nx of neighbors(game, cur)) {
        if (done.has(nx)) continue;
        if (nx !== toId && seat !== undefined && game.nodes[nx].owner !== seat) continue;
        const d = distTo[cur] + dist(game.nodes[cur], game.nodes[nx]);
        if (distTo[nx] === undefined || d < distTo[nx]) {
          distTo[nx] = d; prev[nx] = cur;
          if (queue.indexOf(nx) === -1) queue.push(nx);
        }
      }
    }
    if (prev[toId] === undefined) return null;
    const path = [toId];
    let cur = toId;
    while (cur !== fromId) { cur = prev[cur]; path.unshift(cur); }
    return path;
  }
  function pathTime(game, path, seat) {
    let d = 0;
    for (let i = 1; i < path.length; i++) d += dist(game.nodes[path[i - 1]], game.nodes[path[i]]);
    return d / fleetSpeed(game, seat);
  }

  // ---- orders --------------------------------------------------------------
  // Plotting is free of side effects: an order is checked against the
  // frozen board and stored. Nothing moves until the round resolves.
  function commandPoints(game, seat) {
    return Math.min(CP_MAX, CP_BASE + Math.floor(nodesOf(game, seat).length / CP_PER));
  }
  function cpUsed(game, seat) { return game.orders[seat].length; }

  // Returns undefined if the order is legal for this seat right now, else a
  // short player-facing reason.
  function checkOrder(game, seat, order) {
    if (game.phase !== "plot") return "Orders are given between rounds.";
    if (!game.seatById[seat]) return "No such seat.";
    if (game.locked[seat]) return "Your orders are locked for this round.";
    if (!order || ORDER_KINDS.indexOf(order.kind) === -1) return "Unknown order.";
    if (cpUsed(game, seat) >= commandPoints(game, seat)) return "No command points left this round.";
    const mine = game.orders[seat];
    const N = (id) => game.nodes[id];
    if (order.kind === "send") {
      const from = N(order.from), to = N(order.to);
      if (!from || !to) return "No such position.";
      if (from.owner !== seat) return "You don't hold that position.";
      if (order.from === order.to) return "Pick a different target.";
      if (game.held[order.from] === seat || mine.some((o) => o.kind === "hold" && o.at === order.from)) return "That position is dug in this round.";
      if (!findPath(game, order.from, order.to, seat)) return "No route — you can only move through ground you hold.";
      const frac = clamp(order.frac === undefined ? 0.5 : +order.frac, 0.05, 1);
      if (Math.floor(from.garrison * frac) < MIN_SEND) return "Not enough units to send.";
      return undefined;
    }
    if (order.kind === "support") {
      const from = N(order.from), to = N(order.to);
      if (!from || !to) return "No such position.";
      if (from.owner !== seat) return "You don't hold that position.";
      if (!areLinked(game, order.from, order.to)) return "Support only reaches a neighbouring position.";
      if (mine.some((o) => o.kind === "support" && o.from === order.from)) return "That position already supports this round.";
      return undefined;
    }
    if (order.kind === "hold") {
      const at = N(order.at);
      if (!at || at.owner !== seat) return "You don't hold that position.";
      if (mine.some((o) => o.kind === "hold" && o.at === order.at)) return "Already dug in.";
      if (mine.some((o) => o.kind === "send" && o.from === order.at)) return "That position is sending this round.";
      return undefined;
    }
    if (order.kind === "upgrade") {
      const at = N(order.at);
      if (!at || at.owner !== seat) return "You don't hold that position.";
      const planned = mine.filter((o) => o.kind === "upgrade" && o.at === order.at).length;
      if (at.level + planned >= MAX_LEVEL) return "Already at maximum level.";
      const cost = upgradeCost(at.level + planned);
      if (spendable(game, seat) < cost) return "Need " + cost + " credits.";
      return undefined;
    }
    if (order.kind === "research") {
      if (!TECH[order.track]) return "No such research.";
      if (mine.some((o) => o.kind === "research")) return "One research step a round.";
      const cost = techCost(game, seat, order.track);
      if (cost === null) return TECH[order.track].label + " is fully researched.";
      if (spendable(game, seat) < cost) return "Need " + cost + " credits.";
      return undefined;
    }
    if (order.kind === "fire") {
      if (!canFire(game, seat)) return "Hold the Throne with a full charge to fire.";
      const t = N(order.target);
      if (!t || t.owner === seat || t.owner === NEUTRAL) return "Pick a rival's position.";
      if (mine.some((o) => o.kind === "fire")) return "One strike a round.";
      return undefined;
    }
    return "Unknown order.";
  }

  // Credits not already promised to this round's upgrades and research.
  function spendable(game, seat) {
    let c = game.credits[seat] || 0;
    for (const o of game.orders[seat]) {
      if (o.kind === "upgrade") {
        const at = game.nodes[o.at];
        const before = game.orders[seat].filter((x) => x.kind === "upgrade" && x.at === o.at);
        c -= upgradeCost(at.level + before.indexOf(o));
      } else if (o.kind === "research") {
        c -= techCost(game, seat, o.track) || 0;
      }
    }
    return c;
  }

  function addOrder(game, seat, order) {
    const why = checkOrder(game, seat, order);
    if (why) return why;
    const o = Object.assign({}, order);
    if (o.kind === "send") o.frac = clamp(o.frac === undefined ? 0.5 : +o.frac, 0.05, 1);
    game.orders[seat].push(o);
    return undefined;
  }
  function removeOrder(game, seat, index) {
    if (game.phase !== "plot" || game.locked[seat]) return "Your orders are locked.";
    if (index < 0 || index >= game.orders[seat].length) return "No such order.";
    game.orders[seat].splice(index, 1);
    // Later orders may have depended on this one (credits, a second upgrade):
    // keep only what is still legal, in order.
    const keep = game.orders[seat];
    game.orders[seat] = [];
    for (const o of keep) if (!checkOrder(game, seat, o)) game.orders[seat].push(o);
    return undefined;
  }
  function lockOrders(game, seat) {
    if (game.phase !== "plot") return "Nothing to lock.";
    game.locked[seat] = true;
    return undefined;
  }
  function allLocked(game) {
    return liveSeats(game).every((id) => game.locked[id]);
  }

  // Start the round: apply every seat's orders at once, in a fixed order
  // that does not favour any seat: spending first, then digging in and
  // support, then launches, with seats interleaved one order at a time.
  function beginResolve(game) {
    if (game.phase !== "plot") return "Not in the plot phase.";
    game.phase = "resolve";
    game.clock = 0;
    game.support = [];
    game.held = {};
    const ids = seatOrder(game);
    const byKind = (kinds) => {
      const lists = ids.map((id) => game.orders[id].filter((o) => kinds.indexOf(o.kind) !== -1));
      const out = [];
      for (let i = 0; lists.some((l) => i < l.length); i++) {
        for (let s = 0; s < ids.length; s++) if (i < lists[s].length) out.push([ids[s], lists[s][i]]);
      }
      return out;
    };
    for (const [seat, o] of byKind(["upgrade", "research"])) {
      if (o.kind === "upgrade") applyUpgrade(game, seat, o.at);
      else applyResearch(game, seat, o.track);
    }
    for (const [seat, o] of byKind(["hold", "support"])) {
      if (o.kind === "hold" && game.nodes[o.at].owner === seat) game.held[o.at] = seat;
      if (o.kind === "support" && game.nodes[o.from].owner === seat) {
        game.support.push({ seat, from: o.from, to: o.to, cut: false });
        emit(game, { kind: "support", seat, from: o.from, to: o.to });
      }
    }
    for (const [seat, o] of byKind(["send"])) launch(game, seat, o.from, o.to, o.frac);
    for (const [seat, o] of byKind(["fire"])) fireDoomstar(game, seat, o.target);
    game.history.push({ round: game.round, orders: JSON.parse(JSON.stringify(game.orders)) });
    return undefined;
  }

  function applyUpgrade(game, seat, id) {
    const n = game.nodes[id];
    if (!n || n.owner !== seat || n.level >= MAX_LEVEL) return;
    const cost = upgradeCost(n.level);
    if (game.credits[seat] < cost) return;
    game.credits[seat] -= cost;
    n.level += 1;
    emit(game, { kind: "upgrade", x: n.x, y: n.y, owner: seat, level: n.level });
  }
  function applyResearch(game, seat, track) {
    const cost = techCost(game, seat, track);
    if (cost === null || game.credits[seat] < cost) return;
    game.credits[seat] -= cost;
    game.tech[seat][track] += 1;
    emit(game, { kind: "research", owner: seat, track, level: game.tech[seat][track] });
  }
  function launch(game, seat, fromId, toId, frac) {
    const from = game.nodes[fromId];
    if (!from || from.owner !== seat) return;
    const path = findPath(game, fromId, toId, seat);
    if (!path) return;
    const count = Math.floor(from.garrison * frac);
    if (count < MIN_SEND) return;
    from.garrison -= count;
    game.fleets.push({
      owner: seat, from: fromId, to: toId, count, path, leg: 0, t: 0,
      duration: dist(from, game.nodes[path[1]]) / fleetSpeed(game, seat)
    });
    game.stats[seat].sent += count;
    emit(game, { kind: "launch", x: from.x, y: from.y, owner: seat, count });
  }

  // ---- the Doomstar ------------------------------------------------------
  function fireDoomstar(game, seat, targetId) {
    if (!canFire(game, seat)) return;
    const t = game.nodes[targetId];
    if (!t || t.owner === seat || t.owner === NEUTRAL) return;
    game.charge[seat] = 0;
    game.stats[seat].fired += 1;
    game.doomShot = { owner: seat, targetId, t: DOOM_LOCK_S, victim: t.owner };
    emit(game, { kind: "doomlock", x: t.x, y: t.y, owner: seat, nodeId: targetId, seconds: DOOM_LOCK_S });
  }
  function stepDoomShot(game, dt) {
    const shot = game.doomShot;
    if (!shot) return;
    shot.t -= dt;
    if (shot.t > 0) return;
    game.doomShot = null;
    const t = game.nodes[shot.targetId];
    if (!t || t.owner === shot.owner || t.owner === NEUTRAL) {
      emit(game, { kind: "doomstar", x: t ? t.x : 0, y: t ? t.y : 0, owner: shot.owner, nodeId: shot.targetId, damage: 0, fizzled: true });
      return;
    }
    const before = t.garrison;
    t.garrison = Math.max(0, t.garrison - Math.round(DOOM_DAMAGE * mod(game, shot.owner, "doom")));
    const victim = t.owner;
    const wiped = t.garrison <= 0.001;
    if (wiped) { t.owner = NEUTRAL; t.level = 0; t.garrison = 0; t.assault = null; }
    game.stats[victim].taken += 1;
    emit(game, { kind: "doomstar", x: t.x, y: t.y, owner: shot.owner, nodeId: t.id, damage: Math.round(before - t.garrison), wiped });
  }
  function stepCharge(game, dt) {
    if (!throneNode(game)) return;
    game.chargeTimer -= dt;
    if (game.chargeTimer > 0) return;
    game.chargeTimer += DOOM_CHARGE_INTERVAL;
    for (const s of game.seats) {
      const gained = game.nodes.reduce((sum, n) => sum + (n.owner === s.id ? relayCharge(game, n) : 0), 0) *
        mod(game, s.id, "chargeRate");
      if (!gained) continue;
      const before = game.charge[s.id];
      if (before >= DOOM_CHARGE_NEEDED) continue;
      game.charge[s.id] = Math.min(DOOM_CHARGE_NEEDED, before + gained);
      if (game.charge[s.id] >= DOOM_CHARGE_NEEDED) emit(game, { kind: "charged", owner: s.id });
    }
  }

  // ---- combat --------------------------------------------------------------
  // Support a position receives this instant from a seat, in effective
  // strength: half the supporter's garrison, at the supporter's own
  // strength, while its support stands and it still holds the position.
  function supportFor(game, nodeId, seat, defending) {
    let s = 0;
    for (const sp of game.support) {
      if (sp.cut || sp.to !== nodeId || sp.seat !== seat) continue;
      const from = game.nodes[sp.from];
      if (from.owner !== seat) continue;
      s += from.garrison * SUPPORT_SHARE * (defending ? DEFENDER_EDGE * fortifyMult(game, seat) : assaultMult(game, seat));
    }
    return s;
  }
  function defenceOf(game, node) {
    if (node.owner === NEUTRAL) return node.garrison * terrainDefence(node);
    const hold = game.held[node.id] === node.owner ? HOLD_BONUS : 1;
    return node.garrison * DEFENDER_EDGE * fortifyMult(game, node.owner) * terrainDefence(node) * hold;
  }

  function resolveArrival(game, f) {
    const to = game.nodes[f.to];
    if (to.owner === f.owner) {
      const before = to.garrison, cap = nodeStats(to, game).cap;
      to.garrison = Math.max(before, Math.min(cap, before + f.count));
      emit(game, { kind: "reinforce", x: to.x, y: to.y, owner: f.owner, count: Math.round(to.garrison - before) });
      return;
    }
    // An attack on a supporting position cuts its support, as in Diplomacy.
    for (const sp of game.support) if (sp.from === to.id && sp.seat === to.owner) sp.cut = true;
    if (!to.assault || to.assault.owner !== f.owner) {
      if (to.assault) resolveAssault(game, to);
      to.assault = { owner: f.owner, count: 0, fuse: COALESCE_WINDOW };
    }
    to.assault.count += f.count;
    to.assault.fuse = COALESCE_WINDOW;
    emit(game, { kind: "massing", x: to.x, y: to.y, owner: f.owner, count: Math.round(to.assault.count) });
  }
  function resolveAssault(game, to) {
    const a = to.assault;
    to.assault = null;
    if (!a) return;
    const am = assaultMult(game, a.owner);
    const attack = a.count * am + supportFor(game, to.id, a.owner, false);
    const defender = to.owner;
    const defence = defenceOf(game, to) + (defender !== NEUTRAL ? supportFor(game, to.id, defender, true) : 0);
    if (attack > defence) {
      const survivors = (attack - defence) / am;
      to.owner = a.owner;
      to.level = 0;
      to.garrison = Math.min(nodeStats(to, game).cap, Math.max(1, survivors));
      game.stats[a.owner].captured += 1;
      if (defender !== NEUTRAL) game.stats[defender].lost += 1;
      emit(game, { kind: "capture", x: to.x, y: to.y, owner: a.owner, from: defender, nodeId: to.id, count: Math.round(to.garrison) });
    } else {
      const perUnit = defender === NEUTRAL ? terrainDefence(to)
        : defenceOf(game, to) / Math.max(1e-9, to.garrison);
      const ownShare = defenceOf(game, to) / Math.max(1e-9, defence);
      to.garrison = Math.max(0, to.garrison - (attack * ownShare) / Math.max(1e-9, perUnit));
      emit(game, { kind: "repulsed", x: to.x, y: to.y, owner: defender, attacker: a.owner, nodeId: to.id, count: Math.round(a.count) });
    }
  }
  function stepAssaults(game, dt) {
    for (const n of game.nodes) {
      if (!n.assault) continue;
      n.assault.fuse -= dt;
      if (n.assault.fuse <= 0) resolveAssault(game, n);
    }
  }

  // Fleets that cross on a lane fight there, with no defence modifiers.
  function laneOf(f) {
    const a = f.path[f.leg], b = f.path[f.leg + 1];
    const t = clamp(f.t, 0, 1);
    return { key: Math.min(a, b) + "-" + Math.max(a, b), s: a < b ? t : 1 - t, start: a < b ? 0 : 1, a, b };
  }
  function lanePoint(game, f) {
    const A = game.nodes[f.path[f.leg]], B = game.nodes[f.path[f.leg + 1]], t = clamp(f.t, 0, 1);
    return { x: A.x + (B.x - A.x) * t, y: A.y + (B.y - A.y) * t };
  }
  function stepLaneCombat(game) {
    if (game.fleets.length < 2) return;
    const groups = {};
    for (const f of game.fleets) {
      if (f.count <= 0) continue;
      const L = laneOf(f);
      f.lp = f.lk === L.key && f.ls !== undefined ? f.ls : L.start;
      f.lc = L;
      (groups[L.key] = groups[L.key] || []).push(f);
    }
    for (const key in groups) {
      const g = groups[key];
      for (let i = 0; i < g.length; i++) for (let j = i + 1; j < g.length; j++) {
        const a = g[i], b = g[j];
        if (a.owner === b.owner || a.count <= 0 || b.count <= 0) continue;
        const before = a.lp - b.lp, after = a.lc.s - b.lc.s;
        if (before === 0 || before * after > 0) continue;
        const ma = assaultMult(game, a.owner), mb = assaultMult(game, b.owner);
        const ea = a.count * ma, eb = b.count * mb;
        const pa = lanePoint(game, a), pb = lanePoint(game, b);
        const cA = a.count, cB = b.count;
        let winner = NEUTRAL, left = 0;
        if (ea > eb) { a.count = (ea - eb) / ma; b.count = 0; winner = a.owner; left = a.count; }
        else if (eb > ea) { b.count = (eb - ea) / mb; a.count = 0; winner = b.owner; left = b.count; }
        else { a.count = 0; b.count = 0; }
        if (a.count < 0.5) a.count = 0;
        if (b.count < 0.5) b.count = 0;
        emit(game, { kind: "clash", x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, owner: winner, count: Math.round(left),
          sides: [{ owner: a.owner, count: Math.round(cA) }, { owner: b.owner, count: Math.round(cB) }] });
      }
    }
  }

  // ---- one simulation tick ----------------------------------------------
  // Only runs during a resolve. Ends the round when the clock runs out.
  function step(game, dt) {
    if (game.phase !== "resolve") return;
    const left = ROUND_SECONDS - game.clock;
    if (dt > left) dt = left;
    game.time += dt;
    game.clock += dt;
    computeSupply(game);
    for (const n of game.nodes) {
      if (n.owner === NEUTRAL) continue;
      const s = nodeStats(n, game), m = supplyMult(n, game);
      if (n.garrison < s.cap) n.garrison = Math.min(s.cap, n.garrison + s.unitRate * m * dt);
      game.credits[n.owner] += s.creditRate * m * dt;
    }
    for (const f of game.fleets) {
      const L0 = laneOf(f);
      f.lk = L0.key; f.ls = L0.s;
      f.t += dt / f.duration;
      while (f.t >= 1 && f.leg < f.path.length - 2) {
        f.leg += 1; f.t -= 1;
        f.duration = dist(game.nodes[f.path[f.leg]], game.nodes[f.path[f.leg + 1]]) / fleetSpeed(game, f.owner);
      }
    }
    stepLaneCombat(game);
    const remaining = [], arriving = [];
    for (const f of game.fleets) {
      if (f.count <= 0) continue;
      if (f.t < 1) remaining.push(f); else arriving.push(f);
    }
    game.fleets = remaining;
    if (arriving.length > 1) {
      const rank = {};
      seatOrder(game).forEach((id, i) => { rank[id] = i; });
      arriving.sort((a, b) => rank[a.owner] - rank[b.owner]);
    }
    for (const f of arriving) resolveArrival(game, f);
    stepAssaults(game, dt);
    stepDoomShot(game, dt);
    stepCharge(game, dt);
    if (game.clock >= ROUND_SECONDS - 1e-9) endRound(game);
  }

  // Run the rest of the round in one go (the AI, tests, and the forecast).
  function runRound(game, dt) {
    const h = dt || 1 / 20;
    let guard = 0;
    while (game.phase === "resolve" && guard++ < 100000) step(game, h);
  }

  // ---- status ------------------------------------------------------------
  function endRound(game) {
    // Fights still massing at the bell resolve now, so the board a round
    // ends on is the board the next round is plotted on.
    for (const n of game.nodes) if (n.assault) resolveAssault(game, n);
    computeSupply(game);
    const throne = throneNode(game);
    if (throne && throne.owner !== NEUTRAL) {
      game.points[throne.owner] += THRONE_POINTS;
      emit(game, { kind: "score", owner: throne.owner, points: THRONE_POINTS, why: "Held the Throne" });
    }
    game.history[game.history.length - 1].points = Object.assign({}, game.points);
    const live = liveSeats(game);
    const leader = game.seats.slice().sort((a, b) => standing(game, b.id) - standing(game, a.id))[0];
    if (live.length === 1) game.winner = live[0];
    else if (live.length === 0) game.winner = NEUTRAL;
    else if (game.points[leader.id] >= POINTS_TO_WIN) game.winner = leader.id;
    else if (game.round >= ROUND_LIMIT) game.winner = leader.id;
    if (game.winner !== null) {
      game.phase = "over";
      emit(game, { kind: "over", winner: game.winner });
      return;
    }
    game.round += 1;
    game.phase = "plot";
    game.clock = 0;
    game.support = [];
    game.held = {};
    for (const s of game.seats) { game.orders[s.id] = []; game.locked[s.id] = !alive(game, s.id); }
    emit(game, { kind: "round", round: game.round });
  }
  // Points first, then positions, then garrison: the order the season's
  // standings are read in.
  function standing(game, seat) {
    const own = nodesOf(game, seat);
    return game.points[seat] * 1e6 + own.length * 1e3 + own.reduce((s, n) => s + n.garrison, 0) / 1e3;
  }

  // ---- the forecast ------------------------------------------------------
  // What the round will do if every other seat gives no orders at all: a
  // copy of the board with only this seat's plotted orders, run to the end
  // of the round. Returns a frame every `every` seconds for the slider.
  function forecast(game, seat, every) {
    const step0 = every || 1;
    const c = cloneGame(game);
    for (const s of c.seats) if (s.id !== seat) c.orders[s.id] = [];
    c.events = [];
    beginResolve(c);
    const frames = [snapshotFrame(c)];
    let next = step0;
    while (c.phase === "resolve") {
      step(c, 1 / 20);
      if (c.clock >= next - 1e-9 || c.phase !== "resolve") { frames.push(snapshotFrame(c)); next += step0; }
    }
    return frames;
  }
  function snapshotFrame(g) {
    return {
      clock: g.phase === "resolve" ? g.clock : ROUND_SECONDS,
      nodes: g.nodes.map((n) => ({ owner: n.owner, garrison: n.garrison, level: n.level })),
      fleets: g.fleets.map((f) => ({ owner: f.owner, count: f.count, path: f.path, leg: f.leg, t: f.t })),
      doomShot: g.doomShot ? Object.assign({}, g.doomShot) : null
    };
  }

  function drainEvents(game) { const e = game.events; game.events = []; return e; }

  return {
    NEUTRAL, NODE_TYPES, TERRAIN, TECH, TECH_MAX, MAX_LEVEL, FACTIONS, FACTION_KEYS, SEAT_COLORS,
    DEFENDER_EDGE, COALESCE_WINDOW, FLEET_SPEED, MIN_SEND, DOOM_CHARGE_NEEDED, DOOM_DAMAGE, DOOM_LOCK_S,
    ROUND_SECONDS, ROUND_LIMIT, POINTS_TO_WIN, CP_BASE, CP_PER, CP_MAX, SUPPORT_SHARE, HOLD_BONUS, GALAXY_R,
    seatOrder, makeRng, dist, clamp, nodeStats, techLevel, techCost, assaultMult, fortifyMult, terrainDefence, upgradeCost,
    generateGalaxy, gabrielLanes, createGame, cloneGame, computeSupply, relayCharge, throneNode, canFire,
    neighbors, areLinked, nodesOf, alive, liveSeats, findPath, pathTime, factionOf, mod,
    commandPoints, cpUsed, checkOrder, addOrder, removeOrder, lockOrders, allLocked, spendable,
    beginResolve, step, runRound, endRound, standing, forecast, snapshotFrame,
    defenceOf, supportFor, resolveArrival, resolveAssault, stepLaneCombat, lanePoint, drainEvents
  };
});
