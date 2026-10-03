// Run with: node --test outpost/holo.test.js
//
// holo.js splits into pure camera maths and a canvas renderer. This file
// covers the part that can be wrong silently: if the inverse projection
// drifts, taps land on the wrong station; if the fit is off, a Command is
// pushed off a phone screen. Neither shows up as an exception, so they are
// pinned here with numbers. The look of the scene is checked in a browser.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const E = require("./engine.js");
const H = require("./holo.js");

const DEG45 = Math.PI / 4;
const YAWS = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => k * DEG45);

// The same shape rule as boardShape() in index.html: constant area, the
// aspect follows the canvas, so a phone gets a tall map and a desktop a
// wide one. Generating maps this way is what the on-screen gates need.
function shapeFor(w, h) {
  const area = E.MAP_W * E.MAP_H, aspect = w / h;
  return { mapW: Math.sqrt(area * aspect), mapH: Math.sqrt(area / aspect) };
}
function gameFor(seed, w, h) {
  const s = shapeFor(w, h);
  return E.createGame({ seed, mapW: s.mapW, mapH: s.mapH });
}
function camFor(game, w, h, yaw, zoom) {
  return H.createCamera({ w, h, mapW: game.mapW, mapH: game.mapH, yaw, zoom: zoom || 1 });
}

const PHONE = [390, 844], DESK = [1280, 800];

test("board point -> project -> toBoard round-trips under 0.5 px at every yaw", () => {
  // The error is measured on the board, then converted to screen pixels
  // with the local scale, because 0.5 px is the stated bar and a fixed
  // world tolerance would be generous far away and harsh up close.
  for (const [w, h] of [PHONE, DESK]) {
    const game = gameFor(3, w, h);
    for (const yaw of YAWS) {
      const cam = camFor(game, w, h, yaw);
      for (let i = 0; i <= 8; i++) {
        for (let j = 0; j <= 8; j++) {
          const x = game.mapW * i / 8, y = game.mapH * j / 8;
          const p = H.project(cam, x, y, 0);
          const b = H.toBoard(cam, p.x, p.y);
          const err = Math.hypot(b.x - x, b.y - y) * p.scale;
          assert.ok(err < 0.5, "yaw " + yaw + " (" + x + "," + y + ") err " + err);
        }
      }
    }
  }
});

test("toBoard returns null above the horizon instead of a wild point", () => {
  const game = gameFor(1, ...DESK);
  const cam = camFor(game, ...DESK, 0);
  assert.equal(H.toBoard(cam, 640, -100000), null);
});

test("pick returns each node at its own projected centre, at every yaw", () => {
  for (const [w, h] of [PHONE, DESK]) {
    const game = gameFor(5, w, h);
    for (const yaw of YAWS) {
      const cam = camFor(game, w, h, yaw);
      for (const n of game.nodes) {
        const p = H.project(cam, n.x, n.y, 0);
        for (const touch of [false, true]) {
          const hit = H.pick(cam, game, p.x, p.y, touch);
          assert.equal(hit && hit.id, n.id, "yaw " + yaw + " node " + n.id + " touch " + touch);
        }
      }
    }
  }
});

test("pick also hits a station by its raised plate, not only its foot", () => {
  // The garrison number floats above the pylon; aiming at it must select
  // the station, which a footprint-only hit test would miss.
  const game = gameFor(5, ...DESK);
  const cam = camFor(game, ...DESK, 0);
  for (const n of game.nodes) {
    const top = H.project(cam, n.x, n.y, H.HEIGHT[n.type]);
    const hit = H.pick(cam, game, top.x, top.y, false);
    assert.equal(hit && hit.id, n.id);
  }
});

test("pick is null well away from every node", () => {
  for (const [w, h] of [PHONE, DESK]) {
    const game = gameFor(8, w, h);
    for (const yaw of YAWS) {
      const cam = camFor(game, w, h, yaw);
      // Off-canvas probes are always far from the board.
      for (const [px, py] of [[-300, -300], [w + 300, h + 300], [-300, h / 2], [w / 2, -300]]) {
        assert.equal(H.pick(cam, game, px, py, true), null);
      }
      // And probes on the canvas that are independently measured to be
      // far (> 60 px) from every foot-to-number line.
      let probed = 0;
      for (let px = 4; px < w; px += w / 9) {
        for (let py = 4; py < h; py += h / 9) {
          let near = Infinity;
          for (const n of game.nodes) {
            // Sample the foot-to-number line densely; its nearest sample
            // bounds the distance to the whole hit capsule from above by
            // a pixel or two, which a 60 px margin swallows.
            const a = H.project(cam, n.x, n.y, 0), t = H.numberSpot(cam, n, {});
            for (let k = 0; k <= 8; k++) {
              near = Math.min(near, Math.hypot(px - (a.x + (t.x - a.x) * k / 8), py - (a.y + (t.y - a.y) * k / 8)));
            }
          }
          if (near > 60) { probed++; assert.equal(H.pick(cam, game, px, py, true), null); }
        }
      }
      assert.ok(probed > 0, "found no empty probe points to test");
    }
  }
});

