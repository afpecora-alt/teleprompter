"use strict";

const fs = require("node:fs");
const path = require("node:path");
const assert = require("node:assert/strict");

const ROOT = path.resolve(__dirname, "..");
const OUT = path.resolve(__dirname, "../../qa/evidence/voice-activity");
fs.mkdirSync(OUT, { recursive: true });
const runtimeFiles = ["index.html", "styles.css", "app.js", "voice.js", "sw.js", "manifest.webmanifest"];
const source = Object.fromEntries(runtimeFiles.map((file) => [file, fs.readFileSync(path.join(ROOT, file), "utf8")]));
const combined = runtimeFiles.map((file) => source[file]).join("\n");
const checks = [];

function check(id, condition, observation) {
  checks.push({ id, result: condition ? "PASS" : "FAIL", observation });
  assert.ok(condition, `${id}: ${JSON.stringify(observation)}`);
}

const forbidden = ["SpeechRecognition", "webkitSpeechRecognition", "MediaRecorder", "XMLHttpRequest", "sendBeacon", "WebSocket", "EventSource"];
for (const token of forbidden) {
  check(`A01-source-${token}`, !combined.includes(token), { token, present: combined.includes(token) });
}
check("A06-no-external-runtime-url", !/https?:\/\//u.test(combined), { externalUrlFound: /https?:\/\//u.test(combined) });
check("A02-no-audio-persistence", !/localStorage|indexedDB|caches\.|Cookie|fetch\s*\(/u.test(source["voice.js"]), {
  voiceStorageOrNetworkSinkFound: /localStorage|indexedDB|caches\.|Cookie|fetch\s*\(/u.test(source["voice.js"])
});
check("V13-csp", source["index.html"].includes("connect-src 'none'") && source["index.html"].includes("media-src 'none'"), {
  connectNone: source["index.html"].includes("connect-src 'none'"),
  mediaNone: source["index.html"].includes("media-src 'none'")
});
check("V14-default-flag-off", source["index.html"].includes('id="voiceControls" class="voice-controls" aria-labelledby="voiceTitle" hidden') && source["app.js"].includes('get("voiceExperiment") === "1"') && source["app.js"].includes("if (!voiceExperimentEnabled)"), {
  controlsHiddenByDefault: true,
  explicitQueryFlag: true,
  initializationGuard: true
});
check("V12-offline-voice-module", source["sw.js"].includes('"./voice.js"') && source["sw.js"].includes("teleprompter-shell-v1.1.0-voice-experiment"), {
  voiceModuleCached: source["sw.js"].includes('"./voice.js"')
});
check("A05-no-audio-speed-multiplier", !/state\.speed|px\/s|scrollTop/u.test(source["voice.js"]) && source["app.js"].includes("state.speed * elapsed"), {
  voiceReferencesScrollSpeed: /state\.speed|px\/s|scrollTop/u.test(source["voice.js"]),
  existingElapsedSpeedClockRetained: source["app.js"].includes("state.speed * elapsed")
});
const packageFiles = fs.readdirSync(ROOT).filter((file) => /package(?:-lock)?\.json|yarn\.lock|pnpm-lock|Capacitor|Cordova|Electron/iu.test(file));
check("A03-A05-no-paid-or-native-dependency", packageFiles.length === 0, { packageFiles });
const dummy = fs.readFileSync(path.resolve(__dirname, "../../qa/dummy-500.txt"), "utf8");
const dummyWords = dummy.trim().split(/\s+/u).length;
check("A08-dummy-fixture", dummyWords === 500 && !/CPAB|inspection/iu.test(dummy), { dummyWords });
check("A08-runtime-no-cpab", !/CPAB|inspection/iu.test(combined), { cpabOrInspectionFound: /CPAB|inspection/iu.test(combined) });

const result = {
  generatedAt: new Date().toISOString(),
  scope: "Static runtime source, dependency, CSP, fixture and offline-cache review",
  runtimeFiles,
  checks,
  verdict: "PASS — static checks only"
};
fs.writeFileSync(path.join(OUT, "builder-static-results.json"), `${JSON.stringify(result, null, 2)}\n`);
for (const entry of checks) console.log(`${entry.result} ${entry.id} ${JSON.stringify(entry.observation)}`);
console.log(`PASS ${checks.length} static checks`);
console.log(`Evidence: ${path.join(OUT, "builder-static-results.json")}`);
