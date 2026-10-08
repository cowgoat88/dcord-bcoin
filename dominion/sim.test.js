// Run with: node --test dominion/sim.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./sim.js");
const A = require("./ai.js");
const { NEUTRAL } = S;

const seats = (n, human) => Array.from({ length: n }, (_, i) => ({ ai: !(human && i === 0), faction: "standard" }));

// A small hand-built board for rules tests: a line 0-1-2 with a side node 3
// next to 1. Seat 1 holds 0 and 3, seat 2 holds 2, node 1 is neutral.
function lineGame() {
  return S.createGame({
    seed: 1, seats: [{ faction: "standard" }, { faction: "standard", ai: true }],
    map: {
      mapW: 800, mapH: 400,
      nodes: [
        { x: 100, y: 200, type: "command", owner: 1, garrison: 40 },
        { x: 400, y: 200, type: "factory", owner: NEUTRAL, garrison: 10 },
        { x: 700, y: 200, type: "command", owner: 2, garrison: 40 },
        { x: 400, y: 60, type: "factory", owner: 1, garrison: 30 }
      ],
      lanes: [{ a: 0, b: 1 }, { a: 1, b: 2 }, { a: 1, b: 3 }, { a: 0, b: 3 }]
    }
  });
}
function crosses(p1, p2, p3, p4) {
  const d = (a, b, c) => (c.x - a.x) * (b.y - a.y) - (c.y - a.y) * (b.x - a.x);
  const d1 = d(p3, p4, p1), d2 = d(p3, p4, p2), d3 = d(p1, p2, p3), d4 = d(p1, p2, p4);
  return ((d1 > 0 && d2 < 0) || (d1 < 0 && d2 > 0)) && ((d3 > 0 && d4 < 0) || (d3 < 0 && d4 > 0));
}

// ---------------------------------------------------------------------
// The galaxy
// ---------------------------------------------------------------------
test("every galaxy is connected, its lanes never cross, and every seat starts on the same ground", () => {
  for (let n = 2; n <= 6; n++) {
    for (let seed = 1; seed <= 6; seed++) {
      const g = S.createGame({ seed, seats: seats(n) });
      const seen = new Set([0]), st = [0];
      while (st.length) { const c = st.pop(); for (const x of S.neighbors(g, c)) if (!seen.has(x)) { seen.add(x); st.push(x); } }
      assert.equal(seen.size, g.nodes.length, n + " seats, seed " + seed + ": unreachable ground");
      for (let i = 0; i < g.lanes.length; i++) for (let j = i + 1; j < g.lanes.length; j++) {
        const a = g.lanes[i], b = g.lanes[j];
        if (a.a === b.a || a.a === b.b || a.b === b.a || a.b === b.b) continue;
        assert.ok(!crosses(g.nodes[a.a], g.nodes[a.b], g.nodes[b.a], g.nodes[b.b]), "lanes cross");
      }
      const per = [];
      for (let s = 0; s < n; s++) per.push(g.nodes.filter((x) => x.sector === s).map((x) => x.type + S.neighbors(g, x.id).length + x.terrain + x.garrison).join());
      assert.ok(per.every((p) => p === per[0]), n + " seats, seed " + seed + ": wedges differ");
      for (const s of g.seats) assert.equal(S.nodesOf(g, s.id).filter((x) => x.type === "command").length, 1, "one Command each");
      assert.equal(S.throneNode(g).owner, NEUTRAL, "the Throne starts unclaimed");
    }
  }
});

