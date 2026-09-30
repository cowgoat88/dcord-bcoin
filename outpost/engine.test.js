// Run with: node --test outpost/engine.test.js
// No dependencies — Node's built-in test runner and assert module.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("./engine.js");

const { PLAYER, ENEMY, NEUTRAL } = E;

function run(game, seconds, dt) {
  const step = dt || 1 / 60;
  for (let t = 0; t < seconds; t += step) E.step(game, step);
}
// A bare game with no AI interference, for testing mechanics in isolation.
function quiet(opts) {
  const g = E.createGame(Object.assign({ seed: 42 }, opts));
  g.ai.timer = Infinity;
  return g;
}
function nodeOf(game, type, owner) {
  return game.nodes.find((n) => n.type === type && (owner === undefined || n.owner === owner));
}

// ---------------------------------------------------------------------
// Map generation
// ---------------------------------------------------------------------
test("every generated map is fully connected", () => {
  // An unreachable pocket reads as a broken game, not a hard map.
  for (let seed = 1; seed <= 40; seed++) {
    const g = E.createGame({ seed });
    for (const n of g.nodes) {
      assert.ok(E.findPath(g, g.nodes[0].id, n.id) || n.id === g.nodes[0].id,
        `seed ${seed}: node ${n.id} is unreachable from node 0`);
    }
  }
});

test("maps are point-symmetric, so neither side gets a better position", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const g = E.createGame({ seed });
    const pairs = g.nodes.filter((n) => n.type !== "doomstar");
    assert.equal(pairs.length % 2, 0, "every node but the Doomstar must be paired");
    const centre = g.nodes.find((n) => n.type === "doomstar");
    assert.ok(Math.abs(centre.x - g.mapW / 2) < 1e-6 && Math.abs(centre.y - g.mapH / 2) < 1e-6,
      "the Doomstar must sit exactly at the centre, equidistant from both sides");
    for (let i = 0; i < pairs.length; i += 2) {
      const a = pairs[i], b = pairs[i + 1];
      assert.equal(a.type, b.type, `seed ${seed}: paired nodes must share a type`);
      assert.ok(Math.abs((a.x + b.x) - g.mapW) < 1e-6, "x coordinates must mirror about the centre");
      assert.ok(Math.abs((a.y + b.y) - g.mapH) < 1e-6, "y coordinates must mirror about the centre");
    }
  }
});

test("each side starts with exactly one command node and nothing else", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const g = E.createGame({ seed });
    assert.equal(E.nodesOf(g, PLAYER).length, 1, `seed ${seed}`);
    assert.equal(E.nodesOf(g, ENEMY).length, 1, `seed ${seed}`);
    assert.equal(E.nodesOf(g, PLAYER)[0].type, "command");
    assert.equal(E.nodesOf(g, ENEMY)[0].type, "command");
  }
});

test("the same seed always produces the same map", () => {
  const a = E.createGame({ seed: 777 }), b = E.createGame({ seed: 777 });
  assert.deepEqual(a.nodes.map((n) => [n.x, n.y, n.type, n.owner]),
                   b.nodes.map((n) => [n.x, n.y, n.type, n.owner]));
  assert.equal(a.lanes.length, b.lanes.length);
});

test("the board adapts to the viewport's shape instead of being letterboxed", () => {
  // A fixed-aspect map squeezed into a portrait phone left the playfield
  // in a thin band with the nodes too small to tap.
  const wide = E.createGame({ seed: 5, mapW: 1200, mapH: 500 });
  const tall = E.createGame({ seed: 5, mapW: 500, mapH: 1200 });
  assert.ok(wide.mapW > wide.mapH, "a wide viewport must produce a wide map");
  assert.ok(tall.mapH > tall.mapW, "a tall viewport must produce a tall map");
  for (const g of [wide, tall]) {
    for (const n of g.nodes) {
      assert.ok(n.x >= 0 && n.x <= g.mapW && n.y >= 0 && n.y <= g.mapH,
        "every node must sit inside the board");
    }
  }
});

test("the two command nodes start far apart in either orientation", () => {
  for (const [w, h] of [[1200, 500], [500, 1200]]) {
    const g = E.createGame({ seed: 9, mapW: w, mapH: h });
    const cmds = g.nodes.filter((n) => n.type === "command");
    const span = Math.max(g.mapW, g.mapH);
    assert.ok(E.dist(cmds[0], cmds[1]) > span * 0.5,
      "starting positions must be separated by most of the board");
  }
});

// ---------------------------------------------------------------------
// Orders
// ---------------------------------------------------------------------
test("sendFleet rejects orders from positions you don't hold", () => {
  const g = quiet();
  const foe = E.nodesOf(g, ENEMY)[0];
  const msg = E.sendFleet(g, foe.id, g.nodes[0].id, 0.5, PLAYER);
  assert.equal(msg, "You don't hold that position.");
  assert.equal(g.fleets.length, 0);
});

test("sendFleet refuses a token force rather than silently sending nothing", () => {
  const g = quiet();
  const hq = E.nodesOf(g, PLAYER)[0];
  hq.garrison = 1;
  const target = E.neighbors(g, hq.id)[0];
  assert.equal(E.sendFleet(g, hq.id, target, 1, PLAYER), "Not enough units to send.");
  assert.equal(g.fleets.length, 0);
  assert.equal(hq.garrison, 1, "a rejected order must not cost units");
});

