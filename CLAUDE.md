# CLAUDE.md — realvirtual WEB

This file provides guidance to Claude Code when working with the realvirtual WEB codebase.

## Project Overview

**realvirtual WEB** is a browser-based 3D HMI and digital twin viewer for industrial automation. It loads GLB models and runs interactive transport simulation, drive animation, sensor collision, and LogicStep sequencing in the browser.

- **License:** AGPL-3.0-only (dual-licensed with commercial option)
- **Runtime:** Three.js + TypeScript
- **HMI:** React 19 + MUI 7
- **Build:** Vite 6
- **Tests:** Vitest (browser-mode via Playwright provider) + Playwright E2E

## Quick Start

```bash
npm install
npm run dev          # Vite dev server with HMR (localhost:5173)
npm run build        # Production build -> dist/
npm test             # Run all tests (headless Chromium; see Testing below)
npx tsc --noEmit     # Type-check without emitting
```

## Code Conventions

### File Naming
- Source files: `rv-kebab-case.ts` (always `rv-` prefix for engine files)
- React components: `PascalCase.tsx` (e.g., `TopBar.tsx`, `KpiCard.tsx`)
- Hooks: `use-kebab-case.ts` (e.g., `use-drive-chart.ts`)
- Tests: `rv-name.test.ts` or `component-name.test.ts`
- Stores: `kebab-case-store.ts` (e.g., `visual-settings-store.ts`)

### Naming
- **Classes:** PascalCase with RV prefix for engine classes (e.g., `RVDrive`, `RVSignalStore`)
- **Interfaces/Types:** PascalCase with Config/Options suffix (e.g., `DriveConfig`, `CompactRecording`)
- **Enums:** PascalCase (e.g., `StepState`, `DriveDirection`)
- **Functions:** camelCase (e.g., `loadGLB`, `parseDriveExtras`)
- **Constants:** UPPER_SNAKE_CASE (e.g., `FIXED_DT`, `MM_TO_METERS`)
- **Private fields:** camelCase with or without `_` prefix
- **Exports:** Named exports only (no default exports)

### License Header

Every source file (.ts, .tsx, .js, .mjs, .cjs) must start with:
```typescript
// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
```

Run `node scripts/add-license-headers.mjs` to batch-add missing headers. Safe to re-run.

### Patterns
- **SimulationLoop:** Register callbacks via `onFixedUpdate(cb)` for 60 Hz logic
- **Pre-allocation:** Temp vectors as class fields, never allocate in hot paths
- **Defensive parsing:** `value ?? default` for all GLB extras
- **Signal direction:** Follows PLC convention — PLCOutput = read by viewer, PLCInput = written by viewer
- **No GC in hot paths:** Pre-allocate vectors, reuse objects, clear lists instead of creating new ones

## Architecture

```
src/
  core/
    rv-viewer.ts                 # RVViewer facade (scene, sim loop, plugins, events)
    rv-camera-manager.ts         # Camera control and animation
    rv-visual-settings-manager.ts # Lighting, shadows, tone mapping
    rv-plugin.ts                 # Plugin interface (lifecycle + optional UI slots)
    rv-events.ts                 # Typed EventEmitter
    rv-ui-registry.ts            # UI slot component registry
    engine/                      # Simulation engine subsystems
      rv-scene-loader.ts         # GLB loading, rv_extras parsing, component construction
      rv-node-registry.ts        # Object discovery by path/type
      rv-component-registry.ts   # Schema-based C# -> TypeScript auto-mapping
      rv-drive.ts                # Drive component (ported from Unity Drive.cs)
      rv-transport-surface.ts    # Conveyor surface with AABB collision
      rv-signal-store.ts         # Central PLC signal pub/sub store
      rv-logic-step.ts           # LogicStep sequencing
      rv-sensor.ts               # AABB overlap sensor
      rv-source.ts / rv-sink.ts  # MU spawning/destruction
      rv-mu.ts                   # Movable Unit
      rv-simulation-loop.ts      # Fixed 60 Hz timestep accumulator (+ integration gate)
      rv-simulation-runtime.ts   # SimulationRuntime facade: attach/detach (editor mode),
                                 #   pause reasons, continuous|discrete mode, connection state
      rv-core-subsystems.ts      # Per-tick core pipeline (playback/logic/IK, drives, visuals)
                                 #   driven by the SimulationExecutors (kernel path)
    editor/                      # Asset editor document (Editor mode = GLB authoring):
                                 #   rv-asset-document/ops/executors (undo/redo op log),
                                 #   rv-asset-glb-export (GLTFExporter save), CADLink + re-import,
                                 #   rv-cad-provider (private OCCT injection seam)
    hmi/                         # React HMI components (MUI-based)
      HMIShell.tsx               # Main HMI layout shell
      TopBar.tsx / BottomBar.tsx  # Navigation bars
      settings/                  # Settings panel tabs
      tooltip/                   # Tooltip system
  hooks/                         # React hooks
  interfaces/                    # Industrial protocol adapters (WebSocket Realtime, ctrlX)
  plugins/                       # Built-in + optional plugins (multiuser, webxr, fpv, annotations,
                                 #   aas-link, docs-browser, camera-startpos, blueprint, recorders,
                                 #   order-manager, debug-endpoint, mcp-bridge, ...)
  plugins/demo/                  # Demo model plugins + charts (OEE, parts, cycle time, energy)
  plugins/models/                # Per-model plugin entry points (auto-loaded by ModelPluginManager)
  private-stubs/                 # No-op fallbacks when ../realvirtual-WebViewer-Private~ is absent
tests/                           # Vitest browser tests
e2e/                             # Playwright E2E tests
public/models/                   # GLB storage — NOT a catalogue; nothing is discovered here
public/demo-realvirtual/         # The DemoRealvirtual PROJECT — one folder, delivered as-is
public/demo-realvirtual/project.json  # its manifest: SSOT for what the demo ships
public/library/                  # The component library — APP-LEVEL, beside the demo, not in it
```