test("touch slack is larger than mouse slack", () => {
  assert.ok(H.PICK.touchSlack > H.PICK.mouseSlack);
  // Behaviourally: find a point that a finger hits and a cursor misses.
  const game = gameFor(5, ...DESK);
  const cam = camFor(game, ...DESK, 0);
  const n = game.nodes[0];
  const p = H.project(cam, n.x, n.y, 0);
  const reachMouse = Math.max(E.NODE_TYPES[n.type].radius * p.scale, H.PICK.minRadius) + H.PICK.mouseSlack;
  const reachTouch = Math.max(E.NODE_TYPES[n.type].radius * p.scale, H.PICK.minRadius) + H.PICK.touchSlack;
  // Probe straight down from the foot: the plate is above it, so the
  // nearest part of the station is the foot itself.
  const py = p.y + (reachMouse + reachTouch) / 2;
  // Only meaningful if no other node is closer to the probe.
  const other = game.nodes.some((m) => {
    if (m === n) return false;
    const q = H.project(cam, m.x, m.y, 0);
    return Math.hypot(q.x - p.x, q.y - py) < 40;
  });
  assert.ok(!other, "test geometry: another node is too close to the probe");
  assert.equal(H.pick(cam, game, p.x, py, false), null);
  assert.equal(H.pick(cam, game, p.x, py, true).id, n.id);
});

test("overlapping nodes resolve to the nearer centre", () => {
  // Two stations whose hit areas overlap heavily. The click must go to
  // whichever centre is closer, whichever is drawn nearer the viewer.
  const game = {
    mapW: 1000, mapH: 640, lanes: [], fleets: [],
    nodes: [
      { id: 0, x: 500, y: 300, type: "factory", owner: 0, garrison: 5, level: 0 },
      { id: 1, x: 520, y: 300, type: "factory", owner: 0, garrison: 5, level: 0 }
    ]
  };
  for (const yaw of YAWS) {
    const cam = camFor(game, ...DESK, yaw);
    const a = H.project(cam, 500, 300, 0), b = H.project(cam, 520, 300, 0);
    // Along the foot-to-foot line, a quarter and three quarters of the way.
    const at = (t) => [a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t];
    assert.equal(H.pick(cam, game, ...at(0.25), true).id, 0, "yaw " + yaw);
    assert.equal(H.pick(cam, game, ...at(0.75), true).id, 1, "yaw " + yaw);
    // Beyond each end the answer stays with the nearer one -- but only
    // when the feet are side by side on screen. Seen end-on (yaw 90/270)
    // one station's raised plate lands on top of the other's foot, and the
    // plate is what is drawn there, so that tap rightly goes to it.
    if (Math.abs(b.x - a.x) > 5) {
      assert.equal(H.pick(cam, game, ...at(-0.3), true).id, 0);
      assert.equal(H.pick(cam, game, ...at(1.3), true).id, 1);
    }
  }
});

test("yawFacing puts the seat's Command in the lower half of the screen", () => {
  for (const [w, h] of [PHONE, DESK]) {
    for (let seed = 1; seed <= 20; seed++) {
      const game = gameFor(seed, w, h);
      for (const seat of [E.PLAYER, E.ENEMY]) {
        const yaw = H.yawFacing(game, seat);
        const cam = camFor(game, w, h, yaw);
        const home = game.nodes.find((n) => n.type === "command" && n.owner === seat);
        const p = H.project(cam, home.x, home.y, 0);
        assert.ok(p.y > h / 2, "seed " + seed + " seat " + seat + " y " + p.y + " of " + h);
        // yawFacing snaps to a quarter turn, so the Command is within 45
        // degrees of straight at the viewer rather than exactly on axis.
        const dx = home.x - game.mapW / 2, dy = home.y - game.mapH / 2;
        const along = dx * -Math.sin(yaw) + dy * Math.cos(yaw);
        assert.ok(along >= Math.hypot(dx, dy) * Math.SQRT1_2 - 1e-6, "seed " + seed + " seat " + seat);
      }
    }
  }
});

test("20 seeds: every node and plate is on screen at default zoom, both viewports", () => {
  // Checked at every orbit angle, not just the default: the camera refits
  // per yaw, so a rotated board must still fit.
  for (const [w, h] of [PHONE, DESK]) {
    for (let seed = 1; seed <= 20; seed++) {
      const game = gameFor(seed, w, h);
      const yaws = YAWS.concat([H.yawFacing(game, 1), H.yawFacing(game, 2)]);
      for (const yaw of yaws) {
        const cam = camFor(game, w, h, yaw);
        for (const n of game.nodes) {
          for (const z of [0, H.HEIGHT[n.type]]) {
            const p = H.project(cam, n.x, n.y, z);
            assert.ok(p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h,
              w + "x" + h + " seed " + seed + " yaw " + yaw.toFixed(2) + " node " + n.id + " z" + z +
              " at " + p.x.toFixed(1) + "," + p.y.toFixed(1));
          }
        }
      }
    }
  }
});

