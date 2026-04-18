# Extending realvirtual WEB

Guide for building custom plugins, adding UI components, and extending realvirtual WEB with new functionality.

## Architecture at a Glance

```
main.ts
  viewer.use(new MyPlugin())    // Plugin with lifecycle hooks + optional UI slots

rv-viewer.ts (Core)
  plugins[] → onModelLoaded → onFixedUpdatePre → [drives] → [transport] → onFixedUpdatePost → onRender

HMIShell.tsx (React)
  SlotRenderer('kpi-bar')    → renders all registered kpi-bar components
  SlotRenderer('messages')   → renders all registered message components
  ...
```

Three extension points:

1. **Plugins** — lifecycle callbacks, simulation data, event emission, optional UI slot registration
2. **Events** — typed pub/sub between plugins and UI
3. **UI Components** — Left panels, chart overlays, tooltips, slot-based layout areas

---

## 1. UI Architecture

### Component Tree

```
<ThemeProvider>                        // MUI dark theme
  <HMIShell>                           // Fixed overlay, pointer-events: none on container
    <TooltipLayer />                   //   Generic tooltip renderer
    <KpiBar />                         //   Top center — KPI badge cards (slot: kpi-bar)
    <TopBar />                         //   Top-right buttons + docked panels:
    │   ├── Hierarchy toggle button    //     Opens HierarchyBrowser (LeftPanel)
    │   ├── VR button                  //     Opens VR/AR modal
    │   ├── Settings button            //     Opens Settings (LeftPanel with tabs)
    │   ├── HierarchyBrowser           //     Docked left panel (when open)
    │   ├── PropertyInspector          //     Second left panel beside hierarchy
    │   ├── MachineControlPanel        //     Docked left panel (when open)
    │   └── Settings LeftPanel         //     Model / Visual / Physics / Interfaces / Dev / Tests
    <ButtonPanel />                    //   Left sidebar — logo + slot: button-group
    <MessagePanel />                   //   Right sidebar — slot: messages
    <BottomBar />                      //   Bottom — search/filter bar (slot: search-bar)
    <SlotRenderer slot="views" />      //   Bottom-right — charts, tables (slot: views)
  </HMIShell>
  <GenericTooltipController />         // Single headless controller for all tooltip types
  <DriveChartOverlay />                // Floating chart — outside HMIShell for drag/resize
  <WelcomeModal />                     // First-visit overlay
</ThemeProvider>
```

### HMIShell — The Overlay Container

`HMIShell` is a `position: fixed; inset: 0` container with `pointer-events: none`. This allows the 3D scene underneath to remain interactive. Each direct child gets `pointer-events: auto` restored automatically.

Components that need full pointer interaction (drag, resize) — like `ChartPanel` overlays — render **outside** HMIShell as siblings in `App.tsx`.

### TopBar — Top-Right Menu

The `TopBar` component renders a small button group fixed at top-right with:

| Button | Icon | Action | Visibility |
|--------|------|--------|------------|
| Hierarchy | `AccountTree` / `Close` | Toggles `HierarchyBrowser` left panel | Desktop only |
| VR | `VR` text / `Close` | Opens VR/AR QR code modal | Desktop only |
| AR | `ViewInAr` | Starts WebXR AR session | Mobile + AR supported |
| Settings | `Settings` / `Close` | Toggles Settings left panel | Unless `isSettingsLocked()` |

**Mutual exclusion:** Opening one panel closes the others. The TopBar coordinates with `LeftPanelManager` — when the machine-control panel (or any other left panel) opens, hierarchy and settings close automatically.

#### Settings Panel Tabs

The Settings panel is a `LeftPanel` (540px wide) with these tabs:

| Tab | Content | Lockable |
|-----|---------|----------|
| Model | Renderer (WebGL/WebGPU), model selector, reset all settings | `isTabLocked('model')` |
| Visual | Antialiasing, shadow map, lighting mode, ambient/directional light, tone mapping, camera projection/FOV | `isTabLocked('visual')` |
| Physics | Rapier.js toggle, gravity, friction, substeps, debug wireframes | `isTabLocked('physics')` |
| Interfaces | Protocol selector (WebSocket, ctrlX, MQTT), connection settings, auto-connect | `isTabLocked('interfaces')` |
| Dev Tools | FPS overlay, console log, stats, performance budget bars, GPU benchmark | `isTabLocked('devtools')` |
| Tests | Run Vitest browser tests, show pass/fail results | `isTabLocked('tests')` |

Tabs can be hidden via `rv-app-config.ts` using `isTabLocked(tabName)` and the entire settings button via `isSettingsLocked()`.

#### Adding a Settings Tab via Plugin

Use the `settings-tab` slot to add custom tabs:

```typescript
export class MyPlugin implements RVViewerPlugin {
  readonly id = 'my-plugin';
  readonly slots: UISlotEntry[] = [
    { slot: 'settings-tab', component: MySettingsTab, label: 'My Tab', order: 300 },
  ];
}
```

### ButtonPanel — Left Sidebar

The `ButtonPanel` renders two elements:

1. **Logo + status indicator** — fixed at top-left (always visible)
2. **Button group** — vertical column of icon buttons from the `button-group` slot

The button group automatically shifts right when a left panel is open, reading `activePanelWidth` from the `LeftPanelManager`.

### Pointer Events Strategy

```
HMIShell container           → pointer-events: none  (3D scene receives clicks)
  └── each child component   → pointer-events: auto  (UI elements are interactive)

App.tsx siblings (outside HMIShell):
  └── ChartPanel, tooltips   → pointer-events: auto  (need drag/resize)
```

Individual UI elements mark themselves with `data-ui-panel` attribute for identification. The `RaycastManager` checks `data-ui-panel` to avoid 3D raycasts when clicking on UI.

---

## 2. Components, Signals, and Unity Mapping

### How Unity Components Map to the WebViewer

The Unity scene is exported as a **GLB file** with custom `extras` data on each node. During loading, the `rv-scene-loader.ts` traverses the GLB scene graph and maps Unity components to TypeScript counterparts:

| Unity Component | TypeScript Class | File |
|----------------|-----------------|------|
| `Drive` | `RVDrive` | `rv-drive.ts` |
| `Drive_Simple` | `RVDriveSimple` | `rv-drive-simple.ts` |
| `Drive_Cylinder` | `RVDriveCylinder` | `rv-drive-cylinder.ts` |
| `Drive_ErraticPosition` | `RVErraticDriver` | `rv-erratic.ts` |
| `Sensor` | `RVSensor` | `rv-sensor.ts` |
| `TransportSurface` | `RVTransportSurface` | `rv-transport-surface.ts` |
| `Source` | `RVSource` | `rv-source.ts` |
| `Sink` | `RVSink` | `rv-sink.ts` |
| `Grip` | `RVGrip` | `rv-grip.ts` |
| `GripTarget` | `RVGripTarget` | `rv-grip-target.ts` |
| `ConnectSignal` | `RVConnectSignal` | `rv-connect-signal.ts` |
| `PLCOutputBool/Float/Int` | Signal entry in `SignalStore` | `rv-signal-store.ts` |
| `PLCInputBool/Float/Int` | Signal entry in `SignalStore` | `rv-signal-store.ts` |
| `DrivesRecorder` | `RVDrivesPlayback` | `rv-drives-playback.ts` |
| `ReplayRecording` | `RVReplayRecording` | `rv-replay-recording.ts` |

### Component Registry and Auto-Mapping

Components use a **schema-based auto-mapping system** (`rv-component-registry.ts`). Each TypeScript component declares a static schema matching its C# counterpart:

```typescript
// Schema uses exact C# PascalCase field names
export class RVDrive implements RVComponent {
  static readonly schema: ComponentSchema = {
    Direction: { type: 'enum', enumMap: { 'LinearX': DriveDirection.LinearX, ... }},
    TargetSpeed: { type: 'number', default: 100 },
    Acceleration: { type: 'number', default: 100 },
    UseLimits: { type: 'boolean', default: false },
    // ... maps directly from GLB extras
  };
}
```

**Field types:** `number`, `boolean`, `string`, `vector3`, `componentRef` (resolved to another component), `enum` (string→value mapping).

### Two-Step Loading (Awake/Start Pattern)

Like Unity's `Awake()` / `Start()` lifecycle:

1. **Step 1 "Awake"**: Traverse GLB → construct components → apply schema from extras → register ALL
2. **Step 2 "Start"**: Resolve `ComponentRef` cross-references → call `init()` on ALL

This ensures all components exist before any references are resolved.

### Adding a New Component Type (Unity → WebViewer)

To map an existing Unity component to the WebViewer:

**Step 1: Create the TypeScript component** in `src/core/engine/`:

```typescript
// src/core/engine/rv-my-component.ts
import { Object3D } from 'three';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';

export class RVMyComponent implements RVComponent {
  // Schema key names MUST match C# PascalCase field names exactly
  static readonly schema: ComponentSchema = {
    Speed: { type: 'number', default: 100 },
    IsActive: { type: 'boolean', default: true },
    Mode: { type: 'enum', enumMap: { 'Auto': 0, 'Manual': 1 }},
    TargetDrive: { type: 'componentRef' },        // Resolved to RVDrive in Step 2
    Offset: { type: 'vector3', unityCoords: true }, // Unity→glTF coord conversion
  };

  readonly node: Object3D;
  readonly name: string;
  Speed = 100;
  IsActive = true;
  Mode = 0;
  TargetDrive: RVComponent | null = null;

  constructor(node: Object3D) {
    this.node = node;
    this.name = node.name;
  }

  init(ctx: ComponentContext): void {
    // Called in Step 2 after ALL components exist and ComponentRefs are resolved
    ctx.registry.register('MyComponent', ctx.registry.pathFor(this.node) ?? '', this);
  }

  dispose(): void { /* cleanup on model unload */ }
}

// Self-register: the scene loader auto-discovers this component — no loader changes needed
registerComponent({
  type: 'MyComponent',
  schema: RVMyComponent.schema,
  capabilities: {
    hoverable: true,           // Highlight on mouse hover
    selectable: true,          // Can be clicked/selected
    inspectorVisible: true,    // Shown in Property Inspector (default: true)
    hierarchyVisible: true,    // Shown in Hierarchy Browser (default: true)
    tooltipType: 'drive',      // Tooltip content type (must match tooltip-registry key)
    badgeColor: '#4fc3f7',     // Badge color in hierarchy browser
    filterLabel: 'My Components', // Label in search/filter dropdown (null = not filterable)
    hoverEnabledByDefault: true,  // Hover enabled after scene load
    exclusiveHoverGroup: false,   // Part of Drive/Sensor/MU toggle (default: false)
  },
  create: (node) => new RVMyComponent(node),
  // Optional hooks:
  // needsAABB: true,                          // if component needs a BoxCollider AABB
  // beforeSchema: (inst, extras) => { ... },  // extract raw data before coord conversion
  // afterCreate: (inst, node) => { ... },     // set node metadata after construction
});
```

