# realvirtual WEB

**Browser-Based 3D HMI, Machine Information System, and Digital Twin Viewer for Industrial Automation**

[![License: AGPL v3](https://img.shields.io/badge/License-AGPL_v3-blue.svg)](https://www.gnu.org/licenses/agpl-3.0)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue.svg)](https://www.typescriptlang.org/)
[![Three.js](https://img.shields.io/badge/Three.js-WebGL%20%7C%20WebGPU-green.svg)](https://threejs.org/)
[![AI-Driven Development](https://img.shields.io/badge/AI--Driven_Development-MCP_Enabled-blueviolet.svg)](https://github.com/game4automation/realvirtual-MCP)

![realvirtual WEB — Browser-based 3D HMI and Digital Twin Viewer](docs/images/realvirtual-web-demo.jpg)

realvirtual WEB is an open-source, browser-based 3D HMI and digital twin viewer for manufacturing. Load any standard GLB/glTF file and view it as an interactive 3D model in the browser. For full digital twin functionality — drives, sensors, transport simulation, signal wiring, and KPI dashboards — use GLB files enriched with `rv_extras` metadata, either exported from [realvirtual.io](https://realvirtual.io) Professional or authored manually. No installation required.

**One link. Any device. Live Digital Twin.** Try it: [web.realvirtual.io/demo](https://web.realvirtual.io/demo)

> Part of the [realvirtual.io](https://realvirtual.io) industrial digital twin platform — a [Unity Verified Solution](https://unity.com/partners/realvirtual) for virtual commissioning, 3D HMI, and simulation.

## What It Does

realvirtual WEB replaces traditional desktop HMI and SCADA visualization with a modern, browser-based 3D experience. Connect to real PLCs via WebSocket or MQTT, and operators see live machine states — drive positions, sensor readings, alarms, KPIs — all in the context of the machine's 3D layout. Unlike flat panel HMIs, operators see *what* is happening, *where* it is happening, and *why*.

### Key Capabilities

- **Workspace Modes** — One application, four workspaces, switchable from the toolbar or via `?mode=viewer|hmi|planner|des`: **Viewer** (just show the machine — model and running kinematics, no panels and no authoring), **HMI** (operate and monitor), **Planner** (assemble layouts), **DES** (event-driven material-flow analysis).
- **Live 3D HMI** — Real-time PLC signal visualization via WebSocket or MQTT. Drive monitoring, sensor states, KPI overlays, alarm dashboards, and production charts powered by [Apache ECharts](https://echarts.apache.org/).
- **Signal Linking by Drag & Drop** — Drag a live interface signal straight onto a component slot (Forward, TargetSpeed, SensorOccupied, …). Direction and value type are checked, connections are saved with the layout, and signals can be monitored and forced.
- **Collision Detection** — Give a node one of six collision roles (Tool, Workpiece, Machine, Robot, Environment, None); while the simulation runs, every pair of bodies with *different* roles is checked against each other.
- **Machine Information System** — Attach documents, maintenance guides, technical drawings, and manuals directly to 3D components. Technicians click a part and see its documentation in context — accessible from any device on the shop floor.
- **Transport Simulation** — Full in-browser simulation engine at 60 Hz fixed timestep: conveyor surfaces, sources, sinks, sensors with AABB collision, grippers, and material flow.
- **LogicStep Sequencing** — Serial/parallel containers, signal conditions, delays, drive commands — ported from realvirtual.io Professional based on Unity.
- **WebXR (VR/AR)** — Immersive visualization on Meta Quest, Apple Vision Pro, and AR on Android/iOS with surface detection.
- **Layout Planning** *(Beta)* — Assemble factory layouts directly in the browser: drag reusable parts from a library onto a grid, connect them with typed snap points, and position them with transform gizmos. Ships with a standard parts library and can load any GLB catalog straight from a GitHub repository.
- **Multiuser Sessions** *(Beta)* — Real-time collaboration with avatars, shared camera views, role management, and late-join state sync.
- **Plugin Architecture** — Extend with custom plugins for project-specific HMI, KPI dashboards, maintenance workflows, and industrial interfaces.
- **AI-Ready (MCP)** — Built-in [Model Context Protocol](https://modelcontextprotocol.io) bridge lets AI assistants like Claude inspect, control, and debug a running realvirtual WEB instance — read drive states, set signals, query scene hierarchy, and automate testing through natural language. Uses the [realvirtual MCP Server](https://github.com/game4automation/realvirtual-MCP).

## Use Cases

### 3D HMI / Operator Dashboards
Web-based HMI connected to real PLCs via WebSocket or MQTT. Live signal visualization, KPI overlays, drive monitoring — replacing desktop HMI applications with a browser link.

![HMI Overview — KPI cards, message panel, button panel, search bar, camera presets](docs/images/screenshot-hmi-overview.png)

### Machine Information System
Attach PDFs, maintenance guides, technical drawings, operating manuals, and spare part lists directly to individual 3D components. Technicians open a link on their tablet, click on a motor or valve, and immediately see its documentation, maintenance history, and real-time status — all in 3D context, on-site or remotely. No more searching through binders or file shares.

### Sales & Product Presentation
Interactive 3D models that let prospects explore machines live in the browser. More convincing than slides, more accessible than installed software. Share a link — done.

### Product Configurators
Build browser-based 3D product configurators where customers select options, variants, and accessories — and see the result rendered in real time. Combine with the plugin system to add pricing, BOM generation, or quote workflows.

### Layout Planning
Assemble factory layouts directly in the browser — drag conveyors, robots, fixtures, and pallets from a parts library onto a grid, connect them with typed snap points, and arrange them with transform gizmos. Ships with a standard parts library, and can additionally load GLB catalogs from a URL or GitHub repository.

![Layout Planner — the library panel with conveyors and pallets, placing a snap-connected chain conveyor on the grid](docs/images/screenshot-layout-planner.jpg)

**Try it live:** [Layout Planner demo](https://web.realvirtual.io/demo/?scene=published%3ADemoPlanner&mode=planner)

### Training & Onboarding
Operators learn machine behavior interactively before touching the real system. No software installation, no VPN, no IT department required.

### Remote Acceptance & Support
Share virtual commissioning models with customers for review and sign-off — worldwide, instantly.

## Quick Start

```bash
# Requirements: Node.js >= 18
# Clone the repository (increase buffer for large GLB model files)
git config --global http.postBuffer 524288000
git clone https://github.com/game4automation/realvirtual-WEB.git
cd realvirtual-WEB

npm install
npm run dev          # Vite dev server with HMR
```

Drop `.glb` files exported from [realvirtual.io](https://realvirtual.io) into `public/models/` — they appear automatically in the model selector.

```bash
npm run build        # Production build -> dist/ (local only, nothing published)
npm run preview      # Preview production build
npx tsc --noEmit     # Type check (community view)
npm test             # Run browser tests (headless Chromium via Playwright)
npm run test:node    # Run Node.js tests (fs, glob, ESLint instance)
npm run test:all     # Run both Node + browser tests
npm run e2e          # Run Playwright end-to-end tests (e2e/)
npm run lint         # ESLint (flat-config, boundaries rule)
```

**Type checking:** plain `npx tsc --noEmit` is the **community view** — the base `tsconfig.json`
excludes the generated list of private-dependent tests (`tests/private-dependent-tests.json`), so it
type-checks exactly what a clone of this repository actually contains. `npm run typecheck` is the
*maintainer* full check: it uses `tsconfig.full.json` and **requires the private sibling repository**
`../realvirtual-WebViewer-Private~`, which is not part of this repository — running it without that
folder produces a wall of unresolvable `@rv-private/*` errors. Use `npx tsc --noEmit`.

Publishing is maintainer-only: `npm run deploy` uploads to realvirtual's own Bunny CDN
(`web.realvirtual.io`) and needs `BUNNY_*` credentials that ship with no clone. To host a build
yourself, serve the `dist/` folder produced by `npm run build` from any static web server — see
[doc-deploy.md](doc-deploy.md) for the deployment details.

## Operating Modes

| Mode | Description |
|------|-------------|
| **Standalone** | Pure browser simulation — no gateway, no PLC. The fixed-timestep simulation loop runs the full digital twin offline. |
| **Live** | Connected to a **realvirtual CONNECT** gateway over WebSocket — CONNECT talks to the PLC and streams signals into the browser in real time. This is the usual arrangement for PLC protocols (OPC UA, S7, ADS, Modbus, …), because the browser cannot speak them directly. |
| **Direct** | The browser connects straight to the equipment over a browser-capable protocol (MQTT over WebSocket, REST) — no gateway in the loop. |

**realvirtual CONNECT** is the gateway that makes Live mode work: it speaks the industrial
protocols a browser cannot, and hands the signals to realvirtual WEB over one WebSocket. It is a
separate product and is documented at
[realvirtual.io/doc/web/connect](https://realvirtual.io/doc/web/connect/) — this repository holds
only the browser side of the contract (see [doc-webviewer-interface.md](doc-webviewer-interface.md)).

## Deployment Options

- **Public Demo** — Publish to `web.realvirtual.io` for sales demos and marketing
- **Private Projects** — Unguessable URLs with 128-bit entropy for secure customer access
- **Self-Hosted** — Deploy on your own infrastructure with `settings.json` configuration
- **Kiosk Mode** — Lock all configuration UI for shopfloor panels and public displays

## Tech Stack

| Component | Technology |
|-----------|-----------|
| 3D Rendering | [Three.js](https://threejs.org/) (WebGL + WebGPU *(Beta)* + WebXR) |
| UI Framework | React 19 + MUI 7 |
| Charts | Apache ECharts 6 |
| Build Tool | Vite 6 |
| Language | TypeScript 5.9 |
| Testing | Vitest (browser-mode) + Playwright |

## Industrial Connectivity

Connect to real automation systems via:

| Protocol | Description |
|----------|-------------|
| **WebSocket Realtime** | Bidirectional PLC signal streaming (primary live mode) |
| **MQTT** | IoT and cloud connectivity |
| **Bosch Rexroth ctrlX** | Direct ctrlX CORE integration |
| **REST API** | Polling-based signal access |

The Unity-side [realvirtual.io Professional](https://realvirtual.io) supports 15+ industrial protocols including Siemens S7, Beckhoff ADS, OPC UA, Fanuc, KUKA, ABB, EtherNet/IP, Modbus, and more — all bridged to the browser via WebSocket.

## Architecture

realvirtual WEB works with **any standard GLB/glTF file** — load a CAD export from Blender, SolidWorks, Fusion 360, or any other 3D tool and view it as an interactive 3D model in the browser.

For full digital twin functionality, the GLB file becomes the single source of truth: signal bindings, kinematic definitions, drive parameters, sensor thresholds, and component metadata are embedded via the `rv_extras` schema. [realvirtual.io Professional](https://realvirtual.io) provides the authoring tools to add this metadata during Unity export, but the `rv_extras` format is open and documented — you can author it with any toolchain.

```
src/
  core/
    engine/          # Simulation engine (drives, sensors, transport)
    hmi/             # React HMI components (panels, tooltips, settings)
  hooks/             # React hooks
  interfaces/        # Industrial protocol adapters (WebSocket, MQTT, ctrlX)
  plugins/           # Built-in plugins (multiuser, annotations, FPV, XR)
    demo/            # Demo charts and HMI (OEE, cycle time, energy, drive/sensor overlays)
    models/          # Per-model plugins (auto-loaded when a model is selected)
  private-stubs/     # No-op stubs for commercial modules — what makes this community
                     #   edition build and run without the private sibling repository
tests/               # Vitest browser-mode tests
e2e/                 # Playwright E2E tests
public/models/       # GLB model files
```

## Extending realvirtual WEB

Plugins can contribute UI components to predefined **slots** in the HMI layout — KPI bar, button panel, message panel, settings tabs, and more. The built-in demo plugin uses all of these:

![Drive Monitor — real-time ECharts overlay showing all drive positions](docs/images/screenshot-drive-chart.png)

![Hierarchy Browser — scene tree with component type filters and search](docs/images/screenshot-hierarchy.png)

![Settings Panel — tabbed configuration for model, visual, interfaces, and AI](docs/images/screenshot-settings.png)

The plugin system makes it easy to add custom functionality. Create a plugin class and register it with `viewer.use()`:

```typescript
import type { RVViewerPlugin } from './core/rv-plugin';
import type { RVViewer } from './core/rv-viewer';

class MyPlugin implements RVViewerPlugin {
  id = 'my-plugin';

  init(viewer: RVViewer) {
    // Access drives, signals, scene — all from the RVViewer API
    viewer.on('model-loaded', () => {
      const drives = viewer.drives;          // all drives in the scene
      const signals = viewer.signalStore;    // PLC signal store
      console.log(`Model loaded with ${drives.length} drives`);
    });
  }
}

// Register in main.ts or a model-specific plugin module
viewer.use(new MyPlugin());
```

**Per-model plugins** load automatically when a specific GLB is selected. Place them in `src/plugins/models/<ModelName>/index.ts`:

```typescript
export const models = ['MyMachine'];  // matches MyMachine.glb

export function registerModelPlugins(viewer) {
  viewer.use(new MyCustomDashboard());
}

export function unregisterModelPlugins(viewer) {
  viewer.removePlugin('my-dashboard');
}
```

For the full plugin API — UI slots, event bus, hooks, context menus, and tooltip extensions — see [doc-extending-webviewer.md](doc-extending-webviewer.md).

## Documentation

End users start at the **[realvirtual WEB documentation site](https://realvirtual.io/doc/web/)**.
Developers start with **[Architecture](doc-webviewer.md)**. The full in-repo documentation set:

**Getting started & architecture**
| Document | Contents |
|----------|----------|
| [Architecture](doc-webviewer.md) | Full architecture, component reference, configuration, workspace modes |
| [From Unity to the Web](doc-unity-to-web.md) | Porting patterns and the AI coding-agent workflow |
| [Lifecycle](doc-lifecycle.md) | Runtime lifecycle: model load, fixed-step loop, pause, reset, dispose, events |
| [Node Paths](doc-node-paths.md) | How component, signal and kinematic references are written and resolved |

**Building & extending**
| Document | Contents |
|----------|----------|
| [Plugin Development](doc-extending-webviewer.md) | Plugin system, custom components, UI slots, hooks |
| [Events & Hooks](doc-events-and-hooks.md) | Typed event bus and plugin/component lifecycle hooks |
| [Component Behaviors](doc-behaviors.md) | Per-node TypeScript behaviors and naming conventions |
| [Component Scripting](doc-scripting.md) | JavaScript behaviors authored inside the GLB, run in a QuickJS sandbox |
| [Behavior Modelling](doc-behavior-modelling.md) | Continuous vs DES material-flow modelling (beginner's guide) |
| [Signal Architecture](doc-signal-architecture.md) | Signal store: GLB import to React UI, PLC direction, batching |
| [Signal Connection Logic](doc-signal-connection-logic.md) | Slots, connection states, drag & drop linking, forcing, persistence |
| [UI Visibility](doc-ui-visibility.md) | Which axis decides what is shown: plugin modes vs. UI visibility rules |

**Authoring & operations**
| Document | Contents |
|----------|----------|
| [Layout Planner](doc-layout-planner.md) | Library objects, catalogs, snap points, pivots, deep-links |
| [Persistence](doc-persistence.md) | Scene model, edit ops log, drafts, storage layout |
| [Document Linking](doc-document-linking.md) | PDF/AASX datasheet linking and metadata |

**Connectivity & collaboration**
| Document | Contents |
|----------|----------|
| [Industrial Interfaces](doc-webviewer-interface.md) | WebSocket Realtime, ctrlX, MQTT, signal flow, new-interface guide |
| [Multiuser System](doc-multiuser-system.md) | Sessions, shared views, avatars |
| [AI Integration](doc-ai-integration.md) | AI integration and the MCP bridge |
| [MCP Tools](webviewer.mcp.md) | MCP tools reference (read state, set signals, build layouts) |

**Deploy & debug**
| Document | Contents |
|----------|----------|
| [Building & Deploying](doc-deploy.md) | Local test build vs. publishing, private projects, credentials, CI |
| [Debugging Guide](doc-web-debugging.md) | Debugging tools, debug API, E2E tests, workflow |

## AI-Enabled Development (MCP)

realvirtual WEB and [realvirtual.io](https://realvirtual.io) are fully AI-enabled through the **Model Context Protocol (MCP)**. AI coding assistants like [Claude Code](https://claude.ai/code) can drive the running scene directly.

**The MCP server ships inside [realvirtual CONNECT](https://realvirtual.io/doc/web/connect/)** — there is
nothing extra to install. CONNECT hosts the endpoint at `http://localhost:5100/mcp`; point your
assistant at it and the `web_*` tools reach the browser scene over the same origin that serves it:

- **realvirtual WEB** — list drives and positions, read/write PLC signals, query the scene
  hierarchy, inspect sensor states, debug transport simulation, take screenshots of the running
  scene.
- **Unity Editor** *(optional)* — with [realvirtual.io](https://realvirtual.io) Professional, the
  separate realvirtual MCP package adds 80+ editor tools: create GameObjects, set component
  properties, run simulations, manage scenes, run tests.

This means AI assistants can design, build, test, and debug industrial digital twins end-to-end.

### Getting Started with AI Development

This repo includes a full [Claude Code](https://claude.ai/code) setup:

- **[CLAUDE.md](CLAUDE.md)** — Project conventions, architecture overview, and coding guidelines for AI assistants
- **[.claude/commands/](.claude/commands/)** — Slash commands for common workflows: `/dev`, `/debug`, `/test`, `/build`, `/inspect`, `/license-check`
- **[webviewer.mcp.md](webviewer.mcp.md)** — MCP tools reference for browser-side scene inspection

Open this project in Claude Code and use `/dev` to start the dev server, `/debug drives` to inspect drive states, or `/test` to run the full test suite — all through natural language.

## The Two-Platform Strategy

realvirtual.io follows a deliberate two-platform architecture:

| | Unity (Engineering Platform) | realvirtual WEB (Delivery Platform) |
|---|---|---|
| **Purpose** | CAD import, behavior modeling, virtual commissioning | Browser-based 3D HMI, monitoring, collaboration |
| **Technology** | Unity Engine, C#, Unity Industry | Three.js, TypeScript, React |
| **Deployment** | Desktop application, XR headsets, mobile devices | Any modern browser |
| **PLC connection** | Native protocol drivers | WebSocket / MQTT gateway |
| **Target user** | Automation engineer, simulation expert | Operator, service tech, sales, customer |

## Contributing

Contributions are welcome. Please note that realvirtual WEB is **dual-licensed**
(AGPL-3.0-only + commercial): by submitting a pull request or any other
contribution, you agree to the grant of rights described in
[CONTRIBUTING.md](CONTRIBUTING.md), which allows realvirtual GmbH to also
license your contribution under its commercial license.

## License

Copyright (C) 2025–2026 [realvirtual GmbH](https://realvirtual.io)

This program is licensed under the **GNU Affero General Public License v3 (AGPL-3.0)**.

**What this means:** If you use, modify, or build upon realvirtual WEB in your own project — including deploying it as a web service — you must publish your **complete project** under the same AGPL-3.0 license and make it freely available. This includes all source code, configuration, and **all content delivered through the application** (such as GLB model files, settings, and plugins). This applies whether served over a network or distributed directly.

The "Powered by realvirtual WEB" watermark and the realvirtual logo must remain visible and unmodified in all AGPL deployments. Removal or modification of any branding requires a commercial license.

See [LICENSE](LICENSE) for the full license text.

**SPDX-License-Identifier:** `AGPL-3.0-only`

### Commercial License

If you want to use realvirtual WEB in proprietary or closed-source products — or keep your 3D models, project configuration, and plugins private — a commercial license is available.

Contact: [realvirtual.io/en/company/license](https://realvirtual.io/en/company/license)

---

**[realvirtual.io](https://realvirtual.io)** | [Live Demo](https://web.realvirtual.io/demo) | [realvirtual WEB Documentation](https://realvirtual.io/doc/web/) | [realvirtual.io Documentation](https://doc.realvirtual.io) | [YouTube](https://youtube.com/@realvirtualio) | [Forum](https://forum.realvirtual.io)
