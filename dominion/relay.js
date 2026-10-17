// DOOMSTAR: DOMINION — phone-to-phone over a public message relay.
//
// Two phones on mobile data usually cannot reach each other directly:
// carrier-grade NAT hides both, and a peer-to-peer connection then needs a
// TURN relay. The free one OUTPOST's net.js relied on stopped accepting its
// shared login, so the phones could be introduced ("connected") and still
// never exchange a byte. This goes the other way round: both phones open an
// ordinary secure WebSocket to a public MQTT broker (port 443-style TLS,
// which every cellular network allows) and pass messages through it on a
// topic named after the room.
//
// It has the same shape as net.js -- host({...}) / join({...}) returning
// { code, transport, state(), wake(), close() }, and a transport with
// send / onMessage / onOpen / onClose / isOpen -- so online.js's hostStore
// and guestStore run on it unchanged.
//
// Messages can be lost (the brokers deliver at most once, and a phone that
// is asleep misses what was sent meanwhile). The game protocol already
// lives with that: every request is resent until answered and is safe to
// repeat, and the guest asks whether the game has started.
//
// What passes through the broker: requests and answers between the two
// phones. The host's orders never leave the host's phone until both have
// locked; the guest's orders are sent to the host. Public brokers are
// public, so treat a room like a conversation in a busy cafe: nobody is
// listening for it, but it is not secret.
(function (root) {
  "use strict";

  // Public brokers, tried in this order. The room code carries which one
  // the host used, so both phones always meet on the same broker.
  const BROKERS = [
    "wss://broker.emqx.io:8084/mqtt",
    "wss://broker.hivemq.com:8884/mqtt",
    "wss://test.mosquitto.org:8081/mqtt"
  ];
  const TOPIC = "doomstar-dominion/v1/";
  const CODE_CHARS = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";  // no I/L/O/0/1
  const CONNECT_TIMEOUT_MS = 8000;
  const KNOCK_MS = 1500;

  // For tests and for anyone running their own broker.
  function brokers() {
    try {
      const own = root.localStorage && root.localStorage.getItem("dominion.brokers");
      if (own) return JSON.parse(own);
    } catch (e) { /* none */ }
    return BROKERS;
  }
  function available() { return typeof root.mqtt === "object" && typeof root.mqtt.connect === "function"; }

  // Five characters: four random, the last says which broker.
  function makeCode(brokerIndex) {
    let c = "";
    for (let i = 0; i < 4; i++) c += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
    return c + CODE_CHARS[brokerIndex % CODE_CHARS.length];
  }
  function brokerOf(code) {
    const i = CODE_CHARS.indexOf(String(code).slice(-1).toUpperCase());
    return i >= 0 && i < brokers().length ? i : 0;
  }

  function makeTransport(publish) {
    const msgHandlers = [], openHandlers = [], closeHandlers = [];
    let open = false;
    const queue = [];
    const t = {
      send(msg) { if (!open) { queue.push(msg); return; } publish(msg); },
      onMessage: (fn) => msgHandlers.push(fn),
      onOpen: (fn) => { openHandlers.push(fn); if (open) fn(); },
      onClose: (fn) => closeHandlers.push(fn),
      isOpen: () => open
    };
    t._open = () => {
      if (open) return;
      open = true;
      while (queue.length) publish(queue.shift());
      openHandlers.forEach((fn) => fn());
    };
    t._close = () => { if (!open) return; open = false; closeHandlers.forEach((fn) => fn()); };
    t._deliver = (m) => msgHandlers.forEach((fn) => fn(m));
    return t;
  }

  // Connect to one broker, falling through the list if it does not answer.
  // fixed: only this broker (the guest must use the host's).
  function connectBroker(start, fixed, status, onConnected, onFail) {
    const list = brokers();
    let i = start, client = null, done = false;
    function attempt() {
      const url = list[i];
      status("Reaching the relay…");
      try {
        client = root.mqtt.connect(url, {
          clientId: "dmn-" + Math.random().toString(36).slice(2, 12),
          clean: true, keepalive: 30, reconnectPeriod: 1500, connectTimeout: CONNECT_TIMEOUT_MS,
          protocolVersion: 4
        });
      } catch (e) { next(); return; }
      const timer = setTimeout(() => { if (!done) { try { client.end(true); } catch (e) { /* gone */ } next(); } }, CONNECT_TIMEOUT_MS + 500);
      client.once("connect", () => { if (done) return; done = true; clearTimeout(timer); onConnected(client, i); });
      client.once("error", () => { /* the timer moves on */ });
    }
    function next() {
      if (done) return;
      if (fixed || ++i >= list.length) { done = true; onFail("Could not reach the relay. Check the phone has a data connection and try again."); return; }
      attempt();
    }
    attempt();
  }

  // Host a room: subscribe to our inbox, answer a guest's knock, then pass
  // messages both ways.
  function host(opts) {
    const o = opts || {};
    const status = (m) => { if (o.onStatus) o.onStatus(m); };
    if (!available()) { if (o.onError) o.onError("The relay library did not load."); return null; }
    let client = null, code = null, closed = false, guestId = null;
    const transport = makeTransport((m) => { if (client && code) client.publish(TOPIC + code + "/g", JSON.stringify({ k: "d", p: m })); });
    const api = {
      get code() { return code; },
      transport,
      state() { return { role: "host", code, brokerOpen: !!(client && client.connected), guest: transport.isOpen() }; },
      wake() { if (client && !client.connected) { try { client.reconnect(); } catch (e) { /* retries itself */ } } },
      close() { closed = true; try { if (client) client.end(true); } catch (e) { /* gone */ } }
    };
    connectBroker(0, false, status, (c, bi) => {
      if (closed) { c.end(true); return; }
      client = c;
      code = (o.code || makeCode(bi)).toUpperCase();
      c.subscribe(TOPIC + code + "/h", { qos: 0 }, (err) => {
        if (err) { if (o.onError) o.onError("The relay refused the room. Try again."); return; }
        if (o.onReady) o.onReady(code);
      });
      c.on("message", (topic, buf) => {
        let m; try { m = JSON.parse(String(buf)); } catch (e) { return; }
        if (!m) return;
        if (m.k === "knock") {
          // A guest (or the same guest again after a drop) is here.
          const first = !transport.isOpen();
          guestId = m.from;
          c.publish(TOPIC + code + "/g", JSON.stringify({ k: "welcome" }));
          transport._open();
          if (first && o.onConnect) o.onConnect();
        } else if (m.k === "d") {
          if (!transport.isOpen()) transport._open();
          transport._deliver(m.p);
        }
      });
      c.on("offline", () => status("Lost the relay — reconnecting…"));
      c.on("reconnect", () => status("Reconnecting to the relay…"));
      c.on("connect", () => { if (code) c.subscribe(TOPIC + code + "/h", { qos: 0 }); });
    }, (msg) => { if (o.onError) o.onError(msg); });
    return api;
  }

  // Join a room: subscribe to the guest inbox and knock until the host
  // answers. Knocks continue after a drop, so a phone that slept finds its
  // way back.
  function join(opts) {
    const o = opts || {};
    const status = (m) => { if (o.onStatus) o.onStatus(m); };
    if (!available()) { if (o.onError) o.onError("The relay library did not load."); return null; }
    const code = String(o.code || "").trim().toUpperCase();
    if (!code) { if (o.onError) o.onError("Enter a room code."); return null; }
    const me = "g-" + Math.random().toString(36).slice(2, 10);
    let client = null, closed = false, knocker = null, welcomed = false, lastHeard = 0;
    const transport = makeTransport((m) => { if (client) client.publish(TOPIC + code + "/h", JSON.stringify({ k: "d", p: m, from: me })); });
    function knock() {
      if (closed || !client || !client.connected) return;
      client.publish(TOPIC + code + "/h", JSON.stringify({ k: "knock", from: me }));
    }
    function startKnocking() {
      if (knocker) return;
      knock();
      let tries = 0;
      knocker = setInterval(() => {
        if (transport.isOpen()) { clearInterval(knocker); knocker = null; return; }
        tries++;
        if (tries === 8 && !welcomed) status("No answer from room " + code + " yet. Is the other phone on the game screen with the room open?");
        knock();
      }, KNOCK_MS);
    }
    const api = {
      code, transport,
      state() { return { role: "guest", code, brokerOpen: !!(client && client.connected), guest: transport.isOpen() }; },
      wake() { if (client && !client.connected) { try { client.reconnect(); } catch (e) { /* retries itself */ } } else if (!transport.isOpen()) startKnocking(); },
      close() { closed = true; if (knocker) clearInterval(knocker); try { if (client) client.end(true); } catch (e) { /* gone */ } }
    };
    connectBroker(brokerOf(code), true, status, (c) => {
      if (closed) { c.end(true); return; }
      client = c;
      c.subscribe(TOPIC + code + "/g", { qos: 0 }, (err) => {
        if (err) { if (o.onError) o.onError("The relay refused the room. Try again."); return; }
        status("Knocking on room " + code + "…");
        startKnocking();
      });
      c.on("message", (topic, buf) => {
        let m; try { m = JSON.parse(String(buf)); } catch (e) { return; }
        if (!m) return;
        lastHeard = Date.now();
        if (m.k === "welcome") {
          welcomed = true;
          const first = !transport.isOpen();
          transport._open();
          if (first && o.onConnect) o.onConnect();
        } else if (m.k === "d") {
          if (!transport.isOpen()) transport._open();
          transport._deliver(m.p);
        }
      });
      c.on("offline", () => { transport._close(); status("Lost the relay — reconnecting…"); });
      // Back online: resubscribe and knock until the host answers again.
      c.on("connect", () => { c.subscribe(TOPIC + code + "/g", { qos: 0 }); if (!transport.isOpen()) startKnocking(); });
    }, (msg) => { if (o.onError) o.onError(msg); });
    // iPhone Safari freezes a page in the background; when it comes back,
    // nudge the connection rather than waiting out a backoff.
    if (root.document) root.document.addEventListener("visibilitychange", () => { if (!root.document.hidden) api.wake(); });
    return api;
  }

  root.DominionRelay = { host, join, available, makeCode, brokerOf, BROKERS, TOPIC };
})(typeof self !== "undefined" ? self : this);
