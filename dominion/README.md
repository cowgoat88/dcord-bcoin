# DOOMSTAR: DOMINION

A slow, plotted space-empire game built on the OUTPOST engine. A match is a
season of a galactic war: every round, everyone plots orders against a
frozen galaxy, then the orders lock and thirty simulated seconds of war play
out with nobody touching anything. Hold the Throne at the centre when a
round ends to score. First to 10 points, or the most points after 12
rounds, rules the galaxy.

Design document (research, structure, roadmap):
https://claude.ai/code/artifact/5cfa5de5-1840-4c79-9bfa-21bf4f59e9d6

OUTPOST itself is untouched in `../outpost/`. Dominion copies what it
needs and has its own engine, AI and UI.

## Play

Open `index.html`. No build step, no server.

- **Plot.** Tap one of your positions, then a target, to send part of its
  garrison there (25/50/75/All). Or give it a **Support** order (lend half
  its strength to a neighbour's attack or defence without moving), a
  **Hold** (dig in: defend 25% harder, send nothing), or an **Upgrade**.
  Research and the Doomstar are on the same bar. Every order costs one
  command point: 3 a round, plus one for every 5 positions you hold.
- **Forecast.** Drag the slider to see the next 30 seconds as they would
  play out if no rival gave any orders. Rivals' orders are hidden; that is
  the game.
- **Lock orders.** The round resolves at 1x, 2x or 4x. Replay shows the last
  round again from the start, as many times as you like.

## What is built (roadmap phases 0 and 1)

- **Any number of seats, 2 to 6.** One generated galaxy per match: a wedge
  per seat around the Throne, every wedge the same ground turned, lanes
  from the Gabriel graph of the points, so they never cross. Your home is at
  the bottom of the screen.
- **The round.** Plot, lock, resolve 30 s, status. Orders are checked
  against the frozen board and applied all at once, seats interleaved in an
  order that turns each round.
- **New verbs.** Support (cut if the supporter is itself attacked, as in
  Diplomacy) and Hold, on top of OUTPOST's send, upgrade and research.
- **Carried over from OUTPOST unchanged:** routes only through your own
  ground, supply back to a Command, the defender's edge, terrain, fleets
  fighting where they meet in a lane, the Doomstar and its two-second
  lock-on, the six doctrines (now factions).
- **Rival commanders** that plot with the same command points and the same
  order list as you, during the plot step only, with four personalities
  (hawk, turtle, trader, zealot).
- **Forecast and replay**, both the same deterministic simulation run on a
  copy.

## Objectives (phase 2)

Ten public objectives are dealt from the seed, five stage I (1 point)
then five stage II (2 points). Two show at the start and one more is
revealed at the end of each round. Each seat also holds one secret. At
the end of a round every seat scores the most valuable public objective
it meets (each once) and its secret (once); holding the Throne scores 1
on top. Objectives point at places and moments: hold 3 Relays, take 2
positions in one round, win a lane battle against a larger fleet, hold
the Throne and two positions beside it, strike a leader with the
Doomstar. Secrets include taking a rival's Command and winning a fight
your support decided. Rivals weigh targets by their open objectives.

Measured, all-AI seasons ending on points rather than the round limit:
16 of 30 with three seats, 8 of 30 with four, 13 of 30 with five, with
wins by seat within noise (9/11/10, 6/7/7/10, 8/7/6/6/3).

## Roles

Every round opens with a draft of six roles, fewest points picking first,
so the leader gets what is left. Each lasts one round:

| Role | Effect |
|---|---|
| Admiral | two more command points |
| Marshal | assaults 20% stronger |
| Warden | every position dug in (Hold's defence) through the resolve |
| Engineer | first upgrade free, research 25% cheaper |
| Merchant | credits come in twice as fast |
| Spymaster | the forecast shows rivals' locked orders |

Rivals pick by what their situation asks for. With the draft, all-AI
seasons ending on points: 24 of 30 with three seats, 18 of 30 with four,
17 of 30 with five, wins by seat within noise.

## The galaxy and fog of war (phase 3)

Fifteen positions a wedge: 31 with two seats, 61 with four, 91 with six.
The radius grows with the seat count, so neighbours are the same distance
apart in every galaxy. Lanes are kept only when every turned copy of them
exists, so rounding a position never gives one seat a lane another lacks.

Each seat sees its own positions and everything one lane out, two lanes
out from its Relays, the lanes its fleets are on, and the Throne. The
opening board is public; after that, positions out of sight show what you
saw last (dimmed, garrison marked `~`), fleets out of sight are not shown,
and fights out of sight are not reported. The forecast and the rival
commanders both work from that same knowledge (`viewFor`), never from the
real board: a test changes everything a rival cannot see and checks its
orders do not change. The Spymaster sees the whole galaxy for its round.
The season's end lifts the fog. On a phone the camera opens on what you
can see; pinch out for the rest.

Measured, 100 four-seat all-AI seasons: wins by seat 28/28/23/21; about a
third of the galaxy is in sight of a seat at any time. Seasons ending on
points: 25 of 30 with three seats, 51 of 100 with four, 12 of 30 with five.

## The council (phase 4)

Every round one law comes before the council, dealt from a shuffled deck
of ten. Every live seat has one vote and may add influence to it (spent
win or lose); influence comes in at 1 a round plus 1 per Relay held, so
Relays are now worth fighting over for politics as well as the Doomstar.
Votes are secret until the orders lock, then the law takes effect as the
round resolves and everyone's vote is shown.

| Law | Effect |
|---|---|
| Mobilization | every seat plots one more order, from now on |
| Sanctuary | holding the Throne scores nothing this round |
| Interdiction | nobody may fire the Doomstar this round or the next |
| Levy | every seat pays a fifth of its credits to the seats with fewest points |
| Open Skies | every seat sees the whole galaxy this round |
| Reparations | taking a rival's Command scores 1 point, from now on |
| Censure (elect) | the seat plots two fewer orders and may not fire next round |
| Laurel (elect) | the seat scores 1 point |
| Letter of Marque (elect) | the seat receives 80 credits |
| Sanction (elect) | the seat earns no credits this round |

A tied election goes to the seat with fewer points. Seats remember who
hurt them (a grudge for each position taken, more for a Command or a
Doomstar strike, fading by a third each round); rivals aim at those seats
and vote to censure or sanction them, or the leader. The agenda shows in
the draft, so it can steer the pick.

Measured, 100 five-seat all-AI seasons with draft and council: wins by
seat 17/15/22/22/24.

Not built yet (phases 4 to 6 in the design doc): promises between seats,
the tech tree and faction rules, the campaign, and online play.

## Measured

All-AI seasons, 40 seeds: four-seat wins by seat 6/9/13/12 (within noise of
10 each). Two biases were found and fixed on the way: a fixed processing
order gave the later seat the decisive second hit on contested positions,
and the AI walked targets by node id, so every rival preferred the same
low-numbered sectors. Seats 3 and 4 had been winning 29 of 40. A season
where every seat has the same faction and personality stays exactly
symmetric for all 12 rounds.

Before objectives, every season ran to the round limit: nobody reached 10
points and nobody was eliminated. Objectives were built to change that.

## Tests

```
node --test dominion/sim.test.js
```

34 cases: galaxy connectivity, no crossing lanes and identical wedges for 2
to 6 seats; plotting changes nothing; command points; credits promised
twice; a full round; support turning a fight and being cut; Hold; lane
combat; Throne scoring; the three ways a season ends; seat order rotation;
the forecast matching reality to the unit when rivals pass and hiding their
plans; copies being independent; determinism; AI seasons finishing, fighting
and only ever giving legal orders; objectives dealt, revealed and scored
once each; in-round events counted and reset; rivals following
objectives; seasons ending on points; the roles draft (order, each role
once, effects) and AI seasons drafting every round; what a seat sees, the view, forecast and
rival plans keeping what is out of sight as last seen, intel refreshed
each round; the council's agenda, votes, tally and every law's effect;
grudges; rivals voting legally.