test("sendFleet deducts the committed units immediately", () => {
  const g = quiet();
  const hq = E.nodesOf(g, PLAYER)[0];
  hq.garrison = 40;
  const target = E.neighbors(g, hq.id)[0];
  assert.equal(E.sendFleet(g, hq.id, target, 0.5, PLAYER), undefined);
  assert.equal(hq.garrison, 20);
  assert.equal(g.fleets.length, 1);
  assert.equal(g.fleets[0].count, 20);
});

test("orders may target any node on the map, routing along the lanes", () => {
  // Restricting orders to a single hop makes concentration geometrically
  // impossible on a sparse graph — front lines are only one or two nodes
  // wide — and the map just freezes. Measured before multi-hop: every
  // single test match ended in stalemate.
  const g = quiet();
  const hq = E.nodesOf(g, PLAYER)[0];
  hq.garrison = 60;
  const far = g.nodes
    .filter((n) => n.id !== hq.id && !E.areLinked(g, hq.id, n.id))
    .sort((a, b) => E.dist(b, hq) - E.dist(a, hq))[0];
  assert.ok(far, "setup: the map must have a non-adjacent node");
  assert.equal(E.sendFleet(g, hq.id, far.id, 0.5, PLAYER), undefined);
  const f = g.fleets[0];
  assert.ok(f.path.length > 2, "a distant order must route through intermediate nodes");
  assert.equal(f.path[0], hq.id);
  assert.equal(f.path[f.path.length - 1], far.id);
});

test("a multi-hop fleet actually traverses every leg and arrives", () => {
  const g = quiet();
  const hq = E.nodesOf(g, PLAYER)[0];
  hq.garrison = 200;
  const far = g.nodes
    .filter((n) => n.id !== hq.id && !E.areLinked(g, hq.id, n.id))
    .sort((a, b) => E.dist(b, hq) - E.dist(a, hq))[0];
  E.sendFleet(g, hq.id, far.id, 1, PLAYER);
  const legs = g.fleets[0].path.length - 1;
  run(g, 90);
  assert.equal(g.fleets.length, 0, "the fleet must not be stuck in transit");
  assert.equal(far.owner, PLAYER, "a large enough force must take the destination");
  assert.ok(legs >= 2, "setup: this must genuinely have been a multi-leg route");
});

// ---------------------------------------------------------------------
// Combat
// ---------------------------------------------------------------------
test("defenders fight above their weight, so an equal attack loses", () => {
  const g = quiet();
  const a = g.nodes[0], b = g.nodes[1];
  a.owner = PLAYER; a.garrison = 40;
  b.owner = ENEMY;  b.garrison = 40;
  // Force adjacency for a controlled one-hop fight.
  g.adjacency.set(a.id, [b.id]); g.adjacency.set(b.id, [a.id]);
  E.sendFleet(g, a.id, b.id, 1, PLAYER);
  run(g, 40);
  assert.equal(b.owner, ENEMY, "40 attackers must not take 40 defenders");
  assert.ok(b.garrison < 40, "but the defenders must take losses");
});

test("a big enough attack captures, and the survivors garrison the node", () => {
  const g = quiet();
  const a = g.nodes[0], b = g.nodes[1];
  a.owner = PLAYER; a.garrison = 100;
  b.owner = ENEMY;  b.garrison = 20; b.level = 2;
  g.adjacency.set(a.id, [b.id]); g.adjacency.set(b.id, [a.id]);
  E.sendFleet(g, a.id, b.id, 1, PLAYER);
  run(g, 40);
  assert.equal(b.owner, PLAYER);
  assert.ok(b.garrison > 0, "survivors must hold the captured node");
  assert.equal(b.level, 0, "capturing must not hand over the previous owner's upgrades");
});

test("neutral positions do not get the defender bonus", () => {
  const g = quiet();
  const a = g.nodes[0], b = g.nodes[1];
  a.owner = PLAYER; a.garrison = 22;
  b.owner = NEUTRAL; b.garrison = 20;
  g.adjacency.set(a.id, [b.id]); g.adjacency.set(b.id, [a.id]);
  assert.equal(E.defenceOf(g, b), 20, "an unheld position defends at face value");
  E.sendFleet(g, a.id, b.id, 1, PLAYER);
  run(g, 40);
  assert.equal(b.owner, PLAYER, "22 must beat a neutral 20");
});

test("fleets converging within the coalesce window fight as one force", () => {
  // This is the mechanic that makes concentration possible. Two attacks
  // that each lose on their own must win together — otherwise they are
  // defeated one at a time however well they are timed, and no amount of
  // coordination can ever break an equal position.
  const g = quiet();
  const a = g.nodes[0], b = g.nodes[1], t = g.nodes[2];
  for (const n of [a, b]) { n.owner = PLAYER; n.garrison = 40; }
  t.owner = ENEMY; t.garrison = 50;
  // Equidistant attackers so both land inside the window.
  a.x = 0; a.y = 0; b.x = 0; b.y = 0; t.x = 100; t.y = 0;
  g.adjacency.set(a.id, [t.id]); g.adjacency.set(b.id, [t.id]);
  g.adjacency.set(t.id, [a.id, b.id]);

  assert.ok(40 < E.defenceOf(g, t), "setup: either attack alone must lose");
  E.sendFleet(g, a.id, t.id, 1, PLAYER);
  E.sendFleet(g, b.id, t.id, 1, PLAYER);
  run(g, 30);
  assert.equal(t.owner, PLAYER, "80 committed together must take a 50-strong position");
});

