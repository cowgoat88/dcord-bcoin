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

Five cumulative rungs of extra difficulty, **not gated behind
anything**. Each one is a rule change rather than another production
multiplier, and they stack on whichever opponent tier you picked — so
they are as much a way to make Cadet interesting as to make Commander
worse.

It shipped the other way: locked until you beat Commander. That put a
whole feature behind the hardest thing in the game, and the person it
was built for simply could not get at it. Extra difficulty is something
you should be able to ask for. What is earned is the *record* — which
rung you have cleared, and on which tier, so "cleared III" never
quietly means "cleared III on Cadet".

| Rung | The enemy | Measured player win rate |
|---|---|---|
| — | Commander as it comes | 32% |
| I | out-produces you by 5% | 21% |
| II | make that 12% | 23% |
| III | ...and starts with Fortify I | 13% |
| IV | ...and Assault I on top of that | 0% |
| V | starts fully researched, out-producing you by 15% | 0% |

The ladder was rebuilt once. It used to be made entirely of starting
tech, and that stopped working when transit through neutral ground
closed: in a 150-second contiguous grind a single tech level compounds,
and Fortify I alone took Commander from 32% to 13% while Assault I took
it to 3%. That is not a rung, it is a wall. The first rungs are small
production handicaps now and the tech only starts at III. Rungs I and II
measure within noise of each other, and the last two are in single
digits where the harness cannot order them at all — the ladder this
replaced had the same property (44/39/31/11/7/2). Treat the top of it as
a flex rather than a difficulty curve.

Three other rungs were built and thrown away because they did not
measure: a harsher supply penalty on your side (a commander who keeps a
connected front is never cut off, so it changed nothing), faster enemy
fleets, and cheaper enemy research — and two of those three made the
game measurably *easier*. Starting tech is the one lever that orders
cleanly. Assault II is a cliff in that lever (31% → 11%), so the early
rungs are built from Fortify and Assault I to make the climb a climb.
Ascension is a solo ladder; an online match is two people's doctrines
and nothing else.

## Campaign

Five hand-built missions on the start card, one per doctrine. A skirmish
map is generated and point-symmetric so that a loss is never the map's
fault; a mission is the exact opposite on purpose — the ground is
lopsided, the brief is specific, and the doctrine it hands you is meant
to be the way through.

| Mission | Hands you | Asks for |
|---|---|---|
| **Two Fronts** | ➤ Vanguard | Hold two listening posts, three hops apart down separate arms, for 45 seconds |
| **The Waist** | ● Deep Logistics | Take everything, while the enemy repeatedly cuts your territory in half |
| **The Redoubt Gate** | ★ Forward Relays | Capture a command dug in behind an asteroid wall, in 6 minutes |
| **Deep Seam** | ◈ Prospectors | Hold every Mine on the map at once for 25 seconds |
| **Hard Shell** | ▲ Shock Troops | Crack an opponent already researched to Fortify III, in 4 minutes |

Objectives beyond annihilation are an engine feature, not a script:
`hold` (keep a position, a list of them, or every node of a type, for N
seconds — the clock restarts the moment it changes hands), `capture`
(take a named position before a deadline), `survive` (still be there
when the clock runs out) and `eliminate` (the skirmish default). Losing
every position always loses, whatever the brief says.

Missions are recorded separately from your skirmish record, so a
scripted board never pollutes the difficulty tiers' win rate.

### How well tuned are they, honestly

Not very, yet. Every mission is reachable end to end, every objective
has been verified against the engine, and each one is winnable — but
the claim "this doctrine is the only way through" is **not** verified,
because the tool to verify it does not exist here. The scripted
commander used for balance work plays objectives badly, never takes the
centre, and swings about ±25 points between runs, so a doctrine lock
cannot be told apart from noise.

What the measurements do say, over 40 runs per mission per doctrine:

| Mission | Intended doctrine | Every other doctrine |
|---|---|---|
| Two Fronts | 75% | 43–83% |
| The Waist | 83% | 35–98% |
| The Redoubt Gate | 100% | 0–60% |
| Deep Seam | 28% | 15–28% |
| Hard Shell | 33% | 8–23% |

**Opponent posture.** A mission can ask the opponent to *defend*: it
retakes anything inside its own starting territory and attacks nothing
outside it. Without that, the AI reads a siege wall as an attack force
and marches it into your home, which is what it did. Getting there took
four tries and each failure is instructive — forbidding just the wall to
attack left the Command sallying alone while the wall stopped weakening
itself (player wiped out in 78% of runs); pinning everything turned the
mission into "wait long enough", 100% winnable by every doctrine at
every wall strength; letting dug-in nodes hit only their neighbours
leaked, because a node the fortress recaptured was not itself dug in and
became a staging post. Bounding it by *territory* is what holds.

That work also turned up two genuine engine bugs, both of which made a
fortification impossible to build:

- **Reinforcing a position could shrink it.** A node above its cap was
  clamped down the moment a friendly fleet arrived, so a 220-unit wall
  collapsed to its 68 cap the first time the AI topped it up. Overflow
  is wasted now; the garrison never drops.
