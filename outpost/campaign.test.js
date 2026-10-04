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
const W = { home: 0, doom: 1, foundry: 2, ore: 3, gate: 4, yard: 5, east: 6, afoundry: 10, hub: 11 };
function playWaist(opts) {
  opts = opts || {};
  const m = C.byId("meridian-yard");
  const g = E.createGame(C.optionsFor(m, !!opts.portrait));
  const N = (i) => g.nodes[i];
  const inFlight = (to) => g.fleets.some((f) => f.owner === PLAYER && f.to === to);
  let think = 0;
  while (!g.winner && g.time < m.objective.seconds + 5) {
    E.step(g, 0.1); E.drainEvents(g);
    if (g.time < think) continue;
    think = g.time + 0.5;
    const yard = N(W.yard), gate = N(W.gate);
    if (!opts.noFeed) for (const id of [W.home, W.foundry, W.ore]) {
      const n = N(id);
      if (n.owner === PLAYER && n.garrison > (id === W.home ? 22 : 10)) E.sendFleet(g, id, W.gate, id === W.home ? 0.4 : 0.8, PLAYER);
    }
    // The Yard is open when nothing is inbound or docked.
    const st = E.scriptStatus(g);
    const busy = st.some((s) => s.state === "inbound" || s.state === "docked");
    const next = Math.min(...st.map((s) => (s.state === "clear" ? s.seconds : 0)));
    if (yard.owner !== PLAYER && !busy && next > 4) {
      const need = Math.ceil(yard.garrison * 1.25) + 4;
      if (Math.floor(gate.garrison) >= need && !inFlight(W.yard)) E.sendFleet(g, W.gate, W.yard, Math.min(1, need / gate.garrison), PLAYER);
    }
    if (yard.owner === PLAYER && !opts.noAnnex && N(W.east).owner !== PLAYER && gate.garrison >= 24 && !inFlight(W.east)) E.sendFleet(g, W.gate, W.east, 1, PLAYER);
    if (N(W.east).owner === PLAYER && !opts.noAnnex) {
      for (const tgt of [W.afoundry, 7, 8, 9]) {
        const t = N(tgt);
        if (t.owner === PLAYER || inFlight(tgt)) continue;
        const src = [W.east, W.afoundry, 7, 8, 9].map(N).filter((n) => n.owner === PLAYER && n.id !== tgt && E.areLinked(g, n.id, tgt)).sort((a, b) => b.garrison - a.garrison)[0];
        if (src && src.garrison >= t.garrison + 4) E.sendFleet(g, src.id, tgt, 1, PLAYER);
      }
    }
    if (!opts.noFire && E.canFire(g, PLAYER) && !g.doomShot) E.fireDoomstar(g, PLAYER, W.hub);
    // Storm the Hub through an open Yard once the force clearly outweighs it.
    if (yard.owner === PLAYER) {
      const hub = N(W.hub);
      let force = 0; const srcs = [];
      for (const n of g.nodes) {
        if (n.owner !== PLAYER || n.type === "doomstar" || n.id === W.yard) continue;
        const send = Math.floor(n.garrison * (n.id === W.home ? 0.7 : 0.95));
        if (send >= 3) { force += send; srcs.push([n.id, send / n.garrison]); }
      }
      if (force > E.defenceOf(g, hub) * 1.25 + 8) for (const [id, f] of srcs) E.sendFleet(g, id, W.hub, Math.min(1, f), PLAYER);
    }
  }
  return { winner: g.winner, t: g.time, strikes: g.stats[PLAYER].fired, hub: g.nodes[W.hub].garrison };
}

test("The Waist: the timetable, the Annex and the Doomstar win it", () => {
  const r = playWaist();
  assert.equal(r.winner, PLAYER, "the intended plan must win: " + JSON.stringify(r));
  assert.ok(r.strikes >= 3, "and it takes several strikes, not one: " + r.strikes);
  assert.ok(r.t > 120, "and it is not over in two minutes: " + r.t.toFixed(0) + "s");
});

test("The Waist: without the Doomstar the Hub cannot be broken", () => {
  const r = playWaist({ noFire: true });
  assert.equal(r.winner, ENEMY, "fleets alone must not do it");
  assert.ok(r.hub >= 230, "the Hub is untouched: " + r.hub);
});

test("The Waist: without the Annex there is nothing to charge the weapon", () => {
  const r = playWaist({ noAnnex: true });
  assert.equal(r.winner, ENEMY);
  assert.equal(r.strikes, 0);
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
      const need = c.strength / 1.25 + 4;
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
      const cand = st.filter((c) => c.state === "assembling" && c.seconds < 25 && N(c.fromId).owner === ENEMY)
        .sort((a, b) => b.strength - a.strength)[0];
      if (cand) E.fireDoomstar(g, PLAYER, cand.fromId);
    }
    // And take a depot once it has launched and is empty.
    for (const c of st) {
      const d = N(c.fromId);
      if (d.owner !== ENEMY || d.garrison > 18) continue;
      if (c.state === "assembling" && c.seconds < 12 && c.strength > 8) continue;
      const post = N(c.nodeId);
      if (post.owner !== PLAYER) continue;
      const need = Math.ceil(d.garrison * 1.25) + 3;
      if (post.garrison - 6 >= need && !g.fleets.some((f) => f.owner === PLAYER && f.to === d.id)) E.sendFleet(g, post.id, d.id, Math.min(1, need / post.garrison), PLAYER);
    }
  }
  return { winner: g.winner, t: g.time };
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