test("reinforcing your own node adds to it and never flips ownership", () => {
  const g = quiet();
  const a = g.nodes[0], b = g.nodes[1];
  a.owner = PLAYER; a.garrison = 30;
  b.owner = PLAYER; b.garrison = 5; b.level = 2;
  const levelBefore = b.level;
  g.adjacency.set(a.id, [b.id]); g.adjacency.set(b.id, [a.id]);
  E.sendFleet(g, a.id, b.id, 1, PLAYER);
  run(g, 30);
  assert.equal(b.owner, PLAYER);
  assert.ok(b.garrison > 5, "the garrison must grow");
  assert.equal(b.level, levelBefore, "reinforcing must not reset upgrades");
});

// ---------------------------------------------------------------------
// Economy
// ---------------------------------------------------------------------
test("held positions produce units up to their capacity and no further", () => {
  const g = quiet();
  const n = nodeOf(g, "factory");
  n.owner = PLAYER; n.garrison = 0;
  const cap = E.nodeStats(n).cap;
  run(g, 20);
  assert.ok(n.garrison > 0, "a held position must produce");
  run(g, 900);
  assert.ok(n.garrison <= cap + 1e-6, "production must stop at the cap");
  assert.ok(n.garrison >= cap - 1e-6, "and must actually reach it");
});

test("neutral positions produce nothing", () => {
  const g = quiet();
  const n = g.nodes.find((x) => x.owner === NEUTRAL);
  const before = n.garrison;
  run(g, 120);
  assert.equal(n.garrison, before, "unheld ground must not reinforce itself");
});

test("mines pay credits, other positions do not", () => {
  const g = quiet();
  for (const n of g.nodes) n.owner = NEUTRAL;
  const mine = nodeOf(g, "mine");
  mine.owner = PLAYER;
  g.credits[PLAYER] = 0;
  run(g, 60);
  assert.ok(g.credits[PLAYER] > 0, "a held mine must pay out");

  const g2 = quiet();
  for (const n of g2.nodes) n.owner = NEUTRAL;
  nodeOf(g2, "factory").owner = PLAYER;
  g2.credits[PLAYER] = 0;
  run(g2, 60);
  assert.equal(g2.credits[PLAYER], 0, "a factory must not pay credits");
});

test("upgrades raise production far more than capacity", () => {
  // Scaling both together made a level-3 node's defence larger than any
  // force that could ever be fielded, which froze every front permanently.
  const base = E.nodeStats({ type: "factory", level: 0 });
  const top = E.nodeStats({ type: "factory", level: 3 });
  const rateGain = top.unitRate / base.unitRate;
  const capGain = top.cap / base.cap;
  assert.ok(rateGain > 3, "upgrading must be a real economic gain");
  assert.ok(capGain < 2, "but capacity must stay within reach of an attack");
  assert.ok(rateGain > capGain * 1.5, "rate must clearly outscale capacity");
});

test("a fully upgraded position is still takeable by a concentrated attack", () => {
  const top = E.nodeStats({ type: "factory", level: 3 });
  const defence = top.cap * E.DEFENDER_EDGE;
  const threeCommands = E.nodeStats({ type: "command", level: 0 }).cap * 3;
  assert.ok(threeCommands > defence,
    "three full positions must be able to break the strongest single node");
});

test("upgradeNode charges credits and refuses when you cannot pay", () => {
  const g = quiet();
  const n = E.nodesOf(g, PLAYER)[0];
  const cost = E.upgradeCost(n.level);
  g.credits[PLAYER] = cost - 1;
  assert.equal(E.upgradeNode(g, n.id, PLAYER), "Need " + cost + " credits.");
  assert.equal(n.level, 0, "a refused upgrade must not apply");

  g.credits[PLAYER] = cost;
  assert.equal(E.upgradeNode(g, n.id, PLAYER), undefined);
  assert.equal(n.level, 1);
  assert.equal(g.credits[PLAYER], 0, "the cost must be charged");
});

test("upgradeNode refuses positions you don't hold and stops at max level", () => {
  const g = quiet();
  g.credits[PLAYER] = 1e9;
  const foe = E.nodesOf(g, ENEMY)[0];
  assert.equal(E.upgradeNode(g, foe.id, PLAYER), "You don't hold that position.");

  const n = E.nodesOf(g, PLAYER)[0];
  for (let i = 0; i < E.MAX_LEVEL; i++) E.upgradeNode(g, n.id, PLAYER);
  assert.equal(n.level, E.MAX_LEVEL);
  assert.equal(E.upgradeNode(g, n.id, PLAYER), "Already at maximum level.");
});

