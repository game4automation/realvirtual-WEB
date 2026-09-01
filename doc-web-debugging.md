# Debugging & Observability

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
