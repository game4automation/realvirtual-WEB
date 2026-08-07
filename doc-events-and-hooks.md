# Events & Hooks — Developer Reference

Overview of all extension points where custom logic can hook into realvirtual WEB.
For plugin basics see [doc-extending-webviewer.md](doc-extending-webviewer.md), for the render/sim loop see [doc-lifecycle.md](doc-lifecycle.md).

---

## Overview — Which hook for which purpose?

| I want to… | Use | Source |
|---|---|---|
| React to viewer state (model loaded, pause, selection, …) | **ViewerEvent** via `viewer.on(...)` | [rv-viewer-events.ts](src/core/rv-viewer-events.ts) (the `ViewerEvents` catalog), [rv-events.ts](src/core/rv-events.ts) (the `EventEmitter`), [rv-viewer.ts](src/core/rv-viewer.ts) |
| Run on every 60-Hz tick (read signals, set drives) | **Plugin-Lifecycle** (`onFixedUpdatePre/Post`) | [rv-plugin.ts](src/core/rv-plugin.ts) |
| React to hover/click/selection per 3D component | **Component-Callback** (`onHover/onClick/onSelect`) | [rv-component-registry.ts](src/core/engine/rv-component-registry.ts) |
| Bind custom React UI to viewer state | **React Hook** from [src/hooks/](src/hooks/) | – |
| Emit a custom event via the pub/sub system | `viewer.emit('custom-event', payload)` | EventEmitter is untyped-extensible |

---

## 1. Plugin Lifecycle Hooks

Plugins implement `RVViewerPlugin` and are registered with `viewer.use(plugin)`. Every callback is `try/catch`-isolated — a faulty plugin cannot freeze the simulation.

```ts
import type { RVViewerPlugin } from './core/rv-plugin';

const myPlugin: RVViewerPlugin = {
  id: 'my-plugin',
  order: 100,                // lower = earlier
  onModelLoaded(result, v) { /* after GLB load */ },
  onFixedUpdatePre(dt)    { /* set drive targets */ },
  onFixedUpdatePost(dt)   { /* read sim results */ },
  onRender(dt)            { /* after renderer.render() */ },
  dispose()               { /* cleanup */ },
};

viewer.use(myPlugin);
```

### Complete Callback Table

| Callback | When | Typical Use |
|---|---|---|
| `init(viewer, context?)` | When the plugin is registered via `viewer.use(plugin)` (before any model load) | Initialize plugin state, store the viewer reference, establish connections |
| `onModelLoaded(result, viewer)` | After GLB load, before the `'model-loaded'` event. Also called retroactively for plugins registered after a model is already loaded — **except** when the plugin is disabled or declares `modes` and none is active; then the call is parked and replayed on the mode transition that enables it. | Find components, initialize custom managers |
| `onModelCleared(viewer)` | At the start of `clearModel()`, **before** state reset | Clear own caches |
| `onConnectionStateChanged(state, viewer)` | When `viewer.setConnectionState(...)` changes | Pause/resume polling |
| `onFixedUpdatePre(dt)` | 60 Hz, **before** drive physics & transport | Drive targets, ErraticDriver, replay, CAM |
| `onFixedUpdatePost(dt)` | 60 Hz, **after** drive physics & transport | DriveRecorder, SensorMonitor, KPIs |
| `onRender(frameDt)` | Per render frame, **after** `renderer.render()` | Custom overlays, post effects |
| `onModeActivate(mode, viewer)` | When entering a workspace mode this plugin participates in | Install mode-specific scene overlays, interaction handlers, raycast filters, gizmos |
| `onModeDeactivate(mode, viewer)` | When leaving such a mode, before the plugin is disabled (scene/model still valid). `mode` is `null` only in unusual boot edge cases. | Tear down everything created in onModeActivate |
| `onRenderBackendChanged(backend, viewer)` | When the active 3D render backend changes (plan-256), e.g. `'three'` → `'omniverse'` | Tear down open gizmos / drag handlers — Three interaction is meaningless under a non-Three backend |
| `dispose()` | Viewer is destroyed | Clean up listeners / DOM |

### Plugin Properties

