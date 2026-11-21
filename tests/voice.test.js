"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  ActivityDetector,
  VoiceActivitySession,
  SENSITIVITIES,
  SPEECH_START_MS,
  SILENCE_PAUSE_MS
} = require("../voice.js");

const flush = () => new Promise((resolve) => setImmediate(resolve));

function makeTrack() {
  const target = new EventTarget();
  target.readyState = "live";
  target.stopCalls = 0;
  target.stop = () => {
    target.stopCalls += 1;
    target.readyState = "ended";
  };
  target.endUnexpectedly = () => {
    target.readyState = "ended";
    target.dispatchEvent(new Event("ended"));
  };
  return target;
}

function makeStream() {
  const track = makeTrack();
  return { track, stream: { getTracks: () => [track] } };
}

function makeHarness(options = {}) {
  const calls = [];
  const intervals = new Map();
  const cleared = [];
  let intervalId = 0;
  let now = 0;
  let currentRms = 0;
  const contexts = [];
  const nodes = [];

  class MockContext extends EventTarget {
    constructor() {
      super();
      this.state = "suspended";
      this.closeCalls = 0;
      contexts.push(this);
      calls.push("context");
    }

    resume() {
      calls.push("resume");
      if (options.deferResume) {
        return new Promise((resolve, reject) => {
          this.resolveResume = () => {
            if (this.state !== "closed") this.state = "running";
            resolve();
          };
          this.rejectResume = () => reject(new Error("injected resume failure"));
        });
      }
      if (options.resumeReject) {
        return Promise.reject(new Error("injected resume failure"));
      }
      this.state = "running";
      return Promise.resolve();
    }

    close() {
      this.closeCalls += 1;
      this.state = "closed";
      this.dispatchEvent(new Event("statechange"));
      return Promise.resolve();
    }

    createMediaStreamSource() {
      const node = { connected: false, disconnected: false, connect: () => { node.connected = true; }, disconnect: () => { node.disconnected = true; } };
      nodes.push(node);
      return node;
    }

    createAnalyser() {
      calls.push("analyser");
      const node = {
        fftSize: 0,
        smoothingTimeConstant: -1,
        disconnected: false,
        getFloatTimeDomainData(buffer) {
          for (let index = 0; index < buffer.length; index += 1) {
            buffer[index] = index % 2 === 0 ? currentRms : -currentRms;
          }
        },
        disconnect() { node.disconnected = true; }
      };
      nodes.push(node);
      return node;
    }

    interrupt() {
      this.state = "interrupted";
      this.dispatchEvent(new Event("statechange"));
    }
  }

  const streamFactory = options.streamFactory || (() => Promise.resolve(makeStream().stream));
  const win = {
    isSecureContext: options.secure !== false,
    AudioContext: options.noAudioContext ? undefined : MockContext,
    performance: { now: () => now },
    setInterval(callback) {
      intervalId += 1;
      intervals.set(intervalId, callback);
      return intervalId;
    },
    clearInterval(id) {
      cleared.push(id);
      intervals.delete(id);
    }
  };
  const nav = {
    mediaDevices: {
      getUserMedia() {
        calls.push("getUserMedia");
        return streamFactory();
      }
    }
  };
  return {
    calls,
    contexts,
    nodes,
    intervals,
    cleared,
    win,
    nav,
    setRms(value) { currentRms = value; },
    advance(milliseconds, session) {
      const end = now + milliseconds;
      while (now < end) {
        now = Math.min(end, now + 50);
        if (session) session.sample();
      }
    }
  };
}

test("detector exposes exactly three sensitivities and rejects unknown values", () => {
  assert.deepEqual(Object.keys(SENSITIVITIES), ["low", "normal", "high"]);
  const detector = new ActivityDetector();
  assert.equal(detector.sensitivity, "normal");
  const normalThreshold = detector.thresholds().on;
  detector.setSensitivity("high");
  assert.equal(detector.sensitivity, "high");
  assert.ok(detector.thresholds().on < normalThreshold);
  detector.setSensitivity("low");
  assert.ok(detector.thresholds().on > normalThreshold);
  assert.throws(() => detector.setSensitivity("ultra"), /Unknown voice sensitivity/);
});

