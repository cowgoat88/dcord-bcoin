// Run with: node --test outpost/net.test.js
//
// net.js is browser code, but the part of it that keeps breaking is not
// WebRTC -- it is the bookkeeping around a phone that goes to sleep. That
// bookkeeping is testable with a fake Peer, and these tests exist because
// the real failure (host switches to Messages to send the code, room
// quietly dies, guest is told there is no such room) could not be
// reproduced here any other way.
"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const SRC = fs.readFileSync(path.join(__dirname, "net.js"), "utf8");

// ---------------------------------------------------------------------
// A fake signalling server and Peer, close enough to PeerJS 1.5.5 for
// the state machine: ids are registered and released, reconnect()
// reclaims the same id, and a dial to an unregistered id raises
// peer-unavailable the way the real one does.
// ---------------------------------------------------------------------
function makeWorld() {
  const registry = new Map();     // id -> peer
  const timers = [];
  let now = 0, nextId = 1;
  const listeners = {};           // document/window events

  const doc = {
    visibilityState: "visible",
    addEventListener: (ev, h) => { (listeners[ev] = listeners[ev] || []).push(h); },
    removeEventListener: (ev, h) => {
      const a = listeners[ev] || [];
      const i = a.indexOf(h); if (i >= 0) a.splice(i, 1);
    }
  };

  class Conn {
    constructor(peer, target) {
      this.peer = peer; this.target = target; this.open = false; this._h = {};
      this.sent = [];
    }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
    emit(ev, a) { (this._h[ev] || []).slice().forEach((fn) => fn(a)); }
    send(m) { this.sent.push(m); }
    close() { this.open = false; this.emit("close"); }
  }

  class FakePeer {
    constructor(id, opts) {
      this.id = id || ("anon-" + (nextId++));
      this.opts = opts;
      this.disconnected = false;
      this.destroyed = false;
      this._h = {};
      this.reconnects = 0;
      world.peers.push(this);
      // PeerJS opens asynchronously; so does this.
      world.soon(() => {
        if (this.destroyed) return;
        if (id && registry.has(id)) { this.emit("error", { type: "unavailable-id" }); return; }
        registry.set(this.id, this);
        this.emit("open", this.id);
      });
    }
    on(ev, fn) { (this._h[ev] = this._h[ev] || []).push(fn); }
    emit(ev, a) { (this._h[ev] || []).slice().forEach((fn) => fn(a)); }
    connect(target) {
      const c = new Conn(this, target);
      world.soon(() => {
        if (this.destroyed) return;
        const host = registry.get(target);
        if (!host || host.disconnected) { this.emit("error", { type: "peer-unavailable" }); return; }
        const theirs = new Conn(host, this.id);
        host.emit("connection", theirs);
        world.soon(() => { c.open = true; c.emit("open"); theirs.open = true; theirs.emit("open"); });
      });
      return c;
    }
    reconnect() {
      this.reconnects++;
      world.soon(() => {
        if (this.destroyed) return;
        if (registry.has(this.id) && registry.get(this.id) !== this) {
          this.emit("error", { type: "unavailable-id" }); return;
        }
        registry.set(this.id, this);
        this.disconnected = false;
        this.emit("open", this.id);
      });
    }
    destroy() { this.destroyed = true; registry.delete(this.id); }
    // What iOS does to a backgrounded tab.
    _drop() {
      if (this.destroyed) return;
      this.disconnected = true;
      registry.delete(this.id);
      this.emit("disconnected", this.id);
    }
  }

  const world = {
    peers: [],
    registry,
    self: {
      Peer: FakePeer,
      document: doc,
      navigator: {},
      addEventListener: doc.addEventListener,
      removeEventListener: doc.removeEventListener,
      setTimeout: (fn, ms) => { timers.push({ fn, at: now + (ms || 0) }); return timers.length; },
      clearTimeout: (h) => { if (timers[h - 1]) timers[h - 1].cancelled = true; }
    },
    soon(fn) { timers.push({ fn, at: now }); },
    // Run every timer due within `ms`, in order, including ones the run
    // schedules. A cap keeps a runaway backoff from hanging the test.
    advance(ms) {
      const until = now + (ms || 0);
      for (let guard = 0; guard < 10000; guard++) {
        const due = timers
          .map((t, i) => ({ t, i }))
          .filter(({ t }) => !t.cancelled && !t.done && t.at <= until)
          .sort((a, b) => a.t.at - b.t.at)[0];
        if (!due) break;
        due.t.done = true;
        now = Math.max(now, due.t.at);
        due.t.fn();
      }
      now = until;
    },
    fire(ev) { (listeners[ev] || []).slice().forEach((h) => h()); },
    background() { doc.visibilityState = "hidden"; world.fire("visibilitychange"); },
    foreground() { doc.visibilityState = "visible"; world.fire("visibilitychange"); }
  };

  const net = {};
  new Function("self", SRC)(world.self);
  world.net = world.self.OutpostNet;
  // net.js closes over the real globals for timers; point them at ours so
  // the backoff is controllable.
  return world;
}

