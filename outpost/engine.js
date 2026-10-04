// OUTPOST — core simulation for a node-and-lane command & control RTS.
//
// Pure logic: no DOM, no canvas, no timers, no Math.random. Everything is
// driven by an explicit seeded RNG and a fixed timestep, so a match is
// perfectly reproducible from (seed, list of orders) — which is what makes
// it testable under plain Node (engine.test.js) and what keeps the AI
// honest. index.html owns all rendering, input and effects on top of this.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.OutpostEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // Logical map space. The view scales this to whatever the canvas is, so
  // the whole battlefield always fits on one screen — no pan, no zoom.
  // That single constraint is what makes the game readable on a phone and
  // keeps every decision visible at once.
  const MAP_W = 1000, MAP_H = 640;

  const NEUTRAL = 0, PLAYER = 1, ENEMY = 2;

  // Four node types, each a different shape on screen so type is readable
  // at a glance without labels:
  //   command  hexagon  — your strongest producer, and where you start
  //   factory  square   — the unit engine; taking these wins games
  //   mine     diamond  — pays Credits instead of units (the upgrade economy)
  //   outpost  circle   — cheap filler, but holds ground and links lanes
  // Command is deliberately and visibly the best producer on the map —
  // roughly double a Factory. Losing your home should hurt, and a Factory
  // should read as a useful satellite rather than a replacement base.
  //
  // Relay (was "cheap filler with no purpose") is the Doomstar's fuel: it
  // produces least of anything, but every uncontested Relay you hold
  // charges the superweapon. That is the whole reason to fight for the
  // scattered small nodes.
  const NODE_TYPES = {
    command: { label: "Command", units: 0.78, cap: 70, credits: 0.35, radius: 30, shape: "hex" },
    factory: { label: "Factory", units: 0.40, cap: 45, credits: 0.25, radius: 24, shape: "square" },
    mine:    { label: "Mine",    units: 0.14, cap: 28, credits: 0.90, radius: 22, shape: "diamond" },
    relay:   { label: "Relay",   units: 0.20, cap: 34, credits: 0.25, radius: 21, shape: "circle" },
    doomstar: { label: "Doomstar", units: 0.30, cap: 40, credits: 0.30, radius: 27, shape: "star" }
  };

  // --- Doomstar objective -------------------------------------------
  // Borrowed from the Doomstar prototype and adapted to a lane map: hold
  // Relays to charge the weapon, hold the centre to fire it. It answers
  // two problems at once — it gives the small nodes a reason to exist,
  // and it forces a fight over the middle of the map instead of letting
  // two players turtle on opposite corners.
  const DOOM_CHARGE_PER_RELAY = 1;   // per charge tick, per uncontested Relay
  const DOOM_CHARGE_INTERVAL = 3.0;  // seconds between charge ticks
  const DOOM_CHARGE_NEEDED = 20;     // charge required to fire
  const DOOM_DAMAGE = 26;            // units removed from the target
  // The garrison sitting on the centre at kick-off.
  //
  // Worth knowing before touching this: the centre stayed neutral in 40
  // of 40 measured matches, so the Doomstar is a late-game objective in
  // practice rather than a mid-game one. Lowering this was tried as the
  // fix and is not one -- at a garrison of 7 the weapon still only fired
  // 0.11 times per match, because reaching the middle, not cracking it,
  // is what costs. Do not hang a doctrine on the weapon alone.
  const DOOM_GARRISON = 24;
  // A Relay charges the weapon for as long as it is CONNECTED — in
  // supply, traceable back to one of your Commands. It used to also have
  // to be uncontested, meaning no enemy-held neighbour, and that was too
  // strict to ever come up: Relays sit on the front, so holding one with
  // a quiet neighbourhood mostly meant you had already won, and the
  // charge arrived after it could decide anything. Supply is the
  // condition that already means "you are holding this properly", so the
  // weapon hangs off that instead.

  const MAX_LEVEL = 3;
  // Upgrades boost production hard but capacity only gently, and the split
  // matters. When both scaled together, a level-3 node reached a garrison
  // of 146 and a defence of 182 — more than any single node could ever
  // field, so fronts froze permanently once the map was divided. Rate is
  // the reward for investing; capacity staying low is what keeps every
  // position takeable by a big enough attack.
  const RATE_BONUS = 0.75;  // +75% production per tier (L3 = 3.25x)
  const CAP_BONUS = 0.25;   // +25% capacity per tier   (L3 = 1.75x)

  // Defenders fight above their weight. Without this, whoever moves first
  // always trades up and the map collapses to a coin flip; with it, an
  // attack has to be *committed* to be worth making, which is where the
  // interesting decisions live. The consequence is deliberate: one node
  // can never take an equal one, so winning ground means concentrating
  // several at once. That is the core skill of the game.
  const DEFENDER_EDGE = 1.25;

  // Progressive, army-wide research in the StarCraft mould: each track has
  // three levels, each level costs more than the last, and a level applies
  // to everything you own the moment it completes. This is the third claim
  // on Credits alongside node upgrades, so the interesting question is
  // what you *don't* buy.
  //
  // Assault deliberately out-scales Fortify (+15% vs +10% a level). Three
  // reasons, all measured rather than assumed:
  //   1. Defenders already get a flat x1.25 before any tech.
  //   2. You must attack to win, so Assault is mandatory and Fortify is
  //      the greedy pick — an equal-value Fortify would simply be better.
  //   3. Stalemate is this game's failure mode. Modelling the force
  //      requirements showed an un-teched attacker facing a +60% Fortify
  //      defender needs ~9 mid-size positions converging on one L3
  //      Command — more than anyone holds on a 14-node map, i.e. a
  //      guaranteed freeze. Capping Fortify at +30% keeps the worst case
  //      inside what a side can actually mass.
  // Because both sides research the same tracks, equal tech leaves the
  // force ratio exactly where it started — progression shifts the numbers
  // without shifting the balance, which is the property that makes the
  // StarCraft model work.
  const TECH = {
    assault: { label: "Assault", perLevel: 0.15, costs: [90, 200, 360] },
    fortify: { label: "Fortify", perLevel: 0.10, costs: [80, 175, 320] }
  };
  const TECH_MAX = 3;

  // Every held position earns credits, not only Mines. Measured before
  // this: a side finished an average match having earned 12 credits
  // against a first research level costing 90, and completed 0.13
  // research levels per match -- the whole credit economy, and with it
  // the research buttons, was decoration. Holding ground now funds
  // roughly one research level or one upgrade a match, which makes the
  // spend a decision rather than a formality. Mines stay the economy
  // node at nearly four times a Factory's rate.

  // ---- objectives ------------------------------------------------------
  // A skirmish is won by wiping the other side out. A campaign mission
  // usually is not: it asks you to hold the middle, or to take one
  // position before a clock runs out, or simply to still be standing.
  // Objectives sit on top of the elimination rule rather than replacing
  // it -- losing every position always loses, whatever the brief says.
  //
  //   eliminate  take every enemy position (the default, and skirmish)
  //   hold       hold `nodeId`, every id in `nodeIds`, or every node of
  //              `nodeType`, for `holdFor` seconds without interruption
  //   survive    still hold ground when `seconds` have passed
  //   capture    hold `nodeId` at any point before `seconds` expire
  //
  // `seconds` on hold/capture is a deadline; running it out is a loss.
  const OBJECTIVES = ["eliminate", "hold", "survive", "capture"];

  function objectiveNodes(game, obj) {
    if (obj.nodeIds) return obj.nodeIds.map((id) => game.nodes[id]).filter(Boolean);
    if (obj.nodeId !== undefined && obj.nodeId !== null) {
      const n = game.nodes[obj.nodeId];
      return n ? [n] : [];
    }
    if (obj.nodeType) return game.nodes.filter((n) => n.type === obj.nodeType);
    return [];
  }

  // Returns PLAYER, ENEMY or null. Called after the elimination check, so
  // it only ever runs while both sides are still on the board.
  function stepObjective(game, dt) {
    const obj = game.objective;
    if (!obj) return null;
    if (obj.kind === "eliminate" && !obj.seconds) return null;
    const targets = objectiveNodes(game, obj);
    const holding = targets.length > 0 && targets.every((n) => n.owner === PLAYER);

    if (obj.kind === "capture") {
      if (holding) return PLAYER;
      if (obj.seconds && game.time >= obj.seconds) return ENEMY;
      return null;
    }
    if (obj.kind === "survive") {
      return obj.seconds && game.time >= obj.seconds ? PLAYER : null;
    }
    // A conquest objective can carry a deadline too: take the map, and
    // take it before the clock. Elimination itself is handled by the
    // ordinary win check, so all this adds is the losing end.
    if (obj.kind === "eliminate") {
      return obj.seconds && game.time >= obj.seconds ? ENEMY : null;
    }
    if (obj.kind === "hold") {
      // The clock resets the moment the position changes hands, so a
      // hold objective is a defence of something, not a visit to it.
      game.holdTimer = holding ? (game.holdTimer || 0) + dt : 0;
      if (game.holdTimer >= (obj.holdFor || 0)) return PLAYER;
      if (obj.seconds && game.time >= obj.seconds) return ENEMY;
      return null;
    }
    return null;
  }

  // How far along the objective is, for the readout. Returns null when
  // there is nothing meaningful to show.
  function objectiveProgress(game) {
    const obj = game.objective;
    if (!obj) return null;
    if (obj.kind === "eliminate" && !obj.seconds) return null;
    const left = obj.seconds ? Math.max(0, obj.seconds - game.time) : null;
    if (obj.kind === "hold") {
      const need = obj.holdFor || 0;
      return { kind: "hold", held: Math.min(need, game.holdTimer || 0), need, left,
               onTarget: objectiveNodes(game, obj).every((n) => n.owner === PLAYER) };
    }
    if (obj.kind === "survive") return { kind: "survive", left };
    if (obj.kind === "eliminate") return { kind: "eliminate", left };
    if (obj.kind === "capture") return { kind: "capture", left };
    return null;
  }

  // ---- doctrines -------------------------------------------------------
  // One standing choice made before the match starts. Every doctrine is a
  // SIDEGRADE: each one buys its advantage with a matching weakness, so
  // picking one is a statement about how you intend to play rather than a
  // power level. Research is the ladder you climb during a match;
  // doctrine is the shape of the army you brought to it.
  //
  // They exist because two sides with identical rules converge on
  // identical play. With doctrines a friend who always rushes and a
  // friend who always turtles are playing recognisably different games,
  // and the pre-match pick gives the opening a decision in it.
  //
  // Every effect is expressed as a modifier key read through docMod, so
  // adding a doctrine never means threading a new branch through the
  // simulation.
  const MOD_DEFAULTS = {
    speed: 1,            // fleet travel speed
    cap: 1,              // garrison capacity
    units: 1,            // unit production rate
    credits: 1,          // credit income
    attack: 1,           // assault strength
    defence: 1,          // defensive strength
    research: 1,         // research cost
    doom: 1,             // Doomstar strike damage
    chargeRate: 1,       // Doomstar charge gained per tick
    relayUnits: 1,       // unit production multiplier, Relays only
    cutoff: 0.3          // output multiplier while cut off; OUT_OF_SUPPLY_RATE
                         // is defined from this so the two cannot drift
  };

  // Each doctrine's advantage has to land on something that happens in
  // EVERY match, or it is decoration. Measured over 30 average matches
  // before these numbers were set: a side earns 12 credits a match and
  // finishes 0.13 research levels, fires the Doomstar 0.00 times, and
  // spends 0.0% of its node-seconds at the garrison cap -- but 25% of
  // them cut off from supply. So capacity, credit income and the weapon
  // were all worth approximately zero as written, and the doctrines
  // built on them did nothing a player could feel. Production, fleet
  // speed, attack, defence and the supply penalty are the levers that
  // are live every second, and the set below is built from those.
  // Re-fitted when transit through neutral ground closed. A contiguous
  // grind is a different game: economy picks compounded and tempo picks
  // stopped paying, and the set that had sat inside a 53-68% band at
  // Officer spread to 35-95%. Forward Relays won 95/87% of matches and
  // Shock Troops won 35/15%. Measured again after, 70 seeds a tier
  // against Standard's 85/50:
  //   Vanguard 84/54 · Deep Logistics 79/44 · Forward Relays 83/59
  //   Prospectors 81/43 · Shock Troops 84/41
  // The production penalties are what moved most -- a 20% unit penalty
  // is survivable in a 80s match and crippling in a 150s one.
  const DOCTRINES = {
    standard: {
      label: "Standard", icon: "\u25c6",
      up: "Balanced \u2014 nothing to exploit",
      down: "",
      mods: {}
    },
    vanguard: {
      label: "Vanguard", icon: "\u27a4",
      up: "Fleets travel 40% faster",
      down: "Positions build units 3% slower",
      mods: { speed: 1.40, units: 0.97 }
    },
    logistics: {
      label: "Deep Logistics", icon: "\u25cf",
      up: "Cut-off positions keep 90% output, not 30%",
      down: "Credit income \u221230%",
      mods: { cutoff: 0.90, credits: 0.70 }
    },
    relays: {
      label: "Forward Relays", icon: "\u2605",
      up: "Relays out-build your Factories and charge the Doomstar twice as fast",
      down: "Everywhere else builds 15% slower",
      // The charge half of this used to be the whole doctrine, and it
      // was worth nothing: across 40 measured matches neither side ever
      // held the centre, so the weapon never fired at all. The Relay
      // production bonus is what makes the pick pay off in the match
      // you are actually having; the charge is the upside when it does
      // come together.
      mods: { relayUnits: 2.2, chargeRate: 2, units: 0.85 }
    },
    prospectors: {
      label: "Prospectors", icon: "\u25c8",
      up: "Income +45% and research costs 25% less",
      down: "Positions build units 10% slower",
      mods: { credits: 1.45, research: 0.75, units: 0.90 }
    },
    shock: {
      label: "Shock Troops", icon: "\u25b2",
      up: "Assaults land 15% harder",
      down: "Positions defend 6% worse and build 8% slower",
      mods: { attack: 1.15, defence: 0.94, units: 0.92 }
    }
  };
  const DOCTRINE_KEYS = Object.keys(DOCTRINES);

  // ---- ascension -------------------------------------------------------
  // What you get for beating Commander: an opponent that starts the match
  // already researched, and at the top rung out-producing you as well.
  //
  // Every rung had to move the measured win rate on its own, or it is not
  // a handicap, it is flavour text. Three earlier candidates did not: a
  // harsher supply penalty on your side (a commander who keeps a
  // connected front is never cut off), faster enemy fleets, and cheaper
  // enemy research all came back inside the noise, and two of the three
  // made the game measurably EASIER. Starting tech is the one lever that
  // orders cleanly, so the ladder is built from it.
  //
  // Measured player win rate at Commander, 90 seeds a rung, with the
  // person-like commander in scratchpad/harness2.js:
  //   none 33% | I 22% | II 23% | III 14% | IV 2% | V 0%
  //
  // Starting tech was the whole ladder until transit through neutral
  // ground closed. In a 150s contiguous grind a single tech level
  // compounds: Fortify I alone took Commander from 33% to 13% and
  // Assault I to 3%, which is not a rung, it is a wall. So the first two
  // rungs are small production handicaps instead, and the tech only
  // starts at III. Rungs I and II measure within noise of each other and
  // the last two are in single digits where the harness cannot order
  // them -- the same was true of the ladder this replaces (44/39/31/11/
  // 7/2). Treat the top of the ladder as a flex, not a difficulty curve.
  const ASCENSION = [
    { label: "Ascension I",   note: "The enemy out-produces you by 5%",
      tech: { assault: 0, fortify: 0 }, produce: 1.05 },
    { label: "Ascension II",  note: "Make that 12%",
      tech: { assault: 0, fortify: 0 }, produce: 1.12 },
    { label: "Ascension III", note: "...and it starts with Fortify I",
      tech: { assault: 0, fortify: 1 }, produce: 1.12 },
    { label: "Ascension IV",  note: "...and Assault I on top of that",
      tech: { assault: 1, fortify: 1 }, produce: 1.12 },
    { label: "Ascension V",   note: "The enemy starts fully researched, out-producing you by 15%",
      tech: { assault: 3, fortify: 3 }, produce: 1.15 }
  ];
  const ASCENSION_MAX = ASCENSION.length;

  // Starting tech granted by an ascension level (0 = none).
  function ascensionTech(level) {
    const rung = ASCENSION[(level | 0) - 1];
    return rung ? { assault: rung.tech.assault, fortify: rung.tech.fortify }
                : { assault: 0, fortify: 0 };
  }
  function ascensionProduce(level) {
    const rung = ASCENSION[(level | 0) - 1];
    return rung && rung.produce ? rung.produce : 1;
  }


  function doctrineOf(game, owner) {
    const key = game && game.doctrine && game.doctrine[owner];
    return DOCTRINES[key] ? key : "standard";
  }
  function docMod(game, owner, key) {
    const d = DOCTRINES[doctrineOf(game, owner)];
    const v = d.mods[key];
    return v === undefined ? MOD_DEFAULTS[key] : v;
  }

  // Fleets hitting the same node within this window fight as one force.
  // Without it, converging attacks are defeated one at a time no matter
  // how well timed, which makes concentration — the whole point —
  // impossible. It also reads well: you watch forces mass, then clash.
  const COALESCE_WINDOW = 1.0;

  const FLEET_SPEED = 115;      // logical units per second
  function fleetSpeed(game, owner) { return FLEET_SPEED * docMod(game, owner, "speed"); }
  const MIN_SEND = 2;           // never send a token force
  const OVERFLOW_WASTE = true;  // arriving units above cap are lost

  function upgradeCost(level) { return Math.round(60 * Math.pow(level + 1, 1.45)); }

  // ---- deterministic RNG (mulberry32) --------------------------------
  // A seeded generator rather than Math.random so tests are stable, and so
  // a seed can be shared to replay the exact same map.
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

  // `game` is optional: pass it and the owner's doctrine is applied, omit
  // it for the raw type numbers (the legend, the map generator).
  function nodeStats(node, game) {
    const base = NODE_TYPES[node.type];
    const rateMult = 1 + RATE_BONUS * node.level;
    const held = game && node.owner !== NEUTRAL;
    const dUnits = (held ? docMod(game, node.owner, "units") : 1)
      * (held && node.type === "relay" ? docMod(game, node.owner, "relayUnits") : 1);
    const dCred = held ? docMod(game, node.owner, "credits") : 1;
    const dCap = held ? docMod(game, node.owner, "cap") : 1;
    return {
      unitRate: base.units * rateMult * dUnits,
      creditRate: base.credits * rateMult * dCred,
      cap: Math.round(base.cap * (1 + CAP_BONUS * node.level) * dCap),
      radius: base.radius
    };
  }

  function techLevel(game, owner, track) {
    return (game.tech && game.tech[owner] && game.tech[owner][track]) || 0;
  }
  // Cost of the *next* level, or null when the track is maxed.
  // `game`/`owner` are optional; pass them for the price this side
  // actually pays, which Prospectors discounts.
  function techCost(track, level, game, owner) {
    const spec = TECH[track];
    if (!spec || level >= TECH_MAX) return null;
    const raw = spec.costs[level];
    if (!game) return raw;
    return Math.round(raw * docMod(game, owner, "research"));
  }
  function assaultMult(game, owner) {
    return (1 + TECH.assault.perLevel * techLevel(game, owner, "assault"))
      * docMod(game, owner, "attack");
  }
  function fortifyMult(game, owner) {
    return (1 + TECH.fortify.perLevel * techLevel(game, owner, "fortify"))
      * docMod(game, owner, "defence");
  }

  function researchTech(game, track, owner) {
    if (game.winner) return "The battle is over.";
    if (!TECH[track]) return "No such research.";
    const level = techLevel(game, owner, track);
    const cost = techCost(track, level, game, owner);
    if (cost === null) return TECH[track].label + " is fully researched.";
    if ((game.credits[owner] || 0) < cost) return "Need " + cost + " credits.";
    game.credits[owner] -= cost;
    game.tech[owner][track] = level + 1;
    emit(game, { kind: "research", owner, track, level: level + 1 });
    return undefined;
  }

  // --- terrain ---------------------------------------------------------
  // One property per node, affecting how well it defends. Deliberately
  // the smallest thing that makes *where* a position sits matter as much
  // as what it is: a Factory on high ground is a fortress worth building
  // a front around, the same Factory in a marsh is the obvious place to
  // punch through.
  //
  // Terrain is assigned symmetrically with everything else, so both sides
  // get the same ground. Reducing lane density was measured as the
  // alternative route to "chokepoints" and rejected: even at degree 2.7
  // maps averaged 0.1 articulation points and 4% blocked routes, because
  // the connectivity pass yields ring-like graphs with no cut vertices.
  const TERRAIN = {
    // Open space is the baseline. An asteroid belt gives a defender cover
    // to fight from; a gravity well pins a garrison in place where it
    // cannot manoeuvre, so it is the soft spot on any map.
    open:     { label: "Open Space",    defence: 1.00 },
    asteroid: { label: "Asteroid Belt", defence: 1.25 },
    well:     { label: "Gravity Well",  defence: 0.78 }
  };
  // Command and the Doomstar are always Open. They already have the
  // largest capacities, and stacking highland on top of the defender
  // edge, Fortify and a level-3 upgrade pushes their defence beyond what
  // any realistic concentration can crack — which is exactly how the
  // original stalemate happened.
  const FLAT_TYPES = ["command", "doomstar"];

  function terrainOf(node) {
    return TERRAIN[node.terrain] ? node.terrain : "open";
  }
  function terrainDefence(node) {
    return TERRAIN[terrainOf(node)].defence;
  }

  // --- supply ---------------------------------------------------------
  // A position is IN SUPPLY when it can trace a chain of your own nodes
  // back to one of your Command nodes. Cut that chain and the position
  // keeps flying your colour but barely functions: this is what makes
  // encircling and severing worth doing, rather than every node you
  // occupy simply working at full rate wherever it sits.
  const OUT_OF_SUPPLY_RATE = MOD_DEFAULTS.cutoff;   // production when cut off

  function computeSupply(game) {
    for (const n of game.nodes) n.inSupply = n.owner === NEUTRAL ? true : false;
    for (const owner of [PLAYER, ENEMY]) {
      // Seed from every Command this side holds; if they hold none, the
      // whole side is cut off and has bigger problems than production.
      const stack = game.nodes.filter((n) => n.owner === owner && n.type === "command").map((n) => n.id);
      const seen = new Set(stack);
      while (stack.length) {
        const cur = stack.pop();
        game.nodes[cur].inSupply = true;
        for (const nx of neighbors(game, cur)) {
          if (seen.has(nx)) continue;
          if (game.nodes[nx].owner !== owner) continue;   // only your own ground carries supply
          seen.add(nx); stack.push(nx);
        }
      }
    }
  }

  function supplyMultiplier(node, game) {
    if (node.inSupply !== false) return 1;
    if (!game) return OUT_OF_SUPPLY_RATE;
    return docMod(game, node.owner, "cutoff");
  }

  // A node is contested when any lane-adjacent node is enemy-held. It no
  // longer blocks charging, but it is still what the board marks as a
  // front line, so the view uses it.
  function isContested(game, node) {
    for (const id of neighbors(game, node.id)) {
      const n = game.nodes[id];
      if (n.owner !== NEUTRAL && n.owner !== node.owner) return true;
    }
    return false;
  }

  // How much charge one held Relay contributes per tick: every Relay you
  // hold and can still supply, whether or not the enemy is next door.
  function relayCharge(game, node) {
    if (node.type !== "relay" || node.inSupply === false) return 0;
    return 1;
  }

  // Relays this owner holds that are actually charging right now.
  function chargingRelays(game, owner) {
    return game.nodes.filter((n) => n.owner === owner && relayCharge(game, n) > 0);
  }

  function doomstarNode(game) {
    return game.nodes.find((n) => n.type === "doomstar") || null;
  }
  // You may only fire if you hold the centre and the weapon is charged.
  function canFire(game, owner) {
    const d = doomstarNode(game);
    return !!d && d.owner === owner && (game.charge[owner] || 0) >= DOOM_CHARGE_NEEDED;
  }
  // The strike lands on whatever the enemy has massed hardest — always
  // relevant, and it needs no extra targeting UI on a phone.
  function doomstarTarget(game, owner) {
    const foe = owner === PLAYER ? ENEMY : PLAYER;
    let best = null;
    for (const n of game.nodes) {
      if (n.owner !== foe) continue;
      if (!best || n.garrison > best.garrison) best = n;
    }
    return best;
  }

  // `targetId` is optional: pass one to aim the strike, omit it to hit
  // whatever the enemy has massed hardest. The game's loudest moment
  // should be a decision, but it must still work as one button for a
  // player who does not want to aim.
  function fireDoomstar(game, owner, targetId) {
    if (game.winner) return "The battle is over.";
    const d = doomstarNode(game);
    if (!d) return "No Doomstar on this map.";
    if (d.owner !== owner) return "You must hold the Doomstar to fire it.";
    if ((game.charge[owner] || 0) < DOOM_CHARGE_NEEDED) {
      return "Charge " + Math.floor(game.charge[owner] || 0) + "/" + DOOM_CHARGE_NEEDED + ".";
    }
    let target = null;
    if (targetId !== undefined && targetId !== null) {
      const pick = game.nodes[targetId | 0];
      if (!pick) return "No such position.";
      if (pick.owner === owner) return "You cannot fire on your own position.";
      if (pick.owner === NEUTRAL) return "Only an enemy position is worth a strike.";
      target = pick;
    } else {
      target = doomstarTarget(game, owner);
    }
    if (!target) return "Nothing left to fire at.";

    game.charge[owner] = 0;
    const before = target.garrison;
    target.garrison = Math.max(0, target.garrison - strikeDamage(game, owner));
    const killed = before - target.garrison;
    // A strike that empties a position leaves it abandoned, not captured —
    // you still have to walk in and take it.
    const wiped = target.garrison <= 0.001;
    // Read the victim before a wipe hands the position back to nobody.
    const victim = target.owner;
    if (wiped) { target.owner = NEUTRAL; target.level = 0; target.garrison = 0; target.assault = null; }
    game.stats[owner].fired += 1;
    if (victim !== NEUTRAL) game.stats[victim].taken += 1;
    emit(game, {
      kind: "doomstar", x: target.x, y: target.y, owner,
      nodeId: target.id, damage: Math.round(killed), wiped
    });
    return undefined;
  }

  // What one strike from this side actually removes.
  function strikeDamage(game, owner) {
    return Math.round(DOOM_DAMAGE * docMod(game, owner, "doom"));
  }

  function stepCharge(game, dt) {
    const d = doomstarNode(game);
    if (!d) return;
    game.chargeTimer -= dt;
    if (game.chargeTimer > 0) return;
    game.chargeTimer += DOOM_CHARGE_INTERVAL;
    for (const owner of [PLAYER, ENEMY]) {
      const held = chargingRelays(game, owner);
      const relays = held.length;
      if (!relays) continue;
      const gained = held.reduce((sum, n) => sum + relayCharge(game, n), 0)
        * docMod(game, owner, "chargeRate");
      const before = game.charge[owner] || 0;
      if (before >= DOOM_CHARGE_NEEDED) continue;
      game.charge[owner] = Math.min(DOOM_CHARGE_NEEDED, before + gained * DOOM_CHARGE_PER_RELAY);
      emit(game, {
        kind: "charge", owner, relays,
        total: game.charge[owner], needed: DOOM_CHARGE_NEEDED,
        ready: game.charge[owner] >= DOOM_CHARGE_NEEDED && before < DOOM_CHARGE_NEEDED
      });
    }
  }

  // Defence strength of a node against an incoming fleet. Neutral ground
  // has nobody dug in, so it gets neither the defender edge nor tech.
  function defenceOf(game, node) {
    // Terrain applies to everyone, including unheld ground — a marsh is a
    // marsh whoever is standing in it.
    if (node.owner === NEUTRAL) return node.garrison * terrainDefence(node);
    return node.garrison * DEFENDER_EDGE * fortifyMult(game, node.owner) * terrainDefence(node);
  }

  // ---- map generation -------------------------------------------------
  // The map is generated in one half and rotated 180 degrees about the
  // centre to produce the other. Point symmetry (rather than a mirror)
  // means both sides face an identical problem from an identical relative
  // position, so a loss is never the map's fault.
  function generateMap(seed, nodeCount, mapW, mapH) {
    const W = mapW || MAP_W, H = mapH || MAP_H;
    const rng = makeRng(seed);
    const half = Math.max(3, Math.floor((nodeCount || 14) / 2));
    // Spacing scales with the area per node rather than being a fixed
    // number, so the layout stays evenly spread whatever shape the board
    // is (a phone in portrait gets a tall map, a desktop a wide one).
    const spacing = Math.sqrt((W * H) / (nodeCount || 14)) * 0.72;
    const margin = Math.min(W, H) * 0.075 + 18;
    // Split along the longer axis so the two starting positions end up as
    // far apart as the board allows in either orientation.
    const vertical = H > W;
    const span = vertical ? H : W;
    const pts = [];
    let guard = 0;
    while (pts.length < half && guard++ < 9000) {
      const along = margin + rng() * (span / 2 - margin - spacing * 0.35);
      const across = margin + rng() * ((vertical ? W : H) - margin * 2);
      const p = vertical ? { x: across, y: along } : { x: along, y: across };
      if (dist(p, { x: W / 2, y: H / 2 }) < spacing * 1.15) continue;
      let ok = true;
      for (const q of pts) if (dist(p, q) < spacing) { ok = false; break; }
      if (ok) pts.push(p);
    }

    // Relax the points apart. Pure rejection sampling leaves seven points
    // huddled wherever they happened to fit first, so maps looked cramped
    // and wasted most of the board. A few rounds of mutual repulsion,
    // clamped to the half-region, spread them into something that reads as
    // a deliberately laid-out map.
    const loA = margin, hiA = span / 2 - spacing * 0.35;
    const loC = margin, hiC = (vertical ? W : H) - margin;
    for (let iter = 0; iter < 60; iter++) {
      for (const p of pts) {
        let dx = 0, dy = 0;
        for (const q of pts) {
          if (p === q) continue;
          const d = dist(p, q);
          if (d > spacing * 1.6 || d === 0) continue;
          const push = (spacing * 1.6 - d) / (spacing * 1.6);
          dx += ((p.x - q.x) / d) * push * spacing * 0.16;
          dy += ((p.y - q.y) / d) * push * spacing * 0.16;
        }
        p.x += dx; p.y += dy;
        const a = vertical ? "y" : "x", c = vertical ? "x" : "y";
        p[a] = clamp(p[a], loA, hiA);
        p[c] = clamp(p[c], loC, hiC);
        const cx = W / 2, cy = H / 2;
        const dc = dist(p, { x: cx, y: cy });
        if (dc < spacing * 1.15 && dc > 0.001) {
          const push = (spacing * 1.15) / dc;
          p.x = cx + (p.x - cx) * push;
          p.y = cy + (p.y - cy) * push;
          p[a] = clamp(p[a], loA, hiA);
          p[c] = clamp(p[c], loC, hiC);
        }
      }
    }

    const nodes = [];
    // Player's command is the point furthest "back" along the split axis;
    // its rotated twin becomes the enemy's, which keeps the two as far
    // apart as the layout allows without hard-coding positions.
    const alongOf = (p) => (vertical ? p.y : p.x);
    let hqIdx = 0;
    for (let i = 1; i < pts.length; i++) if (alongOf(pts[i]) < alongOf(pts[hqIdx])) hqIdx = i;

    const typePool = ["factory", "mine", "relay", "factory", "mine", "factory", "relay"];
    const terrainPool = ["open", "asteroid", "open", "well", "open", "asteroid", "well"];
    pts.forEach((p, i) => {
      const type = i === hqIdx ? "command" : typePool[(i * 3 + seed) % typePool.length];
      // Both halves of a mirrored pair get identical ground, so terrain
      // can never hand one side a better start.
      const terrain = FLAT_TYPES.indexOf(type) !== -1
        ? "open" : terrainPool[(i * 5 + seed * 3) % terrainPool.length];
      nodes.push({ id: nodes.length, x: p.x, y: p.y, type, terrain, owner: NEUTRAL, garrison: 0, level: 0 });
      // 180-degree rotation about the map centre.
      nodes.push({
        id: nodes.length, x: W - p.x, y: H - p.y,
        type, terrain, owner: NEUTRAL, garrison: 0, level: 0
      });
    });

    // Starting ownership: the two command nodes.
    for (const n of nodes) {
      if (n.type === "command") {
        n.owner = (vertical ? n.y < H / 2 : n.x < W / 2) ? PLAYER : ENEMY;
        n.garrison = 30;
      } else {
        // Neutral garrisons scale with how good the node is, so the
        // valuable ground costs something to take.
        n.garrison = n.type === "factory" ? 20 : n.type === "mine" ? 16 : 11;
      }
    }

    // The Doomstar sits dead centre — the one node both sides start
    // equally far from, so holding it is always a contested decision.
    nodes.push({
      id: nodes.length, x: W / 2, y: H / 2, type: "doomstar", terrain: "open",
      owner: NEUTRAL, garrison: DOOM_GARRISON, level: 0
    });

    const lanes = buildLanes(nodes, spacing * 2.6);
    return { nodes, lanes, mapW: W, mapH: H };
  }

  // ---- lane layout ------------------------------------------------------
  // Lanes are the whole strategic skeleton: you can only order a move
  // between linked nodes, so chokepoints are real. They also have to be
  // READ at a glance on a phone. The first version linked every node to its
  // four nearest neighbours, which on the shipped seeds drew a mean of
  // 2.9 (portrait) to 5.5 (landscape) lane crossings per map, fans of lanes
  // leaving a node a few degrees apart (down to 0.0) and lanes drawn
  // straight through a third node's body (up to 27 units inside it) -- 89%
  // to 99% of maps had at least one of those, and the line work read as a
  // tangle even though the graph itself was fine.
  //
  // So lanes are now chosen greedily, shortest first, and a candidate is
  // only accepted if the drawing stays clean against everything already
  // accepted: it may not cross or run beside another lane, it may not leave
  // a node within LANE_MIN_ANGLE of a lane already there, and it may not
  // pass within LANE_CLEARANCE of any node that is not one of its ends.
  // Shortest-first matters: it keeps the lanes a person would draw by hand
  // and lets the long diagonal be the one that is refused.
  //
  // Measured over 200 seeds on a 390x844 and a 1280x800 board (before ->
  // after): crossings 2.94 / 5.47 per map -> 0, smallest angle at a node
  // 0.0 -> 28.1 degrees, deepest a lane cut into a foreign node 27 units ->
  // clear by 63, lanes 31.8 / 34.2 -> 29.6 / 29.4, mean degree 4.25 / 4.62
  // -> 3.95 / 3.97, disconnected maps 0 -> 0. Crossings and the angle rule
  // do all the work on these shapes; the clearance and gap rules never bind
  // (the relaxed layout leaves 60+ units) and stay as guards for a board
  // shape nobody measured. A tighter pool (5 neighbours, degree 5) gave
  // ~28.5 lanes and tilted the ladder further toward the player.
  //
  // Even so, fewer lanes tilted the ladder toward the player (Officer +8,
  // Captain +10 points over 300 seeds), so Officer / Captain AI production
  // was re-fitted from 0.86 / 0.93 to 0.87 / 0.94 (see DIFFICULTY).
  //
  // The maps are point-symmetric, so a lane is only ever accepted together
  // with its mirror image (the lane between the two twins of its ends); the
  // greedy order is by length, which a rotation preserves, so the pair is
  // judged once and the whole layout stays symmetric.
  const LANE_MIN_ANGLE = 28 * Math.PI / 180;
  const LANE_CLEARANCE = 18;   // map units of empty space beyond a node's body
  const LANE_GAP = 14;         // closest two unrelated lanes may run
  const LANE_MAX_DEGREE = 6;
  const LANE_NEIGHBOURS = 7;   // candidate pool per node before filtering

  function buildLanes(nodes, maxRange) {
    const n = nodes.length;
    const range = maxRange || 340;
    const radius = nodes.map((m) => (NODE_TYPES[m.type] || { radius: 22 }).radius);

    // Mirror twin of every node, found by geometry about the centroid (the
    // centroid of a point-symmetric set IS the centre), so this does not
    // depend on how ids happen to be paired. A node with no twin maps to
    // -1 and its lanes are simply added one at a time.
    let cx = 0, cy = 0;
    for (const m of nodes) { cx += m.x; cy += m.y; }
    cx /= n; cy /= n;
    const twin = nodes.map((m) => {
      let best = -1, bd = 1e-3;
      for (const o of nodes) {
        const d = Math.hypot(o.x - (2 * cx - m.x), o.y - (2 * cy - m.y));
        if (d < bd) { bd = d; best = o.id; }
      }
      return best;
    });
    const idx = new Map(nodes.map((m, i) => [m.id, i]));
    const tw = (i) => (twin[i] < 0 ? -1 : idx.get(twin[i]));

    const P = nodes;
    const segPt = (a, b, p) => {
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
      return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
    };
    const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const crosses = (a, b, c, d) =>
      orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
    const segGap = (a, b, c, d) => crosses(a, b, c, d) ? 0
      : Math.min(segPt(a, b, c), segPt(a, b, d), segPt(c, d, a), segPt(c, d, b));
    const angleAt = (v, a, b) => {
      const u = Math.atan2(P[a].y - P[v].y, P[a].x - P[v].x);
      const w = Math.atan2(P[b].y - P[v].y, P[b].x - P[v].x);
      let d = Math.abs(u - w);
      if (d > Math.PI) d = 2 * Math.PI - d;
      return d;
    };

    const lanes = [];                 // accepted [a, b] index pairs
    const deg = new Array(n).fill(0);
    const have = new Set();
    const key = (a, b) => (a < b ? a * n + b : b * n + a);

    // Does lane (a,b) sit cleanly among `lanes` and `pending`? `lax` relaxes
    // the rules in steps for the connectivity pass: 0 = all rules,
    // 1 = no degree cap and half the angle / clearance / gap, 2 = only
    // "do not cross", 3 = anything goes.
    function fits(a, b, pending, lax) {
      if (lax >= 3) return true;
      const ang = lax >= 1 ? LANE_MIN_ANGLE / 2 : LANE_MIN_ANGLE;
      const clr = lax >= 1 ? LANE_CLEARANCE / 2 : LANE_CLEARANCE;
      const gap = lax >= 1 ? LANE_GAP / 2 : LANE_GAP;
      if (lax === 0 && (deg[a] >= LANE_MAX_DEGREE || deg[b] >= LANE_MAX_DEGREE)) return false;
      if (lax <= 1) {
        for (let m = 0; m < n; m++) {
          if (m === a || m === b) continue;
          if (segPt(P[a], P[b], P[m]) < radius[m] + clr) return false;
        }
      }
      for (const [c, d] of lanes.concat(pending)) {
        const shared = c === a || c === b || d === a || d === b;
        if (shared) {
          if (lax >= 2) continue;
          const v = (c === a || d === a) ? a : b;
          const x = v === a ? b : a, y = c === v ? d : c;
          if (x === y) return false;
          if (angleAt(v, x, y) < ang) return false;
        } else if (lax >= 2 ? crosses(P[a], P[b], P[c], P[d])
                            : segGap(P[a], P[b], P[c], P[d]) < gap) return false;
      }
      return true;
    }

    // Accept a lane and its mirror together, or neither.
    function tryAdd(a, b, lax) {
      const ma = tw(a), mb = tw(b);
      const selfMirror = (ma === a && mb === b) || (ma === b && mb === a);
      const mirror = ma < 0 || mb < 0 || selfMirror ? null : [ma, mb];
      if (have.has(key(a, b))) return false;
      if (mirror && have.has(key(mirror[0], mirror[1]))) return false;
      if (!fits(a, b, [], lax)) return false;
      if (mirror) {
        if (!fits(mirror[0], mirror[1], [[a, b]], lax)) return false;
        // The two halves must also sit cleanly beside each other.
      }
      for (const [p, q] of mirror ? [[a, b], mirror] : [[a, b]]) {
        lanes.push([p, q]); have.add(key(p, q)); deg[p]++; deg[q]++;
      }
      return true;
    }

    // Candidates: each node's nearest few neighbours in range, shortest
    // first so the cleanest, most local lanes win the contested space.
    const cand = new Map();
    for (let i = 0; i < n; i++) {
      const near = [];
      for (let j = 0; j < n; j++) if (j !== i) near.push({ j, d: dist(P[i], P[j]) });
      near.sort((p, q) => p.d - q.d);
      for (const { j, d } of near.slice(0, LANE_NEIGHBOURS)) {
        if (d < range && !cand.has(key(i, j))) cand.set(key(i, j), { a: Math.min(i, j), b: Math.max(i, j), d });
      }
    }
    const order = [...cand.values()].sort((p, q) => p.d - q.d || p.a - q.a || p.b - q.b);
    for (const c of order) tryAdd(c.a, c.b, 0);

    // Connectivity: join the component holding node 0 to the rest with the
    // shortest lane that keeps the drawing clean, loosening the rules one
    // step at a time only when nothing clean exists, so a pocket is never
    // left but the weakest rule is the one that gives.
    for (let guard = 0; guard < 200; guard++) {
      const seen = componentFrom(nodes, lanes.map(([a, b]) => ({ a: nodes[a].id, b: nodes[b].id })), nodes[0].id);
      if (seen.size === n) break;
      let done = false;
      for (let lax = 0; lax <= 3 && !done; lax++) {
        const pairs = [];
        for (let i = 0; i < n; i++) {
          if (!seen.has(nodes[i].id)) continue;
          for (let j = 0; j < n; j++) {
            if (seen.has(nodes[j].id)) continue;
            pairs.push({ a: i, b: j, d: dist(P[i], P[j]) });
          }
        }
        pairs.sort((p, q) => p.d - q.d || p.a - q.a || p.b - q.b);
        for (const p of pairs) if (tryAdd(p.a, p.b, lax)) { done = true; break; }
      }
      if (!done) break;
    }

    return lanes.map(([a, b]) => ({
      a: Math.min(nodes[a].id, nodes[b].id), b: Math.max(nodes[a].id, nodes[b].id),
      length: dist(nodes[a], nodes[b])
    }));
  }

  function componentFrom(nodes, lanes, startId) {
    const adj = new Map(nodes.map((n) => [n.id, []]));
    for (const l of lanes) { adj.get(l.a).push(l.b); adj.get(l.b).push(l.a); }
    const seen = new Set([startId]);
    const stack = [startId];
    while (stack.length) {
      const cur = stack.pop();
      for (const nx of adj.get(cur) || []) if (!seen.has(nx)) { seen.add(nx); stack.push(nx); }
    }
    return seen;
  }

  // ---- alternative layouts ---------------------------------------------
  // The owner's feedback on the shipped generator: the layout is congested --
  // it is hard to tell which lane goes where, most of all on a phone in 3D.
  // The balance and node variety are liked, the rings on the 3D floor are
  // wanted, so only the PLACEMENT and the LANE CHOICE are redone here, as
  // three more styles behind createGame({ layout }). "classic" is the
  // generator above, untouched. The owner played all four and kept them
  // all: the start screen offers each one, and "Mixed" (its default) draws
  // a different one every match.
  //
  // All three share the shape of the problem: a point-symmetric board
  // (slot k of the first half is node 2k, its 180-degree twin is node 2k+1,
  // the Doomstar is last), slot 0 is the Command and sits at the far end of
  // the long axis, the other six slots take the same type and terrain
  // pools as classic. They differ in where slots go and which lanes join
  // them. Work is done in a board frame (u along the long axis, v across,
  // both from the centre) so one description serves a portrait phone and a
  // landscape desktop; the first half is always u < 0, i.e. the top of a
  // portrait board and the left of a landscape one, as classic does.
  //
  // Measured over 200 seeds on a 390x844 and a 1280x800 board (screen px of
  // the flat 2D fit, phone / desktop; classic -> spaced / orbital / sectors):
  //   lanes per map      29.6 / 29.4 -> 23.9 / 23.6   21.4 / 22.9   20.7 / 20.7
  //   tightest stations  88 / 156    -> 110 / 204     75 / 153      90 / 160   (median per map)
  //   lane nearest a stn 73 / 130    ->  89 / 167     62 / 129      70 / 137
  // Crossings 0, smallest angle 28.1 -> 32-34 degrees, disconnected 0,
  // asymmetric 0 for all. Orbital is not roomier than classic on a phone:
  // nested ellipses leave 69 units between bands at the board's sides, so
  // what it buys is lane readability (a spine, a ring each side, a few
  // links between bands), not spacing. Quick ladder (80 seeds, standard v
  // standard, Cadet..Commander, stock board): classic 98/88/44/31, spaced
  // 100/94/53/29, orbital 98/79/28/23, sectors 100/84/36/30; no
  // stalemates, ~150 s, rush 0% everywhere. NOT re-fitted: orbital's
  // Captain/Commander rungs read low.
  const LAYOUTS = ["classic", "spaced", "orbital", "sectors"];
  function validLayout(name) { return LAYOUTS.indexOf(name) !== -1 ? name : "classic"; }

  function boardFrame(W, H) {
    const vertical = H > W;
    const margin = Math.min(W, H) * 0.075 + 18;   // same edge margin as classic
    const L = vertical ? H : W, S = vertical ? W : H;
    return {
      W, H, vertical, L, S, margin,
      Hu: L / 2 - margin, Hv: S / 2 - margin,     // furthest a node centre may sit
      at: (u, v) => (vertical ? { x: W / 2 + v, y: H / 2 + u } : { x: W / 2 + u, y: H / 2 + v })
    };
  }

  // A fresh RNG stream per attempt, so a rejected layout is retried with
  // different dice but the same seed always walks the same attempts.
  function attemptRng(seed, salt, attempt) {
    return makeRng(((seed >>> 0) ^ Math.imul(salt, 0x9e3779b1)) + Math.imul(attempt + 1, 7919));
  }

  // Nodes from slots: same type / terrain pools and garrisons as classic.
  function nodesFromSlots(seed, fr, slots) {
    const typePool = ["factory", "mine", "relay", "factory", "mine", "factory", "relay"];
    const terrainPool = ["open", "asteroid", "open", "well", "open", "asteroid", "well"];
    const nodes = [];
    slots.forEach((s, i) => {
      const p = fr.at(s.u, s.v), q = fr.at(-s.u, -s.v);
      const type = i === 0 ? "command" : typePool[(i * 3 + seed) % typePool.length];
      const terrain = FLAT_TYPES.indexOf(type) !== -1
        ? "open" : terrainPool[(i * 5 + seed * 3) % terrainPool.length];
      nodes.push({ id: nodes.length, x: p.x, y: p.y, type, terrain, owner: NEUTRAL, garrison: 0, level: 0 });
      nodes.push({ id: nodes.length, x: q.x, y: q.y, type, terrain, owner: NEUTRAL, garrison: 0, level: 0 });
    });
    for (const n of nodes) {
      if (n.type === "command") {
        n.owner = (fr.vertical ? n.y < fr.H / 2 : n.x < fr.W / 2) ? PLAYER : ENEMY;
        n.garrison = 30;
      } else {
        n.garrison = n.type === "factory" ? 20 : n.type === "mine" ? 16 : 11;
      }
    }
    nodes.push({
      id: nodes.length, x: fr.W / 2, y: fr.H / 2, type: "doomstar", terrain: "open",
      owner: NEUTRAL, garrison: DOOM_GARRISON, level: 0
    });
    return nodes;
  }

  // Smallest centre-to-centre distance in the full symmetric set (slots,
  // their twins and the Doomstar), in map units.
  function minSeparation(slots) {
    const all = [{ u: 0, v: 0 }];
    for (const s of slots) { all.push(s, { u: -s.u, v: -s.v }); }
    let m = Infinity;
    for (let i = 0; i < all.length; i++) for (let j = i + 1; j < all.length; j++) {
      m = Math.min(m, Math.hypot(all[i].u - all[j].u, all[i].v - all[j].v));
    }
    return m;
  }

  // Planar lane layer shared by the three styles. Same rules as buildLanes
  // (lanes in mirror pairs, no crossings, a minimum angle at every node,
  // clearance from foreign nodes, a gap between unrelated lanes) but fed an
  // explicit, ordered candidate list instead of "nearest neighbours", with a
  // degree cap and a minimum length so stations never crowd.
  //   groups: [{ pairs: [[i, j], ...], cap? }]  in priority order; cap bounds
  //           how many lanes that group may add
  //   o:      { minLen, maxDeg, angle, clearance, gap }
  function layLanes(nodes, groups, o) {
    const n = nodes.length, P = nodes;
    const minLen = o.minLen || 0, maxDeg = o.maxDeg || 6;
    const ang = o.angle || LANE_MIN_ANGLE, clr = o.clearance === undefined ? LANE_CLEARANCE : o.clearance;
    const gap = o.gap === undefined ? LANE_GAP : o.gap;
    const twinOf = (i) => (i === n - 1 ? i : i ^ 1);
    const radius = nodes.map((m) => NODE_TYPES[m.type].radius);
    const lanes = [], deg = new Array(n).fill(0), have = new Set();
    const key = (a, b) => (a < b ? a * n + b : b * n + a);

    const segPt = (a, b, p) => {
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      const t = l2 ? clamp(((p.x - a.x) * dx + (p.y - a.y) * dy) / l2, 0, 1) : 0;
      return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
    };
    const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    const crosses = (a, b, c, d) =>
      orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;
    const segGap = (a, b, c, d) => crosses(a, b, c, d) ? 0
      : Math.min(segPt(a, b, c), segPt(a, b, d), segPt(c, d, a), segPt(c, d, b));
    const angleAt = (v, a, b) => {
      let d = Math.abs(Math.atan2(P[a].y - P[v].y, P[a].x - P[v].x) - Math.atan2(P[b].y - P[v].y, P[b].x - P[v].x));
      if (d > Math.PI) d = 2 * Math.PI - d;
      return d;
    };

    // relax: 0 = every rule, 1 = half angle / clearance / gap and no degree
    // cap or minimum length, 2 = only "do not cross", 3 = anything.
    function fits(a, b, pending, relax) {
      if (relax >= 3) return true;
      const k = relax >= 1 ? 0.5 : 1;
      if (relax === 0) {
        if (deg[a] >= maxDeg || deg[b] >= maxDeg) return false;
        if (dist(P[a], P[b]) < minLen) return false;
      }
      if (relax <= 1) {
        for (let m = 0; m < n; m++) {
          if (m === a || m === b) continue;
          if (segPt(P[a], P[b], P[m]) < radius[m] + clr * k) return false;
        }
      }
      for (const [c, d] of lanes.concat(pending)) {
        const shared = c === a || c === b || d === a || d === b;
        if (shared) {
          if (relax >= 2) continue;
          const v = (c === a || d === a) ? a : b;
          const x = v === a ? b : a, y = c === v ? d : c;
          if (x === y) return false;
          if (angleAt(v, x, y) < ang * k) return false;
        } else if (relax >= 2 ? crosses(P[a], P[b], P[c], P[d])
                              : segGap(P[a], P[b], P[c], P[d]) < gap * k) return false;
      }
      return true;
    }
    function tryAdd(a, b, relax) {
      const ma = twinOf(a), mb = twinOf(b);
      const self = (ma === a && mb === b) || (ma === b && mb === a);
      const mirror = self ? null : [ma, mb];
      if (a === b || have.has(key(a, b))) return 0;
      if (mirror && have.has(key(mirror[0], mirror[1]))) return 0;
      if (!fits(a, b, [], relax)) return 0;
      if (mirror && !fits(mirror[0], mirror[1], [[a, b]], relax)) return 0;
      const pairs = mirror ? [[a, b], mirror] : [[a, b]];
      for (const [p, q] of pairs) { lanes.push([p, q]); have.add(key(p, q)); deg[p]++; deg[q]++; }
      return pairs.length;
    }

    for (const g of groups) {
      let taken = 0;
      for (const [a, b] of g.pairs) {
        if (g.cap !== undefined && taken >= g.cap) break;
        taken += tryAdd(a, b, 0);
      }
    }

    // Connectivity, loosening one rule at a time only if nothing clean
    // joins the pieces (the same ladder as buildLanes).
    for (let guard = 0; guard < 200; guard++) {
      const seen = componentFrom(nodes, lanes.map(([a, b]) => ({ a, b })), 0);
      if (seen.size === n) break;
      let done = false;
      for (let relax = 0; relax <= 3 && !done; relax++) {
        const pairs = [];
        for (let i = 0; i < n; i++) {
          if (!seen.has(i)) continue;
          for (let j = 0; j < n; j++) if (!seen.has(j)) pairs.push([i, j, dist(P[i], P[j])]);
        }
        pairs.sort((p, q) => p[2] - q[2] || p[0] - q[0] || p[1] - q[1]);
        for (const [a, b] of pairs) if (tryAdd(a, b, relax)) { done = true; break; }
      }
      if (!done) break;
    }
    return lanes.map(([a, b]) => ({
      a: Math.min(a, b), b: Math.max(a, b), length: dist(nodes[a], nodes[b])
    }));
  }

  function pairsByLength(nodes, test) {
    const out = [];
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) {
      const d = dist(nodes[i], nodes[j]);
      if (!test || test(i, j, d)) out.push([i, j, d]);
    }
    return out.sort((p, q) => p[2] - q[2] || p[0] - q[0] || p[1] - q[1]).map((p) => [p[0], p[1]]);
  }

  // Legibility score of a built layout in map units, bigger is better: the
  // tightest of the node-to-node gap, the shortest lane and the closest a
  // lane passes to a node that is not one of its ends (weighted 1.2, because
  // a lane grazing a station is read as a link to it more readily than two
  // stations are confused for one). It is the quantity the owner's
  // "congestion" complaint is about, so each style searches for layouts that
  // maximise it instead of hoping its construction happens to be roomy.
  function layoutScore(nodes, lanes) {
    let m = Infinity;
    for (let i = 0; i < nodes.length; i++) for (let j = i + 1; j < nodes.length; j++) m = Math.min(m, dist(nodes[i], nodes[j]));
    for (const l of lanes) {
      const a = nodes[l.a], b = nodes[l.b];
      m = Math.min(m, l.length);
      const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
      for (const q of nodes) {
        if (q.id === l.a || q.id === l.b) continue;
        const t = l2 ? clamp(((q.x - a.x) * dx + (q.y - a.y) * dy) / l2, 0, 1) : 0;
        m = Math.min(m, 1.2 * Math.hypot(a.x + t * dx - q.x, a.y + t * dy - q.y));
      }
    }
    return m;
  }

  // A layout that came out with few lanes, or a station hanging off a single
  // lane, is worse to play even when its spacing is good: every position
  // should have at least two ways in. Searches multiply their score by this.
  function shapeFactor(nodes, lanes) {
    const deg = new Array(nodes.length).fill(0);
    for (const l of lanes) { deg[l.a]++; deg[l.b]++; }
    return (lanes.length >= 20 ? 1 : 0.7) * (Math.min(...deg) >= 2 ? 1 : 0.75);
  }

  // ---- A: spaced ---------------------------------------------------------
  // Classic made roomier. Seven free points per half are pushed apart by
  // repulsion against EVERY other point in the symmetric set (their own twins
  // and the Doomstar included), which is what classic's half-board relaxation
  // missed: it spaced a half against itself, so a point near the middle sat
  // two or three lane-lengths from its own twin on one side and half of one
  // on the other. The Command is pinned to the far end of the long axis.
  // Lanes: no lane shorter than MIN_LEN_FRAC of the packing spacing, degree
  // cap 4, wider angle / clearance / gap than classic, and a range cap so
  // the lanes that survive are the short sensible ones rather than a web.
  function spacedMap(seed, fr) {
    const { Hu, Hv } = fr;
    const area = 4 * Hu * Hv;
    const hex = Math.sqrt(2 * area / (Math.sqrt(3) * 15));   // best possible spacing of 15 points
    let best = null;
    for (let attempt = 0; attempt < 60; attempt++) {
      const rng = attemptRng(seed, 1, attempt);
      const slots = [{ u: -Hu, v: (rng() - 0.5) * Hv * 0.6 }];
      for (let i = 0; i < 6; i++) slots.push({ u: -(0.04 + rng() * 0.92) * Hu, v: (rng() * 2 - 1) * Hv });
      const R = hex * 1.25;
      for (let iter = 0; iter < 16; iter++) {
        const step = 0.35 * (1 - iter / 24);
        for (let i = 1; i < slots.length; i++) {
          const p = slots[i];
          let fu = 0, fv = 0;
          const push = (qu, qv) => {
            const du = p.u - qu, dv = p.v - qv, d = Math.hypot(du, dv);
            if (d >= R || d < 1e-6) return;
            const w = (R - d) / R;
            fu += du / d * w * hex; fv += dv / d * w * hex;
          };
          push(0, 0);
          for (let j = 0; j < slots.length; j++) {
            if (j !== i) push(slots[j].u, slots[j].v);
            push(-slots[j].u, -slots[j].v);
          }
          p.u = clamp(p.u + fu * step, -Hu * 0.98, -Hu * 0.03);
          p.v = clamp(p.v + fv * step, -Hv, Hv);
        }
      }
      const sep = minSeparation(slots);
      const nodes = nodesFromSlots(seed, fr, slots);
      const lanes = spacedLanes(nodes, sep);
      const score = Math.min(sep, layoutScore(nodes, lanes)) * shapeFactor(nodes, lanes);
      if (!best || score > best.score) best = { nodes, lanes, score };
      if (score >= hex * 0.66) break;
    }
    return best;
  }

  function spacedLanes(nodes, sep) {
    const minLen = sep * 0.95;
    const range = sep * 1.75;
    return layLanes(nodes, [{ pairs: pairsByLength(nodes, (i, j, d) => d >= minLen && d <= range) }], {
      minLen, maxDeg: 4, angle: 34 * Math.PI / 180, clearance: 30, gap: 36
    });
  }

  // ---- B: orbital --------------------------------------------------------
  // Bands around the Doomstar that ARE the 3D floor's range rings. The floor
  // draws three circles at 0.28 / 0.58 / 0.88 of the board's shorter side;
  // on a 2:1 phone board a circle only spans the short side, so nodes laid
  // on circles would huddle in a square in the middle and leave both ends
  // of the board empty. The rings here keep the owner's proportions
  // (0.32 / 0.66 / 1.0 of the outer one) but are ellipses fitted to the board,
  // and the floor draws exactly these (game.rings) for an orbital map.
  //   outer  : both Commands at the poles, plus two home positions per side
  //   middle : three per side, the contested ground
  //   inner  : one per side, beside the Doomstar
  // Lanes run along a ring between neighbours; only a few cross between
  // bands, which is what makes the rings readable as rings.
  const ORBITAL_RHO = [1.0, 0.62, 0.30];
  const ORBITAL_BAND = [0, 0, 0, 0, 1, 1, 2];     // band of each slot
  function orbitalMap(seed, fr) {
    const { Hu, Hv } = fr;
    const place = (rho, t) => ({ u: rho * Hu * Math.cos(t), v: rho * Hv * Math.sin(t) });
    const deg = Math.PI / 180;
    // Each slot's angle may wander inside a window (degrees round the
    // ellipse; the half is the arc 90..270 and its twins fill the other).
    const win = [
      [180 - 3, 180 + 3],      // Command, at the pole
      [116, 158],              // outer: a home position beside the Command
      [202, 244],              // outer: the other
      [88, 106],               // outer: the equator, one side (its twin takes the other)
      [108, 176], [184, 252],  // middle: one each side of the spine
      [160, 200]               // inner, on the spine
    ];
    const rng = attemptRng(seed, 2, 0);
    const build = (c) => c.ts.map((t, i) => place(ORBITAL_RHO[ORBITAL_BAND[i]] * (1 + c.js[i]), t * deg));
    const sample = () => ({
      ts: win.map(([a, b]) => a + rng() * (b - a)),
      js: win.map((_, i) => (i === 0 ? 0 : (rng() - 0.5) * 0.05))
    });
    // The layout is searched, not constructed: draw angle sets, build the
    // lanes each would get, keep the one with the best legibility score,
    // then nudge it. Random draws keep every seed different; the score is
    // what stops a lane cutting through a station of another band.
    const evalc = (c) => {
      const nodes = nodesFromSlots(seed, fr, build(c));
      const lanes = orbitalLanes(nodes, c.ts, minSeparation(build(c)));
      const sc = layoutScore(nodes, lanes) * shapeFactor(nodes, lanes);
      return { c, nodes, lanes, score: sc };
    };
    let best = null;
    for (let k = 0; k < 140; k++) {
      const e = evalc(sample());
      if (!best || e.score > best.score) best = e;
    }
    for (let k = 0; k < 110; k++) {
      const c = {
        ts: best.c.ts.map((t, i) => clamp(t + (rng() - 0.5) * 10, win[i][0], win[i][1])),
        js: best.c.js.map((j, i) => (i === 0 ? 0 : clamp(j + (rng() - 0.5) * 0.02, -0.03, 0.03)))
      };
      const e = evalc(c);
      if (e.score > best.score) best = e;
    }
    best.rings = ORBITAL_RHO.map((r) => (fr.vertical ? [r * Hv, r * Hu] : [r * Hu, r * Hv]));
    return best;
  }

  function orbitalLanes(nodes, ts, sep) {
    const n = nodes.length, D = n - 1;
    // Angle of every node round the centre (a twin is half a turn on) and
    // its band.
    const ang = [], band = [];
    for (let k = 0; k < ts.length; k++) {
      ang[2 * k] = ts[k]; ang[2 * k + 1] = (ts[k] + 180) % 360;
      band[2 * k] = band[2 * k + 1] = ORBITAL_BAND[k];
    }
    const ring = (b) => {
      const ids = [];
      for (let i = 0; i < D; i++) if (band[i] === b) ids.push(i);
      ids.sort((p, q) => ang[p] - ang[q]);
      const pairs = [];
      for (let i = 0; i < ids.length; i++) {
        const a = ids[i], c = ids[(i + 1) % ids.length];
        if (ids.length > 2 || i === 0) pairs.push([a, c]);
      }
      return pairs;
    };
    const byLen = (arr) => arr.map(([a, b]) => [a, b, dist(nodes[a], nodes[b])])
      .sort((p, q) => p[2] - q[2] || p[0] - q[0] || p[1] - q[1]).map((p) => [p[0], p[1]]);
    // Between bands: each node's nearest two on the next band in.
    const radial = (outer, inner) => {
      const pairs = [];
      for (let i = 0; i < D; i++) {
        if (band[i] !== outer) continue;
        const near = [];
        for (let j = 0; j < D; j++) if (band[j] === inner) near.push([j, dist(nodes[i], nodes[j])]);
        near.sort((p, q) => p[1] - q[1]);
        for (const [j] of near.slice(0, 2)) pairs.push([i, j]);
      }
      return byLen(pairs);
    };
    const spokes = [];
    for (let i = 0; i < D; i++) if (band[i] === 2) spokes.push([i, D]);
    const groups = [
      { pairs: byLen(ring(0).concat(ring(1))) },
      { pairs: spokes },
      { pairs: radial(0, 1), cap: 6 },
      { pairs: radial(1, 2), cap: 4 },
      { pairs: byLen(radial(1, 2).concat(radial(0, 1))), cap: 4 }
    ];
    return layLanes(nodes, groups, {
      minLen: sep * 0.9, maxDeg: 4, angle: 34 * Math.PI / 180, clearance: 26, gap: 30
    });
  }

  // ---- C: sectors --------------------------------------------------------
  // A board that reads as places. Each end is a home cluster (the Command,
  // one gate node dead ahead of it, two flank posts beside it); three
  // corridors run base to base -- the left edge, the right edge, and the
  // spine through the Doomstar's plaza -- with a handful of cross-links where
  // a flank meets the plaza. Point symmetry makes the left corridor of one
  // half the right corridor of the other, so each flank is one road from
  // Command to Command, crossing the equator exactly once. Three crossings
  // of the equator in all, which is what a chokepoint is.
  //   slot: 0 Command, 1 gate, 2 plaza, 3/4 home flanks, 5/6 mid flanks
  function sectorsMap(seed, fr) {
    const { Hu, Hv } = fr;
    let best = null;
    for (let attempt = 0; attempt < 40; attempt++) {
      const rng = attemptRng(seed, 3, attempt);
      const j = (a) => (rng() - 0.5) * 2 * a;
      const flip = rng() < 0.5 ? -1 : 1;
      // The spine is Command, gate, plaza, Doomstar: three equal gaps of a
      // third of the half-length, the most room four stations in a line
      // can have. The flank posts sit level with the gate and the plaza.
      const slots = [
        { u: -Hu, v: j(0.12) * Hv },
        { u: -(0.66 + j(0.03)) * Hu, v: j(0.10) * Hv },
        { u: -(0.33 + j(0.03)) * Hu, v: j(0.10) * Hv },
        { u: -(0.66 + j(0.04)) * Hu, v: -(0.80 + j(0.05)) * Hv * flip },
        { u: -(0.62 + j(0.04)) * Hu, v: (0.80 + j(0.05)) * Hv * flip },
        { u: -(0.30 + j(0.04)) * Hu, v: -(0.84 + j(0.05)) * Hv * flip },
        { u: -(0.36 + j(0.04)) * Hu, v: (0.84 + j(0.05)) * Hv * flip }
      ];
      const nodes = nodesFromSlots(seed, fr, slots);
      // Node ids: slot k -> 2k, twin 2k+1; Doomstar last.
      const C = 0, G = 2, PA = 4, TL1 = 6, TR1 = 8, TL2 = 10, TR2 = 12, D = 14;
      const tw = (i) => i ^ 1;
      // The skeleton: home fan, the spine, each flank post to post, and the
      // two equator crossings along the edges (the left post of one half to
      // the twin of the other half's right post, which lies on the same
      // side of the board). Then ONE rung from a flank to the spine near
      // home, ONE at the plaza, and half the time a plaza spoke from the
      // Doomstar: few rungs is the point, since every extra rung turns a
      // corridor into a ladder and the three roads stop being three.
      const must = [[C, G], [C, TL1], [C, TR1], [G, PA], [PA, D], [TL1, TL2], [TR1, TR2],
        [TL2, tw(TR2)], [TR2, tw(TL2)]];
      const rungs = [rng() < 0.5 ? [TL1, G] : [TR1, G], rng() < 0.5 ? [TL2, PA] : [TR2, PA]];
      if (rng() < 0.5) rungs.push(rng() < 0.5 ? [D, TL2] : [D, TR2]);
      const lanes = layLanes(nodes, [
        { pairs: must },
        { pairs: rungs }
      ], { minLen: 0, maxDeg: 5, angle: 32 * Math.PI / 180, clearance: 24, gap: 30 });
      const score = layoutScore(nodes, lanes) * shapeFactor(nodes, lanes);
      if (!best || score > best.score) best = { nodes, lanes, score };
      if (score >= Math.min(Hu, Hv) * 0.62) break;
    }
    return best;
  }

  // One entry point for the three: returns { nodes, lanes, mapW, mapH, rings? }.
  function generateLayout(layout, seed, mapW, mapH) {
    const W = mapW || MAP_W, H = mapH || MAP_H;
    const fr = boardFrame(W, H);
    const built = layout === "spaced" ? spacedMap(seed, fr)
      : layout === "orbital" ? orbitalMap(seed, fr) : sectorsMap(seed, fr);
    const out = { nodes: built.nodes, lanes: built.lanes, mapW: W, mapH: H };
    if (built.rings) out.rings = built.rings;
    return out;
  }

  // ---- game construction ---------------------------------------------
  // ---- opponent posture ------------------------------------------------
  // A mission can ask the opponent to hold ground rather than conquer.
  // In "defend" posture it will retake anything inside its own starting
  // territory and will not attack a single node outside it.
  //
  // Three weaker versions of this were measured first, and each failed
  // in its own direction. Letting the fortress attack freely meant the
  // AI read three 70-unit walls as a stack to throw at the player's
  // home. Forbidding those three nodes to attack at all left the
  // Command sallying alone while the wall never weakened itself, and
  // the player was wiped out in 78% of runs. Pinning everything made
  // the mission "wait long enough" -- 100% winnable by every doctrine
  // at every wall strength tried. Letting dug-in nodes hit only their
  // neighbours leaked, because a node the fortress recaptured was not
  // itself dug in and became a staging post.
  //
  // Bounding it by territory rather than by node is what holds: the
  // wall fights hard for the wall and never takes a step beyond it.
  function isDefensive(game) { return game.posture === "defend"; }
  function defends(game, nodeId) {
    return !isDefensive(game) ||
      (game.foeHomeIds && game.foeHomeIds.indexOf(nodeId) !== -1);
  }

  function validDoctrine(key) { return DOCTRINES[key] ? key : "standard"; }

  // Used by the host when a guest announces its pick. Validation lives
  // here rather than in the protocol so an unknown key can only ever
  // become "standard", never a hole in the rules.
  function setDoctrine(game, seat, key) {
    if (seat !== PLAYER && seat !== ENEMY) return;
    game.doctrine[seat] = validDoctrine(key);
  }

  // A hand-authored board, for campaign missions. Skirmish maps are
  // generated and point-symmetric so a loss is never the map's fault; a
  // mission is the opposite on purpose -- the shape of the ground is the
  // puzzle. Lanes are index pairs, and anything a node omits falls back
  // to a sensible default so a mission file stays readable.
  function buildMap(spec) {
    const W = spec.w || MAP_W, H = spec.h || MAP_H;
    const nodes = spec.nodes.map((n, i) => ({
      id: i,
      x: n.x, y: n.y,
      type: n.type || "factory",
      terrain: FLAT_TYPES.indexOf(n.type) !== -1 ? "open" : (n.terrain || "open"),
      owner: n.owner === undefined ? NEUTRAL : n.owner,
      garrison: n.garrison === undefined ? 0 : n.garrison,
      level: n.level || 0
    }));
    const lanes = spec.lanes.map((l) => ({
      a: Math.min(l[0], l[1]), b: Math.max(l[0], l[1])
    }));
    return { nodes, lanes, mapW: W, mapH: H };
  }

  function createGame(opts) {
    const o = opts || {};
    const seed = (o.seed === undefined ? 12345 : o.seed) >>> 0;
    // `layout` picks the skirmish generator: "classic" (the default and what
    // every earlier build shipped) or one of the candidate styles. A mission
    // brings its own board and ignores it.
    const layout = o.map ? "classic" : validLayout(o.layout);
    const { nodes, lanes, mapW, mapH, rings } = o.map
      ? buildMap(o.map)
      : layout === "classic"
        ? generateMap(seed, o.nodeCount || 14, o.mapW, o.mapH)
        : generateLayout(layout, seed, o.mapW, o.mapH);

    const adjacency = new Map(nodes.map((n) => [n.id, []]));
    for (const l of lanes) { adjacency.get(l.a).push(l.b); adjacency.get(l.b).push(l.a); }

    const rng = makeRng(seed ^ 0x9e3779b9);
    const ascension = clamp(o.ascension | 0, 0, ASCENSION_MAX);
    const mine = validDoctrine(o.doctrine);
    // From Ascension IV the opponent answers your pick; otherwise it draws
    // one from the seed, so a given map always fields the same opponent
    // and a rematch on a new seed is a different problem.
    // The opponent's doctrine is drawn from the seed, so a given map
    // always fields the same opponent and a rematch on a new seed is a
    // different problem to solve.
    const theirs = o.foeDoctrine !== undefined
      ? validDoctrine(o.foeDoctrine)
      : DOCTRINE_KEYS[Math.floor(rng() * DOCTRINE_KEYS.length)];

    return {
      seed,
      rng,
      mapW, mapH,
      // Which generator built the board. The online host sends it in the
      // welcome so the guest rebuilds the same one from the seed.
      layout,
      // Ring ellipses [rx, ry] the 3D floor should draw for this board, or
      // undefined for the stock circles.
      rings,
      nodes, lanes, adjacency,
      fleets: [],
      credits: { [PLAYER]: 40, [ENEMY]: 40 },
      doctrine: { [PLAYER]: mine, [ENEMY]: theirs },
      ascension,
      // A mission can hand the opponent research it would not have had
      // time to earn -- a dug-in defender is dug in from the first tick.
      tech: {
        [PLAYER]: { assault: 0, fortify: 0 },
        [ENEMY]: o.foeTech
          ? { assault: o.foeTech.assault | 0, fortify: o.foeTech.fortify | 0 }
          : ascensionTech(ascension)
      },
      charge: { [PLAYER]: 0, [ENEMY]: 0 },
      chargeTimer: DOOM_CHARGE_INTERVAL,
      time: 0,
      winner: null,
      objective: o.objective || { kind: "eliminate" },
      posture: o.posture || "normal",
      // Captured at creation: "its own ground" cannot mean "whatever it
      // happens to hold", or a defender that takes one node has licence
      // to take the next.
      foeHomeIds: nodes.filter((n) => n.owner === ENEMY).map((n) => n.id),
      holdTimer: 0,
      missionId: o.missionId || null,
      difficulty: o.difficulty === undefined ? 1 : o.difficulty,
      // Seat 2 is the AI in a solo match and the second person online.
      // Nothing in the simulation may act for that seat when somebody is
      // sitting in it -- not the opponent routine, and not the automatic
      // Doomstar. Online this went unnoticed for a while because the
      // host simulates both sides: the guest's weapon charged, the host
      // spent it on the tick it filled, and the guest saw the bar fill
      // and empty with the FIRE button never lighting.
      humanFoe: !!o.humanFoe,
      ai: { timer: 0.8 },
      // Drained by the view each frame and turned into particles, shake
      // and floating numbers. The engine stays render-free but still gets
      // to say "something worth showing happened here".
      events: [],
      // Kept per seat rather than for the player only, so an online
      // guest reads its own scoreboard instead of the host's. `fired`
      // and `taken` are Doomstar strikes dealt and received: a match
      // decided by the weapon should say so at the end.
      stats: {
        [PLAYER]: blankStats(),
        [ENEMY]: blankStats()
      }
    };
  }

  function blankStats() {
    return { sent: 0, captured: 0, lost: 0, peakNodes: 1, fired: 0, taken: 0 };
  }

  function emit(game, ev) { game.events.push(ev); }

  function neighbors(game, id) { return game.adjacency.get(id) || []; }
  function areLinked(game, a, b) { return neighbors(game, a).indexOf(b) !== -1; }
  function nodesOf(game, owner) { return game.nodes.filter((n) => n.owner === owner); }

  // Shortest lane route between two nodes (Dijkstra on lane length).
  // Orders are not restricted to adjacent nodes: a fleet convoys along the
  // network to wherever you send it. This is what makes concentration
  // actually possible — front lines are usually only one or two nodes
  // wide, so "attack with several nodes at once" is geometrically
  // impossible if every order has to be a single hop, and the map just
  // freezes. It is also far better to play: you point at what you want
  // taken, rather than hand-walking units hop by hop.
  // Can a fleet of `owner` pass THROUGH this node on its way somewhere
  // else? Only ground you hold. Everything else -- enemy positions and
  // unclaimed ones alike -- is a roadblock, so a route exists only across
  // territory you have actually taken. This is what turns the lane graph
  // into a real supply network: before it, every route was always
  // available, so there was no such thing as a chokepoint or a flank.
  //
  // No-man's-land used to be open, and that was the single biggest hole
  // in the game. It meant the whole map was in range on the first tick:
  // hold everything, wait for the AI's opening push to leave, then send
  // 75% of every position straight at its Command. Measured, that one
  // line of play won 100/98/87/43% of matches across the four tiers and
  // was over in under thirty seconds. Nothing in the AI could answer it,
  // because the answer is not a smarter AI -- an undefended Command one
  // uninterrupted flight away is simply not defensible. Closing transit
  // through neutral ground means an attack has to be walked forward over
  // ground you have paid for, which kills the rush outright (measured
  // 0% at every tier) and makes position mean something.
  //
  // `undefined` owner means "ignore ownership" (used for map validation).
  function canTransit(game, owner, nodeId) {
    if (owner === undefined || owner === null) return true;
    return game.nodes[nodeId].owner === owner;
  }

  function findPath(game, fromId, toId, owner) {
    if (fromId === toId) return null;
    const distTo = new Map([[fromId, 0]]);
    const prev = new Map();
    const visited = new Set();
    const queue = [fromId];
    while (queue.length) {
      // Small graphs (~14 nodes) — a linear scan for the nearest unvisited
      // node is faster in practice than maintaining a heap.
      let bi = 0;
      for (let i = 1; i < queue.length; i++) {
        if ((distTo.get(queue[i]) ?? Infinity) < (distTo.get(queue[bi]) ?? Infinity)) bi = i;
      }
      const cur = queue.splice(bi, 1)[0];
      if (cur === toId) break;
      if (visited.has(cur)) continue;
      visited.add(cur);
      for (const nx of neighbors(game, cur)) {
        if (visited.has(nx)) continue;
        // The destination may be anything — that is the attack. Every
        // node BEFORE it has to be passable, so an enemy position blocks
        // the road rather than being flown over.
        if (nx !== toId && !canTransit(game, owner, nx)) continue;
        const d = (distTo.get(cur) || 0) + dist(game.nodes[cur], game.nodes[nx]);
        if (d < (distTo.get(nx) ?? Infinity)) {
          distTo.set(nx, d); prev.set(nx, cur);
          if (queue.indexOf(nx) === -1) queue.push(nx);
        }
      }
    }
    if (!prev.has(toId)) return null;
    const path = [toId];
    let cur = toId;
    while (cur !== fromId) { cur = prev.get(cur); path.unshift(cur); }
    return path;
  }

  // ---- orders ---------------------------------------------------------
  // Returns undefined on success, or a short reason string. The view shows
  // the reason verbatim, so these read as player-facing text.
  function sendFleet(game, fromId, toId, fraction, owner) {
    if (game.winner) return "The battle is over.";
    const from = game.nodes[fromId], to = game.nodes[toId];
    if (!from || !to) return "No such position.";
    if (from.owner !== owner) return "You don't hold that position.";
    if (fromId === toId) return "Pick a different target.";
    const path = findPath(game, fromId, toId, owner);
    if (!path) return "No route \u2014 you can only move through ground you hold.";

    const frac = clamp(fraction === undefined ? 0.5 : fraction, 0.05, 1);
    const count = Math.floor(from.garrison * frac);
    if (count < MIN_SEND) return "Not enough units to send.";

    from.garrison -= count;
    game.fleets.push({
      owner, from: fromId, to: toId, count, path, leg: 0,
      t: 0, duration: dist(from, game.nodes[path[1]]) / fleetSpeed(game, owner)
    });
    game.stats[owner].sent += count;
    emit(game, { kind: "launch", x: from.x, y: from.y, owner, count });
    return undefined;
  }

  function upgradeNode(game, id, owner) {
    if (game.winner) return "The battle is over.";
    const n = game.nodes[id];
    if (!n) return "No such position.";
    if (n.owner !== owner) return "You don't hold that position.";
    if (n.level >= MAX_LEVEL) return "Already at maximum level.";
    const cost = upgradeCost(n.level);
    if ((game.credits[owner] || 0) < cost) return "Need " + cost + " credits.";
    game.credits[owner] -= cost;
    n.level += 1;
    emit(game, { kind: "upgrade", x: n.x, y: n.y, owner, level: n.level });
    return undefined;
  }

  // ---- simulation ------------------------------------------------------
  function step(game, dt) {
    if (game.winner) return;
    game.time += dt;
    computeSupply(game);

    // Production. Garrisons are floats internally and floored for display,
    // so a slow node still makes visible progress between ticks.
    const aiMult = aiProduction(game);
    for (const n of game.nodes) {
      if (n.owner === NEUTRAL) continue;
      const s = nodeStats(n, game);
      const m = (n.owner === ENEMY ? aiMult : 1) * supplyMultiplier(n, game);
      if (n.garrison < s.cap) n.garrison = Math.min(s.cap, n.garrison + s.unitRate * m * dt);
      if (s.creditRate > 0) game.credits[n.owner] = (game.credits[n.owner] || 0) + s.creditRate * m * dt;
    }

    // Fleet movement: advance along the current lane, then hand off to the
    // next leg of the route until the final node is reached.
    const remaining = [];
    for (const f of game.fleets) {
      f.t += dt / f.duration;
      while (f.t >= 1 && f.leg < f.path.length - 2) {
        f.leg += 1;
        f.t -= 1;
        const a = game.nodes[f.path[f.leg]], b = game.nodes[f.path[f.leg + 1]];
        f.duration = dist(a, b) / fleetSpeed(game, f.owner);
        f.t *= 1; // carry the overshoot into the new leg
      }
      if (f.t < 1) { remaining.push(f); continue; }
      resolveArrival(game, f);
    }
    game.fleets = remaining;

    stepAssaults(game, dt);
    stepCharge(game, dt);

    if (!game.humanFoe && canFire(game, ENEMY)) fireDoomstar(game, ENEMY);
    if (!game.humanFoe) stepAI(game, dt);

    // Win check. A side is eliminated when it holds no nodes and has
    // nothing still in transit that could retake one.
    const pAlive = game.nodes.some((n) => n.owner === PLAYER) || game.fleets.some((f) => f.owner === PLAYER);
    const eAlive = game.nodes.some((n) => n.owner === ENEMY) || game.fleets.some((f) => f.owner === ENEMY);
    if (!eAlive && pAlive) game.winner = PLAYER;
    else if (!pAlive && eAlive) game.winner = ENEMY;
    else if (!pAlive && !eAlive) game.winner = NEUTRAL;
    else {
      // Both sides still standing: the brief decides, if there is one.
      const byObjective = stepObjective(game, dt);
      if (byObjective) game.winner = byObjective;
    }

    for (const seat of [PLAYER, ENEMY]) {
      const owned = nodesOf(game, seat).length;
      if (owned > game.stats[seat].peakNodes) game.stats[seat].peakNodes = owned;
    }
  }

  function resolveArrival(game, f) {
    const to = game.nodes[f.to];
    const s = nodeStats(to, game);

    if (to.owner === f.owner) {
      const before = to.garrison;
      // Overflow above the cap is wasted -- but reinforcing a position
      // must never make it SMALLER. A node already over its cap (a
      // mission's fortification, say) was being clamped down to the cap
      // the moment a friendly fleet arrived, so a 220-unit wall
      // collapsed to 68 the first time the AI topped it up, and the
      // whole siege fell over in fifty seconds.
      to.garrison = OVERFLOW_WASTE
        ? Math.max(before, Math.min(s.cap, before + f.count))
        : before + f.count;
      emit(game, {
        kind: "reinforce", x: to.x, y: to.y, owner: f.owner,
        count: Math.round(to.garrison - before), wasted: Math.round(f.count - (to.garrison - before))
      });
      return;
    }

    // Hostile arrival: join (or open) the assault massing on this node and
    // restart its fuse, so anything else converging within the window
    // fights alongside rather than being ground down separately.
    if (!to.assault || to.assault.owner !== f.owner) {
      // A second attacker arriving mid-fuse just resolves the existing
      // assault first — three-way fights aren't worth the complexity.
      if (to.assault) resolveAssault(game, to);
      to.assault = { owner: f.owner, count: 0, fuse: COALESCE_WINDOW };
    }
    to.assault.count += f.count;
    to.assault.fuse = COALESCE_WINDOW;
    emit(game, { kind: "massing", x: to.x, y: to.y, owner: f.owner, count: Math.round(to.assault.count) });
  }

  function stepAssaults(game, dt) {
    for (const n of game.nodes) {
      if (!n.assault) continue;
      n.assault.fuse -= dt;
      if (n.assault.fuse <= 0) resolveAssault(game, n);
    }
  }

  function resolveAssault(game, to) {
    const a = to.assault;
    to.assault = null;
    if (!a) return;
    const f = { owner: a.owner, count: a.count, to: to.id };
    // Both sides fight at their researched strength. Comparisons happen in
    // "effective" strength, and anything written back to a garrison is
    // converted to real units so the numbers on screen stay honest.
    const atkMult = assaultMult(game, a.owner);
    const effAttack = f.count * atkMult;
    const defence = defenceOf(game, to);
    if (effAttack > defence) {
      const survivors = (effAttack - defence) / atkMult;
      const previousOwner = to.owner;
      to.owner = f.owner;
      // Capturing does not hand you the previous owner's upgrades; taking
      // ground is a foothold, not a free fortress. Ownership and level are
      // settled before the cap is read, so the survivors are held to the
      // CAPTOR's capacity rather than the defender's.
      to.level = 0;
      to.garrison = Math.min(nodeStats(to, game).cap, survivors);
      game.stats[f.owner].captured += 1;
      if (previousOwner !== NEUTRAL) game.stats[previousOwner].lost += 1;
      emit(game, {
        kind: "capture", x: to.x, y: to.y, owner: f.owner, from: previousOwner,
        nodeId: to.id, count: Math.round(survivors), big: to.type === "command"
      });
    } else {
      // Attack repulsed: the defender keeps the node, minus losses. The
      // defender's own multipliers are unwound so the garrison shown is
      // real units rather than effective strength — a better-fortified
      // defender loses fewer units to the same attack.
      const perUnit = terrainDefence(to) *
        (to.owner === NEUTRAL ? 1 : DEFENDER_EDGE * fortifyMult(game, to.owner));
      to.garrison = Math.max(0, to.garrison - effAttack / perUnit);
      emit(game, {
        kind: "repulsed", x: to.x, y: to.y, owner: to.owner, attacker: f.owner,
        count: Math.round(f.count)
      });
    }
  }

  // ---- AI --------------------------------------------------------------
  // Deliberately simple and legible: it values targets, commits only when
  // the maths says it wins, reinforces its own front line, and spends
  // credits. That is enough to punish a careless player without needing
  // lookahead, and it never cheats — it plays through sendFleet like you.
  // Difficulty scales how *often* the AI can act and how many positions it
  // can coordinate — not how recklessly it attacks. Measured the obvious
  // way round first and it inverted the tiers: an AI told to attack on
  // thin margins constantly dribbled its army away and lost to the tier
  // that waited for an overwhelming margin. Patience is strength here, so
  // every tier keeps the same good attack threshold and the easy ones are
  // simply slower and less able to mass from depth.
  // Two independent knobs, and keeping them separate is the whole trick:
  //   interval — how often the AI *looks* for something to do (fast is
  //              good: it reacts to threats and spends idle capacity)
  //   margin   — how much more force than strictly needed before it
  //              *commits* (high is good: thin-margin attacks fail and
  //              throw the army away)
  // Tying them together inverts the tiers. Measured twice: a "relaxed"
  // AI on a long interval simply banked its army and ground out a win
  // (53 units to the player's 9 by t=80), while the "ruthless" one
  // attacked constantly and left every position thin enough to counter.
  // Hard is therefore responsive *and* patient; easy is sluggish *and*
  // reckless, which is what actually makes it easy to beat.
  // `produce` is the primary lever and the only one that orders reliably.
  // Decision-quality knobs cannot: `margin` helps and hurts in opposite
  // phases (a thin margin grabs undefended neutrals quickly but throws
  // armies at dug-in positions), and early expansion dominates the
  // outcome, so tuning it inverted the tiers twice. A production
  // multiplier is monotonic by construction, which is why almost every
  // RTS uses one. It is applied openly to the AI's own output; the AI
  // still plays through the same orders the player does.
  // The jump from Officer to Commander used to be 1.00 to 1.75 in one
  // step, which is most of the game's whole difficulty range in a single
  // button. Captain fills it, so there is somewhere to go after an even
  // fight stops being a fight.
  // Retuned when transit through neutral ground closed. Contiguous
  // expansion changes the shape of the whole match -- matches run ~148s
  // rather than ~80s -- and the old multipliers, carried over unchanged,
  // left the ladder at 100/18/2/0. Re-fitted against the person-like
  // commander in `scratchpad/harness2.js`, 80 seeds a tier:
  // 99 / 85 / 50 / 35% with no stalemates.
  //
  // The band is far narrower than it looks. Holding everything else
  // fixed, Officer wins 3% of matches at 0.80 and 63% at 1.00, so a
  // "small" nudge of 0.05 here is not small. Cadet is also pinned from
  // the other side: at 0.90 the AI wins The Waist outright on every
  // seed, which turns a campaign mission the player is supposed to
  // learn from into a loss. Measure both, never nudge by intuition.
  //
  // Lane generation was later made planar (see buildLanes), which removed
  // ~3 of 32 lanes and moved the ladder to 98 / 91 / 51 / 36 over 300
  // seeds (Officer, Captain +8 / +10). Officer 0.86 -> 0.87 and Captain
  // 0.93 -> 0.94 brought them back to 84 / 46 (300 seeds). Cadet stays at
  // 0.80 for The Waist.
  const DIFFICULTY = [
    { interval: 2.4, margin: 1.30, minGarrison: 10, maxAttackers: 3, send: 0.60, upgrade: false, produce: 0.80 },
    { interval: 1.8, margin: 1.40, minGarrison: 11, maxAttackers: 4, send: 0.70, upgrade: true,  produce: 0.87 },
    { interval: 1.5, margin: 1.45, minGarrison: 11, maxAttackers: 5, send: 0.75, upgrade: true,  produce: 0.94 },
    { interval: 1.2, margin: 1.50, minGarrison: 12, maxAttackers: 6, send: 0.80, upgrade: true,  produce: 1.00 }
  ];
  const TOP_TIER = DIFFICULTY.length - 1;
  function aiProduction(game) {
    const cfg = DIFFICULTY[clamp(game.difficulty | 0, 0, DIFFICULTY.length - 1)];
    return cfg.produce * ascensionProduce(game.ascension);
  }

  function stepAI(game, dt) {
    const cfg = DIFFICULTY[clamp(game.difficulty | 0, 0, DIFFICULTY.length - 1)];
    game.ai.timer -= dt;
    if (game.ai.timer > 0) return;
    game.ai.timer = cfg.interval;

    const mine = nodesOf(game, ENEMY);
    if (!mine.length) return;

    if (cfg.upgrade) considerSpending(game, mine);

    if (!isDefensive(game) && finishingBlow(game, mine)) return;

    // Pick the best target on the whole map, then throw *everything that
    // borders it* at once. Attacking with one node at a time can never
    // beat the defender edge, so an AI that does that simply never takes
    // ground — it has to concentrate for the same reason the player does.
    let best = null;
    for (const tgt of game.nodes) {
      if (tgt.owner === ENEMY) continue;
      if (!defends(game, tgt.id)) continue;   // holding ground, not taking it
      // Any owned node can contribute, not just bordering ones — the AI
      // masses from depth exactly the way the player can.
      const attackers = mine
        .filter((s) => s.garrison >= cfg.minGarrison && findPath(game, s.id, tgt.id, ENEMY))
        .sort((a, b) => dist(a, tgt) - dist(b, tgt))
        .slice(0, cfg.maxAttackers);
      if (!attackers.length) continue;

      const force = attackers.reduce((sum, s) => sum + Math.floor(s.garrison * cfg.send), 0);
      const need = (defenceOf(game, tgt) / assaultMult(game, ENEMY)) * cfg.margin - incoming(game, tgt.id, ENEMY);
      if (force <= need) continue;

      // The centre and the Relays are worth more than their raw output:
      // one wins the weapon, the others fuel it.
      const value = NODE_TYPES[tgt.type].units * 2 + NODE_TYPES[tgt.type].credits * 3
        + (tgt.type === "doomstar" ? 4 : 0)
        + (tgt.type === "relay" ? 1.5 : 0)
        + (tgt.owner === PLAYER ? 1.5 : 0);
      // Prefer ground that extends the existing front. Taking an isolated
      // pocket now leaves it out of supply at a third of its output, and
      // cutting a node that carries the player's supply is worth extra.
      const touchesUs = neighbors(game, tgt.id).some((id) => game.nodes[id].owner === ENEMY);
      const cutsThem = tgt.owner === PLAYER &&
        neighbors(game, tgt.id).some((id) => game.nodes[id].owner === PLAYER);
      const score = (value * (touchesUs ? 1.8 : 1) * (cutsThem ? 1.3 : 1)) /
        (defenceOf(game, tgt) + 4);
      if (!best || score > best.score) best = { score, tgt, attackers };
    }
    if (best) {
      for (const src of best.attackers) sendFleet(game, src.id, best.tgt.id, cfg.send, ENEMY);
      return;
    }

    // Nothing worth attacking — shore up whichever owned node borders the
    // player and is weakest, pulling from the safest strong node.
    //
    // A defender does not do this. Shuffling garrisons is a conquest
    // habit: it sends half of a donor away, which had a 150-unit siege
    // wall draining itself to 75 within fifteen seconds and handed the
    // player the fortress. A fortification holds what it was given.
    if (isDefensive(game)) return;
    const front = mine
      .filter((n) => neighbors(game, n.id).some((id) => game.nodes[id].owner === PLAYER))
      .sort((a, b) => a.garrison - b.garrison)[0];
    if (!front) return;
    const donor = mine
      .filter((n) => n.id !== front.id && n.garrison > cfg.minGarrison &&
        areLinked(game, n.id, front.id))
      .sort((a, b) => b.garrison - a.garrison)[0];
    if (donor) sendFleet(game, donor.id, front.id, 0.5, ENEMY);
  }

  // The AI buys research too, or the player simply out-techs it for free.
  // It leans Assault when it is even or ahead (it still has to attack to
  // win) and Fortify when it is losing ground, and keeps a margin so it
  // is not left permanently broke.
  // When the opponent is nearly finished, stop being careful.
  //
  // A cautious tier is capped at two attackers committing 55% each, which
  // tops out around 49 units — less than the 87.5 defence of a capped
  // Command. So an AI that had already won on material would sit on 14
  // nodes against the player's 1 and never be able to take the last one.
  // Measured before this: Cadet failed to finish on 5 of 40 idle matches,
  // leaving a new player in a game with no resolution.
  //
  // This only fires when the opponent is down to their last position or
  // two AND the force actually clears the defence, so it closes out a
  // decided game without making the AI reckless in a live one.
  const FINISH_NODES = 2;
  const FINISH_MIN_OWN = 4;      // it must actually have built an empire
  const FINISH_DOMINANCE = 3;    // ...and hold several times what is left
  function finishingBlow(game, mine) {
    const foes = nodesOf(game, PLAYER);
    if (!foes.length || foes.length > FINISH_NODES) return false;
    // Both sides start on exactly one position, so "the opponent is down
    // to one node" is also true at kick-off. Without these two extra
    // conditions the AI opened every game by hurling its whole garrison
    // at the enemy Command, which wrecked the difficulty tiers (measured
    // 16/16/1 instead of 16/15/10). This has to mean *endgame*, not
    // *opening*.
    if (mine.length < FINISH_MIN_OWN) return false;
    if (mine.length < foes.length * FINISH_DOMINANCE) return false;
    // Go for whichever is softest; the rest follows next tick.
    const tgt = foes.slice().sort((a, b) => defenceOf(game, a) - defenceOf(game, b))[0];
    const attackers = mine.filter((s) => s.garrison >= 4 && findPath(game, s.id, tgt.id, ENEMY));
    if (!attackers.length) return false;
    const force = attackers.reduce((sum, s) => sum + Math.floor(s.garrison * 0.9), 0)
      * assaultMult(game, ENEMY);
    if (force <= defenceOf(game, tgt) - incoming(game, tgt.id, ENEMY) * assaultMult(game, ENEMY)) {
      return false;   // not yet enough — keep massing rather than feeding it
    }
    for (const src of attackers) sendFleet(game, src.id, tgt.id, 0.9, ENEMY);
    return true;
  }

  function considerSpending(game, owned) {
    const behind = owned.length < nodesOf(game, PLAYER).length;
    const track = behind ? "fortify" : "assault";
    const cost = techCost(track, techLevel(game, ENEMY, track), game, ENEMY);
    const credits = game.credits[ENEMY] || 0;
    if (cost !== null) {
      if (credits >= cost) { researchTech(game, track, ENEMY); return; }
      // Save toward the next level instead of dribbling the credits away
      // on cheap node upgrades. Without this the AI hovered just under
      // the price of Assault I for an entire match — measured at 89-95
      // credits banked against a 90-credit cost — and never researched
      // at all, because every spare 60 went on a node upgrade first.
      if (credits >= cost * 0.5) return;
    }
    considerUpgrade(game, owned);
  }

  function considerUpgrade(game, owned) {
    const target = owned
      .filter((n) => n.level < MAX_LEVEL)
      .sort((a, b) => (NODE_TYPES[b.type].units + NODE_TYPES[b.type].credits)
        - (NODE_TYPES[a.type].units + NODE_TYPES[a.type].credits))[0];
    if (target) upgradeNode(game, target.id, ENEMY);
  }

  function incoming(game, nodeId, owner) {
    let n = 0;
    for (const f of game.fleets) if (f.to === nodeId && f.owner === owner) n += f.count;
    return n;
  }

  // Aggregate production per second, for the HUD.
  function income(game, owner) {
    let units = 0, credits = 0;
    for (const n of game.nodes) {
      if (n.owner !== owner) continue;
      const s = nodeStats(n, game);
      units += s.unitRate; credits += s.creditRate;
    }
    return { units, credits };
  }

  // --- networking support ----------------------------------------------
  // Only the mutable half of the game travels. The board itself (node
  // positions, types, terrain, lanes) is a pure function of the seed and
  // board shape, so both peers generate an identical map from `welcome`
  // and never have to ship geometry.
  function serializeState(game) {
    return {
      t: game.time,
      w: game.winner,
      cr: { 1: game.credits[PLAYER] || 0, 2: game.credits[ENEMY] || 0 },
      ch: { 1: game.charge[PLAYER] || 0, 2: game.charge[ENEMY] || 0 },
      ct: game.chargeTimer,
      tc: {
        1: { a: techLevel(game, PLAYER, "assault"), f: techLevel(game, PLAYER, "fortify") },
        2: { a: techLevel(game, ENEMY, "assault"), f: techLevel(game, ENEMY, "fortify") }
      },
      n: game.nodes.map((n) => [
        n.owner, Math.round(n.garrison * 100) / 100, n.level,
        n.assault ? [n.assault.owner, Math.round(n.assault.count * 100) / 100, n.assault.fuse] : 0
      ]),
      f: game.fleets.map((f) => [f.owner, f.count, f.t, f.leg, f.duration, f.path]),
      st: game.stats
    };
  }

  function applySnapshot(game, snap) {
    if (!snap) return;
    game.time = snap.t;
    game.winner = snap.w;
    game.credits[PLAYER] = snap.cr[1]; game.credits[ENEMY] = snap.cr[2];
    game.charge[PLAYER] = snap.ch[1]; game.charge[ENEMY] = snap.ch[2];
    game.chargeTimer = snap.ct;
    game.tech[PLAYER] = { assault: snap.tc[1].a, fortify: snap.tc[1].f };
    game.tech[ENEMY] = { assault: snap.tc[2].a, fortify: snap.tc[2].f };
    for (let i = 0; i < game.nodes.length && i < snap.n.length; i++) {
      const n = game.nodes[i], row = snap.n[i];
      n.owner = row[0]; n.garrison = row[1]; n.level = row[2];
      n.assault = row[3] ? { owner: row[3][0], count: row[3][1], fuse: row[3][2] } : null;
    }
    game.fleets = snap.f.map((r) => ({
      owner: r[0], count: r[1], t: r[2], leg: r[3], duration: r[4], path: r[5],
      from: r[5][0], to: r[5][r[5].length - 1]
    }));
    if (snap.st) game.stats = snap.st;
    computeSupply(game);
  }

  // Every order a networked peer can ask for, funnelled through one
  // seat-checked entry point. The seat comes from the connection, never
  // from the message, so a guest cannot move the host's forces.
  function applyOrderAs(game, order, seat) {
    if (!order || typeof order !== "object") return "Malformed order.";
    switch (order.kind) {
      case "send":
        return sendFleet(game, order.from | 0, order.to | 0, +order.frac || 0.5, seat);
      case "upgrade":
        return upgradeNode(game, order.id | 0, seat);
      case "research":
        return researchTech(game, String(order.track), seat);
      case "fire":
        return fireDoomstar(game, seat, order.target);
      default:
        return "Unknown order.";
    }
  }

  function drainEvents(game) {
    const e = game.events;
    game.events = [];
    return e;
  }

  return {
    MAP_W, MAP_H, NEUTRAL, PLAYER, ENEMY, NODE_TYPES, MAX_LEVEL,
    DEFENDER_EDGE, FLEET_SPEED, MIN_SEND, DIFFICULTY, TOP_TIER, RATE_BONUS, CAP_BONUS, COALESCE_WINDOW,
    DOOM_CHARGE_NEEDED, DOOM_CHARGE_PER_RELAY, DOOM_CHARGE_INTERVAL, DOOM_DAMAGE,
    DOOM_GARRISON,
    TECH, TECH_MAX, TERRAIN, FLAT_TYPES,
    makeRng, dist, clamp, upgradeCost, nodeStats, defenceOf,
    generateMap, buildLanes, buildMap, createGame, LAYOUTS, validLayout,
    OBJECTIVES, stepObjective, objectiveProgress, objectiveNodes,
    neighbors, areLinked, nodesOf, incoming, income, findPath, aiProduction,
    canTransit, computeSupply, supplyMultiplier, OUT_OF_SUPPLY_RATE,
    terrainOf, terrainDefence,
    sendFleet, upgradeNode, researchTech, fireDoomstar, step,
    serializeState, applySnapshot, applyOrderAs,
    isDefensive, defends, isContested, chargingRelays, doomstarNode, canFire, doomstarTarget, resolveArrival, resolveAssault, drainEvents,
    techLevel, techCost, assaultMult, fortifyMult,
    DOCTRINES, DOCTRINE_KEYS, doctrineOf, docMod, setDoctrine, fleetSpeed,
    relayCharge, strikeDamage,
    ASCENSION, ASCENSION_MAX, ascensionTech, ascensionProduce
  };
});
