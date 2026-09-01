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
  park, lumber yard, quarry, warehouse.
- Placing a tile costs money up front and starts a **construction site**:
  it consumes Lumber/Concrete from the shared stockpile over several
  simulated days before it becomes functional. Short on materials and the
  site stalls (red hatching) until a Lumber Yard/Quarry restocks the
  stockpile — it does not fail, just waits.
- Lumber Yards and Quarries produce materials per day once built; cosmetic
  delivery trucks path over the built road network from yard to active
  site while it's receiving materials.
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
  Yard, or Quarry to raise its output/radius and lower its upkeep — an
  upgrading building stays fully operational at its current tier the whole
  time, it's not taken offline. This is the other main materials sink:
  growing the city means spending materials on both production output
  (upgrades) and on new construction, not just accumulating them. Roads
  aren't upgradeable yet — there's no capacity mechanic for them to improve
  (see Known simplifications).
- Zoned tiles only grow through their 3 density levels once **built**,
  adjacent to a built road, and within a built power plant's radius.
  Demand for R/C/I is computed each simulated day from population vs. jobs.
- Treasury tracks tax income (plus Goods export revenue) against per-tile
  upkeep; net/day shown live.
- Existing tiles can't be overwritten by picking a different tool — bulldoze
  first. This also makes click/tap-drag painting safe: it only fills empty
  tiles it passes over.
- Save/Load persist to the browser's localStorage; loading merges onto a
  fresh game so a save from before Goods/caps/upgrades existed still loads
  without crashing the economy.

## Controls

- Pick a tool from the panel, then click/tap or drag on the grid to place it
  on an empty tile.
- **Upgrade** tool: tap an existing built Power Plant/Lumber Yard/Quarry
  (rather than an empty tile) to spend money+materials improving it.
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
needed, Node 18+. Covers placement rules (occupied-tile rejection, cost
deduction), construction staging (multi-tick completion, stalling on
short materials), the Lumber Yard/Quarry material-reservation guarantee,
power radius, road/power/built-status gating of zone growth, the RCI
demand bootstrap, storage caps (production clamping, Warehouse cap boost),
Industrial goods production/export, and the Upgrade mechanic (rejection
cases, cost deduction, effect on output/radius/upkeep). The material-
reservation and RCI-bootstrap tests are direct regressions for bugs found
in play: a shared-stockpile deadlock where simultaneous construction
could permanently starve the only tiles that produce more material, and
a demand-formula regression that left `population`/`jobs` stuck at zero
forever. Run this after any change to `engine.js` before touching
`index.html`'s rendering/input code on top of it.

## Known simplifications

No real logistics (material delivery is a global stockpile, not routed
per-site — delivery trucks are cosmetic only), no disasters, no land
value/pollution, no multi-tile buildings, no pinch-to-zoom gesture (buttons
only), no road upgrades (no capacity mechanic exists for roads yet — traffic
is cosmetic), and Goods export is a flat rate rather than tied to
Commercial capacity. These are straightforward to layer onto the existing
tile/state model in `index.html` if the prototype needs to grow.