// ---------------------------------------------------------------------
// Win conditions
// ---------------------------------------------------------------------
test("taking the last enemy position wins, and ends the simulation", () => {
  const g = quiet();
  for (const n of g.nodes) { n.owner = PLAYER; n.assault = null; }
  const last = g.nodes[3];
  last.owner = ENEMY; last.garrison = 1;
  const src = g.nodes.find((n) => n.owner === PLAYER);
  src.garrison = 100;
  g.adjacency.set(src.id, [last.id]); g.adjacency.set(last.id, [src.id]);
  E.sendFleet(g, src.id, last.id, 1, PLAYER);
  run(g, 60);
  assert.equal(g.winner, PLAYER);

  const day = g.time;
  run(g, 10);
  assert.equal(g.time, day, "a finished match must not keep simulating");
  assert.equal(E.sendFleet(g, src.id, last.id, 1, PLAYER), "The battle is over.");
});

test("a side with fleets still in transit is not yet eliminated", () => {
  const g = quiet();
  const a = g.nodes[0], b = g.nodes[1];
  a.owner = PLAYER; a.garrison = 40;
  for (const n of g.nodes) if (n !== a) n.owner = ENEMY;
  b.garrison = 1;
  g.adjacency.set(a.id, [b.id]); g.adjacency.set(b.id, [a.id]);
  E.sendFleet(g, a.id, b.id, 1, PLAYER);
  assert.equal(a.owner, PLAYER);
  a.owner = ENEMY;              // player now holds no nodes, only a fleet
  E.step(g, 1 / 60);
  assert.equal(g.winner, null, "units still in transit must count as alive");
});

// ---------------------------------------------------------------------
// AI
// ---------------------------------------------------------------------
test("the AI expands from its starting position on every difficulty", () => {
  for (let d = 0; d <= 2; d++) {
    const g = E.createGame({ seed: 11, difficulty: d });
    run(g, 240);
    assert.ok(E.nodesOf(g, ENEMY).length > 1,
      `difficulty ${d}: the AI must take ground rather than sit still`);
  }
});

test("the AI concentrates several positions on one target", () => {
  // A single node can never beat an equal one, so an AI that attacks with
  // one at a time never takes ground at all.
  const g = E.createGame({ seed: 4, difficulty: 2 });
  let sawConcentration = false;
  for (let i = 0; i < 60 * 240 && !sawConcentration; i++) {
    E.step(g, 1 / 60);
    const byTarget = new Map();
    for (const f of g.fleets) {
      if (f.owner !== ENEMY) continue;
      byTarget.set(f.to, (byTarget.get(f.to) || 0) + 1);
    }
    for (const count of byTarget.values()) if (count > 1) sawConcentration = true;
  }
  assert.ok(sawConcentration, "the AI must mass multiple forces on a single target");
});

test("matches reach a decision rather than stalling forever", () => {
  // Every match stalemated before multi-hop orders and coalescing existed:
  // once the map was divided, every position sat at capacity and no single
  // attack could ever succeed.
  let decided = 0;
  const seeds = [1, 2, 3, 4, 5, 6];
  for (const seed of seeds) {
    const g = E.createGame({ seed, difficulty: 1 });
    // Both sides played by the same routine, so this measures the game's
    // tendency to resolve rather than either player's skill.
    let acc = 0;
    for (let i = 0; i < 60 * 600 && !g.winner; i++) {
      E.step(g, 1 / 60);
      acc += 1 / 60;
      if (acc >= 1.5) {
        acc = 0;
        let best = null;
        for (const tgt of g.nodes) {
          if (tgt.owner === PLAYER) continue;
          const atk = E.nodesOf(g, PLAYER)
            .filter((s) => s.garrison >= 10 && E.findPath(g, s.id, tgt.id, PLAYER))
            .sort((a, b) => E.dist(a, tgt) - E.dist(b, tgt)).slice(0, 4);
          if (!atk.length) continue;
          const force = atk.reduce((s, n) => s + Math.floor(n.garrison * 0.7), 0);
          if (force <= E.defenceOf(g, tgt) * 1.45 - E.incoming(g, tgt.id, PLAYER)) continue;
          const sc = (E.NODE_TYPES[tgt.type].units * 2) / (E.defenceOf(g, tgt) + 4);
          if (!best || sc > best.sc) best = { sc, tgt, atk };
        }
        if (best) for (const s of best.atk) E.sendFleet(g, s.id, best.tgt.id, 0.7, PLAYER);
      }
      g.events.length = 0;
    }
    if (g.winner) decided++;
  }
  assert.equal(decided, seeds.length, "every match must reach a winner");
});

test("events are drained, so the view never replays the same effect twice", () => {
  const g = quiet();
  const hq = E.nodesOf(g, PLAYER)[0];
  hq.garrison = 40;
  E.sendFleet(g, hq.id, E.neighbors(g, hq.id)[0], 0.5, PLAYER);
  assert.ok(E.drainEvents(g).length > 0, "an order must report something to show");
  assert.equal(E.drainEvents(g).length, 0, "draining must clear the queue");
});

// ---------------------------------------------------------------------
// Progressive research (Assault / Fortify)
// ---------------------------------------------------------------------
test("research costs rise with each level and stop at the cap", () => {
  for (const track of ["assault", "fortify"]) {
    const costs = [0, 1, 2].map((l) => E.techCost(track, l));
    assert.ok(costs.every((c) => c > 0), track + ": every level must have a price");
    assert.ok(costs[1] > costs[0] && costs[2] > costs[1],
      track + ": each level must cost more than the last");
    assert.equal(E.techCost(track, E.TECH_MAX), null, track + ": must cap out");
  }
});