The `capabilities` field is optional. When omitted, conservative defaults apply (not hoverable, not selectable, visible in inspector/hierarchy). All capability fields are optional — only specify what differs from defaults.

**Standalone capability registration** — For types without a factory (e.g., pipeline types, AAS links), use `registerCapabilities()` directly:

```typescript
import { registerCapabilities } from './rv-component-registry';

// Register capabilities for a type that has no factory (no create() needed)
registerCapabilities('AASLink', {
  hoverable: true,
  selectable: true,
  tooltipType: 'aas',
  badgeColor: '#26a69a',
  hoverEnabledByDefault: true,
});
```

**Capability reference:**

| Capability | Type | Default | Description |
|-----------|------|---------|-------------|
| `hoverable` | boolean | `false` | Highlight on mouse hover |
| `selectable` | boolean | `false` | Can be clicked/selected |
| `inspectorVisible` | boolean | `true` | Shown in Property Inspector |
| `hierarchyVisible` | boolean | `true` | Shown in Hierarchy Browser |
| `tooltipType` | string/null | `null` | Tooltip content type (key in tooltip-registry) |
| `badgeColor` | string | `'#90a4ae'` | Hex color for hierarchy browser badge |
| `filterLabel` | string/null | `null` | Label in search/filter dropdown |
| `hoverEnabledByDefault` | boolean | `false` | Auto-enable hover after scene load |
| `exclusiveHoverGroup` | boolean | `false` | Part of Drive/Sensor/MU toggle group |
| `simulationActive` | boolean | `false` | Receives onFixedUpdate calls |

**Querying capabilities:**

```typescript
import { getCapabilities, getTypesWithCapability } from './rv-component-registry';

// Get resolved capabilities for a type (always returns Required<ComponentCapabilities>)
const caps = getCapabilities('Drive');  // { hoverable: true, badgeColor: '#4fc3f7', ... }

// Get all types with a specific capability
const hoverableTypes = getTypesWithCapability('hoverable');  // ['Drive', 'Sensor', 'MU', ...]
```

**Step 2: Import in scene loader** — Add a single side-effect import in `rv-scene-loader.ts`:

```typescript
import './rv-my-component';
```

That's it — the factory loop in the loader auto-discovers the component from the registry.

**Step 3: Export from Unity** — The C# component must be exported in the GLB's `realvirtual` extras by `WebViewerExporter.cs`.

**Field type reference:**

| Schema Type | C# Type | TS Type | Notes |
|------------|---------|---------|-------|
| `number` | `float`, `int` | `number` | Auto-coerced |
| `boolean` | `bool` | `boolean` | Auto-coerced |
| `string` | `string` | `string` | Auto-coerced |
| `vector3` | `Vector3` | `THREE.Vector3` | `unityCoords: true` negates X |
| `componentRef` | Unity Object ref | `RVComponent \| null` | Resolved from hierarchy path |
| `enum` | C# enum | via `enumMap` | GLB string → TS value |

### Signal Store

The `SignalStore` is the central pub/sub store for PLC signals. It mirrors Unity's `PLCInputBool`, `PLCOutputBool`, `PLCInputFloat`, etc.

**Two lookup tables** point to the same underlying values:
- **By name** — `Signal.Name` (custom unique name) or node name. Primary addressing for plugins and HMI. Always O(1) hash lookup.
- **By path** — Full hierarchy path (e.g. `"DemoCell/Signals/ConveyorStart"`). Used internally by the loader and for component-reference resolution. **Also O(1) after first access** — results are cached in `resolveCache`. First access may do a suffix scan (for paths missing the GLB root prefix), but subsequent lookups hit the cache directly.

#### Reading Signals

```typescript
const store = viewer.signalStore;

// By name (primary — O(1) hash lookup)
store.getBool('ConveyorStart');       // boolean
store.getFloat('ConveyorSpeed');      // number
store.getInt('PartCounter');          // number (truncated)
store.get('SignalName');              // boolean | number | undefined

// By path (also O(1) after first access — cached)
store.getBoolByPath('DemoCell/Signals/ConveyorStart');
store.getFloatByPath('DemoCell/Signals/Speed');
```

#### Writing Signals

```typescript
store.set('ConveyorStart', true);     // By name
store.setByPath('DemoCell/Signals/Speed', 500);  // By path

// Bulk update — all values set first, then all listeners fire (batch semantics)
store.setMany({
  ConveyorStart: true,
  MachineSpeed: 200,
  DoorClosed: false,
});
```

#### Subscribing to Changes

```typescript
// Direct subscription (returns unsubscribe function)
const off = store.subscribe('ConveyorStart', (value) => {
  console.log('ConveyorStart changed to', value);
});
off();  // Unsubscribe

// By path
const off2 = store.subscribeByPath('DemoCell/Signals/Speed', (value) => {
  console.log('Speed:', value);
});
```

#### React Hook: useSignal

```typescript
// In a React component — reactive to signal changes
const value = useSignal('ConveyorStart');  // boolean | number | undefined
```

#### RVBehavior Signal Helpers

Plugins extending `RVBehavior` get convenience methods:

```typescript
class MyPlugin extends RVBehavior {
  protected onStart(): void {
    // Read
    const running = this.getSignalBool('ConveyorStart');

    // Write
    this.setSignal('ConveyorSpeed', 500);

    // Subscribe (auto-cleanup on dispose)
    this.onSignalChanged('PartAtSensor', (value) => {
      if (value === true) this.handlePartArrived();
    });
  }
}
```

### Accessing Components from Plugins

```typescript
// All drives
const drives = viewer.drives;  // RVDrive[]

// Find by name
const conveyor = drives.find(d => d.name === 'Conveyor');

// Typed plugin access to component lists
class MyPlugin extends RVBehavior {
  protected onStart(): void {
    const drives = this.drives;     // RVDrive[]
    const sensors = this.sensors;   // (via viewer)
  }
}
```

### LoadResult — What the Loader Returns

After loading a GLB, `loadModel()` returns a `LoadResult` with:

| Field | Type | Description |
|-------|------|-------------|
| `drives` | `RVDrive[]` | All drive components |
| `transportManager` | `RVTransportManager` | Transport surface + MU management |
| `signalStore` | `SignalStore` | All PLC signals |
| `registry` | `NodeRegistry` | Node path → Object3D lookup |
| `playback` | `RVDrivesPlayback \| null` | Drive recording playback |
| `replayRecordings` | `RVReplayRecording[]` | Individual replay recordings |
| `logicEngine` | `RVLogicEngine \| null` | LogicStep execution engine |
| `groups` | `GroupRegistry \| null` | Group definitions (for visibility) |
| `boundingBox` | `Box3` | Scene bounding box |
| `triangleCount` | `number` | Total triangle count |

This result is passed to all plugins via `onModelLoaded(result, viewer)`.

---

## 3. Core Plugins

### The RVViewerPlugin Interface

```typescript
// src/core/rv-plugin.ts

interface RVViewerPlugin {
  readonly id: string;                  // Unique ID, e.g. 'my-analytics'
  readonly order?: number;              // Execution order (lower = earlier, default: 100)
  readonly handlesTransport?: boolean;  // true = replaces kinematic transport
  readonly slots?: UISlotEntry[];       // Optional UI components for HMI layout slots

  onModelLoaded?(result: LoadResult, viewer: RVViewer): void;
  onModelCleared?(viewer: RVViewer): void;
  onFixedUpdatePre?(dt: number): void;   // 60Hz, BEFORE drive physics
  onFixedUpdatePost?(dt: number): void;  // 60Hz, AFTER drive physics + transport
  onRender?(frameDt: number): void;      // Per render frame
  dispose?(): void;                      // Cleanup on viewer destroy
}
```

### Execution Order in fixedUpdate

```
1. LogicEngine.fixedUpdate(dt)         — LogicStep sequencing
2. ReplayRecordings[].fixedUpdate(dt)  — Recording playback (legacy, not yet a plugin)
3. prePlugins[].onFixedUpdatePre(dt)   — Set drive targets, apply interface data
4. ErraticDrivers[].update(dt)         — Random drive targets (legacy, not yet a plugin)
5. drives[].update(dt)                 — Drive physics (sorted by DriveOrderPlugin)
6. transportManager.update(dt)         — MU movement, sensors (skipped if handlesTransport)
7. postPlugins[].onFixedUpdatePost(dt) — Read results, sample data, emit events
8. driveRecorder.sample(dt)            — Drive recording (legacy, not yet a plugin)
```

> **Note:** Steps 2, 4, and 8 are legacy hardcoded calls that predate the plugin system.
> They will be migrated to `onFixedUpdatePre` / `onFixedUpdatePost` plugins in a future
> refactoring pass. New features should always use the plugin system.

Plugins are cached into per-phase arrays sorted by `order`. Each callback is wrapped in try/catch — a faulty plugin cannot crash the simulation.

### RVBehavior Base Class (Recommended)

For most plugins, extend `RVBehavior` instead of implementing `RVViewerPlugin` directly. It provides:

- **Auto-managed viewer lifecycle** — `this.viewer` set on model load, cleared on dispose
- **Convenience getters** — `this.drives`, `this.sensors`, `this.signals`, `this.playback`, `this.scene`
- **Signal access** — `getSignalBool(name)`, `setSignal(name, value)`, `onSignalChanged(name, cb)` with auto-cleanup
- **Component discovery** — `find<T>(type, path)`, `findAll<T>(type)`, `findInParent<T>()`, `findInChildren<T>()`
- **Lifecycle hooks** — `onStart()`, `onDestroy()`, `onPreFixedUpdate(dt)`, `onLateFixedUpdate(dt)`, `onFrame(frameDt)`
- **Cleanup registration** — `addCleanup(fn)` for automatic resource disposal

```typescript
import { RVBehavior } from '../core/rv-behavior';

export class MyPlugin extends RVBehavior {
  readonly id = 'my-plugin';

  protected onStart(): void {
    const drive = this.drives.find(d => d.name === 'Conveyor');
    this.onSignalChanged('ConveyorStart', (value) => {
      if (drive && value === true) drive.jogForward = true;
    });
  }

  protected onLateFixedUpdate(dt: number): void {
    // Read results after drive physics (60Hz)
  }
}
```

### Example: Data-Only Plugin (No Lifecycle)

The simplest plugin just holds data. No callbacks needed.