| Property | Meaning |
|---|---|
| `id` | Unique ID (e.g. `'drive-recorder'`) |
| `order` | Sort order in pre/post/render lists (default `100`) |
| `handlesTransport` | When `true`: kinematic transport manager is skipped |
| `core` | When `true`: plugin always runs even in selective mode |
| `modes` | Workspace modes this plugin participates in. `undefined` (default) = the plugin is shared and active in every mode. When set (e.g. `['planner']` or `['des','hmi']`) the plugin and its UI slots are active only while one of those modes is active. |
| `slots` | Array of `UISlotEntry` — automatic registration in HMI slots |

---

## 2. ViewerEvents — Pub/Sub

`RVViewer` extends `EventEmitter<ViewerEvents>`. Registering via `viewer.on(event, cb)` returns an **unsubscribe function**.

The canonical import path for `ViewerEvents` is:

```ts
import type { ViewerEvents } from './core/rv-viewer-events';
```

```ts
const off = viewer.on('object-hover', (data) => {
  if (data?.nodeType === 'Drive') console.log(data.nodePath);
});
off();                          // unsubscribe

viewer.once('model-loaded', ({ result }) => { /* fires once only */ });
```

### Event Catalog

#### Model / Scene Lifecycle
| Event | Payload | Who fires |
|---|---|---|
| `model-loaded` | `{ result: LoadResult }` | `RVViewer.loadModel()` |
| `model-cleared` | `void` | `RVViewer.clearModel()` |
| `scene-loaded` | `{ scene: RvScene }` | `RVViewer.loadScene()` — after GLB + overlay + placements |

#### Component Lifecycle (generic)

All components — drives, sensors, MUs, and plugin-owned types — report runtime state changes via a **single** generic event. New component types do not need to extend `ViewerEvents`.

| Event | Payload |
|---|---|
| `component-event` | `{ componentType: string; kind: string; path: string; payload?: unknown }` |

Known combinations:

| `componentType` | `kind` | `payload` | Who fires |
|---|---|---|---|
| `sensor` | `changed` | `{ occupied: boolean }` | [sensor-monitor-plugin.ts](src/plugins/sensor-monitor-plugin.ts) |
| `mu` | `spawned` | `{ totalSpawned: number }` | [transport-stats-plugin.ts](src/plugins/transport-stats-plugin.ts) |
| `mu` | `consumed` | `{ totalConsumed: number }` | [transport-stats-plugin.ts](src/plugins/transport-stats-plugin.ts) |
| `drive` | `at-target` | `{ position: number }` | Declared as a known kind in [rv-viewer-events.ts](src/core/rv-viewer-events.ts); no core emitter today — subscribe defensively |

Plugins can emit arbitrary `componentType` / `kind` combinations without modifying the core.

#### HMI Panel States for Drives / Nodes / Sensors

| Event | Payload |
|---|---|
| `drive-chart-toggle` | `{ open: boolean }` |
| `drive-filter` | `{ filter: string; filteredDrives: RVDrive[] }` |
| `sensor-chart-toggle` | `{ open: boolean }` |
| `node-filter` | `{ filter; filteredNodes; tooMany: boolean }` |

#### Interfaces (PLC connectivity)
| Event | Payload |
|---|---|
| `interface-connected` | `{ interfaceId; type }` |
| `interface-disconnected` | `{ interfaceId; reason? }` |
| `interface-error` | `{ interfaceId; error }` |
| `interface-data` | `{ interfaceId; signals: Record<string, unknown> }` |
| `connection-state-changed` | `{ state: 'Connected' \| 'Disconnected'; previous }` |

#### Generic Raycast & Selection Events
| Event | Payload |
|---|---|
| `object-hover` | `ObjectHoverData \| null` |
| `object-unhover` | `ObjectUnhoverData` |
| `object-click` | `ObjectClickData` (declared, see `object-clicked`) |
| `object-clicked` | `{ path: string; node: Object3D; hitPoint?: [number, number, number] }` |
| `object-focus` | `{ path: string; node: Object3D; openInspector?: boolean }` — `openInspector === false` (F shortcut) frames the camera only |
| `object-blur` | `void` — previous focus pin was cleared (`clearFocus()`) |
| `selection-changed` | `SelectionSnapshot` |
| `context-menu-request` | `{ pos: {x,y}; path; node }` |
| `camera-animation-done` | `{ targetPath? }` |