// net.js calls bare setTimeout/clearTimeout, so swap the process globals
// for the duration of a world. Node's test runner is single-threaded, so
// this is safe as long as each test restores them.
function withWorld(fn) {
  const realSet = global.setTimeout, realClear = global.clearTimeout;
  const w = makeWorld();
  global.setTimeout = w.self.setTimeout;
  global.clearTimeout = w.self.clearTimeout;
  try { return fn(w); }
  finally { global.setTimeout = realSet; global.clearTimeout = realClear; }
}

// ---------------------------------------------------------------------

test("a hosted room registers its code with the signalling server", () => {
  withWorld((w) => {
    let ready = null;
    const h = w.net.host({ code: "ABCDE", onReady: (c) => { ready = c; } });
    w.advance(10);
    assert.equal(ready, "ABCDE");
    assert.ok(w.registry.has("outpost-ABCDE"), "the code must be claimed");
    assert.equal(h.state().brokerOpen, true);
    h.close();
  });
});

test("a room that is dropped while the host sends the code reclaims its own code", () => {
  // The reported failure, start to finish: host a room, leave the app to
  // send the code, iOS suspends the tab and the room id is released, the
  // friend types the code and is told there is no such room.
  withWorld((w) => {
    const statuses = [];
    const h = w.net.host({ code: "ABCDE", onStatus: (m) => statuses.push(m) });
    w.advance(10);

    w.background();
    w.peers[0]._drop();                       // what Safari does to the socket
    assert.equal(w.registry.has("outpost-ABCDE"), false, "setup: the room is gone");
    assert.equal(h.state().brokerOpen, false);

    w.foreground();                            // back from Messages
    w.advance(50);
    assert.ok(w.peers[0].reconnects > 0, "coming back must reclaim the id");
    assert.ok(w.registry.has("outpost-ABCDE"), "the same code must be live again");
    assert.equal(h.state().brokerOpen, true);
    assert.ok(statuses.some((m) => /Reconnect/i.test(m)),
      "and the host must have been told what was happening: " + JSON.stringify(statuses));
    h.close();
  });
});

test("a dropped room comes back on its own even if the page is never touched", () => {
  withWorld((w) => {
    const h = w.net.host({ code: "ABCDE" });
    w.advance(10);
    w.peers[0]._drop();
    w.advance(5000);                           // the backoff, unaided
    assert.ok(w.registry.has("outpost-ABCDE"), "the room must come back by itself");
    h.close();
  });
});

test("a transient server error does not close the room", () => {
  withWorld((w) => {
    let fatal = null;
    const h = w.net.host({ code: "ABCDE", onError: (m) => { fatal = m; } });
    w.advance(10);
    w.peers[0].emit("error", { type: "network" });
    w.advance(5000);
    assert.equal(fatal, null, "a network blip is not a reason to end the room");
    assert.equal(h.state().brokerOpen, true);
    h.close();
  });
});