```typescript
// src/plugins/my-config-plugin.ts
import type { RVViewerPlugin } from '../core/rv-plugin';

export class MyConfigPlugin implements RVViewerPlugin {
  readonly id = 'my-config';

  // Public data accessible from React via usePlugin()
  readonly apiUrl: string;
  readonly refreshRate: number;

  constructor(config: { apiUrl: string; refreshRate?: number }) {
    this.apiUrl = config.apiUrl;
    this.refreshRate = config.refreshRate ?? 1000;
  }
}
```

Register and access:

```typescript
// main.ts
viewer.use(new MyConfigPlugin({ apiUrl: 'https://api.example.com' }));

// Any React component
const config = usePlugin<MyConfigPlugin>('my-config');
console.log(config?.apiUrl);
```

### Example: Simulation Plugin (Pre/Post Callbacks)

A plugin that sets drive targets before physics and reads results after:

```typescript
// src/plugins/oscillator-plugin.ts
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVViewer } from '../core/rv-viewer';
import type { RVDrive } from '../core/engine/rv-drive';

export class OscillatorPlugin implements RVViewerPlugin {
  readonly id = 'oscillator';
  readonly order = 50;  // Run before default (100)

  private drives: RVDrive[] = [];
  private elapsed = 0;

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    // Pick drives to oscillate
    this.drives = viewer.drives.filter(d => d.name.startsWith('Osc_'));
  }

  onFixedUpdatePre(dt: number): void {
    this.elapsed += dt;
    for (const drive of this.drives) {
      // Set target position — drive physics handles acceleration/deceleration
      drive.targetPosition = Math.sin(this.elapsed * 2) * 500;  // ±500mm
    }
  }

  onFixedUpdatePost(dt: number): void {
    // Read actual positions after physics
    for (const drive of this.drives) {
      if (drive.isAtTarget) {
        // Could emit events, log data, etc.
      }
    }
  }

  onModelCleared(): void {
    this.drives = [];
    this.elapsed = 0;
  }
}
```

### Example: Event-Emitting Plugin

Plugins can emit typed events that React components subscribe to:

```typescript
// src/plugins/alarm-plugin.ts
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';

export class AlarmPlugin implements RVViewerPlugin {
  readonly id = 'alarm';

  private viewer: RVViewer | null = null;
  private checkInterval = 0;
  private elapsed = 0;

  onModelLoaded(_result: any, viewer: RVViewer): void {
    this.viewer = viewer;
  }

  onFixedUpdatePost(dt: number): void {
    this.elapsed += dt;
    this.checkInterval += dt;
    if (this.checkInterval < 1.0) return;  // Check every second
    this.checkInterval = 0;

    // Example: emit custom event (untyped overload)
    if (someCondition) {
      this.viewer?.emit('alarm:triggered', {
        severity: 'warning',
        message: 'Temperature exceeded threshold',
        time: this.elapsed,
      });
    }
  }

  onModelCleared(): void {
    this.viewer = null;
    this.elapsed = 0;
  }
}
```

Subscribe in React:

```typescript
// In a component
const viewer = useViewer();

useEffect(() => {
  return viewer.on('alarm:triggered', (data) => {
    console.log('Alarm:', data);
  });
}, [viewer]);
```

For type safety on custom events, extend `ViewerEvents` in `rv-viewer.ts`:

```typescript
export interface ViewerEvents {
  // ... existing events ...
  'alarm:triggered': { severity: string; message: string; time: number };
}
```

### MultiuserPlugin

The `MultiuserPlugin` provides real-time presence and avatar synchronization across browser, VR, and AR clients.

```typescript
import { MultiuserPlugin } from './plugins/multiuser-plugin';

// Plugin is registered automatically via plugin system in main.ts.
// Access the running instance via the viewer plugin registry:
const multiuser = viewer.getPlugin('multiuser') as MultiuserPlugin;

// Join a session (connect to MultiplayerWEB server on Port 7000)
multiuser.joinSession('ws://192.168.1.5:7000', 'MyName');

// Join with a specific role and color
multiuser.joinSession('ws://192.168.1.5:7000', 'MyName', '#FF5722', 'operator');

// Leave session — removes all remote avatars and closes the connection
multiuser.leaveSession();

// Get currently visible remote players
const users = multiuser.getConnectedUsers();  // PlayerInfo[]

// Write signals (operator role only — enforced on Unity side)
multiuser.writeSignal('Cell/Signals/ConveyorStart', true);

// Jog drives (operator role only)
multiuser.jogDrive('Cell/Conveyor/Drive', true);   // forward
multiuser.jogDrive('Cell/Conveyor/Drive', false);  // backward
multiuser.stopDrive('Cell/Conveyor/Drive');

// Broadcast a cursor ray so others see where you are pointing
multiuser.sendCursorRay([1, 1, 0], [0, 0, 1]);  // origin, direction (unit vector)
```

#### URL Join Parameters

Users can join a session directly from a URL without opening the UI panel:

| Parameter | Alias | Description |
|-----------|-------|-------------|
| `?server=ws://host:7000` | `multiuserServer` | Server WebSocket URL |
| `?name=Alice` | `multiuserName` | Display name |
| `?role=operator` | `multiuserRole` | Role (`operator` or `observer`) |
| `?multiuserColor=#FF5722` | — | Avatar color (hex) |

Example shareable link:

```
https://viewer.acme.com/webviewer?server=ws://192.168.1.5:7000&name=Alice&role=operator
```

#### Events

Subscribe to state changes via the `multiuser-changed` event:

```typescript
viewer.on('multiuser-changed', (snapshot) => {
  console.log('Connected:', snapshot.connected);
  console.log('Players:', snapshot.players);
  console.log('Player count:', snapshot.playerCount);
  console.log('Local role:', snapshot.localRole);
});
```

The `MultiuserSnapshot` type:

```typescript
interface MultiuserSnapshot {
  connected: boolean;     // WebSocket open and room_join sent
  serverUrl: string;      // Current server URL
  localName: string;      // Local player's display name
  localRole: string;      // 'operator' | 'observer'
  playerCount: number;    // Number of remote avatars visible
  players: PlayerInfo[];  // Full list of remote players
}
```

#### Rate Limits

- **Outgoing**: Avatar position updates are capped at 20 Hz. The hard cap is enforced in `onLateFixedUpdate` via a time accumulator — `_send` is never called more often than `1 / MAX_OUTGOING_HZ`.
- **Incoming**: If the server sends more than 100 messages per second, a `console.warn` is emitted. No messages are silently dropped — this is a monitoring signal only.
- **Unity side**: The `MultiplayerWEB` component enforces a `MaxMessagesPerSecond` limit per client (default: 100). Excess messages are dropped with a `Logger.Warning`. The client is not disconnected.

### Retroactive Registration

If a plugin is registered after a model is already loaded, `onModelLoaded` is called immediately:

```typescript
// Model loaded at t=0
await viewer.loadModel('scene.glb');

// Plugin registered at t=5 — onModelLoaded fires right away
viewer.use(new LatePlugin());
```

### Plugin Order

The `order` property controls execution order within each phase (Pre, Post, Render). Lower values run first:

| order | Intended Use |
|-------|-------------|
| 0 | Infrastructure (DriveOrderPlugin, physics) |
| 50 | Interface data exchange |
| 100 | Default (most plugins) |
| 200 | Analytics, recording |

---

## 4. Events

### Built-in Event Types

The full `ViewerEvents` interface lives at [src/core/rv-viewer.ts](src/core/rv-viewer.ts) (search for `export interface ViewerEvents`). Snapshot of the categories:

```typescript
interface ViewerEvents {
  // Lifecycle
  'model-loaded':       { result: LoadResult };
  'model-cleared':      void;
  'connection-state-changed': { state: 'Connected' | 'Disconnected'; previous: 'Connected' | 'Disconnected' };
  'simulation-pause-changed': { paused: boolean; reasons: readonly string[]; reason: string };

  // Hover / focus / selection
  'drive-hover':        { drive: RVDrive | null; clientX: number; clientY: number };
  'drive-focus':        { drive: RVDrive | null; node: Object3D | null };
  'object-hover':       ObjectHoverData | null;       // { node, nodeType, nodePath, pointer, hitPoint, mesh }
  'object-unhover':     ObjectUnhoverData;            // { node, nodeType }
  'object-click':       ObjectClickData;              // { node, nodeType, nodePath, pointer }
  'object-clicked':     { path: string; node: Object3D };
  'object-focus':       { path: string; node: Object3D };
  'selection-changed':  SelectionSnapshot;
  'exclusive-hover-mode': { mode: HoverableType | null };

  // Filters / charts (UI plumbing)
  'drive-chart-toggle':    { open: boolean };
  'drive-filter':          { filter: string; filteredDrives: RVDrive[] };
  'node-filter':           { filter: string; filteredNodes: NodeSearchResult[]; tooMany: boolean };
  'sensor-chart-toggle':   { open: boolean };
  'groups-overlay-toggle': { open: boolean };

  // Simulation (emitted by plugins)
  'sensor-changed':     { sensorPath: string; occupied: boolean };
  'mu-spawned':         { totalSpawned: number };
  'mu-consumed':        { totalConsumed: number };
  'drive-at-target':    { drivePath: string; position: number };

  // Industrial interfaces
  'interface-connected':    { interfaceId: string; type: string };
  'interface-disconnected': { interfaceId: string; reason?: string };
  'interface-error':        { interfaceId: string; error: string };
  'interface-data':         { interfaceId: string; signals: Record<string, unknown> };

  // Camera / panels / context menu
  'camera-animation-done':  { targetPath?: string };
  'panel-opened':           { panelId: string };
  'panel-closed':           { panelId: string };
  'context-menu-request':   { pos: { x: number; y: number }; path: string; node: Object3D };

  // XR
  'xr-session-start':       void;
  'xr-session-end':         void;
  'xr-hit-test':            { position: Float32Array; matrix: Float32Array };
  'xr-controller-select':   { hand: 'left' | 'right'; position: { x: number; y: number; z: number } };

  // FPV
  'fpv-enter':              void;
  'fpv-exit':               void;

  // Layout planner
  'layout-transform-update': { path: string; position: {x,y,z}; rotation: {x,y,z} };
}
```

### Emitting Events

```typescript
// Typed (compile-time checked):
viewer.emit('sensor-changed', { sensorPath: 'Cell/Sensor1', occupied: true });

// Custom/untyped (for plugin-specific events):
viewer.emit('my-plugin:data-ready', { values: [1, 2, 3] });
```

### Subscribing to Events

```typescript
// Returns unsubscribe function
const off = viewer.on('sensor-changed', (data) => {
  console.log(data.sensorPath, data.occupied);
});
off();  // Unsubscribe

// In React — auto-cleanup via useEffect
useSimulationEvent('sensor-changed', (data) => {
  // Callback ref is stable — no re-subscriptions on re-render
});
```

