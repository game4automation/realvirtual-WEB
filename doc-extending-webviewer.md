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

> **For wiring a single GLB to drives, sensors, transports, signals and AAS
> links, use Component Behaviors — not plugins.** See
> **[doc-behaviors.md](doc-behaviors.md)**. Behaviors are auto-discovered
> per-file, scoped to matching GLBs, and auto-disposed on model-cleared.
> Plugins remain the right tool for cross-cutting, global features (XR,
> Multiuser, custom HMI panels, etc.).

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
    │   └── Settings LeftPanel         //     Model / Visual / Interfaces / Dev / Tests
    <ActivityBar />                    //   Left vertical icon strip — window openers (slot: activity-bar)
    <ButtonPanel />                    //   Floating left tool toolbar — contextual mode tools (slot: button-group)
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

### ActivityBar and ButtonPanel — Left Side

The left side has two distinct components:

- **`ActivityBar`** — the left vertical icon strip (slot: `activity-bar`). It holds window-opener buttons; clicking one opens a left-docked window via the `LeftPanelManager`.
- **`ButtonPanel`** — a floating left tool toolbar (slot: `button-group`). It holds contextual mode tools (grid, snap, measurement) and floats over the 3D view. It also renders the logo + status indicator.

The floating `ButtonPanel` automatically shifts right to clear the activity bar and any open left panel, reading `activePanelWidth` from the `LeftPanelManager`.

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

### How Unity Components Map to realvirtual WEB

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
| `WebError` | `RVWebError` | `rv-web-error.ts` |
| `WebVisibility` | `RVWebVisibility` | `rv-web-visibility.ts` |
| `CustomRuntimeInstruction` | `RVCustomRuntimeInstruction` | `rv-custom-runtime-instruction.ts` |
| `PLCOutputBool/Float/Int` | Signal entry in `SignalStore` | `rv-signal-store.ts` |
| `PLCInputBool/Float/Int` | Signal entry in `SignalStore` | `rv-signal-store.ts` |
| `DrivesRecorder` | `RVDrivesPlayback` | `rv-drives-playback.ts` |
| `ReplayRecording` | `RVReplayRecording` | `rv-replay-recording.ts` |
| `MachiningVolume` | `RVMachiningVolume` | `rv-machining-volume.ts` |
| `MachiningTool` | `RVMachiningTool` | `rv-machining-tool.ts` |

### Runtime messages and instructions

Three components feed the right-side message panels instead of animating geometry:

- **`WebError` → `RVWebError`** — a single bool error signal plus a text message; while the signal is high the part flashes in its error color, a text badge appears, and the error registers in the `ErrorStore`.
- **`WebVisibility` → `RVWebVisibility`** — show/hide on a signal, with an optional second error signal that mirrors `WebError`'s behavior.
- **`CustomRuntimeInstruction` → `RVCustomRuntimeInstruction`** — the richer instruction component: five types (Info / Maintenance / Warning / Error / Success), an ordered step list (each step carries an instruction text, an optional camera target and an optional document URL), an optional dismiss button, and a bool signal that pushes the card on a rising edge and removes it on a falling edge. It registers entries in the `InstructionRuntimeStore` (singleton on `viewer.instructionStore`) and the `CustomRuntimeInstructionPlugin` renders them as cards in the `'messages'` slot. A type-colored highlight gizmo (color from `ErrorColor` when `UseCustomErrorColor` is set, otherwise the type color; blink rate from `BlinkSpeed`) marks the owning node while the card is active. The View button focuses + highlights a step's `targetObject`; the document button opens its `url` in the embedded document viewer. `steps` and `ErrorColor` are read raw from `node.userData.realvirtual` (a nested object list and a Unity `Color` have no schema field type), and the step parser tolerates both a JSON array and the legacy numeric-keyed object form.

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

### Adding a New Component Type (Unity → realvirtual WEB)

To map an existing Unity component to realvirtual WEB:

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
    ctx.registry.register('MyComponent', ctx.registry.getPathForNode(this.node) ?? '', this);
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
| `hierarchyVisible` | boolean | `true` | Declared but **not read anywhere** — see the note below |
| `tooltipType` | string/null | `null` | Tooltip content type (key in tooltip-registry) |
| `badgeColor` | string | `'#90a4ae'` | Hex color for hierarchy browser badge |
| `filterLabel` | string/null | `null` | Label in search/filter dropdown |
| `hoverEnabledByDefault` | boolean | `false` | Auto-enable hover after scene load |
| `exclusiveHoverGroup` | boolean | `false` | Part of Drive/Sensor/MU toggle group |
| `authorable` | boolean | `false` | Can be added to a node in the asset editor's "Add Component" section (needs a complete schema — initial values come from `getSchemaDefaults`) |

> **There is no `simulationActive` capability.** Earlier revisions of this table
> listed one; it never existed in `ComponentCapabilities` and nothing ever read
> it. A component that needs a per-frame tick gets a **dedicated viewer-owned
> manager** instead — see § Per-frame components below.

> **`hierarchyVisible` currently does nothing** (measured, plan-431 §2.8).
> `rg -n "hierarchyVisible" src` finds 11 hits: the declaration, the default and
> nine components that SET it — and not one place that reads it. The hierarchy builds
> its type list in `RvExtrasEditorPlugin._scanEditableNodes`, which filters
> through `isHiddenComponentType()`, i.e. through **`inspectorVisible`** only. So
> a type set `hierarchyVisible: false` still gets a chip — `rv-jt-data.ts` sets
> it precisely to keep JT metadata out of the hierarchy, and the chip is there
> anyway. The flag that actually removes a type from BOTH surfaces is
> `inspectorVisible: false`.
> Documented rather than fixed: making it live would change what existing models
> show. Set it for intent, but do not rely on it.

### A metadata entry with no factory (data that is not a component)

Some rv_extras entries carry no behaviour at all — they are facts ABOUT a node that other
code reads. Those want a schema and capabilities but **no `create` factory**, which is a
deliberate choice with consequences worth knowing before you make it.

`registerComponentSchema(type, schema, capabilities?)` is the one call for this. It
registers the schema (so field descriptors resolve, `getSchemaDefaults` can seed an
`authorable` "Add Component", and the extras validator stops treating the fields as
unknown) and the capabilities, without any factory. `Group` (`rv-group-component.ts`),
`JTData` (`rv-jt-data.ts`) and `NodeKnowledge` (`rv-node-knowledge.ts`) all do this.

```typescript
// src/core/engine/rv-node-knowledge.ts — one overwritable Markdown note per node
registerComponentSchema('NodeKnowledge', {
  Note:      { type: 'string', default: '' },
  UpdatedAt: { type: 'string', default: '' },
  Author:    { type: 'enum', enumMap: { agent: 'agent', user: 'user' }, default: 'agent' },
  // …
}, {
  authorable: true,
  hoverable: false,      // data, not an interactive object — no tooltip, no HMI surface
  selectable: false,
  badgeColor: '#8d6e63',
});
```

What follows from having no factory:

- **No live instance is ever created.** `constructComponentOnNode` returns `null` for a
  factory-less type, so nothing lands in the NodeRegistry and the entry costs nothing per
  tick. It also means `web_component_get` / `_get_all` (which serialize registry instances)
  cannot see it.
- **`applySchema` never runs at load.** The schema's defaults are therefore NOT applied to
  loaded data — they only feed `getSchemaDefaults` for newly authored entries. **Your read
  path has to default for itself.** `readNodeKnowledge()` is the shape to copy: read raw
  `userData.realvirtual[type]`, narrow every field, return `null` when the entry is absent.
- **Read raw `userData`, not the registry.** Besides there being no instance, a value written
  in the current session lives in `userData` long before any reload; a registry-based read
  would report the old state (or nothing).
- **Writing still works normally.** The persistence chain validates no names, so
  `EditTarget.setField` creates the entry and it round-trips into the GLB. That cuts both
  ways — a typo'd field name is written permanently and silently — which is why anything
  authoring such an entry programmatically should hold the type and field names in
  **constants** rather than accept them as parameters.
- **The optimistic UI mirror does not create the entry.** `updateOverlayField` reflects a
  write into `userData` via `applyFieldToScene`, which returns early when the component key
  does not exist yet. For the FIRST field of a new entry that is a no-op, and the entry only
  appears once the op queue flushes. If a caller reads back synchronously, it has to stamp
  the entry itself — see `mirrorIntoUserData` in `rv-mcp-knowledge-tools.ts`.
- **You still owe the rv-ODT coverage test an answer.** `registerComponentSchema` puts the
  type into `getRegisteredSchemaTypes()`, and `tests/spec-loading.test.ts` asserts that every
  registered schema either has an entry in `schema/v1/rv-odt.json` or is declared out of
  scope. A WEB-only type belongs on the out-of-scope list (`OUT_OF_SCOPE_EXACT`) with a
  reason — rv-ODT describes types that exist on BOTH sides, so listing a WEB-only type there
  would claim an interchange contract that does not exist. Skip this and the suite fails with
  *"registered but missing from rv-ODT v1"*.

Use plain `registerCapabilities(type, caps)` instead when there is no schema to register at
all — a pipeline marker or an externally-defined key such as `AASLink`.

### Custom field renderers (when one field needs more than a row)

The Property Inspector renders one `FieldRow` per rv_extras field. When a field
holds something a single row cannot show — a nested step list, 2400 characters of
Markdown — replace that row with a component via `fieldRendererRegistry`
(`rv-field-renderer-registry.ts`). The key is `(componentType, fieldName)`, and
the renderer wins over the `FieldRow` for that pair.

```typescript
// at the bottom of your renderer module
fieldRendererRegistry.register({
  componentType: 'NodeKnowledge',
  fieldName: 'Note',
  component: NodeKnowledgeNoteRenderer,   // gets FieldRendererProps
});
```

**The step that is easy to miss: side-effect-import your module in `App.tsx`.**
Nothing imports a renderer module for its exports — registration IS the module's
effect, so a module nobody imports never runs. `App.tsx` carries the list:

```typescript
import './rv-metadata-field-renderer';
import './rv-ik-path-field-renderer';
import './rv-custom-runtime-instruction-field-renderer';
import './rv-node-knowledge-field-renderer';
```

Forget that line and the renderer works in every test that imports it directly
while the running application still shows the plain editable row. Test it
through the bootstrap path (import `App`, then query the registry), not through
a module import — `tests/rv-node-knowledge-field-renderer.test.tsx` does exactly
that.

**Taking over sibling fields — use `HIDDEN_FIELDS_PER_TYPE`.** A renderer that
also presents neighbouring fields (a provenance header showing `UpdatedAt`,
`Author`, `Confidence`, `NodeIdAtWrite`) has to stop those fields rendering their
own rows. Add them to `HIDDEN_FIELDS_PER_TYPE` in `rv-inspector-helpers.ts`:

```typescript
export const HIDDEN_FIELDS_PER_TYPE: Record<string, ReadonlySet<string>> = {
  LayoutObject: new Set(['Locked', 'Visible']),      // shown by ObjectHeaderSection
  Splat: new Set(['InvertX', 'InvertY', 'InvertZ']), // shown as action buttons
  NodeKnowledge: new Set(NODE_KNOWLEDGE_PROVENANCE_FIELDS), // shown in the renderer's header
};
```

`isFieldHidden()` runs in `ComponentSection` **before** the consumed/other split,
so a hidden field reaches neither a `FieldRow` nor an edit callback. Note the
value type: a `ReadonlySet`, not an array — `isFieldHidden` calls `.has()`.

