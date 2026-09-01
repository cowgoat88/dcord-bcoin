# City Manager

Dependency-free construction-management prototype. Open `index.html` in
any browser — no build step, no server required. Runs on desktop and
mobile (touch input, pinch-free zoom/pan controls).

`engine.js` holds the core simulation (grid, construction staging,
material stockpile, power/road adjacency, RCI demand/economy) with no
DOM or canvas dependency, loaded by `index.html` as a plain `<script>`
before the page's own rendering/input code. This is what `engine.test.js`
exercises directly.

## Mechanics

- Grid of tiles: road, residential/commercial/industrial zones, power plant,
  park, lumber yard, quarry, warehouse, farm.
- Placing a tile costs money up front and starts a **construction site**:
  it consumes Lumber/Concrete from the shared stockpile over several
  simulated days before it becomes functional. Short on materials and the
  site stalls (red hatching) until a Lumber Yard/Quarry restocks the
  stockpile — it does not fail, just waits.
- Lumber Yards and Quarries produce materials per day once built; cosmetic
  delivery trucks path over the built road network from yard to active
  site while it's receiving materials.
- **Zero-producer safety net**: if every Lumber Yard (or every Quarry) is
  gone — bulldozed, or the starting stock got spent before one finished —
  a small trickle of that material (`EMERGENCY_TRICKLE`, below what even
  one working yard produces) accrues regardless. Without it, hitting
  exactly 0 stock with no surviving producer was an unrecoverable dead
  end: nothing produced more, so not even a freshly-placed yard could
  ever finish building itself. The trickle does nothing once a real
  producer exists.
- **Lumber and Concrete are capped**, not unlimited — production stops
  adding to a stockpile that's already full. A **Warehouse** raises every
  cap (Lumber, Concrete, and Goods) once built.
- **Industrial zones are the material sink**: once built and leveled, each
  one converts Lumber+Concrete into **Goods** every day (more at higher
  density), throttled by whichever runs out first — raw input or remaining
  Goods storage. Goods auto-export for cash at a flat daily rate, so a
  developed industrial base is what actually turns raw materials into
  steady income instead of letting the stockpile just climb.
- **Upgrades**: the Upgrade tool spends money + materials (over several
  days, 2 tiers, cost rising each tier) on any built Power Plant, Lumber
  Yard, Quarry, Road, or Farm to raise its output/radius/service-radius and
  lower its upkeep — an upgrading building stays fully operational at its
  current tier the whole time, it's not taken offline. This is the other
  main materials sink: growing the city means spending materials on both
  production output (upgrades) and new construction, not just
  accumulating them.
- **Farms feed Residential — the population bottleneck**: a Farm's output
  decays linearly with distance, full strength at the farm down to zero at
  its radius (6 tiles by default). A res zone sums whatever every nearby
  farm contributes; if that total falls short of what its current density
  needs, it stops growing (orange outline) even if fully powered, road-
  served, and in demand. Only Residential needs food — jobs don't eat.
  This means population growth has its own bottleneck independent of
  power/road/materials: a city needs farm coverage spread across its
  housing, not just one farm somewhere on the map.
- **Clustering**: Lumber Yards and Quarries built next to each other (8
  neighbors) each get a flat output bonus per adjacent same-type built
  tile — a deliberate district of yards outproduces the same number of
  yards scattered around the map.
- **Road service radius**: a zoned tile doesn't need to touch a road
  directly — it grows as long as a road is within radius (3 tiles by
  default, +2 per road upgrade tier) and it's powered. This lets you build
  blocks set back from the frontage road, and upgrading a road extends how
  far its coverage reaches.
- Zoned tiles only grow through their 3 density levels once **built**,
  within a built road's service radius, and within a built power plant's
  radius. Demand for R/C/I is computed each simulated day from population
  vs. jobs.
- **Income is now mostly Goods export, not tax**: tax rates are a minor
  trickle (barely covers upkeep on their own at any real population).
  Warehouses raise export *capacity* as well as storage caps, so building
  up an industrial base (raw material production → Industrial zones →
  Goods → Warehouses to export more of it) is the actual path to a
  growing treasury, not just zoning residential and waiting.
- Existing tiles can't be overwritten by picking a different tool — bulldoze
  first. This also makes click/tap-drag painting safe: it only fills empty
  tiles it passes over.
- Save/Load persist to the browser's localStorage; loading merges onto a
  fresh game so a save from before Goods/caps/upgrades existed still loads
  without crashing the economy.

## Controls

- Pick a tool from the panel, then click/tap or drag on the grid to place it
  on an empty tile.
- **Upgrade** tool: tap an existing built Power Plant/Lumber Yard/Quarry/
  Road/Farm (rather than an empty tile) to spend money+materials improving it.
- Bulldoze clears any tile, including one mid-construction (no refund).
- Zoom (1x–4x) and the Pan toggle control the camera — Pan mode drags the
  view instead of painting, which is the fix for tiles being too small to
  tap accurately on a phone. Mobile starts at 3x zoom automatically.
- Speed buttons (1x/2x/3x) and Pause control simulation rate.
- The side panel scrolls independently of the page on desktop, so the
  canvas never shifts position as more tools are added.

## Tests

```
node --test city-manager/engine.test.js
```

Uses Node's built-in test runner (`node:test`/`node:assert`) — no install
needed, Node 18+. 33 cases covering placement rules, construction staging,
the Lumber Yard/Quarry material-reservation guarantee, power radius,
zone-growth gating, the RCI demand bootstrap, storage caps, Warehouse cap
boost, Industrial goods production/export, the Upgrade mechanic (all
five upgradeable types, rejection cases, cost deduction, effects), the
road service radius (base + upgraded), the clustering output bonus, the
tax-vs-export income balance, the food mechanic (distance falloff,
res-only gating, growth unblocked once fed), and the zero-producer
safety net. These are direct regressions for bugs found in play: a
shared-stockpile deadlock where simultaneous construction could
permanently starve the only tiles that produce more material; a
demand-formula regression that left `population`/`jobs` stuck at zero
forever; and hitting exactly 0 stock with no surviving Lumber Yard/Quarry
being an unrecoverable dead end. Run this after any change to
`engine.js` before touching `index.html`'s rendering/input code on top
of it.

## Known simplifications

No real logistics (material delivery is a global stockpile, not routed
per-site — delivery trucks are cosmetic only), no disasters, no land
value/pollution, no multi-tile buildings, no pinch-to-zoom gesture (buttons
only), and Goods export capacity scales with Warehouse count rather than
Commercial capacity. These are straightforward to layer onto the existing
tile/state model in `index.html` if the prototype needs to grow.