---

## 5. UI Slots (React Components in Plugins)

Plugins can provide UI by declaring a `slots` array on `RVViewerPlugin`. Slot entries are automatically registered into the HMI layout when `viewer.use()` is called.

### Available Layout Slots

```
+------------------------------------------------------------+
|           [kpi-bar] KPI cards, horizontal                  |
| +--------+                                    +---------+  |
| |        |                                    |         |  |
| |[button-|                                    |[messages|  |
| | group] |                                    | ]       |  |
| |        |            3D Scene                |         |  |
| |        |                                    |         |  |
| +--------+                                    +---------+  |
|                                    +-------------------+   |
|                                    | [views]           |   |
|                                    | Charts, tables    |   |
|                                    +-------------------+   |
|           [search-bar] Search field                        |
+------------------------------------------------------------+
```

| Slot | Position | Typical Content |
|------|----------|----------------|
| `kpi-bar` | Top center | KPI badge cards |
| `button-group` | Left sidebar | Navigation icon buttons |
| `search-bar` | Bottom center | Search/filter fields |
| `messages` | Right sidebar | Notifications, status tiles |
| `views` | Bottom right | Expandable panels, charts |
| `settings-tab` | Settings dialog | Additional tabs |
| `toolbar-button` | TopBar (right) | Extra toolbar buttons next to hierarchy/settings |
| `overlay` | Full-screen | Left panels, modals, custom overlays |

### UISlotEntry Type

```typescript
// src/core/rv-ui-plugin.ts

type UISlot =
  | 'kpi-bar'        // Top center: KPI cards horizontal
  | 'button-group'   // Left sidebar: nav buttons vertical
  | 'search-bar'     // Bottom center: search field
  | 'messages'       // Right sidebar: notifications / status tiles
  | 'views'          // Bottom right: expandable panels (charts, tables)
  | 'settings-tab'   // Settings dialog: tab registration
  | 'toolbar-button' // TopBar: extra toolbar buttons
  | 'overlay';       // Full-screen overlays (left panels, modals, etc.)

interface UISlotEntry {
  pluginId?: string;      // Auto-stamped by UIPluginRegistry.register()
  slot: UISlot;
  component: ComponentType<{ viewer: RVViewer }>;
  order?: number;         // Sort order within slot (lower = earlier). Default: 100
  label?: string;         // For settings-tab: tab label
  visibilityId?: string;  // Optional context-store element id for hiding
  visibilityRule?: UIVisibilityRule; // Inline visibility rule (hiddenIn / shownOnlyIn)
}
```

### Example: Plugin with KPI Card

```typescript
// src/plugins/energy-plugin.ts
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry } from '../core/rv-ui-plugin';
import type { RVViewer } from '../core/rv-viewer';

function EnergyKpiCard({ viewer }: { viewer: RVViewer }) {
  return (
    <div style={{ padding: 8, background: 'rgba(0,0,0,0.6)', borderRadius: 8 }}>
      <div style={{ fontSize: 12, color: '#aaa' }}>Energy</div>
      <div style={{ fontSize: 24, color: '#4fc3f7' }}>42 kWh</div>
    </div>
  );
}

export class EnergyPlugin implements RVViewerPlugin {
  readonly id = 'energy';
  readonly slots: UISlotEntry[] = [
    { slot: 'kpi-bar', component: EnergyKpiCard, order: 40 },
  ];
}
```

Register:

```typescript
// main.ts
viewer.use(new EnergyPlugin());
```

The component appears automatically in the top KPI bar, sorted after existing cards (order 40).

### Example: Plugin with Settings Tab

```typescript
export class DebugPlugin implements RVViewerPlugin {
  readonly id = 'debug';
  readonly slots: UISlotEntry[] = [
    { slot: 'settings-tab', component: DebugSettingsTab, label: 'Debug', order: 200 },
  ];
}

function DebugSettingsTab({ viewer }: { viewer: RVViewer }) {
  return (
    <div>
      <h3>Debug Settings</h3>
      <label>
        <input type="checkbox" onChange={() => /* toggle debug */ } />
        Enable verbose logging
      </label>
    </div>
  );
}
```

### Rendering Slots in Custom Components

Use the `useSlot` hook to render slot content anywhere:

```typescript
import { useSlot } from '../hooks/use-slot';
import { useViewer } from '../hooks/use-viewer';

function CustomPanel() {
  const viewer = useViewer();
  const kpiEntries = useSlot('kpi-bar');

  return (
    <div>
      {kpiEntries.map((entry, i) => {
        const Comp = entry.component;
        return <Comp key={i} viewer={viewer} />;
      })}
    </div>
  );
}
```

---

## 6. React Hooks Reference

| Hook | Returns | Purpose |
|------|---------|---------|
| `useViewer()` | `RVViewer` | Access the viewer instance |
| `usePlugin<T>(id)` | `T \| undefined` | Type-safe plugin access |
| `useSimulationEvent(event, cb)` | void | Subscribe to typed events (auto-cleanup) |
| `useSlot(slot)` | `UISlotEntry[]` | Get registered components for a layout slot |
| `useKpiData()` | `KpiDemoPlugin \| undefined` | Access KPI demo data plugin |
| `useSensorState(path)` | `boolean` | Event-based sensor occupied state |
| `useTransportStats(ms?)` | `{ spawned, consumed }` | Polled transport counters |
| `useInterfaceStatus(id)` | `boolean` | Interface connection state |
| `useDrives()` | drive list + hover state | All loaded drives |
| `useSignal(name)` | signal value | Signal store subscription (by name) |
| `useTooltipState()` | `TooltipState` | Current active tooltip (useSyncExternalStore) |

### Writing Custom Hooks

```typescript
// hooks/use-alarm.ts
import { useState } from 'react';
import { useSimulationEvent } from './use-simulation-event';

export function useAlarm() {
  const [alarms, setAlarms] = useState<string[]>([]);

  useSimulationEvent('alarm:triggered', (data) => {
    setAlarms(prev => [...prev.slice(-9), data.message]);  // Keep last 10
  });

  return alarms;
}
```

---

## 6b. Generic Tooltip System

The tooltip system (`core/hmi/tooltip/`) uses **a single headless controller** (`GenericTooltipController`) plus a registry of **content providers** and **data resolvers**. To add a tooltip for a new component type:

### Step 1: Declare `tooltipType` on the component capability

When registering the component (in [rv-component-registry.ts](src/core/engine/rv-component-registry.ts) via `registerComponent({ type: 'Sensor', ... })`), set `capabilities.tooltipType` to a stable string key:

```typescript
registerComponent({
  type: 'Sensor',
  schema: RVSensor.schema,
  capabilities: { hoverable: true, tooltipType: 'sensor' },
  create: (node) => new RVSensor(node),
});
```

For types that have no factory (e.g. AAS links), use `registerCapabilities('AASLink', { tooltipType: 'aas', ... })` instead.

### Step 2: Register a Content Provider AND a Data Resolver

```typescript
// src/core/hmi/tooltip/SensorTooltipContent.tsx
import { tooltipRegistry, type TooltipContentProps } from './tooltip-registry';
import { Typography } from '@mui/material';

function SensorTooltipContent({ data }: TooltipContentProps) {
  return (
    <>
      <Typography variant="subtitle2" sx={{ color: '#4fc3f7' }}>{data.sensorName}</Typography>
      <Typography variant="caption">{data.occupied ? 'Occupied' : 'Free'}</Typography>
    </>
  );
}

// Self-register at module load (side-effect imported by App.tsx)
tooltipRegistry.register({ contentType: 'sensor', component: SensorTooltipContent });

tooltipRegistry.registerDataResolver('sensor', (node, viewer) => {
  const path = viewer.registry.pathFor(node) ?? node.name;
  const sensor = viewer.sensors.find(s => s.path === path);
  if (!sensor) return null;
  return { type: 'sensor', sensorName: node.name, occupied: sensor.occupied };
});
```

### Step 3: Side-effect-import the module

```typescript
// In src/core/hmi/App.tsx — already imports GenericTooltipController, just add yours:
import './core/hmi/tooltip/SensorTooltipContent';
```

That's it. No controller code, no event subscriptions — `GenericTooltipController` (already mounted in `App.tsx`) reads `node.userData.realvirtual` keys on hover and selection, looks up `getCapabilities(key).tooltipType`, and calls your data resolver.

**Bonus — generic PDF links**: any node with `node.userData._rvPdfLinks` automatically gets a PDF section appended at the bottom of its tooltip via `PdfTooltipSection`. No registration needed.

**Positioning modes:** `cursor` (follows mouse), `world` (3D→screen projection), `fixed` (screen position).

**Priority:** When multiple tooltip sections show at once, the **lower** `priority` number wins (default `5` for hover via `caps.hoverPriority`).

---

## 7. Plugins with Both Data and UI

A common pattern: one plugin handles data/simulation AND provides UI via slots.

### Step 1: Plugin (data + events + UI slots)

```typescript
// src/plugins/cycle-counter-plugin.ts
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry } from '../core/rv-ui-plugin';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVViewer } from '../core/rv-viewer';

export interface CycleCounterData {
  totalCycles: number;
  cyclesPerMinute: number;
  lastCycleTime: number;
}

function CycleCounterCard({ viewer }: { viewer: RVViewer }) {
  const data = useCycleCounter();
  if (!data) return null;

  return (
    <KpiCard
      label="Cycles"
      value={data.totalCycles.toString()}
      unit="total"
      secondary={`${data.cyclesPerMinute.toFixed(1)}/min`}
    />
  );
}

export class CycleCounterPlugin implements RVViewerPlugin {
  readonly id = 'cycle-counter';

  // UI slot entries — rendered automatically by HMI layout
  readonly slots: UISlotEntry[] = [
    { slot: 'kpi-bar', component: CycleCounterCard, order: 50 },
  ];

  private viewer: RVViewer | null = null;
  private _data: CycleCounterData = { totalCycles: 0, cyclesPerMinute: 0, lastCycleTime: 0 };

  get data(): Readonly<CycleCounterData> { return this._data; }

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
  }

  onFixedUpdatePost(dt: number): void {
    // ... count cycles, update _data ...
    if (cycleCompleted) {
      this._data.totalCycles++;
      this.viewer?.emit('cycle-counter:cycle', { total: this._data.totalCycles });
    }
  }

  onModelCleared(): void {
    this._data = { totalCycles: 0, cyclesPerMinute: 0, lastCycleTime: 0 };
    this.viewer = null;
  }
}
```

### Step 2: React Hook (optional, for polling plugin data)