**This is also how you make a field read-only in the UI.** Do NOT reach for
`readonly: true` in the schema for that: `isFieldDisplayReadonly` is the single
predicate shared by the inspector's editability gate **and** the
`updateOverlayField` write guard, so the flag blocks programmatic writes too —
including every MCP tool that goes through the overlay. For `NodeKnowledge` that
would have switched `web_knowledge_set` off entirely (measured: `readonly: true`
on `Note` alone turned 20 of 31 `mcp-knowledge-tools` tests red). Hiding the row
removes the editor and leaves the write path open. Use `readonly: true` only when
the value should be visible-but-frozen for *everyone*, tools included.

One caveat: the `readOnlyLive` short-circuit in `ComponentSection` (ephemeral
virtual components such as behavior live state and snap data) skips both
`isFieldHidden` and the renderer lookup and dumps every field as a plain row.
That branch is only reachable for the inspector's own `virtualComponents` list,
never for a persisted rv_extras entry.

### Per-frame components (the manager pattern)

Components are not ticked by the engine. A component that has to do something
every frame is driven by a small **viewer-owned manager**, and registers itself
with it. The live examples are `LampManager` (blink phase), `EnergyChainManager`
(bone poses) and `RVCollisionManager` (`rv-collision-manager.ts`, plan-394 —
per-tick AABB + `bvhcast` check between bodies of different `CollisionRole`s;
it owns the `'collision'` aux-emphasis set and the `CollisionActive` /
`CollisionCount` / `ResetCollisions` signals, and observes spawned MUs through
`RVTransportManager.muLifecycleHook`):

1. Write `rv-<name>-manager.ts` with `register` / `unregister` /
   `update(dt): boolean` / `clear()`. `update` returns whether anything visible
   changed.
2. Create it in `RVViewer`'s constructor, expose it as a `readonly` field, and
   call `clear()` from `clearModel()` **before** the material/geometry teardown.
3. Thread it through `ComponentContext` (rv-component-registry.ts) and
   `RuntimeNodeDeps` + both loader contexts (rv-scene-loader.ts) so components
   reach it from `init()` / `onSceneReady()`.
4. Tick it in `CoreSubsystems.visuals(dt)` and mark the viewer dirty on `true`.
   Mark **shadows** dirty too whenever the manager can move geometry: the drive
   loop only raises that flag for active positioning drives, so a component
   driven by a live signal or an external transform would otherwise keep a stale
   shadow.
5. The component registers itself in `init()`/`onSceneReady()` and unregisters
   in `dispose()`.

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

### Viewer Helper Methods

These typed helpers are preferred over direct `viewer.scene.traverse(...)` or `viewer.camera`
property access.

```typescript
// Iterate over every node registered in NodeRegistry (has userData.realvirtual).
// NOTE: This is NOT equivalent to scene.traverse() — it only visits nodes with
// rv_extras metadata. It does NOT do a full DFS over every Three.js Object3D.
// NOTE the argument order: the NODE comes first, the path second
// (`eachNode(fn: (node: Object3D, path: string) => void)`, rv-viewer.ts).
viewer.eachNode((node: Object3D, path: string) => {
  console.log(path, node.userData.realvirtual);
});

// Project a 3D Object3D to screen pixel coordinates.
// Pass an optional Vector2 as `out` for GC-free hot-path use.
const screenPos = viewer.projectToScreen(someNode);         // returns new Vector2
viewer.projectToScreen(someNode, outVec2);                  // writes into outVec2

// Project a world-space Vector3 to screen pixel coordinates.
const screenPos2 = viewer.projectPoint(new THREE.Vector3(1, 0, 0));

// Get a snapshot of current camera state (position, target, quaternion).
const state = viewer.getCameraState();   // { position: Vector3, target: Vector3, quaternion: Quaternion }
viewer.getCameraState(outState);         // GC-free: write into provided object

// Set multiple OrbitControls options at once.
viewer.setControlsConfig({
  rotateSpeed: 0.8,
  panSpeed: 0.5,
  zoomSpeed: 1.2,
  dampingFactor: 0.05,
  enabled: true,
});

// Toggle renderer stats logging (renders info, draw calls).
viewer.setDebugLogging(true);
viewer.setDebugLogging(false);
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
| `root` | `Object3D` | The GLB root added to the scene — track the new model without diffing `scene.children` |
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

This result is passed to all plugins via `onModelLoaded(result, viewer)`. The table lists the
fields plugins commonly read; `LoadResult` carries more (`modelConfig`, `recorderSettings`, the
batching/dedup results, `raycastGeometrySet`, …) — the full shape is in
[src/core/engine/rv-scene-loader.ts](src/core/engine/rv-scene-loader.ts).

### NodeRegistry growth from lazy LayoutObject expansion

When the user expands a LayoutObject row in the Hierarchy Panel, the tree builder injects the Three.js subtree into the panel and registers any previously-unseen child paths in `NodeRegistry`. Plugins that iterate `registry.forEachNode(...)` should therefore not assume the set of paths stays stable for the lifetime of a model — new paths can appear at any time when the user opens a placed catalog item. Treat `NodeRegistry` as an open set: keep listeners idempotent and address nodes by path (`getNode(path)`), never by integer index.

### Selection sources (`selectNode(path, showInspector, source)`)

The hierarchy editor distinguishes three kinds of selection:

- `'viewport'` — 3D-pick from the canvas; resolves up to the enclosing LayoutObject root so clicking any sub-mesh selects the whole placed object. This is the default behavior the raycast pipeline produces.
- `'tree'` — explicit pick from the Hierarchy Panel; keeps the exact path so nested drive/sensor properties become editable.
- `'api'` (default) — programmatic call from plugins or tests; same as `'tree'`.

The two-argument legacy form `selectNode(path, true)` still works (treated as `source = 'api'`). New plugin code should pass an explicit source.

**Selection-bound 3D overlays:** the reference implementation for a plugin that reacts to selection with a passive scene overlay is [src/plugins/drive-axis-gizmo-plugin.ts](src/plugins/drive-axis-gizmo-plugin.ts) (drive motion axis: double arrow for linear, axis line + rotation ring for rotary drives). It shows the full pattern: subscribe to `viewer.on('selection-changed', …)`, resolve components via `registry.getByPath` with a bounded subtree fallback (a `'viewport'` selection lands on the LayoutObject root, so the drive may sit below the selected path), build shared-geometry meshes on `HIGHLIGHT_OVERLAY_LAYER` with `depthTest:false` (dispose shared resources only in `dispose()`, per deselect just `removeFromParent()`), sync world position/orientation per `onRender` with pre-allocated temps and a null-parent guard, and clean up in `onModelCleared`.

---

## 3. Core Plugins

### The RVViewerPlugin Interface

```typescript
// src/core/rv-plugin.ts

interface RVViewerPlugin {
  readonly id: string;                  // Unique ID, e.g. 'my-analytics'
  readonly order?: number;              // Execution order (lower = earlier, default: 100)
  readonly handlesTransport?: boolean;  // true = replaces kinematic transport
  readonly core?: boolean;              // true = always participates (see doc-ui-visibility.md)
  readonly modes?: ModeId[];            // Workspace modes this plugin runs in (undefined = all)
  readonly slots?: UISlotEntry[];       // Optional UI components for HMI layout slots

  /** Called by viewer.use() — receives the narrower PluginContext facade. */
  init?(viewer: RVViewer, context?: PluginContext): void;

  onModelLoaded?(result: LoadResult, viewer: RVViewer): void;
  onModelCleared?(viewer: RVViewer): void;
  onConnectionStateChanged?(state: 'Connected' | 'Disconnected', viewer: RVViewer): void;
  onFixedUpdatePre?(dt: number): void;   // 60Hz, BEFORE drive physics
  onFixedUpdatePost?(dt: number): void;  // 60Hz, AFTER drive physics + transport
  onRender?(frameDt: number): void;      // Per render frame

  // Workspace mode hooks (plan-198) — everything created in onModeActivate MUST
  // be released in onModeDeactivate; the plugin instance survives mode switches.
  onModeActivate?(mode: ModeId, viewer: RVViewer): void;
  onModeDeactivate?(mode: ModeId | null, viewer: RVViewer): void;

  // Render backend switch (plan-256): 'three' → 'omniverse'. Interactive 3D
  // plugins (raycast/gizmo/camera drag) should tear down under a non-Three backend.
  onRenderBackendChanged?(backend: 'three' | 'omniverse', viewer: RVViewer): void;

  dispose?(): void;                      // Cleanup on viewer destroy
}
```

`core` and `modes` are the **runtime participation** axis; they are compiled into UI visibility
only by `UIPluginRegistry.register()`, which never reads `core`. Read
[doc-ui-visibility.md](doc-ui-visibility.md) before using either.

### Execution Order in fixedUpdate

```
1. LogicEngine.fixedUpdate(dt)         — LogicStep sequencing
2. ReplayRecordings[].fixedUpdate(dt)  — Recording playback (legacy, not yet a plugin)
3. prePlugins[].onFixedUpdatePre(dt)   — Set drive targets, apply interface data
   + onTick(PRE) callbacks             — TickStage.PRE stage
4. drives[].update(dt)                 — Drive physics (sorted by DriveOrderPlugin)
5. transportManager.update(dt)         — MU movement, sensors (skipped if handlesTransport)
   + onTick(SIM) callbacks             — TickStage.SIM stage
6. postPlugins[].onFixedUpdatePost(dt) — Read results, sample data, emit events
   + onTick(POST) callbacks            — TickStage.POST stage
```

> **Note:** Step 2 is a legacy hardcoded call that predates the plugin system.
> New features should always use the plugin system or `simLoop.onTick()`.

Plugins are cached into per-phase arrays sorted by `order`. Each callback is wrapped in try/catch — a faulty plugin cannot crash the simulation.

### Plugin Order Constants (PLUGIN_ORDER)

Instead of magic numbers, use the predefined order constants from `src/core/rv-plugin-order.ts`:

```typescript
import { PLUGIN_ORDER } from '../core/rv-plugin-order';

export class MyInterface extends BaseIndustrialInterface {
  readonly order = PLUGIN_ORDER.INTERFACE_ADAPTER;  // 10 — runs early in Pre phase
}

export class MyAnalyticsPlugin extends RVBehavior {
  readonly order = PLUGIN_ORDER.SIM_DEFAULT;        // 100 — standard order
}
```

| Constant | Value | Intended Use |
|----------|-------|-------------|
| `PLUGIN_ORDER.CORE_PRE` | 0 | Dependency-sort hooks (drive-order, etc.) |
| `PLUGIN_ORDER.INTERFACE_MANAGER` | 5 | Industrial interface manager (lifecycle coordination) |
| `PLUGIN_ORDER.INTERFACE_ADAPTER` | 10 | Live PLC signal flush from adapter to SignalStore |
| `PLUGIN_ORDER.MULTIUSER` | 15 | Multiuser session sync (remote drive states, camera) |
| `PLUGIN_ORDER.UI_CRITICAL` | 50 | UI-critical overlays and sim-controller HMI |
| `PLUGIN_ORDER.PLC_RUNTIME` | 60 | Virtual PLC scan cycle — after the signal-binding flush, before drive physics |
| `PLUGIN_ORDER.SIM_DEFAULT` | 100 | Default order if not specified |
| `PLUGIN_ORDER.DEMO` | 150 | Demo / process-specific plugins |
| `PLUGIN_ORDER.UI_OVERLAY` | 250 | UI overlays (drive-gizmo, layout-planner, kiosk) |
| `PLUGIN_ORDER.DEBUG` | 990 | Debug / telemetry endpoints (mcp-bridge, debug-endpoint) |
| `PLUGIN_ORDER.TEST` | 9999 | Test / perf plugins |

### PluginContext — Narrower API for New Plugins

`viewer.use(plugin)` calls `plugin.init?(viewer, context)`. The `PluginContext`
provides a narrower, more stable API surface than the full `RVViewer`:

```typescript
interface PluginContext {
  /** EventEmitter — typed by ViewerEvents */
  readonly events: EventEmitter<ViewerEvents>;
  readonly connectionState: 'Connected' | 'Disconnected';

