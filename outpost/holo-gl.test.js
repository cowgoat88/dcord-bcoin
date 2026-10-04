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
