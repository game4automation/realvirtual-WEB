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

### On-demand features: `[feature]` and the bundle guard

The Editor and DES load on first use (plan-652, concept in
[doc-extending-webviewer.md](doc-extending-webviewer.md#on-demand-features--the-featureloader-plan-652)).
When something about them looks slow or missing, check in this order:

| Where | What it tells you |
|---|---|
| Console (level *Verbose*) `[feature] asset-editor declared on demand (mode:editor) · stub … ms` | the build ships the feature and did not load it at startup |
| `[boot] features: startup N (… ms; top 3) · deferred M` | one line per start: what loaded eagerly and how many features wait for a trigger |
| `[feature] des ← component:DESManager · 412 ms · 203 KB` | an activation: trigger, duration, chunk bytes (`console.info`) |
| `[feature] … failed after … ms` + Problems `feature-load-failed:<id>` | the load or `activate()` threw; **Retry** in the Problems panel re-runs it (`feature.retry`) |
| Problems `feature-stale-build` "New version available — reload" | a chunk of an older deploy is gone (`vite:preloadError`); reload after saving |
| Problems `feature-late-component:<type>` | a lazy component type reached construction without the pre-scan; it was built after the activation — report the load path |
| DevTools › Performance: `rv:feature.<id>`, `rv:feature.prescan` | the activation span and the cost of the component-type scan of a load |
| Settings › DevTools › **Features** | every feature with state (`declared` / `loading` / `active` / `failed`), trigger, ms, KB |
| `web_status({detail:"render"})` → `features` | the same rows over MCP: `{ id, state, trigger, activation, ms, bytes, error? }` |
| `web_query("des.status", {})` before DES is active | Refused with `not in DES mode`; hint: `web_execute("workspace.setMode", {mode:"des"})` |

**Build side.** Every production build writes `dist/feature-chunks.json` — per feature the JS files a
first activation fetches and their bytes (the source of the KB in the lines above and of the idle
prefetch). `npm run test:bundle-guard` builds the **generated** demo entry (never into `dist/`) and
fails when that entry chunk is over its size budget — the `demo-entry-chunk` pin in
`tests/bundle-budgets.json`, measured in bytes on two independent paths that must agree, and enforced
in `--mode report` as well (until 25.10.2026 this guard printed the entry's size and exited OK: it had
no budget at all and was green 300 kB over) —, when the entry carries Editor, DES or any
`features/*.body` code, when the **boot set** (entry +
startup adapter chunks + their static imports) loads an editor body, DES or a feature body — tolerated
are only the startup stores in `asset-editor/shared/` (up to 64 KB) and the two editor modules startup
adapters import on purpose, `editor-dialog-store` and `mechanism-force-gizmo` (up to 16 KB, 7 KB today) —
or when the build or its chunk table is missing. It is a minutes-long build and therefore not part of `test:all`; run it before a
merge that touches imports of private features. `node scripts/analyze-demo-entry.mjs --keep` builds
the same stage with source maps and prints the composition per source group.

### Robot IK: why a robot only replays

A robot whose rig the viewer cannot use does not stop — it keeps replaying the joint angles Unity
baked into its `IKTarget`s, so it looks like it is working while LIN motion, the interactive
re-solve and the reachability colouring are all quietly absent. Every one of those cases is a
Problems entry now (`IK_PROBLEM_CODES` in `src/core/hmi/problems-store.ts`), reported once per
robot per load by `RVRobotIK` after the kinematic re-parenting pass:

| Problems code | Severity | What it means |
|---|---|---|
| `robot-ik-axes-unresolved` | error | `RobotIK.Axis` resolved to no `Drive` — the robot cannot move at all. Also raised by an `IKPath` that tries to run without drives. |
| `robot-ik-chain-unresolved` | error | No serial 6-revolute chain could be derived. The detail names the axis that broke it and why (not nested under its predecessor, a linear axis in the chain, the wrong axis count). |
| `robot-ik-tcp-unresolved` | error | `RobotIK.TCP` is written in the file but names no node. The tool pose collapses onto the A6 flange — every solved pose is off by the whole tool. A robot with *no* TCP is the supported flange case and is not reported. |
| `robot-ik-opw-unusable` | error | `getOpwParams()` is null (no finite `a1`): no LIN, and reachability cannot be decided. |
| `robot-ik-wrist-type-missing` | warning | No `WristType` in the file, so `Spherical` is assumed — a cobot exported before the field existed is solved with the wrong model. |
| `robot-ik-target-no-angles` | warning | An `IKTarget` has no usable `AxisPos`; the waypoint is skipped and the robot visits a different pose sequence. |

Three related traps worth knowing:

- **Waypoint markers.** Grey means *unknown*, not reachable — no solver, no OPW parameters, or a
  cobot without a derivable chain. Lavender and red are only ever shown after a real solve of the
  robot's own kinematic model; a cobot is never answered by the spherical Pieper solver.
- **`loadGLB` without a `bakeRegistry` does not bake.** The destructive pipeline is gated on
  `!preserveHierarchy && !!options.bakeRegistry`, and `RVViewer` always passes one. A test that
  calls `loadGLB(url, scene, { data })` therefore checks the *authoring* tree (117 nodes on
  `DemoRobotIK.glb`, against 78 baked) and cannot see a node the bake removes — which is exactly
  how the missing `RobotIK.TCP` bake target stayed green for so long. Since plan-772 there is one
  way to load the production tree in a test, `loadBakedGLB()` in
  `tests/helpers/load-baked-glb.ts`: it passes a registry, refuses the authoring flags and proves
  from the RESULT that the bake ran. `tests/bake-test-path-enforced.node.test.ts` fails when a new
  test file loads a GLB without it; the files allowed to load unbaked are listed, with a reason
  each, in `tests/helpers/baked-load-allowlist.ts` (35 declared authoring suites plus 12 legacy
  files nobody has reviewed yet — that second list is the remaining debt).
- **There are TWO solve frames, and a pose handed to the wrong one looks plausible.**
  `targetPoseInBase(base, target, outPos, outQuat, frame)` takes the frame as an argument
  (plan-772): `'chain'` is the glTF orientation the derived joint chain lives in and what
  `solveCobot` reads; `'unity'` is Unity's left-handed frame and what `solvePieper` reads, because
  the OPW parameters come from Unity. `solveFrameFor(wristType, jointChain)` answers which one, on
  exactly the condition the callers use to pick the solver — call it rather than deciding locally.
  The symptom of getting it wrong is a solve that is exact on some waypoints and 60–180° off on
  others, because the mirror is invisible on any tool frame that is a rotation about X or a 180°
  flip — which most tool frames are.

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

npm run e2e                                   # Run all e2e tests (under the test lock)
npm run e2e -- e2e/smoke.spec.ts              # Smoke tests only
npm run e2e -- e2e/hmi-panels.spec.ts         # HMI panel tests only
npm run e2e -- e2e/debug-endpoint.spec.ts     # Debug API tests only
npm run perf                                  # Performance benchmark (e2e/perf-smoke.spec.ts, headed)
```

A bare `npx playwright test …` still works but is **not** protected by the machine-wide test
lock (next section) — prefer the npm scripts.

`playwright.config.ts` starts **two** web servers, both with `reuseExistingServer`:

| Server | Port | Serves |
|--------|------|--------|
| `npm run dev -- --port 5187` | 5187 (`RV_E2E_PORT`) | the dev server — `baseURL` of the `chromium` project, which runs every spec except `embed-smoke.spec.ts`. Default 5187 since plan-606, so it is no longer the vitest browser API port 5177 |
| `npm run preview:embed` | 4178 | the **built** embed artifact from `dist-embed/` — `baseURL` of the `embed-chromium` project, which runs `embed-smoke.spec.ts` only |

The embed server previews a production build, so `npm run build:embed` has to have produced `dist-embed/` before `embed-smoke.spec.ts` can pass.

### Machine-wide test lock (plan-606)

Machine-wide coordination covers the vitest browser suite, node suite, `test:all`, e2e and the
`perf*` runners, across the canonical checkout and every worktree. A run under foreign load
produces reds that are not real (2026-10-14: 34 reds in 14 files, every file green alone).

**Classes and capacity (plan-2200).** `heavy` holds H0 (the base port, default 47177);
`light` holds one of twenty slots at base+3 through base+22 and can coexist with heavy runs;
`exclusive` holds H0 and all twenty light slots. Base+1 and base+2 stay reserved.
In budget mode, an explicit list of 1–20 existing test files in a recognised `vitest run`
invocation qualifies as light; perf runners and perf/GPU configs are exclusive; other runs are
heavy. Override with `RV_TEST_LOCK_CLASS=light|heavy|exclusive` or `--class=light|heavy|exclusive`
(the environment wins; arguments still pass through unchanged).
Capacity defaults to `budget` at >=24 available threads, otherwise `single`;
`RV_TEST_CAPACITY=single|budget` selects it explicitly. Only budget mode sets
`VITEST_MAX_WORKERS`: light gets 4, heavy gets floor(0.75 × threads / 2), i.e. a 12-worker
budget at 32 threads; `RV_TEST_MAX_WORKERS` can override it. Exclusive uses runner defaults.
Single mode always uses heavy and leaves `VITEST_MAX_WORKERS` unset. Re-entering wrappers and
`RV_TEST_LOCK=off` do not apply class or worker environment changes. Direct `npx vitest` keeps
the legacy heavy lock on H0 without a worker budget. `status` shows all holders, including light
slots. Runtime, startup, stall and per-file limits retain their existing rules for every holding
wrapper, including light. Deferred: a second heavy slot, Playwright port derivation, an allocator
and cache isolation.

**How it works.** The lock is a listening socket on the literal address `127.0.0.1:47177`
(`RV_TEST_LOCK_PORT`). `scripts/with-test-lock.mjs` binds it, starts the runner as its child
and releases it only after the child has exited; the OS frees it when the holder dies in any
way, and there is no lock file. An orphaned or hung holder that does NOT die keeps the port,
though — 2026-10-27 a hung bare `npx vitest run` (PID 7388) held it for six hours and blocked five
agents; `node scripts/test-lock.mjs break` (below) is the sanctioned way to free it. While held, `GET http://127.0.0.1:47177/` answers
`{ "rvTestLock": 1, pid, startedAt, cwd, argv }`. Every Node descendant of a locked run carries
the watchdog `scripts/test-lock-watchdog.cjs` (via `NODE_OPTIONS`), which ends it when the
wrapper is gone; on Windows the job object libuv puts children into already ends the whole
non-detached tree (incl. Chromium) when the wrapper is killed.

**Free memory before the lock (plan-2247).** The holding wrapper checks the free commit
(Windows `FreeVirtualMemory`, Linux `MemAvailable`) BEFORE it takes the lock: check, then lock,
then start. Thresholds per class: light 8 GB, heavy 10 GB, exclusive 10 GB. Below the threshold the
run waits WITHOUT holding the lock or any port (re-measured every `RV_TEST_MEMORY_POLL_SECONDS`,
default 30), so it never blocks another run; after `RV_TEST_MEMORY_WAIT_SECONDS` (default 1800) it
exits 1 with `waited N s for M GB free, have X GB`. While it waits, `node scripts/test-lock.mjs status`
lists it as `[test-lock] WAITING for memory: PID … (class …, need N GB, have X GB, since …)` (exit
code unchanged), read from `<tmp>/rv-test-lock-waiting/<pid>.json` (`RV_TEST_MEMORY_WAIT_DIR`; dead
PIDs are ignored and cleaned up); the plan board shows "waiting for memory: N". Override:
`node scripts/with-test-lock.mjs --min-free-gb <n> vitest …` (before the runner) or
`RV_TEST_MIN_FREE_GB=<n>`; `0` switches the check off. A re-entering wrapper (`RV_TEST_LOCK_HELD`)
does not check again. After acquisition the wrapper measures again before spawning the child; a
low or unknown reading releases every acquired port and light mark before returning to the visible
memory wait. Memory queries are asynchronous and bounded by `RV_TEST_MEMORY_QUERY_TIMEOUT_SECONDS`
(default 10 seconds) and the remaining memory wait deadline. An unreadable or timed-out query
keeps waiting; the entry already exists during the first measurement (`have ? GB`), and signals
cancel the query and clean up the entry. Code: `scripts/test-memory.mjs`; `Tools/mem-gate/mem-gate.mjs` stays for runs
outside the lock.

| Entry point | Protected? |
|-------------|-----------|
| `npm test`, `npm run test:node`, `npm run test:watch`, `npm run test:all` | yes (wrapper) |
| `npm run e2e`, `npm run e2e:headed`, `npm run perf`, `perf:matrix`, `perf:soak`, `perf:load` | yes (wrapper) |
| direct `npx vitest run …` | yes, weaker — `tests/global-lock-guard.ts` (root `globalSetup`) takes it for the vitest process and enforces the maximum run time (no startup / stall limit) |
| direct `npx playwright test …`, `npx playwright test --ui`, `npx vitest --ui` | **no** |

**What you see.** A run whose class has no free slot waits:

```text
[test-lock] class heavy waiting for vitest run (PID 12345, since 2026-10-15T08:01:12.345Z) — 1798 s left
```

repeated at most every 30 s. A port taken by something that does not answer as a test lock
shows `port 47177 held by an unknown/unresponsive process — … s left` and is waited on the same
way. After `RV_TEST_LOCK_TIMEOUT_SECONDS` (default 1800; exclusive uses
`RV_TEST_LOCK_EXCLUSIVE_TIMEOUT_SECONDS`, default 3600; retry every `RV_TEST_LOCK_POLL_SECONDS`,
default 2) the run refuses and exits 1:

```text
[test-lock] gave up after 1800 s: 127.0.0.1:47177 is held by vitest run (PID 12345, since …, cwd …). Check with: node scripts/test-lock.mjs status
```

**Who holds it:**

```bash
node scripts/test-lock.mjs status   # exit 0 free, 1 held (pid, since, cwd, argv), 2 unknown process
```

**A hung holder** is freed with `break` — not by killing PIDs by hand:

```bash
node scripts/test-lock.mjs break --dry-run   # the decision and the target, nothing killed
node scripts/test-lock.mjs break             # [--port N] [--min-age-minutes 30] [--idle-seconds 60]
```

It reads the PID listening on `127.0.0.1:<port>` from `netstat -ano` (nobody → `free`, exit 0) and
the process table (command line, creation time, parent, CPU time) from `Win32_Process`, then
**refuses** with exit 2 and the reason unless all three hold: (a) the holder's command line is a
test process — vitest, `with-test-lock.mjs` or `run-all-tests`; (b) it is at least
`--min-age-minutes` old (default 30, floor 10); (c) it is idle — the summed CPU time of the tree it
would end grows by less than 1 s between two samples `--idle-seconds` apart (default 60, floor 10),
and no process joins or leaves that tree meanwhile. The kill target is the topmost ancestor that
still belongs to the same test invocation (`npx vitest`, `cmd.exe /c vitest …`, Git Bash running the
`npx` shim, the wrapper, `run-all-tests`), so the whole npx → cmd → node tree goes; the climb stops
below anything else — a Claude Code shell (`bash -c "source …shell-snapshots…"`), claude.exe, npm,
`timeout`, a node running another script, Unity, CONNECT. It ends the target with
`taskkill /PID <target> /T /F`, waits for the port and prints every process it ended. Exit 0 free or
freed (also when a waiting run takes the port at once), 1 the kill did not free the port, 2 refused
(or bad arguments, or not Windows). A busy run is not hung — the wrapper's own limits end it.

**Switches.** `RV_TEST_LOCK=off` runs without the lock; `RV_TEST_LOCK_PORT` moves it (a foreign
program on 47177). `RV_TEST_LOCK_DIR` — the old opt-in file lock, still written by
`rv-worktree` into `.env.local` — is **ignored**: all worktrees share the machine-wide class slots.
Inside a locked run, `RV_TEST_LOCK_HELD` names the owning wrapper;
a nested wrapper (e.g. `test:all` → `npm run test`) sees it alive and runs without binding again.
`RV_TEST_MAX_RUNTIME_MINUTES` (default 90, fractions allowed, `0` disables) caps a run: the wrapper
that holds the lock ends a child still running after that time with the same tree kill
(`taskkill /T /F`, POSIX process-group SIGKILL), prints `run exceeded RV_TEST_MAX_RUNTIME_MINUTES=…`,
releases the lock and exits with **124**. Re-entering wrappers do not enforce it.
`RV_TEST_STARTUP_TIMEOUT_SECONDS` (default 300, fractions allowed, `0` disables) catches the run that
never gets going (2026-10-15: 74 min of `no tests` / `rpc is closed, cannot call createTesters`): the
holding wrapper ends the tree, prints `no test file started within RV_TEST_STARTUP_TIMEOUT_SECONDS=…`
(elapsed time, since when, argv) and exits with **125** when a vitest run has not started its first test
FILE in time. The timer lives in the wrapper; vitest only reports progress — `scripts/test-progress-reporter.mjs`,
appended to the reporters of both configs by a `configureVitest` plugin, writes `run-start` /
`module-start` / `first-test` / `run-end` once per process into `RV_TEST_LOCK_PROGRESS_FILE` (a temp file
the holder creates and polls). A window opens at the child's spawn when the runner is vitest, when a
re-entering vitest wrapper starts (`test:all` gives node and browser suite one window each), or at a
`run-start` without one; it closes at that process's first `module-start`, first test, its run end, or its
exit. Watch reruns and non-vitest runners (Playwright, perf scripts) are never limited; a direct
`npx vitest run` has no startup, per-file or stall limit — its guard enforces only the maximum run
time. plan-900's `file-start` (from `onTestModuleQueued`, carrying `spec`) deliberately does NOT
close this window: it fires before the import, and closing on it would hand every import hang from
the 300 s window to the 600 s per-file limit.
`RV_TEST_STALL_MINUTES` (default 10, fractions allowed, `0` disables) catches silence after the
first module/file start: every record refreshes the window, including every file start/end and final
test result. On expiry the holder names unfinished files, counts expected files not started, kills
the tree and exits **123**. All reporting runs ending disarms it; watch idle and reruns are exempt.
Ten minutes leaves margin over the longest measured browser test (82 s) and the slowest file
(laserwelding-station-flow, 280 s with a result at least every 82 s).
**It is the FALLBACK for a switched-off per-file limit, and only that** (plan-900 F6, decided
2026-10-27): while `RV_TEST_FILE_TIMEOUT_SECONDS` is non-zero the stall clock is **not armed**, so
123 cannot occur — set `RV_TEST_FILE_TIMEOUT_SECONDS=0` and 123 takes over silence. The rule is one
function, `stallIsResponsible()` in `scripts/with-test-lock.mjs`, not a side effect of the order in
which the two clocks are checked. Why it had to be written down: the stall window is refreshed by
EVERY progress record while the per-file window is refreshed only by FILE events, so the per-file
(or A3b inactivity) trigger is always due no later than the stall trigger and is evaluated first —
with equal defaults (600 s against 10 min) 123 was already unreachable, and that fact rested on the
order of two statements. Preferring 126 is the point of the decision: it **names the file**, 123 does
not. Together with the `WARNING: … DISABLED` lines at the start of every holding run, the log always
says which clock is on duty.
`RV_TEST_FILE_TIMEOUT_SECONDS` (default 600, fractions allowed, **`0` disables — this is the
emergency stop**) is the per-FILE limit (plan-900) and exits **126**: it ends the tree and **names
the file** when ONE test file has been running longer than its budget. It closes the gap the
startup window leaves — that window covers only the FIRST file of a process, so every later file
hang used to fall into the 90-minute cap without a name, which is why `npm run test:all` never
ended by itself. The clock runs per file, from its `file-start` (`onTestModuleQueued`, which fires
BEFORE the setup files and before the import — the only event a file hanging in its own import
still produces) to its `file-end`, in an in-flight map keyed by `(pid, spec)` with the wrapper's
receipt times; the message reads `tests/foo.test.ts ran for RV_TEST_FILE_TIMEOUT_SECONDS=600 (…)
— ending the test tree`. When no `file-start` has arrived at all (worker boot, environment, the
browser tester page) the same clock and the same limit report inactivity instead, saying `the
stalled file is NOT named` — honestly, rather than accusing the last file they saw. The default
600 s comes from a full-suite measurement (0 of 1992 files above 300 s, maximum 251.5 s, slowest
legitimate file 200.1 s) and is longer than any healthy shard (174–257 s), so it cannot fire in a
healthy run by construction; a per-file exception belongs in `FILE_TIMEOUT_OVERRIDES`
(`scripts/with-test-lock.mjs`) as a VALUE, never as "off". A row whose `seconds` is unusable (a
typo, a missing field, `'15 min'`) does **not** free its glob from the limit: it falls back to the
default and the holding wrapper prints a `WARNING: FILE_TIMEOUT_OVERRIDES row …` line (plan-900 F1).
In the globs of that table (and of `scripts/test-exclusions.txt`) `?` is a literal character, `*`
stays inside one path segment, `**` spans any depth and `/**/` spans zero or more segments. **If it ever misfires,
`RV_TEST_FILE_TIMEOUT_SECONDS=0` switches it off without a code change** — a false alarm
hard-kills the whole tree and turns a previously green run red on every machine, and `test`,
`test:node` and `test:all` all go through this wrapper.
Why there is no stall limit BETWEEN a file's start and its end: the reporter writes nothing about
a file in that span, so a long healthy middle and a hang would be indistinguishable, and a
heartbeat per test case would multiply the write volume — hence a DURATION limit per file. For the
same reason a direct `npx vitest run` (no wrapper, and the clock would sit inside the very process
that hangs) can only ever have the maximum run time; to get a named file, run through the wrapper.
Every limit kill (123/124/125/126)
prints `[test-lock] FAILED (exit <code>): <cause>` last, after lock release, regardless of child status.

**After an aborted suite run: which files did that shard still owe?** `scripts/test-shard-plan.mjs`
rebuilds vitest's own shard assignment (sha1 of the spec path, stable order, remainder on the
first shards), so an abort still yields a per-FILE statement:

```bash
node scripts/test-shard-plan.mjs --count 4 --index 2            # what shard 2 of 4 will run
node scripts/test-shard-plan.mjs --count 4 --index 2 --done finished.txt   # what is missing
```

Files that are deliberately not run belong in `scripts/test-exclusions.txt` (empty today, and
empty is the only acceptable steady state) — not in someone's shell history. Every output states
how many files were scanned; a prediction over an empty list is a broken selection, not a result.

**A file hangs before its first test?** `scripts/test-hang-predict.mjs --suite browser` names every
file that matches the known cause: `vi.mock(M, factory)` where the factory asks for the ORIGINAL
module and `M` lies on a static import cycle (vitest's `ManualMockedModule.resolve()` has no
in-flight memo, so the factory waits for the cycle it is part of). File selection and aliases come
from the vitest config, never from the script. A hit is a NECESSARY condition only — it fires
while a cycle closes through the mocked module — so treat it as the first suspect, not as a
verdict. On this tree (2026-10-27, after the cycle edge was removed) it names 0 of 2041 files,
which matches the suite running through; with that edge bent back it names all five that died.

**A limit that is switched off says so.** Every clock the holding wrapper enforces prints
`[test-lock] WARNING: … DISABLED (<VARIABLE>=0) — <what is no longer caught>` at the start of the
run, in a green log as well; a clock that runs normally prints nothing. So if a run hangs and no
limit fires, the first thing to read is the head of its log: a wrapped run once hung for 33
minutes because `RV_TEST_STARTUP_TIMEOUT_SECONDS=0` sat in a shell nobody could see any more.

*Why `module-start` (plan-617, measured 2026-10-17).* The window used to close at the first test
(`onTestCaseReady`). That event is the worker's `test-prepare`, which `@vitest/runner` sends through a
100 ms throttle (`sendTasksUpdateThrottled`): a call shortly after the last send is parked in a
`setTimeout`, and a synchronous first test blocks that timer until it has finished — in browser AND node
mode; a long `beforeAll` delays `test-prepare` by its full length as well. A run of the large CAD line with a first test
over 300 s ended with 125 and no test failure. `onTestModuleStart` comes from the file's `suite-prepare`
(`suite-failed-early` on an import error) — the first event of a worker or file after a pause, which the
throttle sends at once — and arrived on time in every measurement (no general delivery guarantee; the
node regressions in `tests/test-lock.node.test.ts` run a 9 s synchronous first test and a 9 s `beforeAll`
under a 5 s limit). The limit therefore guards against **no module event received** (the #172 class:
rpc dead, nothing reported — a `globalSetup` that never resolves is the counter-check), not against every
hang: an import error is a sign of life and closes the window too, and a run that hangs AFTER a file has
started is covered by `RV_TEST_STALL_MINUTES` (123), with the absolute runtime cap (124) as backup. `first-test` stays the measurement point and the
strict-deps boundary.

**Failures at once (`[test-fail]`, plan-617).** vitest's default reporter prints assertion and stack only
in its final summary; a run ended by 124 / 125 or by hand kept only `× <name>` lines (2026-10-17: 16 red
files, 26 tests, 0 error texts). The same reporter prints every failure to stderr when it arrives in the
main process, one line each (`--reporter=json` stdout stays clean):

```text
[test-fail] tests/foo.test.ts :: Foo > does x — expected 1 to be 2 // Object.is equality @ tests/foo.test.ts:12:5
[test-fail] tests/bar.test.ts :: (suite Bar setup) — dist/index.html not found @ tests/bar.test.ts:8:11
[test-fail] tests/baz.test.ts :: (module) — Failed to load url ./missing @ no stack
```

- the file is relative to the vitest root, the message is the FIRST error's, on one line, at most
  300 characters, the stack part vitest's first parsed frame (`file:line:column`), else the first `at …`
  line, else `no stack`;
- a failed test comes from `onTestCaseResult` with its FINAL result: a test red at first and green on
  retry prints nothing, one whose retries are exhausted prints one line;
- `(suite <name>)`: a describe's own `beforeAll` / `afterAll` error (`onTestSuiteResult`); `(module)`: an
  import error or a file-level hook error (`onTestModuleEnd`). `errors()` returns only an entity's OWN
  errors, so a failing test plus an `afterAll` error of its suite are two lines, each once; no entity or
  error object is printed twice in a run;
- 50 lines per run (`FAIL_LIVE_LIMIT`); the 51st failure prints at once
  `[test-fail] limit of 50 reached — further failures only in the vitest summary`, and a run that ends
  regularly prints `[test-fail] N further failures not shown live (limit 50) — see the vitest summary`.
  An aborted run with more than 50 failures therefore shows that its log is incomplete. The counters are
  per run (reset at every run start, also in watch mode);
- **limit of the promise:** only failures that already reached the reporter survive an abort. A result
  still parked in the worker's 100 ms update buffer when the tree is killed is lost.
The default 300 s stands on measurements of 2026-10-16: the cold case — a fresh worktree (empty Vite
optimize cache, first Chromium launch) under foreign load — reached its first test after 72.2 s (75.2 s
since wrapper start, plan-764 gate run); warm browser runs after 19.2 s and 3.6 s; the node suite after
0.8 s. The data comes from the measurement lines: at its first test file and at its first test each vitest
process prints once to stderr `[test-progress] first test file started after X s (run start <iso>, config
<file>) / Y s since wrapper start` and `[test-progress] first test after X s (…) / Y s since wrapper start`
(the wrapper part from `RV_TEST_WRAPPER_SPAWN_MS`, which every wrapper stamps for its child).
The same reporter ends every vitest run with one stderr line `[test-skips] N skipped: …` — grouped by
the `ctx.skip(note)` note, else as `no reason given: <file>`, top 5 plus `(+N more)`; a run without
skips prints `[test-skips] 0 skipped` (absence would be ambiguous for a gate). A test vitest skipped
because a `beforeAll` of its file threw — vitest 4 marks every task of that suite skipped and records
the error on the suite, so the file is red too (e.g. `tests/bundle-splitting.test.ts` without a `dist/`
build) — groups as `file failed in setup: <file>`: an ancestor (`describe` or the TestModule) reports
`state() === 'failed'` with non-empty `errors()`. A `ctx.skip(note)` note still wins. `describe.skipIf(cond)`
skips at collection and carries no note, so the WebGPU suites (public `real-webgpu-smoke`,
`mu-compute-transforms`; private `cinematic-capability-probe`, `cinematic-motion`,
`cinematic-render-smoke`) use a plain `describe` with `skipEachWithoutAdapter(adapter)` from
`tests/helpers/webgpu-adapter-skip.ts` — a `beforeEach` that calls `ctx.skip(NO_WEBGPU_ADAPTER)` —
and appear as `N no WebGPU adapter (main suite runs without GPU — covered by npm run test:gpu)`. Their
`beforeAll` guards itself with `if (!adapter) return`. The cause is config, not hardware: headless Chromium
in the main suite falls back to SwiftShader — deliberately, every baseline (inventory, red set, run time)
was measured that way — and vitest 4.0.18 does not forward per-instance `launchOptions` (plan-602). These
files get the real GPU in the separate GPU group below.

**GPU group — `npm run test:gpu` (2026-10-17).** A separate, serial vitest browser run of exactly the
files in `tests/gpu-tests.json` (the five above; the private three only when the sibling exists), under
the machine-wide test lock like every test script, and **not** part of `npm test` or `npm run test:all`.

- **Config:** `vitest.gpu.config.ts` resolves `vite.config.ts` and spreads it, so plugins
  (`testLockProgressPlugin` with `[test-skips]` / strict deps), aliases, `@rv-private`, `define`,
  `optimizeDeps.include`, `test.exclude`, the lock guard and `browser.commands` are the main suite's.
  It overrides only the include list, `test.name: 'gpu'`, a setup file, a reporter, and:
- **Flags:** `--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist`, handed to the Playwright
  **provider** (`playwright({ launchOptions: { args } })`). Per-instance `launchOptions` would be
  dropped: vitest 4.0.18's `cloneConfig` gives each `browser.instances` entry the provider of `browser`,
  and the provider launches Chromium with its own factory options. Headless stays on.
- **Browser binary:** `launchOptions.channel: 'chromium'` (`GPU_BROWSER_CHANNEL`) launches the FULL
  Chromium build (`ms-playwright/chromium-<rev>/chrome-win64/`) in new headless mode instead of
  Playwright's default `chrome-headless-shell`. The shell ships no `dxil.dll` / `dxcompiler.dll`: the
  adapter was healthy, but `requestDevice()` failed in Dawn's `EnsureDXCLibraries` (`DynamicLib.Open:
  dxil.dll Windows Error: 87`) and three fell back to WebGL2 (`webgpu-gl`, no compute) — measured 2026-10-17.
- **Serial:** `fileParallelism: false`, `maxWorkers: 1` — one GPU, never two Chromium instances on it.
- **Own cache:** `cacheDir: node_modules/.vite-gpu`, so the run never invalidates or re-optimizes the
  main suite's `node_modules/.vite`. The first run is cold (optimizer pass before the first test).
- **Scan parity:** `optimizeDeps.entries` = the MAIN suite's test files (`mainSuiteEntries` over the
  resolved `test.include` / `test.exclude`). In vitest browser mode the optimizer scans the project's
  include (`project.globTestFiles()` in the `vitest:browser:tests` plugin of `@vitest/browser`), never the
  CLI filter; with only the five GPU files the first run discovered 37 deps mid-run (`react-dom/client`,
  `mqtt`, `@mui/icons-material/*`, …) and the reload emptied a file ("No test suite found"). A filtered
  main-suite run (`npm test -- <file>`) is not affected: its scan still covers every test file.
- **Missing adapter = error:** `tests/helpers/gpu-run-setup.ts` runs before every file, prints
  `[gpu-backend] webgl=<UNMASKED_RENDERER> webgpu=adapter(<vendor>/<architecture>)|none device=ok|<error>`
  and throws `GPU group without a WebGPU adapter — flags not applied or driver/blocklist` when
  `requestAdapter()` gives nothing; in this run `skipEachWithoutAdapter` throws the same message
  instead of skipping. A SwiftShader `webgl=` means the flags did not arrive. It also requests one
  device (destroyed again) and throws `GPU group: WebGPU adapter present but requestDevice failed:
  <message>` — a missing DXC never again hides behind a silent WebGL fallback.
- **Reading the end:** `scripts/test-gpu-run.mjs` prints (stderr) `[gpu-run] WebGPU adapter present`
  (or `FAILED: …`, exit 1), then
  `[gpu-quarantine] inside the baseline (N): A known failure reproduced, B now pass (remove from the list),
  C failed for another cause, D skipped, E not run` and
  `[gpu-quarantine] outside the baseline: P passed, F failed, S skipped`, followed by one line per
  non-reproduced baseline entry and per outside failure. Inside = an id of `tests/webgpu-quarantine.json`:
  there `quarantinedIt` turns the recorded cause into a PASS (with a `[quarantine] known failure …`
  warning), a body that now passes into a red "quarantined test now passes — remove …", and any other
  error stays red. The list may only shrink (`QUARANTINE_BASELINE`); classify after a GPU run, never
  add to it to make the run green. **Empty since 2026-10-17:** the original eight entries (WebGL
  fallback before the real device) all pass on a real WebGPU device (GTX 1060, Dawn D3D12) — every GPU
  failure is now an outside failure, i.e. red.
- **When:** it needs the GPU and the machine — run it in a load window, not next to other heavy runs.
  Do not fold it into the main suite as a vitest project: that was plan-602 part B, reverted in
  77111c0d (cold cache per project, mid-run re-optimization, double wall time).
- **Guard:** `tests/test-gpu-run.node.test.ts` — flags and channel at provider level, the device check, serial, own cache, the main
  configs free of GPU flags, `test:gpu` outside `test:all`, every list entry present and guarded, every
  quarantined file listed, nothing staged into a delivery.

**Strict optimizeDeps (`[test-deps]`, 2026-10-16).** When the Vite deps optimizer of the browser
server discovers an import that `optimizeDeps.include` does not list, it re-optimizes and usually
reloads the page (`new dependencies optimized: X` → `optimized dependencies changed. reloading` →
`Vite unexpectedly reloaded a test`); the run is then unusable but still reported green (three times
in 12 h: `@microsoft/teams-js`, then `three/addons/controls/PointerLockControls.js` twice). The same
plugin's `configureServer` hook (under vitest only — vitest browser mode loads `vite.config.ts` again
for its browser server, so the hook runs there too) wraps two structured hooks of every environment
whose optimizer does discovery: `depsOptimizer.registerMissingImport` (an id not yet in
`metadata.optimized` / `chunks` / `discovered` = a discovery, named) and the environment's `hot.send`
(a `full-reload` while discoveries are pending = the optimizer's reload). No log text is parsed. The
**boundary is the first test** of the vitest process: a discovery or reload before it — a cold cache,
`Re-optimizing dependencies because vite config has changed` after a config edit, the first file's
crawl — is legitimate and never counts. After it, a reload prints at once
`[test-deps] undeclared dependency discovered mid-run: <dep> — add it to optimizeDeps.include in vite.config.ts (the reload made this run unusable)`
(also when the discovery came just before the first test and only its reload after); a discovery that
re-optimized without a reload is named at run end with `(re-optimized without a reload this time; …)`.
Every run ends — after the skip line — with `[test-deps] 0 mid-run re-optimizations` or
`[test-deps] N mid-run re-optimizations: <dep> (reloaded), <dep>`. `RV_TEST_STRICT_DEPS` picks the
mode: `fail` sets `process.exitCode = 1` at run end (vitest never resets it, so the run exits non-zero
although every test passed), `warn` prints the lines only, `off` prints nothing; unset or unknown
values mean `DEFAULT_STRICT_DEPS_MODE`, **`fail`** — the discovery run of 2026-10-16 (full browser suite,
fresh worktree, cold cache) completed the include list with `0 mid-run re-optimizations` after the
`@microsoft/teams-js` and `three/addons/controls/PointerLockControls.js` entries. `RV_TEST_STRICT_DEPS=warn`
downgrades a local run. The fix for a hit is always the include entry in `vite.config.ts`.
The watcher only exists under vitest: without `process.env.VITEST` (which vitest sets itself) the
`configureServer` hook returns at once, so the Playwright `webServer` (a plain vite dev server),
`npm run dev` and every build are never watched and never failed — `fail` applies to vitest runs only.

Limits: a `detached` grandchild leaves the Windows job and is not covered; POSIX signal
forwarding (SIGINT/SIGTERM → child, 10 s grace, then SIGKILL) is implemented but unmeasured.

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

They run under the machine-wide test lock (§ 4, *Machine-wide test lock*), write to `docs/perf/`, and stamp a machine
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
walkthroughs with the full HMI chrome stay with `scripts/recording/`; scripted **tutorial raw
footage** with a click / cursor / camera event track is `scripts/tutorial/` (plan-2004, end of this
section).

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
- **CLI setup**: viewport = `--size` (CSS px, DSF 1), terms / welcome dismissed via
  `addInitScript` (the dev toolbar lives in the ActivityBar, which the recording shell does not mount), simulation reset at the start (the sim start must not depend on the load time),
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
  main thread: station ≈ 3–13 s, the large CAD line ≈ 35 s).
- **What is traced**: a COPY of the model (chunk index order untouched, doc-bake-picking-internals
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

### Tutorial raw footage with an event track (plan-2004)

`npm run tutorial:run -- --script scripts/tutorial/storyboards/<id>.json --ffmpeg <ffmpeg> --ffprobe <ffprobe>`
plays a versioned storyboard against a finished static build (`dist/`, served by the runner's own
server on port 5199) in headless Chrome with GPU, on a **virtual clock**: one `__vt.step(1000/30)`
and one CDP screenshot per frame, so the frame number IS the video time (exact 30 fps CFR, no
resampling). The mouse moves visibly (Fitts duration, Bézier + minimum jerk), clicks are down + up
in the same frame, zoom is a scripted `camera` action, and next to `recording.mp4` the runner writes
`events.json` — pointer path, buttons, keys, target boxes, camera moves and step segments in video
frames — plus a contact sheet `stills-*.jpg` (every click, every camera move, every step start).
The result is **raw footage for manual cutting**: no voice, no cursor drawn into the pixels, no
final film (that is plan-676). Output goes to `.tutorial-out/<id>/` (gitignored); a `--dir` outside
the WebViewer repo is exit 2. Nothing is published unless all gates pass — the null-epoch preflight
before the take, then A (ffprobe frame count == trace frames, frame stamps +1), B (markers on their
expected frames) and C (motion, `movedFraction ≥ 0.10`). Storyboard schema, options, gates, exit
codes and the ffmpeg instrument findings: `scripts/tutorial/README.md`.

## 4e. Deterministic integration tests (plan-600)

Three building blocks for tests that check the *application* over time and across mode
switches: a deterministic **test clock**, checked-in **state goldens**, and a DEV-only
**invariant layer**.

### The test clock — `e2e/_clock.ts`

There is exactly ONE time mechanic in the e2e suite, and `e2e/_clock.ts` is its only façade.
It drives the viewer's existing video-capture path (in use since plan-537 by the video
recorder, the MCP frame capture and the embed) — no new production driver:

```typescript
import { advanceSimSeconds, readTransport, withTestClock } from './_clock';

await waitForViewerReady(page);
const transport = await withTestClock(page, async () => {
  await advanceSimSeconds(page, 120);   // 7200 fixed steps, 3600 rendered frames
  return readTransport(page);
});
expect(transport.consumed).toBeGreaterThan(0);
```

`withTestClock` arms the clock (`beginCapture` + `resetSimulation()`) and releases it
(`endCapture()`) in a `finally` on every path. `advanceSim(page, steps)` advances exactly
`steps` fixed updates at `1/60` s, rendering a frame after each block of 2 steps.

Three measured facts the helper **enforces** rather than documents:

| Fact | Consequence |
|------|-------------|
| `captureStep` alone does not move material — 300 s of pure step advance leaves the sink at `consumed = 0` | every step block is followed by a `captureRenderFrame`; interleaved, the first consumption lands at `simTime = 88.6 s` |
| `beginCapture` alone has no reproducible start state — the live phase before it is wall-clock bound (9.90 s / 747 ticks against 9.85 s / 734 ticks) | `resetSimulation()` is mandatory, and **exactly once**: two resets in a row leave `consumed` at 0 over 120 s |
| `captureAbortReason` brakes nothing by itself — after a model change `captureStep(60)` still counts 60 ticks and `captureRenderFrame` still returns `true` | the check between frames in `advanceSim` is the **only** brake |

Tick numbers reported by the helper are **deltas** since arming. `resetSimulation()` zeroes
`simTime` but *not* `simTickCount`, whose absolute value still carries the wall-clock-bound
live phase (measured 819 against 1007 on two runs) and is useless for comparison.

**The clock is not a neutral clock.** A test that needs one of these cannot use it:

| Limit | Effect on a test |
|-------|------------------|
| Exclusive lock — one capture at a time | no nested use; `endCapture` belongs in a `finally` |
| No WebGPU, no running XR | `webgpu-smoke.spec.ts` stays on the wall clock |
| A model must be loaded and `logicRunState === 'active'` | a journey cannot fast-forward before the load |
| Camera, projection, follow and damping animations are **suspended** | camera moves are out of scope — not additional coverage |
| Selection cleared, input locked, DPR forced to 1 | a golden taken inside the clock expects an empty selection; `endCapture` restores everything |

Scope: this is a strong functional guarantee for the material-flow specs, **not** a proof of
general viewer determinism. XR has its own frame scheduling and the debug endpoint its own
timers. Every new journey proves its own determinism — two fresh runs, same golden.

### State goldens — `e2e/_golden.ts`

A snapshot comes from ONE collector, `collectStateSnapshot()` in
`src/core/engine/rv-state-snapshot.ts`, reached identically from Playwright
(`viewer.collectStateSnapshot()` through `page.evaluate`) and from vitest (direct call).

The field list is **closed**: `mode`, `documentId`, `modelKey`, `drives`, `signals`, `alarms`,
`selection`, `panels`, `nodeCount`, `problems`. Adding a field is a plan decision — each one is
a new source of golden churn. Nothing wall-clock derived is in there (no timestamps, FPS, load
durations or hash URLs). Drive positions are rounded to **3 decimals** (millimetres, so a
micrometre); signal values are left exact, because a signal value is data, not a measurement.
`alarms` and `problems` are projected as machine-readable strings (`path` and `code`), never as
display text, so a wording change cannot turn a golden red.

```typescript
import { expectGolden } from './_golden';
expectGolden('golden-pilot/after-2s', await page.evaluate(() => window.viewer.collectStateSnapshot()));
```

- Goldens live in `e2e/__goldens__/<spec>/<step>.json` and are checked in.
- A **missing golden is red** — it is never created silently.
- Rewriting is explicit: `RV_UPDATE_GOLDENS=1 npx playwright test <spec>`, then review the
  written file in `git diff` before committing it.
- The comparison is exact (the collector already rounded); there is no tolerance band.
- One key per line, so a single changed drive is a single line in `git diff`.

Compare across **fresh runs**. Two calls inside one run prove nothing about reproducibility.

On the dev server a golden can also be written by hand: **Dev toolbar ▸ Snapshot ▸ Save snapshot**
(see §4g) posts `collectStateSnapshot()` to `POST /__api/dev/golden`, which writes the same
canonical form. That is a deliberate recording step like `RV_UPDATE_GOLDENS=1` — review the file
in `git diff` before committing it.

### The invariant layer — `src/core/engine/rv-invariants.ts`

Five statements the viewer must never contradict, checked at named checkpoints and reported as
`console.error` **with its cause** — never thrown, never written to the Problems panel.

| Id | Invariant | Example message |
|----|-----------|-----------------|
| I1 | No NaN or Infinity in `position` / `quaternion` / `scale` of a registered node | `I1 Cell/Broken/Axis: position.x is NaN` |
| I2 | No node-count drift on a RETURN into the same UI state | `I2 nodeCount: 315 -> 318 (returning to hmi)` |
| I3 | No listener without a living consumer, per signal name | `I3 do5: 2 -> 3` |
| I4 | No Problems entry with `severity === 'error'` | `I4 missing-reference: Missing reference` |
| I5 | No renderer resource drift across a return cycle | `I5 geometries: 114 -> 115` |

**Synchronous versus deferred.** `checkInvariants(viewer, reason)` is synchronous and returns
the findings of I1, I2 and I4. I3 and I5 need a frame that was *actually* rendered afterwards,
so a checkpoint files exactly ONE reservation, executed at the next rendered frame; their
findings appear only on the console, so the return value never lies about completeness. A
reservation is **discarded** when `model-loaded`, `model-cleared` or a further mode switch
arrives before its frame — comparing against a state that is no longer the same state is a
false alarm, not a finding.

**The I3/I5 baseline is load-bound.** It is taken one rendered frame after
`placements-materialized`, *not* after `model-loaded`. `model-loaded` fires before
`placements.sealLoad()`, and the references of a layout document arrive seconds later: measured
on `DemoPlanner.glb`, 31 nodes and 4 geometries at `model-loaded` against 201 nodes and 32
geometries at the load-bound completion, across 13 placements. A baseline taken at
`model-loaded` would report that growth as a leak on the next return cycle. `currentModelUrl`
(50-68 frames early) and a `whenSceneReady()` called *before* the load began (resolves at frame
0) are both forbidden markers. When awaiting the load-bound completion from a spec, register the
`placements-materialized` listener **before** `loadModel`: `whenPlacementsMaterialized()` alone
can still be settled from a previous load and then resolves immediately.

**Comparison geometry.** I2, I3 and I5 compare the same *named UI state* (active mode plus the
open panels) before and after a completed cycle, never a number against an earlier number taken
at a different UI state. That is what makes a legitimately mounted extra consumer harmless. I2
is measured over a return rather than over a single switch because a single switch was measured
to be a false positive: `commissioning` creates its own nodes lazily after the switch
(315 to 317) and removes them correctly when it is left, so one switch legitimately reads 317 to
315. Without a reference point nothing is checked, rather than compared against zero.

The per-name listener count comes from `SignalStore.listenerCounts()`, which reads the
`listeners` map — **not** `listenerRefs`. The latter counts `subscribe` calls and diverges where
it matters: the `Set` deduplicates one callback reference, measured 3 to 4 rather than 3 to 5.

**DEV only.** The single switch is `import.meta.env.DEV` — there is no localStorage, URL or env
override, and the two references in `rv-viewer.ts` (install in the constructor, drain at the end
of `render()`) sit behind that guard, so a production build drops the module entirely.
`checkInvariants(viewer, 'explicit')` is callable from a test at any time.

### Fake viewers (plan-2100)

Some tests borrow methods from `RVViewer.prototype` and run them on a hand-built object
(`Object.create(RVViewer.prototype)` plus `Object.assign`). For the plugin lifecycle there is
exactly **one** such builder: `createCoreViewer()` in `tests/helpers/core-toggle-viewer.ts`
(`plugin-origin.test.ts` uses it too; the former second copy is gone).

Its field list (`ViewerInternals` and the `Object.assign`) is maintained **by hand**. That is a
known risk: `Object.create` runs neither the constructor nor any field initializer, so a new
`RVViewer` field that the plugin paths read is `undefined` on the fake. The symptom is a
`TypeError` deep in product code (for example `Cannot read properties of undefined (reading
'filter')`), not a message naming the field. If plugin tests suddenly fail like that after a
field was added to `RVViewer`, add the field to `createCoreViewer()`.

There is no census and no guard that reports a missing field when the fake is built. That was
planned and is deferred (2026-11-01, plan-2100 Phase 0) until a change brings new viewer fields.

## 4f. DES performance measurement (plan-2063)

Run on an otherwise quiet machine. Check host CPU load before starting and do not run other tests, builds or benchmarks concurrently. `perf:des` already uses `scripts/with-test-lock.mjs`; retain that lock wrapper. The lock serializes cooperating test runs, but does not make unrelated workloads quiet.

```sh
RV_TEST_UNATTENDED=1 npm run perf:des -- [--sizes 1,2,4,8] [--repeats 3] [--sim-sec 28800] [--out-dir <directory>]
```

Brackets mark optional arguments; omit the brackets when running. In PowerShell set `$env:RV_TEST_UNATTENDED='1'` first, then run `npm run perf:des -- ...`.

The harness measures PalletYard FastForward without rendering and a separate synthetic warehouse snapshot. Read `schemaVersion`, `status`, `failures`, `machine` and `scenarios[]` in the JSON report. Each scenario records `scenario`, `kind`, `size`, `requestedSimSeconds`, `repeats` and `runs[]`; individual runs include metric `sources`. Aggregates are `scenarios[].metrics.<name>.median`, `.min`, `.max`, `.samples`. For two repeats the median is their arithmetic mean. Do not divide independently aggregated medians to replace an already reported rate.

`wallMs` is computation wall time, `simSeconds` the simulated duration, `totalEventsProcessed` the event count, `eventsPerSecond` the event rate, and `simHoursPerWallHour` the simulated-time/wall-time ratio. `componentCount`, `vehicles`, `stations`, `muCount` and `liveMuCount` describe the loaded model. `heapPeakBytes` uses `performance.memory.usedJSHeapSize` before the run and after each tick (`heapSamples`): it is a sampled peak, not an allocation high-water mark. `heapAfterGcBytes` uses CDP `HeapProfiler.collectGarbage` followed by `Runtime.getHeapUsage`. `snapshotMs`, `snapshotBytes` and `restoreMs` exist only where supported; inspect `snapshot.supported` and `restore.supported` rather than interpreting missing values as zero.

Reference reports: `perf-results/plan-2063/`, specifically:

- `perf-results/plan-2063/2026-11-01-Coder-main-sizes1-8-8h.json`
- `perf-results/plan-2063/2026-11-01-Coder-size16-8h.json`
- `perf-results/plan-2063/2026-11-01-Coder-size8-80h.json`

| n | Sim-h | Wall ms | Events total | Events/s | Sim-h/wall-h | Heap peak MB | Heap after GC MB |
|---|---|---|---|---|---|---|---|
| 1 | 8 | 252.90 (252.90 to 259.70) | 23,240 | 91,894 (89,488 to 91,894) | 113,879 (110,897 to 113,879) | 170.86 (170.77 to 171.01) | 65.49 (65.49 to 65.49) |
| 2 | 8 | 407.60 (389.90 to 408.20) | 44,606 | 109,436 (109,275 to 114,404) | 70,658 (70,554 to 73,865) | 175.11 (174.93 to 175.78) | 66.84 (66.72 to 66.84) |
| 4 | 8 | 746.00 (735.00 to 755.10) | 96,353 | 129,160 (127,603 to 131,093) | 38,606 (38,141 to 39,184) | 178.99 (178.69 to 181.03) | 69.32 (69.32 to 69.37) |
| 8 | 8 | 1,518.20 (1,512.40 to 1,533.10) | 210,301 | 138,520 (137,174 to 139,051) | 18,970 (18,785 to 19,043) | 239.63 (239.35 to 240.73) | 73.07 (73.04 to 73.08) |
| 16 | 8 | 1,730.40 (1,704.60 to 1,731.80) | 290,864 | 168,091 (167,955 to 170,635) | 16,644 (16,630 to 16,895) | 276.02 (275.14 to 279.79) | 79.95 (79.93 to 79.96) |
| 8 | 80 | 12,886.55 (12,852.20 to 12,920.90) | 2,077,838 | 161,242 (160,812 to 161,672) | 22,349 (22,289 to 22,409) | 427.83 (426.14 to 429.52) | 73.10 (73.10 to 73.11) |

Reference conditions for this table: CODER, AMD Ryzen 9 9950X (16C/32T), 64 GB RAM, Windows 11, High performance power plan, Node v26.13.0, headless Chromium (Playwright) in the vitest browser harness; WebViewer origin/main 9a1b2ed7 + measurement fix 75c4a183; 2026-11-01; quiet machine (about 6% CPU beforehand). This machine is the reference hardware; other computers will differ. Values are rounded medians; 8 Sim-h = 28,800 Sim-s (3 repeats), 80 Sim-h = 288,000 Sim-s (2 repeats). MB is decimal. Parentheses show min-max across repeats, not confidence intervals.

| n | Sim-h | Components | MU slots / live MUs |
|---|---|---|---|
| 1 | 8 | 14 | 28 / 5 |
| 2 | 8 | 26 | 30 / 10 |
| 4 | 8 | 52 | 35 / 19 |
| 8 | 8 | 104 | 50 / 38 |
| 16 | 8 | 208 | 83 / 67 |
| 8 | 80 | 104 | 51 / 38 |

Reference conditions for this table: CODER, AMD Ryzen 9 9950X (16C/32T), 64 GB RAM, Windows 11, High performance power plan, Node v26.13.0, headless Chromium (Playwright) in the vitest browser harness; WebViewer origin/main 9a1b2ed7 + measurement fix 75c4a183; 2026-11-01; quiet machine (about 6% CPU beforehand). This machine is the reference hardware; other computers will differ. Counts are medians over the same repeats. MU slots are allocated slots, not cumulative production; stations include pick, drop, buffer and charger, excluding wait points.

Events/s rises from 91,894 at n=1 to 168,091 at n=16. The short 8-hour runs take less than 2 wall-clock seconds and are affected by JIT warm-up; the longer n=8 run reaches a steadier 161,242 Events/s versus 138,520 for 8 hours. This is not evidence that larger models inherently cost less per event. At n=8 the sampled heap peak grows from 239.63 MB (8 hours) to 427.83 MB (80 hours), while heap after GC stays nearly flat: 73,073,608 versus 73,104,408 bytes (73.07 versus 73.10 MB). These runs show garbage peaks without evidence of a retained-heap leak; they do not prove absence of leaks in all workloads.

Vehicle installations support snapshot capture and restore; see [DES snapshot contract](doc-des-snapshot.md#phase-8-guards-and-additions). On the measured yard models (n=1 to n=16, reference machine, 2026-11-02) saving takes 4 to 40 ms, restoring 6 to 103 ms, and the file is 32 to 396 KB. The vehicle-free synthetic warehouse has different orders of magnitude; its timings and sizes must not be transferred to vehicle installations.

| Report run | snapshotMs | snapshotBytes | restoreMs |
|---|---|---|---|
| 2026-11-01-Coder-main-sizes1-8-8h.json | 7.9 (7.7 to 8.0) | 2,077,366 (2,077,366 to 2,077,366) | 18.3 (18.2 to 18.7) |
| 2026-11-01-Coder-size16-8h.json | 7.7 (7.5 to 7.9) | 2,077,366 (2,077,366 to 2,077,366) | 18.5 (18.4 to 19.0) |
| 2026-11-01-Coder-size8-80h.json | 7.7 (7.7 to 7.7) | 2,077,366 (2,077,366 to 2,077,366) | 18.6 (18.6 to 18.6) |

Reference conditions for this table: CODER, AMD Ryzen 9 9950X (16C/32T), 64 GB RAM, Windows 11, High performance power plan, Node v26.13.0, headless Chromium (Playwright) in the vitest browser harness; WebViewer origin/main 9a1b2ed7 + measurement fix 75c4a183; 2026-11-01; quiet machine (about 6% CPU beforehand). This machine is the reference hardware; other computers will differ. Median (min-max), with 3, 3 and 2 repeats respectively. Only `warehouse-synthetic`: 300 Storage components, 3,000 live MUs, 2,000 open events, no vehicles; snapshot-only, not a throughput benchmark.

The acceptance criterion is FastForward >= 100 Sim-h per wall-clock hour, snapshot < 1 s and < 50 MB, and heap < 1 GB. No measured value breaches these thresholds, including the repeat maxima for heap and snapshot and minima for speed. The cited snapshot threshold measurements cover the vehicle-free warehouse. Measurements reach n=16 (24 vehicles, 96 stations), the maximum of `composeYard`; no performance limit was found within that range. This does not establish support for larger models. These are pure headless DES computation measurements without rendering. Browser rendering and Animated mode were not measured. Rendering/Animated performance remains separate work (plan-465).

## 4f. Journeys, the mode matrix and the soak (plan-601)

Three additions that apply the layer above: a watcher that makes an invariant violation fail the
spec it happened in, a generated mode-switch matrix, and a soak against leaks. No new runner, no
new file format, and **no production line** — a journey is an ordinary Playwright spec.

### The journey watcher — `e2e/_journey.ts`

`watchJourney(page)` combines `collectErrors` with `waitForRenderedFrames`:

```typescript
import { watchJourney } from './_journey';

const journey = watchJourney(page);           // BEFORE page.goto — boot errors count
await page.goto('/?model=DemoRealvirtualWeb.glb', { waitUntil: 'domcontentloaded' });
await waitForViewerReady(page);

await page.evaluate(() => window.viewer.modes.requestMode('commissioning'));
await journey.settle();                       // after EVERY mode switch
await journey.assertClean();                  // no [rv-invariants] line, no console error
```

**A filter is not a wait, and that is the whole point.** I3 and I5 are deferred: a checkpoint
files one reservation, executed at the next *actually rendered* frame, and a further mode switch
**discards** it. Filtering the collected errors without waiting inspects a list that cannot hold
the finding yet, so the assertion would be reliably green and check nothing. `settle()` waits two
rendered frames plus the console transport; `assertClean()` settles on its own before it looks.

`collectErrors` collects `pageerror` and `console.error` — **never** `console.log`. Do not phrase
an assertion on a log line. `reset()` forgets everything collected so far and exists only for a
negative test that has already asserted its expected finding (`captureAssertion(journey)` returns
the assertion error instead of throwing it).

Proven by two tests in `e2e/sink-test.spec.ts`: an injected **synchronous** violation (I1 through
a non-finite transform) and an injected **deferred** one (I5 through three cloned geometries
nobody disposes). The deferred one is the proof — without the wait it would be green.

Two measurements worth knowing before writing such a test:

- **A boot load never compares I3/I5.** The baseline is armed at `placements-materialized`, which
  on the boot load happens while `activeMode` is still `null` (`main.ts` applies the mode after
  the model). Its `uiKey` is therefore `none|-|-` and every later comparison is skipped — a leak
  of three geometries stayed silent over a full return cycle (measured 2026-10-14). A spec that
  wants the deferred pair loads the document explicitly, with the mode already applied.
- An explicit load reports `I3 <signal>: 0 -> 1` for the signals whose HMI consumers mount after
  the baseline. Legitimate, and the reason the soak below compares on its own numbers.

### The mode matrix — `e2e/mode-matrix.spec.ts`

Generated from `viewer.modes.list()`, N x (N-1) ordered pairs, on `DemoRealvirtualWeb.glb`:

```typescript
const modes = await page.evaluate(() => window.viewer.modes.list().map((m) => m.id));
// per pair: lockedMode === null, establish `from` AND verify it,
//           requestMode(to) === true, then activeMode === to after settle()
```

`list()` returns **registered**, not enterable modes, so success is measured on `activeMode` and
never on the requested value. The precondition `lockedMode === null` is *checked*, because a
configuration can lock a document (`settings.mode.lock`). **A rejection is a failure here** —
"a rejection is not an error" would make every broken switch green. Rejections are expected in
exactly one place: the separate test with a deliberately installed `lock()` or a vetoing
`registerExitGuard`, which also proves the workspace stays operable afterwards.

Two things the matrix measured on the demo document and handles explicitly rather than hides:

- The first visit to `des` / `planner` / `commissioning` creates `…/Simulation`, which is **not**
  removed when the mode is left (315 to 316, once, then stable). The matrix therefore warms up by
  entering every mode **twice** before it measures — I2 records a count when a mode is entered, so
  one pass leaves the modes visited early with their pre-allocation number.
- I2 is asserted in the geometry it was built for — a doubled return cycle per mode, both returns
  from the same neighbour — and **not** per matrix pair. Across a matrix every mode is entered from
  N-1 different predecessors while the modes allocate lazily *after* the switch, which produces
  entry-time artifacts in both directions (`319 -> 316`, `316 -> 320`). Those are logged, never
  asserted away silently. I1, I3, I4 and I5 stay strict per pair, with zero tolerance.

### The soak — `e2e/mode-soak.spec.ts`

**50** complete return cycles `hmi -> commissioning -> hmi`, compared at **every** return point —
not at the end, because a finding that closes again before the end would be invisible. The cycle
count is binding; it is not lowered to speed a run up.

| Item | Value |
|------|-------|
| resting state | model loaded, placements idle, simulation paused by a named reason, panels closed |
| baseline | after the completed load and one rendered frame (plus one warm-up cycle, see below) |
| comparison point | every return into `hmi`, after a rendered frame, same mode AND same panel configuration |
| rules | `registry.size.nodes` equal, `renderer.info.memory.geometries` / `textures` equal, listeners per signal name not higher |
| tolerance | none |

The soak runs **without the test clock** (it refuses WebGPU/XR, demands `logicRunState ===
'active'` and falsifies the very render cycles a mode switch needs) and **without simulation**: it
holds a pause reason, so no spawned MU can move a counter compared with zero tolerance.
`resetSimulation()` is never called — plan-600 § 5.6 measured that it may run exactly once.

One warm-up cycle precedes the baseline for the lazy `…/Simulation` node above. After it the
comparison has no tolerance at all; measured over 50 cycles the demo document stays at
`nodes=315 geometries=114 textures=44`.

The second test in the file is the discriminator: a document whose references materialise late
(`DemoPlanner.glb`) plus the modes' own resources stay silent, while three leaked geometries are
caught by the very same comparison (`geometries: 32 -> 35`) and disappear again when disposed.

## 4g. The dev toolbar (plan-615)

On the Vite dev server the activity bar carries one extra icon (`</>`, the bar's bottom-most
entry below Settings and Help — on a phone the last entry of the top-right pill;
`data-testid="dev-toolbar-button"`). It sits in the same place in the dev and the delivered view. It replaced the red `ENTWICKLUNGSSERVER` banner and exists
**only on the dev server**: everything sits behind `RV_SERVE_INFO !== null`, and `RV_SERVE_INFO`
is the literal `null` in every build, so Rollup drops it — pinned by
`tests/dev-toolbar-bundle-absence.node.test.ts`, which builds a probe with the production define.
When you add a gate, the constant must **lead** the `&&` chain
(`RV_SERVE_INFO !== null && !recording && <X />`): Rollup folds `null !== null && X`, but not
`!recording && null !== null && X`.

**Which checkout is this tab?** The tooltip names session, port, machine, served path and branch.
A tab served from the **canonical checkout** is never hover-only: the button is red with a warning
dot and the tab title starts with `[⚠ CANONICAL]`. A worktree session keeps a discreet icon and the
`[Plan N]` title prefix.

**The popover** (click the icon):

| Section | What it does |
|---------|--------------|
| Dev server | Session, machine, path, branch of the served checkout (path and branch wrap, full value) |
| View | **Dev** ↔ **Delivered** — see below |
| Snapshot | Spec + step name, *Overwrite*, *Save snapshot* → `e2e/__goldens__/<spec>/<step>.json` |
| Status | `[rv-invariants]` reports of this page, Problems entries with severity `error` |
| Flags | The load-time switches of `rv-dev-load-flags.ts` (metadata, pick structure, JSON field editor); *Reload* applies them |

**View: dev ↔ delivered.** The delivered view shows the app the way a delivery's app config shows
it: `mode.lock`, `lockSettings`, `lockedTabs` and `ui` (`initialContexts`, `visibilityOverrides`)
applied. Switching **reloads the page** (camera and signal state are lost) — only the boot applies
a config the way a delivery does. The choice is per tab (sessionStorage `rv-view-profile`);
`?view=dev` / `?view=delivered` in the URL wins for one boot and is removed when you switch.
Without a choice the boot is unchanged. What "delivered" means is decided in `rv-view-profile.ts`:

- the loaded `settings.json` carries view keys (a customer workspace serves its delivered file) →
  exactly that config;
- it carries none (this repo, or a delivery like the large CAD line's whose generated settings lock nothing) →
  that config plus `{ mode: { lock: "hmi" }, lockSettings: true }`, i.e. HMI only.

The dev view is the loaded config with the view keys removed. The delivered view keeps the
activity bar, so the button stays where it is and is the way back. Only a page with **no** activity
bar mounted at all (a delivered config that hides the bar, a shell without one) gets a small
translucent handle at the bottom-left edge (`data-testid="dev-handle"`) that opens the same
popover. Details: `doc-ui-visibility.md` § 3.

**`POST /__api/dev/golden`** (dev server only, `apply: 'serve'`; logic in
`scripts/lib/rv-dev-golden.mjs`): body `{ "name": "<spec>/<step>", "snapshot": {…}, "overwrite": false }`.
The name is resolved server-side and must stay inside `e2e/__goldens__/` — absolute paths, drive
letters, backslashes, `.`/`..` segments and any extension other than `.json` are refused (400). An
existing file is replaced only with `"overwrite": true` (409 otherwise).

## 5. Debugging Workflow

### Diagnose a DES run

Start with `web_execute(command="diagnose", args={})`. Its read-only result puts `summary`
first, followed by run status, the top 10 problems, faulted components/vehicles, fleet counts
and `statsSanity`. It does not repair statistics or create Problems entries.

For deadlocks and stalls, use the blockage checker (`diag.blockage`, `diag.waitGraph`,
`diag.blockageWatch`, `diag.blockageWatchStatus`), documented in
[src/plugins/mcp-bridge/help/commands.md](src/plugins/mcp-bridge/help/commands.md).

The DES HMI reads the active `DESRunner`, which runs material-flow behaviours.
Use these Problems codes to identify failures:

| Problems code | Severity | What it means |
|---|---|---|
| `des-action-failed` | error | A model action threw. The message names the component and action. FastForward stops and resolves `false`; Animated and Step pause. |
| `des-legacy-component` | warning | A loaded node carries a retired native DES type. The message names its replacement material-flow type; replace it in the model. Reported when the runner binds in DES mode. |
| `des-invalid-capacity` | warning | A non-sink component has a `MaxCapacity` that is not a positive integer. Binding skips that instance; correct its capacity. |
| `tween-handle-exhausted` | error | The tween pool cannot grow within its handle index limit (indices below 2^21). Allocation throws instead of producing an unsafe handle. |

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 180" role="img" aria-label="Start with diagnose, then inspect events, fleet status or problems">
<g fill="none" stroke="currentColor" stroke-width="2">
<rect x="230" y="10" width="200" height="40" rx="6"/>
<path d="M330 50 V80 M110 80 H550 M110 80 V110 M330 80 V110 M550 80 V110 M105 103 L110 110 L115 103 M325 103 L330 110 L335 103 M545 103 L550 110 L555 103"/>
<rect x="10" y="110" width="200" height="50" rx="6"/>
<rect x="230" y="110" width="200" height="50" rx="6"/>
<rect x="450" y="110" width="200" height="50" rx="6"/>
</g>
<g fill="currentColor" text-anchor="middle" font-family="sans-serif" font-size="16">
<text x="330" y="36">diagnose</text>
<text x="110" y="141">des.events</text>
<text x="330" y="141">fleet.status</text>
<text x="550" y="141">problems.list</text>
</g>
</svg>

Use `web_execute` for each follow-up:

- `des.status {}`: inspect `runState` and `reason`. `finished` means the end time was reached
  (`duration-reached`) or an unlimited run drained its model events (`queue-drained`). Pending
  events beyond the end time are normal. `stalled` (`queue-empty-before-end`) means a finite
  run has no more model events; inspect sources and blocked flow. Checkpoints do not count.
- `des.events {limit:20, component:"Source"}`: inspect upcoming events without advancing the
  run; `component` and `action` filter the queue, returned in dispatch order with `total`
  and `truncated`. Maximum limit: 200. Both `des.*` commands require DES mode.
- `fleet.status {state:"fault"}`: inspect fault reason, job, position, waiting and battery;
  `vehicle` is a case-insensitive substring. States: free/order/handling/charging/fault/idle.
  Data comes from fleet handles and vehicle status signals. Without those signals,
  `fromSignals` is false and fault/battery details can be unavailable; consult logs for fault context.
- `problems.list {severity:"error", limit:100}`: read the Problems panel, including marked
  quiet entries. `code` is a case-sensitive prefix; `node` a case-insensitive path substring.
  Results sort by severity then time; maximum limit is 500. `total` is the filtered count,
  while severity counts (and `fleet.status` counts) cover the unfiltered source.

For supporting evidence use `web_logs(level="warn", category="signal,drive", since=60)`
or `web_signal_list(filter="Status.Fault")`. Request `web_status(detail="render")` for rendering
issues; its default basic response does not include render diagnostics.

### Blockage checker

The checker asks whether an **armed** unit is making expected progress. A `deadlock`
is a cycle in the analysed wait graph whose members have stopped progressing beyond
their idle budgets. A `stall` is missing expected progress outside such a cycle,
including an empty line with no wait edge. Parked vehicles without tasks and empty
surfaces are inactive. Counters measure vehicle/surface travel and sink/DES output;
a clear `blocked` flag alone does not establish a healthy run.

The ledger samples progress cheaply; the checker collects dependencies only for
suspected blockages. An explicit wait-graph request collects them directly.

<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 660 95" role="img" aria-label="Progress ledger samples armed units; suspected blockages trigger wait graph diagnosis">
<g fill="none" stroke="currentColor" stroke-width="2">
<rect x="5" y="20" width="195" height="50" rx="6"/><rect x="250" y="20" width="195" height="50" rx="6"/><rect x="495" y="20" width="160" height="50" rx="6"/>
<path d="M200 45 H250 M243 40 L250 45 L243 50 M445 45 H495 M488 40 L495 45 L488 50"/>
</g>
<g fill="currentColor" text-anchor="middle" font-family="sans-serif" font-size="14">
<text x="102" y="49">Progress ledger</text><text x="347" y="49">Idle budget exceeded?</text><text x="575" y="49">Wait graph + probes</text>
</g>
</svg>

Use these four commands through `web_execute`. Example request JSON:

```json
{"command":"diag.blockage","args":{}}
{"command":"diag.waitGraph","args":{}}
{"command":"diag.blockageWatchStatus","args":{}}
{"command":"diag.blockageWatch","args":{"on":true}}
```

The first three are read-only. `diag.blockage` returns `{findings, coverage, atSec,
exempt}`; `diag.waitGraph` returns `{edges, sources}`. Watch status returns, for
example, `{"on":false,"sampleEverySec":1,"since":null}`. The write command
`diag.blockageWatch` enables ongoing Problems entries; pass `{"on":false}` to stop
it. The watch starts off, while progress instrumentation remains available.

Read a finding from its `cls` and ordered `chain`, for example
`A -> Zone 1 -> B -> Zone 2 -> A`. Then compare `idleSec` and `progressCount` with
the resolved idle budget. `budgetSource` names the node supplying `MaxIdleSec`, or
`default`; other properties can inherit from different ancestors. Each `checks`
entry contains `name`, `ok` and `detail`: `no-wait-edge` explains a stall without a
reported dependency, `holders` names the owner or says free, and
`edge-not-analysed` exposes a graph limitation. `cycles` lists the discovered cycles
of a deadlocked component; `cycles-truncated` means its list hit the 1000-cycle cap.
The Problems entry shows the chain, idle/wait budgets and checks; **Go to node**
selects and frames the first mapped node. Watch codes are `blockage-deadlock`
(error), `blockage-stall` (warning by default) and `blockage-coverage-gap` (info).
Resolved Problems entries disappear on subsequent samples.

Always read `coverage` alongside findings. `expected` comes from the model's
population, independently of the adapters; `registered`, `armed`, `complete`,
`inactive` and `bySource` describe instrumentation. `missing` lists expected units
with no adapter, while `unknown` lists reported units outside the expected
population. A missing adapter is neither a healthy unit nor a blockage finding.
An empty findings array with missing coverage is not evidence of a healthy model.

Declare legitimate waiting with a **BlockageBudget** component on the relevant
node or line root. Properties inherit independently from node to ancestors to
defaults; empty numeric fields inherit. `Scope` is `subtree` by default, or `node`
for local settings. Defaults are `MaxWaitSec: 60`, `MaxIdleSec: 120`, and
`WarmupSec: 30` (simulation seconds). The wait budget annotates overdue dependencies;
the idle budget gates findings. A line-root example in `realvirtual` extras:

```json
{"BlockageBudget":{"ExpectFlow":true,"MaxWaitSec":60,"MaxIdleSec":180,"WarmupSec":30,"Scope":"subtree"}}
```

- `ExpectFlow` opts sinks into empty-line monitoring. A sink must also have
  `DeleteMus` enabled and the run must be active; unrelated lines stay independent.
- `ExpectedWaits` declares expected edge kinds; defaults are `charge`, `setup`,
  `failure`, `empty`. The Inspector offers the registered kinds. Matching waits
  are treated as inactive for this classification; `fleet:` prefixes are normalized.
- `SignalSuppress` references a `PLCOutputBool`; true suppresses the subtree during
  a declared pause. `Exempt` permanently excludes a subtree. Both protect descendants
  against child overrides, even with `Scope: node`; use them for explicit intent.
- `Severity` controls stall severity. `SignalBlockageFound` is a `PLCInputBool`
  output published by sampling, not by read-only inspection.

For a suspected false alarm, inspect coverage first, then `diag.waitGraph`, the
progress counter, edge age, holder and checks. Verify that the unit should be armed,
that its adapter records completions/travel, and that the budget comes from the
intended ancestor. Measure the longest legitimate wait before changing that local
budget or declaring an expected wait/pause. A missing holder can mean an incomplete
dependency adapter; it does not prove that the next step is available. Fix the
instrumentation or model declaration instead of disabling the checker.

**v1 limits.** Sink-to-source topology is not inferred: empty-line checks need
`ExpectFlow`. Capacity > 1 zones and external holders expose unanalysed edges;
they can explain stalls but do not form analysed cycles. Grip/MU edges have no
progress unit and appear only in `diag.waitGraph`. Conveyor output waiting for a
fleet pickup has no conveyor-to-fleet dependency edge, so its holder can be `free`.
Vehicle fault/downtime integration is pending the observable fault flag (plan-2053);
an `ExpectedWaits` declaration only works when the corresponding kind is reported.
Starvation detection (plan-2049) and automatic DES matrix grading (plan-2048) are
separate work. Findings are snapshots: check during the run and before reset or
teardown; retained `lastFindings` does not turn a final snapshot into a run-history
assertion.

Calibration found no findings over 600 simulation seconds in Standarddemo and
LaserWelding. PalletYard viewer mode had three vehicles without tasks (`armed: 0`),
so that was not a loaded fleet validation. Its 24-hour DES run had coverage 24/24
but ended with a 163 s `Conveyor_A1` output stall toward fleet pickup. PalletYard's
pick conveyors now declare `BlockageBudget { MaxIdleSec: 600 }` in the model,
generated by `tools/des-examples/pallet-yard.mjs`, to allow normal pickup backpressure
while still reporting output stalls over 10 minutes. The global default stays 120 s.

In runtime tests, use the same checker through
[`expectNoBlockage`](tests/helpers/expect-no-blockage.ts):

```ts
expectNoBlockage(viewer, { requireCoverage: true });
expectNoBlockage({ ledger, registry, budgets, now }, {
  requireCoverage: true,
  allow: finding => finding.waiterId === 'DeliberatelyStoppedUnit',
});
```

Call it after a healthy run, before disposal, with live progress sampling throughout
the run. It throws all unexpected findings with chains, idle seconds versus budgets
and checks. `allow` filters only intentional findings; it cannot waive missing
coverage when `requireCoverage` is true. `idleSec` is the checker's sampling floor,
not an override of model budgets. The legacy `expectNoWaitTimeouts` retains its
separate historical timeout-count/Problems contract.

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
`sizeBytes` per entry (`public/library/project.json` `documents[]` via `npm run build:library`,
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

- `web_status({detail:"render"})` → `cache`: the newest outcomes (default 20, `cacheLast` up to 128),
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

### Suite load budget — a red file that is green alone (plan-2102)

A file that fails inside a full run but passes alone is one of two different problems. **Compute time:** the
same work takes longer under 24 parallel Chromium pages than the test timeout allows — more time or fewer
workers helps. **Wait budget:** the test waits for an event with `@testing-library`'s own 1000 ms
`asyncUtilTimeout` (`waitFor` and every `findBy*`, which runs on `waitFor`), and a higher `testTimeout`
heals none of those. A message such as `expected false to be true` after such a wait is an expired wait
budget, not a statement about the product.

For waits that the test does not control, import `tests/helpers/wait-budget.ts`: `waitForBudgeted(cb)` for
`waitFor`, and `screen.findByText(text, undefined, budgeted())` for `findBy*`. The budget is one fixed value
(`WAIT_BUDGET_MS`, 5000 ms), and an explicit `timeout` still wins. Where the test owns the event (a mock
import promise), wait for that signal instead of polling.

Every `npm test` run writes a run record to `.test-runs/<UTC time>-<commit>-<pid>-<run id>.json` (git-ignored,
last 200 kept) from the reporter: both repo commits and dirty flags, host, cores, `maxWorkers`, the runner
arguments, `filtered`, the file count, `skippedTests` (an `.only` shows up here, not in `filtered`), `durationS` / `importS` / `testsS` (the same sums as the vitest
summary) and `redFiles` as a **list**. Aborted runs write no record. Two runs are comparable only if
`filtered` is false for both, the commits match and `testFiles` and `skippedTests` are equal; runs with a different file count
(2181 against 2188 was the case that started this) are not comparable. A record that cannot be written
prints one warning on stderr and never changes the exit code or stdout.

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