  // Sub-facades — always instantiated eagerly, safe to call from init():
  readonly scene: SceneFacade;       // eachNode, projectToScreen/Point, highlightByPath, clearHighlight
  readonly camera: CameraFacade;     // getCameraState, animateCameraTo, fitToNodes, focusByPath, clearFocus
  readonly controls: ControlsFacade; // setConfig / setRotateSpeed / setPanSpeed / setZoomSpeed / …
  readonly simLoop: SimLoopFacade;   // onTick(stage, callback, order?), setPaused, eachDrive, driveCount
  readonly modes: ModeFacade;        // active workspace mode + request a switch

  loadModel(url: string, opts?: { signalMap?: string }): Promise<void>;
  clearModel(): void;
  emit: EventEmitter<ViewerEvents>['emit'];

  // Live getters — may be null before model load; do NOT cache in init():
  readonly signals: PluginSignalFacade | null;
  readonly nodes: Pick<NodeRegistry, 'getNode' | 'getPathForNode' | 'forEachNode'> | null;
  readonly transport: TransportFacade | null;
}
```

**These are narrowed subsets, not the full classes.** `ctx.signals` is *not* a `SignalStore` and
`ctx.nodes` is *not* a `NodeRegistry` — each exposes only the members listed below. Anything else
you remember from those classes is deliberately not reachable through the context; reach for the
full `viewer` if you truly need it.

| Member | Permitted calls |
|---|---|
| `ctx.signals` (`PluginSignalFacade`) | `get(name)`, `subscribe(name, cb)`, `set(name, value)`, `setMany(record)` — and nothing else. Writes go through a per-plugin `SignalWriter` tagged with the plugin id, so provenance stays visible. |
| `ctx.nodes` | `getNode(path)`, `getPathForNode(node)`, `forEachNode(fn)` |
| `ctx.camera` (`CameraFacade`) | `getCameraState(out?)`, `animateCameraTo(pos, target, durationMs?)`, `fitToNodes(nodes, offsetFactor?)`, `focusByPath(path, offsetFactor?)`, `clearFocus()`. There is **no** `setState`, `animateTo` or `setConfig` on the camera facade — `setConfig` belongs to `ctx.controls`. |

**Important:** `ctx.signals`, `ctx.nodes`, and `ctx.transport` are **live getters**
that return `null` before a model is loaded. Do **not** cache these in `init()` —
read them inside callbacks where the model is guaranteed to be present.

#### BaseViewerPlugin — Recommended Base Class for Context-Aware Plugins

```typescript
import { BaseViewerPlugin } from '../core/rv-base-plugin';
import { PLUGIN_ORDER } from '../core/rv-plugin-order';
import { TickStage } from '../core/rv-tick-stages';
import type { RVViewer } from '../core/rv-viewer';
import type { PluginContext } from '../core/rv-plugin-context';

export class MyPlugin extends BaseViewerPlugin {
  readonly id = 'my-plugin';
  readonly order = PLUGIN_ORDER.SIM_DEFAULT;

  // init() is called by viewer.use() — context is stored in this.context automatically.
  // Call super.init(viewer, context) if you override.
  //
  // Keep it PUBLIC and keep `context` optional: the base declares
  // `init(viewer: RVViewer, context?: PluginContext): void` as a public method
  // (rv-base-plugin.ts), and TypeScript refuses to narrow a public member to
  // `protected` or to drop the `?` in an override.
  override init(viewer: RVViewer, context?: PluginContext): void {
    super.init(viewer, context);   // stores context in this.context
    if (!context) return;          // pre-Phase-4 viewers pass none

    // Register a tick callback at the PRE stage (before drive physics):
    this.context.simLoop.onTick(TickStage.PRE, (dt) => {
      const signals = this.context.signals;  // live getter — null before model load
      if (!signals) return;
      signals.set('MySignal', true);
    });
  }

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    // Safe to use context.signals here — model is loaded
    const signals = this.context.signals;
    if (signals) signals.set('Ready', true);
  }
}
```

Prefer `this.context.scene`, `this.context.camera`, and `this.context.controls` in plugins for a more stable API surface.

### SimLoopFacade — Stage-Based Tick Registration

As an alternative to `onFixedUpdatePre` / `onFixedUpdatePost`, use the stage-based
`simLoop.onTick()` API for finer control:

```typescript
import { TickStage } from '../core/rv-tick-stages';

// In init():
this.context.simLoop.onTick(TickStage.PRE, (dt) => {
  // Runs BEFORE drive physics — same slot as onFixedUpdatePre
}, PLUGIN_ORDER.INTERFACE_ADAPTER);  // optional order within stage

this.context.simLoop.onTick(TickStage.POST, (dt) => {
  // Runs AFTER drive physics + transport — same slot as onFixedUpdatePost
});
```

Stage constants:

| Stage | Value | When | Use for |
|-------|-------|------|---------|
| `TickStage.PRE` | 0 | Before drive physics | Set drive targets, flush incoming signals |
| `TickStage.SIM` | 1 | During physics (drive + transport) | Advanced physics plugins |
| `TickStage.POST` | 2 | After drive physics + transport | Sample data, emit events, send outgoing signals |

Both `onFixedUpdatePre` / `onFixedUpdatePost` and `onTick()` coexist. Legacy plugins
remain fully functional. Defensive iteration ensures that a plugin removing itself
during a tick does not corrupt the iterator.

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

For type safety on custom events, extend `ViewerEvents` in `rv-viewer-events.ts`:

```typescript
// src/core/rv-viewer-events.ts — add to ViewerEvents interface
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

### Registration Origin and Registry Diagnostics

Registration sites may classify plugins with `viewer.use(plugin, origin)`, where `origin`
is `core`, `commercial`, `internal`, or `project`. Delegating loaders that do not own the
individual `use()` calls can wrap synchronous registration in
`viewer.withDefaultOrigin(origin, () => registerPlugins(viewer))`; an explicit origin still
wins. Read-only diagnostics can use `viewer.getPlugins()` (a defensive copy),
`viewer.getPluginOrigin(id)` (`unknown` for untagged IDs), and
`viewer.isPluginDisabled(id)`. The typed `plugins-changed` event fires after successful
register/enable/disable/remove mutations with `{ kind, id }`, and does not fire for no-ops.
Internal builds use these APIs for the private **Features** settings tab; that panel is not
part of customer bundles.

### User Plugin Overrides

The public viewer API can temporarily suppress a registered plugin's lifecycle participation
without unloading it:

```typescript
viewer.setPluginUserEnabled('my-plugin', false);

viewer.isPluginUserDisabled('my-plugin'); // true
viewer.getPluginUserDisabledIds();        // defensive Set<string> copy

viewer.setPluginUserEnabled('my-plugin', true);
viewer.clearPluginUserOverrides();
```

A user-disabled plugin is excluded from fixed-update, render, model-load replay, and workspace-mode
hooks. Disabling an active mode-scoped plugin runs its deactivation hook once; enabling it in its
active mode restores the applicable lifecycle callbacks. The override survives workspace-mode
changes.

**Since plan-435 the override is retroactive and it persists.** Switching a plugin off no longer
only stops *future* callbacks — it undoes what the plugin already built:

1. `onModeDeactivate`, when the plugin participates in the active mode (unchanged).
2. **Teardown** — `onDeactivate(viewer)` if the plugin declares it, otherwise a single
   `onModelCleared(viewer)`, and that fallback only when the plugin actually received the current
   model.
3. `disablePlugin(id)`.
4. **Its UI slots are unregistered** — buttons, tabs and panels disappear.

Switching it back on is the mirror image: slots are re-registered first (in their original
position — the registry remembers a stable per-plugin sequence), then `enablePlugin()` replays a
missed `onModelLoaded` if there was one, then `onActivate(viewer)` or, without that hook, a replay
of the current model, then `onModeActivate`.

The whole teardown lives in `setPluginUserEnabled` alone. `disablePlugin()` / `enablePlugin()` are
deliberately untouched, because they are also the workspace-mode reconcile path — anchoring the
teardown there would fire it on every mode switch.

It is still not an unload: subscriptions the plugin chose to keep, its allocated resources and its
own state stay with the instance, which stays in the registry. Describe the action as switching the
plugin off, never as removing or unloading it. `clearPluginUserOverrides()` returns all overridden
plugins to their normal workspace-mode-driven state; it does not restore a captured snapshot.

**Persistence** (plan-435 Phase 3): overrides are stored per project (falling back to the model)
under `rv-plugin-overrides/<scope>` and re-applied at boot before the model loads. `core: true` and
protected plugins are never persisted or applied, so a stored record cannot boot the viewer into an
unusable state; `?resetPlugins=1` wipes every scope before any of them is read. An override for a
plugin that is only registered later (model plugins, the debug endpoint, the MCP bridge) is held as
an intent on the viewer and applied the moment that plugin appears in `use()`.

Plugins whose teardown cannot be made complete yet are **protected**: the switch is disabled and its
tooltip says whether the lifecycle cannot be interrupted safely or the teardown is simply not
implemented yet. Half-effective switches are worse than no switch.

Successful override changes emit `plugins-changed` with `kind: 'user-disabled'` or
`kind: 'user-enabled'`. Unknown plugin IDs and repeated requests for the current user-intent state
are no-ops and emit no event.

### Retroactive Registration

If a plugin is registered after a model is already loaded, `onModelLoaded` is normally called
immediately:

```typescript
// Model loaded at t=0
await viewer.loadModel('scene.glb');

// Plugin registered at t=5 — onModelLoaded fires right away
viewer.use(new LatePlugin());
```

**"Immediately" has two exceptions** (`rv-viewer.ts`, `use()`): the call is *skipped* when the
plugin is currently disabled, or when it declares `modes` and none of them is the active workspace
mode. In both cases the plugin id is parked in `_missedModelLoad` and the call is **replayed** the
moment the plugin is enabled — i.e. on the mode transition that activates it. A mode-scoped plugin
must therefore not assume `onModelLoaded` has already run by the time `init()` returns; do model-
dependent setup in `onModelLoaded` / `onModeActivate`, never in `init()`.

### Plugin Order

The `order` property controls execution order within each phase (Pre, Post, Render). Lower values run first:

| order | Intended Use |
|-------|-------------|
| 0 | Infrastructure (DriveOrderPlugin) |
| 50 | Interface data exchange |
| 100 | Default (most plugins) |
| 200 | Analytics, recording |

---

## 4. Events

### Built-in Event Types

The canonical import path for `ViewerEvents` is:

```typescript
import type { ViewerEvents } from './core/rv-viewer-events';
```

The full `ViewerEvents` interface lives at [src/core/rv-viewer-events.ts](src/core/rv-viewer-events.ts).
**The snapshot below is a partial catalog** — roughly two thirds of the declared events, picked to
show the categories. It is not kept exhaustive on purpose; around two dozen further events (scene
lifecycle, diagnostics, render-mode, snap/drag, MCP and multiuser channels) exist only in the
source. Treat `rv-viewer-events.ts` as the list, this table as the map:

