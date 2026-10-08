// Run with: node --test dominion/campaign.test.js
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const S = require("./sim.js");
const A = require("./ai.js");
const C = require("./campaign.js");

const seats = (n) => Array.from({ length: n }, (_, i) => ({ ai: true, faction: S.FACTION_KEYS[i % S.FACTION_KEYS.length] }));
function playSeason(g) {
  // A person seat is played by the AI too.
  let guard = 0;
  while (g.phase !== "over" && guard++ < 40) {
    while (g.phase === "draft") { A.runDraft(g); if (g.phase === "draft") A.draftPick(g, S.draftTurn(g)); }
    A.planAll(g);
    for (const s of g.seats) if (!s.ai && !g.locked[s.id] && S.alive(g, s.id)) A.plan(g, s.id);
    S.beginResolve(g); S.runRound(g); S.drainEvents(g);
  }
  assert.equal(g.phase, "over");
}

test("a campaign runs its seasons: places score, legacies are drafted, a winner is named", () => {
  const c = C.createCampaign({ seed: 11, seats: seats(4), seasons: 3 });
  const personalities = c.seats.map((s) => s.personality);
  const seeds = new Set();
  for (let season = 1; season <= 3; season++) {
    assert.equal(c.phase, "season");
    const g = C.seasonGame(c);
    seeds.add(g.seed);
    assert.deepEqual(g.seats.map((s) => s.personality), personalities, "the same commanders every season");
    for (const s of g.seats) for (const k of c.legacies[s.id]) assert.ok(k in C.LEGACIES);
    playSeason(g);
    const before = Object.values(c.points).reduce((a, b) => a + b, 0);
    assert.equal(C.endSeason(c, g), undefined);
    assert.equal(Object.values(c.points).reduce((a, b) => a + b, 0) - before, C.PLACE_POINTS.slice(0, 4).reduce((a, b) => a + b, 0));
    assert.match(C.endSeason(c, g), /not over/, "a season is counted once");
    if (season < 3) {
      assert.equal(c.phase, "legacy");
      const first = C.legacyTurn(c);
      assert.equal(c.points[first], Math.min(...Object.values(c.points)), "furthest behind picks first");
      C.runLegacyDraft(c);
      assert.equal(c.phase, "season");
      const picked = c.seats.map((_, i) => c.legacies[i + 1][season - 1]);
      assert.equal(new Set(picked).size, 4, "each legacy once per draft");
    }
  }
  assert.equal(seeds.size, 3, "a new galaxy every season");
  assert.equal(c.phase, "over");
  assert.equal(c.winner, C.standings(c)[0]);
  assert.equal(c.results.length, 3);
});

test("legacies apply at the start of every season", () => {
  const c = C.createCampaign({ seed: 5, seats: [{ faction: "standard" }, { faction: "vanguard", ai: true }] });
  c.legacies[1] = ["veterans", "warchest", "machine", "army", "claim"];
  const g = C.seasonGame(c), plain = S.createGame({ seed: g.seed, seats: c.seats, draft: true, council: true });
  assert.ok(S.hasTech(g, 1, "assault1"), "a legacy technology counts as owned");
  assert.ok(S.assaultMult(g, 1) > S.assaultMult(plain, 1));
  assert.equal(S.techCost(g, 1, "assault1"), null);
  assert.ok(S.techCost(g, 1, "assault2") > 0, "and opens the next tier");
  assert.equal(g.credits[1], plain.credits[1] + 80);
  assert.equal(g.influence[1], plain.influence[1] + 3);
  const cmd = (x) => x.nodes.find((n) => n.type === "command" && n.owner === 1).garrison;
  assert.equal(cmd(g), cmd(plain) + 25);
  assert.equal(g.charge[1], S.DOOM_CHARGE_NEEDED / 2);
  assert.equal(g.credits[2], plain.credits[2], "only the seat that holds it");
});

test("a person picks their own legacy; rivals wait for it", () => {
  const c = C.createCampaign({ seed: 3, seats: [{ faction: "standard" }, { faction: "vanguard", ai: true }, { faction: "shock", ai: true }] });
  const g = C.seasonGame(c);
  playSeason(g);
  C.endSeason(c, g);
  C.runLegacyDraft(c);
  if (c.phase === "legacy") {
    assert.equal(C.legacyTurn(c), 1);
    assert.match(C.pickLegacy(c, 2, C.legacyChoices(c, 2)[0]), /not your pick/);
    assert.equal(C.pickLegacy(c, 1, C.legacyChoices(c, 1)[0]), undefined);
    C.runLegacyDraft(c);
  }
  assert.equal(c.phase, "season");
  assert.equal(c.legacies[1].length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(c)), c, "the record is plain data");
});

test("grudges carry into the next season at half strength", () => {
  const c = C.createCampaign({ seed: 3, seats: seats(3) });
  const g = C.seasonGame(c);
  playSeason(g);
  g.grudge[1][2] = 4;
  C.endSeason(c, g);
  assert.equal(c.grudge[1][2], 2);
  C.runLegacyDraft(c);
  assert.equal(C.seasonGame(c).grudge[1][2], 2);
});
