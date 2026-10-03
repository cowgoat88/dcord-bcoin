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

// Lane drawing: planar, well separated, symmetric. Shapes are the boards
// the page would produce for a phone in portrait and a desktop window.
const LANE_SHAPES = [["portrait", 390 / 844], ["landscape", 1280 / 800]].map(([name, asp]) => ({
  name, mapW: Math.sqrt(1000 * 640 * asp), mapH: Math.sqrt(1000 * 640 / asp)
}));
function laneMaps(seeds) {
  const out = [];
  for (const sh of LANE_SHAPES) {
    for (let seed = 1; seed <= seeds; seed++) {
      out.push({ label: `${sh.name} seed ${seed}`, g: E.createGame({ seed, mapW: sh.mapW, mapH: sh.mapH }) });
    }
  }
  return out;
}
function segPoint(a, b, p) {
  const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
  const t = Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2));
  return Math.hypot(a.x + t * dx - p.x, a.y + t * dy - p.y);
}
const orient = (a, b, c) => (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
const properCross = (a, b, c, d) =>
  orient(a, b, c) * orient(a, b, d) < 0 && orient(c, d, a) * orient(c, d, b) < 0;

test("generated lanes never cross each other", () => {
  for (const { label, g } of laneMaps(40)) {
    for (let i = 0; i < g.lanes.length; i++) for (let j = i + 1; j < g.lanes.length; j++) {
      const p = g.lanes[i], q = g.lanes[j];
      if (p.a === q.a || p.a === q.b || p.b === q.a || p.b === q.b) continue;
      assert.ok(!properCross(g.nodes[p.a], g.nodes[p.b], g.nodes[q.a], g.nodes[q.b]),
        `${label}: lanes ${p.a}-${p.b} and ${q.a}-${q.b} cross`);
    }
  }
});

test("lanes leaving a node are at least 28 degrees apart", () => {
  for (const { label, g } of laneMaps(40)) {
    for (const v of g.nodes) {
      const dirs = g.lanes.filter((l) => l.a === v.id || l.b === v.id).map((l) => {
        const o = g.nodes[l.a === v.id ? l.b : l.a];
        return Math.atan2(o.y - v.y, o.x - v.x);
      });
      for (let i = 0; i < dirs.length; i++) for (let j = i + 1; j < dirs.length; j++) {
        let d = Math.abs(dirs[i] - dirs[j]);
        if (d > Math.PI) d = 2 * Math.PI - d;
        assert.ok(d * 180 / Math.PI >= 28 - 1e-6, `${label}: node ${v.id} has two lanes ${(d * 180 / Math.PI).toFixed(1)} degrees apart`);
      }
    }
  }
});

test("no lane passes through or beside a node that is not one of its ends", () => {
  for (const { label, g } of laneMaps(40)) {
    for (const l of g.lanes) for (const m of g.nodes) {
      if (m.id === l.a || m.id === l.b) continue;
      const gap = segPoint(g.nodes[l.a], g.nodes[l.b], m) - E.NODE_TYPES[m.type].radius;
      assert.ok(gap >= 18, `${label}: lane ${l.a}-${l.b} passes ${gap.toFixed(1)} units from node ${m.id}'s edge`);
    }
  }
});

test("lanes are point-symmetric and every generated board stays connected", () => {
  for (const { label, g } of laneMaps(40)) {
    const twin = (id) => {
      const n = g.nodes[id];
      return g.nodes.find((m) => Math.abs(m.x - (g.mapW - n.x)) < 1e-6 && Math.abs(m.y - (g.mapH - n.y)) < 1e-6).id;
    };
    const keys = new Set(g.lanes.map((l) => Math.min(l.a, l.b) + ":" + Math.max(l.a, l.b)));
    assert.equal(keys.size, g.lanes.length, `${label}: duplicate lane`);
    for (const l of g.lanes) {
      const a = twin(l.a), b = twin(l.b);
      assert.ok(keys.has(Math.min(a, b) + ":" + Math.max(a, b)), `${label}: lane ${l.a}-${l.b} has no mirror`);
    }
    for (const n of g.nodes) {
      assert.ok(n.id === 0 || E.findPath(g, 0, n.id), `${label}: node ${n.id} unreachable`);
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
  //
  // The route has to run over ground you hold, so this hands the player
  // a corridor first; reaching across unclaimed space is exactly what
  // `canTransit` now refuses.
  const g = quiet();
  const hq = E.nodesOf(g, PLAYER)[0];
  hq.garrison = 60;
  const far = g.nodes
    .filter((n) => n.id !== hq.id && !E.areLinked(g, hq.id, n.id))
    .sort((a, b) => E.dist(b, hq) - E.dist(a, hq))[0];
  assert.ok(far, "setup: the map must have a non-adjacent node");
  const corridor = E.findPath(g, hq.id, far.id, undefined);
  assert.ok(corridor && corridor.length > 2, "setup: a multi-hop corridor must exist");
  for (const id of corridor.slice(1, -1)) g.nodes[id].owner = PLAYER;
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
  for (const id of E.findPath(g, hq.id, far.id, undefined).slice(1, -1)) {
    g.nodes[id].owner = PLAYER;
  }
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

test("holding ground pays, and Mines pay far the best", () => {
  // Every position earns something: a side that earns only from Mines
  // finished an average match with 12 credits against a 90-credit
  // research level, which made the whole spend system decoration.
  function earned(type) {
    const g = quiet();
    // Keep both Commands held: strip the enemy of everything and the
    // match ends on the first tick, and strip your own Command and the
    // position is out of supply. Either way it earns nothing and the
    // measurement is of the fixture, not the rule.
    for (const n of g.nodes) if (n.type !== "command") n.owner = NEUTRAL;
    const home = g.nodes.find((n) => n.type === "command" && n.owner === PLAYER);
    const subject = g.nodes.find((n) => n.type === type && n.owner === NEUTRAL)
      || nodeOf(g, type);
    subject.owner = PLAYER;
    g.credits[PLAYER] = 0;
    const before = E.income(g, PLAYER).credits - E.nodeStats(home, g).creditRate;
    run(g, 60);
    // Count only what the position under test contributed.
    return before * 60;
  }
  const mine = earned("mine"), factory = earned("factory"), relay = earned("relay");
  assert.ok(factory > 0, "a held Factory must pay something");
  assert.ok(relay > 0, "a held Relay must pay something");
  assert.ok(mine > factory * 2, "a Mine must still be clearly the credit node");

  // And a minute of holding one ordinary position must be worth having.
  assert.ok(factory > 10, "holding ground for a minute has to move the needle, got " + factory);
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
  // The player has to hold enough of the map that the match is still
  // running at the end. Against an idle opponent the AI now closes a
  // game in about 90 seconds, before it has ever banked the 90 credits
  // Assault I costs — so an idle fixture measures nothing.
  function contested(diff) {
    const g = E.createGame({ seed: 8, difficulty: diff });
    for (const n of g.nodes) {
      if (n.type !== "doomstar" && n.owner === NEUTRAL && n.id % 2 === 0) n.owner = PLAYER;
    }
    for (const n of E.nodesOf(g, PLAYER)) n.garrison = E.nodeStats(n).cap;
    run(g, 260);
    return E.techLevel(g, ENEMY, "assault") + E.techLevel(g, ENEMY, "fortify");
  }
  assert.equal(contested(0), 0, "the easiest tier must not research at all");
  assert.ok(contested(2) > 0, "the hardest tier must spend credits on research");
});

test("difficulty tiers are ordered: a harder tier out-produces an easier one", () => {
  // The only lever that orders reliably. Decision-quality knobs inverted
  // the tiers twice: a thin attack margin grabs undefended neutrals fast
  // but throws armies at dug-in positions, and early expansion dominates.
  const rates = [0, 1, 2, 3].map((d) => E.aiProduction(E.createGame({ seed: 1, difficulty: d })));
  for (let i = 1; i < rates.length; i++) {
    assert.ok(rates[i - 1] < rates[i],
      "AI production must increase monotonically with difficulty: " + rates.join(" < "));
  }
  // The band is narrow and it is meant to be: once transit through
  // neutral ground closed, the measured swing from 0.80 to 1.00 at
  // Officer was 3% to 63%.
  assert.ok(rates[1] > 0.85 && rates[1] < 1.05, "the middle tier must be close to an even fight");
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
  const base = E.nodeStats(mine).unitRate * 10;
  assert.ok(Math.abs(mine.garrison - base) < 0.5,
    "the player's own rate must be untouched by the difficulty setting");
  // Their own rate, not the player's: the opponent's doctrine is drawn
  // from the map seed and may scale output on its own.
  const theirBase = E.nodeStats(theirs, g).unitRate * 10;
  assert.ok(Math.abs(theirs.garrison - theirBase * E.aiProduction(g)) < 0.5,
    "the AI's output must be its own rate times the tier multiplier");
  assert.notEqual(E.aiProduction(g), 1, "setup: this tier must differ from the player's rate");
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

test("a Relay charges under fire, as long as it is still supplied", () => {
  // The old rule also required no enemy-held neighbour, and that was too
  // strict ever to come up: Relays sit on the front, so a quiet
  // neighbourhood mostly meant the match was already decided. Supply is
  // the condition now.
  const g = quiet();
  const home = g.nodes.find((n) => n.type === "command" && n.owner === PLAYER);
  const relay = g.nodes.find((n) => n.type === "relay");
  relay.owner = PLAYER;
  // Hand it a chain back to a Command of ours so it is genuinely supplied.
  for (const id of E.findPath(g, home.id, relay.id, PLAYER) || []) g.nodes[id].owner = PLAYER;
  E.computeSupply(g);
  assert.equal(relay.inSupply, true, "setup: the Relay must be supplied");
  assert.equal(E.relayCharge(g, relay), 1);

  // Put the enemy right next door. It must keep charging.
  const nb = E.neighbors(g, relay.id).map((id) => g.nodes[id])
    .find((n) => n.type !== "command");
  nb.owner = ENEMY;
  E.computeSupply(g);
  assert.equal(E.isContested(g, relay), true, "setup: it is now on the front line");
  assert.equal(E.relayCharge(g, relay), 1, "pressure next door must not stop the charge");

  g.charge[PLAYER] = 0;
  run(g, E.DOOM_CHARGE_INTERVAL * 3 + 0.2);
  assert.ok(g.charge[PLAYER] > 0, "a contested but supplied Relay must still charge");
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

test("an aimed strike hits the position you picked, not the biggest", () => {
  const g = quiet();
  E.doomstarNode(g).owner = PLAYER;
  g.charge[PLAYER] = E.DOOM_CHARGE_NEEDED;
  const foes = g.nodes.filter((n) => n.id !== E.doomstarNode(g).id);
  foes[0].owner = ENEMY; foes[0].garrison = 30;   // the one we want gone
  foes[1].owner = ENEMY; foes[1].garrison = 60;   // the automatic choice
  foes[2].owner = NEUTRAL;

  assert.equal(E.fireDoomstar(g, PLAYER, foes[0].id), undefined);
  assert.equal(Math.round(foes[0].garrison), 30 - E.DOOM_DAMAGE);
  assert.equal(foes[1].garrison, 60, "the automatic target must be spared");
});

test("aiming refuses your own ground, neutral ground and nonsense", () => {
  const g = quiet();
  E.doomstarNode(g).owner = PLAYER;
  g.charge[PLAYER] = E.DOOM_CHARGE_NEEDED;
  const foes = g.nodes.filter((n) => n.id !== E.doomstarNode(g).id);
  foes[0].owner = PLAYER; foes[0].garrison = 10;
  foes[1].owner = NEUTRAL;
  foes[2].owner = ENEMY; foes[2].garrison = 40;

  assert.match(E.fireDoomstar(g, PLAYER, foes[0].id), /your own/);
  assert.match(E.fireDoomstar(g, PLAYER, foes[1].id), /enemy position/);
  assert.match(E.fireDoomstar(g, PLAYER, 9999), /No such position/);
  assert.equal(g.charge[PLAYER], E.DOOM_CHARGE_NEEDED,
    "a refused strike must not spend the charge");
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
  // The player must hold enough ground that the AI cannot simply win
  // before the weapon ever charges — it closes out a one-sided game in
  // about 90 seconds now.
  for (const n of g.nodes) {
    if (n.owner === NEUTRAL && n.type !== "doomstar" && n.id % 2 === 0) n.owner = PLAYER;
  }
  for (const n of E.nodesOf(g, PLAYER)) n.garrison = E.nodeStats(n).cap;
  const victim = E.nodesOf(g, PLAYER)[0];
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

  assert.equal(E.findPath(g, a.id, c.id, PLAYER), null,
    "unclaimed ground in between does NOT carry traffic");
  assert.ok(E.findPath(g, a.id, b.id, PLAYER),
    "but it is attackable — it is the destination, not a waypoint");
  b.owner = ENEMY;
  assert.equal(E.findPath(g, a.id, c.id, PLAYER), null,
    "an enemy position in the way must block the route entirely");
  assert.ok(E.findPath(g, a.id, b.id, PLAYER),
    "but the blocker itself must still be attackable — it is the destination");
  b.owner = PLAYER;
  assert.ok(E.findPath(g, a.id, c.id, PLAYER), "your own ground carries traffic");
});

test("neither side can reach the other's Command on the opening tick", () => {
  // The exploit this rule exists for: hold everything, wait for the AI's
  // first push to leave, then send 75% of every position straight at its
  // Command. It won 100/98/87/43% of matches across the four tiers and
  // was over inside thirty seconds, because no-man's-land carried the
  // whole trip. With transit closed the route simply does not exist
  // until ground between has been taken.
  for (let seed = 1; seed <= 30; seed++) {
    const g = E.createGame({ seed });
    const mine = E.nodesOf(g, PLAYER)[0], theirs = E.nodesOf(g, ENEMY)[0];
    assert.ok(!E.areLinked(g, mine.id, theirs.id), "setup: the homes are not adjacent");
    assert.equal(E.findPath(g, mine.id, theirs.id, PLAYER), null,
      "seed " + seed + ": their Command must not be reachable from the start");
    assert.equal(E.findPath(g, theirs.id, mine.id, ENEMY), null,
      "seed " + seed + ": and the rule has to cut both ways");
  }
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

// ---------------------------------------------------------------------
// Terrain
// ---------------------------------------------------------------------
test("terrain is mirrored, so neither side gets easier space", () => {
  for (let seed = 1; seed <= 20; seed++) {
    const g = E.createGame({ seed });
    const pairs = g.nodes.filter((n) => n.type !== "doomstar");
    for (let i = 0; i < pairs.length; i += 2) {
      assert.equal(E.terrainOf(pairs[i]), E.terrainOf(pairs[i + 1]),
        `seed ${seed}: mirrored positions must sit in the same kind of space`);
    }
  }
});

test("Command and the Doomstar always sit in open space", () => {
  // Stacking highland on top of the defender edge, Fortify and a level-3
  // upgrade would push the biggest positions past what any realistic
  // concentration can crack — which is how the original stalemate began.
  for (let seed = 1; seed <= 20; seed++) {
    const g = E.createGame({ seed });
    for (const n of g.nodes) {
      if (E.FLAT_TYPES.indexOf(n.type) !== -1) {
        assert.equal(E.terrainOf(n), "open", `seed ${seed}: ${n.type} must be in open space`);
      }
    }
  }
});

test("every map offers a mix of space, not one uniform type", () => {
  let sawHigh = 0, sawMarsh = 0;
  for (let seed = 1; seed <= 20; seed++) {
    const g = E.createGame({ seed });
    const kinds = new Set(g.nodes.map(E.terrainOf));
    if (kinds.has("asteroid")) sawHigh++;
    if (kinds.has("well")) sawMarsh++;
  }
  assert.ok(sawHigh >= 15, "most maps should contain asteroid cover, got " + sawHigh + "/20");
  assert.ok(sawMarsh >= 15, "most maps should contain gravity wells, got " + sawMarsh + "/20");
});

test("terrain changes how hard a position is to take", () => {
  const g = quiet();
  const base = { owner: PLAYER, garrison: 40, terrain: "open" };
  const high = { owner: PLAYER, garrison: 40, terrain: "asteroid" };
  const soft = { owner: PLAYER, garrison: 40, terrain: "well" };
  assert.ok(E.defenceOf(g, high) > E.defenceOf(g, base), "asteroid cover must defend better");
  assert.ok(E.defenceOf(g, soft) < E.defenceOf(g, base), "a gravity well must defend worse");
  // It applies to unheld space too — a gravity well pins anyone in it.
  const wildHigh = { owner: NEUTRAL, garrison: 40, terrain: "asteroid" };
  const wildOpen = { owner: NEUTRAL, garrison: 40, terrain: "open" };
  assert.ok(E.defenceOf(g, wildHigh) > E.defenceOf(g, wildOpen));
});

test("the same attack takes a position in a gravity well but fails in an asteroid belt", () => {
  function fight(terrain) {
    const g = quiet();
    const a = g.nodes[0], b = g.nodes[1];
    a.owner = PLAYER; a.garrison = 62; a.terrain = "open";
    b.owner = ENEMY; b.garrison = 45; b.terrain = terrain;
    g.adjacency.set(a.id, [b.id]); g.adjacency.set(b.id, [a.id]);
    E.sendFleet(g, a.id, b.id, 1, PLAYER);
    run(g, 40);
    return b.owner;
  }
  assert.equal(fight("well"), PLAYER, "62 must take 45 defenders pinned in a gravity well");
  assert.equal(fight("asteroid"), ENEMY, "the same 62 must fail against 45 in an asteroid belt");
});

test("even the strongest terrain stays crackable by a concentrated attack", () => {
  const g = quiet();
  g.tech[ENEMY].fortify = E.TECH_MAX;
  const worst = {
    type: "factory", level: 3, owner: ENEMY, terrain: "asteroid",
    garrison: E.nodeStats({ type: "factory", level: 3 }).cap
  };
  const defence = E.defenceOf(g, worst);
  const midCap = (E.nodeStats({ type: "factory", level: 0 }).cap +
                  E.nodeStats({ type: "relay", level: 0 }).cap) / 2;
  assert.ok(midCap * 0.75 * 7 > defence,
    "seven mid-size positions must break the worst case, got " + defence.toFixed(0));
  assert.ok(midCap * 0.75 * 5 * (1 + E.TECH.assault.perLevel * E.TECH_MAX) > defence,
    "five must do it with Assault maxed");
});

test("a cautious AI still closes out a game it has already won", () => {
  // Regression for a real stall: capped at two attackers committing 55%,
  // the easiest tier tops out near 49 units against a capped Command's
  // 87.5 defence, so it could hold 14 positions to the player's 1 and
  // never take the last one. Measured before the fix: 5 of 40 idle
  // matches never resolved, leaving a new player with no ending.
  let stalls = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const g = E.createGame({ seed, difficulty: 0 });
    let t = 0;
    while (!g.winner && t < 900) { E.step(g, 1 / 30); t += 1 / 30; g.events.length = 0; }
    if (!g.winner) stalls++;
  }
  assert.equal(stalls, 0, "every idle match must reach an ending");
});

test("the endgame push is an endgame, not an opening rush", () => {
  // Both sides start on exactly one position, so "the opponent is down to
  // one node" is also true at kick-off. Without a dominance check the AI
  // opened every game by hurling its whole garrison at the enemy Command.
  // Sampled across the whole opening, not at one instant, so a rush that
  // launched and landed between checks cannot slip through.
  for (const seed of [1, 4, 9]) {
    const g = E.createGame({ seed, difficulty: 2 });
    let rushed = false;
    for (let i = 0; i < 60 * 20; i++) {
      E.step(g, 1 / 60);
      if (g.fleets.some((f) => f.owner === ENEMY &&
          g.nodes[f.to].type === "command" && g.nodes[f.to].owner === PLAYER)) {
        rushed = true; break;
      }
      g.events.length = 0;
    }
    assert.equal(rushed, false,
      `seed ${seed}: the AI must not throw itself at the enemy Command in the opening`);
  }
});

// ---------------------------------------------------------------------
// Doctrines
// ---------------------------------------------------------------------

test("every doctrine only uses modifier keys the engine knows about", () => {
  const known = ["speed", "cap", "units", "relayUnits", "credits", "attack",
                 "defence", "research", "doom", "chargeRate", "cutoff",
                 "contestedCharge"];
  for (const key of E.DOCTRINE_KEYS) {
    const d = E.DOCTRINES[key];
    assert.ok(d.label && d.up, key + " needs a label and something to say for itself");
    assert.ok(!Object.keys(d.mods).length || d.down,
      key + " changes the rules, so it must spell out the cost");
    for (const mod of Object.keys(d.mods)) {
      assert.ok(known.indexOf(mod) !== -1, key + " uses unknown modifier " + mod);
    }
  }
});

test("every doctrine is a trade, never a straight upgrade", () => {
  // "Standard" is the one with nothing on either side of the ledger.
  for (const key of E.DOCTRINE_KEYS) {
    if (key === "standard") continue;
    const mods = E.DOCTRINES[key].mods;
    const keys = Object.keys(mods);
    assert.ok(keys.length >= 2, key + " must give something up");
    // At least one modifier must be worse than the baseline. "cutoff" and
    // "contestedCharge" are floors rather than multipliers, so higher is
    // better for those two as well.
    const higherIsBetter = ["cutoff", "contestedCharge", "chargeRate", "relayUnits"];
    const worse = keys.some((k) => mods[k] < 1 && higherIsBetter.indexOf(k) === -1);
    assert.ok(worse, key + " has no cost");
  }
});

test("an unknown doctrine is treated as Standard, never as a hole in the rules", () => {
  const g = E.createGame({ seed: 5, doctrine: "cheatmode", foeDoctrine: "standard" });
  assert.equal(E.doctrineOf(g, PLAYER), "standard");
  assert.equal(E.docMod(g, PLAYER, "attack"), 1);
  E.setDoctrine(g, PLAYER, "nonsense");
  assert.equal(E.doctrineOf(g, PLAYER), "standard");
  E.setDoctrine(g, PLAYER, "shock");
  assert.equal(E.doctrineOf(g, PLAYER), "shock");
  E.setDoctrine(g, NEUTRAL, "shock");          // not a seat; must be ignored
  assert.equal(E.doctrineOf(g, PLAYER), "shock");
});

test("Vanguard arrives first and hits softer for it", () => {
  const fast = E.createGame({ seed: 8, doctrine: "vanguard", foeDoctrine: "standard" });
  const slow = E.createGame({ seed: 8, doctrine: "standard", foeDoctrine: "standard" });
  assert.ok(E.fleetSpeed(fast, PLAYER) > E.fleetSpeed(slow, PLAYER) * 1.2,
    "the speed edge has to be big enough to change when you arrive");
  const home = fast.nodes.find((n) => n.owner === PLAYER);
  const slowHome = slow.nodes.find((n) => n.owner === PLAYER);
  assert.ok(E.nodeStats(home, fast).unitRate < E.nodeStats(slowHome, slow).unitRate,
    "and it is paid for");

  // A fleet on the same route really does land sooner.
  function trip(g) {
    const from = g.nodes.find((n) => n.owner === PLAYER);
    from.garrison = 40;
    const to = g.nodes[E.neighbors(g, from.id)[0]];
    assert.equal(E.sendFleet(g, from.id, to.id, 0.5, PLAYER), undefined);
    return g.fleets[0].duration;
  }
  assert.ok(trip(fast) < trip(slow), "the same hop must take less time");
});

test("Deep Logistics keeps a severed position working", () => {
  function output(doctrine) {
    const g = E.createGame({ seed: 8, doctrine, foeDoctrine: "standard" });
    g.ai.timer = Infinity;
    const n = g.nodes.find((x) => x.type === "mine");
    n.owner = PLAYER; n.garrison = 5;
    // Cut it off: it holds no Command and nothing links it to one.
    for (const other of g.nodes) if (other !== n && other.owner === PLAYER) other.owner = NEUTRAL;
    E.computeSupply(g);
    assert.equal(n.inSupply, false);
    return E.supplyMultiplier(n, g);
  }
  assert.ok(output("logistics") > output("standard"));
  assert.equal(output("standard"), E.OUT_OF_SUPPLY_RATE);
});

test("Forward Relays actually gets the weapon fired inside a match", () => {
  // The point of the doctrine: reaching a full charge in the time a
  // match actually lasts. Measured before it existed, the weapon fired
  // 0.00 times per match.
  function chargeAfter(doctrine, seconds) {
    const g = E.createGame({ seed: 7, doctrine, foeDoctrine: "standard" });
    g.ai.timer = Infinity;
    // Take the whole board but leave the enemy their Command, so the
    // Relays are all in supply (a Relay with no chain back to a Command
    // of yours charges nothing, whatever your doctrine) and the match
    // does not end before the clock runs.
    const foeHome = g.nodes.find((n) => n.type === "command" && n.owner === ENEMY);
    for (const n of g.nodes) if (n !== foeHome) n.owner = PLAYER;
    E.computeSupply(g);
    run(g, seconds);
    return g.charge[PLAYER];
  }
  // Ten seconds in, before either side saturates the 20-charge cap.
  assert.ok(chargeAfter("relays", 10) > chargeAfter("standard", 10),
    "it has to charge visibly faster");
  assert.equal(chargeAfter("relays", 10), E.DOOM_CHARGE_NEEDED,
    "holding four Relays, this doctrine should be ready to fire almost at once");
  // The Relay production bonus is what makes this pick pay off in the
  // match you are actually having; everything else builds slower for it.
  const g = E.createGame({ seed: 7, doctrine: "relays", foeDoctrine: "standard" });
  const plain = E.createGame({ seed: 7, doctrine: "standard", foeDoctrine: "standard" });
  const relay = g.nodes.find((n) => n.type === "relay"); relay.owner = PLAYER;
  const plainRelay = plain.nodes.find((n) => n.type === "relay"); plainRelay.owner = PLAYER;
  assert.ok(E.nodeStats(relay, g).unitRate > E.nodeStats(plainRelay, plain).unitRate * 1.8,
    "a Relay must become a real producer");
  const fac = g.nodes.find((n) => n.type === "factory"); fac.owner = PLAYER;
  assert.ok(E.nodeStats(relay, g).unitRate > E.nodeStats(fac, g).unitRate,
    "...and out-build this side's own Factories, which is what the doctrine "
    + "claims and what makes taking Relays worth doing in the match you are "
    + "actually having");
  const plainFac = plain.nodes.find((n) => n.type === "factory"); plainFac.owner = PLAYER;
  assert.ok(E.nodeStats(fac, g).unitRate < E.nodeStats(plainFac, plain).unitRate,
    "and everywhere else is the price");
});

test("Prospectors earns more and researches cheaper, and builds slower", () => {
  const rich = E.createGame({ seed: 8, doctrine: "prospectors", foeDoctrine: "standard" });
  const plain = E.createGame({ seed: 8, doctrine: "standard", foeDoctrine: "standard" });
  const mine = rich.nodes.find((n) => n.type === "mine");
  mine.owner = PLAYER;
  plain.nodes.find((n) => n.type === "mine").owner = PLAYER;

  assert.ok(E.income(rich, PLAYER).credits > E.income(plain, PLAYER).credits);
  assert.ok(E.income(rich, PLAYER).units < E.income(plain, PLAYER).units);
  assert.ok(E.techCost("assault", 0, rich, PLAYER) < E.techCost("assault", 0, plain, PLAYER));
  // The published price list is untouched for anyone who asks without a game.
  assert.equal(E.techCost("assault", 0), E.TECH.assault.costs[0]);
});

test("Shock Troops hits harder and holds worse", () => {
  const g = E.createGame({ seed: 8, doctrine: "shock", foeDoctrine: "standard" });
  assert.ok(E.assaultMult(g, PLAYER) > E.assaultMult(g, ENEMY));
  assert.ok(E.fortifyMult(g, PLAYER) < E.fortifyMult(g, ENEMY));
});

test("a captured position is held to the cap it has AFTER changing hands", () => {
  // Taking ground resets its upgrades, so the survivors are held to the
  // bare capacity of a level-0 node -- not to the fortress the previous
  // owner had built. Ownership and level have to be settled before the
  // cap is read, which is the ordering this guards.
  const g = E.createGame({ seed: 8, doctrine: "standard", foeDoctrine: "standard" });
  g.ai.timer = Infinity;
  const tgt = g.nodes.find((n) => n.type === "factory");
  tgt.owner = ENEMY; tgt.garrison = 1; tgt.level = E.MAX_LEVEL;
  const fortressCap = E.nodeStats(tgt, g).cap;
  tgt.assault = { owner: PLAYER, count: 400, fuse: 0 };
  E.resolveAssault(g, tgt);
  assert.equal(tgt.owner, PLAYER);
  assert.equal(tgt.level, 0);
  assert.equal(tgt.garrison, E.NODE_TYPES.factory.cap);
  assert.ok(tgt.garrison < fortressCap, "the loser's upgraded cap must not carry over");
});

// ---------------------------------------------------------------------
// Ascension
// ---------------------------------------------------------------------

test("ascension grants the enemy starting tech and, at the top, production", () => {
  const plain = E.createGame({ seed: 3, ascension: 0 });
  assert.deepEqual(plain.tech[ENEMY], { assault: 0, fortify: 0 });
  assert.equal(plain.tech[PLAYER].assault, 0, "your own side is never handed tech");

  let last = { assault: -1, fortify: -1 };
  for (let lvl = 1; lvl <= E.ASCENSION_MAX; lvl++) {
    const g = E.createGame({ seed: 3, ascension: lvl });
    const t = g.tech[ENEMY];
    assert.ok(t.assault + t.fortify >= last.assault + last.fortify,
      "level " + lvl + " must not hand back tech");
    assert.deepEqual(g.tech[PLAYER], { assault: 0, fortify: 0 });
    last = t;
  }
  const top = E.createGame({ seed: 3, ascension: E.ASCENSION_MAX, difficulty: 2 });
  const base = E.createGame({ seed: 3, ascension: E.ASCENSION_MAX - 1, difficulty: 2 });
  assert.ok(E.aiProduction(top) > E.aiProduction(base), "the last rung adds production");
});

test("ascension is clamped to the rungs that exist", () => {
  const over = E.createGame({ seed: 3, ascension: 99 });
  assert.equal(over.ascension, E.ASCENSION_MAX);
  const under = E.createGame({ seed: 3, ascension: -4 });
  assert.equal(under.ascension, 0);
  assert.equal(E.createGame({ seed: 3 }).ascension, 0, "ascension is off unless asked for");
});

test("every ascension rung says what it does", () => {
  assert.equal(E.ASCENSION.length, E.ASCENSION_MAX);
  for (const rung of E.ASCENSION) {
    assert.ok(rung.label && rung.note, "a rung with no description is not a rung");
    assert.ok(rung.tech && rung.tech.assault <= E.TECH_MAX && rung.tech.fortify <= E.TECH_MAX);
  }
});

test("seat 2 held by a person keeps its own Doomstar to fire", () => {
  // Reported from a real match: online, the guest's weapon charges and
  // then discharges on its own, the FIRE button never lights, nothing
  // visible happens. The step loop auto-fired for seat ENEMY on every
  // tick, which is right when that seat is the AI and wrong when it is
  // the second person -- the host's simulation spent the guest's charge
  // the instant it filled, at a target the guest never chose.
  const human = quiet({ humanFoe: true });
  E.doomstarNode(human).owner = ENEMY;
  human.charge[ENEMY] = E.DOOM_CHARGE_NEEDED;
  const victim = human.nodes.find((n) => n.type !== "doomstar");
  victim.owner = PLAYER; victim.garrison = 50;
  run(human, 3);
  assert.equal(human.charge[ENEMY], E.DOOM_CHARGE_NEEDED,
    "nobody may spend a person's charge for them");
  assert.equal(E.canFire(human, ENEMY), true, "so their FIRE button lights");
  assert.equal(E.applyOrderAs(human, { kind: "fire" }, ENEMY), undefined,
    "and the order the guest sends is accepted");
  assert.ok(human.charge[ENEMY] < E.DOOM_CHARGE_NEEDED, "which spends it");

  // The AI still fires its own, or a solo match loses the weapon.
  const solo = quiet();
  E.doomstarNode(solo).owner = ENEMY;
  solo.charge[ENEMY] = E.DOOM_CHARGE_NEEDED;
  const target = solo.nodes.find((n) => n.type !== "doomstar");
  target.owner = PLAYER; target.garrison = 50;
  run(solo, 3);
  assert.ok(solo.charge[ENEMY] < E.DOOM_CHARGE_NEEDED,
    "an AI opponent must still fire unprompted");
});

test("a human-held seat 2 is not played by the AI either", () => {
  const g = quiet({ humanFoe: true });
  g.ai.timer = 0;                       // invite it to act
  const before = E.nodesOf(g, ENEMY).map((n) => n.garrison);
  run(g, 6);
  assert.equal(g.fleets.filter((f) => f.owner === ENEMY).length, 0,
    "no orders may be issued for a seat somebody is sitting in");
  assert.ok(E.nodesOf(g, ENEMY).every((n, i) => n.garrison >= before[i]),
    "and its garrisons must only grow");
});

test("a strike is recorded for both the side firing and the side hit", () => {
  const g = quiet();
  E.doomstarNode(g).owner = PLAYER;
  g.charge[PLAYER] = E.DOOM_CHARGE_NEEDED;
  const victim = g.nodes.find((n) => n.type === "factory");
  victim.owner = ENEMY; victim.garrison = 60;

  assert.equal(g.stats[PLAYER].fired, 0);
  assert.equal(E.fireDoomstar(g, PLAYER, victim.id), undefined);
  assert.equal(g.stats[PLAYER].fired, 1, "the firing side counts a strike dealt");
  assert.equal(g.stats[ENEMY].taken, 1, "the side hit counts one received");
  assert.equal(g.stats[PLAYER].taken, 0);
  assert.equal(g.stats[ENEMY].fired, 0);

  // A strike that wipes the position still credits the side that lost it,
  // even though the node goes neutral in the same breath.
  g.charge[PLAYER] = E.DOOM_CHARGE_NEEDED;
  const doomed = g.nodes.find((n) => n.type === "mine");
  doomed.owner = ENEMY; doomed.garrison = 2;
  E.fireDoomstar(g, PLAYER, doomed.id);
  assert.equal(doomed.owner, NEUTRAL, "setup: it must have been wiped");
  assert.equal(g.stats[ENEMY].taken, 2);
});

test("each seat keeps its own scoreboard", () => {
  // An online guest holds seat 2 and reads the same stats object the
  // host sends, so the numbers have to be per seat or it shows the
  // host's match instead of its own.
  const g = quiet();
  for (const seat of [PLAYER, ENEMY]) {
    assert.deepEqual(g.stats[seat],
      { sent: 0, captured: 0, lost: 0, peakNodes: 1, fired: 0, taken: 0 });
  }
  const theirs = E.nodesOf(g, ENEMY)[0];
  theirs.garrison = 30;
  const target = g.nodes.find((n) => n.owner === NEUTRAL && E.findPath(g, theirs.id, n.id, ENEMY));
  E.sendFleet(g, theirs.id, target.id, 0.5, ENEMY);
  assert.ok(g.stats[ENEMY].sent > 0, "the enemy's launch counts against the enemy");
  assert.equal(g.stats[PLAYER].sent, 0, "...and not against you");
});

// ---------------------------------------------------------------------
// Objectives and hand-authored maps
// ---------------------------------------------------------------------

const TINY = {
  w: 400, h: 300,
  nodes: [
    { x: 50, y: 150, type: "command", owner: PLAYER, garrison: 20 },
    { x: 200, y: 150, type: "factory", owner: NEUTRAL, garrison: 5 },
    { x: 350, y: 150, type: "command", owner: ENEMY, garrison: 20 }
  ],
  lanes: [[0, 1], [1, 2]]
};

test("a hand-authored map is built exactly as written", () => {
  const g = E.createGame({ map: TINY });
  assert.equal(g.nodes.length, 3);
  assert.equal(g.mapW, 400);
  assert.equal(g.mapH, 300);
  assert.deepEqual(g.nodes.map((n) => n.owner), [PLAYER, NEUTRAL, ENEMY]);
  assert.deepEqual(E.neighbors(g, 1).slice().sort(), [0, 2]);
  assert.equal(E.areLinked(g, 0, 2), false, "a lane that was not written must not exist");
  // Unlike a generated board, nothing here is seeded or symmetric.
  assert.equal(g.nodes[0].garrison, 20);
});

test("a Command is never placed on terrain that favours it", () => {
  const g = E.createGame({ map: {
    w: 400, h: 300,
    nodes: [
      { x: 50, y: 150, type: "command", terrain: "asteroid", owner: PLAYER, garrison: 10 },
      { x: 350, y: 150, type: "factory", terrain: "asteroid", owner: ENEMY, garrison: 10 }
    ],
    lanes: [[0, 1]]
  } });
  assert.equal(E.terrainOf(g.nodes[0]), "open", "a Command sits in open space, mission or not");
  assert.equal(E.terrainOf(g.nodes[1]), "asteroid");
});

test("a capture objective is won by taking the position and lost on the clock", () => {
  const g = E.createGame({ map: TINY, objective: { kind: "capture", nodeId: 2, seconds: 30 } });
  g.ai.timer = Infinity;
  run(g, 5);
  assert.equal(g.winner, null, "holding nothing new decides nothing");

  g.nodes[2].owner = PLAYER;
  E.step(g, 1 / 60);
  assert.equal(g.winner, PLAYER, "taking the target ends it");

  const slow = E.createGame({ map: TINY, objective: { kind: "capture", nodeId: 2, seconds: 10 } });
  slow.ai.timer = Infinity;
  run(slow, 11);
  assert.equal(slow.winner, ENEMY, "running the clock out is a loss");
});

test("a hold objective wants it held, not merely visited", () => {
  const g = E.createGame({ map: TINY,
    objective: { kind: "hold", nodeId: 1, holdFor: 5, seconds: 60 } });
  g.ai.timer = Infinity;
  g.nodes[1].owner = PLAYER;
  run(g, 3);
  assert.equal(g.winner, null);
  assert.ok(g.holdTimer >= 2.5 && g.holdTimer <= 3.5, "the clock runs while you hold it");

  // Lose it and the clock goes back to zero.
  g.nodes[1].owner = ENEMY;
  E.step(g, 1 / 60);
  assert.equal(g.holdTimer, 0, "losing the position restarts the hold");
  assert.equal(g.winner, null);

  g.nodes[1].owner = PLAYER;
  run(g, 6);
  assert.equal(g.winner, PLAYER);
});

test("a hold objective over a node TYPE wants every one of them at once", () => {
  const g = E.createGame({ map: {
    w: 400, h: 300,
    nodes: [
      { x: 50, y: 150, type: "command", owner: PLAYER, garrison: 20 },
      { x: 160, y: 80, type: "mine", owner: PLAYER, garrison: 5 },
      { x: 160, y: 220, type: "mine", owner: NEUTRAL, garrison: 5 },
      { x: 350, y: 150, type: "command", owner: ENEMY, garrison: 20 }
    ],
    lanes: [[0, 1], [0, 2], [1, 3], [2, 3]]
  }, objective: { kind: "hold", nodeType: "mine", holdFor: 3, seconds: 60 } });
  g.ai.timer = Infinity;
  run(g, 4);
  assert.equal(g.winner, null, "one of the two is not all of them");
  g.nodes[2].owner = PLAYER;
  run(g, 4);
  assert.equal(g.winner, PLAYER);
});

test("survive is won by still being there when the clock runs out", () => {
  const g = E.createGame({ map: TINY, objective: { kind: "survive", seconds: 8 } });
  g.ai.timer = Infinity;
  run(g, 5);
  assert.equal(g.winner, null);
  run(g, 4);
  assert.equal(g.winner, PLAYER);
});

test("losing every position loses, whatever the brief says", () => {
  const g = E.createGame({ map: TINY, objective: { kind: "survive", seconds: 600 } });
  g.ai.timer = Infinity;
  for (const n of g.nodes) n.owner = ENEMY;
  E.step(g, 1 / 60);
  assert.equal(g.winner, ENEMY, "elimination outranks the objective");
});

test("a skirmish is unaffected: no objective means take everything", () => {
  const g = quiet();
  assert.equal(g.objective.kind, "eliminate");
  assert.equal(E.objectiveProgress(g), null, "nothing to show on a skirmish HUD");
});

test("every shipped mission is coherent", () => {
  const C = require("./campaign.js");
  assert.ok(C.MISSIONS.length > 0);
  const seen = new Set();
  for (const m of C.MISSIONS) {
    assert.ok(!seen.has(m.id), "mission ids must be unique: " + m.id);
    seen.add(m.id);
    assert.ok(m.name && m.brief && m.goal && m.hint, m.id + " needs its text");
    assert.ok(E.DOCTRINES[m.doctrine], m.id + " names a doctrine that exists");
    assert.ok(E.OBJECTIVES.indexOf(m.objective.kind) !== -1, m.id + " objective kind");

    const g = E.createGame(C.optionsFor(m));
    assert.equal(E.doctrineOf(g, PLAYER), m.doctrine, m.id + " must hand you its doctrine");
    assert.ok(E.nodesOf(g, PLAYER).length > 0, m.id + " needs you to start somewhere");
    assert.ok(E.nodesOf(g, ENEMY).length > 0, m.id + " needs an opponent");

    // Every position must be reachable from your start, or part of the
    // board is scenery and the brief may be impossible.
    const reach = new Set(E.nodesOf(g, PLAYER).map((n) => n.id));
    let grew = true;
    while (grew) {
      grew = false;
      for (const n of g.nodes) {
        if (reach.has(n.id)) continue;
        for (const nb of E.neighbors(g, n.id)) {
          if (reach.has(nb)) { reach.add(n.id); grew = true; break; }
        }
      }
    }
    assert.equal(reach.size, g.nodes.length, m.id + " has unreachable ground");

    // And the thing the brief asks for has to exist on the board.
    if (m.objective.kind !== "eliminate" && m.objective.kind !== "survive") {
      assert.ok(E.objectiveNodes(g, m.objective).length > 0,
        m.id + " names an objective position that is not on its map");
    }
  }
});

test("the difficulty tiers climb without a cliff in the middle", () => {
  // Officer to Commander used to be 1.00 to 1.75 in one step, which is
  // most of the range in a single button.
  let last = 0;
  for (const tier of E.DIFFICULTY) {
    assert.ok(tier.produce > last, "production must rise with every tier");
    last = tier.produce;
  }
  assert.equal(E.TOP_TIER, E.DIFFICULTY.length - 1);
  // No single step may be more than half the whole range.
  const span = E.DIFFICULTY[E.TOP_TIER].produce - E.DIFFICULTY[0].produce;
  for (let i = 1; i < E.DIFFICULTY.length; i++) {
    const step = E.DIFFICULTY[i].produce - E.DIFFICULTY[i - 1].produce;
    assert.ok(step <= span * 0.5,
      "tier " + i + " is a cliff: +" + step.toFixed(2) + " of a " + span.toFixed(2) + " range");
  }
});

test("every capture mission leaves at least one route that actually works", () => {
  // The Redoubt Gate shipped with a level-3 enemy Command: cap 123,
  // regenerating 2.54 units a second. The Doomstar does 26 damage and,
  // holding every Relay on that map, recharges in about ten seconds --
  // during which the target regrew 25. Net 0.6 units a strike, against
  // a wall you could not mass through either. The mission was not hard,
  // it was impossible, and its own hint pointed at the dead route.
  //
  // So: a capture objective must be beatable by massing units, or by
  // the weapon, and a mission built around the weapon must be beatable
  // by the weapon specifically.
  const C = require("./campaign.js");
  for (const m of C.MISSIONS) {
    if (m.objective.kind !== "capture") continue;
    const g = E.createGame(C.optionsFor(m));
    const target = g.nodes[m.objective.nodeId];
    const stats = E.nodeStats(target, g);

    const relays = g.nodes.filter((n) => n.type === "relay").length;
    const perTick = relays * E.DOOM_CHARGE_PER_RELAY * E.docMod(g, PLAYER, "chargeRate");
    const cycle = perTick > 0
      ? (E.DOOM_CHARGE_NEEDED / perTick) * E.DOOM_CHARGE_INTERVAL : Infinity;
    const netPerStrike = E.strikeDamage(g, PLAYER) - stats.unitRate * cycle;
    const strikeWorks = netPerStrike > E.strikeDamage(g, PLAYER) * 0.25;

    // Massing: what you can build against what the target is worth once
    // it has grown into its cap.
    const buildable = E.income(g, PLAYER).units * m.objective.seconds;
    const needed = stats.cap * E.DEFENDER_EDGE * E.fortifyMult(g, ENEMY) * E.terrainDefence(target);
    const massWorks = buildable > needed * 1.5;   // headroom for losses

    assert.ok(strikeWorks || massWorks,
      m.id + ": neither route works. A strike nets " + netPerStrike.toFixed(1) +
      " units (" + E.strikeDamage(g, PLAYER) + " damage against " +
      (stats.unitRate * cycle).toFixed(1) + " regrowth per " + cycle.toFixed(0) + "s cycle), " +
      "and you can build " + buildable.toFixed(0) + " units against a target worth " +
      needed.toFixed(0));

    if (m.doctrine === "relays") {
      assert.ok(strikeWorks,
        m.id + " is the weapon mission, so the weapon has to break the target: " +
        "nets only " + netPerStrike.toFixed(1) + " a strike");
    }
  }
});

test("reinforcing a position never makes it smaller", () => {
  // A node can legitimately sit above its cap -- a mission builds
  // fortifications that way, and the Doomstar's damage against one is
  // permanent precisely because it cannot regrow. Clamping on arrival
  // turned a friendly top-up into demolition: a 220-unit wall dropped
  // to its 68 cap the first time the AI reinforced it, and a siege that
  // should have taken minutes ended in fifty seconds.
  const g = quiet();
  const n = g.nodes.find((x) => x.type === "factory");
  n.owner = PLAYER;
  const cap = E.nodeStats(n, g).cap;
  n.garrison = cap + 80;

  E.resolveArrival(g, { owner: PLAYER, to: n.id, count: 10 });
  assert.equal(n.garrison, cap + 80, "an over-cap position keeps what it has");

  // Below the cap it still fills, and still wastes the overflow.
  n.garrison = cap - 5;
  E.resolveArrival(g, { owner: PLAYER, to: n.id, count: 50 });
  assert.equal(n.garrison, cap, "under the cap it fills to the cap and no further");
});

test("a defending opponent holds its ground and never marches on yours", () => {
  // Reported from play: the siege wall, three fortifications of 70-odd
  // units, was read by the AI as an attack force and sent into the
  // player's home. A mission can ask for a defender instead.
  const map = {
    w: 600, h: 400,
    nodes: [
      { x: 60, y: 200, type: "command", owner: PLAYER, garrison: 20 },
      { x: 300, y: 200, type: "factory", owner: NEUTRAL, garrison: 5 },
      { x: 460, y: 120, type: "factory", owner: ENEMY, garrison: 90 },
      { x: 540, y: 200, type: "command", owner: ENEMY, garrison: 90 }
    ],
    lanes: [[0, 1], [1, 2], [2, 3]]
  };
  const defend = E.createGame({ map, posture: "defend", difficulty: 3 });
  assert.equal(E.isDefensive(defend), true);
  assert.deepEqual(defend.foeHomeIds, [2, 3], "its own ground is where it started");
  assert.equal(E.defends(defend, 0), false, "your Command is not its ground");
  assert.equal(E.defends(defend, 2), true);

  run(defend, 120);
  assert.equal(defend.nodes[0].owner, PLAYER, "it must never take your Command");
  assert.equal(defend.nodes[1].owner, NEUTRAL, "nor expand onto neutral ground");
  assert.ok(defend.nodes[2].garrison >= 90, "and it holds what it was given");

  // It does still retake its own ground.
  defend.nodes[2].owner = PLAYER;
  defend.nodes[2].garrison = 1;
  run(defend, 90);
  assert.equal(defend.nodes[2].owner, ENEMY, "a defender still fights for its own wall");

  // Without the posture, the same opponent comes for you.
  const normal = E.createGame({ map, difficulty: 3 });
  assert.equal(E.isDefensive(normal), false);
  run(normal, 200);
  assert.equal(normal.nodes[1].owner, ENEMY, "an ordinary opponent does expand");
  assert.notEqual(normal.nodes[0].owner, PLAYER, "an ordinary opponent does attack");
});

test("a defender does not drain its own fortifications to shuffle units", () => {
  // The "shore up the front" branch sends half of a donor away. On a
  // defensive map that had a 150-unit wall at 75 within fifteen
  // seconds, which handed the player the fortress.
  const map = {
    w: 600, h: 400,
    nodes: [
      { x: 60, y: 200, type: "command", owner: PLAYER, garrison: 20 },
      { x: 300, y: 200, type: "factory", owner: ENEMY, garrison: 150 },
      { x: 540, y: 200, type: "command", owner: ENEMY, garrison: 120 }
    ],
    lanes: [[0, 1], [1, 2]]
  };
  const g = E.createGame({ map, posture: "defend", difficulty: 3 });
  const wall = g.nodes[1].garrison, home = g.nodes[2].garrison;
  run(g, 60);
  assert.ok(g.nodes[1].garrison >= wall, "the wall must not shrink, got " + g.nodes[1].garrison);
  assert.ok(g.nodes[2].garrison >= home, "nor the keep behind it");
});
