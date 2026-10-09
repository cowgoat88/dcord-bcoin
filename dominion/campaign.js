// DOOMSTAR: DOMINION — the campaign.
//
// A campaign is a run of seasons against the same rivals. Each season is an
// ordinary match on a new galaxy. Placing in a season earns campaign
// points; between seasons every seat drafts one legacy, a lasting edge it
// keeps for the rest of the campaign, and the seat furthest behind picks
// first. Grudges carry over at half strength. Pacts do not.
//
// The campaign record is plain data, so the page can keep it in the
// browser between visits.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) module.exports = factory(require("./sim.js"), require("./ai.js"));
  else root.DominionCampaign = factory(root.DominionSim, root.DominionAI);
})(typeof self !== "undefined" ? self : this, function (S, A) {
  "use strict";

  const SEASONS = 4;
  const PLACE_POINTS = [5, 3, 2, 1, 0, 0];
  const giveTech = (id) => (g, s) => { g.tech[s][id] = 0; };
  const LEGACIES = {
    veterans: { label: "Veterans", text: "Start every skirmish with Assault Doctrine.", apply: giveTech("assault1") },
    ramparts: { label: "Ramparts", text: "Start every skirmish with Hardpoints.", apply: giveTech("fortify1") },
    couriers: { label: "Couriers", text: "Start every skirmish with Ion Drives.", apply: giveTech("drives") },
    friends: { label: "Old Friends", text: "Start every skirmish with Envoys.", apply: giveTech("envoys") },
    warchest: { label: "War Chest", text: "Start every skirmish with 80 more credits.", apply: (g, s) => { g.credits[s] += 80; } },
    machine: { label: "Machine of State", text: "Start every skirmish with 3 more influence.", apply: (g, s) => { g.influence[s] += 3; } },
    army: { label: "Standing Army", text: "Your Command starts every skirmish with 25 more ships.",
      apply: (g, s) => { const c = g.nodes.find((n) => n.type === "command" && n.owner === s); if (c) c.garrison += 25; } },
    claim: { label: "Throne Claim", text: "Start every skirmish with the Doomstar half charged.",
      apply: (g, s) => { g.charge[s] = S.DOOM_CHARGE_NEEDED / 2; } }
  };
  const LEGACY_KEYS = Object.keys(LEGACIES);
  // What each personality reaches for first.
  const LEGACY_LEAN = {
    hawk: ["veterans", "army", "claim", "couriers"],
    turtle: ["ramparts", "army", "machine", "warchest"],
    trader: ["warchest", "friends", "machine", "couriers"],
    zealot: ["claim", "veterans", "machine", "army"]
  };

  function createCampaign(o) {
    const seed = o.seed | 0 || 1;
    const seats = o.seats.map((s, i) => ({
      faction: s.faction, ai: !!s.ai, name: s.name || null,
      // Fixed for the whole campaign, so a rival is the same commander
      // every season.
      personality: s.personality || (s.ai ? A.PERSONALITY_KEYS[(seed + i * 3) % A.PERSONALITY_KEYS.length] : null)
    }));
    const per = (v) => { const r = {}; seats.forEach((_, i) => { r[i + 1] = typeof v === "function" ? v() : v; }); return r; };
    return {
      v: 1, seed, seasons: o.seasons || SEASONS, season: 1, seats,
      points: per(0), legacies: per(() => []), grudge: per(() => ({})),
      results: [], draft: null, phase: "season", winner: null,
      // Season length and rival strength, the same every season. Only the
      // ones given, so the record stays plain JSON.
      rules: JSON.parse(JSON.stringify({ pointsToWin: o.pointsToWin, roundLimit: o.roundLimit, difficulty: o.difficulty, draft: o.draft, council: o.council, tech: o.tech }))
    };
  }

  function seasonSeed(c) { return ((c.seed * 31 + c.season * 7919) % 99991) + 1; }

  // The season's match, with everyone's legacies applied.
  function seasonGame(c) {
    const g = S.createGame(Object.assign({ seed: seasonSeed(c), seats: c.seats, draft: true, council: true }, c.rules || {}));
    for (const s of g.seats) {
      if (c.seats[s.id - 1].name) s.name = c.seats[s.id - 1].name;
      for (const k of c.legacies[s.id]) LEGACIES[k].apply(g, s.id);
      g.grudge[s.id] = Object.assign({}, c.grudge[s.id]);
    }
    g.campaign = { season: c.season, of: c.seasons };
    return g;
  }

  // The season is over: places, campaign points, grudges, then the legacy
  // draft or the campaign's end.
  function endSeason(c, g) {
    if (c.phase !== "season" || g.phase !== "over") return "The skirmish is not over.";
    const ranked = g.seats.slice().sort((a, b) => S.standing(g, b.id) - S.standing(g, a.id)).map((s) => s.id);
    const earned = {};
    ranked.forEach((id, i) => { earned[id] = PLACE_POINTS[i] || 0; c.points[id] += earned[id]; });
    c.results.push({ season: c.season, winner: g.winner, ranked, earned, points: Object.assign({}, g.points), rounds: g.round });
    for (const s of g.seats) {
      const carry = {};
      for (const k in g.grudge[s.id]) { const v = Math.round(g.grudge[s.id][k] * 50) / 100; if (v >= 0.3) carry[k] = v; }
      c.grudge[s.id] = carry;
    }
    if (c.season >= c.seasons) {
      c.phase = "over";
      c.winner = standings(c)[0];
      return undefined;
    }
    c.season += 1;
    c.phase = "legacy";
    // Furthest behind picks first; a tie goes to the worse last season.
    const last = {};
    ranked.forEach((id, i) => { last[id] = i; });
    const order = c.seats.map((_, i) => i + 1).sort((a, b) => c.points[a] - c.points[b] || last[b] - last[a]);
    c.draft = { order, picks: {} };
    return undefined;
  }
  // Campaign standings, best first: points, then the latest season's place.
  function standings(c) {
    const last = c.results.length ? c.results[c.results.length - 1].ranked : [];
    return c.seats.map((_, i) => i + 1).sort((a, b) => c.points[b] - c.points[a] || last.indexOf(a) - last.indexOf(b));
  }

  function legacyTurn(c) {
    if (c.phase !== "legacy") return null;
    return c.draft.order.find((id) => !c.draft.picks[id]) || null;
  }
  function legacyChoices(c, seat) {
    const taken = Object.values(c.draft ? c.draft.picks : {});
    return LEGACY_KEYS.filter((k) => taken.indexOf(k) === -1 && c.legacies[seat].indexOf(k) === -1);
  }
  function pickLegacy(c, seat, k) {
    if (c.phase !== "legacy") return "There is no legacy draft now.";
    if (legacyTurn(c) !== seat) return "It is not your pick.";
    if (legacyChoices(c, seat).indexOf(k) === -1) return "That legacy is not on offer.";
    c.draft.picks[seat] = k;
    c.legacies[seat].push(k);
    if (!legacyTurn(c)) { c.phase = "season"; c.draft = null; }
    return undefined;
  }
  // Rivals pick until it is a person's turn or the draft is over.
  function runLegacyDraft(c) {
    let guard = 0;
    while (c.phase === "legacy" && guard++ < 10) {
      const seat = legacyTurn(c);
      if (!c.seats[seat - 1].ai) return;
      const left = legacyChoices(c, seat);
      const lean = LEGACY_LEAN[c.seats[seat - 1].personality] || [];
      pickLegacy(c, seat, lean.find((k) => left.indexOf(k) !== -1) || left[0]);
    }
  }

  return {
    SEASONS, PLACE_POINTS, LEGACIES, LEGACY_KEYS,
    createCampaign, seasonGame, seasonSeed, endSeason, standings,
    legacyTurn, legacyChoices, pickLegacy, runLegacyDraft
  };
});
