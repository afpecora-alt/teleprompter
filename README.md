# Local Teleprompter PWA v1

A private phone teleprompter built with plain HTML, CSS and JavaScript. It has one autosaved current draft, named local scripts, elapsed-time scrolling, live speed/font controls, mirroring, fullscreen, wake-lock fallback messaging and an offline app shell. No account, backend, analytics, framework, package manager, build step or third-party runtime request is used.

## Run locally

From any directory:

    python3 -m http.server 8080 --directory /home/hermes/.hermes/shared-work/teleprompter/build

Open http://localhost:8080 in Chrome or Safari. Use DevTools mobile emulation at 390x844 for a phone-sized check. localhost is allowed for service-worker development; a phone on another device needs an Antonio-approved HTTPS host, which is not included here.

Stop the server with Ctrl-C. Nothing is deployed by this build.

## App files

- index.html — semantic Edit/Read UI and strict Content Security Policy
- styles.css — light-on-dark responsive layout, safe areas and 48px controls
- app.js — editor, local persistence, playback and browser API handling
- sw.js — versioned same-origin offline app-shell cache
- manifest.webmanifest — standalone PWA metadata and local icons
- icon-192.png, icon-512.png, icon-maskable-512.png — PWA icons
- apple-touch-icon.png — 180x180 iPhone home-screen icon

## Use

1. Paste/type a script or choose a local .txt file. Empty and non-text files are rejected with a visible message.
2. Start reading. Play/Pause, speed and font controls are in the bottom thumb bar. Manual scrolling while paused sets the resume point.
3. Mirror flips only the script. Fullscreen has a visible exit. On browsers without fullscreen, add the PWA to the home screen and launch it standalone.
4. Save named scripts in Edit mode. Opening, replacing, clearing and deleting ask for confirmation when content could be lost.
5. The current draft and settings use the single localStorage key teleprompter.v1. A storage failure is shown as “Not saved”; reading still works.

Wake lock is requested on Play, released on Pause/end/hidden, and requested again when visible during playback. If unsupported or denied, the app visibly instructs you to extend/disable phone auto-lock. Browser storage can be evicted, so retain source .txt files. iOS Safari fullscreen support varies; standalone home-screen display is the documented fallback.

## Checks

Syntax checks:

    node --check /home/hermes/.hermes/shared-work/teleprompter/build/app.js
    node --check /home/hermes/.hermes/shared-work/teleprompter/build/sw.js

Dummy QA fixtures live in ../qa/. Soup Nazi owns the full DoD run in ../qa/definition-of-done.md, including physical-device tests. For offline checking: load once, confirm the service worker is active, switch DevTools Network to Offline, then reload.

## Rollback

This is a local static bundle. Revert or replace the files in this directory with the prior local copy. If a later approved deployment occurs, republish the prior bundle and bump CACHE_NAME in sw.js.
