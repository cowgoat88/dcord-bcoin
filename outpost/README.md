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
- **Credits** come from Mines and pay for two different things: **node
  upgrades** (a single position produces more) and **research** (a
  permanent, army-wide bonus). What you skip is the real decision.
- Hotkeys: `A` select all, `U` upgrade, `Q` Assault, `W` Fortify,
  `1`–`4` commit level, `Space` pause, `Esc` clear selection.

## Research

Two progressive tracks in the StarCraft mould — three levels each, each
level costing more than the last, and each applying to your entire force
the moment it completes:

| Track | Per level | Max | Costs | Effect |
|---|---|---|---|---|
| ⚔ **Assault** | +15% | +45% | 90 / 200 / 360 | Everything you attack with hits harder |
| ⛨ **Fortify** | +10% | +30% | 80 / 175 / 320 | Every position you hold defends harder |

Both sides can research, and the AI does (except on Cadet), so the enemy's
current levels are shown in the top bar — it is the thing to watch and
answer. Because both tracks are available to both players, **equal
research leaves the force balance exactly where it started**; progression
moves the numbers without moving the balance, which is the property that
makes this model work.

**Assault deliberately out-scales Fortify.** Three reasons, all measured:

1. Defenders already hold a flat ×1.25 before any research.
2. You must attack to win, so Assault is mandatory and Fortify is the
   greedy pick. At equal value, Fortify would simply be the better buy.
3. Stalemate is this game's failure mode. Modelling the force
   requirements showed an un-teched attacker facing a **+60% Fortify**
   defender on a maxed Command needs about **nine** mid-size positions
   converging at once — more than anyone holds on a 14-node map, i.e. a
   guaranteed freeze. Capping Fortify at +30% keeps the worst case at
   seven positions untteched, or five with Assault maxed.

Stress-tested across 16 seeds in five research configurations, including
an AI that starts with Fortify maxed: **zero stalemates**, and a player
with Assault maxed beats an AI with Fortify maxed 16/16.

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
- **Difficulty inverted twice, and decision quality could not fix it.**
  Tiers defined by how *recklessly* the AI attacked made "ruthless" the
  weakest, because thin margins throw an army away. Tuning patience
  instead inverted it the other way: a slow, patient AI simply banked its
  army and ground out a win (53 units to the player's 9 by t=80). The
  cause is that the attack margin helps and hurts in opposite phases — a
  thin margin grabs undefended neutrals quickly but fails against dug-in
  positions — and early expansion dominates the result. Difficulty is now
  led by an openly-applied production multiplier (0.70 / 1.00 / 1.30),
  which is monotonic by construction and is what most RTS games use.
  Measured over 16 seeds the tiers finally order correctly: the reference
  player wins 100% / 94% / 25%.
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

Node's built-in runner, no install needed (Node 18+). 40 cases covering
map connectivity and symmetry, deterministic generation, viewport
adaptation, order validation, multi-hop routing, the defender edge,
arrival coalescing, capture and reinforcement, production and capacity,
the credit economy, upgrade costs and limits, win detection, AI expansion
and concentration, the research tracks (escalating costs, army-wide
effect, the Assault/Fortify asymmetry, parity under equal tech, and that
a fully fortified position stays crackable), difficulty ordering, and the
stalemate regression.
