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
npm test             # Run all 226 tests (headless Chromium)
npm run test:watch   # Watch mode (328 tests)
```

## Architecture

```
src/
├── main.ts                              # Entry: viewer creation, plugin registration, HMI init
├── rv-test-runner.ts                    # Dev-only in-browser test runner
├── core/
│   ├── rv-viewer.ts                     # RVViewer facade (scene, sim loop, plugins, events)
│   ├── rv-camera-manager.ts             # CameraManager (projection, animation, viewport offset)
│   ├── rv-visual-settings-manager.ts    # VisualSettingsManager (lighting, shadows, tone mapping)
│   ├── rv-plugin.ts                     # RVViewerPlugin interface (lifecycle + optional UI slots)
│   ├── rv-model-plugin-manager.ts       # Per-model dynamic plugin loading/unloading
│   ├── rv-events.ts                     # Typed EventEmitter<TEvents>
│   ├── rv-behavior.ts                    # RVBehavior abstract base class (MonoBehaviour-like)
│   ├── rv-ui-plugin.ts                  # UISlot types, UISlotEntry (with pluginId tracking)
│   ├── rv-ui-registry.ts               # UIPluginRegistry (slot component lookup, register/unregister)
│   ├── types/
│   │   └── plugin-types.ts             # Shared plugin API type definitions (decouples core↔plugins)
│   ├── engine/                          # Simulation engine subsystems
│   │   ├── rv-scene-loader.ts           # GLB loading, component construction, NodeRegistry population
│   │   ├── rv-node-registry.ts          # Centralized object discovery (path, type, hierarchy)
│   │   ├── rv-component-registry.ts     # Schema-based auto-mapping (Unity C# → TypeScript)
│   │   ├── rv-model-config.ts           # Model-specific plugin config (modelname.json + GLB extras)
│   │   ├── rv-plugin-loader.ts          # Dynamic ESM plugin loading (external .js plugins)
│   │   ├── rv-drive.ts                  # RVDrive (ported from Drive.cs)
│   │   ├── rv-drive-simple.ts           # RVDriveSimple (companion drive)
│   │   ├── rv-drive-cylinder.ts         # RVDriveCylinder (companion drive)
│   │   ├── rv-drives-playback.ts        # Frame-based recording playback
│   │   ├── rv-transport-manager.ts      # Sources → Transport → Sensors → Sinks
│   │   ├── rv-transport-surface.ts      # AABB-based conveyor surface
│   │   ├── rv-mu.ts                     # RVMovingUnit
│   │   ├── rv-source.ts                 # MU spawner (interval/distance modes)
│   │   ├── rv-sink.ts                   # MU consumer
│   │   ├── rv-sensor.ts                 # AABB overlap detection
│   │   ├── rv-aabb.ts                   # Axis-aligned bounding box
│   │   ├── rv-signal-store.ts           # PLC signal pub/sub store
│   │   ├── rv-signal-wiring.ts          # Signal routing (ConnectSignal)
│   │   ├── rv-connect-signal.ts         # Signal connection component
│   │   ├── rv-logic-step.ts             # LogicStep base + all step types
│   │   ├── rv-logic-engine.ts           # LogicStep tree builder from GLB extras
│   │   ├── rv-erratic.ts               # RVErraticDriver (random targets)
│   │   ├── rv-ring-buffer.ts            # Generic RingBuffer for history/stats
│   │   ├── rv-drive-recorder.ts         # Drive data recording
│   │   ├── rv-raycast-manager.ts        # Unified raycast system (hover, click, XR)
│   │   ├── rv-raycast-layers.ts        # Three.js layer constants for selective raycasting
│   │   ├── rv-drive-hover.ts            # Drive hover/click detection
│   │   ├── rv-highlight-manager.ts      # Object highlight overlays + edge glow
│   │   ├── rv-replay-recording.ts       # DrivesRecorder replay
│   │   ├── rv-simulation-loop.ts        # Fixed 60Hz accumulator loop (XR-compatible)
│   │   ├── rv-xr-manager.ts            # WebXR session management (VR/AR)
│   │   ├── rv-xr-hit-test.ts           # AR hit-test reticle
│   │   ├── rv-grip.ts                   # Gripping system
│   │   ├── rv-grip-target.ts            # Grip target positions
│   │   ├── rv-group-registry.ts         # Group definitions and visibility
│   │   ├── rv-physics-world.ts          # Rapier.js physics world wrapper
│   │   ├── rapier-physics-plugin.ts     # Physics-based transport (replaces kinematic)
│   │   ├── rv-constants.ts              # Shared numeric constants (MM_TO_METERS, DRAG_THRESHOLD_PX, etc.)
│   │   ├── rv-debug.ts                  # Structured category-based debug logging
│   │   └── rv-extras-validator.ts       # Dev-mode GLB extras parity checker
│   └── hmi/                             # React HMI layout components (MUI-based)
│       ├── rv-app-config.ts             # App config singleton (settings.json, lock mode, plugins)
│       ├── ui-context-store.ts          # Context-aware UI visibility (activateContext, useUIVisible)
│       ├── context-menu-store.ts        # Plugin-extensible right-click context menus
│       ├── visual-settings-store.ts     # Visual settings (shadows, light, cameras)
│       ├── physics-settings-store.ts    # Physics settings (Rapier.js)
│       ├── search-settings-store.ts     # Search/filter settings
│       ├── rv-storage-keys.ts           # Central localStorage key registry
│       ├── hmi-entry.ts                 # HMI initialization (React root)
│       ├── App.tsx                      # Root layout (minimal public shell)
│       ├── HMIShell.tsx                 # SlotRenderer for plugin UI
│       ├── KpiBar.tsx                   # Top KPI card container (slot: kpi-bar)
│       ├── ButtonPanel.tsx              # Left sidebar with nav buttons (slot: button-group)
│       ├── MessagePanel.tsx             # Right message panel (slot: messages)
│       ├── settings/                    # Settings panel tabs (extracted from TopBar)
│       │   ├── ModelTab.tsx             # Model/renderer selection
│       │   ├── VisualTab.tsx            # Lighting, shadows, tone mapping
│       │   ├── PhysicsTab.tsx           # Rapier.js toggle, gravity
│       │   ├── InterfacesTab.tsx        # WebSocket/MQTT/ctrlX config
│       │   ├── DevToolsTab.tsx          # FPS, benchmarks, debug
│       │   └── TestsTab.tsx             # Feature test runner
│       ├── TopBar.tsx, BottomBar.tsx     # Top/bottom bars
│       ├── KpiCard.tsx, TileCard.tsx     # Reusable card components
│       ├── ChartPanel.tsx               # Draggable/resizable chart overlay
│       ├── LeftPanel.tsx                # Standardized docked left panel
│       ├── LayoutLibraryPanel.tsx       # Layout planner library panel (multi-tab)
│       ├── MachineControlPanel.tsx      # Machine start/stop/mode control
│       ├── MaintenancePanel.tsx         # Maintenance step guides
│       ├── GroupsOverlay.tsx            # Group visibility toggles
│       ├── left-panel-manager.ts        # LeftPanel mutual exclusion coordinator
│       ├── layout-constants.ts          # Shared positioning constants
│       ├── shared-sx.ts                 # Reusable MUI sx style fragments
│       ├── chart-theme.ts              # Shared ECharts theme constants
│       ├── chart-constants.ts           # Chart color/size constants
│       ├── group-visibility-store.ts    # Group visibility state
│       └── tooltip/                     # Generic tooltip system
│           ├── tooltip-store.ts         # TooltipStore (useSyncExternalStore, priority resolution)
│           ├── tooltip-registry.ts      # TooltipContentRegistry (content type → React component)
│           ├── tooltip-utils.ts         # 3D→screen projection, viewport clamping
│           ├── TooltipLayer.tsx         # Tooltip renderer (glassmorphism, cursor/world/fixed)
│           ├── DriveTooltipController.tsx # Headless bridge: drive hover → tooltip store
│           ├── DriveTooltipContent.tsx   # Drive tooltip content (name, speed, position)
│           └── index.ts                 # Barrel export
├── private-stubs/                       # No-op fallbacks when private folder absent
│   ├── private-plugins.ts              # export function registerPrivatePlugins() {} // no-op
│   └── custom/
│       └── hmi-entry.tsx               # Mounts core/hmi/App.tsx
├── interfaces/                          # Industrial interface plugins
│   ├── interface-manager.ts             # Interface coordinator (mutex, auto-connect)
│   ├── interface-settings-store.ts      # Interface settings (WS, MQTT, ctrlX)
│   ├── base-industrial-interface.ts     # Abstract interface base class
│   ├── websocket-realtime-interface.ts  # WebSocket Realtime protocol
│   └── ctrlx-interface.ts              # Bosch Rexroth ctrlX protocol
├── plugins/                             # Plugin implementations
│   ├── sensor-monitor-plugin.ts         # Event-based sensor monitoring (core)
│   ├── transport-stats-plugin.ts        # Transport statistics (10Hz RingBuffer, core)
│   ├── camera-events-plugin.ts          # Camera animation done events (core)
│   ├── drive-order-plugin.ts            # Topological drive sorting for CAM/Gear (core)
│   ├── multiuser-plugin.ts             # Multi-user presence + avatars
│   ├── webxr-plugin.ts                 # WebXR VR/AR support
│   ├── fpv-plugin.tsx                  # First-person view navigation
│   ├── annotation-plugin.ts            # 3D markers, labels, drawing
│   ├── mcp-bridge-plugin.ts            # Claude MCP WebSocket bridge (dev)
│   ├── debug-endpoint-plugin.ts        # Debug HTTP endpoint (dev)
│   ├── demo/                            # Demo model plugins (loaded per-model)
│   │   ├── index.ts                    # Barrel exports (no global registration)
│   │   ├── kpi-demo-plugin.ts          # OEE/Parts/CycleTime demo data
│   │   ├── demo-hmi-plugin.tsx         # Demo KPI cards, buttons, messages
│   │   ├── DriveChartOverlay.tsx       # Real-time drive position/speed chart
│   │   ├── SensorChartOverlay.tsx      # Real-time sensor timeline chart
│   │   ├── OeeChart.tsx               # OEE breakdown chart
│   │   ├── PartsChart.tsx             # Parts per hour chart
│   │   ├── CycleTimeChart.tsx         # Cycle time scatter chart
│   │   ├── EnergyChart.tsx            # Power consumption chart
│   │   ├── test-axes-plugin.tsx        # Manual axis control slider
│   │   ├── machine-control-plugin.ts   # Machine start/stop panel
│   │   ├── maintenance-plugin.ts       # Maintenance checklists
│   │   └── perf-test-plugin.ts         # Performance benchmarking (?perf)
│   └── models/                          # Per-model plugin entry points
│       └── DemoRealvirtualWeb/
│           └── index.ts                # Registers all demo model plugins
├── hooks/                               # React hooks
│   ├── use-viewer.ts                    # RVViewer context access
│   ├── use-plugin.ts                    # usePlugin<T>(id) for type-safe plugin access
│   ├── use-simulation-event.ts          # Event subscription with auto-cleanup
│   ├── use-slot.ts                      # useSlot(slot) for UI rendering
│   ├── use-sensor-state.ts              # Event-based sensor state
│   ├── use-transport-stats.ts           # Transport counters
│   ├── use-drives.ts                    # Drive list and hover state
│   ├── use-drive-chart.ts              # Drive chart toggle
│   ├── use-drive-filter.ts             # Drive search/filter
│   ├── use-signal.ts                    # Signal store subscriptions
│   ├── use-tooltip.ts                   # useTooltipState() hook
│   ├── use-mobile-layout.ts            # Mobile detection
│   ├── use-multiuser.ts                # Multiuser state
│   ├── use-machine-control.ts          # Machine control state
│   ├── use-maintenance-mode.ts         # Maintenance mode state
│   ├── use-groups-overlay.ts           # Group visibility
│   └── use-interface-status.ts          # Interface connection status
└── tests/
    ├── glb-extras.test.ts               # GLB structure (21 tests)
    ├── rv-node-registry.test.ts         # NodeRegistry (34 tests)
    ├── rv-transport.test.ts             # Transport simulation (17 tests)
    ├── rv-logic-steps.test.ts           # LogicStep sequencing (33 tests)
    ├── rv-signal-store.test.ts          # Signal pub/sub (23 tests)
    ├── rv-drives-playback.test.ts       # Recording playback (10 tests)
    ├── rv-aabb.test.ts                  # AABB collision (7 tests)
    ├── rv-events-typed.test.ts          # Typed EventEmitter (7 tests)
    ├── rv-plugin-lifecycle.test.ts      # Plugin lifecycle (8 tests)
    ├── rv-sensor-monitor-plugin.test.ts # SensorMonitor (6 tests)
    ├── rv-ui-registry.test.ts           # UI registry (5 tests)
    ├── rv-simulation-loop-xr.test.ts    # SimLoop XR compat (5 tests)
    ├── rv-xr-manager.test.ts            # XR platform detection (8 tests)
    ├── rv-xr-hit-test.test.ts           # AR hit-test (5 tests)
    ├── kpi-utils.test.ts                # KPI utilities (40 tests)
    ├── rv-step-serializer.test.ts       # LogicStep serializer (5 tests)
    ├── rv-app-config.test.ts            # App config, lock mode, store overrides (15 tests)
    ├── rv-model-config.test.ts          # Model config, plugin activation modes (25 tests)
    ├── rv-component-registry.test.ts    # Component auto-mapping (tests)
    ├── rv-group-registry.test.ts        # Group parsing/registry (tests)
    ├── rv-layout-store.test.ts          # Layout planner store (16 tests)
    ├── rv-layout-persistence.test.ts    # Layout JSON serialization (5 tests)
    ├── rv-layout-grid.test.ts           # Grid snap math (7 tests)
    ├── rv-layout-model-cache.test.ts    # GLB model cache (6 tests)
    ├── rv-layout-bounds.test.ts         # Floor alignment (4 tests)
    ├── rv-layout-lifecycle.test.ts      # Layout plugin lifecycle (6 tests)
    ├── rv-layout-localstorage.test.ts   # Layout localStorage persistence (8 tests)
    └── ...                              # Additional test suites (67 files total, 900+ tests)