test("researchTech charges credits, applies army-wide, and refuses when broke", () => {
  const g = quiet();
  const cost = E.techCost("assault", 0);
  g.credits[PLAYER] = cost - 1;
  assert.equal(E.researchTech(g, "assault", PLAYER), "Need " + cost + " credits.");
  assert.equal(E.techLevel(g, PLAYER, "assault"), 0);

  g.credits[PLAYER] = cost;
  assert.equal(E.researchTech(g, "assault", PLAYER), undefined);
  assert.equal(E.techLevel(g, PLAYER, "assault"), 1);
  assert.equal(g.credits[PLAYER], 0);
  assert.ok(E.assaultMult(g, PLAYER) > 1, "the bonus must apply immediately");
  assert.equal(E.assaultMult(g, ENEMY), 1, "and must not leak to the opponent");
});

test("research refuses to go past the maximum level", () => {
  const g = quiet();
  g.credits[PLAYER] = 1e9;
  for (let i = 0; i < E.TECH_MAX; i++) E.researchTech(g, "fortify", PLAYER);
  assert.equal(E.techLevel(g, PLAYER, "fortify"), E.TECH_MAX);
  assert.equal(E.researchTech(g, "fortify", PLAYER), "Fortify is fully researched.");
});

test("Assault makes an otherwise-losing attack succeed", () => {
  function fight(assaultLevel) {
    const g = quiet();
    const a = g.nodes[0], b = g.nodes[1];
    a.owner = PLAYER; a.garrison = 50;
    b.owner = ENEMY; b.garrison = 45;
    g.adjacency.set(a.id, [b.id]); g.adjacency.set(b.id, [a.id]);
    g.tech[PLAYER].assault = assaultLevel;
    E.sendFleet(g, a.id, b.id, 1, PLAYER);
    run(g, 40);
    return b.owner;
  }
  assert.equal(fight(0), ENEMY, "50 must not beat 45 defenders behind the defender edge");
  assert.equal(fight(3), PLAYER, "the same attack must succeed with Assault fully researched");
});

test("Fortify makes an otherwise-winning attack fail", () => {
  function fight(fortifyLevel) {
    const g = quiet();
    const a = g.nodes[0], b = g.nodes[1];
    a.owner = PLAYER; a.garrison = 60;
    b.owner = ENEMY; b.garrison = 45;
    g.adjacency.set(a.id, [b.id]); g.adjacency.set(b.id, [a.id]);
    g.tech[ENEMY].fortify = fortifyLevel;
    E.sendFleet(g, a.id, b.id, 1, PLAYER);
    run(g, 40);
    return b.owner;
  }
  assert.equal(fight(0), PLAYER, "60 must beat 45 defenders with no Fortify");
  assert.equal(fight(3), ENEMY, "the same attack must fail against full Fortify");
});

test("equal research leaves the force balance exactly where it started", () => {
  // The property that makes the StarCraft model work: progression moves
  // the numbers without moving the balance.
  const baseline = (() => {
    const g = quiet();
    return E.defenceOf(g, { owner: ENEMY, garrison: 100 }) / E.assaultMult(g, PLAYER);
  })();
  for (let lvl = 1; lvl <= E.TECH_MAX; lvl++) {
    const g = quiet();
    g.tech[PLAYER].assault = lvl; g.tech[ENEMY].fortify = lvl;
    const ratio = E.defenceOf(g, { owner: ENEMY, garrison: 100 }) / E.assaultMult(g, PLAYER);
    // Assault out-scales Fortify on purpose, so parity must not get worse
    // for the attacker as both sides climb the tree.
    assert.ok(ratio <= baseline + 1e-9,
      `level ${lvl}: matched research must never make attacking harder than level 0`);
  }
});

test("Assault out-scales Fortify, so teching offence beats teching defence", () => {
  // Deliberate: defenders already hold a flat x1.25 edge, attacking is
  // mandatory to win, and an un-answerable Fortify would re-freeze the
  // map the way the pre-multi-hop build did.
  const maxAssault = 1 + E.TECH.assault.perLevel * E.TECH_MAX;
  const maxFortify = 1 + E.TECH.fortify.perLevel * E.TECH_MAX;
  assert.ok(maxAssault > maxFortify, "full Assault must beat full Fortify");
});

test("a fully fortified position is still crackable by a concentrated attack", () => {
  // The stalemate guard. Modelling showed a +60% Fortify defender on an
  // L3 Command needed ~9 mid-size positions converging — more than a side
  // ever holds on this map. The cap has to keep the worst case reachable.
  const g = quiet();
  g.tech[ENEMY].fortify = E.TECH_MAX;
  const top = { type: "command", level: 3, owner: ENEMY, garrison: E.nodeStats({ type: "command", level: 3 }).cap };
  const defence = E.defenceOf(g, top);
  const midCap = (E.nodeStats({ type: "factory", level: 0 }).cap +
                  E.nodeStats({ type: "relay", level: 0 }).cap) / 2;
  const positionsNeeded = (assaultLevel) => {
    const per = midCap * 0.75 * (1 + E.TECH.assault.perLevel * assaultLevel);
    return Math.ceil(defence / per);
  };
  // This is the hardest target the game can produce: a maxed, fully
  // fortified Command. It must stay reachable for a side that holds most
  // of a 14-node map, and researching Assault must be a real answer to it.
  assert.ok(positionsNeeded(0) <= 7,
    "the strongest fortified node must fall to 7 mid-size positions even untteched, got " + positionsNeeded(0));
  assert.ok(positionsNeeded(E.TECH_MAX) <= 5,
    "with Assault maxed it must take clearly fewer, got " + positionsNeeded(E.TECH_MAX));
  assert.ok(positionsNeeded(E.TECH_MAX) < positionsNeeded(0),
    "Assault research must be a genuine counter to full Fortify");
});

