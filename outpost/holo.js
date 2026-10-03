// OUTPOST — holotable renderer (Tier 1 3D).
//
// The match drawn as a tilted board with stations standing on it. The
// simulation is untouched: positions are the engine's 2D values, height
// is decoration. This is Canvas 2D with a hand-written perspective camera
// -- no WebGL (iOS drops GL contexts when a tab is backgrounded, which is
// exactly what the online flow makes people do) and no library (the game
// runs from file:// with classic scripts and no build step).
//
// Two halves, deliberately separate:
//   * camera maths  -- pure functions, no DOM, tested in Node (holo.test.js)
//   * create()      -- the renderer that owns a canvas, tested in a browser
//
// Conventions: world x/y are the engine's map units (y grows toward the
// bottom of the 2D view), z is up. Angles are radians. At yaw 0 the board
// looks exactly like the flat view seen from below, so nothing about the
// map's handedness changes when the camera orbits.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.OutpostHolo = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const TAU = Math.PI * 2;
  const FOV = 45 * Math.PI / 180;          // vertical field of view
  const DEFAULT_PITCH = 55 * Math.PI / 180; // elevation of the camera above the board
  const PORTRAIT_PITCH = 62 * Math.PI / 180; // phone portrait: the board is width-bound, so tilt up to use the height
  const ZOOM_MIN = 0.7, ZOOM_MAX = 1.6;
  // How far back the camera sits, as a multiple of the distance at which
  // the board's circumscribed circle would just fill a 45 degree FOV.
  // Bigger = flatter perspective. 1.5 keeps the far end of a phone
  // portrait board at ~75% of the near end's scale: enough to read as
  // depth, not enough to shrink far stations below ~20 px across (1.25
  // measured 19.4 px worst case over 20 seeds, 1.5 gives 20.7).
  const STANDOFF = 1.5;
  const CEILING = 104;      // tallest thing the fit reserves headroom for

  // Station geometry. Radii mirror engine NODE_TYPES (holo.test.js checks
  // they still agree) so the camera works without importing the engine.
  const RADIUS = { command: 30, factory: 24, mine: 22, relay: 21, doomstar: 27 };
  const SHAPE = { command: "hex", factory: "square", mine: "diamond", relay: "circle", doomstar: "star" };
  // Height of the top plate above the board. Command is the tallest thing
  // on the table on purpose: it is the one you must not lose.
  const HEIGHT = { command: 84, factory: 58, mine: 40, relay: 52, doomstar: 76 };
  // Pylon half-width as a fraction of the station radius.
  const POLE = { command: 0.40, factory: 0.32, mine: 0.26, relay: 0.15, doomstar: 0.36 };
  const PLATE_THICK = 6;

  // Hit-testing slack in CSS px beyond the station's footprint. A finger
  // covers far more than a cursor, and the board is smaller on a phone.
  const PICK = { mouseSlack: 4, touchSlack: 14, minRadius: 9 };

  // The engine is optional: with it, capacity arcs and Relay feed state
  // are exact; without it (Node camera tests) they fall back to the type
  // table. A caller can also pass frame.capOf to override.
  const engine = () => (typeof globalThis !== "undefined" && globalThis.OutpostEngine) || null;

  const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
  const radiusOf = (n) => RADIUS[n.type] || 22;
  const heightOf = (n) => HEIGHT[n.type] || 30;

  // =====================================================================
  // Camera (pure)
  // =====================================================================
  // Camera space: X to the viewer's right, Y up the screen, Z along the
  // view direction. The board's centre is the look-at point. `yaw` spins
  // the board about its centre; "near" is the world direction
  // (-sin yaw, cos yaw), so yaw 0 puts the bottom of the flat map nearest.
  function toView(cam, x, y, z, out) {
    const dx = x - cam.cx, dy = y - cam.cy;
    const r = dx * cam.c + dy * cam.s;          // screen-right component
    const f = dx * cam.s - dy * cam.c;          // distance away from the viewer
    out.X = r;
    out.Y = f * cam.sp + z * cam.cp;
    out.Z = cam.D + f * cam.cp - z * cam.sp;
    return out;
  }

  const _v = { X: 0, Y: 0, Z: 0 };

  // Pitch is fixed per device class, not free. A tall narrow canvas is
  // width-bound however it is tilted, so a steeper view spends the spare
  // height on depth instead of leaving it as empty sky.
  function defaultPitch(w, h) { return h > w * 1.3 ? PORTRAIT_PITCH : DEFAULT_PITCH; }

  function createCamera(o) {
    const w = o.w, h = o.h, mapW = o.mapW, mapH = o.mapH;
    const yaw = o.yaw || 0;
    const zoom = clamp(o.zoom === undefined ? 1 : o.zoom, ZOOM_MIN, ZOOM_MAX);
    const pitch = o.pitch === undefined ? defaultPitch(w, h) : o.pitch;
    const R = Math.hypot(mapW, mapH) / 2;
    const cam = {
      w, h, mapW, mapH, yaw, zoom, pitch,
      cx: mapW / 2, cy: mapH / 2,
      c: Math.cos(yaw), s: Math.sin(yaw),
      cp: Math.cos(pitch), sp: Math.sin(pitch),
      D: STANDOFF * R / Math.tan(FOV / 2),
      focal: 1, ox: 0, oy: 0
    };

    // Auto-fit. Screen position is linear in `focal`, so the scale that
    // makes the board's bounding box (corners on the plane, and again at
    // the tallest pylon so nothing pokes off the top) just fit is a
    // closed-form division, not a search. Fitting per yaw means a
    // portrait phone gets the whole width at yaw 0 instead of being sized
    // for the worst-case rotation and wasting the screen.
    let maxU = 0, minV = Infinity, maxV = -Infinity;
    for (const zc of [0, CEILING]) {
      for (let i = 0; i < 4; i++) {
        toView(cam, i & 1 ? mapW : 0, i & 2 ? mapH : 0, zc, _v);
        const u = _v.X / _v.Z, v = _v.Y / _v.Z;
        if (Math.abs(u) > maxU) maxU = Math.abs(u);
        if (v < minV) minV = v;
        if (v > maxV) maxV = v;
      }
    }
    const m = Math.max(12, Math.min(w, h) * 0.035);
    const fit = Math.min((w - 2 * m) / (2 * maxU), (h - 2 * m) / (maxV - minV));
    cam.focal = fit * zoom;
    cam.ox = w / 2;
    // Centre the bounding box vertically; sy = oy - focal * v.
    cam.oy = h / 2 + cam.focal * (minV + maxV) / 2;
    return cam;
  }

  // Allocation-free projection for the render loop. Returns false when
  // the point is behind the near plane.
  function projInto(cam, x, y, z, out) {
    toView(cam, x, y, z, _v);
    if (_v.Z < cam.D * 0.1) return false;
    const k = cam.focal / _v.Z;
    out.x = cam.ox + _v.X * k;
    out.y = cam.oy - _v.Y * k;
    out.depth = _v.Z;
    out.scale = k;
    return true;
  }

  function project(cam, x, y, z) {
    const o = { x: 0, y: 0, depth: 0, scale: 0 };
    return projInto(cam, x, y, z || 0, o) ? o : null;
  }

  // Inverse of project() restricted to the board plane z = 0. A pixel
  // above the horizon never meets the plane, hence null.
  function toBoard(cam, px, py) {
    const q = -(py - cam.oy) / cam.focal;
    const den = cam.sp - q * cam.cp;
    if (den <= 1e-9) return null;
    const f = q * cam.D / den;
    const Z = cam.D + f * cam.cp;
    if (Z <= 0) return null;
    const r = (px - cam.ox) / cam.focal * Z;
    // Undo the yaw rotation (see toView).
    return {
      x: cam.cx + r * cam.c + f * cam.s,
      y: cam.cy + r * cam.s - f * cam.c
    };
  }

  // Where a station's garrison number is drawn: centred just above the top
  // plate, so the plate's silhouette (the type cue) stays visible instead
  // of being covered by the digits. Shared by the renderer and by pick so
  // that tapping the number selects the station.
  const _n = { x: 0, y: 0, depth: 0, scale: 0 };
  const _spot = { x: 0, y: 0, px: 12, depth: 0 };
  function numberSpot(cam, n, out) {
    out = out || _spot;
    const top = heightOf(n) + (n.type === "command" ? 8 : 0);
    projInto(cam, n.x, n.y, top, _n);
    const r = radiusOf(n);
    out.px = clamp(Math.round(r * _n.scale * 0.95), 12, 24);
    out.x = _n.x;
    out.y = _n.y - (r * 0.92 * cam.sp * _n.scale + out.px * 0.5 + 3);
    out.depth = _n.depth;
    return out;
  }

  // Screen-space hit test. A station is a pylon, so the thing you aim at
  // is the line from its foot on the board to its top plate, not just the
  // footprint: tapping the number floating above a Factory must select
  // the Factory. A node is a candidate when the point is within reach of
  // that segment. Among candidates the winner is the one whose nearer
  // end (foot or plate centre) is closest to the point -- "nearest
  // centre" -- and the one closer to the viewer breaks exact ties. Ranking
  // by distance to the whole segment instead would let a tall pylon
  // swallow every tap on a neighbour's foot that happens to sit behind it.
  const _a = { x: 0, y: 0, depth: 0, scale: 0 }, _b = { x: 0, y: 0, depth: 0, scale: 0 };
  function pick(cam, game, px, py, touch) {
    let best = null, bestD = Infinity, bestDepth = Infinity;
    const slack = touch ? PICK.touchSlack : PICK.mouseSlack;
    for (const n of game.nodes) {
      if (!projInto(cam, n.x, n.y, 0, _a)) continue;
      numberSpot(cam, n, _spot);
      _b.x = _spot.x; _b.y = _spot.y;
      const reach = Math.max(radiusOf(n) * _a.scale, PICK.minRadius) + slack;
      if (distToSegment(px, py, _a.x, _a.y, _b.x, _b.y) > reach) continue;
      const d = Math.min(Math.hypot(px - _a.x, py - _a.y), Math.hypot(px - _b.x, py - _b.y));
      if (d < bestD - 1e-6 || (Math.abs(d - bestD) <= 1e-6 && _a.depth < bestDepth)) {
        best = n; bestD = d; bestDepth = _a.depth;
      }
    }
    return best;
  }

  function distToSegment(px, py, ax, ay, bx, by) {
    const vx = bx - ax, vy = by - ay;
    const L = vx * vx + vy * vy;
    const t = L > 1e-9 ? clamp(((px - ax) * vx + (py - ay) * vy) / L, 0, 1) : 0;
    return Math.hypot(px - (ax + vx * t), py - (ay + vy * t));
  }

  // Yaw that points the seat's Command at the viewer. Near is
  // (-sin yaw, cos yaw), so a Command offset (dx, dy) from the board
  // centre is exactly facing at yaw = atan2(-dx, dy). That angle is then
  // snapped to the nearest quarter turn. Exact facing tilts a tall phone
  // board diagonally, which shrinks it by a third (measured: stations
  // fell to 12 px across at 390x844); a quarter turn keeps the board
  // square to the screen and still puts the Command within 45 degrees of
  // straight ahead, always in the nearer half of the table.
  function yawFacing(game, seat) {
    let home = null;
    for (const n of game.nodes) {
      if (n.type === "command" && n.owner === seat) { home = n; break; }
    }
    if (!home) return 0;
    const dx = home.x - game.mapW / 2, dy = home.y - game.mapH / 2;
    if (Math.hypot(dx, dy) < 1e-6) return 0;
    const exact = Math.atan2(-dx, dy);
    const snapped = Math.round(exact / (Math.PI / 2)) * (Math.PI / 2);
    return ((snapped % TAU) + TAU) % TAU;
  }

  // =====================================================================
  // Renderer
  // =====================================================================
  // Unit outlines, matching shapePath() in index.html.
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
    } else { // hex
      for (let i = 0; i < 6; i++) {
        const a = Math.PI / 6 + i * Math.PI / 3;
        pts.push([Math.cos(a), Math.sin(a)]);
      }
    }
    return pts;
  }
  const UNIT = {};
  for (const k of ["circle", "square", "star", "diamond", "hex"]) UNIT[k] = unitShape(k);
  const RING = UNIT.circle;
  const RING_FINE = (() => {
    const p = [];
    for (let i = 0; i < 40; i++) p.push([Math.cos(i * TAU / 40), Math.sin(i * TAU / 40)]);
    return p;
  })();

  // Same generator as engine.js makeRng, copied so holo.js stays
  // standalone. Render never touches Math.random: the sky is seeded.
  function makeRng(seed) {
    let a = (seed >>> 0) || 1;
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const FONT = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const DEFAULT_COLORS = ["#64748b", "#22d3ee", "#fb7185"];

  function create(canvas, opts) {
    opts = opts || {};
    const ctx = canvas.getContext("2d");
    const makeCanvas = opts.createCanvas || ((w, h) => {
      const c = document.createElement("canvas");
      c.width = w; c.height = h;
      return c;
    });

    let cssW = 0, cssH = 0, dpr = 1;
    let yaw = opts.yaw || 0, zoom = clamp(opts.zoom || 1, ZOOM_MIN, ZOOM_MAX);
    const pitch = opts.pitch;
    let cam = null, camKey = "";
    let lastGame = null;
    let bg = null;                 // pre-rendered gradient + nebula
    const glows = new Map();       // "color|bucket" -> sprite canvas

    // Seeded sky: u,v in [0,1), `layer` is how strongly it parallaxes.
    const stars = [];
    {
      const rng = makeRng(7);
      for (let i = 0; i < 150; i++) {
        stars.push({ u: rng(), v: rng(), r: rng() * 1.3 + 0.5, a: rng() * 0.5 + 0.18,
          tw: rng() * 6, layer: 0.25 + rng() * 0.75 });
      }
    }

    // Scratch objects so the frame loop does not allocate per point.
    const P = { x: 0, y: 0, depth: 0, scale: 0 };
    const Q = { x: 0, y: 0, depth: 0, scale: 0 };
    const items = [];
    const labels = [];
    let colorOf = null, mySeat = 1, game = null, now = 0;

    // ---- camera plumbing ------------------------------------------------
    function ensureCamera(g) {
      const mapW = g ? g.mapW : 1000, mapH = g ? g.mapH : 640;
      const key = [cssW, cssH, mapW, mapH, yaw, zoom].join("|");
      if (key !== camKey || !cam) {
        cam = createCamera({ w: cssW, h: cssH, mapW, mapH, yaw, zoom, pitch });
        camKey = key;
      }
      return cam;
    }

    function resize(w, h, ratio) {
      cssW = Math.max(1, w); cssH = Math.max(1, h);
      dpr = Math.min(ratio || 1, 2);
      canvas.width = Math.floor(cssW * dpr);
      canvas.height = Math.floor(cssH * dpr);
      bg = null; camKey = "";
    }

    // ---- sprites --------------------------------------------------------
    // A glow is a radial gradient. Building one per node per frame is what
    // makes a naive canvas renderer slow on a phone, so each colour/size is
    // rendered once into a small canvas and blitted. Sizes are bucketed to
    // keep the cache tiny.
    function glow(color, radius) {
      const b = clamp(Math.ceil(radius / 8) * 8, 8, 128);
      const key = color + "|" + b;
      let s = glows.get(key);
      if (!s) {
        if (glows.size > 96) glows.clear();
        s = makeCanvas(b * 2, b * 2);
        const g = s.getContext("2d");
        const grd = g.createRadialGradient(b, b, 0, b, b, b);
        grd.addColorStop(0, color);
        grd.addColorStop(0.35, color);
        grd.addColorStop(1, "rgba(0,0,0,0)");
        g.globalAlpha = 0.55;
        g.fillStyle = grd;
        g.fillRect(0, 0, b * 2, b * 2);
        glows.set(key, s);
      }
      return s;
    }
    function blit(color, x, y, radius, alpha) {
      const s = glow(color, radius);
      ctx.globalAlpha = alpha;
      ctx.drawImage(s, x - radius, y - radius, radius * 2, radius * 2);
    }

    // The gradient and nebula blobs are baked once per size into one
    // offscreen canvas at device resolution, so each frame is a 1:1 blit.
    // (A bigger-than-view canvas that slid with the yaw cost ~1.5 ms a
    // frame in software raster because the blit had to resample; only the
    // stars parallax now, which is the cue that matters.)
    function buildBackground() {
      const w = Math.ceil(cssW), h = Math.ceil(cssH);
      const c = makeCanvas(Math.ceil(cssW * dpr), Math.ceil(cssH * dpr)), g = c.getContext("2d");
      g.scale(dpr, dpr);
      const base = g.createRadialGradient(w / 2, h / 2, 0, w / 2, h / 2, Math.max(w, h) * 0.7);
      base.addColorStop(0, "#0e1830");
      base.addColorStop(1, "#05080f");
      g.fillStyle = base; g.fillRect(0, 0, w, h);
      const rng = makeRng(23);
      const tints = ["rgba(56,100,190,", "rgba(120,70,190,", "rgba(30,150,170,", "rgba(190,80,120,"];
      for (let i = 0; i < 5; i++) {
        const x = rng() * w, y = rng() * h, r = (0.18 + rng() * 0.25) * Math.max(w, h);
        const grd = g.createRadialGradient(x, y, 0, x, y, r);
        const t = tints[i % tints.length];
        grd.addColorStop(0, t + "0.13)");
        grd.addColorStop(1, t + "0)");
        g.fillStyle = grd; g.fillRect(0, 0, w, h);
      }
      bg = { c, w, h };
    }

    // ---- small drawing helpers -----------------------------------------
    // Trace a unit outline scaled by r, centred (x, y) at height z.
    function tracePoly(unit, x, y, z, r, rot) {
      const cs = rot ? Math.cos(rot) : 1, sn = rot ? Math.sin(rot) : 0;
      for (let i = 0; i < unit.length; i++) {
        const ux = unit[i][0] * r, uy = unit[i][1] * r;
        projInto(cam, x + ux * cs - uy * sn, y + ux * sn + uy * cs, z, P);
        i ? ctx.lineTo(P.x, P.y) : ctx.moveTo(P.x, P.y);
      }
      ctx.closePath();
    }
    // Arc on the plane at height z, from angle a0 for `span` radians.
    function traceArc(x, y, z, r, a0, span) {
      const steps = Math.max(6, Math.ceil(span / TAU * 40));
      for (let i = 0; i <= steps; i++) {
        const a = a0 + span * i / steps;
        projInto(cam, x + Math.cos(a) * r, y + Math.sin(a) * r, z, P);
        i ? ctx.lineTo(P.x, P.y) : ctx.moveTo(P.x, P.y);
      }
    }
    function text(str, x, y, px, fill, bold) {
      ctx.font = (bold ? "700 " : "600 ") + px + "px " + FONT;
      ctx.lineWidth = Math.max(3, px * 0.24);
      ctx.strokeStyle = "rgba(4,8,16,.88)";
      ctx.strokeText(str, x, y);
      ctx.fillStyle = fill;
      ctx.fillText(str, x, y);
    }

    // ---- scene ----------------------------------------------------------
    function drawBackground() {
      if (!bg) buildBackground();
      ctx.globalAlpha = 1;
      ctx.drawImage(bg.c, 0, 0, cssW, cssH);
      ctx.fillStyle = "#b8cbe6";
      const spin = yaw / TAU;
      for (const s of stars) {
        // Nearer layers slide further when the board orbits: that offset
        // difference is the whole parallax cue.
        let u = (s.u - spin * s.layer) % 1; if (u < 0) u += 1;
        ctx.globalAlpha = s.a * (0.65 + 0.35 * Math.sin(now * 0.0011 + s.tw));
        ctx.fillRect(u * cssW, s.v * cssH, s.r, s.r);
      }
      ctx.globalAlpha = 1;
    }

    function drawBoard() {
      const W = game.mapW, H = game.mapH;
      // The table surface and a soft edge (three strokes fading outward).
      ctx.beginPath();
      projInto(cam, 0, 0, 0, P); ctx.moveTo(P.x, P.y);
      projInto(cam, W, 0, 0, P); ctx.lineTo(P.x, P.y);
      projInto(cam, W, H, 0, P); ctx.lineTo(P.x, P.y);
      projInto(cam, 0, H, 0, P); ctx.lineTo(P.x, P.y);
      ctx.closePath();
      ctx.globalAlpha = 0.5; ctx.fillStyle = "#0a1a33"; ctx.fill();
      ctx.strokeStyle = "#5ea2e8";
      ctx.globalAlpha = 0.1; ctx.lineWidth = 7; ctx.stroke();
      ctx.globalAlpha = 0.38; ctx.lineWidth = 1.2; ctx.stroke();

      // Grid, bucketed by depth so far lines fade without a gradient per
      // line. Each line is cut into pieces so its alpha can change along it.
      const R = Math.hypot(W, H) / 2;
      const zNear = cam.D - R * cam.cp, zSpan = 2 * R * cam.cp;
      const G = Math.max(60, Math.round(Math.min(W, H) / 7 / 10) * 10);
      const segs = [[], [], [], []];
      const addLine = (x0, y0, x1, y1) => {
        const N = 10;
        for (let i = 0; i < N; i++) {
          const ax = x0 + (x1 - x0) * i / N, ay = y0 + (y1 - y0) * i / N;
          const bx = x0 + (x1 - x0) * (i + 1) / N, by = y0 + (y1 - y0) * (i + 1) / N;
          projInto(cam, ax, ay, 0, P); projInto(cam, bx, by, 0, Q);
          const dn = clamp(((P.depth + Q.depth) / 2 - zNear) / zSpan, 0, 0.999);
          segs[(dn * 4) | 0].push(P.x, P.y, Q.x, Q.y);
        }
      };
      for (let gx = G; gx < W; gx += G) addLine(gx, 0, gx, H);
      for (let gy = G; gy < H; gy += G) addLine(0, gy, W, gy);
      ctx.strokeStyle = "#6f9ad6"; ctx.lineWidth = 1;
      for (let b = 0; b < 4; b++) {
        const a = segs[b];
        ctx.globalAlpha = 0.20 - b * 0.04;   // bucket 0 is nearest
        ctx.beginPath();
        for (let i = 0; i < a.length; i += 4) { ctx.moveTo(a[i], a[i + 1]); ctx.lineTo(a[i + 2], a[i + 3]); }
        ctx.stroke();
      }
      // Range rings about the centre. They are what gives the table its
      // depth -- the owner asked for them back after they were removed in
      // a pass at decluttering the lanes, which was the wrong target: the
      // congestion is in the map layout, not in the floor.
      ctx.strokeStyle = "#6f9ad6"; ctx.globalAlpha = 0.16; ctx.lineWidth = 1;
      ctx.beginPath();
      for (const f of [0.28, 0.58, 0.88]) {
        tracePoly(RING_FINE, W / 2, H / 2, 0, Math.min(W, H) * f * 0.5 * 1.15, 0);
      }
      ctx.stroke();
      ctx.globalAlpha = 1;
    }

    // Lanes are drawn in batched passes -- one path per style, not four
    // strokes per lane. Software raster (and a phone's GPU driver) pays per
    // stroke call, and dashed strokes most of all, so the pass order is
    // base conduits, supply glow by owner, flow dashes, owner halves by
    // colour, front-line dashes. Depth fade is two buckets (near/far).
    function drawLanes() {
      const R = Math.hypot(game.mapW, game.mapH) / 2;
      const zNear = cam.D - R * cam.cp, zSpan = 2 * R * cam.cp;
      const base = [[], []], supply = new Map(), half = new Map(), flow = [], front = [];
      let wbSum = 0;
      for (const l of game.lanes) {
        const a = game.nodes[l.a], b = game.nodes[l.b];
        projInto(cam, a.x, a.y, 0, P); projInto(cam, b.x, b.y, 0, Q);
        const dn = clamp(((P.depth + Q.depth) / 2 - zNear) / zSpan, 0, 1);
        const seg = [P.x, P.y, Q.x, Q.y];
        wbSum += (P.scale + Q.scale) / 2;
        base[dn > 0.5 ? 1 : 0].push(seg);
        const sameOwner = a.owner === b.owner && a.owner !== 0;
        const contested = a.owner !== b.owner && a.owner !== 0 && b.owner !== 0;
        if (sameOwner && a.inSupply !== false && b.inSupply !== false) {
          const k = colorOf(a.owner);
          (supply.get(k) || supply.set(k, []).get(k)).push(seg);
          flow.push(seg);
        }
        if (sameOwner || contested) {
          const mx = (P.x + Q.x) / 2, my = (P.y + Q.y) / 2;
          const ka = (sameOwner ? "s|" : "c|") + colorOf(a.owner), kb = (sameOwner ? "s|" : "c|") + colorOf(b.owner);
          (half.get(ka) || half.set(ka, []).get(ka)).push([P.x, P.y, mx, my]);
          (half.get(kb) || half.set(kb, []).get(kb)).push([mx, my, Q.x, Q.y]);
        }
        if (contested) front.push(seg);
      }
      const sc = game.lanes.length ? wbSum / game.lanes.length : 0.6;
      const wb = clamp(3.2 * sc * 1.5, 1.3, 5);
      const stroke = (segs) => {
        ctx.beginPath();
        for (const g of segs) { ctx.moveTo(g[0], g[1]); ctx.lineTo(g[2], g[3]); }
        ctx.stroke();
      };
      ctx.lineCap = "round";
      ctx.strokeStyle = "#7d9bc8"; ctx.lineWidth = wb;
      ctx.globalAlpha = 0.32; stroke(base[0]);
      ctx.globalAlpha = 0.2; stroke(base[1]);
      ctx.lineWidth = wb * 1.55; ctx.globalAlpha = 0.5;
      for (const [k, segs] of supply) { ctx.strokeStyle = k; stroke(segs); }
      if (flow.length) {
        // A live supply line shows a slow flow along it.
        ctx.setLineDash([2, 12]); ctx.lineDashOffset = -now * 0.05;
        ctx.strokeStyle = "#ffffff"; ctx.globalAlpha = 0.5; ctx.lineWidth = Math.max(1, wb * 0.6);
        stroke(flow);
        ctx.setLineDash([]);
      }
      for (const [k, segs] of half) {
        const same = k.charAt(0) === "s";
        ctx.strokeStyle = k.slice(2);
        ctx.globalAlpha = same ? 0.62 : 0.5;
        ctx.lineWidth = same ? wb * 1.1 : wb * 0.85;
        stroke(segs);
      }
      if (front.length) {
        // The front line: live dashes, same cue as the flat view.
        ctx.setLineDash([6, 10]); ctx.lineDashOffset = -now * 0.02;
        ctx.strokeStyle = "#ffffff"; ctx.globalAlpha = 0.4; ctx.lineWidth = Math.max(1, wb * 0.5);
        stroke(front);
        ctx.setLineDash([]);
      }
      ctx.globalAlpha = 1; ctx.lineCap = "butt";
    }

    // Everything that lies flat on the board and so can never occlude
    // anything standing on it: terrain, shadows, pads, capacity arcs.
    function drawGround(n) {
      const r = radiusOf(n), h = heightOf(n);
      const c = colorOf(n.owner);
      projInto(cam, n.x, n.y, 0, Q);
      const sc = Q.scale;

      const terr = n.terrain;
      if (terr === "asteroid" || terr === "well") {
        const rock = terr === "asteroid", rr = r + 19;
        ctx.globalAlpha = rock ? 0.26 : 0.22;
        ctx.fillStyle = rock ? "#b0895f" : "#9b7fd4";
        ctx.beginPath(); tracePoly(RING, n.x, n.y, 0, rr, 0); ctx.fill();
        if (rock) {
          ctx.globalAlpha = 0.95; ctx.fillStyle = "#b0895f";
          const rocks = [[-0.95, -0.42, 2.8], [-0.35, 0.74, 1.9], [0.55, 0.68, 2.3],
            [1.0, -0.3, 1.7], [0.15, -0.9, 1.4], [-0.6, 0.1, 1.5]];
          for (const [ax, ay, rad] of rocks) {
            projInto(cam, n.x + ax * rr * 0.8, n.y + ay * rr * 0.8, 0, P);
            const rp = Math.max(1.5, rad * P.scale * 1.5);
            ctx.beginPath(); ctx.ellipse(P.x, P.y, rp, rp * 0.75, 0, 0, TAU); ctx.fill();
          }
        } else {
          // Concentric rings falling inward: ground you cannot climb out of.
          ctx.strokeStyle = "#9b7fd4"; ctx.lineWidth = Math.max(1, 1.5 * sc * 1.4);
          for (let k = 0; k < 3; k++) {
            ctx.globalAlpha = 0.85 - k * 0.22;
            ctx.beginPath(); tracePoly(RING, n.x, n.y, 0, (rr - 2) * (1 - k * 0.24), 0); ctx.stroke();
          }
        }
      }

      // Shadow of the top plate, thrown along a fixed world direction so
      // it swings with the board: the strongest cheap depth cue there is.
      ctx.globalAlpha = 0.5; ctx.fillStyle = "#02050a";
      ctx.beginPath();
      tracePoly(UNIT[SHAPE[n.type] || "circle"], n.x + h * 0.28, n.y + h * 0.36, 0, r * 0.95, 0);
      ctx.fill();

      // Pad, in owner colour.
      ctx.globalAlpha = 0.13; ctx.fillStyle = c;
      ctx.beginPath(); tracePoly(RING, n.x, n.y, 0, r * 1.05, 0); ctx.fill();
      ctx.globalAlpha = 0.65; ctx.strokeStyle = c; ctx.lineWidth = clamp(1.6 * sc * 1.4, 1, 3);
      ctx.beginPath(); tracePoly(RING, n.x, n.y, 0, r * 1.05, 0); ctx.stroke();

      // Capacity arc, as in the flat view: how full this position is.
      const cap = capOf(n);
      const frac = clamp(n.garrison / cap, 0, 1);
      const aw = clamp(3 * sc * 1.4, 1.6, 4.5);
      ctx.globalAlpha = 0.12; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = aw;
      ctx.beginPath(); traceArc(n.x, n.y, 0, r + 7, 0, TAU); ctx.stroke();
      if (n.owner !== 0 && frac > 0) {
        ctx.globalAlpha = 0.9; ctx.strokeStyle = c;
        ctx.beginPath(); traceArc(n.x, n.y, 0, r + 7, -Math.PI / 2, frac * TAU); ctx.stroke();
      }

      // Cut off from Command: a broken orange ring, so it reads as severed.
      if (n.owner !== 0 && n.inSupply === false) {
        ctx.globalAlpha = 0.55 + 0.45 * Math.abs(Math.sin(now * 0.005));
        ctx.strokeStyle = "#ff7a5c"; ctx.lineWidth = aw * 0.8;
        ctx.setLineDash([4, 5]);
        ctx.beginPath(); traceArc(n.x, n.y, 0, r + 13, 0, TAU); ctx.stroke();
        ctx.setLineDash([]);
      }

      if (n.type === "doomstar") drawDoomRings(n, r, sc);
      ctx.globalAlpha = 1;
    }

    let capFn = null, relayFn = null;
    function capOf(n) {
      const c = capFn ? capFn(n) : 0;
      return c > 0 ? c : { command: 70, factory: 45, mine: 28, relay: 34, doomstar: 40 }[n.type] || 40;
    }

    function drawDoomRings(n, r, sc) {
      // Pulsing halo on the board, plus each seat's charge as an arc.
      const glowT = 0.5 + 0.5 * Math.sin(now * 0.0022);
      ctx.strokeStyle = n.owner === 0 ? "#ffd166" : colorOf(n.owner);
      ctx.globalAlpha = 0.22 + glowT * 0.3; ctx.lineWidth = clamp(2 * sc * 1.4, 1.2, 3);
      ctx.beginPath(); tracePoly(RING, n.x, n.y, 0, r + 17 + glowT * 5, 0); ctx.stroke();
      const need = capDoom;
      const seats = [1, 2];
      for (let i = 0; i < seats.length; i++) {
        const s = seats[i], ch = (game.charge && game.charge[s]) || 0;
        if (ch <= 0) continue;
        const f = clamp(ch / need, 0, 1);
        const full = f >= 1;
        ctx.strokeStyle = full ? "#ff7a5c" : colorOf(s);
        ctx.globalAlpha = full ? 0.6 + 0.4 * glowT : 0.9;
        ctx.lineWidth = clamp(3.2 * sc * 1.4, 1.8, 5);
        ctx.beginPath(); traceArc(n.x, n.y, 0, r + 26 + i * 7, -Math.PI / 2, f * TAU); ctx.stroke();
      }
    }
    let capDoom = 20;

    // Stations ----------------------------------------------------------
    function drawStation(n) {
      const r = radiusOf(n), h = heightOf(n);
      const c = colorOf(n.owner);
      const kind = SHAPE[n.type] || "circle";
      const unit = UNIT[kind];
      const doom = n.type === "doomstar";
      const rot = doom ? now * 0.0003 : 0;
      projInto(cam, n.x, n.y, 0, P);
      const bx = P.x, by = P.y, bs = P.scale;
      const zPlate = h - PLATE_THICK;

      // Pylon: a tapered column from foot to underside of the plate.
      projInto(cam, n.x, n.y, zPlate, Q);
      const pw = r * POLE[n.type];
      const wb = Math.max(1.6, pw * bs), wt = Math.max(1.2, pw * 0.6 * Q.scale);
      ctx.globalAlpha = 0.5; ctx.fillStyle = c;
      ctx.beginPath();
      ctx.moveTo(bx - wb, by); ctx.lineTo(bx + wb, by);
      ctx.lineTo(Q.x + wt, Q.y); ctx.lineTo(Q.x - wt, Q.y);
      ctx.closePath(); ctx.fill();
      ctx.globalAlpha = 0.55; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(bx, by); ctx.lineTo(Q.x, Q.y); ctx.stroke();

      // Level: amber rings stacked up the pylon, one per level.
      for (let i = 0; i < n.level; i++) {
        const z = 6 + i * 6;
        ctx.globalAlpha = 0.9; ctx.strokeStyle = "#fbbf24";
        ctx.lineWidth = clamp(1.8 * bs * 1.4, 1.2, 2.6);
        ctx.beginPath(); tracePoly(RING, n.x, n.y, z, pw * 1.9 + 3, 0); ctx.stroke();
      }

      // Command wears a second, smaller tier so it is unmistakable even
      // when the footprint is small.
      if (n.type === "command") plate(n, unit, c, h + 8, r * 0.5, 0, 4, 0.5);

      // Glow behind the plate, then the plate itself (a slab: underside,
      // verticals, top face).
      const plateR = r * 0.92;
      projInto(cam, n.x, n.y, h, Q);
      const gr = plateR * Q.scale * 2.1 + 6;
      blit(c, Q.x, Q.y, gr, n.owner === 0 ? 0.22 : 0.4);
      plate(n, unit, c, h, plateR, rot, PLATE_THICK, 1);

      // A Relay you hold shows whether it is feeding the Doomstar.
      if (n.type === "relay" && n.owner !== 0 && relayFn) {
        const live = relayFn(n) > 0;
        projInto(cam, n.x, n.y, h + 10, P);
        ctx.fillStyle = live ? "#ffd166" : "#ff7a5c";
        ctx.globalAlpha = live ? 0.6 + 0.4 * Math.abs(Math.sin(now * 0.004)) : 0.9;
        ctx.beginPath(); ctx.arc(P.x, P.y, Math.max(2, 3.2 * P.scale * 1.4), 0, TAU); ctx.fill();
      }
      ctx.globalAlpha = 1;
    }

    function plate(n, unit, c, z, r, rot, thick, alpha) {
      const flash = n.owner === 0 ? 0.1 : 0.2;
      // Underside, darker, then the connecting verticals.
      ctx.globalAlpha = 0.85 * alpha; ctx.fillStyle = "#050a14";
      ctx.beginPath(); tracePoly(unit, n.x, n.y, z - thick, r, rot); ctx.fill();
      ctx.globalAlpha = 0.45 * alpha; ctx.strokeStyle = c; ctx.lineWidth = 1;
      ctx.beginPath();
      const cs = Math.cos(rot), sn = Math.sin(rot);
      for (let i = 0; i < unit.length; i++) {
        const ux = unit[i][0] * r, uy = unit[i][1] * r;
        const wx = n.x + ux * cs - uy * sn, wy = n.y + ux * sn + uy * cs;
        projInto(cam, wx, wy, z - thick, P); ctx.moveTo(P.x, P.y);
        projInto(cam, wx, wy, z, P); ctx.lineTo(P.x, P.y);
      }
      ctx.stroke();
      // Top face: tinted fill and a bright rim.
      ctx.globalAlpha = (flash + 0.18) * alpha; ctx.fillStyle = c;
      ctx.beginPath(); tracePoly(unit, n.x, n.y, z, r, rot); ctx.fill();
      ctx.globalAlpha = alpha;
      ctx.strokeStyle = c; ctx.lineWidth = clamp(2.2 * P.scale * 1.5 + 0.4, 1.4, 3.2);
      ctx.stroke();
    }

    // Fleets -----------------------------------------------------------
    const FORM = [[0, 0], [-1.35, 1.15], [-1.35, -1.15], [-2.7, 2.1], [-2.7, -2.1]];
    function fleetPose(f, out) {
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

    function drawFleet(f, fp) {
      const c = colorOf(f.owner);
      const size = (5 + Math.min(9, Math.sqrt(f.count) * 0.9)) * 2.1;
      const vx = -fp.uy, vy = fp.ux;
      projInto(cam, fp.x, fp.y, fp.z, Q);
      const qx = Q.x, qy = Q.y, qs = Q.scale;

      // Trail: the arc it just flew, so altitude reads from the curve.
      const back = 28 / fp.len;
      ctx.globalAlpha = 0.34; ctx.strokeStyle = c; ctx.lineWidth = Math.max(1.2, 2 * qs * 1.4);
      ctx.beginPath();
      for (let i = 0; i <= 5; i++) {
        const tt = Math.max(0, fp.t - back * i / 5);
        projInto(cam, fp.a.x + (fp.x - fp.a.x) * (tt / Math.max(fp.t, 1e-6)),
          fp.a.y + (fp.y - fp.a.y) * (tt / Math.max(fp.t, 1e-6)),
          4 * fp.H * tt * (1 - tt), P);
        i ? ctx.lineTo(P.x, P.y) : ctx.moveTo(P.x, P.y);
      }
      ctx.stroke();

      // Tether to the board, which anchors the fleet's altitude.
      projInto(cam, fp.x, fp.y, 0, P);
      ctx.globalAlpha = 0.24; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.moveTo(qx, qy); ctx.lineTo(P.x, P.y); ctx.stroke();

      blit(c, qx, qy, size * qs * 1.9 + 5, 0.6);

      // The swarm: chevrons lying flat at altitude, so they foreshorten
      // with the board instead of billboarding.
      const n = Math.min(5, 1 + Math.floor(Math.sqrt(f.count) / 1.7));
      ctx.fillStyle = c; ctx.strokeStyle = "#ffffff"; ctx.lineWidth = 0.8;
      for (let i = 0; i < n; i++) {
        const s = size * (i === 0 ? 1 : 0.68);
        const ox = fp.x + (fp.ux * FORM[i][0] + vx * FORM[i][1]) * size;
        const oy = fp.y + (fp.uy * FORM[i][0] + vy * FORM[i][1]) * size;
        ctx.globalAlpha = i === 0 ? 1 : 0.85;
        ctx.beginPath();
        chev(ox, oy, fp.z, fp.ux, fp.uy, vx, vy, s);
        ctx.fill();
        ctx.globalAlpha = i === 0 ? 0.6 : 0.3; ctx.stroke();
      }
      ctx.globalAlpha = 1;
      if (f.count >= 8) labels.push({ x: qx, y: qy - Math.max(12, size * qs + 9), str: String(Math.round(f.count)), px: 11, fill: "#e6f0ff", depth: Q.depth, fleet: true });
    }
    // One chevron as a closed subpath of world-space points at height z.
    function chev(x, y, z, ux, uy, vx, vy, s) {
      const pts = [[s, 0], [-0.7 * s, 0.62 * s], [-0.3 * s, 0], [-0.7 * s, -0.62 * s]];
      for (let i = 0; i < 4; i++) {
        projInto(cam, x + ux * pts[i][0] + vx * pts[i][1], y + uy * pts[i][0] + vy * pts[i][1], z, P);
        i ? ctx.lineTo(P.x, P.y) : ctx.moveTo(P.x, P.y);
      }
      ctx.closePath();
    }

    // ---- frame ----------------------------------------------------------
    function render(frame) {
      game = frame.game; lastGame = game;
      now = frame.now || 0;
      mySeat = frame.mySeat === undefined ? 1 : frame.mySeat;
      colorOf = frame.colorOf || ((o) => (o === mySeat ? DEFAULT_COLORS[1] : o === 0 ? DEFAULT_COLORS[0] : DEFAULT_COLORS[2]));
      const E = engine();
      capFn = frame.capOf || (E ? (n) => E.nodeStats(n, game).cap : null);
      relayFn = E ? (n) => E.relayCharge(game, n) : null;
      capDoom = (E && E.DOOM_CHARGE_NEEDED) || 20;
      if (!cssW) resize(canvas.clientWidth || 300, canvas.clientHeight || 150, 1);
      ensureCamera(game);
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.textAlign = "center"; ctx.textBaseline = "middle"; ctx.lineJoin = "round";

      drawBackground();
      drawBoard();
      drawLanes();

      // Plane layer first: nothing flat can hide anything upright.
      for (const n of game.nodes) drawGround(n);

      // The caller's board-plane marks (selection rings, order routes)
      // sit with the ground, so stations and fleets stand over them
      // instead of being struck through. Wrapped in save/restore so a
      // caller cannot leave dash or alpha state behind for the scene.
      if (frame.underlay) { ctx.save(); frame.underlay(ctx, api.screenOf); ctx.restore(); }

      // Upright layer, painter-sorted far to near by depth of the foot.
      items.length = 0;
      for (const n of game.nodes) {
        projInto(cam, n.x, n.y, 0, P);
        items.push({ depth: P.depth, n, fleet: null });
      }
      for (const f of game.fleets) {
        const fp = {};
        if (!fleetPose(f, fp)) continue;
        projInto(cam, fp.x, fp.y, 0, P);
        items.push({ depth: P.depth - 0.5, n: null, fleet: f, fp });
      }
      items.sort((a, b) => b.depth - a.depth);
      labels.length = 0;
      for (const it of items) {
        if (it.n) drawStation(it.n); else drawFleet(it.fleet, it.fp);
      }

      // Final pass: numbers sit on top of everything, never occluded. Far
      // to near so that where two overlap the nearer one is on top.
      for (const n of game.nodes) {
        const sp = numberSpot(cam, n, _spot);
        labels.push({ x: sp.x, y: sp.y + 1, str: String(Math.floor(n.garrison)), px: sp.px, fill: "#f1f6ff", depth: sp.depth, fleet: false });
      }
      labels.sort((a, b) => b.depth - a.depth);
      ctx.globalAlpha = 1;
      for (const l of labels) text(l.str, l.x, l.y, l.px, l.fill, !l.fleet);

      // Then the caller's text and effects, over the numbers: a preview
      // pill or a floating "+5" that a station could hide is worse than
      // useless, so nothing the scene draws may cover it.
      if (frame.overlay) {
        ctx.save();
        ctx.globalAlpha = 1;
        frame.overlay(ctx, api.screenOf);
        ctx.restore();
      }
    }

    // ---- interface ------------------------------------------------------
    // `const api` is referenced by render() through the closure; it is
    // only ever called after create() has returned, so the order is safe.
    const api = {
      name: "holo",
      resize,
      render,
      pick(px, py, touch) {
        if (!lastGame) return null;
        return pick(ensureCamera(lastGame), lastGame, px, py, !!touch);
      },
      screenOf(wx, wy, wz) {
        const c = ensureCamera(lastGame);
        const p = project(c, wx, wy, wz || 0);
        return p && { x: p.x, y: p.y, scale: p.scale, depth: p.depth };
      },
      toBoard(px, py) { return toBoard(ensureCamera(lastGame), px, py); },
      camera() { return ensureCamera(lastGame); },
      orbit(dYaw) { yaw = (((yaw + dYaw) % TAU) + TAU) % TAU; },
      setYaw(y) { yaw = ((y % TAU) + TAU) % TAU; },
      getYaw() { return yaw; },
      zoomBy(f) { zoom = clamp(zoom * f, ZOOM_MIN, ZOOM_MAX); },
      setZoom(z) { zoom = clamp(z, ZOOM_MIN, ZOOM_MAX); },
      getZoom() { return zoom; }
    };
    return api;
  }

  return {
    createCamera, project, toBoard, pick, yawFacing, create,
    PICK, RADIUS, HEIGHT, SHAPE, ZOOM_MIN, ZOOM_MAX, DEFAULT_PITCH, defaultPitch, numberSpot
  };
});