```typescript
// hooks/use-cycle-counter.ts
import { useState, useEffect } from 'react';
import { usePlugin } from './use-plugin';
import type { CycleCounterPlugin } from '../plugins/cycle-counter-plugin';

export function useCycleCounter() {
  const plugin = usePlugin<CycleCounterPlugin>('cycle-counter');
  const [data, setData] = useState(plugin?.data);

  useEffect(() => {
    if (!plugin) return;
    const id = setInterval(() => setData({ ...plugin.data }), 500);
    return () => clearInterval(id);
  }, [plugin]);

  return data;
}
```

### Step 3: Register

```typescript
// main.ts
viewer.use(new CycleCounterPlugin());
```

The plugin runs at 60Hz (data), emits events, AND renders a KPI card — all from a single `viewer.use()` call.

---

## 8. Floating Chart Panels

Use `ChartPanel` to create draggable, resizable overlay panels (same as the drive chart and KPI charts):

```typescript
import { ChartPanel } from './ChartPanel';

interface Props {
  open: boolean;
  onClose: () => void;
}

function MyChartPanel({ open, onClose }: Props) {
  const chartRef = useRef<HTMLDivElement>(null);

  return (
    <ChartPanel
      open={open}
      onClose={onClose}
      title="My Chart"
      titleColor="#66bb6a"
      subtitle="Last 24 hours"
      defaultWidth={750}
      defaultHeight={340}
      zIndex={1400}
    >
      <div ref={chartRef} style={{ width: '100%', height: '100%' }} />
    </ChartPanel>
  );
}
```

`ChartPanel` features:
- Drag via title bar
- Resize via bottom-right corner handle
- ESC key to close
- Expand/collapse toggle (full-width)
- Glassmorphism dark theme (MUI Paper)

### Wiring Chart Panels to KPI Badges

Chart panels render in `App.tsx` (outside `HMIShell`) to avoid `pointer-events: none` blocking. The pattern:

```typescript
// App.tsx
const [openChart, setOpenChart] = useState<string | null>(null);
const toggle = (id: string) => setOpenChart(prev => prev === id ? null : id);

// Pass toggle to TopBar/KpiCards
<TopBar onKpiClick={toggle} />

// Render chart overlays as siblings
<MyChart open={openChart === 'my-chart'} onClose={() => setOpenChart(null)} />
```

### z-index Hierarchy

| Layer | z-index | Content |
|-------|---------|---------|
| HMIShell | 1000 | Main HMI overlay |
| TopBar | 1200 | Top bar with KPI badges |
| KPI Charts | 1400 | OEE, Parts/h, Cycle Time panels |
| Drive Chart | 1500 | Drive chart overlay |

---

## 9. Left Panels (Docked Side Panels)

Use the `LeftPanel` component and `LeftPanelManager` to create docked side panels — the same pattern used by the Hierarchy Browser, Property Inspector, Settings, and Machine Control panels.

### LeftPanelManager — Mutual Exclusion

Only one left panel can be open at a time. The `LeftPanelManager` (on `viewer.leftPanelManager`) coordinates this automatically — opening a new panel closes the previous one ("last one wins").

```typescript
const lpm = viewer.leftPanelManager;

lpm.open('my-panel', 350);        // Open with width 350px
lpm.close('my-panel');             // Close (no-op if not the active one)
lpm.toggle('my-panel', 350);      // Toggle open/closed
lpm.isOpen('my-panel');            // Check if active
lpm.activePanel;                   // Current panel id or null
lpm.activePanelWidth;              // Current panel width (0 when closed)
```

React components subscribe via `useSyncExternalStore`:

```typescript
import { useSyncExternalStore } from 'react';

const lpm = viewer.leftPanelManager;
const snapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
// snapshot.activePanel  — 'my-panel' | null
// snapshot.activePanelWidth — number
```

### LeftPanel Component

`LeftPanel` provides the standardized container: fixed positioning below the TopBar, header with title and close button, optional toolbar/footer, optional resize handle, and mobile full-screen behavior.

```typescript
import { LeftPanel } from '../core/hmi/LeftPanel';
```

**Props:**

| Prop | Type | Default | Description |
|------|------|---------|-------------|
| `title` | `ReactNode` | required | Header title (string or custom JSX) |
| `onClose` | `() => void` | required | Close button handler |
| `children` | `ReactNode` | required | Panel content |
| `width` | `number` | 320 | Panel width in px |
| `resizable` | `boolean` | false | Enable right-edge resize handle |
| `minWidth` | `number` | 200 | Min width when resizable |
| `maxWidth` | `number` | 600 | Max width when resizable |
| `onResize` | `(width) => void` | — | Callback during resize |
| `toolbar` | `ReactNode` | — | Optional toolbar between title and close button |
| `footer` | `ReactNode` | — | Optional footer below content |
| `mobile` | `'full-screen' \| 'hidden'` | `'full-screen'` | Mobile display policy |

### Example: Custom Left Panel

A complete example — a plugin that adds a button to the `button-group` slot and opens a docked left panel:

```typescript
// src/plugins/my-status-plugin.tsx
import { useSyncExternalStore, useCallback } from 'react';
import { IconButton, Box, Typography } from '@mui/material';
import { Analytics } from '@mui/icons-material';
import { useViewer } from '../hooks/use-viewer';
import { LeftPanel } from '../core/hmi/LeftPanel';
import type { RVViewerPlugin, UISlotEntry } from '../core/rv-plugin';

const PANEL_ID = 'my-status';
const PANEL_WIDTH = 320;

// Button in the left sidebar (slot: 'button-group')
function StatusButton({ viewer }: { viewer: RVViewer }) {
  const lpm = viewer.leftPanelManager;
  const snapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const isActive = snapshot.activePanel === PANEL_ID;

  return (
    <IconButton
      size="small"
      onClick={() => lpm.toggle(PANEL_ID, PANEL_WIDTH)}
      sx={{ color: isActive ? '#4fc3f7' : 'text.secondary' }}
    >
      <Analytics sx={{ fontSize: 18 }} />
    </IconButton>
  );
}

// The panel itself — renders when open
function StatusPanel() {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  const snapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);

  const isOpen = snapshot.activePanel === PANEL_ID;
  const handleClose = useCallback(() => lpm.close(PANEL_ID), [lpm]);

  if (!isOpen) return null;

  return (
    <LeftPanel title="Status" onClose={handleClose} width={PANEL_WIDTH}>
      <Box sx={{ p: 1.5, overflowY: 'auto', flex: 1 }}>
        <Typography variant="body2">My custom panel content</Typography>
      </Box>
    </LeftPanel>
  );
}

// Plugin: registers button + panel
export class MyStatusPlugin implements RVViewerPlugin {
  readonly id = 'my-status';
  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: StatusButton, order: 60 },
  ];
}
```

The `StatusPanel` component should be rendered in `App.tsx` alongside other panels:

```typescript
// App.tsx
<StatusPanel />
```

### Built-in Left Panels

| Panel ID | Width | Trigger | Component |
|----------|-------|---------|-----------|
| `'hierarchy'` | resizable (default 320) | TopBar toggle / button-group | `HierarchyBrowser` |
| `'settings'` | 540 | TopBar gear icon | `SettingsPanel` (via TopBar) |
| `'machine-control'` | 370 | button-group toggle | `MachineControlPanel` |

### Layout Integration

The `ButtonPanel` automatically shifts right when a left panel is open, reading `activePanelWidth` from the manager. No extra wiring needed — the manager's `useSyncExternalStore` API triggers re-renders in any subscribing component.

### Layout Constants

All left panel positioning uses shared constants from `core/hmi/layout-constants.ts`:

| Constant | Value | Description |
|----------|-------|-------------|
| `LEFT_PANEL_TOP` | 44 | Top position (below TopBar) |
| `LEFT_PANEL_LEFT` | 8 | Left margin on desktop |
| `LEFT_PANEL_BOTTOM` | 8 | Bottom margin on desktop |
| `LEFT_PANEL_ZINDEX` | 1200 | z-index for all left panels |

---

## 10. Testing Plugins

Tests use Vitest in headless Chromium. Create `tests/<name>.test.ts`:

```typescript
// tests/my-plugin.test.ts
import { describe, it, expect } from 'vitest';
import { MyPlugin } from '../src/plugins/my-plugin';

describe('MyPlugin', () => {
  it('has correct id', () => {
    const plugin = new MyPlugin();
    expect(plugin.id).toBe('my-plugin');
  });

  it('generates valid data', () => {
    const plugin = new MyPlugin();
    expect(plugin.data.length).toBeGreaterThan(0);
    expect(plugin.data.every(d => d.value >= 0)).toBe(true);
  });
});
```

Run tests:

```bash
cd Assets/realvirtual-WebViewer~
npm test              # All tests, headless
npm run test:watch    # Watch mode
```

### Testing Core Plugin Lifecycle

Use a minimal mock to test plugin dispatch without the full viewer:

```typescript
class MockHost {
  plugins: any[] = [];
  prePlugins: any[] = [];
  postPlugins: any[] = [];
  drives: any[] = [];
  private _lastLoadResult: any = null;

  use(plugin: any): this {
    if (this.plugins.some(p => p.id === plugin.id)) return this;
    this.plugins.push(plugin);
    if (plugin.onFixedUpdatePre) this.prePlugins.push(plugin);
    if (plugin.onFixedUpdatePost) this.postPlugins.push(plugin);
    if (this.drives.length > 0 && this._lastLoadResult && plugin.onModelLoaded) {
      plugin.onModelLoaded(this._lastLoadResult, this);
    }
    return this;
  }

  simulateLoad(result: any) {
    this._lastLoadResult = result;
    this.drives = [{ name: 'TestDrive' }];
    for (const p of this.plugins) p.onModelLoaded?.(result, this);
  }

  tick(dt: number) {
    for (const p of this.prePlugins) try { p.onFixedUpdatePre!(dt); } catch {}
    for (const p of this.postPlugins) try { p.onFixedUpdatePost!(dt); } catch {}
  }
}
```

---

## 11. Checklist: Adding a New Feature

1. **Create plugin** in `src/plugins/`:
   - Extend `RVBehavior` (recommended) or implement `RVViewerPlugin` directly
   - Override lifecycle hooks (`onStart`, `onDestroy`, `onPreFixedUpdate`, etc.) as needed
   - Add `slots` array for UI components (KPI cards, buttons, messages, etc.)
   - Set `order` if execution timing matters

2. **Create React hook** (if needed):
   - New file in `src/hooks/`
   - Use `usePlugin<T>(id)` or `useSimulationEvent()`

3. **Register in main.ts**:
   ```typescript
   viewer.use(new MyPlugin());
   ```

