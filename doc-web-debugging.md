# Debugging & Observability

> **Applies to:** Community debugging. Full maintainer type checks and tests that depend on commercial modules require the private sibling; use the Community commands in Getting started.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-09-16.
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

Guide for debugging realvirtual WEB — structured logging, HTTP debug API, Claude Code integration, and automated E2E testing.

---

## 1. Structured Logging System

realvirtual WEB uses a category-based structured logging system with an always-on ring buffer. All log entries are captured regardless of whether a category is enabled for console output.

The module is **`src/core/engine/rv-debug.ts`**. The import paths in the samples below are written from `src/`; adjust the relative depth for the file you are editing (most callers inside `src/core/engine/` simply use `'./rv-debug'`).

### Debug Categories

| Category | What it covers |
|----------|---------------|
| `loader` | GLB loading, node registration |
| `playback` | DrivesPlayback, ReplayRecording |
| `drive` | Drive updates, positionOverwrite |
| `transport` | TransportSurface, MU movement |
| `sensor` | Sensor collision, occupancy |
| `logic` | LogicStep execution |
| `signal` | Signal store changes |
| `erratic` | ErraticDriver |
| `grip` | Grip pick/place |
| `parity` | GLB extras parity validation |
| `config` | App config loading |
| `multiuser` | Multiuser synchronization |
| `interface` | Industrial interface connections |
| `render` | Render loop and performance metrics |
| `perf` | Load-phase timings |
| `plugins` | Model plugin loading/unloading |
| `system` | Non-categorized system messages (always prints to console) |

### Enabling Console Output

By default only the `loader` category prints to the browser console in dev mode. Enable more categories via URL parameter or localStorage:

```
?debug=all                          # Enable all categories
?debug=playback,signal              # Enable specific categories
?debug=none                         # Disable all
```

Or via localStorage:
```js
localStorage.setItem('rv-debug', 'signal,drive');
```

### Log Levels

Five severity levels, ordered: `trace` < `debug` < `info` < `warn` < `error`

- **trace/debug** — Verbose operational details
- **info** — Noteworthy events (model loaded, connection established)
- **warn** — Potential issues (missing signal path, timeout)
- **error** — Failures (WebSocket lost, parsing error)

### Using in Code

**Category-based logging** — console output gated by active categories, but always buffered:

```ts
import { debug, debugWarn, debugError } from './core/engine/rv-debug';

debug('signal', 'value changed', { name, value });     // level: debug
debugWarn('drive', 'speed limit exceeded', speed);      // level: warn, captures stack
debugError('loader', 'failed to parse node', err);      // level: error, captures stack
```

**System-level logging** — always prints to console AND buffers:

```ts
import { logInfo, logWarn, logError } from './core/engine/rv-debug';

logInfo('Model loaded successfully');
logWarn('WebSocket reconnecting...');
logError('Critical failure', errorObj);
```

### Querying the Log Buffer

The ring buffer holds the last 500 entries. Query it programmatically:

```ts
import { getLogBuffer, getLastLogs, queryLogs, clearLogBuffer, getLogBufferSize } from './core/engine/rv-debug';

getLogBuffer();                  // All 500 entries (oldest first)
getLastLogs(10);                 // Last 10 entries
getLogBufferSize();              // Current entry count

queryLogs({ level: 'warn' });                           // All warn + error entries
queryLogs({ category: 'signal' });                      // Only signal category
queryLogs({ level: 'warn', category: 'signal' });       // Combined filter
queryLogs({ since: Date.now() - 60000, limit: 20 });    // Last minute, max 20
clearLogBuffer();                                        // Reset buffer
```

### LogEntry Structure

Each entry in the buffer has this shape:

```ts
interface LogEntry {
  level: 'trace' | 'debug' | 'info' | 'warn' | 'error';
  category: DebugCategory | 'system';
  message: string;
  timestamp: number;      // Date.now()
  elapsed: number;        // Seconds since page load
  data?: unknown;         // Extra payload (args passed to debug())
  stack?: string;         // Call stack (captured for warn/error)
}
```

---

## 2. Debug HTTP API

realvirtual WEB exposes a bidirectional debug bridge via HTTP endpoints on the Vite dev server. The browser pushes state snapshots at ~1 Hz; external tools read them via GET requests.

### Base URL

```
http://localhost:5173/__api/debug
```

(Port may vary — the dev server defaults to 5173.)

### Snapshot Endpoints (GET)

| Endpoint | Returns |
|----------|---------|
| `/__api/debug` | Full state snapshot (signals, drives, sensors, errors, logs, etc.) |
| `/__api/debug/signals` | All signal name→value pairs |
| `/__api/debug/drives` | All drives with position, speed, jog state |
| `/__api/debug/sensors` | All sensors with occupancy state |
| `/__api/debug/errors` | Captured browser console errors/warnings |
| `/__api/debug/changelog` | Recent signal changes with timestamps |
| `/__api/debug/logic` | LogicStep tree with active step state |
| `/__api/debug/transport` | MU spawn/consume statistics |
| `/__api/debug/stateHistory` | Connection state transitions |
| `/__api/debug/logs` | Last 100 structured log entries |
| `/__api/debug/signals?names=A,B` | Watch specific signals only |

### Log Filtering

The logs endpoint supports query parameters for filtering:

```
/__api/debug/logs                                    # All entries
/__api/debug/logs?level=warn                         # Warn + error only
/__api/debug/logs?category=signal                    # Signal category only
/__api/debug/logs?level=warn&category=signal&limit=20  # Combined
```

- **`level`** — Minimum severity: `trace`, `debug`, `info`, `warn`, `error`
- **`category`** — Exact category match: `loader`, `signal`, `drive`, etc.
- **`limit`** — Return only the last N entries

### Command Queue (POST)

External tools can send commands to the running browser:

**Send a command:**
```bash
curl -s -X POST http://localhost:5173/__api/debug/cmd \
  -H "Content-Type: application/json" \
  -d '{"cmd":"setSignal","name":"ConveyorStart","value":true}'
```

**Available commands:**
| Command | Payload |
|---------|---------|
| `setSignal` | `{"cmd":"setSignal","name":"SignalName","value":true}` |
| `setSignals` | `{"cmd":"setSignals","signals":{"A":true,"B":42}}` |
| `jogDrive` | `{"cmd":"jogDrive","name":"DriveName","forward":true}` |
| `stopDrive` | `{"cmd":"stopDrive","name":"DriveName"}` |
| `moveDrive` | `{"cmd":"moveDrive","name":"DriveName","position":90}` |

**Check command results:**
```bash
curl -s http://localhost:5173/__api/debug/cmd/results
```

---

## 3. Claude Code Integration

### `/debugweb` Command

Inspects the running realvirtual WEB directly from Claude Code:

```
/debugweb                           # Full state overview
/debugweb signals                   # All signal values
/debugweb drives                    # All drive states
/debugweb sensors                   # All sensor states
/debugweb errors                    # Browser console errors/warnings
/debugweb logs                      # All recent structured log entries
/debugweb logs warn                 # Only warnings and errors
/debugweb logs signal               # Only signal category logs
/debugweb logs warn signal 20       # Warn+ from signal category, last 20
/debugweb watch Signal1,Signal2     # Watch specific signals
/debugweb set SignalName true       # Set a boolean signal
/debugweb jog DriveName forward     # Jog a drive
/debugweb stop DriveName            # Stop a drive
/debugweb move DriveName 90         # Move drive to position
```

Log entries are displayed as:
```
[warn]  [signal]  00:05:12.340 | setByPath: path NOT found "SomeSignal"
[error] [system]  00:05:13.001 | WebSocket connection lost
[debug] [drive]   00:05:14.500 | Drive "Conveyor1" speed=100 pos=45.2
```

### `/testbrowser` Command

Uses Playwright MCP for direct browser inspection and interaction:

```
/testbrowser                     # Page overview (accessibility tree)
/testbrowser screenshot          # Capture browser screenshot
/testbrowser click Settings      # Click a UI element by name
/testbrowser check               # Health check: model loaded? errors? FPS?
/testbrowser perf                # Run performance benchmark
```

This gives Claude Code direct access to the browser's accessibility tree, DOM state, and screenshots — without curl workarounds.

### Playwright MCP Setup

The Playwright MCP server is configured in the Unity project's `.mcp.json` — that file lives at the **Unity project root, two levels above this directory** (next to `Assets/`), not in `Assets/realvirtual-WebViewer~/`:

```json
{
  "mcpServers": {
    "playwright": {
      "command": "npx",
      "args": ["@playwright/mcp@latest"]
    }
  }
}
```

This provides Claude Code with browser navigation, element clicking, form filling, screenshot capture, and accessibility tree inspection.

---

## 4. E2E Testing

Automated end-to-end tests in `e2e/` verify realvirtual WEB functionality using Playwright.

### Watching a vitest browser run (headless opt-out)

The vitest suite (`tests/*.test.ts`, run with `npm test`) drives a real Chromium through the
Playwright provider. Since plan-375 it runs **headless by default** — `browser.headless: true`
is pinned in `vite.config.ts` rather than left to vitest's default, which follows
`process.env.CI` and is therefore `false` on a developer machine.