```

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
      5. Transport           — Sources → Surfaces → Sensors → Sinks (or Rapier physics)
      6. Plugins Post        — Sample data (SensorMonitor, TransportStats, DriveRecorder)
      7. Plugins Render      — Camera events, visual overlays
```

## Plugin System

All extensions use the `RVViewerPlugin` interface. For convenience, extend `RVBehavior` — a MonoBehaviour-like abstract base class that manages viewer lifecycle, provides getters for drives/sensors/signals, and handles cleanup:

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
  .use(rapierPlugin)
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
| **ALL-MODE** | No `rv_plugins` declared anywhere | All registered plugins receive `onModelLoaded` (backward compatible) |
| **SELECTIVE-MODE** | `rv_plugins` declared in modelname.json, GLB extras, or settings.json | Only declared plugins + `core: true` plugins activate |

In selective mode, core plugins (physics, drive sorting, sensor monitoring) always activate regardless of the `rv_plugins` list. This ensures essential infrastructure is never accidentally disabled.

See **[Model-Specific Plugin Configuration](#model-specific-plugin-configuration)** for how to declare `rv_plugins`.

Plugins with `slots` automatically register React components into HMI layout positions (kpi-bar, button-group, messages, views, search-bar, settings-tab).

### Plugin Tiers

| Tier | Loaded when | Can be removed | Examples |
|------|------------|----------------|----------|
| **Core** (`core: true`) | Always — survive model switches | No (`removePlugin()` blocked) | drive-order, sensor-monitor, transport-stats, camera-events, rapier-physics, extras-editor |
| **Global Private** | Always when private folder present | Yes | layout-planner, des-plugin, des-hmi |
| **Model-Specific** | Only when matching GLB is loaded | Yes (auto-removed on model switch) | kpi-demo, demo-hmi, webxr, multiuser, fpv, annotations |

Model-specific plugins are defined in `plugins/index.ts` files per model folder. The `ModelPluginManager` auto-discovers them via `import.meta.glob` and loads/unloads them when models are switched. See **[doc-extending-webviewer.md](doc-extending-webviewer.md) § Per-Model Plugin System** for how to create model-specific plugins.

See **[doc-extending-webviewer.md](doc-extending-webviewer.md)** for detailed plugin development guide, UI slot system, event bus, hooks reference, and examples.

## Simulation Features

### Transport
Non-physics AABB-based transport (or Rapier.js physics when enabled). Sources spawn MUs, transport surfaces move them, sensors detect overlap, sinks consume.

### LogicStep Engine
Port of Unity's LogicStep sequencing: SerialContainer, ParallelContainer, SetSignalBool, WaitForSignalBool, WaitForSensor, Delay, DriveToPosition, SetDriveSpeed, Enable.

### Signal Store
Central pub/sub for PLC signals (bool/int/float) with two lookup tables:
- **By name** (primary) — Signal.Name if set, otherwise node name (GameObject name). Used by plugins and HMI.
- **By path** (secondary) — Full hierarchy path. Used by GLB object references (ComponentRef) and internal bindings.

Change-only notification. Batch semantics for `setMany()`.

### Drive Physics
Ported from Drive.cs — acceleration/deceleration, position limits, rotation and linear movement. CAM/Gear master-slave dependencies resolved via topological sort.

### Raycast System

Unified raycast pipeline (`rv-raycast-manager.ts`) consolidates drive hover, scene click, and XR controller raycasting into a single Three.js `Raycaster` with **layer-based filtering**.

**Layer Architecture** (`rv-raycast-layers.ts`):
| Layer | Bit | Purpose |
|-------|-----|---------|
| DEFAULT | 0 | Standard Three.js rendering layer |
| DRIVE | 1 | Drive meshes |
| SENSOR | 2 | Sensor meshes |
| MU | 3 | Moving Unit meshes |
| METADATA | 4 | Metadata nodes |
| SCENE_CLICK | 5 | General scene click targets |

Layers are hardware-level bit-mask filters (zero-cost, no array iteration). Each node type gets its own layer. Plugins register targets via `registerTargets()`, and the raycaster only tests meshes on enabled layers.

**Key features:**
- **Pointer hover**: Throttled at 50ms, walks up from hit mesh to find nearest ancestor with `realvirtual` userData
- **XR controller ray**: `updateFromXRController(origin, direction)` for VR/AR controller raycasting
- **AR tap selection**: 9-point sampling (`arTapRaycast()`) for touch tolerance on mobile AR
- **Click detection**: `raycastForRVNode(e)` for scene click without altering hover state
- **Exclude filters**: Skip highlight overlays, sensor viz meshes, and custom exclusions
- **Highlight integration**: Automatic orange overlay + edge glow via `RVHighlightManager`

**Highlight Manager** (`rv-highlight-manager.ts`):
- Semi-transparent orange fill overlay + glowing edge outlines
- Cached `EdgesGeometry` (WeakMap) for GC-free repeated highlights
- Two modes: static snapshot (brief hover) and tracked (overlays follow moving meshes)
- Single highlight slot — calling `highlight()` replaces the previous one

**Events emitted:**
- `object-hover` — `{ node, nodeType, nodePath, pointer, mesh }`
- `object-unhover` — `{ node, nodeType }`

### Tooltip System

Generic, extensible tooltip system (`core/hmi/tooltip/`) with content-type registry pattern. Decoupled from specific component types — new tooltip providers (sensor, MU, etc.) can be added without modifying the core.

**Architecture:**

```
Controller (headless)  →  TooltipStore (singleton)  →  TooltipLayer (renderer)
                                                            ↓
                                                    TooltipContentRegistry
                                                            ↓
                                                    Content Provider (React)
```

**Three positioning modes:**
- **cursor** — Follows mouse pointer (ref-based updates, no React re-render on move)
- **world** — Projects a 3D `Object3D` to screen coordinates (for focused/selected objects)
- **fixed** — Uses a fixed screen position

**Key design decisions:**
- **Data-only store**: Holds typed data objects, not ReactNodes (avoids re-render storms)
- **Shallow-compare guard**: `show()` only notifies React when data fields actually change
- **Cursor position is ref-based**: Updated via `getCursorPos()`, polled at 100ms — not in React state
- **Priority resolution**: When multiple tooltips are active, highest priority wins
- **useSyncExternalStore**: React 18+ pattern for efficient subscription without cascading renders

**Built-in: Drive Tooltip**

`DriveTooltipController` (headless) bridges drive hover/focus state to `tooltipStore.show()/hide()`. `DriveTooltipContent` renders drive name, direction, position, speed (exponential moving average), target, and limits.

**Adding a new tooltip type** (e.g., Sensor):

```typescript
// 1. Create content provider — self-registers at module import
import { tooltipRegistry } from './core/hmi/tooltip';

function SensorTooltipContent({ data, viewer }: TooltipContentProps) {
  return <Typography>{data.sensorName}: {data.occupied ? 'Occupied' : 'Free'}</Typography>;
}
tooltipRegistry.register({ contentType: 'sensor', component: SensorTooltipContent });

// 2. Create controller (headless React component)
function SensorTooltipController() {
  useEffect(() => {
    // On sensor hover:
    tooltipStore.show({
      id: 'sensor',
      data: { type: 'sensor', sensorName: 'MySensor', occupied: true },
      mode: 'cursor',
      cursorPos: { x: clientX, y: clientY },
      priority: 10,
    });
    // On unhover:
    tooltipStore.hide('sensor');
  }, [/* deps */]);
  return null;
}

// 3. Import content module in App.tsx (triggers self-registration)
import './core/hmi/tooltip/SensorTooltipContent';
```

**React hook:**
```typescript
import { useTooltipState } from './hooks/use-tooltip';
const { active } = useTooltipState();  // current tooltip or null
```

### WebXR (VR/AR)
VR on Quest, Vision Pro, PCVR. AR with hit-test surface detection and model placement. Uses `setAnimationLoop` for XR frame callback.

## Renderer Support

- **WebGL** (default): Stable, all browsers
- **WebGPU**: Three.js r171+ `WebGPURenderer` with WebGL2 fallback

Selection persists via URL parameter (`?renderer=webgpu`) or localStorage.

## Deployment Configuration (settings.json)

Place a `settings.json` in `public/` (or next to `index.html` in production) to configure the viewer at deployment level. The file is fetched with cache-busting before React mounts, so settings apply immediately without flicker.

A documented example is provided in `public/settings.example.json` — copy it to `public/settings.json` and edit as needed.

### Settings Priority

```
URL Params  >  settings.json  >  localStorage  >  Code DEFAULTS
```

Each settings store (`visual`, `physics`, `search`, `interface`) follows this 3-layer merge:
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
  "physics": {
    "enabled": false
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
- **`lockedTabs: ["physics", "interfaces"]`** — Hides only specific tabs in the Settings dialog. The gear button remains visible for unlocked tabs.
- **`hideWelcomeModal: true`** — Suppresses the welcome/about dialog on first visit.
- **`defaultModel: "models/demo.glb"`** — Pre-selects a model on load (can be a filename or full URL).

`lockSettings` is an admin override — it only comes from `settings.json` or the `?lockSettings` URL param, never from localStorage.

### Context Visibility Overrides

Control which HMI elements are visible or hidden based on active "contexts" (e.g. `fpv`, `planner`, `maintenance`, `xr`, `kiosk`). Rules are declared per UI element with `hiddenIn` and `shownOnlyIn`:

```json
{
  "uiVisibility": {
    "kpi-bar":      { "hiddenIn": ["fpv", "xr"] },
    "bottom-bar":   { "hiddenIn": ["fpv", "xr", "planner"] },
    "button-panel": { "hiddenIn": ["xr"] },
    "top-bar":      { "hiddenIn": ["xr"] },
    "messages":     { "hiddenIn": ["fpv", "planner"] },
    "views":        { "hiddenIn": ["fpv", "planner"] },
    "kiosk-overlay": { "shownOnlyIn": ["kiosk"] }
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

### API (for plugins/custom code)

```typescript
import { getAppConfig, isSettingsLocked, isTabLocked } from './core/hmi/rv-app-config';

// Read config values
const config = getAppConfig();
if (config.interface?.autoConnect) { /* ... */ }

// Check lock state
if (isSettingsLocked()) { /* hide settings UI */ }
if (isTabLocked('physics')) { /* hide physics tab */ }
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
- Core plugins (`core: true`) cannot be disabled
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

**328 tests** running in real Chromium via Vitest v4 + Playwright:

```bash
npm test              # All tests, headless
npm run test:watch    # Watch mode
npx tsc --noEmit     # Type check only
```

Test GLB: Export from Unity demo scene → `public/models/tests.glb`.

| Suite | Tests | Validates |
|-------|-------|-----------|
| GLB structure | 21 | File loads, extras, component properties |
| NodeRegistry | 34 | Path computation, type queries, hierarchy traversal |
| Transport | 17 | Linear/radial movement, MU lifecycle, surface transfer |
| LogicSteps | 33 | All step types, containers, looping, integration |
| SignalStore | 23 | Pub/sub, name/path access, change notification, bulk updates |
| DrivesPlayback | 10 | Frame advancement, looping, seeking |
| KPI utils | 40 | Formatting, calculations, edge cases |
| AABB | 7 | Overlap, position update, X-flip |
| EventEmitter | 7 | Typed events, unsubscribe, custom events |
| Plugin Lifecycle | 8 | Order, retroactive load, exception isolation |
| SensorMonitor | 6 | onChanged callback, RingBuffer |
| UI Registry | 5 | Slot registration, order sorting |
| SimLoop XR | 5 | setAnimationLoop, frame clamping |
| XR Manager | 8 | Platform detection, WebGPU guard |
| XR Hit-Test | 5 | Reticle, placement, dispose |
| Step Serializer | 5 | RVLogicStep to RVStepNode conversion |
| App Config | 15 | Fetch fallbacks, lock guards, config override merge, store integration |

## Debug Logging

Category-based structured logging via `rv-debug.ts`. Zero overhead in production.

```
?debug=all              # URL parameter
?debug=playback,loader  # Specific categories
```

Categories: `loader`, `playback`, `drive`, `transport`, `sensor`, `logic`, `signal`, `erratic`, `parity`

## Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| three | ^0.171.0 | 3D rendering (WebGL + WebGPU + WebXR) |
| @dimforge/rapier3d-compat | ^0.14.0 | Physics engine (WASM) |
| react + react-dom | ^19 | HMI overlay |
| @mui/material | ^7 | UI components |
| echarts | ^5 | Charts |
| vite | ^6.1.0 | Build tool + dev server |
| vitest | ^4 | Test runner |
| typescript | ^5.7 | Compiler |

## Camera Controls

- **Right mouse**: Orbit
- **Middle mouse**: Pan
- **Scroll**: Zoom
- Damping enabled (factor 0.08)
- Auto-fit to model bounding box after load

## Known Limitations

- `controllerScale` hardcoded to 1000 (mm→m)
- Only `Drive_ErraticPosition` behavior animated (other DriveBehaviours not ported)
- Materials may differ from Unity URP (PBR mapping differences)
- OnSignal spawn mode not implemented for Sources

## Multiuser

realvirtual WEB supports real-time multiuser sessions where multiple users see each other as avatars in the same 3D scene. Each user's camera position is shared and rendered as a colored sphere with a name label.

### Quick Start

1. Add the `MultiplayerWEB` component to any GameObject in your Unity scene
2. Press Play — the WebSocket server starts on Port 7000
3. Open the WebViewer, click the Multiuser button in the top bar
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

Use the standalone relay server for sessions without a running Unity instance:

```bash
cd relay
npm start -- --port 7000 --model ./model.glb
```

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

See **[doc-extending-webviewer.md](doc-extending-webviewer.md)** for:
- Plugin development (lifecycle callbacks, UI slots, events)
- React hooks reference
- UI slot system and layout
- Chart panel integration
- Testing patterns
- Existing plugins reference

Plugins can read deployment config via `getAppConfig()` from `rv-app-config.ts` to adjust behavior based on `settings.json` values. Custom tooltips can be added via `tooltipRegistry.register()` — see [Tooltip System](#tooltip-system) above.
