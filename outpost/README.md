# OUTPOST

A real-time command & control game. Open `index.html` in any browser — no
build step, no server, no dependencies, no asset files (even the sound is
synthesised at runtime).

Hold positions, build forces, and send them down the supply lanes until
the map is yours. A match runs about two to five minutes.

## How it plays

- **Drag** one of your positions onto any other node to order an attack.
- **Tap** your positions to build a group, then **tap a target** to send
  the whole group at once.
- **Commit** (25/50/75/All) sets how much of each garrison an order sends.
- **Credits** come from Mines and pay for **upgrades**.
- Hotkeys: `A` select all, `U` upgrade, `1`–`4` commit level, `Space`
  pause, `Esc` clear selection.

Positions are shaped by role, so the map is readable without labels:
hexagon **Command** (your strongest producer, and where you start),
square **Factory** (the unit engine), diamond **Mine** (pays credits),
circle **Outpost** (cheap ground that links lanes).

## The one rule that matters

**Defenders fight at ×1.25, so a single position can never take an equal
one.** Winning ground means concentrating several positions on one target
at the same time. Everything else in the design follows from making that
the central skill:

- **Orders route anywhere.** You can send from any position to any node,
  and the fleet convoys along the lane network. Restricting orders to a
  single hop makes concentration geometrically impossible, because front
  lines are only one or two nodes wide — and the map simply freezes.
- **Converging forces combine.** Fleets that reach the same target within
  a one-second window fight as one force. Without this, well-timed
  attacks are still defeated one at a time and coordination is pointless.
- **Upgrades scale production, not durability.** Rate rises +75% a tier
  while capacity rises only +25%, so investing pays off without putting a
  position beyond any force that could be fielded against it.
- **The attack preview** shows your committed force against the target's
  defence before you commit, so the ×1.25 rule is something you learn
  rather than something that silently eats your army.

## Design notes

These were found by measurement, not guesswork, and each one replaced
something that did not work:

- **Every match used to stalemate.** With single-hop orders and capacity
  scaling on upgrades, all 24 test matches ran to the time limit: once
  the map was divided, every position sat at its cap and no attack could
  ever succeed. Multi-hop orders, coalescing arrivals and the rate/cap
  split fixed it — matches now resolve in 40s–4min, and a regression test
  asserts that six seeds all reach a winner.
- **Difficulty was inverted.** Tiers defined by how *recklessly* the AI
  attacked made the "ruthless" setting the weakest, because attacking on
  thin margins dribbles an army away. Every tier now keeps the same good
  attack threshold, and difficulty scales how often the AI acts and how
  many positions it can coordinate.
- **The map adapts to your screen.** A fixed-aspect map letterboxed into a
  portrait phone left the playfield in a thin band with nodes too small to
  tap. The map is now generated to the viewport's aspect ratio with its
  area held constant, so pacing is identical on a phone and a desktop.
- **Node positions are relaxed.** Pure rejection sampling left points
  huddled wherever they first fit; a few rounds of mutual repulsion spread
  them into a layout that uses the whole board.
- **Maps are point-symmetric.** Each is generated in one half and rotated
  180°, so both sides face an identical problem and a loss is never the
  map's fault. Same seed, same map — the seed is shown on the start
  screen and `Retry Seed` replays it.

## Architecture

`engine.js` is the whole simulation and has no DOM, no canvas, no timers
and no `Math.random` — it runs on a seeded RNG and a fixed timestep, so a
match is reproducible from its seed and testable under plain Node.
`index.html` owns rendering, input and effects, and talks to the engine
only through orders (`sendFleet`, `upgradeNode`) and a drained event
queue. The AI plays through the same `sendFleet` the player does; it has
no private powers.

## Tests

```
node --test outpost/engine.test.js
```

Node's built-in runner, no install needed (Node 18+). 29 cases covering
map connectivity and symmetry, deterministic generation, viewport
adaptation, order validation, multi-hop routing, the defender edge,
arrival coalescing, capture and reinforcement, production and capacity,
the credit economy, upgrade costs and limits, win detection, AI expansion
and concentration, and the stalemate regression.
