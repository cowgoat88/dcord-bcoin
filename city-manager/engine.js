// Core simulation for City Manager: grid state, construction staging,
// material stockpile with storage caps, industrial goods production,
// building upgrades, road service radius, material clustering, and
// RCI demand/economy. No DOM, no canvas, no timers — safe to run under
// plain Node for tests (engine.test.js) and loaded as a plain <script>
// by index.html, which owns all rendering/input/camera/cosmetic-traffic
// code on top of this.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.CityEngine = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const GRID_W = 40, GRID_H = 25, TILE = 20;
  const POWER_RADIUS = 8;
  const MAX_LEVEL = 3;
  const CAP_PER_LEVEL = 10; // population or jobs added per level
  const LUMBER_RATE = 3, CONCRETE_RATE = 3; // per built yard, per day (before upgrades/clustering)

  // A zoned tile doesn't need to touch a road directly — it just needs one
  // within this radius (bigger with road upgrades), like a real city block
  // set back from its frontage road.
  const ROAD_BASE_RADIUS = 3;
  const ROAD_UPGRADE_STEP = 2; // extra radius per road upgrade tier

  // Lumber Yards/Quarries producing side-by-side (an "industrial cluster")
  // each get a flat bonus per same-type built neighbor (8-neighborhood) —
  // this is what makes tile placement/layout matter, not just raw counts.
  const CLUSTER_BONUS_PER_NEIGHBOR = 0.25;

  // Storage: raw materials and finished Goods are capped so they can't
  // grow forever. Warehouses raise every cap AND raise how much Goods can
  // be exported per day — they're the export terminal, not just a shelf.
  const STORAGE_BASE = { lumber: 100, concrete: 100, goods: 60 };
  const WAREHOUSE_BONUS = { lumber: 80, concrete: 80, goods: 80 };
  const GOODS_EXPORT_BASE = 3; // units/day exportable with zero warehouses
  const GOODS_EXPORT_PER_WAREHOUSE = 6; // extra export capacity per built warehouse
  const GOODS_PRICE = 8; // $ per unit sold — the main income lever
  const IND_INPUT_PER_LEVEL = 1; // lumber AND concrete consumed, per zone level, per day
  const IND_OUTPUT_PER_LEVEL = 2; // goods produced, per zone level, per day

  // Tax is deliberately a minor trickle now, not a viable income strategy
  // on its own — Goods export (production + warehouses) is meant to carry
  // the treasury. See README for the reasoning.
  const TAX = { res: 0.12, com: 0.2, ind: 0.15 };

  // Power Plants, Lumber Yards, Quarries, and Roads can each be upgraded
  // twice: more output/radius per tier, and lower upkeep (efficiency).
  const UPGRADE_MAX_LEVEL = 2;
  const UPGRADEABLE_TYPES = ["power", "lumber", "quarry", "road"];

  const BUILD = {
    road:      { cost: 5,   lumber: 1,  concrete: 0,  ticks: 1, color: "#555",    label: "Road" },
    res:       { cost: 15,  lumber: 2,  concrete: 1,  ticks: 3, color: "#4caf50", label: "Residential" },
    com:       { cost: 15,  lumber: 2,  concrete: 1,  ticks: 3, color: "#42a5f5", label: "Commercial" },
    ind:       { cost: 15,  lumber: 2,  concrete: 1,  ticks: 3, color: "#ffb74d", label: "Industrial" },
    power:     { cost: 500, lumber: 20, concrete: 30, ticks: 8, color: "#e0665a", label: "Power Plant" },
    park:      { cost: 20,  lumber: 3,  concrete: 0,  ticks: 2, color: "#2e7d32", label: "Park" },
    lumber:    { cost: 100, lumber: 5,  concrete: 0,  ticks: 4, color: "#8d6e63", label: "Lumber Yard" },
    quarry:    { cost: 100, lumber: 5,  concrete: 5,  ticks: 4, color: "#78909c", label: "Quarry" },
    warehouse: { cost: 150, lumber: 10, concrete: 10, ticks: 5, color: "#a1887f", label: "Warehouse" }
  };
  const BULLDOZE_COST = 5;
  const UPKEEP = { road: 0.5, zone: 1, power: 20, park: 1, yard: 0.5, warehouse: 1 };

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }
  function inBounds(x, y) { return x >= 0 && y >= 0 && x < GRID_W && y < GRID_H; }

  function newTile() {
    return { type: "empty" };
  }

  function newSite(tool) {
    const spec = BUILD[tool];
    return {
      type: tool,
      status: "site",
      level: 0,
      powered: false,
      progress: 0,
      ticksNeeded: spec.ticks,
      need: { lumber: spec.lumber, concrete: spec.concrete },
      delivered: { lumber: 0, concrete: 0 },
      stalled: false,
      upgradeLevel: 0,
      upgrading: null
    };
  }

  function createGame() {
    const board = [];
    for (let y = 0; y < GRID_H; y++) {
      const row = [];
      for (let x = 0; x < GRID_W; x++) row.push(newTile());
      board.push(row);
    }
    return {
      board,
      money: 10000,
      stock: {
        lumber: 30, concrete: 15, goods: 0,
        lumberCap: STORAGE_BASE.lumber, concreteCap: STORAGE_BASE.concrete, goodsCap: STORAGE_BASE.goods
      },
      warehouses: 0,
      day: 1,
      population: 0,
      jobs: 0,
      demand: { res: 50, com: 20, ind: 20 },
      lastNet: 0
    };
  }

  function isBuiltRoad(game, x, y) {
    return inBounds(x, y) && game.board[y][x].type === "road" && game.board[y][x].status === "built";
  }

  // Strict 1-tile adjacency — used for the road *network graph* (delivery
  // truck pathing), which needs a literal unbroken chain of road tiles,
  // unlike a zone's service radius below.
  function hasAdjacentRoad(game, x, y) {
    const deltas = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dx, dy] of deltas) {
      if (isBuiltRoad(game, x + dx, y + dy)) return true;
    }
    return false;
  }

  function adjacentBuiltRoad(game, x, y) {
    const deltas = [[1,0],[-1,0],[0,1],[0,-1]];
    for (const [dx, dy] of deltas) {
      const nx = x + dx, ny = y + dy;
      if (isBuiltRoad(game, nx, ny)) return [nx, ny];
    }
    return null;
  }

  function effectiveRoadRadius(tile) {
    return ROAD_BASE_RADIUS + ROAD_UPGRADE_STEP * (tile.upgradeLevel || 0);
  }

  // Whether (x,y) is within *some* built road's service radius — not
  // necessarily touching it. Each road's own upgrade tier decides how far
  // its coverage reaches, so a scan has to check every nearby road rather
  // than just the road nearest to (x,y).
  function hasRoadService(game, x, y) {
    const maxR = ROAD_BASE_RADIUS + ROAD_UPGRADE_STEP * UPGRADE_MAX_LEVEL;
    for (let dy = -maxR; dy <= maxR; dy++) {
      for (let dx = -maxR; dx <= maxR; dx++) {
        const nx = x + dx, ny = y + dy;
        if (!isBuiltRoad(game, nx, ny)) continue;
        const road = game.board[ny][nx];
        if (Math.max(Math.abs(dx), Math.abs(dy)) <= effectiveRoadRadius(road)) return true;
      }
    }
    return false;
  }

  // Counts built same-type tiles in the 8-neighborhood — the industrial
  // "clustering" bonus: Lumber Yards/Quarries built next to each other
  // each produce more, rewarding a deliberate district layout.
  function countClusterNeighbors(game, x, y, type) {
    let count = 0;
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) {
        if (dx === 0 && dy === 0) continue;
        const nx = x + dx, ny = y + dy;
        if (!inBounds(nx, ny)) continue;
        const t = game.board[ny][nx];
        if (t.type === type && t.status === "built") count++;
      }
    }
    return count;
  }

  // Upgrade tiers scale both cost and effect. A tile at upgradeLevel L
  // pays this to reach L+1.
  function upgradeCost(level) {
    return {
      cost: 200 * (level + 1),
      lumber: 15 * (level + 1),
      concrete: 15 * (level + 1),
      ticks: 5
    };
  }

  function effectiveRate(base, tile) {
    return base * (1 + 0.5 * (tile.upgradeLevel || 0));
  }

  function effectivePowerRadius(tile) {
    return POWER_RADIUS + 3 * (tile.upgradeLevel || 0);
  }

  // Each upgrade tier also trims upkeep: more efficient, not just bigger.
  function upkeepMultiplier(tile) {
    return 1 - 0.15 * (tile.upgradeLevel || 0);
  }

  // Export capacity scales with built Warehouses — they're the terminal
  // Goods actually ship out from, not just extra shelf space.
  function effectiveExportRate(game) {
    return GOODS_EXPORT_BASE + (game.warehouses || 0) * GOODS_EXPORT_PER_WAREHOUSE;
  }

  function computePower(game) {
    const { board } = game;
    for (let y = 0; y < GRID_H; y++)
      for (let x = 0; x < GRID_W; x++) board[y][x].powered = false;

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const plant = board[y][x];
        if (plant.type !== "power" || plant.status !== "built") continue;
        const radius = effectivePowerRadius(plant);
        for (let dy = -radius; dy <= radius; dy++) {
          for (let dx = -radius; dx <= radius; dx++) {
            const nx = x + dx, ny = y + dy;
            if (!inBounds(nx, ny)) continue;
            if (Math.max(Math.abs(dx), Math.abs(dy)) <= radius) board[ny][nx].powered = true;
          }
        }
      }
    }
  }

  // Recomputes storage caps and warehouse count from built Warehouses.
  // Called before anything that produces/consumes stock this tick, so it
  // reflects completions from the *previous* tick — consistent with how
  // computePower and road service also only see prior-tick completions.
  function recomputeCaps(game) {
    let warehouses = 0;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = game.board[y][x];
        if (t.type === "warehouse" && t.status === "built") warehouses++;
      }
    }
    game.warehouses = warehouses;
    game.stock.lumberCap = STORAGE_BASE.lumber + warehouses * WAREHOUSE_BONUS.lumber;
    game.stock.concreteCap = STORAGE_BASE.concrete + warehouses * WAREHOUSE_BONUS.concrete;
    game.stock.goodsCap = STORAGE_BASE.goods + warehouses * WAREHOUSE_BONUS.goods;
  }

  function recomputeTotals(game) {
    const { board } = game;
    let population = 0, comJobs = 0, indJobs = 0;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = board[y][x];
        if (t.status !== "built") continue;
        if (t.type === "res") population += t.level * CAP_PER_LEVEL;
        if (t.type === "com") comJobs += t.level * CAP_PER_LEVEL;
        if (t.type === "ind") indJobs += t.level * CAP_PER_LEVEL;
      }
    }
    game.population = population;
    game.jobs = comJobs + indJobs;

    // Treat zero jobs as one phantom job so res demand starts slightly
    // positive instead of exactly 0 — otherwise res never grows (needs
    // d>0), so population never grows, so com/ind demand never turns
    // positive either: a permanent zero-zero deadlock. Regression-tested
    // in engine.test.js ("RCI bootstrap").
    const jobsForRes = game.jobs || 1;
    game.demand.res = clamp(((jobsForRes - population) / 10) * 5, -100, 100);
    game.demand.ind = clamp(((population - indJobs) / 10) * 5, -100, 100);
    game.demand.com = clamp(((population - comJobs * 2) / 10) * 5, -100, 100);
  }

  function bfsPath(game, start, end) {
    const key = (x, y) => y * GRID_W + x;
    const visited = new Set([key(start[0], start[1])]);
    const queue = [[start, [start]]];
    let head = 0;
    while (head < queue.length) {
      const [[cx, cy], path] = queue[head++];
      if (cx === end[0] && cy === end[1]) return path;
      const deltas = [[1,0],[-1,0],[0,1],[0,-1]];
      for (const [dx, dy] of deltas) {
        const nx = cx + dx, ny = cy + dy;
        if (!isBuiltRoad(game, nx, ny) || visited.has(key(nx, ny))) continue;
        visited.add(key(nx, ny));
        queue.push([[nx, ny], path.concat([[nx, ny]])]);
      }
    }
    return null;
  }

  function advanceSite(game, x, y, t, reserveLumber, reserveConcrete, onProgress) {
    const needLumber = Math.min(t.need.lumber / t.ticksNeeded, t.need.lumber - t.delivered.lumber);
    const needConcrete = Math.min(t.need.concrete / t.ticksNeeded, t.need.concrete - t.delivered.concrete);
    const availLumber = game.stock.lumber - reserveLumber;
    const availConcrete = game.stock.concrete - reserveConcrete;
    if (availLumber >= needLumber && availConcrete >= needConcrete) {
      game.stock.lumber -= needLumber;
      game.stock.concrete -= needConcrete;
      t.delivered.lumber += needLumber;
      t.delivered.concrete += needConcrete;
      t.progress += 1;
      t.stalled = false;
      if (onProgress) onProgress(x, y, t);
      if (t.progress >= t.ticksNeeded) t.status = "built";
    } else {
      t.stalled = true;
    }
  }

  function stepConstruction(game, onProgress) {
    // Lumber Yards/Quarries are the only source of new stock. Giving them
    // first pick of the pool each tick isn't enough on its own: other sites
    // draining the pool tick after tick can still leave too little for a
    // yard's *later* ticks even though it went first every time so far. So
    // everything else is also barred from touching whatever the still-in-
    // progress yards/quarries need for the rest of their build — otherwise
    // a big enough batch of simultaneous construction permanently freezes
    // the economy at zero production (nothing left to ever finish a yard).
    // Regression-tested in engine.test.js ("material deadlock").
    const { board } = game;
    const priority = [];
    const rest = [];
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = board[y][x];
        if (t.status !== "site") continue;
        (t.type === "lumber" || t.type === "quarry" ? priority : rest).push([x, y, t]);
      }
    }
    for (const [x, y, t] of priority) advanceSite(game, x, y, t, 0, 0, onProgress);

    let reserveLumber = 0, reserveConcrete = 0;
    for (const [, , t] of priority) {
      if (t.status !== "site") continue;
      reserveLumber += t.need.lumber - t.delivered.lumber;
      reserveConcrete += t.need.concrete - t.delivered.concrete;
    }
    for (const [x, y, t] of rest) advanceSite(game, x, y, t, reserveLumber, reserveConcrete, onProgress);
  }

  // Returns undefined on success, or a user-facing message on rejection.
  // Unlike a fresh build, an upgrading tile stays fully operational at its
  // current tier the whole time — this only affects a tile that's already
  // status==="built".
  function startUpgrade(game, x, y) {
    if (!inBounds(x, y)) return undefined;
    const t = game.board[y][x];
    if (!UPGRADEABLE_TYPES.includes(t.type) || t.status !== "built") {
      return "Select a built Power Plant, Lumber Yard, Quarry, or Road to upgrade.";
    }
    if (t.upgrading) return "Already upgrading.";
    if ((t.upgradeLevel || 0) >= UPGRADE_MAX_LEVEL) return "Already at max level.";
    const spec = upgradeCost(t.upgradeLevel || 0);
    if (game.money < spec.cost) return "Not enough money.";
    game.money -= spec.cost;
    t.upgrading = {
      progress: 0,
      ticksNeeded: spec.ticks,
      need: { lumber: spec.lumber, concrete: spec.concrete },
      delivered: { lumber: 0, concrete: 0 }
    };
    return undefined;
  }

  // Runs after stepConstruction each tick, so it only ever spends whatever
  // stock construction left behind that tick — no reservation needed since
  // the two never execute concurrently.
  function stepUpgrades(game) {
    const { board } = game;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = board[y][x];
        const u = t.upgrading;
        if (!u) continue;
        const needLumber = Math.min(u.need.lumber / u.ticksNeeded, u.need.lumber - u.delivered.lumber);
        const needConcrete = Math.min(u.need.concrete / u.ticksNeeded, u.need.concrete - u.delivered.concrete);
        if (game.stock.lumber >= needLumber && game.stock.concrete >= needConcrete) {
          game.stock.lumber -= needLumber;
          game.stock.concrete -= needConcrete;
          u.delivered.lumber += needLumber;
          u.delivered.concrete += needConcrete;
          u.progress += 1;
          if (u.progress >= u.ticksNeeded) {
            t.upgradeLevel = (t.upgradeLevel || 0) + 1;
            t.upgrading = null;
          }
        }
        // Insufficient stock: the upgrade simply waits: the tile keeps
        // operating at its current tier, nothing is lost or "stalled".
      }
    }
  }

  function simTick(game, onProgress) {
    const { board, stock } = game;
    computePower(game);
    recomputeCaps(game);
    stepConstruction(game, onProgress);
    stepUpgrades(game);

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = board[y][x];
        if (t.status !== "built" || (t.type !== "res" && t.type !== "com" && t.type !== "ind")) continue;
        const eligible = t.powered && hasRoadService(game, x, y);
        const d = game.demand[t.type];
        if (eligible && d > 0 && t.level < MAX_LEVEL) {
          if (Math.random() < 0.3) t.level += 1;
        } else if (d < -70 && t.level > 0) {
          if (Math.random() < 0.15) t.level -= 1;
        }
      }
    }

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = board[y][x];
        if (t.status !== "built") continue;
        if (t.type === "lumber") {
          const cluster = countClusterNeighbors(game, x, y, "lumber");
          const rate = effectiveRate(LUMBER_RATE, t) * (1 + CLUSTER_BONUS_PER_NEIGHBOR * cluster);
          stock.lumber = Math.min(stock.lumber + rate, stock.lumberCap);
        }
        if (t.type === "quarry") {
          const cluster = countClusterNeighbors(game, x, y, "quarry");
          const rate = effectiveRate(CONCRETE_RATE, t) * (1 + CLUSTER_BONUS_PER_NEIGHBOR * cluster);
          stock.concrete = Math.min(stock.concrete + rate, stock.concreteCap);
        }
      }
    }

    // Industrial zones are the only material sink beyond upkeep: they
    // convert raw Lumber+Concrete into Goods (capped), throttled by
    // whichever is scarcer — available input, or remaining Goods storage.
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = board[y][x];
        if (t.status !== "built" || t.type !== "ind" || t.level <= 0) continue;
        const wantInput = t.level * IND_INPUT_PER_LEVEL;
        const wantOutput = t.level * IND_OUTPUT_PER_LEVEL;
        const goodsRoom = Math.max(0, stock.goodsCap - stock.goods);
        const ratio = Math.max(0, Math.min(
          1,
          stock.lumber / wantInput,
          stock.concrete / wantInput,
          goodsRoom / wantOutput
        ));
        stock.lumber -= wantInput * ratio;
        stock.concrete -= wantInput * ratio;
        stock.goods = Math.min(stock.goodsCap, stock.goods + wantOutput * ratio);
      }
    }

    recomputeTotals(game);

    const exportRate = effectiveExportRate(game);
    const exported = Math.min(stock.goods || 0, exportRate);
    stock.goods = (stock.goods || 0) - exported;

    let income = game.population * TAX.res + game.jobs * TAX.com * 0.6 + exported * GOODS_PRICE;
    let upkeep = 0;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = board[y][x];
        if (t.status !== "built") continue;
        if (t.type === "road") upkeep += UPKEEP.road * upkeepMultiplier(t);
        else if (t.type === "res" || t.type === "com" || t.type === "ind") upkeep += UPKEEP.zone * t.level;
        else if (t.type === "power") upkeep += UPKEEP.power * upkeepMultiplier(t);
        else if (t.type === "park") upkeep += UPKEEP.park;
        else if (t.type === "lumber" || t.type === "quarry") upkeep += UPKEEP.yard * upkeepMultiplier(t);
        else if (t.type === "warehouse") upkeep += UPKEEP.warehouse;
      }
    }
    game.lastNet = Math.round(income - upkeep);
    game.money += game.lastNet;
    game.day += 1;
  }

  // Returns undefined on success, or a user-facing message on rejection.
  function placeTile(game, x, y, tool) {
    if (!inBounds(x, y)) return undefined;
    const t = game.board[y][x];
    if (tool === "bulldoze") {
      if (t.type === "empty") return undefined;
      if (game.money < BULLDOZE_COST) return "Not enough money.";
      game.money -= BULLDOZE_COST;
      game.board[y][x] = newTile();
      recomputeTotals(game);
      return undefined;
    }
    if (t.type !== "empty") return "Bulldoze that tile first.";
    const spec = BUILD[tool];
    if (game.money < spec.cost) return "Not enough money.";
    game.money -= spec.cost;
    game.board[y][x] = newSite(tool);
    return undefined;
  }

  return {
    GRID_W, GRID_H, TILE, POWER_RADIUS, MAX_LEVEL, CAP_PER_LEVEL,
    ROAD_BASE_RADIUS, ROAD_UPGRADE_STEP, CLUSTER_BONUS_PER_NEIGHBOR,
    LUMBER_RATE, CONCRETE_RATE, BUILD, BULLDOZE_COST, UPKEEP, TAX,
    STORAGE_BASE, WAREHOUSE_BONUS, GOODS_EXPORT_BASE, GOODS_EXPORT_PER_WAREHOUSE, GOODS_PRICE,
    IND_INPUT_PER_LEVEL, IND_OUTPUT_PER_LEVEL,
    UPGRADE_MAX_LEVEL, UPGRADEABLE_TYPES, upgradeCost,
    effectiveRate, effectivePowerRadius, effectiveRoadRadius, effectiveExportRate, upkeepMultiplier,
    clamp, inBounds, newTile, newSite, createGame,
    isBuiltRoad, hasAdjacentRoad, adjacentBuiltRoad, hasRoadService, countClusterNeighbors,
    computePower, recomputeCaps, recomputeTotals, bfsPath,
    advanceSite, stepConstruction, startUpgrade, stepUpgrades,
    simTick, placeTile
  };
});
