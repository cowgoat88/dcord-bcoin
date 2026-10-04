// Run with: node --test outpost/online.test.js
// Exercises the session protocol over an in-memory loopback — no
// networking, no browser, no PeerJS.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("./engine.js");
const O = require("./online.js");

function pair(opts) {
  const o = opts || {};
  const link = O.loopback();
  const hostGame = E.createGame({ seed: o.seed || 7, mapW: o.mapW || 1000, mapH: o.mapH || 640, humanFoe: true, layout: o.layout });
  hostGame.ai.timer = Infinity;              // no AI in an online match
  const received = [];
  const rejects = [];
  let guestGame = null;

  const host = O.createHost({ engine: E, game: hostGame, transport: link.a });
  let welcome = null;
  const guest = O.createGuest({
    engine: E, transport: link.b, doctrine: o.doctrine,
    onWelcome: (msg) => {
      welcome = msg;
      guestGame = E.createGame({ seed: msg.seed, mapW: msg.mapW, mapH: msg.mapH, layout: msg.layout });
      guestGame.ai.timer = Infinity;
      E.applySnapshot(guestGame, msg.snapshot);
    },
    onState: (snap) => { received.push(snap); if (guestGame) E.applySnapshot(guestGame, snap); },
    onReject: (err) => rejects.push(err)
  });
  link.b.fireOpen();
  return { link, host, guest, hostGame, get guestGame() { return guestGame; },
           get welcome() { return welcome; }, received, rejects };
}

test("a guest that says hello is welcomed and rebuilds the same board", () => {
  const s = pair();
  assert.ok(s.guestGame, "the guest must have built a game from the welcome");
  assert.equal(s.guestGame.seed, s.hostGame.seed);
  assert.equal(s.guestGame.nodes.length, s.hostGame.nodes.length);
  // The board is derived from the seed, never shipped — so it has to match.
  assert.deepEqual(
    s.guestGame.nodes.map((n) => [Math.round(n.x), Math.round(n.y), n.type, n.terrain]),
    s.hostGame.nodes.map((n) => [Math.round(n.x), Math.round(n.y), n.type, n.terrain])
  );
  assert.equal(s.host.hasGuest(), true);
  assert.equal(s.guest.seat, O.GUEST_SEAT);
});

test("the welcome carries the map layout, so a guest rebuilds the host's board", () => {
  // Seed + size alone would build the classic map on the guest whenever
  // the host chose another generator, and every lane and node would differ.
  for (const layout of [undefined, "classic", "spaced", "orbital", "sectors"]) {
    const s = pair({ layout, seed: 21, mapW: 560, mapH: 1100 });
    assert.equal(s.welcome.layout, layout || "classic");
    assert.equal(s.guestGame.layout, layout || "classic");
    assert.deepEqual(s.guestGame.nodes.map((n) => [n.x, n.y, n.type, n.terrain]),
      s.hostGame.nodes.map((n) => [n.x, n.y, n.type, n.terrain]));
    assert.deepEqual(s.guestGame.lanes, s.hostGame.lanes);
    assert.deepEqual(s.guestGame.rings, s.hostGame.rings);
  }
  // A host that predates layouts sends none: the guest must fall back to classic.
  const old = E.createGame({ seed: 21, mapW: 560, mapH: 1100 });
  const fromOld = E.createGame({ seed: 21, mapW: 560, mapH: 1100, layout: undefined });
  assert.deepEqual(fromOld.lanes, old.lanes);
});

test("the host's state reaches the guest verbatim", () => {
  const s = pair();
  for (let i = 0; i < 60 * 5; i++) E.step(s.hostGame, 1 / 60);
  s.host.pushNow();
  assert.ok(s.received.length > 0, "a snapshot must have been delivered");
  assert.equal(
    JSON.stringify(E.serializeState(s.guestGame)),
    JSON.stringify(E.serializeState(s.hostGame)),
    "the guest's state must match the host's exactly"
  );
});