4. **Add tests** in `tests/`:
   - Test data generation, event emission, lifecycle behavior
   - Run `npm test` to verify

5. **Update README.md**:
   - Add new files to the architecture diagram and file reference table
   - Add new test suites to the test coverage table

---

## 12. Existing Plugins Reference

### Core Plugins (`core: true` — always loaded, survive model switches)

| Plugin | ID | File | Purpose |
|--------|----|------|---------|
| `RapierPhysicsPlugin` | `rapier-physics` | [src/core/engine/rapier-physics-plugin.ts](src/core/engine/rapier-physics-plugin.ts) | Rapier.js physics-based transport (replaces kinematic) |
| `DriveOrderPlugin` | `drive-order` | [src/plugins/drive-order-plugin.ts](src/plugins/drive-order-plugin.ts) | Topological sort for CAM/Gear master-slave |
| `SensorMonitorPlugin` | `sensor-monitor` | [src/plugins/sensor-monitor-plugin.ts](src/plugins/sensor-monitor-plugin.ts) | Event-based sensor change tracking |
| `TransportStatsPlugin` | `transport-stats` | [src/plugins/transport-stats-plugin.ts](src/plugins/transport-stats-plugin.ts) | 10 Hz spawn/consume RingBuffers |
| `CameraEventsPlugin` | `camera-events` | [src/plugins/camera-events-plugin.ts](src/plugins/camera-events-plugin.ts) | Emits `camera-animation-done` |
| `RvExtrasEditorPlugin` | `rv-extras-editor` | [src/core/hmi/rv-extras-editor.tsx](src/core/hmi/rv-extras-editor.tsx) | Hierarchy browser + property inspector |
| `DebugEndpointPlugin` | `debug-endpoint` | [src/plugins/debug-endpoint-plugin.ts](src/plugins/debug-endpoint-plugin.ts) | `/__api/debug` HTTP bridge (dev) |
| `McpBridgePlugin` | `mcp-bridge` | [src/plugins/mcp-bridge-plugin.ts](src/plugins/mcp-bridge-plugin.ts) | Claude MCP WebSocket bridge (dev) |

### Optional Plugins (registered eagerly, opt-in via model config)

| Plugin | ID | File | Purpose |
|--------|----|------|---------|
| `WebXRPlugin` | `webxr` | [src/plugins/webxr-plugin.ts](src/plugins/webxr-plugin.ts) | Immersive VR/AR (Quest, Vision Pro, Android AR) |
| `MultiuserPlugin` | `multiuser` | [src/plugins/multiuser-plugin.ts](src/plugins/multiuser-plugin.ts) | Presence, avatars, signal/drive sync, relay support |
| `FpvPlugin` | `fpv` | [src/plugins/fpv-plugin.tsx](src/plugins/fpv-plugin.tsx) | First-person WASD + mouse look walkthrough |
| `AnnotationPlugin` | `annotations` | [src/plugins/annotation-plugin.ts](src/plugins/annotation-plugin.ts) | 3D markers, labels, drawing |
| `AasLinkPlugin` | `aas-link` | [src/plugins/aas-link-plugin.tsx](src/plugins/aas-link-plugin.tsx) | AAS / AASX linking + tooltip |
| `DocsBrowserPlugin` | `docs-browser` | [src/plugins/docs-browser-plugin.tsx](src/plugins/docs-browser-plugin.tsx) | PDF / docs browser overlay |
| `CameraStartposPlugin` | `camera-startpos` | [src/plugins/camera-startpos-plugin.tsx](src/plugins/camera-startpos-plugin.tsx) | Per-model start position presets |
| `BlueprintPlugin` | `blueprint` | [src/plugins/blueprint-plugin.ts](src/plugins/blueprint-plugin.ts) | Blueprint / 2D plan view |
| `DriveRecorderPlugin` | `drive-recorder` | [src/plugins/drive-recorder-plugin.ts](src/plugins/drive-recorder-plugin.ts) | Drive recording at runtime |
| `SensorRecorderPlugin` | `sensor-recorder` | [src/plugins/sensor-recorder-plugin.ts](src/plugins/sensor-recorder-plugin.ts) | Sensor history recording |
| `OrderManagerPlugin` | `order-manager` | [src/plugins/order-manager-plugin.tsx](src/plugins/order-manager-plugin.tsx) | Production order manager |

### Demo Model Plugins (loaded for `DemoRealvirtualWeb.glb`)

| Plugin | ID | File | Purpose |
|--------|----|------|---------|
| `KpiDemoPlugin` | `kpi-demo` | [src/plugins/demo/kpi-demo-plugin.ts](src/plugins/demo/kpi-demo-plugin.ts) | Seeded OEE/Parts/CycleTime demo data |
| `DemoHMIPlugin` | `demo-hmi` | [src/plugins/demo/demo-hmi-plugin.tsx](src/plugins/demo/demo-hmi-plugin.tsx) | Demo KPI cards, nav buttons, message tiles |
| `MachineControlPlugin` | `machine-control` | [src/plugins/demo/machine-control-plugin.ts](src/plugins/demo/machine-control-plugin.ts) | Start/stop control panel |
| `MaintenancePlugin` | `maintenance` | [src/plugins/demo/maintenance-plugin.ts](src/plugins/demo/maintenance-plugin.ts) | Maintenance checklist + progress |
| `TestAxesPlugin` | `test-axes` | [src/plugins/demo/test-axes-plugin.tsx](src/plugins/demo/test-axes-plugin.tsx) | Manual axis slider |
| `PerfTestPlugin` | `perf-test` | [src/plugins/demo/perf-test-plugin.ts](src/plugins/demo/perf-test-plugin.ts) | Performance benchmark (`?perf`) |

### Data Access Patterns

| Plugin | Public API | Hook |
|--------|-----------|------|
| `KpiDemoPlugin` | `.oeeData`, `.partsData`, `.cycleTimeData`, `.partsTarget`, `.taktTimeMs` | `useKpiData()` |
| `TransportStatsPlugin` | `.timeBuffer`, `.spawnedBuffer`, `.consumedBuffer` (RingBuffers) | `useTransportStats(ms?)` |
| `SensorMonitorPlugin` | `.eventHistory` (RingBuffer) | `useSensorState(path)` |

---

## 13. Per-Model Plugin System

Plugins are organized into three tiers:

1. **Core plugins** (`core: true`) — Always loaded, survive model switches. Cannot be removed via `removePlugin()`.
2. **Global private plugins** — Always loaded when the private folder is present (e.g., LayoutPlanner, DES).
3. **Model-specific plugins** — Loaded/unloaded dynamically when a model is loaded or switched.

Each model declares which plugins it needs via a `plugins/index.ts` entry point. When switching models, the previous model's plugins are fully unloaded (disposed, UI slots removed) and the new model's plugins are loaded.

### Creating Model-Specific Plugins

Create a `plugins/index.ts` in one of these locations:

- **Public models**: `src/plugins/models/<ModelName>/index.ts`
- **Private projects**: `projects/<projectname>/plugins/index.ts`

The file must export three things:

```typescript
import type { RVViewer } from '../../../core/rv-viewer';
import type { ModelPluginModule } from '../../../core/rv-model-plugin-manager';

// Which GLB filenames (without .glb) this module handles
export const models = ['MyModel', 'MyModelVariant'];

const registeredIds: string[] = [];

export function registerModelPlugins(viewer: RVViewer): void {
  const plugins = [
    new MyCustomPlugin(),
    new WebXRPlugin(),    // Optional: include only if this model needs VR/AR
  ];
  for (const p of plugins) {
    viewer.use(p);
    registeredIds.push(p.id);
  }
}

export function unregisterModelPlugins(viewer: RVViewer): void {
  for (const id of registeredIds) {
    viewer.removePlugin(id);
  }
  registeredIds.length = 0;
}

export default { models, registerModelPlugins, unregisterModelPlugins } satisfies ModelPluginModule;
```

### How It Works

1. `ModelPluginManager` uses `import.meta.glob` to discover all `plugins/index.ts` files at build time
2. When `viewer.loadModel(url)` is called, the manager extracts the model filename
3. It finds the matching plugin module (by `models` array or folder name)
4. Previous model's `unregisterModelPlugins()` is called — all plugins are disposed and removed
5. New model's `registerModelPlugins()` is called — plugins are registered via `viewer.use()`
6. Registered plugins receive `onModelLoaded` retroactively (standard `viewer.use()` behavior)

### Plugin Management API

```typescript
// Register a plugin (standard)
viewer.use(new MyPlugin());

// Remove a non-core plugin (dispose + remove from all arrays + UI)
viewer.removePlugin('my-plugin');  // returns true if removed

// Disable a plugin (keeps it registered but skips all callbacks)
viewer.disablePlugin('my-plugin');
```

### Example: Demo Model Plugins

The built-in demo model (`DemoRealvirtualWeb.glb`) registers its plugins in `src/plugins/models/DemoRealvirtualWeb/index.ts`:

```
src/plugins/models/DemoRealvirtualWeb/index.ts
  ├── KpiDemoPlugin        (OEE KPI cards)
  ├── DemoHMIPlugin        (buttons, messages, navigation)
  ├── TestAxesPlugin       (manual axis control)
  ├── MachineControlPlugin (start/stop panel)
  ├── MaintenancePlugin    (maintenance checklists)
  ├── WebXRPlugin          (VR/AR)
  ├── MultiuserPlugin      (presence)
  ├── FpvPlugin            (first-person walkthrough)
  └── AnnotationPlugin     (3D markers)
```

### Example: Private Project Plugins

A private project (e.g., Mauser 3D HMI) registers its plugins in `projects/mauser3dhmi/plugins/index.ts`. Only the plugins this specific project needs are loaded:

```
projects/mauser3dhmi/plugins/index.ts
  ├── WebXRPlugin          (VR/AR)
  ├── MultiuserPlugin      (presence)
  ├── FpvPlugin            (first-person walkthrough)
  ├── AnnotationPlugin     (3D markers)
  └── (custom Mauser HMI plugins)
```

---

## 14. Context Menu System

Plugin-extensible right-click context menus on 3D objects. Plugins register menu items via `ContextMenuStore`; items are filtered by `condition` callbacks at open time and sorted by `order`.

### Registering Menu Items