Those last two lines used to be a pair with a caveat: dropping a GLB into
`public/models/` made it a "DEV BUILT-IN" you could pick in the model list even
though it was not in the demo. **That is gone (plan-735.)** The build-time glob
over `public/models/*.glb` has been removed, so a file dropped there is invisible
until a manifest declares it — add a `documents[]` row to
`public/demo-realvirtual/project.json`.

Since plan-737 the demo is **one folder artefact** (`public/demo-realvirtual/`),
delivered byte-identically to every channel: in place on the hosted demo and in
the Git mirror, and as a normal writable project (`projects/demo-realvirtual/`)
in a customer workspace. There it **arrives once**, with the customer's first
delivery, and is **never overwritten** afterwards — since plan-738 it obeys the
same territorial rule as every other folder under `projects/`, with no demo
exception; only an explicit, preview-confirmed `--projects demo-realvirtual`
run replaces it. The delete-then-copy in `copyDemoRealvirtualFolder()` rebuilds
the STAGING folder, not the customer's. The component library is *not* part of
it — `public/library/` is app-level, shared by every project, and the demo
merely subscribes to it through its `libraries[]`.

The rule is now the same everywhere and has no exceptions: **a document exists
because a `project.json` says so.** Every channel publishes one — the hosted demo,
the CONNECT bundle, the dev checkout, the customer workspace, and the projectless
standard delivery, whose manifest is generated at staging time and is vendor-owned.
A deploy root without a readable `project.json` has no project at all: the viewer
logs a named error and shows one, rather than inventing a project around whatever
GLBs happen to be lying about.

**Asset cache integrity (plan-508).** Library GLBs and splats go through
`RVAssetBlobCache` (buckets `rv-assets-glb-v2` / `rv-assets-splat-v2`); its cache key is
url + the catalog's `sha256` (`cacheKeyFor`, both tiers), looked up by url in
`src/core/library/rv-asset-hash-registry.ts`, which the catalog normalizer fills. A hit
under a hash key is served without re-hashing; network bytes are verified, a mismatch is
refetched once with `cache: 'reload'` and then fails as "hash mismatch". `ModelCache`
invalidates a key when its expected hash changes. Catalogs are stamped by the builders and
re-stamped by the deploy AFTER signing; the dev server answers missing asset paths with 404
(`rv-asset-404-guard`), the deploy probes the live host. Outcomes: `web_status.cache`,
DevTools › Render › Asset cache. Details: `doc-web-debugging.md`, `doc-deploy.md`.

### Local projects: the linked list, not a workspace (plan-743)

**There is no workspace root.** The dashboard's Projects section is a flat,
uncapped list of LINKED project folders (`rv-project/linked`, one
`projectfolder:<id>` handle per project), with two verbs: **Add** links a folder
you already have — a project folder, a folder full of project folders (each child
is linked, nothing is written to the parent), or a plain folder that an uncapped
recursive `.glb` scan turns into a project — and **New** creates one under a
remembered parent. Permission is asked for when a project is OPENED and never
when the list is drawn.

When touching this area: the rules live in
`src/core/hmi/projects/linked-project-verbs.ts` and `src/core/project/rv-project-{linked,add,scan}.ts`,
never in `ProjectsDashboardHost.tsx` — that file cannot be rendered by a test, so
a rule inside it is a rule with no test. `runLegacyCleanup()` deletes the old
workspace keys on first boot; there is deliberately no migration.

## Operating Modes

| Mode | Description |
|------|-------------|
| **Standalone** | Pure browser simulation — no Unity, no PLC. Fixed-timestep accumulator mirrors Unity FixedUpdate. |
| **Live** | Connected to realvirtual (Unity) via WebSocket — live PLC signals override local behavior. |
| **Direct** | Direct REST/MQTT connection to PLC without Unity. |

## Key Design Rules

