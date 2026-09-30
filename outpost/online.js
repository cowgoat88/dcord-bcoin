// OUTPOST — host-authoritative online session protocol.
//
// The host's browser is the only copy of the truth: it runs the
// simulation, validates every order (its own and the guest's, through
// applyOrderAs with a seat the connection decides), and broadcasts a
// state snapshot on a timer. The guest never advances the simulation
// itself — it renders the last snapshot it was sent — so the two copies
// cannot drift apart and rejoining is just "send the latest snapshot".
//
// Unlike a turn-based game, a real-time one cannot snapshot only after
// an action: nothing would move between orders. The host therefore
// broadcasts at a fixed rate, and because the whole mutable state
// serialises to around half a kilobyte that costs a few KB/s.
//
// The transport is injected ({ send, onMessage, onOpen, onClose }) so the
// protocol can be tested over an in-memory loopback with no networking
// involved. net.js supplies the real one.
(function (root, factory) {
  if (typeof module !== "undefined" && module.exports) {
    module.exports = factory();
  } else {
    root.OutpostOnline = factory();
  }
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const PROTOCOL_VERSION = 1;
  const HOST_SEAT = 1;    // engine PLAYER
  const GUEST_SEAT = 2;   // engine ENEMY
  const SNAPSHOT_HZ = 12;
  const PING_INTERVAL = 4000;
  const TIMEOUT = 15000;

  function randomToken() {
    let s = "";
    for (let i = 0; i < 16; i++) s += Math.floor(Math.random() * 36).toString(36);
    return s;
  }

  // ---- host -----------------------------------------------------------
  // opts: { engine, game, transport, onGuest, onError, now }
  function createHost(opts) {
    const E = opts.engine;
    const transport = opts.transport;
    const now = opts.now || (() => Date.now());
    let game = opts.game;
    let guest = null;           // { token, name, lastSeen }
    let lastBroadcast = 0;
    let closed = false;

    function send(msg) {
      msg.v = PROTOCOL_VERSION;
      transport.send(msg);
    }

    function welcomePayload(token) {
      return {
        type: "welcome",
        token: token,
        seat: GUEST_SEAT,
        // The guest rebuilds the identical board from these three values
        // rather than being shipped any geometry.
        seed: game.seed,
        mapW: game.mapW,
        mapH: game.mapH,
        snapshot: E.serializeState(game)
      };
    }

    function broadcast(force) {
      if (!guest || closed) return;
      const t = now();
      if (!force && t - lastBroadcast < 1000 / SNAPSHOT_HZ) return;
      lastBroadcast = t;
      send({ type: "state", snapshot: E.serializeState(game) });
    }

    transport.onMessage(function (msg) {
      if (closed || !msg || msg.v !== PROTOCOL_VERSION) {
        if (msg && msg.v !== PROTOCOL_VERSION) send({ type: "reject", error: "version-mismatch" });
        return;
      }
      if (msg.type === "hello") {
        // A rejoin presents the token from its first welcome. A different
        // token while someone is already connected is a third party.
        if (guest && msg.token !== guest.token) {
          send({ type: "reject", error: "room-full" });
          return;
        }
        guest = { token: (guest && guest.token) || randomToken(), name: msg.name || "Guest", lastSeen: now() };
        send(welcomePayload(guest.token));
        if (opts.onGuest) opts.onGuest(guest, true);
        return;
      }
      if (!guest) return;
      guest.lastSeen = now();
      if (msg.type === "order") {
        const reason = E.applyOrderAs(game, msg.order, GUEST_SEAT);
        if (reason) send({ type: "reject", error: reason, ref: msg.ref });
        broadcast(true);        // answer an order immediately, don't wait for the tick
      } else if (msg.type === "ping") {
        send({ type: "pong" });
      } else if (msg.type === "bye") {
        guest = null;
        if (opts.onGuest) opts.onGuest(null, false);
      }
    });

    transport.onClose(function () {
      if (opts.onGuest) opts.onGuest(null, false);
    });

    return {
      role: "host",
      seat: HOST_SEAT,
      isConnected: () => !!guest && now() - guest.lastSeen < TIMEOUT,
      hasGuest: () => !!guest,
      // Called every frame by the host's game loop, after it has stepped
      // its own simulation.
      tick: () => broadcast(false),
      pushNow: () => broadcast(true),
      setGame: (g) => { game = g; broadcast(true); },
      // A fresh match: the guest is told to rebuild from the new seed.
      restart: (g) => {
        game = g;
        if (guest) send(welcomePayload(guest.token));
      },
      close: () => { closed = true; try { send({ type: "bye" }); } catch (e) { /* gone */ } }
    };
  }

  // ---- guest ----------------------------------------------------------
  // opts: { engine, transport, onWelcome, onState, onReject, onStatus, now }
  function createGuest(opts) {
    const transport = opts.transport;
    const now = opts.now || (() => Date.now());
    let token = opts.token || null;
    let lastSeen = now();
    let closed = false;
    let pingTimer = null;

    function send(msg) {
      msg.v = PROTOCOL_VERSION;
      transport.send(msg);
    }

    transport.onOpen(function () {
      send({ type: "hello", name: opts.name || "Guest", token: token });
      if (!pingTimer && typeof setInterval === "function") {
        pingTimer = setInterval(() => { if (!closed) send({ type: "ping" }); }, PING_INTERVAL);
        // A keep-alive must not keep the host process alive: under Node
        // (the protocol tests) an un-unref'd interval hangs the test
        // runner forever. Browsers have no unref and ignore this.
        if (pingTimer && typeof pingTimer.unref === "function") pingTimer.unref();
      }
    });

    transport.onMessage(function (msg) {
      if (closed || !msg || msg.v !== PROTOCOL_VERSION) return;
      lastSeen = now();
      if (msg.type === "welcome") {
        token = msg.token;
        if (opts.onWelcome) opts.onWelcome(msg);
      } else if (msg.type === "state") {
        if (opts.onState) opts.onState(msg.snapshot);
      } else if (msg.type === "reject") {
        if (opts.onReject) opts.onReject(msg.error, msg.ref);
      } else if (msg.type === "bye") {
        if (opts.onStatus) opts.onStatus("host-left");
      }
    });

    transport.onClose(function () {
      if (opts.onStatus) opts.onStatus("disconnected");
    });

    return {
      role: "guest",
      seat: GUEST_SEAT,
      getToken: () => token,
      isConnected: () => !closed && now() - lastSeen < TIMEOUT,
      // The guest never applies an order locally — it asks, and waits for
      // the snapshot. Fleets take seconds to cross the map, so the round
      // trip is invisible, and it makes divergence impossible by design.
      sendOrder: (order, ref) => send({ type: "order", order: order, ref: ref }),
      close: () => {
        closed = true;
        if (pingTimer) clearInterval(pingTimer);
        try { send({ type: "bye" }); } catch (e) { /* gone */ }
      }
    };
  }

  // An in-memory transport pair, used by the tests and handy for local
  // two-window play without any networking at all.
  function loopback() {
    const a = {}, b = {};
    function wire(self, other) {
      self._msg = []; self._open = []; self._close = [];
      self.send = (m) => {
        // Structured-clone the way a real datachannel would, so a test
        // cannot accidentally pass a live object reference between peers.
        const copy = JSON.parse(JSON.stringify(m));
        (other._msg || []).forEach((fn) => fn(copy));
      };
      self.onMessage = (fn) => self._msg.push(fn);
      self.onOpen = (fn) => self._open.push(fn);
      self.onClose = (fn) => self._close.push(fn);
      self.fireOpen = () => self._open.forEach((fn) => fn());
      self.fireClose = () => self._close.forEach((fn) => fn());
    }
    wire(a, b); wire(b, a);
    return { a, b };
  }

  return {
    PROTOCOL_VERSION, HOST_SEAT, GUEST_SEAT, SNAPSHOT_HZ,
    createHost, createGuest, loopback
  };
});