```typescript
interface ViewerEvents {
  // Lifecycle
  'model-loaded':       { result: LoadResult };
  'model-cleared':      void;
  'connection-state-changed': { state: 'Connected' | 'Disconnected'; previous: 'Connected' | 'Disconnected' };
  'simulation-pause-changed': { paused: boolean; reasons: readonly string[]; reason: string };

  // Hover / focus / selection (component-agnostic)
  'object-hover':       ObjectHoverData | null;       // { node, nodeType, nodePath, pointer, hitPoint, mesh }
  'object-unhover':     ObjectUnhoverData;            // { node, nodeType }
  'object-click':       ObjectClickData;              // { node, nodeType, nodePath, pointer }
  'object-clicked':     { path: string; node: Object3D; hitPoint?: [number, number, number] };
  // openInspector === false (F shortcut) frames the camera only — listeners must
  // NOT open or reveal the inspector. Omitted/true (double-click) opens as before.
  'object-focus':       { path: string; node: Object3D; openInspector?: boolean };
  'object-blur':        void;                          // previous focus was cleared
  'selection-changed':  SelectionSnapshot;
  'exclusive-hover-mode': { mode: HoverableType | null };

  // Filters / charts (UI plumbing — bound to specific HMI panels)
  'drive-chart-toggle':    { open: boolean };
  'drive-filter':          { filter: string; filteredDrives: RVDrive[] };
  'node-filter':           { filter: string; filteredNodes: NodeSearchResult[]; tooMany: boolean };
  'sensor-chart-toggle':   { open: boolean };
  'groups-overlay-toggle': { open: boolean };

  // Generic component lifecycle event — emitted by drives, sensors, MUs and plugin-defined components.
  // Known: sensor/changed { occupied }, mu/spawned { totalSpawned },
  //        mu/consumed { totalConsumed }, drive/at-target { position }.
  'component-event': {
    componentType: string;
    kind: string;
    path: string;
    payload?: unknown;
  };

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

  // Layout planner — position/rotation/scale are TUPLES, not {x,y,z} objects
  'layout-transform-update': {
    path: string;
    position: [number, number, number];
    rotation: [number, number, number];
    scale?: [number, number, number];
    visible?: boolean;
  };
}
```

### Emitting Events

```typescript
// Typed (compile-time checked):
viewer.emit('component-event', {
  componentType: 'sensor',
  kind: 'changed',
  path: 'Cell/Sensor1',
  payload: { occupied: true },
});

// Custom/untyped (for plugin-specific events):
viewer.emit('my-plugin:data-ready', { values: [1, 2, 3] });
```

### Subscribing to Events

```typescript
// Returns unsubscribe function
const off = viewer.on('component-event', (e) => {
  if (e.componentType === 'sensor' && e.kind === 'changed') {
    console.log(e.path, (e.payload as { occupied: boolean }).occupied);
  }
});
off();  // Unsubscribe

// In React — auto-cleanup via useEffect
useSimulationEvent('component-event', (e) => {
  // Callback ref is stable — no re-subscriptions on re-render
});
```

---

## 5. UI Slots (React Components in Plugins)

Plugins can provide UI by declaring a `slots` array on `RVViewerPlugin`. Slot entries are automatically registered into the HMI layout when `viewer.use()` is called.

> **Before you gate a slot by mode, read [doc-ui-visibility.md](doc-ui-visibility.md).**
> Whether a plugin *runs* and whether its UI is *shown* are two separate axes. `modes`/`core`
> decide participation; `UIPluginRegistry.register` compiles `modes` (and never `core`) into the
> slot's `shownOnlyInAny` rule. So `core: true` + `modes: ['hmi']` means "runtime runs in every
> mode, UI appears only in hmi" — and a `shownOnlyInAny` you write on the entry yourself is
> replaced, not merged.

> **Your new plugin appears in the Viewer workspace unless you say otherwise.**
> `modes: undefined` means "every mode", and the `viewer` mode (plan-387) is meant to stay
> nearly empty — model, kinematics, Settings, view/grouping controls. If your slot is anything
> an operator or engineer uses, gate it. Two rules of thumb:
>
> - **A `button-group` entry with no `visibilityRule` needs NOTHING.** `ButtonPanel` already
>   hides ruleless buttons in every focused (non-hmi) mode, Viewer mode included. Adding `modes`
>   to such a plugin is actively harmful: it compiles a rule, the ruleless branch stops
>   applying, and the button becomes visible in DES/Planner/Editor where it never was.
> - **Anything else needs an explicit rule.** Prefer `hiddenIn: [modeContext('viewer')]` on the
>   slot entry over `modes`, because `modes` compiles to `shownOnlyInAny` — a positive list that
>   fails CLOSED whenever no `mode:*` context is active (before mode boot, and in the CONNECT
>   embed path which skips it). Reach for `modes` only when you also want the plugin's *runtime*
>   off in that mode.
>
> **The `visibilityId` requirement is `SlotRenderer`-only.** `SlotRenderer` (`HMIShell.tsx`)
> applies a rule **only when the entry also carries a `visibilityId`** — without one your rule is
> silently ignored there. `ButtonPanel`, `ActivityBar` and `MessagePanel` evaluate
> `entry.visibilityRule` directly via `evaluateVisibilityRule()` and need no id. Note that a
> plugin declaring `modes` gets a `visibilityId` auto-assigned by `UIPluginRegistry.register()`,
> so this only bites hand-written rules on `overlay` / `views` / `kpi-bar` / `search-bar` entries.

### Available Layout Slots

```
+------------------------------------------------------------+
| TopBar: [toolbar-button-leading] [Hierarchy][Settings…]    |
|         [toolbar-button-center] [toolbar-button-trailing]  |
|         [toolbar-button] [camera/view group]               |
|           [kpi-bar] KPI cards, horizontal                  |
| +-+ +------+                                   +---------+  |
| |A| |[butt-|                                   |         |  |
| |c| | on-  |                                   |[messages|  |
| |t| |group]|                                   | ]       |  |
| |i| +------+         3D Scene                  |         |  |
| |v|  (floating tool toolbar)                   |         |  |
| |i|                                            |         |  |
| |t|                                            |         |  |
| |y|                                +-------------------+   |
| |-|                                | [views]           |   |
| |b|                                | Charts, tables    |   |
| |a|                                +-------------------+   |
| |r|     [search-bar] Search field                          |
| +-+ (left vertical icon strip: window openers)             |
+------------------------------------------------------------+
```

| Slot | Position | Typical Content |
|------|----------|----------------|
| `kpi-bar` | Top center | KPI badge cards |
| `activity-bar` | Left sidebar | Window-opener buttons that open a left-docked window |
| `button-group` | Floating left toolbar | Contextual mode tools (grid, snap, measurement) |
| `search-bar` | Bottom center | Search/filter fields |
| `messages` | Right sidebar | Notifications, status tiles |
| `views` | Bottom right | Expandable panels, charts |
| `settings-tab` | Settings dialog | Additional tabs |
| `toolbar-button-leading` | TopBar (left) | Primary simulation controls before Hierarchy |
| `toolbar-button` | TopBar (right) | Extra action buttons (toggles/modals) |
| `toolbar-button-center` | TopBar (center) | Center region toolbars (reserved) |
| `toolbar-button-trailing` | TopBar (right) | Right region toolbars before the camera/view group |
| `overlay` | Full-screen | Left panels, modals, custom overlays |

### UISlotEntry Type

```typescript
// src/core/rv-ui-plugin.ts

type UISlot =
  | 'kpi-bar'                 // Top center: KPI cards horizontal
  | 'activity-bar'           // Left: window-opener buttons (open a left-docked window)
  | 'button-group'           // Floating left: contextual mode tools (grid, snap, measurement)
  | 'search-bar'             // Bottom center: search field
  | 'messages'               // Right: notifications / status tiles
  | 'views'                  // Bottom right: expandable panels (charts, tables)
  | 'settings-tab'           // Settings dialog: tab registration
  | 'toolbar-button-leading' // TopBar: primary sim controls before Hierarchy
  | 'toolbar-button'         // TopBar: extra action buttons (toggles/modals)
  | 'toolbar-button-center'  // TopBar: center region toolbars (reserved)
  | 'toolbar-button-trailing'// TopBar: right region toolbars before the camera group
  | 'overlay';               // Full-screen overlays (left panels, modals, etc.)

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
  // `viewer.registry` is `NodeRegistry | null` (null before a model loads), and the
  // path lookup is `getPathForNode(node)` — there is no `pathFor()`.
  const path = viewer.registry?.getPathForNode(node) ?? node.name;
  // Sensors live on the transport manager, not on the viewer: there is no
  // `viewer.sensors`. Match by node identity — RVSensor has no `path` field.
  const sensor = viewer.transportManager?.sensors.find(s => s.node === node);
  if (!sensor) return null;
  return { type: 'sensor', sensorName: node.name, path, occupied: sensor.occupied };
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

## 8b. Contributing a Help Topic

> **Internal, not a guaranteed API.** This registry is deliberately unsealed: it may change
> shape without notice until real plugin use cases have shaped it. Do not depend on it from a
> customer deliverable yet.

The help button and <kbd>F1</kbd> derive their target from the most recently opened window and
the active workspace mode (see *Context-Sensitive Help* in `doc-webviewer.md`). A plugin that
owns a piece of UI which is not a docked window can contribute its own documentation page:

```typescript
import { registerHelpTopic } from '../core/hmi/help-topic-registry';

private unregisterHelp: (() => void) | null = null;

init(viewer) {
  // No priority argument — every plugin contribution sits on the fixed top rank (40),
  // above the open window (30) and the workspace mode (20).
  this.unregisterHelp = registerHelpTopic(
    'plugin:my-plugin', { slug: 'planning/des', anchor: 'setup' },
  );
}

dispose() {
  this.unregisterHelp?.();
  this.unregisterHelp = null;
}
```

Rules worth knowing:

- **Always unregister in `dispose()`.** The core context cannot go stale (it is read fresh on
  every call), but a plugin contribution can — it is the one thing that survives a model switch
  on its own.
- **Registration order decides among contributions.** `Map.set()` does not move an existing key,
  so re-registering the same `sourceId` updates its topic but keeps its position. Unregister and
  register again to move it.
- **A stale disposer is harmless.** Each registration carries a generation number; a disposer
  from a superseded registration is ignored rather than deleting the newer entry.
- **Notification is content-based.** Re-registering an identical `{slug, anchor}` — even as a
  freshly allocated object — notifies nobody.
- **Plugin slugs are not validated.** Core topics are checked against the offline sitemap
  snapshot in `help-topics.ts`; a plugin may point at its own documentation set instead.

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
// snapshot.activePanel      — 'my-panel' | null   (LEFT slot; backward-compat alias)
// snapshot.activePanelWidth — number              (LEFT slot)
// snapshot.left / .right    — per-side slot state
// snapshot.lastOpenedSide   — 'left' | 'right' | null
```

`lastOpenedSide` names the side whose window was opened most recently. Left and right can hold a
panel at the same time, so consumers that need exactly ONE window (the context-sensitive help
does) use it to break the tie. It is re-derived when a panel closes and when `restore()` runs,
and it is deliberately **not** persisted — it is session state, not a setting.

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
// Two modules: rv-plugin.ts exports ONLY RVViewerPlugin; UISlotEntry lives in rv-ui-plugin.ts.
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry } from '../core/rv-ui-plugin';
import type { RVViewer } from '../core/rv-viewer';

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
| `LEFT_PANEL_TOP` | 0 | Top position (flush to viewport top) |
| `LEFT_PANEL_LEFT` | 46 | Left margin (equals ACTIVITY_BAR_WIDTH) |
| `LEFT_PANEL_BOTTOM` | 0 | Bottom position (flush to viewport bottom) |
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