- **Component naming parity:** TypeScript components match their Unity C# counterparts (Drive, Sensor, TransportSurface) for AI-assisted porting.
- **Live signals always override local behavior:** Immediately, per-component, no blending.
- **GLB as single source of truth:** All component config is in `rv_extras` inside the GLB. No separate signal map files.
- **Standalone simulation uses accumulator pattern:** Fixed-timestep equivalent to Unity FixedUpdate.
- **Events & hooks for loose coupling:** Plugins, HMI components and engine systems communicate through the typed `ViewerEvents` bus (`viewer.on / viewer.emit`) and plugin-lifecycle hooks (`onModelLoaded`, `onModelCleared`, `onRender`, …) wherever possible. Direct cross-plugin imports / module-level coupling are kept for stable, performance-critical APIs only. Prefer registry patterns (`componentActionRegistry`, `fieldRendererRegistry`) and `viewer.on('layout-transform-update', …)`-style subscriptions over hard wiring; that's what lets plugins like `gaussian-splat-plugin` stay in step with `layout-planner` mutations without either side knowing about the other. When a new cross-cutting concern shows up, ask first whether a typed event or a tiny registry can carry it before reaching for a shared service singleton.

## Commands (plan-499)

A user action is ONE command in `commandRegistry` (`src/core/hmi/rv-command-registry.ts`): buttons
(`ActionSegment`/`ActionButton` `command=`, `useCommandView`), context-menu items, inspector
actions, keyboard handlers and MCP write tools (`@McpTool({ command })` + `dispatchBoundCommand`)
are views of it — never a second copy of its rule. Every write tool is bound or allow-listed with a
reason; `tests/rv-command-mcp-parity.node.test.ts` and `tests/rv-command-bindings-execution.test.ts`
enforce it. Details: `doc-extending-webviewer.md` §5b.

## Testing

### Running Tests
```bash
npm test              # Run all tests once (CI mode)
npm run test:node     # Node-environment tests only (*.node.test.ts) — seconds, no browser
npm run test:watch    # Watch mode for development
npm run test:all      # node suite + browser suite, under ONE lock
```

### Machine-wide test lock (plan-606)

Test runs coordinate across the canonical checkout, every worktree and community clones.
`RV_TEST_CAPACITY=single|budget` selects capacity (default budget at >=24 threads): single keeps
one heavy run on H0; budget allows heavy on H0 plus light on base+3..+22, while exclusive holds
all slots. Budget mode alone sets `VITEST_MAX_WORKERS` (light 4, heavy floor(0.75 × threads / 2),
12 at 32 threads). `RV_TEST_LOCK_CLASS` / `--class=` overrides classification in budget mode;
`status` shows all holders. Direct `npx vitest` stays heavy on H0 without a budget. See
`doc-web-debugging.md` for classification and overrides. A suite under foreign load is useless as a measurement
(2026-10-14: two parallel suites → 34 reds in 14 files, every file green alone).

- **Mechanism:** the lock is a listening socket on `127.0.0.1:47177`. The wrapper
  `scripts/with-test-lock.mjs` binds it, then starts the runner as its child (no shell, args
  unchanged, inherited TTY) and releases it only after the child's process has exited — so it
  brackets Playwright's `webServer` and every teardown. The OS frees the port whenever the
  holder dies, and there is no lock file — but an orphaned or HUNG holder that does not die keeps
  the port (2026-10-27: a hung bare `npx vitest run`, PID 7388, held it six hours and blocked five
  agents). `node scripts/test-lock.mjs break` is the sanctioned way to free it (see below).
- **Supported (protected) entry points:** `npm test`, `npm run test:node`, `npm run test:watch`
  (lock held for the whole watch session), `npm run test:all` (one lock around both suites; the
  inner `npm run …` re-enter via `RV_TEST_LOCK_HELD`), `npm run e2e`, `npm run e2e:headed`,
  `npm run perf`, `perf:matrix`, `perf:soak`, `perf:load`. Extra args pass through:
  `npm test -- tests/foo.test.ts -t "a b|c"`.
- **Direct `npx vitest run`** is covered by the root `globalSetup` `tests/global-lock-guard.ts`
  (both vitest configs): it takes the lock itself for the vitest process (weaker — released at
  global teardown, before vitest has closed everything). It enforces `RV_TEST_MAX_RUNTIME_MINUTES`
  itself (same default 90, exit 124, the vitest process ends and frees the port); the startup and
  stall limits exist only under the wrapper — prefer the npm scripts.
- **NOT protected:** a direct `npx playwright test` (incl. `--ui`), `vitest --ui` started directly,
  and anything else that bypasses the npm scripts. Use the npm scripts.
- **A second run waits** and prints `[test-lock] waiting for <argv> (PID …, since …) — N s left`
  (at most every 30 s); after `RV_TEST_LOCK_TIMEOUT_SECONDS` (default 1800; exclusive: 3600 via
  `RV_TEST_LOCK_EXCLUSIVE_TIMEOUT_SECONDS`) it refuses, naming the
  holder. Who holds it: `node scripts/test-lock.mjs status` (exit 0 free, 1 held, 2 unknown process).
