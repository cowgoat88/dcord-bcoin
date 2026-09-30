// OUTPOST — PeerJS transport for online.js.
//
// Wraps the vendored PeerJS as the { send, onMessage, onOpen, onClose }
// shape the session protocol expects. A room code is a short id the host
// registers with the free public PeerJS signalling server; that server
// only introduces the two browsers, after which the connection is direct
// peer-to-peer. No accounts, nothing to host, no game data through any
// server.
(function (root) {
  "use strict";

  const PREFIX = "outpost-";
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";  // no I/L/O/0/1
  const CODE_LEN = 5;
  // Google's free STUN servers, for NAT traversal only.
  const PEER_CONFIG = {
    config: {
      iceServers: [
        { urls: "stun:stun.l.google.com:19302" },
        { urls: "stun:stun1.l.google.com:19302" }
      ]
    }
  };

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
    let conn = null, open = false;
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
      onClose: (fn) => closeHandlers.push(fn)
    };
    t._attach = function (c) {
      conn = c;
      open = false;
      c.on("open", () => {
        open = true;
        while (queue.length) { try { conn.send(queue.shift()); } catch (e) { break; } }
        openHandlers.forEach((fn) => fn());
      });
      c.on("data", (d) => msgHandlers.forEach((fn) => fn(d)));
      c.on("close", () => { open = false; closeHandlers.forEach((fn) => fn()); });
      c.on("error", () => { open = false; closeHandlers.forEach((fn) => fn()); });
      if (c.open) { // already connected by the time we attached
        open = true;
        while (queue.length) { try { conn.send(queue.shift()); } catch (e) { break; } }
        openHandlers.forEach((fn) => fn());
      }
    };
    return t;
  }

  function available() {
    return typeof root.Peer === "function";
  }

  // Host a room. onReady(code) fires once the signalling server has
  // accepted our id; onConnect fires when a guest actually arrives.
  function host(opts) {
    const o = opts || {};
    if (!available()) { if (o.onError) o.onError("PeerJS failed to load."); return null; }
    const code = (o.code || makeCode()).toUpperCase();
    const transport = makeTransport();
    let peer = null, destroyed = false;

    function start(attempt) {
      peer = new root.Peer(PREFIX + code, PEER_CONFIG);
      peer.on("open", () => { if (o.onReady) o.onReady(code); });
      peer.on("connection", (c) => {
        transport._attach(c);
        if (o.onConnect) o.onConnect();
      });
      peer.on("error", (err) => {
        const type = err && err.type;
        // The signalling server can hold a just-released id for a while;
        // retry rather than telling the player the code is broken.
        if (type === "unavailable-id" && !destroyed && attempt < 12) {
          setTimeout(() => start(attempt + 1), 5000);
          if (o.onStatus) o.onStatus("Reclaiming room code…");
          return;
        }
        if (o.onError) o.onError(describe(err));
      });
    }
    start(0);

    return {
      code,
      transport,
      close() {
        destroyed = true;
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
    let peer = null, destroyed = false;

    peer = new root.Peer(null, PEER_CONFIG);
    peer.on("open", () => {
      const c = peer.connect(PREFIX + code, { reliable: true });
      if (!c) { if (o.onError) o.onError("Could not reach that room."); return; }
      transport._attach(c);
      if (o.onConnect) o.onConnect();
    });
    peer.on("error", (err) => {
      const type = err && err.type;
      if (type === "peer-unavailable") {
        if (o.onError) o.onError("No game found with code " + code + ".");
        return;
      }
      if (!destroyed && o.onError) o.onError(describe(err));
    });

    return {
      code,
      transport,
      close() {
        destroyed = true;
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
      close() { try { ch.close(); } catch (e) { /* already closed */ } }
    };
  }

  root.OutpostNet = { host, join, localPair, makeCode, available, PREFIX };
})(typeof self !== "undefined" ? self : this);