### Where test assets live, and the rule that comes with them

There are exactly **three** places a `.glb` can live, and they are not
interchangeable:

| Place | What belongs there |
|---|---|
| `public/models/` | **Only what is shipped.** The demo models a customer actually receives, as declared by `public/project.json`. A guard test (`publicModels_OnlyShippedDemos`) fails on anything else. |
| `public/library/` | The delivered standard library (`PalletHandling` + `catalog.json`). Unchanged, and not a place for experiments. |
| `../realvirtual-WebViewer-Private~/projects/Development/` | **Everything internal.** `fixtures/` for synthetic test GLBs, `models/` for real internal reference models, `library/Custom/` for the internal custom library, and `scratch/` for experiments. |

**`scratch/` is where a try-out goes.** It exists precisely so `public/models/`
does not become the dumping ground again - which is what it had become, because
there was nowhere else. Nothing in `scratch/` is delivered, deployed or
published, and nothing there needs a `documents[]` entry: those files are
working material, not documents. Delete them whenever you like.

#### Loading an internal asset from a test

Never write the URL. It comes from the one source of truth,
`tests/fixtures/glb-paths.mjs`:

```typescript
import { DEV_GLB } from './fixtures/glb-paths.mjs';
import { devAssetAvailable } from './fixtures/dev-asset-available';

const DEV_ASSETS = await devAssetAvailable(DEV_GLB.tests);

describe.skipIf(!DEV_ASSETS)('my suite', () => {
  beforeAll(async () => { /* load DEV_GLB.tests */ });
  it('...', () => { /* ... */ });
});
```

**The `skipIf` is not optional, and a guard test enforces the pairing.** These
assets exist only on a machine that has the private sibling checked out; a
public checkout has none of them. Without the guard the suite fails there
instead of reporting `skipped`.

Two things that look like they would work and do not:

- **`if (!ready) return`** reports the test as `passed`. That is a suite which
  claims to have checked something it never loaded - the exact failure the
  `skipIf` exists to prevent.
- **`res.ok` as the probe.** Without the private sibling nothing claims
  `/private-assets/`, so the dev server answers it with the SPA fallback: a
  `200 text/html` for every path. `res.ok` is therefore `true` for an asset
  that is not there. `devAssetAvailable()` checks the CONTENT TYPE, which is
  why it is a shared helper and not four lines you write again.

In a Playwright spec the equivalent is decided in Node, before a browser is
even started:

```typescript
import { DEV_ASSETS_SKIP_REASON, HAS_DEV_ASSETS } from './dev-assets';

test.describe('my spec', () => {
  test.skip(!HAS_DEV_ASSETS, DEV_ASSETS_SKIP_REASON);
  // ...
});
```

The generated `physics-zone-test.glb` fixture is rebuilt with
`node scripts/build-physics-test-glb.mjs`, which writes into the Development
project and fails with instructions if the private sibling is not there.

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

> **These tables are not exhaustive.** `src/plugins/` holds well over fifty entries; the lists
> below name the ones a plugin author is most likely to read as a reference. The authoritative
> answer to "is this plugin core?" is the `readonly core = true` line in its own source file.

### Core Plugins (`core: true` — always participate, survive model switches)

| Plugin | ID | File | Purpose |
|--------|----|------|---------|
| `DriveOrderPlugin` | `drive-order` | [src/plugins/drive-order-plugin.ts](src/plugins/drive-order-plugin.ts) | Topological sort for CAM/Gear master-slave |
| `SensorMonitorPlugin` | `sensor-monitor` | [src/plugins/sensor-monitor-plugin.ts](src/plugins/sensor-monitor-plugin.ts) | Event-based sensor change tracking |
| `TransportStatsPlugin` | `transport-stats` | [src/plugins/transport-stats-plugin.ts](src/plugins/transport-stats-plugin.ts) | 10 Hz spawn/consume RingBuffers |
| `CameraEventsPlugin` | `camera-events` | [src/plugins/camera-events-plugin.ts](src/plugins/camera-events-plugin.ts) | Emits `camera-animation-done` |
| `CameraStartposPlugin` | `camera-startpos` | [src/plugins/camera-startpos-plugin.tsx](src/plugins/camera-startpos-plugin.tsx) | Per-model start position presets — the canonical `core: true` + mode-scoped-UI case (see [doc-ui-visibility.md](doc-ui-visibility.md) §4) |
| `RvExtrasEditorPlugin` | `rv-extras-editor` | [src/core/hmi/rv-extras-editor.tsx](src/core/hmi/rv-extras-editor.tsx) | Hierarchy browser + property inspector |
| `AdaptiveNavPlugin` | `adaptive-nav` | [src/plugins/adaptive-nav-plugin.ts](src/plugins/adaptive-nav-plugin.ts) | Scene-size-aware navigation defaults |
| `ConnectionSystemPlugin` | `connection-system` | [src/plugins/connection-system-plugin.ts](src/plugins/connection-system-plugin.ts) | Typed connection registry session (see §22) |
| `KioskPlugin` | `kiosk` | [src/plugins/kiosk-plugin.tsx](src/plugins/kiosk-plugin.tsx) | Kiosk chrome + idle detection / tour |
| `SignalBindPlugin` | `signal-bind` | [src/plugins/signal-bind/SignalBindPlugin.ts](src/plugins/signal-bind/SignalBindPlugin.ts) | Signal ↔ component binding popover and persistence |

**`SignalBindPlugin`'s click-to-open popover is mode-gated at the click handler**, not by slot
visibility: `object-clicked` returns early unless `isSignalLinkModeActive()` is true (an explicit
link-mode toggle or a running signal drag), so an ordinary scene click never surfaces the binding
popover.

### Optional Plugins (registered eagerly, opt-in via model config)

| Plugin | ID | File | Purpose |
|--------|----|------|---------|
| `WebXRPlugin` | `webxr` | [src/plugins/webxr-plugin.ts](src/plugins/webxr-plugin.ts) | Immersive VR/AR (Quest, Vision Pro, Android AR) |
| `MultiuserPlugin` | `multiuser` | [src/plugins/multiuser-plugin.ts](src/plugins/multiuser-plugin.ts) | Presence, avatars, signal/drive sync, relay support |
| `FpvPlugin` | `fpv` | [src/plugins/fpv-plugin.tsx](src/plugins/fpv-plugin.tsx) | First-person WASD + mouse look walkthrough |
| `AnnotationPlugin` | `annotations` | [src/plugins/annotation-plugin.ts](src/plugins/annotation-plugin.ts) | 3D markers, labels, drawing |
| `AasLinkPlugin` | `aas-link` | [src/plugins/aas-link-plugin.tsx](src/plugins/aas-link-plugin.tsx) | AAS / AASX linking + tooltip |
| `DocsBrowserPlugin` | `docs-browser` | [src/plugins/docs-browser-plugin.tsx](src/plugins/docs-browser-plugin.tsx) | PDF / docs browser overlay |
| `CollisionAlertPlugin` | `collision-alert` | [src/plugins/collision-alert-plugin.tsx](src/plugins/collision-alert-plugin.tsx) | Collision alert tiles in the `messages` slot (order 6), fed by `RVCollisionManager` |
| `DebugEndpointPlugin` | `debug-endpoint` | [src/plugins/debug-endpoint-plugin.ts](src/plugins/debug-endpoint-plugin.ts) | `/__api/debug` HTTP bridge (dev) — **not** `core` |
| `McpBridgePlugin` | `mcp-bridge` | [src/plugins/mcp-bridge-plugin.ts](src/plugins/mcp-bridge-plugin.ts) | Claude MCP WebSocket bridge (dev) — **not** `core` |
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
2. **Global plugins from the private sibling** — Always loaded when the private folder is present.
3. **Model-specific plugins** — Loaded/unloaded dynamically when a model is loaded or switched.

> **LayoutPlanner and DES are in the PUBLIC tree** (`src/plugins/layout-planner/`,
> `src/plugins/des/`) — an older revision of this page listed them as private examples; they are
> not. The actual split inside the private sibling is two entry points, and they are different
> tiers:
>
> | Entry point | Tier | Reaches |
> |---|---|---|
> | `private-plugins.ts` | customer | every build that has the private folder. `main.ts` awaits `registerPrivatePlugins(viewer)`; the public build resolves it to the no-op stub in `src/private-stubs/`. |
> | `internal-plugins.ts` | internal | realvirtual-internal builds only, behind a `__RV_INTERNAL__`-gated dynamic import (Omniverse render backend, physics provider, Features tab). |
>
> Both must finish registering before the workspace-mode registration in `main.ts`, because they
> can contribute modes and component types. See [doc-deploy.md](doc-deploy.md) for which tier ends
> up in which artifact.

Each model declares which plugins it needs via a `plugins/index.ts` entry point. When switching models, the previous model's plugins are fully unloaded (disposed, UI slots removed) and the new model's plugins are loaded.

### Creating Model-Specific Plugins

Create a `plugins/index.ts` in one of these locations:

- **Public models**: `src/plugins/models/<ModelName>/index.ts`
- **Private projects**: `projects/<projectname>/plugins/index.ts`

The file must export three things:

```typescript
import type { RVViewer } from '../../../core/rv-viewer';
import type { ModelPluginModule } from '../../../core/rv-model-plugin-manager';

// DEPRECATED since plan-718 — bind in the manifest instead (see below).
// Which GLB filenames (without .glb) this module handles.
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

### Binding: `scriptRef` in the manifest, not `models[]` in the module

Since plan-718 the binding lives in `project.json`, on the document row:

```jsonc
{ "id": "ast_m8x", "path": "models/linie1.glb", "name": "Linie 1",
  "scriptRef": "plugins/index.ts" }
```

Three things follow, and each of them is why the declaration moved:

- **A rename cannot break it.** The reference hangs on the row, whose id is frozen
  at birth; `models[]` matched a GLB *file name*.
- **N:1 is free.** Several documents may carry the same `scriptRef` and share one
  module — the module is imported once.
- **The reference must stay inside the project.** `../` is refused, by the viewer
  and by `scripts/validate-project.mjs`.

A `scriptRef` that resolves to no bundled module loads **no** plugins; it does not
fall back to the name match, because binding the wrong code is worse than binding
none. `models[]` is still read for a project that has not been migrated, for one
release generation — the migration (`rv-project-refs-migration.ts`, and
`scripts/migrate-project-manifest.mjs` offline) converts declarations to
references and reports any that differ from a document name only in case, since
the match is case-SENSITIVE on both sides.

### How It Works

1. `ModelPluginManager` uses `import.meta.glob` to discover all `plugins/index.ts` files at build time
2. When `viewer.loadModel(url)` is called, the manager resolves the document row and reads its `scriptRef`
3. It finds the matching plugin module (by `scriptRef`; failing a reference, by `models` array or folder name)
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
  ├── ModelOptionPlugin    (supplier variants — see Model Options below)
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

### Model Options (selectable variants)

A **model option** is a named variant of the *same* GLB geometry — for example swapping a component's supplier — surfaced as its own entry in the model selector. There is no duplicate GLB and no build step: the option is carried as an `?option=<id>` marker on the model URL and applied at load time.

Command-based by design: `model-options.ts` declares only the selectable options (id + label); what each option *does* is spelled out imperatively in the model's `index.ts` using generic rv_extras commands — readable next to the model it belongs to.

**1. Declaration** — drop a `model-options.ts` next to the model's `index.ts` (selector metadata only):

```typescript
// src/plugins/models/<ModelName>/model-options.ts
import type { ModelOptionDef } from '../model-option-plugin';

