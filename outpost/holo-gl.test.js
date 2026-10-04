// Run with: node --test outpost/holo-gl.test.js
//
// holo-gl draws with WebGL, which Node has none of, so what is pinned here
// is the part that can be wrong silently and is pure maths: the three.js
// camera built from a holo.js camera must put every world point on the same
// pixel holo.js does. If it drifts, the 2D numbers and overlays (drawn at
// holo's projection) float away from the stations drawn by the GL scene.
// The look of the scene is checked in a browser.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const E = require("./engine.js");
const H = require("./holo.js");
const GL = require("./holo-gl.js");

// The vendored IIFE bundle, run in a bare context: three's maths classes
// need no DOM. `self` is provided because some builds look for it.
const sandbox = { console };
sandbox.self = sandbox; sandbox.globalThis = sandbox;
vm.createContext(sandbox);
vm.runInContext(fs.readFileSync(path.join(__dirname, "vendor", "three.subset.min.js"), "utf8"), sandbox, { filename: "three.subset.min.js" });
const THREE = sandbox.THREE;

// Same shape rule as boardShape() in index.html.
function shapeFor(w, h) {
  const area = E.MAP_W * E.MAP_H, aspect = w / h;
  return { mapW: Math.sqrt(area * aspect), mapH: Math.sqrt(area / aspect) };
}
const YAWS = [0, 1, 2, 3, 4, 5, 6, 7].map((k) => k * Math.PI / 4);
const SIZES = [[390, 844], [1280, 800]];

test("the bundle exposes what holo-gl uses", () => {
  const src = fs.readFileSync(path.join(__dirname, "holo-gl.js"), "utf8");
  const names = [...new Set([...src.matchAll(/\bT\.([A-Z][A-Za-z0-9]*)/g)].map((m) => m[1]))];
  const missing = names.filter((n) => THREE[n] === undefined);
  assert.deepEqual(missing, []);
});

test("three.js camera projects every station to within 0.5 px of OutpostHolo.project", () => {
  let worst = 0, count = 0;
  for (const [w, h] of SIZES) {
    const s = shapeFor(w, h);
    for (const seed of [3, 11]) {
      const game = E.createGame({ seed, mapW: s.mapW, mapH: s.mapH, layout: seed === 11 ? "orbital" : "classic" });
      for (const yaw of YAWS) {
        for (const zoom of [1, 1.4, 0.8]) {
          const hc = H.createCamera({ w, h, mapW: game.mapW, mapH: game.mapH, yaw, zoom });
          const cam = GL.cameraFor(hc, THREE);
          for (const n of game.nodes) {
            const top = H.HEIGHT[n.type] || 30;
            for (const z of [0, top, top + 8]) {
              const ref = H.project(hc, n.x, n.y, z);
              const got = GL.projectThree(cam, THREE, hc, n.x, n.y, z);
              const err = Math.hypot(ref.x - got.x, ref.y - got.y);
              if (err > worst) worst = err;
              count++;
              assert.ok(err < 0.5, `${w}x${h} seed ${seed} yaw ${yaw.toFixed(2)} zoom ${zoom} node ${n.id} z ${z}: ${err}`);
            }
          }
        }
      }
    }
  }
  assert.ok(count > 1000);
  // Pure float arithmetic on both sides: it should be far below the bar.
  assert.ok(worst < 1e-3, "worst " + worst);
});

test("board corners, and the near/far planes, behave", () => {
  for (const [w, h] of SIZES) {
    const s = shapeFor(w, h);
    for (const yaw of YAWS) {
      const hc = H.createCamera({ w, h, mapW: s.mapW, mapH: s.mapH, yaw });
      const cam = GL.cameraFor(hc, THREE);
      for (let i = 0; i < 4; i++) {
        const x = i & 1 ? s.mapW : 0, y = i & 2 ? s.mapH : 0;
        const ref = H.project(hc, x, y, 0);
        const got = GL.projectThree(cam, THREE, hc, x, y, 0);
        assert.ok(Math.hypot(ref.x - got.x, ref.y - got.y) < 0.01);
        // Inside the clip volume: depth within (-1, 1).
        const v = new THREE.Vector3(x, 0, y).project(cam);
        assert.ok(v.z > -1 && v.z < 1, "corner clipped by near/far");
      }
    }
  }
});

