# Working notes for OUTPOST

## Always post the githack link after a commit

Every time work is committed and pushed, end the reply with the live
preview URL for that exact commit:

```
https://raw.githack.com/cowgoat88/dcord-bcoin/<commit-sha>/outpost/index.html
```

Use the specific commit SHA, not a branch name — the owner plays the link
straight away and a branch URL can serve a stale cached copy. One link per
push, at the end of the reply.

## Before committing

- `node --test outpost/engine.test.js` must be green (run it more than
  once; growth and AI decisions are probabilistic).
- No `window.__dbg` or other debug hooks left in `index.html`.
- Check the change in a real browser at desktop *and* phone width.

## Balance changes get measured, not guessed

Several "obvious" tunings in this project turned out backwards when
measured — difficulty tiers inverted twice, and reducing lane density
produced no chokepoints at all. Run a seed sweep and report the numbers
rather than reasoning from the constants.

Current baseline over 200 seeds with the person-like commander
(`scratchpad/harness2.js`): difficulty must stay monotonic and
stalemates must stay at zero.

### Measure how often an effect can even apply, before tuning it

The first doctrine set was tuned carefully and did nothing a player
could feel, because three of the things it was built on never happen:

| | measured in real matches |
|---|---|
| credits earned per match | 12, against a 90-credit research level |
| research levels completed | 0.13 per match |
| time spent at the garrison cap | 0.0% of node-seconds |
| Doomstar strikes | 0.00 per match; the centre stayed neutral 40/40 |
| ...but a human match has been decided by one | the bots do not play objectives; benchmark figures for the weapon are a floor, not a verdict |
| positions cut off from supply | 25% of node-seconds |

So before pricing a lever, measure how much of the match it is live
for. `scratchpad/felt.js` does exactly this and is worth re-running
after any balance change.

### Two scratch harnesses disagree, and one of them is wrong

`bal2.js` measures the ascension ladder against a fixed Standard
opponent; the shipped game draws the AI's doctrine from the map seed.
`lad.js` does that and is the one to trust for ladder numbers — the two
gave 93/82/74/26/5/11 and 92/82/61/21/10/4 for the same rungs. At the
top rungs both are in single digits, where 5/200 against 11/200 is
noise rather than an ordering.

### What the benchmark cannot see

The old harness (`harness.js`) attacked on a fixed cadence, never banked
units and barely spent credits, so it priced cap, credits and the weapon
at exactly zero. `harness2.js` replaces it: it values Mines, commits 60%
rather than 75%, and spends on upgrades as well as research, which
produces 110-150s matches and a roughly even fight at Officer.

Even so its response is **not monotonic** — dialling production from
0.85 to 0.80 to 0.70 moved one doctrine's win rate 76% → 87% → 60% — and
any attack or defence penalty hits its commit threshold like a cliff, so
composing two separately-measured levers does not give their sum.
Measure each candidate whole, never price a doctrine's cost on attack or
defence alone, and treat anything inside +/-10 points as noise.

### Campaign missions cannot be balanced from here

`scratchpad/mission.js` and `mtune.js` run the scripted commander
through each mission with every doctrine. They are good enough to catch
a mission that is unwinnable, trivially winnable, or won in 20 seconds
when it is supposed to be a siege — and that is all. At 10-40 runs per
cell the noise is about +/-25 points, and the bot plays objectives
badly: it does not shuttle a garrison between two posts, it does not
play to a clock, and it never takes the centre. So "only this doctrine
can win this map" is a claim this toolchain cannot support. Use it to
rule out broken missions, then hand the rest to a person.

### Do not gate features behind the hardest thing in the game

The ascension ladder shipped locked until a Commander win, and the
owner — who could not beat Commander — simply had no access to a
finished feature. Progression is fine as a *record*; it is not fine as a
*lock* on content someone already has. The same instinct nearly buried
the campaign, which was a collapsed `<details>` that read as a section
heading rather than a control.

Related: five mission rows open by default push Deploy below the fold on
every phone size measured (390x844 and 360x640 both).

