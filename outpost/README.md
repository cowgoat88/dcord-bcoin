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

## Doctrines

One standing choice, made on the start screen before the match. A
doctrine is a **sidegrade**: each one buys its advantage with a matching
weakness, so picking one says how you intend to play rather than how
strong you want to be. Research is the ladder you climb during a match;
doctrine is the shape of the army you brought to it.

| Doctrine | Gets | Gives up |
|---|---|---|
| ◆ **Standard** | Balanced — nothing to exploit | — |
| ➤ **Vanguard** | Fleets travel 25% faster | Positions build units 12% slower |
| ● **Deep Logistics** | Cut-off positions keep 90% output instead of 30% | Credit income −30% |
| ★ **Forward Relays** | Relays out-build Factories and charge the Doomstar twice as fast | Everywhere else builds 10% slower |
| ◈ **Prospectors** | Income +70%, research 30% cheaper | Positions build units 10% slower |
| ▲ **Shock Troops** | Assaults land 15% harder | Positions defend 6% worse and build 20% slower |

Both sides always have one. Against the AI its doctrine is drawn from
the map seed, so a given seed always fields the same opponent and a
rematch on a new seed is a different problem; online, each player brings
their own and the host is authoritative about both.

You should be able to *see* it working without taking the README's word
for it. The match opens with a line naming your doctrine and what it
does, the top bar shows the pairing throughout, selecting a position
reports its actual units/s and credits/s, and the research buttons show
the price your side pays. Prospectors opens on ⚔ 63c where everyone else
opens on ⚔ 90c.

### The first version of this did nothing, and why

Worth writing down, because the failure is instructive. The doctrines
shipped first were built on garrison capacity, credit income and the
Doomstar — and measured against real matches, all three were worth
approximately nothing:

- A side finished an average match having earned **12 credits**, against
  a first research level costing 90. It completed **0.13 research
  levels** per match. The credit economy, and with it the research
  buttons, was decoration.
- Garrison capacity was reached **0.0%** of the time, so "holds 15%
  fewer units" was a cost of literally zero.
- The Doomstar fired **0.00 times per match**: across 40 measured
  matches neither side ever held the centre, and it was never once
  chosen as a target. Lowering the centre's garrison was tried as the
  fix and is not one — at a garrison of 7 it still only fired 0.11 times
  a match, because reaching the middle, not cracking it, is what costs.