test("a guest order is applied by the host and comes back in the snapshot", () => {
  const s = pair();
  const foe = E.nodesOf(s.hostGame, E.ENEMY)[0];   // the guest's own seat
  foe.garrison = 40;
  const target = E.neighbors(s.hostGame, foe.id)[0];
  s.host.pushNow();

  s.guest.sendOrder({ kind: "send", from: foe.id, to: target, frac: 0.5 });
  assert.equal(s.hostGame.fleets.length, 1, "the host must have applied the guest's order");
  assert.equal(s.hostGame.fleets[0].owner, E.ENEMY, "and credited it to the guest's seat");
  assert.equal(s.guestGame.fleets.length, 1, "the guest must see it in the snapshot that follows");
});

test("a guest cannot order the host's forces", () => {
  // The seat comes from the connection, never from the message.
  const s = pair();
  const hostNode = E.nodesOf(s.hostGame, E.PLAYER)[0];
  hostNode.garrison = 40;
  const target = E.neighbors(s.hostGame, hostNode.id)[0];
  s.guest.sendOrder({ kind: "send", from: hostNode.id, to: target, frac: 1 });
  assert.equal(s.hostGame.fleets.length, 0, "no fleet may be created from the host's position");
  assert.equal(Math.round(hostNode.garrison), 40, "and it must not lose units");
  assert.ok(s.rejects.length > 0, "the guest must be told why");
});

test("the guest never advances the simulation on its own", () => {
  // Divergence is impossible by construction: the guest only renders
  // whatever snapshot it was last handed.
  const s = pair();
  s.host.pushNow();
  const before = E.serializeState(s.guestGame);
  for (let i = 0; i < 60 * 3; i++) E.step(s.hostGame, 1 / 60);
  assert.equal(JSON.stringify(E.serializeState(s.guestGame)), JSON.stringify(before),
    "the guest's state must not move until a snapshot arrives");
  s.host.pushNow();
  assert.notEqual(JSON.stringify(E.serializeState(s.guestGame)), JSON.stringify(before));
});

test("every order type round-trips through the seat check", () => {
  const s = pair();
  const mine = E.nodesOf(s.hostGame, E.ENEMY)[0];
  s.hostGame.credits[E.ENEMY] = 5000;
  mine.garrison = 40;

  s.guest.sendOrder({ kind: "upgrade", id: mine.id });
  assert.equal(mine.level, 1, "upgrade");

  s.guest.sendOrder({ kind: "research", track: "assault" });
  assert.equal(E.techLevel(s.hostGame, E.ENEMY, "assault"), 1, "research");

  E.doomstarNode(s.hostGame).owner = E.ENEMY;
  s.hostGame.charge[E.ENEMY] = E.DOOM_CHARGE_NEEDED;
  s.guest.sendOrder({ kind: "fire" });
  assert.equal(s.hostGame.charge[E.ENEMY], 0, "fire");

  s.guest.sendOrder({ kind: "nonsense" });
  assert.ok(s.rejects.some((r) => /Unknown order/.test(r)), "an unknown order is rejected, not applied");
});

test("a mismatched protocol version is refused rather than misread", () => {
  const link = O.loopback();
  const game = E.createGame({ seed: 3 });
  const seen = [];
  link.b.onMessage((m) => seen.push(m));
  O.createHost({ engine: E, game: game, transport: link.a });
  link.b.send({ v: 999, type: "hello" });
  assert.ok(seen.some((m) => m.type === "reject" && m.error === "version-mismatch"));
});

