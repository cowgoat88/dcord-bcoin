// Run with: node --test city-manager/engine.test.js
// No dependencies — uses Node's built-in test runner and assert module.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("./engine.js");

function buildRoadRow(game, y, x0, x1) {
  for (let x = x0; x <= x1; x++) {
    const rejection = E.placeTile(game, x, y, "road");
    assert.equal(rejection, undefined, `road placement at ${x},${y} should succeed`);
  }
}

function runTicks(game, n, onProgress) {
  for (let i = 0; i < n; i++) E.simTick(game, onProgress);
}

// Places a road row, then completes it by running ticks (roads need 1
// tick and 1 lumber each — startup stock covers this comfortably).
function buildAndFinishRoadRow(game, y, x0, x1) {
  buildRoadRow(game, y, x0, x1);
  runTicks(game, 1);
}

test("placeTile rejects an occupied tile until bulldozed", () => {
  const game = E.createGame();
  assert.equal(E.placeTile(game, 5, 5, "road"), undefined);
  const rejection = E.placeTile(game, 5, 5, "res");
  assert.equal(rejection, "Bulldoze that tile first.");
  assert.equal(game.board[5][5].type, "road", "original tile must be untouched by the rejected placement");

  assert.equal(E.placeTile(game, 5, 5, "bulldoze"), undefined);
  assert.equal(game.board[5][5].type, "empty");
  assert.equal(E.placeTile(game, 5, 5, "res"), undefined, "placement now succeeds on the cleared tile");
});

test("placeTile deducts money and rejects when funds are insufficient", () => {
  const game = E.createGame();
  const before = game.money;
  E.placeTile(game, 1, 1, "road");
  assert.equal(game.money, before - E.BUILD.road.cost);

  game.money = 1;
  const rejection = E.placeTile(game, 2, 2, "power");
  assert.equal(rejection, "Not enough money.");
  assert.equal(game.board[2][2].type, "empty", "failed placement must not create a site");
});

test("a placed tile starts as an unbuilt site, not immediately functional", () => {
  const game = E.createGame();
  E.placeTile(game, 3, 3, "road");
  const t = game.board[3][3];
  assert.equal(t.status, "site");
  assert.equal(t.progress, 0);
  assert.equal(E.isBuiltRoad(game, 3, 3), false, "an unbuilt road must not count as a road yet");
});

test("construction completes after its required number of ticks given enough stock", () => {
  const game = E.createGame();
  E.placeTile(game, 3, 3, "road"); // 1 tick, 1 lumber
  E.simTick(game);
  assert.equal(game.board[3][3].status, "built");
  assert.equal(E.isBuiltRoad(game, 3, 3), true);

  E.placeTile(game, 4, 4, "park"); // 2 ticks, 3 lumber
  E.simTick(game);
  assert.equal(game.board[4][4].status, "site", "park needs a 2nd tick");
  E.simTick(game);
  assert.equal(game.board[4][4].status, "built");
});

test("construction stalls (without consuming stock) when materials run short", () => {
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 0, concrete: 0 });
  // Power Plant's per-tick need (2.5 lumber, 3.75 concrete) exceeds even
  // EMERGENCY_TRICKLE, so this must genuinely still stall — a cheap build
  // like a road would now succeed immediately off the trickle alone,
  // since production runs before construction each tick.
  E.placeTile(game, 3, 3, "power");
  E.simTick(game);
  const t = game.board[3][3];
  assert.equal(t.status, "site");
  assert.equal(t.stalled, true);
  assert.equal(t.progress, 0);
  // Stock ends the tick at EMERGENCY_TRICKLE, not 0 — with zero built
  // Lumber Yards/Quarries that safety-net trickle applies regardless of
  // the stalled site; it's independent of "did construction consume it".
  assert.equal(game.stock.lumber, E.EMERGENCY_TRICKLE, "a stalled site must not partially consume stock");
  assert.equal(game.stock.concrete, E.EMERGENCY_TRICKLE);
});

test("Lumber Yards/Quarries never deadlock even when many builds start at once", () => {
  // This reproduces the exact scenario that used to freeze the economy at
  // zero production forever: a full slate of simultaneous construction
  // draining the starting stockpile before the yard/quarry could finish.
  const game = E.createGame();
  buildRoadRow(game, 10, 0, 9);
  E.placeTile(game, 0, 9, "lumber");
  E.placeTile(game, 1, 9, "quarry");
  E.placeTile(game, 2, 9, "power");
  E.placeTile(game, 4, 9, "res");
  E.placeTile(game, 5, 9, "res");
  E.placeTile(game, 6, 9, "com");
  E.placeTile(game, 7, 9, "ind");

  runTicks(game, 30);

  // game.board is indexed [y][x]; these tiles were placed at (x=0,y=9) and (x=1,y=9).
  assert.equal(game.board[9][0].status, "built", "Lumber Yard must complete despite competing simultaneous construction");
  assert.equal(game.board[9][1].status, "built", "Quarry must complete despite competing simultaneous construction");
  assert.ok(game.stock.lumber > 0 || game.stock.concrete > 0, "stock must be flowing again, not frozen at a starved floor");
});

