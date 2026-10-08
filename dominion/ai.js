// DOOMSTAR: DOMINION — the rival commanders.
//
// An AI seat plans its round the way a person does: against the frozen
// board, with the same command points and the same order list. It never
// acts during a resolve. That keeps it honest (it cannot react faster than
// you) and it keeps the forecast meaningful.
//
// Planning order, best first, until command points run out:
//   1. fire the Doomstar if it can
//   2. defend what is about to fall: dig in, or have a neighbour support it
//   3. attack the best target it can take, with supporting positions
//      lending strength instead of flying in
//   4. spend credits: research, then upgrades
//   5. move spare garrisons from the rear to the front
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./sim.js"));
  else root.DominionAI = factory(root.DominionSim);
})(typeof self !== "undefined" ? self : this, function (S) {
  "use strict";
  const NEUTRAL = S.NEUTRAL;

  // How much a position is worth to take, before its defence is counted.
  const VALUE = { command: 3.0, factory: 2.0, mine: 1.4, relay: 1.6, doomstar: 3.2 };

  // Personalities nudge the same plan: how much margin before committing,
  // how much it values the Throne, how readily it digs in.
  const PERSONALITIES = {
    hawk:   { margin: 1.10, throne: 2.0, hold: 0.6, send: 0.75, label: "Hawk" },
    turtle: { margin: 1.45, throne: 1.0, hold: 1.4, send: 0.60, label: "Turtle" },
    trader: { margin: 1.30, throne: 1.2, hold: 1.0, send: 0.65, label: "Trader" },
    zealot: { margin: 1.20, throne: 3.0, hold: 0.9, send: 0.70, label: "Zealot" }
  };
  const PERSONALITY_KEYS = Object.keys(PERSONALITIES);

  function personalityOf(game, seat) {
    const s = game.seatById[seat];
    return PERSONALITIES[s && s.personality] || PERSONALITIES[PERSONALITY_KEYS[(game.seed + seat) % PERSONALITY_KEYS.length]];
  }

  function cpLeft(game, seat) { return S.commandPoints(game, seat) - S.cpUsed(game, seat); }
  function hostile(seat, n) { return n.owner !== seat && n.owner !== NEUTRAL; }

  // Strongest single-round threat to a position: every hostile neighbour
  // sending most of its garrison, at its own assault strength.
  function threatTo(game, seat, node) {
    let t = 0;
    for (const id of S.neighbors(game, node.id)) {
      const n = game.nodes[id];
      if (hostile(seat, n)) t += n.garrison * 0.8 * S.assaultMult(game, n.owner);
    }
    return t;
  }

  function plan(game, seat) {
    const P = personalityOf(game, seat);
    const N = (id) => game.nodes[id];
    const busy = new Set();                 // positions already given an order this round
    const add = (o) => {
      if (cpLeft(game, seat) <= 0) return false;
      if (S.addOrder(game, seat, o)) return false;
      if (o.from !== undefined) busy.add(o.from);
      if (o.at !== undefined && o.kind === "hold") busy.add(o.at);
      return true;
    };
    // Every list is walked starting from this seat's own sector and going
    // round. Walking by node id instead broke ties toward low-numbered
    // sectors for every seat at once, so seats 1 and 2 were everybody's
    // first choice and won 11 of 40 four-seat matches between them.
    const home = (game.nodes.find((n) => n.type === "command" && n.owner === seat) || {}).sector;
    const nSec = game.seats.length;
    const rel = (n) => (n.sector < 0 ? -1 : ((n.sector - (home || 0)) % nSec + nSec) % nSec);
    const ring = game.nodes.slice().sort((a, b) => rel(a) - rel(b) || a.id - b.id);
    const mine = () => ring.filter((n) => n.owner === seat);

    // 1. The weapon.
    if (S.canFire(game, seat)) {
      const tgt = ring.filter((n) => hostile(seat, n))
        .sort((a, b) => b.garrison - a.garrison)[0];
      if (tgt) add({ kind: "fire", target: tgt.id });
    }

    // 2. Defence.
    const endangered = mine()
      .map((n) => ({ n, threat: threatTo(game, seat, n), def: S.defenceOf(game, n) }))
      .filter((x) => x.threat > x.def)
      .sort((a, b) => (VALUE[b.n.type] - VALUE[a.n.type]) || (b.threat - a.threat));
    for (const e of endangered.slice(0, 2)) {
      if (cpLeft(game, seat) <= 1) break;
      if (e.threat < e.def * S.HOLD_BONUS * P.hold + 1 || e.n.type === "command") add({ kind: "hold", at: e.n.id });
      const helper = S.neighbors(game, e.n.id).map(N)
        .filter((h) => h.owner === seat && !busy.has(h.id) && h.garrison >= 8)
        .sort((a, b) => b.garrison - a.garrison)[0];
      if (helper) add({ kind: "support", from: helper.id, to: e.n.id });
    }

    // 3. Attack: the best target this round, taken by everything that can
    // reach it together, plus support from positions next to it.
    for (let tries = 0; tries < 2 && cpLeft(game, seat) > 0; tries++) {
      let best = null;
      for (const t of ring) {
        if (t.owner === seat) continue;
        const sources = mine()
          .filter((s) => !busy.has(s.id) && s.garrison >= 8 && S.findPath(game, s.id, t.id, seat))
          .map((s) => ({ s, path: S.findPath(game, s.id, t.id, seat) }))
          .map((x) => Object.assign(x, { eta: S.pathTime(game, x.path, seat) }))
          .sort((a, b) => a.eta - b.eta);
        if (!sources.length) continue;
        // Sources that land within the coalescing window of the first fight
        // as one. Later ones still count, at a discount: damage done to a
        // defender stays done, but the defender grows in between.
        const first = sources[0].eta;
        const wave = sources.filter((x) => x.eta <= first + 4).slice(0, Math.max(1, cpLeft(game, seat) - 1));
        const supporters = S.neighbors(game, t.id).map(N)
          .filter((h) => h.owner === seat && !busy.has(h.id) && wave.every((w) => w.s.id !== h.id) && h.garrison >= 6);
        const am = S.assaultMult(game, seat);
        const force = wave.reduce((a, w) => a + Math.floor(w.s.garrison * P.send) * (w.eta <= first + 0.9 ? 1 : 0.8), 0) * am +
          supporters.slice(0, 1).reduce((a, h) => a + h.garrison * S.SUPPORT_SHARE * am, 0);
        const st = S.nodeStats(t, game);
        let need = S.defenceOf(game, t);
        if (t.owner !== NEUTRAL) {
          need += Math.min(st.cap - t.garrison, st.unitRate * first) * S.DEFENDER_EDGE * S.fortifyMult(game, t.owner);
          // A rival's neighbours may support it.
          for (const id of S.neighbors(game, t.id)) {
            const h = N(id);
            if (h.owner === t.owner) need += h.garrison * S.SUPPORT_SHARE * 0.5 * S.DEFENDER_EDGE;
          }
        }
        need *= P.margin;
        if (force <= need) continue;
        let score = VALUE[t.type] / (need + 6);
        if (t.type === "doomstar") score *= P.throne;
        if (t.owner !== NEUTRAL) {
          // Hitting the leader is worth more; hitting a weak neighbour is cheap.
          // Only a real leader: a tie is nobody, or seat 1 would be "the
          // leader" every opening and get ganged up on for its seat number.
          const order = game.seats.slice().sort((a, b) => S.standing(game, b.id) - S.standing(game, a.id));
          const lead = order[0], second = order[1];
          if (lead && second && lead.id === t.owner && lead.id !== seat &&
              game.points[lead.id] > game.points[second.id]) score *= 1.4;
        }
        if (!best || score > best.score) best = { score, t, wave, supporters };
      }
      if (!best) break;
      for (const w of best.wave) add({ kind: "send", from: w.s.id, to: best.t.id, frac: P.send });
      const h = best.supporters[0];
      if (h) add({ kind: "support", from: h.id, to: best.t.id });
    }

    // 4. Spend.
    const tracks = ["assault", "fortify"].filter((tr) => S.techCost(game, seat, tr) !== null)
      .sort((a, b) => S.techCost(game, seat, a) - S.techCost(game, seat, b));
    if (tracks.length && S.spendable(game, seat) >= S.techCost(game, seat, tracks[0]) * 1.1) add({ kind: "research", track: tracks[0] });
    const up = mine().filter((n) => n.level < S.MAX_LEVEL && (n.type === "command" || n.type === "factory"))
      .sort((a, b) => a.level - b.level)[0];
    if (up && S.spendable(game, seat) >= S.upgradeCost(up.level) * 1.3) add({ kind: "upgrade", at: up.id });

    // 5. Bring the rear forward.
    const front = (n) => S.neighbors(game, n.id).some((id) => N(id).owner !== seat);
    const rear = mine().filter((n) => !busy.has(n.id) && !front(n) && n.garrison >= 16)
      .sort((a, b) => b.garrison - a.garrison);
    for (const r of rear) {
      if (cpLeft(game, seat) <= 0) break;
      const dest = mine().filter((n) => front(n) && S.findPath(game, r.id, n.id, seat))
        .sort((a, b) => threatTo(game, seat, b) - threatTo(game, seat, a) || S.dist(r, a) - S.dist(r, b))[0];
      if (dest) add({ kind: "send", from: r.id, to: dest.id, frac: 0.6 });
    }
    S.lockOrders(game, seat);
    return game.orders[seat];
  }

  // Plot every AI seat that has not locked.
  function planAll(game) {
    for (const s of game.seats) {
      if (s.ai && !game.locked[s.id] && S.alive(game, s.id)) plan(game, s.id);
    }
  }

  return { plan, planAll, PERSONALITIES, PERSONALITY_KEYS, personalityOf, threatTo };
});