export const baseModel = 'DemoRealvirtualWeb';   // base GLB (filename without .glb)

export const modelOptions: ModelOptionDef[] = [
  { id: 'sew', label: 'SEW' },   // → ?option=sew, selector entry "DemoRealvirtualWeb (SEW)"
];
```

**2. Apply** — in the model's `index.ts`, write an `apply(viewer, optionId)` that issues rv_extras commands, and register `ModelOptionPlugin` with it. Register the plugin **first** when an option swaps AAS ids, so the swap lands before `AasLinkPlugin` pre-parses the AASX:

```typescript
import { ModelOptionPlugin, remapAasLink, setComponentField } from '../model-option-plugin';

function applyModelOption(viewer: RVViewer, option: string): void {
  if (option === 'sew') {
    // Re-point every node whose AAS currently equals the Festo motor to the SEW AAS
    // (updates the tooltip AND the property inspector). Value-matched, hits all nodes.
    remapAasLink(viewer,
      'http://smart.festo.com/aas/99920200617190044000012858',
      'https://demo.realvirtual.io/aas/sew/KA47-DRN90M4-Demo-0001',
      'SEW KA47-DRN90M4 Gearmotor');
    // Generic: set any rv_extras component field on any node.
    // setComponentField(viewer, 'DemoCell/.../Motor', 'Drive', 'TargetSpeed', 250);
  }
}

const instances = [
  new ModelOptionPlugin(applyModelOption),  // first
  // ...other model plugins
];
```

**How it surfaces:** `main.ts` eager-globs every `models/<name>/model-options.ts` and, for each discovered GLB whose name matches `baseModel`, adds one selector entry per option (`<base> (<label>)`) pointing at the same GLB url with `?option=<id>` appended. The base model with no option stays unchanged. Activating an option is also a shareable deep link: `…/?model=<glb>&option=sew`.

**Commands** (`model-option-plugin.ts`) mutate the loaded scene in place after construction, so they reflect immediately in the property inspector and live consumers (tooltips, AAS panel):
- `remapAasLink(viewer, fromAasId, toAasId, description)` — value-matched AAS swap across all matching nodes; updates derived `_rvAasLink` and the raw `AASLink` component.
- `setComponentField(viewer, nodePath, component, field, value)` — set any rv_extras component field on a node.

They do NOT retroactively reconfigure already-constructed behavioural components (e.g. a running Drive) — use a GLB/overlay for that.

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

**From settings.json** — the key is `ui.visibilityOverrides` (there is no `uiVisibility` block).
It is a `Record<elementId, UIVisibilityRule>` on `RVAppConfig.ui`
([rv-app-config.ts](src/core/rv-app-config.ts)), applied once in `main.ts` at startup and
overriding code-declared defaults:

```json
{ "ui": { "visibilityOverrides": { "kpi-bar": { "hiddenIn": ["fpv", "xr"] } } } }
```

Startup order matters in one direction: `registerUIElement` **overwrites unconditionally**, and
`SlotRenderer` re-registers a slot entry's compiled rule on every render. So for an id owned by a
slot entry (a plugin declaring `modes`), the compiled `modes` rule wins over
`ui.visibilityOverrides` — the override sticks only for ids registered by `useUIVisible`/chrome.
See [doc-ui-visibility.md](doc-ui-visibility.md).

### Rule Precedence

Evaluated in this order by `evaluateVisibilityRule()` ([ui-context-store.ts](src/core/hmi/ui-context-store.ts)):

1. Unknown element (no rule) → **visible**
2. `shownOnlyInAny` defined and NO listed context active → **hidden** (OR gate — checked FIRST,
   before `shownOnlyIn`; this is what `plugin.modes` compiles into)
3. `shownOnlyIn` defined and not ALL listed contexts active → **hidden**
4. `hiddenIn` — if ANY listed context is active → **hidden**
5. Otherwise → **visible**

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
A plugin can opt to take over transport by setting `handlesTransport: true`. The core loop then skips `transportManager.update(dt)` automatically so the plugin can drive MU movement, sensor detection, and sink consumption on its own. No core code changes needed.

**Why render chart overlays outside HMIShell?**
`HMIShell` has `pointer-events: none` on its container so the 3D scene remains interactive. Chart panels need pointer events for drag/resize, so they render as siblings in `App.tsx`.

**Why RVBehavior base class?**
Mirrors Unity's MonoBehaviour pattern. Every plugin repeated the same boilerplate: store/null-check viewer, find drives, cleanup subscriptions. `RVBehavior` handles this automatically. Subclasses override named hooks (`onStart`, `onPreFixedUpdate`, etc.) instead of implementing raw interface methods.

**Why may a load-time hierarchy mutation never be unconditional? (plan-727)**
An authoring load must leave the node tree exactly as the GLB describes it — the
asset editor exports the live tree, so anything a load moves gets baked into the
saved bytes and the CAD re-import loses the moved nodes silently. If your plugin
or component restructures nodes at load time (`attach()`, `add()`, reparenting a
subtree from `onSceneReady`), gate it on `preserveAuthoringHierarchy` and prefer
computing a world transform over moving the node. Do **not** gate on
`preserveHierarchy` — that flag is about mesh baking and pickability, and the
embed viewer sets it while still needing structure work to run. See the invariant
section in `doc-webviewer.md`.

**Why two signal lookup tables (name + path)?**
Signals need to be addressed by **name** for communication (plugin API, HMI, interfaces) and by **path** for GLB object references (ComponentRef). The name is the signal's identity (Signal.Name if set, otherwise node name); the path is its location in the scene hierarchy. Both resolve to the same underlying value.

---

## 17. Gizmo Overlay System (`viewer.gizmoManager`)

The `GizmoOverlayManager` is the central tool for rendering visual overlays on top of any 3D node. It is **generic** — sensors, drives, grips, stations, or any custom component can request a gizmo without knowing implementation details.

### Public API

```typescript
import type { GizmoOverlayManager, GizmoShape, GizmoOptions, GizmoHandle } from '@rv/core';

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
  keepInComposer?: boolean; // default false — see "Keeping 3D UI out of SSAO"
}
```

### Keeping 3D UI out of SSAO

realvirtual runs Screen-Space Ambient Occlusion (`GTAOPass` / `N8AO`) inside the
`EffectComposer`. GTAO builds its **own** depth+normal gbuffer with a
`scene.overrideMaterial`, so a gizmo's `depthWrite: false` does **not** keep it
out of SSAO — **only the camera layer mask does**. Any 3D UI left on the default
layer 0 ends up in the AO pass and casts dark halos onto nearby geometry. This
is the single most common regression when adding new 3D UI.

You don't have to think about this when using `GizmoOverlayManager`: by default
every gizmo is tagged onto `HIGHLIGHT_OVERLAY_LAYER`, which the render loop pulls
out of the composer before AO and re-renders on top afterwards. New UI built on
the manager is therefore **AO-safe automatically**.

Bloom/glow gizmos (`emissiveIntensity > 0`, or the `mesh-glow-hull` /
`sphere-glow-hull` shapes — which toggle emissive on/off at runtime, e.g.
`WebSensor` states) must stay **inside** the composer so `UnrealBloomPass` can
glow them. They are auto-detected (or set `keepInComposer: true`) and placed on
`NO_AO_LAYER` instead — see below — so they keep bloom **and** stay out of SSAO.

#### Two layers, two helpers

There are two ways to keep 3D UI out of SSAO, depending on whether it should draw
on top of everything or stay in the scene:

| Helper (`rv-group-registry`) | Layer | When to use | Render behavior |
|---|---|---|---|
| `markAsOverlay(obj)` | `HIGHLIGHT_OVERLAY_LAYER` | On-top UI: wireframes, handles, labels, snap guides | Pulled out of the composer, re-rendered on top (depthTest off) |
| `markNoAO(obj)` | `NO_AO_LAYER` | In-scene UI that must be depth-occluded or needs bloom: placement ghost, grid, glow gizmos | Stays in the RenderPass (correct depth + bloom); only the AO pass skips it |

`markNoAO` works via a **dedicated AO clone camera**: the real cameras enable
`NO_AO_LAYER` so the `RenderPass` draws those objects normally, while
`PostProcessingManager.syncAoCamera()` hands GTAO/N8AO a clone with `NO_AO_LAYER`
disabled — so they never enter the AO gbuffer. No look change, full robustness:
once an object is tagged, it's excluded regardless of depth/bloom settings.

The overlay-layer set lives in one place (`OVERLAY_LAYERS` in
`rv-group-registry`); add a new overlay layer there and every render path picks
it up.

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

`registerComponent({ ... })` automatically tags the node in `afterCreate` — `node.userData._rvComponentInstance = inst` (first writer wins) **plus** an ordered `node.userData._rvComponentInstances` array holding every component on that node. The dispatcher listens to the viewer's raycast/selection events, walks up the parent chain and invokes the **first instance that implements the requested hook**:

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
- **Several components on one node** are supported (plan-417): a Unity node may carry e.g. `SceneButtonMoveable` and `SceneButtonBase` at once. Lookup is per hook and per node in registration order, so a component without `onClick` never swallows the click of a sibling — or of an ancestor — that has one. Single-instance nodes behave exactly as before. Detach an instance in `dispose()` with `removeComponentInstance(node, this)`, which also promotes the next instance into `_rvComponentInstance`.

### Reference consumers

- **`RVWebSensor`** (`rv-web-sensor.ts`) — hover/click/select on an overlay gizmo.
- **`RVSceneButtonBase`** (`rv-scene-button-base.ts`, plan-417) — the first *interactive* consumer: `onClick()` runs the button state machine and writes a PLC signal, `onHover()` drives the cap animation. It is also the reference for the two rules the dispatcher imposes on a component family: put the hooks on the node that carries the collider in Unity (never on a wrapper further up, whose event an intermediate component would otherwise absorb), and keep animated meshes out of the pick set so the BVH never holds a stale pose.

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
import { initWebSensor, resetWebSensorConfig } from '@rv/core';

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
- **Pipeline simulation** — [src/plugins/processindustry-plugin.ts](src/plugins/processindustry-plugin.ts). Higher-level pipeline orchestration: pump speed, tank levels, processing-unit throughput.
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

## 21. Unified CAD Import (Provider Registry)

One "Import" entry point ([src/plugins/unified-import/](src/plugins/unified-import/)) serves all geometry sources through a provider registry in the core ([src/core/import/rv-import-provider.ts](src/core/import/rv-import-provider.ts)). The dialog renders one tab per registered provider and offers the sink choice explicitly:

- **Add to current scene** (additive, default) — `viewer.importObject(items, options)` places through the layout planner: `AddPlacementOp` in the scene op log, full undo/redo, autosave. It never calls `loadModel`/`clearModel`; the existing scene is untouched. Non-catalog results (raw GLB bytes, parsed CAD trees) are first written into the Local Working Folder (`library/imports/`) as a regular catalog asset so the placement survives reloads; without a working folder the import still places (blob URL) but is flagged as non-persistent with a visible warning.
- **Open as new scene** (replace) — `openImportAsNewScene(viewer, item)` from [src/core/import/rv-import-object.ts](src/core/import/rv-import-object.ts) loads via `viewer.loadModel()` (clears the scene). STEP results go through `preParsedRoot` — no GLB round-trip.

### Writing a provider

Implement `CadImportProvider` and register it:

```ts
import { importProviderRegistry, type CadImportProvider } from '.../core/import/rv-import-provider';