test("RCI bootstraps from zero: a built, powered, road-adjacent, fed res zone eventually grows", () => {
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 200, concrete: 200 }); // isolate RCI growth from the material economy, covered separately above
  buildAndFinishRoadRow(game, 10, 0, 5);
  E.placeTile(game, 2, 9, "power");
  E.placeTile(game, 3, 9, "res");
  E.placeTile(game, 4, 9, "farm"); // food is required to grow past level 0 now
  runTicks(game, 8); // finish power (8 ticks), res (3 ticks), and farm (3 ticks)
  assert.equal(game.board[9][2].status, "built");
  assert.equal(game.board[9][3].status, "built");
  assert.equal(game.board[9][4].status, "built");

  assert.ok(game.demand.res > 0, "res demand must be positive at population=0/jobs=0 so growth can start (regression: jobs||1 fallback)");

  let grew = false;
  for (let i = 0; i < 200 && !grew; i++) {
    E.simTick(game);
    if (game.board[9][3].level > 0) grew = true;
  }
  assert.ok(grew, "a built, powered, road-adjacent res zone must eventually level up from demand alone");
  assert.ok(game.population > 0, "recomputeTotals must reflect the grown zone's population");
});

test("a zone only grows once built, powered, and road-adjacent — not merely placed", () => {
  const game = E.createGame();
  // No power plant, no road: res zone sits at level 0 forever regardless of demand.
  E.placeTile(game, 3, 3, "res");
  runTicks(game, 50);
  assert.equal(game.board[3][3].level, 0, "an unpowered, unconnected zone must never grow");
  assert.equal(game.population, 0);
});

test("computePower marks tiles within radius of a built power plant only", () => {
  const game = E.createGame();
  E.placeTile(game, 10, 10, "power");
  E.computePower(game);
  assert.equal(game.board[10][10].powered, false, "still under construction, must not power anything yet");

  // Isolate the radius math from the material economy (covered by its own
  // test above) by marking the plant built directly rather than running
  // out the full 8-tick/30-concrete construction.
  game.board[10][10].status = "built";
  E.computePower(game);
  assert.equal(game.board[10][10 + E.POWER_RADIUS].powered, true, "in range");
  assert.equal(game.board[10][10 + E.POWER_RADIUS + 1].powered, false, "just outside range");
});

test("recomputeTotals counts only built zones toward population and jobs", () => {
  const game = E.createGame();
  E.placeTile(game, 1, 1, "res");
  E.recomputeTotals(game);
  assert.equal(game.population, 0, "an unbuilt site contributes nothing");

  game.board[1][1].status = "built";
  game.board[1][1].level = 2;
  E.recomputeTotals(game);
  assert.equal(game.population, 2 * E.CAP_PER_LEVEL);
});

test("bulldoze clears a tile and never rejects for occupancy", () => {
  const game = E.createGame();
  E.placeTile(game, 6, 6, "quarry");
  assert.equal(E.placeTile(game, 6, 6, "bulldoze"), undefined);
  assert.equal(game.board[6][6].type, "empty");
});

test("simTick's economy applies upkeep only to built tiles and advances the day counter", () => {
  const game = E.createGame();
  const startDay = game.day;
  E.placeTile(game, 1, 1, "road"); // still a site this tick, no upkeep yet
  E.simTick(game);
  assert.equal(game.day, startDay + 1);
  assert.equal(game.board[1][1].status, "built");
  // With nothing else built, net for this tick reflects zero income and
  // exactly two charges — the single now-built road's upkeep plus the
  // administrative cost of a one-tile city — never a mystery charge for
  // the site tick before it completed.
  const expected = -(E.UPKEEP.road + E.ADMIN_COST_PER_TILE * Math.pow(1, E.ADMIN_SCALING));
  assert.ok(game.lastNet <= 0);
  assert.equal(game.lastNet, Math.round(expected));
  assert.equal(game.builtTiles, 1, "only the finished road counts toward the admin footprint");
});

