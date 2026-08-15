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
public/models/                   # GLB model files
```

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

## Testing

### Running Tests
```bash
npm test              # Run all tests once (CI mode)
npm run test:node     # Node-environment tests only (*.node.test.ts) — seconds, no browser
npm run test:watch    # Watch mode for development
```

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
Adding a tool also means adding its delegate instance to `tests/helpers/mcp-schemas.ts`
(the ONE list that must mirror `_sendDiscover`) and bumping the count assertion in
`tests/rv-mcp-tool-conventions.test.ts`.

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

**The default MCP server is realvirtual CONNECT** (`http://localhost:5100/mcp`). It hosts the MCP endpoint itself, so nothing extra is installed: register it as `"realvirtual-CONNECT": { "type": "http", "url": "http://localhost:5100/mcp" }` in `.mcp.json`, enable it via the CONNECT tray icon (*MCP server ▸ Enabled*) and restart CONNECT. The browser reaches it over the same WebSocket contract at `:5100/webviewer` — that is the AI Bridge panel's default port, including under the Vite dev server on 5173 (`?mcpPort=5100` pins it explicitly). Claude Code and Claude Code Desktop speak HTTP natively; classic Claude Desktop needs the `npx -y mcp-remote http://localhost:5100/mcp --allow-http` stdio shim.

The local **Node bridge** in `mcp-bridge/` (a stdio MCP server hosting its own WebSocket server on `:18714`/`:18715`) is **not deprecated** — it remains the documented emergency fallback. In `.mcp.json` it is parked under the top-level `_disabledMcpServers` key, which Claude Code never launches; move that block into `mcpServers`, run `npm run setup` inside `mcp-bridge/` once, and point the browser at its port to fall back. Moving it back is the way home.

Tool ownership is strict: CONNECT owns the `web_*` browser tools, the Unity Python MCP server owns the 80+ Unity Editor tools. The Python server's historic `web_*` proxy on `:18712` still exists (arming `--no-webviewer` everywhere is follow-up plan 348) — ignore it and call `web_*` through CONNECT. Full reference: `doc-ai-integration.md`.

## Documentation Files

| File | Contents |
|------|----------|
| `doc-webviewer.md` | Full architecture, component reference, configuration |
| `doc-deploy.md` | Local test build vs. publishing to public; `npm run deploy`/`deploy:private`, credentials, CI |
| `doc-lifecycle.md` | Runtime lifecycle: model load, fixed-step loop, pause, reset, dispose, events |
| `../realvirtual-WebViewer-Private~/doc-render-picking.md` | **Batched render pipeline (motion blobs) + picking/highlight system — architecture AND hard do-not-touch contracts. Read BEFORE changing rv-batched-render/rv-batch-*/rv-raycast-*/rv-highlight-* files.** Lives in the private sibling (not published on the public mirror). |
| `doc-node-paths.md` | **Node paths: how component/signal references are written by the exporter and resolved by NodeRegistry. The three naming layers (Unity / glTF / Three.js after sanitization + file-global dedup), alias mechanics, resolution order, known pitfalls. Read BEFORE changing anything that stores or resolves a path.** |
| `doc-ui-visibility.md` | **UI visibility: the two independent axes — plugin runtime participation (`modes`/`core` → `pluginParticipatesInMode`) vs. element presentation (`visibilityRule`/`useUIVisible`), the bridge in `UIPluginRegistry.register`, the `shownOnlyInAny` overwrite, deploy overrides. Read BEFORE changing plugin `modes`/`core`, UI slots or anything gated by `useUIVisible`.** |
| `doc-extending-webviewer.md` | Plugin system, custom components, UI slots, hooks |
| `doc-path-fleet-control.md` | Path-based vehicles (AGV/FTS): task primitive (destination + service time + callbacks), fleet/dock/router seams for project logic (TS plugin or JS-in-GLB), traffic in both kernels incl. the DES segment-occupancy rule |
| `doc-multiuser-system.md` | Multiuser sessions, relay server, shared views |
| `doc-web-debugging.md` | Debugging tools and workflow |
| `doc-webviewer-interface.md` | Industrial interfaces (WebSocket Realtime, ctrlX, MQTT) — protocol, signal flow, new-interface guide |
| `doc-persistence.md` | Persistence architecture: Scene model, ops log, drafts, localStorage / sessionStorage / IndexedDB layout |
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

Commit here, not in the parent repo:
```bash
git add -A
git commit -m "feat(webviewer): description"
git push origin main
```

Work canonically on `main` or in a worktree (`/worktree-web <plan>`) — the worktree is a tool
against parallel sessions, not an obligation. A handful of paths that git ignores (for example
`.env.production` and the NDA models under `public/models/library/Custom/`) stay under Plastic
control; they are listed file by file in `<WS>\ignore.conf`.

## Private/Commercial Extensions

Private extensions live in the sibling folder `../realvirtual-WebViewer-Private~/`. They are wired in via Vite path aliases (`@rv-private`). When absent, stub files in `src/private-stubs/` provide no-op fallbacks.

Private content is NOT AGPL — do not add AGPL headers to private files.

**Two private tiers** (see `doc-deploy.md` → "Build tiers & feature gating"): `private-plugins.ts` = customer tier (ships in customer deploys), `internal-plugins.ts` = internal/dev-only tier, loaded ONLY behind the `__RV_INTERNAL__` build flag (dev server/vitest always on; production builds only with `RV_INTERNAL=1`; customer deploys never set it — Rollup drops the gated dynamic import and its chunks). NEVER import internal feature modules statically — their side-effect registrations would leak back into every private build. Guard: `tests/private-internal-gate.node.test.ts`. New in-development features register in `internal-plugins.ts`, not `private-plugins.ts`.

## Design Context

Before designing or changing UI, read the two design-context files. They live in the **private
sibling** `../realvirtual-WebViewer-Private~/` — strategy and brand are not published on the
public mirror:

- **`../realvirtual-WebViewer-Private~/PRODUCT.md`** — strategic context: register (product), users, positioning ("the open standard for browser-based 3D-HMIs"), brand personality (precise, industrial, calm), anti-references (no SCADA/WinCC look, no gamer/sci-fi HUD, no generic SaaS dashboard, no consumer playfulness), WCAG AA target.
- **`../realvirtual-WebViewer-Private~/DESIGN.md`** — the visual system ("The Glass Control Room"): three glass surface tiers over the 3D viewport, no shadows, Instrument Blue `#4fc3f7` as the only working accent, monospace for all measurement values, 13px Inter density.

New UI must follow these files; they are the source of truth for design decisions. Without the
private sibling (community edition) they are simply absent — the code itself remains the
fallback authority (`src/core/hmi/theme.ts`, `signal-colors.ts`).