```typescript
import { contextMenuStore, type ContextMenuRegistration } from './core/hmi/context-menu-store';

// In plugin onModelLoaded or constructor:
contextMenuStore.register({
  pluginId: 'my-plugin',
  items: [
    {
      id: 'focus-camera',
      label: 'Focus Camera',
      action: (target) => viewer.focusByPath(target.path),
      order: 10,
    },
    {
      id: 'inspect-drive',
      label: (target) => `Inspect ${target.path.split('/').pop()}`,  // Dynamic label
      condition: (target) => target.types.includes('Drive'),         // Only for drives
      action: (target) => openDrivePanel(target.path),
      order: 20,
      dividerBefore: true,       // Visual separator above this item
    },
    {
      id: 'delete-item',
      label: 'Remove',
      condition: (target) => target.types.includes('MU'),
      action: (target) => removeMU(target.path),
      order: 900,
      danger: true,              // Renders in red/warning color
    },
  ],
});
```

### ContextMenuItem Interface

```typescript
interface ContextMenuItem {
  id: string;                                                // Unique item ID
  label: string | ((target: ContextMenuTarget) => string);   // Static or dynamic label
  icon?: string;                                             // Optional icon name
  action: (target: ContextMenuTarget) => void;               // Click handler
  condition?: (target: ContextMenuTarget) => boolean;        // Filter (errors → false)
  order?: number;                                            // Sort order (default: 100)
  danger?: boolean;                                          // Red/warning style
  dividerBefore?: boolean;                                   // Visual separator above
}

interface ContextMenuTarget {
  path: string;                        // Full hierarchy path of the right-clicked node
  node: Object3D;                      // Three.js node reference
  types: string[];                     // Component types on this node (e.g. ['Drive', 'Sensor'])
  extras: Record<string, unknown>;     // Raw GLB extras
}
```

### Unregistering on Dispose

```typescript
// In plugin dispose():
contextMenuStore.unregister('my-plugin');
```

### React Hook

```typescript
import { useContextMenu } from './core/hmi/context-menu-store';

function MyComponent() {
  const menu = useContextMenu();
  // menu.open, menu.pos, menu.target, menu.items (ResolvedContextMenuItem[])
}
```

### Trigger Behavior

- **Desktop**: Right-click on 3D canvas with drag-distance guard (`DRAG_THRESHOLD_PX`)
- **Touch**: Long-press (500ms) on 3D canvas
- **Item filtering**: `condition` callbacks are wrapped in try/catch — errors are treated as `false`
- **Empty menu**: If zero items pass their conditions, the menu does not open

---

## 14b. Context-Aware UI Visibility

The `ui-context-store` provides data-driven visibility for HMI elements based on active "contexts" — special modes like FPV navigation, layout planner, maintenance, or XR sessions that should hide irrelevant UI.

### Concepts

- **Context**: A named mode string (e.g. `'fpv'`, `'planner'`, `'maintenance'`, `'xr'`, `'kiosk'`)
- **Rule**: Per UI element, defines when it should be hidden or shown
- **Store**: Module-level singleton with `useSyncExternalStore` integration

### Activating Contexts from Plugins

```typescript
import { activateContext, deactivateContext, setContext } from './core/hmi/ui-context-store';

// In plugin onStart:
activateContext('fpv');       // Hide elements with hiddenIn: ['fpv']

// In plugin onDestroy:
deactivateContext('fpv');     // Restore visibility
```

### Subscribing in React

```typescript
import { useUIVisible } from './core/hmi/ui-context-store';

function KpiBar() {
  // Second argument registers a default rule (overridable by settings.json)
  const visible = useUIVisible('kpi-bar', { hiddenIn: ['fpv', 'xr'] });
  if (!visible) return null;
  return <div>...</div>;
}
```

### Rule Registration

Rules can be registered programmatically or via `settings.json`:

```typescript
import { registerUIElement } from './core/hmi/ui-context-store';

// Programmatic (typically in module-level or plugin init)
registerUIElement('my-panel', { hiddenIn: ['fpv', 'planner'] });
registerUIElement('kiosk-overlay', { shownOnlyIn: ['kiosk'] });
```

**From settings.json** — the `uiVisibility` block in settings.json overrides code-declared defaults (see [doc-webviewer.md](doc-webviewer.md) for format).

### Rule Precedence

1. Unknown element (no rule) → **visible**
2. `shownOnlyIn` defined and not ALL listed contexts active → **hidden**
3. `hiddenIn` — if ANY listed context is active → **hidden**
4. Otherwise → **visible**

Rules compose with the existing `H` key HMI toggle via AND logic: `{hmiVisible && useUIVisible('element') && <Element />}`

---

## 15. Internal Managers (CameraManager, VisualSettingsManager)

`rv-viewer.ts` delegates camera and visual settings operations to two internal manager classes, extracted for maintainability. These are **not part of the public plugin API** but are documented here for contributor reference.

### CameraManager (`rv-camera-manager.ts`)

Manages perspective/orthographic camera switching, smooth camera animations, viewport offset computation, and FOV control.

```typescript
// Accessed internally by RVViewer — not exported to plugins
class CameraManager {
  fov: number;                              // Perspective camera FOV
  projection: 'perspective' | 'orthographic';  // Switch camera type
  isCameraAnimating: boolean;               // Animation in progress?

  animateCameraTo(pos, target, duration);   // Smooth cubic ease-out animation
  tickCameraAnimation(dtSec);               // Advance animation (called per frame)
  cancelCameraAnimation();                  // Stop mid-animation

  getCurrentViewportOffset();               // Panel offsets for centered focus
  applyViewportOffset(center, dist, offset); // Shift target for panel-aware centering
  computeNodeBounds(nodes);                 // Bounding box from mesh renderers
  syncOrthoFrustum();                       // Match ortho frustum to perspective FOV
}
```

### VisualSettingsManager (`rv-visual-settings-manager.ts`)

Manages tone mapping, shadows, lighting mode, ground plane, DPR, and environment maps.

```typescript
class VisualSettingsManager {
  lightingMode: 'simple' | 'default';       // Simple (ambient) or Default (env map + dir light)
  toneMapping: ToneMappingType;              // none, linear, reinhard, cineon, aces, agx, neutral
  toneMappingExposure: number;

  ambientColor: string;                      // Hex color
  ambientIntensity: number;
  dirLightEnabled: boolean;
  dirLightColor: string;
  dirLightIntensity: number;

  shadowEnabled: boolean;
  shadowIntensity: number;
  shadowQuality: 'low' | 'medium' | 'high';  // 512 / 1024 / 2048 shadow map

  maxDpr: number;                            // Device pixel ratio cap
  lightIntensity: number;                    // Unified intensity (mode-aware)
}
```

Both managers receive a shared state interface from `RVViewer` and operate on it directly — no events or callbacks, just property access.

---

## 16. Key Design Decisions

**Why unified plugins with optional UI slots?**
A single `RVViewerPlugin` interface handles both simulation lifecycle and UI registration. Plugins declare `slots?: UISlotEntry[]` — if present, the HMI renders them; if absent, the plugin is data-only. This avoids the overhead of separate "core" and "UI" plugin classes for what is usually one logical feature. The plugin class itself has no React dependency — only the slot component functions use React.

**Why try/catch around every plugin callback?**
A single faulty plugin must never freeze the simulation. Errors are logged but execution continues.

**Why cached plugin arrays (prePlugins, postPlugins, renderPlugins)?**
Instead of checking `if (plugin.onFixedUpdatePre)` for every plugin at 60Hz, plugins are sorted into cached arrays once during `use()`. The hot path is a simple for-loop.

**Why handlesTransport flag?**
When a physics engine (Rapier.js) replaces the kinematic transport, it sets `handlesTransport: true`. The core loop skips `transportManager.update(dt)` automatically. No core code changes needed.

**Why render chart overlays outside HMIShell?**
`HMIShell` has `pointer-events: none` on its container so the 3D scene remains interactive. Chart panels need pointer events for drag/resize, so they render as siblings in `App.tsx`.

**Why RVBehavior base class?**
Mirrors Unity's MonoBehaviour pattern. Every plugin repeated the same boilerplate: store/null-check viewer, find drives, cleanup subscriptions. `RVBehavior` handles this automatically. Subclasses override named hooks (`onStart`, `onPreFixedUpdate`, etc.) instead of implementing raw interface methods.

**Why two signal lookup tables (name + path)?**
Signals need to be addressed by **name** for communication (plugin API, HMI, interfaces) and by **path** for GLB object references (ComponentRef). The name is the signal's identity (Signal.Name if set, otherwise node name); the path is its location in the scene hierarchy. Both resolve to the same underlying value.

---

## 17. Gizmo Overlay System (`viewer.gizmoManager`)

The `GizmoOverlayManager` is the central tool for rendering visual overlays on top of any 3D node. It is **generic** — sensors, drives, grips, stations, or any custom component can request a gizmo without knowing implementation details.

### Public API

```typescript
import type { GizmoOverlayManager, GizmoShape, GizmoOptions, GizmoHandle } from '@/core';

// Available on every viewer:
viewer.gizmoManager.create(node, opts): GizmoHandle;
viewer.gizmoManager.clearNode(node): void;
viewer.gizmoManager.setGlobalVisibility(visible): void;
viewer.gizmoManager.setGlobalShapeOverride(shape | null): void;
viewer.gizmoManager.setTagFilter(tag | null): void;
```

### Gizmo Shapes

| Shape | Renders | Notes |
|-------|---------|-------|
| `'box'` | AABB wireframe of the subtree | Cheap, unobtrusive |
| `'transparent-shell'` | Filled transparent box on subtree-AABB | **Default for WebSensor** — volumetric |
| `'mesh-overlay'` | Overlay mesh per `isMesh` descendant | Best when the node has multiple visible parts (lamp = housing + lens + base); non-Mesh children (Group, Light, Camera) are filtered out |
| `'sphere'` | Sphere centered on subtree | Point sensors |
| `'sprite'` | Camera-facing billboard (icon) | Always visible |
| `'text'` | Camera-facing label, `depthTest: false`, `renderOrder: 11` | NOT a tooltip — always visible, controlled by the component (not by hover state); each text gizmo gets its own `CanvasTexture` (not material-cached) |

### `GizmoOptions`

```typescript
interface GizmoOptions {
  shape: GizmoShape;
  color: number;            // 0xRRGGBB
  opacity: number;          // 0..1
  blinkHz?: number;         // 0 = no blink, > 0 = square-wave opacity modulation
  size?: number;            // default 1.0
  visible?: boolean;
  renderOrder?: number;     // default 10 (text default 11)
  depthTest?: boolean;      // default true (text default false)
  text?: string;            // required for shape: 'text'
  textOffsetY?: number;     // world-units above subtree-top
}
```

### Material sharing & blink

Materials are cached by `${color}_${opacity}_${depthTest}_${blinkHz}` — sensors that share **all four** properties share one material instance. Blink is modulated **once per material per frame** in the central `tick()` loop (called from `RVViewer.fixedUpdate()`). This guarantees no opacity conflicts even when many gizmos use the same color but different blink rates: they end up on different materials.

