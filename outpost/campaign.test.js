// Run with: node --test outpost/campaign.test.js
//
// The two scripted missions are puzzles with one intended solution each,
// and the engine tests cannot say whether the brief can actually be
// done. These play each one the way its hint describes and then play it
// the ways it is meant to punish. A scripted bot is evidence that the
// mission is solvable and that the shortcuts do not work; it says
// nothing about how hard a person finds it -- that wants play.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("./engine.js");
const C = require("./campaign.js");

const { PLAYER, ENEMY } = E;

test("every scripted convoy runs along lanes that exist", () => {
  for (const m of C.MISSIONS) {
    if (!m.script) continue;
    const g = E.createGame(C.optionsFor(m));
    for (const c of m.script.convoys || []) {
      assert.ok(E.areLinked(g, c.from, c.to), m.id + ": " + c.id + " needs a lane " + c.from + "-" + c.to);
      if (c.onward !== undefined) assert.ok(E.areLinked(g, c.to, c.onward), m.id + ": " + c.id + " has no lane onward");
      assert.equal(g.nodes[c.from].owner, ENEMY, m.id + ": " + c.id + " must start at an enemy depot");
      if (c.every) assert.ok(c.every > (c.dwell || 0) + 5, m.id + ": the next run must not overlap this one");
    }
    for (const d of m.script.dispatches || []) assert.ok(d.text && d.at >= 0, m.id + " dispatch needs text and a time");
    const names = g.nodes.map((n) => n.name).filter(Boolean);
    assert.equal(new Set(names).size, names.length, m.id + ": position names must be unique");
    if (m.objective.keep) for (const id of m.objective.keep) assert.ok(g.nodes[id] && g.nodes[id].owner === PLAYER, m.id + " keeps a position you start with");
    assert.equal(m.posture, "static", m.id + " runs its own traffic, so the opponent routine must stay out of it");
  }
});

// ---------------------------------------------------------------------
// The Waist
// ---------------------------------------------------------------------
// Positions, by index in the mission's map.
const W = { home: 0, doom: 1, gate: 2, yard: 3, east: 4, relays: [5, 6, 7], amine: 8, hub: 9 };
const ANNEX = [4, 5, 6, 8, 7];            // the order a person would take it in
function playWaist(opts) {
  opts = opts || {};
  const m = C.byId("meridian-yard");
  const g = E.createGame(C.optionsFor(m, !!opts.portrait));
  const N = (i) => g.nodes[i];
  const inFlight = (to) => g.fleets.some((f) => f.owner === PLAYER && f.to === to);
  let think = 0, strikes = 0, storms = 0;
  while (!g.winner && g.time < m.objective.seconds + 5) {
    E.step(g, 0.1);
    for (const ev of E.drainEvents(g)) if (ev.kind === "doomstar" && ev.owner === PLAYER && !ev.fizzled) strikes++;
    if (g.time < think) continue;
    think = g.time + 0.5;
    const yard = N(W.yard), gate = N(W.gate), home = N(W.home), hub = N(W.hub);
    // Anchorage feeds the Gatehouse.
    if (!opts.noFeed && home.owner === PLAYER && home.garrison > 22) E.sendFleet(g, W.home, W.gate, 0.45, PLAYER);
    // The freight timetable: the Yard is open when nothing is inbound,
    // docked or on its way out, and the next landing is a while off.
    const st = E.scriptStatus(g);
    const busy = st.some((s) => s.state !== "clear");
    const next = Math.min(...st.map((s) => (s.state === "clear" ? s.seconds : 0)));
    const annexLeft = !opts.noAnnex && ANNEX.some((i) => N(i).owner !== PLAYER);
    // Wanted force for the storm, from everything that could go.
    const sources = g.nodes.filter((n) => n.owner === PLAYER && n.type !== "doomstar" && n.id !== W.yard);
    const potential = sources.reduce((a, n) => a + Math.floor(n.garrison * 0.95), 0);
    const stormNeed = E.defenceOf(g, hub) * 1.25 + 8;
    const wantYard = annexLeft || (opts.brute ? potential > 50 : potential > stormNeed);
    // 1. Take the Yard when it opens.
    if (yard.owner !== PLAYER && wantYard && !busy && next > 5) {
      const need = Math.ceil(yard.garrison * 1.25) + 4;
      if (Math.floor(gate.garrison) >= need && !inFlight(W.yard)) E.sendFleet(g, W.gate, W.yard, Math.min(1, need / gate.garrison), PLAYER);
    }
    // 2. With the Yard ours, ferry across and take the Annex one position at a time.
    if (yard.owner === PLAYER && annexLeft) {
      const tgt = ANNEX.map(N).find((n) => n.owner !== PLAYER && !inFlight(n.id));
      if (tgt) {
        const need = tgt.garrison + 4;
        const anx = ANNEX.map(N).filter((n) => n.owner === PLAYER && E.areLinked(g, n.id, tgt.id)).sort((a, b) => b.garrison - a.garrison)[0];
        let have = 0; const send = [];
        if (anx && anx.garrison - 2 >= need) send.push([anx.id, Math.min(1, need / anx.garrison)]);
        else {
          for (const n of [gate, home]) {
            const give = Math.floor(n.garrison * (n.id === W.home ? 0.8 : 0.95));
            if (give >= 3 && E.findPath(g, n.id, tgt.id, PLAYER)) { send.push([n.id, give / n.garrison]); have += give; }
          }
          if (have < need) send.length = 0;
        }
        for (const [id, f] of send) E.sendFleet(g, id, tgt.id, Math.min(1, f), PLAYER);
      }
    }
    // 3. Fire when charged. The weapon needs no connection.
    if (!opts.noFire && E.canFire(g, PLAYER) && !g.doomShot) E.fireDoomstar(g, PLAYER, W.hub);
    // 4. Storm the Hub through an open Yard once the force clearly outweighs it
    // (or, brute-forcing, as soon as there is something to throw).
    if (yard.owner === PLAYER && !annexLeft && !st.some((s) => s.state === "inbound" || s.state === "leaving")) {
      const need = opts.brute ? 50 : stormNeed;
      let force = 0; const srcs = [];
      for (const n of sources) { const send = Math.floor(n.garrison * (n.id === W.home ? 0.7 : 0.95)); if (send >= 3 && E.findPath(g, n.id, W.hub, PLAYER)) { force += send; srcs.push([n.id, send / n.garrison]); } }
      if (force > need) { storms++; for (const [id, f] of srcs) E.sendFleet(g, id, W.hub, Math.min(1, f), PLAYER); }
    }
  }
  return { winner: g.winner, t: g.time, strikes, storms, hub: g.nodes[W.hub].garrison };
}