test("raw material stock never exceeds its cap even with surplus production", () => {
  const game = E.createGame();
  Object.assign(game.stock, { lumber: game.stock.lumberCap - 1, concrete: 0 });
  game.board[5][5] = { type: "lumber", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  runTicks(game, 10);
  assert.equal(game.stock.lumber, game.stock.lumberCap, "production must clamp at the cap, not exceed it");
});

test("a built Warehouse raises every storage cap", () => {
  const game = E.createGame();
  const baseCap = game.stock.lumberCap;
  E.placeTile(game, 8, 8, "warehouse");
  Object.assign(game.stock, { lumber: 1000, concrete: 1000 }); // isolate cap effect from the material economy
  runTicks(game, E.BUILD.warehouse.ticks);
  assert.equal(game.board[8][8].status, "built");
  E.recomputeCaps(game);
  assert.equal(game.stock.lumberCap, baseCap + E.WAREHOUSE_BONUS.lumber);
  assert.equal(game.stock.concreteCap, E.STORAGE_BASE.concrete + E.WAREHOUSE_BONUS.concrete);
  assert.equal(game.stock.goodsCap, E.STORAGE_BASE.goods + E.WAREHOUSE_BONUS.goods);
});

test("a built, leveled Industrial zone converts raw materials into capped Goods", () => {
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 50, concrete: 50, goods: 0 });
  game.board[5][5] = { type: "ind", status: "built", level: 2, powered: false, upgradeLevel: 0, upgrading: null };
  // Enough residents to fully staff those 2 levels of Industrial jobs —
  // without them staffing is 0 and the zone correctly produces nothing,
  // which would make this test pass for the wrong reason.
  game.board[5][8] = { type: "res", status: "built", level: 2, powered: false, upgradeLevel: 0, upgrading: null };
  E.simTick(game);
  assert.equal(E.staffingRatio(game), 1, "setup: Industrial must be fully staffed here");
  const expectedInput = 2 * E.IND_INPUT_PER_LEVEL;
  const expectedOutput = 2 * E.IND_OUTPUT_PER_LEVEL;
  // No Lumber Yard/Quarry exists in this fixture, so EMERGENCY_TRICKLE
  // also adds back in on top of what Industrial consumed.
  assert.equal(game.stock.lumber, 50 - expectedInput + E.EMERGENCY_TRICKLE);
  assert.equal(game.stock.concrete, 50 - expectedInput + E.EMERGENCY_TRICKLE);
  // With zero warehouses, export capacity is just the flat base rate.
  assert.equal(game.stock.goods, Math.max(0, expectedOutput - E.GOODS_EXPORT_BASE));
});

test("Industrial goods output throttles to zero once Goods storage is full, without wasting input", () => {
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 50, concrete: 50, goods: game.stock.goodsCap });
  game.board[5][5] = { type: "ind", status: "built", level: 3, powered: false, upgradeLevel: 0, upgrading: null };
  // Fully staffed, so the throttle under test is Goods storage — not a
  // lack of workers silently zeroing output.
  game.board[5][8] = { type: "res", status: "built", level: 3, powered: false, upgradeLevel: 0, upgrading: null };
  const lumberBefore = game.stock.lumber;
  E.simTick(game);
  assert.equal(E.staffingRatio(game), 1, "setup: Industrial must be fully staffed here");
  // Only a little export capacity opens up Goods room for that tick (no
  // warehouses here, so just GOODS_EXPORT_BASE), so consumption must be
  // near zero, never the full per-level want.
  assert.ok(game.stock.lumber > lumberBefore - 0.5, "full Goods storage must not let industry burn raw material for nothing");
});

test("exported Goods convert to income at GOODS_PRICE", () => {
  const game = E.createGame();
  Object.assign(game.stock, { goods: E.GOODS_EXPORT_BASE * 2 });
  E.simTick(game);
  assert.ok(game.lastNet >= E.GOODS_EXPORT_BASE * E.GOODS_PRICE - 1, "export income must show up in the day's net");
});

test("export capacity scales with built Warehouses, not just the flat base rate", () => {
  const game = E.createGame();
  assert.equal(E.effectiveExportRate(game), E.GOODS_EXPORT_BASE);
  game.warehouses = 2;
  assert.equal(E.effectiveExportRate(game), E.GOODS_EXPORT_BASE + 2 * E.GOODS_EXPORT_PER_WAREHOUSE);
});

test("tax income is a minor trickle relative to Goods export, not a viable strategy alone", () => {
  // Regression guard for the "too easy, just tax" complaint: a sizeable
  // city's tax income must stay well under what a modest export operation
  // brings in, so export/production is doing the economic heavy lifting.
  const game = E.createGame();
  const taxIncomeAt100Pop = 100 * E.TAX.res;
  const exportIncomeWithOneWarehouse = (E.GOODS_EXPORT_BASE + E.GOODS_EXPORT_PER_WAREHOUSE) * E.GOODS_PRICE;
  assert.ok(taxIncomeAt100Pop < exportIncomeWithOneWarehouse,
    "100 population's res tax must not out-earn one warehouse's worth of export income");
});

