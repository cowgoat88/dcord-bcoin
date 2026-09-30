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
| positions cut off from supply | 25% of node-seconds |

So before pricing a lever, measure how much of the match it is live
for. `scratchpad/felt.js` does exactly this and is worth re-running
after any balance change.

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

## Branch

Work goes on `claude/rts-city-manager-game-mkjevh`.
