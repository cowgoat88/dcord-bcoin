# Holotable view (Tier 1 3D) — implementation plan

A second, optional renderer that draws the existing match as a 3D
holotable: stations standing on a tilted board, fleets arcing between
them, depth, parallax, a Doomstar strike that crosses the volume. The
simulation, the rules, the map, the network protocol and every number in
`engine.js` stay exactly as they are. The flat 2D view stays the default
and stays fully supported.

Out of scope, by decision: free-space movement (no lanes), and any change
to map topology (concentric shells). Those are separate projects with
their own rebalance; nothing here touches balance.

## Decisions

**Canvas 2D with a hand-written perspective camera. No WebGL, no
Three.js.**

- The game runs from `file://` with classic scripts and no build step.
  Current Three.js ships ES modules only, and module scripts do not load
  from `file://`. Vendoring an old UMD build means ~600 KB pinned to a
  stale release.
- iOS Safari drops WebGL contexts when a tab is backgrounded under memory
  pressure. Backgrounding is part of the online flow (switching apps to
  send the room code), so a WebGL renderer would add a failure mode right
  where phone play was just made reliable. Canvas 2D has no such failure.
- The scene is small: about 14 stations, 30 lanes, tens of fleets, a few
  hundred particles. Projected Canvas 2D handles that at 60 fps on a phone
  if glows are pre-rendered sprites rather than per-frame gradients.
- It reuses the colours, shapes and effects the 2D view already has.

**The board stays a plane.** Stations get visual height and fleets get an
altitude arc in flight, but positions, distances and travel times are the
engine's 2D values. Nothing on the wire changes; host and guest can use
different views in the same match.

**The camera has two degrees of freedom: yaw (orbit) and zoom.** Pitch is
fixed per device class. There is no free camera.

## The seam

The 2D renderer touches screen geometry in 14 places (`view`, `toWorld`,
`toScreen`, `nodeAt`). All drawing happens in world coordinates under one
affine transform. That makes a narrow interface possible.

```js
// A renderer owns pixels and answers "what is under this point".
// index.html owns the game, input, selection and UI state.
renderer = {
  name,                         // "flat" | "holo"
  resize(cssW, cssH, dpr),      // sets its own transform or camera
  render(frame),                // frame: { game, now, dt, ...see below }
  pick(px, py, touch),          // CSS px -> node | null
  screenOf(wx, wy, wz = 0),     // world -> { x, y, scale } in CSS px
};
```

`holo.js` is a classic script exposing `window.OutpostHolo`. Its camera
maths is exported as pure functions so it is testable in Node with no
DOM:

```js
OutpostHolo.createCamera({ w, h, mapW, mapH, yaw, zoom, pitch? }) -> camera
OutpostHolo.project(camera, x, y, z)   -> { x, y, depth, scale } | null
OutpostHolo.toBoard(camera, px, py)    -> { x, y } | null   // onto z = 0
OutpostHolo.pick(camera, game, px, py, touch) -> node | null
OutpostHolo.yawFacing(game, seat)      -> yaw that puts seat's Command nearest
OutpostHolo.create(canvas, opts)       -> renderer (the interface above)
```

## Checkpoints

Every checkpoint ends with a commit only when all of its gates pass. A
failed gate stops the checkpoint; it does not get waved through.

Standing gates, re-run at every checkpoint:

- `node --test outpost/engine.test.js outpost/online.test.js outpost/net.test.js`
- `scratchpad/flow.js`, `hud.js`, `help.js`, `menu.js`, `net2tab.js`,
  `netphone.js` (see `CLAUDE.md` for what each guards)
- no `window.__dbg` or other debug hooks in `index.html`

### CP0 — Plan and contract

This file. The interface above is the contract both parallel workstreams
build to.

### CP1 — The seam, with no visible change

Wrap the existing 2D renderer as `flat` behind the interface, inside
`index.html`. Route `resize`, the per-frame draw and every `nodeAt` call
through `renderer`. Add a stored view preference (default `flat`) with no
control to change it yet.

Gates:

- all standing gates pass;
- screenshots of the start screen and of a paused match on a fixed seed,
  at 1280x800 and 390x844, match the pre-change baseline (mean absolute
  pixel difference under 1%; the starfield twinkles, so exact equality is
  not the bar);
- the diff to the 2D drawing functions is call-site only.

### CP2 — `holo.js` core, standalone (in parallel with CP1)

A new file, not yet loaded by `index.html`. Renders a match from game
state with no overlays: background with yaw parallax, a faint board grid,
lanes coloured by ownership, stations with height and a type silhouette
(hex Command, square Factory, diamond Mine, circle Relay, star Doomstar),
garrison numbers as billboards drawn in a final pass, fleets arcing along
their legs, painter-sorted far to near. Glows are cached sprites.

Gates (`holo.test.js`, Node):

- board point -> screen -> board round trip under 0.5 px, yaw 0..315 in
  45 degree steps;
- `pick` returns each node at its own projected centre at every yaw, and
  null well away from all nodes; touch slack exceeds mouse slack;
- overlapping nodes resolve to the nearer centre;
- `yawFacing` puts the seat's Command in the lower half of the screen;
- for 20 seeds, every node is on screen at default zoom at 390x844 and
  1280x800, and no node's tap diameter is under 18 CSS px at 390x844.

Gates (browser, standalone preview page in the scratchpad):

- screenshots at 1280x800 and 390x844 of opening, mid-game and late-game
  states, reviewed for legibility before CP3;
- a mid-game frame renders in under 8 ms median over 300 frames in
  headless Chromium at 390x844 (a proxy, not a phone measurement).

### CP3 — Integration

Load `holo.js`, add a 2D/3D control, persist the choice. Port the
overlays: selection rings, pending target, order preview numbers,
NO ROUTE, Doomstar aim mode, drag arrow, hover, particles and floating
numbers projected from world coordinates. Index.html computes what to
show; each renderer decides how to draw it, so preview maths is not
duplicated. Camera gestures must not collide with order gestures: on
touch, two fingers orbit and pinch zooms; with a mouse, right-drag orbits
and the wheel zooms. One finger keeps tap, hold and drag exactly as now.

Gates:

- all standing gates pass with the view set to 2D and again set to 3D;
- `hud.js` passes at all ten widths with the new control in the bar;
- a new `scratchpad/holoplay.js` plays a match through the 3D view by
  pointer events only: select, send, hold to group, reinforce, upgrade,
  research, aim and fire the Doomstar, pause, help, menu and back;
- switching views mid-match keeps selection and does not drop a frame of
  simulation.

**Human gate:** the owner plays at least one solo match and one online
match in 3D on a phone before CP4 starts. If the 3D view reads worse than
2D, the fix is decided then, not assumed.

### CP4 — Phones and online

- Default yaw faces each player's own Command, host and guest alike.
- Automatic low-fidelity mode when frame time runs over budget: fewer
  particles, no glow sprites, lower star count.
- `net2tab.js` and `netphone.js` pass with host and guest on different
  views.

### CP5 — Polish and record

Doomstar beam through the volume, capture flash, supply lines dimming
when cut. README section and `CLAUDE.md` notes on what the seam is and
how to test both renderers.
