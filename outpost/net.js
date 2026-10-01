// OUTPOST — PeerJS transport for online.js.
//
// Wraps the vendored PeerJS as the { send, onMessage, onOpen, onClose }
// shape the session protocol expects. A room code is a short id the host
// registers with the free public PeerJS signalling server; that server
// only introduces the two browsers, after which the connection is direct
// peer-to-peer. No accounts, nothing to host, no game data through any
// server.
//
// Two things about phones shape everything below.
//
// The first is that leaving the browser is part of the flow. You host a
// room, then switch to Messages to send the code. iOS suspends a
// backgrounded Safari tab within seconds: the WebSocket to the signalling
// server closes, the room id is released, and the friend who types the
// code is told there is no such room -- which is exactly the reported
// failure. PeerJS will not recover from that on its own. So every
// connection here watches for the drop, reclaims the SAME id with
// peer.reconnect(), and is kicked awake again the moment the page comes
// back to the foreground.
//
// The second is that two phones on mobile data are usually both behind
// carrier-grade NAT, where STUN alone cannot find a path. That needs a
// TURN relay, so the list below has several.
(function (root) {
  "use strict";

  const PREFIX = "outpost-";
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";  // no I/L/O/0/1
  const CODE_LEN = 5;

  // How hard to try before giving up on the signalling server.
  const REVIVE_DELAYS = [600, 1200, 2500, 5000, 8000, 12000];
  const JOIN_TRIES = 6;          // the host may be mid-reconnect
  const JOIN_RETRY_MS = 2500;
  const OPEN_TIMEOUT_MS = 20000; // ICE had its chance

  // STUN finds a direct path when there is one. TURN relays the traffic
  // when there is not, which on two phones on mobile data is most of the
  // time -- carrier-grade NAT gives both ends an address neither can
  // reach. The relays are free public ones and are listed several deep on
  // purpose: an ICE server that is down or has moved is skipped rather
  // than fatal, so a stale entry costs a little gathering time and
  // nothing else. Replace them with your own if you ever want this to
  // stop depending on somebody's goodwill.
  const ICE_SERVERS = [
    { urls: "stun:stun.l.google.com:19302" },
    { urls: "stun:stun1.l.google.com:19302" },
    { urls: "stun:stun.cloudflare.com:3478" },
    {
      urls: [
        "turn:openrelay.metered.ca:80",
        "turn:openrelay.metered.ca:443",
        "turn:openrelay.metered.ca:443?transport=tcp"
      ],
      username: "openrelayproject",
      credential: "openrelayproject"
    }
  ];
  // Swapped wholesale by setIceServers() below, so a relay of your own
  // can be dropped in from the page without touching this file.
  let iceServers = ICE_SERVERS.slice();
  function peerConfig() {
    return { config: { iceServers: iceServers, iceCandidatePoolSize: 4 } };
  }
  function setIceServers(list) {
    if (Array.isArray(list) && list.length) iceServers = list.slice();
  }

  function makeCode() {
    let s = "";
    for (let i = 0; i < CODE_LEN; i++) {
      s += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    }
    return s;
  }

  // One connection's worth of the transport contract. Buffers anything
  // sent before the channel opens so callers never have to care.
  function makeTransport() {
    const msgHandlers = [], openHandlers = [], closeHandlers = [];
    let conn = null, open = false, generation = 0;
    const queue = [];
    const t = {
      send(msg) {
        if (!conn || !open) { queue.push(msg); return; }
        try { conn.send(msg); } catch (e) { /* channel died; onClose will fire */ }
      },
      onMessage: (fn) => msgHandlers.push(fn),
      // A late subscriber still gets told the channel is open. The
      // session is constructed after the transport, so with a connection
      // that is already live (the two-tab loopback, or a peer that
      // connected quickly) the guest would otherwise never send hello
      // and simply sit there looking connected but dead.
      onOpen: (fn) => { openHandlers.push(fn); if (open) fn(); },
      onClose: (fn) => closeHandlers.push(fn),
      isOpen: () => open
    };
    function flush() {
      while (queue.length) { try { conn.send(queue.shift()); } catch (e) { break; } }
    }
    // Attaching happens more than once now: a guest retries the dial, and
    // a host whose first guest vanished can be joined again. Each attach
    // takes a generation, and a stale connection's events are ignored --
    // without that, an abandoned attempt closing later would report the
    // live one as dead.
    t._attach = function (c) {
      const mine = ++generation;
      conn = c;
      open = false;
      const live = () => mine === generation;
      c.on("open", () => {
        if (!live()) return;
        open = true;
        flush();
        openHandlers.forEach((fn) => fn());
      });
      c.on("data", (d) => { if (live()) msgHandlers.forEach((fn) => fn(d)); });
      c.on("close", () => {
        if (!live()) return;
        open = false; closeHandlers.forEach((fn) => fn());
      });
      c.on("error", () => {
        if (!live()) return;
        open = false; closeHandlers.forEach((fn) => fn());
      });
      if (c.open) { // already connected by the time we attached
        open = true;
        flush();
        openHandlers.forEach((fn) => fn());
      }
    };
    // Abandon the current connection without reporting a close: used when
    // a dial is retried, so the caller sees one outcome rather than a
    // failure for every attempt.
    t._abandon = function () { generation++; conn = null; open = false; };
    return t;
  }

  function available() {
    return typeof root.Peer === "function";
  }

  // Everything that can wake a suspended page: coming back to the
  // foreground, being restored from the back/forward cache, regaining the
  // network. A session registers for all of them and unregisters on
  // close, because a room that outlives its page is worse than no room.
  function watchWake(fn) {
    const doc = root.document;
    const handlers = [];
    function on(target, ev, h) {
      if (!target || !target.addEventListener) return;
      target.addEventListener(ev, h);
      handlers.push([target, ev, h]);
    }
    const visible = () => { if (!doc || doc.visibilityState !== "hidden") fn(); };
    on(doc, "visibilitychange", visible);
    on(root, "pageshow", visible);
    on(root, "focus", visible);
    on(root, "online", fn);
    return function stop() {
      for (const [target, ev, h] of handlers) {
        try { target.removeEventListener(ev, h); } catch (e) { /* gone */ }
      }
      handlers.length = 0;
    };
  }

  // Ask the phone not to sleep while a room is open with nobody in it.
  // A locked screen is a backgrounded tab, which is a dropped room. Best
  // effort: the API is absent on older iOS and the request can be
  // refused, and neither case is worth telling the player about.
  function keepAwake() {
    const nav = root.navigator;
    if (!nav || !nav.wakeLock || !nav.wakeLock.request) return function () {};
    let lock = null, released = false;
    function take() {
      if (released || lock) return;
      try {
        const p = nav.wakeLock.request("screen");
        if (p && p.then) {
          p.then((l) => {
            if (released) { try { l.release(); } catch (e) {} return; }
            lock = l;
            if (l.addEventListener) l.addEventListener("release", () => { lock = null; });
          }, () => {});
        }
      } catch (e) { /* refused; not worth a message */ }
    }
    take();
    const stopWatch = watchWake(take);   // iOS drops the lock on background
    return function release() {
      released = true;
      stopWatch();
      try { if (lock) lock.release(); } catch (e) { /* already gone */ }
      lock = null;
    };
  }

  // Host a room. onReady(code) fires once the signalling server has
  // accepted our id; onConnect fires when a guest actually arrives.
  function host(opts) {
    const o = opts || {};
    if (!available()) { if (o.onError) o.onError("PeerJS failed to load."); return null; }
    const code = (o.code || makeCode()).toUpperCase();
    const transport = makeTransport();
    let peer = null, destroyed = false, guestHere = false;
    let revives = 0, timer = null, idRetries = 0;
    const releaseWake = keepAwake();

    const status = (m) => { if (o.onStatus) o.onStatus(m); };

    function build() {
      peer = new root.Peer(PREFIX + code, peerConfig());
      peer.on("open", () => {
        revives = 0; idRetries = 0;
        if (o.onReady) o.onReady(code);
      });
      peer.on("connection", (c) => {
        guestHere = true;
        transport._attach(c);
        if (o.onConnect) o.onConnect();
      });
      // The drop that breaks everything. PeerJS keeps the object alive
      // but the room id is gone from the server until this reclaims it.
      peer.on("disconnected", () => {
        if (destroyed) return;
        status("Reconnecting…");
        schedule();
      });
      peer.on("close", () => { if (!destroyed) schedule(); });
      peer.on("error", (err) => {
        const type = err && err.type;
        if (destroyed) return;
        // The signalling server can hold a just-released id for a while:
        // the room we are reclaiming is usually our own, from before the
        // phone went to sleep.
        if (type === "unavailable-id") {
          if (idRetries++ < 12) {
            status("Reclaiming room code…");
            later(() => { rebuild(); }, 5000);
          } else if (o.onError) {
            o.onError("Room code " + code + " is still held. Try hosting again.");
          }
          return;
        }
        // Transient, and recoverable: do not tear the room down over it.
        if (type === "network" || type === "socket-error" ||
            type === "socket-closed" || type === "server-error") {
          status("Reconnecting…");
          schedule();
          return;
        }
        // A guest that walked away is the session's business, not a
        // reason to close the room.
        if (type === "peer-unavailable") return;
        if (o.onError) o.onError(describe(err));
      });
    }

    function later(fn, ms) {
      if (timer) { clearTimeout(timer); }
      timer = setTimeout(() => { timer = null; fn(); }, ms);
    }

    function rebuild() {
      if (destroyed) return;
      try { if (peer) peer.destroy(); } catch (e) { /* already gone */ }
      build();
    }

    function revive() {
      if (destroyed) return;
      if (!peer || peer.destroyed) { rebuild(); return; }
      if (!peer.disconnected) return;          // already back
      try { peer.reconnect(); } catch (e) { rebuild(); }
    }

    function schedule() {
      if (destroyed) return;
      const wait = REVIVE_DELAYS[Math.min(revives, REVIVE_DELAYS.length - 1)];
      revives++;
      later(revive, wait);
    }

    // Coming back to the foreground is the one moment we know the phone
    // is awake, so retry immediately rather than waiting out a backoff
    // that was itself asleep.
    const stopWake = watchWake(() => {
      if (destroyed) return;
      revives = 0;
      if (timer) { clearTimeout(timer); timer = null; }
      revive();
    });

    build();

    return {
      code,
      transport,
      // For the screen, and for anyone trying to work out what went
      // wrong on somebody else's phone.
      state() {
        return {
          role: "host",
          code,
          brokerOpen: !!(peer && !peer.disconnected && !peer.destroyed),
          guest: guestHere && transport.isOpen(),
          retries: revives
        };
      },
      wake: revive,
      close() {
        destroyed = true;
        if (timer) { clearTimeout(timer); timer = null; }
        stopWake();
        releaseWake();
        try { if (peer) peer.destroy(); } catch (e) { /* already gone */ }
      }
    };
  }

  // Join a room by code.
  function join(opts) {
    const o = opts || {};
    if (!available()) { if (o.onError) o.onError("PeerJS failed to load."); return null; }
    const code = String(o.code || "").trim().toUpperCase();
    if (!code) { if (o.onError) o.onError("Enter a room code."); return null; }
    const transport = makeTransport();
    let peer = null, destroyed = false, connected = false, givenUp = false;
    let tries = 0, timer = null, openTimer = null;

    const status = (m) => { if (o.onStatus) o.onStatus(m); };

    function later(fn, ms) {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => { timer = null; fn(); }, ms);
    }

    // One dial. The host's phone may be asleep between the code being
    // sent and the code being typed, so a single "no such room" is not
    // an answer -- it is the most likely state of a room that is about
    // to come back.
    function dial() {
      if (destroyed || connected || givenUp) return;
      tries++;
      if (!peer || peer.destroyed) { build(); return; }
      if (peer.disconnected) { try { peer.reconnect(); } catch (e) { build(); } return; }
      let c = null;
      try { c = peer.connect(PREFIX + code, { reliable: true }); } catch (e) { c = null; }
      if (!c) { retry("Could not reach that room."); return; }
      transport._abandon();
      transport._attach(c);
      c.on("open", () => {
        connected = true;
        if (openTimer) { clearTimeout(openTimer); openTimer = null; }
        if (timer) { clearTimeout(timer); timer = null; }
        if (o.onConnect) o.onConnect();
      });
      // Signalling can succeed and the media path still never form --
      // that is the two-phones-on-mobile-data case, and without this it
      // just hangs on "Connecting" forever.
      if (openTimer) clearTimeout(openTimer);
      openTimer = setTimeout(() => {
        openTimer = null;
        if (connected || destroyed) return;
        retry("Could not open a route to that room.");
      }, OPEN_TIMEOUT_MS);
    }

    // Each attempt can fail twice -- the dial is refused, and then the
    // watchdog for that same dial fires -- so the giving-up message is
    // said once or the player reads the wrong reason.
    function retry(finalMsg) {
      if (destroyed || connected || givenUp) return;
      if (openTimer) { clearTimeout(openTimer); openTimer = null; }
      if (tries >= JOIN_TRIES) {
        givenUp = true;
        if (o.onError) o.onError(finalMsg);
        return;
      }
      status("Room " + code + " did not answer — trying again ("
        + tries + "/" + JOIN_TRIES + ")…");
      later(dial, JOIN_RETRY_MS);
    }

    function build() {
      peer = new root.Peer(null, peerConfig());
      peer.on("open", () => { dial(); });
      peer.on("disconnected", () => {
        if (destroyed || connected) return;
        try { peer.reconnect(); } catch (e) { /* rebuilt on next dial */ }
      });
      peer.on("error", (err) => {
        const type = err && err.type;
        if (destroyed || givenUp) return;
        if (type === "peer-unavailable") {
          retry("No game found with code " + code + ". Ask them to re-open "
            + "the room — a phone that has been away from the game for a "
            + "while loses the code.");
          return;
        }
        if (type === "network" || type === "socket-error" ||
            type === "socket-closed" || type === "server-error") {
          retry("Could not reach the matchmaking server.");
          return;
        }
        if (o.onError) o.onError(describe(err));
      });
    }

    const stopWake = watchWake(() => {
      if (destroyed || connected || givenUp) return;
      dial();
    });

    build();

    return {
      code,
      transport,
      state() {
        return {
          role: "guest",
          code,
          brokerOpen: !!(peer && !peer.disconnected && !peer.destroyed),
          guest: connected && transport.isOpen(),
          retries: tries
        };
      },
      wake: dial,
      close() {
        destroyed = true;
        if (timer) { clearTimeout(timer); timer = null; }
        if (openTimer) { clearTimeout(openTimer); openTimer = null; }
        stopWake();
        try { if (peer) peer.destroy(); } catch (e) { /* already gone */ }
      }
    };
  }

  function describe(err) {
    const type = (err && err.type) || "";
    if (type === "network") return "Lost contact with the matchmaking server.";
    if (type === "browser-incompatible") return "This browser can't do peer-to-peer.";
    if (type === "disconnected") return "Disconnected from the matchmaking server.";
    if (type === "server-error") return "The matchmaking server is unavailable.";
    if (type === "webrtc") return "This device refused the peer connection.";
    return (err && err.message) || "Connection failed.";
  }

  // A transport over BroadcastChannel: two tabs of the same browser,
  // no signalling server, no internet. It exists because it is the only
  // way to exercise the whole online stack — protocol, seats, order
  // routing, rendering — without a second person and a working peer
  // connection, and it is genuinely useful for a quick hot-seat-ish game
  // on one machine.
  function localPair(opts) {
    const o = opts || {};
    if (typeof root.BroadcastChannel !== "function") {
      if (o.onError) o.onError("This browser has no BroadcastChannel.");
      return null;
    }
    const code = (o.code || "LOCAL").toUpperCase();
    const role = o.role === "guest" ? "guest" : "host";
    const ch = new root.BroadcastChannel("outpost-local-" + code);
    const transport = makeTransport();
    // Stand in for a PeerJS DataConnection.
    const fake = {
      open: true,
      _h: {},
      on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); },
      send(msg) { ch.postMessage({ from: role, payload: msg }); },
      _emit(ev, arg) { (this._h[ev] || []).forEach((fn) => fn(arg)); }
    };
    ch.onmessage = (e) => {
      const d = e.data;
      if (!d || d.from === role) return;      // ignore our own echo
      fake._emit("data", d.payload);
    };
    transport._attach(fake);
    setTimeout(() => { if (o.onConnect) o.onConnect(); }, 0);
    return {
      code, transport,
      state() { return { role, code, brokerOpen: true, guest: true, retries: 0 }; },
      wake() {},
      close() { try { ch.close(); } catch (e) { /* already closed */ } }
    };
  }

  root.OutpostNet = {
    host, join, localPair, makeCode, available, PREFIX,
    ICE_SERVERS, setIceServers, _makeTransport: makeTransport
  };
})(typeof self !== "undefined" ? self : this);