test("the AI researches on the tiers that are meant to", () => {
  const easy = E.createGame({ seed: 8, difficulty: 0 });
  run(easy, 260);
  assert.equal(E.techLevel(easy, ENEMY, "assault") + E.techLevel(easy, ENEMY, "fortify"), 0,
    "the easiest tier must not research at all");

  const hard = E.createGame({ seed: 8, difficulty: 2 });
  run(hard, 260);
  assert.ok(E.techLevel(hard, ENEMY, "assault") + E.techLevel(hard, ENEMY, "fortify") > 0,
    "the hardest tier must spend credits on research");
});

test("difficulty tiers are ordered: a harder tier out-produces an easier one", () => {
  // The only lever that orders reliably. Decision-quality knobs inverted
  // the tiers twice: a thin attack margin grabs undefended neutrals fast
  // but throws armies at dug-in positions, and early expansion dominates.
  const rates = [0, 1, 2].map((d) => E.aiProduction(E.createGame({ seed: 1, difficulty: d })));
  assert.ok(rates[0] < rates[1] && rates[1] < rates[2],
    "AI production must increase monotonically with difficulty: " + rates.join(" < "));
  assert.equal(rates[1], 1, "the middle tier must be an even fight");
});

test("the AI's production multiplier only touches the AI", () => {
  const g = E.createGame({ seed: 3, difficulty: 2 });
  g.ai.timer = Infinity;
  for (const n of g.nodes) n.owner = NEUTRAL;
  const mine = g.nodes[0], theirs = g.nodes[1];
  mine.type = theirs.type = "factory";
  mine.owner = PLAYER; theirs.owner = ENEMY;
  mine.garrison = theirs.garrison = 0;
  // Each needs a Command behind it or both sit out of supply at a third
  // of output, which hides the very difference under test.
  const myHq = g.nodes[2], theirHq = g.nodes[3];
  myHq.type = theirHq.type = "command";
  myHq.owner = PLAYER; theirHq.owner = ENEMY;
  g.adjacency.set(mine.id, [myHq.id]); g.adjacency.set(myHq.id, [mine.id]);
  g.adjacency.set(theirs.id, [theirHq.id]); g.adjacency.set(theirHq.id, [theirs.id]);
  run(g, 10);
  assert.ok(theirs.garrison > mine.garrison,
    "at the hardest tier the AI must out-produce the player from the same node type");
  const base = E.nodeStats(mine).unitRate * 10;
  assert.ok(Math.abs(mine.garrison - base) < 0.5,
    "the player's own rate must be untouched by the difficulty setting");
});

// ---------------------------------------------------------------------
// The Doomstar objective (what Relays are actually for)
// ---------------------------------------------------------------------
test("every map has exactly one Doomstar, dead centre, reachable by both sides", () => {
  for (let seed = 1; seed <= 15; seed++) {
    const g = E.createGame({ seed });
    const doom = g.nodes.filter((n) => n.type === "doomstar");
    assert.equal(doom.length, 1, `seed ${seed}: exactly one Doomstar`);
    assert.equal(doom[0].owner, NEUTRAL, "it must start unheld");
    assert.ok(E.neighbors(g, doom[0].id).length > 0, "it must be connected to the lane network");
    for (const side of [PLAYER, ENEMY]) {
      const home = E.nodesOf(g, side)[0];
      assert.ok(E.findPath(g, home.id, doom[0].id), `seed ${seed}: ${side} must be able to reach it`);
    }
  }
});

test("held Relays charge the Doomstar; nothing else does", () => {
  // Both sides must keep a node or the match ends instantly and the
  // simulation stops stepping, which silently makes any timing assertion
  // below pass for the wrong reason.
  function bench(holdType) {
    const g = quiet();
    const keepEnemy = E.nodesOf(g, ENEMY)[0];
    for (const n of g.nodes) if (n !== keepEnemy) n.owner = NEUTRAL;
    const held = g.nodes.find((n) => n.type === holdType && n !== keepEnemy);
    held.owner = PLAYER;
    // Supply now gates charging, so the position needs a Command behind
    // it; and nothing adjacent may be enemy-held or contest is the cause.
    const hq = E.nodesOf(g, PLAYER).find((n) => n.type === "command") ||
      g.nodes.find((n) => n !== held && n !== keepEnemy);
    hq.type = "command"; hq.owner = PLAYER;
    g.adjacency.set(held.id, [hq.id]); g.adjacency.set(hq.id, [held.id]);
    for (const id of E.neighbors(g, held.id)) {
      if (g.nodes[id] !== keepEnemy && g.nodes[id] !== hq) g.nodes[id].owner = NEUTRAL;
    }
    g.charge[PLAYER] = 0;
    run(g, E.DOOM_CHARGE_INTERVAL * 3 + 0.2);
    assert.equal(g.winner, null, "setup: the match must still be running");
    return g.charge[PLAYER];
  }
  assert.ok(bench("relay") > 0, "a held Relay must charge the weapon");
  assert.equal(bench("factory"), 0, "a Factory must not charge the weapon");
});

