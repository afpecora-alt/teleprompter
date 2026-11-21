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
  scope: "Actual served UI with two fake tracks per stream and independently controlled getUserMedia/AudioContext.resume promises; no real microphone or physical device",
  checks: [],
  errors: []
};
const contexts = [];
let currentScenario = "setup";

function record(id, pass, observation) {
  results.checks.push({ id, result: pass ? "PASS" : "FAIL", observation });
  console.log(`${pass ? "PASS" : "FAIL"} ${id} ${JSON.stringify(observation)}`);
  assert.ok(pass, `${id}: ${JSON.stringify(observation)}`);
}

async function state(page) {
  return page.evaluate(() => {
    const snapshot = window.__voiceMock.snapshot();
    delete snapshot.calls;
    return {
      ...snapshot,
      status: document.getElementById("voiceStatus").textContent,
      playbackStatus: document.getElementById("playbackStatus").textContent
    };
  });
}

async function makePage(browser) {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  contexts.push(context);
  const page = await context.newPage();
  page.on("pageerror", (error) => results.errors.push(`${currentScenario}: pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") results.errors.push(`${currentScenario}: console: ${message.text()}`);
  });
  await page.addInitScript(installBrowserMocks, { deferResume: true, tracksPerStream: 2 });
  await page.goto(`${BASE}?voiceExperiment=1`, { waitUntil: "domcontentloaded" });
  await page.fill("#scriptInput", DUMMY);
  await page.click("#startButton");
  await page.click("#voiceSetupButton");
  return page;
}

async function enable(page) {
  await page.click("#voiceEnableButton");
  await page.waitForFunction(() => window.__voiceMock.snapshot().permissionCalls === 1);
}

async function prepareOrdering(page, ordering) {
  if (ordering === "resume-first") {
    await page.evaluate(() => { window.__voiceMock.mode = "pending"; });
  }
  await enable(page);
  if (ordering === "stream-first") {
    await page.waitForFunction(() => {
      const mock = window.__voiceMock.snapshot();
      return mock.trackStates.length === 2 && mock.pendingResumeCount === 1;
    });
  } else {
    await page.waitForFunction(() => window.__voiceMock.snapshot().pendingResumeCount === 1);
    await page.evaluate(() => window.__voiceMock.resolveNextResume());
    await page.waitForFunction(() => window.__voiceMock.snapshot().contextStates[0] === "running");
  }
  await page.waitForTimeout(50);
  return state(page);
}

async function performExit(page, action) {
  if (action === "disable") {
    await page.click("#voiceDisableButton");
  } else if (action === "pause") {
    await page.click("#playButton");
  } else if (action === "end") {
    await page.evaluate(() => {
      const reader = document.getElementById("readerScroll");
      reader.scrollTop = reader.scrollHeight;
    });
    await page.waitForFunction(() => document.getElementById("playbackStatus").textContent === "End of script");
  } else if (action === "hide") {
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => true });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  } else if (action === "navigate") {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pagehide", { persisted: true })));
  }
  await page.waitForFunction(() => document.getElementById("voiceStatus").textContent === "Microphone off");
  return state(page);
}

async function settleOutstanding(page, ordering) {
  await page.evaluate((order) => {
    if (order === "stream-first") window.__voiceMock.resolveNextResume();
    else window.__voiceMock.resolvePending();
  }, ordering);
  await page.waitForTimeout(100);
}

async function restorePage(page, action) {
  if (action === "hide") {
    await page.evaluate(() => {
      Object.defineProperty(document, "hidden", { configurable: true, get: () => false });
      document.dispatchEvent(new Event("visibilitychange"));
    });
  } else if (action === "navigate") {
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent("pageshow", { persisted: true })));
  }
  await page.waitForTimeout(100);
}

function cleanFinal(final, expectedStatus) {
  return final.trackStates.length === 2 &&
    final.trackStates.every((value) => value === "ended") &&
    final.trackStopCalls.every((value) => value === 1) &&
    final.contextStates.length === 1 && final.contextStates[0] === "closed" &&
    final.analyserCount === 0 && final.intervalCount === 0 && final.sampleCount === 0 &&
    final.disconnectedSources.length === 0 && final.disconnectedAnalysers.length === 0 &&
    final.permissionCalls === 1 && final.status === expectedStatus;
}

async function runExitScenario(browser, ordering, action) {
  currentScenario = `${ordering}-${action}`;
  const page = await makePage(browser);
  if (action === "end") {
    await page.click("#playButton");
    await page.evaluate(() => {
      const reader = document.getElementById("readerScroll");
      const maximum = reader.scrollHeight - reader.clientHeight;
      reader.scrollTop = Math.max(0, maximum - 200);
    });
    await page.waitForTimeout(75);
    await page.click("#playButton");
  }
  const before = await prepareOrdering(page, ordering);
  const afterExit = await performExit(page, action);
  await settleOutstanding(page, ordering);
  await restorePage(page, action);
  const final = await state(page);
  const beforeReady = ordering === "stream-first"
    ? before.trackStates.every((value) => value === "live") && before.contextStates[0] === "suspended"
    : before.trackStates.length === 0 && before.contextStates[0] === "running";
  record(`V04-V09-${ordering}-${action}`, beforeReady && cleanFinal(final, "Microphone off"), {
    before,
    afterExit,
    final
  });
}

async function runResumeRejection(browser, ordering) {
  currentScenario = `${ordering}-resume-reject`;
  const page = await makePage(browser);
  let before;
  if (ordering === "stream-first") {
    before = await prepareOrdering(page, ordering);
    await page.evaluate(() => window.__voiceMock.rejectNextResume());
  } else {
    await page.evaluate(() => { window.__voiceMock.mode = "pending"; });
    await enable(page);
    await page.waitForFunction(() => window.__voiceMock.snapshot().pendingResumeCount === 1);
    before = await state(page);
    await page.evaluate(() => window.__voiceMock.rejectNextResume());
  }
  await page.waitForFunction(() => document.getElementById("voiceStatus").textContent === "Voice unavailable — manual mode");
  const afterFailure = await state(page);
  if (ordering === "resume-first") {
    await page.evaluate(() => window.__voiceMock.resolvePending());
  }
  await page.waitForTimeout(100);
  const final = await state(page);
  record(`V03-${ordering}-resume-reject`, cleanFinal(final, "Voice unavailable — manual mode"), {
    before,
    afterFailure,
    final
  });
}

async function runRepeatedCancel(browser) {
  currentScenario = "repeated-enable-cancel";
  const page = await makePage(browser);
  const cycles = [];
  for (let cycle = 0; cycle < 2; cycle += 1) {
    if (cycle > 0) await page.click("#voiceSetupButton");
    await page.click("#voiceEnableButton");
    await page.waitForFunction((count) => {
      const mock = window.__voiceMock.snapshot();
      return mock.trackStates.length === count && mock.pendingResumeCount === 1;
    }, (cycle + 1) * 2);
    await page.click("#voiceDisableButton");
    await page.evaluate(() => window.__voiceMock.resolveNextResume());
    await page.waitForTimeout(75);
    cycles.push(await state(page));
  }

  await page.click("#voiceSetupButton");
  await page.click("#voiceEnableButton");
  await page.waitForFunction(() => window.__voiceMock.snapshot().trackStates.length === 6);
  await page.evaluate(() => window.__voiceMock.resolveNextResume());
  await page.waitForFunction(() => document.getElementById("voiceStatus").textContent === "Scroll paused for silence");
  const recovered = await state(page);
  await page.click("#voiceDisableButton");
  const cleaned = await state(page);
  await page.waitForTimeout(100);
  const final = await state(page);
  const pass = cycles.every((cycle) => cycle.analyserCount === 0 && cycle.intervalCount === 0) &&
    recovered.analyserCount === 1 && recovered.intervalCount === 1 &&
    final.trackStates.length === 6 && final.trackStates.every((value) => value === "ended") &&
    final.trackStopCalls.every((value) => value === 1) &&
    final.contextStates.length === 3 && final.contextStates.every((value) => value === "closed") &&
    final.disconnectedSources.every(Boolean) && final.disconnectedAnalysers.every(Boolean) &&
    final.intervalCount === 0 && final.sampleCount === cleaned.sampleCount &&
    final.permissionCalls === 3 && final.status === "Microphone off";
  record("V04-V09-repeated-enable-cancel", pass, { cycles, recovered, cleaned, final });
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  results.browser = `Chromium ${browser.version()}`;
  try {
    for (const ordering of ["stream-first", "resume-first"]) {
      for (const action of ["disable", "pause", "end", "hide", "navigate"]) {
        await runExitScenario(browser, ordering, action);
      }
      await runResumeRejection(browser, ordering);
    }
    await runRepeatedCancel(browser);
    record("V15-race-console", results.errors.length === 0, { errors: results.errors });
    results.verdict = "PASS — builder fake-track race checks only; physical devices and real microphone remain UNVERIFIED";
  } catch (error) {
    results.verdict = "FAIL";
    results.failureScenario = currentScenario;
    results.failure = error.stack || String(error);
    console.error(error);
    process.exitCode = 1;
  } finally {
    for (const context of contexts) {
      try { await context.close(); } catch {}
    }
    await browser.close();
    fs.writeFileSync(path.join(OUT, "builder-capture-race-results.json"), `${JSON.stringify(results, null, 2)}\n`);
    console.log(`Evidence: ${path.join(OUT, "builder-capture-race-results.json")}`);
  }
})();
