# realvirtual WEB

**The open standard for browser-based 3D-HMI and Digital Twins in manufacturing.**

realvirtual WEB brings industrial 3D visualization to the browser — load realvirtual GLB exports and run transport simulation, sensor collision, LogicStep sequencing, and drive animation with no installation required. WebGL, WebGPU, and WebXR (VR/AR) supported out of the box.

**One link. Any device. Live Digital Twin.** Share an interactive 3D model of your machine or production line with anyone — customers, operators, service technicians — across desktop, tablet, and VR/AR headsets.

**Built for manufacturing:**
- **3D HMI / operator dashboards** — Web-based HMI connected to real PLCs via WebSocket or MQTT. Live signal visualization, KPI overlays, drive monitoring — replacing desktop HMI applications.
- **Sales & presales** — Interactive 3D models that let prospects explore machines live in the browser. More convincing than slides, more accessible than installed software.
- **Maintenance & service** — Technicians open a link on their tablet, interact with 3D components, check sensor states and drive positions — on-site or remote.
- **Training & onboarding** — Operators learn machine behavior interactively before touching the real system.
- **Remote acceptance** — Share virtual commissioning models with customers for review and sign-off — worldwide, instantly.

> For building custom plugins and extending the viewer, see **[doc-extending-webviewer.md](doc-extending-webviewer.md)**.
> For how scenes, drafts, and edits are stored and resumed across reloads, see **[doc-persistence.md](doc-persistence.md)**.
> For attaching custom JavaScript/TypeScript behavior directly to a node inside the GLB (sandboxed, hot-reloaded, no separate build), see **[doc-scripting.md](doc-scripting.md)**.
> For how component and signal references are written as node paths and resolved by the `NodeRegistry` — the three naming layers, alias mechanics, resolution order — see **[doc-node-paths.md](doc-node-paths.md)**. Read it before changing anything that stores or resolves a path.

## Live signal binding

Signal linking is INLINE in the Property Inspector: every schema signal slot of
a selected component (`componentRef + signal` fields) always appears as a
two-column row in its component section — LEFT the slot name, RIGHT the
assigned signal (an internal model signal or a CONNECT signal) or "not linked".
Empty slots are shown too (e.g. `Drive_Simple` always shows Forward AND
Backward). Each row is a drop target for dragged signal chips and opens a
combined picker with two groups: **CONNECT (live)** signals and **Model
signals** (internal SignalStore entries; a slot never offers its own target
signal). A slot assigned to an internal signal shows that signal's external
CONNECT mapping as a chain indicator on the chip. Auto-assign and Unbind-all
are component-section actions with a two-click confirm.

Each persisted mapping is a Slot → Signal assignment keyed by component path,
slot kind, and slot name. `sourceKind: 'connect' | 'internal'` determines
whether `signal` resolves through a CONNECT provider or the model's
SignalStore; mappings without `sourceKind` are legacy CONNECT mappings.
Internal assignments relay through the binding manager and do not rewrite the
authored `componentRef` or mutate the GLB.

Enable **Signal link mode** from the icon bar to keep bindable component badges
visible, or Shift-drag a discovered CONNECT signal for a temporary linking
gesture. Shift-drag activates only after the pointer crosses the drag threshold
and never changes the persisted icon-bar setting. While a signal-link mode is
active (`isSignalLinkModeActive()` — the icon-bar toggle or a running signal
drag), clicking or tapping a badge without holding Shift opens the binding
popover — the in-scene quick path, rendering the SAME two-column slot rows as
the inspector. Outside an active link mode a scene click never surfaces the
popover. The popover separates **Control ·
PLC → Viewer** from **Feedback · Viewer → PLC** and validates type and
direction.

Bindings are available for Planner placements and regular GLB component nodes.
An explicitly wired component keeps its existing **Mapped** SignalStore path.
A drive whose standard control signals were created automatically by the WEB
loader instead exposes rows that call the component's normal command methods
directly (no model signal; the row tooltip explains why forcing is
unavailable). This decision is made per component instance from loader
provenance, not from signal metadata. Direct v1 support is limited to
`Drive_Simple` (including Speed, Accelaration, and ScaleSpeed),
`Drive_Cylinder`, and `Drive_DestinationMotor`; `Drive_Speed` and
`Drive_FollowPosition` remain mapped only.

Green badges mean live, Instrument Blue means pending while CONNECT discovery or
ownership is not ready, amber means a previously known provider is disconnected,
red means a provider/type/fan-in conflict, and grey means unbound. Direct rows
always require a registered CONNECT provider; a same-named standalone signal
does not make them live. Live controls suppress only the affected component
instance. Feedback stays owned by the model and writes back through the
connected interface. See [doc-signal-architecture.md](doc-signal-architecture.md)
for the provider, priority, and liveness contracts.

During a Shift-drag, every compatible 3D target is shown proactively with a
constant-screen-size connector marker. The 50 targets nearest the camera also
receive a subtle Instrument Blue box outline. The compatible port nearest the
pointer is emphasized by swapping its marker for a larger white *active* sprite
— picked by a screen-space magnet radius (`NEAREST_MAGNET_RADIUS_PX = 42` in
`drop-target-overlay.ts`) around the cursor, with a full NDC frustum test so
off-screen ports never win. **No connector line is drawn** between the drag chip
and the port. Compatibility uses the same slot type, direction, eligibility, and
binding resolution as the popover; targets that cannot accept the signal stay
unmarked. The existing scene-hover behavior continues to auto-open the binding
popover so the signal can still be dropped directly onto a slot row. All
markers disappear immediately after a drop, cancellation, model clear, or
switch away from the Three.js rendering backend.

## Quick Start

```bash
cd Assets/realvirtual-WebViewer~
npm install
npm run dev          # Vite dev server with HMR
```

Drop `.glb` files into `public/models/` — they appear automatically in the model selector.

```bash
npm run build        # Production build → dist/
npm run preview      # Preview production build
npm test             # Run browser tests (headless Chromium via Playwright)
npm run test:node    # Run Node.js tests (fs, glob, ESLint — see below)
npm run test:all     # Run both: Node tests + browser tests
npm run test:watch   # Watch mode
npm run lint         # ESLint (flat-config, boundaries/dependencies rule)
```

**Test naming convention:** Files matching `tests/*.node.test.ts` run in Node
environment (use `vitest.node.config.ts`). Files matching `tests/*.test.ts` run in the
browser environment. Use the Node config for tests that require `fs`, glob imports,
or the ESLint instance itself.

## Workspace Modes

realvirtual WEB is organized into **workspace modes** — switch them from the mode
dropdown in the top-left toolbar. Exactly one mode is active at a time; switching a
mode swaps both the active plugin set and the UI (each plugin declares its mode
membership via `plugin.modes`). The same model stays loaded across a switch.

| Mode | Purpose | What it adds |
|---|---|---|
| **Viewer** | Just look at the machine. The model, the running kinematics, and nothing else to operate — for shared links, embedded showcases and "show the machine" deliveries, where an engineering IDE would only confuse. | Nothing. It *removes*: no authoring, no signals, no panels, no Play/Pause. What remains is Settings, the camera / view controls and the grouping overlay. Kinematics run exactly as in HMI (`runtime: 'simulation'`). |
| **HMI** (default) | Operate and monitor a running model — the delivery / 3D-HMI view. | Live PLC signals (WebSocket / MQTT / REST), KPI overlays, message panel, drive & sensor tooltips, camera presets, measurement. |
| **DES** | Discrete-event material-flow simulation for throughput and utilization analysis — fast, event-driven rather than per-frame. | DES workspace surface, material-flow statistics, and the **Experiments window**: ONE tree — Project → Experiment → Run → Checkpoint — over full-state snapshots stored chunked in IndexedDB with NDJSON.gz export/import (see [doc-persistence.md](doc-persistence.md) §7.5). Snapshots capture the complete sim state — event queue, components, MUs, RNG streams and script-component state — so any stored point loads back with correct statistics and continues deterministically (script authors persist closure state via the `onSnapshot`/`onRestore` hooks, see [doc-scripting.md](doc-scripting.md)). **Simulation runs** are tracked automatically: every run gets a run id + master seed (fixed or auto-rolled per reset) and is archived with its statistics on reset / sim end under its experiment; **projects** are the comparison boundary. The Experiments window (opened from the DES clock settings or the DES side-tool button) shows all experiments of the active project at once — per-run status/seed/sim-time, expandable checkpoints with load-and-continue, snapshot/export/import/rename/delete on the experiment rows — and run checkboxes across the whole tree feed the project-internal multi-run compare view with mean ± 95% CI (see [doc-persistence.md](doc-persistence.md) §7.5.1). |
| **Planner** | Assemble and edit layouts by dragging reusable library objects (conveyors, robots, fixtures) onto a grid, snapping and positioning them with gizmos. Authoring, not operation. | Library panel, grid + snap toolbar, translate / rotate gizmos, snap-point connections. See [doc-layout-planner.md](doc-layout-planner.md). |
| **Editor** | Author a single asset: import CAD, restructure the hierarchy, split and merge meshes, assign materials, add components. The only mode registered with `runtime: 'detached'` — the `SimulationRuntime` performs **no** time integration here, because this is asset authoring, not simulation. | Asset-editor op log with undo, Materials window, Mesh Separator / Mesh Merge, unified CAD import, `preserveHierarchy` loading (no uber bake, every node keeps its own material). |

**The five modes in one line:** Viewer *only shows* a model, HMI *runs and shows* it,
DES *analyses material flow through* it, Planner *builds and arranges* it, Editor
*authors the asset itself*.

Switch modes via the dropdown or the `?mode=viewer|hmi|des|planner|editor` URL parameter, so a
shared link can boot directly into a workspace (e.g. `?scene=published:MyLayout&mode=planner`).
A locked-down deployment can pin a single mode (the dropdown then hides).

Inside an **iframe** the mode switcher additionally disappears: embedding a viewer in a foreign
page should not offer a way out into the full app. This is driven by the `embedded` UI context
(set at boot from `window.self !== window.top`), so a deployment can re-enable the switcher
through `ui.visibilityOverrides` for the `mode-switcher` element.

### Pending placements (Planner)

Dragging a library asset must not wait for its GLB — a large CAD asset can take
ten seconds to fetch and decode. A **pending placement** is a fully committed
placement whose root node temporarily carries *placeholder* geometry. It is not a
draft and not a special store state: `PlacedComponent` carries its `glbUrl` from
the first frame, so in the layout store a pending placement is indistinguishable
from a finished one, and it can be moved, snapped, selected, deleted and undone
while its geometry is still decoding.

The drag sequence (all files in `src/plugins/layout-planner/`):

| Step | What happens |
|---|---|
| **Hover** a library card | After an 80 ms intent delay (`PREFETCH_INTENT_MS`, `LayoutLibraryPanel.tsx`) the card calls `ModelCache.prefetch(url)`. `pointerdown` fires it immediately — touch has no hover. Virtual/DES and splat entries are skipped: they never take this path. |
| **`dragstart`** | `_startGlbDraft` builds a catalog-sized wireframe box with an optional thumbnail billboard (`placeholder-node.ts`, well under a millisecond) and registers it as a real placement in **`light`** mode. `_moveDraft` therefore works from the very first pointer frame. |
| **`drop`** | `_commitDraft` records the store entry and the `addPlacement` undo op immediately. The gesture never blocks, and the user can start the next drag. |
| **decode lands** | `swapPlacedGeometry` (`scene-mutations.ts`) replaces the placeholder's **children** under the same root and re-registers the placement in **`full`** mode. |

Entry-kind routing happens first (`_startDraft`): only GLB assets get a
placeholder. Virtual/DES entries are detected by the `virtual` **flag** (their
`glbUrl` is the empty string, not `undefined`) and keep the existing synchronous
ghost path; splats are still placed via `placeComponent`.

**`light` vs `full` registration.** Both modes clear the preview flags, run
`resolveUniqueName`, fill `objectMap`/`idByObject`, register the root in the
`NodeRegistry`, add raycast aux targets and dirty the shadow map — so a
placeholder is addressable by path and hittable like any placement.
`full` additionally runs the naming-convention scan, `processExtras`
(signals / drives / components), behavior dispatch, LogicStep merge, snap-port
registration, the grouped-BVH rebuild and the `layout-content-added` event. A
placeholder has no `userData.realvirtual` to process, and running `processExtras`
twice would duplicate or orphan its registrations. `mode` defaults to `'full'`
everywhere — exactly one call site passes `'light'`.

While a placement is pending, **snap-point mating is skipped** (the box has no
real ports); grid snap, magnetic bbox snap and drop-to-surface work purely on the
AABB and stay active. Real ports become available for the *next* drag once the
swap has landed — a dropped object never re-snaps itself.

**Two cache layers, two kinds of de-duplication** (`model-cache.ts`,
`core/engine/rv-asset-blob-cache.ts`): the blob cache de-duplicates in-flight
*fetches* URL-wide and persists bytes in the Cache API bucket `rv-planner-glbs`;
`ModelCache._inflight` de-duplicates in-flight *decodes*, which is what makes the
hover prefetch pay off — the drag's own `getOrLoad` joins the prefetch's promise
instead of decoding the same GLB a second time. Every caller still receives its
own `.clone()`; only the decode is shared. `getOrLoad(url, { signal })` detaches
*this* consumer on abort and deliberately lets the shared work finish, so
deleting one placement cannot tear down an unrelated second placement of the
same asset.

**Feedback and failure.** A pending placeholder pulses at 1.5 Hz through the
shared `GizmoOverlayManager` (`pending-pulse.ts`; `prefers-reduced-motion: reduce`
switches the pulse **off** rather than damping it), and a status tile in the
`'messages'` slot names each loading asset (`PendingLoadMessage.tsx`, no progress
bar — `LoadingManager.onProgress` is unreliable for GLTF). A failed load leaves
the placement in place and marks it red **and** dashed **and** badged, with
**Wiederholen** / **Entfernen** on the status tile. Retry bumps the load's
generation without creating a new undo entry — the placement itself was never
rolled back.

See [doc-lifecycle.md](doc-lifecycle.md) §3.4 for the swap order and the
cancellation paths, and [doc-layout-planner.md](doc-layout-planner.md) for
pivot, snap and library semantics.

### Public material-flow kernel contracts

The public material-flow API describes event-safe state without importing the
private DES engine. `MaterialFlowSelf` exposes the MUs currently held by a
component through `self.mus`, together with `currentLoad`, `reservedLoad`,
`downstreamFreeCapacity()`, `reserveDownstream()`, and `reservation()`. A
`ReservationRecord` is JSON data for one active capacity promise; it identifies
holder, target, optional port, quantity, and optional carrier slots by stable
`MuRef`. The runtime `ReservationHandle` commits a batch atomically or rolls the
record back.

`FrozenDescriptor` is the JSON-only representation of scheduled work paused by
a component failure. It stores the named action, optional MU reference, payload,
remaining time, and position/path tween data. No live event or tween handle is
part of this contract, so the private runner can resolve actions and paths again
after snapshot restore.

`self.pathTween()` creates a data-only path tween for a duration event. Persisted
events use a stable `pathRef` plus arc-length addresses in metres; FastForward
does not write transforms and settles the MU at the exact path position when a
visual is available again. The same `self` surface also provides convention-based
node access (`find()`/`findAll()` for single or multiple transport axes), typed
signals, ports, scheduling, statistics, MU transfer/spawn, and the snapshot-safe
`self.prop` state bag.

`self.axesTween(anchorRef, phases, ease)` creates a JSON-safe multi-axis spec.
Each phase uses normalized `at0`/`at1` event-window fractions and stable drive
paths, so one duration event can stage several robot poses. The public
`TweenRegistry.addDrive()` options expose `ease: 'linear' | 'scurve'` and
`writePolicy: 'always' | 'finalOnly'`. `finalOnly` suppresses intermediate axis
writes while FastForward is active; reasoned `settle()` calls distinguish normal
event-time settling from the final FastForward-exit pose.

## Architecture

