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
    for (let i = 0; i < g.nodes.length; i += 2) {
      const a = g.nodes[i], b = g.nodes[i + 1];
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
  assert.equal(E.defenceOf(b), 20, "an unheld position defends at face value");
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

  assert.ok(40 < E.defenceOf(t), "setup: either attack alone must lose");
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
            .filter((s) => s.garrison >= 10 && E.findPath(g, s.id, tgt.id))
            .sort((a, b) => E.dist(a, tgt) - E.dist(b, tgt)).slice(0, 4);
          if (!atk.length) continue;
          const force = atk.reduce((s, n) => s + Math.floor(n.garrison * 0.7), 0);
          if (force <= E.defenceOf(tgt) * 1.45 - E.incoming(g, tgt.id, PLAYER)) continue;
          const sc = (E.NODE_TYPES[tgt.type].units * 2) / (E.defenceOf(tgt) + 4);
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