When you need to *see* what a failing test does — a misplaced overlay, a gizmo that never
appears, a canvas that stays black — opt out for that invocation only:

```bash
npx vitest --browser.headless=false                        # watch mode, visible browser
npx vitest run --browser.headless=false tests/foo.test.ts  # single file, visible browser
```

Do not flip the config value to debug: a visible window changes what the suite measures.
Chromium throttles and repaints differently when a window is focused, occluded or minimized,
and several tests read frame timings or `document.visibilityState`.

Note that this is orthogonal to `npm run e2e:headed`, which controls the *Playwright* e2e
runner in `e2e/` — a different runner with a different browser session.

### Running Tests

```bash
cd Assets/realvirtual-WebViewer~

npx playwright test                           # Run all e2e tests
npx playwright test e2e/smoke.spec.ts         # Smoke tests only
npx playwright test e2e/hmi-panels.spec.ts    # HMI panel tests only
npx playwright test e2e/debug-endpoint.spec.ts # Debug API tests only
npx playwright test e2e/perf-smoke.spec.ts    # Performance benchmark
```

`playwright.config.ts` starts **two** web servers, both with `reuseExistingServer`:

| Server | Port | Serves |
|--------|------|--------|
| `npm run dev -- --port 5177` | 5177 | the dev server — `baseURL` of the `chromium` project, which runs every spec except `embed-smoke.spec.ts` |
| `npm run preview:embed` | 4178 | the **built** embed artifact from `dist-embed/` — `baseURL` of the `embed-chromium` project, which runs `embed-smoke.spec.ts` only |

The embed server previews a production build, so `npm run build:embed` has to have produced `dist-embed/` before `embed-smoke.spec.ts` can pass.

### Test Suites

**`smoke.spec.ts`** — Basic functionality:
- Page loads without critical JavaScript errors
- Debug API returns valid snapshot
- At least 1 drive exists after model load
- At least 1 signal exists after model load
- Rendering is active (FPS > 0)

**`hmi-panels.spec.ts`** — HMI interaction:
- Bottom bar renders with controls
- Settings button opens settings panel
- Hierarchy button opens hierarchy panel
- Panels can be closed after opening

**`debug-endpoint.spec.ts`** — Debug API validation:
- `/__api/debug` returns valid JSON snapshot
- `/__api/debug/logs` returns array with correct LogEntry structure
- `?level=warn` filtering works (only warn/error entries returned)
- `?category=signal` filtering works (only signal entries returned)
- `?limit=5` limits results correctly
- POST command queue accepts and queues commands
- Signal and drive sub-routes return data
- Unknown routes return 404

**`perf-smoke.spec.ts`** — Performance benchmark:
- Opens with `?perf` flag
- Waits for PerfTestPlugin to complete 5-second FPS sampling
- Reports min/avg/max FPS, frame times, draw calls, triangle count
- Asserts rendering is active (FPS > 0)

**`camera-startpos.spec.ts`** — Camera start-position persistence:
- Save a camera view
- Reload the page
- Verify the camera view is restored

**`sink-test.spec.ts`** — Sink MU consumption:
- Source spawns MUs
- MUs traverse transport surfaces
- Sink consumes them

**`webgpu-smoke.spec.ts`** — Rendering backend smoke test:
- Boots realvirtual in both WebGL and WebGPU rendering modes without JS errors
- Headless Chromium falls back to WebGL

**`collision.spec.ts`** — Collision manager end-to-end:
- Collisions report as cards in the right-side messages panel
- The highlight survives a workspace mode change
- Cards clear when the overlap ends / the type is ignored

**`inline-signal-linking.spec.ts`** — Inline signal linking:
- Every signal slot of a selected element shows as a row (empty ones as *not linked*)
- A slot binds to an internal model signal through the picker and goes live without a CONNECT provider
- Unlinking restores *not linked*

**`signal-link-mode.spec.ts`** — Signal link mode:
- Toggle visible in hmi and planner mode, hidden in fpv; persisted across reload
- Badge click opens the direct bind popover (mouse and touch)
- Unwired drives stay *pending* without CONNECT and go live with it
- Model switch and reload leave no stale or duplicate badges

**`slot-authority.spec.ts`** — Slot write authority:
- bind → force → unforce round trip and the authority state after each
- The held live source value is redispatched onto the slot on unforce
- A model switch cleans the state up

**`connect-embed-e2e.spec.ts`** — CONNECT embed gate (`connect-embed` UI context):
- The minimal gate loads, closes and restarts the standalone CONNECT demo from the model row
- The row close action is keyboard reachable and 44 px on a coarse pointer
- The signal hint stays visible and unobstructed next to a maximally wide CONNECT panel

**`embed-smoke.spec.ts`** — the **built** `rv-embed` artifact (runs against the preview server on 4178, not the dev server):
- Loads the Draco vignette
- Enforces the mobile single-simulation limit
- Disposes cleanly when removed by an SPA

### Writing New E2E Tests

Follow the existing pattern:

```ts
import { test, expect } from 'playwright/test';

test('my test', async ({ page }) => {
  test.setTimeout(90_000);  // Generous timeout for model loading

  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 30_000 });
  await page.waitForTimeout(3_000);  // Wait for async init

  // Use page.request for API calls
  const response = await page.request.get('/__api/debug/logs');
  const logs = await response.json();
  expect(logs.length).toBeGreaterThan(0);

  // Filter non-critical errors
  const critical = errors.filter(
    e => !e.includes('favicon') && !e.includes('ResizeObserver')
  );
  expect(critical).toHaveLength(0);
});
```

---

### A demo is red on /dev/ — reading `smoke-result.json` (plan-503)

Every public deploy ends with the live demo smoke (`doc-deploy.md` § *The demo smoke after every public deploy*); the `/dev` watcher shows a red one as `SMOKE FAILED` in `watch.log`, in `--status` and as a Windows notification. Everything you need is in ONE folder — `<watcher root>\last-smoke\` for `/dev`, `.smoke\<time>\` for a release deploy:

| File | What it answers |
|------|-----------------|
| `smoke-result.json` | the verdict: `status`, `reason`, `failures[]` (spec, title, message, attachment paths), `flaky[]`, `steps` (runtime / reachability / freshness with the SERVED fingerprint / playwright exit), `durations` per test, `observations` (the JSON attachments of each test) |
| `expected.json` | the stand the deploy uploaded: `pair`, `baseUrl`, `demos`, `fingerprint` |
| `playwright-report.json` | Playwright's raw JSON report (only when Playwright ran) |
| `artifacts\<test>\` | screenshots, the HMI motion frames, `error-context.md` (page snapshot), `trace.zip` of a retry |

Read `reason` first — it says which layer failed:

- `runtime-missing` — no `node_modules/playwright/cli.js` in the clone or no `chromium*` under `PLAYWRIGHT_BROWSERS_PATH`. Look at `<root>\last-runtime.log`; then `--retry-smoke`.
- `unreachable` — the demo manifest did not answer within 10 s (network, DNS, CDN).
- `stale-cdn` — for 60 s after the purge the CDN did not serve the uploaded bytes. Compare `steps.freshness.served` with `fingerprint`: a different `indexHtml` = old edge, a different `manifest` = the demo manifest is stale, a different GLB `size` = an old model. A persisting `stale-cdn` is a CDN finding, not a flake.
- `expected-unreadable` — no usable `expected.json` (a manual run without `--expected`, or a hand-edited file).
- `incomplete` — an expected test did not run (skipped, filtered, or the spec failed at import — the global errors in `failures[]` say why, e.g. `prod-demo: … unreachable`).
- `timeout` / `crashed` — the 10-minute budget was used up or Playwright died; `partialLog` holds the tail of the `line` reporter.
- `report-unreadable` — Playwright ended without a JSON report.
- `tests` — a test failed. `failures[0].message` and its attachments are the place to start:
  - **boot** (`demo-smoke.spec.ts`): the `<key>-boot` observation lists `notFound` (every 404) and `rawErrors`; a 404 outside the allowlist (root `project.json`/`models.json`, optional `*.kin.json`) is the usual cause;
  - **HMI journey**: the `motion` observation has the clip, the drives that moved and the three diff ratios against the threshold (`e2e/_motion.ts`); frames are in `artifacts\…\machine-frame-*.png`;
  - **planner journey**: the `reload-contract` observation has the world positions before / after the drag / after the reload, `collateral` and the phase timings (`openMs`, `dragMs`, `reloadMs`). `raycast missed the target placement` means the click did not select `ChainConveyor_1m` — see `raycast-miss.png`.

Two things that are NOT failures: the red banner "Hardware acceleration is disabled — rendering on the CPU" is in every headless screenshot (SwiftShader), and `flaky[]` entries passed on their retry (green, but worth a look when they repeat).

**Load matters.** The smoke renders on the CPU. On a saturated machine (measured 2026-09-27: 100 % CPU from parallel sessions) a click can stall until the test timeout and the HMI frames can stop changing — `timeout`, `Test timeout of 120000ms exceeded` or `ratios 0 / 0 / 0` together with long `durations` point there. Re-run with `--retry-smoke` (watcher) or `npm run smoke:prod -- --expected <file>` when the machine is quiet before treating it as a regression.

Reproduce a single spec by hand against the same target:

```powershell
$env:RV_SMOKE_BASE_URL = 'https://web.realvirtual.io/dev/'
$env:RV_SMOKE_EXPECTED_DEMOS = '{"hmi":"doc_demorealvirtualweb_7l7hfw","planner":"doc_demoplanner_gf4m6v"}'   # = demos of expected.json
node node_modules/playwright/cli.js test --project=prod-demo e2e/prod-demo/planner-journey.spec.ts --headed
```

The motion threshold is calibrated locally (dev server, pauses the simulation — never against the CDN): `npx playwright test --project=chromium e2e/prod-demo-calibration`.

## 4b. Large-Scale Performance Harness (plan-465)

Three DEV-only globals turn the running viewer into a measurable rig. They exist
because the viewer's own metrics cannot answer scale questions: `currentFps` /
`currentFrameTime` average over 500 ms **and** read a frame delta the simulation
loop has already clamped to 0.1 s, so a 400 ms hitch is invisible in them.

| Global | Purpose |
|---|---|
| `window.__rvSyntheticLine` | build / dispose a parameterised transport line without a GLB |
| `window.__rvPerfProbe` | per-frame (unclamped) and per-step timing, histograms, lost sim time, latency clock |
| `window.__rvSyntheticLoad` | in-browser PLC signal load through the real buffer/flush path |

```js
// Plan first — this NEVER builds, it just tells you whether the config is sane.
__rvSyntheticLine.plan({ targetMUs: 2400, lanes: 24, segments: 9 })
// → { capacityMUs, spawnCapMUs, fillTimeS, sourceIntervalS, valid, reason, ... }