test("20 seeds at 390x844: no station is under 18 px across on the default views", () => {
  // The default views are the ones the player lives in: yaw 0 and facing
  // either Command. A sideways orbit of a tall board is allowed to be
  // small -- it is a deliberate choice, not the starting view. The strict
  // measure is the drawn footprint; the tap target is checked as well.
  const [w, h] = PHONE;
  let smallest = Infinity;
  for (let seed = 1; seed <= 20; seed++) {
    const game = gameFor(seed, w, h);
    for (const yaw of [0, H.yawFacing(game, 1), H.yawFacing(game, 2)]) {
      const cam = camFor(game, w, h, yaw);
      for (const n of game.nodes) {
        const p = H.project(cam, n.x, n.y, 0);
        const drawn = 2 * E.NODE_TYPES[n.type].radius * p.scale;
        smallest = Math.min(smallest, drawn);
        assert.ok(drawn >= 18, "seed " + seed + " node " + n.id + " " + n.type + " drawn " + drawn.toFixed(1));
        const tap = 2 * (Math.max(drawn / 2, H.PICK.minRadius) + H.PICK.touchSlack);
        assert.ok(tap >= 18);
      }
    }
  }
  assert.ok(smallest >= 18);
});

test("zoom is clamped to its range and changes scale monotonically", () => {
  const game = gameFor(2, ...PHONE);
  const at = (z) => H.createCamera({ w: 390, h: 844, mapW: game.mapW, mapH: game.mapH, yaw: 0, zoom: z });
  assert.equal(at(0.1).zoom, H.ZOOM_MIN);
  assert.equal(at(9).zoom, H.ZOOM_MAX);
  assert.ok(at(1.4).focal > at(1).focal && at(1).focal > at(0.8).focal);
});

test("radius table agrees with the engine so the camera need not import it", () => {
  for (const type of Object.keys(E.NODE_TYPES)) {
    assert.equal(H.RADIUS[type], E.NODE_TYPES[type].radius, type);
    assert.equal(H.SHAPE[type], E.NODE_TYPES[type].shape, type);
  }
});

// ---------------------------------------------------------------------
// Renderer smoke test with a recording stand-in for the canvas. It cannot
// say whether the picture is good, only that a frame draws without
// throwing, with the label size floor kept, and that per-frame gradient
// creation stays at zero once the sprites exist -- the property the plan
// calls out for phone performance.
// ---------------------------------------------------------------------
function fakeCanvas() {
  const calls = {};
  const fonts = [];
  const ctx = new Proxy({}, {
    get(t, k) {
      if (k in t) return t[k];
      return (...a) => { calls[k] = (calls[k] || 0) + 1; return { addColorStop() {} }; };
    },
    set(t, k, v) { if (k === "font") fonts.push(v); t[k] = v; return true; }
  });
  const make = () => ({ width: 0, height: 0, clientWidth: 390, clientHeight: 844, getContext: () => ctx });
  return { canvas: make(), make, calls, fonts };
}

test("render draws a frame; gradients are cached, labels are at least 11px", () => {
  const f = fakeCanvas();
  const r = H.create(f.canvas, { createCanvas: f.make });
  const game = gameFor(4, 390, 844);
  // Put a fleet in flight so the fleet path runs too.
  E.sendFleet(game, game.nodes.find((n) => n.owner === E.PLAYER).id,
    game.nodes.find((n) => n.owner === E.ENEMY).id, 1, E.PLAYER);
  for (let i = 0; i < 20; i++) E.step(game, 0.1);
  r.resize(390, 844, 3);
  assert.equal(f.canvas.width, 780, "dpr is clamped to 2");
  r.render({ game, now: 1000, dt: 16, mySeat: E.PLAYER });
  const first = f.calls.createRadialGradient;
  assert.ok(first > 0);
  r.render({ game, now: 1016, dt: 16, mySeat: E.PLAYER });
  r.render({ game, now: 1032, dt: 16, mySeat: E.PLAYER });
  assert.equal(f.calls.createRadialGradient, first, "no gradient creation after the first frame");
  assert.equal(f.calls.createLinearGradient, undefined);
  for (const font of f.fonts) {
    const px = parseFloat(/(\d+(\.\d+)?)px/.exec(font)[1]);
    assert.ok(px >= 11, font);
  }
  // The renderer's own pick agrees with the pure one.
  const n = game.nodes[3];
  const s = r.screenOf(n.x, n.y);
  assert.equal(r.pick(s.x, s.y, false).id, n.id);
  r.orbit(Math.PI / 2);
  const s2 = r.screenOf(n.x, n.y);
  assert.equal(r.pick(s2.x, s2.y, false).id, n.id);
  r.zoomBy(100);
  assert.equal(r.camera().zoom, H.ZOOM_MAX);
});