// ---------------------------------------------------------------------
// Plotting
// ---------------------------------------------------------------------
test("plotting changes nothing on the board, and orders are checked against it", () => {
  const g = lineGame();
  const before = JSON.stringify(g.nodes);
  assert.equal(S.addOrder(g, 1, { kind: "send", from: 0, to: 1, frac: 0.5 }), undefined);
  assert.equal(JSON.stringify(g.nodes), before, "nothing moved");
  assert.match(S.addOrder(g, 1, { kind: "send", from: 2, to: 1 }), /don't hold/);
  assert.match(S.addOrder(g, 1, { kind: "send", from: 0, to: 2 }), /No route/, "routes still need your own ground");
  assert.match(S.addOrder(g, 1, { kind: "support", from: 0, to: 2 }), /neighbouring/);
  assert.equal(S.addOrder(g, 1, { kind: "hold", at: 3 }), undefined);
  assert.match(S.addOrder(g, 1, { kind: "send", from: 3, to: 1 }), /dug in/, "a held position cannot also send");
});

test("command points limit the orders a round can carry", () => {
  const g = lineGame();
  const cp = S.commandPoints(g, 1);
  assert.equal(cp, S.CP_BASE);
  for (let i = 0; i < cp; i++) {
    const why = S.addOrder(g, 1, { kind: "send", from: i % 2 ? 3 : 0, to: 1, frac: 0.2 });
    assert.equal(why, undefined, why);
  }
  assert.match(S.addOrder(g, 1, { kind: "send", from: 0, to: 1, frac: 0.2 }), /command points/);
  assert.equal(S.removeOrder(g, 1, 0), undefined);
  assert.equal(S.cpUsed(g, 1), cp - 1, "removing one gives the point back");
});

test("credits promised to this round's upgrades cannot be promised twice", () => {
  const g = lineGame();
  g.credits[1] = 70;
  assert.equal(S.addOrder(g, 1, { kind: "upgrade", at: 0 }), undefined);
  assert.match(S.addOrder(g, 1, { kind: "upgrade", at: 3 }), /Need/, "60 is spoken for, 10 left");
});

// ---------------------------------------------------------------------
// Resolving
// ---------------------------------------------------------------------
test("a round runs its full length, then the board is plotted again", () => {
  const g = lineGame();
  S.addOrder(g, 1, { kind: "send", from: 0, to: 1, frac: 0.6 });
  S.lockOrders(g, 1); S.lockOrders(g, 2);
  assert.equal(S.allLocked(g), true);
  S.beginResolve(g);
  assert.equal(g.phase, "resolve");
  assert.match(S.addOrder(g, 1, { kind: "hold", at: 0 }), /between rounds/, "no orders while time runs");
  S.runRound(g);
  assert.equal(g.phase, "plot");
  assert.equal(g.round, 2);
  assert.ok(Math.abs(g.time - S.ROUND_SECONDS) < 1e-6);
  assert.equal(g.nodes[1].owner, 1, "24 units took a 10-garrison neutral");
  assert.deepEqual(g.orders[1], [], "orders clear for the new round");
  assert.equal(g.locked[1], false);
});

test("a supporting neighbour lends half its garrison to a defence, without moving", () => {
  const mk = (withSupport) => {
    const g = lineGame();
    g.nodes[1].owner = 1; g.nodes[1].garrison = 20;
    g.nodes[3].garrison = 40;
    if (withSupport) S.addOrder(g, 1, { kind: "support", from: 3, to: 1 });
    S.addOrder(g, 2, { kind: "send", from: 2, to: 1, frac: 1 });
    S.beginResolve(g); S.runRound(g);
    return g;
  };
  // 40 attackers against 20 x 1.25 = 25: falls alone.
  assert.equal(mk(false).nodes[1].owner, 2);
  // With 40 x 0.5 x 1.25 = 25 more, the defence is 50: holds.
  const held = mk(true);
  assert.equal(held.nodes[1].owner, 1, "support turned the fight");
  assert.ok(held.nodes[3].garrison >= 40, "the supporter lost nothing");
});

test("support is cut when the supporting position is itself attacked", () => {
  const g = lineGame();
  g.nodes[1].owner = 1; g.nodes[1].garrison = 20;
  g.nodes[3].garrison = 40;
  S.addOrder(g, 1, { kind: "support", from: 3, to: 1 });
  S.beginResolve(g);
  // A raid lands on the supporter first, then the real attack on node 1.
  g.fleets.push({ owner: 2, from: 2, to: 3, count: 3, path: [2, 1, 3], leg: 1, t: 0.9, duration: 1 });
  S.step(g, 0.2);
  assert.equal(g.support[0].cut, true);
  g.fleets.push({ owner: 2, from: 2, to: 1, count: 40, path: [2, 1], leg: 0, t: 0.95, duration: 2.6 });
  S.runRound(g);
  assert.equal(g.nodes[1].owner, 2, "with its support cut, node 1 falls");
});

test("a dug-in position defends a quarter harder", () => {
  const mk = (hold) => {
    const g = lineGame();
    g.nodes[1].owner = 1; g.nodes[1].garrison = 20;
    if (hold) S.addOrder(g, 1, { kind: "hold", at: 1 });
    S.addOrder(g, 2, { kind: "send", from: 2, to: 1, frac: 0.7 });  // 28 against 25, or against 31.25 dug in
    S.beginResolve(g); S.runRound(g);
    return g.nodes[1].owner;
  };
  assert.equal(mk(false), 2);
  assert.equal(mk(true), 1);
});

test("fleets that meet in a lane still fight there", () => {
  const g = lineGame();
  g.nodes[1].owner = 1; g.nodes[1].garrison = 1;
  S.addOrder(g, 1, { kind: "send", from: 0, to: 2, frac: 1 });   // 40 east
  S.addOrder(g, 2, { kind: "send", from: 2, to: 0, frac: 1 });   // 40 west: routes only through their own ground...
  assert.equal(g.orders[2].length, 0, "...which they do not have, so it is refused");
  S.addOrder(g, 2, { kind: "send", from: 2, to: 1, frac: 0.5 });
  S.beginResolve(g);
  let clash = false;
  while (g.phase === "resolve") { S.step(g, 0.05); for (const e of S.drainEvents(g)) if (e.kind === "clash") clash = true; }
  assert.ok(clash, "the two fleets met on the 1-2 lane");
});

test("the Throne scores a point at the end of every round it is held", () => {
  const g = S.createGame({ seed: 3, seats: seats(3) });
  const t = S.throneNode(g);
  t.owner = 2; t.garrison = 30;
  for (const s of g.seats) S.lockOrders(g, s.id);
  S.beginResolve(g); S.runRound(g);
  assert.equal(g.points[2], 1);
  assert.equal(g.points[1], 0);
});

test("the season ends on points, on the round limit, or with one seat left", () => {
  const g = S.createGame({ seed: 3, seats: seats(3) });
  g.points[3] = S.POINTS_TO_WIN - 1;
  S.throneNode(g).owner = 3;
  S.beginResolve(g); S.runRound(g);
  assert.equal(g.phase, "over");
  assert.equal(g.winner, 3);

  const h = S.createGame({ seed: 3, seats: seats(3) });
  h.round = S.ROUND_LIMIT;
  S.beginResolve(h); S.runRound(h);
  assert.equal(h.phase, "over", "the limit ends it");

  const k = S.createGame({ seed: 3, seats: seats(3) });
  for (const n of k.nodes) if (n.owner === 2 || n.owner === 3) n.owner = NEUTRAL;
  S.beginResolve(k); S.runRound(k);
  assert.equal(k.winner, 1, "last seat standing");
});

test("same-instant arrivals are processed in an order that turns each round", () => {
  const g = S.createGame({ seed: 1, seats: seats(4) });
  assert.deepEqual(S.seatOrder(g), [1, 2, 3, 4]);
  g.round = 2; assert.deepEqual(S.seatOrder(g), [2, 3, 4, 1]);
  g.round = 4; assert.deepEqual(S.seatOrder(g), [4, 1, 2, 3]);
});

// ---------------------------------------------------------------------
// Forecast and replay
// ---------------------------------------------------------------------
test("the forecast shows the round to come without touching the real board", () => {
  const g = lineGame();
  S.addOrder(g, 1, { kind: "send", from: 0, to: 1, frac: 0.6 });
  const before = JSON.stringify([g.nodes, g.fleets, g.orders, g.phase, g.time]);
  const frames = S.forecast(g, 1, 1);
  assert.equal(JSON.stringify([g.nodes, g.fleets, g.orders, g.phase, g.time]), before, "the real game is untouched");
  assert.equal(frames.length, S.ROUND_SECONDS + 1, "one frame a second, both ends included");
  assert.equal(frames[0].nodes[1].owner, NEUTRAL);
  assert.equal(frames.at(-1).nodes[1].owner, 1, "it shows the capture");
  // With the rival passing, the forecast is exactly what happens.
  S.lockOrders(g, 1); S.lockOrders(g, 2);
  S.beginResolve(g); S.runRound(g);
  assert.deepEqual(g.nodes.map((n) => n.owner), frames.at(-1).nodes.map((n) => n.owner));
  assert.ok(g.nodes.every((n, i) => Math.abs(n.garrison - frames.at(-1).nodes[i].garrison) < 1e-6), "to the unit");
});

test("the forecast hides other seats' plans", () => {
  const g = lineGame();
  S.addOrder(g, 2, { kind: "send", from: 2, to: 1, frac: 1 });
  const frames = S.forecast(g, 1, 1);
  assert.equal(frames.at(-1).nodes[1].owner, NEUTRAL, "seat 1 does not see seat 2's attack coming");
});

test("a copied game is fully independent", () => {
  const g = S.createGame({ seed: 2, seats: seats(3) });
  const c = S.cloneGame(g);
  c.nodes[1].garrison = 999; c.credits[1] = 999; c.orders[1].push({ kind: "hold", at: 1 });
  assert.notEqual(g.nodes[1].garrison, 999);
  assert.notEqual(g.credits[1], 999);
  assert.equal(g.orders[1].length, 0);
  assert.equal(c.seatById[1], c.seats[0], "the copy's seat index points at its own seats");
});

test("the same seed and the same orders give the same season", () => {
  const play = () => {
    const g = S.createGame({ seed: 9, seats: seats(3) });
    while (g.phase !== "over") { A.planAll(g); S.beginResolve(g); S.runRound(g); S.drainEvents(g); }
    return JSON.stringify([g.winner, g.points, g.nodes.map((n) => [n.owner, Math.round(n.garrison * 1000)])]);
  };
  assert.equal(play(), play());
});

// ---------------------------------------------------------------------
// The rivals
// ---------------------------------------------------------------------
test("AI rivals finish a three- and a four-seat season, using every kind of order", () => {
  const kinds = new Set();
  for (const n of [3, 4]) {
    for (let seed = 1; seed <= 4; seed++) {
      const g = S.createGame({ seed, seats: seats(n) });
      let captures = 0;
      while (g.phase !== "over") {
        A.planAll(g);
        for (const s of g.seats) {
          assert.ok(g.orders[s.id].length <= S.commandPoints(g, s.id), "never over its command points");
          for (const o of g.orders[s.id]) kinds.add(o.kind);
        }
        S.beginResolve(g); S.runRound(g);
        captures += S.drainEvents(g).filter((e) => e.kind === "capture").length;
      }
      assert.ok(g.winner, "a winner");
      assert.ok(captures >= 12, n + " seats, seed " + seed + ": the rivals actually fight: " + captures);
    }
  }
  for (const k of ["send", "support", "research"]) assert.ok(kinds.has(k), "used " + k);
});

test("an AI seat only ever gives orders a person could", () => {
  const g = S.createGame({ seed: 4, seats: seats(3, true) });
  for (let r = 0; r < 5; r++) {
    A.planAll(g);
    assert.equal(g.orders[1].length, 0, "it never plots for the human seat");
    for (const s of g.seats.filter((x) => x.ai)) {
      const c = S.cloneGame(g);
      c.orders[s.id] = []; c.locked[s.id] = false;
      for (const o of g.orders[s.id]) assert.equal(S.addOrder(c, s.id, o), undefined, "replaying its orders is legal");
    }
    S.lockOrders(g, 1);
    S.beginResolve(g); S.runRound(g); S.drainEvents(g);
  }
});

test("the simulation uses no math that may differ between browsers", () => {
  // Online, every client re-runs each round from the stored orders, so the
  // result must be identical everywhere. Math.hypot, Math.pow and trig are
  // implementation-defined in their last bit; generation may use trig only
  // because its output is rounded to whole units.
  const src = require("fs").readFileSync(require("path").join(__dirname, "sim.js"), "utf8");
  const code = src.replace(/\/\/.*$/gm, "");
  assert.ok(!/Math\.(hypot|pow|exp|log|atan2?|tan)\b/.test(code), "no hypot, pow, exp, log or tan in the engine");
  const trig = code.split("\n").filter((l) => /Math\.(sin|cos)\(/.test(l));
  assert.ok(trig.every((l) => /Math\.round\(/.test(l)), "sin and cos only inside a rounding");
  const g = S.createGame({ seed: 5, seats: seats(4) });
  assert.ok(g.nodes.every((n) => Number.isInteger(n.x) && Number.isInteger(n.y)), "positions are whole units");
});

// ---------------------------------------------------------------------
// Objectives
// ---------------------------------------------------------------------
test("two public objectives show at the start and one more is revealed every round", () => {
  const g = S.createGame({ seed: 4, seats: seats(3) });
  assert.equal(S.publicObjectives(g).length, 2);
  assert.equal(g.deck.length, 10);
  assert.ok(g.deck.slice(0, 5).every((id) => S.objectiveById(id).stage === 1), "stage I first");
  assert.ok(g.deck.slice(5).every((id) => S.objectiveById(id).stage === 2), "then stage II");
  for (const s of g.seats) S.lockOrders(g, s.id);
  S.beginResolve(g); S.runRound(g);
  assert.equal(S.publicObjectives(g).length, 3);
  for (const s of g.seats) assert.ok(S.objectiveById(g.secret[s.id].id), "every seat has a secret");
});

test("a seat scores at most one public objective a round, each only once, and its secret only once", () => {
  const g = S.createGame({ seed: 4, seats: seats(3) });
  // Make every stage I objective trivially met by seat 1 on the board.
  g.deck = ["relays3", "mines2", "nine", "spread", "factories", "court", "fifteen", "everywhere", "relays5", "levels"];
  g.revealed = 3;
  const free = g.nodes.filter((n) => n.owner === 0 && n.type !== "doomstar");
  for (const n of free) { n.owner = 1; n.garrison = 20; }
  g.secret[1] = { id: "fortress", scored: false };
  const before = g.points[1];
  for (const s of g.seats) S.lockOrders(g, s.id);
  S.beginResolve(g); S.runRound(g);
  const got = g.points[1] - before;
  assert.equal(got, 2, "one public (1) and the secret (1): " + got);
  assert.equal(g.secret[1].scored, true);
  for (const s of g.seats) S.lockOrders(g, s.id);
  S.beginResolve(g); S.runRound(g);
  assert.equal(g.points[1] - before, 3, "the next round, the next public only; the secret does not pay twice");
  const scoredIds = Object.keys(g.scored).filter((id) => g.scored[id].includes(1));
  assert.equal(scoredIds.length, 2);
});

test("things that happen during a round count toward objectives, and reset each round", () => {
  const g = lineGame();
  g.nodes[1].owner = 1; g.nodes[1].garrison = 20; g.nodes[3].garrison = 40;
  S.addOrder(g, 1, { kind: "support", from: 3, to: 1 });
  S.addOrder(g, 2, { kind: "send", from: 2, to: 1, frac: 1 });
  S.beginResolve(g); S.runRound(g);
  assert.equal(g.nodes[1].owner, 1);
  assert.equal(g.flags[1].supportDecisive, true, "the support decided it");
  for (const s of g.seats) S.lockOrders(g, s.id);
  S.beginResolve(g);
  assert.equal(g.flags[1].supportDecisive, false, "a new round starts clean");
  const h = lineGame();
  h.nodes[2].garrison = 5;
  h.nodes[1].owner = 1; h.nodes[1].garrison = 30;
  S.addOrder(h, 1, { kind: "send", from: 1, to: 2, frac: 1 });
  S.beginResolve(h); S.runRound(h);
  assert.equal(h.nodes[2].owner, 1);
  assert.equal(h.flags[1].tookCommand, true, "taking a rival's Command is noticed");
  assert.equal(h.flags[1].captures, 1);
  assert.equal(h.flags[2].lost, 1);
});

test("rivals value what their open objectives ask for", () => {
  const g = S.createGame({ seed: 4, seats: seats(3) });
  g.deck = ["relays3", "nine", "mines2", "spread", "factories", "court", "fifteen", "everywhere", "relays5", "levels"];
  g.revealed = 1;
  g.secret[2] = { id: "crown", scored: false };
  const w = A.wants(g, 2);
  const relay = g.nodes.find((n) => n.type === "relay" && n.owner === 0);
  const mine = g.nodes.find((n) => n.type === "mine" && n.owner === 0 && n.sector === relay.sector);
  assert.ok(w.weight(relay) > w.weight(mine), "Hold 3 Relays makes Relays worth more");
  const cmd = g.nodes.find((n) => n.type === "command" && n.owner === 1);
  assert.ok(w.weight(cmd) >= 2.5, "a secret to take a Command makes Commands worth more");
});

test("seasons end on points, not only on the round limit", () => {
  let onPoints = 0;
  for (let seed = 1; seed <= 12; seed++) {
    const g = S.createGame({ seed, seats: seats(3) });
    while (g.phase !== "over") { A.planAll(g); S.beginResolve(g); S.runRound(g); S.drainEvents(g); }
    if (g.points[g.winner] >= S.POINTS_TO_WIN) onPoints++;
  }
  assert.ok(onPoints >= 3, "objectives decide some seasons: " + onPoints + "/12");
});

test("the roles draft: fewest points picks first, each role once, and roles take effect", () => {
  const g = S.createGame({ seed: 5, seats: seats(4), draft: true });
  assert.equal(g.phase, "draft");
  g.points[3] = 2; g.points[1] = 1;
  S.openDraft(g);
  assert.equal(S.draftTurn(g), g.draft.order[0]);
  assert.equal(g.draft.order[g.draft.order.length - 1], 3, "the leader picks last");
  assert.ok(g.points[g.draft.order[0]] === 0);
  const first = S.draftTurn(g);
  assert.ok(S.pickRole(g, 3, "admiral"), "out of turn is refused");
  assert.equal(S.pickRole(g, first, "admiral"), undefined);
  const second = S.draftTurn(g);
  assert.ok(S.pickRole(g, second, "admiral"), "a taken role is refused");
  assert.equal(S.addOrder(g, first, { type: "hold", node: S.nodesOf(g, first)[0].id }) !== undefined, true,
    "no orders during the draft");
  ["merchant", "engineer", "spymaster"].forEach((r) => assert.equal(S.pickRole(g, S.draftTurn(g), r), undefined));
  assert.equal(g.phase, "plot");
  assert.equal(S.rolesLeft(g).length, 2);
  const base = Math.min(S.CP_MAX, S.CP_BASE + Math.floor(S.nodesOf(g, first).length / S.CP_PER));
  assert.equal(S.commandPoints(g, first), base + 2, "the Admiral plots two more orders");
  const eng = Object.keys(g.roles).map(Number).find((s) => g.roles[s] === "engineer");
  assert.equal(S.upgradePrice(g, eng, 0, 0), 0, "the Engineer's first upgrade is free");
  assert.ok(S.upgradePrice(g, eng, 0, 1) > 0);
});

test("all-AI seasons with the draft run, every seat holding a different role each round", () => {
  const g = S.createGame({ seed: 9, seats: seats(4), draft: true });
  let rounds = 0;
  while (g.phase !== "over" && rounds < 20) {
    A.runDraft(g);
    assert.equal(g.phase, "plot");
    const taken = Object.values(g.roles);
    assert.equal(new Set(taken).size, taken.length);
    assert.equal(taken.length, S.liveSeats(g).length);
    A.planAll(g); S.beginResolve(g); S.runRound(g); S.drainEvents(g); rounds++;
  }
  assert.equal(g.phase, "over");
});
