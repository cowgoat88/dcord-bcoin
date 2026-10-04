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
  const MAX_SHIPS = MAX_FLEETS * 5;
  const MAX_LEVEL = 5;

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

    // ---- fleets: instanced ships + one dynamic line buffer for trails ---
    const fleetLayer = (() => {
      // A dart: tip, two swept wings, a notch, a ridge above and a keel below.
      const T0 = [1, 0, 0], L = [-0.7, 0, 0.62], R = [-0.7, 0, -0.62], N = [-0.3, 0, 0], U = [-0.15, 0.3, 0], D = [-0.15, -0.12, 0];
      const tris = [[T0, L, U], [T0, U, R], [L, N, U], [R, U, N], [T0, L, D], [T0, D, R], [L, N, D], [R, D, N]];
      const p = [];
      for (const t of tris) for (const v of t) p.push(v[0], v[1], v[2]);
      const g = keep(new T.BufferGeometry());
      g.setAttribute("position", new T.BufferAttribute(new Float32Array(p), 3));
      g.computeVertexNormals();
      const m = keep(new T.MeshStandardMaterial({ color: 0xffffff, roughness: 0.4, metalness: 0.3, flatShading: true,
        side: T.DoubleSide, fog: false }));
      // Instance colour also drives the emissive term, so a ship glows in
      // its owner's colour rather than only being lit by it.
      m.onBeforeCompile = (sh) => {
        sh.fragmentShader = sh.fragmentShader.replace("#include <emissivemap_fragment>",
          "#include <emissivemap_fragment>\n#if defined( USE_COLOR ) || defined( USE_INSTANCING_COLOR )\n  totalEmissiveRadiance = vColor.rgb * 0.8;\n#endif");
      };
      const mesh = new T.InstancedMesh(g, m, MAX_SHIPS);
      mesh.instanceMatrix.setUsage(T.DynamicDrawUsage);
      mesh.setColorAt(0, new T.Color(1, 1, 1));
      mesh.instanceColor.setUsage(T.DynamicDrawUsage);
      mesh.count = 0; mesh.frustumCulled = false; mesh.renderOrder = 20;
      scene.add(mesh);

      const SEG = 6;
      const lp = new Float32Array(MAX_FLEETS * SEG * 2 * 3), lc = new Float32Array(MAX_FLEETS * SEG * 2 * 4);
      const lg = keep(new T.BufferGeometry());
      lg.setAttribute("position", new T.BufferAttribute(lp, 3).setUsage(T.DynamicDrawUsage));
      lg.setAttribute("color", new T.BufferAttribute(lc, 4).setUsage(T.DynamicDrawUsage));
      lg.setDrawRange(0, 0);
      const lm = keep(new T.LineBasicMaterial({ vertexColors: true, transparent: true, depthWrite: false, fog: false }));
      const lines = new T.LineSegments(lg, lm);
      lines.frustumCulled = false; lines.renderOrder = 19;
      scene.add(lines);
      return { mesh, lines, lp, lc, lg, SEG };
    })();

    // ---- camera plumbing (same contract as holo.js) --------------------
    function ensureCamera(g) {
      const mapW = g ? g.mapW : 1000, mapH = g ? g.mapH : 640;
      const k = [cssW, cssH, mapW, mapH, yaw, zoom].join("|");
      if (k !== camKey || !hcam) {
        hcam = H.createCamera({ w: cssW || 300, h: cssH || 150, mapW, mapH, yaw, zoom });
        camKey = k;
        cameraFor(hcam, T, camera3);
        applyCameraDerived();
      }
      return hcam;
    }
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
      bloomPass = new T.UnrealBloomPass(new T.Vector2(cssW, cssH), 0.4, 0.4, 0.85);
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
        const sh = new T.Shape(), pts = unitShape("star");
        for (let i = 0; i < pts.length; i++) {
          const x = pts[i][0] * plateR * 1.02, y = -pts[i][1] * plateR * 1.02;
          i ? sh.lineTo(x, y) : sh.moveTo(x, y);
        }
        sh.closePath();
        plate = new T.ExtrudeGeometry(sh, { depth: PLATE_THICK + 3, bevelEnabled: false });
        plate.rotateX(-Math.PI / 2);
      } else plate = new T.CylinderGeometry(plateR, plateR, PLATE_THICK, 28);
      out.plate = keep(plate);
      out.edges = keep(new T.EdgesGeometry(plate, 25));
      // Where the plate sits: its centre height. (Diamond hangs from the top.)
      out.plateY = kind === "diamond" ? h - plateR * 1.05 * 0.55
        : kind === "star" ? zPlate - 1.5
        : zPlate + PLATE_THICK / 2;
      if (kind === "star") out.plateY = zPlate - 1.5;
      // Footprint of the plate on the ground, for the cast shadow.
      const fp = new T.Shape(), up = unitShape(kind);
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
      g.levelRing = keep(new T.TorusGeometry(1, 0.045, 5, 28).rotateX(Math.PI / 2));
      g.core = keep(new T.SphereGeometry(1, 14, 10));
      g.rock = keep(new T.DodecahedronGeometry(1, 0));
      g.chimney = keep(new T.BoxGeometry(5, 11, 5));
      g.tier = keep(new T.CylinderGeometry(1, 1, 8, 6));
      g.tierEdges = keep(new T.EdgesGeometry(g.tier, 25));
      g.relayTorus = keep(new T.TorusGeometry(1, 0.11, 6, 32));
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
      flowM.color.setScalar(1.6);
      const frontM = laneMat({ alphaMap: dash("front", 26, 12) });
      frontM.color.setScalar(1.6);
      rec.lanes = {
        base: mkLane(full, 4.2, 0.5, 1, baseM, 5),
        own: mkLane(half, 5.4, 0.6, 2, ownM, 6),
        flow: mkLane(full, 2.4, 0.7, 1, flowM, 7),
        front: mkLane(full, 2.6, 0.8, 1, frontM, 8),
        sig: new Int32Array(L).fill(-1), colorSig: "", flowM, frontM
      };

      // ---- stations and terrain -------------------------------------
      game.nodes.forEach((n, i) => {
        const g = geosFor(n.type);
        const r = g.r, h = g.h;
        const grp = new T.Group();
        grp.position.set(n.x, 0, n.y);
        gameRoot.add(grp);
        const nr = { n, grp, g, owner: -1, col: "", level: -1, frac: -2, spin: [], cut: null, relay: null, doom: null, mats: {} };

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
        nr.mats.pylon = pm; nr.mats.plate = plm; nr.mats.edge = em;
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
        } else if (g.kind === "square") {
          // Factory: twin stacks on the roof.
          const sm = own(new T.MeshStandardMaterial({ color: 0x445566, roughness: 0.4, metalness: 0.5, emissive: 0x224466, emissiveIntensity: 0.9, fog: false }));
          for (const sx of [-1, 1]) {
            const c = new T.Mesh(SG.chimney, sm);
            c.position.set(sx * g.plateR * 0.42, h + 5.5 - 0.5, -g.plateR * 0.3);
            grp.add(c);
          }
          nr.mats.stack = sm;
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
          nr.spin.push(plateGrp);
          const cm = own(new T.MeshBasicMaterial({ color: 0xffd166, fog: false }));
          const core = new T.Mesh(SG.core, cm);
          core.scale.setScalar(7); core.position.y = h + 9;
          grp.add(core);
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
          nr.doom = { core, cm, halo, haloM, arcs };
          rec.doom = nr;
        }

        // Level rings: amber hoops up the pylon, one per level.
        nr.levels = [];
        const lm = own(new T.MeshBasicMaterial({ color: 0xfbbf24, fog: false }));
        lm.color.setScalar(1.3);
        for (let k = 0; k < MAX_LEVEL; k++) {
          const lr = new T.Mesh(SG.levelRing, lm);
          lr.scale.setScalar(g.pw * 1.9 + 3);
          lr.position.y = 6 + k * 6;
          lr.visible = false;
          grp.add(lr);
          nr.levels.push(lr);
        }
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
    function setOwnerLook(nr, str, owner) {
      const c = colorFor(str);
      const m = nr.mats, neutral = owner === 0;
      m.plate.color.copy(c).multiplyScalar(neutral ? 0.75 : 0.62);
      m.plate.emissive.copy(c); m.plate.emissiveIntensity = neutral ? 0.3 : 0.4;
      m.pylon.color.copy(c).multiplyScalar(0.45);
      m.pylon.emissive.copy(c); m.pylon.emissiveIntensity = neutral ? 0.12 : 0.3;
      if (m.tier) { m.tier.color.copy(c).multiplyScalar(0.55); m.tier.emissive.copy(c); m.tier.emissiveIntensity = neutral ? 0.2 : 0.9; }
      if (m.stack) { m.stack.color.copy(c).multiplyScalar(0.5); m.stack.emissive.copy(c); m.stack.emissiveIntensity = neutral ? 0.2 : 0.9; }
      if (m.ring) { m.ring.color.copy(c).multiplyScalar(0.5); m.ring.emissive.copy(c); m.ring.emissiveIntensity = neutral ? 0.25 : 1.1; }
      m.edge.color.copy(c).lerp(tmpC.set(0xffffff), neutral ? 0.1 : 0.35);
      nr.padFill.material.color.copy(c); nr.padFill.material.opacity = neutral ? 0.1 : 0.14;
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
    const FORM = [[0, 0], [-1.35, 1.15], [-1.35, -1.15], [-2.7, 2.1], [-2.7, -2.1]];

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

    function updateFleets(game, colorOf) {
      const mesh = fleetLayer.mesh, lp = fleetLayer.lp, lc = fleetLayer.lc;
      let ships = 0, seg = 0, nf = 0;
      fleetLabels.length = 0;
      for (const f of game.fleets) {
        if (nf >= MAX_FLEETS) break;
        if (!fleetPose(game, f, fp)) continue;
        nf++;
        const col = colorFor(colorOf(f.owner));
        const size = (5 + Math.min(9, Math.sqrt(f.count) * 0.9)) * 2.1;
        const vx = -fp.uy, vy = fp.ux;
        // Heading and climb along the arc.
        const slope = 4 * fp.H * (1 - 2 * fp.t) / fp.len;
        _q1.setFromAxisAngle(AX_Y, -Math.atan2(fp.uy, fp.ux));
        _q2.setFromAxisAngle(AX_Z, Math.atan(slope));
        _q1.multiply(_q2);
        const n = Math.min(5, 1 + Math.floor(Math.sqrt(f.count) / 1.7));
        for (let i = 0; i < n && ships < MAX_SHIPS; i++) {
          const s = size * (i === 0 ? 1 : 0.68) * 1.2;
          _p.set(fp.x + (fp.ux * FORM[i][0] + vx * FORM[i][1]) * size,
            fp.z + 3,
            fp.y + (fp.uy * FORM[i][0] + vy * FORM[i][1]) * size);
          _s.set(s, s, s);
          _m4.compose(_p, _q1, _s);
          mesh.setMatrixAt(ships, _m4);
          mesh.setColorAt(ships, _col.copy(col).multiplyScalar(1.25));
          ships++;
        }
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
        {
          const o = seg * 6, c = seg * 8;
          lp[o] = fp.x; lp[o + 1] = fp.z + 3; lp[o + 2] = fp.y; lp[o + 3] = fp.x; lp[o + 4] = 0.8; lp[o + 5] = fp.y;
          lc[c] = col.r; lc[c + 1] = col.g; lc[c + 2] = col.b; lc[c + 3] = 0.3;
          lc[c + 4] = col.r; lc[c + 5] = col.g; lc[c + 6] = col.b; lc[c + 7] = 0.04;
          seg++;
        }
        glowAdd(fp.x, fp.z + 3, fp.y, col, 0.3, size * 1.5 + 6);
        if (f.count >= 8) fleetLabels.push({ f, x: fp.x, y: fp.y, z: fp.z + 3, size, str: String(Math.round(f.count)) });
      }
      mesh.count = ships;
      mesh.instanceMatrix.needsUpdate = true;
      if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
      fleetLayer.lg.setDrawRange(0, seg * 2);
      fleetLayer.lg.attributes.position.needsUpdate = true;
      fleetLayer.lg.attributes.color.needsUpdate = true;
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
        if (n.owner !== nr.owner || str !== nr.col) { setOwnerLook(nr, str, n.owner); nr.owner = n.owner; nr.col = str; }
        const c = colorFor(str);

        const lv = Math.min(n.level || 0, MAX_LEVEL);
        if (lv !== nr.level) { for (let k = 0; k < MAX_LEVEL; k++) nr.levels[k].visible = k < lv; nr.level = lv; }

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
          // The core brightens and throbs faster as the weapon charges.
          const throb = 0.5 + 0.5 * Math.sin(now * (0.004 + best * 0.012));
          D.core.scale.setScalar(6.5 + best * 4 + throb * (1 + best * 2.5));
          D.cm.color.set(best >= 1 ? 0xff7a5c : 0xffd166).multiplyScalar(1.1 + best * 1.4 + throb * 0.5);
        }

        // Station glow sprite, above the plate.
        glowAdd(n.x, g.plateY, n.y, c, n.owner === 0 ? 0.16 : 0.34, g.plateR * 2.3 + 8);
      }
      updateFleets(game, colorOf);
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
      for (const l of labels) text(l.str, l.x, l.y, l.px, l.fill, !l.fleet);
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
        ensureCamera(game);
        if (game) {
          if (!built || built.game !== game || built.W !== game.mapW || built.H !== game.mapH || built.nodes.length !== game.nodes.length) buildGame(game);
          const capFn = frame.capOf || (E ? (n) => E.nodeStats(n, game).cap : null);
          const capOf = (n) => { const c = capFn ? capFn(n) : 0; return c > 0 ? c : { command: 70, factory: 45, mine: 28, relay: 34, doomstar: 40 }[n.type] || 40; };
          const relayFn = E ? (n) => E.relayCharge(game, n) : null;
          const capDoom = (E && E.DOOM_CHARGE_NEEDED) || 20;
          updateScene(game, colorOf, capOf, relayFn, capDoom);
          if (!lost) {
            if (composer) composer.render(); else renderer.render(scene, camera3);
          }
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
      camera() { return ensureCamera(lastGame); },
      orbit(dYaw) { yaw = (((yaw + dYaw) % TAU) + TAU) % TAU; },
      setYaw(y) { yaw = ((y % TAU) + TAU) % TAU; },
      getYaw() { return yaw; },
      zoomBy(f) { zoom = clamp(zoom * f, ZMIN, ZMAX); },
      setZoom(z) { zoom = clamp(z, ZMIN, ZMAX); },
      getZoom() { return zoom; },
      onFailure(cb) { if (typeof cb === "function") failCbs.push(cb); if (failed) { /* already failed: stay quiet, once only */ } },
      setQuality(q) {
        q = q === "low" ? "low" : "high";
        if (q === quality) return;
        quality = q;
        buildComposer();
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
        disposeGame();
        disposeComposer();
        for (const x of shared) { try { x.dispose(); } catch (e) { /* ignore */ } }
        shared.length = 0;
        if (bgTex) { bgTex.dispose(); bgTex = null; }
        fleetLayer.mesh.dispose();
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
