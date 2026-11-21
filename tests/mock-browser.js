"use strict";

module.exports = function installBrowserMocks(options) {
  const mock = {
    calls: [],
    tracks: [],
    contexts: [],
    analysers: [],
    intervals: new Set(),
    pending: [],
    level: 0,
    mode: "normal",
    sampleCount: 0,
    wakeRequests: 0,
    wakeReleases: 0,
    permissionState: "granted"
  };
  window.__voiceMock = mock;

  if (options && options.secure === false) {
    Object.defineProperty(window, "isSecureContext", { configurable: true, get: () => false });
  }

  const nativeSetInterval = window.setInterval.bind(window);
  const nativeClearInterval = window.clearInterval.bind(window);
  window.setInterval = (callback, delay, ...args) => {
    const id = nativeSetInterval(callback, delay, ...args);
    mock.intervals.add(id);
    return id;
  };
  window.clearInterval = (id) => {
    mock.intervals.delete(id);
    return nativeClearInterval(id);
  };

  class MockTrack extends EventTarget {
    constructor() {
      super();
      this.readyState = "live";
      this.stopCalls = 0;
    }
    stop() {
      this.stopCalls += 1;
      this.readyState = "ended";
    }
    endUnexpectedly() {
      this.readyState = "ended";
      this.dispatchEvent(new Event("ended"));
    }
  }

  function makeStream() {
    const track = new MockTrack();
    mock.tracks.push(track);
    return { getTracks: () => [track] };
  }

  class MockAnalyser {
    constructor() {
      this.fftSize = 0;
      this.smoothingTimeConstant = -1;
      this.disconnected = false;
    }
    getFloatTimeDomainData(buffer) {
      mock.sampleCount += 1;
      for (let index = 0; index < buffer.length; index += 1) {
        buffer[index] = index % 2 === 0 ? mock.level : -mock.level;
      }
    }
    disconnect() {
      this.disconnected = true;
    }
  }

  class MockContext extends EventTarget {
    constructor() {
      super();
      this.state = "suspended";
      this.closeCalls = 0;
      mock.contexts.push(this);
      mock.calls.push("context");
    }
    resume() {
      mock.calls.push("resume");
      if (mock.mode === "resume-fail") {
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
      return {
        disconnected: false,
        connect() {},
        disconnect() { this.disconnected = true; }
      };
    }
    createAnalyser() {
      mock.calls.push("analyser");
      const analyser = new MockAnalyser();
      mock.analysers.push(analyser);
      return analyser;
    }
    interrupt() {
      this.state = "interrupted";
      this.dispatchEvent(new Event("statechange"));
    }
  }

  if (!(options && options.unsupported)) {
    window.AudioContext = MockContext;
    window.webkitAudioContext = undefined;
    const mediaDevices = {
      getUserMedia() {
        mock.calls.push("getUserMedia");
        if (mock.mode === "deny") {
          return Promise.reject(new Error("injected permission denial"));
        }
        if (mock.mode === "pending") {
          return new Promise((resolve) => mock.pending.push(() => resolve(makeStream())));
        }
        return Promise.resolve(makeStream());
      }
    };
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, get: () => mediaDevices });
  } else {
    window.AudioContext = undefined;
    window.webkitAudioContext = undefined;
    Object.defineProperty(navigator, "mediaDevices", { configurable: true, get: () => undefined });
  }

  class MockPermissionStatus extends EventTarget {
    constructor() {
      super();
      this.state = "granted";
    }
  }
  const permissionStatus = new MockPermissionStatus();
  Object.defineProperty(navigator, "permissions", {
    configurable: true,
    get: () => ({ query: async () => permissionStatus })
  });

  Object.defineProperty(navigator, "wakeLock", {
    configurable: true,
    get: () => ({
      async request() {
        mock.wakeRequests += 1;
        const sentinel = new EventTarget();
        sentinel.released = false;
        sentinel.release = async () => {
          if (!sentinel.released) {
            sentinel.released = true;
            mock.wakeReleases += 1;
            sentinel.dispatchEvent(new Event("release"));
          }
        };
        return sentinel;
      }
    })
  });

  mock.setLevel = (value) => { mock.level = value; };
  mock.resolvePending = () => {
    const pending = mock.pending.splice(0);
    for (const resolve of pending) resolve();
  };
  mock.revokePermission = () => {
    permissionStatus.state = "denied";
    permissionStatus.dispatchEvent(new Event("change"));
  };
  mock.snapshot = () => ({
    calls: mock.calls.slice(),
    permissionCalls: mock.calls.filter((call) => call === "getUserMedia").length,
    analyserCount: mock.analysers.length,
    trackStates: mock.tracks.map((track) => track.readyState),
    trackStopCalls: mock.tracks.map((track) => track.stopCalls),
    contextStates: mock.contexts.map((context) => context.state),
    disconnectedAnalysers: mock.analysers.map((analyser) => analyser.disconnected),
    intervalCount: mock.intervals.size,
    sampleCount: mock.sampleCount,
    wakeRequests: mock.wakeRequests,
    wakeReleases: mock.wakeReleases
  });
};
