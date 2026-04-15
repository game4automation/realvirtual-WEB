# CLAUDE.md — realvirtual WEB

This file provides guidance to Claude Code when working with the realvirtual WEB codebase.

## Project Overview

**realvirtual WEB** is a browser-based 3D HMI and digital twin viewer for industrial automation. It loads GLB models and runs interactive transport simulation, drive animation, sensor collision, and LogicStep sequencing in the browser.

- **License:** AGPL-3.0-only (dual-licensed with commercial option)
- **Runtime:** Three.js + TypeScript
- **HMI:** React 19 + MUI 7
- **Build:** Vite 6
- **Physics:** Rapier.js (WASM)
- **Tests:** Vitest + Playwright (browser-mode, 1300+ tests)

## Quick Start

```bash
npm install
npm run dev          # Vite dev server with HMR (localhost:5173)
npm run build        # Production build -> dist/
npm test             # Run all tests (headless Chromium)
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
      rv-simulation-loop.ts      # Fixed 60 Hz timestep accumulator
    hmi/                         # React HMI components (MUI-based)
      HMIShell.tsx               # Main HMI layout shell
      TopBar.tsx / BottomBar.tsx  # Navigation bars
      settings/                  # Settings panel tabs
      tooltip/                   # Tooltip system
  hooks/                         # React hooks
  interfaces/                    # Industrial protocol adapters
  plugins/                       # Built-in plugins
  plugins/demo/                  # Demo charts and HMI plugin (OeeChart, DriveChartOverlay, etc.)
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

## Testing

### Running Tests
```bash
npm test              # Run all tests once (CI mode)
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

### Before Committing
Always run both checks:
```bash
npx tsc --noEmit     # Must pass with zero errors
npm test             # All tests must pass
```

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

The recommended MCP server is [realvirtual-MCP](https://github.com/game4automation/realvirtual-MCP) — a Python bridge that connects AI agents (Claude Code, Claude Desktop, Cursor) to realvirtual WEB via the debug API. When also used with the Unity Editor, 80+ additional tools for scene authoring and simulation control become available.

## Documentation Files

| File | Contents |
|------|----------|
| `doc-webviewer.md` | Full architecture, component reference, configuration |
| `doc-extending-webviewer.md` | Plugin system, custom components, UI slots, hooks |
| `doc-multiuser-system.md` | Multiuser sessions, relay server, shared views |
| `doc-web-debugging.md` | Debugging tools and workflow |
| `doc-webviewer-interface.md` | RVViewer public API reference |
| `webviewer.mcp.md` | MCP tools reference (imported at runtime) |

## Git Repository

This directory has its **own git repository** (separate from the parent realvirtual Plastic SCM repo):

- **Remote:** `https://github.com/game4automation/realvirtual-WEB-DEV.git`
- **Branch:** `main`

Commit here, not in the parent repo:
```bash
git add -A
git commit -m "feat(webviewer): description"
git push origin main
```

## Private/Commercial Extensions

Private extensions live in the sibling folder `../realvirtual-WebViewer-Private~/`. They are wired in via Vite path aliases (`@rv-private`). When absent, stub files in `src/private-stubs/` provide no-op fallbacks.

Private content is NOT AGPL — do not add AGPL headers to private files.