__rvSyntheticLine.build({ targetMUs: 2400, sensorsPerSegment: 4, signalBinding: 'browser' })
__rvPerfProbe.start()
// … let it run …
__rvPerfProbe.report()      // frameMs/stepMs/transportMs p50/p95/p99 from whole-run histograms
__rvPerfProbe.stop()
__rvSyntheticLine.dispose() // gives back components, MUs, pools, drives, signals, geometry
```

`build()` **throws** on an invalid configuration (target above 80 % of geometric
capacity, of the spawn ceiling, or below the spawn gate) rather than running a
line that can never fill — a half-empty line still produces confident numbers.

### URL-driven runs

`?perf&scenario=line` makes `PerfTestPlugin` do all of the above and publish to
`window.__PERF_RESULTS__`:

```
/?perf&scenario=line&mode=smoke&mu=2400&duration=30&sensors=1&speed=5000
/?perf&scenario=line&mode=supported&mu=2400&sensors=4&load=connect&duration=300
```

Parameters: `mode` (`supported` grades against the §1.3 criteria, `smoke` only
checks that it ran), `mu`, `sensors`, `lanes`, `plcs`, `segments`, `seglen`,
`speed`, `templates`, `mulen`, `mugap`, `seed`, `originx`/`originz`, `load`
(`none|browser|connect`), `duration`. `scenario=model` (the default) is the
original FPS+benchmark run, unchanged.

Three **environment** parameters decide what the run is measured in (all recorded
in the report's `env` block):

| Parameter | Default for `scenario=line` | Effect |
|---|---|---|
| `keepmodel=on\|off` | `off` | keep the loaded demo GLB standing next to the line. Off = its scene root is removed and its drives/surfaces/sensors/sources/sinks/MUs are dropped from the tick lists, so `draws`, the shadow pass and the transport cost belong to the LINE. Not `model=` — that is the viewer's model selector. |
| `shadows=on\|off` | `on` (production) | prices the shadow pass as its own axis. The product's "shadows dirty on every MU-count change" rule is unchanged. |
| `effects=on\|off` | `on` (production) | the MU spawn/vanish clip effects, which clone every material of the MU per spawn. Instanced MUs never get them; the axis bites on the clone path. |

Under `?perf` the `DebugEndpointPlugin` and the MCP bridge are **not installed**:
the debug endpoint serialises the whole drive/sensor/surface/signal inventory once
a second and POSTs it, which on a 216-sensor line was ~14 % of CPU. The Node
runners additionally set `rv-welcome-dismissed` so the first-visit modal does not
cover the canvas.

The line is parked at `(1000, 0, 1000)` when a model is kept: the transport
manager picks an MU's driving surface from every overlapping surface, so a
synthetic line built on top of a loaded model would hand its parts to that
model's belts. With `keepmodel=off` the origin defaults to `(0, 0, 0)` instead —
1.4 km away it fell outside the camera frustum and nothing was actually rendered.
The camera is framed on the line **after** the warmup, because an MU pool's
`InstancedMesh` does not exist until its source has spawned the first part.

### Lost simulation time

`viewer.loop` now counts what the accumulator threw away, in **both** tick paths:

```js
viewer.loop.clampedSeconds          // real time dropped by the 0.1 s frame clamp
viewer.loop.droppedBacklogSeconds   // backlog dropped at the maxSubSteps ceiling
viewer.loop.pausedSeconds           // integration deliberately off — NOT drift
viewer.loop.lostSimSeconds          // clamped + dropped
viewer.loop.resetLostTimeCounters()
```

A growing `lostSimSeconds` means the displayed simulation is falling behind wall
clock — the number to look at when "it looks slower than the PLC".

### Store inventory

`signalStore.stats()` returns the size of every internal index (signals, paths,
listeners, resolve cache, force pins, providers, writer inventory). Stable signal
count with a climbing listener count is the classic teardown bug.
`signalStore.unregisterByPrefix('LINE/')` removes one namespace and leaves every
other signal, listener, alias and force pin untouched.

### Runners

See `docs/perf/README.md` for the full method, the acceptance criteria and the
CONNECT setup.

```bash
npm run perf:matrix -- --mu 500,1000,2400 --sensors 1,4 --duration 300 --runs 3
npm run perf:soak   -- --hours 8 --mu 2400 --load connect --base http://localhost:5100 --gc-interval 5
npm run perf:load   -- --source browser --rates 1000,5000,20000
```

They hold the shared `test-lock`, write to `docs/perf/`, and stamp a machine
fingerprint into every report. Headless runs are marked as non-citable: Chromium
falls back to SwiftShader and the frame times then describe the rasteriser.

---

## 4c. Performance documents (plan-492)

The URL-driven runs of §4b measure, but they show nothing while they run: one
PASS/FAIL badge appears top-left when `duration` is over, and the parameters live
in the URL. For LOOKING at scale — and for the question "what does one more
lane / cell cost" — the private Development project carries two documents that
open like any other scene and carry their own control window:

| Document | What it builds | Sliders | Live readouts |
|---|---|---|---|
| **Perf Line** (`models/PerfLine.glb`, plugin `perf-line-controls-plugin.tsx`) | the §4b synthetic transport line at the origin: lanes of chained belts, sources, sinks, sensors, library `RollConveyor-*` visuals and loaded Euro pallets as MUs (carton box and plain box selectable; a library MU is scaled to its asset's length along the belt, `MU_ASSET_PITCH_MM`, and merged into ONE multi-material mesh so it instances). Robots are the REAL library Fanuc CRX placed beside the line on the production placement path (`rv-robot-placements.ts`), not the runner's box farm | lanes, conveyors per lane, target MUs, sensors per conveyor, robots; geometry library/primitive, MU asset pallet/carton/box, robot motion static/erratic (live); Graphics full/fast (the published `Default`/`Fast` visual presets, Fast = no shadow pass), MU spawn effects on/off | plan of the slider values BEFORE the build (capacity, fill time, invalid reason), conveyors, sensors, live MUs, conveyor draws/triangles, MU instancing, frame p50/p95, jank, draw calls scene/shadow, triangles, heap |
| **Perf Cell Matrix** (`models/PerfCellMatrix.glb`, plugin `perf-cells-controls-plugin.tsx`) | N customer-shaped cells (a lane of real CAD chain conveyors plus a six-axis robot) on the PRODUCTION placement path: destructive bake, chunk meshes, pick structure, shadow pass | cells (1–64), conveyors per lane, motion none/conveyor/robot/all/sparse | placements, bakes, chunks, chunk meshes, dynamic/total nodes, sensors, fps p50/p95, jank, draw calls scene/shadow, triangles, materialize/bake/pick-wait ms, heap |

Opening: link the Development project once (Projects dashboard → Add →
`Assets/realvirtual-WebViewer-Private~/projects/Development`), then open the
document. Both windows read their opening state off the URL — `?mu=2400&lanes=24&segments=9`
is the plan-465 reference line, `?cells=16&cellmotion=all` a 16-cell matrix — and
**Rebuild** swaps the content without reloading the page. Neither calls
`loadModel`: they build into the open document through the same seams the headless
runners use (`buildSyntheticLine(host)`, `buildCellMatrix(viewer)`), so what the
window shows is what `npm run perf:matrix -- --scenario line|cells` measures.

Two things the windows are not: a citable number (that is the runner with its
warmup, observation window and validity gate, §4b and `docs/perf/README.md`),
and a place where the line's transport topology can change — the pitch between
library lanes follows the conveyor asset's width (`laneSpacingFor()`), but
capacity, fill time and every surface AABB depend on lane length only.

The headless cell-matrix runner: `npm run perf:matrix -- --scenario cells --cells 1,4,16 --cellmotion none,all --renderer webgl`;
report `docs/perf/<date>-cells-baseline.md` (draw calls, triangles and chunk meshes
per placement, the p95 knee per motion). A vsync-capped sweep says so in its header;
read the draw-call columns as the scaling evidence then, not the frame times.

## 4c-bis. Time to the first plant frame (`npm run perf:first-frame`, plan-598)

```bash
npm run build && npx vite preview --port 5598 --strictPort      # or a live URL
npm run perf:first-frame -- "http://localhost:5598/?consent=decline" 5 [--repeat 2] [--report-only]
```

n cold runs (fresh headless Chromium each, real GPU via `--use-angle=d3d11`), a median
table and a verdict. The **endpoint** "Bild sichtbar" is the moment the loading overlay
starts to go away (`fade-out` or `hidden`, whichever comes first); a run is only valid when
`viewer.renderer.info.render.calls > 0` and `viewer.currentModel` is set at that moment.
Long tasks count from navigation to the endpoint. Exit code `0` pass, `1` acceptance
violation (median above `--target-ms`, default 3000, or any valid run with a long task
> 500 ms), `2` an invalid or aborted run — never filtered out. Each run logs the GPU string
and the build hash. Results (JSON + `.cpuprofile`) land in `scripts/perf/first-frame/runs/`
(git-ignored); `categorize.cjs`, `aftercallers.cjs` and `keydiff.cjs` there break a run down
further — see `scripts/perf/first-frame/README.md`. Perf phase tables are switched on via
`localStorage rv-debug=perf`, never `?debug=` (that loads eruda from a CDN). Measure the live
demo with `?consent=decline`.

## 4d. Recording videos (plan-537)

Demo and marketing videos are recorded **frame by frame**, not in real time: the live loop
stops, every video frame advances the simulation by exactly `1/fps` through the production
fixed tick (`60/fps` steps of 1/60 s), the camera is placed from a camera path, the frame is
rendered through the full pipeline (post-processing, outlines, WebLabels) and handed to a
WebCodecs `VideoEncoder` with an explicit timestamp; `mediabunny` (lazy import) writes the MP4
in the browser. Real-time FPS, GPU load, a hidden tab or a minimised RDP desktop do not change
the result — the ad-hoc `captureStream` + `MediaRecorder` script fell to 2–8 fps in exactly that
situation. By default the video shows the 3D canvas only (in-scene WebLabels and gizmos
included); `--hmi composite|layer` adds the React HMI frame-synchronously (plan-556, below). UI
walkthroughs with the full HMI chrome stay with `scripts/recording/`.

**CLI** — own Chrome window (GPU), MCP bridge off (`mcpPort=1`), MP4 via Playwright's
`download` event, frame count verified afterwards (exit 1 on a mismatch):

```bash
npm run dev    # or any running viewer
npm run record -- --project prj_sample --doc doc_laserweldingassemblystation_1n66y05   --size 1080x1080 --fps 60 --seconds 40 --out recordings/station.mp4
npm run record -- "http://localhost:5173/?project=prj_sample&doc=…" --path presets   --views "iso,front:3:1,cam1:4:2" --seconds 12
```

Options: `--path orbit|presets|fixed` (orbit: `--target <node>`, `--radius-scale`, `--sweep`,
`--start`, `--orbit-height`, `--easing none|inOut`; presets: `--views` = `view[:transition[:hold]]`
with `iso|top|front|back|left|right|home`, `cam1..cam3` = the CAM 1–3 camera bookmarks (the
floating camera cluster rendered by `TopBar.tsx`, bottom right — not the BottomBar),
`current`; `--orbit-from-view` = orbit around the current view's target at its distance and
height, plan-551), `--size WxH` (even, default 1920x1080), `--fps 30|60` (60), `--seconds` (10),
`--warmup` (3 sim seconds, not encoded), `--quality standard|high|max` (high), `--jitter`,
`--bitrate`, `--codec avc|hevc|av1|vp9`, `--browser chrome|chromium`, `--headless`, `--base`.
A JSON summary is written next to the MP4. Ctrl+C aborts between frames and restores the viewer.

**Viewer UI (plan-551, commercial)** — the private feature `video-record-ui` adds a **Record video**
button (slot `toolbar-button-trailing`, directly before the CAM 1–3 bookmarks; not on mobile
layouts; disabled with the `capturePreflight()` reason as tooltip). The dialog (lazy chunk) offers
camera *Orbit (from current view)* (`{ kind: 'orbit', fromCurrentView: true }`, refused in
first-person / follow) or *Fixed (current view)*, length 2–60 s, 640×360 … 3840×2160, 30/60 fps,
quality standard / high / max / cinematic (cinematic: 8 / 32 / 64 spp, denoiser on/off, look
studio / viewer / hall / outdoor, depth of field on/off — plan-553, motion blur on/off with a
90° / 180° / 270° shutter — plan-554, video only, default on / 180°, 30 fps only; offered only when the cinematic provider is registered, enabled only with `navigator.gpu` +
`showDirectoryPicker`), and a live estimate (raster: bitrate size; cinematic: 26.7 s per 1080p
64-spp frame scaled by pixels × samples, refined by the last run in this browser, plus PNG disk
need). Above the 512 MiB in-memory limit the start is blocked — for the cinematic mux too.

- **Raster** starts from the current state (warmup 0) and downloads the MP4 (`downloadVideo`).
- **Cinematic** writes into a folder chosen with the File System Access picker (`pickFolderForKey
  ('video-out')` as the first statement of the click; the handle is kept for "Use <folder>"):
  `frame-%06d.png` via `createWritable` (swap file, atomic on `close`), `cinematic.json` after every
  frame, the MP4 at the end (`muxVideoFrames` → `<model>.mp4` in the same folder). The rules are the
  CLI's: the portable half of `scripts/lib/rv-cinematic-frames.mjs` lives in
  `src/core/engine/rv-cinematic-manifest.mjs` (no imports; Node digest in the CLI, `crypto.subtle`
  in the browser — same hash), so a folder started by the CLI resumes in the dialog (not the other
  way round: the dialog stores an explicit camera the CLI options cannot express).
  A cinematic run starts from a **simulation reset** (`resetSimulation: true`, inside the capture,
  after the camera was read from the current view), stores the **resolved** camera
  (`resolveExplicitCameraSpec`: absolute centre / radius / height / start angle or position /
  target) as `cameraPath`, and replays that stored camera on resume. `cameraPoses` (position,
  target, fov, projection, zoom) is a resume field (CLI too). One cinematic run per browser origin:
  Web Lock `rv-cinematic-recording` (`ifAvailable`), held through the mux and the final manifest;
  the folder is re-scanned under the lock. Frames without a manifest or of another recording are
  refused ("Use a different folder"); other files in the folder are never touched.
- **Overlay**: frame x / N, s/frame (moving average over 10 frames), ETA, elapsed, Cancel (raster:
  nothing saved; cinematic: stops after the current frame, resume by choosing the same folder),
  `beforeunload` guard, Screen Wake Lock (re-requested on `visibilitychange`, failures ignored).
- **Hidden tab** (measured 2026-10-04, see plan-551): raster capture and the MP4 mux run at full
  speed in a hidden (minimised) tab — 30 frames 640×360 in 1.7 s visible and hidden, the mux of
  30 frames 0.6–1.1 s; both wait on `MessageChannel` / the encoder's `dequeue` event, never on a
  timer. The **path tracer's GPU work pauses** while the tab is hidden (0 samples in 90 s) and the
  frame completes 1.6 s after the tab is shown again. Therefore both stall watchdogs (the capture's
  backstop and the renderer's sample / denoiser checks) count visible time only
  (`watchdogElapsedMs`), the denoiser loop yields through `yieldMacrotask()` instead of
  `setTimeout(0)`, and the overlay says *Recording pauses while the tab is hidden*.

**Still image (plan-557)** — the dialog's mode toggle *Video | Still image* saves ONE PNG of the 3D
scene exactly as it is at the click: `captureStill(viewer, options)` in `rv-video-capture.ts`
(the dialog chunk calls it directly — there is no lazy `viewer.*` wrapper, whose `await import()`
would let the simulation tick before the take-over).

- **Exact state**: `beginCapture` runs synchronously in the click's task, before the first
  `await` — no `captureStep`, no warmup, no reset, no camera pose but the current one, capture
  clock `frameDt = 0`. Sim time and drive / signal state are identical before and after, also with
  a running simulation. The cinematic Web Lock is acquired AFTER the take-over through the
  `acquire` hook (`acquireCinematicLease()` in the private `record-video-run.ts` holds
  `rv-cinematic-recording` with a deferred promise until `finally`); a held lock refuses with
  *The cinematic renderer is busy …* and nothing is written.
- **Size**: first choice *Viewport (W × H)* = the drawing buffer at the click (DPR included), then
  640×360 … 3840×2160. Edges 16…8192, pixels ≤ `MAX_RENDER_PIXELS`, odd sizes allowed (no 4:2:0);
  a larger viewport is shrunk proportionally (`fitStillSize`). A fixed size keeps the vertical
  field of view — another aspect ratio crops differently than on screen (dialog hint).
- **WebLabels**: a viewport still passes `labelReferenceHeight = canvas CSS height × output /
  drawing-buffer height` to `beginCapture`, so labels keep their on-screen proportion (also with
  the renderer DPR cap 1.5 and a shrunk output); a fixed size keeps the video contract (relative to
  the output height).
- **Raster** (standard / high / max) uses `rasterQualityConfig()` — the same supersample (GPU cap
  included), jitter, full-resolution post and shadow map as a video frame of that quality, the
  downscaler whenever `ss > 1 || jitter > 0`; one warm-up render, the frame, the PNG copied in the
  same task (no `preserveDrawingBuffer`). Pixel parity with the video frame is tested (< 2/255).
- **Cinematic**: the registered frame source — `whenBvhIdle` → `setup` (current camera, look,
  64 / 256 / 1024 spp, default 256, denoiser, DoF) → ONE `renderFrame` with `abortInFrame: true` →
  `readPng` bytes → `dispose`. No folder, manifest, mux or fingerprint. An **orthographic camera is
  refused** in the still preflight (*Cinematic needs the perspective camera*; the tracer would get a
  45° stand-in) — cinematic videos with an ortho camera behave as before. `syncCamera` copies the
  perspective `zoom` (video and still). Overall backstop `stillBackstopMs(w, h, spp)` =
  max(first-frame stall + 60 s, 3 × the expected trace time + 300 s) — 1024 spp in 4K is not cut off.
- **Cancel** (still only — the video keeps "stops after the current frame"): the renderer honours
  the signal INSIDE the frame only with `abortInFrame` — between sample blocks and denoise steps,
  and every wait (`gpu.idle`, sample read-back, denoise, `toBlob`) is raced against the signal and
  the stall timeout (`raceAbortable` in `rv-cinematic-hook.ts`); an abandoned frame leaves the
  source spent and it is disposed. The async setup phases (lock, renderer import, BVH wait,
  `setup`) are raced against the signal and a setup timeout (300 s); a phase that resolves late is
  disposed at once. Latency ≤ 5 s except while `setScene` blocks the main thread — the overlay then
  says *Cancelling after scene setup…*. Result: *Cancelled — nothing was saved.*, viewer restored.
- **Download**: `<model>-<YYYYMMDD-HHMMSS>.png` via `defaultCaptureFileName(base, 'png')` +
  `downloadBytes(bytes, name, 'image/png')` (`defaultVideoFileName` / `downloadVideo` are wrappers).
  The CLI still (`--still`) and the HMI in a still came with plan-556 (below).

**HMI in the video (plan-556)** — the React HMI (operator panels, signal / PLC read-outs, the
CONNECT panel) frame-synchronous with the plant. Engine side: `src/core/engine/rv-recording-hmi.ts`
(exposed as `viewer.recordingHmi`) + the generic `frameHook` of `recordVideo` / `captureStill`; no
Playwright in the viewer.

```bash
# composite: one MP4 with 3D + HMI (a NEW --out-dir is required, raster has no resume)
npm run record -- --project prj_sample --doc doc_laserweldingassemblystation_1n66y05 --path fixed \
  --size 1920x1080 --fps 30 --seconds 10 --hmi composite --hmi-open laserwelding-operator-panel \
  --out-dir recordings/station-hmi --mp4 recordings/station-hmi.mp4 [--keep-frames false]