#### UI Panels & Overlays
| Event | Payload |
|---|---|
| `panel-opened` / `panel-closed` | `{ panelId: string }` |
| `groups-overlay-toggle` | `{ open: boolean }` |
| `exclusive-hover-mode` | `{ mode: HoverableType \| null }` |
| `safety-door:show-all` | `{ show: boolean }` |

#### Simulation Pause
| Event | Payload |
|---|---|
| `simulation-pause-changed` | `{ paused; reasons: readonly string[]; reason: string }` |

> Fired **only** on the idle ↔ paused transition, not when additional reasons are added.

#### XR / VR / AR
| Event | Payload |
|---|---|
| `xr-session-start` / `xr-session-end` | `void` |
| `xr-hit-test` | `{ position: Float32Array; matrix: Float32Array }` |
| `xr-controller-select` | `{ hand: 'left' \| 'right'; position: {x,y,z} }` |

#### Miscellaneous
| Event | Payload |
|---|---|
| `fpv-enter` / `fpv-exit` | `void` |
| `multiuser-changed` | `MultiuserSnapshot` |
| `mcp-bridge-changed` | `McpBridgeSnapshot` |
| `layout-transform-update` | `{ path; position; rotation; scale?; visible? }` |

### Emitting Custom Events

`EventEmitter` can be used both typed (via `ViewerEvents`) and untyped:

```ts
viewer.emit('my-plugin:metric-update', { kpi: 42 });
viewer.on('my-plugin:metric-update', (data) => { /* … */ });
```

---

## 3. Component Lifecycle Hooks

Every 3D component (`RVDrive`, `RVSensor`, …) implements `RVComponent` from [rv-component-registry.ts](src/core/engine/rv-component-registry.ts).

| Method | When |
|---|---|
| `init(ctx)` | During construction, after schema mapping from the GLB `rv_extras` |
| `onSceneReady?(ctx)` | Second init phase **after** kinematic reparenting (Phase 8b) |
| `dispose?()` | During `clearModel()` |
| `onOwnershipChanged?(isOwner)` | Multiuser: server takes over / releases authority |
| `onHover?(hovered, event?)` | Raycast — node enters / leaves hover |
| `onClick?(event)` | Click on the node |
| `onSelect?(selected)` | Node enters / leaves selection |
| `getLiveState?()` | Returns the component's authoritative current runtime values (source of truth for the inspector, hierarchy badges, tooltips) |
| `setLiveField?(fieldName, value)` | Applies an inspector edit to live runtime state immediately; return true if handled, false to fall back to generic assignment |

### What `ComponentContext` actually carries

**There is no `ctx.viewer`.** A component never gets the viewer pointer — that is the point of the
context. It receives a fixed set of collaborators, split into always-present and optional
([rv-component-registry.ts](src/core/engine/rv-component-registry.ts)):

| Always present | Optional (null-check before use) |
|---|---|
| `registry` (`NodeRegistry`) | `gizmoManager` — overlay gizmos (`GizmoOverlayManager`) |
| `signalStore` (`SignalStore`) | `lampManager` — fixed-update lamp flashing |
| `scene` (`THREE.Scene`) | `outlineManager` — the OutlinePass wrapper |
| `transportManager` (`RVTransportManager`) | `errorStore` — central error/alarm registry |
| `root` (`Object3D`, the loaded GLB root) | `instructionStore` — runtime-instruction registry |
| | `componentEventDispatcher` — hover/click/select routing |
| | `events` — `EventEmitter<ViewerEvents>` |
| | `energyChainManager` — energy-chain rigs (plan-362) |
| | `collisionManager` — `CollisionRole` registrar (plan-394) |
| | `expectSceneReady` — `true` when `onSceneReady()` will still run on this load path |

Note that `events` and `componentEventDispatcher` are **optional**, so a component that wants to
emit a `component-event` must guard the call. `expectSceneReady` is the flag that tells a component
which freeze it may do in `init()`: on the paths that set it, kinematic re-parenting still happens
between `init()` and `onSceneReady()`, so anything capturing a bind frame must wait for the second
pass.