```
src/
├── main.ts                              # Entry: viewer creation, plugin registration, HMI init
├── rv-test-runner.ts                    # Dev-only in-browser test runner
├── core/
│   ├── rv-viewer.ts                     # RVViewer facade (scene, sim loop, plugins, events)
│   ├── rv-camera-manager.ts             # Camera (projection, animation, viewport offset)
│   ├── rv-visual-settings-manager.ts    # Lighting, shadows, tone mapping
│   ├── rv-app-config.ts                 # App config singleton (settings.json, lock mode)
│   ├── rv-plugin.ts                     # RVViewerPlugin interface (lifecycle + optional UI slots)
│   ├── rv-behavior.ts                   # RVBehavior abstract base class (MonoBehaviour-like)
│   ├── rv-events.ts                     # Typed EventEmitter<TEvents>
│   ├── rv-model-plugin-manager.ts       # Per-model dynamic plugin loading/unloading
│   ├── rv-ui-plugin.ts                  # UISlot types, UISlotEntry
│   ├── rv-ui-registry.ts                # UIPluginRegistry (slot component lookup)
│   ├── maintenance-parser.ts            # MaintenancePanel content parser
│   ├── types/plugin-types.ts            # Shared plugin API types (decouples core↔plugins)
│   ├── engine/                          # Simulation engine subsystems
│   │   ├── rv-scene-loader.ts           # GLB loading, two-phase component construction
│   │   ├── rv-node-registry.ts          # Object discovery (path, type, hierarchy)
│   │   ├── rv-component-registry.ts     # Schema-based auto-mapping (C# → TS) + capability registry
│   │   ├── rv-model-config.ts           # Per-model plugin config (modelname.json + GLB extras)
│   │   ├── rv-plugin-loader.ts          # Dynamic ESM plugin loading
│   │   ├── rv-simulation-loop.ts        # Fixed 60 Hz accumulator (XR-compatible)
│   │   ├── rv-debug.ts                  # Structured category-based debug logging + ring buffer
│   │   ├── rv-constants.ts              # Shared numeric constants (MM_TO_METERS, etc.)
│   │   ├── rv-coordinate-utils.ts       # Unity ↔ glTF coord conversions
│   │   ├── rv-active-only.ts            # Active-only sub-tree marker
│   │   │
│   │   │── # Components (ports of Unity C#) ───────────────────────────────
│   │   ├── rv-drive.ts                  # RVDrive (Drive.cs)
│   │   ├── rv-drive-simple.ts           # Drive_Simple
│   │   ├── rv-drive-cylinder.ts         # Drive_Cylinder
│   │   ├── rv-drives-playback.ts        # DrivesRecorder playback
│   │   ├── rv-drive-recorder.ts         # Drive data recording
│   │   ├── rv-replay-recording.ts       # ReplayRecording component
│   │   ├── rv-erratic.ts                # Drive_ErraticPosition
│   │   ├── rv-mu.ts                     # MovingUnit (incl. instanced MU pool)
│   │   ├── rv-source.ts                 # MU spawner
│   │   ├── rv-sink.ts                   # MU consumer
│   │   ├── rv-sensor.ts                 # AABB sensor
│   │   ├── rv-sensor-recorder.ts        # Sensor history sampler
│   │   ├── rv-transport-surface.ts      # Conveyor surface
│   │   ├── rv-transport-manager.ts      # Sources → surfaces → sensors → sinks
│   │   ├── rv-path.ts                   # RVPath substrate (line/arc segments, rv_extras.Path schema)
│   │   ├── rv-path-network.ts           # Path graph (successors, routing hooks, project router)
│   │   ├── rv-path-traveler.ts          # Arc-length movement scalar along the path graph
│   │   ├── rv-spacing-controller.ts     # 1D arc-length headway (car following, raycast-free)
│   │   ├── rv-zone-registry.ts          # Zone reservation (control-point model, claim/release)
│   │   ├── rv-grip.ts / rv-grip-target.ts  # Gripping
│   │   ├── rv-signal-store.ts           # PLC signal pub/sub
│   │   ├── rv-signal-wiring.ts          # Signal routing (ConnectSignal)
│   │   ├── rv-connect-signal.ts         # Signal connection component
│   │   ├── rv-logic-step.ts             # LogicStep base + step types
│   │   ├── rv-logic-engine.ts           # LogicStep tree builder
│   │   ├── rv-pipe-flow.ts              # Process pipe flow propagation
│   │   ├── rv-tank-fill.ts              # Tank fill visualization
│   │   ├── rv-safety-door.ts            # Safety door / hazard zone halo
│   │   │
│   │   │── # Rendering, raycast, optimization ────────────────────────────
│   │   ├── rv-raycast-manager.ts        # Unified hover/click/XR raycaster
│   │   ├── rv-raycast-geometry.ts       # BVH groups + face-range hit resolution
│   │   ├── rv-highlight-manager.ts      # Highlight overlays + edge glow
│   │   ├── rv-selection-manager.ts      # Selection state + events
│   │   ├── rv-gizmo-manager.ts          # Generic 3D gizmo overlays (sensors, etc.)
│   │   ├── rv-batched-render.ts         # Motion-blob BatchedMesh arenas (static + per-drive; uber + per-material)
│   │   ├── rv-batch-table.ts            # Arena registry + source-mesh → instance map
│   │   ├── rv-batch-visibility.ts       # Per-instance visibility reconcile (setVisibleAt)
│   │   ├── rv-uber-material.ts          # Uber-material (PBR atlas-shared)
│   │   ├── rv-material-dedup.ts         # Material deduplication
│   │   │
│   │   │── # Plumbing ────────────────────────────────────────────────────
│   │   ├── rv-aabb.ts                   # AABB primitive
│   │   ├── rv-ring-buffer.ts            # Generic RingBuffer
│   │   ├── rv-group-registry.ts         # Group definitions and visibility
│   │   ├── rv-xr-manager.ts             # WebXR session management
│   │   ├── rv-xr-hit-test.ts            # AR hit-test reticle
│   │   ├── rv-avatar-manager.ts         # Multiuser 3D avatar rendering
│   │   ├── rv-mcp-tools.ts              # @McpTool / @McpParam decorators
│   │   ├── rv-component-event-dispatcher.ts # Per-component onHover/onClick/onSelect routing
│   │   ├── rv-auto-filter-registry.ts   # Type-based auto filter registration
│   │   └── rv-extras-validator.ts       # Dev-mode GLB extras parity checker
│   └── hmi/                             # React HMI layout components (MUI-based)
│       ├── rv-app-config.ts             # DEPRECATED re-export barrel → import from core/rv-app-config.ts
│       ├── ui-context-store.ts          # Context-aware UI visibility (activateContext, useUIVisible)
│       ├── context-menu-store.ts        # Plugin-extensible right-click context menus
│       ├── visual-settings-store.ts     # Visual settings (shadows, light, cameras)
│       ├── search-settings-store.ts     # Search/filter settings
│       ├── rv-storage-keys.ts           # Central localStorage key registry
│       ├── App.tsx                      # Root layout (minimal public shell)
│       ├── HMIShell.tsx                 # SlotRenderer for plugin UI
│       ├── KpiBar.tsx                   # Top KPI card container (slot: kpi-bar)
│       ├── ButtonPanel.tsx              # Left sidebar with nav buttons (slot: button-group)
│       ├── MessagePanel.tsx             # Right message panel (slot: messages)
│       ├── settings/                    # Settings panel tabs (extracted from TopBar)
│       │   ├── ModelTab.tsx             # Model/renderer selection
│       │   ├── VisualTab.tsx            # Lighting, shadows, tone mapping
│       │   ├── InterfacesTab.tsx        # WebSocket/MQTT/ctrlX config
│       │   ├── DevToolsTab.tsx          # FPS, benchmarks, debug
│       │   └── TestsTab.tsx             # Feature test runner
│       ├── TopBar.tsx, BottomBar.tsx     # Top/bottom bars
│       ├── KpiCard.tsx, TileCard.tsx     # Reusable card components
│       ├── LeftPanel.tsx                # Standardized docked left panel
│       ├── MachineControlPanel.tsx      # Machine start/stop/mode control
│       ├── MaintenancePanel.tsx         # Maintenance step guides
│       ├── GroupsOverlay.tsx            # Group visibility toggles
│       ├── left-panel-manager.ts        # LeftPanel mutual exclusion coordinator
│       ├── layout-constants.ts          # Shared positioning constants
│       ├── shared-sx.ts                 # Reusable MUI sx style fragments
│       ├── chart-theme.ts              # Shared ECharts theme constants
│       ├── chart-constants.ts           # Chart color/size constants
│       ├── group-visibility-store.ts    # Group visibility state
│       └── tooltip/                       # Generic tooltip system
│           ├── tooltip-store.ts           # TooltipStore (useSyncExternalStore, priority resolution)
│           ├── tooltip-registry.ts        # TooltipContentRegistry (content-type → React, data resolvers, search resolvers)
│           ├── tooltip-utils.ts           # 3D→screen projection, viewport clamping
│           ├── TooltipLayer.tsx           # Tooltip renderer (glassmorphism, cursor/world/fixed)
│           ├── GenericTooltipController.tsx # Single headless controller — reads rv_extras + _rvPdfLinks, calls resolvers
│           ├── DriveTooltipContent.tsx    # Drive content provider + data resolver
│           ├── MetadataTooltipContent.tsx # RuntimeMetadata content provider
│           ├── PipeTooltipContent.tsx     # Pipe/flow content provider
│           ├── PumpTooltipContent.tsx     # Pump content provider
│           ├── TankTooltipContent.tsx     # Tank content provider
│           ├── ProcessingUnitTooltipContent.tsx
│           ├── PdfTooltipSection.tsx      # Generic PDF links section (auto-stacked)
│           └── index.ts                   # Barrel export
├── private-stubs/                       # No-op fallbacks when private folder absent
│   ├── private-plugins.ts              # export function registerPrivatePlugins() {} // no-op
│   └── custom/
│       └── hmi-entry.tsx               # HMI entry (React root) — mounts core/hmi/App.tsx.
│                                       #   Imported as `@rv-private/custom/hmi-entry`;
│                                       #   the private build overrides it.
├── interfaces/                          # Industrial interface plugins
│   ├── interface-manager.ts             # Interface coordinator (mutex, auto-connect) — core: true
│   ├── interface-settings-store.ts      # Interface settings (WS, MQTT, ctrlX)
│   ├── base-industrial-interface.ts     # Abstract interface base class
│   ├── signal-transport-core.ts         # Shared transport/framing core
│   ├── signal-transport.worker.ts       # Off-main-thread signal transport worker
│   ├── reconnect-policy.ts              # Shared backoff/reconnect policy
│   ├── websocket-realtime-interface.ts  # WebSocket Realtime protocol
│   ├── mqtt-interface.ts                # MQTT protocol
│   ├── twincat-hmi-interface.ts         # Beckhoff TwinCAT HMI protocol
│   └── ctrlx-interface.ts              # Bosch Rexroth ctrlX protocol
├── plugins/                             # Plugin implementations
│   │  # Core (`core: true` — always loaded, survive model switches) ───
│   ├── sensor-monitor-plugin.ts         # Event-based sensor monitoring
│   ├── transport-stats-plugin.ts        # 10 Hz RingBuffer transport stats
│   ├── camera-events-plugin.ts          # Camera animation done events
│   ├── drive-order-plugin.ts            # Topological CAM/Gear drive sort
│   ├── camera-startpos-plugin.tsx       # Per-model camera start position
│   ├── connection-system-plugin.ts      # Typed connections (edges, StopOnExit)
│   ├── adaptive-nav-plugin.ts           # Distance-adaptive navigation
│   ├── kiosk-plugin.tsx                 # Kiosk / idle-tour mode
│   ├── signal-bind/                     # Signal-link mode, popover, drop targets
│   │  # Dev-only (NOT core) ────────────────────────────────────────────
│   ├── debug-endpoint-plugin.ts         # /__api/debug HTTP endpoint (dev)
│   ├── mcp-bridge-plugin.ts             # Claude MCP WebSocket bridge (dev)
│   │  # Optional / model-specific ─────────────────────────────────────
│   ├── layout-planner/                  # Planner mode: library panel, gizmos, placements
│   │   └── LayoutLibraryPanel.tsx       # Layout planner library panel (multi-tab)
│   ├── multiuser-plugin.ts              # Multi-user presence + avatars + relay
│   ├── webxr-plugin.ts                  # WebXR VR/AR support
│   ├── fpv-plugin.tsx                   # First-person WASD navigation
│   ├── annotation-plugin.ts             # 3D markers, labels, drawing
│   ├── rv-annotation-renderer.ts        # Annotation render helpers
│   ├── aas-link-plugin.tsx              # AAS / AASX linking + tooltip
│   ├── aas-link-parser.ts               # AASX ZIP/index parser
│   ├── docs-browser-plugin.tsx          # PDF / docs browser panel
│   ├── blueprint-plugin.ts              # Blueprint / 2D plan view
│   ├── drive-recorder-plugin.ts         # Drive recording (runtime)
│   ├── sensor-recorder-plugin.ts        # Sensor history recording
│   ├── order-manager-plugin.tsx         # Production order manager
│   │  # Demo model plugins (loaded per-model) ─────────────────────────
│   ├── demo/
│   │   ├── index.ts                     # Barrel exports
│   │   ├── kpi-demo-plugin.ts           # OEE/Parts/CycleTime demo data
│   │   ├── demo-hmi-plugin.tsx          # Demo KPI cards, buttons, messages
│   │   ├── robot-alarm/                 # FANUC CRX "Ask AI" alarm assistant
│   │   ├── machine-control-plugin.ts    # Machine start/stop panel
│   │   ├── maintenance-plugin.ts        # Maintenance checklists
│   │   ├── test-axes-plugin.tsx         # Manual axis control slider
│   │   ├── perf-test-plugin.ts          # Performance benchmark (?perf)
│   │   ├── DriveChartOverlay.tsx, SensorChartOverlay.tsx  # draggable chart overlays
│   │   └── OeeChart.tsx, PartsChart.tsx, CycleTimeChart.tsx, EnergyChart.tsx
│   └── models/                          # Per-model plugin entry points
│       └── DemoRealvirtualWeb/index.ts  # Registers demo model plugins
├── hooks/                               # React hooks (see hook table in extending guide)
└── ...
```

**Tests** live in [tests/](tests/) (Vitest browser-mode) and [e2e/](e2e/) (Playwright). For the current inventory run `ls tests/*.test.*`; for a particular suite, run `npx vitest run -t '<name>'`.

> **Note:** The `~` suffix in `realvirtual-WebViewer~` prevents Unity from importing `node_modules/`.

## Data Flow

```
Unity GLB Export (UnityGLTF + GLBComponentSerializer)
  → GLB with node.extras.realvirtual.{Drive, TransportSurface, Sensor, Source, Sink, ...}
  → Three.js GLTFLoader → node.userData.realvirtual.*
  → rv-scene-loader.ts: Two-phase construction (register nodes, then build typed instances)
  → LoadResult { drives[], transportManager, signalStore, registry, logicEngine, playback }
  → viewer.use(plugin) — Register plugins
  → SimulationLoop (60Hz fixedUpdate):
      1. LogicEngine         — LogicStep sequencing
      2. Playback            — Recording playback
      3. Plugins Pre         — Set drive targets (ErraticDriver, ReplayRecording, etc.)
      4. Drive physics       — Sorted: master before slave (DriveOrderPlugin)
      5. Transport           — Sources → Surfaces → Sensors → Sinks
      6. Plugins Post        — Sample data (SensorMonitor, TransportStats, DriveRecorder)
      7. Plugins Render      — Camera events, visual overlays
```

## Plugin System

All extensions use the `RVViewerPlugin` interface. `viewer.use(plugin)` calls `plugin.init?(viewer, context)`, giving each plugin a `PluginContext` — a narrower facade over scene, camera, controls, simLoop, and the signal/node/transport live-getters.