- **A defender drained itself.** The AI's "shore up the front" branch
  sends half of a donor node away. On a defensive map a 150-unit wall
  was at 75 within fifteen seconds. Defenders no longer shuffle
  garrisons.

With both fixed, wall strength finally means something — win time rose
from 67s to 152s as the wall went from 70 to 150 — and the mission has
the sharpest doctrine lock in the set: **Forward Relays 100%, every
other doctrine 0–60%**, nobody wiped out, and a typical win at 264s of
the 360s clock.

The Redoubt Gate was **impossible as first shipped**, and the arithmetic
is worth recording. Its enemy Command was level 3: cap 123, regenerating
2.54 units a second. The Doomstar does 26 damage and, holding every
Relay on that map, recharges in about ten seconds — during which the
target regrew 25. Net 0.6 units a strike, so the mission's own hint
pointed at a target the weapon could not dent, behind a wall you could
not mass through either. The Command is now level 1, the wall sits just
*over* its cap so strike damage against it is permanent, and the hint
says plainly to shoot the wall rather than the Command. A test now
fails if any capture mission leaves neither route open.

The Redoubt Gate and Hard Shell look like real doctrine locks. The Waist
and Two Fronts are flavoured but anyone can win them. Treat the low
absolute numbers with suspicion in the other direction too: a bot that
cannot shuttle a garrison or play to a clock failing 70% of the time is
not evidence that a person will. These need play, not more simulation.

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

- **Routes cross only ground you hold.** Enemy positions and unclaimed
  ones alike are roadblocks, not something to fly over. The target itself
  is always attackable — it is the road *to* it that has to be open, so
  an attack has to be walked forward over ground you have paid for.
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

- **Orders route anywhere your ground reaches.** You can send from any
  position to any node your territory connects to, and the fleet convoys
  along the lane network. Restricting orders to a single hop makes
  concentration geometrically impossible, because front lines are only
  one or two nodes wide — and the map simply freezes.
- **Converging forces combine.** Fleets that reach the same target within
  a one-second window fight as one force. Without this, well-timed
  attacks are still defeated one at a time and coordination is pointless.
- **Upgrades scale production, not durability.** Rate rises +75% a tier
  while capacity rises only +25%, so investing pays off without putting a
  position beyond any force that could be fielded against it.
- **The attack preview** shows your committed force against the target's
  defence before you commit, so the ×1.25 rule is something you learn
  rather than something that silently eats your army.

### The opening all-in, and what closing it cost

The game shipped with one line of play that beat it outright: hold
everything, wait for the AI's first push to leave its Command, then send
75% of every position straight at that Command. Measured over 60 seeds a
tier, that won **100% / 98% / 87% / 43%** of matches and was usually over
inside 30 seconds.

The instinct is to blame the AI, and the traces look like it — at seed 3
the rush lands while the enemy Command holds 10 units, because the AI
spent its whole opening garrison on move one, and at t=6s it holds
`command:13 mine:10` against a minimum-garrison floor of 11, so exactly
one of its two positions is even allowed to attack. That is the reported
"paralysis", literally.

It is not the cause. Eight AI-side fixes were built and measured, and
every one of them failed:

| candidate | rush win% Cad/Off/Cap/Cmd |
|---|---|
| as shipped | 100 / 98 / 87 / 43 |
| reinforce any threatened position | 80 / 80 / 97 / 85 |
| keep a reserve at the Command | 98 / 77 / 82 / 58 |
| Command defends at ×1.4 / ×1.7 / ×2.0 | 98 / 95 / 78 / 52 … 100 / 100 / 93 / 23 |
| drop the minimum-garrison floor | 100 / 100 / 100 / 53 |
| time-aware home defence, only where help arrives in time and wins | 100 / 98 / 90 / 48 |
| neutral ground costs 2× / 3× / 4× to cross | still 100 / 98 at the low tiers |

Several of those made normal play markedly worse; the Command-defence
ones collapsed the player's win rate at Officer to 8–20%. The last one in
the table is instructive: a defence that only commits when it can
actually win declines to commit at all here, correctly, because there is
nothing to commit with. An undefended Command one uninterrupted flight
away is not a defensible position, and no amount of AI makes it one.

The fix is topological, and it was the owner's own suggestion: **no-man's
land stops carrying traffic**. One line in `canTransit`. The rush dies at
every tier (0 / 0 / 0 / 0) because the route does not exist until ground
between has been taken, and a regression test now asserts that neither
Command is reachable from the other on the opening tick, across 30 seeds.

