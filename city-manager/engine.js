// Core simulation for City Manager: grid state, construction staging,
// material stockpile, power/road adjacency, and RCI demand/economy.
// No DOM, no canvas, no timers — safe to run under plain Node for tests
// (engine.test.js) and loaded as a plain <script> by index.html, which
// owns all rendering/input/camera/cosmetic-traffic code on top of this.
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
  const LUMBER_RATE = 3, CONCRETE_RATE = 3; // per built yard, per day

  const BUILD = {
    road:    { cost: 5,   lumber: 1,  concrete: 0,  ticks: 1, color: "#555",    label: "Road" },
    res:     { cost: 15,  lumber: 2,  concrete: 1,  ticks: 3, color: "#4caf50", label: "Residential" },
    com:     { cost: 15,  lumber: 2,  concrete: 1,  ticks: 3, color: "#42a5f5", label: "Commercial" },
    ind:     { cost: 15,  lumber: 2,  concrete: 1,  ticks: 3, color: "#ffb74d", label: "Industrial" },
    power:   { cost: 500, lumber: 20, concrete: 30, ticks: 8, color: "#e0665a", label: "Power Plant" },
    park:    { cost: 20,  lumber: 3,  concrete: 0,  ticks: 2, color: "#2e7d32", label: "Park" },
    lumber:  { cost: 100, lumber: 5,  concrete: 0,  ticks: 4, color: "#8d6e63", label: "Lumber Yard" },
    quarry:  { cost: 100, lumber: 5,  concrete: 5,  ticks: 4, color: "#78909c", label: "Quarry" }
  };
  const BULLDOZE_COST = 5;
  const UPKEEP = { road: 0.5, zone: 1, power: 20, park: 1, yard: 0.5 };
  const TAX = { res: 0.5, com: 1, ind: 0.8 };

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
      stalled: false
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
      stock: { lumber: 30, concrete: 15 },
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

  function computePower(game) {
    const { board } = game;
    for (let y = 0; y < GRID_H; y++)
      for (let x = 0; x < GRID_W; x++) board[y][x].powered = false;

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        if (board[y][x].type !== "power" || board[y][x].status !== "built") continue;
        for (let dy = -POWER_RADIUS; dy <= POWER_RADIUS; dy++) {
          for (let dx = -POWER_RADIUS; dx <= POWER_RADIUS; dx++) {
            const nx = x + dx, ny = y + dy;
            if (!inBounds(nx, ny)) continue;
            if (Math.max(Math.abs(dx), Math.abs(dy)) <= POWER_RADIUS) board[ny][nx].powered = true;
          }
        }
      }
    }
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

  function simTick(game, onProgress) {
    const { board } = game;
    computePower(game);
    stepConstruction(game, onProgress);

    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = board[y][x];
        if (t.status !== "built" || (t.type !== "res" && t.type !== "com" && t.type !== "ind")) continue;
        const eligible = t.powered && hasAdjacentRoad(game, x, y);
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
        if (t.type === "lumber") game.stock.lumber += LUMBER_RATE;
        if (t.type === "quarry") game.stock.concrete += CONCRETE_RATE;
      }
    }

    recomputeTotals(game);

    let income = game.population * TAX.res + game.jobs * TAX.com * 0.6;
    let upkeep = 0;
    for (let y = 0; y < GRID_H; y++) {
      for (let x = 0; x < GRID_W; x++) {
        const t = board[y][x];
        if (t.status !== "built") continue;
        if (t.type === "road") upkeep += UPKEEP.road;
        else if (t.type === "res" || t.type === "com" || t.type === "ind") upkeep += UPKEEP.zone * t.level;
        else if (t.type === "power") upkeep += UPKEEP.power;
        else if (t.type === "park") upkeep += UPKEEP.park;
        else if (t.type === "lumber" || t.type === "quarry") upkeep += UPKEEP.yard;
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
    LUMBER_RATE, CONCRETE_RATE, BUILD, BULLDOZE_COST, UPKEEP, TAX,
    clamp, inBounds, newTile, newSite, createGame,
    isBuiltRoad, hasAdjacentRoad, adjacentBuiltRoad,
    computePower, recomputeTotals, bfsPath,
    advanceSite, stepConstruction, simTick, placeTile
  };
});