For convenience, extend `BaseViewerPlugin` (context-aware) or `RVBehavior` (MonoBehaviour-like, also context-aware) instead of implementing `RVViewerPlugin` directly:

```typescript
// Raw interface (for minimal plugins)
interface RVViewerPlugin {
  readonly id: string;
  readonly order?: number;              // Execution order (lower = earlier)
  readonly handlesTransport?: boolean;  // true = replaces kinematic transport
  readonly core?: boolean;              // true = always active, even in selective mode
  readonly slots?: UISlotEntry[];       // Optional React components for HMI layout

  onModelLoaded?(result, viewer): void;
  onFixedUpdatePre?(dt): void;          // Before drive physics (60Hz)
  onFixedUpdatePost?(dt): void;         // After drive physics + transport (60Hz)
  onRender?(frameDt): void;
  dispose?(): void;
}

// Base class (recommended for most plugins)
abstract class RVBehavior implements RVViewerPlugin {
  abstract readonly id: string;
  protected viewer: RVViewer | null;    // Auto-managed
  protected get drives(): RVDrive[];
  protected get sensors(): RVSensor[];
  protected get signals(): SignalStore | null;
  // Signal access by name (primary)
  protected getSignalBool(name: string): boolean;
  protected setSignal(name: string, value: boolean | number): void;
  protected onSignalChanged(name: string, cb): void;  // Auto-cleanup
  // Generic component discovery (like GetComponent<T>)
  protected find<T>(type, path): T | null;
  protected findAll<T>(type): { path, instance: T }[];
  // Lifecycle hooks
  protected onStart?(result): void;     // Like MonoBehaviour.Start()
  protected onDestroy?(): void;         // Like MonoBehaviour.OnDestroy()
  protected onPreFixedUpdate?(dt): void;  // Before drive physics
  protected onLateFixedUpdate?(dt): void; // After drive physics
  protected onFrame?(frameDt): void;    // Per render frame
}
```

### Registration

Plugins are registered via `viewer.use()` (eager) or `viewer.registerLazy()` (code-split):

```typescript
// Eager registration — plugin is always bundled
viewer
  .use(new DriveOrderPlugin())
  .use(new SensorMonitorPlugin());

// Lazy registration — Vite code-splits into a separate chunk
viewer.registerLazy('maintenance', () => import('./plugins/maintenance-plugin'));
viewer.registerLazy('multiuser', () => import('./plugins/multiuser-plugin'));
```

Lazy plugins are only loaded when a model requests them (via `rv_plugins` or `modelname.json`). This keeps the initial bundle small.

### Plugin Resolution

When a model requests a plugin by ID, the viewer resolves it through a three-level chain:

```
1. Already registered (via use())        → return existing
2. Lazy built-in (via registerLazy())    → import chunk, instantiate, use()
3. External plugin (models/plugins/{id}.js) → dynamic import(), use()
4. Not found                             → null (no crash)
```

External plugins are pre-built `.js` files placed in `models/plugins/`. They must export a default class or instance implementing `RVViewerPlugin`.

### Activation Modes

Plugin activation depends on whether the model declares an `rv_plugins` list:

| Mode | Condition | Behavior |
|------|-----------|----------|
| **ALL-MODE** | No `rv_plugins` declared anywhere | All registered plugins receive `onModelLoaded` |
| **SELECTIVE-MODE** | `rv_plugins` declared in modelname.json, GLB extras, or settings.json | Only declared plugins + `core: true` plugins activate |

In selective mode, core plugins (drive sorting, sensor monitoring) always activate regardless of the `rv_plugins` list. This ensures essential infrastructure is never accidentally disabled.

