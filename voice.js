"use strict";

(() => {
  const SPEECH_START_MS = 200;
  const SILENCE_PAUSE_MS = 600;
  const SENSITIVITIES = Object.freeze({
    low: Object.freeze({ minimum: 0.04, ratio: 5 }),
    normal: Object.freeze({ minimum: 0.022, ratio: 3.5 }),
    high: Object.freeze({ minimum: 0.012, ratio: 2.4 })
  });

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  class ActivityDetector {
    constructor(sensitivity = "normal") {
      this.sensitivity = sensitivity;
      this.reset();
    }

    reset() {
      this.active = false;
      this.smoothed = 0;
      this.noiseFloor = 0.008;
      this.speechSince = null;
      this.silenceSince = null;
      this.lastNow = null;
    }

    setSensitivity(sensitivity) {
      if (!Object.prototype.hasOwnProperty.call(SENSITIVITIES, sensitivity)) {
        throw new Error("Unknown voice sensitivity");
      }
      this.sensitivity = sensitivity;
      this.reset();
    }

    thresholds() {
      const setting = SENSITIVITIES[this.sensitivity];
      const on = Math.max(setting.minimum, this.noiseFloor * setting.ratio);
      return { on, off: on * 0.55 };
    }

    update(rms, now) {
      const sample = clamp(Number.isFinite(rms) ? rms : 0, 0, 1);
      const timestamp = Number.isFinite(now) ? now : 0;
      const elapsed = this.lastNow === null ? 0.05 : clamp((timestamp - this.lastNow) / 1000, 0, 0.25);
      this.lastNow = timestamp;

      const smoothingAlpha = 1 - Math.exp(-elapsed / 0.05);
      this.smoothed += (sample - this.smoothed) * smoothingAlpha;

      if (!this.active) {
        const floorSeconds = this.smoothed > this.noiseFloor ? 1.5 : 4;
        const floorAlpha = 1 - Math.exp(-elapsed / floorSeconds);
        this.noiseFloor = clamp(this.noiseFloor + (this.smoothed - this.noiseFloor) * floorAlpha, 0.001, 0.2);
      }

      const { on, off } = this.thresholds();
      if (!this.active) {
        if (this.smoothed >= on) {
          if (this.speechSince === null) {
            this.speechSince = timestamp;
          }
          if (timestamp - this.speechSince >= SPEECH_START_MS) {
            this.active = true;
            this.speechSince = null;
            this.silenceSince = null;
          }
        } else {
          this.speechSince = null;
        }
      } else if (this.smoothed <= off) {
        if (this.silenceSince === null) {
          this.silenceSince = timestamp;
        }
        if (timestamp - this.silenceSince >= SILENCE_PAUSE_MS) {
          this.active = false;
          this.silenceSince = null;
          this.speechSince = null;
        }
      } else {
        this.silenceSince = null;
      }
      return this.active;
    }

    get levelRatio() {
      return clamp(this.smoothed / Math.max(this.thresholds().on, 0.000001), 0, 1);
    }
  }

  function stopStream(stream) {
    if (!stream || typeof stream.getTracks !== "function") {
      return;
    }
    for (const track of stream.getTracks()) {
      try {
        track.stop();
      } catch {
        // Cleanup continues for every remaining track and the audio context.
      }
    }
  }

  class VoiceActivitySession {
    constructor(options = {}) {
      this.window = options.window || globalThis.window;
      this.navigator = options.navigator || globalThis.navigator;
      this.detector = options.detector || new ActivityDetector();
      this.onStatus = options.onStatus || (() => {});
      this.onLevel = options.onLevel || (() => {});
      this.requestId = 0;
      this.pending = false;
      this.enabled = false;
      this.stream = null;
      this.context = null;
      this.source = null;
      this.analyser = null;
      this.buffer = null;
      this.timerId = null;
      this.trackHandlers = [];
      this.contextStateHandler = null;
      this.permissionStatus = null;
      this.permissionHandler = null;
    }

    get shouldScroll() {
      return this.enabled && this.detector.active;
    }

    isCurrent(requestId) {
      return requestId === this.requestId && this.pending;
    }

    emit(status, detail = "") {
      this.onStatus({ status, detail, active: this.detector.active });
    }

    enable() {
      if (this.pending || this.enabled) {
        return;
      }
      const win = this.window;
      const nav = this.navigator;
      const Context = win && (win.AudioContext || win.webkitAudioContext);
      if (!win || win.isSecureContext !== true || !nav || !nav.mediaDevices ||
          typeof nav.mediaDevices.getUserMedia !== "function" || typeof Context !== "function") {
        this.emit("unavailable", "Microphone capture or Web Audio is unavailable here. Manual controls remain ready.");
        return;
      }

      const requestId = ++this.requestId;
      this.pending = true;
      this.emit("pending", "Waiting for the browser microphone prompt. Manual controls remain ready.");

      let context;
      let resumePromise;
      let streamPromise;
      try {
        context = new Context();
        this.context = context;
        resumePromise = context.state === "suspended" && typeof context.resume === "function"
          ? context.resume()
          : Promise.resolve();
      } catch {
        this.fail(requestId, "Microphone or audio setup failed. Use manual mode or retry explicitly.");
        return;
      }
      const guardedResume = Promise.resolve(resumePromise);
      guardedResume.catch(() => {
        // The main enable chain handles the failure; this also covers a synchronous capture throw.
      });
      try {
        streamPromise = nav.mediaDevices.getUserMedia({
          audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
          video: false
        });
      } catch {
        this.fail(requestId, "Microphone or audio setup failed. Use manual mode or retry explicitly.");
        return;
      }

      const guardedStream = Promise.resolve(streamPromise).then((stream) => {
        if (!this.isCurrent(requestId)) {
          stopStream(stream);
          return null;
        }
        // Own capture as soon as it exists. Resume may still be pending, and every
        // cleanup/failure exit must be able to stop this already-resolved stream.
        this.stream = stream;
        return stream;
      });
      guardedStream.catch(() => {
        // The main enable chain handles current failures; stale failures need no UI action.
      });

      guardedResume
        .then(() => guardedStream)
        .then((stream) => {
          if (!stream || !this.isCurrent(requestId)) {
            return;
          }
          this.startGraph(stream, requestId);
        })
        .catch(() => {
          this.fail(requestId, "Microphone permission or audio startup failed. Use manual mode or retry explicitly.");
        });
    }

    startGraph(stream, requestId) {
      try {
        this.stream = stream;
        this.source = this.context.createMediaStreamSource(stream);
        this.analyser = this.context.createAnalyser();
        this.analyser.fftSize = 1024;
        this.analyser.smoothingTimeConstant = 0;
        this.buffer = new Float32Array(this.analyser.fftSize);
        this.source.connect(this.analyser);

        for (const track of stream.getTracks()) {
          const ended = () => {
            if (this.enabled) {
              this.cleanup("unavailable", "The microphone track ended. Manual mode is ready; enable voice explicitly to retry.");
            }
          };
          track.addEventListener("ended", ended);
          this.trackHandlers.push({ track, ended });
        }

        this.contextStateHandler = () => {
          if (this.enabled && (this.context.state === "suspended" || this.context.state === "interrupted")) {
            this.cleanup("unavailable", "Audio was interrupted. Manual mode is ready; enable voice explicitly to retry.");
          }
        };
        this.context.addEventListener("statechange", this.contextStateHandler);

        this.pending = false;
        this.enabled = true;
        this.detector.reset();
        this.emit("silence", "Speak to scroll at the selected manual speed.");
        if (!this.enabled || requestId !== this.requestId) {
          return;
        }
        this.sample();
        this.timerId = this.window.setInterval(() => this.sample(), 50);
        this.watchPermission(requestId);
      } catch {
        this.fail(requestId, "Audio analysis could not start. Manual mode is ready.");
      }
    }

    async watchPermission(requestId) {
      if (!this.navigator.permissions || typeof this.navigator.permissions.query !== "function") {
        return;
      }
      try {
        const status = await this.navigator.permissions.query({ name: "microphone" });
        if (!this.enabled || requestId !== this.requestId) {
          return;
        }
        this.permissionStatus = status;
        this.permissionHandler = () => {
          if (status.state === "denied" && this.enabled) {
            this.cleanup("unavailable", "Microphone permission was revoked. Manual mode is ready.");
          }
        };
        status.addEventListener("change", this.permissionHandler);
      } catch {
        // Track-ended and context interruption handlers remain as the portable fallback.
      }
    }

    sample() {
      if (!this.enabled || !this.analyser || !this.buffer) {
        return;
      }
      try {
        this.analyser.getFloatTimeDomainData(this.buffer);
        let squares = 0;
        for (let index = 0; index < this.buffer.length; index += 1) {
          squares += this.buffer[index] * this.buffer[index];
        }
        const rms = Math.sqrt(squares / this.buffer.length);
        const wasActive = this.detector.active;
        const active = this.detector.update(rms, this.window.performance.now());
        this.onLevel(this.detector.levelRatio);
        if (active !== wasActive) {
          this.emit(active ? "listening" : "silence", active ? "" : "Speak to resume from the current position.");
        }
      } catch {
        this.cleanup("unavailable", "Audio analysis stopped unexpectedly. Manual mode is ready.");
      }
    }

    setSensitivity(sensitivity) {
      this.detector.setSensitivity(sensitivity);
      this.onLevel(0);
      if (this.enabled) {
        this.emit("silence", "Sensitivity changed. Speak to resume from the current position.");
      }
    }

    fail(requestId, detail) {
      if (requestId === this.requestId) {
        this.cleanup("unavailable", detail);
      }
    }

    disable() {
      const hadPendingRequest = this.pending;
      this.cleanup("off", hadPendingRequest
        ? "If the browser prompt is still open, dismiss it. Any late stream will be stopped."
        : "Voice activation is not saved; enable it again explicitly when needed.");
    }

    cleanup(status, detail) {
      this.requestId += 1;
      this.pending = false;
      this.enabled = false;
      if (this.timerId !== null) {
        this.window.clearInterval(this.timerId);
        this.timerId = null;
      }
      if (this.permissionStatus && this.permissionHandler) {
        this.permissionStatus.removeEventListener("change", this.permissionHandler);
      }
      this.permissionStatus = null;
      this.permissionHandler = null;
      if (this.context && this.contextStateHandler) {
        this.context.removeEventListener("statechange", this.contextStateHandler);
      }
      this.contextStateHandler = null;
      for (const { track, ended } of this.trackHandlers) {
        track.removeEventListener("ended", ended);
      }
      this.trackHandlers = [];
      for (const node of [this.source, this.analyser]) {
        if (node && typeof node.disconnect === "function") {
          try {
            node.disconnect();
          } catch {
            // Continue stopping tracks and closing the context.
          }
        }
      }
      stopStream(this.stream);
      this.stream = null;
      this.source = null;
      this.analyser = null;
      this.buffer = null;
      if (this.context && this.context.state !== "closed" && typeof this.context.close === "function") {
        try {
          Promise.resolve(this.context.close()).catch(() => {});
        } catch {
          // The tracks are already stopped and the visible state is off/unavailable.
        }
      }
      this.context = null;
      this.detector.reset();
      this.onLevel(0);
      this.emit(status, detail);
    }
  }

  const api = { ActivityDetector, VoiceActivitySession, SENSITIVITIES, SPEECH_START_MS, SILENCE_PAUSE_MS };
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  } else {
    globalThis.TeleprompterVoice = api;
  }
})();