- **A hung holder is freed with `node scripts/test-lock.mjs break`** (`[--dry-run]`, `[--port N]`,
  `[--min-age-minutes 30]` (floor 10), `[--idle-seconds 60]` (floor 10)) — not by killing PIDs by hand.
  It takes the PID listening on the port (netstat) and refuses (exit 2, printing why) unless the
  holder's command line is a test process (vitest / with-test-lock / run-all-tests), it is older than
  the minimum age, AND its tree is idle (< 1 s CPU between two samples, no process added or gone).
  Then it kills the topmost ancestor still belonging to the same test invocation (npx vitest,
  `cmd /c vitest`, Git Bash's `npx` shim, wrapper, run-all-tests) with `taskkill /T /F` — never a
  Claude Code shell, claude.exe, npm, `timeout`, another node, Unity or CONNECT — re-checks the port and
  prints what it ended. Exit 0 free/freed (also when a waiting run took the port at once), 1 the
  kill did not free it, 2 refused. Windows only. A busy or young run is not hung: wait for it.
- **Env switches:** `RV_TEST_LOCK=off` (no lock), `RV_TEST_LOCK_PORT` (other port, e.g. when a
  foreign program uses 47177), `RV_TEST_LOCK_TIMEOUT_SECONDS`, `RV_TEST_LOCK_POLL_SECONDS`
  (default 2). `RV_TEST_LOCK_DIR` (the old file lock, still written by `rv-worktree` into
  `.env.local`) is **ignored** — one lock per machine is intended. `RV_TEST_MAX_RUNTIME_MINUTES`
  (default 90, `0` = off): the lock-holding wrapper kills a run still going after that, releases, exits 124.
  `RV_TEST_STARTUP_TIMEOUT_SECONDS` (default 300, `0` = off): same kill, exit **125**
  (`no test file started within …`), when a vitest run has not started its first test FILE by then
  (progress via `scripts/test-progress-reporter.mjs` in both vitest configs; a direct `npx vitest` is not
  covered — only the maximum run time applies to it, see above —, watch reruns and non-vitest runners never limited). Since plan-617 the window closes at the
  first `module-start` (a file's `suite-prepare`, or its import error), not at the first test: vitest's
  100 ms update throttle delivers `test-prepare` only after a synchronous first test or a long `beforeAll`
  has finished, so a legitimate first test longer than the limit used to be killed (2026-10-17, the large CAD line).
  The limit guards against "no module event received" (#172: rpc dead, nothing reported); a run that
  hangs AFTER a file started is covered by the stall limit.
  `RV_TEST_STALL_MINUTES` (default 10, fractions allowed, `0` disables) catches silence after the
  first module/file start: every record refreshes the window, including every file start/end and final
  test result. On expiry the holder names unfinished files, counts expected files not started, kills
  the tree and exits **123**. All reporting runs ending disarms it; watch idle and reruns are exempt.
  Ten minutes leaves margin over the longest measured browser test (82 s) and the slowest file
  (laserwelding-station-flow, 280 s with a result at least every 82 s). Every limit kill (123/124/125)
  prints `[test-lock] FAILED (exit <code>): <cause>` last, after lock release, regardless of child status.
  300 s stands (measured 2026-10-16 with the `[test-progress]` line): cold fresh worktree under foreign
  load first test after 72.2 s (75.2 s since wrapper start, plan-764 gate run), warm 19.2 s / 3.6 s, node 0.8 s.
- **Failures at once (`[test-fail]`, stderr, plan-617):** vitest's default reporter prints assertion and
  stack only in its final summary, so a run ended by 124 / 125 or by hand lost every cause. The same
  reporter prints each failure the moment it reaches the main process:
  `[test-fail] <file> :: <full test name> — <first message, one line, ≤ 300 chars> @ <first stack line | no stack>`;
  `:: (suite <name>)` for a `beforeAll` / `afterAll` error of a describe, `:: (module)` for an import or
  file-level hook error. Only the final result of a retried test counts (green on retry → no line), each
  cause once. 50 lines per run; the 51st prints `[test-fail] limit of 50 reached — further failures only in
  the vitest summary` at once, a regular run end the remaining count. A failure still in the worker's
  update buffer when the run is killed is lost — only what already arrived is kept.
- **Progress + skip lines (stderr):** at its first test file and at its first test every vitest process
  prints once `[test-progress] first test file started after X s (…)` and
  `[test-progress] first test after X s (run start …, config …) / Y s since wrapper start`; every run
  ends with `[test-skips] N skipped: <count> <note>, <count> no reason given: <file>, …` (top 5) —
  `[test-skips] 0 skipped` when none (absence would be ambiguous). Tests vitest skipped because a
  `beforeAll` of their file threw (the file is red as well) group as `file failed in setup: <file>`.
  `--reporter=json` stdout stays clean.
  WebGPU suites skip with the note `no WebGPU adapter (main suite runs without GPU — covered by npm run
  test:gpu)` (`tests/helpers/webgpu-adapter-skip.ts`; `describe.skipIf` carries no note). The cause is
  config, not hardware: the main suite deliberately runs headless Chromium on SwiftShader (every baseline
  was measured that way), and vitest 4.0.18 does not forward per-instance `launchOptions`.
- **GPU group (`npm run test:gpu`, 2026-10-17):** a separate, serial vitest run of the WebGPU files
  (`tests/gpu-tests.json`: public `real-webgpu-smoke`, `mu-compute-transforms`; private
  `cinematic-capability-probe`, `-motion`, `-render-smoke` when the sibling exists) WITH the real GPU.
  `vitest.gpu.config.ts` spreads the resolved `vite.config.ts` (plugins, aliases, define,
  optimizeDeps, exclude, lock guard identical) and overrides only: the Playwright PROVIDER gets
  `launchOptions.args` = `--use-angle=d3d11 --enable-gpu --ignore-gpu-blocklist` (headless stays on) and
  `launchOptions.channel: 'chromium'` (`GPU_BROWSER_CHANNEL`) — the FULL Chromium in new headless instead of
  `chrome-headless-shell`, which ships no `dxil.dll` / `dxcompiler.dll`, so Dawn D3D12 could not create a
  device and three fell back to WebGL2 silently (measured 2026-10-17),
  `fileParallelism: false` / `maxWorkers: 1` (one GPU), its own `cacheDir` `node_modules/.vite-gpu`
  (never touches the main suite's optimizer cache), `optimizeDeps.entries` = the main suite's test files
  (vitest browser mode scans the project's include, not the CLI filter — with only five files the first run
  re-optimized 37 deps mid-run), the include list, a setup file and a reporter.
  **A missing adapter is an ERROR there, not a skip**: `tests/helpers/gpu-run-setup.ts` prints
  `[gpu-backend] webgl=… webgpu=adapter(…)|none device=ok|<error>` and throws `GPU group without a WebGPU
  adapter — flags not applied or driver/blocklist`, or — adapter present, `requestDevice()` failed —
  `GPU group: WebGPU adapter present but requestDevice failed: <message>`; `skipEachWithoutAdapter` throws the same instead of skipping. Run end
  (stderr, `scripts/test-gpu-run.mjs`): `[gpu-run]` verdict, then `[gpu-quarantine] inside the baseline
  (N): … known failure reproduced, … now pass (remove from the list), … failed for another cause, …` and
  `[gpu-quarantine] outside the baseline: … passed, … failed` — inside = an id of
  `tests/webgpu-quarantine.json` (empty since 2026-10-17 — every GPU failure is red), where a PASS means the known failure reproduced. Not part of `npm test`
  / `test:all`, never staged into a delivery; it needs the GPU, so run it in a load window. Never split
  the main suite into projects for this (plan-602 part B, reverted 77111c0d: cold cache per project,
  mid-run re-optimization, double wall time). Guard: `tests/test-gpu-run.node.test.ts`.
- **Strict optimizeDeps (`[test-deps]`, stderr):** a dependency Vite's optimizer discovers **after the
  run's first test** re-optimizes mid-run and usually reloads the page ("Vite unexpectedly reloaded a
  test") — that run is unusable but used to report green. The same reporter watches the optimizer
  (`registerMissingImport` + its `full-reload`) and prints `[test-deps] undeclared dependency discovered
  mid-run: <dep> — add it to optimizeDeps.include in vite.config.ts (the reload made this run unusable)`;
  every run ends with `[test-deps] 0 mid-run re-optimizations` or the list. **Before** the first test
  (cold cache, "Re-optimizing dependencies because vite config has changed") nothing ever counts.
  `RV_TEST_STRICT_DEPS` = `fail` (a hit ends the run non-zero although every test passed) / `warn` (lines
  only) / `off` (nothing). Default **`fail`** (`DEFAULT_STRICT_DEPS_MODE`) since the discovery run of
  2026-10-16 completed the include list (full suite, fresh worktree, 0 mid-run re-optimizations);
  `RV_TEST_STRICT_DEPS=warn` downgrades a local run. The fix for a hit is always the include entry.
  The watcher is a no-op without `process.env.VITEST` (vitest sets it): the Playwright `webServer` (a
  plain vite dev server), `npm run dev` and builds are never affected — `fail` applies to vitest runs only.
- **e2e port:** Playwright's dev server defaults to **5187** now (`RV_E2E_PORT` overrides), so it no
  longer equals the vitest browser API port 5177.
- Details and troubleshooting: `doc-web-debugging.md` § 4 *Machine-wide test lock*.

### Test Patterns
```typescript
import { describe, it, expect } from 'vitest';

describe('MyComponent', () => {
  it('should do something', () => {
    // Arrange + Act + Assert
  });
});
```

- **Pure TS tests:** Test logic directly, no GLB/Three.js needed
- **GLB integration tests:** Load via GLTFLoader, check `userData.realvirtual`
- **Test files:** `tests/*.test.ts`
- All tests run in headless Chromium via Playwright provider

### Headless is the default (and the opt-out)

`browser.headless: true` is pinned in `vite.config.ts`. Do not remove it: vitest's own
default follows `process.env.CI`, which is unset on a developer machine, so before plan-375
every local `npm test` opened a real Chromium window — extra compositor work per test file,
and frame-timing tests that depended on whether that window was focused or occluded.

To watch a run for visual debugging, opt out per invocation instead of editing the config:

```bash
npx vitest --browser.headless=false                       # watch mode, visible browser
npx vitest run --browser.headless=false tests/foo.test.ts # one file, visible browser
```

### Before Committing
Always run both checks:
```bash
npm run typecheck    # Full typecheck incl. private-dependent tests — must pass with zero errors
npm test             # All tests must pass
```

Note: plain `npx tsc --noEmit` shows the COMMUNITY view — it excludes the generated list of
private-dependent test files (`tests/private-dependent-tests.json`, maintained by
`npm run gen:private-excludes`, guarded by `tests/private-test-excludes.node.test.ts`). The
community edition (public mirror, no private sibling) must stay green on that view; the full
dev check is `npm run typecheck` (tsconfig.full.json).

**If you added, renamed or re-described an MCP tool, also run:**
```bash
npm run gen:mcp-docs   # regenerate the tool reference; commit the changed .md files
```

The tool tables in `webviewer.mcp.md` and `src/plugins/mcp-bridge/help/*.md` are generated
from the `@McpTool` decorators into `<!-- BEGIN GENERATED: … -->` fences and checked in.
`tests/rv-mcp-docs-drift.test.ts` fails in BOTH directions — a tool change without a
regeneration run, and a hand-edited block — so `npm test` will tell you if you forget.
Everything outside the fences is prose: edit it freely, the generator never touches it.
Adding a tool class also means adding its delegate instance to `src/plugins/mcp-bridge/rv-mcp-instances.ts`
(plan-713: the ONE list, production code; `McpBridgePlugin._sendDiscover` and
`tests/helpers/mcp-schemas.ts` both READ it - the helper is no longer hand-maintained) and bumping the
count assertion in `tests/rv-mcp-tool-conventions.test.ts`.

## Debug API

When the dev server is running (`npm run dev`), debug endpoints are available:

| Endpoint | Description |
|----------|-------------|
| `GET /__api/debug` | Full state snapshot (signals, drives, sensors, errors) |
| `GET /__api/debug/signals` | All signal values |
| `GET /__api/debug/drives` | All drive states |
| `GET /__api/debug/sensors` | All sensor states |
| `GET /__api/debug/logs` | Structured log entries |
| `POST /__api/debug/cmd` | Send commands (setSignal, jogDrive, etc.) |

## MCP Integration

realvirtual WEB includes a built-in MCP bridge (`src/plugins/mcp-bridge-plugin.ts`) that exposes the running Three.js scene to AI assistants. The MCP tools documentation is in `webviewer.mcp.md`.

**The default MCP server is realvirtual CONNECT** (`http://localhost:5100/mcp`). It hosts the MCP endpoint itself, so nothing extra is installed: register it as `"realvirtual-CONNECT": { "type": "http", "url": "http://localhost:5100/mcp" }` in `.mcp.json`, enable it via the CONNECT tray icon (*MCP server ▸ Enabled*) and restart CONNECT. The browser reaches it over the same WebSocket contract at `:5100/webviewer` — that is the AI Bridge panel's default port, including under the Vite dev server on 5173 (`?mcpPort=5100` pins it explicitly). A **hosted** page that CONNECT did not serve (the demo on `web.realvirtual.io`, a customer site) targets `ws://localhost:<port>/webviewer` when AI control or a user connection action needs it — no URL parameter — and its https origin is paired once in the CONNECT tray instead of being added to `AllowedOrigins` (plan-541; the AI Bridge panel names the cause when it does not connect). Claude Code and Claude Code Desktop speak HTTP natively; classic Claude Desktop needs the `npx -y mcp-remote http://localhost:5100/mcp --allow-http` stdio shim.

The local **Node bridge** in `mcp-bridge/` (a stdio MCP server hosting its own WebSocket server on `:18714`/`:18715`) is **not deprecated** — it remains the documented emergency fallback. In `.mcp.json` it is parked under the top-level `_disabledMcpServers` key, which Claude Code never launches; move that block into `mcpServers`, run `npm run setup` inside `mcp-bridge/` once, and point the browser at its port to fall back. Moving it back is the way home.

When CONNECT serves the page (marker cookie or same-origin `/health` signature, including the dev proxy), the `/webviewer` channel stays connected with AI on or off for SolidCraft, log relay and ownership status. **AI control** in *Settings ▸ AI* gates the tab's AI/MCP catalog and calls: off announces no tools and refuses non-internal calls with `AI_DISABLED:`; CONNECT enforces the same gate, including for local clients.

Tool ownership is strict: CONNECT owns the `web_*` browser tools, the Unity Python MCP server owns the 80+ Unity Editor tools. The Python server's historic `web_*` proxy on `:18712` still exists (arming `--no-webviewer` everywhere is follow-up plan 348) — ignore it and call `web_*` through CONNECT. Full reference: `doc-ai-integration.md`.

## Architecture contracts (mandatory)

`../realvirtual-WebViewer-Private~/.contracts/` (Private sibling, not on the public mirror) holds the
architecture contracts of realvirtual WEB: golden rules, the reasons behind them, the rejected
alternatives and the guard tests. They are binding for every plan and every change to WebViewer
code, small fixes included. The folder is authoritative, not this list:

| Contract | Read before you touch … |
|---|---|
| `contract-bake-picking.md` | anything that draws, hides, picks or highlights |
| `contract-node-identity.md` | anything that stores, migrates or resolves a reference |
| `contract-signals.md` | signal direction, slots, bindings, mappings, connectors |
| `contract-component-model.md` | component schemas, fields, units and coordinate conversion |
| `contract-documents-projects.md` | documents, projects, manifests, libraries |
| `contract-plugins.md` | plugin lifecycle, listeners, model/placement events |
| `contract-commands-mcp.md` | commands, MCP tools, undo/macro, read-only gates |
| `contract-tier-boundary.md` | Community vs. Commercial vs. internal code, imports across the boundary |

Enforcement: `/planweb`, `/doweb` and `/fix` require reading the touched contracts and naming every
touched rule; `/check-plan` treats a violation as a blocker. A deviation is never worked around
silently: stop and ask. A rule change belongs in the contract itself, not in a plan.

## Documentation Files

| File | Contents |
|------|----------|
| `doc-webviewer.md` | Full architecture, component reference, configuration |
| `doc-deploy.md` | Local test build vs. publishing to public; `npm run deploy`/`deploy:private`, credentials, CI |
| `doc-lifecycle.md` | Runtime lifecycle: model load, fixed-step loop, pause, reset, dispose, events |
| `../realvirtual-WebViewer-Private~/.contracts/contract-bake-picking.md` | **Contract (golden rules + rejected alternatives) of the bake render pipeline, picking and highlight. Read BEFORE changing anything that draws, hides, picks or highlights.** Details and section numbers cited in code: `../realvirtual-WebViewer-Private~/doc-bake-picking-internals.md`. Private sibling, not on the public mirror. |
| `../realvirtual-WebViewer-Private~/.contracts/contract-node-identity.md` | **Contract of node identity (NodeId) and stored references (addresses). Read BEFORE changing anything that stores, migrates or resolves a reference.** Mechanics: `doc-node-paths.md` § 0. |
| `doc-node-paths.md` | **Node paths: how component/signal references are written by the exporter and resolved by NodeRegistry. The three naming layers (Unity / glTF / Three.js after sanitization + file-global dedup), alias mechanics, resolution order, known pitfalls. Read BEFORE changing anything that stores or resolves a path.** |
| `doc-ui-visibility.md` | **UI visibility: the two independent axes — plugin runtime participation (`modes`/`core` → `pluginParticipatesInMode`) vs. element presentation (`visibilityRule`/`useUIVisible`), the bridge in `UIPluginRegistry.register`, the `shownOnlyInAny` overwrite, deploy overrides. Read BEFORE changing plugin `modes`/`core`, UI slots or anything gated by `useUIVisible`.** |
| `doc-extending-webviewer.md` | Plugin system, custom components, UI slots, hooks |
| `doc-path-fleet-control.md` | Path-based vehicles (AGV/FTS): task primitive (destination + service time + callbacks), fleet/dock/router seams for project logic (TS plugin or JS-in-GLB), traffic in both kernels incl. the DES segment-occupancy rule |
| `doc-multiuser-system.md` | Multiuser sessions, relay server, shared views |
| `doc-web-debugging.md` | Debugging tools and workflow |
| `doc-webviewer-interface.md` | Industrial interfaces (WebSocket Realtime, ctrlX, MQTT) — protocol, signal flow, new-interface guide |
| `doc-persistence.md` | Persistence architecture: document model, ops log, drafts, localStorage / sessionStorage / IndexedDB layout |
| `doc-ai-integration.md` | AI integration + MCP bridge: architecture, setup, the AI Bridge status panel, activity indicator, `web_screenshot` cropping, troubleshooting |
| `webviewer.mcp.md` | MCP tools reference (imported at runtime) |

## Git Repository — git only, no Plastic

This directory has its **own git repository**, and since plan-360 (2026-08-01) git is its
**sole owner**: Plastic SCM no longer tracks these files, so `cm update`, a branch switch or a
Plastic merge cannot change or delete anything here. Nothing in this folder belongs in a
Plastic checkin.

- **`origin`** — `https://git.realvirtual.io/rv-internal/realvirtual-WEB.git` (Forgejo, the
  integration remote; every commit goes here)
- **`public`** — `https://github.com/game4automation/realvirtual-WEB.git` (public mirror,
  pushed deliberately and only via `/gitweb`)
- **Branch:** `main`

Commit here, not in the parent repo. **Add path by path, never `git add -A`** - in a
shared checkout the tree regularly carries other sessions' uncommitted work, and `-A`
would sweep it into your commit (plus stray files like redirected test logs, which are
not gitignored):
```bash
git add -- src/thing.ts tests/thing.test.ts   # the paths YOU changed
git commit -m "feat(webviewer): description"
git push origin main
```

### Check-in authorization

Commit and push to the internal `origin` remote of this repo and of its private sibling
need no individual approval: finished, green work gets committed and pushed, then
reported, instead of being parked uncommitted while someone waits for a word. The
authoritative wording, including which remotes and targets are excluded, lives outside
this mirrored file: see the repository CLAUDE.md of the parent Unity project, section
"Standing authorization for web-repo check-ins".

Two conditions hold absolutely:
- **Your own changes only, added path by path** (see above). Foreign uncommitted work in
  the tree is reported, never carried along. If you cannot tell whose a change is, read
  its diff instead of guessing from the path.
- **Never rewrite what is not yours.** No `rebase`, `reset --hard` or force-push while
  foreign commits or foreign working-tree changes are present. Setting your commit onto
  `origin/main` freshly (`read-tree` / `commit-tree`), or pushing via a temporary
  `git worktree`, is how to do that without touching the shared tree.

Pushing to the public mirror, publishing into external repositories, deployments and
releases are **never** covered by this and always need an explicit word from Thomas or
Vincent, given in their own session.

## Private/Commercial Extensions

Private extensions live in the sibling folder `../realvirtual-WebViewer-Private~/`. They are wired in via Vite path aliases (`@rv-private`). When absent, stub files in `src/private-stubs/` provide no-op fallbacks.

Private content is NOT AGPL — do not add AGPL headers to private files.

**Two private tiers** (see `doc-deploy.md` → "Build tiers & feature gating"): `private-plugins.ts` = customer tier (ships in customer deploys), `internal-plugins.ts` = internal/dev-only tier, loaded ONLY behind the `__RV_INTERNAL__` build flag (dev server/vitest always on; production builds only with `RV_INTERNAL=1`; customer deploys never set it — Rollup drops the gated dynamic import and its chunks). NEVER import internal feature modules statically — their side-effect registrations would leak back into every private build. Guard: `tests/private-internal-gate.node.test.ts`. New in-development features register in `internal-plugins.ts`, not `private-plugins.ts`.

**On-demand features (plan-652):** the Editor (`asset-editor`) and DES (`des`) are declared at startup and load on first use (manifest `activation`, stub `features/<id>.register.ts` + body `features/<id>.body.ts`, `viewer.features`). NEVER value-import a `*.body.ts`, `plugins/asset-editor/**` (except `asset-editor/shared/`) or `plugins/des/**` from entry/startup code — one static import pulls the body back into the boot set. Call `viewer.features.ensure(...)` / `ensureFeatureIfDeclared(...)` before `getPlugin('asset-editor' | 'des-hmi')`. Guards: `tests/feature-manifest-consistency.node.test.ts`, `npm run test:bundle-guard`. Details: `doc-extending-webviewer.md` → *On-demand features*.

## Design Context

Before designing or changing UI, read the two design-context files. They live in the **private
sibling** `../realvirtual-WebViewer-Private~/` — strategy and brand are not published on the
public mirror:

- **`../realvirtual-WebViewer-Private~/PRODUCT.md`** — strategic context: register (product), users, positioning ("the open standard for browser-based 3D-HMIs"), brand personality (precise, industrial, calm), anti-references (no SCADA/WinCC look, no gamer/sci-fi HUD, no generic SaaS dashboard, no consumer playfulness), WCAG AA target.
- **`../realvirtual-WebViewer-Private~/DESIGN.md`** — the visual system ("The Glass Control Room"): three glass surface tiers over the 3D viewport, no shadows, Instrument Blue `#4fc3f7` as the only working accent, monospace for all measurement values, 13px Inter density.

New UI must follow these files; they are the source of truth for design decisions. Without the
private sibling (community edition) they are simply absent — the code itself remains the
fallback authority (`src/core/hmi/theme.ts`, `signal-colors.ts`).

### Inspector UI rule (plan-510) — read [`DESIGN.md`](DESIGN.md) before touching the inspector

- Inspector UI is built **only** from the inspector building blocks (`InspectorRow`,
  `InspectorSubheader`, `InspectorActionRow`, `DetailsDisclosure`) and the design values of
  `src/core/hmi/shared-sx.ts` (`INK_*`, `DIVIDER`, `FS.*`, `ICON_SIZE.*`, `ACCENT`/`WARN`/…) —
  no local colours, font sizes, pixel columns or `type="number"` inputs; UI text is English;
  numbers go through `parseDecimal` / `formatDecimal` (`rv-number-format.ts`).
- The ESLint baseline (`eslint-suppressions.json`) and the language allowlist
  (`tests/fixtures/ui-language-allowlist.json`) **only shrink**: never regenerate or extend them,
  never raise `SUPPRESSION_CEILING` / `ALLOWLIST_CEILING` without the user's approval — fix the
  code, then `npm run lint:prune` and lower the ceiling.
- The gate is `npm run test:all` (it runs `tests/hmi-design-lint.node.test.ts` and
  `tests/ui-language.node.test.ts` via `test:node`); `npm test` alone does not.
- Reference page: `?rvDev=inspector-gallery` on the dev server.