# layer: the 3D MP4 exactly as without HMI + hmi-%06d.png (HMI alone, straight alpha, sRGB)
npm run record -- … --hmi layer --out-dir recordings/station-layer --mp4 recordings/station-3d.mp4
# still: reset, round(at·60) fixed steps, one image (raster or cinematic, --hmi off|composite|layer)
npm run record -- … --still recordings/station.png --at 0.5 --size 3840x2160 --hmi composite
```

- **Per frame**: the frame source that is encoded (raster: the accumulated / downscaled canvas;
  cinematic: the tracer PNG, decoded) is snapshotted IN THE RENDER TASK (`createImageBitmap`) and
  shown as the **underlay** — a `bitmaprenderer` canvas (`#rv-recording-underlay`, z-index 999)
  above the hidden `#rv-viewport`, below `#react-root`. No PNG encode in the page
  (`OffscreenCanvas.convertToBlob` costs 1–6.7 s). Then the **settle**: `flushNow()` of the shared
  UI ticker → ONE commit barrier (`RecordingFrameProbe`: `useSyncExternalStore` + `useLayoutEffect`
  acknowledges after React committed, ≈ 3 ms) → every Web Animation frozen at the recording clock
  (`playbackRate = 0` + `currentTime = sim ms` — never `pause()`: Playwright's `animations:
  'disabled'` restarts paused infinite animations) → one rAF. Then `page.screenshot({ animations:
  'allow' })` → `frame-%06d.png` (composite) or, with `html, body, #react-root` transparent and the
  underlay hidden, `omitBackground: true` → `hmi-%06d.png` (layer). Every settle / screenshot is
  bounded (`--hmi-timeout`, default 30 s); a generation token keeps a late callback from writing.
- **Recording ticks**: while recording, `setRecordingTicks(true)` REPLACES every wall-clock read-out
  timer — the shared 200 ms ticker (`markDirty` / `subscribeTick`) and the per-hook polls
  (`subscribePoll`: `useSignalTick`, `useChangeGatedTick`) — so a read-out shows exactly the frame's
  sim state; they restart afterwards. **Supported panels**: operator panels (model `WebOperatorPanel`
  and `OperatorPanelPlugin`), panels using `useSignal` / `SignalBadge` / `useThrottledSignalValue`,
  the property inspector's read-outs, the CONNECT panel. `--hmi-open` accepts operator panel ids
  (expanded for the run) and `connect`; any other id is refused with the supported list. A visible
  side panel outside the list is reported (`unsupported panel visible: <id>`) and not recorded.
- **What is in the frame** (UI context `recording`, App.tsx renders `RecordingHmiShell`): the
  viewport (full-bleed), the operator panels + allow-listed overlay entries
  (`allowRecordingOverlay(pluginId)`), the CONNECT panel when open. Everything else of the shell is
  not mounted (TopBar, TitleBar, KPI bar, ActivityBar, ButtonPanel, search, messages, problems,
  banners, dialogs, tooltips, the record dialog / progress) — `RECORDING_SHELL_INVENTORY` lists every
  element; a stored `hmiVisible = false` is overridden; UI zoom is pinned to 1. A style tag hides the
  ViewCube, the watermark and `[data-rv-recording-exclude]`; the cinematic preview canvas gets
  `opacity: 0`.
- **CLI setup**: viewport = `--size` (CSS px, DSF 1), terms / welcome / dev banner dismissed via
  `addInitScript`, simulation reset at the start (the sim start must not depend on the load time),
  the page must be `visible` (keep the window / RDP session visible — hidden pages stall screenshots).
- **Raster output contract**: both modes need a NEW `--out-dir` (missing or empty) and `--mp4`;
  composite muxes `frame-*.png` with the shared helper (`muxFrameDir`: codec / bitrate / abort
  forwarded, frame count verified) and deletes them only with `--keep-frames false` after a verified
  mux; layer never deletes `hmi-*.png` (they are the product). `--hmi off` keeps today's refusal of
  `--out-dir` / `--mp4` for raster.
- **Cinematic**: composite = the HMI screenshot IS `frame-i` (the tracer PNG only lives as the
  underlay; an unfinished frame is traced again on resume); layer = `frame-i` (tracer) + `hmi-i`,
  a frame counts only as a validated PAIR — the resume starts at the first incomplete pair and
  rewrites both. `hmi`, `hmiOpen`, `viewport` enter the options hash only with the HMI on (golden
  hashes of other runs unchanged); an off / composite mismatch is refused naming `hmi`.
- **Determinism / cost**: two layer runs give byte-identical `hmi-*.png` (PilotLamp blink phase
  included); the composite is not required to be identical (raster noise under the 0.92 plate).
  1080p: composite screenshot ≈ 0.22–0.3 s, layer ≈ 0.1 s per frame. ProRes 4444 / WebM alpha is
  not built — composite the PNG sequence in the editing program.
- **Dialog (commercial)**: *Include HMI: Off | Composite* records THIS tab via tab sharing —
  `getDisplayMedia({ preferCurrentTab, selfBrowserSurface: 'include', surfaceSwitching: 'exclude' })`
  requested synchronously in the Start click (`max` width / height constraints, otherwise Chrome
  raises the page DPR). Per frame a marker strip (74 blocks of 8×8 CSS px: sync + 32-bit nonce +
  32-bit sequence + CRC-8) at the bottom edge proves the grabbed stream frame shows THIS run and
  THIS frame; the band is cut off. Geometry frozen after the sharing infobar settled, rounded down to
  even; a change of stream size / DPR / window aborts (cinematic stays resumable). Output size =
  window × display scale. Progress in the tab title; Esc or "Stop sharing" cancels. A still with the
  HMI shows the state after sharing was granted. Private: `src/plugins/video-record-ui/rv-tab-capture.ts`.
  The stream is I420 4:2:0 limited range: fine coloured text on coloured ground loses chroma in the
  dialog still (the CLI still is full RGB).

**MCP** — `web_record_video` (same options, flat): writes `recordings/<name>.mp4` into a writable
project, else the browser downloads it; returns `{ path | download, frames, seconds, sizeBytes,
codec, renderSeconds, … }`, never the bytes. Not cancellable in v1; a job whose estimated render
time × 2 exceeds the 600 s tool limit is refused, and every MCP capture has a local 540 s deadline.

**Quality.** `standard` = exactly what the viewer draws. `high` (default) = 2× supersampling
(capped by the GPU texture/renderbuffer/viewport limits and 8K; the result reports the real
`supersample`), AO/bloom buffers at full render resolution, a 4096² directional shadow map and an
exact linear-light box downscale. `max` = high + `jitter` (default 4) Halton-jittered sub-renders
per frame averaged together — spatial anti-aliasing without temporal artefacts (the simulation
does not advance between them). Outline edge thickness, the toon outline, fat-line widths and
WebLabel screen sizes are scaled so they look the same after the downscale.

**Time model and limits (v1).** fps ∈ {30, 60}; `seconds × fps` must be whole; the warmup is
rounded to whole fixed steps; frame *i* shows the sim after `warmup + (i+1)/fps` and the camera at
`i/fps`. The MP4 is built in memory: an estimate above 512 MB is refused, and the actual encoder
bytes are counted too. Supported states: a loaded model, local continuous simulation (not DES, not
live-controlled, not a multiuser follower, runtime attached), WebGL renderer, one capture at a
time. A paused simulation still runs during the capture; pause state, camera, selection, size,
DPR, loop state and every quality setting are restored afterwards — also after an error, an abort
or a model change.

**Cinematic (plan-550, commercial builds).** `--quality cinematic` path traces every frame with
three-gpu-pathtracer's `WebGPUPathTracer` on its **own WebGPU device** next to the WebGL viewer
(the capture itself stays WebGL; `WebGLPathTracer` is never used — 0 samples in 570 s in the
spike). The capture loop is shared: same sim steps, camera path, raster tick, abort and restore;
only the frame source differs (`src/core/engine/rv-cinematic-hook.ts`, registered by the private
`cinematic-render` feature, lazy — a community build answers *Cinematic render is a commercial
feature*). Frames go to disk as PNG, not into the encoder:

```bash
npm run record -- "http://localhost:5173/?project=prj_sample&doc=doc_laserweldingassemblystation_1n66y05" \
  --quality cinematic --out-dir recordings/station-cinematic --size 1920x1080 --fps 30 --seconds 10 \
  [--samples 64] [--denoise aux|noaux|off] [--hdr my.hdr] [--mp4 out.mp4] \
  [--look studio|viewer|hall|outdoor] [--vignette 0.15] [--dof [--fstop 5.6]] \
  [--no-material-presets] [--material-overrides cinematic-materials.json] \
  [--motion-blur on|off] [--shutter 180] [--blur-subframes 8]
# smoke: --samples 4 --size 160x90 --seconds 1 --fps 30   (4 spp = motion blur off for the run: < 8 spp)
```

- **Out dir** = `frame-%06d.png` (written atomically, `.tmp` → rename) + `cinematic.json` (options
  hash, model structure hash, HDR hash, environment + lights, camera poses, tracer/denoiser
  versions, seed rule, unseeded-randomness list, meshes that could not be copied). The MP4 is
  muxed from the PNGs at the end (`viewer.muxVideoFrames`, same encoder ladder), frame count verified.
- **Resume** is implicit: run the same command again. The CLI resumes at the first missing frame
  (a truncated last PNG is re-rendered); the page fast-forwards the sim with the SAME per-frame
  sequence (step + camera + raster tick, no trace). Any manifest difference refuses and names the
  field. Unseeded randomness (Source `RandomDistance`, Erratic drivers) is listed and warned about.
- **Exit codes**: 0 ok, 1 failed, 2 usage, **3 = stopped but resumable** (Ctrl+C after the current
  frame, a stalled frame — watchdog 10 × the last frame time, ≥ 120 s, first frame 300 s — or a lost
  WebGPU device). Ctrl+C during the scene setup takes effect after `setScene` returns (it blocks the
  main thread: station ≈ 3–13 s, Mauser ≈ 35 s).
- **What is traced**: a COPY of the model (chunk index order untouched, doc-render-picking
  § 1.5.3). Skipped: overlays (`__*`), highlight range proxies, skinned / non-MU instanced meshes,
  sensor visualisation, non-PBR / custom-shader materials (laser beam, WebLabels, gizmos). Uber
  chunks are split into material buckets by `rmPacked`; MU pools are expanded per active instance.
  Per frame the copy is diffed: motion/visibility → `updateTransforms`, colour/emissive →
  `updateMaterials` (`material.version` alone is ignored — some paths bump it every frame),
  spawned/sunk MUs → `setScene` with cached BLAS.
- **Detached buffers**: the async per-mesh BVH build (`_startAsyncBvhBuild` → `GenerateMeshBVHWorker`)
  transfers a mesh's position/index buffers until its build resolves. The capture waits for
  `viewer.whenBvhIdle()` before the fingerprint and before the copy; a buffer still detached is
  retried, and whatever cannot be copied is printed and listed in the manifest — never dropped.
- **Look (plan-553)** — `--look` (default **studio**), data in the private
  `src/cinematic/rv-cinematic-looks.ts`:
  - `studio`: a light-grey cyclorama (floor + back wall joined by a quarter circle, radius ≥ 0.4 ×
    content size, roughness 0.7) sized from the content bounds; a camera that stays on one side
    (spread ≤ 100°: fixed, short orbit, close presets) gets the back wall behind the model, a path
    around the model gets a seamless bowl the camera stays inside. Key / fill / rim
    `RectAreaLight`s placed relative to the frame-0 camera, the studio HDRI
    (`envmaps/studio.hdr`, Poly Haven *Studio Small 08*) at 0.25, AgX tone mapping.
  - `viewer`: the plan-550 setup unchanged — the raw equirect of the environment preset
    (`DEFAULT_ENVIRONMENT_HDR` = `envmaps/empty_warehouse_01_1k.hdr`), the viewer's environment
    intensity / rotation / background, its visible directional lights, its tone mapping and a plain
    PBR floor instead of the checker / reflector.
  - `hall`: the warehouse HDR as light AND background + a concrete floor, AgX.
  - `outdoor`: a bright partly-cloudy sky (`envmaps/outdoor.hdr`, Poly Haven *Kloofendal 48d
    Partly Cloudy Pure Sky*) + a ground plane, AgX.
  `--hdr` replaces only the look's HDR (lights, floor and tone curve stay). Order of the image:
  linear accumulation → OIDN → tone mapping (`renderer.toneMapping`, applied exactly once by the
  tracer's present pass — Phase 0) → sRGB → **vignette** (`--vignette`, default 0.15 = corners 15 %
  darker, 0 = off) on the 8-bit frame.
- **Material presets (plan-553, default on)** on PRIVATE clones in the traced copy — viewer
  materials are never modified. Uber-chunk buckets are additionally split per triangle by a preset
  class from vertex colour + roughness / metalness (transparent → **glass** with transmission,
  metalness ≥ 0.8 → **brushed metal**, saturated + glossy + non-metal → **paint** with clearcoat,
  dark + rough → **rubber**); named meshes (`tex:*` chunks, keep meshes) match `glas|glass|scheibe`,
  `alu|aluminium`, `lack|paint`, `gummi|rubber`. `--material-overrides <json>` =
  `{ "rules": [{ "match": "<regex>", "preset": "glass|brushedMetal|paint|rubber|none", "params": { … } }] }`
  for NAMED meshes / materials (unnamed uber buckets are reachable through the heuristic only);
  its content is part of the fingerprint. Clones are keyed by (source material, preset / override)
  and refreshed from the source on every `sync()`. **Lamps** (`userData._rvLampMesh`) glow: their
  clone follows `isLit()` / `getOnColorHex()` with `Intensity × 3 × exposure`.
  `--no-material-presets` = the plan-550 materials (lamps included). The setup line prints the
  counts per preset; capabilities the tracer lacks would degrade a preset and be listed.
- **Depth of field (plan-553, opt-in)**: `--dof [--fstop 5.6]` swaps in three-gpu-pathtracer's
  `PhysicalCamera` (6 blades); the focus distance is `|position − target|` of the camera-path pose
  per frame (orbit: the centre, fixed: the target, presets: the interpolated target).
- **Motion blur (plan-554, default on: 180° trailing shutter, K = 8 sub-frames)** — path A: the
  S samples of a frame are accumulated in ONE tracer accumulation across `K_eff = max(1, min(K,
  ⌊S/4⌋))` sub-times of the shutter `[T − shutter/360/fps, T]` (tranche targets `⌈S·(j+1)/K_eff⌉`;
  `K_eff = 1`, i.e. fewer than 8 spp, renders the run sharp and says so). Capture side
  (`rv-video-capture.ts`): a rendered frame runs its 60 Hz steps ONE BY ONE under the read-only
  `CinematicMotionRecorder` hook (`beginFrame` → `afterStep` × steps → `captureRenderFrame` →
  `afterRender`) — no extra tick, and nothing in the viewer graph is refreshed (one
  `updateMatrixWorld` between two steps changed the simulation in the spike); the fast-forward of a
  resume and a run without blur never call it (N3). Every sub-time evaluates the camera PATH
  (`ctx.cameraAt(offset)`; frame 0 clamps to t = 0, a cut — a preset boundary with transition 0,
  `CameraPath.cutTimes()` — holds the post-cut pose). Private side
  (`src/cinematic/rv-cinematic-motion.ts`): source-local TRS of every traced mesh and its ancestors
  per step, interpolated on the SOURCE hierarchy (children of a turning parent follow the arc); a
  node turned by a rotational Drive uses the Drive's signed travel (`RVDrive.stepTravel` /
  `travelOdometer` — several turns per step are exact; other nodes slerp, correct below 180° per
  step). Held at the frame end instead of blurred: spawn / despawn, a re-parent, an MU id missing in
  a bracketing state (MUs are keyed by `muId`, never by slot — `release()` swaps and pops), a Drive
  whose `discontinuityRev` changed (direct `currentPosition` writes, `Drive_FollowPosition`,
  `reset()`, multiuser sync), a transform changed at render time (onRender / effects), and an
  unmarked teleport (> 250 mm and > 20× the previous step). Renderer
  (`rv-cinematic-renderer.ts`): `sync()` + public updates, ONE `reset()`, then per sub-time
  interpolated matrices → camera → the adapter's reset-free `_bvhData.updateTransforms()` /
  `_cameraRayFnHandle.update()` → `maxSamples = t_j` → wait (the plan-553 stall watchdog per wait);
  the denoiser is detached meanwhile and runs once with scene + camera at the shutter middle. The
  adapter (`createMotionTracerAdapter`) checks the INSTALLED tracer version (package.json at build
  time, verified: 0.0.26) and its private members once in `setup()`: unsupported → the whole run is
  `off` with the reason. A camera-shader rebuild or a throwing hook in a frame is a resumable error —
  never a sharp replacement frame. The CLI prints `motion blur: pathA-v1, K sub-frames` (or the
  fallback reason) after the scene setup; frame lines carry `blurSubFrames` / `blurMoving` in the
  stats. Measured on the spike: ≤ +5 % per frame at 1080p/64 spp, K = 8.
