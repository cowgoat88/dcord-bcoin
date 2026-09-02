// Core simulation for City Manager: grid state, construction staging,
// material stockpile with storage caps, industrial goods production,
// building upgrades, road service radius, material clustering, farm-fed
// food coverage, and RCI demand/economy. No DOM, no canvas, no timers —
// safe to run under plain Node for tests (engine.test.js) and loaded as
// a plain <script> by index.html, which owns all rendering/input/camera/
// cosmetic-traffic code on top of this.
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

  // Safety net: if every Lumber Yard/Quarry is gone (bulldozed, or the
  // starting stock got spent before one was ever finished), the stockpile
  // can otherwise sit at exactly 0 forever — nothing produces more, so
  // not even a freshly-placed yard/quarry could ever finish building
  // itself. This trickle is deliberately below what a single working yard
  // produces (LUMBER_RATE), so it does nothing once real production
  // exists; it only exists so hitting rock bottom is always recoverable.
  const EMERGENCY_TRICKLE = 2;

  // A zoned tile doesn't need to touch a road directly — it just needs one
  // within this radius (bigger with road upgrades), like a real city block
  // set back from its frontage road.
  const ROAD_BASE_RADIUS = 3;
  const ROAD_UPGRADE_STEP = 2; // extra radius per road upgrade tier

  // Lumber Yards/Quarries producing side-by-side (an "industrial cluster")
  // each get a flat bonus per same-type built neighbor (8-neighborhood) —
  // this is what makes tile placement/layout matter, not just raw counts.
  const CLUSTER_BONUS_PER_NEIGHBOR = 0.25;

  // Farms feed Residential growth: a farm's output decays linearly with
  // distance to zero at FOOD_RADIUS (an isolated house near the field gets
  // full benefit; one at the edge of range gets almost none), and a res
  // zone needs food proportional to its current density to grow further.
  // This is the bottleneck on population growth — food is a coverage
  // value recomputed every tick, not a stockpile.
  const FOOD_RADIUS = 6;
  const FOOD_RATE = 6; // per farm, at distance 0 (before upgrades)
  const FOOD_PER_LEVEL = 4; // food a res zone needs per (level+1) to grow further

  // Storage: raw materials and finished Goods are capped so they can't
  // grow forever. Warehouses raise every cap AND raise how much Goods can
  // be exported per day — they're the export terminal, not just a shelf.
  const STORAGE_BASE = { lumber: 100, concrete: 100, goods: 60 };
  const WAREHOUSE_BONUS = { lumber: 80, concrete: 80, goods: 80 };
  const GOODS_EXPORT_BASE = 3; // units/day exportable with zero warehouses
  const GOODS_EXPORT_PER_WAREHOUSE = 6; // extra export capacity per built warehouse

  // Goods sell into a market with finite depth: the price is per-unit, but
  // flooding it with more units *per day* drives that price down toward a
  // floor. Without this the 300th unit/day earned exactly as much as the
  // first, so the export loop was a linear money printer with no marginal
  // pressure — the single biggest reason a saturated city just accrued
  // cash forever. Revenue still rises with volume, but sub-linearly, so
  // scaling up production is worth less per unit than making each unit
  // cheaper to produce (upgrades, clustering, tighter layout).
  const GOODS_PRICE = 8; // $ per unit at low volume
  const GOODS_PRICE_FLOOR = 2; // $ per unit the price never falls below
  const GOODS_MARKET_DEPTH = 120; // units/day at which the premium has halved

  // Running a city has an administrative cost that grows faster than the
  // city does — a 900-tile city costs far more than 9x a 100-tile one to
  // run. Per-tile upkeep alone is flat, so income (which scales with
  // population and production) always outran it; this is the term that
  // makes sprawl genuinely expensive and forces tight, deliberate layout.
  // Deliberately negligible for a small starting city.
  const ADMIN_COST_PER_TILE = 0.15;
  const ADMIN_SCALING = 1.2; // exponent — >1 is what makes it super-linear
  const IND_INPUT_PER_LEVEL = 1; // lumber AND concrete consumed, per zone level, per day
  const IND_OUTPUT_PER_LEVEL = 2; // goods produced, per zone level, per day

  // Tax is deliberately a minor trickle, not a viable income strategy on
  // its own — Goods export (production + warehouses) is meant to carry the
  // treasury. Measured at a saturated city these rates leave export at
  // ~62% of gross income; raising them is what previously let a player
  // coast on zoning alone. See README for the reasoning.
  const TAX = { res: 0.09, com: 0.14, ind: 0.11 };
  const JOB_TAX_FACTOR = 0.6; // jobs are taxed at this fraction of their rate

  // Lose conditions. A single bad day never ends the game — both require
  // a sustained failure, not a momentary dip.
  const BANKRUPTCY_DEBT_DAYS = 30; // consecutive days with money < 0
  const COLLAPSE_POPULATION_THRESHOLD = 10; // must have gotten at least this big once...
  // ...before falling back to 0 population counts as a collapse rather
  // than "hasn't started growing yet".

  // A built zone that goes unserved (unpowered, road-cut, or — for
  // Residential — unfed) for this many consecutive days starts losing
  // levels instead of just failing to grow. This is what makes City
  // Collapse actually reachable through neglect, not just self-bulldozing.
  const NEGLECT_TICKS_BEFORE_DECAY = 10;
  const NEGLECT_DECAY_CHANCE = 0.2;

  const BUILD = {
    road:      { cost: 5,   lumber: 1,  concrete: 0,  ticks: 1, color: "#555",    label: "Road" },
    res:       { cost: 15,  lumber: 2,  concrete: 1,  ticks: 3, color: "#4caf50", label: "Residential" },
    com:       { cost: 15,  lumber: 2,  concrete: 1,  ticks: 3, color: "#42a5f5", label: "Commercial" },
    ind:       { cost: 15,  lumber: 2,  concrete: 1,  ticks: 3, color: "#ffb74d", label: "Industrial" },
    power:     { cost: 500, lumber: 20, concrete: 30, ticks: 8, color: "#e0665a", label: "Power Plant" },
    park:      { cost: 20,  lumber: 3,  concrete: 0,  ticks: 2, color: "#2e7d32", label: "Park" },
    lumber:    { cost: 100, lumber: 5,  concrete: 0,  ticks: 4, color: "#8d6e63", label: "Lumber Yard" },
    quarry:    { cost: 100, lumber: 5,  concrete: 5,  ticks: 4, color: "#78909c", label: "Quarry" },
    warehouse: { cost: 150, lumber: 10, concrete: 10, ticks: 5, color: "#a1887f", label: "Warehouse" },
    farm:      { cost: 80,  lumber: 3,  concrete: 0,  ticks: 3, color: "#c9a227", label: "Farm" }
  };
  const BULLDOZE_COST = 5;
  const UPKEEP = { road: 0.5, zone: 1, power: 20, park: 1, yard: 0.5, warehouse: 1, farm: 0.5 };

  // Power Plants, Lumber Yards, Quarries, Roads, and Farms can each be
  // upgraded twice: more output/radius per tier, and lower upkeep.
  const UPGRADE_MAX_LEVEL = 2;
  const UPGRADEABLE_TYPES = ["power", "lumber", "quarry", "road", "farm"];

  function formatList(items) {
    if (items.length <= 1) return items.join("");
    if (items.length === 2) return items.join(" or ");
    return items.slice(0, -1).join(", ") + ", or " + items[items.length - 1];
  }
  // Generated from UPGRADEABLE_TYPES so adding a new upgradeable building
  // can't leave this message silently out of date (it happened twice).
  const UPGRADE_REJECTION_MESSAGE =
    "Select a built " + formatList(UPGRADEABLE_TYPES.map((t) => BUILD[t].label)) + " to upgrade.";

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
      upgrading: null,
      neglect: 0
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
      foodSupply: 0,
      foodDemand: 0,
      demand: { res: 50, com: 20, ind: 20 },
      builtTiles: 0,
      lastNet: 0,
      lastIncome: 0,
      lastUpkeep: 0,
      lastAdmin: 0,
      lastExported: 0,
      lastGoodsPrice: GOODS_PRICE,
      debtStreak: 0,
      peakPopulation: 0,
      gameOver: null
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

  // Per-unit price for selling `volume` goods in a single day. Hyperbolic
  // decay from GOODS_PRICE toward GOODS_PRICE_FLOOR — never zero, so a big
  // exporter still earns, just at thin margins.
  function goodsPriceFor(volume) {
    if (!(volume > 0)) return GOODS_PRICE;
    return GOODS_PRICE_FLOOR + (GOODS_PRICE - GOODS_PRICE_FLOOR) / (1 + volume / GOODS_MARKET_DEPTH);
  }

  // Commercial and Industrial zones need people to staff them. If the city
  // has fewer residents than jobs, every job-holding zone runs at that
  // fraction of capacity. This is what makes population an input to the
  // economy rather than just a score: before it existed, an all-Industrial
  // city with zero housing produced Goods at full rate and skipped the
  // entire Residential/farm/food system.
  function staffingRatio(game) {
    const jobs = game.jobs || 0;
    if (jobs <= 0) return 1;
    return clamp((game.population || 0) / jobs, 0, 1);
  }

  // Super-linear administrative cost from the city's total built footprint.
  function adminCost(game) {
    const tiles = game.builtTiles || 0;
    if (tiles <= 0) return 0;
    return ADMIN_COST_PER_TILE * Math.pow(tiles, ADMIN_SCALING);
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

  // Splats each built Farm's output outward with linear distance falloff
  // (full strength at the farm, zero past FOOD_RADIUS), accumulating into
  // every tile's foodSupply. Mirrors computePower's structure, but sums a
  // weighted value instead of setting a flag, since food is graded rather
  // than in/out of range.
  function computeFood(game) {
    const { board } = game;
    for (let y = 0; y < GRID_H; y++)
      for (let x = 0; x < GRID_W; x++) board[y][x].foodSupply = 0;

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const farm = board[y][x];
        if (farm.type !== "farm" || farm.status !== "built") continue;
        const rate = effectiveRate(FOOD_RATE, farm);
        for (let dy = -FOOD_RADIUS; dy <= FOOD_RADIUS; dy++) {
          for (let dx = -FOOD_RADIUS; dx <= FOOD_RADIUS; dx++) {
            const nx = x + dx, ny = y + dy;
            if (!inBounds(nx, ny)) continue;
            const dist = Math.max(Math.abs(dx), Math.abs(dy));
            if (dist > FOOD_RADIUS) continue;
            board[ny][nx].foodSupply += rate * (1 - dist / FOOD_RADIUS);
          }
        }
      }
    }
  }

  // How much food a res zone needs (from all farms in range combined) to
  // be eligible to grow past its current level.
  function foodNeedFor(tile) {
    return FOOD_PER_LEVEL * (tile.level + 1);
  }

  // How much food a res zone needs to *hold* its current level without
  // being neglected. Deliberately lower than foodNeedFor: reaching a level
  // only required enough food for the next tier at the moment of growth,
  // so demanding that same higher amount forever after would flag every
  // zone that just grew as neglected. 0 at level 0 — an un-grown zone
  // can't starve.
  function foodNeedToMaintain(tile) {
    return FOOD_PER_LEVEL * tile.level;
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
    let population = 0, comJobs = 0, indJobs = 0, foodSupply = 0, foodDemand = 0, builtTiles = 0;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = board[y][x];
        if (t.status !== "built") continue;
        builtTiles++;
        if (t.type === "res") { population += t.level * CAP_PER_LEVEL; foodDemand += foodNeedFor(t); }
        if (t.type === "com") comJobs += t.level * CAP_PER_LEVEL;
        if (t.type === "ind") indJobs += t.level * CAP_PER_LEVEL;
        if (t.type === "farm") foodSupply += effectiveRate(FOOD_RATE, t);
      }
    }
    game.population = population;
    game.jobs = comJobs + indJobs;
    game.comJobs = comJobs;
    game.indJobs = indJobs;
    game.builtTiles = builtTiles;
    game.peakPopulation = Math.max(game.peakPopulation || 0, population);
    // City-wide totals for display only — actual growth eligibility below
    // uses each res zone's own local foodSupply (from computeFood), since
    // food doesn't pool globally the way Lumber/Concrete/Goods do.
    game.foodSupply = foodSupply;
    game.foodDemand = foodDemand;

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

  function gameOverMessage(game) {
    if (!game.gameOver) return undefined;
    return game.gameOver.reason === "bankruptcy"
      ? "Game over — the city went bankrupt."
      : "Game over — the city collapsed.";
  }

  // Returns undefined on success, or a user-facing message on rejection.
  // Unlike a fresh build, an upgrading tile stays fully operational at its
  // current tier the whole time — this only affects a tile that's already
  // status==="built".
  function startUpgrade(game, x, y) {
    const over = gameOverMessage(game);
    if (over) return over;
    if (!inBounds(x, y)) return undefined;
    const t = game.board[y][x];
    if (!UPGRADEABLE_TYPES.includes(t.type) || t.status !== "built") {
      return UPGRADE_REJECTION_MESSAGE;
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
    if (game.gameOver) return; // frozen: the run has already ended
    const { board, stock } = game;
    computePower(game);
    computeFood(game);
    recomputeCaps(game);

    // Production runs before anything consumes stock, so construction and
    // upgrades see *today's* fresh material instead of always trailing a
    // full tick behind. This also gives them first claim on it ahead of
    // Industrial consumption below — a half-built Power Plant is more
    // urgent than incremental Goods output, and previously Industrial
    // effectively got priority just by running later in tick order, which
    // could leave new construction stuck at 0% indefinitely whenever
    // Industrial consumption kept pace with a single Quarry's output.
    let builtLumberYards = 0, builtQuarries = 0;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = board[y][x];
        if (t.status !== "built") continue;
        if (t.type === "lumber") {
          builtLumberYards++;
          const cluster = countClusterNeighbors(game, x, y, "lumber");
          const rate = effectiveRate(LUMBER_RATE, t) * (1 + CLUSTER_BONUS_PER_NEIGHBOR * cluster);
          stock.lumber = Math.min(stock.lumber + rate, stock.lumberCap);
        }
        if (t.type === "quarry") {
          builtQuarries++;
          const cluster = countClusterNeighbors(game, x, y, "quarry");
          const rate = effectiveRate(CONCRETE_RATE, t) * (1 + CLUSTER_BONUS_PER_NEIGHBOR * cluster);
          stock.concrete = Math.min(stock.concrete + rate, stock.concreteCap);
        }
      }
    }
    // See EMERGENCY_TRICKLE: guarantees recovery even from zero producers.
    if (builtLumberYards === 0) stock.lumber = Math.min(stock.lumber + EMERGENCY_TRICKLE, stock.lumberCap);
    if (builtQuarries === 0) stock.concrete = Math.min(stock.concrete + EMERGENCY_TRICKLE, stock.concreteCap);

    stepConstruction(game, onProgress);
    stepUpgrades(game);

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = board[y][x];
        if (t.status !== "built" || (t.type !== "res" && t.type !== "com" && t.type !== "ind")) continue;
        // Food only gates Residential — jobs don't need to eat. This is
        // the population bottleneck: a house can be powered, road-served,
        // and in demand, and still not grow if no farm reaches it.
        //
        // Growing to the next level and *holding* the current one are
        // different thresholds: foodNeedFor is next-tier food, so a zone
        // that just grew would otherwise fail its own upkeep check the
        // very next tick even with completely stable food/power/road.
        const basicService = t.powered && hasRoadService(game, x, y);
        const fedToMaintain = t.type !== "res" || t.foodSupply >= foodNeedToMaintain(t);
        const fedToGrow = t.type !== "res" || t.foodSupply >= foodNeedFor(t);
        const maintained = basicService && fedToMaintain;
        const canGrow = basicService && fedToGrow;
        if (maintained) {
          // Served: neglect resets.
          t.neglect = 0;
        } else {
          // Unserved (unpowered, road-cut, or short even of upkeep food):
          // a brief outage is forgiven, but sustained neglect starts
          // costing levels — this is what makes City Collapse reachable
          // through play instead of only via self-bulldozing.
          t.neglect = (t.neglect || 0) + 1;
          if (t.neglect > NEGLECT_TICKS_BEFORE_DECAY && t.level > 0) {
            if (Math.random() < NEGLECT_DECAY_CHANCE) t.level -= 1;
          }
        }
        if (canGrow) {
          const d = game.demand[t.type];
          if (d > 0 && t.level < MAX_LEVEL) {
            if (Math.random() < 0.3) t.level += 1;
          } else if (d < -70 && t.level > 0) {
            if (Math.random() < 0.15) t.level -= 1;
          }
        }
      }
    }

    // Totals are recomputed here, *before* Industrial runs, so staffing
    // reflects this tick's actual population and job count including the
    // growth loop just above. Reading last tick's totals instead left a
    // bootstrap hole: on a fresh game jobs was still 0, staffingRatio
    // returned its "no jobs, no constraint" default of 1, and a city with
    // industry but no residents got one free fully-staffed day.
    recomputeTotals(game);

    // Industrial zones are the only material sink beyond upkeep: they
    // convert raw Lumber+Concrete into Goods (capped), throttled by
    // whichever is scarcer — available input, remaining Goods storage, or
    // how much of their capacity the population can actually staff.
    const staffing = staffingRatio(game);
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = board[y][x];
        if (t.status !== "built" || t.type !== "ind" || t.level <= 0) continue;
        const wantInput = t.level * IND_INPUT_PER_LEVEL * staffing;
        const wantOutput = t.level * IND_OUTPUT_PER_LEVEL * staffing;
        if (wantOutput <= 0) continue;
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

    const exportRate = effectiveExportRate(game);
    const exported = Math.min(stock.goods || 0, exportRate);
    stock.goods = (stock.goods || 0) - exported;

    const unitPrice = goodsPriceFor(exported);
    game.lastGoodsPrice = unitPrice;
    game.lastExported = exported;
    // Commercial and Industrial jobs are taxed at their own rates —
    // TAX.ind used to be dead: every job was billed at TAX.com.
    let income = game.population * TAX.res
      + (game.comJobs || 0) * TAX.com * JOB_TAX_FACTOR
      + (game.indJobs || 0) * TAX.ind * JOB_TAX_FACTOR
      + exported * unitPrice;
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
        else if (t.type === "farm") upkeep += UPKEEP.farm * upkeepMultiplier(t);
      }
    }
    const admin = adminCost(game);
    game.lastAdmin = admin;
    game.lastIncome = income;
    game.lastUpkeep = upkeep + admin;
    game.lastNet = Math.round(income - upkeep - admin);
    game.money += game.lastNet;
    game.day += 1;

    // Lose conditions: both require a sustained failure, not one bad tick.
    game.debtStreak = game.money < 0 ? (game.debtStreak || 0) + 1 : 0;
    if (game.debtStreak >= BANKRUPTCY_DEBT_DAYS) {
      game.gameOver = { reason: "bankruptcy", day: game.day };
    } else if (game.peakPopulation >= COLLAPSE_POPULATION_THRESHOLD && game.population === 0) {
      game.gameOver = { reason: "collapse", day: game.day };
    }
  }

  // Returns undefined on success, or a user-facing message on rejection.
  function placeTile(game, x, y, tool) {
    const over = gameOverMessage(game);
    if (over) return over;
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
    FOOD_RADIUS, FOOD_RATE, FOOD_PER_LEVEL,
    LUMBER_RATE, CONCRETE_RATE, EMERGENCY_TRICKLE, BUILD, BULLDOZE_COST, UPKEEP, TAX, JOB_TAX_FACTOR,
    STORAGE_BASE, WAREHOUSE_BONUS, GOODS_EXPORT_BASE, GOODS_EXPORT_PER_WAREHOUSE, GOODS_PRICE,
    GOODS_PRICE_FLOOR, GOODS_MARKET_DEPTH, ADMIN_COST_PER_TILE, ADMIN_SCALING,
    IND_INPUT_PER_LEVEL, IND_OUTPUT_PER_LEVEL,
    UPGRADE_MAX_LEVEL, UPGRADEABLE_TYPES, UPGRADE_REJECTION_MESSAGE, upgradeCost,
    BANKRUPTCY_DEBT_DAYS, COLLAPSE_POPULATION_THRESHOLD,
    NEGLECT_TICKS_BEFORE_DECAY, NEGLECT_DECAY_CHANCE,
    effectiveRate, effectivePowerRadius, effectiveRoadRadius, effectiveExportRate, upkeepMultiplier,
    goodsPriceFor, staffingRatio, adminCost,
    clamp, inBounds, newTile, newSite, createGame, gameOverMessage,
    isBuiltRoad, hasAdjacentRoad, adjacentBuiltRoad, hasRoadService, countClusterNeighbors,
    computePower, computeFood, foodNeedFor, foodNeedToMaintain, recomputeCaps, recomputeTotals, bfsPath,
    advanceSite, stepConstruction, startUpgrade, stepUpgrades,
    simTick, placeTile
  };
});