test("The Waist: the timetable, the Annex and the Doomstar win it", () => {
  const r = playWaist();
  assert.equal(r.winner, PLAYER, "the intended plan must win: " + JSON.stringify(r));
  assert.ok(r.strikes >= 5, "and it takes several strikes, not one: " + r.strikes);
  assert.ok(r.t > 150, "and it is not over in two and a half minutes: " + r.t.toFixed(0) + "s");
});

test("The Waist: timing the freight and throwing everything at the Hub does not work", () => {
  // Reported from play: with a big home economy the Hub fell to fleets
  // alone. Anchorage now has a Command, the Doomstar and a mine.
  const r = playWaist({ noFire: true, brute: true });
  assert.equal(r.winner, ENEMY, "fleets alone must not do it: " + JSON.stringify(r));
});

test("The Waist: the Hub cannot be stormed without first shooting it", () => {
  const r = playWaist({ noFire: true });
  assert.equal(r.winner, ENEMY);
  assert.ok(r.hub >= 440, "it is untouched: " + r.hub);
});

test("The Waist: without the Annex there is nothing to charge the weapon", () => {
  const r = playWaist({ noAnnex: true });
  assert.equal(r.winner, ENEMY);
  assert.equal(r.strikes, 0);
});

test("The Waist: the Annex keeps charging after the Yard has fallen again", () => {
  const m = C.byId("meridian-yard");
  const g = E.createGame(C.optionsFor(m));
  for (const i of [5, 6, 7]) { g.nodes[i].owner = PLAYER; g.nodes[i].garrison = 12; }
  E.computeSupply(g);
  assert.equal(g.nodes[5].inSupply, false, "the Annex is cut off from Anchorage");
  assert.equal(E.chargingRelays(g, PLAYER).length, 3, "and its Relays charge anyway");
  const before = g.charge[PLAYER];
  for (let t = 0; t < 10; t += 0.1) E.step(g, 0.1);
  assert.ok(g.charge[PLAYER] - before >= 8, "charge climbs without a connection: " + (g.charge[PLAYER] - before));
});

test("The Waist: standing at the Gatehouse and waiting loses to the clock", () => {
  const r = playWaist({ noFeed: true, noAnnex: true, noFire: true });
  assert.equal(r.winner, ENEMY);
});