- **Fingerprint**: the look is resolved BEFORE the fingerprint (`resolveLook`): `look` (name,
  resolved parameters, look / preset algorithm versions, fallbacks, DoF, vignette, override content
  hash) and the hash of the HDR bytes actually loaded are resume fields; the requested options are
  part of `optionsHash` with a readable `lookOptions` copy. A plan-550 folder is refused naming
  `lookOptions`. plan-554: the REQUESTED blur (`motionBlur`, canonical off form
  `{ enabled: false, shutterDeg: 0, subFrames: 1 }`) is in `optionsHash` with a readable copy — a
  pre-554 folder is refused naming `motionBlur`; the RESOLVED blur (`resolvedBlur: pathA-v1 | off`,
  `blurFallbackReason`, `blurSubFrames`) is known only after the scene setup, so the CLI and the
  dialog folder sink compare it a second time there, before the first frame — a folder rendered with
  blur is never continued without it, and vice versa.
- **Assets**: the private tree's `assets/oidn/*.tza` and `assets/envmaps/{studio,outdoor}.hdr` are
  served as `<base>oidn/` / `<base>envmaps/` by `cinematicAssetsPlugin`
  (`scripts/_rv-cinematic-assets.mjs`), emitted into `dist/` only when the renderer is bundled and
  staged into customer workspaces with the `cinematic-render` feature.
