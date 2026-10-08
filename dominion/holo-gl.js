// OUTPOST — "Enhanced 3D" renderer (holo-gl): the holotable drawn with
// WebGL through three.js, with holo.js as its camera and its fallback.
//
// The board, the stations and the ships are three.js objects. Everything a
// player reads or touches is NOT: garrison numbers, fleet counts and the
// caller's overlays are crisp Canvas 2D text drawn on the game canvas, which
// sits over the WebGL canvas and keeps all pointer input. That split is the
// design: the GL scene can be as rich as the device allows, and the numbers
// stay legible, never occluded, and exactly where holo.js puts them.
//
// Camera alignment is the load-bearing part. holo.js owns the camera maths
// (position, tilt, per-yaw fit, zoom) and everything else -- pick(),
// screenOf(), the overlay anchors -- calls it. This file does not re-derive
// any of that: cameraFor() turns an OutpostHolo camera into a three.js one
// whose projection reproduces holo's pixel formula exactly, so a world point
// lands on the same pixel in both renderers (holo-gl.test.js checks 0.5 px).
//
// What makes it a space battle (GL3), all of it in the GL layer:
//  - bloom from emissive parts only (rims, engines, beacons, effects);
//  - stations that flare in the new owner's colour when they change hands;
//  - fleets as instanced swarms, count-scaled and capped per quality tier;
//  - a Doomstar beam + shockwave + flash, started by frame.events (the
//    caller's drained engine events for THIS frame; never drained here);
//  - a 1.5 s match-start fly-in, flyIn(), on the same camera maths as pick().
// Two quality tiers, setQuality("high" | "low"): high has the composer and
// the full swarm, low draws straight to the canvas with a small swarm.
//
// World mapping (engine -> three.js): x -> X, z (up) -> Y, y -> Z. With that
// choice a three.js camera at yaw 0 sits at +Z looking toward -Z with +X on
// its right, which is exactly the flat map seen from below, so the map's
// handedness never changes. Engine y therefore grows toward the viewer.
//
// The script is classic and UMD like holo.js. THREE is read from the global
// at create() time (not at load), so load order does not matter and Node
// tests can inject their own.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory(root);
  } else {
    root.OutpostHoloGL = factory(root);
  }
})(typeof self !== "undefined" ? self : this, function (root) {
  "use strict";

  const TAU = Math.PI * 2;
  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);

  const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const DEFAULT_COLORS = ["#64748b", "#22d3ee", "#fb7185"];
  // Pylon half-width as a fraction of the station radius, and the plate
  // thickness. Same values as holo.js (not exported there).
  const POLE = { command: 0.40, factory: 0.32, mine: 0.26, relay: 0.15, doomstar: 0.36 };
  const PLATE_THICK = 6;
  const NEAR_FRAC = 0.1;      // near plane as a fraction of the camera distance; holo clips at the same depth
  const MAX_FLEETS = 160;     // fleets that get trails/glow; ships are capped with them
  const MAX_LEVEL = 5;

  // Quality tiers. "high" runs the bloom composer and the full swarm;
  // "low" renders straight to the canvas with no post-process, a small swarm
  // and only the cheap effects. Ship caps come from a count budget rather
  // than a frame-time guess: ~40 vertices a ship, so 1500 ships is 60 k
  // vertices in ONE draw call, and the measured cost in this sandbox's
  // software GL was dominated by the composer (fill rate), not by ships.
  //   perFleet : most ships one fleet shows;  k : ships = k * sqrt(count)
  //   budget   : ships over all fleets (a war with ten big fleets is scaled
  //              down together, never silently dropping a whole fleet)
  const TIERS = {
    high: { perFleet: 30, k: 2.2, budget: 1500, trail: true, light: true, echo: true, column: true },
    low: { perFleet: 6, k: 1.1, budget: 360, trail: false, light: false, echo: false, column: false }
  };
  const MAX_SHIPS = TIERS.high.budget;

  // Bloom. UnrealBloomPass works on LINEAR scene colour before tone output,
  // so the threshold is a real brightness: only pixels above 1.0 glow. Lit
  // board, lanes, grid and pads are authored below 1.0 (the brightest lane
  // dash is 0.9), while station rims, engines, level rings, beacons and
  // effects are authored 1.4-3, which is what "emissive parts drive the
  // bloom" means here. Strength/radius were tuned by eye at 390 and 1280:
  // 0.62/0.55 gives a halo about 10 px wide round a rim at dpr 2 without
  // lifting the dark board anywhere (checked by sampling pixels).
  const BLOOM = { strength: 0.62, radius: 0.55, threshold: 1.0 };

  // Match-start fly-in: 1.5 s, ease-out cubic. Starts 35 degrees round, at
  // the farthest zoom and 17 degrees higher in pitch, and lands on the
  // game's home yaw/zoom/pitch. Cubic ease-out spends most of the move early
  // and settles gently, so by 0.75 s the board is already 87% home and a
  // player can start planning before it stops.
  const FLY_MS = 1500, FLY_YAW = 35 * Math.PI / 180, FLY_PITCH = 17 * Math.PI / 180, FLY_ZOOM = 0.62;

  // Doomstar strike timeline (ms after the engine event): the beam head
  // sweeps source -> target, holds, then its tail runs down the arc.
  const BEAM_HEAD = 320, BEAM_HOLD = 240, BEAM_TAIL = 760, BEAM_LIFE = BEAM_HEAD + BEAM_HOLD + BEAM_TAIL;
  const RIPPLES = 8, STRIKES = 2, CAPTURE_MS = 900;

  // ---- access to the sibling scripts ------------------------------------
  function getHolo() {
    if (root && root.OutpostHolo) return root.OutpostHolo;
    if (typeof globalThis !== "undefined" && globalThis.OutpostHolo) return globalThis.OutpostHolo;
    if (typeof module !== "undefined" && module.exports && typeof require === "function") {
      try { return require("./holo.js"); } catch (e) { /* fall through */ }
    }
    return null;
  }
  function getTHREE(inject) {
    if (inject) return inject;
    if (root && root.THREE) return root.THREE;
    if (typeof globalThis !== "undefined" && globalThis.THREE) return globalThis.THREE;
    return null;
  }
  const engine = () => (typeof globalThis !== "undefined" && globalThis.OutpostEngine) || (root && root.OutpostEngine) || null;

  // =====================================================================
  // supported()
  // =====================================================================
  // three.js has been WebGL2-only since r163, so that is what is probed.
  // The throwaway context is released at once: browsers cap live contexts
  // (iOS is stingy) and a leaked probe would starve the real one.
  let supportedCache = null;
  function supported() {
    if (supportedCache !== null) return supportedCache;
    let ok = false;
    try {
      if (typeof document !== "undefined" && document.createElement) {
        const c = document.createElement("canvas");
        const gl = c.getContext("webgl2");
        ok = !!gl;
        if (gl) {
          const ext = gl.getExtension && gl.getExtension("WEBGL_lose_context");
          if (ext && ext.loseContext) ext.loseContext();
        }
      }
    } catch (e) { ok = false; }
    supportedCache = ok;
    return ok;
  }

  // =====================================================================
  // Camera (pure; testable without WebGL)
  // =====================================================================
  // holo.js projects with
  //     X = right, Y = up, Z = depth   (camera space, see toView)
  //     sx = ox + focal * X / Z,   sy = oy - focal * Y / Z
  // A three.js camera placed and aimed identically gives the same X, Y, Z;
  // its projection matrix is then written by hand so that clip -> pixels is
  // the same affine map:  ndcX = (2 focal / w) X/Z + (2 ox / w - 1),
  //                       ndcY = (2 focal / h) Y/Z + (1 - 2 oy / h).
  // (three.js looks down -z, so the offset terms live in matrix elements
  // [8] and [9], which multiply z_eye and divide out as -z_eye = Z.)
  // The fit and offset that holo computes per yaw are all inside focal/ox/oy,
  // so reproducing them here is just reading them.
  function cameraFor(hc, T, cam) {
    T = getTHREE(T);
    cam = cam || new T.PerspectiveCamera();
    const near = hc.D * NEAR_FRAC, far = hc.D * 4;
    // Target is the board centre at z = 0 (engine (cx, cy) -> three (cx, 0, cy)).
    // "Near" in the engine is (-sin yaw, cos yaw); the camera sits that way
    // from the target and above it by the pitch.
    const px = hc.cx - hc.s * hc.cp * hc.D;
    const py = hc.sp * hc.D;
    const pz = hc.cy + hc.c * hc.cp * hc.D;
    cam.position.set(px, py, pz);
    cam.up.set(0, 1, 0);
    cam.lookAt(hc.cx, 0, hc.cy);
    cam.updateMatrixWorld(true);
    cam.near = near; cam.far = far;
    cam.aspect = hc.w / hc.h;
    const e = cam.projectionMatrix.elements;
    e[0] = 2 * hc.focal / hc.w; e[4] = 0; e[8] = 1 - 2 * hc.ox / hc.w; e[12] = 0;
    e[1] = 0; e[5] = 2 * hc.focal / hc.h; e[9] = 2 * hc.oy / hc.h - 1; e[13] = 0;
    e[2] = 0; e[6] = 0; e[10] = -(far + near) / (far - near); e[14] = -2 * far * near / (far - near);
    e[3] = 0; e[7] = 0; e[11] = -1; e[15] = 0;
    cam.projectionMatrixInverse.copy(cam.projectionMatrix).invert();
    return cam;
  }

  // Engine world point -> pixel through a three.js camera built by cameraFor.
  // Only used by tests and tooling; the renderer asks holo.
  function projectThree(cam, T, hc, x, y, z, out) {
    T = getTHREE(T);
    const v = new T.Vector3(x, z || 0, y).project(cam);
    out = out || {};
    out.x = (v.x + 1) / 2 * hc.w;
    out.y = (1 - v.y) / 2 * hc.h;
    return out;
  }

  // =====================================================================
  // Small geometry helpers
  // =====================================================================
  function unitShape(kind) {
    const pts = [];
    if (kind === "circle") {
      for (let i = 0; i < 24; i++) pts.push([Math.cos(i * TAU / 24), Math.sin(i * TAU / 24)]);
    } else if (kind === "square") {
      const s = 0.88; pts.push([-s, -s], [s, -s], [s, s], [-s, s]);
    } else if (kind === "star") {
      for (let i = 0; i < 10; i++) {
        const a = -Math.PI / 2 + i * Math.PI / 5, rr = i % 2 ? 0.48 : 1;
        pts.push([Math.cos(a) * rr, Math.sin(a) * rr]);
      }
    } else if (kind === "diamond") {
      pts.push([0, -1], [1, 0], [0, 1], [-1, 0]);
    } else {
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + i * Math.PI / 3;
        pts.push([Math.cos(a), Math.sin(a)]);
      }
    }
    return pts;
  }

  // Flat ribbon geometry on the board plane (y = const). `segs` is a flat
  // list [ax, az, bx, bz, u0, u1, ...]; one quad per segment, `width` wide.
  // uv.x runs along the segment in WORLD units so a dash texture with
  // repeat = 1/period gives dashes of a fixed physical length everywhere.
  function ribbonGeometry(T, segs, width, y) {
    const n = segs.length / 6;
    const pos = new Float32Array(n * 12), uv = new Float32Array(n * 8), idx = new Uint32Array(n * 6);
    const hw = width / 2;
    for (let i = 0; i < n; i++) {
      const o = i * 6;
      const ax = segs[o], az = segs[o + 1], bx = segs[o + 2], bz = segs[o + 3];
      const dx = bx - ax, dz = bz - az, len = Math.hypot(dx, dz) || 1;
      const nx = -dz / len * hw, nz = dx / len * hw;
      const p = i * 12, q = i * 8, v = i * 4;
      pos[p] = ax + nx; pos[p + 1] = y; pos[p + 2] = az + nz;
      pos[p + 3] = ax - nx; pos[p + 4] = y; pos[p + 5] = az - nz;
      pos[p + 6] = bx + nx; pos[p + 7] = y; pos[p + 8] = bz + nz;
      pos[p + 9] = bx - nx; pos[p + 10] = y; pos[p + 11] = bz - nz;
      uv[q] = segs[o + 4]; uv[q + 1] = 0; uv[q + 2] = segs[o + 4]; uv[q + 3] = 1;
      uv[q + 4] = segs[o + 5]; uv[q + 5] = 0; uv[q + 6] = segs[o + 5]; uv[q + 7] = 1;
      // Both windings: the ribbon is seen from above, but a mirrored
      // camera must not make it vanish.
      idx[i * 6] = v; idx[i * 6 + 1] = v + 2; idx[i * 6 + 2] = v + 1;
      idx[i * 6 + 3] = v + 1; idx[i * 6 + 4] = v + 2; idx[i * 6 + 5] = v + 3;
    }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(pos, 3));
    g.setAttribute("uv", new T.BufferAttribute(uv, 2));
    g.setIndex(new T.BufferAttribute(idx, 1));
    return g;
  }
  function loopSegs(pts, closed) {
    const s = [];
    let u = 0;
    const n = pts.length;
    for (let i = 0; i < (closed ? n : n - 1); i++) {
      const a = pts[i], b = pts[(i + 1) % n];
      const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
      s.push(a[0], a[1], b[0], b[1], u, u + len);
      u += len;
    }
    return s;
  }
  // A ring (or an arc, via drawRange) lying flat at the origin, in the XZ
  // plane. Index order is angular, so drawing the first k of N segments
  // draws the first k/N of the turn: a fill gauge with no per-frame
  // geometry. Angle 0 is -pi/2 (the top of the flat map), growing the way
  // holo.js's capacity arcs grow.
  const ARC_N = 72;
  function arcGeometry(T, r, width, y) {
    const N = ARC_N;
    const pos = new Float32Array((N + 1) * 6), uv = new Float32Array((N + 1) * 4), idx = new Uint32Array(N * 6);
    const ri = r - width / 2, ro = r + width / 2;
    for (let i = 0; i <= N; i++) {
      const a = -Math.PI / 2 + TAU * i / N, c = Math.cos(a), s = Math.sin(a);
      pos[i * 6] = c * ri; pos[i * 6 + 1] = y; pos[i * 6 + 2] = s * ri;
      pos[i * 6 + 3] = c * ro; pos[i * 6 + 4] = y; pos[i * 6 + 5] = s * ro;
      uv[i * 4] = r * TAU * i / N; uv[i * 4 + 1] = 0; uv[i * 4 + 2] = r * TAU * i / N; uv[i * 4 + 3] = 1;
    }
    for (let i = 0; i < N; i++) {
      const v = i * 2;
      idx[i * 6] = v; idx[i * 6 + 1] = v + 2; idx[i * 6 + 2] = v + 1;
      idx[i * 6 + 3] = v + 1; idx[i * 6 + 4] = v + 2; idx[i * 6 + 5] = v + 3;
    }
    const g = new T.BufferGeometry();
    g.setAttribute("position", new T.BufferAttribute(pos, 3));
    g.setAttribute("uv", new T.BufferAttribute(uv, 2));
    g.setIndex(new T.BufferAttribute(idx, 1));
    return g;
  }

  // =====================================================================
  // Renderer
  // =====================================================================
  function create(glCanvas, opts) {
    opts = opts || {};
    const T = getTHREE(opts.THREE);
    const H = getHolo();
    if (!T) throw new Error("holo-gl: THREE is not loaded");
    if (!H) throw new Error("holo-gl: OutpostHolo is not loaded");
    const overlay = opts.overlayCanvas;
    if (!overlay) throw new Error("holo-gl: overlayCanvas is required");
    const octx = overlay.getContext("2d");
    const RADIUS = H.RADIUS, HEIGHT = H.HEIGHT, SHAPE = H.SHAPE;
    const radiusOf = (n) => RADIUS[n.type] || 22;
    const heightOf = (n) => HEIGHT[n.type] || 30;
    const ZMIN = H.ZOOM_MIN, ZMAX = H.ZOOM_MAX;

    let cssW = 0, cssH = 0, dpr = 1;
    let yaw = opts.yaw || 0, zoom = clamp(opts.zoom || 1, ZMIN, ZMAX);
    let hcam = null, camKey = "";
    let lastGame = null;
    let quality = opts.quality === "low" ? "low" : "high";
    let lost = false, failed = false, disposed = false, lostTimer = 0;
    const failCbs = [];
    let now = 0;
    let fly = null;                  // the match-start camera move, null when not flying

    // ---- three.js core ---------------------------------------------------
    const renderer = new T.WebGLRenderer({
      canvas: glCanvas,
      antialias: opts.antialias !== undefined ? !!opts.antialias
        : !(typeof devicePixelRatio === "number" && devicePixelRatio >= 2),
      alpha: false, stencil: false, powerPreference: "default"
    });
    renderer.setClearColor(0x05080f, 1);
    const scene = new T.Scene();
    const camera3 = new T.PerspectiveCamera();
    scene.fog = new T.Fog(0x070d1a, 1, 2);
    const maxPoint = (() => {
      try {
        const r = renderer.getContext().getParameter(renderer.getContext().ALIASED_POINT_SIZE_RANGE);
        return r && r[1] ? r[1] : 64;
      } catch (e) { return 64; }
    })();

    // Lights. The key light comes from a fixed WORLD direction, so shading
    // swings with the board when it orbits (the same cue holo.js gets from
    // its shadows). Colours are cool ambient, warm key.
    const ambient = new T.AmbientLight(0x7f95c4, 0.75);
    const hemi = new T.HemisphereLight(0xaac4ff, 0x10182a, 0.55);
    const key = new T.DirectionalLight(0xfff1dc, 3.0);
    scene.add(ambient, hemi, key, key.target);
    // The Doomstar's flash. It is ALWAYS in the scene (intensity 0 when idle)
    // because three.js compiles every lit material for a fixed light count:
    // adding a light at the first strike would recompile every station
    // shader mid-battle, a hitch on exactly the frame that should be the
    // best one.
    const flashLight = new T.PointLight(0xffb070, 0, 420, 2);
    scene.add(flashLight);

    // Everything owned by the current game lives under `gameRoot` and is
    // freed in one go when the game changes; things shared by games
    // (background, stars, fleet pools, geometry caches) live on `scene`.
    let gameRoot = null, built = null;
    const gameOwned = [];            // geometries/materials/textures to dispose with the game
    const own = (o) => { gameOwned.push(o); return o; };
    const shared = [];               // disposed with the renderer
    const keep = (o) => { shared.push(o); return o; };

    // Shared dash textures: 1-D alpha ramps for flow/front/cut-off ribbons.
    const dashTex = {};
    function dash(name, period, on) {
      if (dashTex[name]) return dashTex[name];
      const c = document.createElement("canvas");
      c.width = 64; c.height = 4;
      const g = c.getContext("2d");
      g.fillStyle = "#000"; g.fillRect(0, 0, 64, 4);
      g.fillStyle = "#fff"; g.fillRect(0, 0, Math.round(64 * on / period), 4);
      const t = keep(new T.CanvasTexture(c));
      t.wrapS = T.RepeatWrapping; t.wrapT = T.ClampToEdgeWrapping;
      t.repeat.set(1 / period, 1);
      t.minFilter = T.LinearFilter; t.generateMipmaps = false;
      dashTex[name] = t;
      return t;
    }

    // ---- background: baked gradient + nebula, plus a star dome ----------
    let bgTex = null;
    function buildBackground() {
      if (bgTex) { bgTex.dispose(); bgTex = null; }
      const w = Math.max(64, Math.ceil(cssW / 2)), h = Math.max(64, Math.ceil(cssH / 2));
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      const g = c.getContext("2d");
      const base = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      base.addColorStop(0, "#0e1830"); base.addColorStop(1, "#05080f");
      g.fillStyle = base; g.fillRect(0, 0, w, h);
      const rng = H.makeRng ? H.makeRng(23) : mulberry(23);
      const tints = ["rgba(56,100,190,", "rgba(120,70,190,", "rgba(30,150,170,", "rgba(190,80,120,"];
      for (let i = 0; i < 5; i++) {
        const x = rng() * w, y = rng() * h, r = (0.18 + rng() * 0.25) * Math.max(w, h);
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        const t = tints[i % tints.length];
        grd.addColorStop(0, t + "0.13)"); grd.addColorStop(1, t + "0)");
        g.fillStyle = grd; g.fillRect(0, 0, w, h);
      }
      bgTex = new T.CanvasTexture(c);
      bgTex.colorSpace = T.SRGBColorSpace;
      scene.background = bgTex;
    }
    function mulberry(seed) {
      let a = (seed >>> 0) || 1;
      return function () {
        a |= 0; a = (a + 0x6D2B79F5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }

    const stars = (() => {
      const N = 320, rng = mulberry(7);
      const pos = new Float32Array(N * 3), col = new Float32Array(N * 3);
      for (let i = 0; i < N; i++) {
        // Uniform on the sphere; a unit dome, scaled to the camera distance later.
        const u = rng() * 2 - 1, a = rng() * TAU, s = Math.sqrt(1 - u * u);
        pos[i * 3] = s * Math.cos(a); pos[i * 3 + 1] = u; pos[i * 3 + 2] = s * Math.sin(a);
        const b = 0.35 + rng() * 0.65;
        col[i * 3] = 0.72 * b; col[i * 3 + 1] = 0.8 * b; col[i * 3 + 2] = 0.9 * b;
      }
      const g = keep(new T.BufferGeometry());
      g.setAttribute("position", new T.BufferAttribute(pos, 3));
      g.setAttribute("color", new T.BufferAttribute(col, 3));
      const m = keep(new T.PointsMaterial({ size: 1.7, sizeAttenuation: false, vertexColors: true,
        transparent: true, opacity: 0.85, depthWrite: false, fog: false }));
      const p = new T.Points(g, m);
      p.frustumCulled = false; p.renderOrder = -10;
      scene.add(p);
      return p;
    })();

    // ---- glow sprites: one Points object, per-vertex colour and size ---
    // Replaces holo.js's cached radial-gradient blits, and is the one thing
    // that makes stations and fleets glow with the post-process OFF (low
    // quality). Size is a WORLD radius, converted to pixels with the same
    // focal length the camera uses.
    const MAX_GLOW = 96 + MAX_FLEETS;
    const glow = (() => {
      const pos = new Float32Array(MAX_GLOW * 3), col = new Float32Array(MAX_GLOW * 4), size = new Float32Array(MAX_GLOW);
      const g = keep(new T.BufferGeometry());
      g.setAttribute("position", new T.BufferAttribute(pos, 3).setUsage(T.DynamicDrawUsage));
      g.setAttribute("aColor", new T.BufferAttribute(col, 4).setUsage(T.DynamicDrawUsage));
      g.setAttribute("aSize", new T.BufferAttribute(size, 1).setUsage(T.DynamicDrawUsage));
      g.setDrawRange(0, 0);
      const m = keep(new T.ShaderMaterial({
        transparent: true, depthWrite: false, depthTest: true, blending: T.AdditiveBlending, fog: false,
        uniforms: { uScale: { value: 1 }, uMax: { value: maxPoint } },
        vertexShader:
          "attribute vec4 aColor; attribute float aSize; uniform float uScale; uniform float uMax; varying vec4 vColor;\n" +
          "void main(){ vec4 mv = modelViewMatrix * vec4(position, 1.0); vColor = aColor;\n" +
          "  gl_PointSize = clamp(aSize * 2.0 * uScale / max(-mv.z, 1.0), 1.0, uMax);\n" +
          "  gl_Position = projectionMatrix * mv; }",
        fragmentShader:
          "varying vec4 vColor;\n" +
          "void main(){ vec2 d = gl_PointCoord * 2.0 - 1.0; float r = dot(d, d); if (r > 1.0) discard;\n" +
          "  float a = 1.0 - r; a *= a; gl_FragColor = vec4(vColor.rgb, vColor.a * a);\n" +
          "  #include <colorspace_fragment>\n}"
      }));
      const p = new T.Points(g, m);
      p.frustumCulled = false; p.renderOrder = 50;
      scene.add(p);
      return { points: p, pos, col, size, mat: m, geo: g, n: 0 };
    })();
    function glowAdd(x, y, z, color, a, radius) {
      if (glow.n >= MAX_GLOW) return;
      const i = glow.n++;
      glow.pos[i * 3] = x; glow.pos[i * 3 + 1] = y; glow.pos[i * 3 + 2] = z;
      glow.col[i * 4] = color.r; glow.col[i * 4 + 1] = color.g; glow.col[i * 4 + 2] = color.b; glow.col[i * 4 + 3] = a;
      glow.size[i] = radius;
    }

    // ---- fleets: instanced swarm ships + one dynamic line buffer for trails ---
    const fleetLayer = (() => {
      // A dart: tip, two swept wings, a notch, a ridge above and a keel
      // below, plus a small flame pyramid behind the notch. `aEng` is 0 on
      // the hull and 1 on the flame; the shader below lights the flame far
      // above 1.0, so the engines are what the bloom picks out of a swarm.
      const T0 = [1, 0, 0], L = [-0.7, 0, 0.62], R = [-0.7, 0, -0.62], N = [-0.3, 0, 0], U = [-0.15, 0.3, 0], D = [-0.15, -0.12, 0];
      const tris = [[T0, L, U], [T0, U, R], [L, N, U], [R, U, N], [T0, L, D], [T0, D, R], [L, N, D], [R, D, N]];
      const FB = [[-0.28, 0.1, 0.13], [-0.28, 0.1, -0.13], [-0.28, -0.1, -0.13], [-0.28, -0.1, 0.13]], FT = [-1.25, 0, 0];
      const p = [], eng = [];
      for (const t of tris) for (const v of t) { p.push(v[0], v[1], v[2]); eng.push(0); }
      for (let i = 0; i < 4; i++) {
        for (const v of [FB[i], FB[(i + 1) % 4], FT]) { p.push(v[0], v[1], v[2]); eng.push(1); }
      }
      const g = keep(new T.BufferGeometry());
      g.setAttribute("position", new T.BufferAttribute(new Float32Array(p), 3));
      g.setAttribute("aEng", new T.BufferAttribute(new Float32Array(eng), 1));
      g.computeVertexNormals();
      const m = keep(new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.3, flatShading: true,
        side: T.DoubleSide, fog: false }));
      const shipHigh = { value: quality === "high" ? 1 : 0 };
      // Instance colour also drives the emissive term, so a ship glows in
      // its owner's colour rather than only being lit by it: 0.35 on the hull
      // (lit hull stays under the bloom threshold, so a swarm keeps its
      // shape), 2.95 on the flame (over it, so the engines glow).
      m.onBeforeCompile = (sh) => {
        sh.vertexShader = sh.vertexShader
          .replace("#include <common>", "#include <common>\nattribute float aEng; varying float vEng;")
          .replace("#include <begin_vertex>", "#include <begin_vertex>\nvEng = aEng;");
        sh.fragmentShader = sh.fragmentShader
          .replace("#include <common>", "#include <common>\nvarying float vEng; uniform float uHigh;")
          .replace("#include <emissivemap_fragment>",
            "#include <emissivemap_fragment>\n#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )\n" +
            // The flame is set to the same LINEAR luminance (1.7) for both sides, or rose
            // (luminance 0.34) would glow a third as much as cyan (0.53) at equal gain;
            // with no bloom (low) it is just the owner's full-saturation colour instead.
            "  float l = dot(vColor.rgb, vec3(0.2126, 0.7152, 0.0722));\n" +
            "  vec3 fl = uHigh > 0.5 ? vColor.rgb / max(l, 0.12) * 1.7 : vColor.rgb / max(max(vColor.r, vColor.g), max(vColor.b, 0.001)) * 0.9;\n" +
            "  totalEmissiveRadiance = vColor.rgb * 0.35 + fl * vEng;\n#endif");
        sh.uniforms.uHigh = shipHigh;
      };
      const mesh = new T.InstancedMesh(g, m, MAX_SHIPS);
      mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
      mesh.setColorAt(0, new T.Color(1, 1, 1));
      mesh.instanceColor.setUsage(T.DynamicDrawUsage);
      mesh.count = 0; mesh.frustumCulled = false; mesh.renderOrder = 20;
      scene.add(mesh);

      const SEG = 6;
      const lp = new Float32Array(MAX_FLEETS * (SEG + 1) * 2 * 3), lc = new Float32Array(MAX_FLEETS * (SEG + 1) * 2 * 4);
      const lg = keep(new T.BufferGeometry());
      lg.setAttribute("position", new T.BufferAttribute(lp, 3).setUsage(T.DynamicDrawUsage));
      lg.setAttribute("color", new T.BufferAttribute(lc, 4).setUsage(T.DynamicDrawUsage));
      lg.setDrawRange(0, 0);
      const lm = keep(new T.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false }));
      const lines = new T.LineSegments(lg, lm);
      lines.frustumCulled = false; lines.renderOrder = 19;
      scene.add(lines);
      return { mesh, lines, lp, lc, lg, SEG, shipHigh };
    })();

    // ---- strike effects: beam tubes and expanding ripples ---------------
    // Both are ShaderMaterials on SHARED unit geometry; everything that
    // varies (the arc, the radius, the front) is a uniform, so a strike
    // allocates nothing and the beam is never rebuilt on the CPU.
    //
    // Beam: a tube (BEAM_S rings of BEAM_R vertices) whose `position` is
    // (u along, cos, sin). The vertex shader bends it onto a quadratic Bezier
    // P0 -> P1 -> P2, in the arc's own vertical plane: `side` is that
    // plane's normal and cross(tangent, side) the other cross-section axis,
    // so the frame can never degenerate (a Doomstar straight below the
    // target gives a vertical tube; a frame built from "up" would flip).
    const BEAM_S = 40, BEAM_R = 8;
    const beamGeo = (() => {
      const pos = new Float32Array((BEAM_S + 1) * (BEAM_R + 1) * 3), idx = [];
      for (let i = 0; i <= BEAM_S; i++) for (let j = 0; j <= BEAM_R; j++) {
        const o = (i * (BEAM_R + 1) + j) * 3, a = j / BEAM_R * TAU;
        pos[o] = i / BEAM_S; pos[o + 1] = Math.cos(a); pos[o + 2] = Math.sin(a);
      }
      for (let i = 0; i < BEAM_S; i++) for (let j = 0; j < BEAM_R; j++) {
        const a = i * (BEAM_R + 1) + j, b = a + BEAM_R + 1;
        idx.push(a, b, a + 1, a + 1, b, b + 1);
      }
      const g = keep(new T.BufferGeometry());
      g.setAttribute("position", new T.BufferAttribute(pos, 3));
      g.setIndex(new T.BufferAttribute(new Uint16Array(idx), 1));
      return g;
    })();
    function beamMaterial() {
      return keep(new T.ShaderMaterial({
        transparent: true, depthWrite: false, depthTest: true, blending: T.AdditiveBlending, fog: false, side: T.DoubleSide,
        uniforms: {
          uP0: { value: new T.Vector3() }, uP1: { value: new T.Vector3() }, uP2: { value: new T.Vector3() },
          uSide: { value: new T.Vector3(0, 0, 1) }, uColor: { value: new T.Color(1, 0.5, 0.3) },
          uRad: { value: 8 }, uHead: { value: 0 }, uTail: { value: 0 }, uFade: { value: 0 }, uTime: { value: 0 }, uShape: { value: 0 }, uGain: { value: 1 }
        },
        vertexShader:
          "uniform vec3 uP0, uP1, uP2, uSide; uniform float uRad, uShape; varying float vU; varying vec3 vN; varying vec3 vV;\n" +
          "void main(){ float u = position.x; float s = 1.0 - u;\n" +
          "  vec3 c = s*s*uP0 + 2.0*s*u*uP1 + u*u*uP2;\n" +
          "  vec3 t = normalize(2.0*s*(uP1-uP0) + 2.0*u*(uP2-uP1));\n" +
          "  vec3 nrm = normalize(cross(t, uSide));\n" +
          "  vec3 dir = uSide*position.y + nrm*position.z;\n" +
          // arc: thin at both ends, fat in the middle; column: fat at the foot, thin at the top
          "  float w = mix(0.3 + 0.7*sin(3.14159*u), 1.0 - 0.72*u, uShape);\n" +
          "  vec4 mv = modelViewMatrix * vec4(c + dir*uRad*w, 1.0);\n" +
          "  vU = u; vN = normalize(normalMatrix * dir); vV = -mv.xyz; gl_Position = projectionMatrix * mv; }",
        fragmentShader:
          "uniform vec3 uColor; uniform float uHead, uTail, uFade, uTime, uGain; varying float vU; varying vec3 vN; varying vec3 vV;\n" +
          "void main(){\n" +
          // core: facing the camera = the axis of the tube = hot
          "  float f = abs(dot(normalize(vN), normalize(vV)));\n" +
          "  float core = pow(f, 1.6);\n" +
          "  float alive = smoothstep(uTail - 0.02, uTail + 0.03, vU) * (1.0 - smoothstep(uHead - 0.04, uHead, vU));\n" +
          "  float lead = smoothstep(uHead - 0.12, uHead, vU);\n" +
          "  float ripple = 0.8 + 0.2 * sin(vU * 70.0 - uTime * 0.045);\n" +
          // HDR budget: ~1.1 at the edge up to ~2.4 on the axis and the head. Much
          // more and the bloom (which blurs whatever is over 1.0) spreads the beam
          // over a third of a phone screen: 7x was tried first and read as a flare.
          "  vec3 col = mix(uColor, vec3(1.0, 0.9, 0.7), core * core) * (0.9 + 1.1 * core + 0.6 * lead) * ripple * uGain;\n" +
          "  float a = (0.12 + 0.88 * core) * alive * uFade;\n" +
          "  gl_FragColor = vec4(col * a, a);\n" +
          "  #include <colorspace_fragment>\n}"
      }));
    }
    const strikes = [];
    for (let k = 0; k < STRIKES; k++) {
      const mk = (shape) => {
        const mat = beamMaterial(); mat.uniforms.uShape.value = shape;
        const mesh = new T.Mesh(beamGeo, mat);
        mesh.frustumCulled = false; mesh.renderOrder = 30; mesh.visible = false;
        scene.add(mesh);
        return { mesh, mat };
      };
      strikes.push({ arc: mk(0), col: mk(1), t0: -1e9, active: false, impacted: false, tx: 0, ty: 0, tz: 0, sx: 0, sy: 0, sz: 0, tid: -1, color: new T.Color() });
    }
    let nextStrike = 0;

    // Ripple: a flat disc on the board with a ring painted by the fragment
    // shader at radius uR (0..1 of the disc). Used for capture pulses and
    // the strike's shockwave and its echo.
    const rippleGeo = keep(new T.CircleGeometry(1, 48).rotateX(-Math.PI / 2));
    const ripples = [];
    for (let k = 0; k < RIPPLES; k++) {
      const mat = keep(new T.ShaderMaterial({
        transparent: true, depthWrite: false, depthTest: true, blending: T.AdditiveBlending, fog: false,
        uniforms: { uR: { value: 0 }, uFade: { value: 0 }, uColor: { value: new T.Color() } },
        vertexShader: "varying vec2 vP; void main(){ vP = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }",
        fragmentShader:
          "uniform float uR, uFade; uniform vec3 uColor; varying vec2 vP;\n" +
          "void main(){ float d = length(vP);\n" +
          "  float ring = exp(-pow((d - uR) / 0.055, 2.0));\n" +
          "  float wash = smoothstep(uR, 0.0, d) * 0.05;\n" +
          "  float a = (ring + wash) * uFade * step(d, 1.0);\n" +
          "  gl_FragColor = vec4(uColor * a, a);\n" +
          "  #include <colorspace_fragment>\n}"
      }));
      const mesh = new T.Mesh(rippleGeo, mat);
      mesh.frustumCulled = false; mesh.renderOrder = 16; mesh.visible = false; mesh.position.y = 1.9;
      scene.add(mesh);
      ripples.push({ mesh, mat, t0: 0, dur: 1, rmax: 1, power: 1, active: false });
    }
    let nextRipple = 0;
    function ripple(x, z, rmax, dur, color, power, delay, lum) {
      const r = ripples[nextRipple++ % RIPPLES];
      r.active = true; r.t0 = now + (delay || 0); r.dur = dur; r.rmax = rmax; r.power = power;
      r.mesh.position.x = x; r.mesh.position.z = z;
      r.mesh.scale.set(rmax, 1, rmax);
      r.mat.uniforms.uColor.value.copy(color).multiplyScalar(lum || 1);
      r.mesh.visible = false;
    }

    // ---- camera plumbing (same contract as holo.js) --------------------
    // The view actually drawn: the game's yaw/zoom, plus whatever is left of
    // the fly-in. pick(), screenOf() and the overlays all go through
    // ensureCamera, so they follow the animated camera frame for frame; the
    // fly-in's progress is only advanced in render() (from frame.now), never
    // from the wall clock, so a tap between frames hits what was last drawn.
    function ensureCamera(g) {
      const mapW = g ? g.mapW : 1000, mapH = g ? g.mapH : 640;
      let ey = yaw, ez = zoom, ep;
      if (fly) {
        const k = fly.k;
        ey = yaw + FLY_YAW * k;
        ez = zoom + (clamp(zoom * FLY_ZOOM, ZMIN, ZMAX) - zoom) * k;
        ep = H.defaultPitch(cssW || 300, cssH || 150) + FLY_PITCH * k;
      }
      const ck = [cssW, cssH, mapW, mapH, ey, ez, ep].join("|");
      if (ck !== camKey || !hcam) {
        hcam = H.createCamera({ w: cssW || 300, h: cssH || 150, mapW, mapH, yaw: ey, zoom: ez, pitch: ep });
        camKey = ck;
        cameraFor(hcam, T, camera3);
        applyCameraDerived();
      }
      return hcam;
    }
    function stepFly() {
      if (!fly) return;
      if (fly.t0 < 0) fly.t0 = now;
      const p = (now - fly.t0) / FLY_MS;
      if (p >= 1) { fly = null; return; }
      const q = 1 - Math.max(0, p);
      fly.k = q * q * q;
    }
    function cancelFly() { fly = null; }
    function applyCameraDerived() {
      const R = Math.hypot(hcam.mapW, hcam.mapH) / 2;
      scene.fog.near = hcam.D - R * hcam.cp;
      scene.fog.far = hcam.D + R * hcam.cp * 3;
      glow.mat.uniforms.uScale.value = hcam.focal * dpr;
      stars.position.set(hcam.cx, 0, hcam.cy);
      stars.scale.setScalar(hcam.D * 2.2);
      // Fixed world direction: up and to the "west" of the board, a little toward the viewer's default side.
      key.position.set(hcam.cx - 420, 760, hcam.cy + 260);
      key.target.position.set(hcam.cx, 0, hcam.cy);
      key.target.updateMatrixWorld();
    }

    // ---- post-processing ------------------------------------------------
    let composer = null, bloomPass = null;
    function disposeComposer() {
      if (composer) {
        try { composer.renderTarget1.dispose(); composer.renderTarget2.dispose(); } catch (e) { /* ignore */ }
        for (const p of composer.passes) { if (p.dispose) try { p.dispose(); } catch (e) { /* ignore */ } }
      }
      composer = null; bloomPass = null;
    }
    function buildComposer() {
      disposeComposer();
      if (quality !== "high" || !cssW) return;
      const w = Math.floor(cssW * dpr), h = Math.floor(cssH * dpr);
      const rt = new T.WebGLRenderTarget(w, h, { type: T.HalfFloatType, samples: dpr >= 2 ? 0 : 4 });
      composer = new T.EffectComposer(renderer, rt);
      composer.setPixelRatio(dpr);
      composer.setSize(cssW, cssH);
      composer.addPass(new T.RenderPass(scene, camera3));
      bloomPass = new T.UnrealBloomPass(new T.Vector2(cssW, cssH), BLOOM.strength, BLOOM.radius, BLOOM.threshold);
      composer.addPass(bloomPass);
      composer.addPass(new T.OutputPass());
    }

    function resize(w, h, ratio) {
      cssW = Math.max(1, w); cssH = Math.max(1, h);
      dpr = Math.min(ratio || 1, 2);
      renderer.setPixelRatio(dpr);
      renderer.setSize(cssW, cssH, false);
      overlay.width = Math.floor(cssW * dpr);
      overlay.height = Math.floor(cssH * dpr);
      camKey = "";
      buildBackground();
      buildComposer();
      ensureCamera(lastGame);
    }

    // =================================================================
    // Per-game scene
    // =================================================================
    const tmpC = new T.Color(), tmpC2 = new T.Color();
    const _v1 = new T.Vector3(), _v2 = new T.Vector3(), _v3 = new T.Vector3(), _zAxis = new T.Vector3(0, 0, 1), _white = new T.Color(1, 1, 1);
    const colorCache = new Map();
    function colorFor(str) {
      let c = colorCache.get(str);
      if (!c) { c = new T.Color(str); if (colorCache.size > 32) colorCache.clear(); colorCache.set(str, c); }
      return c;
    }

    // Station geometry is per TYPE (radius and height are constants of the
    // type), built once per renderer and shared by every station of it.
    const typeGeo = {};
    function geosFor(type) {
      if (typeGeo[type]) return typeGeo[type];
      const kind = SHAPE[type] || "circle";
      const r = RADIUS[type] || 22, h = HEIGHT[type] || 30;
      const plateR = r * 0.92, zPlate = h - PLATE_THICK;
      const pw = r * (POLE[type] || 0.3);
      const out = { kind, r, h, plateR, zPlate, pw };
      const segs = kind === "hex" ? 6 : kind === "square" ? 4 : 10;
      const pyl = new T.CylinderGeometry(pw * 0.6, pw, zPlate, segs, 1);
      if (kind === "square") pyl.rotateY(Math.PI / 4);
      pyl.translate(0, zPlate / 2, 0);
      out.pylon = keep(pyl);
      let plate;
      if (kind === "hex") plate = new T.CylinderGeometry(plateR, plateR, PLATE_THICK, 6);
      else if (kind === "square") plate = new T.BoxGeometry(plateR * 1.76, PLATE_THICK, plateR * 1.76);
      else if (kind === "diamond") {
        // A gem on a stem: the plan silhouette is the diamond holo.js draws.
        plate = new T.OctahedronGeometry(plateR * 1.05, 0);
        plate.scale(1, 0.55, 1);
      } else if (kind === "star") {
        // The Doomstar is a battle station, not a plate: a metal sphere on
        // the pylon, with its trench and dish added per station.
        out.orbR = plateR * 1.05;
        plate = new T.SphereGeometry(out.orbR, 32, 20);
      } else plate = new T.CylinderGeometry(plateR, plateR, PLATE_THICK, 28);
      out.plate = keep(plate);
      out.edges = keep(new T.EdgesGeometry(plate, 25));
      // Where the plate sits: its centre height. (Diamond hangs from the top.)
      out.plateY = kind === "diamond" ? h - plateR * 1.05 * 0.55
        : kind === "star" ? h + plateR * 0.35
        : zPlate + PLATE_THICK / 2;
      // Footprint of the plate on the ground, for the cast shadow.
      const fp = new T.Shape(), up = unitShape(kind === "star" ? "circle" : kind);
      for (let i = 0; i < up.length; i++) {
        const x = up[i][0] * plateR, y = -up[i][1] * plateR;
        i ? fp.lineTo(x, y) : fp.moveTo(x, y);
      }
      fp.closePath();
      const fg = new T.ShapeGeometry(fp);
      fg.rotateX(-Math.PI / 2);
      out.foot = keep(fg);
      typeGeo[type] = out;
      return out;
    }
    let sharedGeo = null;
    function shGeo() {
      if (sharedGeo) return sharedGeo;
      const g = {};
      g.disc = (rr) => new T.CircleGeometry(rr, 36).rotateX(-Math.PI / 2);
            g.core = keep(new T.SphereGeometry(1, 14, 10));
      g.rock = keep(new T.DodecahedronGeometry(1, 0));
      g.chimney = keep(new T.BoxGeometry(5, 11, 5));
      g.tier = keep(new T.CylinderGeometry(1, 1, 8, 6));
      g.tierEdges = keep(new T.EdgesGeometry(g.tier, 25));
      g.relayTorus = keep(new T.TorusGeometry(1, 0.11, 6, 32));
      g.mast = keep(new T.CylinderGeometry(0.9, 1.5, 22, 6).translate(0, 11, 0));
      g.cap = keep(new T.BoxGeometry(7.4, 2.6, 7.4));
      g.dot = keep(new T.SphereGeometry(1, 10, 8));
      sharedGeo = g;
      return g;
    }

    function buildGame(game) {
      disposeGame();
      gameRoot = new T.Group();
      scene.add(gameRoot);
      const W = game.mapW, Hh = game.mapH;
      const SG = shGeo();
      const rec = { game, nodes: [], lanes: null, doom: null, W, H: Hh };
      const add = (o, order) => { if (order !== undefined) o.renderOrder = order; gameRoot.add(o); return o; };

      // Board surface: dark glass, lit, with a bright rim and a soft halo.
      const bm = own(new T.MeshStandardMaterial({ color: 0x0a1a33, roughness: 0.82, metalness: 0.15,
        emissive: 0x06142a, emissiveIntensity: 0.9, fog: false }));
      const bg = own(new T.PlaneGeometry(W, Hh).rotateX(-Math.PI / 2).translate(W / 2, -0.4, Hh / 2));
      add(new T.Mesh(bg, bm), 0);

      const rimC = [[0, 0], [W, 0], [W, Hh], [0, Hh]];
      const rimSegs = [];
      for (let i = 0; i < 4; i++) {
        const a = rimC[i], b = rimC[(i + 1) % 4];
        const dx = b[0] - a[0], dz = b[1] - a[1], len = Math.hypot(dx, dz);
        const ex = dx / len * 1.5, ez = dz / len * 1.5; // extend into the corners so they close
        rimSegs.push(a[0] - ex, a[1] - ez, b[0] + ex, b[1] + ez, 0, len);
      }
      const rimMat = own(new T.MeshBasicMaterial({ color: 0x5ea2e8, transparent: true, opacity: 0.55, depthWrite: false, fog: false }));
      rimMat.color.multiplyScalar(1.4);
      add(new T.Mesh(own(ribbonGeometry(T, rimSegs, 2.4, 0.3)), rimMat), 2);
      const haloMat = own(new T.MeshBasicMaterial({ color: 0x5ea2e8, transparent: true, opacity: 0.1, depthWrite: false, fog: false }));
      add(new T.Mesh(own(ribbonGeometry(T, rimSegs, 14, 0.25)), haloMat), 1);

      // Grid: same spacing rule as holo.js. Fog fades the far lines.
      const G = Math.max(60, Math.round(Math.min(W, Hh) / 7 / 10) * 10);
      const gp = [];
      for (let gx = G; gx < W; gx += G) gp.push(gx, 0.1, 0, gx, 0.1, Hh);
      for (let gy = G; gy < Hh; gy += G) gp.push(0, 0.1, gy, W, 0.1, gy);
      const gg = own(new T.BufferGeometry());
      gg.setAttribute("position", new T.BufferAttribute(new Float32Array(gp), 3));
      add(new T.LineSegments(gg, own(new T.LineBasicMaterial({ color: 0x6f9ad6, transparent: true, opacity: 0.24, depthWrite: false }))), 3);

      // Range rings: the orbital layout's own ellipses if it has them,
      // else holo.js's three circles about the centre.
      const ringSegs = [];
      const ellipse = (rx, ry) => {
        const pts = [];
        for (let i = 0; i < 72; i++) pts.push([W / 2 + Math.cos(i * TAU / 72) * rx, Hh / 2 + Math.sin(i * TAU / 72) * ry]);
        ringSegs.push(...loopSegs(pts, true));
      };
      if (game.rings) for (const [rx, ry] of game.rings) ellipse(rx, ry);
      else for (const f of [0.28, 0.58, 0.88]) { const rr = Math.min(W, Hh) * f * 0.5 * 1.15; ellipse(rr, rr); }
      add(new T.Mesh(own(ribbonGeometry(T, ringSegs, 2, 0.35)),
        own(new T.MeshBasicMaterial({ color: 0x6f9ad6, transparent: true, opacity: 0.26, depthWrite: false }))), 4);

      // ---- lanes -------------------------------------------------------
      const L = game.lanes.length;
      const full = [], half = [];
      for (const l of game.lanes) {
        const a = game.nodes[l.a], b = game.nodes[l.b];
        const len = Math.hypot(b.x - a.x, b.y - a.y), mx = (a.x + b.x) / 2, mz = (a.y + b.y) / 2;
        full.push(a.x, a.y, b.x, b.y, 0, len);
        half.push(a.x, a.y, mx, mz, 0, len / 2, mx, mz, b.x, b.y, len / 2, len);
      }
      const colorAttr = (quads) => {
        const arr = new Float32Array(quads * 4 * 4);
        const at = new T.BufferAttribute(arr, 4);
        at.setUsage(T.DynamicDrawUsage);
        return at;
      };
      const mkLane = (segs, width, y, quadsPerLane, mat, order) => {
        const geo = own(ribbonGeometry(T, segs, width, y));
        const ca = colorAttr(L * quadsPerLane);
        geo.setAttribute("color", ca);
        const mesh = new T.Mesh(geo, mat);
        add(mesh, order);
        return { geo, ca, mesh };
      };
      const laneMat = (extra) => own(new T.MeshBasicMaterial(Object.assign({ vertexColors: true, transparent: true, depthWrite: false }, extra)));
      const baseM = laneMat({});
      const ownM = laneMat({});
      ownM.color.setScalar(1.35);
      const flowM = laneMat({ alphaMap: dash("flow", 20, 4) });
      flowM.color.setScalar(0.9);   // < 1: lanes must not bloom
      const frontM = laneMat({ alphaMap: dash("front", 26, 12) });
      frontM.color.setScalar(0.9);
      rec.lanes = {
        base: mkLane(full, 4.2, 0.5, 1, baseM, 5),
        own: mkLane(half, 5.4, 0.6, 2, ownM, 6),
        flow: mkLane(full, 2.4, 0.7, 1, flowM, 7),
        front: mkLane(full, 2.6, 0.8, 1, frontM, 8),
        sig: new Int32Array(L).fill(-1), colorSig: "", flowM, frontM
      };

      // ---- stations and terrain -------------------------------------
      const lampLit = own(new T.MeshBasicMaterial({ color: 0xfbbf24, fog: false }));
      const lampDim = own(new T.MeshBasicMaterial({ color: 0x4a3a18, fog: false }));
      game.nodes.forEach((n, i) => {
        const g = geosFor(n.type);
        const r = g.r, h = g.h;
        const grp = new T.Group();
        grp.position.set(n.x, 0, n.y);
        gameRoot.add(grp);
        const nr = { n, grp, g, owner: -1, col: "", level: -1, frac: -2, spin: [], cut: null, relay: null, doom: null, mats: {},
          hot: new T.Color(), flashT: -1e9, hitT: -1e9, kickT: -1e9, boost: 0 };

        // Terrain under the pad.
        const terr = n.terrain;
        if (terr === "asteroid" || terr === "well") {
          const rock = terr === "asteroid", rr = r + 19;
          const dm = own(new T.MeshBasicMaterial({ color: rock ? 0xb0895f : 0x9b7fd4, transparent: true, opacity: rock ? 0.24 : 0.22, depthWrite: false }));
          const d = new T.Mesh(own(SG.disc(rr)), dm); d.position.y = 0.9; d.renderOrder = 9; grp.add(d);
          if (rock) {
            const rm = own(new T.MeshStandardMaterial({ color: 0xb0895f, roughness: 0.95, metalness: 0.0, flatShading: true,
              emissive: 0x2a1c0e, emissiveIntensity: 0.6, fog: false }));
            const rocks = [[-0.95, -0.42, 2.8], [-0.35, 0.74, 1.9], [0.55, 0.68, 2.3], [1.0, -0.3, 1.7], [0.15, -0.9, 1.4], [-0.6, 0.1, 1.5],
              [0.8, 0.3, 1.2], [-0.2, -0.5, 1.1]];
            for (const [ax, ay, rad] of rocks) {
              const m = new T.Mesh(SG.rock, rm);
              const s = rad * 2.3;
              m.scale.set(s, s * 0.8, s);
              m.position.set(ax * rr * 0.8, s * 0.55, ay * rr * 0.8);
              m.rotation.set(ax * 3, ay * 5, 0);
              grp.add(m);
            }
          } else {
            for (let k = 0; k < 3; k++) {
              const ring = new T.Mesh(own(arcGeometry(T, (rr - 2) * (1 - k * 0.24), 2.4, 1.0)),
                own(new T.MeshBasicMaterial({ color: 0x9b7fd4, transparent: true, opacity: 0.85 - k * 0.22, depthWrite: false })));
              ring.renderOrder = 9; ring.userData.well = k; grp.add(ring); nr.spin.push(ring);
            }
          }
        }

        // Shadow of the plate, thrown along a fixed world direction.
        const shm = own(new T.MeshBasicMaterial({ color: 0x02050a, transparent: true, opacity: 0.38, depthWrite: false, fog: false }));
        const shadow = new T.Mesh(g.foot, shm);
        shadow.position.set(h * 0.28, 1.0, h * 0.36); shadow.renderOrder = 10; grp.add(shadow);

        // Pad (fill + ring) and capacity gauge on the board.
        const padFill = new T.Mesh(own(SG.disc(r * 1.05)), own(new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.13, depthWrite: false })));
        padFill.position.y = 1.2; padFill.renderOrder = 11; grp.add(padFill);
        const padRing = new T.Mesh(own(arcGeometry(T, r * 1.05, 2, 1.3)), own(new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.7, depthWrite: false })));
        padRing.renderOrder = 12; grp.add(padRing);
        const track = new T.Mesh(own(arcGeometry(T, r + 7, 3.4, 1.4)), own(new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.12, depthWrite: false })));
        track.renderOrder = 12; grp.add(track);
        const fillGeo = own(arcGeometry(T, r + 7, 3.4, 1.5));
        const fill = new T.Mesh(fillGeo, own(new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false })));
        fill.renderOrder = 13; grp.add(fill);
        nr.padFill = padFill; nr.padRing = padRing; nr.fill = fill; nr.fillGeo = fillGeo;

        // Cut off from Command: a dashed orange ring.
        const cutM = own(new T.MeshBasicMaterial({ color: 0xff7a5c, transparent: true, opacity: 0.8, depthWrite: false, alphaMap: dash("cut", 14, 7) }));
        cutM.color.setScalar(1.15);
        const cut = new T.Mesh(own(arcGeometry(T, r + 13, 2.4, 1.5)), cutM);
        cut.renderOrder = 13; cut.visible = false; grp.add(cut);
        nr.cut = cut;

        // The station: pylon, plate, rim, level rings.
        const pm = own(new T.MeshStandardMaterial({ color: 0x445566, roughness: 0.5, metalness: 0.5, emissive: 0x112233, emissiveIntensity: 0.6, fog: false }));
        const plm = own(new T.MeshStandardMaterial({ color: 0x445566, roughness: 0.35, metalness: 0.45, emissive: 0x224466, emissiveIntensity: 0.5, fog: false }));
        const em = own(new T.LineBasicMaterial({ color: 0xffffff, fog: false }));
        // Small parts that should glow (beacon, stack caps): one basic material per
        // station, recoloured with the owner's HDR colour in setOwnerLook.
        const acc = own(new T.MeshBasicMaterial({ color: 0xffffff, fog: false }));
        nr.mats.pylon = pm; nr.mats.plate = plm; nr.mats.edge = em; nr.mats.acc = acc;
        const pylon = new T.Mesh(g.pylon, pm); grp.add(pylon);
        const plateGrp = new T.Group();
        plateGrp.position.y = g.plateY;
        const plate = new T.Mesh(g.plate, plm);
        const edges = new T.LineSegments(g.edges, em);
        plateGrp.add(plate, edges);
        grp.add(plateGrp);
        nr.plateGrp = plateGrp;
        if (g.kind === "hex") {
          // Command: a second, smaller tier so it is unmistakable.
          const tm = own(new T.MeshStandardMaterial({ color: 0x445566, roughness: 0.3, metalness: 0.5, emissive: 0x224466, emissiveIntensity: 0.9, fog: false }));
          const tier = new T.Mesh(SG.tier, tm);
          tier.scale.set(g.plateR * 0.5, 1, g.plateR * 0.5);
          tier.position.set(0, h + 4 - PLATE_THICK / 2 + 0.5, 0);
          const te = new T.LineSegments(SG.tierEdges, em);
          te.scale.copy(tier.scale); te.position.copy(tier.position);
          grp.add(tier, te);
          nr.mats.tier = tm;
          // A mast and a beacon: the Command is the one tall thin thing on
          // the board, so it reads at any size, and the beacon blinks.
          const mast = new T.Mesh(SG.mast, pm);
          mast.position.y = h + 5.5; grp.add(mast);
          const bead = new T.Mesh(SG.dot, acc);
          bead.scale.setScalar(3.1); bead.position.y = h + 29;
          grp.add(bead);
          nr.bead = bead;
        } else if (g.kind === "square") {
          // Factory: twin stacks on the roof.
          const sm = own(new T.MeshStandardMaterial({ color: 0x445566, roughness: 0.4, metalness: 0.5, emissive: 0x224466, emissiveIntensity: 0.9, fog: false }));
          for (const sx of [-1, 1]) {
            const c = new T.Mesh(SG.chimney, sm);
            c.position.set(sx * g.plateR * 0.42, h + 5.5 - 0.5, -g.plateR * 0.3);
            grp.add(c);
          }
          nr.mats.stack = sm;
          // Glowing caps on the stacks: the factory's furnace.
          nr.caps = [];
          for (const sx of [-1, 1]) {
            const cp = new T.Mesh(SG.cap, acc);
            cp.position.set(sx * g.plateR * 0.42, h + 5.5 - 0.5 + 5.6, -g.plateR * 0.3);
            grp.add(cp); nr.caps.push(cp);
          }
        } else if (g.kind === "diamond") {
          nr.spin.push(plateGrp);
        } else if (g.kind === "circle") {
          // Relay: a tilted ring orbiting a feed lamp.
          const rm = own(new T.MeshStandardMaterial({ color: 0x445566, roughness: 0.3, metalness: 0.6, emissive: 0x224466, emissiveIntensity: 1.0, fog: false }));
          const ringG = new T.Group();
          const ring = new T.Mesh(SG.relayTorus, rm);
          ring.scale.setScalar(g.plateR * 0.78);
          ring.rotation.x = Math.PI / 2 - 0.5;
          ringG.add(ring);
          ringG.position.y = h + 8;
          grp.add(ringG);
          nr.spin.push(ringG);
          nr.mats.ring = rm;
          const dm = own(new T.MeshBasicMaterial({ color: 0xffd166, fog: false }));
          const dot = new T.Mesh(SG.dot, dm);
          dot.scale.setScalar(3.4); dot.position.y = h + 8;
          grp.add(dot);
          nr.relay = { dot, mat: dm };
        } else if (g.kind === "star") {
          // Death Star: a dark equatorial trench with a thin lit seam in the
          // owner's colour above it, and a dish in the northern hemisphere.
          // The dish turns to face the viewer (so it is always seen) and, during
          // the lock-on, swings toward the target; eight tributary beams then
          // converge in front of it, where the superlaser starts.
          const R = g.orbR;
          const trM = own(new T.MeshStandardMaterial({ color: 0x0b1018, roughness: 0.9, metalness: 0.2, fog: false }));
          const trench = new T.Mesh(SG.relayTorus, trM);
          trench.scale.set(R * 1.005, R * 1.005, R * 0.5); trench.rotation.x = Math.PI / 2;
          plateGrp.add(trench);
          const seam = new T.Mesh(SG.relayTorus, acc);
          seam.scale.set(R * 1.0, R * 1.0, R * 0.16); seam.rotation.x = Math.PI / 2; seam.position.y = R * 0.13;
          plateGrp.add(seam);
          for (const lat of [-0.5, 0.52]) {           // panel lines, for scale
            const pr = R * Math.sqrt(1 - lat * lat);
            const pl = new T.Mesh(SG.relayTorus, trM);
            pl.scale.set(pr * 1.004, pr * 1.004, R * 0.12); pl.rotation.x = Math.PI / 2; pl.position.y = lat * R;
            plateGrp.add(pl);
          }
          const dishG = new T.Group();
          plateGrp.add(dishG);
          const dr = R * 0.3, dz = Math.sqrt(R * R - dr * dr);
          const dm = own(new T.MeshStandardMaterial({ color: 0x1a212c, roughness: 0.6, metalness: 0.6, emissive: 0x000000, fog: false, side: T.DoubleSide }));
          const dish = new T.Mesh(own(new T.CircleGeometry(dr, 28)), dm);
          dish.position.z = dz + 0.4; dishG.add(dish);
          const dishRim = new T.Mesh(SG.relayTorus, acc);
          dishRim.scale.set(dr, dr, dr * 0.6); dishRim.position.z = dz + 0.4; dishG.add(dishRim);
          const cm = own(new T.MeshBasicMaterial({ color: 0xffd166, fog: false }));
          const core = new T.Mesh(SG.core, cm);
          core.position.z = dz + 0.8; dishG.add(core);
          const focalZ = dz + dr * 1.7;
          const bp = new Float32Array(8 * 6);
          for (let k = 0; k < 8; k++) {
            const a = k * Math.PI / 4;
            bp.set([Math.cos(a) * dr * 0.85, Math.sin(a) * dr * 0.85, dz + 0.6, 0, 0, focalZ], k * 6);
          }
          const bg = own(new T.BufferGeometry());
          bg.setAttribute("position", new T.BufferAttribute(bp, 3));
          const beamM = own(new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false, fog: false }));
          const beams = new T.LineSegments(bg, beamM);
          beams.visible = false; beams.renderOrder = 15; dishG.add(beams);
          const spark = new T.Mesh(SG.dot, beamM);
          spark.position.z = focalZ; spark.visible = false; dishG.add(spark);
          const haloM = own(new T.MeshBasicMaterial({ color: 0xffd166, transparent: true, opacity: 0.4, depthWrite: false }));
          const halo = new T.Mesh(own(arcGeometry(T, r + 17, 2.6, 1.6)), haloM);
          halo.renderOrder = 13; grp.add(halo);
          const arcs = [1, 2].map((s, k) => {
            const m = own(new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthWrite: false }));
            m.color.setScalar(1.4);
            const geo = own(arcGeometry(T, r + 26 + k * 7, 3.6, 1.7));
            const mesh = new T.Mesh(geo, m);
            mesh.renderOrder = 14; mesh.visible = false; grp.add(mesh);
            return { mesh, mat: m, seat: s };
          });
          nr.doom = { core, cm, halo, haloM, arcs, dishG, dm, beams, beamM, spark, R, dr, focalZ,
            dir: new T.Vector3(0, 0.5, 1).normalize(), focus: new T.Vector3(n.x, g.plateY, n.y) };
          rec.doom = nr;
        }

        // Level: five lamps spaced round the plate's rim, one lit per level
        // (unlit ones stay as dim studs so the maximum is visible too). A
        // first version stacked amber hoops above the roof; with bloom on it
        // fused into one yellow blob sitting exactly under the garrison
        // number, so it hid both the level and the digits. Lamps on the rim
        // stay apart at any yaw and clear of the number.
        nr.levels = [];
        // On the Doomstar's sphere the lamps sit on a ring below the trench.
        const orb = g.kind === "star";
        const lampY = g.kind === "diamond" ? g.plateY : orb ? g.plateY - g.orbR * 0.58 : g.plateY + PLATE_THICK / 2 + 1.2;
        const lampR = orb ? g.orbR * 0.86 : g.plateR * 1.02;
        for (let k = 0; k < MAX_LEVEL; k++) {
          const a = -Math.PI / 2 + k * TAU / MAX_LEVEL;
          const lamp = new T.Mesh(SG.dot, lampDim);
          lamp.scale.setScalar(3.3);
          lamp.position.set(Math.cos(a) * lampR, lampY, Math.sin(a) * lampR);
          grp.add(lamp);
          nr.levels.push(lamp);
        }
        nr.mats.level = lampLit; nr.mats.levelDim = lampDim;
        rec.nodes.push(nr);
      });
      built = rec;
    }

    function disposeGame() {
      if (gameRoot) { scene.remove(gameRoot); gameRoot = null; }
      for (const o of gameOwned) { try { o.dispose(); } catch (e) { /* ignore */ } }
      gameOwned.length = 0;
      built = null;
    }

    // =================================================================
    // Per-frame updates
    // =================================================================
    // A "hot" version of a colour: the stuff that should glow. With the
    // composer on it is pushed to a fixed LINEAR luminance `lum` (cyan and
    // rose differ 1.6x in luminance, so equal multipliers would make one
    // side glow more than the other); a scale above 1 per channel is what
    // the bloom threshold keys on. With no composer (low) an over-1 colour
    // would just clip toward white, so it is normalised to its own full
    // saturation instead and stays unmistakably the owner's colour.
    const lum = (c) => 0.2126 * c.r + 0.7152 * c.g + 0.0722 * c.b;
    function hot(out, c, L) {
      out.copy(c);
      if (quality === "high") return out.multiplyScalar(L / Math.max(lum(c), 0.12));
      return out.multiplyScalar(Math.min(1, L * 0.6) / Math.max(c.r, c.g, c.b, 1e-3));
    }
    // `boost` (0..1) is the capture/strike flash: it lifts the same
    // emissive terms the bloom reads, so the whole station flares and fades
    // as one, in the NEW owner's colour.
    function setOwnerLook(nr, str, owner, boost) {
      const c = colorFor(str);
      const m = nr.mats, neutral = owner === 0, b = boost || 0;
      hot(nr.hot, c, neutral ? 0.3 : 1.5);
      if (nr.g.kind === "star") {
        // The Doomstar's hull stays grey metal (a glowing sphere blooms into
        // a blob); ownership shows on its seam, dish rim and pad.
        m.plate.color.set(0x8a95a6).lerp(c, 0.18);
        m.plate.emissive.copy(c); m.plate.emissiveIntensity = (neutral ? 0.03 : 0.07) + b * 1.2;
      } else {
        m.plate.color.copy(c).multiplyScalar(neutral ? 0.7 : 0.6);
        m.plate.emissive.copy(c); m.plate.emissiveIntensity = (neutral ? 0.25 : 0.45) + b * 3.2;
      }
      m.pylon.color.copy(c).multiplyScalar(0.45);
      m.pylon.emissive.copy(c); m.pylon.emissiveIntensity = (neutral ? 0.12 : 0.3) + b * 1.6;
      if (m.tier) { m.tier.color.copy(c).multiplyScalar(0.55); m.tier.emissive.copy(c); m.tier.emissiveIntensity = (neutral ? 0.2 : 0.9) + b * 3; }
      if (m.stack) { m.stack.color.copy(c).multiplyScalar(0.5); m.stack.emissive.copy(c); m.stack.emissiveIntensity = (neutral ? 0.2 : 0.9) + b * 3; }
      if (m.ring) { m.ring.color.copy(c).multiplyScalar(0.5); m.ring.emissive.copy(c); m.ring.emissiveIntensity = (neutral ? 0.25 : 1.1) + b * 3; }
      m.edge.color.copy(nr.hot);
      if (b > 0) m.edge.color.multiplyScalar(1 + b * 1.5);
      m.acc.color.copy(nr.hot);
      hot(m.level.color, colorFor("#fbbf24"), 1.4);
      nr.padFill.material.color.copy(c); nr.padFill.material.opacity = (neutral ? 0.1 : 0.14) + b * 0.25;
      nr.padRing.material.color.copy(c);
      nr.fill.material.color.copy(c);
    }

    // Writes one lane's colours into the four lane meshes.
    function setLane(L, i, a, b, colorOf) {
      const supplyOk = a.owner === b.owner && a.owner !== 0 && a.inSupply !== false && b.inSupply !== false;
      const sameOwner = a.owner === b.owner && a.owner !== 0;
      const contested = a.owner !== b.owner && a.owner !== 0 && b.owner !== 0;
      const put = (ca, quad, r, g, bl, al) => {
        const arr = ca.array, o = quad * 16;
        for (let k = 0; k < 4; k++) { arr[o + k * 4] = r; arr[o + k * 4 + 1] = g; arr[o + k * 4 + 2] = bl; arr[o + k * 4 + 3] = al; }
      };
      put(L.base.ca, i, 0.49, 0.61, 0.78, 0.34);
      if (sameOwner || contested) {
        const ca = colorFor(colorOf(a.owner)), cb = colorFor(colorOf(b.owner));
        const al = sameOwner ? 0.7 : 0.55;
        put(L.own.ca, i * 2, ca.r, ca.g, ca.b, al);
        put(L.own.ca, i * 2 + 1, cb.r, cb.g, cb.b, al);
      } else { put(L.own.ca, i * 2, 0, 0, 0, 0); put(L.own.ca, i * 2 + 1, 0, 0, 0, 0); }
      put(L.flow.ca, i, 1, 1, 1, supplyOk ? 0.55 : 0);
      put(L.front.ca, i, 1, 1, 1, contested ? 0.5 : 0);
    }

    const _q1 = new T.Quaternion(), _q2 = new T.Quaternion(), _m4 = new T.Matrix4();
    const _p = new T.Vector3(), _s = new T.Vector3(), _col = new T.Color();
    const AX_Y = new T.Vector3(0, 1, 0), AX_Z = new T.Vector3(0, 0, 1);
    function fleetPose(game, f, out) {
      const a = game.nodes[f.path[f.leg]], b = game.nodes[f.path[f.leg + 1]];
      if (!a || !b) return false;
      const t = clamp(f.t, 0, 1);
      const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
      out.x = a.x + dx * t; out.y = a.y + dy * t;
      out.ux = dx / len; out.uy = dy / len; out.len = len; out.t = t;
      out.H = clamp(10 + len * 0.1, 14, 34);
      out.z = 4 * out.H * t * (1 - t);
      out.a = a;
      return true;
    }
    const fp = {};
    const fleetLabels = [];

    // Cheap stable pseudo-random in [0,1): a per-ship constant that does not
    // depend on the fleet array's order, so a swarm keeps its shape from
    // frame to frame (fleets have no id; owner/route/count identify one).
    const hash01 = (a, b) => { const x = Math.sin(a * 127.1 + b * 311.7) * 43758.5453; return x - Math.floor(x); };
    const plan = [];
    // Swarm layout: a sunflower (golden-angle) disc stretched along the
    // heading, so ships never line up or overlap the same way twice; plus a
    // little jitter and a slow wobble. The leader (i = 0) sits at the front.
    function updateFleets(game, colorOf) {
      const tier = TIERS[quality];
      const mesh = fleetLayer.mesh, lp = fleetLayer.lp, lc = fleetLayer.lc;
      let ships = 0, seg = 0, nf = 0;
      fleetLabels.length = 0;
      plan.length = 0;
      let want = 0;
      for (const f of game.fleets) {
        if (nf >= MAX_FLEETS) break;
        if (!fleetPose(game, f, fp)) continue;
        nf++;
        const n = clamp(Math.round(tier.k * Math.sqrt(f.count)), 1, tier.perFleet);
        plan.push(f, n);
        want += n;
      }
      const shrink = want > tier.budget ? tier.budget / want : 1;
      for (let pi = 0; pi < plan.length; pi += 2) {
        const f = plan[pi];
        let n = plan[pi + 1];
        if (shrink < 1) n = Math.max(1, Math.floor(n * shrink));
        fleetPose(game, f, fp);
        const col = colorFor(colorOf(f.owner));
        const seed = f.owner * 7.31 + f.from * 1.7 + f.to * 3.3 + f.count * 0.013;
        const s0 = clamp(19 - 0.35 * n, 11, 17);
        const rad = n > 1 ? 9 + 6.8 * Math.sqrt(n) : 0;
        const vx = -fp.uy, vy = fp.ux;
        const head = -Math.atan2(fp.uy, fp.ux);
        // Near the end of the leg the swarm draws in on the target, so the
        // ships behind do not hang in mid-air when the fleet is removed.
        const conv = clamp((1 - fp.t) * fp.len / 55, 0.3, 1);
        for (let i = 0; i < n && ships < MAX_SHIPS; i++) {
          let al = 0, la = 0;
          if (i > 0) {
            const r = rad * Math.sqrt(i / n), th = i * 2.39996 + seed * 6.2832;
            al = r * Math.cos(th) * 1.35 - r * 0.3; la = r * Math.sin(th) * 0.9;
          }
          const h1 = hash01(seed, i), h2 = hash01(i, seed + 5.5), h3 = hash01(seed + 2.2, i + 9.1);
          al = (al + (h1 - 0.5) * s0 * 0.9) * conv;
          la = (la + (h2 - 0.5) * s0 * 0.9) * conv + Math.sin(now * 0.0031 + h3 * 40) * 1.6;
          const ti = Math.min(1, fp.t + al / fp.len);
          if (ti < 0) continue;                      // not out of the dock yet: the swarm streams out of the station
          const slope = 4 * fp.H * (1 - 2 * ti) / fp.len;
          const alt = 4 * fp.H * ti * (1 - ti) + 3 + Math.sin(now * 0.0043 + h3 * 60) * 2.2;
          _q1.setFromAxisAngle(AX_Y, head + Math.sin(now * 0.002 + h2 * 30) * 0.1);
          _q2.setFromAxisAngle(AX_Z, Math.atan(slope));
          _q1.multiply(_q2);
          const grow = clamp(ti * fp.len / 14, 0, 1);
          const sc = s0 * (i === 0 ? 1.3 : 0.8 + h1 * 0.35) * grow;
          _p.set(fp.a.x + fp.ux * fp.len * ti + vx * la, alt, fp.a.y + fp.uy * fp.len * ti + vy * la);
          _s.set(sc, sc, sc);
          _m4.compose(_p, _q1, _s);
          mesh.setMatrixAt(ships, _m4);
          mesh.setColorAt(ships, _col.copy(col).multiplyScalar(0.92 + h3 * 0.2));
          ships++;
        }
        const size = rad * 0.6 + s0 * 1.2;            // label/glow footprint of the whole swarm
        if (tier.trail) {
          // Trail: the arc just flown (fading toward its tail), and a tether to the board.
          const back = 28 / fp.len;
          let px = fp.x, pz = fp.y, py = fp.z + 3;
          for (let i = 1; i <= 5; i++) {
            const tt = Math.max(0, fp.t - back * i / 5);
            const nx = fp.a.x + (fp.x - fp.a.x) * (tt / Math.max(fp.t, 1e-6));
            const nz = fp.a.y + (fp.y - fp.a.y) * (tt / Math.max(fp.t, 1e-6));
            const ny = 4 * fp.H * tt * (1 - tt) + 3;
            const o = seg * 6, c = seg * 8;
            lp[o] = px; lp[o + 1] = py; lp[o + 2] = pz; lp[o + 3] = nx; lp[o + 4] = ny; lp[o + 5] = nz;
            const a0 = 0.6 * (1 - (i - 1) / 5), a1 = 0.6 * (1 - i / 5);
            lc[c] = col.r * 1.4; lc[c + 1] = col.g * 1.4; lc[c + 2] = col.b * 1.4; lc[c + 3] = a0;
            lc[c + 4] = col.r * 1.4; lc[c + 5] = col.g * 1.4; lc[c + 6] = col.b * 1.4; lc[c + 7] = a1;
            px = nx; py = ny; pz = nz; seg++;
          }
          const o = seg * 6, c = seg * 8;
          lp[o] = fp.x; lp[o + 1] = fp.z + 3; lp[o + 2] = fp.y; lp[o + 3] = fp.x; lp[o + 4] = 0.8; lp[o + 5] = fp.y;
          lc[c] = col.r; lc[c + 1] = col.g; lc[c + 2] = col.b; lc[c + 3] = 0.3;
          lc[c + 4] = col.r; lc[c + 5] = col.g; lc[c + 6] = col.b; lc[c + 7] = 0.04;
          seg++;
        }
        glowAdd(fp.x, fp.z + 3, fp.y, col, 0.2, size * 1.1 + 8);
        if (f.count >= 8) fleetLabels.push({ f, x: fp.x, y: fp.y, z: fp.z + 3, size, str: String(Math.round(f.count)) });
      }
      mesh.count = ships;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      fleetLayer.lg.setDrawRange(0, seg * 2);
      fleetLayer.lg.attributes.position.needsUpdate = true;
      fleetLayer.lg.attributes.color.needsUpdate = true;
    }

    // ---- Doomstar strike ----------------------------------------------------
    const _hot = new T.Color(), _own = new T.Color();
    function strike(ev, colorOf) {
      const B = built;
      if (!B || !B.doom) return;
      const src = B.doom, tn = B.nodes[ev.nodeId];
      const st = strikes[nextStrike++ % STRIKES];
      const tg = tn ? tn.g : { plateY: 30 };
      const f = src.doom && src.doom.focus;
      const sx = f ? f.x : src.n.x, sy = f ? f.y : src.g.h + 9, sz = f ? f.z : src.n.y;
      const tx = ev.x, ty = tg.plateY + 4, tz = ev.y;
      st.t0 = now; st.active = true; st.impacted = false; st.tid = tn ? ev.nodeId : -1;
      st.sx = sx; st.sy = sy; st.sz = sz; st.tx = tx; st.ty = ty; st.tz = tz;
      // Orange, tinted a third of the way toward the firing side's colour so
      // the player can tell whose weapon it was without reading anything.
      _own.copy(colorFor(colorOf(ev.owner)));
      st.color.set(0xff8a5c).lerp(_own, 0.3);
      const dx = tx - sx, dz = tz - sz, dist = Math.hypot(dx, dz);
      const peak = Math.min(300, 70 + 0.5 * dist);
      const u = st.arc.mat.uniforms;
      u.uP0.value.set(sx, sy, sz); u.uP2.value.set(tx, ty, tz);
      u.uP1.value.set((sx + tx) / 2, 2 * peak - (sy + ty) / 2, (sz + tz) / 2);
      // The arc lies in the vertical plane through source and target;
      // `side` is that plane's normal (any horizontal if they coincide).
      if (dist > 1) u.uSide.value.set(dz / dist, 0, -dx / dist); else u.uSide.value.set(1, 0, 0);
      u.uColor.value.copy(st.color);
      const c = st.col.mat.uniforms;
      c.uP0.value.set(tx, 0, tz); c.uP1.value.set(tx, 130, tz); c.uP2.value.set(tx, 260, tz);
      c.uSide.value.set(1, 0, 0); c.uColor.value.copy(st.color);
      src.kickT = now;
    }

    // Ease-out for sweeps; a hand-rolled helper because the shader wants a
    // front slightly past 1 so the last segment is actually lit.
    const easeOut = (p) => { const q = 1 - clamp(p, 0, 1); return 1 - q * q; };
    let warmed = false;
    function updateEffects(game) {
      const tier = TIERS[quality];
      const B = built;
      const pxw = hcam.D / hcam.focal;             // world units per CSS pixel at the board's centre
      let lightI = 0, lx = 0, ly = 0, lz = 0;
      for (const st of strikes) {
        if (!st.active) { if (warmed) { st.arc.mesh.visible = false; st.col.mesh.visible = false; } continue; }
        const T0 = now - st.t0;
        if (T0 > BEAM_LIFE + 60) { st.active = false; st.arc.mesh.visible = false; st.col.mesh.visible = false; continue; }
        const au = st.arc.mat.uniforms;
        const tailP = clamp((T0 - BEAM_HEAD - BEAM_HOLD) / BEAM_TAIL, 0, 1);
        au.uHead.value = easeOut(T0 / BEAM_HEAD) * 1.06;
        au.uTail.value = tailP * tailP * 1.06;
        au.uFade.value = 1 - 0.85 * tailP;
        au.uTime.value = now;
        au.uRad.value = 4.2 * pxw;
        au.uGain.value = quality === "high" ? 1 : 0.6;   // no bloom to carry it: keep the orange from clipping to white
        st.arc.mesh.visible = true;
        const Tc = T0 - BEAM_HEAD;
        if (tier.column && Tc >= 0) {
          const cu = st.col.mat.uniforms, tc = clamp((Tc - 120) / 420, 0, 1);
          cu.uHead.value = easeOut(Tc / 110) * 1.06; cu.uTail.value = tc * 1.06; cu.uFade.value = 1 - 0.7 * tc;
          cu.uTime.value = now; cu.uRad.value = 7 * pxw; cu.uGain.value = au.uGain.value;
          st.col.mesh.visible = true;
        } else st.col.mesh.visible = false;
        // The strike lands when the beam head does.
        if (T0 >= BEAM_HEAD) {
          if (!st.impacted) {
            st.impacted = true;
            const tn = st.tid >= 0 ? B.nodes[st.tid] : null;
            if (tn) tn.hitT = now;
            hot(_hot, st.color, 1.5);
            ripple(st.tx, st.tz, 210, 1000, _hot, 1, 0, 1);
            if (tier.echo) ripple(st.tx, st.tz, 135, 800, _hot, 0.7, 170, 1);
          }
          const lt = T0 - BEAM_HEAD;
          if (lt < 560) {
            hot(_hot, st.color, 1.4);
            glowAdd(st.tx, st.ty, st.tz, _hot, 0.3 * (1 - lt / 560), 24 + lt * 0.1);
            if (tier.light) {
              const I = 16000 * Math.exp(-lt / 150);
              if (I > lightI) { lightI = I; lx = st.tx; ly = 80; lz = st.tz; }
            }
          }
        }
        if (T0 < BEAM_HEAD + BEAM_HOLD) { hot(_hot, st.color, 2.0); glowAdd(st.sx, st.sy, st.sz, _hot, 0.4, 26); }
      }
      flashLight.intensity = lightI;
      if (lightI > 0) flashLight.position.set(lx, ly, lz);

      for (const r of ripples) {
        if (!r.active) { if (warmed) r.mesh.visible = false; continue; }
        const T0 = now - r.t0;
        if (T0 >= r.dur) { r.active = false; r.mesh.visible = false; continue; }
        if (T0 < 0) { r.mesh.visible = false; continue; }
        const p = T0 / r.dur, q = 1 - p;
        r.mat.uniforms.uR.value = 1 - Math.pow(q, 2.2);
        r.mat.uniforms.uFade.value = r.power * Math.pow(q, 1.4);
        r.mesh.visible = true;
      }
      // First frame only: draw every effect once, invisibly, so its shader
      // program is compiled now rather than on the first strike.
      if (!warmed) {
        for (const st of strikes) { st.arc.mesh.visible = true; st.col.mesh.visible = true; }
        for (const r of ripples) r.mesh.visible = true;
      }
    }

    function updateScene(game, colorOf, capOf, relayFn, capDoom) {
      const B = built;
      // Lanes: rewrite only the lanes whose ownership or supply changed.
      const L = B.lanes;
      const csig = colorOf(1) + "|" + colorOf(2) + "|" + colorOf(0);
      const force = csig !== L.colorSig;
      L.colorSig = csig;
      let dirty = false;
      for (let i = 0; i < game.lanes.length; i++) {
        const l = game.lanes[i], a = game.nodes[l.a], b = game.nodes[l.b];
        const sig = a.owner | (b.owner << 2) | ((a.inSupply === false ? 1 : 0) << 4) | ((b.inSupply === false ? 1 : 0) << 5);
        if (!force && L.sig[i] === sig) continue;
        L.sig[i] = sig;
        setLane(L, i, a, b, colorOf);
        dirty = true;
      }
      if (dirty) { L.base.ca.needsUpdate = true; L.own.ca.needsUpdate = true; L.flow.ca.needsUpdate = true; L.front.ca.needsUpdate = true; }
      // Live dashes: supply flows toward higher u, the front line crawls.
      const fl = L.flowM.alphaMap, fr = L.frontM.alphaMap;
      fl.offset.x = -((now * 0.0007) % 1);
      fr.offset.x = -((now * 0.0003) % 1);

      glow.n = 0;
      const pulse = 0.5 + 0.5 * Math.sin(now * 0.0022);
      for (let i = 0; i < B.nodes.length; i++) {
        const nr = B.nodes[i], n = game.nodes[i], g = nr.g;
        nr.n = n;
        const str = colorOf(n.owner);
        // A change of owner after the first look is a capture. Read from the
        // state rather than the engine's "capture" event so it also fires
        // for a Doomstar wipe and for the guest, who gets no events.
        if (nr.owner !== -1 && n.owner !== nr.owner) {
          nr.flashT = now;
          ripple(n.x, n.y, 110, 900, hot(tmpC2, colorFor(str), n.owner === 0 ? 0.6 : 1.8), n.owner === 0 ? 0.5 : 1, 0, 1);
        }
        const boost = Math.max(clamp(1 - (now - nr.flashT) / CAPTURE_MS, 0, 1), clamp(1 - (now - nr.hitT) / 700, 0, 1));
        const bq = boost * boost;
        if (n.owner !== nr.owner || str !== nr.col || bq > 0 || nr.boost > 0) {
          setOwnerLook(nr, str, n.owner, bq); nr.owner = n.owner; nr.col = str; nr.boost = bq;
        }
        const c = colorFor(str);

        const lv = Math.min(n.level || 0, MAX_LEVEL);
        if (lv !== nr.level) { for (let k = 0; k < MAX_LEVEL; k++) nr.levels[k].material = k < lv ? nr.mats.level : nr.mats.levelDim; nr.level = lv; }

        // Capacity gauge.
        const cap = capOf(n);
        const frac = n.owner !== 0 ? clamp(n.garrison / cap, 0, 1) : 0;
        const segs = Math.round(frac * ARC_N);
        if (segs !== nr.frac) { nr.fillGeo.setDrawRange(0, segs * 6); nr.fill.visible = segs > 0; nr.frac = segs; }

        // Severed from Command.
        const cutOff = n.owner !== 0 && n.inSupply === false;
        nr.cut.visible = cutOff;
        if (cutOff) nr.cut.material.opacity = 0.55 + 0.45 * Math.abs(Math.sin(now * 0.005));

        for (const s of nr.spin) {
          if (s.userData.well !== undefined) s.rotation.y = now * 0.0004 * (s.userData.well % 2 ? -1 : 1);
          else if (g.kind === "diamond") s.rotation.y = now * 0.0007 + i;
          else if (g.kind === "circle") s.rotation.y = now * 0.0016 + i;
          else s.rotation.y = now * 0.0003;
        }

        if (nr.relay) {
          const feeding = n.owner !== 0 && relayFn ? relayFn(n) > 0 : false;
          nr.relay.dot.visible = n.owner !== 0;
          nr.relay.mat.color.set(feeding ? 0xffd166 : 0xff7a5c);
          const a = feeding ? 0.7 + 0.3 * Math.abs(Math.sin(now * 0.004)) : 0.9;
          nr.relay.mat.color.multiplyScalar(a * 1.6);
        }

        if (nr.doom) {
          const D = nr.doom;
          let best = 0;
          for (const a of D.arcs) {
            const ch = (game.charge && game.charge[a.seat]) || 0;
            const f = clamp(ch / capDoom, 0, 1);
            a.mesh.visible = ch > 0;
            if (ch > 0) {
              const k = Math.round(f * ARC_N);
              a.mesh.geometry.setDrawRange(0, k * 6);
              const full = f >= 1;
              a.mat.color.set(full ? 0xff7a5c : colorOf(a.seat)).multiplyScalar(full ? 1.4 + 0.6 * pulse : 1.2);
              a.mat.opacity = full ? 0.6 + 0.4 * pulse : 0.9;
              if (f > best) best = f;
            }
          }
          const base = n.owner === 0 ? tmpC2.set(0xffd166) : tmpC2.set(str);
          D.haloM.color.copy(base).multiplyScalar(1.3);
          D.haloM.opacity = 0.22 + pulse * 0.3 + best * 0.3;
          D.halo.scale.setScalar(1 + pulse * 0.05 + best * 0.04);
          // Aim the dish: toward the viewer, up and to the left (where the
          // flat and standard 3D views draw it); during the lock-on it swings
          // most of the way toward the target.
          const ds = game.doomShot, lp = ds && H.lockProgress ? H.lockProgress(game) : -1;
          const locking = lp >= 0 && ds.owner === n.owner;
          const cx = n.x, cy = g.plateY, cz = n.y;
          _v1.set(camera3.position.x - cx, camera3.position.y - cy, camera3.position.z - cz).normalize();
          _v2.set(-_v1.z, 0, _v1.x).normalize();                  // the viewer's left, on the board
          _v3.copy(_v1).multiplyScalar(0.8).addScaledVector(_v2, 0.42); _v3.y += 0.38; _v3.normalize();
          const tn = locking ? game.nodes[ds.targetId] : null;
          if (tn) {
            _v1.set(tn.x - cx, (HEIGHT[tn.type] || 40) - cy, tn.y - cz).normalize();
            _v3.lerp(_v1, 0.7 * Math.min(1, lp * 4)).normalize();
          }
          D.dir.lerp(_v3, 0.25).normalize();
          D.dishG.quaternion.setFromUnitVectors(_zAxis, D.dir);
          D.focus.set(cx, cy, cz).addScaledVector(D.dir, D.focalZ);
          // The lens warms with the charge and blazes during the lock.
          const throb = 0.5 + 0.5 * Math.sin(now * (locking ? 0.022 : 0.004 + best * 0.012));
          const kick = clamp(1 - (now - nr.kickT) / 500, 0, 1);
          const heat = Math.max(best * 0.6, locking ? 0.6 + 0.4 * lp : 0, kick);
          D.core.scale.setScalar(D.dr * (0.22 + heat * 0.35 + throb * 0.1 * (0.3 + heat)));
          const lensC = locking ? tmpC.copy(colorFor(colorOf(ds.owner))).lerp(_white, 0.35) : tmpC.set(best >= 1 ? 0xff7a5c : 0xffd166);
          D.cm.color.copy(lensC).multiplyScalar(1.2 + heat * 2.6 + throb * 0.6);   // > 1 on purpose: the lens is the Doomstar's bloom source
          D.dm.emissive.copy(lensC); D.dm.emissiveIntensity = heat * 0.5;
          D.beams.visible = locking; D.spark.visible = locking;
          if (locking) {
            D.beamM.color.copy(lensC).multiplyScalar(1.5 + 1.5 * lp);
            D.beamM.opacity = 0.45 + 0.5 * lp;
            D.spark.scale.setScalar(D.dr * (0.12 + 0.14 * lp) * (0.85 + 0.15 * throb));
          }
        }

        // Small animated parts.
        if (nr.bead) nr.bead.scale.setScalar(3.1 * (0.8 + 0.25 * Math.sin(now * 0.005 + i)));
        if (nr.caps) for (const cp of nr.caps) cp.scale.y = 0.75 + 0.55 * (0.5 + 0.5 * Math.sin(now * 0.004 + i * 2));

        // Station glow sprite, above the plate.
        glowAdd(n.x, g.plateY, n.y, c, ((n.owner === 0 ? 0.16 : 0.34) + bq * 0.6) * (g.kind === "star" ? 0.45 : 1), g.plateR * 2.3 + 8 + bq * 40);
      }
      updateFleets(game, colorOf);
      updateEffects(game);
      glow.geo.setDrawRange(0, glow.n);
      glow.geo.attributes.position.needsUpdate = true;
      glow.geo.attributes.aColor.needsUpdate = true;
      glow.geo.attributes.aSize.needsUpdate = true;
    }

    // =================================================================
    // Overlay (2D text on the game canvas)
    // =================================================================
    function text(str, x, y, px, fill, bold) {
      octx.font = (bold ? "700 " : "600 ") + px + "px " + FONT;
      octx.lineWidth = Math.max(3, px * 0.24);
      octx.strokeStyle = "rgba(4,8,16,.88)";
      octx.strokeText(str, x, y);
      octx.fillStyle = fill;
      octx.fillText(str, x, y);
    }
    // A soft dark scrim under each number. The text already has a dark
    // outline, but a bloomed Doomstar core or a charged station can sit right
    // under a number (sampled: up to 1.0 relative luminance under the "24"
    // over the core, white text is 0.9), where an outline alone is thin. The
    // scrim keeps the contrast whatever the GL layer does, and fades to
    // nothing at its edge so it never reads as a box.
    function scrim(x, y, px, len) {
      const ry = px * 0.9, rx = px * (0.36 * len + 0.75);
      octx.save();
      octx.translate(x, y); octx.scale(rx / ry, 1);
      const g = octx.createRadialGradient(0, 0, 0, 0, 0, ry);
      g.addColorStop(0, "rgba(3,6,14,0.62)"); g.addColorStop(0.55, "rgba(3,6,14,0.4)"); g.addColorStop(1, "rgba(3,6,14,0)");
      octx.fillStyle = g;
      octx.fillRect(-ry, -ry, ry * 2, ry * 2);
      octx.restore();
    }
    const labels = [];
    const _P = { x: 0, y: 0, depth: 0, scale: 0 };
    const _spot = { x: 0, y: 0, px: 12, depth: 0 };
    function drawOverlay(frame, game) {
      octx.setTransform(dpr, 0, 0, dpr, 0, 0);
      octx.globalAlpha = 1;
      octx.clearRect(0, 0, cssW, cssH);
      if (!game) return;
      octx.textAlign = "center"; octx.textBaseline = "middle"; octx.lineJoin = "round";
      if (frame.underlay) { octx.save(); frame.underlay(octx, api.screenOf); octx.restore(); }
      // Numbers on top of the scene, never occluded, >= 11 CSS px: the same
      // anchors and sizes as holo.js (numberSpot), far to near.
      labels.length = 0;
      for (const l of fleetLabels) {
        const p = H.project(hcam, l.x, l.y, l.z);
        if (!p) continue;
        labels.push({ x: p.x, y: p.y - Math.max(12, l.size * p.scale + 9), str: l.str, px: 11, fill: "#e6f0ff", depth: p.depth, fleet: true });
      }
      for (const n of game.nodes) {
        const sp = H.numberSpot(hcam, n, _spot);
        labels.push({ x: sp.x, y: sp.y + 1, str: String(Math.floor(n.garrison)), px: Math.max(11, sp.px), fill: "#f1f6ff", depth: sp.depth, fleet: false });
      }
      labels.sort((a, b) => b.depth - a.depth);
      for (const l of labels) { scrim(l.x, l.y, l.px, l.str.length); text(l.str, l.x, l.y, l.px, l.fill, !l.fleet); }
      if (frame.overlay) {
        octx.save(); octx.globalAlpha = 1;
        frame.overlay(octx, api.screenOf);
        octx.restore();
      }
    }

    // =================================================================
    // Frame
    // =================================================================
    function fail(reason) {
      if (failed) return;
      failed = true;
      for (const cb of failCbs.slice()) { try { cb(reason); } catch (e) { /* a callback must not break teardown */ } }
    }

    function render(frame) {
      if (disposed || failed) return;
      const game = frame.game;
      lastGame = game;
      now = frame.now || 0;
      try {
        if (!cssW) resize(glCanvas.clientWidth || 300, glCanvas.clientHeight || 150, 1);
        const E = engine();
        const colorOf = frame.colorOf || ((o) => (o === (frame.mySeat === undefined ? 1 : frame.mySeat) ? DEFAULT_COLORS[1] : o === 0 ? DEFAULT_COLORS[0] : DEFAULT_COLORS[2]));
        stepFly();
        ensureCamera(game);
        if (game) {
          if (!built || built.game !== game || built.W !== game.mapW || built.H !== game.mapH || built.nodes.length !== game.nodes.length) buildGame(game);
          // Engine events from THIS frame (the caller drains them once and
          // hands them over; nothing here drains). Only the Doomstar strike
          // is drawn from one: everything else is read from the state.
          if (frame.events) for (const ev of frame.events) if (ev && ev.kind === "doomstar") strike(ev, colorOf);
          const capFn = frame.capOf || (E ? (n) => E.nodeStats(n, game).cap : null);
          const capOf = (n) => { const c = capFn ? capFn(n) : 0; return c > 0 ? c : { command: 70, factory: 45, mine: 28, relay: 34, doomstar: 40 }[n.type] || 40; };
          const relayFn = E ? (n) => E.relayCharge(game, n) : null;
          const capDoom = (E && E.DOOM_CHARGE_NEEDED) || 20;
          updateScene(game, colorOf, capOf, relayFn, capDoom);
          if (!lost) {
            if (composer) composer.render(); else renderer.render(scene, camera3);
          }
          warmed = true;
        }
        drawOverlay(frame, game);
      } catch (err) {
        fail("render: " + (err && err.message ? err.message : String(err)));
      }
    }

    // ---- context loss ---------------------------------------------------
    // three.js re-uploads geometry, textures and programs on its own once
    // the context returns, so "restored" only has to end the countdown. If
    // it does not come back within 3 s the caller is told and should swap
    // renderers: an iOS tab that stays frozen is not coming back by itself.
    function onLost(e) {
      if (e && e.preventDefault) e.preventDefault();
      lost = true;
      clearTimeout(lostTimer);
      lostTimer = setTimeout(() => { if (lost) fail("webglcontextlost"); }, 3000);
    }
    function onRestored() {
      lost = false;
      clearTimeout(lostTimer);
      camKey = "";
    }
    glCanvas.addEventListener("webglcontextlost", onLost, false);
    glCanvas.addEventListener("webglcontextrestored", onRestored, false);
    // A finger or a wheel on the board ends the fly-in. Listened to here, on
    // the overlay canvas that owns all pointer input, in the bubble phase
    // AFTER the game's own handler: that handler's pick() then still sees the
    // camera the player was looking at when they touched, and only the
    // frames after it jump home. Passive: it never blocks a gesture.
    const onTouchBoard = () => cancelFly();
    if (overlay.addEventListener) {
      overlay.addEventListener("pointerdown", onTouchBoard, { passive: true });
      overlay.addEventListener("wheel", onTouchBoard, { passive: true });
    }

    // ---- interface --------------------------------------------------------
    const api = {
      name: "holo-gl",
      resize,
      render,
      pick(px, py, touch) {
        if (!lastGame) return null;
        return H.pick(ensureCamera(lastGame), lastGame, px, py, !!touch);
      },
      screenOf(wx, wy, wz) {
        const c = ensureCamera(lastGame);
        const p = H.project(c, wx, wy, wz || 0);
        return p && { x: p.x, y: p.y, scale: p.scale, depth: p.depth };
      },
      toBoard(px, py) { return H.toBoard(ensureCamera(lastGame), px, py); },
      // Screen point where the Doomstar's superlaser starts (in front of its
      // dish), so the lock-on overlay leaves from the dish actually drawn.
      doomFocus() {
        const D = built && built.doom && built.doom.doom;
        if (!D || !lastGame) return null;
        const p = H.project(ensureCamera(lastGame), D.focus.x, D.focus.z, D.focus.y);
        return p && { x: p.x, y: p.y };
      },
      camera() { return ensureCamera(lastGame); },
      // Anything that moves the camera by hand ends the fly-in on the spot:
      // a player who starts turning the board is not waiting for the intro.
      orbit(dYaw) { cancelFly(); yaw = (((yaw + dYaw) % TAU) + TAU) % TAU; },
      setYaw(y) { cancelFly(); yaw = ((y % TAU) + TAU) % TAU; },
      getYaw() { return yaw; },
      zoomBy(f) { cancelFly(); zoom = clamp(zoom * f, ZMIN, ZMAX); },
      setZoom(z) { cancelFly(); zoom = clamp(z, ZMIN, ZMAX); },
      getZoom() { return zoom; },
      // The match-start camera move, from the game's current yaw/zoom (so
      // call it after the board has been turned to face home). The clock is
      // frame.now of the first frame after the call. Skipped for people who
      // ask their system for reduced motion. Returns whether it started.
      flyIn() {
        try {
          if (typeof matchMedia === "function" && matchMedia("(prefers-reduced-motion: reduce)").matches) return false;
        } catch (e) { /* no matchMedia: fly */ }
        fly = { t0: -1, k: 1 };
        return true;
      },
      flying() { return !!fly; },
      onFailure(cb) { if (typeof cb === "function") failCbs.push(cb); if (failed) { /* already failed: stay quiet, once only */ } },
      setQuality(q) {
        q = q === "low" ? "low" : "high";
        if (q === quality) return;
        quality = q;
        fleetLayer.shipHigh.value = q === "high" ? 1 : 0;
        buildComposer();
        // Glowing parts are authored differently without the composer (see
        // hot()), so every station re-reads its colours on the next frame.
        if (built) for (const nr of built.nodes) nr.col = "";
      },
      quality() { return quality; },
      // GPU memory counts, so a test can prove dispose() frees what the
      // scene allocated. Deliberately not the renderer or scene objects.
      info() {
        const m = renderer ? renderer.info.memory : { geometries: 0, textures: 0 };
        return { geometries: m.geometries, textures: m.textures };
      },
      dispose(o) {
        if (disposed) return;
        disposed = true;
        clearTimeout(lostTimer);
        glCanvas.removeEventListener("webglcontextlost", onLost, false);
        glCanvas.removeEventListener("webglcontextrestored", onRestored, false);
        if (overlay.removeEventListener) {
          overlay.removeEventListener("pointerdown", onTouchBoard);
          overlay.removeEventListener("wheel", onTouchBoard);
        }
        fly = null;
        disposeGame();
        disposeComposer();
        for (const x of shared) { try { x.dispose(); } catch (e) { /* ignore */ } }
        shared.length = 0;
        if (bgTex) { bgTex.dispose(); bgTex = null; }
        fleetLayer.mesh.dispose();
        if (flashLight.dispose) flashLight.dispose();
        renderer.dispose();
        // A context can only be reused on the same canvas while it is
        // alive, so it is released only when the caller says the canvas is
        // being thrown away.
        if (o && o.loseContext) { try { renderer.forceContextLoss(); } catch (e) { /* ignore */ } }
        failCbs.length = 0;
      }
    };
    return api;
  }

  return { supported, create, cameraFor, projectThree, NEAR_FRAC };
});