### Subtree behavior

All shapes are subtree-aware:
- Bounding shapes (`box`, `transparent-shell`, `sphere`) compute the AABB over **all mesh descendants** of the node
- `mesh-overlay` creates one overlay-mesh **per descendant Mesh** (skipping `Group`/`Light`/`Camera`/etc.)
- Subtree-AABB is computed **once at `create()`** (assumes static scene); for moving objects, dispose and re-create the gizmo

### Example: a custom component using gizmos

```typescript
class MyComponent implements RVComponent {
  private _gizmo?: GizmoHandle;
  init(ctx: ComponentContext): void {
    if (!ctx.gizmoManager) return;     // gizmoManager is OPTIONAL on ComponentContext
    this._gizmo = ctx.gizmoManager.create(this.node, {
      shape: 'transparent-shell',
      color: 0x00ff00,
      opacity: 0.4,
    });
  }
  dispose(): void { this._gizmo?.dispose(); }
}
```

---

## 18. Component Event Dispatcher (`viewer.componentEventDispatcher`)

Most components need to react when their node is hovered, clicked, or selected. Rather than every component subscribing to `viewer.on('object-hover'/'object-clicked'/'selection-changed')` and filtering, the `ComponentEventDispatcher` does the routing centrally.

### How it works

`registerComponent({ ... })` automatically tags `node.userData._rvComponentInstance = inst` in `afterCreate`. The dispatcher listens to the viewer's raycast/selection events, walks up the parent chain to find a tagged node, and invokes the matching component's optional callbacks:

```typescript
interface RVComponent {
  // Required (existing):
  readonly node: Object3D;
  init(ctx: ComponentContext): void;

  // Optional event callbacks (NEW — additive, no existing implementer breaks):
  onHover?(hovered: boolean, event?: ObjectHoverData): void;
  onClick?(event: { path: string; node: Object3D }): void;
  onSelect?(selected: boolean): void;
  dispose?(): void;
}
```

### Important details

- Subscribes to the **real** event channels: `object-hover`, `object-unhover`, `object-clicked` (NOT the declared-but-unemitted `object-click`), `selection-changed`
- Selection is resolved via `SelectionSnapshot.selectedPaths` + `registry.getNode(path)` (NOT a non-existent `nodes` field)
- `onSelect(false)` fires for nodes that **leave** the selection (tracked via internal `Set<Object3D>`)
- All callback invocations are wrapped in `try/catch` — a faulty component never breaks the dispatcher
- Listener cleanup on `dispose()`: viewer subscriptions are stored as unsubscribe fns and called on disposal (no listener leaks on scene reload)

### Example

```typescript
class MyHoverableComponent implements RVComponent {
  init(ctx: ComponentContext): void { /* ... */ }
  onHover(hovered: boolean): void {
    this._gizmo?.update({ size: hovered ? 1.15 : 1.0 });
  }
  onClick(event): void { console.log('Clicked at', event.path); }
  onSelect(selected: boolean): void {
    this._gizmo?.update({ color: selected ? 0xffff00 : 0x808080 });
  }
}
```

---

## 19. WebSensor & `initWebSensor()` Configuration API

`WebSensor` (Unity component) → `RVWebSensor` (TypeScript) is the canonical reference implementation that uses both `gizmoManager` and the event dispatcher. See [doc-webviewer.md](./doc-webviewer.md) for end-user documentation. The developer-facing aspect:

### Customizing default visuals via `initWebSensor()`

All WebSensor visual parameters (state colors, opacities, blink rates, default shape, default size, default int→state map) are **hardcoded constants** but **overridable** at runtime via a config API. Call this from a model's `index.ts` (per-project styling) or from the app bootstrap (global corporate design):

```typescript
import { initWebSensor, resetWebSensorConfig } from '@/core';

// Brand-color override + slower warning blink + custom int mapping
initWebSensor({
  stateStyles: {
    high:    { color: 0x00a030, opacity: 0.60 },   // brand green (other fields kept)
    warning: { blinkHz: 0.5 },                      // slower pulse
  },
  defaultIntStateMap: { 0: 'low', 10: 'high', 20: 'warning', 30: 'error' },
  defaultShape: 'mesh-overlay',
  defaultSize: 1.5,
});

// To restore baked-in ISA-101 defaults:
resetWebSensorConfig();
```

`stateStyles` uses **deep partial merge** — only the fields you specify override; unspecified fields keep their current value. `initWebSensor()` is additive across multiple calls.

### Default state styling (ISA-101 aligned)

| State | Color | Opacity | Blink | Meaning |
|-------|-------|---------|-------|---------|
| `low` | `#808080` (grey) | 0.35 | — | Normal / inactive |
| `high` | `#3080ff` (blue) | 0.55 | — | Active / OK |
| `warning` | `#ffaa00` (amber) | 0.70 | 1 Hz | Attention |
| `error` | `#ff2020` (red) | 0.85 | 2 Hz | Alarm |
| `unbound` | `#404040` (dark grey) | 0.20 | — | Signal not resolved |

### Public API exports

The barrel `src/core/index.ts` exposes:

- `WebSensor`-related: `initWebSensor`, `resetWebSensorConfig`, `WebSensorConfig`, `WebSensorInitOptions`, `WebSensorState`, `StateStyle`
- `Gizmo`-related: `GizmoOverlayManager`, `GizmoShape`, `GizmoOptions`, `GizmoHandle`
- `Events`: `ComponentEventDispatcher`

---

## 20. Other Feature Plugins (one-paragraph orientation)

These plugins are documented inline (in their source) rather than in dedicated long-form pages. Use this section as a map; the linked file is the canonical spec.

### Process simulation: Pipe / Tank / Pipeline / SafetyDoor

- **Pipe flow propagation** — [src/core/engine/rv-pipe-flow.ts](src/core/engine/rv-pipe-flow.ts). Propagates flow values through connected `Pipe` components based on graph traversal; works hand-in-hand with `Pump` and `Tank`.
- **Pipeline simulation** — [src/core/engine/rv-pipeline-sim.ts](src/core/engine/rv-pipeline-sim.ts). Higher-level pipeline orchestration: pump speed, tank levels, processing-unit throughput.
- **Tank fill** — [src/core/engine/rv-tank-fill.ts](src/core/engine/rv-tank-fill.ts). Renders a fill-level visualization inside a tank mesh, driven by a signal or a `Tank` component value.
- **Safety door** — [src/core/engine/rv-safety-door.ts](src/core/engine/rv-safety-door.ts). Renders an amber hazard halo around a safety-door component when its zone is breached.

Each ships its own tooltip content provider (Pipe, Pump, Tank, ProcessingUnit). Author scenes in Unity with the matching components and they appear automatically — no plugin registration needed for the rendering side.

### Recorders

- **Drive recorder** — [src/plugins/drive-recorder-plugin.ts](src/plugins/drive-recorder-plugin.ts). Records drive position/speed/target during a session for later replay or analysis.
- **Sensor recorder** — [src/plugins/sensor-recorder-plugin.ts](src/plugins/sensor-recorder-plugin.ts). Records sensor occupied/free transitions with timestamps.

Both expose RingBuffers via the plugin instance — read them through `usePlugin<TheRecorder>('id')`.

### Camera start-position presets

[src/plugins/camera-startpos-plugin.tsx](src/plugins/camera-startpos-plugin.tsx) + [src/core/hmi/camera-startpos-store.ts](src/core/hmi/camera-startpos-store.ts) + [src/core/hmi/settings/CameraStartTab.tsx](src/core/hmi/settings/CameraStartTab.tsx). Per-model named camera positions, persisted in localStorage and embeddable in `rv_extras`. Activated automatically on model load if a `defaultStartPos` is set.

### Annotations + shared view

[src/plugins/annotation-plugin.ts](src/plugins/annotation-plugin.ts) + [src/core/hmi/AnnotationPanel.tsx](src/core/hmi/AnnotationPanel.tsx) + [src/core/hmi/SharedViewBanner.tsx](src/core/hmi/SharedViewBanner.tsx). 3D markers / labels / drawings on surfaces, with `?view=...` URL param for shareable curated views. Sync of annotations across multiuser sessions is handled by the `multiuser-plugin` integration.

### AAS / AASX linking

[src/plugins/aas-link-plugin.tsx](src/plugins/aas-link-plugin.tsx) + [src/plugins/aas-link-parser.ts](src/plugins/aas-link-parser.ts). Loads AASX packages from `public/aasx/` (or `assetsBasePath`), extracts embedded PDFs, and attaches them as `_rvPdfLinks` on matching nodes. Tooltip rendering is handled by the generic tooltip system (`tooltipType: 'aas'`). See also [doc-document-linking.md](doc-document-linking.md).

### Docs browser

[src/plugins/docs-browser-plugin.tsx](src/plugins/docs-browser-plugin.tsx) + [src/core/hmi/DocViewerOverlay.tsx](src/core/hmi/DocViewerOverlay.tsx) + [src/core/hmi/pdf-viewer-store.tsx](src/core/hmi/pdf-viewer-store.tsx). Built-in PDF viewer (page nav, zoom, open in new tab) for `_rvPdfLinks` entries. Auto-mounts when any node has PDF links.

### Order manager

[src/plugins/order-manager-plugin.tsx](src/plugins/order-manager-plugin.tsx). Production order list / status panel — useful for OEE-style demos and operator HMIs. Reads orders from the plugin's own state; pair with a custom feeder plugin for live data.

### Blueprint / 2D plan view

[src/plugins/blueprint-plugin.ts](src/plugins/blueprint-plugin.ts). Top-down 2D plan view overlay; useful as a mini-map or layout preview.

### MCP bridge & MCP tool authoring

[src/plugins/mcp-bridge-plugin.ts](src/plugins/mcp-bridge-plugin.ts) opens a WebSocket to the Python MCP server. Tools are declared on `RVBehavior` subclasses with the `@McpTool` and `@McpParam` decorators in [src/core/engine/rv-mcp-tools.ts](src/core/engine/rv-mcp-tools.ts) — the bridge auto-discovers them on connect and registers JSON tool schemas. To add a new tool: subclass `RVBehavior`, decorate an async method, and register the plugin. The user-facing tool catalog is [webviewer.mcp.md](webviewer.mcp.md).

### Where the public RVViewer API is documented

There is no separate API reference yet. The authoritative surface is [src/core/rv-viewer.ts](src/core/rv-viewer.ts) (search for `class RVViewer` and `interface ViewerEvents`). Most plugin-relevant calls are described in §3 (RVViewerPlugin / RVBehavior), §4 (Events), §5 (UI Slots), §9 (Left Panels), §13 (Per-Model Plugins) above.
