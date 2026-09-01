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
  E.placeTile(game, 3, 3, "road");
  E.simTick(game);
  const t = game.board[3][3];
  assert.equal(t.status, "site");
  assert.equal(t.stalled, true);
  assert.equal(t.progress, 0);
  assert.equal(game.stock.lumber, 0, "a stalled site must not partially consume stock");
  assert.equal(game.stock.concrete, 0);
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

test("RCI bootstraps from zero: a built, powered, road-adjacent res zone eventually grows", () => {
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 200, concrete: 200 }); // isolate RCI growth from the material economy, covered separately above
  buildAndFinishRoadRow(game, 10, 0, 5);
  E.placeTile(game, 2, 9, "power");
  E.placeTile(game, 3, 9, "res");
  runTicks(game, 8); // finish power (8 ticks) and res (3 ticks)
  assert.equal(game.board[9][2].status, "built");
  assert.equal(game.board[9][3].status, "built");

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
  // (at most) the single now-built road's upkeep — never a mystery charge
  // for the site tick before it completed.
  assert.ok(game.lastNet <= 0);
  assert.ok(game.lastNet >= -E.UPKEEP.road - 0.01);
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
  E.simTick(game);
  const expectedInput = 2 * E.IND_INPUT_PER_LEVEL;
  const expectedOutput = 2 * E.IND_OUTPUT_PER_LEVEL;
  assert.equal(game.stock.lumber, 50 - expectedInput);
  assert.equal(game.stock.concrete, 50 - expectedInput);
  // GOODS_EXPORT_RATE auto-sells some of the same tick's output.
  assert.equal(game.stock.goods, Math.max(0, expectedOutput - E.GOODS_EXPORT_RATE));
});

test("Industrial goods output throttles to zero once Goods storage is full, without wasting input", () => {
  const game = E.createGame();
  Object.assign(game.stock, { lumber: 50, concrete: 50, goods: game.stock.goodsCap });
  game.board[5][5] = { type: "ind", status: "built", level: 3, powered: false, upgradeLevel: 0, upgrading: null };
  const lumberBefore = game.stock.lumber;
  E.simTick(game);
  // Only GOODS_EXPORT_RATE worth of room opens up (from the export step),
  // so consumption must be near zero, never the full per-level want.
  assert.ok(game.stock.lumber > lumberBefore - 0.5, "a full warehouse must not let industry burn raw material for nothing");
});

test("exported Goods convert to income at GOODS_PRICE", () => {
  const game = E.createGame();
  Object.assign(game.stock, { goods: E.GOODS_EXPORT_RATE * 2 });
  E.simTick(game);
  assert.ok(game.lastNet >= E.GOODS_EXPORT_RATE * E.GOODS_PRICE - 1, "export income must show up in the day's net");
});

test("startUpgrade rejects non-upgradeable, unbuilt, already-upgrading, and max-level tiles", () => {
  const game = E.createGame();
  assert.equal(E.startUpgrade(game, 1, 1), "Select a built Power Plant, Lumber Yard, or Quarry to upgrade.");

  E.placeTile(game, 2, 2, "lumber");
  assert.equal(E.startUpgrade(game, 2, 2), "Select a built Power Plant, Lumber Yard, or Quarry to upgrade.", "still a site, not built");

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
