# DOOMSTAR: DOMINION

A slow, plotted space-empire game built on the OUTPOST engine. A match is a
season of a galactic war: every round, everyone plots orders against a
frozen galaxy, then the orders lock and thirty simulated seconds of war play
out with nobody touching anything. Hold the Throne at the centre when a
round ends to score. First to 20 points, or the most points after 18
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

### Pacts

Any two seats can make a pact for two rounds: an offer, then an answer
(rivals answer at once, and offer you pacts at the start of a round).
Partners share sight. Nothing in the rules stops an attack on a partner,
but plotting one breaks the pact as the orders lock and makes the breaker
an Oathbreaker for three rounds: its influence is gone, every seat holds a
grudge, and nobody will make a pact with it. You cannot offer a pact with
an attack on that seat already plotted. Rivals keep their word, except a
Hawk taking the Throne from a partner who leads.

Measured, 100 all-AI seasons with draft, council and pacts: wins by seat
22/20/27/31 with four seats, 16/18/22/19/25 with five; about 7 pacts a
season with four seats.

## Technology and factions (phase 5)

Twelve technologies in four branches of three; each needs the one above
it, one a round, paid as the orders lock (90, 190, 330 credits).

| | Tier 1 | Tier 2 | Tier 3 |
|---|---|---|---|
| War | Assault Doctrine: assaults +15% | Shock Troops: +15% more | Siege Lances: assaults ignore Asteroid Belts and digging in |
| Bulwark | Hardpoints: defence +10% | Deep Bunkers: +10% more | Bastion: Hold digs in by 50%, not 25% |
| Propulsion | Ion Drives: fleets +20% speed | Lane Pickets: +25% in lane battles | Deep Sensors: one lane more sight everywhere |
| Statecraft | Envoys: +1 influence a round | Logistics Net: +1 order a round | Capacitors: Doomstar charges 50% faster |

Each faction keeps its modifiers and bends one rule:

| Faction | Rule |
|---|---|
| Free Worlds | Senate: your council vote counts two |
| Kestrel Wings | Deep Strike: fleets may fly over one unclaimed position, losing a quarter |
| Deep Combine | Convoys: supply runs through pact partners' positions |
| Choir of the Array | The Array: Relays see three lanes out |
| Meridian Guild | Trade Pacts: every round of a pact pays both partners 40 credits |
| Iron Covenant | Hold the Line: positions you take are dug in for the rest of the round |

Measured, 150 four-seat all-AI seasons with everything on: faction win
rates 0.21 to 0.29 (even is 0.25), wins by seat 41/35/30/44. Deep Strike
over any amount of unclaimed ground won 47% of seasons; limiting it to one
position, at a quarter of the fleet, and cutting Kestrel's speed bonus
brought it to 29%.

## The campaign (phase 6)

Choose **Campaign** on the start screen: four seasons against the same
rivals (same factions, same personalities) on a new galaxy each season.
Places earn campaign points, 5/3/2/1. Between seasons every seat drafts a
legacy it keeps for the rest of the campaign, furthest behind first:

| Legacy | Effect, every season |
|---|---|
| Veterans | start with Assault Doctrine |
| Ramparts | start with Hardpoints |
| Couriers | start with Ion Drives |
| Old Friends | start with Envoys |
| War Chest | 80 more starting credits |
| Machine of State | 3 more starting influence |
| Standing Army | Command starts with 25 more ships |
| Throne Claim | Doomstar starts half charged |

Grudges carry into the next season at half strength; pacts do not. The
campaign and the season in progress are saved in this browser at the
start of every round, so **Continue** on the start screen picks up where
you left off (a single season too). The game works without storage.

## Sound

Howler.js 2.2.4 (`vendor/howler.core.min.js`, MIT) plays eleven effects:
order clicks, locking in, launches, captures, repulses, lane battles, the
Doomstar's lock-on and blast, scoring, the council's gavel and the round
bell. The effects are made by code (`tools/sfx.js`) and stored as data
URIs in `sounds.js`, so they play from a `file://` page too. **Sound
on/off** on the start screen, or press M; the choice is remembered in this
browser.

## Online

Choose **Online** on the start screen: two people plus your chosen number
of rivals, one season. One person creates a match and sends the code; the
other joins with it. Only orders travel. Every screen re-runs each round
itself from everyone's orders, which works because the engine and the
rivals use only exactly specified math and every resolve, forecast and
replay steps by the same fixed 1/20 s (`S.STEP`); a fingerprint of the
board travels with each plot, and a screen that disagrees says so.

