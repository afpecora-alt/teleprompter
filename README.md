# Local Teleprompter PWA — voice activity experiment

Plain HTML, CSS and JavaScript. The `voice-activity-experiment` branch adds an opt-in, local Web Audio pause/resume prototype to the v1 teleprompter. It has no account, backend, analytics, framework, package manager, build step, paid dependency or third-party runtime request.

The experiment only detects sound activity. Speech permits scrolling at exactly the manually selected px/s speed; silence gates the same scroll clock off. It does not recognize words, follow the script, infer reading pace or change speed with loudness. Audio is analysed transiently in memory and is not recorded, saved, transcribed, logged or transmitted.

## Run locally

From any directory:

    python3 -m http.server 8080 --bind 127.0.0.1 --directory /home/hermes/.hermes/shared-work/teleprompter/repo

Open http://localhost:8080/ for ordinary v1 manual mode. The voice controls are absent and no microphone code runs.

Open http://localhost:8080/?voiceExperiment=1 to opt into the experiment for that page load. Use dummy text only, such as `../qa/dummy-500.txt`. localhost is allowed for desktop development. A physical phone needs a separately Antonio-approved, locally reachable HTTPS origin; none is included or deployed here.

Stop the server with Ctrl-C.

## Use the experiment

1. Paste/type a dummy script or choose a local .txt file, then Start reading.
2. Under **Voice pause/resume — experimental**, choose Low, Normal or High sensitivity. There is no calibration wizard.
3. Tap **Set up voice**, read the in-app pre-prompt, then tap **Enable microphone**. **Not now** closes the pre-prompt without requesting permission.
4. Speak to scroll at the selected manual speed. Silence shows **Scroll paused for silence**. The level bar is transient and is never persisted.
5. Play/Pause, speed, font, mirror and manual positioning remain available. Disable voice returns to manual scrolling without resetting position.

Main Pause, end of script, Disable, page hide/navigation, permission revocation, track end and audio interruption stop every track, disconnect the analyser and close the AudioContext. A pending permission result that arrives after cleanup has its tracks stopped. Returning to the page never restarts capture; a fresh explicit Enable is required. Voice activation and the URL feature flag are not persisted.

## Immediate rollback

Remove `?voiceExperiment=1` and reload. The voice UI is hidden and its capture path is inert; v1 manual behavior remains.

For a full code rollback, stop the server, run `git switch main` in the repo, then serve again. If the branch service worker previously controlled the origin, unregister it or clear this localhost site's stored service-worker/cache data to avoid a cached branch shell. No remote branch or deployment is created by this experiment.

## App files

- `index.html` — semantic Edit/Read UI, opt-in voice controls and strict Content Security Policy (`connect-src 'none'; media-src 'none'`)
- `styles.css` — light-on-dark responsive layout, safe areas and 48px controls
- `voice.js` — dependency-free activity detector and single capture owner
- `app.js` — editor, local persistence, elapsed-time playback, voice gate integration and browser lifecycle
- `sw.js` — versioned same-origin offline app-shell cache, including `voice.js`
- `manifest.webmanifest` and local PNG icons — standalone PWA metadata

## Checks

Syntax and deterministic unit tests:

    node --check app.js
    node --check voice.js
    node --check sw.js
    node --test tests/voice.test.js

The browser tests use the free Playwright package already available in the build environment; Playwright is not an app dependency. Set `PLAYWRIGHT_MODULE` to its module path, serve the repo, then run:

    PLAYWRIGHT_MODULE=/path/to/playwright node tests/browser-smoke.js
    PLAYWRIGHT_MODULE=/path/to/playwright node tests/resource-run.js

`browser-smoke.js` exercises the actual served UI and scroll loop with deterministic mocked browser audio/permission APIs. `resource-run.js` performs five timed speech/silence cycles and a real 10-minute bounded-resource run. Mocks do not prove real microphone behavior. Evidence is written to `../qa/evidence/voice-activity/` and contains states, positions, timings and resource counts, never audio or analyser sample values.

Soup Nazi owns independent verification against `../qa/voice-activity-dod.md`. Android Chrome and iPhone Safari, in both tab and installed-PWA modes, remain UNVERIFIED without named-device evidence. Real quiet-room/noise behavior, physical interruptions, offline microphone capture and phone resource behavior are not claimed by the desktop tests.