```ts
class MyComponent implements RVComponent {
  readonly node: Object3D;
  isOwner = true;

  init(ctx: ComponentContext) {
    ctx.signalStore.subscribe('Conveyor1.Start', (v) => { /* … */ });
    ctx.events?.emit('component-event', {          // optional — guard it
      componentType: 'my-component', kind: 'ready',
      path: ctx.registry.getPathForNode(this.node) ?? '',
    });
  }
  onHover(hovered: boolean) { /* highlight on/off */ }
  dispose() { /* cleanup */ }
}
```

---

## 4. React Hooks (HMI Layer)

All hooks live in [src/hooks/](src/hooks/). Pattern: every hook requires the `RVViewer` context (`useViewer()`).

### Generic Hooks

| Hook | Purpose |
|---|---|
| `useViewer()` | Get the current `RVViewer` from React context |
| `useViewerEvent(event, initial, select)` | Subscribe to a typed viewer event, derive a value |
| `useSimulationEvent(event, …)` | Specialized for sim events |
| `usePlugin<T>(id)` | Get a plugin instance by ID |
| `useSlot(slotId)` | Render / query a UI slot |
| `useEditorPlugin()` / `useEditorState()` | Editor / planner state |

### Signals

| Hook | Purpose |
|---|---|
| `useSignal(path)` | Read the current signal value (re-renders on change) |
| `useSignalTick(path)` | Tick counter — for performance-critical subscriptions |
| `useSignalWrite(path)` | Write function for a signal |

### Drives, Sensors, MUs

| Hook | Purpose |
|---|---|
| `useDrives()` | List of all drives |
| `useHoveredDrive()` / `useFocusedDrive()` | Currently hovered / focused drive |
| `useDriveFilter()` / `useDriveChartOpen()` | Drive filter, chart state |
| `useSensorState()` / `useSensorChartOpen()` | Sensor states |
| `useTransportStats()` | Aggregated transport KPIs |

### Interaction & UI

| Hook | Purpose |
|---|---|
| `useHoveredObject()` | Generic hover state |
| `useSelection()` | Selection snapshot |
| `useTooltipState()` | Tooltip state |
| `useLongPress()` | Long-press detection (touch) |
| `useMobileLayout()` / `useTouchDevice()` | Responsive layout |
| `useNodeFilter()` | Node search filter |
| `useGroupsOverlayOpen()` | Groups overlay state |

### Status & Data

| Hook | Purpose |
|---|---|
| `useInterfaceStatus()` | Status of all interfaces |
| `useKpiData()` | KPI slot data |
| `useMaintenanceMode()` | Maintenance mode state |
| `useMachineControl()` | Machine control panel state |
| `useMultiuser()` | Multiuser snapshot |
| `useMcpBridge()` | MCP bridge status |
| `useInstruction()` / `useInstructionsBySource()` | Displayed instructions |
| `useCameraStartPos()` | Camera start position |
| `useEChart()` | ECharts setup helper |

### Example — Binding custom UI to events

```tsx
import { useViewerEvent } from './hooks/use-viewer-event';

export function MyHud() {
  const filter = useViewerEvent('drive-filter', '', (d) => d.filter);
  const paused = useViewerEvent(
    'simulation-pause-changed',
    false,
    (d) => d.paused,
  );
  return <div>{paused ? 'PAUSED' : `Filter: ${filter}`}</div>;
}
```

---

## 5. Recommendations

- **Always react at the highest possible level of abstraction**: React hook > ViewerEvent > Plugin > Component callback.
- **No allocations in `onFixedUpdatePre/Post` and `onRender`** — pre-allocate, reuse vectors.
- **Don't forget to unsubscribe**: `viewer.on(...)` returns a function. Call it in `dispose()`.
- **`object-click` vs. `object-clicked`**: Clicks are emitted as `object-clicked`. `object-click` is declared but is not currently fired (see [rv-component-event-dispatcher.ts](src/core/engine/rv-component-event-dispatcher.ts)).
- **`simulation-pause-changed` is edge-triggered** — if you need the full reason stack, read `viewer.loop.pauseReasons` directly.

---

## See Also

- [doc-extending-webviewer.md](doc-extending-webviewer.md) — Plugin system, UI slots, custom components
- [doc-lifecycle.md](doc-lifecycle.md) — Runtime lifecycle, fixed-step loop, dispose
- [doc-signal-architecture.md](doc-signal-architecture.md) — SignalStore & PLC signals in detail
- [doc-webviewer-interface.md](doc-webviewer-interface.md) — Custom industrial interfaces
