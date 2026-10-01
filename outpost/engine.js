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
  const DOCTRINES = {
    standard: {
      label: "Standard", icon: "\u25c6",
      up: "Balanced \u2014 nothing to exploit",
      down: "",
      mods: {}
    },
    vanguard: {
      label: "Vanguard", icon: "\u27a4",
      up: "Fleets travel 25% faster",
      down: "Positions build units 12% slower",
      mods: { speed: 1.25, units: 0.88 }
    },
    logistics: {
      label: "Deep Logistics", icon: "\u25cf",
      up: "Cut-off positions keep 90% output, not 30%",
      down: "Credit income \u221230%",
      mods: { cutoff: 0.90, credits: 0.70 }
    },
    relays: {
      label: "Forward Relays", icon: "\u2605",
      up: "Relays out-build Factories and charge the Doomstar twice as fast",
      down: "Everywhere else builds 10% slower",
      // The charge half of this used to be the whole doctrine, and it
      // was worth nothing: across 40 measured matches neither side ever
      // held the centre, so the weapon never fired at all. The Relay
      // production bonus is what makes the pick pay off in the match
      // you are actually having; the charge is the upside when it does
      // come together.
      mods: { relayUnits: 2.5, chargeRate: 2, units: 0.90 }
    },
    prospectors: {
      label: "Prospectors", icon: "\u25c8",
      up: "Income +70% and research costs 30% less",
      down: "Positions build units 10% slower",
      mods: { credits: 1.70, research: 0.70, units: 0.90 }
    },
    shock: {
      label: "Shock Troops", icon: "\u25b2",
      up: "Assaults land 15% harder",
      down: "Positions defend 6% worse and build 20% slower",
      mods: { attack: 1.15, defence: 0.94, units: 0.80 }
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
  // Measured player win rate over 200 seeds at Commander:
  //   none 44% | I 39% | II 31% | III 11% | IV 7% | V 2%
  // (measured with the person-like commander in scratchpad/harness2.js.
  // Assault II is a cliff -- 31% to 11% -- so the first rungs are built
  // from Fortify and Assault I to make the climb a climb. An earlier V
  // that only added production inverted against IV: at that depth the
  // tech gap already decides it.)
  const ASCENSION = [
    { label: "Ascension I",   note: "The enemy starts with Fortify I",
      tech: { assault: 0, fortify: 1 } },
    { label: "Ascension II",  note: "The enemy also starts with Assault I",
      tech: { assault: 1, fortify: 1 } },
    { label: "Ascension III", note: "Its Assault starts at II",
      tech: { assault: 2, fortify: 1 } },
    { label: "Ascension IV",  note: "The enemy starts fully researched",
      tech: { assault: 3, fortify: 3 } },
    { label: "Ascension V",   note: "...and out-produces you by a further 25%",
      tech: { assault: 3, fortify: 3 }, produce: true }
  ];
  const ASCENSION_MAX = ASCENSION.length;
  const ASC_PRODUCE_BONUS = 1.25;

  // Starting tech granted by an ascension level (0 = none).
  function ascensionTech(level) {
    const rung = ASCENSION[(level | 0) - 1];
    return rung ? { assault: rung.tech.assault, fortify: rung.tech.fortify }
                : { assault: 0, fortify: 0 };
  }
  function ascensionProduce(level) {
    const rung = ASCENSION[(level | 0) - 1];
    return rung && rung.produce ? ASC_PRODUCE_BONUS : 1;
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

  // Lanes connect each node to its nearest neighbours, then the graph is
  // forced connected. Lanes are the whole strategic skeleton: you can only
  // order a move between linked nodes, so chokepoints are real.
  function buildLanes(nodes, maxRange) {
    const key = (a, b) => (a < b ? a + ":" + b : b + ":" + a);
    const set = new Map();
    const add = (a, b) => {
      if (a === b) return;
      const k = key(a, b);
      if (!set.has(k)) set.set(k, { a: Math.min(a, b), b: Math.max(a, b) });
    };

    // Connect to the 3 nearest neighbours within a sane range.
    for (const n of nodes) {
      const near = nodes
        .filter((m) => m.id !== n.id)
        .map((m) => ({ m, d: dist(n, m) }))
        .sort((p, q) => p.d - q.d)
        .slice(0, 4);
      for (const { m, d } of near) if (d < (maxRange || 340)) add(n.id, m.id);
    }

    // Force connectivity: repeatedly join the component holding node 0 to
    // the closest node outside it. Without this a map can generate with an
    // unreachable pocket, which reads as a bug to the player.
    for (let guard = 0; guard < 200; guard++) {
      const seen = componentFrom(nodes, [...set.values()], 0);
      if (seen.size === nodes.length) break;
      let best = null;
      for (const n of nodes) {
        if (!seen.has(n.id)) continue;
        for (const m of nodes) {
          if (seen.has(m.id)) continue;
          const d = dist(n, m);
          if (!best || d < best.d) best = { a: n.id, b: m.id, d };
        }
      }
      if (!best) break;
      add(best.a, best.b);
    }

    return [...set.values()].map((l) => ({
      a: l.a, b: l.b, length: dist(nodes[l.a], nodes[l.b])
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

  // ---- game construction ---------------------------------------------
  function validDoctrine(key) { return DOCTRINES[key] ? key : "standard"; }

  // Used by the host when a guest announces its pick. Validation lives
  // here rather than in the protocol so an unknown key can only ever
  // become "standard", never a hole in the rules.
  function setDoctrine(game, seat, key) {
    if (seat !== PLAYER && seat !== ENEMY) return;
    game.doctrine[seat] = validDoctrine(key);
  }

  function createGame(opts) {
    const o = opts || {};
    const seed = (o.seed === undefined ? 12345 : o.seed) >>> 0;
    const { nodes, lanes, mapW, mapH } = generateMap(seed, o.nodeCount || 14, o.mapW, o.mapH);

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
      nodes, lanes, adjacency,
      fleets: [],
      credits: { [PLAYER]: 40, [ENEMY]: 40 },
      doctrine: { [PLAYER]: mine, [ENEMY]: theirs },
      ascension,
      tech: { [PLAYER]: { assault: 0, fortify: 0 }, [ENEMY]: ascensionTech(ascension) },
      charge: { [PLAYER]: 0, [ENEMY]: 0 },
      chargeTimer: DOOM_CHARGE_INTERVAL,
      time: 0,
      winner: null,
      difficulty: o.difficulty === undefined ? 1 : o.difficulty,
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
  // else? Your own ground and no-man's-land are open; an enemy-held node
  // is a roadblock. This is what turns the lane graph into a real supply
  // network: before it, every route was always available, so there was no
  // such thing as a chokepoint, a flank, or a line worth cutting.
  // `undefined` owner means "ignore ownership" (used for map validation).
  function canTransit(game, owner, nodeId) {
    if (owner === undefined || owner === null) return true;
    const n = game.nodes[nodeId];
    return n.owner === owner || n.owner === NEUTRAL;
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
    if (!path) return "No route \u2014 the enemy holds the way.";

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

    if (canFire(game, ENEMY)) fireDoomstar(game, ENEMY);
    stepAI(game, dt);

    // Win check. A side is eliminated when it holds no nodes and has
    // nothing still in transit that could retake one.
    const pAlive = game.nodes.some((n) => n.owner === PLAYER) || game.fleets.some((f) => f.owner === PLAYER);
    const eAlive = game.nodes.some((n) => n.owner === ENEMY) || game.fleets.some((f) => f.owner === ENEMY);
    if (!eAlive && pAlive) game.winner = PLAYER;
    else if (!pAlive && eAlive) game.winner = ENEMY;
    else if (!pAlive && !eAlive) game.winner = NEUTRAL;

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
      to.garrison = OVERFLOW_WASTE ? Math.min(s.cap, to.garrison + f.count) : to.garrison + f.count;
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
  const DIFFICULTY = [
    { interval: 2.4, margin: 1.30, minGarrison: 10, maxAttackers: 3, send: 0.60, upgrade: false, produce: 0.70 },
    { interval: 1.8, margin: 1.40, minGarrison: 11, maxAttackers: 4, send: 0.70, upgrade: true,  produce: 1.00 },
    { interval: 1.2, margin: 1.50, minGarrison: 12, maxAttackers: 6, send: 0.80, upgrade: true,  produce: 1.75 }
  ];
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

    if (finishingBlow(game, mine)) return;

    // Pick the best target on the whole map, then throw *everything that
    // borders it* at once. Attacking with one node at a time can never
    // beat the defender edge, so an AI that does that simply never takes
    // ground — it has to concentrate for the same reason the player does.
    let best = null;
    for (const tgt of game.nodes) {
      if (tgt.owner === ENEMY) continue;
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
    DEFENDER_EDGE, FLEET_SPEED, MIN_SEND, DIFFICULTY, RATE_BONUS, CAP_BONUS, COALESCE_WINDOW,
    DOOM_CHARGE_NEEDED, DOOM_CHARGE_PER_RELAY, DOOM_CHARGE_INTERVAL, DOOM_DAMAGE,
    DOOM_GARRISON,
    TECH, TECH_MAX, TERRAIN, FLAT_TYPES,
    makeRng, dist, clamp, upgradeCost, nodeStats, defenceOf,
    generateMap, buildLanes, createGame,
    neighbors, areLinked, nodesOf, incoming, income, findPath, aiProduction,
    canTransit, computeSupply, supplyMultiplier, OUT_OF_SUPPLY_RATE,
    terrainOf, terrainDefence,
    sendFleet, upgradeNode, researchTech, fireDoomstar, step,
    serializeState, applySnapshot, applyOrderAs,
    isContested, chargingRelays, doomstarNode, canFire, doomstarTarget, resolveArrival, resolveAssault, drainEvents,
    techLevel, techCost, assaultMult, fortifyMult,
    DOCTRINES, DOCTRINE_KEYS, doctrineOf, docMod, setDoctrine, fleetSpeed,
    relayCharge, strikeDamage,
    ASCENSION, ASCENSION_MAX, ASC_PRODUCE_BONUS, ascensionTech, ascensionProduce
  };
});