test("hasRoadService allows building within radius, not just directly adjacent", () => {
  const game = E.createGame();
  buildAndFinishRoadRow(game, 10, 10, 10); // single built road tile at (10,10)
  assert.equal(E.hasRoadService(game, 10 + E.ROAD_BASE_RADIUS, 10), true, "within base radius");
  assert.equal(E.hasRoadService(game, 10 + E.ROAD_BASE_RADIUS + 1, 10), false, "just outside base radius");
});

test("upgrading a road extends its service radius", () => {
  const game = E.createGame();
  buildAndFinishRoadRow(game, 10, 10, 10);
  const farX = 10 + E.ROAD_BASE_RADIUS + E.ROAD_UPGRADE_STEP;
  assert.equal(E.hasRoadService(game, farX, 10), false, "beyond base radius before upgrading");

  game.money = 100000;
  Object.assign(game.stock, { lumber: 1000, concrete: 1000 });
  assert.equal(E.startUpgrade(game, 10, 10), undefined);
  runTicks(game, E.upgradeCost(0).ticks);
  assert.equal(game.board[10][10].upgradeLevel, 1);
  assert.equal(E.hasRoadService(game, farX, 10), true, "reachable once the road's radius grows with its upgrade tier");
});

test("countClusterNeighbors counts only built same-type neighbors", () => {
  // Uses newSite() so the site tile has real construction bookkeeping —
  // this game is never ticked, just read directly.
  const game = E.createGame();
  game.board[5][5] = { type: "lumber", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  game.board[5][6] = { type: "lumber", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  game.board[5][4] = E.newSite("lumber"); // status "site" — must not count
  assert.equal(E.countClusterNeighbors(game, 5, 5, "lumber"), 1, "an adjacent site (not built) must not count");
});

test("clustering boosts yard output: adjacent built yards each out-produce an isolated one", () => {
  const isolated = E.createGame();
  isolated.board[15][15] = { type: "lumber", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  Object.assign(isolated.stock, { lumber: 0 });
  E.simTick(isolated);
  const isolatedGain = isolated.stock.lumber;

  const clustered = E.createGame();
  clustered.board[5][5] = { type: "lumber", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  clustered.board[5][6] = { type: "lumber", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  Object.assign(clustered.stock, { lumber: 0 });
  E.simTick(clustered);
  const clusteredGain = clustered.stock.lumber; // two adjacent built lumber yards, each getting the other's bonus
  assert.ok(clusteredGain / 2 > isolatedGain, "a clustered yard must out-produce an isolated one of the same tier");
});

test("startUpgrade rejects non-upgradeable, unbuilt, already-upgrading, and max-level tiles", () => {
  const game = E.createGame();
  assert.equal(E.startUpgrade(game, 1, 1), E.UPGRADE_REJECTION_MESSAGE);

  E.placeTile(game, 2, 2, "lumber");
  assert.equal(E.startUpgrade(game, 2, 2), E.UPGRADE_REJECTION_MESSAGE, "still a site, not built");

  game.board[2][2].status = "built";
  Object.assign(game.stock, { lumber: 1000, concrete: 1000 });
  assert.equal(E.startUpgrade(game, 2, 2), undefined);
  assert.equal(E.startUpgrade(game, 2, 2), "Already upgrading.");

  game.board[2][2].upgrading = null;
  game.board[2][2].upgradeLevel = E.UPGRADE_MAX_LEVEL;
  assert.equal(E.startUpgrade(game, 2, 2), "Already at max level.");
});

test("startUpgrade rejects insufficient funds and deducts cost on success", () => {
  const game = E.createGame();
  E.placeTile(game, 2, 2, "quarry");
  game.board[2][2].status = "built";
  const spec = E.upgradeCost(0);
  game.money = spec.cost - 1;
  assert.equal(E.startUpgrade(game, 2, 2), "Not enough money.");

  game.money = 100000;
  const before = game.money;
  assert.equal(E.startUpgrade(game, 2, 2), undefined);
  assert.equal(game.money, before - spec.cost);
});

test("a completed upgrade raises effective output/radius and lowers upkeep", () => {
  const game = E.createGame();
  E.placeTile(game, 2, 2, "lumber");
  game.board[2][2].status = "built";
  game.money = 100000;
  Object.assign(game.stock, { lumber: 1000, concrete: 1000 });

  assert.equal(E.startUpgrade(game, 2, 2), undefined);
  const spec = E.upgradeCost(0);
  runTicks(game, spec.ticks);

  const tile = game.board[2][2];
  assert.equal(tile.upgradeLevel, 1);
  assert.equal(tile.upgrading, null);
  assert.equal(E.effectiveRate(E.LUMBER_RATE, tile), E.LUMBER_RATE * 1.5);
  assert.ok(E.upkeepMultiplier(tile) < 1, "an upgraded building must be more efficient, not just bigger");

  const basePlant = { upgradeLevel: 0 };
  assert.equal(E.effectivePowerRadius(basePlant), E.POWER_RADIUS);
  const upgradedPlant = { upgradeLevel: 1 };
  assert.ok(E.effectivePowerRadius(upgradedPlant) > E.POWER_RADIUS, "an upgraded Power Plant must cover more ground");
});

test("computeFood decays linearly with distance and stops at FOOD_RADIUS", () => {
  const game = E.createGame();
  game.board[10][10] = { type: "farm", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  E.computeFood(game);
  const atFarm = game.board[10][10].foodSupply;
  const halfway = game.board[10][10 + Math.floor(E.FOOD_RADIUS / 2)].foodSupply;
  const atEdge = game.board[10][10 + E.FOOD_RADIUS].foodSupply;
  const justPast = game.board[10][10 + E.FOOD_RADIUS + 1].foodSupply;
  assert.equal(atFarm, E.FOOD_RATE, "full strength at the farm's own tile");
  assert.ok(halfway > 0 && halfway < atFarm, "partial supply partway to the radius edge");
  assert.ok(atEdge >= 0 && atEdge < halfway, "supply keeps decaying toward the edge");
  assert.equal(justPast, 0, "zero beyond the radius");
});

test("a res zone without enough nearby food never grows even when powered and road-served", () => {
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 200, concrete: 200 });
  buildAndFinishRoadRow(game, 10, 0, 5);
  E.placeTile(game, 2, 9, "power");
  E.placeTile(game, 3, 9, "res");
  // No farm anywhere on the board.
  runTicks(game, 100);
  assert.equal(game.board[9][3].level, 0, "food-starved res zone must not grow despite demand/power/road all being satisfied");
});

test("a nearby farm feeds a res zone enough to let it grow", () => {
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 200, concrete: 200 });
  buildAndFinishRoadRow(game, 10, 0, 5);
  E.placeTile(game, 2, 9, "power");
  E.placeTile(game, 3, 9, "res");
  E.placeTile(game, 4, 9, "farm");
  runTicks(game, 8);

  let grew = false;
  for (let i = 0; i < 200 && !grew; i++) {
    E.simTick(game);
    if (game.board[9][3].level > 0) grew = true;
  }
  assert.ok(grew, "a fed res zone must be able to grow");
});

test("food does not gate Commercial or Industrial growth, only Residential", () => {
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 200, concrete: 200 });
  buildAndFinishRoadRow(game, 10, 0, 5);
  E.placeTile(game, 2, 9, "power");
  E.placeTile(game, 3, 9, "com");
  E.placeTile(game, 4, 9, "ind");
  // No farm anywhere — if food gated these too, neither would ever grow.
  runTicks(game, 4); // finish construction
  game.demand.com = 50;
  game.demand.ind = 50;
  let comGrew = false, indGrew = false;
  for (let i = 0; i < 100 && !(comGrew && indGrew); i++) {
    E.simTick(game);
    game.demand.com = 50; // hold demand positive; recomputeTotals would otherwise swing it
    game.demand.ind = 50;
    if (game.board[9][3].level > 0) comGrew = true;
    if (game.board[9][4].level > 0) indGrew = true;
  }
  assert.ok(comGrew, "Commercial growth must not require food");
  assert.ok(indGrew, "Industrial growth must not require food");
});