// ---------------------------------------------------------------------
// Last Light
// ---------------------------------------------------------------------
const POST = { ridge: 4, mid: 5, deep: 6 };
function playLight(mode, opts) {
  opts = opts || {};
  const m = C.byId("last-light");
  const g = E.createGame(C.optionsFor(m));
  const N = (i) => g.nodes[i];
  let think = 0;
  while (!g.winner && g.time < m.objective.seconds + 10) {
    E.step(g, 0.1); E.drainEvents(g);
    if (mode === "idle" || g.time < think) continue;
    think = g.time + 0.5;
    const st = E.scriptStatus(g);
    // Answer the wave that is coming: reinforce the post it lands on.
    for (const c of st) {
      if (c.state !== "inbound" && !(c.state === "assembling" && c.seconds < 8)) continue;
      const post = N(c.nodeId);
      if (post.owner !== PLAYER) continue;
      // What the wave will be once the Array has had its say.
      const shot = !opts.noFire && g.doomShot && g.doomShot.targetId === c.fromId ? 26 : 0;
      const need = Math.max(0, c.strength - shot) / 1.25 + 4;
      let have = post.garrison + g.fleets.filter((f) => f.owner === PLAYER && f.to === post.id).reduce((s, f) => s + f.count, 0);
      if (have >= need) continue;
      const donors = g.nodes.filter((n) => n.owner === PLAYER && n.id !== post.id && n.type !== "doomstar" && E.findPath(g, n.id, post.id, PLAYER))
        .sort((a, b) => E.dist(a, post) - E.dist(b, post));
      for (const d of donors) {
        const give = Math.floor(d.garrison - (d.id === 0 ? 20 : 6));
        if (give < 3) continue;
        if (E.sendFleet(g, d.id, post.id, give / d.garrison, PLAYER)) continue;
        have += give;
        if (have >= need) break;
      }
    }
    if (mode !== "smart") continue;
    // Shoot the depot that is about to launch the biggest wave.
    if (!opts.noFire && E.canFire(g, PLAYER) && !g.doomShot) {
      // Late enough that the depot cannot refill, early enough that the
      // two-second lock lands before the wave leaves.
      const cand = st.filter((c) => c.state === "assembling" && c.seconds > 2.4 && c.seconds < 9 && N(c.fromId).owner === ENEMY)
        .sort((a, b) => a.seconds - b.seconds)[0];
      if (cand) E.fireDoomstar(g, PLAYER, cand.fromId);
    }
    // And take a depot once it has launched and is empty.
    for (const c of st) {
      const d = N(c.fromId);
      if (d.owner !== ENEMY || d.garrison > 18) continue;
      if (c.state === "assembling" && c.seconds < 12 && c.strength > 8) continue;
      // Not while its wave is still on the lane: a small fleet sent down
      // the lane meets the wave head-on and is gone.
      if (c.state === "inbound") continue;
      const post = N(c.nodeId);
      if (post.owner !== PLAYER) continue;
      const need = Math.ceil(d.garrison * 1.25) + 3;
      if (post.garrison - 6 >= need && !g.fleets.some((f) => f.owner === PLAYER && f.to === d.id)) E.sendFleet(g, post.id, d.id, Math.min(1, need / post.garrison), PLAYER);
    }
  }
  return { winner: g.winner, t: g.time, posts: [4, 5, 6].filter((i) => N(i).owner === PLAYER).length, depots: [7, 8, 9].filter((i) => N(i).owner === PLAYER).length, lost: [0, 1].filter((i) => N(i).owner !== PLAYER) };
}

test("Last Light: shooting the depots as they fill, and holding, wins it", () => {
  const r = playLight("smart");
  assert.equal(r.winner, PLAYER, JSON.stringify(r));
});

test("Last Light: doing nothing loses well before the relief arrives", () => {
  const r = playLight("idle");
  assert.equal(r.winner, ENEMY);
  assert.ok(r.t < 330, "it should not be a close thing: lost at " + r.t.toFixed(0));
});

test("Last Light: reinforcing alone is not enough, and neither is the weapon unused", () => {
  assert.equal(playLight("turtle").winner, ENEMY, "answering waves with garrisons alone must lose");
  assert.equal(playLight("smart", { noFire: true }).winner, ENEMY, "the Array has to be fired");
});

test("a mission turned for a portrait screen is the same mission", () => {
  for (const m of C.MISSIONS) {
    const a = E.createGame(C.optionsFor(m)), b = E.createGame(C.optionsFor(m, true));
    assert.equal(b.mapW, a.mapH); assert.equal(b.mapH, a.mapW);
    assert.deepEqual(b.lanes, a.lanes, m.id + ": same lanes");
    for (let i = 0; i < a.nodes.length; i++) {
      assert.equal(b.nodes[i].x, a.nodes[i].y);
      assert.equal(b.nodes[i].y, a.nodes[i].x);
      assert.equal(b.nodes[i].name, a.nodes[i].name);
      for (let j = i + 1; j < a.nodes.length; j++) {
        assert.ok(Math.abs(E.dist(a.nodes[i], a.nodes[j]) - E.dist(b.nodes[i], b.nodes[j])) < 1e-9, m.id + ": distances survive");
      }
    }
  }
  const r = playWaist({ portrait: true });
  assert.equal(r.winner, PLAYER, "and the intended plan wins it turned too");
});