test("a Relay with an enemy neighbour is contested and stops charging", () => {
  // This is what stops charging being free once you have grabbed a corner.
  const g = quiet();
  const keepEnemy = E.nodesOf(g, ENEMY)[0];
  for (const n of g.nodes) if (n !== keepEnemy) n.owner = NEUTRAL;
  const relay = g.nodes.find((n) => n.type === "relay" &&
    E.neighbors(g, n.id).every((id) => g.nodes[id] !== keepEnemy));
  relay.owner = PLAYER;
  assert.equal(E.isContested(g, relay), false);
  assert.equal(E.chargingRelays(g, PLAYER).length, 1);

  g.nodes[E.neighbors(g, relay.id)[0]].owner = ENEMY;
  assert.equal(E.isContested(g, relay), true, "an enemy-held neighbour must contest it");
  assert.equal(E.chargingRelays(g, PLAYER).length, 0);

  g.charge[PLAYER] = 0;
  run(g, E.DOOM_CHARGE_INTERVAL * 3 + 0.2);
  assert.equal(g.charge[PLAYER], 0, "a contested Relay must not charge");
});

test("firing needs both a full charge and the centre", () => {
  const g = quiet();
  const doom = E.doomstarNode(g);
  g.charge[PLAYER] = E.DOOM_CHARGE_NEEDED;
  doom.owner = ENEMY;
  assert.equal(E.fireDoomstar(g, PLAYER), "You must hold the Doomstar to fire it.");

  doom.owner = PLAYER;
  g.charge[PLAYER] = E.DOOM_CHARGE_NEEDED - 1;
  assert.ok(/^Charge /.test(E.fireDoomstar(g, PLAYER)), "an undercharged weapon must refuse");
  assert.equal(E.canFire(g, PLAYER), false);

  g.charge[PLAYER] = E.DOOM_CHARGE_NEEDED;
  assert.equal(E.canFire(g, PLAYER), true);
});

test("the strike hits the enemy's largest position and spends the charge", () => {
  const g = quiet();
  E.doomstarNode(g).owner = PLAYER;
  g.charge[PLAYER] = E.DOOM_CHARGE_NEEDED;
  const foes = g.nodes.filter((n) => n.id !== E.doomstarNode(g).id);
  foes[0].owner = ENEMY; foes[0].garrison = 20;
  foes[1].owner = ENEMY; foes[1].garrison = 60;   // the biggest
  assert.equal(E.doomstarTarget(g, PLAYER).id, foes[1].id);

  assert.equal(E.fireDoomstar(g, PLAYER), undefined);
  assert.equal(g.charge[PLAYER], 0, "firing must spend the whole charge");
  assert.equal(Math.round(foes[1].garrison), 60 - E.DOOM_DAMAGE);
  assert.equal(foes[0].garrison, 20, "other positions must be untouched");
});

test("a strike that empties a position abandons it rather than capturing it", () => {
  const g = quiet();
  E.doomstarNode(g).owner = PLAYER;
  g.charge[PLAYER] = E.DOOM_CHARGE_NEEDED;
  const victim = g.nodes.find((n) => n.type !== "doomstar");
  for (const n of g.nodes) if (n !== victim && n.type !== "doomstar") n.owner = NEUTRAL;
  victim.owner = ENEMY; victim.garrison = 5; victim.level = 2;
  E.fireDoomstar(g, PLAYER);
  assert.equal(victim.owner, NEUTRAL, "a wiped position goes neutral, not to the attacker");
  assert.equal(victim.garrison, 0);
  assert.equal(victim.level, 0);
});

test("Command clearly out-produces a Factory", () => {
  // The owner's note: the main base should matter more than a satellite.
  const cmd = E.nodeStats({ type: "command", level: 0 }).unitRate;
  const fac = E.nodeStats({ type: "factory", level: 0 }).unitRate;
  assert.ok(cmd > fac * 1.6, `Command ${cmd}/s must clearly beat Factory ${fac}/s`);
  assert.ok(E.nodeStats({ type: "command", level: 0 }).cap >
            E.nodeStats({ type: "factory", level: 0 }).cap);
});

test("the AI fires the Doomstar once it can", () => {
  const g = E.createGame({ seed: 5, difficulty: 2 });
  E.doomstarNode(g).owner = ENEMY;
  for (const n of g.nodes) if (n.type === "relay") n.owner = ENEMY;
  const victim = g.nodes.find((n) => n.owner === PLAYER);
  victim.garrison = 60;
  let fired = false;
  for (let i = 0; i < 60 * 120 && !fired; i++) {
    E.step(g, 1 / 60);
    if (E.drainEvents(g).some((e) => e.kind === "doomstar")) fired = true;
  }
  assert.ok(fired, "the AI must use the weapon rather than sitting on a full charge");
});

