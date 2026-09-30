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

Current baseline over 200 seeds: 198 / 167 / 133 player wins across the
three difficulty tiers, zero stalemates. Difficulty must stay monotonic
and stalemates must stay at zero.

### What the benchmark cannot see

The scripted commander used for balance sweeps attacks on a fixed 1.5s
cadence, never banks units and barely spends credits. Measured with
single-modifier ablations over 200 seeds, it prices only three things:

- fleet **speed** (very strong: +40% speed was worth +22 points)
- unit **production** rate
- **defence** strength

and is completely blind to **garrison cap**, **credit income** and
**research cost** — cap cut to 80% measured as exactly 0 difference.
Its response is also not smooth: a 1% production cut measured −7 points
while an 8% cut measured 0. Treat anything inside ±10 points as noise,
and never price a doctrine's *cost* on a lever the harness reports as
free. The sweep lives in the scratchpad as `harness.js` plus the
`tune*.js` / `iso*.js` drivers.

## Branch

Work goes on `claude/rts-city-manager-game-mkjevh`.