test("detector requires sustained speech and silence, with hysteresis", () => {
  const detector = new ActivityDetector("normal");
  detector.update(0, 0);
  let now = 50;
  for (; now < SPEECH_START_MS; now += 50) {
    assert.equal(detector.update(0.1, now), false);
  }
  assert.equal(detector.update(0.1, SPEECH_START_MS), false);
  assert.equal(detector.update(0.1, SPEECH_START_MS + 50), true);

  const betweenThresholds = (detector.thresholds().on + detector.thresholds().off) / 2;
  now += 50;
  for (let count = 0; count < 30; count += 1) {
    assert.equal(detector.update(betweenThresholds, now), true);
    now += 50;
  }

  const silenceStarted = now;
  let stoppedAfter = null;
  for (; now <= silenceStarted + 1200; now += 50) {
    if (!detector.update(0, now)) {
      stoppedAfter = now - silenceStarted;
      break;
    }
  }
  assert.ok(stoppedAfter !== null, "silence stops the gate");
  assert.ok(stoppedAfter >= SILENCE_PAUSE_MS && stoppedAfter <= 800, `stop took ${stoppedAfter} ms`);
});

test("detector adapts its noise floor during a constant non-speech control", () => {
  const detector = new ActivityDetector("normal");
  let activations = 0;
  let wasActive = false;
  for (let now = 0; now <= 10000; now += 50) {
    const active = detector.update(0.03, now);
    if (active && !wasActive) activations += 1;
    wasActive = active;
  }
  assert.equal(detector.active, false);
  assert.ok(activations <= 1, "constant noise must not repeatedly restart the gate");
  const quiet = new ActivityDetector("normal");
  for (let now = 0; now <= 5000; now += 50) {
    assert.equal(quiet.update(0.001, now), false);
  }
});

test("session construction is inert and enable owns one graph and one timer", async () => {
  const harness = makeHarness();
  const statuses = [];
  const session = new VoiceActivitySession({ window: harness.win, navigator: harness.nav, onStatus: (event) => statuses.push(event.status) });
  assert.deepEqual(harness.calls, []);
  session.enable();
  await flush();
  assert.deepEqual(harness.calls.slice(0, 3), ["context", "resume", "getUserMedia"]);
  assert.equal(session.enabled, true);
  assert.equal(harness.intervals.size, 1);
  assert.equal(session.shouldScroll, false);
  harness.setRms(0.1);
  harness.advance(250, session);
  assert.equal(session.shouldScroll, true);
  harness.setRms(0);
  harness.advance(900, session);
  assert.equal(session.shouldScroll, false);
  session.disable();
  assert.equal(session.enabled, false);
  assert.equal(harness.intervals.size, 0);
  assert.equal(harness.contexts[0].state, "closed");
  assert.ok(harness.nodes.every((node) => node.disconnected));
  assert.deepEqual(statuses, ["pending", "silence", "listening", "silence", "off"]);
});

test("denial is a visible terminal failure with no automatic retry", async () => {
  const harness = makeHarness({ streamFactory: () => Promise.reject(new Error("injected denial")) });
  const statuses = [];
  const session = new VoiceActivitySession({ window: harness.win, navigator: harness.nav, onStatus: (event) => statuses.push(event.status) });
  session.enable();
  await flush();
  assert.equal(session.enabled, false);
  assert.equal(session.pending, false);
  assert.equal(harness.contexts[0].state, "closed");
  assert.equal(harness.calls.filter((call) => call === "getUserMedia").length, 1);
  harness.advance(5000, session);
  assert.equal(harness.calls.filter((call) => call === "getUserMedia").length, 1);
  assert.deepEqual(statuses, ["pending", "unavailable"]);
});

test("synchronous capture failure handles a simultaneous resume rejection", async () => {
  const harness = makeHarness({
    resumeReject: true,
    streamFactory: () => { throw new Error("injected synchronous capture failure"); }
  });
  const statuses = [];
  const session = new VoiceActivitySession({ window: harness.win, navigator: harness.nav, onStatus: (event) => statuses.push(event.status) });
  session.enable();
  await flush();
  assert.equal(session.enabled, false);
  assert.equal(session.pending, false);
  assert.equal(harness.contexts[0].state, "closed");
  assert.deepEqual(statuses, ["pending", "unavailable"]);
});

test("Disable during pending permission stops a late stream and never builds a graph", async () => {
  const late = makeStream();
  let resolveStream;
  const harness = makeHarness({ streamFactory: () => new Promise((resolve) => { resolveStream = resolve; }) });
  const session = new VoiceActivitySession({ window: harness.win, navigator: harness.nav });
  session.enable();
  session.disable();
  resolveStream(late.stream);
  await flush();
  assert.equal(late.track.readyState, "ended");
  assert.equal(late.track.stopCalls, 1);
  assert.equal(harness.calls.includes("analyser"), false);
  assert.equal(harness.intervals.size, 0);
  assert.equal(session.enabled, false);
});