The start card is now a stepped flow (`showStep`) rather than one tall
stack, which is what bought the headroom back: the tallest screen is
536px against a 568px single card that showed less. `scratchpad/flow.js`
walks every path at 360x640 and desktop and asserts the primary button
is reachable without scrolling on each one -- run it after anything that
adds a control to the start card.

### A balance change this big invalidates every other balance number

Closing transit through neutral ground is one line in `canTransit`. It
changed the length of a match from ~80s to ~148s, and that alone broke:

- the difficulty ladder (100/18/2/0 until the production multipliers were
  re-fitted),
- the doctrine set (a 53-68% band at Officer spread to 35-95%; Forward
  Relays 95/87, Shock Troops 35/15),
- the ascension ladder (starting tech compounds over a longer match --
  Fortify I alone took Commander from 33% to 13%),
- a campaign mission (`The Waist` became a guaranteed loss, which is how
  Cadet's production ceiling was found),
- and six engine tests that encoded the old routing rule.

So after any change to routing, supply or match length, re-run all of it:
`scratchpad/rush.js`, `doc.js`, `lad.js`, `mission.js`, and a 120-seed
ladder sweep with `harness2.js`. Fixing only the thing you aimed at
leaves five silent regressions.

### The AI could not be fixed into solving the opening all-in

Eight AI-side candidates were built and measured against the rush (hold
everything, wait for the AI's first push to leave, send 75% of every
position at its Command). All eight failed, several made normal play
worse, and the most careful one -- a time-aware home defence that only
commits when the arriving force actually clears the attack and lands
before the wave -- correctly declines to commit, because on the opening
tick there is nothing to commit with. The table is in the README. When a
behaviour fix keeps failing in every form, check whether the geometry
makes the position defensible at all.

### Two layout checks to run before committing UI work

- `scratchpad/flow.js` walks every start-screen path at 360x640, 390x844
  and desktop and fails if a primary action needs scrolling. It catches
  the one failure mode this card keeps having.
- `scratchpad/hud.js` sweeps ten widths from 1440 to 320 and fails if
  the toolbar wraps, overflows, or clips a button. Adding a single
  button to the top bar silently wrapped it onto a second row at 1280px;
  nothing else would have caught that.

Both re-derive their own pass/fail, so read the last line rather than
the table.

### Native confirm() is not an option

The page is opened from githack and run in iframes and previews where
`window.confirm` is suppressed or ignored, and the Playwright checks
trap it as a failure. Destructive actions use the in-page dialog
(`askConfirm`) instead.

### A mission's opponent needs a posture, and two bugs hid behind it

`posture: "defend"` bounds the AI by its *starting territory*: it
retakes its own ground and attacks nothing else. Narrower versions all
failed -- see the README for which and why. While getting there, two
engine bugs surfaced that make over-cap fortifications impossible:
reinforcing a position clamped it down to its cap, and the AI's
"shore up the front" branch sent half of a donor away even on a
defensive map. Both are fixed and tested. If a mission's fortification
appears to melt, check those two first.

### Overlays opened over a live match must be able to close

`?` in the top bar called `resetFlow()` and cleared `started`, which
abandoned the match to show the rules. Anything opened over a running
game -- help, the record, a dialog -- pauses rather than ends it,
restores the previous pause state on close, and answers Escape and a
backdrop click. `scratchpad/help.js` checks the clock actually freezes
and actually resumes, which is the part a visual check misses.

### The online flow needs its own smoke test

`scratchpad/net2tab.js` drives two tabs through the whole thing: host,
join, auto-start, clock sync, mirrored seats, leaving. It exists
because the stepped start flow silently removed the host's only way to
begin an online match -- `showStep` hid the primary button on the
online screen -- and nothing else noticed for two commits. Any change
to `showStep`, the net handlers or the start flow should re-run it.

Note the two-tab path (`btnLocal`) builds its own host session and does
NOT go through `startHosting`, so a hook added to one needs adding to
both. That is how the first attempt at this fix missed.

### Phone-to-phone matchmaking: two separate failures, one symptom

Reported from two iPhones: "no game found with the code" on the guest,
"loses connection" on the host, no idea what it was waiting for. There
are two independent causes and fixing either alone leaves it broken.

1. **Leaving the app kills the room.** iOS suspends a backgrounded
   Safari tab within seconds. The WebSocket to the signalling server
   closes, PeerJS releases the room id, and the friend who types the
   code is told there is no such room. Sending the code is the one thing
   the host *must* do, so the flow guarantees the failure. PeerJS does
   not recover on its own: nothing in it calls `reconnect()`. net.js now
   watches `disconnected`, reclaims the same id with a backoff, and --
   this is the load-bearing part, because a suspended tab's timers do
   not run either -- retries immediately on `visibilitychange`,
   `pageshow`, `focus` and `online`.
2. **STUN alone cannot cross carrier-grade NAT.** Two phones on mobile
   data usually both have unreachable addresses, so signalling succeeds
   and the data channel never opens. That needs TURN. The relay list is
   in `net.js` and `setIceServers()` replaces it from the page.

   The confirmed working test was run over cellular, so the relay is not
   a precaution -- it is carrying the traffic, and the game depends on a
   free third-party service staying up. If phone-to-phone play breaks
   again with the room opening fine and the connection never forming,
   suspect the relay first and check it before touching anything else.

The guest side was also wrong to believe the first answer: it now
retries a dial six times, because the host's phone being asleep when the
code is typed is the normal case, not an edge case.

### What cannot be verified from this container

The egress proxy blocks the PeerJS broker and every TURN host, so a real
two-device handshake cannot run here. The fix for it was shipped on the
strength of the stand-in below and then confirmed working between two
iPhones -- so the method holds, but note what it rests on: a stand-in is
evidence about the state machine, never about the network.
`scratchpad/netphone.js` is the closest thing: it serves the real page over HTTP, swaps the vendored
PeerJS for `scratchpad/fakepeer.js` (a stand-in with a localStorage
registry and BroadcastChannel data channels), and drives two tabs
through host, suspend, join-while-asleep, wake and play. It models a
suspended tab honestly -- `reconnect()` is a no-op while asleep -- which
is what makes the foreground wake-up testable at all.

Getting the stand-in wrong hid a bug once: its connections opened even
when the target id did not exist, so a guest that should have been
retrying looked connected. If a net change passes suspiciously easily,
check the stand-in's fidelity before believing it.

`net.test.js` covers the same state machine headlessly with a fake Peer
and controllable timers.

### Seat 2 means two different things, and the engine has to be told which

Seat `ENEMY` is the AI in a solo match and the second person online.
Anything in the simulation that acts for seat 2 unprompted is correct in
the first case and a bug in the second, and the host runs the
simulation for both sides, so the bug lands on the guest.

It shipped that way: `step()` auto-fired the Doomstar for seat 2 every
tick. Online that spent the guest's charge the instant it filled, at a
target they never chose. From the guest's seat the bar filled, emptied
itself, and the FIRE button never lit -- which reads as "the weapon is
broken", not as "the host fired it for me".

The online path had been disabling the AI with `game.ai.timer =
Infinity`, which says nothing about the rest of the loop and only
covered `stepAI`. There is now an explicit `game.humanFoe`, set at all
four places an online game is built, and both `stepAI` and the
automatic Doomstar are gated on it. Anything added later that acts for
seat 2 on its own goes behind the same flag -- grep for it before
writing a new one.

### Both views share one board orientation

Your base is drawn on the near side: bottom of a portrait screen, left
of a landscape one. The generator puts seat 1 at the top of a portrait
map, so the 2D view is turned half a turn for whoever starts on the far
side (`flipView`, decided once per game in `orientBoard`), and the 3D
camera starts at yaw 0 or pi to match. Switching views only tilts the
board. The flat turn is done by drawing from a mirrored stand-in game,
not by rotating the canvas, which would turn every number upside down;
`pickFlat` and `screenOfFlat` map through the same mirror.
`scratchpad/orient/orient.js` measures from pixels that the base is on
the same side in both views; `orient/tap.js` checks a tap in the turned
view selects the node drawn there. Any harness that projects station
positions must use the same rule (see `holoplay.js` `homeYaw`).

### Lanes never cross

The owner found overlapping lanes hard to read. `buildLanes` now accepts
lanes shortest first, in mirror pairs, only if they cross nothing, leave
every node at least 28 degrees from its other lanes and clear foreign
nodes. Before: 3-5 crossings per map and 0-degree angles on almost every
map. After: none, with about 2 fewer lanes per map. That alone tilted
the ladder toward the player by 8-10 points at Officer and Captain; a
0.01 production nudge to each brought it back. Any future change to lane
rules needs the same ladder, doctrine, rush and mission re-measure.

### The invite link must not skip the doctrine screen

`?join=CODE` used to jump straight into the room, so the friend who
opened the link -- the usual way in, since Send invite shares a link --
never saw the doctrine choice and played whatever their phone had stored.
It now lands on the doctrine screen with "Join CODE" on the button.
`scratchpad/netinvite.js` drives that whole path against the stand-in
signalling server, and also checks the host is told the guest's doctrine
(the "Opponent connected" toast used to cover that announcement) and that
both boards use the host's map style. Run it after any change to the
start flow or the online handlers, alongside net2tab and netphone.

### Map styles: four generators, Mixed by default

`createGame({ layout })` takes classic, spaced, orbital or sectors. The
start screen offers them (beside the opponent in a skirmish, above Host
online) plus Mixed, the default, which never repeats the style just
played. The online welcome carries the layout so the guest builds the
host's board. Balance was measured per style but NOT re-fitted: the
owner found all four play well. Orbital's quick ladder read the AI
weaker at Captain and Commander (79/28/23 against classic's 88/44/31,
80 seeds); if a per-style fit is ever wanted, that is where to start.

### 3D Enhanced: three.js renderer with an automatic fallback

`holo-gl.js` draws the 3D view on WebGL with a vendored three.js subset
(`vendor/three.subset.min.js`, 0.186.1, rebuilt with the command in its
header from `vendor/three.subset.entry.js`). It is loaded only when
Enhanced is on (`prefs.gfx`, default off) and the 3D view is showing.
The view button in the top bar cycles 2D -> 3D -> 3D+ (Enhanced) -> 2D;
the switch in the help overlay sets the same pref. It started out only
in the help overlay and the owner could not find it -- a mode that only
exists behind a menu is a mode nobody uses. After a fallback the cycle
skips 3D+ for the rest of the session. Its camera is built from
`OutpostHolo.createCamera`, so pick, screenOf and every overlay are
holo.js's own; the overlays are drawn on the 2D `#board` canvas on top,
which keeps all pointer input.

The fallback is holo-gl -> holo -> flat, once per session, with one
toast: scripts fail to load or take over 15 s, no WebGL2, create or
render throws, a lost context not restored within 3 s, or the median
frame interval over 42 ms for 3 s (after first dropping to low quality).
Not 24 ms: a phone in Low Power Mode, and this sandbox's headless
browser, run at 30 Hz -- 33 ms a frame however light the scene -- and a
24 ms rule would switch Enhanced off on every one of them.

Testing it:
- `scratchpad/glfallback.js` forces every failure against a stand-in
  renderer (`scratchpad/gl2/stub-*.js`, served in place of the real files)
  and asserts one toast, the GL canvas hidden, the clock running, the
  selection and the camera kept. `scratchpad/hologlplay.js` plays a match
  through Enhanced by pointer events; `HOLOGL=real` points both at the
  real renderer, `NOSHOT=1` skips screenshots.
- Against the real renderer, this sandbox renders WebGL in software, so
  in a busy match the slow-frame rule fires legitimately and the later
  checks see standard 3D. That is the fallback working, not a bug, and
  no frame timing from here says anything about a phone. Phone
  smoothness is the owner's call on a device.
- `scratchpad/gl1/life.js` checks the real renderer's context loss,
  restore, throw and dispose behaviour.

### The Doomstar locks on before it fires

`fireDoomstar` no longer applies damage: it spends the charge and starts
`game.doomShot = { owner, targetId, t }`, and `stepDoomShot` lands the
strike `DOOM_LOCK_S` (2 s) later inside `step()`. Events: `doomlock` at
the start, `doomstar` at impact (`fizzled: true` if the target changed
hands meanwhile). The lock is in the snapshot (`ds`), so the guest sees
it too; renderers draw it from state. The guest gets no engine events,
so `applySnapshot` re-tells the lock (`doomlock`) and the strike
(`doomstar`, damage from the garrison change it saw) when `ds` starts
and ends -- without that the side being shot online got the laser but
no warning toast, sound or impact. Tests that fire the weapon must call
`E.stepDoomShot(g, E.DOOM_LOCK_S)` (or step the game) before asserting
damage. The station is drawn as an orb in every view: `paintOrb` /
`paintLock` in holo.js serve the flat and standard 3D views, and holo-gl
builds a sphere with trench and a dish that turns toward the target;
its `doomFocus()` tells the overlay where the laser starts.

### Campaign missions that run their own traffic

`campaign.js` missions can carry a `script` (convoys and dispatches, see
`stepScript` in engine.js) and an objective `keep` list, and set the
opponent to `posture: "static"`. The reason for static: with the normal
opponent routine alive, the AI retakes the crossing the moment it is
empty and the timetable stops being the puzzle. `campaign.test.js` plays
each scripted mission the intended way and the ways it must punish; add
the same pair of plays for any new scripted mission, because the
doctrine-sweep harnesses cannot play a timetable.

The objective, and the timetable, live on `#missionBar` under the
toolbar, never in `#hud`. An objective in the toolbar pushed Menu off
the screen at every width on every mission, and Menu is the way out of
a match. `scratchpad/mis/campaign_hud.js` checks all missions at ten
widths (toolbar one row, Menu clickable and leaving the match, strip
inside the viewport, board below it) and fails on the old build, which
is the proof that it can see the bug. A strip that changes height has
to resize the board, hence the ResizeObserver on `#boardWrap`.

Missions are drawn landscape. On a portrait screen `optionsFor(m, true)`
turns the board (x and y swapped); lanes, indices and distances are
untouched, so it is the same mission, and a test holds it to that.

### Fleets fight in lanes, and a tick-by-tick crossing is what detects it

`stepLaneCombat` runs after fleets move and before anything arrives. It
tracks each fleet's position along its lane in one fixed direction
(`f.lk`/`f.ls` are stamped before the move, so a fleet that turned onto a
new lane mid-tick starts from the node it came from) and a pair of
opposing fleets whose order swaps, or touches, between ticks fights. A
pair that began the tick at the same spot is skipped. No defence
modifiers; Assault research and doctrine only. Emits `clash` (x, y,
winner, count left, both sides) for the UI.

Two things to remember when writing a bot or a test: a small fleet sent
down a lane toward an enemy wave dies, and a fleet that used to "slip
past" something no longer does. `campaign.test.js` bots wait for lanes to
clear for that reason. Guests get no `clash` events, so no flash online.

Measured before and after on skirmishes (`scratchpad/lane/`), it moves
nothing outside noise, because skirmish fleets rarely cross. Re-measure
if the AI ever starts sending fleets through each other's lanes.

### Deep Logistics Relays charge when cut off

`relayCharge` returns the doctrine's cut-off rate (0.9) for a cut-off
Relay when the doctrine has one above the default, so only Deep
Logistics changes. It was asked for because The Waist's Annex cannot be
held connected, and a Doomstar that only charges while the crossing is
yours turns the mission into retaking the crossing after every convoy.

### A mission's brute-force route has to be measured, not assumed

The first Waist could be won without the Doomstar by timing the freight
and sending fleets at the Hub, and the first Last Light "smart" bot won
by sending a fleet to take a depot while its wave was still in the lane,
which only worked because fleets passed through each other. Give every
scripted mission a bot for the route it must not allow and make the test
fail if that route wins. What stopped the Waist brute force was not the
Hub's garrison alone (attrition does not care how big a number is when
it does not regenerate) but Fortify III on the Combine and a smaller
home economy. A strike ignores fortification and a fleet does not.

## Branch

Work goes on `claude/rts-city-manager-game-mkjevh`.
