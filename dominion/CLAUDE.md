# Working notes for DOOMSTAR: DOMINION

## Where this lives

`dominion/` is the new game. `outpost/` is the finished OUTPOST and stays
as it is: do not change it for Dominion's sake. Dominion copied
`holo.js`, `holo-gl.js`, `net.js` and `vendor/` from OUTPOST; only
`holo.js` (the Doomstar orb and lock-on painters) is wired in so far.

The owner asked for a fork into a separate repository. This session could
not create one (GitHub refused repository creation, 403), so Dominion
lives here until the owner creates the repository and it can be pushed
there.

## Always post the githack link after a push

```
https://raw.githack.com/cowgoat88/dcord-bcoin/<commit-sha>/dominion/index.html
```

## Before committing

- `node --test dominion/sim.test.js dominion/campaign.test.js dominion/online.test.js` green, run twice.
- `node --test outpost/*.test.js` still green: nothing in `outpost/` should
  have changed.
- Look at the page at desktop and phone width.

## Design

The design document is the plan:
https://claude.ai/code/artifact/5cfa5de5-1840-4c79-9bfa-21bf4f59e9d6
Three pillars, and a feature that serves none of them waits: orders are
plans, not reflexes; points, not annihilation; politics is a second board.

## Files

- `sim.js` the rules, `ai.js` the rival commanders, `campaign.js` seasons
  and legacies, `index.html` the page. All UMD, no build step.
- `sounds.js` is generated: edit `tools/sfx.js` and run
  `node dominion/tools/sfx.js`. Howler (vendored) plays the data URIs; a
  file fetch would fail from `file://`.

## Engine notes

- `sim.js` is pure and deterministic. The forecast and the replay are the
  same code on a `cloneGame` copy; if they ever disagree with what
  happens, determinism broke, and a test checks the forecast against the
  real round to the unit when rivals pass.
- Nothing moves during plotting. `addOrder` validates against the frozen
  board and stores; `beginResolve` applies spending, then hold and
  support, then launches, seats interleaved; `step` only runs during a
  resolve and ends the round itself at `ROUND_SECONDS`.
- Same-instant processing turns by one seat each round (`seatOrder`). With
  a fixed order the later seat always got the second, decisive hit on a
  position two seats reached together.
- The AI walks every list starting from its own sector (`ring` in
  `ai.js`). Walking by node id made every rival break ties toward the same
  low-numbered sectors. Any new AI loop must do the same.
- Fog of war: rivals plan on `viewFor(game, seat)` and the forecast runs
  on it too. Anything new that reads the board on a seat's behalf (AI,
  forecast, UI hints) must read the view, not `game`, or it leaks what the
  seat cannot see. The UI draws through `known(n, fog)`.
- The council resolves at the start of `beginResolve`, before any order is
  applied, so a law voted this round already binds this round. The
  forecast skips it (`skipCouncil`): nobody knows the vote. Laws in force
  live in `game.laws` as `{ id, seat?, from, to }`; permanent ones use
  `to: 9999`, never Infinity, which JSON turns into null.
- `game.tech[seat][id]` holds the round a technology was researched, and 0
  for one that came with a campaign legacy: test with `hasTech`, never
  truthiness.
- Rivals plot only in the plot step, with the same command points and
  orders as a person, and lock. They never act during a resolve.

## Measuring

`scratchpad/dom/sweep.js <seats> <seeds>` runs all-AI seasons and prints
wins by seat, how seasons end, Throne holding and captures. Seat fairness
is the first number to look at after any rule or AI change: a symmetric
galaxy with a biased result means a tie-break somewhere is not rotation
invariant.

## Online: store orders, not state

The planned backend is Neon Postgres through its Data API (HTTP from the
browser, guarded by row-level security and Neon Auth). It stores only the
match record and each seat's orders per round. Every client re-runs the
round itself from the same orders. That needs no server code and keeps
the game a static page, but it only works if the simulation is
bit-identical in every browser, so `sim.js` uses only exactly specified
math (`+ - * /`, `Math.sqrt`, `Math.round`); a test enforces it. Orders
stay hidden by RLS until every live seat has locked the round.

Built: `online.js` (stores and the match client), `schema.sql` (tables and
RLS), the Online option in the page. Two rules keep clients identical:
the resolve on screen steps by `S.STEP` through an accumulator, never by
frame time; and rivals plan (`Client.planRivals`) at the start of the plot,
before any person's orders are applied. Never let anything a person does
reach the game state online except through posted moves.
Sound: Howler.js, vendored in `vendor/`, never from a CDN.
