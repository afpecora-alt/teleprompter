"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const installBrowserMocks = require("./mock-browser.js");

const BASE = process.env.TELEPROMPTER_URL || "http://127.0.0.1:8080/";
const OUT = path.resolve(__dirname, "../../qa/evidence/voice-activity");
const DUMMY = fs.readFileSync(path.resolve(__dirname, "../../qa/dummy-500.txt"), "utf8");
fs.mkdirSync(OUT, { recursive: true });

const results = {
  generatedAt: new Date().toISOString(),
  base: BASE,
  fixture: "qa/dummy-500.txt",
  scope: "Headless desktop Chromium with deterministic browser API mocks; not a physical-device or real-microphone test",
  checks: [],
  errors: [],
  requests: []
};

function record(id, pass, observation) {
  results.checks.push({ id, result: pass ? "PASS" : "FAIL", observation });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${JSON.stringify(observation)}`);
  assert.ok(pass, `${id}: ${JSON.stringify(observation)}`);
}

async function makePage(context, options = {}) {
  const page = await context.newPage();
  page.__errors = [];
  page.on("pageerror", (error) => {
    page.__errors.push(`pageerror: ${error.message}`);
    results.errors.push(`pageerror: ${error.message}`);
  });
  page.on("console", (message) => {
    if (message.type() === "error") {
      page.__errors.push(`console: ${message.text()}`);
      results.errors.push(`console: ${message.text()}`);
    }
  });
  page.on("request", (request) => results.requests.push(`${request.method()} ${request.url()}`));
  await page.addInitScript(installBrowserMocks, options);
  return page;
}

async function loadReader(page, flagged = true) {
  await page.goto(flagged ? `${BASE}?voiceExperiment=1` : BASE, { waitUntil: "domcontentloaded" });
  await page.waitForTimeout(250);
  await page.fill("#scriptInput", DUMMY);
  await page.click("#startButton");
  await page.waitForTimeout(200);
  if ((await page.textContent("#playButton")) === "Pause") {
    await page.click("#playButton");
  }
}

async function waitStatus(page, text) {
  await page.waitForFunction((expected) => document.getElementById("voiceStatus").textContent === expected, text, { timeout: 5000 });
}

async function enableVoice(page) {
  await page.click("#voiceSetupButton");
  await page.click("#voiceEnableButton");
  await page.waitForFunction(() => ["Scroll paused for silence", "Listening"].includes(document.getElementById("voiceStatus").textContent), null, { timeout: 5000 });
}

async function setSpeech(page, active, loud = false) {
  await page.evaluate(({ active, loud }) => window.__voiceMock.setLevel(active ? (loud ? 0.25 : 0.12) : 0), { active, loud });
}

async function position(page) {
  return page.evaluate(() => document.getElementById("readerScroll").scrollTop);
}

async function snapshot(page) {
  return page.evaluate(() => window.__voiceMock.snapshot());
}

async function measureRate(page, milliseconds = 3000) {
  const before = await position(page);
  const started = Date.now();
  await page.waitForTimeout(milliseconds);
  const after = await position(page);
  const elapsed = (Date.now() - started) / 1000;
  return { before, after, pxPerSecond: (after - before) / elapsed };
}

async function expectCleanup(page, id) {
  const state = await snapshot(page);
  await page.waitForTimeout(180);
  const after = await snapshot(page);
  const lastTrack = state.trackStates.at(-1);
  const lastContext = state.contextStates.at(-1);
  const levelHidden = await page.isHidden("#voiceLevel");
  record(id, lastTrack === "ended" && lastContext === "closed" && state.intervalCount === 0 && state.disconnectedAnalysers.every(Boolean) && after.sampleCount === state.sampleCount && levelHidden, {
    lastTrack,
    lastContext,
    intervalCount: state.intervalCount,
    analysersDisconnected: state.disconnectedAnalysers.every(Boolean),
    samplesAfterCleanup: after.sampleCount - state.sampleCount,
    levelHidden
  });
}

async function setHidden(page, hidden) {
  await page.evaluate((value) => {
    Object.defineProperty(document, "hidden", { configurable: true, get: () => value });
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  results.browser = `Chromium ${browser.version()}`;
  const pages = [];
  try {
    const coreContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const core = await makePage(coreContext);
    pages.push(core);
    await loadReader(core, true);
    let state = await snapshot(core);
    record("V01-default", await core.isVisible("#voiceControls") && state.permissionCalls === 0 && (await core.textContent("#voiceStatus")) === "Microphone off", {
      voiceUiVisible: await core.isVisible("#voiceControls"),
      permissionCalls: state.permissionCalls,
      status: await core.textContent("#voiceStatus")
    });
    record("V01-honest-label", (await core.textContent("#voiceTitle")).includes("experimental") && (await core.textContent("#voiceControls")).includes("does not follow the script"), {
      title: await core.textContent("#voiceTitle")
    });
    const sensitivity = await core.$$eval("#voiceSensitivity option", (options) => options.map((option) => option.value));
    record("V07-three-sensitivities", sensitivity.length === 3 && new Set(sensitivity).size === 3, { sensitivity });

    await core.click("#voiceSetupButton");
    record("V02-pre-prompt", await core.isVisible("#voicePrePrompt") && (await core.textContent("#voicePrePrompt")).includes("transiently on this device only"), {
      visible: await core.isVisible("#voicePrePrompt")
    });
    await core.screenshot({ path: path.join(OUT, "builder-pre-prompt.png") });
    await core.click("#voiceCancelButton");
    state = await snapshot(core);
    record("V02-cancel", state.permissionCalls === 0 && state.contextStates.length === 0, { permissionCalls: state.permissionCalls, contextCount: state.contextStates.length });
    await enableVoice(core);
    state = await snapshot(core);
    record("V02-call-order", state.calls.slice(0, 3).join(",") === "context,resume,getUserMedia", { calls: state.calls.slice(0, 3) });
    await waitStatus(core, "Scroll paused for silence");

    const speechStarted = Date.now();
    await setSpeech(core, true);
    await waitStatus(core, "Listening");
    const startMilliseconds = Date.now() - speechStarted;
    record("V06-mocked-speech-start", startMilliseconds <= 500, { startMilliseconds });
    await core.screenshot({ path: path.join(OUT, "builder-listening.png") });

    const normalRate = await measureRate(core);
    await setSpeech(core, true, true);
    const loudRate = await measureRate(core);
    const rateTolerance = Math.max(Math.abs(normalRate.pxPerSecond) * 0.1, 2);
    record("V05-fixed-speed-two-levels", Math.abs(normalRate.pxPerSecond - loudRate.pxPerSecond) <= rateTolerance && normalRate.pxPerSecond > 0, {
      normalPxPerSecond: normalRate.pxPerSecond,
      loudPxPerSecond: loudRate.pxPerSecond,
      tolerance: rateTolerance,
      selectedSpeed: await core.textContent("#speedValue")
    });

    const beforeSpeed = await position(core);
    await core.click("#speedUp");
    await core.click("#speedUp");
    const afterSpeed = await position(core);
    const fasterRate = await measureRate(core);
    record("V08-live-speed-position", afterSpeed >= beforeSpeed && fasterRate.pxPerSecond > normalRate.pxPerSecond, {
      beforeSpeed,
      afterSpeed,
      fasterPxPerSecond: fasterRate.pxPerSecond,
      selectedSpeed: await core.textContent("#speedValue")
    });
    await setSpeech(core, true, false);
    const normalFasterRate = await measureRate(core);
    const fasterTolerance = Math.max(Math.abs(normalFasterRate.pxPerSecond) * 0.1, 2);
    record("V05-fixed-speed-two-levels-fast", Math.abs(normalFasterRate.pxPerSecond - fasterRate.pxPerSecond) <= fasterTolerance && normalFasterRate.pxPerSecond > 0, {
      normalPxPerSecond: normalFasterRate.pxPerSecond,
      loudPxPerSecond: fasterRate.pxPerSecond,
      tolerance: fasterTolerance,
      selectedSpeed: await core.textContent("#speedValue")
    });

    const silenceStarted = Date.now();
    await setSpeech(core, false);
    await waitStatus(core, "Scroll paused for silence");
    const pauseMilliseconds = Date.now() - silenceStarted;
    const pausedAt = await position(core);
    await core.waitForTimeout(2000);
    const heldAt = await position(core);
    record("V06-mocked-silence-stop", pauseMilliseconds <= 800 && Math.abs(heldAt - pausedAt) <= 2, {
      pauseMilliseconds,
      pausedAt,
      heldAt,
      drift: Math.abs(heldAt - pausedAt)
    });
    await core.screenshot({ path: path.join(OUT, "builder-silence.png") });

    await core.evaluate(() => { document.getElementById("readerScroll").scrollTop += 300; });
    await core.waitForTimeout(150);
    const repositioned = await position(core);
    await setSpeech(core, true);
    await waitStatus(core, "Listening");
    await core.waitForTimeout(500);
    const resumed = await position(core);
    record("V08-manual-position-resume", resumed > repositioned && repositioned > heldAt, { heldAt, repositioned, resumed });

    const beforeMirror = await position(core);
    await core.click("#mirrorButton");
    const afterMirror = await position(core);
    const beforeFont = await position(core);
    await core.click("#fontUp");
    const afterFont = await position(core);
    record("V08-display-controls", afterMirror >= beforeMirror && afterFont > 0, { beforeMirror, afterMirror, beforeFont, afterFont });

    await core.click("#voiceDisableButton");
    await expectCleanup(core, "V09-disable-cleanup");
    const manualBefore = await position(core);
    await core.waitForTimeout(800);
    const manualAfter = await position(core);
    record("V03-manual-after-disable", manualAfter > manualBefore && (await core.textContent("#voiceStatus")) === "Microphone off", {
      manualBefore,
      manualAfter,
      status: await core.textContent("#voiceStatus")
    });
    const storageKeys = await core.evaluate(() => Object.keys(localStorage));
    record("V13-storage-keys", storageKeys.every((key) => key === "teleprompter.v1"), { storageKeys });
    await core.reload({ waitUntil: "domcontentloaded" });
    const reopened = await snapshot(core);
    record("V01-S05-reopen-off", (await core.textContent("#voiceStatus")) === "Microphone off" && reopened.permissionCalls === 0 && reopened.contextStates.length === 0, {
      status: await core.textContent("#voiceStatus"),
      permissionCalls: reopened.permissionCalls,
      contextCount: reopened.contextStates.length,
      restoredWords: (await core.inputValue("#scriptInput")).trim().split(/\s+/).length
    });
    await coreContext.close();

    const lifeContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const life = await makePage(lifeContext);
    pages.push(life);
    await loadReader(life, true);

    await enableVoice(life);
    await setSpeech(life, true);
    await waitStatus(life, "Listening");
    await life.click("#playButton");
    await expectCleanup(life, "V09-main-pause-cleanup");
    const pausePosition = await position(life);
    await life.waitForTimeout(1200);
    record("V09-main-pause-position", Math.abs((await position(life)) - pausePosition) <= 2, { pausePosition, after: await position(life) });

    await life.evaluate(() => {
      const reader = document.getElementById("readerScroll");
      reader.scrollTop = reader.scrollHeight - reader.clientHeight - 50;
    });
    await life.waitForTimeout(150);
    await enableVoice(life);
    await setSpeech(life, true);
    await waitStatus(life, "Listening");
    await life.waitForFunction(() => document.getElementById("playbackStatus").textContent === "End of script");
    await expectCleanup(life, "V09-end-cleanup");

    await enableVoice(life);
    await setSpeech(life, true);
    await waitStatus(life, "Listening");
    const callsBeforeHide = (await snapshot(life)).permissionCalls;
    await setHidden(life, true);
    await expectCleanup(life, "V09-page-hide-cleanup");
    await setHidden(life, false);
    await life.waitForTimeout(500);
    record("V10-no-foreground-restart", (await snapshot(life)).permissionCalls === callsBeforeHide && (await life.textContent("#voiceStatus")) === "Microphone off", {
      callsBeforeHide,
      callsAfterShow: (await snapshot(life)).permissionCalls,
      status: await life.textContent("#voiceStatus")
    });
    await life.click("#playButton");
    await life.waitForTimeout(400);
    await life.click("#playButton");
    record("V10-manual-recovery", (await life.textContent("#playButton")) === "Play", { playButton: await life.textContent("#playButton") });

    await enableVoice(life);
    await setSpeech(life, true);
    await waitStatus(life, "Listening");
    const callsBeforePagehide = (await snapshot(life)).permissionCalls;
    await life.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
    await expectCleanup(life, "V09-pagehide-event-cleanup");
    await life.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
    await life.waitForTimeout(400);
    record("V10-no-pageshow-restart", (await snapshot(life)).permissionCalls === callsBeforePagehide && (await life.textContent("#voiceStatus")) === "Microphone off", {
      callsBeforePagehide,
      callsAfterPageshow: (await snapshot(life)).permissionCalls,
      status: await life.textContent("#voiceStatus")
    });

    for (const kind of ["track", "context", "permission"]) {
      await enableVoice(life);
      await setSpeech(life, true);
      await waitStatus(life, "Listening");
      await life.evaluate((interruption) => {
        if (interruption === "track") window.__voiceMock.tracks.at(-1).endUnexpectedly();
        if (interruption === "context") window.__voiceMock.contexts.at(-1).interrupt();
        if (interruption === "permission") window.__voiceMock.revokePermission();
      }, kind);
      await waitStatus(life, "Voice unavailable — manual mode");
      await expectCleanup(life, `V09-${kind}-interruption-cleanup`);
      if (kind === "permission") {
        await life.evaluate(() => { window.__voiceMock.mode = "normal"; });
      }
    }
    await life.screenshot({ path: path.join(OUT, "builder-unavailable.png") });
    await lifeContext.close();

    const faultContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const fault = await makePage(faultContext);
    pages.push(fault);
    await loadReader(fault, true);
    await fault.evaluate(() => { window.__voiceMock.mode = "deny"; });
    await fault.click("#voiceSetupButton");
    await fault.click("#voiceEnableButton");
    await waitStatus(fault, "Voice unavailable — manual mode");
    await fault.click("#playButton");
    const denialBefore = await position(fault);
    await fault.waitForTimeout(600);
    const denialAfter = await position(fault);
    await fault.click("#playButton");
    record("V03-denial-manual", denialAfter > denialBefore && (await snapshot(fault)).permissionCalls === 1, {
      denialBefore,
      denialAfter,
      permissionCalls: (await snapshot(fault)).permissionCalls
    });

    for (const action of ["disable", "pause", "end", "hide"]) {
      if ((await fault.textContent("#playButton")) === "Pause") await fault.click("#playButton");
      await fault.evaluate(() => { window.__voiceMock.mode = "pending"; });
      const analysersBefore = (await snapshot(fault)).analyserCount;
      await fault.click("#voiceSetupButton");
      await fault.click("#voiceEnableButton");
      await waitStatus(fault, "Microphone permission requested…");
      if (action === "disable") {
        await fault.click("#voiceDisableButton");
      } else if (action === "pause") {
        await fault.click("#playButton");
        await fault.click("#playButton");
      } else if (action === "end") {
        await fault.evaluate(() => {
          const reader = document.getElementById("readerScroll");
          reader.scrollTop = reader.scrollHeight - reader.clientHeight - 50;
        });
        await fault.waitForTimeout(150);
        await fault.click("#playButton");
        await fault.waitForFunction(() => document.getElementById("playbackStatus").textContent === "End of script");
      } else {
        await setHidden(fault, true);
      }
      await fault.evaluate(() => window.__voiceMock.resolvePending());
      await fault.waitForTimeout(150);
      const late = await snapshot(fault);
      record(`V04-pending-${action}`, late.trackStates.at(-1) === "ended" && late.analyserCount === analysersBefore && late.intervalCount === 0, {
        lateTrack: late.trackStates.at(-1),
        analyserCountBefore: analysersBefore,
        analyserCountAfter: late.analyserCount,
        intervalCount: late.intervalCount,
        status: await fault.textContent("#voiceStatus")
      });
      if (action === "hide") await setHidden(fault, false);
    }
    await faultContext.close();

    for (const options of [{ unsupported: true }, { secure: false }]) {
      const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
      const page = await makePage(context, options);
      pages.push(page);
      await loadReader(page, true);
      await page.click("#voiceSetupButton");
      await page.click("#voiceEnableButton");
      await waitStatus(page, "Voice unavailable — manual mode");
      const apiState = await snapshot(page);
      record(`V03-${options.unsupported ? "unsupported" : "insecure"}`, apiState.permissionCalls === 0 && apiState.contextStates.length === 0, {
        permissionCalls: apiState.permissionCalls,
        contextCount: apiState.contextStates.length,
        status: await page.textContent("#voiceStatus")
      });
      await context.close();
    }

    const flagContext = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const flag = await makePage(flagContext);
    pages.push(flag);
    await loadReader(flag, false);
    const flagState = await snapshot(flag);
    record("V14-flag-off-inert", !(await flag.isVisible("#voiceControls")) && flagState.permissionCalls === 0 && flagState.contextStates.length === 0, {
      voiceVisible: await flag.isVisible("#voiceControls"),
      permissionCalls: flagState.permissionCalls,
      contextCount: flagState.contextStates.length
    });
    await flag.click("#playButton");
    const manualRate = await measureRate(flag, 1200);
    await flag.click("#playButton");
    record("V14-v1-manual-playback", manualRate.pxPerSecond > 0, manualRate);
    const wakeState = await snapshot(flag);
    record("V14-v1-wake-release", wakeState.wakeRequests >= 2 && wakeState.wakeReleases === wakeState.wakeRequests, {
      wakeRequests: wakeState.wakeRequests,
      wakeReleases: wakeState.wakeReleases
    });
    await flag.click("#mirrorButton");
    record("V14-v1-mirror", await flag.$eval("#scriptSurface", (element) => getComputedStyle(element).transform !== "none"), {
      transform: await flag.$eval("#scriptSurface", (element) => getComputedStyle(element).transform)
    });
    await flag.reload({ waitUntil: "domcontentloaded" });
    record("V14-v1-script-persistence", (await flag.inputValue("#scriptInput")) === DUMMY && !(await flag.isVisible("#voiceControls")), {
      restoredWords: (await flag.inputValue("#scriptInput")).trim().split(/\s+/).length,
      voiceVisible: await flag.isVisible("#voiceControls")
    });
    await flagContext.close();

    const offlineContext = await browser.newContext({ viewport: { width: 390, height: 844 } });
    const offline = await makePage(offlineContext);
    pages.push(offline);
    await offline.goto(`${BASE}?voiceExperiment=1`, { waitUntil: "domcontentloaded" });
    await offline.evaluate(() => navigator.serviceWorker.ready);
    await offline.reload({ waitUntil: "domcontentloaded" });
    await offlineContext.setOffline(true);
    await offline.reload({ waitUntil: "domcontentloaded" });
    await offline.fill("#scriptInput", DUMMY);
    await offline.click("#startButton");
    await offline.click("#playButton");
    await enableVoice(offline);
    await setSpeech(offline, true);
    await waitStatus(offline, "Listening");
    record("V12-offline-mocked-shell-and-gate", await offline.isVisible("#voiceControls"), {
      title: await offline.title(),
      status: await offline.textContent("#voiceStatus"),
      serviceWorkerControlled: await offline.evaluate(() => Boolean(navigator.serviceWorker.controller))
    });
    await offlineContext.setOffline(false);
    await offlineContext.close();

    const externalRequests = results.requests.filter((entry) => !entry.startsWith(`GET ${BASE}`) && !entry.startsWith("GET http://localhost:8080/"));
    record("V13-runtime-requests", externalRequests.length === 0, { requestCount: results.requests.length, externalRequests });
    record("V15-console", results.errors.length === 0, { errors: results.errors });
    results.verdict = "PASS — builder desktop/mock checks only; physical devices and real microphone remain UNVERIFIED";
  } catch (error) {
    results.verdict = "FAIL";
    results.failure = error.stack || String(error);
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const page of pages) {
      try { if (!page.isClosed()) await page.close(); } catch {}
    }
    await browser.close();
    fs.writeFileSync(path.join(OUT, "builder-browser-results.json"), `${JSON.stringify(results, null, 2)}\n`);
    console.log(`Evidence: ${path.join(OUT, "builder-browser-results.json")}`);
  }
})();