- **This browser**: two tabs of one browser, sharing a match through
  localStorage. No server; for trying it out or two people at one desk.
- **Neon server**: a Neon project with the Data API and Neon Auth enabled
  and `schema.sql` run once in its SQL editor. Paste the Data API URL and
  a Neon Auth access token. Row-level security referees: you may only post
  for your own seat, once a round, never edit a move, and nobody can read
  another person's orders until everyone has locked that round.

`schema.sql`'s rules were checked on Postgres 16 with a stand-in for
`auth.user_id()`. The Neon client (`online.js`) follows the Data API's
PostgREST conventions and is tested against a fake fetch; it has not been
run against a live Neon project from here, because this environment cannot
reach neon.com. Getting a token is the open step: Neon Auth's sign-in
needs its own client setup, so for now the token is pasted.

Online for now: pacts are only made between rivals (an answer from a person
mid-plot would need another round trip), and the campaign is offline only.

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

## Season length and the scoreboard

A season is first to 20 points or the most after 18 rounds (it was 10 and
12, and seasons ended before the fighting started). Measured over 40
four-seat all-AI seasons: average end round 11.1 to 15.8, 75% ending on
points, and positions taken from rivals up from 5 to 19 a season. Both are
per-game settings (`pointsToWin`, `roundLimit` in `createGame`).

Every point is logged with its round and reason (`game.scoreLog`). The end
screen shows the winning point (round, reason, and the total it reached),
points by round for every seat, and each seat's full list of points
(secrets revealed once the season is over).

### Contact

Measured over 60 four-seat all-AI seasons, before and after:

| | before | after |
|---|---|---|
| first position taken from a rival | round 6.6 | round 5.0 |
| rounds with no rival position taken | 49% | 32% |
| points from the Throne | 15% | 24% |
| lead changes a season | 1.9 | 2.5 |
| average season | 15.8 rounds | 15.6 rounds |

What changed: the Throne scores 1 a round in the first third of the round
limit, 2 in the second, 3 in the last; four new objectives need contact
(take a position from a rival, hold one in a rival's home sector, take one
from the leader, take three from rivals in a round) and the deck is six
of each stage; every seat starts with a Mine as well; unclaimed positions
hold 1.6x the garrison; rivals value a rival's position 2.2x an empty one;
20 points to win. Faction numbers were retuned after (200 seasons: win
rates 0.20 to 0.29).

## Season length and rival strength

The start screen offers **Quick** (13 points / 12 rounds, about 11 rounds),
**Standard** (20 / 18, about 16) and **Epic** (28 / 24, about 22), and
rivals at **Easy**, **Normal** or **Hard**. Rivals always play by your
rules: the same orders and command points. Easy rivals play cautiously
and produce 30% fewer credits and 25% fewer ships; Hard rivals produce
25% more credits and 15% more ships and pile onto a person in the lead.
Sharper thinking alone did not make rivals stronger (every variant tried
was within noise of Normal), so Hard is an open handicap, as the start
screen says. Measured, a seat playing at Normal strength against three
rivals wins 33% at Easy, 26% at Normal, 13% at Hard (80 seasons each).
Campaigns and online matches keep the settings they started with.

## First game and colour

**Basic rules** (the default on a first visit) leave out the roles draft,
the council, pacts and technology: orders, the Throne, objectives and fog
only. **Full** turns them all on. Online matches always use the full rules.
Every seat has a mark as well as a colour (● ▲ ■ ◆ ★ ✚), drawn beside its
positions and shown in the standings, the details panel, the report and
the scoreboard, so ownership never depends on telling colours apart.

## Orders on screen

Orders are numbered in the order given, with the same numbers drawn on the
map; Undo (or Ctrl+Z) takes back the last one, × any one, and the message
names anything else it cancelled. A line under the list says when they
happen: on lock, all at once, in four steps (upgrades and research, holds
and supports, sends, the Doomstar).

## Tests

```
node --test dominion/sim.test.js dominion/campaign.test.js dominion/online.test.js
```

39 cases: galaxy connectivity, no crossing lanes and identical wedges for 2
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
grudges; rivals voting legally; pacts sharing sight and running out,
betrayal making an Oathbreaker, rivals keeping their word; the tech tree's prerequisites and effects;
each faction's rule. `campaign.test.js`, 4 cases: a full campaign
(places, legacy draft order, one legacy each, a winner), legacies applied,
a person's legacy pick, grudges carried over. `online.test.js`, 4 cases:
a full online season of two people and two rivals with both clients
identical every round and orders hidden until both lock, the database
refusing moves for another seat or twice, no pacts with people online,
the Neon client's requests.
