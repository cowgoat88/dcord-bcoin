// Run with: node --test dominion/online.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./sim.js");
const A = require("./ai.js");
const O = require("./online.js");

const config = (seed) => ({ seed, seats: [{ faction: "standard", name: "Ana" }, { faction: "vanguard", ai: true, name: "Rival" }, { faction: "shock", name: "Bo" }, { faction: "relays", ai: true, name: "Choir" }] });

// A person's turn, played by the AI's own logic on that person's view.
function plotLikeAPerson(c) {
  const g = c.game, view = S.viewFor(g, c.seat);
  A.plan(view, c.seat);      // plans and locks on the copy only
  for (const o of view.orders[c.seat]) S.addOrder(g, c.seat, o);
  const left = S.voteChoices(g);
  if (left.length) S.castVote(g, c.seat, left[c.seat % left.length], Math.min(1, g.influence[c.seat]));
}
async function draftUntilDone(clients) {
  for (let guard = 0; guard < 20; guard++) {
    let turn = null;
    for (const c of clients) turn = await c.syncDraft();
    if (!turn) return;
    const c = clients.find((x) => x.seat === turn);
    assert.equal(await c.pick(S.rolesLeft(c.game)[0]), undefined);
  }
  throw new Error("draft stuck");
}

test("two people and two rivals play a season online and every client holds the same galaxy", async () => {
  const net = O.memoryDatabase();
  const ana = net.storeFor("user-ana"), bo = net.storeFor("user-bo");
  const m = await O.createMatch(ana, config(77));
  assert.equal(await O.seatsFilled(ana, m.id), false);
  const boSeat = await O.joinMatch(bo, m.id);
  assert.equal(boSeat, 3, "the next seat a person may take");
  await assert.rejects(O.joinMatch(net.storeFor("user-cy"), m.id), /full/);
  assert.equal(await O.seatsFilled(bo, m.id), true);
  const [mb] = await bo.select("matches", { id: m.id });
  const clients = [new O.Client(ana, m, 1), new O.Client(bo, mb, 3)];
  let rounds = 0;
  while (clients[0].game.phase !== "over" && rounds < 20) {
    await draftUntilDone(clients);
    for (const c of clients) { assert.equal(c.game.phase, "plot"); c.planRivals(); }
    plotLikeAPerson(clients[0]);
    await clients[0].lock();
    // Bo cannot read Ana's orders yet, and the round cannot begin.
    const peek = await bo.select("moves", { match_id: m.id, round: clients[1].game.round, kind: "plot" });
    assert.equal(peek.length, 0, "orders stay hidden until everyone has locked");
    assert.equal(await clients[1].tryReveal(), false);
    plotLikeAPerson(clients[1]);
    await clients[1].lock();
    for (const c of clients) {
      assert.equal(await c.tryReveal(), true);
      S.runRound(c.game); S.drainEvents(c.game);
    }
    assert.equal(O.stateHash(clients[0].game), O.stateHash(clients[1].game), "round " + clients[0].game.round + ": same galaxy");
    rounds++;
  }
  assert.equal(clients[0].game.phase, "over");
  assert.deepEqual(clients[0].game.points, clients[1].game.points);
  assert.equal(clients[0].game.winner, clients[1].game.winner);
  assert.ok(!clients[0].desync && !clients[1].desync);
});

test("the database refuses a move for someone else's seat, or a second one", async () => {
  const net = O.memoryDatabase();
  const ana = net.storeFor("a"), bo = net.storeFor("b");
  const m = await O.createMatch(ana, config(5));
  await O.joinMatch(bo, m.id);
  await assert.rejects(bo.insert("moves", { match_id: m.id, round: 1, seat: 1, kind: "plot", payload: {} }), /not your seat/);
  const c = new O.Client(ana, m, 1);
  c.game.phase = "plot";
  await c.lock();
  await assert.rejects(c.lock(), /already/);
});

test("online, pacts are only made between rivals", () => {
  const g = S.createGame({ seed: 3, seats: config(3).seats, council: true });
  g.online = true;
  assert.match(S.checkPact(g, 1, 2), /not made online/);
  assert.equal(S.checkPact(g, 2, 4), undefined);
});

test("neonStore speaks PostgREST with a bearer token", async () => {
  const calls = [];
  const fake = async (url, opt) => {
    calls.push({ url, opt });
    return { ok: true, status: 200, json: async () => (opt && opt.method === "POST" ? [Object.assign({ id: "x" }, JSON.parse(opt.body))] : [{ id: "x" }]) };
  };
  const st = O.neonStore("https://example.test/rest/v1/", () => "tok", fake);
  const row = await st.insert("moves", { round: 2 });
  assert.equal(row.round, 2);
  await st.select("moves", { match_id: "a b", round: 2 });
  assert.equal(calls[0].url, "https://example.test/rest/v1/moves");
  assert.equal(calls[0].opt.headers.Authorization, "Bearer tok");
  assert.equal(calls[0].opt.headers.Prefer, "return=representation");
  assert.equal(calls[1].url, "https://example.test/rest/v1/moves?match_id=eq.a%20b&round=eq.2");
  const dup = O.neonStore("https://e.test", () => "t", async () => ({ ok: false, status: 409, statusText: "Conflict", json: async () => ({ code: "23505", message: "duplicate key" }) }));
  await assert.rejects(dup.insert("seats", {}), (e) => e.duplicate === true);
});