test("a rejoin with the original token resumes; a stranger is refused", () => {
  const s = pair();
  const token = s.guest.getToken();
  assert.ok(token, "the first welcome must issue a token");

  // Same guest coming back after a refresh.
  const before = s.received.length;
  s.link.b.send({ v: O.PROTOCOL_VERSION, type: "hello", token: token });
  assert.equal(s.host.hasGuest(), true, "the original guest must be let back in");

  // Somebody else, while the seat is taken.
  const seen = [];
  s.link.b.onMessage((m) => seen.push(m));
  s.link.b.send({ v: O.PROTOCOL_VERSION, type: "hello", token: "someone-else" });
  assert.ok(seen.some((m) => m.type === "reject" && m.error === "room-full"),
    "a third party must be turned away while the room is occupied");
});

test("restarting hands the guest a new board to rebuild from", () => {
  const s = pair();
  const firstSeed = s.guestGame.seed;
  const fresh = E.createGame({ seed: firstSeed + 100, mapW: 1000, mapH: 640 });
  s.host.restart(fresh);
  assert.equal(s.guestGame.seed, firstSeed + 100, "the guest must rebuild on the new seed");
});

test("snapshots stay small enough to send many times a second", () => {
  const s = pair();
  for (let i = 0; i < 60 * 60; i++) E.step(s.hostGame, 1 / 60);
  const bytes = JSON.stringify(E.serializeState(s.hostGame)).length;
  assert.ok(bytes < 8000, "a snapshot must stay well under a datachannel frame, got " + bytes);
});

test("a guest brings its own doctrine, and a bogus one becomes Standard", () => {
  const s = pair({ doctrine: "shock" });
  assert.equal(E.doctrineOf(s.hostGame, O.GUEST_SEAT), "shock",
    "the host must adopt the doctrine the guest announced");
  assert.equal(s.welcome.doctrine[O.GUEST_SEAT], "shock",
    "and tell the guest what both sides are fighting under");

  const bogus = pair({ doctrine: "invincible" });
  assert.equal(E.doctrineOf(bogus.hostGame, O.GUEST_SEAT), "standard");
});

test("a rematch keeps the guest's doctrine", () => {
  const s = pair({ doctrine: "vanguard" });
  const fresh = E.createGame({ seed: 991, mapW: 1000, mapH: 640 });
  assert.notEqual(E.doctrineOf(fresh, O.GUEST_SEAT), "vanguard",
    "the fresh board must not already carry it, or this proves nothing");
  s.host.restart(fresh);
  assert.equal(E.doctrineOf(fresh, O.GUEST_SEAT), "vanguard");
  assert.equal(s.welcome.doctrine[O.GUEST_SEAT], "vanguard");
});

test("the guest's Doomstar is theirs to fire, not the host's to spend", () => {
  // Reported from a real match: online, the guest's weapon charges and
  // then discharges by itself, the FIRE button never lights, nothing
  // happens. The host simulates both sides, and its step loop fired
  // seat 2's weapon automatically the way it does against the AI -- so
  // the charge was always spent before the guest could see it full.
  const s = pair();
  const centre = s.hostGame.nodes.find((n) => n.type === "doomstar");
  centre.owner = 2;                                  // the guest holds it
  s.hostGame.charge[2] = E.DOOM_CHARGE_NEEDED;
  const victim = s.hostGame.nodes.find((n) => n.owner === 1 && n.type !== "doomstar");
  victim.garrison = 60;
  const before = victim.garrison;

  for (let i = 0; i < 180; i++) E.step(s.hostGame, 1 / 60);
  assert.equal(s.hostGame.charge[2], E.DOOM_CHARGE_NEEDED,
    "three seconds of simulation must not have spent it");

  s.host.tick(1 / 60);                               // push a snapshot
  assert.equal(E.canFire(s.guestGame, 2), true,
    "and the guest's own copy must agree the weapon is ready");

  s.guest.sendOrder({ kind: "fire", target: victim.id });
  assert.ok(s.hostGame.charge[2] < E.DOOM_CHARGE_NEEDED, "firing spends the charge");
  assert.ok(victim.garrison < before, "and the strike lands on what they aimed at");
  assert.equal(s.hostGame.stats[2].fired, 1, "it counts as theirs");
});
