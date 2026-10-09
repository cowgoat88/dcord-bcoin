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
  // The tech tree: four branches of three. A technology needs the one
  // before it in its branch. Each is a rule, not just a bigger number, from
  // tier 3 on.
  const BRANCHES = {
    war:        { label: "War",        icon: "\u2694", color: "#fb7185" },
    bulwark:    { label: "Bulwark",    icon: "\u26e8", color: "#86efac" },
    propulsion: { label: "Propulsion", icon: "\u27a4", color: "#7dd3fc" },
    statecraft: { label: "Statecraft", icon: "\u2696", color: "#fcd34d" }
  };
  const TECH_COSTS = [0, 90, 190, 330];
  const TECHS = {
    assault1:   { branch: "war", tier: 1, label: "Assault Doctrine", text: "Assaults land 15% harder." },
    assault2:   { branch: "war", tier: 2, label: "Shock Troops", text: "Assaults land a further 15% harder." },
    siege:      { branch: "war", tier: 3, label: "Siege Lances", text: "Your assaults ignore Asteroid Belts and dug-in defenders." },
    fortify1:   { branch: "bulwark", tier: 1, label: "Hardpoints", text: "Your positions defend 10% harder." },
    fortify2:   { branch: "bulwark", tier: 2, label: "Deep Bunkers", text: "Your positions defend a further 10% harder." },
    bastion:    { branch: "bulwark", tier: 3, label: "Bastion", text: "Hold digs in by half again instead of a quarter." },
    drives:     { branch: "propulsion", tier: 1, label: "Ion Drives", text: "Your fleets fly 20% faster." },
    pickets:    { branch: "propulsion", tier: 2, label: "Lane Pickets", text: "Your fleets fight 25% harder in lanes." },
    sensors:    { branch: "propulsion", tier: 3, label: "Deep Sensors", text: "You see one lane further from every position." },
    envoys:     { branch: "statecraft", tier: 1, label: "Envoys", text: "One more influence every round." },
    logistics:  { branch: "statecraft", tier: 2, label: "Logistics Net", text: "One more order every round." },
    capacitors: { branch: "statecraft", tier: 3, label: "Capacitors", text: "The Doomstar charges half again as fast for you." }
  };
  const TECH_KEYS = Object.keys(TECHS);
  const ASSAULT_PER = 0.15, FORTIFY_PER = 0.10;
  const DOOM_CHARGE_INTERVAL = 3.0, DOOM_CHARGE_NEEDED = 20, DOOM_DAMAGE = 26, DOOM_LOCK_S = 2.0;

  const MOD_DEFAULTS = {
    speed: 1, cap: 1, units: 1, credits: 1, attack: 1, defence: 1,
    research: 1, doom: 1, chargeRate: 1, relayUnits: 1, cutoff: 0.3
  };
  const OUT_OF_SUPPLY_RATE = MOD_DEFAULTS.cutoff;

  // OUTPOST's doctrines are Dominion's factions. Each keeps its modifiers
  // and bends one rule of the game.
  const FACTIONS = {
    standard:    { label: "Free Worlds",      icon: "◆", up: "Income +15%, build 5% faster", mods: { credits: 1.15, units: 1.05 },
      rule: { label: "Senate", text: "Your vote in the council counts two." } },
    vanguard:    { label: "Kestrel Wings",    icon: "➤", up: "Fleets travel 5% faster; build 5% slower", mods: { speed: 1.05, units: 0.95 },
      rule: { label: "Deep Strike", text: "Your fleets may fly over one unclaimed position on the way, losing a third of their number." } },
    logistics:   { label: "Deep Combine",     icon: "●", up: "Cut-off positions keep 90% output and Relays keep charging; income −15%", mods: { cutoff: 0.90, credits: 0.85 },
      rule: { label: "Convoys", text: "Your supply runs through pact partners' positions as if they were yours." } },
    relays:      { label: "Choir of the Array", icon: "★", up: "Relays build 80% faster and charge twice as fast; elsewhere 15% slower", mods: { relayUnits: 1.8, chargeRate: 2, units: 0.85 },
      rule: { label: "The Array", text: "Your Relays see three lanes out." } },
    prospectors: { label: "Meridian Guild",   icon: "◈", up: "Income +45%, research 25% cheaper; build 4% slower", mods: { credits: 1.45, research: 0.75, units: 0.96 },
      rule: { label: "Trade Pacts", text: "Every round of a pact pays you and your partner 40 credits each." } },
    shock:       { label: "Iron Covenant",    icon: "▲", up: "Assaults land 8% harder; defend 6% worse, build 8% slower", mods: { attack: 1.08, defence: 0.94, units: 0.92 },
      rule: { label: "Hold the Line", text: "Positions you take are dug in for the rest of the round." } }
  };
  const TRADE_PACT_CREDITS = 40;
  const DEEP_STRIKE_KEEP = 0.65;
  const FACTION_KEYS = Object.keys(FACTIONS);

  const SEAT_COLORS = ["#22d3ee", "#fb7185", "#fbbf24", "#a78bfa", "#a3e635", "#fb923c"];
  const SECTOR_NAMES = ["Kestrel Reach", "Ashfall", "The Meridian", "Halcyon Drift", "Iron Verge", "Lantern Deep"];

  // ---- the round ---------------------------------------------------------
  const ROUND_SECONDS = 30;       // simulated seconds a round runs for
  const ROUND_LIMIT = 18;         // the season ends after this many rounds
  const THRONE_POINTS = 1;        // scored at status by whoever holds the Throne, in the first third
  // The Throne is worth more as the season goes on: 1 a round in the first
  // third of the round limit, 2 in the second, 3 in the last. It pulls the
  // fighting to the centre late, when the economy is built.
  function thronePoints(game) {
    const third = game.roundLimit / 3;
    return game.round <= third ? THRONE_POINTS : game.round <= 2 * third ? THRONE_POINTS + 1 : THRONE_POINTS + 2;
  }
  const POINTS_TO_WIN = 20;
  const CP_BASE = 3;              // orders a seat may give in a round
  const CP_PER = 5;               // +1 order for every this many positions held
  const CP_MAX = 8;
  const ORDER_KINDS = ["send", "support", "hold", "upgrade", "research", "fire"];
  const SUPPORT_SHARE = 0.5;      // a supporting position lends this share of its garrison
  const HOLD_BONUS = 1.25;        // a held (dug-in) position defends at this multiple
  const BASTION_BONUS = 1.5;      // ... or this, with the Bastion technology

  // ---- roles: the initiative draft ------------------------------------------
  // At the start of every round each seat drafts one role, fewest points
  // first, so the seat behind picks before the leader. A role is one
  // strong ability for that round only.
  const ROLES = {
    admiral:   { label: "Admiral",   icon: "\u2693", text: "Two extra orders this round." },
    marshal:   { label: "Marshal",   icon: "\u2694", text: "Your fleets strike 20% harder this round, in assaults and in lanes." },
    warden:    { label: "Warden",    icon: "\u26e8", text: "Every position you hold is dug in this round, without spending orders." },
    engineer:  { label: "Engineer",  icon: "\u2692", text: "Your first upgrade this round is free and research costs a quarter less." },
    merchant:  { label: "Merchant",  icon: "\u25c8", text: "Your positions pay double credits this round." },
    spymaster: { label: "Spymaster", icon: "\u25c9", text: "You see the whole galaxy, and your forecast shows every rival's locked orders, this round." }
  };
  const ROLE_KEYS = Object.keys(ROLES);
  const MARSHAL_BONUS = 1.2;
  function roleOf(game, seat) { return (game.roles && game.roles[seat]) || null; }

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
  // Every browser must compute the same round from the same orders: online,
  // each client re-runs the resolve itself and only the orders are stored.
  // Math.sqrt and + - * / are exactly specified in JavaScript; Math.hypot,
  // Math.pow and the trig functions are not, and may differ in the last
  // bit between engines. So the simulation uses only the former.
  function dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.sqrt(dx * dx + dy * dy); }
  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function emit(game, ev) {
    game.events.push(ev);
    // Every point is logged with its round and reason, for the scoreboard.
    if (ev.kind === "score" && game.scoreLog) {
      game.scoreLog.push({ round: game.round, owner: ev.owner, points: ev.points, why: ev.why, objective: ev.objective || null, secret: !!ev.secret });
    }
  }

  function factionOf(game, seat) {
    const s = game.seatById[seat];
    return s && FACTIONS[s.faction] ? s.faction : "standard";
  }
  function mod(game, seat, key) {
    if (!seat) return MOD_DEFAULTS[key];
    const v = FACTIONS[factionOf(game, seat)].mods[key];
    return v === undefined ? MOD_DEFAULTS[key] : v;
  }
  function fleetSpeed(game, seat) { return FLEET_SPEED * mod(game, seat, "speed") * (game.tech && hasTech(game, seat, "drives") ? 1.2 : 1); }
  const UPGRADE_COSTS = [60, 164, 295, 448];      // 60 x (level + 1)^1.45, rounded
  function upgradeCost(level) { return UPGRADE_COSTS[level] || UPGRADE_COSTS[UPGRADE_COSTS.length - 1]; }

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
  // The value is the round it was researched; 0 means it came with a legacy.
  function hasTech(game, seat, id) { return !!game.tech[seat] && game.tech[seat][id] !== undefined; }
  function techCount(game, seat) { return game.tech[seat] ? Object.keys(game.tech[seat]).length : 0; }
  function techPrereq(id) {
    const t = TECHS[id];
    return TECH_KEYS.find((k) => TECHS[k].branch === t.branch && TECHS[k].tier === t.tier - 1) || null;
  }
  // What a technology costs this seat, or null if it cannot research it.
  function techCost(game, seat, id) {
    const t = TECHS[id];
    if (!t || hasTech(game, seat, id)) return null;
    const pre = techPrereq(id);
    if (pre && !hasTech(game, seat, pre)) return null;
    return Math.round(TECH_COSTS[t.tier] * mod(game, seat, "research") * (roleOf(game, seat) === "engineer" ? 0.75 : 1));
  }
  function assaultMult(game, seat) {
    return (1 + ASSAULT_PER * ((hasTech(game, seat, "assault1") ? 1 : 0) + (hasTech(game, seat, "assault2") ? 1 : 0))) * mod(game, seat, "attack") *
      (roleOf(game, seat) === "marshal" ? MARSHAL_BONUS : 1);
  }
  // What the n-th upgrade a seat makes this round costs (n from 0): the
  // Engineer's first is free.
  function upgradePrice(game, seat, level, nth) {
    return roleOf(game, seat) === "engineer" && nth === 0 ? 0 : upgradeCost(level);
  }
  function fortifyMult(game, seat) {
    return (1 + FORTIFY_PER * ((hasTech(game, seat, "fortify1") ? 1 : 0) + (hasTech(game, seat, "fortify2") ? 1 : 0))) * mod(game, seat, "defence");
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
  // Every seat starts with three positions (Command, Factory, Mine) and the
  // neutrals at 1.6x: measured, the first fight with a rival came at round
  // 6.6 before, 5.0 after, and rounds with no fight fell from 49% to 32%.
  const NEUTRAL_GARRISON = 1.6;
  // Fifteen positions a wedge: 61 in a four-seat galaxy, 91 with six. The
  // radius grows with the seat count so every galaxy has the same density
  // and the same distance between neighbours.
  const WEDGE = [
    // r (fraction of radius), angle (fraction of the wedge, 0..1), type, garrison
    { r: 0.86, a: 0.50, type: "command", g: 30, home: true },
    { r: 0.74, a: 0.34, type: "factory", g: 14, homeSide: true },
    { r: 1.00, a: 0.50, type: "factory", g: 8 },
    { r: 0.74, a: 0.68, type: "mine", g: 8, homeSide: true },
    { r: 0.97, a: 0.20, type: "relay", g: 8 },
    { r: 0.97, a: 0.80, type: "factory", g: 12 },
    { r: 0.62, a: 0.52, type: "relay", g: 12 },
    { r: 0.62, a: 0.12, type: "factory", g: 16 },
    { r: 0.84, a: 0.04, type: "relay", g: 14 },
    { r: 0.80, a: 0.90, type: "mine", g: 12 },
    { r: 0.48, a: 0.30, type: "mine", g: 14 },
    { r: 0.48, a: 0.76, type: "factory", g: 16 },
    { r: 0.34, a: 0.52, type: "relay", g: 18 },
    { r: 0.24, a: 0.10, type: "mine", g: 20 },
    { r: 0.60, a: 0.90, type: "relay", g: 16 }
  ];
  function galaxyRadius(seatCount) {
    return Math.round(GALAXY_R * Math.sqrt((WEDGE.length * seatCount) / 36));
  }

  function generateGalaxy(seed, seatCount) {
    const rng = makeRng(seed ^ 0x51ed27);
    const N = clamp(seatCount | 0, 2, 6);
    const R = galaxyRadius(N);
    const W = 2 * Math.round(R * 1.15), H = W, cx = W / 2, cy = H / 2;
    // Jitter one wedge, then copy it round.
    const jit = WEDGE.map((p) => ({
      r: p.r + (rng() - 0.5) * 0.05,
      a: clamp(p.a + (rng() - 0.5) * 0.06, 0.02, 0.98),
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
        const ang = a0 + j.a * span, rr = j.r * R;
        nodes.push({
          // Whole-unit coordinates: cos and sin may differ in the last bit
          // between browsers, and a rounded position does not.
          id: nodes.length, x: Math.round(cx + Math.cos(ang) * rr), y: Math.round(cy + Math.sin(ang) * rr),
          type: j.p.type, terrain: j.terrain,
          owner: j.p.home || j.p.homeSide ? s + 1 : NEUTRAL,
          // Unclaimed ground is held more stubbornly than it used to be, so
          // a rival's border becomes the cheaper target sooner.
          garrison: j.p.home || j.p.homeSide ? j.p.g : Math.round(j.p.g * NEUTRAL_GARRISON), level: 0, sector: s,
          name: j.p.home ? SECTOR_NAMES[s % SECTOR_NAMES.length] : null
        });
      }
    }
    const lanes = symmetricLanes(gabrielLanes(nodes, GALAXY_R * 0.62), N, WEDGE.length);
    return { nodes, lanes, mapW: W, mapH: H };
  }

  // Rounded positions are not exactly rotations of each other, so a near
  // tie can keep a lane in one wedge and drop its copy in another. Keep a
  // lane only if every turned copy of it is there too: every seat gets the
  // same lanes, and a subset of a planar graph is still planar.
  function symmetricLanes(lanes, N, K) {
    const key = (a, b) => (a < b ? a + "-" + b : b + "-" + a);
    const have = new Set(lanes.map((l) => key(l.a, l.b)));
    const turn = (id, t) => (id === 0 ? 0 : 1 + (((Math.floor((id - 1) / K) + t) % N) * K) + ((id - 1) % K));
    return lanes.filter((l) => {
      for (let t = 1; t < N; t++) if (!have.has(key(turn(l.a, t), turn(l.b, t)))) return false;
      return true;
    });
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

  // ---- objectives ----------------------------------------------------------
  // Points come from places and moments, never from a kill count, so the
  // strongest army does not automatically lead. Public objectives are
  // revealed one a round, cheap ones first, so the whole table chases the
  // same goal at once and collides. Each seat also holds one secret.
  //
  // At status each seat may score ONE public objective it qualifies for
  // (the most valuable) and its secret, once each, as in Twilight
  // Imperium. Everything is checked against the board as the round ends,
  // plus a few things that happened during it (game.flags).
  const owned = (g, seat, type) => g.nodes.filter((n) => n.owner === seat && (!type || n.type === type));
  const sectorsHeld = (g, seat) => new Set(owned(g, seat).filter((n) => n.sector >= 0).map((n) => n.sector));
  const homeOf = (g, seat) => g.seatById[seat].home;
  const OBJECTIVES = [
    // Stage I: 1 point.
    { id: "relays3", stage: 1, points: 1, text: "Hold 3 Relays", test: (g, s) => owned(g, s, "relay").length >= 3 },
    { id: "mines2", stage: 1, points: 1, text: "Hold 3 Mines", test: (g, s) => owned(g, s, "mine").length >= 3 },
    { id: "spread", stage: 1, points: 1, text: "Hold positions in 2 sectors besides your own", test: (g, s) => [...sectorsHeld(g, s)].filter((x) => x !== homeOf(g, s)).length >= 2 },
    { id: "raid", stage: 1, points: 1, text: "Take a position from a rival", test: (g, s) => g.flags[s].rivalTaken >= 1 },
    { id: "nine", stage: 1, points: 1, text: "Hold 9 positions", test: (g, s) => owned(g, s).length >= 9 },
    { id: "twoTaken", stage: 1, points: 1, text: "Take 2 positions in one round", test: (g, s) => g.flags[s].captures >= 2 },
    { id: "underdog", stage: 1, points: 1, text: "Win a lane battle against a larger fleet", test: (g, s) => g.flags[s].underdog },
    { id: "research", stage: 1, points: 1, text: "Own 2 technologies", test: (g, s) => techCount(g, s) >= 2 },
    { id: "border", stage: 1, points: 1, text: "Hold a position in a rival's home sector", test: (g, s) => g.seats.some((r) => r.id !== s && owned(g, s).some((n) => n.sector === r.home)) },
    // Stage II: 2 points.
    { id: "court", stage: 2, points: 2, text: "Hold the Throne and 2 positions next to it", test: (g, s) => { const t = throneNode(g); return !!t && t.owner === s && neighbors(g, t.id).filter((id) => g.nodes[id].owner === s).length >= 2; } },
    { id: "fifteen", stage: 2, points: 2, text: "Hold 15 positions", test: (g, s) => owned(g, s).length >= 15 },
    { id: "everywhere", stage: 2, points: 2, text: "Hold a position in every sector", test: (g, s) => sectorsHeld(g, s).size >= g.seats.length },
    { id: "relays5", stage: 2, points: 2, text: "Hold 5 Relays", test: (g, s) => owned(g, s, "relay").length >= 5 },
    { id: "humble", stage: 2, points: 2, text: "Take a position from the seat leading on points", test: (g, s) => g.flags[s].tookFromLeader },
    { id: "conquest", stage: 2, points: 2, text: "Take 3 positions from rivals in one round", test: (g, s) => g.flags[s].rivalTaken >= 3 },
    { id: "regicide", stage: 2, points: 2, text: "Strike a seat ahead of you on points with the Doomstar", test: (g, s) => g.flags[s].doomOnLeader },
    { id: "doctrine", stage: 2, points: 2, text: "Own technologies in 3 branches", test: (g, s) => new Set(Object.keys(g.tech[s]).map((k) => TECHS[k].branch)).size >= 3 }
  ];
  const SECRETS = [
    { id: "crown", points: 2, text: "Take a rival's Command", test: (g, s) => g.flags[s].tookCommand },
    { id: "severed", points: 1, text: "Have 3 rival positions cut off from supply at once", test: (g, s) => g.nodes.filter((n) => n.owner !== s && n.owner !== NEUTRAL && n.inSupply === false).length >= 3 },
    { id: "untouched", points: 1, text: "Lose nothing in a round while holding 10 positions", test: (g, s) => g.flags[s].lost === 0 && owned(g, s).length >= 10 },
    { id: "blitz", points: 1, text: "Take 3 positions in one round", test: (g, s) => g.flags[s].captures >= 3 },
    { id: "beachhead", points: 1, text: "Hold 2 positions in a rival's home sector", test: (g, s) => g.seats.some((r) => r.id !== s && owned(g, s).filter((n) => n.sector === r.home).length >= 2) },
    { id: "butcher", points: 1, text: "Destroy 40 enemy units in lane battles in one round", test: (g, s) => g.flags[s].laneKills >= 40 },
    { id: "fortress", points: 1, text: "Hold every position in your home sector", test: (g, s) => g.nodes.filter((n) => n.sector === homeOf(g, s)).every((n) => n.owner === s) },
    { id: "kingmaker", points: 1, text: "Win a fight that your support decided", test: (g, s) => g.flags[s].supportDecisive }
  ];
  const STAGE_ONE_SHOWN = 6, STAGE_TWO_SHOWN = 6;
  function objectiveById(id) { return OBJECTIVES.find((o) => o.id === id) || SECRETS.find((o) => o.id === id) || null; }
  function blankFlags() {
    return { upgrades: 0, captures: 0, lost: 0, laneKills: 0, underdog: false, doomOnLeader: false, tookCommand: false, supportDecisive: false,
      rivalTaken: 0, tookFromLeader: false };
  }
  // A shuffled deck from the seed: six stage I objectives, then six stage
  // II, two showing at the start and one more revealed at every status.
  function dealObjectives(game, rng) {
    const shuffle = (arr) => { const a = arr.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; } return a; };
    const one = shuffle(OBJECTIVES.filter((o) => o.stage === 1)).slice(0, STAGE_ONE_SHOWN).map((o) => o.id);
    const two = shuffle(OBJECTIVES.filter((o) => o.stage === 2)).slice(0, STAGE_TWO_SHOWN).map((o) => o.id);
    game.deck = one.concat(two);
    game.revealed = 2;
    game.scored = {};                       // objective id -> [seat ids that scored it]
    const secrets = shuffle(SECRETS);
    game.secret = {};
    game.seats.forEach((s, i) => { game.secret[s.id] = { id: secrets[i % secrets.length].id, scored: false }; });
  }
  function publicObjectives(game) { return game.deck.slice(0, game.revealed).map(objectiveById); }

  function scoreObjectives(game) {
    for (const seat of seatOrder(game)) {
      if (!alive(game, seat)) continue;
      const open = publicObjectives(game)
        .filter((o) => !(game.scored[o.id] || []).includes(seat) && o.test(game, seat))
        .sort((a, b) => b.points - a.points);
      if (open.length) {
        const o = open[0];
        (game.scored[o.id] = game.scored[o.id] || []).push(seat);
        game.points[seat] += o.points;
        emit(game, { kind: "score", owner: seat, points: o.points, why: o.text, objective: o.id });
      }
      const sec = game.secret[seat], so = sec && objectiveById(sec.id);
      if (so && !sec.scored && so.test(game, seat)) {
        sec.scored = true;
        game.points[seat] += so.points;
        emit(game, { kind: "score", owner: seat, points: so.points, why: so.text, objective: so.id, secret: true });
      }
    }
    if (game.revealed < game.deck.length) {
      game.revealed += 1;
      emit(game, { kind: "reveal", objective: game.deck[game.revealed - 1] });
    }
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
      personality: s.personality || null,
      color: SEAT_COLORS[i]
    }));
    const perSeat = (v) => { const o2 = {}; for (const s of seats) o2[s.id] = typeof v === "function" ? v(s) : v; return o2; };
    const game = {
      seed, mapW: map.mapW, mapH: map.mapH,
      nodes, lanes: map.lanes, adjacency,
      seats, seatById: {},
      fleets: [],
      credits: perSeat(40),
      tech: perSeat(() => ({})),   // technology id -> round researched
      charge: perSeat(0),
      points: perSeat(0),
      stats: perSeat(() => ({ sent: 0, captured: 0, lost: 0, fired: 0, taken: 0 })),
      chargeTimer: DOOM_CHARGE_INTERVAL,
      doomShot: null,
      time: 0,
      round: 1,
      phase: o.draft ? "draft" : "plot",   // draft | plot | resolve | over
      useDraft: !!o.draft,
      draft: null,            // { order: [seat...], picks: { seat: role } } while drafting
      roles: {},              // this round's roles, seat -> role
      clock: 0,               // seconds into the current resolve
      orders: perSeat(() => []),
      locked: perSeat(false),
      support: [],            // this round's live support orders
      held: {},               // node id -> seat, positions dug in this round
      useCouncil: !!o.council,
      influence: perSeat(INFLUENCE_START),
      votes: perSeat(null),
      agenda: null,           // { law, round } before the council this round
      laws: [],               // laws in force: { id, seat?, from, to }
      lawLog: [],             // every council's result
      lawDeck: [],
      grudge: perSeat(() => ({})),
      pacts: [],              // { a, b, from, to }
      offers: [],             // { from, to } waiting for an answer this round
      oathbreaker: perSeat(0),  // last round a seat is an Oathbreaker
      winner: null,
      events: [],
      pointsToWin: o.pointsToWin || POINTS_TO_WIN,
      roundLimit: o.roundLimit || ROUND_LIMIT,
      scoreLog: [],           // { round, owner, points, why, objective, secret }, in order
      history: []             // one entry per finished round: { round, orders, points }
    };
    for (const s of seats) {
      game.seatById[s.id] = s;
      const home = nodes.find((n) => n.type === "command" && n.owner === s.id);
      s.home = home ? home.sector : -1;
    }
    game.flags = perSeat(blankFlags);
    dealObjectives(game, makeRng(seed ^ 0x0b1ec7));
    computeSupply(game);
    // The opening board is public, as a board game's is; after that each
    // seat only knows what it has seen.
    game.intel = perSeat(() => nodes.map((n) => [n.owner, n.garrison, n.level, 0]));
    openCouncil(game);
    if (game.useDraft) openDraft(game);
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
      // Convoys: the Deep Combine's supply also runs through its partners.
      const through = factionOf(game, s.id) === "logistics" && game.pacts ? partnersOf(game, s.id) : [];
      while (stack.length) {
        const cur = stack.pop();
        if (game.nodes[cur].owner === s.id) game.nodes[cur].inSupply = true;
        for (const nx of neighbors(game, cur)) {
          const o = game.nodes[nx].owner;
          if (seen.has(nx) || (o !== s.id && through.indexOf(o) === -1)) continue;
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
    return !!t && t.owner === seat && (game.charge[seat] || 0) >= DOOM_CHARGE_NEEDED && !game.doomShot &&
      !lawActive(game, "interdict") && !lawActive(game, "censure", seat);
  }

  // ---- routing: only through your own ground --------------------------
  // Routes run only through your own ground. Deep Strike (Kestrel Wings)
  // may also cross one unclaimed position per route: the search runs on
  // (position, crossed yet?) pairs, key id or id + N.
  function findPath(game, fromId, toId, seat) {
    if (fromId === toId) return null;
    const deep = seat !== undefined && factionOf(game, seat) === "vanguard";
    const N = game.nodes.length;
    const distTo = { [fromId]: 0 }, prev = {}, done = new Set();
    const queue = [fromId];
    let goal = null;
    while (queue.length) {
      let bi = 0;
      for (let i = 1; i < queue.length; i++) if (distTo[queue[i]] < distTo[queue[bi]]) bi = i;
      const key = queue.splice(bi, 1)[0];
      const cur = key % N, used = key >= N;
      if (cur === toId) { goal = key; break; }
      if (done.has(key)) continue;
      done.add(key);
      for (const nx of neighbors(game, cur)) {
        let nkey = used ? nx + N : nx;
        if (nx !== toId && seat !== undefined && game.nodes[nx].owner !== seat) {
          if (!deep || used || game.nodes[nx].owner !== NEUTRAL) continue;
          nkey = nx + N;
        }
        if (done.has(nkey)) continue;
        const d = distTo[key] + dist(game.nodes[cur], game.nodes[nx]);
        if (distTo[nkey] === undefined || d < distTo[nkey]) {
          distTo[nkey] = d; prev[nkey] = key;
          if (queue.indexOf(nkey) === -1) queue.push(nkey);
        }
      }
    }
    if (goal === null) return null;
    const path = [toId];
    let k = goal;
    while (k !== fromId) { k = prev[k]; path.unshift(k % N); }
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
    return Math.max(1, Math.min(CP_MAX, CP_BASE + Math.floor(nodesOf(game, seat).length / CP_PER)) +
      (roleOf(game, seat) === "admiral" ? 2 : 0) + lawCount(game, "mobilize") + (hasTech(game, seat, "logistics") ? 1 : 0) - (lawActive(game, "censure", seat) ? 2 : 0));
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
      const nth = mine.filter((o) => o.kind === "upgrade").length;
      const cost = upgradePrice(game, seat, at.level + planned, nth);
      if (spendable(game, seat) < cost) return "Need " + cost + " credits.";
      return undefined;
    }
    if (order.kind === "research") {
      const t = TECHS[order.tech];
      if (!t) return "No such technology.";
      if (mine.some((o) => o.kind === "research")) return "One technology a round.";
      if (hasTech(game, seat, order.tech)) return "You already have " + t.label + ".";
      const cost = techCost(game, seat, order.tech);
      if (cost === null) return t.label + " needs " + TECHS[techPrereq(order.tech)].label + " first.";
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
    const ups = game.orders[seat].filter((x) => x.kind === "upgrade");
    for (const o of game.orders[seat]) {
      if (o.kind === "upgrade") {
        const at = game.nodes[o.at];
        const before = game.orders[seat].filter((x) => x.kind === "upgrade" && x.at === o.at);
        c -= upgradePrice(game, seat, at.level + before.indexOf(o), ups.indexOf(o));
      } else if (o.kind === "research") {
        c -= techCost(game, seat, o.tech) || 0;
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
    for (const s of game.seats) game.flags[s.id] = blankFlags();
    resolveCouncil(game);
    breakPacts(game);
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
      else applyResearch(game, seat, o.tech);
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
    const cost = upgradePrice(game, seat, n.level, game.flags[seat].upgrades);
    if (game.credits[seat] < cost) return;
    game.credits[seat] -= cost;
    game.flags[seat].upgrades += 1;
    n.level += 1;
    emit(game, { kind: "upgrade", x: n.x, y: n.y, owner: seat, level: n.level });
  }
  function applyResearch(game, seat, id) {
    const cost = techCost(game, seat, id);
    if (cost === null || game.credits[seat] < cost) return;
    game.credits[seat] -= cost;
    game.tech[seat][id] = game.round;
    emit(game, { kind: "research", owner: seat, tech: id });
  }
  function launch(game, seat, fromId, toId, frac) {
    const from = game.nodes[fromId];
    if (!from || from.owner !== seat) return;
    const path = findPath(game, fromId, toId, seat);
    if (!path) return;
    const count = Math.floor(from.garrison * frac);
    if (count < MIN_SEND) return;
    from.garrison -= count;
    // Deep Strike: crossing unclaimed ground costs a third of the fleet.
    const crossed = path.slice(1, -1).some((id) => game.nodes[id].owner !== seat);
    game.fleets.push({
      owner: seat, from: fromId, to: toId, count: crossed ? count * DEEP_STRIKE_KEEP : count, path, leg: 0, t: 0,
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
    if (game.points[victim] > game.points[shot.owner]) game.flags[shot.owner].doomOnLeader = true;
    addGrudge(game, victim, shot.owner, 2);
    emit(game, { kind: "doomstar", x: t.x, y: t.y, owner: shot.owner, nodeId: t.id, damage: Math.round(before - t.garrison), wiped });
  }
  function stepCharge(game, dt) {
    if (!throneNode(game)) return;
    game.chargeTimer -= dt;
    if (game.chargeTimer > 0) return;
    game.chargeTimer += DOOM_CHARGE_INTERVAL;
    for (const s of game.seats) {
      const gained = game.nodes.reduce((sum, n) => sum + (n.owner === s.id ? relayCharge(game, n) : 0), 0) *
        mod(game, s.id, "chargeRate") * (hasTech(game, s.id, "capacitors") ? 1.5 : 1);
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
  // attacker is optional: Siege Lances see through terrain and digging in.
  function defenceOf(game, node, attacker) {
    const siege = attacker !== undefined && hasTech(game, attacker, "siege");
    const terrain = siege ? Math.min(1, terrainDefence(node)) : terrainDefence(node);
    if (node.owner === NEUTRAL) return node.garrison * terrain;
    const dug = game.held[node.id] === node.owner || (game.phase === "resolve" && roleOf(game, node.owner) === "warden");
    const hold = dug && !siege ? (hasTech(game, node.owner, "bastion") ? BASTION_BONUS : HOLD_BONUS) : 1;
    return node.garrison * DEFENDER_EDGE * fortifyMult(game, node.owner) * terrain * hold;
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
    const atkSupport = supportFor(game, to.id, a.owner, false);
    const attack = a.count * am + atkSupport;
    const defender = to.owner;
    const defSupport = defender !== NEUTRAL ? supportFor(game, to.id, defender, true) : 0;
    const defence = defenceOf(game, to, a.owner) + defSupport;
    if (attack > defence) {
      const fa = game.flags[a.owner];
      fa.captures += 1;
      if (to.type === "command" && defender !== NEUTRAL) fa.tookCommand = true;
      if (atkSupport > 0 && attack - atkSupport <= defence) fa.supportDecisive = true;
      if (defender !== NEUTRAL) {
        game.flags[defender].lost += 1;
        fa.rivalTaken += 1;
        // The leader: strictly ahead of everyone else on points.
        const others = game.seats.filter((x) => x.id !== defender).map((x) => game.points[x.id]);
        if (game.points[defender] > Math.max.apply(null, others)) fa.tookFromLeader = true;
      }
      const survivors = (attack - defence) / am;
      to.owner = a.owner;
      to.level = 0;
      to.garrison = Math.min(nodeStats(to, game).cap, Math.max(1, survivors));
      game.stats[a.owner].captured += 1;
      if (defender !== NEUTRAL) game.stats[defender].lost += 1;
      emit(game, { kind: "capture", x: to.x, y: to.y, owner: a.owner, from: defender, nodeId: to.id, count: Math.round(to.garrison) });
      addGrudge(game, defender, a.owner, to.type === "command" ? 3 : 1);
      if (factionOf(game, a.owner) === "shock") game.held[to.id] = a.owner;
      if (to.type === "command" && defender !== NEUTRAL && lawActive(game, "reparations")) {
        game.points[a.owner] += 1;
        emit(game, { kind: "score", owner: a.owner, points: 1, why: "Reparations for a Command" });
      }
    } else {
      const perUnit = defenceOf(game, to, a.owner) / Math.max(1e-9, to.garrison);
      const ownShare = defenceOf(game, to, a.owner) / Math.max(1e-9, defence);
      to.garrison = Math.max(0, to.garrison - (attack * ownShare) / Math.max(1e-9, perUnit));
      if (defender !== NEUTRAL && defSupport > 0 && defence - defSupport < attack) game.flags[defender].supportDecisive = true;
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
        const ma = assaultMult(game, a.owner) * (hasTech(game, a.owner, "pickets") ? 1.25 : 1);
        const mb = assaultMult(game, b.owner) * (hasTech(game, b.owner, "pickets") ? 1.25 : 1);
        const ea = a.count * ma, eb = b.count * mb;
        const pa = lanePoint(game, a), pb = lanePoint(game, b);
        const cA = a.count, cB = b.count;
        let winner = NEUTRAL, left = 0;
        if (ea > eb) { a.count = (ea - eb) / ma; b.count = 0; winner = a.owner; left = a.count; }
        else if (eb > ea) { b.count = (eb - ea) / mb; a.count = 0; winner = b.owner; left = b.count; }
        else { a.count = 0; b.count = 0; }
        if (a.count < 0.5) a.count = 0;
        if (b.count < 0.5) b.count = 0;
        if (winner !== NEUTRAL) {
          const loserCount = winner === a.owner ? cB : cA, winCount = winner === a.owner ? cA : cB;
          const fw = game.flags[winner];
          fw.laneKills += loserCount;
          if (winCount < loserCount) fw.underdog = true;
        }
        emit(game, { kind: "clash", x: (pa.x + pb.x) / 2, y: (pa.y + pb.y) / 2, owner: winner, count: Math.round(left),
          lane: [a.path[a.leg], a.path[a.leg + 1]],
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
      if (!lawActive(game, "sanction", n.owner))
        game.credits[n.owner] += s.creditRate * m * dt * (roleOf(game, n.owner) === "merchant" ? 2 : 1);
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
  // Every resolve, forecast and replay steps by exactly STEP: the same
  // orders then give the same round on every screen and every client.
  const STEP = 1 / 20;
  function runRound(game, dt) {
    const h = dt || STEP;
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
    if (throne && throne.owner !== NEUTRAL && !lawActive(game, "sanctuary")) {
      const tp = thronePoints(game);
      game.points[throne.owner] += tp;
      emit(game, { kind: "score", owner: throne.owner, points: tp, why: "Held the Throne" });
    }
    scoreObjectives(game);
    refreshIntel(game);
    for (const s of game.seats) {
      if (!alive(game, s.id)) continue;
      game.influence[s.id] += 1 + game.nodes.filter((n) => n.owner === s.id && n.type === "relay").length + (hasTech(game, s.id, "envoys") ? 1 : 0);
      const gr = game.grudge[s.id];
      for (const k in gr) { gr[k] = Math.round(gr[k] * 2 / 3 * 100) / 100; if (gr[k] < 0.3) delete gr[k]; }
    }
    for (const p of game.pacts) {
      if (p.from > game.round || game.round > p.to) continue;
      if (factionOf(game, p.a) === "prospectors" || factionOf(game, p.b) === "prospectors") {
        game.credits[p.a] += TRADE_PACT_CREDITS; game.credits[p.b] += TRADE_PACT_CREDITS;
      }
    }
    game.history[game.history.length - 1].points = Object.assign({}, game.points);
    const live = liveSeats(game);
    const leader = game.seats.slice().sort((a, b) => standing(game, b.id) - standing(game, a.id))[0];
    if (live.length === 1) game.winner = live[0];
    else if (live.length === 0) game.winner = NEUTRAL;
    else if (game.points[leader.id] >= game.pointsToWin) game.winner = leader.id;
    else if (game.round >= game.roundLimit) game.winner = leader.id;
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
    game.roles = {};
    for (const s of game.seats) { game.orders[s.id] = []; game.locked[s.id] = !alive(game, s.id); }
    game.offers = [];
    openCouncil(game);
    if (game.useDraft) openDraft(game);
    emit(game, { kind: "round", round: game.round });
  }

  // ---- the council ----------------------------------------------------------
  // Politics is a second board. Every round one law comes before the
  // council. Every live seat has one vote and may add influence to it,
  // earned from Relays; votes are secret until the orders lock, and the
  // law takes effect as the round resolves. Some laws elect a seat.
  const INFLUENCE_START = 2;
  const PERMANENT = 9999;
  const LAWS = {
    mobilize: { kind: "law", label: "Mobilization", text: "Every seat plots one more order, from now on." },
    sanctuary: { kind: "law", label: "Sanctuary", text: "Holding the Throne scores nothing this round." },
    interdict: { kind: "law", label: "Interdiction", text: "Nobody may fire the Doomstar this round or the next." },
    tariff: { kind: "law", label: "Levy", text: "Every seat pays a fifth of its credits; the seats with fewest points share it." },
    openSkies: { kind: "law", label: "Open Skies", text: "Every seat sees the whole galaxy this round." },
    reparations: { kind: "law", label: "Reparations", text: "Taking a rival's Command scores 1 point, from now on." },
    censure: { kind: "elect", label: "Censure", text: "The elected seat plots two fewer orders and may not fire the Doomstar next round." },
    laurel: { kind: "elect", label: "Laurel", text: "The elected seat scores 1 point." },
    marque: { kind: "elect", label: "Letter of Marque", text: "The elected seat receives 80 credits." },
    sanction: { kind: "elect", label: "Sanction", text: "The elected seat earns no credits this round." }
  };
  const LAW_KEYS = Object.keys(LAWS);
  function lawActive(game, id, seat) {
    if (!game.laws) return false;
    return game.laws.some((l) => l.id === id && l.from <= game.round && game.round <= l.to && (seat === undefined || l.seat === seat));
  }
  function lawCount(game, id) {
    return game.laws ? game.laws.filter((l) => l.id === id && l.from <= game.round && game.round <= l.to).length : 0;
  }
  function openCouncil(game) {
    if (!game.useCouncil) return;
    if (!game.lawDeck.length) game.lawDeck = shuffled(LAW_KEYS, makeRng(game.seed ^ (0x1a3 + game.round * 7919)));
    game.agenda = { law: game.lawDeck.shift(), round: game.round };
    for (const s of game.seats) game.votes[s.id] = null;
    emit(game, { kind: "agenda", law: game.agenda.law });
  }
  function shuffled(list, rng) {
    const a = list.slice();
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); const t = a[i]; a[i] = a[j]; a[j] = t; }
    return a;
  }
  function voteChoices(game) {
    if (!game.agenda) return [];
    return LAWS[game.agenda.law].kind === "elect" ? liveSeats(game) : ["for", "against"];
  }
  // Returns undefined if the vote is legal, else a reason. choice null
  // withdraws the vote.
  function castVote(game, seat, choice, influence) {
    if (!game.agenda) return "Nothing is before the council.";
    if (game.phase !== "plot" && game.phase !== "draft") return "Votes are cast while plotting.";
    if (game.locked[seat]) return "Your orders are locked.";
    if (choice === null) { game.votes[seat] = null; return undefined; }
    if (voteChoices(game).indexOf(choice) === -1) return "Not a choice on this agenda.";
    const inf = Math.max(0, Math.floor(influence || 0));
    if (inf > game.influence[seat]) return "Not enough influence.";
    game.votes[seat] = { choice, influence: inf };
    return undefined;
  }
  function tally(game) {
    const t = {};
    for (const c of voteChoices(game)) t[c] = 0;
    for (const s of game.seats) {
      const v = game.votes[s.id];
      if (!v || !alive(game, s.id) || t[v.choice] === undefined) continue;
      t[v.choice] += (factionOf(game, s.id) === "standard" ? 2 : 1) + v.influence;
    }
    return t;
  }
  function resolveCouncil(game) {
    if (!game.agenda || game.skipCouncil) return;
    const law = LAWS[game.agenda.law], id = game.agenda.law, t = tally(game);
    for (const s of game.seats) { const v = game.votes[s.id]; if (v) game.influence[s.id] -= v.influence; }
    let passed = false, elected = null;
    if (law.kind === "elect") {
      // Most votes wins; a tie goes to the seat with fewer points, then to
      // the turn order. Nobody voting elects nobody.
      const rank = {};
      seatOrder(game).forEach((x, i) => { rank[x] = i; });
      const best = voteChoices(game).filter((c) => t[c] > 0)
        .sort((a, b) => t[b] - t[a] || game.points[a] - game.points[b] || rank[a] - rank[b])[0];
      if (best !== undefined) { passed = true; elected = best; }
    } else passed = t.for > t.against;
    const votes = {};
    for (const s of game.seats) votes[s.id] = game.votes[s.id];
    emit(game, { kind: "law", law: id, passed, elected, tally: t, votes });
    game.lawLog.push({ round: game.round, law: id, passed, elected, tally: t, votes });
    if (!passed) return;
    const r = game.round, add = (o) => game.laws.push(Object.assign({ id, from: r, to: r }, o));
    switch (id) {
      case "mobilize": add({ to: PERMANENT }); break;
      case "reparations": add({ to: PERMANENT }); break;
      case "sanctuary": case "openSkies": add({}); break;
      case "interdict": add({ to: r + 1 }); break;
      case "censure": add({ seat: elected, from: r + 1, to: r + 1 }); break;
      case "sanction": add({ seat: elected }); break;
      case "laurel":
        game.points[elected] += 1;
        emit(game, { kind: "score", owner: elected, points: 1, why: "Laurel of the council" });
        break;
      case "marque": game.credits[elected] += 80; break;
      case "tariff": {
        const live = liveSeats(game);
        let pot = 0;
        for (const x of live) { const pay = game.credits[x] / 5; game.credits[x] -= pay; pot += pay; }
        const low = Math.min.apply(null, live.map((x) => game.points[x]));
        const poor = live.filter((x) => game.points[x] === low);
        for (const x of poor) game.credits[x] += pot / poor.length;
        break;
      }
    }
  }
  // ---- pacts ------------------------------------------------------------
  // A promise between two seats: neither attacks the other for a few
  // rounds, and both see what the other sees. Nothing in the rules stops
  // an attack. Plotting one against a partner breaks the pact as the orders
  // lock, and the breaker is an Oathbreaker for three rounds: its influence
  // is gone, every other seat holds a grudge, and nobody will deal with it.
  const PACT_ROUNDS = 2, OATH_ROUNDS = 3;
  function pactBetween(game, a, b) {
    return (game.pacts || []).find((p) => ((p.a === a && p.b === b) || (p.a === b && p.b === a)) && p.from <= game.round && game.round <= p.to) || null;
  }
  function partnersOf(game, seat) {
    return (game.pacts || []).filter((p) => (p.a === seat || p.b === seat) && p.from <= game.round && game.round <= p.to)
      .map((p) => (p.a === seat ? p.b : p.a));
  }
  function oathbroken(game, seat) { return !!game.oathbreaker && (game.oathbreaker[seat] || 0) >= game.round; }
  function checkPact(game, a, b) {
    if (!game.useCouncil) return "There is no council to witness a pact.";
    if (game.phase !== "plot" && game.phase !== "draft") return "Pacts are made while plotting.";
    if (a === b || !game.seatById[b] || !alive(game, b)) return "No such seat.";
    if (pactBetween(game, a, b)) return "You already have a pact.";
    // Online, a pact with a person would need an answer mid-plot; only
    // rivals deal with each other there, for now.
    if (game.online && (!game.seatById[a].ai || !game.seatById[b].ai)) return "Pacts with people are not made online yet.";
    if (oathbroken(game, a)) return "Nobody deals with an Oathbreaker.";
    if (oathbroken(game, b)) return "That seat is an Oathbreaker.";
    if (game.orders[a].some((o) => orderVictim(game, a, o) === b)) return "Your orders already strike them.";
    if (game.orders[b].some((o) => orderVictim(game, b, o) === a)) return "Their orders already strike you.";
    return undefined;
  }
  // An offer waits for the other seat to answer while plotting.
  function offerPact(game, from, to) {
    const why = checkPact(game, from, to);
    if (why) return why;
    if (game.offers.some((o) => o.from === from && o.to === to)) return "Already offered.";
    game.offers.push({ from, to });
    emit(game, { kind: "offer", from, to });
    return undefined;
  }
  function answerOffer(game, to, from, yes) {
    const i = game.offers.findIndex((o) => o.from === from && o.to === to);
    if (i === -1) return "No such offer.";
    game.offers.splice(i, 1);
    return yes ? makePact(game, from, to) : undefined;
  }
  // Both seats have agreed: the pact runs from this round for PACT_ROUNDS.
  function makePact(game, a, b) {
    const why = checkPact(game, a, b);
    if (why) return why;
    game.pacts.push({ a, b, from: game.round, to: game.round + PACT_ROUNDS - 1 });
    emit(game, { kind: "pact", a, b, to: game.round + PACT_ROUNDS - 1 });
    return undefined;
  }
  // Does this order strike at a seat? (Its target as the orders lock.)
  function orderVictim(game, seat, o) {
    if (o.kind === "send" || (o.kind === "support" && game.nodes[o.to].owner !== seat)) return game.nodes[o.to].owner;
    if (o.kind === "fire") return game.nodes[o.target].owner;
    return NEUTRAL;
  }
  function breakPacts(game) {
    if (!game.pacts || !game.pacts.length) return;
    for (const s of game.seats) {
      for (const o of game.orders[s.id]) {
        const v = orderVictim(game, s.id, o);
        if (v === NEUTRAL || v === s.id) continue;
        const p = pactBetween(game, s.id, v);
        if (!p) continue;
        p.to = game.round - 1;          // over, from this round
        game.oathbreaker[s.id] = game.round + OATH_ROUNDS - 1;
        game.influence[s.id] = 0;
        for (const x of game.seats) if (x.id !== s.id) addGrudge(game, x.id, s.id, x.id === v ? 4 : 2);
        emit(game, { kind: "betrayal", owner: s.id, victim: v });
      }
    }
  }

  // Grudges: who has hurt whom. They fade by a third each round. Rivals
  // turn on the seats that hurt them and vote against them.
  function addGrudge(game, victim, by, amount) {
    if (!game.grudge || victim === NEUTRAL || by === NEUTRAL || victim === by) return;
    const g = game.grudge[victim];
    g[by] = (g[by] || 0) + amount;
  }

  // ---- the draft -----------------------------------------------------------
  function draftOrder(game) {
    const rank = {};
    seatOrder(game).forEach((id, i) => { rank[id] = i; });
    return liveSeats(game).sort((a, b) => game.points[a] - game.points[b] || rank[a] - rank[b]);
  }
  function openDraft(game) {
    game.phase = "draft";
    game.roles = {};
    game.draft = { order: draftOrder(game), picks: {} };
  }
  function draftTurn(game) {
    if (game.phase !== "draft") return null;
    return game.draft.order.find((id) => !game.draft.picks[id]) || null;
  }
  function rolesLeft(game) {
    if (!game.draft) return ROLE_KEYS.slice();
    const taken = Object.values(game.draft.picks);
    return ROLE_KEYS.filter((k) => taken.indexOf(k) === -1);
  }
  function pickRole(game, seat, role) {
    if (game.phase !== "draft") return "The draft is over.";
    if (draftTurn(game) !== seat) return "It is not your pick.";
    if (!ROLES[role]) return "No such role.";
    if (rolesLeft(game).indexOf(role) === -1) return "That role is taken.";
    game.draft.picks[seat] = role;
    emit(game, { kind: "role", owner: seat, role });
    if (!draftTurn(game)) {
      game.roles = Object.assign({}, game.draft.picks);
      game.phase = "plot";
    }
    return undefined;
  }
  // Points first, then positions, then garrison: the order the season's
  // standings are read in.
  function standing(game, seat) {
    const own = nodesOf(game, seat);
    return game.points[seat] * 1e6 + own.length * 1e3 + own.reduce((s, n) => s + n.garrison, 0) / 1e3;
  }

  // ---- fog of war ------------------------------------------------------
  // A seat sees its own positions and everything one lane from them, two
  // lanes from its Relays, the lanes its fleets are on, and the Throne,
  // which everyone can always see. The Spymaster sees the whole galaxy for
  // its round. Everywhere else a seat knows only what it saw last.
  const SIGHT_RELAY = 2;
  function sightOf(game, seat) {
    const seen = ownSight(game, seat);
    if (seen.size === game.nodes.length) return seen;
    // Pact partners share what they see.
    for (const p of partnersOf(game, seat)) for (const id of ownSight(game, p)) seen.add(id);
    return seen;
  }
  function ownSight(game, seat) {
    const seen = new Set();
    if (roleOf(game, seat) === "spymaster" || lawActive(game, "openSkies")) { for (const n of game.nodes) seen.add(n.id); return seen; }
    const t = throneNode(game);
    if (t) seen.add(t.id);
    for (const n of game.nodes) {
      if (n.owner !== seat) continue;
      let ring = [n.id];
      seen.add(n.id);
      const relaySight = SIGHT_RELAY + (factionOf(game, seat) === "relays" ? 1 : 0);
      for (let hop = 0; hop < (n.type === "relay" ? relaySight : 1) + (hasTech(game, seat, "sensors") ? 1 : 0); hop++) {
        const nextRing = [];
        for (const id of ring) for (const nx of neighbors(game, id)) { if (!seen.has(nx)) nextRing.push(nx); seen.add(nx); }
        ring = nextRing;
      }
    }
    for (const f of game.fleets) {
      if (f.owner !== seat) continue;
      seen.add(f.path[f.leg]);
      if (f.leg + 1 < f.path.length) seen.add(f.path[f.leg + 1]);
    }
    return seen;
  }
  function fleetSeen(f, seat, sight) {
    return f.owner === seat || sight.has(f.path[f.leg]) || (f.leg + 1 < f.path.length && sight.has(f.path[f.leg + 1]));
  }
  function refreshIntel(game) {
    for (const s of game.seats) {
      const mem = game.intel[s.id];
      if (!mem) continue;            // a seat's view holds only its own memory
      const sight = sightOf(game, s.id);
      for (const id of sight) { const n = game.nodes[id]; mem[id] = [n.owner, n.garrison, n.level, game.round]; }
    }
  }
  // The galaxy as one seat knows it: positions out of sight as last seen,
  // fleets out of sight gone, nobody else's orders. The forecast and the
  // rival commanders both plan from this, never from the real board.
  function viewFor(game, seat) {
    const c = cloneGame(game);
    const sight = sightOf(game, seat), mem = game.intel[seat];
    for (const n of c.nodes) {
      if (sight.has(n.id)) continue;
      const m = mem[n.id];
      n.owner = m[0]; n.garrison = m[1]; n.level = m[2]; n.assault = null;
    }
    c.fleets = c.fleets.filter((f) => fleetSeen(f, seat, sight));
    for (const s of c.seats) if (s.id !== seat) { c.orders[s.id] = []; c.locked[s.id] = false; c.votes[s.id] = null; }
    c.intel = { [seat]: mem.map((m) => m.slice()) };
    c.viewOf = seat;
    computeSupply(c);
    return c;
  }

  // ---- the forecast ------------------------------------------------------
  // What the round will do if every other seat gives no orders at all: a
  // copy of the board with only this seat's plotted orders, run to the end
  // of the round. Returns a frame every `every` seconds for the slider.
  function forecast(game, seat, every) {
    const step0 = every || 1;
    const c = viewFor(game, seat);
    // Nobody knows how the council will vote, so the forecast leaves the
    // law out.
    c.skipCouncil = true;
    // The Spymaster sees rivals' orders once they are locked; everyone
    // else sees a galaxy where rivals do nothing.
    const spy = roleOf(game, seat) === "spymaster";
    for (const s of c.seats) if (s.id !== seat && spy && game.locked[s.id]) c.orders[s.id] = game.orders[s.id].map((o) => Object.assign({}, o));
    c.events = [];
    beginResolve(c);
    const frames = [snapshotFrame(c)];
    let next = step0;
    while (c.phase === "resolve") {
      step(c, STEP);
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
    NEUTRAL, NODE_TYPES, TERRAIN, BRANCHES, TECHS, TECH_KEYS, TECH_COSTS, MAX_LEVEL, FACTIONS, FACTION_KEYS, SEAT_COLORS,
    DEFENDER_EDGE, COALESCE_WINDOW, FLEET_SPEED, MIN_SEND, DOOM_CHARGE_NEEDED, DOOM_CHARGE_INTERVAL, DOOM_DAMAGE, DOOM_LOCK_S,
    ROUND_SECONDS, ROUND_LIMIT, POINTS_TO_WIN, CP_BASE, CP_PER, CP_MAX, SUPPORT_SHARE, HOLD_BONUS, GALAXY_R,
    seatOrder, makeRng, dist, clamp, nodeStats, hasTech, techCount, techPrereq, techCost, assaultMult, fortifyMult, terrainDefence, upgradeCost,
    generateGalaxy, gabrielLanes, createGame, cloneGame, computeSupply, relayCharge, throneNode, canFire,
    neighbors, areLinked, nodesOf, alive, liveSeats, findPath, pathTime, factionOf, mod,
    commandPoints, cpUsed, checkOrder, addOrder, removeOrder, lockOrders, allLocked, spendable,
    beginResolve, step, runRound, STEP, thronePoints, endRound, standing, forecast, snapshotFrame,
    ROLES, ROLE_KEYS, MARSHAL_BONUS, roleOf, draftOrder, openDraft, draftTurn, rolesLeft, pickRole, upgradePrice,
    OBJECTIVES, SECRETS, objectiveById, publicObjectives, scoreObjectives,
    sightOf, fleetSeen, refreshIntel, viewFor, SIGHT_RELAY,
    PACT_ROUNDS, OATH_ROUNDS, pactBetween, partnersOf, oathbroken, checkPact, makePact, offerPact, answerOffer, orderVictim,
    LAWS, LAW_KEYS, INFLUENCE_START, lawActive, lawCount, voteChoices, castVote, tally, addGrudge,
    defenceOf, supportFor, resolveArrival, resolveAssault, stepLaneCombat, lanePoint, drainEvents
  };
});
