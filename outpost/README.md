# OUTPOST

A real-time command & control game. Open `index.html` in any browser — no
build step, no server, no dependencies, no asset files (even the sound is
synthesised at runtime).

Hold positions, build forces, and send them down the supply lanes until
the map is yours. A match runs about two to five minutes.

## How it plays

- **Tap** one of your positions to pick it up, then **tap a target** —
  the first tap previews the order, a second tap on the same target sends
  it. The target can be an enemy position *or one of your own*, which is
  how you reinforce and shuffle units around your territory.
- **Press and hold** one of your positions to add it to a group, then
  order the whole group at once.
- **Drag** from a position straight onto a target to skip the confirm
  step (handy with a mouse).
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

## The Doomstar

The centre of every map holds a **Doomstar**, and it is what the Relays
are for:

- Every **uncontested Relay you hold** adds charge every few seconds.
- A Relay is **contested** — and stops charging — while any lane-adjacent
  node is enemy-held, so charging is something you have to protect.
- At full charge, **if you also hold the Doomstar itself**, you can fire:
  it strips units from the enemy's single largest position. A position
  emptied by the strike is abandoned, not captured — you still have to go
  and take it.

It exists to answer two problems at once. Relays used to be filler with
no reason to fight over them, and two players could comfortably turtle in
opposite corners. Now the small scattered nodes fuel the weapon and the
middle of the map is worth holding.

## Terrain

Every position stands on ground, and the ground decides how well it
defends. One property, three values:

| Space | Defence | Reads as |
|---|---|---|
| **Asteroid Belt** | ×1.25 | amber halo, scattered rocks |
| **Open Space** | ×1.00 | nothing |
| **Gravity Well** | ×0.78 | violet halo, concentric rings |

A Factory in an asteroid belt has cover to fight from and is a fortress
worth building a front around; the same Factory in a gravity well is
pinned where it cannot manoeuvre, and is the obvious place to punch
through. It applies to unheld space too — a gravity well pins whoever is
in it — so terrain shapes where you expand, not just where you fight.

Terrain is mirrored with the rest of the map, so it can never hand one
side an easier start. **Command and the Doomstar always sit in open
space**: they already carry the largest capacities, and stacking an
asteroid belt on top of the defender edge, Fortify and a level-3 upgrade
pushes them past what any realistic concentration can crack — which is
exactly how the original stalemate began.

### Why terrain, and not narrower maps

Fewer lanes was measured first as the way to create chokepoints, and
rejected. Sweeping lane density from ~4.9 down to 2.7 connections per
position produced, per map, an average of **0.1 articulation points**
(positions whose loss actually splits the map) and only **4% of routes
fully blocked** — because the generator's connectivity pass yields
ring-like graphs, which have no cut vertices however sparse they get. It
also made the game worse, not better: the player's win rate across the
three tiers fell from 9/5/0 to 8/2/1. Terrain gives positional depth
without touching connectivity.

## Supply lines

The lane map is a supply network, not just a set of shortcuts:

- **You cannot move through enemy-held ground.** Routes run over your own
  positions and no-man's-land; an enemy position is a roadblock, not
  something to fly over. The target itself is always attackable — it is
  the road *to* it that has to be open.
- **A position is in supply** only if it can trace a chain of your own
  positions back to one of your Commands. Cut that chain and everything
  beyond it drops to **30% output**, stops paying credits, and — if it is
  a Relay — stops charging the Doomstar. It still flies your colour; it
  just barely functions.

This is what makes flanking and encirclement real. Measured over 25
maps, planting an enemy position mid-route changes **37%** of all routes
(forcing the long way round), and in every one of 10 full test matches
some position ended up severed. Taking the right single node can starve
a whole wing.

The board shows it: live supply lines are thick and flowing, a severed
position gets a broken orange ring and a CUT OFF label, and an order with
no open route previews as **NO ROUTE** instead of silently failing. Order
previews trace the actual lane path the fleet will take, so a detour
looks like a detour.

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

`online.js` is the session protocol with its transport injected, so it
is testable without networking; `net.js` wraps the vendored PeerJS (MIT,
`vendor/`) as that transport and also provides the BroadcastChannel
two-tab mode.

`engine.js` is the whole simulation and has no DOM, no canvas, no timers
and no `Math.random` — it runs on a seeded RNG and a fixed timestep, so a
match is reproducible from its seed and testable under plain Node.
`index.html` owns rendering, input and effects, and talks to the engine
only through orders (`sendFleet`, `upgradeNode`) and a drained event
queue. The AI plays through the same `sendFleet` the player does; it has
no private powers.

## Play a friend

Press **Host game** on the start screen. You get a five-character room
code and a copyable invite link; send either to your friend. They open
the link (or press **Join with code** and type it) and you are in the
same match — one of you commands each side. No accounts, nothing to
install, no server to run: the free public PeerJS signalling server only
introduces the two browsers, and after that the connection is directly
peer-to-peer with no game data passing through anything in between.

**Two tabs** plays both sides in one browser on one machine, over
BroadcastChannel with no internet at all. It is the quickest way to see
the online mode working, and it is how the networking was tested.

### How it works

Host-authoritative. The host's browser is the only copy of the truth: it
runs the simulation, validates every order through one seat-checked
entry point (`applyOrderAs`, where the seat comes from the connection and
never from the message, so a guest cannot move the host's forces), and
broadcasts a state snapshot 12 times a second. The guest never advances
the simulation itself — it renders whatever snapshot it was last sent —
so the two copies cannot drift apart, and rejoining is just "send the
latest snapshot".

Only the mutable half of the game travels, about half a kilobyte a
snapshot. The board is a pure function of the seed and board shape, so
both peers generate an identical map from the three values in `welcome`
and no geometry ever crosses the wire.

A guest holds engine seat 2, and the UI swaps which seat counts as
"you", so both players see their own forces in their own colour and read
the HUD the same way.

## Tests

```
node --test outpost/engine.test.js outpost/online.test.js
```

Node's built-in runner, no install needed (Node 18+). 40 cases covering
map connectivity and symmetry, deterministic generation, viewport
adaptation, order validation, multi-hop routing, the defender edge,
arrival coalescing, capture and reinforcement, production and capacity,
the credit economy, upgrade costs and limits, win detection, AI expansion
and concentration, the research tracks (escalating costs, army-wide
effect, the Assault/Fortify asymmetry, parity under equal tech, and that
a fully fortified position stays crackable), difficulty ordering, the supply network (enemy ground blocking transit,
orders refused with no route, severed positions falling out of supply and
producing far less, cut-off Relays not charging), terrain (mirrored
placement, Command and Doomstar always in open space, defence effects,
and the worst possible position staying crackable), and the stalemate
regression.

`online.test.js` adds 10 cases over an in-memory loopback, with no
networking or browser involved: the welcome handshake and both peers
deriving the same board from a seed, snapshots reaching the guest
verbatim, a guest's order being applied by the host and coming back,
a guest being unable to order the host's forces, the guest never
advancing the simulation on its own, every order type passing the seat
check, a version mismatch being refused, rejoin-by-token versus a
stranger being turned away, restart, and snapshots staying small enough
to send many times a second.