- **Denoiser**: oidn-web + OIDN weights (see Assets). `aux` (albedo + normal guides, default),
  `noaux`, `off`.
- **Throughput** (GTX 1060, station 1080p, spike): 64 spp + OIDN ≈ 22 s/frame → 10 s @ 30 fps ≈
  1.8 h; 32 spp ≈ 12 s/frame. PNGs ≈ 1.2–1.3 MB each. plan-553 budget (user decision 2026-10-05): the studio look may cost
  at most +40 % per frame against the viewer look (measured +36 %: the cyclorama turns every background
  pixel into a full path), the other looks +20 %.
- **MCP**: `web_record_video` refuses `quality: cinematic` with a pointer to the CLI (no new tool
  parameters — delegate payload ceiling).
- **Dev server**: the tracer packages are excluded from Vite's dep optimizer and their own bare
  imports (`three/webgpu`, `three/tsl`, `three-mesh-bvh/webgpu`, `Pass.js`) are pinned in
  `optimizeDeps.include` — a mid-session re-optimization reloads the page during a recording.

**Determinism.** Same options + same start state → same frame count, timestamps and sim time per
frame. Not visually identical for models with unseeded randomness (e.g. Source `RandomDistance`).
Known wall-clock readers that do not affect motion: the gizmo blink phase
(`rv-gizmo-manager.ts`) and the LogicStep cycle-time statistic (`rv-logic-step.ts`).