test("cameraFor reuses a passed camera and keeps it in sync", () => {
  const s = shapeFor(390, 844);
  const cam = new THREE.PerspectiveCamera();
  const a = H.createCamera({ w: 390, h: 844, mapW: s.mapW, mapH: s.mapH, yaw: 0 });
  const b = H.createCamera({ w: 390, h: 844, mapW: s.mapW, mapH: s.mapH, yaw: 1 });
  assert.equal(GL.cameraFor(a, THREE, cam), cam);
  const p0 = GL.projectThree(cam, THREE, a, 100, 100, 0);
  GL.cameraFor(b, THREE, cam);
  const p1 = GL.projectThree(cam, THREE, b, 100, 100, 0);
  const ref1 = H.project(b, 100, 100, 0);
  assert.ok(Math.hypot(p1.x - ref1.x, p1.y - ref1.y) < 1e-3);
  assert.ok(Math.hypot(p0.x - p1.x, p0.y - p1.y) > 1, "camera did not move");
});

test("supported() is false where there is no WebGL (Node)", () => {
  assert.equal(GL.supported(), false);
});

test("the contract surface exists", () => {
  assert.equal(typeof GL.supported, "function");
  assert.equal(typeof GL.create, "function");
  assert.equal(typeof GL.cameraFor, "function");
  // create() needs a canvas and WebGL; without THREE it refuses clearly
  // rather than half-building.
  assert.throws(() => GL.create({}, { overlayCanvas: {} }), /THREE is not loaded|overlayCanvas|getContext/);
});

test("create() builds the renderer surface against a stub WebGLRenderer", () => {
  // A minimal stand-in for everything create() touches before the first
  // frame, so the exported surface and its non-GL behaviour are checked in
  // Node: yaw/zoom bookkeeping, screenOf == project, pick == holo's pick.
  const T = Object.assign({}, THREE);
  const stubGL = { ALIASED_POINT_SIZE_RANGE: 1, getParameter: () => [1, 256] };
  T.WebGLRenderer = class {
    constructor() { this.domElement = {}; }
    setClearColor() {} setPixelRatio() {} setSize() {} dispose() {} render() {} forceContextLoss() {}
    getContext() { return stubGL; }
  };
  const listeners = {};
  const glCanvas = {
    addEventListener: (k, f) => { listeners[k] = f; }, removeEventListener: (k) => { delete listeners[k]; },
    clientWidth: 390, clientHeight: 844
  };
  const overlay = { getContext: () => ({}), width: 0, height: 0 };
  // create() builds a few canvases (dash textures); none are needed here
  // because those are created lazily inside buildGame(), not create().
  global.document = { createElement: () => ({ getContext: () => ({ createRadialGradient: () => ({ addColorStop() {} }), fillRect() {} }), width: 0, height: 0 }) };
  try {
    const r = GL.create(glCanvas, { overlayCanvas: overlay, THREE: T });
    assert.equal(r.name, "holo-gl");
    for (const k of ["resize", "render", "pick", "screenOf", "toBoard", "camera", "orbit", "setYaw", "getYaw", "zoomBy",
      "setZoom", "getZoom", "onFailure", "setQuality", "quality", "dispose"]) assert.equal(typeof r[k], "function", k);
    assert.equal(r.quality(), "high");
    r.setYaw(Math.PI); assert.ok(Math.abs(r.getYaw() - Math.PI) < 1e-12);
    r.orbit(-2 * Math.PI); assert.ok(Math.abs(r.getYaw() - Math.PI) < 1e-9);
    r.setZoom(99); assert.equal(r.getZoom(), H.ZOOM_MAX);
    r.zoomBy(0.001); assert.equal(r.getZoom(), H.ZOOM_MIN);
    assert.ok(listeners.webglcontextlost && listeners.webglcontextrestored);
    r.dispose();
    assert.ok(!listeners.webglcontextlost, "dispose removes the listeners");
  } finally {
    delete global.document;
  }
});

