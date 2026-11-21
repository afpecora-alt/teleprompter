"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || "playwright");
const installBrowserMocks = require("./mock-browser.js");

const BASE = process.env.TELEPROMPTER_URL || "http://127.0.0.1:8080/";
const DURATION_MS = Number(process.env.RESOURCE_DURATION_MS || 600000);
const OUT = path.resolve(__dirname, "../../qa/evidence/voice-activity");
const DUMMY = fs.readFileSync(path.resolve(__dirname, "../../qa/dummy-500.txt"), "utf8");
fs.mkdirSync(OUT, { recursive: true });

const results = {
  generatedAt: new Date().toISOString(),
  requestedDurationMs: DURATION_MS,
  scope: "Headless desktop Chromium, real elapsed time, deterministic browser API mocks; no real microphone or physical device",
  fixture: "qa/dummy-500.txt",
  cycles: [],
  metrics: [],
  repositions: 0,
  errors: []
};

async function waitStatus(page, expected) {
  await page.waitForFunction((text) => document.getElementById("voiceStatus").textContent === text, expected, { timeout: 5000 });
}

async function setSpeech(page, active) {
  await page.evaluate((value) => window.__voiceMock.setLevel(value ? 0.12 : 0), active);
}

async function position(page) {
  return page.evaluate(() => document.getElementById("readerScroll").scrollTop);
}

async function metrics(page, cdp, label, elapsedMs) {
  const value = await page.evaluate(() => ({
    ...window.__voiceMock.snapshot(),
    domNodes: document.getElementsByTagName("*").length,
    status: document.getElementById("voiceStatus").textContent,
    scrollTop: document.getElementById("readerScroll").scrollTop,
    maximumScroll: document.getElementById("readerScroll").scrollHeight - document.getElementById("readerScroll").clientHeight
  }));
  const performanceMetrics = await cdp.send("Performance.getMetrics");
  const wanted = ["JSHeapUsedSize", "JSHeapTotalSize", "Nodes", "JSEventListeners", "Documents", "Frames"];
  const cdpValues = Object.fromEntries(performanceMetrics.metrics.filter((entry) => wanted.includes(entry.name)).map((entry) => [entry.name, entry.value]));
  const point = { label, elapsedMs, ...value, cdp: cdpValues };
  delete point.calls;
  results.metrics.push(point);
  console.log(`METRIC ${JSON.stringify(point)}`);
}