test("foodNeedFor scales with a res zone's current level", () => {
  const tile0 = { level: 0 };
  const tile2 = { level: 2 };
  assert.equal(E.foodNeedFor(tile0), E.FOOD_PER_LEVEL * 1);
  assert.equal(E.foodNeedFor(tile2), E.FOOD_PER_LEVEL * 3);
  assert.ok(E.foodNeedFor(tile2) > E.foodNeedFor(tile0), "a denser house needs more food to grow further");
});

test("hitting zero stock with zero producers is recoverable, not a permanent dead end", () => {
  // Regression for a real reported bug: with no built Lumber Yard/Quarry
  // anywhere, a construction site at 0 stock used to sit at 0% forever —
  // nothing produced more material, so not even a freshly-placed yard
  // could ever finish building itself. EMERGENCY_TRICKLE guarantees this
  // always eventually resolves.
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 0, concrete: 0 });
  E.placeTile(game, 5, 5, "lumber"); // needs 5 lumber total, 4 ticks

  let completed = false;
  for (let i = 0; i < 20 && !completed; i++) {
    E.simTick(game);
    if (game.board[5][5].status === "built") completed = true;
  }
  assert.ok(completed, "a freshly-placed Lumber Yard must eventually finish even starting from absolute zero stock");
  assert.ok(game.stock.lumber > 0, "stock must be flowing again once the yard exists");
});