const provider: CadImportProvider = {
  id: 'my-source',
  label: 'My Source',
  availability: () => 'ready',            // 'ready' | 'needs-setup' | 'connecting' — reactive, not a sync boolean
  onAvailabilityChange: (cb) => myStore.subscribe(cb),
  renderConfigTab: (ctx) => <MyTab ctx={ctx} />,   // call ctx.setInput(...) when the user picked something
  resolve: async (input) => ({ ok: [/* object3d | glb | catalog items */], failed: [] }),
};
importProviderRegistry.register(provider);
```

Notes:

- `resolve()` supports **partial success** (`{ ok, failed }`); a throwing resolve is normalized by `resolveProviderSafe()` — errors surface in the dialog, never silently.
- Registering an existing id **replaces** the previous provider (logged warning) — registration is idempotent for HMR.
- Commercial providers (STEP, Unity Asset Manager, Onshape) register from the private repo; a public build only carries the core GLB-file provider.
- Additive placement auto-align (`pivotToFloorCenter`/`alignToFloor`) can be skipped per import via `importObject(..., { skipAutoAlign: true })` — required for multi-part CAD assemblies with a functional origin. The dialog exposes this as the "Auto-align to floor" checkbox.
- The additive STEP provider has a kill switch: set localStorage `rv.import.stepAdditive` to `off` to unregister it without affecting other providers.

### Blueprint / 2D plan view

[src/plugins/blueprint-plugin.ts](src/plugins/blueprint-plugin.ts). Top-down 2D plan view overlay; useful as a mini-map or layout preview.

### MCP bridge & MCP tool authoring

[src/plugins/mcp-bridge-plugin.ts](src/plugins/mcp-bridge-plugin.ts) opens a WebSocket to the Python MCP server. Tools are declared on `RVBehavior` subclasses with the `@McpTool` and `@McpParam` decorators in [src/core/engine/rv-mcp-tools.ts](src/core/engine/rv-mcp-tools.ts) — the bridge auto-discovers them on connect and registers JSON tool schemas. To add a new tool: subclass `RVBehavior`, decorate an async method, and register the plugin. The user-facing tool catalog is [webviewer.mcp.md](webviewer.mcp.md).

### SimController (Play / Pause / Reset)

[src/plugins/sim-controller/](src/plugins/sim-controller/) registers a 2-button TopBar widget plus Pause-Badge. It is the **canonical example** of how to hold the simulation pause via a named reason — see "Pause-Reason Pattern" below.

### Pause-Reason Pattern (Defense-in-Depth)

The simulation pause state in realvirtual is a **set of named reasons**, not a boolean. Multiple subsystems can hold pause simultaneously (`viewer.setSimulationPaused('my-reason', true)`), and the simulation only resumes when every reason has been released. The same `reason` string can be set/cleared multiple times — only set membership matters.

Existing reasons: `'user'` (SimController), `'layout-edit'` (Layout-Planner), `'ar-placement'` (WebXR), `'shared-view'` (Multiuser).

To safely participate without leaking a frozen simulation, plugins must release their reason on every shutdown path. **Defense-in-Depth, three stages**:

1. **UI close path** — every code path that closes the plugin's panel/mode must call the same release. Audit every `onClick`, `lpm.close()`, `setActive(false)` and confirm they end with `viewer.setSimulationPaused(myReason, false)`.
2. **`dispose()` safety net** — release the reason unconditionally in `dispose()`. Catches the case where the user closes realvirtual / swaps the model while the panel is still open.
3. **Manual escape (dev tools only)** — `viewer.clearPauseReasons(reason?)` exists as a last-resort override. It logs a `[SimControl]` warning so leaks remain observable; never call it from production code paths.

Reference implementations: [src/plugins/sim-controller/index.ts](src/plugins/sim-controller/index.ts) and the `setActive` / `dispose` of [src/plugins/layout-planner/index.ts](src/plugins/layout-planner/index.ts).

### Where the public RVViewer API is documented

There is no separate API reference yet. The authoritative surface is [src/core/rv-viewer.ts](src/core/rv-viewer.ts) (search for `class RVViewer` and `interface ViewerEvents`). Most plugin-relevant calls are described in §3 (RVViewerPlugin / RVBehavior), §4 (Events), §5 (UI Slots), §9 (Left Panels), §13 (Per-Model Plugins) above.

## 21b. Physics Provider Registry (optional physics zones)

The zone-based physics feature (see "Physics Zones (optional)" in [doc-webviewer.md](doc-webviewer.md)) follows the same public-interface / private-provider split as the IK solver: the AGPL core ships only the contract and a registry singleton in [src/core/engine/rv-physics-registry.ts](src/core/engine/rv-physics-registry.ts); the actual engine (Rapier, Rust → WASM) is a private provider. Without a registered provider the feature is a **strict no-op** — kinematic transport runs unchanged and no physics code is loaded.

```ts
import { physicsRegistry, type PhysicsProvider } from '.../core/engine/rv-physics-registry';

physicsRegistry.register(myProvider);   // private side; pass null to unregister
```

`PhysicsProvider` is deliberately dependency-free (lean `{x,y,z}` structural types, no Three.js, no engine types). The contract in short:

- **Lifecycle**: `init()` (lazy, re-entrancy-safe — loads the WASM on demand), `dispose()` (must free the WASM world; safe during a pending init), `ready`, and a `failed` fail-off latch: after the first `step()` exception the provider disables itself permanently (one error log, every further call is a no-op).
- **World building**: `addZone` (application-level AABB + per-zone config; first zone wins on overlap), `addStaticBox`, `addConveyor` / `setConveyorVelocity` (kinematic velocity-based belts), `addSensorBox`, `addDynamicMU` (kinematic → dynamic handover with an explicit initial velocity), `removeBody` (two-phase and idempotent — bodies are freed at the end of the next step, never mid-tick).
- **Per tick**: `step(dt)` (fixed accumulator dt only), `syncPoses(out)` (zero-GC readback — the callback receives reused pos/quat objects, copy immediately), `getSettledBodies(maxLinVel, uprightToleranceDeg)` (call exactly once per tick), `castRay`, and the `onSensorEvent` enter/leave callback.

**`IPhysicsMUHook`** (same file) is the narrow injection seam between the transport manager and the physics lifecycle owner (pattern: `IAccumulationQuery`): the physics plugin registers itself as `transportManager.physicsMUHook`, and every MU dispose path — swap-and-pop removal, `reset()` (sim stop/reset, model clear, kernel mode switch) and `removeMU()` — calls `onMUDisposed(mu)` **before** `mu.dispose()`, so no physics body is ever orphaned.

**`IMULifecycleHook`** (`rv-transport-manager.ts`, plan-394) is the second seam of that shape and exists for the opposite direction: `onMUSpawned(mu, role)` fires right after a source pushed a new MU, `onMURemoved(mu)` on every dispose path. It is needed because a spawned MU cannot carry its own configuration — the clone paths call `stripComponentMetadata()`, which deletes `userData.realvirtual` so a clone never resurrects as a live component. Anything an MU should inherit is therefore handed over by its source at spawn time; the collision manager uses it for `Source.CollisionRoleForMUs`.

Read-only diagnostics live in the `physicsDiagnostics` singleton (same module): `{ active, zones, bodies, stepMs }`, mutated in place by the provider's plugin and consumed by the Settings → Simulation line and the `web_transport_status` MCP tool.

The private reference implementation is `RapierPhysicsProvider` + `PhysicsZonePlugin` (lifecycle owner: world build per model load, step/sync per tick, settle return, DES/multiuser/reset guards) in the private repo.

## 21c. Machining Provider Registry (CSG material removal)

The CSG milling/drilling feature (see "Machining (CSG material removal)" in [doc-webviewer.md](doc-webviewer.md)) follows the same public-interface / private-provider split as physics and the IK solver: the AGPL core ships only the contract, the registry singleton and the two components (`RVMachiningVolume`, `RVMachiningTool`) in `src/core/engine/rv-machining-registry.ts` / `rv-machining-volume.ts` / `rv-machining-tool.ts` / `rv-machining-manager.ts`; the actual kernel (`rv-csg` Rust crate → `rv_csg.wasm`, run inside a Web Worker) is a private provider. Without a registered provider, `machiningRegistry.provider` is `null`, every `MachiningVolume` keeps its authored workpiece mesh visible, and one console warning is logged (F10 — no crash, no synchronous fallback compute path).

```ts
import { machiningRegistry, type MachiningProvider } from '.../core/engine/rv-machining-registry';