(async () => {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  page.on("pageerror", (error) => results.errors.push(`pageerror: ${error.message}`));
  page.on("console", (message) => {
    if (message.type() === "error") results.errors.push(`console: ${message.text()}`);
  });
  await page.addInitScript(installBrowserMocks, {});
  const cdp = await context.newCDPSession(page);
  await cdp.send("Performance.enable");
  const started = Date.now();
  let fiveMinuteCaptured = false;
  let lastProgressMinute = -1;
  try {
    await page.goto(`${BASE}?voiceExperiment=1`, { waitUntil: "domcontentloaded" });
    await page.fill("#scriptInput", DUMMY);
    await page.click("#startButton");
    await page.click("#playButton");
    for (let index = 0; index < 12; index += 1) {
      if (await page.isDisabled("#speedDown")) break;
      await page.click("#speedDown");
    }
    await page.click("#voiceSetupButton");
    await page.click("#voiceEnableButton");
    await waitStatus(page, "Scroll paused for silence");
    await metrics(page, cdp, "0 minutes", 0);

    let cycle = 0;
    while (Date.now() - started < DURATION_MS) {
      cycle += 1;
      const nearEnd = await page.evaluate(() => {
        const reader = document.getElementById("readerScroll");
        const maximum = reader.scrollHeight - reader.clientHeight;
        return maximum > 0 && reader.scrollTop / maximum > 0.5;
      });
      if (nearEnd) {
        await page.evaluate(() => {
          const reader = document.getElementById("readerScroll");
          reader.scrollTop = (reader.scrollHeight - reader.clientHeight) * 0.2;
        });
        results.repositions += 1;
        await page.waitForTimeout(150);
      }

      const speechStarted = Date.now();
      await setSpeech(page, true);
      await waitStatus(page, "Listening");
      const startMs = Date.now() - speechStarted;
      await page.waitForTimeout(4000);
      const silenceStarted = Date.now();
      await setSpeech(page, false);
      await waitStatus(page, "Scroll paused for silence");
      const pauseMs = Date.now() - silenceStarted;
      const pausedAt = await position(page);
      await page.waitForTimeout(2000);
      const afterSilence = await position(page);
      const drift = Math.abs(afterSilence - pausedAt);
      if (cycle <= 5) {
        results.cycles.push({ cycle, startMs, pauseMs, pausedAt, afterSilence, drift });
        console.log(`CYCLE ${JSON.stringify(results.cycles.at(-1))}`);
      }
      await page.waitForTimeout(1000);

      const elapsed = Date.now() - started;
      if (!fiveMinuteCaptured && elapsed >= Math.min(300000, DURATION_MS / 2)) {
        await metrics(page, cdp, DURATION_MS === 600000 ? "5 minutes" : "midpoint", elapsed);
        fiveMinuteCaptured = true;
      }
      const progressMinute = Math.floor(elapsed / 60000);
      if (progressMinute !== lastProgressMinute) {
        lastProgressMinute = progressMinute;
        console.log(`PROGRESS elapsedMs=${elapsed} cycles=${cycle}`);
      }
    }

    const elapsed = Date.now() - started;
    await metrics(page, cdp, DURATION_MS === 600000 ? "10 minutes" : "end", elapsed);
    results.actualDurationMs = elapsed;
    results.totalCycles = cycle;
    results.selectedSpeed = await page.textContent("#speedValue");
    results.finalPosition = await position(page);
    await page.click("#playButton");
    await page.waitForTimeout(150);
    results.cleanup = await page.evaluate(() => window.__voiceMock.snapshot());
    delete results.cleanup.calls;

    assert.equal(results.cycles.length, 5);
    for (const entry of results.cycles) {
      assert.ok(entry.startMs <= 500, `cycle ${entry.cycle} start ${entry.startMs} ms`);
      assert.ok(entry.pauseMs <= 800, `cycle ${entry.cycle} pause ${entry.pauseMs} ms`);
      assert.ok(entry.drift <= 2, `cycle ${entry.cycle} drift ${entry.drift} px`);
    }
    assert.ok(results.actualDurationMs >= DURATION_MS);
    assert.equal(results.errors.length, 0);
    assert.equal(results.cleanup.trackStates.at(-1), "ended");
    assert.equal(results.cleanup.contextStates.at(-1), "closed");
    assert.equal(results.cleanup.intervalCount, 0);
    assert.ok(results.cleanup.disconnectedAnalysers.every(Boolean));
    assert.equal(results.cleanup.permissionCalls, 1);
    assert.equal(results.cleanup.analyserCount, 1);
    assert.equal(results.metrics.length, 3);
    for (const point of results.metrics) {
      assert.ok(point.cdp.JSHeapUsedSize > 0);
      assert.ok(point.cdp.JSEventListeners > 0);
    }
    assert.ok(results.metrics.at(-1).cdp.JSEventListeners <= results.metrics[0].cdp.JSEventListeners + 4);
    assert.ok(results.metrics.at(-1).cdp.Nodes <= results.metrics[0].cdp.Nodes + 10);
    results.verdict = "PASS — desktop/mock five-cycle and bounded-resource checks only";
    console.log(`PASS durationMs=${results.actualDurationMs} cycles=${cycle} repositions=${results.repositions}`);
  } catch (error) {
    results.verdict = "FAIL";
    results.failure = error.stack || String(error);
    results.failureState = await page.evaluate(() => {
      const reader = document.getElementById("readerScroll");
      const mock = window.__voiceMock.snapshot();
      delete mock.calls;
      return {
        voiceStatus: document.getElementById("voiceStatus").textContent,
        playbackStatus: document.getElementById("playbackStatus").textContent,
        playButton: document.getElementById("playButton").textContent,
        scrollTop: reader.scrollTop,
        maximumScroll: reader.scrollHeight - reader.clientHeight,
        mock
      };
    });
    process.exitCode = 1;
    console.error(error);
  } finally {
    await context.close();
    await browser.close();
    fs.writeFileSync(path.join(OUT, "builder-resource-results.json"), `${JSON.stringify(results, null, 2)}\n`);
    console.log(`Evidence: ${path.join(OUT, "builder-resource-results.json")}`);
  }
})();