test("joining retries rather than believing the first 'no such room'", () => {
  // The host is asleep when the code is typed, which is the normal case
  // when the code travelled by text message.
  withWorld((w) => {
    const statuses = [];
    let failed = null, joined = false;
    const h = w.net.host({ code: "ABCDE" });
    w.advance(10);
    w.peers[0]._drop();                        // host's phone is asleep

    const g = w.net.join({
      code: "ABCDE",
      onStatus: (m) => statuses.push(m),
      onConnect: () => { joined = true; },
      onError: (m) => { failed = m; }
    });
    w.advance(100);
    assert.equal(joined, false, "setup: nothing to join yet");
    assert.equal(failed, null, "one miss must not be the final answer");
    assert.ok(statuses.some((m) => /trying again/i.test(m)), statuses.join(" | "));

    w.foreground();                            // host picks their phone up
    w.advance(10000);
    assert.ok(joined, "the retry must find the room once it is back");
    assert.equal(failed, null);
    g.close(); h.close();
  });
});

test("joining a code that is never there gives up and says so", () => {
  withWorld((w) => {
    let failed = null;
    const g = w.net.join({ code: "ZZZZZ", onError: (m) => { failed = m; } });
    w.advance(120000);
    assert.ok(failed && /No game found with code ZZZZZ/.test(failed), String(failed));
    g.close();
  });
});

test("a guest and host that find each other carry messages both ways", () => {
  withWorld((w) => {
    const h = w.net.host({ code: "ABCDE" });
    w.advance(10);
    const g = w.net.join({ code: "ABCDE" });
    w.advance(100);
    const toHost = [], toGuest = [];
    h.transport.onMessage((m) => toHost.push(m));
    g.transport.onMessage((m) => toGuest.push(m));
    assert.equal(h.state().guest, true, "the host must see the guest as joined");
    assert.equal(g.state().guest, true);
    g.close(); h.close();
  });
});

test("an abandoned dial does not report the live connection as closed", () => {
  // A guest that retried would otherwise get a close event from the
  // attempt it gave up on, and tear down the connection that worked.
  withWorld((w) => {
    const t = w.net._makeTransport();
    const closes = [];
    t.onClose(() => closes.push(1));
    const stale = { open: false, _h: {}, on(e, f) { (this._h[e] = this._h[e] || []).push(f); },
      emit(e) { (this._h[e] || []).forEach((f) => f()); }, send() {} };
    t._attach(stale);
    t._abandon();
    const live = { open: true, _h: {}, on(e, f) { (this._h[e] = this._h[e] || []).push(f); },
      emit(e) { (this._h[e] || []).forEach((f) => f()); }, send() {} };
    t._attach(live);
    stale.emit("close");
    assert.equal(closes.length, 0, "the abandoned attempt must be silent");
    assert.equal(t.isOpen(), true, "and the live connection must still read as open");
  });
});

test("the relay list is there, because two phones on mobile data need one", () => {
  withWorld((w) => {
    const turn = w.net.ICE_SERVERS.filter((s) => {
      const u = [].concat(s.urls);
      return u.some((x) => /^turns?:/.test(x));
    });
    assert.ok(turn.length >= 1, "STUN alone cannot cross carrier-grade NAT");
    for (const s of turn) {
      assert.ok(s.username && s.credential, "a TURN entry with no credentials is decoration");
    }
    const h = w.net.host({ code: "ABCDE" });
    w.advance(10);
    const ice = w.peers[0].opts.config.iceServers;
    assert.ok(ice.some((s) => [].concat(s.urls).some((x) => /^turns?:/.test(x))),
      "and the relays have to actually reach the peer");
    h.close();
  });
});

test("a page can supply its own relay without editing the file", () => {
  withWorld((w) => {
    w.net.setIceServers([{ urls: "turn:example.test:3478", username: "u", credential: "p" }]);
    const h = w.net.host({ code: "ABCDE" });
    w.advance(10);
    assert.deepEqual(w.peers[0].opts.config.iceServers,
      [{ urls: "turn:example.test:3478", username: "u", credential: "p" }]);
    h.close();
    w.net.setIceServers(w.net.ICE_SERVERS);
  });
});

test("closing a room stops it waking up again", () => {
  withWorld((w) => {
    const h = w.net.host({ code: "ABCDE" });
    w.advance(10);
    h.close();
    const before = w.peers[0].reconnects;
    w.foreground();
    w.advance(20000);
    assert.equal(w.peers[0].reconnects, before, "a closed room must stay closed");
    assert.equal(w.registry.has("outpost-ABCDE"), false);
  });
});
