# City Manager

Single-file, dependency-free RTS city-builder prototype. Open `index.html` in
any browser — no build step, no server required.

## Mechanics

- Grid of tiles: road, residential/commercial/industrial zones, power plant, park.
- Zoned tiles only develop (and grow through 3 density levels) when adjacent
  to a road and within a power plant's radius.
- Demand for R/C/I is computed each simulated day from population vs. jobs
  and drives zone growth or decay.
- Treasury tracks tax income against per-tile upkeep; net/day shown live.
- Traffic dots wander the road network for visual feedback only.
- Save/Load persist to the browser's localStorage.

## Controls

- Pick a tool from the panel, then click or click-drag on the grid to place it.
- Bulldoze clears a tile.
- Speed buttons (1x/2x/3x) and Pause control simulation rate.

## Known simplifications

No pathfinding, no disasters, no land value/pollution, no multi-tile
buildings. These are straightforward to layer on top of the existing
tile/state model in `index.html` if the prototype needs to grow.