What it cost: a match now runs about **148 seconds instead of 80**, and
every balance number in the game had to be re-fitted, because a long
contiguous grind is a different game from a short one. Carried over
unchanged, the difficulty ladder read 100/18/2/0 and the doctrine set
spread from a 53–68% band at Officer to 35–95%, with Forward Relays at
95/87% and Shock Troops at 35/15%. Production penalties were what moved
most — a 20% unit penalty is survivable in an 80-second match and
crippling in a 150-second one. After re-fitting: the tiers measure
99/86/45/31 over 120 seeds with no stalemates, and the doctrines sit
inside 78–85% at Officer and 41–61% at Captain.

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
  led by an openly-applied production multiplier, which is monotonic by
  construction and is what most RTS games use. Measured over 120 seeds
  the tiers order correctly: the reference player wins 99% / 86% / 45% /
  31%.
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

## Starting a game

One decision per screen, in the order you actually make them:

```
New game ─┬─ Skirmish  → Opponent (+ Ascension) → Doctrine → Deploy
          ├─ Campaign  → Mission                           → Deploy
          └─ Friend    → Doctrine → Host / Join
```

A breadcrumb under the title says where you are (`Skirmish › Captain`),
Back steps out, and the primary button reads **Next** until the last
screen, where it becomes **Deploy** — or `Deploy · The Redoubt Gate`
when a mission is armed.

This replaced a single card that stacked every toggle at once. That card
was 568px of controls before anything was open; the tallest screen in
the flow is now 536px and the typical one is under 350px, which is what
keeps the whole thing a one-pager on a 360×640 phone. The record moved
to a screen of its own, reached from "Your record" on the first screen —
it is something to look up between matches, not a decision to make
before one.

**How to play** is its own screen, reachable from the start card and
from `?` in the top bar at any time. Opening it mid-match pauses the
clock and closing it resumes — unless you were already paused, in which
case it leaves you paused. It used to be a disclosure inside the start
card, which meant the in-game `?` could only reach it by throwing you
back to the menu and abandoning the match: reported as a hang, and
fairly, since nothing on that screen offered a way back to the game.

**Getting out.** `Menu` in the top bar leaves any match and returns to
the first screen, and so does Escape — which backs out of the innermost
thing first: an aim, then a selection, and only then the match.

Leaving a match in progress **asks first**, because a misclick on a
toolbar button should not cost you a game. The dialog pauses the
simulation while it is up, puts focus on *Keep playing* so Enter can
never destroy anything, takes Escape or a backdrop click as "no", traps
Tab between its two buttons, and returns focus to whatever opened it. It
only appears when there is something to lose: once a match has ended,
Menu just leaves. Online, the wording changes to say the opponent will
be dropped, and the room is actually closed rather than left open behind
the menu.

**Toolbar.** The top bar never wraps and never truncates a readout.
As the window narrows it sheds whole stats in order of how easily they
are found elsewhere — income, then the doctrine pairing (it is in its
own tooltip), then enemy tech (it is on the end screen), then the
labels, with Pause becoming a glyph on a phone. Verified at ten widths
from 1440px down to 320px: one row, nothing clipped, every button
reachable.

## Your record

Wins, losses, streak and fastest time per tier are kept on your device
(localStorage only — no account, no server) and shown on the start
screen and after each match. The one thing it gates is the Ascension
ladder, which needs a Commander win to appear at all.

## Difficulty is stated, not hidden

The tiers differ mainly by an openly-applied production multiplier —
Cadet −20%, Officer −14%, Captain −7%, Commander even — and the buttons
say so. Captain exists because Officer to Commander used to be a jump of
1.00 to 1.75 in one press, most of the game's whole difficulty range in
a single step, with nothing in between for someone who has outgrown an
even fight. A test fails if any one tier step is more than half the
total range.

The whole table was re-fitted when transit through neutral ground
closed. A contiguous match runs about 148 seconds rather than 80, and
production compounds over that time, so the old multipliers left the
ladder at 100/18/2/0. The band is far narrower than it looks: holding
everything else fixed, Officer wins 3% of matches at 0.80 and 63% at
1.00. Cadet is pinned from the other side as well — at 0.90 the AI wins
the campaign mission *The Waist* outright on every seed, which turns a
mission the player is supposed to learn from into a loss.
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

Press **Play a friend**, pick a doctrine, then **Host game**. You get a
five-character room code and a copyable invite link; send either one.
The room stays open while you switch windows to send it, and **the match
starts by itself the moment they arrive** — there is nothing to press
afterwards. Your friend opens the link, or presses **Join with code**
and types it.

**Two tabs** runs both sides in one browser on one machine, which is
also how the whole online stack is tested without a second person.

It shipped briefly with no way to start at all: the stepped start flow
hid the primary button on the online screen, so a host could open a
room, watch a guest connect, and have no Deploy to press — while the
guest was already dropped into a board the host could not see. The match
now begins on the connection itself, which removes the button rather
than fixing it. `scratchpad/net2tab.js` drives the whole thing end to
end and asserts both sides enter the match, their clocks agree, the
seats are mirrored, and leaving tells the other person.

If the host leaves, or the connection drops, the other side gets a
notice saying so and a way back to the menu, rather than being left
tapping a frozen board.

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
a fully fortified position stays crackable), difficulty ordering, the supply network (only your own ground carrying
transit, neither Command reachable from the other on the opening tick,
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