test("Disable after capture resolves but before audio resume stops the owned stream", async () => {
  const granted = makeStream();
  const harness = makeHarness({ deferResume: true, streamFactory: () => Promise.resolve(granted.stream) });
  const statuses = [];
  const session = new VoiceActivitySession({ window: harness.win, navigator: harness.nav, onStatus: (event) => statuses.push(event.status) });
  session.enable();
  await flush();
  assert.equal(session.pending, true);
  assert.equal(granted.track.readyState, "live");
  session.disable();
  assert.equal(granted.track.readyState, "ended");
  assert.equal(granted.track.stopCalls, 1);
  assert.equal(harness.contexts[0].state, "closed");
  harness.contexts[0].resolveResume();
  await flush();
  assert.equal(harness.calls.includes("analyser"), false);
  assert.equal(harness.intervals.size, 0);
  assert.equal(session.enabled, false);
  assert.deepEqual(statuses, ["pending", "off"]);
});

test("audio-resume rejection stops capture that resolved first", async () => {
  const granted = makeStream();
  const harness = makeHarness({ deferResume: true, streamFactory: () => Promise.resolve(granted.stream) });
  const statuses = [];
  const session = new VoiceActivitySession({ window: harness.win, navigator: harness.nav, onStatus: (event) => statuses.push(event.status) });
  session.enable();
  await flush();
  harness.contexts[0].rejectResume();
  await flush();
  assert.equal(granted.track.readyState, "ended");
  assert.equal(granted.track.stopCalls, 1);
  assert.equal(harness.contexts[0].state, "closed");
  assert.equal(harness.calls.includes("analyser"), false);
  assert.equal(harness.intervals.size, 0);
  assert.deepEqual(statuses, ["pending", "unavailable"]);
});

test("repeated cancel and re-enable isolates stale resume settlement", async () => {
  const grants = [makeStream(), makeStream(), makeStream()];
  let request = 0;
  const harness = makeHarness({
    deferResume: true,
    streamFactory: () => Promise.resolve(grants[request++].stream)
  });
  const session = new VoiceActivitySession({ window: harness.win, navigator: harness.nav });

  session.enable();
  await flush();
  session.disable();
  session.enable();
  await flush();
  harness.contexts[0].resolveResume();
  await flush();
  assert.equal(session.pending, true);
  assert.equal(harness.calls.includes("analyser"), false);
  assert.equal(grants[0].track.readyState, "ended");
  assert.equal(grants[1].track.readyState, "live");
  session.disable();
  harness.contexts[1].resolveResume();
  await flush();

  session.enable();
  await flush();
  harness.contexts[2].resolveResume();
  await flush();
  assert.equal(session.enabled, true);
  assert.equal(harness.intervals.size, 1);
  session.disable();
  assert.equal(harness.intervals.size, 0);
  assert.ok(grants.every(({ track }) => track.readyState === "ended" && track.stopCalls === 1));
  assert.ok(harness.contexts.every((context) => context.state === "closed"));
  assert.ok(harness.nodes.every((node) => node.disconnected));
  assert.equal(harness.calls.filter((call) => call === "getUserMedia").length, 3);
});

test("audio-resume failure also stops a stream that arrives later", async () => {
  const late = makeStream();
  let resolveStream;
  const harness = makeHarness({
    resumeReject: true,
    streamFactory: () => new Promise((resolve) => { resolveStream = resolve; })
  });
  const session = new VoiceActivitySession({ window: harness.win, navigator: harness.nav });
  session.enable();
  await flush();
  resolveStream(late.stream);
  await flush();
  assert.equal(late.track.readyState, "ended");
  assert.equal(harness.calls.includes("analyser"), false);
  assert.equal(session.enabled, false);
});

test("unexpected track end and audio interruption clean up without restarting", async () => {
  for (const interruption of ["track", "context"]) {
    const granted = makeStream();
    const harness = makeHarness({ streamFactory: () => Promise.resolve(granted.stream) });
    const statuses = [];
    const session = new VoiceActivitySession({ window: harness.win, navigator: harness.nav, onStatus: (event) => statuses.push(event.status) });
    session.enable();
    await flush();
    if (interruption === "track") granted.track.endUnexpectedly();
    else harness.contexts[0].interrupt();
    assert.equal(session.enabled, false);
    assert.equal(granted.track.readyState, "ended");
    assert.equal(harness.contexts[0].state, "closed");
    assert.equal(harness.intervals.size, 0);
    assert.equal(statuses.at(-1), "unavailable");
    assert.equal(harness.calls.filter((call) => call === "getUserMedia").length, 1);
  }
});

test("unsupported or insecure capture leaves a manual unavailable state without API calls", () => {
  for (const options of [{ secure: false }, { noAudioContext: true }]) {
    const harness = makeHarness(options);
    const statuses = [];
    const session = new VoiceActivitySession({ window: harness.win, navigator: harness.nav, onStatus: (event) => statuses.push(event.status) });
    session.enable();
    assert.deepEqual(statuses, ["unavailable"]);
    assert.deepEqual(harness.calls, []);
    assert.equal(harness.intervals.size, 0);
  }
});