Two of those were fixed rather than designed around. **Every position
now earns credits**, not just Mines (Mines stay the credit node at
nearly four times a Factory's rate), which funds roughly one research
level or one upgrade a match and makes the spend a real decision. And
Forward Relays was rebuilt around Relay *production*, so it pays off in
the match you are actually having; the charge bonus is the upside when
it does come together. The Doomstar remains a late-game objective, and
the engine says so in a comment where the constant lives.

### On the balance numbers, honestly

Measured over 200 seeds against the shipped AI with a commander that
plays like a person — values Mines, does not all-in every tick, spends
credits — every doctrine lands within about six points of Standard at
both difficulties, with zero stalemates. That is the tightest result of
four separate attempts, and it is still not proof they are equal.

The benchmark is a proxy and it behaves badly near the edges: its
response to a modifier is **not monotonic** (dialling production from
0.85 to 0.80 to 0.70 moved the win rate 76% → 87% → 60%), and any
penalty to attack or defence hits its commit threshold like a cliff
rather than a slope, which is why no doctrine's cost is priced on those
alone. Treat anything inside ±10 points as noise. The numbers rule out a
runaway pick; the rest comes from people playing.

## Ascension

Beating Commander unlocks a ladder. Each rung is a rule change rather
than another production multiplier, they are cumulative, and only one
rung past your best is ever offered — it is a ladder, not a menu. Your
progress lives in the same local record as everything else.

The panel is on the start screen from the first launch, shut and marked
**locked**, with the five rungs greyed out so you can see the shape of
what is there to earn. It shipped hidden outright until the first
Commander win, which meant nobody knew it existed — a reward you cannot
see is not a reward.

| Rung | The enemy | Measured player win rate |
|---|---|---|
| — | Commander as it comes | 46% |
| I | starts with Fortify I | 41% |
| II | also starts with Assault I | 31% |
| III | its Assault starts at II | 11% |
| IV | starts fully researched | 5% |
| V | ...and out-produces you by a further 25% | 2% |

Three other rungs were built and thrown away because they did not
measure: a harsher supply penalty on your side (a commander who keeps a
connected front is never cut off, so it changed nothing), faster enemy
fleets, and cheaper enemy research — and two of those three made the
game measurably *easier*. Starting tech is the one lever that orders
cleanly. Assault II is a cliff in that lever (31% → 11%), so the early
rungs are built from Fortify and Assault I to make the climb a climb.
Ascension is a solo ladder; an online match is two people's doctrines
and nothing else.

## The Doomstar

The centre of every map holds a **Doomstar**, and it is what the Relays
are for:

- Every **supplied Relay you hold** adds charge every few seconds. What
  stops it is losing supply — the chain of your own positions back to a
  Command — not an enemy moving in next door.
- That rule used to be stricter: a Relay also had to be *uncontested*,
  with no enemy-held neighbour. It was too strict to ever come up.
  Relays sit on the front, so holding one with a quiet neighbourhood
  mostly meant the match was already decided, and the charge arrived
  after it could change anything. Supply already means "you are holding
  this properly", so the weapon hangs off that instead.
- At full charge, **if you also hold the Doomstar itself**, you can fire.
  Press FIRE and the map goes into aim mode: tap the enemy position you
  want hit, or press FIRE a second time to take the default — their
  single largest position. A position emptied by the strike is abandoned,
  not captured — you still have to go and take it.

  Aiming matters because the biggest stack is often not the one worth
  breaking. Cracking a fortified Relay to stop their charge, or softening
  a chokepoint the moment before your fleets land, beats shaving units
  off a rear-area garrison that was never going anywhere.

- Strikes dealt and taken appear on the end-of-match scoreboard, but
  only when the weapon came into it, so the line means something when it
  shows up.

It exists to answer two problems at once. Relays used to be filler with
no reason to fight over them, and two players could comfortably turtle in
opposite corners. Now the small scattered nodes fuel the weapon and the
middle of the map is worth holding.

**How often it actually comes up.** Scripted benchmark matches reach a
full charge in 6% of games and never take the centre at all, which made
the weapon look like dead content — but a person plays the objective and
a human match has already been decided by a strike. Treat the benchmark
numbers here as a floor, not a verdict. The remaining limiter is supply:
across measured matches a held Relay is out of supply 68% of the time,
because Relays get grabbed forward and left hanging off the end of a
line. Connecting what you take is what charges the weapon.

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

## Your record

Wins, losses, streak and fastest time per tier are kept on your device
(localStorage only — no account, no server) and shown on the start
screen and after each match. The one thing it gates is the Ascension
ladder, which needs a Commander win to appear at all.

## Difficulty is stated, not hidden

The tiers differ mainly by an openly-applied production multiplier —
Cadet −30%, Officer even, Commander +75% — and the buttons say so.
Decision-quality knobs were tried first and inverted the tiers twice
(see the design notes below); a multiplier is the only lever that orders
reliably, and a handicap a player can see reads as a difficulty setting
rather than as the AI cheating.

Holding ground funds the spending, too: every position earns credits,
not just Mines. Before that it did not — a side finished an average
match having earned 12 credits against a 90-credit research level, and
completed 0.13 research levels a match, which made the research buttons
decoration. Mines are still the credit node at nearly four times a
Factory's rate.

Every tier also closes out a game it has already won. A cautious AI
capped at two attackers tops out near 49 units against a capped
Command's 87.5 defence, so it could hold fourteen positions to the
player's one and never take the last: measured at 5 stalled matches in
40. The endgame push only fires once the opponent is down to a position
or two *and* the AI holds several times what is left, because both sides
start on exactly one position — without that check it became an opening
rush that wrecked the tiers.

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