See **[Model-Specific Plugin Configuration](#model-specific-plugin-configuration)** for how to declare `rv_plugins`.

Plugins with `slots` automatically register React components into HMI layout positions: `kpi-bar`, `button-group`, `messages`, `views`, `search-bar`, `settings-tab`, `toolbar-button`, `overlay`. See **[doc-extending-webviewer.md § 5](doc-extending-webviewer.md)** for the full slot reference.

### Plugin Tiers

| Tier | Loaded when | Can be removed | Examples |
|------|------------|----------------|----------|
| **Core** (`core: true`) | Always — survive model switches | No (`removePlugin()` blocked); `disablePlugin()` works on any plugin | `drive-order`, `sensor-monitor`, `transport-stats`, `camera-events`, `camera-startpos`, `rv-extras-editor`, `signal-bind`, `connection-system`, `adaptive-nav`, `kiosk`, `interface-manager` |
| **Global Private** | Always when private folder present | Yes | `layout-planner`, `des-plugin`, `des-hmi` |
| **Model-Specific** | Only when matching GLB is loaded | Yes (auto-removed on model switch) | `kpi-demo`, `demo-hmi`, `webxr`, `multiuser`, `fpv`, `annotations`, `aas-link`, `docs-browser`, `blueprint`, `drive-recorder`, `sensor-recorder`, `order-manager`, `machine-control`, `maintenance` |

`debug-endpoint` and `mcp-bridge` are registered unconditionally in dev builds but are **not**
`core: true` — a project may remove them.

Model-specific plugins are defined in `plugins/index.ts` files per model folder. The `ModelPluginManager` auto-discovers them via `import.meta.glob` and loads/unloads them when models are switched. See **[doc-extending-webviewer.md](doc-extending-webviewer.md) § Per-Model Plugin System** for how to create model-specific plugins.

See **[doc-extending-webviewer.md](doc-extending-webviewer.md)** for detailed plugin development guide, UI slot system, event bus, hooks reference, and examples.

## Simulation Features

### Transport
Non-physics AABB-based transport. Sources spawn MUs, transport surfaces move them, sensors detect overlap, sinks consume.

#### MU accumulation (gap clamp)
MUs on conveyors do not penetrate each other: each moving MU clamps its per-tick advance to the free distance up to the next MU in its actual (signed) move direction — a jam builds up behind a stopped part and releases automatically when the leader moves on. This is a pure 1D projection along the transport direction over the existing spatial grid (no physics engine, no continuous collision detection), so it also works with forced signals, reversed belts, rotated conveyors and across surface seams. Pre-existing overlaps are ignored (only new penetration is prevented), gripped MUs never block, and Sources hold a spawn while the spawn spot is occupied. Radial (turntable) surfaces are excluded.

Configuration: per TransportSurface via **Accumulate** (boolean, default `true`) and **MinGap** (mm, default `0`) in the GLB/scene extras; deployment-wide off-switch via settings.json `simulation.accumulateDefault: false`. Diagnostics: `mu.blocked` per MU and `blockedMuCount` in the `web_transport_status` MCP tool.

#### Source markers (floor ring + label)
Every Source carries an always-visible **floor marker** — a thin semi-transparent ring on the ground plus a camera-oriented label sprite showing the source's node name. The marker is visible in **Play, Pause, AR and Layout-Planner modes** so spawn locations stay identifiable even before the first MU appears. Each source's ring/label color is derived deterministically from its name (golden-ratio hue hash), giving consistent visual separation across sessions.

Markers are children of the source node, so they follow Layout-Planner drags automatically. They are excluded from raycast hits via the central `RaycastManager.excludeFilters` (the same filter also catches the pause-ghost overlay), so clicking through the marker selects the underlying layout object instead.

Toggle globally via **Settings → Visual → Show source markers** (default ON) or programmatically via `viewer.setSourceMarkersVisible(false)` / the MCP tool `web_view_source_markers`. The choice persists to `localStorage['rv-source-markers-visible']`.

### Physics Zones (optional)

Opt-in rigid-body physics for free 3D material behavior — MUs falling off conveyor ends, sliding down chutes, tipping and stacking in bins. Kinematic transport (including the accumulation gap clamp above) stays the default and is unchanged; physics only takes over per MU at natural handover points.

- **Activation**: Settings → Simulation → **Physics (whole scene)** (default OFF, stored in `localStorage['rv.physics']`, takes effect on the next model load). Without explicit physics zones in the model, enabling the toggle treats the whole scene as one zone with default parameters (friction 0.8, restitution 0).
- **Full physics (Beta)**: a second switch, **Full physics — all conveyors** (`localStorage['rv.physics.full']`, only effective while the main switch is on). Every non-radial transport surface then runs as a physical belt and MUs become dynamic bodies the moment they enter a surface — accumulation pressure is computed by the physics engine instead of the gap clamp. Radial (turntable) surfaces stay kinematic (v1 exclusion).
- **`WebPhysicsZone` extras contract**: zones are box volumes authored as `WebPhysicsZone` rv_extras in the GLB (schema `schema/v1/rv-odt.json`, spec section 7a): `ZoneEnabled`, `WholeScene`, `Friction`, `Restitution`, `RemoveBelowY`, `ShowGizmo`, `StaticColliders` (node paths of additional fixed collision geometry), `BoxCollider` (center/size). Today zones come from test fixtures or programmatic authoring; Layout-Planner zone authoring writes the same contract (follow-up). Overlapping zones: the first registered zone wins, configs are never mixed.
- **Handover at the conveyor end**: a belt is never cut by a zone boundary — a surface is either fully kinematic or fully physics-managed. An MU that runs off a conveyor end inside a zone becomes a dynamic body with the belt's exit velocity (also at v=0); a settled, upright MU (25° tolerance) resting over a kinematic surface returns to the kinematic pipeline with its exact pose. Tipped-over MUs stay physics-owned and rest where they fell.
- **`PhysicsMode` on surfaces and sensors**: per-instance boolean extras flag. A `PhysicsMode` surface fully inside a zone becomes a friction-driven physical belt; a `PhysicsMode` sensor inside a zone detects via physics collider events or a physics raycast (`onChanged` fires exactly as in the kinematic path). Physics-managed sensors only see physics-owned MUs — leave `PhysicsMode` off for sensors that must see both.
- **Kill switches**: settings.json `simulation.physicsEnabled: false` disables physics deployment-wide (wins over the user toggle); `simulation.physicsSurfaceDefault: false` keeps every surface kinematic (wins over `PhysicsMode` and full physics).
- **Exclusions**: physics runs only in the continuous simulation kernel — switching to DES tears the physics world down; an active multiuser/live connection (Unity is the pose authority) disables physics entirely.
- **Diagnostics**: read-only line in Settings → Simulation ("N zones / M bodies / X ms step") and `physicsOwnedCount` / `physicsBodies` in the `web_transport_status` MCP tool.

The physics engine itself is a **private provider** (Rapier, Rust → WASM) behind the public `PhysicsProvider` registry — open-source builds without a registered provider are a strict no-op and load zero physics bytes. See [doc-extending-webviewer.md](doc-extending-webviewer.md) for the provider contract.

### Path Simulation (AGV / Overhead Conveyor)

Objects can ride **paths** (lines and arcs, arc-length parametrized) instead of flat transport surfaces. The substrate is `RVPath` (`rv-path.ts`), reconstructed from the WebViewer-native `rv_extras.Path` schema — segments (`line`/`arc`), `closed`, `successors` graph links, optional `zone`/`zoneCapacity` attributes. Paths register into the shared `RVPathNetwork`; the graph resolves successor/predecessor links by id.

Two library components ride this substrate (in `src/behaviors/`, built with `defineLibraryComponent` — see [doc-behavior-modelling.md](doc-behavior-modelling.md)):

- **`Agv`** — an autonomous path-following vehicle. One arc-length movement scalar (`PathTraveler`), speed/ramps from the shared drive ramp (drive parity, mm/s), pose from the path tangent. Traffic control is **raycast-free**, the way professional material-flow tools do it: 1D arc-length **headway** to the vehicle ahead (car-following ramp, `SafetyDistance`/`MinGap`/`LookAhead`/`HeadwayGain`) plus **zone reservation** (control-point model — a zoned path must be claimed before entry, `claim`/`release` in `rv-zone-registry.ts`). Signals: `Agv.Run`, `Agv.Moving`, `Agv.Position` (mm), `Agv.AtNode` (pulse), `Agv.Blocked`.
- **`OverheadConveyor`** — a circulating chain on a closed path: one chain phase scalar, N carriers at fixed pitch (`(s_chain + i·pitch) mod L`), gravity-oriented carrier pose.

**Routing is project logic, not built in.** Vehicles follow `successors[0]` by default; junction decisions, arrival tracking, and dispatch come from id-based hooks (`selectNextPath(candidateIds, ctx) → id`, `onArrive(pathId, travelerId)`, `requestDispatch(travelerId)`) that a project script (JS-in-GLB) fills via its `routing.*` handlers — see [doc-scripting.md](doc-scripting.md). Only plain JSON crosses the script boundary; the path graph is queryable by id via `self.paths`.

**DES coupling and its parity boundary.** In the event kernel a path leg is one arrival event (`transit = length / speed`) with a `path` tween for visible arc-true interpolation; an occupied zone reschedules the arrival check (a discrete poll). Determinism parity between the continuous and event kernels holds **for the conflict-free case only** (free track, no zone contention): arrival times, end poses, and FastForward end states match. **Under contention the two kernels intentionally diverge in their momentary trajectory** — continuous runs a smooth car-following ramp per tick, the event kernel a discrete reschedule-until-free — while arrival order, end state, and throughput converge. There is no shared discretized conflict model; only conflict-free trajectories are comparable moment by moment.

### LogicStep Engine
Port of Unity's LogicStep sequencing — roughly 25 step types are built in `rv-logic-engine.ts`:
containers (SerialContainer, ParallelContainer), timing (Delay, Pause), signals (SetSignalBool,
WaitForSignalBool, SetSignalFloat, WaitForSignalFloat, JumpOnSignal), sensors (WaitForSensor),
drives (DriveToPosition / DriveTo, StartDriveTo, SetDriveSpeed, StartDriveSpeed,
WaitForDrivesAtTarget), gripping (GripPick, GripPlace), robots (IKPath), scene control
(Enable, SetActiveOnly, CinemachineCamera) and statistics (StatStartCycle, StatEndCycle,
StatState, StatOutput).

### Signal Store
Central pub/sub for PLC signals (bool/int/float) with two lookup tables:
- **By name** (primary) — Signal.Name if set, otherwise node name (GameObject name). Used by plugins and HMI.
- **By path** (secondary) — Full hierarchy path. Used by GLB object references (ComponentRef) and internal bindings.

Change-only notification. Batch semantics for `setMany()`.

### Virtual PLC (Structured Text)
Internal dev builds include a browser-side IEC 61131-3 soft PLC: write Structured Text in a Monaco editor (opened from the Planner), compile it in the browser, and run it as a 60 Hz scan cycle in a QuickJS sandbox against the SignalStore — sensors in, drives out, no Unity and no PLC hardware required. See **[doc-plc-programming.md](doc-plc-programming.md)**.

### Drive Physics
Ported from Drive.cs — acceleration/deceleration, position limits, rotation and linear movement. CAM/Gear master-slave dependencies resolved via topological sort.

### WebSensor (3D-HMI status indicator)
Pure UI marker authored in Unity (`Packages/io.realvirtual.professional/Runtime/WebViewerHMI/WebSensor.cs`) and rendered exclusively by realvirtual WEB (`rv-web-sensor.ts`). Four visual states — **Low / High / Warning / Error** plus an **Unbound** fallback — driven by either:

- a **PLCOutputBool** (`SignalBool`) → `false=Low`, `true=High`, OR
- a **PLCOutputInt** (`SignalInt`) → mapped via flexible `IntStateMap` string (default `0=Low, 1=High, 2=Warning, 3=Error`)

ISA-101-aligned colors (grey / blue / amber / red), with amber blinking at 1 Hz and red at 2 Hz. The visualization is delegated to the generic `GizmoOverlayManager` and supports six shapes (box / transparent-shell / mesh-overlay / sphere / sprite / text). When `Label` is set, an additional camera-facing text gizmo renders the label above the node. See `Sensor isolation` below for the end-user control. For developer-side customization (corporate-design overrides, custom int-mapping defaults), see [doc-extending-webviewer.md § 19](./doc-extending-webviewer.md#19-websensor--initwebsensor-configuration-api).

### Lamp (signal-light material)

`Lamp` is the browser counterpart of Unity's `Lamp.cs`. It changes the
emissive color and intensity of the first eligible mesh on the component node
or below it; helper meshes whose names start with `_` are skipped. The runtime
clones every material slot so a lamp never changes another mesh that shared the
authored material. Lamp meshes stay outside material deduplication, uber
material conversion, and BatchedMesh arenas so signal changes remain visible
and the normal hover/selection path continues to work.

The component reads `SignalLampOn` and the Unity-compatible
`SingalLampFlashing` field (`SignalLampFlashing` is accepted as an alias).
Without a signal, `LampOn` remains the authored state. `OnColor` is read
directly from the object-valued GLB extras; `Intensity` controls HDR emission,
`Flashing` enables blinking, and `Period` is the full on-plus-off cycle in
seconds. The viewer-owned `LampManager` uses a symmetric 50% duty cycle,
including the first cycle. `Period <= 0` produces steady light.

This symmetric blink differs intentionally from the asymmetric coroutine in
Unity's current `Lamp.cs`. Blink phase is deterministic per local viewer but is
not synchronized to a shared multiuser epoch, so clients joining at different
times can be phase-shifted. Emission works on WebGL and WebGPU; visible bloom
still depends on the renderer's active post-processing path and luminance
threshold. The asset editor includes red, amber, green, blue, and white
**Lamp / Signal** presets, with stronger blue and white emission to compensate
for luminance-based bloom.

### EnergyChain (cable carrier)

`EnergyChain` turns a rigid CAD energy chain (drag chain, cable carrier) into
one that moves with its linear axis. Attaching the component to the CAD node is
the entire user action: drive axis, bend radius, link height, chain length and
the position of the bend are **measured** from the rest pose, and every numeric
field left at `0` keeps auto-calibrating. `Anchor` and `Follower` are node
references (Unity `Transform` fields, wire `componentType`
`UnityEngine.Transform`); they are shown read-only in the inspector and
corrected through `web_editor_set_field`, which the component resolves live —
no reload.

With `Follower` left empty the moving end is derived from the scene context
(`rv-energy-chain-assign.ts`): first from a **drive** whose travel direction is
parallel to the measured chain axis, otherwise from a **`Kinematic` node**. In
both cases the chain end that lies inside — or nearest to — that node's moved
subtree becomes the moving one. The automatic stages refuse to answer rather
than guess: a candidate that cannot tell the two ends apart (they sit only `2R`
apart, so the nearer one has to win by at least `R`), or one further away than
the chain is long, is skipped, and the chain degrades to its rest pose. An
explicit reference always overrides both stages; clearing it falls back to them
without rebuilding the rig, because assignment is path configuration, not
structure.

The motion is a closed formula, not a solver: straight strand → half-circle bend
→ straight strand, with the bend at `c = (L − πR + a + m) / 2`, i.e. travelling
at exactly **half** the follower speed while the chain length stays constant.
It is therefore deterministic, timestep-independent and allocation-free per
frame.

Rendering uses `SkinnedMesh`: **one skinned mesh per source mesh, all bound to a
single shared `Skeleton`**, because a CAD chain is regularly split across
several meshes with their own transforms (the reference part keeps both strands
in one mesh and the bend in another). The originals stay in the tree, hidden.
Bones are concentrated on the bend — the two strands are antiparallel, which is
the degenerate case for linear blend skinning — and the count is clamped up to
the minimum derived from a 15° per-joint limit (21), reported in the status line.

All geometry lives in the **chain-local bind frame**, so a chain under a moving
kinematic parent, a planner-relocated asset or a multiuser transform moves as a
whole without deforming. Chains are excluded from material dedup, uber-material
baking and BatchedMesh arenas; picking runs through an invisible envelope hull
registered as an auxiliary raycast target, since a `SkinnedMesh` never enters
the pick BVH. GLB export restores the original meshes and prunes the rig — the
rig is rebuilt deterministically on load. If calibration or the follower
assignment fails, the chain simply holds its CAD rest pose and says why in its
status line; it is never worse than an unrigged part.

### Collision detection (CollisionRole)

Give a node a **Collision Role** in the inspector and the viewer checks it against
every other body of a *different* role while the simulation runs. There is one
dropdown and nothing else — no group names, no exclusion matrix:

`None` · `Tool` · `Workpiece` · `Machine` · `Robot` · `Environment` (default `None`).

- **What a body is.** The role covers the node's whole subtree, down to the next
  descendant carrying a role of its own. A robot marked `Robot` with a gripper
  marked `Tool` is therefore *two* bodies — "the robot counts up to the gripper".
- **What is checked.** Different roles always, identical roles never, `None`
  never, and a body is never checked against a body nested inside it (a robot
  against its own gripper would report the design-inherent flange contact on
  tick one). The check is two-stage: the body's world AABB — re-unioned every
  tick from all its meshes, so it is correct while an arm extends — and then
  exact triangle against triangle.
- **What happens on a hit.** The involved nodes get the pulsing severity
  outline (the same OutlinePass status silhouette the error-message system
  uses) and one **collision card per pair** appears in the right-side messages
  panel — no modal. Card and outline **latch**: they stay after the geometry
  separates, so a brief brush is never missed. Clicking a card frames the
  camera on the collided objects and flashes them. Each card carries two
  buttons: **OK** acknowledges exactly this pair (while the geometry still
  intersects it is re-detected on the next tick), and **Ignore** suppresses
  that collision *type* (the role pair, e.g. Tool ↔ Workpiece) for the rest
  of the current run — the ignore is dropped on the next model load. **The
  simulation never stops** — this is a notice, not a safety halt.
- **Signals.** `CollisionActive` (bool) and `CollisionCount` (int) mirror the
  latched state for the PLC; a rising edge on `ResetCollisions` clears the
  reported state (still-intersecting, non-ignored pairs are re-detected on
  the next tick).
- **Spawned parts.** A Source has its own **Collision Role For MUs** field —
  every MU it spawns joins the check with that role and leaves it at the sink.
  Instanced MUs are checked at box precision only (they share one geometry, so
  there is no per-instance BVH).
- **Only visible geometry participates** (`visible` chain plus render layer), so
  hidden MU templates and batch source meshes cause no phantom hits.
- **Known limits.** Geometry that is deformed at runtime — skinned meshes,
  morph targets, energy chains — is excluded and reported once per model load in
  the console. Geometry that already overlaps when you press Play is reported
  immediately: there is deliberately no baseline, so set floors, frames and
  supports to `None`.

### Sensor isolation (toolbar button)
A single **Isolate Sensors** toolbar button (in the `button-group` slot, registered via `web-sensor-plugin.tsx`) toggles sensor isolation mode. When active, non-sensor meshes are dimmed (opacity `0.55`) and desaturated so only the sensors stand out, and sensor labels are shown for identification. Click the button again to restore the normal view.

The isolation state persists in `localStorage` under key `rv-group-visibility` (field `isolatedAutoFilter`).

### Generic Gizmo Overlay System
The `GizmoOverlayManager` (`viewer.gizmoManager`) is a reusable infrastructure for any component that needs to render a visual overlay over its node. WebSensor is the first consumer; future Drive direction arrows, Grip volumes, Station zones, etc. can all use the same API. Material sharing keyed by `(color, opacity, depthTest, blinkHz)` keeps memory low; one central `tick()` loop modulates all blinking gizmos in sync. Gizmos are tagged onto the on-top overlay layer by default so they never contaminate SSAO (bloom/glow gizmos stay in the composer via `keepInComposer`); see [doc-extending-webviewer.md § 17 — "Keeping 3D UI out of SSAO"](./doc-extending-webviewer.md#17-gizmo-overlay-system-viewergizmomanager).

### Drive Axis Gizmo
Selecting a node with a `Drive` component shows a passive orange overlay visualizing the drive's motion axis (`drive-axis-gizmo-plugin.ts`): linear drives get a **double arrow** along the axis (solid tip = positive direction, dimmed tip = negative), rotary drives get a **dashed centreline plus a rotation ring** with a tangential arrow indicating the positive direction and a dot marking the current angle. With **UseLimits**, linear drives show end-stop disks at the travel limits (the gizmo centre is the current position) and the rotary ring arc is clamped to the limit range; while a drive is running its gizmo subtly pulses. The axis is derived from `Direction` + `ReverseDirection` (via `RVDrive.getAxis()`) and composed into world space including parent and home rotations; `Virtual` drives show nothing. When the selected node itself has no Drive, a subtree search applies — a gizmo appears only if **exactly one** drive is found below it (selecting a robot root shows nothing; select the individual axis node instead). The overlay lives on the highlight overlay layer (no SSAO/toon artifacts), is not pickable, scales with the object size clamped by camera distance, and supports multi-select (one gizmo per drive). Toggle: **Settings ▸ Visual ▸ Display ▸ Drive axis gizmo** (persisted, default on).

### Component Event Dispatcher
Per-component event callbacks for `onHover` / `onClick` / `onSelect` are routed centrally via `viewer.componentEventDispatcher` — components implement optional methods on the `RVComponent` interface and the dispatcher resolves which component matches each viewer-level event (via `node.userData._rvComponentInstance` + parent-chain walk). Exception-isolated and listener-leak-safe. See [doc-extending-webviewer.md § 18](./doc-extending-webviewer.md#18-component-event-dispatcher-viewercomponenteventdispatcher).

### AI Alarm Assistant (demo)
The standard demo ships a FANUC CRX alarm tile (`src/plugins/demo/robot-alarm/`) for **SYST-320 — Contact Force Exceeds Limit**. The card offers a prominent **Ask AI** button and a **History** icon button (badge = note count). Ask AI shows a short "analyzing" spinner, then types out a structured answer: diagnosis, recommended steps, a **live excerpt pulled from the bundled FANUC PDF** with a page deep-link, a summary of what previous operators did, and a **Sources** block whose entries open the manual at the cited page. The History dialog lists the operator notes and lets a visitor add their own (stored in `localStorage`); a new note is considered in the next answer. The assistant answer is generated client-side via an `AlarmAssistantProvider` seam — no backend — while the PDF excerpt and page links are real.

### WebDiagnostics (AI error diagnosis, signal-driven)

The productive counterpart of the alarm-assistant demo. A `WebDiagnostics` rv_extras marker (`rv-web-diagnostics.ts`, rv-ODT §7a.32) binds a PLC error signal to the AI diagnosis:

- **SignalBool** — rising edge triggers a diagnosis for the node, falling edge clears it.
- **SignalInt** — any change to a non-zero error code triggers; `0` clears.
- **DocFilter / ErrorId / Label / AutoOpen** — backend metadata filter, stable comment-store key, display label, and automatic dialog opening.

The marker only emits a typed `diagnose-request` viewer event (leading-edge debounced, 1 s window; unchanged values never re-fire). The diagnosis itself runs in the `WebDiagnosticsPlugin` (private tier): it calls the CONNECT `/diagnose` endpoint (`RemoteDiagnoseProvider`, BFF pattern — no LLM key, vector index or PDF full text in the browser), shows a messages-slot card plus a result dialog (cause / remedy / PDF sources with page deep-links), and offers a shared comment history backed by `GET/POST {notesUrl}/comments`.

Everything is **config-gated via `settings.json`**: `diagnostics.diagnoseUrl` enables the diagnosis backend, `diagnostics.notesUrl` switches the operator notes from `localStorage` to the shared CONNECT comment store. Without these URLs (demo / public builds) the marker events are ignored and the offline demo above stays exactly as it is. Model switches and falling edges abort in-flight requests plugin-side (`onModelCleared`), so no stale answer ever reaches the UI.

### Raycast System

Unified raycast pipeline (`rv-raycast-manager.ts`) consolidates hover, scene click, and XR controller raycasting into a single Three.js `Raycaster`. Hover is throttled at 50 ms.

**BVH-grouped geometry** (`rv-raycast-geometry.ts`):
Instead of iterating all scene meshes per ray, the loader builds **merged BVH groups**:

- **One merged BVH for all static meshes** — never animates, baked once.
- **One merged BVH per kinematic Drive group** — re-used as the drive moves; only the group transform updates.
- **`InstancedMesh` targets for MU pools** — single instanced draw, single BVH.

Each ray is tested against this small set of grouped geometries. Hit-to-node resolution uses **face-range binary search** (O(log n)) — the loader records, for every face range in a group, which `realvirtual` ancestor owns it. No ancestor walk-up at runtime.

**Raycast readiness:** BVH trees are built asynchronously after `model-loaded` — one reused background worker builds the merged groups first, then the per-mesh geometries; a time-sliced inline fallback covers environments without `Worker`. Hover and click work immediately after load through the native three.js raycast fallback and switch to BVH acceleration per geometry as trees complete. The `'raycast-ready'` viewer event signals full completion.

**Hoverability is capability-driven**: `getCapabilities(type).hoverable` (from [rv-component-registry.ts](src/core/engine/rv-component-registry.ts)) decides whether a component type takes part in hover/click. There is no separate Three.js layer per type; the raycaster runs `layers.enableAll()`.

**Key features:**
- **Pointer hover**: Throttled at 50 ms, resolves the hit face to its registered `realvirtual` ancestor via face-range lookup.
- **XR controller ray**: `updateFromXRController(origin, direction)` for VR/AR controller raycasting.
- **AR tap selection**: 9-point sampling (`arTapRaycast()`) for touch tolerance on mobile AR.
- **Click detection**: `raycastForRVNode(e)` for scene click without altering hover state.
- **Exclude filters**: Skip highlight overlays, sensor viz meshes, and custom exclusions.
- **Visibility gate**: Runtime-hidden subtrees (WebVisibility signal, Groups panel) are not hoverable/clickable — the ray falls through to what's behind.
- **Highlight integration**: Instrument-Blue hover/selection highlight via `RVHighlightManager` (OutlinePass silhouette for rendered meshes, overlay fill + edges for batched content).
- **Metrics**: pick-path timings (raycast split, resolve, highlight apply, strategy) live in Settings → Dev Tools → "Picking & Highlight".

**Highlight Manager** (`rv-highlight-manager.ts`):
- Two independent channels: hover (light blue `0x4aa3ff`) and selection (deep blue `0x1e88ff`)
- Strategy per apply: OutlinePass silhouette → overlay fill + `EdgesGeometry` (batched/hidden content) → bounding-box fallback (dense subtrees)
- Cached `EdgesGeometry` (WeakMap) for GC-free repeated highlights
- Two modes: static snapshot (brief hover) and tracked (overlays follow moving meshes)

**Architecture + hard invariants** (batched arenas, pick geometry, layer/AO contracts, do-not-touch rules) are documented in the internal render/picking design note, which is not part of this repository. The canonical source is `src/core/engine/rv-batched-render.ts`, `rv-batch-table.ts`, `rv-batch-visibility.ts` and `rv-raycast-geometry.ts`.

**Events emitted:**
- `object-hover` — `{ node, nodeType, nodePath, pointer, hitPoint, mesh }`
- `object-unhover` — `{ node, nodeType }`
- `object-click` — `{ node, nodeType, nodePath, pointer }`

### Tooltip System

Generic, extensible tooltip system (`core/hmi/tooltip/`) with **a single headless controller**, a content-type registry, and per-component **data resolvers**. New tooltip types are added by registering a content provider + a data resolver — no per-type controllers.

**Architecture:**

```
GenericTooltipController (single, headless)
    ├─ reads node.userData.realvirtual (rv_extras keys)
    ├─ for each key → getCapabilities(key).tooltipType
    ├─ tooltipRegistry.getDataResolver(tooltipType) → data
    └─ tooltipStore.show({ id, data, mode, cursorPos, priority })
                ↓
         TooltipLayer (renderer)
                ↓
         tooltipRegistry.getProvider(contentType)  →  Content Provider (React)
```

The same controller also auto-attaches a **PDF links section** (`PdfTooltipSection`) at the bottom whenever `node.userData._rvPdfLinks` is non-empty.

**Three positioning modes:**
- **cursor** — Follows mouse pointer (ref-based updates, no React re-render on move)
- **world** — Projects a 3D `Object3D` to screen coordinates (for focused/selected objects)
- **fixed** — Uses a fixed screen position

**Key design decisions:**
- **One controller for all types**: `GenericTooltipController` replaced the previous per-type controllers (Drive/Pipeline/Metadata/AAS).
- **Capability-driven dispatch**: which `rv_extras` keys produce a tooltip is decided by `getCapabilities(type).tooltipType` in [rv-component-registry.ts](src/core/engine/rv-component-registry.ts). No controller code per type.
- **Data-only store**: Holds typed data objects, not ReactNodes (avoids re-render storms)
- **Shallow-compare guard**: `show()` only notifies React when data fields actually change
- **Cursor position is ref-based**: Updated via `getCursorPos()`, polled at 100 ms — not in React state
- **Priority resolution**: several bubbles can be visible at once (one per `targetPath`; entries sharing a `targetPath` merge into one bubble with stacked sections). Hover tooltips are the exception — at most one at a time, and the entry with the **highest** `priority` number wins (default `0`)
- **useSyncExternalStore**: React 18+ pattern for efficient subscription without cascading renders

**Built-ins**: Drive, RuntimeMetadata, Pipe, Pump, Tank, ProcessingUnit, Lamp, WebSensor, AASLink. Each ships a content provider + a data resolver.

**Adding a new tooltip type** (e.g., Sensor):

```typescript
// 1. Declare the capability — in rv-component-registry registration:
registerComponent({
  type: 'Sensor',
  // ... other fields ...
  capabilities: { hoverable: true, tooltipType: 'sensor' /* matches step 2 */ },
});

// 2. Register a content provider AND a data resolver — self-registers at module import
import { tooltipRegistry, type TooltipContentProps } from './core/hmi/tooltip/tooltip-registry';

function SensorTooltipContent({ data }: TooltipContentProps) {
  return <Typography>{data.sensorName}: {data.occupied ? 'Occupied' : 'Free'}</Typography>;
}

tooltipRegistry.register({ contentType: 'sensor', component: SensorTooltipContent });

tooltipRegistry.registerDataResolver('sensor', (node, viewer) => {
  // node has rv_extras.Sensor — derive what to display
  const path = viewer.registry.pathFor(node) ?? node.name;
  const sensor = viewer.sensors.find(s => s.path === path);
  if (!sensor) return null;
  return { type: 'sensor', sensorName: node.name, occupied: sensor.occupied };
});

// 3. Side-effect-import the content module so registration runs (in App.tsx)
import './core/hmi/tooltip/SensorTooltipContent';
```

That's it — the single `GenericTooltipController` will now show the sensor tooltip on hover and on selection (pinned). No controller code to write.

**React hook:**
```typescript
import { useTooltipState } from './hooks/use-tooltip';
const { visible } = useTooltipState();  // VisibleTooltip[] — all currently visible bubbles
```

### Hierarchy Panel

The Hierarchy Panel (left dockable panel, owned by `RvExtrasEditorPlugin`) renders a tree of every node carrying `userData.realvirtual` plus the live overlay-override state. Two view modes:

- **All** — virtualised tree with expand/collapse. Its expanded-independent structural tree is cached, while placed LayoutObject/CADLink children are injected lazily without rebuilding unaffected branches (see below).
- **Drives / Sensors / Signals / Logic** — flat, virtualised view filtered by component family. Logic mode preserves container indentation.

#### LayoutObject expand behavior

Placed catalog items (LayoutObjects from the Layout Planner) are expandable like normal GLB nodes. When the user opens the chevron on a LayoutObject:

- Inner nodes that carry their own `userData.realvirtual` (drives, sensors, signals, etc.) appear as normal child rows and route through the Property Inspector as standalone selections.
- Mesh-only descendants (no `userData.realvirtual`) appear as dimmed/italic rows. They are selectable for highlight + Transform-only inspection.
- Sub-paths are registered on demand into the `NodeRegistry`, so plugins that query by path (`viewer.registry.getNode('RC/Drive-Lin-X')`) see them as first-class nodes.

Selection sources differentiate intent:

- 3D-viewport picks resolve up to the LayoutObject root (so the whole placed object highlights and lifts together).
- Tree clicks keep the explicit sub-path, exposing nested drive properties to the inspector.

When the LayoutObject's `Locked` flag is set, edits on any sub-path are rejected (`updateOverlayField` returns `false` and logs a warning). The root row itself stays editable so the user can unlock it without first reverting nested changes. Deleting a LayoutObject purges every overlay entry whose path falls under that subtree, so re-placing a catalog item with the same root name starts from defaults.

### WebXR (VR/AR)
VR on Quest, Vision Pro, PCVR. AR with hit-test surface detection and model placement. Uses `setAnimationLoop` for XR frame callback.

### Simulation Control (Play / Pause / Reset)

The TopBar SimController plugin exposes two buttons next to the existing tools:

- **Play / Pause toggle** — toggles the `'user'` pause reason via `viewer.setSimulationPaused('user', …)`. Pausing freezes every `onFixedUpdate` consumer (drives, transport, sources, sinks, LogicSteps). `onRender` keeps running so the scene stays interactive (camera, selection, gizmos).
- **Reset** — calls `viewer.resetSimulation()`, which clears all MUs, resets LogicSteps to `Idle` **and snaps every drive back to its authored `StartPosition`** (`RVDrive.reset()`). Only **signals** are intentionally left alone — blanket-resetting them would fight Live mode, so each component re-establishes the signals it owns in its `onReset` / `onStart` handler. See [doc-lifecycle.md](doc-lifecycle.md) §6.2.

Keyboard shortcuts (enabled by default, suppressed inside text inputs):

| Key       | Action                          |
|-----------|---------------------------------|
| `Space`   | Toggle Play / Pause             |
| `Shift+R` | Reset MUs + LogicSteps + drives |

#### Pause is a multi-reason set

Pause is reference-counted by `string` reason. Multiple subsystems can hold it simultaneously, and the simulation only resumes after every holder releases its reason:

| Reason          | Holder                                       |
|-----------------|----------------------------------------------|
| `'user'`        | SimController Play/Pause button (+ shortcut) |
| `'layout-edit'` | Layout-Planner while the planner is active   |
| `'ar-placement'`| WebXR plugin while placing the model in AR   |

The Pause-Badge in the TopBar shows the active reasons live (`paused: user, layout-edit`) so it's easy to debug why the simulation is frozen.

#### Live mode

In Live mode, the WebSocket / MQTT / REST interface listeners **continue to write** into the `SignalStore` while the simulation is paused. Drives and components do not consume those values until the simulation resumes — the next `onFixedUpdate` tick picks up the **current** signal values, which means drives may visibly snap to a new target ("live snap") rather than gradually interpolating. This is intentional: it prevents the viewer from running on stale data after a long pause.

#### Dev-tools escape

If a plugin crashes mid-execution and leaks a pause reason, `viewer.clearPauseReasons(reason?)` is a manual override. Logs a `[SimControl]` warning. Use sparingly — the plugin's own `dispose()` should normally clean up its own reason.

#### MCP tools

When the MCP bridge is connected, the following tools are exposed:

| Tool                  | Purpose                                                    |
|-----------------------|------------------------------------------------------------|
| `web_sim_play_pause`  | Toggle or explicitly set the `'user'` reason                |
| `web_sim_reset`       | Clear MUs + LogicSteps + reset drives (`resetSimulation()`) |

## Context-Sensitive Help

One help button sits at the bottom of the ActivityBar (plus <kbd>F1</kbd>). It opens the
documentation page that matches the current application state in a **new browser tab**. There
is no in-app documentation viewer and no iframe.

### How the target is derived

The context is **derived at call time, never mirrored**. The signals that decide it are already
reactive and already owned by someone, so there is no second store to keep in sync and nothing
that can be left behind:

| Rank | Source | Read from |
|------|--------|-----------|
| 40 | Plugin contribution | `help-topic-registry.ts` |
| 30 | Most recently opened window | `viewer.leftPanelManager` → `snapshot.lastOpenedSide` |
| 20 | Active workspace mode | `viewer.modes.activeMode` |
| 0 | Fallback | documentation root |

`deriveHelpTopic(input)` is a pure function; `readHelpContextInput(viewer)` collects the triple
from the viewer. Both are in `src/core/hmi/help-context.ts`.

Because left and right panels can be open simultaneously, "the active panel" does not exist.
`LeftPanelManager` therefore carries `lastOpenedSide` in its snapshot — the side whose window
was opened last, re-derived on close and on restore, and deliberately **not persisted**
(session state, not a setting).

Nothing is ever a dead end: an unknown panel id or mode falls through to the next rank and
finally to the documentation root.

### Files

| File | Contents |
|------|----------|
| `src/core/hmi/help-topics.ts` | Topic tables (panel → slug, mode → slug), labels, and `KNOWN_DOC_SLUGS` — an offline sitemap snapshot the tests check every slug against |
| `src/core/hmi/help-context.ts` | `deriveHelpTopic`, `readHelpContextInput`, `openCurrentHelp`, `useHelpTopic`, `useHelpShortcut` |
| `src/core/hmi/help-url.ts` | `buildHelpUrl` (slash normalisation, anchor, scheme validation) and `openExternal` |
| `src/core/hmi/help-topic-registry.ts` | Plugin contributions — see `doc-extending-webviewer.md` |

`openCurrentHelp(viewer)` is the single entry point: the click handler and the <kbd>F1</kbd>
listener both call exactly it, so they cannot diverge and a configured base URL cannot apply to
only one of them. It is **strictly synchronous** all the way to `window.open(url, '_blank',
'noopener,noreferrer')` — an `await` in that path would let popup blockers swallow the tab.

> Not to be confused with `DOC_BASE_URL` in `tooltip/MetadataTooltipContent.tsx`. That constant
> resolves relative links out of Unity `RuntimeMetadata` (customer content on
> `doc.realvirtual.io`) and is a separate concern.

### Keyboard and visibility

<kbd>F1</kbd> is registered on the app shell, not on the button, so it keeps working in FPV
where the ActivityBar is hidden. It obeys the same `help` visibility rule as the button —
in a kiosk deployment both are gone, and the key does **not** call `preventDefault()` there, so
the browser's own F1 handling stays untouched. The same applies while the caret is in an input,
textarea or contenteditable.

Default rule: `{ hiddenIn: ['kiosk'] }`, overridable per deployment through
`ui.visibilityOverrides['help']` (see *Context Visibility Overrides*). The base URL is
configured separately via `docs.baseUrl` (see `doc-deploy.md`).

On mobile the entry appears in the "⋮" overflow menu instead of the bar. In the CONNECT embed
shell it is part of the activity-bar allowlist.

## Signal Chips & Interaction Model

`SignalBadge` (`src/core/hmi/rv-signal-badge.tsx`) is the single signal chip component used everywhere a signal appears — the hierarchy browser, the property inspector, the CONNECT panel, the signal-bind popover and the signal search overlay.

### Display variants

Three normalized variants control how much a chip shows:

| Variant    | Renders                                | Example                    |
|------------|----------------------------------------|----------------------------|
| `full`     | Name (dot notation) + type + value     | `Conveyor.Start OutBool ●` |
| `standard` | Name + value                           | `Conveyor.Start ●`         |
| `minimal`  | I/O direction letter + value           | `O ●`                      |

The global default lives in the persisted signal-display store (Settings ▸ Interfaces ▸ Signal chips). Any `SignalBadge` usage may override it with the optional `variant` prop — the prop wins over the global setting. The label itself is built by the pure `buildChipLabel(variant, parts)` helper.

### Interaction model

The three chip interactions are strictly separated:

| Gesture                  | Effect |
|--------------------------|--------|
| **Hover**                | Interactive tooltip: full name, direction · type · value, address · source, originating CONNECT interface (resolved via signal membership in the CONNECT snapshot), comment, and **all** component bindings (max 8 rows + "+N more"). Every binding row is clickable and navigates to the bound component; clicking the tooltip title navigates to the signal node itself. |
| **Click**                | Force (pin) the signal — bool chips toggle, numeric chips open the force-value popover. Gated by the force confirmation. |
| **Shift+Drag**           | Start a signal drag to create a link. A ghost chip follows the cursor; `Esc` or releasing without a target cancels. |

A Shift+Click without movement (< 4 px) neither forces nor drags. While a drag is in progress all signal tooltips are suppressed globally.

### Drag & drop signal linking

The drag state machine lives in `src/core/hmi/signal-drag-store.ts` (`idle → armed → dragging → drop/cancel`); the `SignalDragPayload` carries `name`, `direction`, `plcType`, `address`, `comment`, `source`, the provider identity (`interfaceId`, and `topic` for MQTT) and a **required** `origin: 'connect' | 'internal'`, so drop targets validate without a store roundtrip. `origin` is what tells an internal model signal (which deliberately has no `interfaceId`) apart from a CONNECT signal that lost its provider. Drag sources are every signal chip and the whole signal rows of the CONNECT panel list. Drop targets register their DOM elements in `src/core/hmi/signal-drop-target.ts`; the drop is resolved centrally at pointerup with `elementFromPoint` plus a rect-union fallback per target (a slot row spanning several grid cells accepts drops across its whole band — portals and MUI popovers cannot swallow the hit). Hovering a target shows green (accepted) or red (type/direction mismatch — the drop is ignored) feedback.

Drop targets:

- **Signal slot rows** — the inline Property-Inspector rows AND the signal-bind popover rows (both `SignalSlotRow`): dropping a CONNECT signal onto a slot row creates the mapping through the same code path as the picker (type/direction validated by `slotAcceptsSignal` in `src/plugins/signal-bind/drop-accept.ts`).
- **3D scene** — dragging over a placed element with bindable slots auto-opens its signal-bind popover (debounced ~250 ms, `src/plugins/signal-bind/scene-drag-open.ts`), so the drop can land directly on a slot row. Leaving the element without dropping closes the auto-opened popover again. Requires the planner signal-linking feature (`signalBindingManager`).

## Typed Connections

Typed, directed connections link two components logically — persisted in the rv-ODT `Connections` block (`connections` edge list + `connectionTypes` signatures, `schema/v1/rv-odt.json` section 7g), so a GLB is self-describing. A connection is a named **bidirectional call**: the source invokes the target with request parameters; the target answers — usually deferred through a reply handle — with response parameters. Edges are 1:n capable (several edges may share a source or a target).

Two type categories share one storage / drag / inspector / cable mechanism:

| | Built-in (engine-semantic) | User-defined |
|---|---|---|
| Example | `StopOnExit` | `QualityCheck`, … |
| Signature | in code (`registerBuiltinConnectionType`) | data in `connectionTypes` (request/response parameter schemas) |
| Receive | `onArrival(mu)` | `onRequest(topic, params, reply)` |
| Answer | `mu.release()` | `reply(response)` (deferred, exactly once) |

**StopOnExit** builds a work station without code on the conveyor side: connect a sensor (source) to a station script (target). An MU reaching the sensor is stopped — the **transport surface decides how** via its `Accumulate` flag: on an accumulating surface the single MU is held (owner tag `heldBy: 'connection'`, the belt keeps running, following MUs accumulate); on a non-accumulating surface — or for instanced MUs (`useInstancing`), which have no per-instance hold — the surface's **drive is stopped** (note: a drive shared across several surfaces halts the whole line). The station script receives `onArrival(mu)`, processes (`self.in(ProcessTime, 'done', mu)`) and frees the MU with `mu.release()`.

Runtime pieces:

- `src/core/engine/rv-connection-registry.ts` — edge/type model, adjacency index, request/reply dispatch (re-entrancy-guarded), parameter validation.
- `src/core/engine/rv-connection-hold.ts` — the MU hold controller (single-MU hold vs. belt stop, per-drive refcount).
- `src/plugins/connection-system-plugin.ts` — loads the `Connections` extras block, applies edit-op edges on `scene-loaded`, dispatches StopOnExit from sensor `component-event`s and couples holds/reply handles to `simulation-reset`.
- `src/plugins/connection-gizmo-plugin.ts` — optional cable layer: one `link-line` gizmo per resolvable edge, colored by type, endpoints tracked per frame without geometry rebuilds. Toggleable via the Display panel's `Connections` overlay category.

Editing: the Property Inspector's **Connections** section lists in/out edges as chips (click navigates to the other end), offers typed per-edge config fields, an add form, a drag handle (drag onto another node in the 3D scene to connect) and the connection-type editor. All edits are ops (`addConnection` / `removeConnection` / `setConnectionType`) — undoable and draft-autosaved. GLBs without a `Connections` block load unchanged.

## Unified CAD Import

All geometry sources are imported through one entry point: the **Import** button (left tool toolbar, available in every workspace mode) opens the Unified Import Dialog. Its tabs come dynamically from the import provider registry (`viewer.importProviders`):

| Provider | Source | Build |
|----------|--------|-------|
| GLB File | local `.glb` file(s) | core (public) |
| STEP | local `.step`/`.stp` via occt WASM (browser-local, no upload) | private |
| Asset Manager | Unity Cloud Asset Manager (shared connections with the Library panel) | private |
| Onshape | Onshape cloud (registry entry point reserved) | private |

The dialog makes the target explicit ("Import as"):

- **Add to current scene** (default) — additive: the result is placed as a layout component through `viewer.importObject()`. The placement is recorded in the scene op log (undo/redo, autosave) and the imported geometry is written into the active project's `library/imports/` as a regular library asset, so it reloads like any catalog item. Without a writable project open the import still works but a warning marks it as non-persistent. The "Auto-align to floor" checkbox controls the AABB pivot/floor alignment — uncheck it for multi-part CAD assemblies that must keep their CAD origin.
- **Open as new scene** — replace: loads the result as a new model (clears the current scene), identical to opening a model from the selector.

Providers report availability reactively (`ready` / `needs-setup` / `connecting`); a provider that needs a login or credentials shows a setup hint instead of its form. Errors and partial results (e.g. 3 of 5 files converted) are listed in the dialog — nothing fails silently. See `doc-extending-webviewer.md` §21 for writing your own provider.

### CAD metadata (`JTData`)

JT files carry more than geometry: part name, mass, source units, layer and a stable per-body
uid. The JT reader writes a curated subset of those into each node as
`extras.realvirtual.JTData`, and the viewer registers it as a read-only component so the values
show up in the property panel.

| Field | Meaning |
|-------|---------|
| `ContractVersion` | Version of the metadata contract this block was written with |
| `PartName` | Part name from the CAD system |
| `Mass` | Mass of the part — **the unit is not recorded in JT files**, so it is reported as unknown rather than guessed |
| `MassSource` | `asserted` (user-set, assembly level) or `cad` (computed, part level). These describe **different objects** and must not be summed |
| `SourceUnits` | Length unit of the source model, raw — before the mm→m conversion the reader applies |
| `Layer` | CAD layer |
| `BodyUid` | Stable per-body uid, suitable for matching a part across CAD revisions |

Three properties are worth knowing:

- **Every field is optional.** The reader omits what the source file does not provide instead of
  writing `0` or `null`, so a block carrying only `ContractVersion` and `Layer` is normal. A GLB
  with no `JTData` at all is equally normal — not every exporter fills these properties.
- **It is provenance, not user state.** `JTData` describes the imported geometry. On CAD
  re-import it is therefore *not* carried over from the previous revision: the freshly imported
  values win, while your own components (drives, sensors, …) survive as usual.
- **Read-only, and not addable by hand.** The importer writes it; the inspector shows it.

## Materials Window (Editor mode)

Imported CAD arrives with whatever appearance the source file carried — usually a sea of flat greys. The **Materials** window (palette button in the left tool toolbar, Editor mode only) applies material presets to the selection and reports the material/texture health of the asset.

It docks on the right and shares that slot with the Quick Edit window — opening one closes the other.

**Sections**

- **Asset** — material and texture counts, plus actionable warnings: duplicate materials (distinct instances that render identically), oversized (≥2048px) and non-power-of-two textures, and transparency flags with no visual effect. Clicking a warning selects the parts it refers to. Deliberately no triangle/draw-call stats — those live in Settings → Dev Tools.
- **Presets** — a swatch library grouped into Metal, Plastic, Rubber & Glass and Paint (RAL). Click applies to every mesh under the selection. Custom presets appear in their own group.
- **Edit** — free PBR editing (base color, metalness, roughness, opacity) seeded from the primary selection, saveable as a custom preset. Custom presets persist in `localStorage` under `rv-editor-material-presets`.

**How it persists.** Each apply is a `setMaterial` op on the AssetDocument, so it is undoable and lands in the GLB on save as a real glTF material — there is no `rv_extras` override layer for appearance. Dragging a slider coalesces into a single undo step.

**Two invariants worth knowing** (`src/core/editor/rv-asset-material.ts`):

- **Clone-on-write.** The loader's dedup pass means one material instance routinely backs hundreds of parts, so applying a preset *assigns* a different instance and never mutates the attached one. Painting a subassembly cannot change parts elsewhere that happened to share its material.
- **One instance per distinct value.** Painting 400 parts "Steel" yields a single shared material, so the exported GLB does not carry 400 identical definitions. Undo re-attaches the exact original instances, preserving whatever sharing existed before.

**Editor mode only, by design.** Editor mode loads with `preserveHierarchy: true`, which skips the uber bake and nulls the `BatchTable`, so every node keeps its own real material. In batched modes the same assignment would be a silent no-op — batched source meshes render at `layers.mask = 0` and the arena keeps drawing the baked appearance. The plugin's `modes: ['editor']` gate is what keeps the window out of those modes.

## Asset Editor Op Log — Bulk Edits and Failure

The asset editor records every edit as an `AssetOp` on the `AssetDocument`
(`src/core/editor/rv-asset-document.ts`), applies it through
`AssetExecutorContext` (`rv-asset-executors.ts`) and folds multi-step actions into
one `composite` undo unit via `withTransaction`. Two properties of that machinery
are load-bearing once an edit touches hundreds of nodes at once.

### One top-level op per bulk move (`reparentNodesBatch`)

`AssetExecutorContext._afterApply` runs **once per top-level op** — and each run
emits `editor-structure-changed` (which costs the hierarchy panel a full
`scene.traverse`) plus one grouped-BVH classification. So an API that emits one op
per node makes both of those scale with the node count.

- `reparentNodes(paths, target)` — one top-level op **per node**. Use it for
  interactive moves (drag & drop, a handful of nodes).
- `reparentNodesBatch(paths, target)` — the whole block resolved **before** the
  first mutation and applied as **one composite**: one structure event, one BVH
  classification, one world-matrix flush, one undo step. Use it for anything bulk
  (`groupIntoEmpty`, the PLMXML kinematics import).

Measured on a synthetic 4493-node assembly moving 434 nodes with the hierarchy
panel open: **178 ms → 21 ms**, structure events 773 → 8, forced
`updateMatrixWorld` walks 1306 → 16. 73% of the original cost was the panel
re-scanning the scene once per node.

The batch is deliberately **not** a new persisted op kind — it composes the
existing `renameNode`/`reparentNode` primitives, so undo, redo, draft replay and
the op-log schema are unchanged. Two details it owns: all paths and collision
renames are resolved up front (a later lookup can never be invalidated by an
earlier move), and `prevIndex` is recorded against the parent's children **minus
the batch's earlier members**, because the inverse restores them in reverse order
into a list that grows back one node at a time — snapshotting raw indices
scrambles sibling order on undo.

The matrix batching that goes with it is applied **only** to a composite made
purely of moves and renames (`isPureMoveComposite`): those apply a transform
resolved before the batch opened, so nothing inside reads `matrixWorld`. A
composite that also constructs components keeps the eager per-op refresh, and the
flush itself is unconditional — the editor pick backend reads `matrixWorld` raw.

### Failure contract

An op **either applies or rejects**; a transaction is **all-or-nothing**.

- `applyOp()` rejects when the executor failed, and the op is then not recorded.
- A `composite` that fails part-way rolls its already-applied primitives back
  before re-throwing (`_forwardAny`/`_inverseAny`).
- `withTransaction()` rolls back everything it applied, records nothing, and
  re-throws the original error — including failures from the `void`-returning
  mutators (`setField`, `addComponent`, …), which land in `_txnError`.
- `undo()`/`redo()` move their stacks only **after** the apply succeeded, so a
  failed undo stays retryable.
- The op queue tail never rejects, so one failed op cannot poison later ones.

The single documented exception is `CadGeometryUnavailableError`: it stays a
collected, user-recoverable condition (`takeMissingCadGeometry`) so replaying a
draft whose GLB cache was evicted still restores everything else.

### Busy state during a transaction

A transaction suppresses intermediate store notifications (868 synchronous
`useSyncExternalStore` snapshot changes for 434 moves used to abort the apply with
React's "Maximum update depth exceeded"). Because that also swallowed the `busy`
transition, the transaction publishes busy **once** when it opens and drops it on
commit or rollback. The observable sequence for a bulk edit is therefore exactly
three states: `busy` → `busy, dirty, undoable` → `idle, dirty, undoable`.

### Mesh Separator — splitting one mesh into its parts

A CAD import often arrives as a *single* mesh holding several physically separate
parts. Such a mesh is one unit for selection, material assignment, visibility and
kinematics. **Separate** cuts it apart, after which the existing per-mesh paths
apply unchanged — no special case in `setMaterial`, picking or the GLB export.

Right-click a single selected mesh → **Separate ▸**

- **Into parts…** — connected components, found by union-find over
  position-quantized vertices.
- **By material group…** — one part per `geometry.groups` entry, each carrying
  the material of its own slot. Offered only when the mesh has ≥ 2 groups.

The click opens a confirmation dialog reporting the part count; nothing is applied
until it is confirmed.

**Weld and output are separate roles.** The weld (`weldVertexIds`) quantizes the
**position only**, and exists only to build the connectivity graph; the output
geometry is rebuilt from the **original** vertex indices, so normals, UVs and hard
edges survive. Hashing all attributes instead — what `BufferGeometryUtils.mergeVertices()`
does — reports six islands for a single hard-edged cube, because each face has its
own normal at every shared corner. `weldThreshold` (default `0.0001`, an API
parameter, no UI setting) is therefore a **quantization resolution, not a distance
tolerance**: two points closer than the resolution can still land in adjacent grid
cells and stay separate.

**Where the work runs.** Weld, union-find and the attribute copy run in a Web
Worker (`rv-mesh-separator-worker.ts`) behind `RVMeshSeparatorClient`, in two
phases — `analyze` for the preview, `extract` only after confirmation. Measured on
a workstation, a main-thread run costs 63–380 ms from ~200k vertices upward, which
is exactly the range this feature targets. Request buffers are **copied, never
transferred** (a transfer would detach the live source geometry's `ArrayBuffer` and
take rendering and raycasting down with it); responses are transferred. Every
request carries a monotonic id, and an answer whose id is stale is dropped — that
is how dialog cancel, a geometry change and `dispose()` abort.

**What the op does** (`separateMesh`, `rv-asset-executors.ts`). The source mesh is
replaced by a **same-named `Group`**, so its path stays valid:

- The Group's local transform comes from the **baked `matrixWorld`**
  (`inverse(parent.matrixWorld) · source.matrixWorld`), decomposed to TRS, with
  both auto-update flags copied from the source — editor loads run
  `freezeStaticMatrices()`, after which the local TRS is not authoritative.
- `userData` is **deep-copied**, existing child nodes are moved across, and the
  components of the whole subtree are torn down (`disposeComponentsInSubtree`,
  **before** the registry unregister — afterwards nothing resolves) and rebuilt via
  `processExtras`.
- Undo parks the Group in the trash and brings the original back; redo is *not* the
  `importCad` trash short-circuit, because after an undo the original is live *with
  its children* while the Group sits in the trash.
- The op is parameter-only. `childNames` is resolved **once** at op creation and
  applied verbatim — a collision on replay is a logged no-op, never a silent
  rename, so a live run and a draft replay cannot drift apart.

**Not eligible:** instanced, skinned, morph-target and interleaved geometry (they
cannot be copied attribute by attribute), a mesh that is already a single island,
and — in island mode only — a multi-material mesh, which is routed to the group
mode instead. The reason is reported in the dialog.

**Draw calls.** Editor mode does not bake, so each part is its own draw call; the
dialog states the count. Loading the result in a batched mode does *not* merge the
parts back into one geometry: `rv-batched-render.ts` registers every unique
geometry as its own `BatchedMesh` slot and every mesh as its own instance.
(`buildMergeBatches()` in `rv-mesh-merge-batch.ts` *would* concatenate candidates
into one arena, but it has no caller in this tree — `meshMergeRegistry` is an
unwired seam.)

### Mesh Merge — collapsing a subtree back into one mesh

**Merge** is the inverse of Separate and lives in the same context menu. Where
Separate turns one mesh into a same-named `Group` of island children, Merge turns
the subtree of any node into a same-named **`Mesh`** — one mesh **per material and
per Group**. A deeply nested CAD import becomes a flat, HMI-ready object without
losing its function.

Right-click any node with children → **Merge into one mesh…**. The label is static
(the classification walks the whole subtree and must not run while the menu opens),
and the entry reads the **clicked target**, not the selection — a right-click on a
hierarchy row highlights it but does not select it. The dialog reports how many
parts become how many meshes and how many nodes are kept, and nothing is applied
until it is confirmed.

**What is merged, and what survives.** `classifySubtree()` in `rv-mesh-merge.ts`
sorts every node of the subtree into three categories, checked in this order:

| Category | Detected by | Effect |
|---|---|---|
| **Protected** | any non-passive rv_extras key, **or** a naming-convention name (`Drive-Rot-Y`, `Transport-Z`, `Sensor`, `Carrier-1`, `Snap-ZP-…`) | node **and its whole subtree** are untouched and become children of the result |
| **Anchor** | `Kinematic`, `Drive`, `CADLink`, `JTData` | the node survives, but its extras-free geometry still merges — into an output that stays **its own child** |
| **Mergeable** | a single-material `Mesh` with no active extras and no guard hit | goes into a bucket |

Boilerplate the Unity exporter stamps on nearly every node (`layer`, `tag`,
`activeSelf`, `renderer`, `rigidbody`, `colliders`) is **passive** and does not
protect anything — without that rule nothing would ever merge. `Group*` is passive
too, but for a different reason: group membership rides along on the output mesh
instead (see below). The naming-convention check uses the same parsers the library
loader uses, so a merge over a conveyor asset cannot dissolve it into a static mesh.

**Owner zones.** Nothing merges across an anchor boundary. Each anchor opens its
own zone, and the output built from its geometry stays a **child of that anchor** —
otherwise a `Drive` would stop moving its own geometry, an asset that looks correct
and is broken. The subtree root is a zone too; exactly one output carries
`role: 'root'` and *replaces* the root at its path (a root zone without geometry
still gets it, as an empty carrier), and every further root-zone output becomes its
child.

**Bucket key** = `ownerPath | sorted group names | materialKey`, deliberately
**without** an attribute signature. `materialKey` is a *semantic* fingerprint —
name, colour, metalness, roughness, map name, side, transparent, opacity — not
`material.uuid`, which three.js re-mints in every `Material` constructor and which
would therefore diverge on a plain GLB reload.

**Geometry.** Every source is baked into its owner's space with **exactly one**
`applyMatrix4()`, which already transforms `normal` **and** `tangent`; a second,
manual normal-matrix pass would transform normals twice. At a negative determinant
the triangle winding is flipped and the tangent handedness `w` inverted — the
renderer compensates mirroring per mesh via `gl.FrontFace`, and once mirrored and
unmirrored parts share one geometry that compensation is gone. The index type is
left to three.js (`setIndex()` picks `Uint32` from the actual index values).

`mergeGeometries()` returns `null` **silently** on incompatible attribute sets, so
the bucket is normalised first, along a whitelist: `normal` (via
`computeVertexNormals()`), `color` (white/opaque) and `uv`/`uv1`/`uv2` (zeros) can
be reconstructed; `tangent`, `skinIndex`, `skinWeight` and any custom attribute
**cannot**, and a mismatch there refuses the merge with a diagnostic rather than
inventing values — and never produces a second mesh for the same (material, Group)
pair. The return value is always checked.

**Where the work runs.** The bake and the merge run in a Web Worker
(`rv-mesh-merge-worker.ts`) behind `RVMeshMergeClient`; classification, traversal
and the attribute copy stay synchronous. Request buffers are tight copies made by
the `serialize*` helpers and are therefore handed over on the **transfer list** —
that detaches nothing live, because the copy is already independent. Measured on a
workstation: a main-thread merge costs ~41 ms at 200k and ~142 ms at 1M vertices,
against ~2.5 ms / ~12.4 ms of main-thread submit cost through the worker; peak live
buffer memory is 2.0× the source buffers at both sizes (the worker bakes its own
copies **in place**, so there is no third copy).

**What the op does** (`mergeMesh`, `rv-asset-executors.ts`). The whole partition —
sources, buckets, output names, owner zones and surviving nodes — is resolved
**once** at op creation (`planMergeMesh()`) and applied verbatim. That is stricter
than `separateMesh`, because bucketing depends on the material: an executor that
re-classified on replay would produce a different split as soon as a `setMaterial`
op ran in between. Every source therefore carries a replay signature
(`materialKey`, vertex and triangle count), and a divergence is reported as a
**collected, user-recoverable failure** (`takeUnappliedMerges()`), never as a
silent no-op and never as a throw — a throw would make the replay caller replace
the partially restored document with an empty one.

Undo is bit-exact: every node that changes parent is recorded with its original
parent object, sibling index, depth and local matrix, captured in one pass **before**
the first detachment, and restored shallowest-first at ascending sibling index.
Children authored under an output *after* the merge are recognised (they are not in
`generated`) and re-homed to the zone's origin owner instead of vanishing into the
trash. Output geometries carry `MERGER_GEOMETRY_MARK` so the trash flush disposes
only what the merge built — the parked originals may be shared and come back alive
on undo, and `disposeBoundsTree()` always runs before `dispose()`.

The replacement node takes the root's local and world matrix, both auto-update
flags, `visible`, `layers`, `castShadow`/`receiveShadow`, `renderOrder`,
`frustumCulled` and a **deep copy** of its `userData`; each output additionally
gets `Group`/`Group_N` extras for its resolved group names, because
`rv-group-sync.ts` derives membership exclusively from those.

**Not eligible:** fewer than two mergeable meshes, a subtree that is only carriers,
a multi-material source (split it with *Separate ▸ By material group* first), and
instanced/skinned/morph/interleaved geometry. The reason is reported in the dialog
and no op is created.

**The cost.** After a merge the parts share one bounding box, so culling is coarser
and a click hits the merged mesh instead of the individual part. That is the point
of the operation, and Separate is the way back.

## Renderer Support

- **WebGL** (default): Stable, all browsers
- **WebGPU**: Three.js r185 `WebGPURenderer` with WebGL2 fallback

Selection persists via URL parameter (`?renderer=webgpu`) or localStorage.

### Automatic Quality Selection

Weak devices automatically get the published **"Fast"** visual preset (Unlit render mode, no shadows, no antialias, lower DPR cap) instead of "Default" (`src/core/hmi/auto-quality.ts`):

- **Boot seed** — on a fresh install (no persisted visual settings), a standalone WebGL probe classifies the GPU tier; mobile devices and integrated/software GPUs seed "Fast", everything else "Default".
- **FPS watchdog** — after each model load (5 s grace period), `viewer.currentFps` is sampled (15 valid samples, hidden-tab samples skipped); a median below 20 fps switches to "Fast" at runtime.

Both stages show a one-time modal ("Performance mode enabled", dismissed with OK) and act **at most once per device** — the localStorage flag `rv-auto-quality-applied` guarantees a manual preset choice is never overridden afterwards. The preset can be changed anytime under **Settings → Visual → Preset**.

## Deployment Configuration (settings.json)

Place a `settings.json` in `public/` (or next to `index.html` in production) to configure the viewer at deployment level. The file is fetched with cache-busting before React mounts, so settings apply immediately without flicker.

A documented example is provided in `public/settings.example.json` — copy it to `public/settings.json` and edit as needed.

### Model signature and provenance

Deploys can embed an Ed25519 provenance signature in the default scene extras:
`scenes[scene ?? 0].extras.rv_sig`. The signature covers the complete finished
GLB byte stream. The signer temporarily substitutes a fixed 88-character
standard-Base64 placeholder, so verification does not reserialize JSON or
depend on property order.

At runtime the loader verifies every GLB before `GLTFLoader.parseAsync()`.
Unsigned models keep the existing behavior. A valid signature enables model
logic immediately. An invalid signature, or a browser that cannot verify
Ed25519, still loads geometry and HMI but gates simulation ticks, component
events, behaviors, and runtime component initialization. The provenance banner
lets the user explicitly activate logic; that decision is stored per model as
`rv-sig-unlock:<modelName>`. Local files use their filename as the stable model
identity instead of their temporary `blob:` URL.

Signed models are self-contained: if `rv_sig` exists, the loader never applies
a neighboring `.kin.json` sidecar, regardless of whether verification succeeds.

Deployment signing is Node-only:

```bash
# PKCS#8 Ed25519 private key, either PEM text or Base64-encoded PEM.
# Never expose this as a VITE_ variable.
set RV_SIGN_PRIVATE_KEY=<private-key>
npm run deploy
```

Public deploys sign retained GLBs after model pruning. Private deploys sign each
plaintext project GLB before optional RVE1 encryption. When signing is enabled,
all GLBs are uploaded even if the remote file has the same size, because a new
valid signature can change bytes without changing length.

Commercial customer keys use a root-certified `rv_key` object. The customer
keeps its Ed25519 private key and receives a certificate for its raw public key:

```bash
node scripts/rv-issue-customer-key.mjs \
  --pub <44-character-padded-public-key> \
  --org "Customer Organization" \
  --out customer-cert.json

set RV_SIGN_PRIVATE_KEY=<customer-private-key>
set RV_SIGN_CUSTOMER_CERT=C:\secure\customer-cert.json
npm run deploy:private
```

The deploy fails if the customer certificate is not root-certified or its
public key does not match `RV_SIGN_PRIVATE_KEY`. Verify a generated artifact
without deploying it:

```bash
node scripts/rv-sign-glb.mjs --verify dist/models/machine.glb
```

### Published models (CONNECT `model_changed`)

A model pushed to a running CONNECT gateway (`POST /model`) reaches the viewer over the WebSocket as
`model_changed`, carrying the model name, the URL it is actually served under and a **revision**
counter. Two rules govern what happens next, and both exist because the previous behaviour — a blanket
`window.location.reload()` — violated them.

**The user's selection is never overridden. Only the contents of their selection are refreshed.**

| Situation | Behaviour |
|-----------|-----------|
| the published model is new | it appears in the model selection; nothing is disturbed |
| the published model is the one currently open | its geometry reloads in place |
| another model is open | nothing happens |
| the open model, but there is unsaved work | a hint offering the choice, never an automatic load |
| no model is open | only the catalogue is updated — an empty scene is a decision, not an invitation |

Who does what:

- `signal-transport-core.ts` forwards the announcement out of the worker instead of discarding it.
- `websocket-realtime-interface.ts` checks that the gateway is the page's own origin
  (`isSameOriginWsTarget`, scheme + host + port including implicit ones) and emits a typed event.
  It performs no action of its own — a page can hold three of these clients (InterfaceManager,
  the per-model one in `ConnectPlugin`, and the inheriting `CtrlXInterface`).
- `rv-model-update-coordinator.ts` is the single actor. It deduplicates by canonical URL **and**
  revision, discards announcements carrying an older revision, and decides per the table above.
- `rv-model-catalog.ts` owns model identity: the **canonical URL** (catalogue key, `localStorage`
  entry, scene-draft key — never rewritten) versus the **fetch URL** (`?v=<revision>`, used at the
  download and nowhere else), plus the catalogue signal that reaches both `SceneStore` and the login
  gate's picker.
- `rv-view-state.ts` captures and restores the complete view — projection, position, quaternion,
  controls target and zoom — because both `loadModel()` and `loadScene()` re-fit the camera. FPV and
  Follow are left alone; they drive the camera every frame.

A model published while the browser was closed or the socket was down is picked up on the next load
from `GET /model/manifest`, laid **additively** over the catalogue the viewer resolved for itself
(`models.json` stays authoritative where it exists). There is no polling.

### CONNECT embedded demo gate

CONNECT's `-PublicDemo` bundle injects `ui.initialContexts: ["connect-embed"]` and an empty
`defaultModel`. The viewer then starts with the CONNECT panel and a minimal CTA shell instead of
restoring a model, scene, or workspace mode. Starting the bundled demo unlocks the regular HMI.
The bundle also carries the AGPL license and an exact corresponding-source link.

In this context the **Models** panel shows exactly one row — the bundled demo. Clicking it starts
the demo, and the **×** on the active row closes it, returning to the non-persisted gate with the
panel still open. Both paths run through `connect-embed-actions.ts`, never through
`SceneStore.openBuiltin` (which would persist a draft the embed context does not want). There is
no demo chip and no close button over the viewport.

### AAS resolution contract

An AAS surface only appears when the link can actually be resolved. The resolvability is decided
once per model load — where the project-specific `assetsBasePath` is known — and written to
`node.userData._rvAasResolution`; tooltip, detail panel, inspector button, doc-mode click, sidebar
counter and "Add to Cart" all read that one marking.

| State | Meaning | UI |
|-------|---------|----|
| `resolved` | `aasx/index.json` available, id known | shown |
| `unknown-id` | index available, id not in it | **hidden** |
| `index-missing` | index not shipped (404 / SPA fallback) | **hidden** |
| `index-error` | network failure, 5xx, broken JSON | visible error |
| `pending` | not determined yet | renders nothing |

A deployment without an AASX payload (the CONNECT embed strips the whole `aasx/` folder) therefore
shows no AAS UI at all instead of a red error on every motor hover. A *broken* index keeps its
visible error on purpose — hiding it would mask a broken deployment.

Links attached at runtime (`attachDriveDatasheets`, layout-planner placements) are marked
`pending` synchronously and classified by `resolveAasSubtree()`, which is driven from the viewer's
`model-loaded` and `layout-content-added` events so it also runs in modes where `AasLinkPlugin`
is not loaded.

### Settings Priority

```
URL Params  >  settings.json  >  localStorage  >  Code DEFAULTS
```

Each settings store (`visual`, `search`, `interface`) follows this 3-layer merge:
1. **DEFAULTS** — Hardcoded in each store module
2. **localStorage** — User's persisted preferences (overrides DEFAULTS)
3. **settings.json** — Deployment config (overrides localStorage per-field via `??`)

### Example settings.json

```json
{
  "lockSettings": true,
  "hideWelcomeModal": true,
  "defaultModel": "models/customer-line.glb",
  "visual": {
    "shadows": true,
    "shadowStrength": 0.5,
    "lightIntensity": 1.0
  },
  "interface": {
    "activeType": "websocket-realtime",
    "autoConnect": true,
    "wsAddress": "192.168.1.100",
    "wsPort": 7000
  }
}
```

### Lock Mode

- **`lockSettings: true`** — Hides the Settings gear button entirely. All `save*()` functions become no-ops (lock guard). End users see only the 3D scene and HMI overlay.
- **`lockedTabs: ["interfaces", "devtools"]`** — Hides only specific tabs in the Settings dialog. The gear button remains visible for unlocked tabs.
- **`hideWelcomeModal: true`** — Suppresses the welcome/about dialog on first visit.
- **`defaultModel: "models/demo.glb"`** — Pre-selects a model on load (can be a filename or full URL).

`lockSettings` is an admin override — it only comes from `settings.json` or the `?lockSettings` URL param, never from localStorage.

### Context Visibility Overrides

Control which HMI elements are visible or hidden based on active "contexts" (e.g. `fpv`, `planner`, `maintenance`, `xr`, `kiosk`). Rules are declared per UI element with `hiddenIn` and `shownOnlyIn`:

The rules live under the `ui` key as `visibilityOverrides` (`UIContextConfig` in
`src/core/rv-app-config.ts`):

```json
{
  "ui": {
    "initialContexts": ["kiosk"],
    "visibilityOverrides": {
      "kpi-bar":      { "hiddenIn": ["fpv", "xr"] },
      "bottom-bar":   { "hiddenIn": ["fpv", "xr", "planner"] },
      "button-panel": { "hiddenIn": ["xr"] },
      "top-bar":      { "hiddenIn": ["xr"] },
      "messages":     { "hiddenIn": ["fpv", "planner"] },
      "views":        { "hiddenIn": ["fpv", "planner"] },
      "kiosk-overlay": { "shownOnlyIn": ["kiosk"] }
    }
  }
}
```

**Rule semantics:**
- `hiddenIn: ["fpv", "xr"]` — element is hidden when ANY of these contexts is active
- `shownOnlyIn: ["kiosk"]` — element is visible ONLY when ALL listed contexts are active
- No rule → always visible (default)
- Rules compose with the existing `H` key HMI toggle via AND logic

**Built-in contexts:** `fpv` (first-person view), `planner` (layout planner), `maintenance`, `xr` (VR/AR), `kiosk`

Plugins activate/deactivate contexts programmatically:

```typescript
import { activateContext, deactivateContext, setContext } from './core/hmi/ui-context-store';

activateContext('fpv');     // Hides elements with hiddenIn: ['fpv']
deactivateContext('fpv');   // Restores visibility
setContext('kiosk', true);  // Convenience toggle
```

React components subscribe via the `useUIVisible()` hook:

```typescript
import { useUIVisible } from './core/hmi/ui-context-store';

function KpiBar() {
  const visible = useUIVisible('kpi-bar', { hiddenIn: ['fpv', 'xr'] });
  if (!visible) return null;
  // ...
}
```

### URL Parameter Overrides

| Parameter | Effect |
|-----------|--------|
| `?lockSettings` | Locks settings (highest priority) |
| `?lockSettings=false` | Explicitly unlocks |
| `?model=models/demo.glb` | Load specific model |
| `?renderer=webgpu` | Use WebGPU renderer |
| `?option=<id>` | Load a **model variant** (see below) |

#### `?option=` — deep-link model variants

A model folder may declare variants of the SAME GLB in `models/<name>/model-options.ts` —
different supplier data on identical geometry, applied by that model's `applyModelOption`.
Two lists exist:

- **`modelOptions`** — variants offered as extra rows in the model selector.
- **`deepLinkOptions`** — variants reachable ONLY by URL, never listed in the UI.

`DemoRealvirtualWeb` uses the second list for its `bosch` and `sew` AAS mappings: three
near-identical rows in the model list confused more than they helped, so the variants are
deep-link-only. `?option=bosch` and `?option=sew` still work, survive a reload, and are
shareable:

```
/?option=bosch
/?scene=builtin:DemoRealvirtualWeb.glb&option=sew
```

`ModelOptionPlugin` **always** runs the model's apply callback on `onModelLoaded` — with
`optionId = null` when no option is active. A model uses that call to normalize the GLB back
to its default variant (e.g. nodes hard-wired to a non-default supplier in the export), so
switching away from an option does not leave the previous variant applied.

`option` is a **top-level** query parameter and is deliberately not folded into the
`scene=builtin:` value — the boot matcher compares that value against a filename. It is kept
across scene-URL rewrites for the base model it belongs to, and removed when switching to a
model that does not declare it (otherwise a stale `option` would keep applying).

### API (for plugins/custom code)

```typescript
import { getAppConfig, isSettingsLocked, isTabLocked } from './core/hmi/rv-app-config';

// Read config values
const config = getAppConfig();
if (config.interface?.autoConnect) { /* ... */ }

// Check lock state
if (isSettingsLocked()) { /* hide settings UI */ }
if (isTabLocked('interfaces')) { /* hide interfaces tab */ }
```

### How Stores Use Config

Each settings store internally calls `getAppConfig()` — no signature changes needed at call sites:

```typescript
// In loadVisualSettings():
const fromStorage = loadFromLocalStorage();           // Layer 1+2
const override = getAppConfig().visual;                // Layer 3
if (!override) return fromStorage;
return {
  shadows: override.shadows ?? fromStorage.shadows,    // config wins if set
  lightIntensity: override.lightIntensity ?? fromStorage.lightIntensity,
  // ...
};

// In saveVisualSettings():
if (isSettingsLocked()) return;  // Lock guard — no-op when locked
localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
```

## News

An opt-in, fail-silent feed of product announcements (`src/core/news-store.ts`,
`src/core/hmi/NewsDialog.tsx`). Two independent queues feed the same dialog: the public
WEB queue fetched directly from the portal, and the CONNECT queue proxied by a connected
gateway. The dialog joins the startup chain via `startup-modal-coordinator.ts`, so it
never collides with the welcome or auto-quality modals.

### Deployment gating

The WEB queue is fail-closed. `fetchUnseenNews()` issues a request only when
`settings.json` carries both fields:

```json
{
  "news": {
    "enabled": true,
    "apiUrl": "https://download.realvirtual.io/news/api/v1"
  }
}
```

`enabled` must be exactly `true`, and `apiUrl` must be an absolute HTTP(S) URL **without
query or fragment** — the store appends `?target=web` itself. Anything else resolves to
`null` and no request happens. Private, customer and self-hosted deployments omit the
block entirely and therefore make zero external requests.

Two further gates are evaluated before `fetch` is referenced at all:

| Gate | Effect |
|------|--------|
| Already fetched this session | At most one WEB request per page load |
| Running inside a CONNECT embed | WEB fetch suppressed — news arrive through the gateway instead, so no duplicate dialog appears |

### Contract v1

```json
{ "contract": 1, "items": [ { "id": "…", "title": "…", "body": "…", "link": null,
  "validFrom": "…", "validTo": null, "updatedAt": "…" } ] }
```

Validation is all-or-nothing: a wrong `contract` value, a malformed item, or a `link`
that is not `http:`/`https:` discards the entire response. Duplicate ids are dropped and
the list is capped at 20 items. The request aborts after 5 s (`NEWS_FETCH_TIMEOUT_MS`).
Every failure path — offline, timeout, non-2xx, structural error — yields an empty queue
with no banner and without blocking startup. Item bodies are rendered through
`SafeMarkdown`, never as raw HTML.

### Seen state

| Queue | Storage | Acknowledgement |
|-------|---------|-----------------|
| WEB | `localStorage['rv-news-seen']` | `markNewsSeen(id)` — local only |
| CONNECT | Gateway-side `news-seen.json` | `markConnectNewsSeen(id)` — drops the item locally, then `POST /news/seen`; the gateway stays the source of truth |

## Publishing

### Public Demo

The standard publish workflow deploys to `https://web.realvirtual.io/{demoName}/`:

1. **Unity:** Tools → realvirtual → Export → WebViewer Tools → Publish tab
2. Select provider (Bunny CDN), enter demo name, export scene, click Publish
3. The viewer app + GLB are uploaded to the CDN

Or via Claude: `/deploy-web`

### Private Projects

Private projects publish to **unguessable URLs** at `https://web.realvirtual.io/{code}/` where `{code}` is a 32-character hex string (128-bit entropy). Each project is fully self-contained — its own GLB models, plugins, and settings.

**Local project structure:**

```
Assets/realvirtual-WebViewer-Private~/projects/
  mauser3dhmi/                        # Project folder
    project.json                      # Metadata: name, code, settings
    index.ts                          # Project-level plugins (optional)
    models/
      CL Digital Twin V100.glb        # Customer-specific GLBs
    models/CL Digital Twin V100/
      index.ts                        # Model-specific plugins (optional)
    plugins/
      customer-hmi.ts                 # Plugin source files
```

**project.json format:**

```json
{
  "name": "Mauser 3D HMI",
  "code": "a9d6c728c2a7006e52e55c03a174efbf",
  "created": "2026-04-03",
  "lastPublished": "",
  "settings": {
    "defaultModel": "CL Digital Twin V100.glb"
  }
}
```

**Unity workflow:**

1. Open the **Private** tab in WebViewer Tools
2. Click **New Project** (or create the folder structure manually)
3. Open your customer scene, click **Export Scene** on the project card
4. Optionally write an `index.ts` for project-specific plugins
5. Click **Publish** — stages, compiles plugins, uploads to CDN
6. Share the URL: `https://web.realvirtual.io/{code}/`

Or via Claude: `/deploy-web-private`

**How it works:**

- The shared app bundle (`index.html`, `assets/`) is copied from `dist/` — no separate Vite build per project
- Project `index.ts` is compiled to `project-plugin.js` via esbuild (<1s)
- Model-specific `index.ts` compiled to `model-plugin.js` in the model's subfolder
- At runtime, the viewer loads `project-plugin.js` and `model-plugin.js` via dynamic `import()` and calls `setup(viewer)`
- Customer GLBs never touch `public/models/` — they stay in the private project folder

### Project-Specific Plugins (index.ts)

Project plugins control which plugins are active and can disable standard plugins. The viewer instance is injected — no direct imports from the app source needed.

**Project-level** (applies to all models in the project):

```ts
import type { RVViewer } from 'realvirtual-webviewer';
import { CustomerHmiPlugin } from './plugins/customer-hmi';

export default function setup(viewer: RVViewer): void {
  viewer.use(new CustomerHmiPlugin());
  viewer.disablePlugin('kpi-demo');      // Disable standard plugins
  viewer.disablePlugin('test-axes');
}
```

**Model-level** (applies only to a specific model):

```ts
import type { RVViewer } from 'realvirtual-webviewer';

export default function setup(viewer: RVViewer): void {
  viewer.disablePlugin('sensor-monitor');  // Not needed for this model
}
```

**`disablePlugin(id)` API:**

- Removes the plugin from all tick callbacks (`onFixedUpdatePre/Post`, `onRender`)
- Skips the plugin in lifecycle callbacks (`onModelLoaded`, `onModelCleared`, `onConnectionStateChanged`)
- Works on **any** plugin, core ones included — only `removePlugin()` refuses `core: true`
- `dispose()` is still called for disabled plugins (prevents memory leaks)

### CDN Structure

```
https://web.realvirtual.io/
  demo/                              # Public demo
    index.html, assets/*, models/demo.glb
  a9d6c728c2a7006e52e55c03a174efbf/  # Private project (root-level)
    index.html                       # Same app bundle
    assets/                          # Same JS/CSS
    project-plugin.js                # Compiled from project index.ts
    models/
      CL Digital Twin V100.glb       # Customer-specific
    settings.json                    # Project-specific config
```

Security is based on URL unguessability (128-bit entropy, same principle as Google Docs share links). HTTPS is enforced by Bunny CDN.

## GLB Extras Format

The GLB export stores component data in `node.extras.realvirtual`:

```json
{
  "extras": {
    "realvirtual": {
      "Drive": { "Direction": "LinearX", "TargetSpeed": 500.0, "Acceleration": 100.0 },
      "TransportSurface": { "SurfaceSpeed": 500.0, "BoxCollider": { "center": [0,0.5,0], "size": [2,0.1,0.5] } },
      "Sensor": { "BoxCollider": { "center": [0,0,0], "size": [0.1,0.2,0.5] } }
    }
  }
}
```

Enums as strings, component references as `{ type: "ComponentReference", path: "...", componentType: "..." }`.

## Testing

Tests run in real Chromium via Vitest + Playwright:

```bash
npm test              # All tests, headless
npm run test:watch    # Watch mode
npm run typecheck     # Full type check (tsconfig.full.json — includes private-dependent tests)
npx tsc --noEmit      # Community type check — the public tsconfig, excludes private-dependent tests
```

Test GLB: Export from Unity demo scene → `public/models/tests.glb`.

Test files live in [tests/](tests/) (Vitest, browser-mode) and [e2e/](e2e/) (Playwright). Run `ls tests/*.test.*` for the current inventory — counts move every release, so no totals are kept here.

## Debug Logging

Category-based structured logging via `rv-debug.ts`. Zero overhead in production.

```
?debug=all              # URL parameter
?debug=playback,loader  # Specific categories
```

The 15 categories enabled by `?debug=all`: `loader`, `playback`, `drive`, `transport`, `sensor`,
`logic`, `signal`, `erratic`, `grip`, `parity`, `config`, `multiuser`, `interface`, `render`,
`perf`. A 16th category, `plugins` (model plugin loading/unloading), exists but must be named
explicitly (`?debug=plugins`).

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| three | 0.185.1 (pinned, no `^`) | 3D rendering (WebGL + WebGPU + WebXR) |
| react + react-dom | ^19 | HMI overlay |
| @mui/material | ^7 | UI components |
| echarts | ^6.0.0 | Charts |
| vite | ^6.1.0 | Build tool + dev server |
| vitest | ^4 | Test runner |
| typescript | ^5.7 | Compiler |

## Camera Controls

- **Right mouse**: Orbit
- **Middle mouse**: Pan
- **Scroll**: Zoom
- Damping enabled (default factor 0.2, `DEFAULT_ORBIT_NAVIGATION_SETTINGS` in `rv-orbit-controls-config.ts`; user-configurable together with rotate/pan/zoom speed)
- Auto-fit to model bounding box after load

## Known Limitations

- `controllerScale` hardcoded to 1000 (mm→m)
- Materials may differ from Unity URP (PBR mapping differences)
- OnSignal spawn mode not implemented for Sources

Ported DriveBehaviours: `Drive_Simple`, `Drive_Cylinder`, `Drive_DestinationMotor`,
`Drive_Speed`, `Drive_FollowPosition`, `Drive_Gear`, `Drive_PositionSwitch` and
`Drive_ErraticPosition`. Behaviours outside that list are not ported.

## Multiuser

realvirtual WEB supports real-time multiuser sessions where multiple users see each other as avatars in the same 3D scene. Each user's camera position is shared and rendered as a colored sphere with a name label.

### Quick Start

1. Add the `MultiplayerWEB` component to any GameObject in your Unity scene
2. Press Play — the WebSocket server starts on Port 7000
3. Open realvirtual WEB, click the Multiuser button in the top bar
4. Enter the server URL (e.g., `ws://192.168.1.5:7000`) and your name
5. Click Connect — you will see other connected users as avatars

### Features

- **VR/AR Avatars**: VR users show head + controller positions
- **Roles**: Operator (can control signals and drives) vs Observer (watch only)
- **Late Join**: New users receive the complete simulation state (all signal values, drive positions, and current avatars)
- **Cursor Rays**: See where other users are pointing in the 3D scene
- **URL Join**: Share `?server=ws://host:7000&name=User` links for instant session entry
- **Rate limiting**: Max 100 messages/second per client on the Unity side; outgoing avatar updates capped at 20 Hz on the browser side
- **Auto-reconnect**: The browser client reconnects automatically after a 2 s delay

### Web-only Mode (No Unity)

For sessions without a running Unity instance, point realvirtual WEB at a standalone relay server. The relay source lives in a separate repository; realvirtual WEB ships with a default hosted relay (`wss://download.realvirtual.io/relay`) configured in [multiuser-settings-store.ts](src/core/hmi/multiuser-settings-store.ts). Switch a session into relay mode via the Multiuser settings tab or by passing `?server=wss://...&joinCode=...` on the URL.

### Microsoft Teams Integration

realvirtual WEB runs natively inside Microsoft Teams as an interactive app — no screen sharing needed. Share 3D digital twins directly in meetings, channels, and chats.

**What it does:**
- **Meeting stage sharing** — Share the 3D viewer to the meeting stage. All participants can orbit, pan, and zoom the model independently — including external guests who are not in your organization.
- **Personal tab** — Pin the viewer in your Teams sidebar for quick access.
- **Channel tab** — Add the viewer to any channel. Configure which model to display per channel via the config page.

**Setup:**

1. Build the Teams app package:
   ```bash
   cd teams-app
   powershell.exe Compress-Archive -Path manifest.json,color.png,outline.png -DestinationPath realvirtual-web-teams.zip
   ```

2. Install in Teams:
   - **Personal**: Teams → Apps → Manage your apps → Upload a custom app → select the zip
   - **Organization-wide**: Teams Admin Center → Manage apps → Upload new app

3. Share in a meeting:
   - Click **Share** in the meeting toolbar
   - Select **realvirtual WEB** from the app list
   - The 3D viewer opens on the meeting stage for all participants

**Key points:**
- Only the person sharing needs the app installed — guests see it automatically on the meeting stage
- External participants (outside your org) can interact with the shared 3D viewer
- The app loads from `https://web.realvirtual.io/demo/` — public URL, no VPN required
- Teams SDK initialization is automatic when `?teams=1` is in the URL
- The `teams-app/` directory contains `manifest.json`, `color.png` (192x192), and `outline.png` (32x32)

**Configurable tabs** allow per-channel model selection. The config page (`teams-config.html`) lets users set a custom model URL when adding the tab to a channel.

## Shared Constants

Centralized numeric constants in `rv-constants.ts` replace magic numbers across the codebase:

| Constant | Value | Purpose |
|----------|-------|---------|
| `MM_TO_METERS` | `1000` | Unity mm → Three.js meters conversion factor |
| `DRAG_THRESHOLD_PX` | `8` | Min pixel distance before pointerdown→move is treated as drag |
| `DEFAULT_DPR_CAP` | `1.5` | Device pixel ratio cap to limit GPU load on HiDPI screens |
| `lastPathSegment(path)` | — | Extracts last segment from hierarchy path (`"Root/Child/Leaf"` → `"Leaf"`) |

## Context Menus

Plugin-extensible right-click context menus on 3D objects. Plugins register menu items via `ContextMenuStore`; items are filtered by condition callbacks at open time, labels can be dynamic functions, and errors in conditions are caught and treated as `false`.

```typescript
import { contextMenuStore } from './core/hmi/context-menu-store';

// Register items from a plugin
contextMenuStore.register({
  pluginId: 'my-plugin',
  items: [
    {
      id: 'focus',
      label: 'Focus Camera',
      action: (target) => viewer.focusByPath(target.path),
      order: 10,
    },
    {
      id: 'inspect',
      label: (target) => `Inspect ${target.path.split('/').pop()}`,
      condition: (target) => target.types.includes('Drive'),
      action: (target) => openInspector(target.path),
      order: 20,
    },
  ],
});

// Unregister on plugin dispose
contextMenuStore.unregister('my-plugin');
```

The context menu opens on right-click (with drag-distance guard) and touch long-press (500ms). It renders via MUI `<Menu>` in `ContextMenuLayer.tsx`.

## Extending

For wiring drives, sensors, transports, signals and AAS links onto a GLB
without touching the engine, use **Component Behaviors** —
see **[doc-behaviors.md](doc-behaviors.md)** (one TypeScript file per GLB
in `src/behaviors/`, auto-discovered, with a naming convention
(`Drive-Lin-Y`, `Transport-X`, …) and sidecar JSON as alternative wiring
paths — no Unity marker required).

See **[doc-extending-webviewer.md](doc-extending-webviewer.md)** for:
- Plugin development (lifecycle callbacks, UI slots, events)
- React hooks reference
- UI slot system and layout
- Chart panel integration
- Testing patterns
- Existing plugins reference

Plugins can read deployment config via `getAppConfig()` from `rv-app-config.ts` to adjust behavior based on `settings.json` values. Custom tooltips can be added via `tooltipRegistry.register()` — see [Tooltip System](#tooltip-system) above.
