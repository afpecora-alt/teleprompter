"use strict";

(() => {
  const STORAGE_KEY = "teleprompter.v1";
  const MIN_SPEED = 15;
  const MAX_SPEED = 180;
  const SPEED_STEP = 15;
  const MIN_FONT = 24;
  const MAX_FONT = 96;
  const FONT_STEP = 4;
  const SAVE_DELAY = 400;

  const byId = (id) => document.getElementById(id);
  const els = {
    editView: byId("editView"),
    readView: byId("readView"),
    scriptInput: byId("scriptInput"),
    scriptName: byId("scriptName"),
    wordCount: byId("wordCount"),
    readWordCount: byId("readWordCount"),
    inputMessage: byId("inputMessage"),
    fileInput: byId("fileInput"),
    startButton: byId("startButton"),
    clearButton: byId("clearButton"),
    saveScriptButton: byId("saveScriptButton"),
    savedList: byId("savedList"),
    emptySaved: byId("emptySaved"),
    saveStatus: byId("saveStatus"),
    readSaveStatus: byId("readSaveStatus"),
    pwaStatus: byId("pwaStatus"),
    editButton: byId("editButton"),
    playbackStatus: byId("playbackStatus"),
    readerScroll: byId("readerScroll"),
    scriptSurface: byId("scriptSurface"),
    scriptText: byId("scriptText"),
    playButton: byId("playButton"),
    speedDown: byId("speedDown"),
    speedUp: byId("speedUp"),
    speedValue: byId("speedValue"),
    fontDown: byId("fontDown"),
    fontUp: byId("fontUp"),
    fontValue: byId("fontValue"),
    mirrorButton: byId("mirrorButton"),
    fullscreenButton: byId("fullscreenButton"),
    wakeStatus: byId("wakeStatus"),
    readNotice: byId("readNotice"),
    voiceControls: byId("voiceControls"),
    voiceStatus: byId("voiceStatus"),
    voiceDetail: byId("voiceDetail"),
    voiceSetupButton: byId("voiceSetupButton"),
    voicePrePrompt: byId("voicePrePrompt"),
    voiceEnableButton: byId("voiceEnableButton"),
    voiceCancelButton: byId("voiceCancelButton"),
    voiceDisableButton: byId("voiceDisableButton"),
    voiceSensitivity: byId("voiceSensitivity"),
    voiceLevel: byId("voiceLevel"),
    voiceLevelFill: byId("voiceLevelFill")
  };

  let state = freshState();
  let saveTimer = null;
  let storageWriteBlocked = false;
  let playing = false;
  let rafId = null;
  let lastTimestamp = null;
  let lastProgressSave = 0;
  let playbackPosition = 0;
  let wakeSentinel = null;
  let wakeRequestId = 0;
  let voiceSession = null;
  const voiceExperimentEnabled = new URLSearchParams(window.location.search).get("voiceExperiment") === "1";

  function freshState() {
    return {
      version: 1,
      current: { name: "", text: "" },
      fontSize: 40,
      speed: 45,
      mirror: false,
      progress: 0,
      saved: []
    };
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function finiteNumber(value, fallback) {
    return typeof value === "number" && Number.isFinite(value) ? value : fallback;
  }

  function normalizeState(value) {
    const clean = freshState();
    if (!value || value.version !== 1) {
      throw new Error("Unsupported saved-state version");
    }

    if (value.current && typeof value.current === "object") {
      clean.current.name = typeof value.current.name === "string" ? value.current.name.slice(0, 120) : "";
      clean.current.text = typeof value.current.text === "string" ? value.current.text : "";
    }
    clean.fontSize = clamp(finiteNumber(value.fontSize, clean.fontSize), MIN_FONT, MAX_FONT);
    clean.speed = clamp(finiteNumber(value.speed, clean.speed), MIN_SPEED, MAX_SPEED);
    clean.mirror = value.mirror === true;
    clean.progress = clamp(finiteNumber(value.progress, 0), 0, 1);

    if (Array.isArray(value.saved)) {
      clean.saved = value.saved
        .filter((item) => item && typeof item.id === "string" && typeof item.name === "string" && typeof item.text === "string")
        .map((item) => ({ id: item.id, name: item.name.slice(0, 120), text: item.text }));
    }
    return clean;
  }

  function setSaveStatus(message, isError) {
    for (const element of [els.saveStatus, els.readSaveStatus]) {
      element.textContent = message;
      element.classList.toggle("error", isError);
    }
  }

  function setInputNotice(message, isError = false) {
    els.inputMessage.textContent = message;
    els.inputMessage.classList.toggle("error", isError);
  }

  function loadState() {
    let raw = null;
    try {
      raw = localStorage.getItem(STORAGE_KEY);
    } catch {
      setSaveStatus("Not saved: browser storage is unavailable.", true);
      return;
    }

    if (raw === null) {
      setSaveStatus("New draft — not saved yet", false);
      return;
    }

    try {
      state = normalizeState(JSON.parse(raw));
      setSaveStatus("Restored from this device", false);
    } catch {
      storageWriteBlocked = true;
      setSaveStatus("Not saved: existing browser data is unreadable and was not overwritten.", true);
    }
  }

  function persist() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
      saveTimer = null;
    }
    if (storageWriteBlocked) {
      setSaveStatus("Not saved: existing browser data is unreadable and was not overwritten.", true);
      return false;
    }

    state.current.text = els.scriptInput.value;
    state.current.name = els.scriptName.value.trim().slice(0, 120);
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
      setSaveStatus("Saved on this device", false);
      return true;
    } catch {
      setSaveStatus("Not saved: browser storage failed. Keep your source .txt file.", true);
      return false;
    }
  }

  function scheduleSave() {
    if (saveTimer !== null) {
      clearTimeout(saveTimer);
    }
    saveTimer = setTimeout(persist, SAVE_DELAY);
  }

  function countWords(text) {
    const trimmed = text.trim();
    return trimmed ? trimmed.split(/\s+/u).length : 0;
  }

  function updateEditorDisplay() {
    const count = countWords(els.scriptInput.value);
    els.wordCount.textContent = `${count} ${count === 1 ? "word" : "words"}`;
    els.startButton.disabled = els.scriptInput.value.trim().length === 0;
    els.startButton.textContent = state.progress > 0 && state.progress < 1 ? "Resume reading" : "Start reading";
  }

  function handleEditorInput() {
    state.current.text = els.scriptInput.value;
    state.current.name = els.scriptName.value.trim().slice(0, 120);
    state.progress = 0;
    updateEditorDisplay();
    scheduleSave();
  }

  function makeId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return window.crypto.randomUUID();
    }
    return `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  }

  function renderSavedList() {
    const fragment = document.createDocumentFragment();
    for (const item of state.saved) {
      const row = document.createElement("li");
      const name = document.createElement("span");
      name.className = "script-name";
      name.textContent = item.name;

      const open = document.createElement("button");
      open.type = "button";
      open.className = "secondary";
      open.textContent = "Open";
      open.setAttribute("aria-label", `Open ${item.name}`);
      open.addEventListener("click", () => openSavedScript(item.id));

      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "secondary";
      remove.textContent = "Delete";
      remove.setAttribute("aria-label", `Delete ${item.name}`);
      remove.addEventListener("click", () => deleteSavedScript(item.id));

      row.append(name, open, remove);
      fragment.append(row);
    }
    els.savedList.replaceChildren(fragment);
    els.emptySaved.hidden = state.saved.length > 0;
  }

  function saveNamedScript() {
    const name = els.scriptName.value.trim().slice(0, 120);
    const text = els.scriptInput.value;
    if (!name) {
      setInputNotice("Enter a script name before saving.", true);
      return;
    }
    if (!text.trim()) {
      setInputNotice("Type or load a script before saving.", true);
      return;
    }

    const foldedName = name.toLocaleLowerCase();
    const existingIndex = state.saved.findIndex((item) => item.name.toLocaleLowerCase() === foldedName);
    if (existingIndex >= 0) {
      const replace = window.confirm(`Replace the saved script named “${name}”?`);
      if (!replace) {
        setInputNotice("Replace cancelled; the saved script was not changed.");
        return;
      }
      state.saved[existingIndex] = { id: state.saved[existingIndex].id, name, text };
    } else {
      state.saved.push({ id: makeId(), name, text });
    }

    state.current = { name, text };
    renderSavedList();
    const stored = persist();
    setInputNotice(
      stored ? `Saved “${name}” on this device.` : `“${name}” is available for this session only; browser storage failed.`,
      !stored
    );
  }

  function openSavedScript(id) {
    const item = state.saved.find((candidate) => candidate.id === id);
    if (!item) {
      setInputNotice("That saved script is no longer available.", true);
      return;
    }
    if (els.scriptInput.value.trim() && els.scriptInput.value !== item.text) {
      const replace = window.confirm(`Replace the current editor text with “${item.name}”?`);
      if (!replace) {
        setInputNotice("Open cancelled; the current draft was not changed.");
        return;
      }
    }

    els.scriptInput.value = item.text;
    els.scriptName.value = item.name;
    state.current = { name: item.name, text: item.text };
    state.progress = 0;
    updateEditorDisplay();
    persist();
    setInputNotice(`Opened “${item.name}”.`);
  }

  function deleteSavedScript(id) {
    const index = state.saved.findIndex((candidate) => candidate.id === id);
    if (index < 0) {
      return;
    }
    const name = state.saved[index].name;
    if (!window.confirm(`Delete only the saved script named “${name}”? This cannot be undone.`)) {
      setInputNotice("Delete cancelled; the saved script was not changed.");
      return;
    }
    state.saved.splice(index, 1);
    renderSavedList();
    const stored = persist();
    setInputNotice(stored ? `Deleted “${name}”.` : `Deleted for this session, but browser storage failed.`, !stored);
  }

  function clearDraft() {
    if (!els.scriptInput.value && !els.scriptName.value) {
      setInputNotice("The current draft is already clear.");
      return;
    }
    if (!window.confirm("Clear the current editor text? Named saved scripts will not be deleted.")) {
      setInputNotice("Clear cancelled; the current draft was not changed.");
      return;
    }
    els.scriptInput.value = "";
    els.scriptName.value = "";
    state.current = { name: "", text: "" };
    state.progress = 0;
    updateEditorDisplay();
    const stored = persist();
    setInputNotice(stored ? "Current draft cleared. Named scripts were kept." : "Draft cleared for this session, but browser storage failed.", !stored);
  }

  function loadTextFile() {
    const file = els.fileInput.files && els.fileInput.files[0];
    if (!file) {
      return;
    }

    const isTxtName = file.name.toLocaleLowerCase().endsWith(".txt");
    const isTextType = !file.type || file.type === "text/plain";
    if (!isTxtName || !isTextType) {
      setInputNotice("Choose a plain-text .txt file. Non-text files are not loaded.", true);
      els.fileInput.value = "";
      return;
    }
    if (file.size === 0) {
      setInputNotice("That .txt file is empty. Choose a file with some text.", true);
      els.fileInput.value = "";
      return;
    }
    if (els.scriptInput.value.trim() && !window.confirm("Replace the current editor text with the selected file?")) {
      setInputNotice("File load cancelled; the current draft was not changed.");
      els.fileInput.value = "";
      return;
    }

    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result !== "string" || reader.result.length === 0) {
        setInputNotice("That file has no readable text.", true);
      } else {
        els.scriptInput.value = reader.result;
        els.scriptName.value = file.name.replace(/\.txt$/i, "").slice(0, 120);
        handleEditorInput();
        setInputNotice(`Loaded ${file.name}.`);
      }
      els.fileInput.value = "";
    };
    reader.onerror = () => {
      setInputNotice("The file could not be read. Your current draft was not changed.", true);
      els.fileInput.value = "";
    };
    reader.readAsText(file);
  }

  function maxScroll() {
    return Math.max(0, els.readerScroll.scrollHeight - els.readerScroll.clientHeight);
  }

  function normalizedProgress() {
    const maximum = maxScroll();
    return maximum > 0 ? clamp(els.readerScroll.scrollTop / maximum, 0, 1) : 0;
  }

  function setNormalizedProgress(progress) {
    const clean = clamp(finiteNumber(progress, 0), 0, 1);
    els.readerScroll.scrollTop = maxScroll() * clean;
    playbackPosition = els.readerScroll.scrollTop;
    state.progress = clean;
  }

  function updateControlDisplay() {
    els.speedValue.textContent = `${state.speed} px/s`;
    els.fontValue.textContent = `${state.fontSize} px`;
    els.speedDown.disabled = state.speed <= MIN_SPEED;
    els.speedUp.disabled = state.speed >= MAX_SPEED;
    els.fontDown.disabled = state.fontSize <= MIN_FONT;
    els.fontUp.disabled = state.fontSize >= MAX_FONT;
    els.mirrorButton.textContent = `Mirror: ${state.mirror ? "On" : "Off"}`;
    els.mirrorButton.setAttribute("aria-pressed", String(state.mirror));
  }

  function applyVisualSettings() {
    els.scriptSurface.style.fontSize = `${state.fontSize}px`;
    els.scriptSurface.classList.toggle("mirrored", state.mirror);
    updateControlDisplay();
  }

  function voiceCaptureActive() {
    return Boolean(voiceSession && (voiceSession.pending || voiceSession.enabled));
  }

  function voiceScrollBlocked() {
    return Boolean(voiceSession && voiceSession.enabled && !voiceSession.shouldScroll);
  }

  function updatePlaybackStatus() {
    if (!playing) {
      return;
    }
    els.playbackStatus.textContent = voiceScrollBlocked() ? "Voice paused" : "Playing";
  }

  function updateVoiceStatus({ status, detail }) {
    const labels = {
      off: "Microphone off",
      pending: "Microphone permission requested…",
      listening: "Listening",
      silence: "Scroll paused for silence",
      unavailable: "Voice unavailable — manual mode"
    };
    els.voiceStatus.textContent = labels[status] || labels.unavailable;
    els.voiceDetail.textContent = detail || "";
    const captureVisible = status === "pending" || status === "listening" || status === "silence";
    els.voiceSetupButton.hidden = captureVisible;
    els.voiceSetupButton.textContent = status === "unavailable" ? "Retry voice setup" : "Set up voice";
    els.voiceDisableButton.hidden = !captureVisible;
    els.voiceDisableButton.textContent = status === "pending" ? "Cancel voice setup" : "Disable voice";
    els.voiceLevel.hidden = status !== "listening" && status !== "silence";
    if (status !== "pending") {
      els.voicePrePrompt.hidden = true;
    }
    updatePlaybackStatus();
    if ((status === "listening" || status === "silence") && !playing && els.readView.hidden === false) {
      startPlayback();
    }
  }

  function stopVoiceCapture() {
    if (voiceCaptureActive()) {
      voiceSession.disable();
    }
  }

  function initializeVoiceExperiment() {
    if (!voiceExperimentEnabled) {
      return;
    }
    els.voiceControls.hidden = false;
    if (!window.TeleprompterVoice) {
      updateVoiceStatus({ status: "unavailable", detail: "The local voice module did not load. Manual controls remain ready." });
      els.voiceSetupButton.disabled = true;
      return;
    }
    voiceSession = new window.TeleprompterVoice.VoiceActivitySession({
      window,
      navigator,
      onStatus: updateVoiceStatus,
      onLevel: (ratio) => {
        els.voiceLevelFill.style.transform = `scaleX(${clamp(finiteNumber(ratio, 0), 0, 1)})`;
      }
    });
    els.voiceSetupButton.addEventListener("click", () => {
      els.voicePrePrompt.hidden = false;
      els.voiceSetupButton.hidden = true;
      els.voiceEnableButton.focus();
    });
    els.voiceCancelButton.addEventListener("click", () => {
      els.voicePrePrompt.hidden = true;
      els.voiceSetupButton.hidden = false;
      els.voiceSetupButton.focus();
    });
    els.voiceEnableButton.addEventListener("click", () => {
      els.voicePrePrompt.hidden = true;
      voiceSession.enable();
    });
    els.voiceDisableButton.addEventListener("click", () => voiceSession.disable());
    els.voiceSensitivity.addEventListener("change", () => voiceSession.setSensitivity(els.voiceSensitivity.value));
    updateVoiceStatus({ status: "off", detail: "Voice activation is off until you explicitly enable it." });
  }

  function enterReader() {
    const text = els.scriptInput.value;
    if (!text.trim()) {
      setInputNotice("Type, paste or load a script before reading.", true);
      return;
    }

    state.current.text = text;
    state.current.name = els.scriptName.value.trim().slice(0, 120);
    els.scriptText.textContent = text;
    const count = countWords(text);
    els.readWordCount.textContent = `${count} ${count === 1 ? "word" : "words"}`;
    applyVisualSettings();
    els.editView.hidden = true;
    els.readView.hidden = false;
    setNormalizedProgress(state.progress);
    els.playbackStatus.textContent = state.progress >= 1 ? "End of script" : "Paused";
    els.playButton.textContent = state.progress >= 1 ? "Restart" : "Play";
    persist();
    startPlayback();
  }

  function enterEditor() {
    if (playing || rafId !== null || wakeSentinel || voiceCaptureActive()) {
      pausePlayback();
    }
    els.readView.hidden = true;
    els.editView.hidden = false;
    updateEditorDisplay();
    els.startButton.focus();
  }

  function startPlayback() {
    if (playing) {
      return;
    }
    const maximum = maxScroll();
    if (maximum <= 0) {
      els.playbackStatus.textContent = "Script fits on screen";
      els.playButton.textContent = "Play";
      stopVoiceCapture();
      releaseWakeLock();
      return;
    }
    if (state.progress >= 0.999 || els.readerScroll.scrollTop >= maximum - 1) {
      setNormalizedProgress(0);
    }
    playbackPosition = els.readerScroll.scrollTop;

    playing = true;
    lastTimestamp = null;
    lastProgressSave = 0;
    updatePlaybackStatus();
    els.playButton.textContent = "Pause";
    acquireWakeLock();
    rafId = requestAnimationFrame(playbackTick);
  }

  function pausePlayback() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    playing = false;
    lastTimestamp = null;
    if (!els.readView.hidden) {
      state.progress = normalizedProgress();
    }
    els.playbackStatus.textContent = "Paused";
    els.playButton.textContent = "Play";
    stopVoiceCapture();
    releaseWakeLock();
    persist();
  }

  function finishPlayback() {
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    playing = false;
    lastTimestamp = null;
    els.readerScroll.scrollTop = maxScroll();
    state.progress = 1;
    els.playbackStatus.textContent = "End of script";
    els.playButton.textContent = "Restart";
    stopVoiceCapture();
    releaseWakeLock();
    persist();
  }

  function playbackTick(timestamp) {
    rafId = null;
    if (!playing || document.hidden) {
      return;
    }

    const maximum = maxScroll();
    if (maximum <= 0) {
      finishPlayback();
      return;
    }

    const elapsed = lastTimestamp === null ? 0 : Math.max(0, (timestamp - lastTimestamp) / 1000);
    lastTimestamp = timestamp;
    if (elapsed > 0 && !voiceScrollBlocked()) {
      playbackPosition = Math.min(maximum, playbackPosition + state.speed * elapsed);
      els.readerScroll.scrollTop = playbackPosition;
    }
    state.progress = normalizedProgress();

    if (timestamp - lastProgressSave >= 1500) {
      lastProgressSave = timestamp;
      scheduleSave();
    }

    if (els.readerScroll.scrollTop >= maximum - 0.75) {
      finishPlayback();
    } else {
      rafId = requestAnimationFrame(playbackTick);
    }
  }

  function togglePlayback() {
    if (playing) {
      pausePlayback();
    } else {
      startPlayback();
    }
  }

  function changeSpeed(amount) {
    state.speed = clamp(state.speed + amount, MIN_SPEED, MAX_SPEED);
    updateControlDisplay();
    scheduleSave();
  }

  function changeFont(amount) {
    const progress = els.readView.hidden ? state.progress : normalizedProgress();
    state.fontSize = clamp(state.fontSize + amount, MIN_FONT, MAX_FONT);
    els.scriptSurface.style.fontSize = `${state.fontSize}px`;
    if (!els.readView.hidden) {
      setNormalizedProgress(progress);
    } else {
      state.progress = progress;
    }
    updateControlDisplay();
    scheduleSave();
  }

  function toggleMirror() {
    const progress = els.readView.hidden ? state.progress : normalizedProgress();
    state.mirror = !state.mirror;
    els.scriptSurface.classList.toggle("mirrored", state.mirror);
    if (!els.readView.hidden) {
      setNormalizedProgress(progress);
    }
    updateControlDisplay();
    scheduleSave();
  }

  function wakeFallback(message) {
    els.wakeStatus.textContent = `${message} Set phone auto-lock to Never or the longest available time while prompting.`;
  }

  async function acquireWakeLock() {
    if (!playing || document.hidden) {
      return;
    }
    if (wakeSentinel && !wakeSentinel.released) {
      els.wakeStatus.textContent = "Screen wake lock active.";
      return;
    }
    if (!navigator.wakeLock || typeof navigator.wakeLock.request !== "function") {
      wakeFallback("Wake lock is unsupported in this browser.");
      return;
    }

    const requestId = ++wakeRequestId;
    els.wakeStatus.textContent = "Requesting screen wake lock…";
    try {
      const sentinel = await navigator.wakeLock.request("screen");
      if (requestId !== wakeRequestId || !playing || document.hidden) {
        if (!sentinel.released) {
          await sentinel.release();
        }
        return;
      }
      wakeSentinel = sentinel;
      els.wakeStatus.textContent = "Screen wake lock active.";
      sentinel.addEventListener("release", () => {
        if (wakeSentinel === sentinel) {
          wakeSentinel = null;
          if (playing && !document.hidden) {
            wakeFallback("Screen wake lock was released by the browser.");
          }
        }
      });
    } catch {
      if (requestId === wakeRequestId && playing && !document.hidden) {
        wakeFallback("Wake lock was denied or failed.");
      }
    }
  }

  async function releaseWakeLock() {
    wakeRequestId += 1;
    const sentinel = wakeSentinel;
    wakeSentinel = null;
    if (sentinel && !sentinel.released) {
      try {
        await sentinel.release();
      } catch {
        // The visible state below still reports that playback no longer holds a lock.
      }
    }
    if (!playing) {
      els.wakeStatus.textContent = "Screen wake lock off.";
    } else if (document.hidden) {
      els.wakeStatus.textContent = "Screen wake lock released while the page is hidden.";
    }
  }

  async function toggleFullscreen() {
    els.readNotice.classList.remove("error");
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
      } else if (document.fullscreenEnabled && typeof document.documentElement.requestFullscreen === "function") {
        await document.documentElement.requestFullscreen();
      } else {
        els.readNotice.textContent = "Fullscreen is unavailable here. Add this app to your home screen and open it for standalone display.";
      }
    } catch {
      els.readNotice.textContent = "Fullscreen was blocked. Add this app to your home screen and open it standalone, or use the browser’s full-screen command.";
      els.readNotice.classList.add("error");
    }
  }

  function updateFullscreenControl() {
    const active = Boolean(document.fullscreenElement);
    els.fullscreenButton.textContent = active ? "Exit fullscreen" : "Fullscreen";
    els.readNotice.textContent = active ? "Fullscreen on. Use Exit fullscreen to leave." : "";
  }

  function handleVisibilityChange() {
    if (document.hidden) {
      if (voiceCaptureActive()) {
        pausePlayback();
        return;
      }
      if (rafId !== null) {
        cancelAnimationFrame(rafId);
        rafId = null;
      }
      lastTimestamp = null;
      releaseWakeLock();
    } else if (playing) {
      lastTimestamp = null;
      acquireWakeLock();
      if (rafId === null) {
        rafId = requestAnimationFrame(playbackTick);
      }
    }
  }

  function registerServiceWorker() {
    if (!("serviceWorker" in navigator)) {
      els.pwaStatus.textContent = "Offline install is unsupported in this browser; the app still works while open.";
      return;
    }
    if (!window.isSecureContext) {
      els.pwaStatus.textContent = "Offline install requires HTTPS or localhost.";
      return;
    }
    navigator.serviceWorker.register("./sw.js")
      .then((registration) => {
        registration.update().catch(() => {
          // An offline update failure must not hide the already-cached app's readiness.
        });
        return navigator.serviceWorker.ready;
      })
      .then(() => {
        els.pwaStatus.textContent = "Offline app shell ready. Add to Home Screen to install.";
      })
      .catch(() => {
        els.pwaStatus.textContent = "Offline setup failed; the app still works while open. Check HTTPS/localhost hosting.";
      });
  }

  els.scriptInput.addEventListener("input", handleEditorInput);
  els.scriptName.addEventListener("input", () => {
    state.current.name = els.scriptName.value.trim().slice(0, 120);
    scheduleSave();
  });
  els.fileInput.addEventListener("change", loadTextFile);
  els.startButton.addEventListener("click", enterReader);
  els.clearButton.addEventListener("click", clearDraft);
  els.saveScriptButton.addEventListener("click", saveNamedScript);
  els.editButton.addEventListener("click", enterEditor);
  els.playButton.addEventListener("click", togglePlayback);
  els.speedDown.addEventListener("click", () => changeSpeed(-SPEED_STEP));
  els.speedUp.addEventListener("click", () => changeSpeed(SPEED_STEP));
  els.fontDown.addEventListener("click", () => changeFont(-FONT_STEP));
  els.fontUp.addEventListener("click", () => changeFont(FONT_STEP));
  els.mirrorButton.addEventListener("click", toggleMirror);
  els.fullscreenButton.addEventListener("click", toggleFullscreen);
  els.readerScroll.addEventListener("scroll", () => {
    if (!playing || voiceScrollBlocked()) {
      playbackPosition = els.readerScroll.scrollTop;
      state.progress = normalizedProgress();
      if (state.progress < 0.999 && els.playbackStatus.textContent === "End of script") {
        els.playbackStatus.textContent = "Paused";
        els.playButton.textContent = "Play";
      }
      scheduleSave();
    }
  }, { passive: true });

  document.addEventListener("visibilitychange", handleVisibilityChange);
  document.addEventListener("fullscreenchange", updateFullscreenControl);
  window.addEventListener("pagehide", () => {
    if (voiceCaptureActive()) {
      pausePlayback();
    } else {
      persist();
    }
    if (rafId !== null) {
      cancelAnimationFrame(rafId);
      rafId = null;
    }
    lastTimestamp = null;
    releaseWakeLock();
  });
  window.addEventListener("pageshow", () => {
    if (playing && !document.hidden && rafId === null) {
      lastTimestamp = null;
      acquireWakeLock();
      rafId = requestAnimationFrame(playbackTick);
    }
  });

  loadState();
  els.scriptInput.value = state.current.text;
  els.scriptName.value = state.current.name;
  updateEditorDisplay();
  applyVisualSettings();
  renderSavedList();
  initializeVoiceExperiment();
  registerServiceWorker();
})();