test("EMERGENCY_TRICKLE stops applying once a real producer exists", () => {
  const game = E.createGame();
  game.board[5][5] = { type: "lumber", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  Object.assign(game.stock, { lumber: 0 });
  E.simTick(game);
  // A single built yard already produces more than the trickle alone
  // would, and the trickle must not additionally stack on top of it.
  assert.equal(game.stock.lumber, E.LUMBER_RATE);
});

test("new construction gets priority over Industrial consumption for the same day's production", () => {
  // Regression for a reported bug: a level-3 Industrial zone's concrete
  // draw (3/day) exactly matches a single Quarry's output (3/day), and a
  // second built Warehouse keeps Industrial's Goods output permanently
  // under the export cap (so it never self-throttles that way, isolating
  // the actual mechanism under test). Under the old tick order —
  // Industrial consumption running *after* production, ahead of the next
  // tick's construction check — this was a genuine permanent deadlock:
  // concrete confirmed stuck at exactly 0 for 60+ ticks in manual testing.
  // Production now running before construction fixes it: the site should
  // complete in exactly its minimum build time (5 ticks) since it gets
  // first claim on each day's fresh concrete before Industrial touches it.
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 1000, concrete: 0 }); // lumber is never the bottleneck here
  game.board[10][10] = { type: "quarry", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  game.board[10][11] = { type: "ind", status: "built", level: 3, powered: false, upgradeLevel: 0, upgrading: null };
  game.board[10][13] = { type: "warehouse", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  E.placeTile(game, 12, 10, "warehouse"); // needs 10 concrete over 5 days

  let completedAtTick = null;
  for (let i = 0; i < 20 && completedAtTick === null; i++) {
    E.simTick(game);
    if (game.board[10][12].status === "built") completedAtTick = i + 1;
  }
  assert.equal(completedAtTick, 5, "new construction must finish in its minimum build time, not starve behind Industrial consumption");
});

test("a single bad day never triggers bankruptcy, but a sustained debt streak does", () => {
  const game = E.createGame();
  game.money = -1;
  for (let i = 0; i < E.BANKRUPTCY_DEBT_DAYS - 1; i++) {
    E.simTick(game);
    game.money = -1; // hold in debt without letting the economy recover on its own
  }
  assert.equal(game.gameOver, null, "must not trigger before the full debt streak elapses");

  E.simTick(game);
  assert.ok(game.gameOver, "must trigger once the debt streak reaches BANKRUPTCY_DEBT_DAYS");
  assert.equal(game.gameOver.reason, "bankruptcy");
});

test("debt streak resets the moment money is non-negative again", () => {
  const game = E.createGame();
  game.money = -1;
  for (let i = 0; i < E.BANKRUPTCY_DEBT_DAYS - 2; i++) {
    E.simTick(game);
    game.money = -1;
  }
  assert.ok(game.debtStreak > 0, "streak must have been accumulating");
  game.money = 5; // one solvent day
  E.simTick(game);
  assert.equal(game.debtStreak, 0, "a solvent day must reset the streak entirely, not just pause it");
});

test("once the game is over, simTick freezes state and placeTile/startUpgrade are rejected", () => {
  const game = E.createGame();
  game.gameOver = { reason: "bankruptcy", day: 5 };
  const dayBefore = game.day;
  const moneyBefore = game.money;
  E.simTick(game);
  assert.equal(game.day, dayBefore, "simTick must be a no-op once the game has ended");
  assert.equal(game.money, moneyBefore);

  const msg = E.placeTile(game, 3, 3, "road");
  assert.equal(msg, E.gameOverMessage(game));
  assert.equal(game.board[3][3].type, "empty", "no placement must happen once the game is over");

  const upgradeMsg = E.startUpgrade(game, 3, 3);
  assert.equal(upgradeMsg, E.gameOverMessage(game));
});

test("City Collapse only triggers after population has actually grown, not at the start of a fresh game", () => {
  const game = E.createGame();
  E.simTick(game); // population is 0 from tick 1, same as any brand-new city
  assert.equal(game.gameOver, null, "population 0 before ever growing must not be mistaken for a collapse");
});

test("a res zone that grew past level 0 does not falsely neglect-decay on stable food that only covered the old growth threshold", () => {
  // Regression for a critical bug found in live play-testing: foodNeedFor
  // is a *growth* threshold (food needed to reach the next level), scaled
  // to level+1. Using that same number to decide whether a zone is
  // "maintained" meant any zone that just grew immediately needed MORE
  // food than got it there in the first place, registering as neglected
  // from the very next tick even with perfectly stable food/power/road —
  // which would eventually decay and falsely collapse every city that
  // ever grew past level 0. foodNeedToMaintain (scaled to the *current*
  // level) must be used for neglect instead, decoupled from growth.
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 1000, concrete: 1000 });
  game.money = 1000000;

  game.board[10][10] = { type: "power", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  game.board[10][11] = { type: "road", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  game.board[10][12] = { type: "farm", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  game.board[10][13] = { type: "res", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  game.demand.res = 100;

  let grew = false;
  for (let i = 0; i < 100 && !grew; i++) {
    E.simTick(game);
    game.demand.res = 100;
    if (game.board[10][13].level > 0) grew = true;
  }
  assert.ok(grew, "setup: the res zone must grow past level 0");
  const levelAfterGrowth = game.board[10][13].level;
  // This farm's supply to this tile only ever covers foodNeedToMaintain at
  // this level, not foodNeedFor's higher next-tier threshold — exactly the
  // gap that used to falsely trigger neglect.
  assert.ok(
    game.board[10][13].foodSupply < E.foodNeedFor(game.board[10][13]),
    "setup: food must fall short of the growth threshold for this to be a meaningful regression check"
  );

  // Nothing about service changes from here — power, road, and farm all
  // stay exactly as built. Run far longer than NEGLECT_TICKS_BEFORE_DECAY
  // and confirm neglect never accumulates and the game never ends.
  for (let i = 0; i < 200; i++) {
    E.simTick(game);
    game.demand.res = 0; // stop further growth so the level under test holds steady
  }
  assert.equal(game.board[10][13].neglect, 0, "a zone with stable food/power/road must never accumulate neglect just for having grown");
  assert.ok(game.board[10][13].level >= levelAfterGrowth, "the zone must not have decayed");
  assert.equal(game.gameOver, null, "normal growth must never falsely trigger City Collapse");
});

test("a built, grown zone that goes unserved decays after sustained neglect, eventually collapsing the city", () => {
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 1000, concrete: 1000 });
  game.money = 1000000;

  // Get one res zone up to a real level with full service...
  game.board[10][10] = { type: "power", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  game.board[10][11] = { type: "road", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  game.board[10][12] = { type: "farm", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  game.board[10][13] = { type: "res", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  game.demand.res = 100; // force growth chances to resolve quickly for the test

  let grew = false;
  for (let i = 0; i < 100 && !grew; i++) {
    E.simTick(game);
    game.demand.res = 100;
    if (game.board[10][13].level > 0) grew = true;
  }
  assert.ok(grew, "setup: the res zone must actually grow first");
  assert.ok(game.peakPopulation >= E.COLLAPSE_POPULATION_THRESHOLD || game.population > 0, "sanity: population did grow");

  // ...then bulldoze its road, cutting service, and watch neglect decay it
  // all the way back down without ever touching the zone directly.
  game.board[10][11] = E.newTile();

  let collapsed = false;
  for (let i = 0; i < 500 && !collapsed; i++) {
    E.simTick(game);
    if (game.gameOver) collapsed = true;
  }
  assert.ok(collapsed, "sustained neglect must be able to fully collapse a city that had grown");
  assert.equal(game.gameOver.reason, "collapse");
});

test("goods price falls as daily export volume rises, but never below the floor", () => {
  // The export loop used to pay a flat GOODS_PRICE per unit at any volume,
  // so a saturated city printed money linearly forever with no marginal
  // pressure. Price now decays hyperbolically toward a floor.
  assert.equal(E.goodsPriceFor(0), E.GOODS_PRICE, "zero volume quotes the base price");
  const small = E.goodsPriceFor(5);
  const medium = E.goodsPriceFor(E.GOODS_MARKET_DEPTH);
  const huge = E.goodsPriceFor(E.GOODS_MARKET_DEPTH * 100);
  assert.ok(small > medium && medium > huge, "price must fall monotonically with volume");
  assert.ok(small <= E.GOODS_PRICE, "price never exceeds the base");
  assert.ok(huge > E.GOODS_PRICE_FLOOR, "price approaches the floor but never reaches or crosses it");
  // At exactly market depth the premium over the floor has halved.
  assert.ok(Math.abs(medium - (E.GOODS_PRICE_FLOOR + (E.GOODS_PRICE - E.GOODS_PRICE_FLOOR) / 2)) < 1e-9);
});

test("total export revenue still rises with volume — the price curve thins margins, it does not cap income", () => {
  // A price curve that made revenue *fall* past some volume would make
  // extra production actively harmful and reward doing nothing.
  let prev = 0;
  for (let v = 1; v <= 500; v += 7) {
    const revenue = v * E.goodsPriceFor(v);
    assert.ok(revenue > prev, "revenue must be monotonically increasing at volume " + v);
    prev = revenue;
  }
});

test("administrative cost is negligible for a small city and super-linear for a large one", () => {
  const small = E.adminCost({ builtTiles: 10 });
  const mid = E.adminCost({ builtTiles: 100 });
  const big = E.adminCost({ builtTiles: 1000 });
  assert.equal(E.adminCost({ builtTiles: 0 }), 0, "an empty map costs nothing to administer");
  assert.ok(small < 5, "a 10-tile city must not be meaningfully taxed by admin overhead");
  // Super-linear: 10x the tiles must cost *more* than 10x the admin.
  assert.ok(mid > small * 10, "admin must grow faster than linearly (10 -> 100 tiles)");
  assert.ok(big > mid * 10, "admin must grow faster than linearly (100 -> 1000 tiles)");
});

test("simTick charges administrative cost on top of per-tile upkeep and reports both", () => {
  const game = E.createGame();
  for (let x = 1; x <= 12; x++) game.board[5][x] = { type: "road", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  E.simTick(game);
  assert.equal(game.builtTiles, 12);
  const expectedAdmin = E.adminCost({ builtTiles: 12 });
  assert.ok(Math.abs(game.lastAdmin - expectedAdmin) < 1e-9, "lastAdmin must reflect the built footprint");
  assert.ok(game.lastUpkeep > game.lastAdmin, "lastUpkeep is the combined figure, admin included");
  assert.equal(game.lastNet, Math.round(game.lastIncome - game.lastUpkeep));
});

test("Commercial and Industrial zones only run at the rate the population can staff", () => {
  // Before staffing existed, an all-Industrial city with zero housing
  // produced Goods at full rate, skipping the entire Residential/farm/food
  // system — the most degenerate strategy in the game.
  assert.equal(E.staffingRatio({ population: 0, jobs: 0 }), 1, "an empty city must not divide by zero");
  assert.equal(E.staffingRatio({ population: 100, jobs: 50 }), 1, "surplus population does not over-staff");
  assert.equal(E.staffingRatio({ population: 25, jobs: 100 }), 0.25);
  assert.equal(E.staffingRatio({ population: 0, jobs: 100 }), 0, "no residents means no output at all");
});

test("an all-Industrial city with no housing produces no Goods", () => {
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 500, concrete: 500 });
  // Fully served industry, but nobody lives here.
  game.board[10][10] = { type: "power", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  for (let x = 8; x <= 12; x++) game.board[9][x] = { type: "road", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  for (let x = 8; x <= 12; x++) game.board[11][x] = { type: "ind", status: "built", level: 3, powered: false, upgradeLevel: 0, upgrading: null };
  game.board[11][13] = { type: "warehouse", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  runTicks(game, 15);
  assert.equal(game.population, 0, "setup: this city genuinely has no residents");
  assert.equal(game.stock.goods, 0, "unstaffed Industrial zones must produce nothing");
});

test("adding housing to a job-heavy city restores Industrial output", () => {
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 500, concrete: 500 });
  game.board[10][10] = { type: "power", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  for (let x = 6; x <= 14; x++) game.board[9][x] = { type: "road", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  for (let x = 8; x <= 12; x++) game.board[11][x] = { type: "ind", status: "built", level: 2, powered: false, upgradeLevel: 0, upgrading: null };
  // Housing + farms so residents actually exist and are fed.
  for (let x = 6; x <= 14; x++) game.board[8][x] = { type: "res", status: "built", level: 3, powered: false, upgradeLevel: 0, upgrading: null };
  for (let x = 6; x <= 14; x++) game.board[7][x] = { type: "farm", status: "built", level: 0, powered: false, upgradeLevel: 0, upgrading: null };
  runTicks(game, 10);
  assert.ok(game.population > 0, "setup: residents must exist");
  assert.ok(E.staffingRatio(game) > 0, "setup: staffing must be non-zero");
  assert.ok(game.stock.goods > 0, "a staffed Industrial base must produce Goods");
});

test("Industrial job tax uses TAX.ind, not TAX.com", () => {
  // TAX.ind was previously dead: every job was billed at TAX.com's rate.
  const comCity = E.createGame();
  const indCity = E.createGame();
  for (const [g, type] of [[comCity, "com"], [indCity, "ind"]]) {
    for (let x = 5; x <= 9; x++) g.board[10][x] = { type, status: "built", level: 3, powered: false, upgradeLevel: 0, upgrading: null };
    E.simTick(g);
  }
  assert.equal(comCity.jobs, indCity.jobs, "setup: both cities must have identical job counts");
  assert.ok(E.TAX.com !== E.TAX.ind, "setup: the two rates must differ for this to prove anything");
  assert.ok(
    comCity.lastIncome > indCity.lastIncome,
    "with TAX.com > TAX.ind, a commercial city must out-earn an identical industrial one"
  );
});