// ---------------------------------------------------------------------
// Supply network: routing through enemy ground, and being cut off
// ---------------------------------------------------------------------
test("fleets cannot transit an enemy-held position", () => {
  // Before this, every route was always open regardless of who held the
  // ground between, so there was no such thing as a chokepoint or a flank.
  const g = quiet();
  // A deliberate chain A - B - C with no other link between A and C.
  const [a, b, c] = g.nodes;
  g.adjacency.set(a.id, [b.id]);
  g.adjacency.set(b.id, [a.id, c.id]);
  g.adjacency.set(c.id, [b.id]);
  for (const n of g.nodes) if (![a, b, c].includes(n)) g.adjacency.set(n.id, []);
  a.owner = PLAYER; b.owner = NEUTRAL; c.owner = NEUTRAL;

  assert.ok(E.findPath(g, a.id, c.id, PLAYER), "neutral ground in between is passable");
  b.owner = ENEMY;
  assert.equal(E.findPath(g, a.id, c.id, PLAYER), null,
    "an enemy position in the way must block the route entirely");
  assert.ok(E.findPath(g, a.id, b.id, PLAYER),
    "but the blocker itself must still be attackable — it is the destination");
  b.owner = PLAYER;
  assert.ok(E.findPath(g, a.id, c.id, PLAYER), "your own ground carries traffic");
});

test("an order with no route is refused and costs nothing", () => {
  const g = quiet();
  const [a, b, c] = g.nodes;
  g.adjacency.set(a.id, [b.id]);
  g.adjacency.set(b.id, [a.id, c.id]);
  g.adjacency.set(c.id, [b.id]);
  for (const n of g.nodes) if (![a, b, c].includes(n)) g.adjacency.set(n.id, []);
  a.owner = PLAYER; a.garrison = 40;
  b.owner = ENEMY; c.owner = ENEMY;
  const msg = E.sendFleet(g, a.id, c.id, 0.5, PLAYER);
  assert.match(msg, /No route/);
  assert.equal(a.garrison, 40, "a refused order must not spend units");
  assert.equal(g.fleets.length, 0);
});

test("a position cut off from your Command falls out of supply", () => {
  const g = quiet();
  const hq = E.nodesOf(g, PLAYER)[0];
  const mid = g.nodes[E.neighbors(g, hq.id)[0]];
  // Find something reachable only through `mid`, by cutting the graph down
  // to a simple chain.
  const far = g.nodes.find((n) => n !== hq && n !== mid);
  g.adjacency.set(hq.id, [mid.id]);
  g.adjacency.set(mid.id, [hq.id, far.id]);
  g.adjacency.set(far.id, [mid.id]);
  for (const n of g.nodes) if (![hq, mid, far].includes(n)) g.adjacency.set(n.id, []);

  mid.owner = PLAYER; far.owner = PLAYER;
  E.computeSupply(g);
  assert.equal(far.inSupply, true, "a connected chain is in supply");
  assert.equal(E.supplyMultiplier(far), 1);

  mid.owner = ENEMY;                       // sever the chain
  E.computeSupply(g);
  assert.equal(far.inSupply, false, "cutting the chain must isolate what is beyond it");
  assert.equal(E.supplyMultiplier(far), E.OUT_OF_SUPPLY_RATE);
});

test("an out-of-supply position produces far less", () => {
  function output(cut) {
    const g = quiet();
    const keepEnemy = E.nodesOf(g, ENEMY)[0];
    const hq = E.nodesOf(g, PLAYER)[0];
    const far = g.nodes.find((n) => n !== hq && n !== keepEnemy && n.type === "factory");
    for (const n of g.nodes) if (n !== keepEnemy && n !== hq) n.owner = NEUTRAL;
    far.owner = PLAYER; far.garrison = 0;
    // Wire it either onto the Command's chain or off on its own.
    g.adjacency.set(far.id, cut ? [] : [hq.id]);
    g.adjacency.set(hq.id, cut ? [] : [far.id]);
    E.computeSupply(g);
    run(g, 20);
    return far.garrison;
  }
  const connected = output(false), isolated = output(true);
  assert.ok(connected > 0, "a supplied position must produce");
  assert.ok(isolated < connected * 0.5,
    `an isolated position must produce much less (${isolated.toFixed(1)} vs ${connected.toFixed(1)})`);
});

test("a cut-off Relay stops charging the Doomstar", () => {
  const g = quiet();
  const keepEnemy = E.nodesOf(g, ENEMY)[0];
  const relay = g.nodes.find((n) => n.type === "relay" && n !== keepEnemy);
  for (const n of g.nodes) if (n !== keepEnemy) n.owner = NEUTRAL;
  relay.owner = PLAYER;
  g.adjacency.set(relay.id, []);            // severed from any Command
  E.computeSupply(g);
  assert.equal(relay.inSupply, false, "setup: the Relay must be isolated");
  assert.equal(E.chargingRelays(g, PLAYER).length, 0,
    "an isolated Relay must not feed the weapon");
});

test("neutral ground never counts as out of supply", () => {
  const g = quiet();
  E.computeSupply(g);
  for (const n of g.nodes) {
    if (n.owner === NEUTRAL) {
      assert.notEqual(n.inSupply, false, "unheld ground has no supply state to lose");
    }
  }
});