machiningRegistry.register(myProvider);   // private side; pass null to unregister
```

`MachiningProvider` is deliberately dependency-free (lean `{x,y,z}` structural types, no Three.js, no WASM types, no URL — nothing crosses the public/private seam but the interface itself). The private provider registers from a **feature adapter** (`features/machining.register.ts` in the private repo, same pattern as `ik-solver.register.ts`), loaded lazily only once a model actually contains a `MachiningVolume`.

### Job/ack protocol instead of fire-and-forget

Subtraction is too expensive to run on the main thread (SIMD128, single-threaded, no `rayon` in the browser build — see the plan's benchmark), so the entire kernel — SDF grid, `rvc_subtract`, tessellation — lives in one Web Worker per session. Because the worker is asynchronous and can fall behind, the contract is a **job/ack protocol with sequence numbers**, not fire-and-forget:

- `submitSubtract(handle, job)` is non-blocking and returns `{accepted:true, seq}` or `{accepted:false, reason:'backlog'|'closed'}` immediately — it never throws and never awaits the worker.
- `onAck(handle, cb)` delivers `{seq, removedVoxels, pendingJobs, pendingChunks}` per processed job. `pendingJobs`/`pendingChunks` are **momentary** queue depths, not cumulative counters.
- `onChunkMeshes(handle, cb)` delivers transferable, trimmed-to-actual-size chunk batches as they're tessellated (budgeted `MACHINING_TESSELLATE_BATCH = 16` chunks per kernel call, parity with the Unity `CsgKernel.TESSELLATE_BATCH`).

### Backpressure and sweep coalescing

At most `MACHINING_MAX_PENDING_JOBS = 8` unacknowledged jobs are allowed per grid. When the manager's per-tick submit is rejected with `reason: 'backlog'`, it does **not** drop the tick or collapse the tool's motion to a straight chord — a `MachiningSubtractJob` carries an **ordered segment list** (`MachiningToolSegment[]`), and the rejected tick's segments are prepended to the next job's list. A curved path A→B→C stays two segments (A→B, B→C); every intermediate pose survives as its own `rvc_subtract` call in the worker, so coalescing is volume-equivalent up to `MACHINING_MAX_SEGMENTS_PER_JOB = 64` segments per job — only above that cap does the worker degrade deterministically by reducing per-segment substeps (lossy, and the only place it is).

### Reset barrier and epochs

`resetGrid(handle)` is a **barrier**, not just another job: every queued job is discarded (sequence-range invalidation), and the returned promise resolves only after the worker confirms the grid has been re-initialized — a new **epoch** begins at that point. Every chunk batch and ack carries the epoch it was produced under; a batch that arrives after a reset or a `destroyGrid()` of the same handle is silently dropped by the epoch guard instead of being applied to stale geometry.

### Idle ack — why `SignalMachiningActive` actually falls

`SignalMachiningActive` is derived from `pendingJobs + pendingChunks > 0` on the **last received ack** — a momentary state, never a latch on "the last ack had `removedVoxels > 0`" (that construction never falls again once material has been removed at all). To make the momentary state reachable even after the queues genuinely go idle, the worker emits a synthetic **idle ack** (`isIdleAck(ack)` is true for `seq < 0`, both depths `0`) once both the job queue and the chunk queue have drained — so the signal is guaranteed to fall to `false` by the following tick.

### Fail-off latch and boot watchdog

`failed` on the provider is a **permanent** latch: `catch_unwind` does not exist on `wasm32`, so a WASM panic traps the whole instance and the only safe reaction is to stop calling into it — every method becomes a no-op afterward (`submitSubtract` returns `reason: 'closed'`). The private provider also guards against a worker that never reports readiness at all: a boot watchdog (`MACHINING_BOOT_TIMEOUT_MS = 15s`) fails the provider off instead of leaving `init()` pending forever, and `worker.onerror` / `onmessageerror` are wired to the same fail-off path — the only channel available when the worker's module failed to load and no line of its own code ever ran.

### `destroyGrid`, listener cleanup and `clearModel()`

`destroyGrid(handle)` is idempotent, aborts an in-flight `createGrid`/`resetGrid` of the same handle cleanly, frees the grid's WASM linear memory exactly once, and removes every listener registered via `onAck`/`onChunkMeshes` for that handle (both of which return an `Unsubscribe` function). It is the *only* route by which a grid's memory is freed — `clearModel()` calls it for every live grid before geometry teardown, which is what keeps repeated model switches from leaking worker-side memory.

### `MachiningManager` — the per-tick driver

`MachiningManager` (`rv-machining-manager.ts`) is the per-frame-manager for this feature (see "Per-frame components" in §2 above): instantiated once in `RVViewer`'s constructor, reachable through `ComponentContext.machiningManager`, ticked in `CoreSubsystems.visuals(dt)` **after** the drive updates of the same tick (tool poses must see the fresh axis positions), and torn down in `clearModel()`/`dispose()`. It reads every registered tool's `matrixWorld` relative to its volume, builds the swept segments, submits jobs, applies acknowledged chunk batches to `RVMachiningVolume` (marking render **and** shadow dirty), and owns the reset-signal edge detection. It is inactive during DES FastForward and while following another session as a multiuser client — analogous to the physics provider.

## 22. Typed Connections (Script API)

Typed, directed connections ([src/core/engine/rv-connection-registry.ts](src/core/engine/rv-connection-registry.ts)) link two components as a named **bidirectional call**: request parameters out, deferred response parameters back through a reply handle — no Promise/await, deterministic in both kernels. Edges + user-defined type signatures live in the rv-ODT `Connections` block (see `schema/v1/specification.md`, section 7g); the Property Inspector's Connections section and Shift+Drag create them in the editor (op-logged, undoable).

### Station side — the built-in `StopOnExit` type

Connect a **sensor** (source) to a **station script** (target). When an MU reaches the sensor it is already stopped (single-MU hold on accumulating surfaces, belt stop otherwise / for instanced MUs) before the handler fires:

```js
function setup(self) {
  return {
    onArrival(mu) {                      // "sensor: got one" — mu is already held
      self.setState('processing'); self.statState('Working'); self.statCycleStart();
      self.in(self.prop.ProcessTime, 'done', mu);
    },
    des: { on(hook, mu) {
      if (hook === 'done') {
        self.statCycleEnd(); self.statOutput(1);
        self.setState('idle'); self.statState('Empty');
        mu.release();                    // "station: done, may pass" — frees the hold
      }
    } },
  };
}
```

`mu.release()` frees whatever hold mode was applied; a double release is a no-op. The per-edge `ProcessTime` config is authored in the inspector and arrives via `self.prop`.

### Custom types — `self.connection(type).call` / `onRequest`

User-defined types carry their request/response parameter schemas as DATA in `connectionTypes` — the inspector renders typed fields and the runtime validates parameters (missing → default + warning, type mismatch → default + warning):

```js
// Target (receiver) — reply now or in a later tick (deferred handle):
onRequest(topic, params, reply) {
  if (topic === 'QualityCheck') {
    self.in(2.0, 'inspected', null, { params: params, reply: reply });
  }
},
des: { on(hook, mu, data) {
  if (hook === 'inspected') data.reply({ pass: true, defects: 0 });
} }

// Source (sender) — 1:n fan-out; onReply fires once per replying target:
var n = self.connection('QualityCheck').call({ partId: 42, imageRef: 'img://x' }, function (resp) {
  if (!resp.pass) self.raiseError('QC', 'part failed inspection');
});
```

Rules: a reply handle answers **exactly once** (duplicates are ignored with a warning); open handles are invalidated on `simulation-reset` and dispose (no ghost replies); cyclic edges (A→B→A) are allowed but dispatch is depth-guarded and edge creation warns. Delivery to the target is scheduled on the target's own event list — never re-entrant into the caller's tick.

### Live geometry in DES hooks (FastForward note)

In DES FastForward the runner normally skips per-frame animation and only "settles" tween positions to the exact simulation time before events dispatch when a component in the model needs it. Script components with DES hooks (`des: { on(...) }`, `des.onAccept`, ...) count as needing it: while at least one active script component with DES hooks exists, the event-time settle stays on, so reading live world transforms (`node.worldPosition()` etc.) inside a hook always sees exact positions — at the cost of the model-wide FastForward fast path. Prefer values carried in event data (`self.in(delay, hook, mu, data)`) over sampling world transforms inside DES hooks when you do not actually need live geometry; the DES lint flags `worldPosition()`/`worldQuaternion()`/`worldDirection()` in DES-hook components with a hint for this reason. (Built-in material-flow definitions declare the same need explicitly via `des: { samplesLiveGeometry: true }`.)

### Host-side extension points

- `registerBuiltinConnectionType({ type, config, configDefaults, description })` — add an engine-semantic type (module-load side effect, like `registerComponent`).
- `getConnectionSystem()` — the session registry: `addConnection` / `removeConnection` / `outOf(path)` / `into(path)` / `registerEndpoint(path, { onRequest?, onArrival? })` / `call(...)`.
- Cable layer: [src/plugins/connection-gizmo-plugin.ts](src/plugins/connection-gizmo-plugin.ts) draws one `link-line` gizmo per resolvable edge (color by type via `connectionTypeColor`), toggleable through the `connections` overlay category.
- Drag-to-link: [src/core/hmi/node-link-drag-store.ts](src/core/hmi/node-link-drag-store.ts) (its own isolated instance of the generic [src/core/hmi/drop-target-registry.ts](src/core/hmi/drop-target-registry.ts) — the signal-linking domain from plan-246 uses another instance and is unaffected).

## 23. Path Simulation — Agv as a Library-Component Example + Routing Hooks

[src/behaviors/Agv.ts](src/behaviors/Agv.ts) and [src/behaviors/OverheadConveyor.ts](src/behaviors/OverheadConveyor.ts) are the reference examples for a library component built on the path substrate: one `defineLibraryComponent(def)` call each (see [doc-behavior-modelling.md](doc-behavior-modelling.md) for the factory), riding `RVPath` / `RVPathNetwork` / `PathTraveler` ([src/core/engine/rv-path.ts](src/core/engine/rv-path.ts), [rv-path-network.ts](src/core/engine/rv-path-network.ts), [rv-path-traveler.ts](src/core/engine/rv-path-traveler.ts)) with raycast-free traffic (`SpacingController` headway + `ZoneRegistry` claims). The Agv shows the full pattern: schema defaults from rv_extras, the shared drive ramp for speed, signals with `self.isWired` live-override, a `continuous` block plus a purely declarative `des` block, and reset/teardown hooks that release every zone claim (a surviving claim would block a crossing permanently).

**The component ships mechanics only — routing and dispatch are project logic.** Three id-based hooks cross to project code (only plain values, never engine objects):

| Hook | Fired | Contract |
|---|---|---|
| `selectNextPath(candidateIds, ctx)` | at every junction (and by the traffic look-ahead) | return one of `candidateIds`; anything else → default `candidateIds[0]` |
| `onArrive(pathId, travelerId)` | a vehicle completed a path (hand-off or dead-end stop) | notification |
| `requestDispatch(travelerId)` | once when a vehicle goes idle at a dead end | the dispatch trigger for fleet logic |

There are two ways to fill them:

1. **Native TS (tests, custom engine code):** set `traveler.hooks.selectNextPath` / `hooks.onArrive` per traveler, or register a network-wide router via `getDefaultPathNetwork().setRouter(router, owner)` (returns the unregister function). Per-traveler hooks take precedence over the router.
2. **Project script (JS-in-GLB):** declare `routing.*` handlers in the setup return — the web-component registry registers them as the network's project router and unregisters them on dispose/hot-reload. Dispatch is synchronous host→VM (the same `callHandler` pattern as the DES station handshake); the path graph is queryable by id via `self.paths`. See [doc-scripting.md](doc-scripting.md) for the script-side API and a routing-table example.

```js
// Project script: route by table, reserve a charging bay, dispatch on idle
function setup(self) {
  var routeAt = {};                         // 'travelerId@junctionPathId' → chosen successor id
  self.paths.claim('ChargingBay');          // zone reservation by id (shared with AGV traffic)
  return {
    routing: {
      selectNextPath: function (ids, ctx) {
        // Pure table lookup — deterministic and repeatable per junction.
        var want = routeAt[ctx.travelerId + '@' + ctx.currentPathId];
        return want && ids.indexOf(want) >= 0 ? want : ids[0];
      },
      onArrive: function (pathId, agvId) {
        self.log(agvId + ' completed ' + pathId);  // progress tracking
      },
      requestDispatch: function (agvId) {
        routeAt[agvId + '@M'] = 'B';               // assign the next mission leg(s)
      },
    },
  };
}
```

Keep `selectNextPath` cheap, side-effect-free and deterministic: the headway leader search and the zone claim walk re-ask the same routing decision every tick through the same dispatch, so a random or self-mutating pick would make the look-ahead diverge from the actual hand-off. Mutate routing state in `requestDispatch` (fired once per stop), never inside `selectNextPath` — and note that `onArrive(pathId, …)` fires *before* the routing pick at that same boundary, so do not consume the decision for `pathId` there.


## Library source providers (plan-372)

Every supplier of placeable assets registers with one registry, and all three
consumers — the Layout Planner, the Projects dashboard and the Asset Editor —
read that single list. None of them imports another.

```ts
import {
  registerLibrarySourceProvider,
  type LibrarySource,
  type LibrarySourceProvider,
} from 'core/library/library-source-registry';

const unregister = registerLibrarySourceProvider({
  id: 'my-provider',                       // unique across providers
  listSources: (): LibrarySource[] => [...],
  subscribe: (listener) => store.subscribe(listener),
});
```

Three rules are not negotiable:

- **Identity is the pair `(providerId, sourceId)`.** A source id only has to be
  unique inside its provider. `resolveAsset` takes an `assetId`, never an entry
  object — otherwise reopening an editor draft is impossible.
- **`ResolvedAsset.url` is never persisted.** Cloud adapters return `blob:`
  URLs that are dead after a reload. The caller owns the URL and must call
  `revokeUrl()` in the success, error *and* cancel paths.
- **`getSnapshot` fallbacks must be module-level constants.** An inline
  `() => ({...})` gives `useSyncExternalStore` a new identity on every read,
  which is an infinite render loop (React minified error #185).

## Project backends

A project's bytes live behind `ProjectBackend`, with three implementations:
`bundled` (a delivered build, read-only), `browser` (OPFS) and `folder` (File
System Access). Anything writing project data should go through the backend
rather than reaching for the filesystem, so it works on all three — that is what
lets a user on Firefox or Safari, where only the browser backend is writable,
save their own assets at all.