// ---- GL3: fly-in, swarms, strike events ------------------------------------
// A stand-in WebGLRenderer that records what it is asked to draw, so the
// scene graph and the camera actually handed to three.js can be inspected
// in Node. The composer classes are stubbed too (the real ones need a GL
// context); the stub composer just draws the scene it was given.
function makeHarness(quality) {
  const T = Object.assign({}, THREE);
  const drawn = { scene: null, camera: null, calls: 0 };
  const stubGL = { ALIASED_POINT_SIZE_RANGE: 1, getParameter: () => [1, 256] };
  T.WebGLRenderer = class {
    constructor() { this.domElement = {}; }
    setClearColor() {} setPixelRatio() {} setSize() {} dispose() {} forceContextLoss() {}
    getContext() { return stubGL; }
    render(scene, camera) { drawn.scene = scene; drawn.camera = camera; drawn.calls++; }
  };
  T.EffectComposer = class {
    constructor(r) { this.r = r; this.passes = []; this.renderTarget1 = { dispose() {} }; this.renderTarget2 = { dispose() {} }; }
    setPixelRatio() {} setSize() {}
    addPass(p) { this.passes.push(p); }
    render() { const p = this.passes[0]; this.r.render(p.scene, p.camera); }
  };
  T.RenderPass = class { constructor(scene, camera) { this.scene = scene; this.camera = camera; } };
  T.UnrealBloomPass = class { constructor(res, strength, radius, threshold) { this.args = [strength, radius, threshold]; } dispose() {} };
  T.OutputPass = class {};
  const listeners = {}, overlayListeners = {};
  const glCanvas = {
    addEventListener: (k, f) => { listeners[k] = f; }, removeEventListener: (k) => { delete listeners[k]; },
    clientWidth: 390, clientHeight: 844
  };
  // Any 2D-context call is a no-op; assignments are accepted.
  const noop = () => ({ addColorStop() {} });
  const ctx2d = new Proxy({}, { get: (t, k) => (k in t ? t[k] : noop), set: (t, k, v) => { t[k] = v; return true; } });
  const overlay = {
    getContext: () => ctx2d, width: 0, height: 0,
    addEventListener: (k, f) => { overlayListeners[k] = f; }, removeEventListener: (k) => { delete overlayListeners[k]; }
  };
  global.document = { createElement: () => ({ getContext: () => ctx2d, width: 0, height: 0 }) };
  global.OutpostEngine = E;
  const r = GL.create(glCanvas, { overlayCanvas: overlay, THREE: T, quality });
  r.setYaw(0);
  r.resize(390, 844, 1);
  const s = shapeFor(390, 844);
  const game = E.createGame({ seed: 5, mapW: s.mapW, mapH: s.mapH, layout: "classic" });
  const colorOf = (o) => (o === 1 ? "#22d3ee" : o === 0 ? "#64748b" : "#fb7185");
  const frame = (now, extra) => Object.assign({ game, now, dt: 16, mySeat: 1, colorOf }, extra);
  const done = () => { r.dispose(); delete global.document; delete global.OutpostEngine; };
  return { r, T, drawn, game, frame, overlayListeners, done, s };
}

