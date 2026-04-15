# Debugging & Observability

Guide for debugging the realvirtual WebViewer — structured logging, HTTP debug API, Claude Code integration, and automated E2E testing.

---

## 1. Structured Logging System

The WebViewer uses a category-based structured logging system (`rv-debug.ts`) with an always-on ring buffer. All log entries are captured regardless of whether a category is enabled for console output.

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
import { debug, debugWarn, debugError } from './rv-debug';

debug('signal', 'value changed', { name, value });     // level: debug
debugWarn('drive', 'speed limit exceeded', speed);      // level: warn, captures stack
debugError('loader', 'failed to parse node', err);      // level: error, captures stack
```

**System-level logging** — always prints to console AND buffers:

```ts
import { logInfo, logWarn, logError } from './rv-debug';

logInfo('Model loaded successfully');
logWarn('WebSocket reconnecting...');
logError('Critical failure', errorObj);
```

### Querying the Log Buffer

The ring buffer holds the last 500 entries. Query it programmatically:

```ts
import { getLogBuffer, getLastLogs, queryLogs, clearLogBuffer, getLogBufferSize } from './rv-debug';

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

The WebViewer exposes a bidirectional debug bridge via HTTP endpoints on the Vite dev server. The browser pushes state snapshots at ~1 Hz; external tools read them via GET requests.

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

Inspects the running WebViewer directly from Claude Code:

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

The Playwright MCP server is configured in `.mcp.json`:

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

Automated end-to-end tests in `e2e/` verify WebViewer functionality using Playwright.

### Running Tests

```bash
cd Assets/realvirtual-WebViewer~

npx playwright test                           # Run all e2e tests
npx playwright test e2e/smoke.spec.ts         # Smoke tests only
npx playwright test e2e/hmi-panels.spec.ts    # HMI panel tests only
npx playwright test e2e/debug-endpoint.spec.ts # Debug API tests only
npx playwright test e2e/perf-smoke.spec.ts    # Performance benchmark
```

The dev server starts automatically on port 5177 (configured in `playwright.config.ts`).

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
   import contextMenuStore from './core/hmi/context-menu-store';
   // The store's snapshot shows open state and resolved items
   console.log(contextMenuStore.getSnapshot());
   ```

2. **Condition evaluation errors are swallowed** — If a menu item's `condition` callback throws, the item is silently hidden (treated as `false`). Add a breakpoint inside your condition function to verify it doesn't throw.

3. **Items appear but shouldn't** — Check that your `condition` function properly tests the `target` object. Common issue: checking `target.nodePath` when the click target is the ground plane (no node).

4. **Menu doesn't open at all** — The drag guard suppresses context menus after a pointer-move exceeding 8px. If you moved the mouse slightly during right-click, the menu is intentionally suppressed. On touch devices, a 500ms long-press is required.

5. **Debugging UI context visibility** — Check which contexts are active:
   ```js
   import { getActiveContexts, isUIElementVisible } from './core/hmi/ui-context-store';
   console.log('Active contexts:', getActiveContexts());
   console.log('bottomBar visible:', isUIElementVisible('bottomBar'));
   ```

6. **Context overrides from settings.json** — If elements appear/disappear unexpectedly, check `settings.json` for `uiVisibility` rules that may override the programmatic defaults:
   ```json
   { "uiVisibility": { "bottomBar": { "planner": false } } }
   ```

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