## 5. Debugging Workflow

### Typical Debug Session

1. **Start the dev server**: `/webviewer` or `npm run dev` in `Assets/realvirtual-WebViewer~/`
2. **Load a model** in the browser
3. **Check health**: `/debugweb` for full snapshot, or `/testbrowser check`
4. **Investigate issues**:
   - `/debugweb logs warn` — see recent warnings/errors with stack traces
   - `/debugweb errors` — browser console errors
   - `/debugweb signals` — check signal states
   - `/debugweb changelog` — see what changed recently
5. **Interact**: `/debugweb set SignalName true` to toggle signals
6. **Visual inspect**: `/testbrowser screenshot` to see the browser state

### "A library asset is old" / "could not be loaded" — the asset cache (plan-508)

Placeable GLBs (and splats) are fetched through `RVAssetBlobCache`: an in-memory
tier plus a browser **Cache API** bucket — `rv-assets-glb-v2` for GLBs,
`rv-assets-splat-v2` for splats. The old url-keyed buckets `rv-planner-glbs` /
`rv-planner-splats` are deleted on the first open of a session; there is nothing to
migrate, the bytes come back from the network.

**The cache key is url + catalog hash.** Both catalog builders write `sha256` +
`sizeBytes` per entry (`public/library/catalog.json` via `npm run build:library`,
which `prebuild` runs), the deploy re-stamps them after signing, and the catalog
normalizer registers them in a url → hash registry
(`src/core/library/rv-asset-hash-registry.ts`). `ModelCache` and the splat plugin
look the hash up **by url**, so a drop, a hover prefetch, a nested placement and a
splat all take the same path. Consequences worth knowing when something looks stale:

- A **changed file with a re-stamped catalog** is simply a new key: miss, download,
  verify, store — and the older version of that url leaves both tiers. No manual
  cache clearing needed.
- A **hit is not re-hashed** (it was verified when stored); it is only magic-checked.
- Downloaded bytes that do **not** hash to the catalog value are evicted and fetched
  once more with `cache: 'reload'` (past the browser's HTTP cache). A second mismatch
  fails the load: the Problems panel shows *"Referenced asset could not be loaded: …
  Load failed: hash mismatch (expected ab12…, got cd34…)"*. That means the catalog is
  out of date for the file on the server — re-run `npm run build:library` (dev) or
  redeploy (the deploy stamps after signing). Unverified bytes are never served.
- A catalog **without** hashes (hand-written, customer catalogs) keeps the older
  behaviour: magic check plus a same-origin conditional GET (`If-None-Match` /
  `If-Modified-Since`); cross-origin hits are trusted.
- `ModelCache` remembers the hash each key was requested under: a different hash —
  including an unhashed prefetch followed by a hashed load — invalidates decoded,
  baked and in-flight work (epoch bump, like an editor save). A catalog reloaded
  mid-session with a new hash does the same through the registry subscription.

**Read what the cache did** instead of guessing:

- `web_status` → `cache`: the newest outcomes (default 20, `cacheLast` up to 128),
  counters per outcome since the last clear, `storage` (`navigator.storage.estimate()`
  usage/quota) and `persisted` (the `navigator.storage.persist()` verdict, asked once
  after the first store — Safari evicts unpersisted storage after seven idle days).
- DevTools › Render › **Asset cache**, under the bake stats: the same table
  (time, outcome, file, bytes, ms), **Clear outcomes**, and **Clear persistent cache**
  (wipes both buckets and the snap index, then reloads).
- Console lines keep their `[blob-cache:<bucket>] HIT / MISS / STALE / REPLACED /
  EVICT / HASH MISMATCH / NO-CACHE` prefix.

| Outcome | Meaning |
|---|---|
| `hit` | Served from the Cache API, no network (hash key, or a hit without validators / cross-origin) |
| `revalidated` | Unhashed hit, conditional GET answered 304 |
| `replaced` | Unhashed hit, conditional GET answered 200 — the newer file replaced it |
| `offline-hit` | Unhashed hit, revalidation unreachable — the cached bytes were served |
| `miss` | Downloaded (verified when hashed), stored when a Cache API exists |
| `evicted` | A stored entry failed the content check (e.g. an HTML page) and was dropped |
| `rejected` | A network body failed the content check (HTML, too short, opaque) — nothing stored |
| `hash-mismatch` | Downloaded bytes did not hash to the catalog value (`detail`: expected/got, attempt) |

**Missing asset paths answer 404 in dev.** The Vite plugin `rv-asset-404-guard`
(`vite.config.ts`, middleware in `scripts/lib/rv-fs.mjs`) answers `404 text/plain`
for a missing `library/**`, `models/**` or any `*.glb`, `*.kin.json`, `*.splat`,
`*.ksplat`, `*.ply` — checked case-exactly and file-only against `public/` and the
project root — instead of Vite's SPA `index.html` with status 200 (that page, cached
once under a GLB url, was the 2026-09-26 "not found" incident). Vite-internal paths
(`/@…`, `/__…`, `/src/`, `/node_modules/`) and `/private-models/`, `/private-assets/`
are left alone. The CONNECT counterpart for installed mounts is
`DevProxyMiddleware.IsReservedPath()`; the deploy counterpart is the post-deploy probe
(`doc-deploy.md` § *Library catalog hashes and the post-deploy probe*).