test("fly-in: mid-flight the three.js camera, screenOf and pick all match holo's animated camera", () => {
  const h = makeHarness("low");
  try {
    const { r, game, frame, drawn } = h;
    r.render(frame(1000));
    assert.equal(r.flying(), false);
    const home = H.createCamera({ w: 390, h: 844, mapW: game.mapW, mapH: game.mapH, yaw: 0, zoom: 1 });
    assert.equal(r.camera().yaw, 0);

    assert.equal(r.flyIn(), true);
    assert.equal(r.flying(), true);
    // The clock starts at the first frame after the call.
    r.render(frame(2000));
    const start = r.camera();
    assert.ok(Math.abs(start.yaw - 35 * Math.PI / 180) < 1e-9, "starts 35 degrees round");
    assert.ok(start.zoom < 1 && start.pitch > home.pitch, "starts farther and higher");

    // Midpoint, 750 ms in: ease-out cubic leaves (1 - 0.5)^3 = 12.5% of the move.
    r.render(frame(2750));
    const k = 0.125;
    const want = H.createCamera({
      w: 390, h: 844, mapW: game.mapW, mapH: game.mapH,
      yaw: 35 * Math.PI / 180 * k, zoom: 1 + (0.7 - 1) * k, pitch: home.pitch + 17 * Math.PI / 180 * k
    });
    assert.ok(r.flying());
    const hc = r.camera();
    for (const f of ["yaw", "zoom", "pitch", "focal", "ox", "oy"]) assert.ok(Math.abs(hc[f] - want[f]) < 1e-9, f + " " + hc[f] + " vs " + want[f]);
    let worst = 0;
    for (const n of game.nodes) {
      for (const z of [0, H.HEIGHT[n.type] || 30]) {
        const ref = H.project(want, n.x, n.y, z);
        const sc = r.screenOf(n.x, n.y, z);
        assert.ok(Math.hypot(ref.x - sc.x, ref.y - sc.y) < 1e-9, "screenOf follows the animated camera");
        // And the camera three.js was actually given at that frame.
        const got = GL.projectThree(drawn.camera, THREE, hc, n.x, n.y, z);
        const err = Math.hypot(ref.x - got.x, ref.y - got.y);
        if (err > worst) worst = err;
        assert.ok(err < 0.5, `mid-fly-in station ${n.id} z ${z}: ${err}`);
      }
      // pick at a station's drawn position lands on that station.
      const top = r.screenOf(n.x, n.y, (H.HEIGHT[n.type] || 30) * 0.5);
      const hit = r.pick(top.x, top.y, false);
      assert.ok(hit && hit.id === n.id, "pick at station " + n.id + " during the fly-in");
    }
    assert.ok(worst < 1e-3, "worst " + worst);
    // Home yaw/zoom stay what the game set; only the drawn view animates.
    assert.equal(r.getYaw(), 0); assert.equal(r.getZoom(), 1);

    // Done at 1500 ms: exactly the home camera again.
    r.render(frame(3500));
    assert.equal(r.flying(), false);
    const end = r.camera();
    for (const f of ["yaw", "zoom", "pitch", "focal", "ox", "oy"]) assert.equal(end[f], home[f], f);
  } finally { h.done(); }
});

test("fly-in ends the moment a pointer goes down, a wheel turns or the player orbits", () => {
  const h = makeHarness("low");
  try {
    const { r, frame, overlayListeners } = h;
    r.render(frame(1000));
    for (const how of ["pointerdown", "wheel", "orbit", "zoom"]) {
      r.flyIn(); r.render(frame(5000));
      assert.equal(r.flying(), true, how + ": started");
      if (how === "orbit") r.orbit(0.1); else if (how === "zoom") r.zoomBy(1.1); else overlayListeners[how]({});
      assert.equal(r.flying(), false, how + " cancels");
      r.render(frame(5100));
      assert.ok(Math.abs(r.camera().yaw - r.getYaw()) < 1e-12, how + ": camera is at the player's yaw");
      r.setYaw(0); r.setZoom(1);
    }
  } finally { h.done(); }
});

function instancedOf(scene) {
  let m = null;
  scene.traverse((o) => { if (o.isInstancedMesh) m = o; });
  return m;
}
// A fleet of `count` units half way down some lane.
function fleet(game, count, from, to, t) {
  game.fleets.push({ owner: 1, from, to, count, path: [from, to], leg: 0, t, duration: 10 });
}

test("swarms: ship count scales with fleet size, is capped per tier, and a war is budgeted", () => {
  const counts = {};
  for (const q of ["high", "low"]) {
    const h = makeHarness(q);
    try {
      const { game, r, frame, drawn } = h;
      const l = game.lanes[0];
      const ships = () => { r.render(frame(10)); return instancedOf(drawn.scene).count; };
      game.fleets.length = 0;
      fleet(game, 4, l.a, l.b, 0.6);
      const small = ships();
      game.fleets.length = 0;
      fleet(game, 40, l.a, l.b, 0.6);
      const mid = ships();
      game.fleets.length = 0;
      fleet(game, 150, l.a, l.b, 0.6);
      const big = ships();
      game.fleets.length = 0;
      for (let i = 0; i < 40; i++) fleet(game, 300, game.lanes[i % game.lanes.length].a, game.lanes[i % game.lanes.length].b, 0.5);
      const war = ships();
      counts[q] = { small, mid, big, war };
      assert.ok(small >= 1 && small < mid && mid <= big, q + ": scales " + JSON.stringify(counts[q]));
    } finally { h.done(); }
  }
  // Ships drawn are those already out of the dock, so the swarm may show
  // slightly fewer than planned; the caps are hard.
  assert.ok(counts.high.big >= 20 && counts.high.big <= 30, "high: one big fleet is a swarm of 20-30: " + counts.high.big);
  assert.ok(counts.low.big <= 6, "low: capped at 6 per fleet: " + counts.low.big);
  assert.ok(counts.high.war <= 1500, "high: war budget " + counts.high.war);
  assert.ok(counts.low.war <= 360, "low: war budget " + counts.low.war);
  assert.ok(counts.high.war > counts.low.war * 2, "high shows far more than low");
});

test("doomstar events are handled without draining the engine's queue, and others are ignored", () => {
  const h = makeHarness("low");
  try {
    const { game, r, frame } = h;
    const doom = game.nodes.find((n) => n.type === "doomstar");
    const tgt = game.nodes.find((n) => n.type === "command");
    const failures = [];
    r.onFailure((why) => failures.push(why));
    r.render(frame(1000));
    game.events.push({ kind: "launch", x: 1, y: 1, owner: 1, count: 3 });
    const evs = [
      { kind: "doomstar", x: tgt.x, y: tgt.y, owner: 1, nodeId: tgt.id, damage: 20, wiped: false },
      { kind: "capture", x: tgt.x, y: tgt.y, owner: 1, from: 2, nodeId: tgt.id, count: 3, big: true },
      null, { kind: "doomstar", x: doom.x, y: doom.y, owner: 2, nodeId: doom.id, damage: 20, wiped: false }
    ];
    const beams = () => { const out = []; h.drawn.scene.traverse((o) => { if (o.isMesh && o.material.uniforms && o.material.uniforms.uP0 && o.visible) out.push(o); }); return out; };
    let seen = 0, last = -1;
    for (let t = 1016; t < 3000; t += 16) {
      r.render(frame(t, { events: t === 1016 ? evs : undefined }));
      const n = beams().length;
      if (t === 1208) seen = n;
      last = n;
    }
    // Two doomstar events -> two strikes in flight at 192 ms (arc + column once landed); gone by 2 s.
    assert.deepEqual(failures, [], "no render failure");
    assert.ok(seen >= 2, "beams are drawn while a strike is in flight: " + seen);
    assert.equal(last, 0, "and are hidden again afterwards");
    assert.equal(game.events.length, 1, "the renderer must not drain game.events");
    // A frame without `events` (holo.js and flat never see one) is fine.
    r.render({ game, now: 4000, colorOf: h.frame(0).colorOf });
  } finally { h.done(); }
});

test("setQuality swaps the composer; bloom is only on at high", () => {
  const h = makeHarness("high");
  try {
    const { r, drawn, frame } = h;
    assert.equal(r.quality(), "high");
    r.render(frame(10));
    r.setQuality("low"); assert.equal(r.quality(), "low");
    r.render(frame(20));
    r.setQuality("high"); assert.equal(r.quality(), "high");
    r.render(frame(30));
    assert.ok(drawn.calls >= 3);
  } finally { h.done(); }
});