### After Making Code Changes

1. Run TypeScript check: `npx tsc --noEmit`
2. Run unit tests: `npx vitest run`
3. Run e2e smoke test: `npx playwright test e2e/smoke.spec.ts`
4. Check logs: `/debugweb logs warn` for any new warnings

### Debugging Context Menus

Context menus are managed by `ContextMenuStore` (`context-menu-store.ts`). When a right-click menu doesn't show expected items:

1. **Check registrations** — In the browser console:
   ```js
   import { contextMenuStore } from './core/hmi/context-menu-store';
   // The store's snapshot shows open state and resolved items
   console.log(contextMenuStore.getSnapshot());
   ```

2. **Condition evaluation errors are swallowed** — If a menu item's `condition` callback throws, the item is silently hidden (treated as `false`). Add a breakpoint inside your condition function to verify it doesn't throw.

3. **Items appear but shouldn't** — Check that your `condition` function properly tests the `target` object. Common issue: checking `target.nodePath` when the click target is the ground plane (no node).

4. **Menu doesn't open at all** — The drag guard suppresses context menus after a pointer-move exceeding 8px. If you moved the mouse slightly during right-click, the menu is intentionally suppressed. On touch devices, a 500ms long-press is required.

5. **Debugging UI context visibility** — Check which contexts are active (`isUIElementVisible` takes the active-context set as its second argument):
   ```js
   import { getActiveContexts, isUIElementVisible } from './core/hmi/ui-context-store';
   console.log('Active contexts:', getActiveContexts());
   console.log('button-panel visible:', isUIElementVisible('button-panel', getActiveContexts()));
   ```

6. **Context overrides from settings.json** — If elements appear/disappear unexpectedly, check `settings.json` for `ui.visibilityOverrides` rules that may override the programmatic defaults. Each entry maps a registered element id to a `UIVisibilityRule` — arrays of contexts under `hiddenIn`, `shownOnlyIn` and/or `shownOnlyInAny`, never a per-context boolean map:
   ```json
   {
     "ui": {
       "visibilityOverrides": {
         "button-panel": { "hiddenIn": ["planner", "xr"] },
         "help": { "shownOnlyIn": ["kiosk"] }
       }
     }
   }
   ```
   `hiddenIn` hides when ANY listed context is active, `shownOnlyIn` shows only when ALL are, `shownOnlyInAny` shows when at least one is; they combine with AND. Config overrides beat the code-declared defaults — see [`doc-ui-visibility.md`](doc-ui-visibility.md).

### The inspector JSON editor misbehaves — `rv-webviewer-json-editor` (plan-555)

`WebOperatorPanel.Config` uses a Monaco JSON editor on desktop. To rule it out, switch every
JSON field back to the plain text field and reload:

```js
localStorage.setItem('rv-webviewer-json-editor', '0');   // text field everywhere
localStorage.removeItem('rv-webviewer-json-editor');     // back to the editor
```

Read when the field mounts (`isJsonEditorEnabled()`, `src/core/engine/rv-dev-load-flags.ts`);
no UI writes it. Touch devices always get the text field, and a Monaco chunk that cannot
load falls back to it on its own (`console.warn` "Monaco failed to load").

### Enabling Verbose Logging for a Specific Area

To debug transport issues, for example:

```
http://localhost:5173/?debug=transport,sensor
```

Or at runtime in the browser console:

```js
window.viewer  // Access viewer instance
// Enable debug category programmatically:
import { enableDebug } from './core/engine/rv-debug';
enableDebug('transport');
```

### Reading write-authority conflicts

When a component's value "does not stick", the write gate has usually recorded
why. It is on in every build — the default mode is `shadow`, which records but
never rejects, so the log is populated even though nothing is being blocked.

```js
window.__rvViewer.signalStore.getWriteConflicts()
// [{ slotId, writerId, writerKind, reason, writeCount }, …]
```

Entries are deduplicated per `(slot, writer, reason)`; `writeCount` is how often
that same conflict recurred, so a four-digit count means "every tick", not "four
times".

Reading `reason`:

| `reason` | What it means |
|---|---|
| `authority-forced` | An operator force pins the channel, or a slot on it is `forced`. The value is held. |
| `authority-bound` | A live binding owns a **command** slot on the channel; the local write is displaced by the relay. |
| `authority-remote` | A remote session owner pre-empts this writer (UI hint only; see the ranking section in `doc-signal-architecture.md`). |

Two things changed with plan-353 and are worth knowing when comparing against
older notes or screenshots:

- **The reason now matches the authority that actually decided.** The old gate
  returned at the first claimed slot it found on the channel and always logged
  `authority-bound`, so a forced slot registered later was reported as bound —
  or not reported at all. The channel is now ranked in full (`forced` >
  `bound(control)` > `bound(feedback)`) and `slotId` names the deciding slot.
- **A bound FEEDBACK slot is no longer a conflict.** Command authority belongs
  to CONNECT, feedback authority to the component that produces the value, so a
  local write to a channel whose bound slots are all `feedback` is permitted and
  logs nothing. If you expected an entry and see none, check the role first:

```js
// The role the gate is using for a slot (default 'control' when unregistered):
window.__rvViewer.signalStore   // …then compare with the binding's own role
```

A slot whose role reads `control` when you expect `feedback` usually means the
slot signal's PLC type never arrived (`_deriveSlotRole` falls back to `unknown`,
which the gate treats like `control`) — check that the gateway registered the
type, not the binding.

### "Something is missing" — the duplicated-scene signature

A user report of the shape *"parts of the machine are just not there"* after a
CAD import or an editor open is often not a missing part at all: it is TWO
complete copies of the model in the scene, drawn on top of each other, with
z-fighting deciding per-pixel which one you see. The registry, the hierarchy and
the selection outline all look perfectly correct, because they describe one of
the copies — which is what makes it so confusing to chase from the UI.

Ask `web_status` first; the counts give it away immediately:

| Field | Healthy | Duplicated |
|---|---|---|
| `render.meshes` | the model's mesh count | roughly **2×** it (live case: 208 instead of ~92) |
| `render.maskHistogram["mesh:1"]` | one entry per model mesh | **doubled** |
| `render.meshesEffVisible` | matches the visible model | a mix of both copies, so neither count matches |

Confirm from the console — a healthy scene has exactly one model root:

```js
window.__rvViewer.scene.children.filter((c) => c.userData._rvModelRoot).length  // must be 1
window.__rvViewer.checkSingleModelRoot('manual')   // logs under the `loader` category in dev
```

**Recovery: reopen the document** (`web_editor_open`, or leave and re-enter the
mode). The next load's `clearModel()` sweeps every tagged root, so one clean
open is enough — nothing has to be repaired by hand and nothing was lost.

**Cause, and why you should rarely see it now.** It took two overlapping
`loadModel()` runs: the loser's root is parented by `loadGLB` but only tagged
`_rvModelRoot` after the load completes, so the winner's `clearModel()` sweep
ran through the window where the root was invisible to it. Since plan-442 the
root adoption is generation-checked — an overtaken run disposes its own subtree
and rejects with `LoadAbortedError` — and editor activations are serialized
through one queue, so the two runs cannot overlap in the first place. A
backgrounded tab used to widen the window enormously (Chrome throttles timers in
hidden tabs, stretching a load from 6 s to 37 s in the reported case), which is
why the report came from a session left in the background.

If the doubled counts DO come back, that is a real regression: capture
`web_status`, the `loader`-category log lines around the load, and whether the
tab was hidden.
