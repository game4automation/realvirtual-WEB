# Extending realvirtual WEB

> **Applies to:** Community runtime and public extension APIs. Examples of commercial or optional integrations require the corresponding feature or separate product.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-09-16.
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

Start with the runnable [Community project plugin](doc-project-plugin-example.md). This is the detailed extension reference; [Events](doc-events-and-hooks.md) owns the event catalog, [Lifecycle](doc-lifecycle.md) owns execution order, and [UI visibility](doc-ui-visibility.md) owns presentation rules.

> Ribbon editor overlays use the `ribbon-preview` overlay category and descriptive
> `GizmoOptions.kind` tags. Extensions should treat these gizmos as transient,
> non-pickable authoring aids and hide them around custom capture/export passes via
> `RibbonEditorPreview.beginExportPass()` / `endExportPass()`. Unity does not export
> `RibbonWinder.SpeedControl`; its imported default is `None`. The built-in MCP
> screenshot path already applies this guard; custom GLB and thumbnail exporters
> must bracket their own clone/render operation.

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

Four extension points:

1. **Plugins** — lifecycle callbacks, simulation data, event emission, optional UI slot registration
2. **Events** — typed pub/sub between plugins and UI
3. **UI Components** — Left panels, chart overlays, tooltips, slot-based layout areas
4. **Commands** — one definition per user action; buttons, menu items, shortcuts and MCP write
   tools are views of it ([§5b](#5b-commands--buttons-menus-shortcuts-and-mcp-tools-as-views))

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

#### Pointer coordinates: use `rv-pointer-utils`, never your own arithmetic

A plugin that raycasts from a pointer event converts client coordinates to
Normalized Device Coordinates. There is exactly one place that does it:

```typescript
import { pointerToNDC, ndcFromRect } from '../core/engine/rv-pointer-utils';

// The common case — one getBoundingClientRect() inside the helper.
pointerToNDC(e.clientX, e.clientY, canvas, this._ndc);

// When the handler ALSO needs the rect (a bounds check, a zero-size guard),
// measure once and hand the rect over. A second getBoundingClientRect() in a
// pointermove handler is a second forced layout on every mouse move.
const rect = canvas.getBoundingClientRect();
if (e.clientX < rect.left || e.clientX > rect.right) return null;
ndcFromRect(e.clientX, e.clientY, rect, this._ndc);
```

Both write into the `out` vector you pass and return it; omit `out` and you get a
shared module-level scratch vector that the NEXT call overwrites — fine to hand
straight to `Raycaster.setFromCamera`, never something to store.

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
| `Drive_SEWMovilink` | `RVDriveSEWMovilink` | `rv-drive-sew-movilink.ts` |
| `Drive_ProfidriveSpeed` / `Drive_ProfidrivePos` | `RVDriveProfidriveSpeed` / `RVDriveProfidrivePos` | `rv-drive-profidrive-speed.ts` / `rv-drive-profidrive-pos.ts` |
| `Drive_FestoFHPP` | `RVDriveFestoFHPP` | `rv-drive-festo-fhpp.ts` |
| `Drive_UniDriveMotor` | `RVDriveUniDriveMotor` | `rv-drive-unidrive-motor.ts` |
| `Drive_ProportionalValve` | `RVDriveProportionalValve` | `rv-drive-proportional-valve.ts` |
| `Drive_ContinousDestination` | `RVDriveContinousDestination` | `rv-drive-continous-destination.ts` |
| `DrivePulseEncoder` | `RVDrivePulseEncoder` | `rv-drive-pulse-encoder.ts` |
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
    pick: 'select',            // 'none' | 'select' | 'action' — pointer interaction (default 'none')
    bake: 'chunk',             // 'merge' | 'chunk' | 'keep' — what the planner bake does with its meshes (default 'merge')
    ui: {
      badge: '#4fc3f7',        // Badge color in the hierarchy browser
      filter: 'My Components', // Label in the search/filter dropdown + visibility auto-filters (null = not filterable)
      category: 'transport',   // Coarse hierarchy-chip / search-group category (see ui.category below)
      tooltip: 'drive',        // Tooltip content type (must match a tooltip-registry key)
      priority: 10,            // Tooltip section priority — HIGHER is the primary section (default 5)
      hidden: false,           // true hides the component from inspector + hierarchy chips
    },
    authorable: false,         // addable in the asset editor's "Add Component" section
    // claimsNode: false,      // pure annotation: the node DISAPPEARS from baked models unless something else claims it (default true)
    // onPreBake: (node, extras, ctx) => { ... },  // see "capabilities.onPreBake" below
  },
  create: (node) => new RVMyComponent(node),
  // Optional hooks:
  // needsAABB: true,                          // if component needs a BoxCollider AABB
  // beforeSchema: (inst, extras) => { ... },  // extract raw data before coord conversion
  // afterCreate: (inst, node) => { ... },     // set node metadata after construction
});
```

The `capabilities` field is optional. When omitted, conservative defaults apply (`pick:'none'`, `bake:'merge'`, visible, not filterable, no tooltip). All capability fields are optional — only specify what differs from defaults.

**Standalone capability registration** — For types without a factory (e.g., pipeline types, AAS links), use `registerCapabilities()` directly:

```typescript
import { registerCapabilities } from './rv-component-registry';

// Register capabilities for a type that has no factory (no create() needed)
registerCapabilities('AASLink', {
  pick: 'select',
  ui: { tooltip: 'aas', badge: '#26a69a', filter: 'AAS', category: 'info', priority: 3 },
});
```

**Capability reference (plan-753 §2.3):**

| Capability | Type | Default | Description |
|-----------|------|---------|-------------|
| `pick` | `'none' \| 'select' \| 'action'` | `'none'` | Pointer interaction. `select` = hover + tooltip + click selects the node. `action` = hover + click fires `component.onClick` **without** selecting (3D buttons, switches, doors — until the chunk pick backend of plan-753 Phase 3 lands, the gate treats it like `select`). Every `pick !== 'none'` type is hover-enabled at model load; `RVViewer.setExclusiveHoverMode()` narrows that to one type among those that also carry a `ui.filter`. |
| `bake` | `'merge' \| 'chunk' \| 'keep'` | `'merge'` | Bake role of the node's meshes (`rv-bake-chunk.ts`). `chunk` = a MOVER: the subtree is cut into its own chunk under the mover node and transformed as a unit (Drive, Kinematic, Grip, TransportSurface, Cam, SceneButtonMoveable, PlacementMeta …); it also keeps the node matrix-dynamic in `freezeStaticMatrices`. `keep` = the ORIGINAL meshes stay individual and are never baked (Lamp, MU, Source, Chain, ribbon web, MachiningVolume, Pipe/Tank, EnergyChain rig …). `merge` (the default, also Sink) = staged into the enclosing chunk. Read per node via `bakeRoleOf(node)`: `keep` > `chunk` > `merge` across the node's components, an authored `rv.BakeRole` extras value overrides, no registered component → `undefined` (the bake inherits). |
| `ui.badge` | string | `'#90a4ae'` | Hex color for the hierarchy browser badge |
| `ui.filter` | string/null | `null` | Label in the search/filter dropdown, the visibility auto-filters and the exclusive hover group. Also the FINE second level of the hierarchy filter: the entry in a category chip's ▾ menu |
| `ui.category` | string/null | `null` | Coarse category (plan-597): one hierarchy filter chip and one global-search result group. Ids, in their fixed chip/search order: `drives`, `sensors`, `transport`, `material-flow`, `process`, `robotics`, `signals`, `logic`, `hmi`, `physics`, `info`, `other`. Resolved by `categoryOf(typeKey)` (`rv-component-category.ts`): the exact key's capabilities, else the `_N` base type, else a built-in rule for types without a declaration of their own (`PLCInput*`/`PLCOutput*`/`ConnectSignal` → signals, `LogicStep_*` → logic, `Drive_*` → drives, `Source`/`Sink`/`MU`/`DES*` → material-flow, `Grip`/`GripTarget` → robotics, …), else `other`. An id outside the list is normalised to `other` (DEV warning). Every literal `ui.filter` declaration must also carry a `ui.category` other than `other` — `tests/component-category-coverage.node.test.ts` scans the source for it |
| `ui.tooltip` | string/null | `null` | Tooltip content type (key in tooltip-registry) |
| `ui.priority` | number | `5` | Tooltip section priority for hover AND pinned bubbles — the **higher** priority is the primary section |
| `ui.hidden` | boolean | `false` | Hide the component from the Property Inspector and the hierarchy chips (`isHiddenComponentType`) |
| `authorable` | boolean | `false` | Can be added to a node in the asset editor's "Add Component" section (needs a complete schema — initial values come from `getSchemaDefaults`). A type whose rv-ODT `$def` has no defaults persists explicit authoring defaults in its add path instead — `BoxCollider` (plan-525: `center` 0, `size` 0.1 m, one per node, a child `Collider` on a mesh node) and `WebPhysicsZone` (adds a missing 1 m `BoxCollider` in the same undo step) go through `collider-add-rules.ts` of the asset editor. |
| `onPreBake` | function | none | Static hook on the TYPE, run over the throwaway graph before the bake — see *`capabilities.onPreBake`* below. Extras keys with the `_N` dedup suffix (`Group_1`) dispatch to their base type; a hook gets the node's full extras and runs once per (node, type). |
| `claimsNode` | boolean | `true` | Does a component of this type keep its node alive through the destructive bake? `false` = pure annotation: **a node that carries nothing else DISAPPEARS from every baked model** — it survives only as reference target, `bakeClaims()` claim, `Snap-*` port, keep mesh or ancestor of a survivor. Declared by `Group` and the Unity export markers (`rigidbody`, `renderer`, `colliders`, `BoxCollider`, `MeshCollider`, `RuntimeUIWindow`, `RuntimeInteractable`); the set is frozen in `tests/bake-claims-node.test.ts`. `BoxCollider` is authorable since plan-525 (factory `RVBoxCollider`, visible in the inspector) and still declares `claimsNode: false` — an authored collider lives on an EMPTY node, which the survival model keeps by its authored-collider rule, while the same marker on a CAD mesh stays pure annotation. Read it through `claimsNodeOf(key)`, which resolves `_N` keys to their base type; an unknown type claims. Leave it at the default unless your type really is data about geometry that nobody addresses by path. |

Node-level getters: `pickModeOf(typeOrNode)` (strongest mode across the node's components, `action` > `select` > `none`), `bakeRoleOf(node)`, `uiOf(type)`; type queries: `getPickableTypes()`, `getFilterableTypes()`, `getTypesWhere(pred)`, `getTypesWithCapability('pick' | 'bake' | 'authorable')`.

#### Surviving the bake (plan-754)

The bake is **destructive**: after it, a node that nobody claimed does not exist.
It is not hidden, not masked and not merely unregistered — it was never built into
the template that reaches the scene. What survives is: any node with an rv
component whose type claims its node (`claimsNode`, default true — a `Group` or
a Unity export marker alone claims nothing), any node a reference points at, a `Snap-*` port, the ancestor chain of
a survivor (so survivor paths never change), and the keep meshes. So if your
extension needs a node at runtime, it has to say so BEFORE the bake. There are
three ways, in order of preference:

**1. A component on the node.** The normal case, and the one that also gets you a
path, an inspector and a badge. Declare the role your component needs:

> **Whoever touches a mesh is `keep`. A reference can only claim a node or a
> boundary.** Rewrites geometry or swaps a material → `keep`. Only moves or hides
> the subtree → `chunk`. Neither → leave it at `merge`: the node survives, its
> triangles go into the enclosing chunk, and pick/highlight still reach it through
> its index window. Mesh ownership is always LOCAL to a component sitting on the
> node — there is deliberately no way to claim someone else's mesh from a distance.

**2. `bakeTarget` on a reference field.** A `componentRef` / `componentRefArray`
field declares what it claims for its TARGET:

```typescript
// rv-component-registry.ts
export interface FieldDescriptor {
  /** Reference fields only. Default 'merge' (target survives as a node);
   *  'chunk' makes the target a chunk boundary. NEVER 'keep'. */
  bakeTarget?: 'merge' | 'chunk';
}
```

Read it through `bakeTargetOf(desc)` — never off the descriptor directly. The
effective role of a node is the STRONGEST of its own component roles and every
incoming tag, `keep > chunk > merge > unclaimed (= removed)`. Because the default
is `merge`, an untagged reference is still safe: its target survives. Tag `chunk`
when the referrer moves, hides, scales, scrolls or clones the target as a unit —
`KinematicJoint.BodyA/BodyB` and `WebVisibility.AdditionalTargets[]` are the
canonical examples. The generated rv-ODT schema does not carry this keyword (D15),
so the tagged fields — including the handful of path-string and name-in-subtree
references — are declared in one TS table, `REFERENCE_BAKE_TARGETS`
(`src/core/engine/rv-bake-survival.ts`). Add a row there rather than a fourth
resolver.

**3. `RVPlugin.bakeClaims()` — a bare CAD node a plugin needs.** When the node you
need carries nothing and you cannot change the GLB, claim it by path. Claims are a
**main-model input only** (plan-757 D5): they are collected by the viewer for the
document it loads and never for a planner placement — a placed asset is baked by the
`ModelCache` through the same recipe (`prepareAndBake`, `src/core/engine/rv-prepare-and-bake.ts`)
but without a plugin layer, so a bare node your plugin needs inside a *placed* asset
must carry a component (or be a reference target) in the asset's own file. A claim that
is nevertheless addressed into a placement — its path starts with the placement's
document path (`Layout/Arburg_1/…`) or with the asset's root name (`Arburg/…`), or it
resolves inside the instance — kept nothing, and the viewer says so: one
`plugin-claim-not-applicable` entry per (placement, claim) in the Problems panel
(`src/core/hmi/problems-store.ts`), cleared with the document. Nothing is logged to the
console for it, and the main model's removal report lists the same claim as unresolved.
Claim paths are read by the same resolver as every component reference: as written
inside the asset, else with the root name stripped (`Conveyor/Label` and `Label` both
name the conveyor's label), else unresolved:

```typescript
// A model plugin that attaches an error badge to a bare CAD leaf at runtime.
export default class CagelinePlugin implements RVViewerPlugin {
  id = 'mauser-cageline';

  // Collected by the viewer BEFORE the bake and fed into the survival model
  // next to the reference tags. Without this the node is pruned and the
  // getNode() below returns undefined.
  bakeClaims() {
    return [
      { path: 'MauserCageline30/Station_12/Housing/ErrorLamp', role: 'chunk' as const },
      { path: 'MauserCageline30/Station_12/Gate', role: 'merge' as const },
    ];
  }

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    const lamp = viewer.registry.getNode('MauserCageline30/Station_12/Housing/ErrorLamp');
    if (!lamp) return;               // claim unresolved, or a different document
    attachWebError(lamp);
  }
}
```

`role: 'merge'` keeps the node addressable (its mesh is merged); `role: 'chunk'`
additionally gives it its own chunk mesh, which is what you need if you want to
MOVE or HIDE it. A claim whose path does not resolve is reported in the bake
removal report, never thrown — a plugin may serve several documents. The
authoring-side alternatives are equally valid and usually better: put a component
on the node, or author `rv.BakeRole` on it in the GLB.

#### `capabilities.onPreBake` — structural preparation before the bake

Some components need to change the tree, or read geometry, BEFORE it is merged:
the kinematic re-parenting, the drive HOME pose the mover chunks are baked
against, the sensor beam, a body's mass from its mesh. Those run as a **static**
hook on the component TYPE, over the throwaway `tmp` graph:

```typescript
registerComponent({
  type: 'MyComponent',
  capabilities: {
    bake: 'chunk',
    onPreBake: (node, extras, ctx) => {
      // extras and tree only — see the rule below
      const box = ctx.localBounds(node);
      if (box) extras._myBeamLength = box.max.z - box.min.z;
    },
  },
  // …
});
```

`PreBakeContext` is deliberately tiny: `root`, `resolvePath(path)`,
`localBounds(node)` (the ONE sanctioned geometry read), `keepMaterial(id, mat)`
and `notifyReparented(node, previousPath)` so a re-parented subtree keeps its
authored path resolvable as an alias.

> **Hard rule: extras and tree only.** No component instance, no signal store and
> no live registry exists when a hook runs. A hook may re-parent nodes and write
> plain-data numbers into `extras`; it must not resolve other components, read or
> write signals, or keep a reference to anything. Break it and the bake silently
> depends on an initialisation order again, which is the whole class of bug the
> pipeline removed. A lint test enforces that no hook imports a runtime instance
> API.

The matching rule for AFTER the bake: **no component reads source geometry at
init.** If you need geometry, declare `keep` or `chunk` and read your own mesh; if
you need a NUMBER derived from geometry, compute it in `onPreBake`. A component
type without a hook goes through the pipeline unchanged.

**Partition labels — your own hideable chunks (plan-755).** A hook may also stamp
`node.userData._rvPartition = ['MyLabel', …]` (`RV_PARTITION_KEY`,
`src/core/engine/rv-bake-chunk.ts`; plain strings only). The bake then splits
the geometry below that node off the enclosing chunk: a chunk is
**boundary × partition × material**, where the partition is the sorted set of
labels between a mesh and its chunk boundary, joined with `|`. Per boundary and
partition the scene gets ONE synthetic node named after the partition
(`<boundary>/<label>`, static geometry: `<root>/<label>`) that parents those
chunk meshes — set `.visible` on it and exactly that geometry hides, without
paying a chunk boundary per node. This is how `Group` works: its built-in hook
stamps the resolved group names, and the Groups panel hides and isolates the
resulting objects. The rules:

- Labels stop at a boundary and the boundary's OWN stamp does not partition (all
  of its meshes would share it) — hide the boundary node instead.
- Nested labels combine: a mesh under `A` and `B` lands in one object `A|B`. A
  chunk key is an identity; never split it on `|`.
- The synthetic node (`userData._rvSynthetic`) is rebuilt by every bake: address
  it at runtime, never persist a path, an override or a reference against it.
- The bake does not know what a label means. The extras a partition object
  carries come from ONE builder slot, `registerPartitionExtras()`, which the
  Group side owns — do not replace it from a plugin; find your object by path.
- Placements and the embed facade run the same recipe as the main model since
  plan-757 (history: until then they used to run no pre-bake hooks, so a
  planner-placed library asset had no partition objects). A placed asset is
  partitioned exactly like the document that opens the same file; only plugin
  `bakeClaims()` stay a main-model input (D5).

> **There is no `simulationActive` capability.** Earlier revisions of this table
> listed one; it never existed in `ComponentCapabilities` and nothing ever read
> it. A component that needs a per-frame tick gets a **dedicated viewer-owned
> manager** instead — see § Per-frame components below.

> **The old 12-field capabilities block is gone (plan-753 Phase 4b).** Until
> Phase 4 a declaration could still spell out `hoverable`, `selectable`,
> `hoverEnabledByDefault`, `exclusiveHoverGroup`, `badgeColor`, `filterLabel`,
> `tooltipType`, `hoverPriority`, `pinPriority`, `inspectorVisible`,
> `hierarchyVisible`; the adapter `normalizeCapabilities()` mapped it with a
> one-time warning. The registration entry points now take `ComponentCapabilities`
> only — a legacy field is a **type error**. External plugin bundles that still
> use the old shape must migrate with this table (release note):
>
> | old | new |
> |---|---|
> | `selectable: true` | `pick: 'select'` |
> | `hoverable: true, selectable: false` | `pick: 'select'` for info nodes; `pick: 'action'` for `PushButton3D`, `EmergencyButton3D`, `HandleSwitch3D`, `SceneButtonMoveable`, `WebSafetyDoor` |
> | `hoverable: false, selectable: false` | `pick: 'none'` (the default — may be omitted) |
> | `hoverEnabledByDefault`, `exclusiveHoverGroup` | **gone** — every pickable type hovers by default; the hover-mode toggle groups by `ui.filter` |
> | `badgeColor`, `filterLabel`, `tooltipType` | `ui.badge`, `ui.filter`, `ui.tooltip` |
> | `hoverPriority`, `pinPriority` | `ui.priority` (= the old `hoverPriority`; pinned bubbles use the same value) |
> | `inspectorVisible: false` | `ui.hidden: true` |
> | `hierarchyVisible` | **gone** — it never did anything (plan-431 §2.8: nothing read it; `ui.hidden` is the flag that removes a type from both surfaces) |
>
> `bake` had no legacy counterpart; a migrated declaration keeps the `merge`
> default until its author decides otherwise. The movers and runtime-mutated
> types that the old `MOVER_KEY` / `EXCLUDED_SUBTREE_KEYS` lists named carry
> their role explicitly.

> **Plugin-visible changes of plan-754 (release note).** The bake became
> destructive and the hierarchy became the scene graph. Five things an external
> plugin or private project can notice:
>
> | Change | What to do |
> |---|---|
> | **`registry.getNode(path)` returns `undefined` for any unclaimed node of a baked model** — the main model included, not only raw CAD parts under a placed catalog item. | Null-check it (you should already). If you need a bare node, declare `RVPlugin.bakeClaims()`, put a component on it, or author `rv.BakeRole` in the GLB — see *Surviving the bake*. |
> | **`ModeDescriptor.hierarchyScope: 'composition'` is gone**, with `projectComposition`, `buildCompositionTree` and `COMPOSITION_CHILD_TYPES`. | Remove the field from your mode registration — it is a type error. The one real tree plus the flat type filters replaces it. |
> | **`refreshEditableNodes()` is a deprecated no-op** for one release. | Delete the call. There is no scanned node list left to refresh. |
> | **The selection snapshot gained `nodes`.** Selection identity is the `Object3D` now; `selectedPaths` / `primaryPath` are derived and cover only what the registry addresses. `web_selection_get` mirrors this with a `nodes[]` field. | Keep reading paths if that is all you need; read `nodes` when a chunk mesh, a light or an overlay must also count as selected. |
> | **`BakedAsset.master` → `BakedAsset.template`**, and `ModelCache` keeps only that template after a bake. | Rename the field. If you needed the FULL source hierarchy, `ModelCache.decodeFresh(cacheKey)` is the one uncached door to it (the asset editor and `descend` use it); `getOrLoad*` never yields non-survivors after a bake. |

> **Plugin-visible changes of plan-755 (release note).** `Group` became a
> partition key of the chunk instead of a node that survives for its own sake.
>
> | Change | What to do |
> |---|---|
> | **Group-only nodes are no longer addressable in a baked model.** A node that carried only a `Group` (plus export markers) is removed, together with plain ancestors only it kept alive — about 12,600 paths on a CAD model grouped down to solids. `registry.getNode(path)` returns `undefined` for them. | Address the group's geometry through its partition object (`<boundary>/<key>`), claim the node with `RVPlugin.bakeClaims()`, put a real component on it, or work in the editor (it never bakes). |
> | **New capability `claimsNode`** (default `true`). The former implicit rule "hidden + `merge` = export marker" is gone; `Group` and seven marker types declare `false`. | Nothing, unless you registered a hidden, role-less marker type of your own and relied on its nodes being pruned: declare `claimsNode: false` explicitly. |
> | **Partition objects.** New synthetic nodes named after a group combination (`MC01.13`, `CNCCase\|CNCDoor`) appear under chunk boundaries, carry `Group` extras and `userData._rvSynthetic`, and parent chunk meshes. `BakedChunk` gained `partition`, `partitionLabels`, `groupObject`; chunk keys may contain a `grp:<key>` segment. | Do not assume a chunk mesh is a direct child of `chunk.owner` (use `chunk.groupObject ?? chunk.owner`), do not parse chunk keys, and skip `_rvSynthetic` nodes when you persist anything. A group's members now include these objects. |

### Units on fields and signal slots (plan-512)

Three rv-ODT keywords carry units into the `FieldDescriptor` (`loadSchemaFromSpec`
copies them; `inline-schemas-baseline.ts` pins them):

| Keyword | On | Meaning |
|---|---|---|
| `unit` | number fields | Unit of the value (UCUM-style: `mm`, `mm/s2`, `s`). The SSOT of the inspector suffix — `getFieldUnit()` reads the schema first and falls back to `FIELD_UNITS` only for fields without one (`field-unit-schema-ssot.test.ts` keeps both in step, alias-normalised). A `Vector3`'s `unit` is documentation only. |
| `signalUnit` | signal slots (`componentRef` + `signal`) | Unit of the slot's value on the COMPONENT side: a unit (`mm`) or a quantity token resolved through `Drive.Direction` of the carrying node — `@drive-position` (`mm`/`deg`), `@drive-speed` (`mm/s`/`deg/s`), `@drive-acceleration` (`mm/s2`/`deg/s2`). No drive (or `Virtual`) → no unit → no auto-scale. |
| `scaleField` | signal slots | The sibling NUMBER field of the same component that scales the slot. Binding a signal with a known unit writes `conversion(signal unit → signalUnit).factor` there. |

```json
"Position": {
  "$ref": "#/$defs/ComponentReference",
  "signal": "PLCOutputFloat",
  "signalUnit": "@drive-position",
  "scaleField": "Scale",
  "description": "..."
}
```

Rules when you declare them on a new behavior:

- **Both or neither.** `signalUnit` without `scaleField` does nothing.
- **One factor rule for both directions.** Your behavior must compute a command as
  `target = signal × S (+ offset)` and a feedback as `signal = (target − offset) / S` —
  then the same `S` is right for both. A formula of any other shape (a percentage
  normalisation like `Drive_ProfidriveSpeed.SetpointScale`, a dimensionless setpoint)
  must NOT be annotated.
- **Shared fields are allowed.** Several slots may name the same `scaleField`
  (`Drive_Simple.Speed`/`Accelaration`/`IsAtSpeed` → `ScaleSpeed`); the first binding
  sets it, a later one with another factor reports `unit-scale-conflict` instead of
  overwriting.
- **Feedback formulas that can switch the scaling off** (like `ScaleFeedbackPosition`)
  need a gate in `FEEDBACK_GATES` (`plugins/signal-bind/unit-scale.ts`), or the badge
  would claim `auto` for a factor nobody applies.
- **A scale field has no `unit`** — it is a pure factor.
- The annotated set is pinned positively AND negatively by
  `tests/field-unit-schema-ssot.test.ts`; adding a slot means adding its row there.

A source declares its unit through `SignalMeta.unit` (+ an optional resolved
`unitDef`, which wins over the built-in table): `store.setSignalMeta(name, { unit: 'm' })`.
Nothing converts the VALUE — the unit only feeds the factor of a binding.

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
  pick: 'none',          // data, not an interactive object — no tooltip, no HMI surface
  ui: { badge: '#8d6e63' },
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

#### JSON fields in the inspector: `RvJsonEditor` (plan-555)

A field that holds JSON (today `WebOperatorPanel.Config`) gets a Monaco JSON editor
instead of a text area — the same editor core as the script and ST editors, loaded
lazily. The parts are field-neutral and live in `src/core/hmi/json-editor/`:

- `RvJsonEditor.tsx` — inline editor (4–15 lines, auto height) plus an **Expand editor**
  window on the same model. Applies on blur / Ctrl+Enter / closing the window / unmount
  through your `onCommit(text, target)`, against the edit target captured at mount; a
  write that has not come back through `value` yet is deduplicated. External value
  changes update a clean model as one undo step; a dirty model keeps the text and shows
  a conflict hint (Ctrl+Enter overwrites, Escape reloads). Text that was not applied is
  kept as a draft per model URI and restored on the next mount. Render it with
  `key={docId + '|' + nodePath}`.
- `rv-json-field-context.ts` — `JsonFieldContext` per model URI
  (`rv-json://<componenttype>.<fieldname>/<docId>/<nodePath>.json`, built by
  `jsonFieldUri`): `schemaId` + `schema` (completion / hover only), `signalKeys` +
  `signals()` (read fresh per request), `snippets` (per `arrayKey`) and `validate(text)`
  (your rules → markers, owner `rv-json-rules`).
- `rv-json-monaco-loader.ts` — `loadJsonMonaco()`: JSON worker, `schemaValidation:
  'ignore'`, ONE completion + ONE hover provider for `json` that look the context up by
  URI. The only module besides the script loader that may import `monaco-editor`
  (`tests/plc-import-boundary.node.test.ts`).
- `rv-json-path-ranges.ts` — JSON path ↔ text range (`jsonc-parser`).
- `src/core/hmi/monaco/rv-monaco-workers.ts` — `registerMonacoWorker(labels, factory)`:
  the one `MonacoEnvironment.getWorker` of the page, first registration per label wins,
  `'*'` is the generic fallback. Every Monaco loader (public and private) registers here
  instead of writing `self.MonacoEnvironment`.

Your field renderer must import the editor only through `React.lazy` (the renderer
module is in the entry chunk — see `WebOperatorPanelHost.tsx` →
`operator-devices/operator-panel-json-context.ts`), keep a plain text field for touch
devices and as the Suspense / error fallback, and honour the dev flag
`rv-webviewer-json-editor` (`isJsonEditorEnabled()` in `rv-dev-load-flags.ts`).

#### Rendering Markdown in a renderer: use `LazyMarkdown`

`react-markdown` and `remark-gfm` must never be imported statically — a static
import pulls both into the main chunk and undoes the code split. `LazyMarkdown`
(`core/hmi/rv-markdown-lazy.tsx`) is the one entry point:

```typescript
import { LazyMarkdown } from '../rv-markdown-lazy';

<LazyMarkdown
  text={note}
  components={MD_COMPONENTS}          // optional react-markdown overrides
  fallback={<RawNote text={note} />}  // shown while loading AND on failure
  errorBoundary                       // catch a REJECTED chunk (offline, purged CDN)
/>
```

`Suspense` handles a pending chunk and nothing else; a rejected dynamic import
throws, and without `errorBoundary` that throw takes your surrounding subtree
down with it. Never add `rehype-raw` — it turns note text back into executable
HTML, and `react-markdown` refusing raw HTML by default is the whole security
story of the field renderer.

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

### Inspector UI for your own components (building blocks)

A custom field renderer, an extra section or a component action draws with the
same four blocks the built-in sections use, so its values sit on the same
column as every other row:

- `InspectorRow` (`core/hmi/rv-inspector-row.tsx`) — one label → value row;
  `dot` holds an override marker (click = reset), `trailing` an icon button,
  `labelTitle` the tooltip. A message is an `InspectorRow` with an empty label.
- `InspectorSubheader` (`core/hmi/rv-inspector-blocks.tsx`) — a group heading
  inside your section.
- `InspectorActionRow` — wraps your buttons so they start on the value column
  (`inspectorActionButtonSx` styles a new one). Component actions registered
  through `componentActionRegistry` are wrapped for you.
- `DetailsDisclosure` — collapsed technical details (hashes, GUIDs, versions)
  with a one-line summary.

Colours, font sizes and the monospace stack come from `core/hmi/shared-sx.ts`
(`INK_*`, `FS.*`, `ICON_SIZE.*`, `MONO`, `ACCENT` …); numbers are parsed and
shown with `parseDecimal` / `formatDecimal` (`core/hmi/rv-number-format.ts`,
comma and dot both accepted). UI text is English.

```tsx
import { InspectorRow } from '../../core/hmi/rv-inspector-row';
import { InspectorSubheader, DetailsDisclosure } from '../../core/hmi/rv-inspector-blocks';
import { formatDecimal } from '../../core/hmi/rv-number-format';
import { FS, INK_LOW, MONO } from '../../core/hmi/shared-sx';

export function PumpStatusRenderer({ value }: FieldRendererProps) {
  const s = value as { rpm: number; serial: string };
  return (
    <>
      <InspectorSubheader>Runtime</InspectorSubheader>
      <InspectorRow label="Speed" labelColor={INK_LOW}>
        <Typography sx={{ fontSize: FS.label, fontFamily: MONO }}>{formatDecimal(s.rpm, 1)} rpm</Typography>
      </InspectorRow>
      <DetailsDisclosure title="Device details" summary={s.serial}>
        <InspectorRow label="Serial" labelColor={INK_LOW}>…</InspectorRow>
      </DetailsDisclosure>
    </>
  );
}
```

#### Where a component action appears (`placement`, `danger`, `group`)

An action registered with `componentActionRegistry.register(type, [...])` is
drawn by the section according to three optional fields of `ComponentAction`:

- `placement: 'body'` (default) — a button in the section's action row, for
  machine **operations** (Jog, Stop, Toggle, Auto-assign).
- `placement: 'menu'` — an item of the section header's ⋮ menu
  (`InspectorSectionMenu`), for **component management** (Replace…,
  Re-import…, Remove). Such an action never appears as a body button.
- `danger: true` — a destructive menu item: sorted last, behind a divider, in
  the theme's error red. There is no confirmation dialog; in the editor the
  removal is undone with Undo. A `danger` action belongs in the menu.
- `group: '<name>'` — consecutive body actions with the same group render as
  ONE segmented control (`Jog − | Stop | Jog +`, `inspectorSegmentedGroupSx`);
  a group is a set of commands, not a selection toggle.

```ts
componentActionRegistry.register('Pump', [
  { id: 'jog-back', label: 'Jog −', group: 'jog', onClick: (ctx) => jog(ctx, -1) },
  { id: 'stop',     label: 'Stop',  group: 'jog', onClick: (ctx) => stop(ctx) },
  { id: 'jog-fwd',  label: 'Jog +', group: 'jog', onClick: (ctx) => jog(ctx, +1) },
  { id: 'replace',  label: 'Replace…', placement: 'menu', onClick: (ctx) => replace(ctx) },
  { id: 'remove',   label: 'Remove', placement: 'menu', danger: true, onClick: (ctx) => remove(ctx) },
]);
```

`tests/browser/inspector-action-layout.browser.test.tsx` holds the layout
guardrail (a segment group stays on one line at a 320 px inspector) and checks
that no menu / danger action is a body button.

The inspector files are linted for this (`rv/hmi-design` in `eslint.config.js`,
gated by `tests/hmi-design-lint.node.test.ts` in `npm run test:all`); the full
rules are in `DESIGN.md` (repository root), and `?rvDev=inspector-gallery` on the
dev server shows every block in every state.

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

`RibbonManager` (`rv-ribbon-manager.ts`, plan-459/460) is the same pattern with one
thing added, and it is worth reading when your components are not independent of
each other. Web paths that share a roller are ONE machine: a slitter's strips run
off one parent roll, so integrating that roll once per path would consume it N
times over, and letting each path decide on its own whether to stop would leave
its siblings running off a roll that is no longer there.

So the manager groups its components (union-find over "shares a roller", rebuilt
on register/unregister) and ticks a GROUP rather than a component:

1. sample every roller's drive ONCE, so a roller shared by three strips is read
   once and all three see the same number;
2. read each path's SECTION speeds from its driven rollers;
3. clamp — a winder that is empty or full zeroes every section of the whole group
   in the same tick, a dancer at a stop clamps directionally;
4. integrate each dancer and each winder exactly once, through its owner (the path
   with the smallest node path — a tie-break that does not depend on registration
   order);
5. pose every member with its own section speeds.

It is also where the alternative to a drive behaviour is on show. A web reads its
drives directly — `(drive.currentPosition − last) / dt` on every driven roller —
rather than through an `IDriveBehavior`, because the manager already ticks in
`CoreSubsystems.visuals()` AFTER `drives()` and therefore sees the drive values of
the same tick. The behaviour contract would have bought nothing the tick order
does not already give — and would have cost an entry in `DRIVE_BEHAVIOR_MAP` and a
sort rule in `DriveOrderPlugin`.

The reverse lesson is in the same file: plan-460 REMOVED the "every path of a
group must name the same drive" rule together with the `ConnectedDrive` field. Once
each section reads its own driven roller there is no single group speed left to
disagree about, and two rewinders pulling at different rates stopped being a
modelling error and became the thing dancers exist for. When a consistency check
is the only thing holding a design together, the design is usually the problem.

**Querying capabilities:**

```typescript
import { getCapabilities, getPickableTypes, getTypesWhere, bakeRoleOf } from './rv-component-registry';

// Get resolved capabilities for a type (always returns ResolvedCapabilities — every field present)
const caps = getCapabilities('Drive');  // { pick: 'select', bake: 'chunk', ui: { badge: '#4fc3f7', ... }, authorable: true }

// Get all types the pointer can interact with
const pickable = getPickableTypes();  // ['Drive', 'Sensor', 'MU', ...]

// Any predicate over the resolved form
const hoverGroup = getTypesWhere((c) => c.pick !== 'none' && c.ui.filter !== null);

// Per node: the bake role across its components (undefined = no registered component)
const role = bakeRoleOf(node);  // 'merge' | 'chunk' | 'keep' | undefined
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

### Text in the scene: the label contract, the Plate exemption and label clicks (plan-529)

**Canvas text goes through `rv-label-sprite.ts`.** Every text sprite (`createLabelSprite`, `replaceLabelTexture`) sits on an overlay layer, is not tone-mapped and neither tests nor writes depth — otherwise GTAO, bloom and tone mapping smear it. `labelContractViolations()` walks a scene and reports every canvas-textured **Sprite** that breaks this; `tests/label-sprite-contract.test.ts` runs it over every producer. A `WebLabel` Billboard is built through this factory and passes it.

**The one sanctioned exception is a `WebLabel` Plate** (`rv-label-plate.ts`): a sign ON the machine must be hidden by geometry in front of it, so it is a depth-tested, depth-writing `Mesh` on layer 0, flagged `userData._rvLabelPlate`. The contract checks sprites only, which keeps the exemption narrow; the contract test pins both halves (a Plate is not reported, a Billboard still passes). The texture still comes from `createLabelTexture()` (sRGB, anisotropy, mipmaps); the material colour scales the texture below the default bloom threshold and the plate stands 2 mm off the node plane against AO darkening. Do not copy this for other text — if your text must be occluded, reuse `rv-label-plate.ts`.

**Runtime visuals are never saved.** Anything a component builds from its extras at load (label sprite, plate, rigs, clones) must carry a marker that `pruneRuntimeHelpers()` in `rv-asset-glb-export.ts` removes before export — for WebLabel that is `userData._rvWebLabel`. Otherwise the editor's save writes the visual into the file and the next load builds a second one next to it; `tests/rv-web-label-export.test.ts` checks save → reload → save does not grow.

**Label clicks do not use the component ACTION pick.** Capabilities are frozen per type; `WebLabel` is statically `pick:'select'` (since 2026-10-12 — a label names an object, so the labelled node is a hover / selection target and a pick owner of its merged geometry in the bake; before that it was `'none'` and a label-only node such as a cabinet was an owner-less, blocking chunk segment at runtime) and never `'action'`. The label VISUALS are aux raycast targets of their node (`WebLabelHost.pick`, Billboards `onTop`), so hovering a label hovers the object and a click selects AND frames it; the hover / selection state draws a border on the label and a pin line down to the object (`WebLabelHost.emphasis`). Link clicks stay separate: the viewer-owned `WebLabelManager` (`ctx.webLabelManager`, threaded through `InitSubsystems` like every manager) is asked FIRST inside the canvas `pointerup` handler, after the click-vs-drag threshold and after the transform gizmo / marquee had their chance to stop the event. It raycasts only its own effectively visible, linked labels; a Billboard hit wins, a Plate hit only when `RaycastManager.raycastSurface()` (a stateless query) reports no opaque surface closer. The URL is checked with `isSafeExternalUrl()` (absolute `http`/`https` only) and opened synchronously with `openExternal()` (`noopener,noreferrer`). Hover over a linked label sets the pointer cursor with priority over the raycast manager (`RaycastManager.cursorOverride`). The manager's per-frame pass (`tick()`) runs in the **render path**, not in `CoreSubsystems.visuals()`, because the latter stops with the simulation. XR taps are not routed to labels (documented limitation).

### Plugin LogicStep types (`rv-logic-step-registry.ts`)

`RVLogicEngine` builds the built-in `LogicStep_*` types in a `switch`. A step
whose runtime lives in a plugin — above all a PRIVATE one, which the public
engine must never import — registers a builder instead:

```typescript
import { registerLogicStepBuilder } from '../core/engine/rv-logic-step-registry';

const off = registerLogicStepBuilder('LogicStep_MechanismPath', (ctx) => {
  // ctx: data (the step's rv_extras), node, stepType, registry, signalStore, scope
  const ref = ctx.data['MechanismPath'] as ComponentRef | undefined;
  const path = ctx.registry.resolve(ref, ctx.scope).component;
  return new MyStep(path);  // an RVLogicStep, or null for "no step"
});
```

The `default:` branch of `buildStep()` asks the registry before it warns, so an
unregistered type keeps the old behaviour (`console.warn`, no step). A second
registration replaces the first; the returned function removes exactly its own
builder. Add the type to the `CONSUMED` map in `rv-extras-validator.ts` and give
it an rv-ODT `$def` + `logicSteps` index entry like any other step.

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
  wheelZoomToCursor: true,    // mouse wheel zooms to the cursor (default; false = to the view centre)
  navigateAroundCursorPoint: false, // orbit / pan about controls.target (default; true = about the surface point under the cursor)
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

### The hierarchy is the scene graph — and `getNode()` may return undefined

Since plan-754 the Hierarchy Panel renders `viewer.scene` directly: a row IS an
`Object3D` and `children` is the whole tree. There is no projection and no lazy
injection any more (`buildStructureTree`, `applyLazyInjection`, the synthetic
`Geometry` type and the composition view are deleted), so expanding a row has
**no NodeRegistry side effect** — expanding is UI state, and UI state must not
change the set of addressable paths. Registration belongs to the two places that
actually put geometry into the scene: the loader and `registerPlaced`.

What this means for a plugin:

- The set of registered paths no longer grows because a user opened a row. It still changes on model load, placement and structural edits, so `NodeRegistry` remains an open set — keep listeners idempotent and address nodes by path (`getNode(path)`), never by integer index.
- **A node can be browsable without being resolvable.** `registry.getNode(path)`
  returns `undefined` for **any unclaimed node of a baked model — the main model
  included**, not just for raw CAD parts under a placed catalog item. After the
  destructive bake an unclaimed node is gone entirely, and the rows that remain
  without a path are the runtime objects (lights, gizmos, overlays) and the chunk
  meshes. Code that reacts to a hierarchy selection must tolerate that, exactly as
  it must tolerate a stale path. If you NEED a bare node to stay resolvable, claim
  it — see *Surviving the bake* above.
- **`hierarchyScope` is gone.** A `ModeDescriptor` used to declare
  `hierarchyScope: 'composition'` so the planner saw each placed asset as one row.
  There is one tree now, the real one, with flat type filters and the
  `runtime` / `chunk` badges on top; `projectComposition` / `buildCompositionTree`
  and `COMPOSITION_CHILD_TYPES` no longer exist. Remove the field from any mode
  registration — it is a type error.
- **`refreshEditableNodes()` is a deprecated no-op** for one release. The panel has
  no scanned node list left to refresh, so there is nothing to invalidate; the
  method survives only so an existing external caller does not throw. Delete your
  call.

### Placements pick through their chunks

There is no separate pick geometry for placements (the plan-745 placement
raycast bundles and the merged static / per-drive groups went with plan-753
Phase 4b). A placement is a `BakedAsset` instance of the viewer's
`BakeRegistry`; its chunk meshes ARE its render geometry and its pick
geometry, and the `PickBackend` (installed once per load by the viewer) resolves a
hit triangle through the chunk's segment table to that segment's owner node. A
placement appears on `instantiate` and disappears on `release`; nothing
scene-wide is rebuilt.

What a plugin author needs to know:

- **Iterate pick meshes through `viewer.bakeRegistry.pickMeshes`** (chunk +
  keep meshes of every live instance — the main model and every placement),
  never by walking the scene for `__raycastBVH` meshes: those do
  not exist any more.
- **Never `dispose()` a chunk geometry.** It is shared by every instance of the
  asset; `disposeSubtree` / `disposeModelSubtree` skip geometries registered
  in `chunkMetaOf`, and the `BakedAsset` frees them at refcount 0 once retired.
- **Highlights on baked roots** go through `chunk-outline` / `chunk-overlay`
  (pooled wrapper proxies with their own `drawRange` over the chunk geometry —
  never `drawRange` on the chunk itself). Keep meshes and plain nodes without
  a window use the ordinary overlay pairs.
- **Virtual / DES entries** (`buildVirtualNode`) are the one non-baked kind of
  placement: their meshes register as aux raycast targets resolving to the
  placement root — add on register, remove on delete.

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

### `model-loaded` is not "the scene is complete" — `whenSceneReady()`

`onModelLoaded` / `model-loaded` mean: the document's **own** GLB is parsed, registered and
announced. For a **layout document** the placed references are *not* in the scene yet — the core
materialises them asynchronously afterwards (`viewer.placements`, one bake per asset, smaller
assets first), which takes seconds on a real layout. Until then those placements are missing from
the scene graph, the `NodeRegistry`, the `SignalStore`, snap pairing, bounds and the transport
topology. The contract (`src/core/engine/rv-scene-ready.ts`):

| Name | Meaning |
|---|---|
| `viewer.placements.state` | `'idle' \| 'materializing'`; counters in `viewer.placements.progress` (`total`, `materialized`, `pending`, `missing`). |
| event `placements-materialized` | **exactly once per load**, payload `{ aborted, total, materialized, missing }` — right after `model-loaded` for a document without references, else when the last reference is instantiated (or failed into its placeholder); `aborted: true` when the document changed first. |
| event `placements-state-changed` | `{ state }` on every flip (busy indication). |
| `viewer.whenSceneReady(): Promise<void>` | **the join point**: no load in flight AND placements idle. Follows a document change (resolves for the new document); never rejects. |

Rules of thumb for a plugin:

- Work that is correct **per placement** follows `layout-content-added` (`{ root, chunks?, keep? }`)
  and needs nothing else — that is how the clip tools, AAS resolution, the planner's snap pairing
  and the transport topology stay correct. Since plan-757 Phase 2 the event also fires for every
  **nested** placement root — a reference inside a placed asset, materialised by the core instancer
  (`isNestedPlacementRoot(root)`, `_layoutNestedOf`): it is CONTENT of its record's placement, not
  a record (the planner refreshes the hierarchy and the snap pairing for it, nothing else), and it
  is released with its parent, innermost first, each with its own `layout-content-removed`. Its counterpart is `layout-content-removed`
  (`{ root, path }`, emitted by the planner's remove path BEFORE the subtree leaves the scene):
  undo whatever you attached to that root. The `WebComponentPlugin` does exactly this pair
  (plan-757 §2.8): a placement's `WebComponent` scripts are wired on `layout-content-added` under
  the same session-wide `allowScripts` rule as the main model's, and disposed on
  `layout-content-removed` — a placement is the main model at another origin.
- Work that snapshots or judges the **whole** scene in `onModelLoaded` (lists of drives / sensors,
  "does this path resolve", framing, statistics) re-runs on `placements-materialized` or awaits
  `viewer.whenSceneReady()`. The core already does this for: the simulation (held with the pause
  reason `placements-materializing` while the scene is incomplete), one batched `drives-changed`
  (drive order, recorder, `useDrives`), the DES re-bind, the ground disc and the camera re-fit
  (only when nobody moved the camera since the load framed it).
- **Never** hand `viewer.whenSceneReady()` to `viewer.trackLoadingWork()` from `onModelLoaded`:
  `loadModel` drains that queue before it returns, and the join point waits for `loadModel` — a
  deadlock. Use `void viewer.whenSceneReady().then(...)` and re-check that your `LoadResult` is
  still `viewer.lastLoadResult`.

```typescript
onModelLoaded(result: LoadResult, viewer: RVViewer): void {
  this.rebuild(viewer);                       // the document's own content
  void viewer.whenSceneReady().then(() => {
    if (viewer.lastLoadResult === result) this.rebuild(viewer);   // + every placed reference
  });
}
```

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
  'model-loaded':       { result: LoadResult };   // scene may still be incomplete → whenSceneReady()
  'placements-materialized': { aborted: boolean; total: number; materialized: number; missing: number }; // once per load
  'placements-state-changed': { state: 'idle' | 'materializing' };
  'layout-content-added':   { root: Object3D; chunks?: Mesh[]; keep?: Mesh[] };  // one placement is live
  'layout-content-removed': { root: Object3D; path: string | null };            // …and is leaving (planner remove)
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

## 5b. Commands — Buttons, Menus, Shortcuts and MCP Tools as Views

A **command** is the ONE definition of a user action (plan-499): label, the rule that says whether
it can run *and why not*, the execution, the undo label and the MCP mirror. Buttons, context-menu
items, keyboard shortcuts and the bodies of MCP write tools are **views** of the command — none of
them carries its own copy of the rule. That is what makes "the tooltip of a disabled button" and
"the `{error}` an agent receives" the same string by construction, and what lets the viewer show
which button the AI just used.

### The registry

`src/core/hmi/rv-command-registry.ts` holds `commandRegistry` (open, eager):

```typescript
commandRegistry.register({
  id: 'sim.reset', label: 'Reset simulation', readOnly: false, shortcut: 'Shift+R',
  scope: 'none',                 // 'editor' = needs the active asset document (guard texts reused)
  available: true, unavailableReason: 'Not available',
  argsSchema: {},                // COMMAND args (name → 'string' | 'number' | 'boolean' | 'string[]')
  buttonKey: () => 'sim.reset',  // the button the afterglow / choreography targets
  mcp: { tool: 'web_sim_reset', params: [] },   // 1:1 mirror, checked by the parity gate
  eagerImpl: resetImpl,          // open impls in memory: enabled() is synchronous from the start
  impl: () => Promise.resolve(resetImpl),       // lazy impls: `import('@rv-private/...')`
});
```

An implementation is `{ visible?(ctx), enabled(ctx, args), run(ctx, args) }`. `enabled()` returns
`true` or `{ reason, details? }` and is formulated on the **args** (not on the selection) —
views pass the selection as args. `run()` returns the value the tool body serialises; a failure
after `enabled()` said yes is thrown as `CommandError(message, details)`.

Every trigger goes through ONE dispatcher, never `run()` directly:

```typescript
const r = await commandRegistry.execute('layout.remove', { id: null }, { origin: 'ui', viewer });
// r = { ok: true, value } | { ok: false, kind: 'disabled' | 'unavailable' | 'invisible' | 'stale' | 'threw' | 'unknown', reason, details? }
```

Order: unknown → `available` (community stub first, before any mode guard) → context + guard →
lazy impl → identity recheck → `visible` → `enabled` → identity recheck → `run` → `onExecuted`.
A cached implementation runs synchronously up to its own first `await`, so a key press or click
has its effect in the same tick. `ctx.origin` ('ui' | 'mcp' | 'shortcut') exists for attribution
only (a signal written by the bridge is booked as `mcp`); a rule never depends on it.

UI-local gates that are not rules of the action (`busy`, a running test session, "select a single
object") stay on the view as `disabled` and are OR-ed with the command's answer.

**Where commands live:** editor commands — open descriptors in `editor-command-descriptors.ts`,
private implementations in `@rv-private/plugins/asset-editor/editor-commands` (community stub:
`impls = {}` → `ERR_EDITOR_UNAVAILABLE`); planner — `plugins/layout-planner/planner-commands.ts`;
sim / drives / signals — `plugins/sim-controller/sim-commands.ts`; rigid-body mechanisms (plan-504)
— open descriptors in `mechanism-command-descriptors.ts`, private implementations in
`@rv-private/plugins/asset-editor/mechanism/mechanism-commands` (same stub rule). Each exposes an
idempotent `ensure…CommandsRegistered(registry?)`; the owning plugin calls it in its constructor, the
MCP bridge before every call (the editor and mechanism descriptors additionally register when the
MCP tool module loads, so a first call never meets "Unknown command").

### Views

| View | How it binds |
|------|--------------|
| `ActionSegment` (open, `core/hmi/action-group.tsx`) | `command={{ id, args?, buttonKey?, viewer?, invoke? }}` instead of `onClick` — the TypeScript union forbids both |
| `ActionButton` (private Quick Edit primitive) | same `command=` prop; `label` overrides the command label |
| any other button (`IconButton`, a card) | `const view = useCommandView({ id, args, viewer })` → `view.onClick`, `view.disabled`, `view.reason`, `view.dataAttrs` (spread them: `data-rv-command-id` / `data-rv-button-id`), `view.simPhase`, `view.touch` + `aiTouchSx(view.aiTouch, getAiTouchMs())` |
| context-menu item | `ContextMenuItem.command = { id, args: (target) => …, buttonKey? }`; `ContextMenuLayer` dispatches with origin `ui` (mouse) or `shortcut` (menu chord); the item keeps its local one-letter `shortcut` and its own label |
| inspector action | `ComponentAction.command = { id, args: (ctx) => …, buttonKey? }`; `rv-component-section` renders it through the command. Keep an `onClick` that dispatches the SAME command for programmatic callers |
| keyboard | the handler keeps its guards (editable target, modifiers, test-run lock) and then calls `execute(id, args, { origin: 'shortcut' })` |
| interactive view | `CommandRef.invoke` — a click opens a picker / menu / placement mode; the dispatch happens when it completes (the speed menu, a library entry, "Pivot to Object", Anchor A/B, "Assign Drive") |
| control view | a control that is not a button — a select, a slider, a small form — dispatches `execute(id, args, { origin: 'ui', buttonKey })` itself with its new value. `useCommandView` still gives it the rule (`disabled`, `reason`) and the afterglow (`aiTouch`); it carries **no** `data-rv-button-id`, so an MCP call gets no simulated hover/press on it, only the afterglow |

Button keys: a command with several buttons (Rotate X/Y/Z, one library entry per catalog id, one
Jog button per drive) derives its `buttonKey(args)`; view and tool binding compute the same key.
With several ROWS of the same kind mounted, the key names the row (`mech.pin-mass:<path>`,
`mech.axis:<jointPath>#<componentType>`), so only the addressed row glows. When the button
disappears on success (Add Body, Fix), the key names the surrounding row container instead
(`mech.body-row:<path>`, `mech.finding-row:<jointPath>#<code>`) — the
container renders the afterglow (`useAiTouch`) under its own attribute, never `data-rv-button-id`,
because the click choreography would find an ancestor with that id before the button inside it.

**Example — the Mechanism section (plan-504).** Readiness is not execution: the Anchor A button is
an interactive view of `mechanism.setAnchorSnap`, whose `enabled()` only checks the joint (so the
button is clickable before anything is picked); the click arms the viewport pick, and the pick's
completion dispatches the command with the picked point:

```tsx
<ActionButton
  label="Anchor A"
  command={{
    id: 'mechanism.setAnchorSnap',
    args: () => ({ path: joint.nodePath, componentType, side: 'A' }),   // readiness
    invoke: () => startMechanismPick(viewer, 'anchor', 'Pick anchor A', (pick) => {
      void commandRegistry.execute('mechanism.setAnchorSnap',              // execution
        { path: joint.nodePath, componentType, side: 'A', pickJson: pickResultToJson(pick) },
        { origin: 'ui', viewer });
    }),
  }}
/>
```

`run()` demands exactly ONE source (`candidateId` from `web_editor_mechanism_snap_list` XOR
`pickJson`) and throws a `CommandError` before any write otherwise; cancelling the pick dispatches
nothing. The density select and the jog slider of the same section are control views, the limits
form commits through its "Apply" button (one undo step per Apply, never per keystroke).

### MCP tool bindings

A write tool declares the command it is a view of in its decorator — metadata only, the wire schema
is unchanged:

```typescript
@McpTool('Reset the simulation: …', { readOnly: false, command: 'sim.reset' })
async webSimReset(ctx?: McpCallContext): Promise<string> {
  return this._json(await this._dispatch(ctx, 'webSimReset', {}), (v) => ({ ok: true, ...v }));
}
```

- **1:1** — `command: 'id'`: the wire args ARE the command args (`argsSchema` must equal the wire
  shape, `mcp` mirrors the `@McpParam`s).
- **Multiplexer** — `command: { branches, normalize? }`: a **branch table** (`when` wire values →
  `id`, `args(wire)`, `requires`, `buttonKey`), e.g. `web_editor_pivot` per `mode`,
  `web_editor_shortcut` per key chord. No free resolver function — the gate checks every branch.

The bridge resolves the binding ONCE per call, before any wait (`buildCallContext`: command, args,
button key, document handle, selection), runs the **preflight** (`preload` + `enabled()`; a refusal
gets no hover/press choreography and no afterglow), then calls the body with the context as its
trailing argument. The body's only job is `dispatchBoundCommand(ctx)` plus serialisation — never a
second resolution. On success the bridge's `onExecuted` listener starts the **afterglow** on the
target button (`button-sim-state.ts`: ~3 s, accent colour + "AI" marker, `aria-description="Triggered
by AI"`, colour/opacity only — no transform, so `prefers-reduced-motion` needs nothing extra) and the
AI status pill shows the command label.

### The parity rule

Every MCP write tool (`readOnly: false`) is **either** bound to a command **or** listed in
`NO_UI_WRITE_TOOLS` (`tests/rv-command-mcp-parity.node.test.ts`) with a specific reason — "there is
no button to be a view of" or "the UI counterpart is not a one-click action with an enablement rule"
(viewport gestures, the agent camera, settings toggles, document/dialog flows, form fields, agent
routines). "Not yet migrated" is not a reason. Two tests enforce it:

- `rv-command-mcp-parity.node.test.ts` (metadata gate): every write tool bound or allow-listed;
  1:1 mirror and annotations match; every multiplexer branch exists, maps to the hand-kept
  expectation table and produces exactly the command's args shape; the counts are pinned
  (96 write tools: 45 bound, 51 allow-listed — plan-504 bound the eleven Mechanism section tools;
  `web_editor_mechanism_set_anchor` stays a millimetre field input; the five plan-729 path tools and
  the two plan-501 trajectory writes are allow-listed with their reasons).
- `rv-command-bindings-execution.test.ts` (execution gate): every bound tool dispatches exactly ONE
  `execute` with the expected id/args (`EXPECTED_DISPATCH`), serialises the pre-migration result
  shape, and answers a refusal as `{error: reason, ...details}`.

Adding a write tool therefore means: bind it (`command:` + an `EXPECTED_DISPATCH` row) or add it
to the allow-list with its reason — and bump the counts.

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

### Step 1: Declare `ui.tooltip` on the component capability

When registering the component (in [rv-component-registry.ts](src/core/engine/rv-component-registry.ts) via `registerComponent({ type: 'Sensor', ... })`), set `capabilities.ui.tooltip` to a stable string key:

```typescript
registerComponent({
  type: 'Sensor',
  schema: RVSensor.schema,
  capabilities: { pick: 'select', ui: { tooltip: 'sensor' } },
  create: (node) => new RVSensor(node),
});
```

For types that have no factory (e.g. AAS links), use `registerCapabilities('AASLink', { pick: 'select', ui: { tooltip: 'aas', ... } })` instead.

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

That's it. No controller code, no event subscriptions — `GenericTooltipController` (already mounted in `App.tsx`) reads `node.userData.realvirtual` keys on hover and selection, looks up `getCapabilities(key).ui.tooltip`, and calls your data resolver.

**Bonus — generic PDF links**: any node with `node.userData._rvPdfLinks` automatically gets a PDF section appended at the bottom of its tooltip via `PdfTooltipSection`. No registration needed.

**Positioning modes:** `cursor` (follows mouse), `world` (3D→screen projection), `fixed` (screen position).

**Priority:** When multiple tooltip sections show at once, the **higher** `priority` number is the primary section (`tooltipStore` sorts descending; default `5` via `caps.ui.priority`, used for hover AND pinned bubbles).

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

## 8c. A Control Window in a Project Plugin

A `ControlWindow` is the operator counterpart of the chart overlays above: the same chrome
(drag by the title bar, glass surface, remembered position), minus the one thing an operator
panel must not have — a way to close it. It collapses to its title bar instead, and remembers
that across reloads. There is no close button and Escape does nothing.

It lives in `src/core/hmi/ControlWindow.tsx` and carries three controls, deliberately few and
deliberately distinct (ISA-101: a latching selector and a momentary button must not look alike):

| Control | Semantics |
|---------|-----------|
| `LatchGroup` | one of N, latched, the active one lit. `value = null` is a real state: the model matches no option. |
| `MomentaryButton` | press-and-hold. `onPress` down, `onRelease` up. Omit `onRelease` for a one-shot action. |
| `ControlSlider` | a continuous value, live in its own label, `onChange` live and `onCommit` at the end of the drag. |

### Where the window is defined

In the project's own plugin module — `projects/<name>/plugins/index.ts`, the only entry the
discovery glob loads — bound to a document by `documents[].scriptRef` in `project.json`:

```jsonc
// projects/Development/project.json
{ "path": "models/DemoRibbonTension.glb", "name": "DemoRibbonTension",
  "scriptRef": "plugins/index.ts" }
```

```ts
// projects/Development/plugins/index.ts
import type { RVViewer } from '@rv/core/rv-viewer';
import { RibbonTensionControlsPlugin } from './ribbon-tension-controls-plugin';

let registered: string[] = [];

export function registerModelPlugins(viewer: RVViewer): void {
  const plugin = new RibbonTensionControlsPlugin();
  viewer.use(plugin);
  registered.push(plugin.id);
}

export function unregisterModelPlugins(viewer: RVViewer): void {
  for (const id of registered) viewer.removePlugin(id);
  registered = [];
}
```

Every project uses that same `scriptRef`, so the resolver narrows by the OPEN project
(`ModelPluginManager`, `projectFolderProvider`). Nothing to configure — but it does mean the
project has to be open: a bare `?model=` URL loads the GLB without any project code. The e2e
route is `?projectUrl=<deploy root>`.

### The window itself

```tsx
export const RibbonTensionControls = ({ plugin }: { plugin: RibbonTensionControlsPlugin }) => {
  const snap = useSyncExternalStore(plugin.subscribe, plugin.getSnapshot);
  return (
    <ControlWindow title="Ribbon Tension" panelId="ribbon-tension-controls">
      <ControlGroup label="Situation">
        <LatchGroup ariaLabel="Situation" value={snap.latch} disabled={!snap.ready}
          options={[{ id: 'slack', label: 'Slack' }, { id: 'normal', label: 'Normal' }]}
          onChange={(id) => plugin.applyLatch(id)} />
      </ControlGroup>
      <ControlSlider label="Nip 2" unit="mm/s" min={700} max={900} value={snap.nip2MmPerS}
        disabled={!snap.ready} onChange={(v) => plugin.setNip2(v)} />
      <MomentaryButton label="Load x2" disabled={!snap.ready}
        onPress={() => plugin.holdDouble(true)} onRelease={() => plugin.holdDouble(false)} />
    </ControlWindow>
  );
};
```

Register it in the `overlay` slot with a `visibilityId` and **no** `visibilityRule`. The
Mauser HMI hides its window with `hiddenIn: ['viewer']`; copying that rule here hides the
operator panel in exactly the mode it exists for.

### Four rules the lifecycle imposes

1. **Read the model in `onStart`, never in `init`.** `init` runs at `viewer.use()`, which is
   before `loadGLB`. Until `onStart` has run, publish `ready: false` and render the controls
   disabled.
2. **The model is the truth.** Keep only the latch in your store; read slider values back out
   of the model. Reconcile once per `onFrame` — not a fixed-step hook, because `onFrame` also
   runs while the simulation is paused, and an external change (MCP, console) must still move
   the slider. Convert units in ONE function, match the latch with a tolerance, and return the
   SAME snapshot object when nothing changed, or the window re-renders 60 times a second.
3. **Two resets, and they are different.** A *Reset* button is a demo reset: set your values
   and latch, explicitly. The global `resetSimulation()` emits `simulation-reset` BEFORE
   `drive.reset()` runs, so a listener that reads values there reads the old ones — clear the
   latch, set a one-shot flag, and let the next `onFrame` read what the reset restored.
4. **Do not subscribe to `model-cleared`.** `onModelCleared` calls `onDestroy` first; release
   your references there.

---

## 8d. Quick Edit — Groups section (plan-760)

The asset editor's Quick Edit window has a **Groups** section directly under **Kinematics**
(private `plugins/asset-editor/groups/GroupsList.tsx`, mounted by `KinematicsPanel.tsx`). It
lists every authored `Group` component of the document — kinematic groups included — and is
built from the same row primitives as the Kinematics list (`list-row-primitives.tsx`: row shell,
fold chevron, eye/isolate actions, filter row). Auto-filter categories, overlay categories and
baked partition objects are not groups and never appear here; the editor does not bake.

**What a row shows and does.** Resolved name (a prefixed group reads `Prefix · Suffix`, only the
suffix is editable), member count, an accent dot (`GROUP_ACCENT` `#80deea` for a plain group,
`KINEMATIC_ACCENT` `#ce93d8` for a group a `Kinematic*` owns), and on hover the actions Isolate,
Eye, Rename, Dissolve and *Remove selection from group*. Hovering a row previews its members as
an overlay; **clicking** a row selects all members (those with a registry path) and makes the
group the **Auto Assign target** — it does not switch the mode on. The chevron folds open the
member rows (indent, path tooltip, click = select, `×` = remove from this group), capped at
`MEMBER_ROW_CAP = 200` with an "and N more… (filter to narrow)" row beyond that. The section has
its own filter row (substring on the resolved name; pending and armed groups always stay listed)
and its own resize handle (`GROUPS_LIST_HEIGHT` 240, min 120, max 1200, stored under
`rv-groups-list-height`).

**Add Group / pending rows.** The footer button *Add Group* (`data-rv-button-id="qe.add-group"`)
asks for a name and adds a **pending** row (dimmed, outline dot, 0 members, no eye/isolate) that
lives in the auto-assign store until the registry knows the name — the first assignment creates
the `Group` components. A pending name is cleared on `model-loaded` and when the panel closes.
The "Add to group (no kinematic)…" field in the Components section still exists and is
unchanged.

**Rename / Dissolve.** Pencil or double-click opens an inline editor (Enter/blur commits, Escape
cancels, IME composition is ignored, a refusal keeps the field open with a toast). Rename
rewrites `GroupName` on every member key and on the owning `Kinematic*` in ONE transaction,
per key so a mixed prefixed/unprefixed group stays one group; a new name that would drop a
key's prefix is refused before any write. Dissolve (trash, `ConfirmActionDialog`) removes the
matching `Group` keys and blanks `Kinematic.GroupName`; it never deletes geometry. Both are one
undo step; undo restores the registry and the kinematic link, not an eye state.

**Live only — the rule.** Eye, Isolate and *Show all* in BOTH editor lists call
`viewer.groups.setVisible / isolate / showAll` and bump the shared `group-view-store` tick; they
never write `rv-group-visibility`. The persisted profile belongs to the HMI's **Display** panel,
whose close handler skips `persistCurrentGroupVisibility` while `getActiveAssetContext()` is
non-null (`closeGroupsOverlay`, `GroupsOverlay.tsx`). Quick Edit = live, Display panel =
persisted.

**The Auto Assign contract** (one mode, one target, for both sections):

| Event | Target (store) | Mode (`autoAssign`) |
|---|---|---|
| Click a Kinematics row | `{ groupName, kinematicPath }` | unchanged |
| Click a Groups row | `{ groupName, kinematicPath: first owning Kinematic or null }` | unchanged |
| Add Kinematic / Add Group | the new group | **unchanged** — never switched on programmatically |
| Toggle (either header, same state) | unchanged | user click |
| Escape (no input focused, no dialog open) | unchanged | off |
| Rename of the target | re-keyed to the new name | unchanged |
| Dissolve of the target, `model-loaded`, panel close, asset switch | `null` | off |
| 3D click / marquee, mode ON + target | `assignTarget()` routes: kinematic → `autoAssignToKinematic`, plain → `assignToGroup`; a click on a node that carries a `Kinematic*` re-targets; target itself / existing member = no-op | unchanged |
| 3D click / marquee, mode OFF | nothing — `getArmedTarget()` is `null`, the marquee is a normal selection | unchanged |
| Undo removes the target group from the registry | target stays; not in registry and not pending → no hide, no ghost, assign = no-op | unchanged |
| Eye / Isolate on the armed row while ON; Show all | locked ("Turn off Auto Assign first") / Show all skips the armed group | unchanged |

While the mode is ON and the target exists, the target group is hidden and the selection is
ghosted in the group's accent; the `AutoAssignController` (`auto-assign-controller.ts`) owns
that hide/restore imperatively (`apply()` is idempotent and re-runs on `groups-changed` and the
view tick, `suspend(name)` / `resume(newName | null)` bracket a rename or dissolve), and restores
onto the same `GroupInfo` instance it captured. The React bridge is `useAutoAssignArming()`,
mounted once by the panel: it writes `enabled`, registers the ONE `object-clicked` listener,
the Escape listener and the `model-loaded` disarm.

**For plugin authors — store and controller API in three sentences.** The target lives in
`kinematics/auto-assign-store.ts` as `{ groupName: string; kinematicPath: string | null }`:
`setAutoAssignTarget(t | null)` publishes it, `getAutoAssignTarget()` reads it for display
(armed row, ghost accent), `getArmedTarget()` returns it only while the mode is enabled and is
the only accessor routing, hide and marquee may read; `addPending / removePending / isPending`
manage the pending names. The singleton `autoAssignController` (`bind / setEnabled / disarm /
suspend / resume / apply / busy`) is the sole writer of `enabled` and of the hide state — a list
publishes a target, it never nulls it in an effect cleanup and never flips the mode. Group
mutations go through `groups/group-ops.ts` (`assignToGroup`, `removeFromGroup`, `renameGroup`,
`dissolveGroup`, `validateGroupName`, `groupNameCollides`, `assignTarget`), each ONE
`withTransaction` that throws a `GroupOpError` BEFORE any write, and the same four operations
are the commands `editor.groupAssign / groupRemove / groupRename / groupDissolve` behind the
MCP verbs `web_editor_group_assign / _remove / _rename / _dissolve` (`webviewer.mcp.md`).

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

### AgentEye (`viewer.agentEye`, plan-740)

The MCP agent does **not** share the viewport camera. `viewer.agentEye` is a second, independent
camera body: a pose that no user input ever changes, persisted per tab (`sessionStorage`, keyed by
`deriveModelKey(modelUrl)` from `core/engine/rv-model-key.ts`), rendered offscreen and never
through the visible frame.

```typescript
interface AgentPose { px, py, pz, tx, ty, tz, fov, aspect, projection }

viewer.agentEye?.ensure();                 // spawn at the current viewport pose on first use
viewer.agentEye?.setPose({ px, py, pz });  // partial patch; persists and fires onChange
viewer.agentEye?.setLens({ fov, aspect, projection });   // clamped 5..120° / 0.2..5
viewer.agentEye?.camera();                 // the private Perspective/Orthographic camera
viewer.agentEye?.unproject(x, y);          // image fraction → world ray (the pick frame)
```

Three things a contributor has to know before touching it:

- **`AGENT_EYE_LAYER = 5`** (`rv-group-registry.ts`) carries the "AI" frustum cone and is part of
  `OVERLAY_LAYERS`, so `disableOverlayLayers()` strips it from every offscreen camera — the agent
  cannot photograph its own cone, and neither can the thumbnail renderer or the object analyzer.
  Only the two VIEWPORT cameras enable layer 5.
- **`userData._agentEyeOverlay = true`** on the gizmo keeps it out of picking. The `RaycastManager`
  filters through `_excludeFilters`, **not** through layer bits (doc-render-picking §2.4), so the
  layer alone would leave the cone clickable.
- **Plugin `agent-eye`** (`src/plugins/agent-eye-plugin.ts`) owns the lifecycle: it creates the
  body and the cone, registers the double-click attach and the three auto-detach paths, exposes the
  Settings ▸ Visual toggle, and owns the `EyeChannels` instance (one render target per body,
  released on model change). It is a core plugin — the embed viewer loads no plugins, so it has no
  cone and no `web_eye`.

Attach is `CameraManager.startFollow(new AgentEyeFollowSource(eye))` with follow mode `'follow'`
(so `controls.enabled` stays true and the first user drag detaches). `FollowSource` gained
`onFollowStopped()` so the plugin can pull `attached` and the cone's visibility back in sync no
matter which of the detach paths fired.

Every MCP capture renders through `EyeChannels.renderChannels()` (`core/engine/rv-eye-channels.ts`),
reached from the tool side by `renderAgentChannels()` in `rv-mcp-observe-tools.ts` — which also owns
the single `serializeEyeCapture()` promise chain. Adding a new capture tool means going through
those two, not through `captureFrameCanvas`: that one reads the visible drawing buffer and has
exactly one legitimate consumer, `web_screenshot`.

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
`preserveHierarchy` — that flag turns the BAKE off, which is a different question
from "may this load restructure the authored tree"; only the editor sets it today
(the embed viewer bakes since plan-754 D20). Structural work a runtime load needs
belongs in an `onPreBake` hook, which runs on the throwaway graph and therefore
cannot corrupt an authored document at all. See the invariant section in
`doc-webviewer.md`.

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

> **plan-558 — reusable motion engine.** Two pure engine modules carry the AGV
> distance control and are reusable for any 1D mover:
>
> - [`rv-motion-profile.ts`](src/core/engine/rv-motion-profile.ts) — closed-form
>   time-optimal profiles in **meters / seconds**: `planProfile(t0, x0, v0, limits, a, b, xEnd, { vEnd })`
>   with piecewise-linear v² limits (`LimitPiece`), forward / backward pass,
>   `positionAt` / `speedAt` / `timeAt`, `feasible: false` = emergency stop;
>   `minSeparation` (exact time-domain gap check, cut at a branch point) and
>   `earliestGapCrossing` (exact field entry / exit times). Throws `RangeError`
>   on invalid input; the evaluators are allocation-free.
> - [`rv-movement-authority.ts`](src/core/engine/rv-movement-authority.ts) — the
>   trajectory-based moving block: per vehicle one versioned plan (route +
>   profile), leader envelopes, zone claims keyed on odometer positions, the
>   coalesced re-plan flush, scanner state machine and motion state
>   (free / slowed / stopped). Kernel-neutral through the `MbHost` callbacks;
>   `getDefaultMovementAuthority('des' | 'continuous')` (the continuous one owns
>   the exact-time `MotionEventClock`). `RVPath.curvatureIntervals()` feeds the
>   curve limits; `findUnzonedMerges()` reports merges without a common zone
>   (Problems panel at load).

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

## Binary resources in a GLB (plan-498 pattern)

Some components need bytes that are neither geometry nor texture — the first one is
the `Fmu` component, whose `.fmu` package travels inside the GLB. The pattern it
established is the one to reuse for the next such payload.

- **Standard glTF, no custom chunk.** The payload is an ordinary `bufferView` in the
  BIN chunk; the component's extras name it (`FmuEmbed.bufferView`, `byteLength`,
  `sha256`) and the file lists all such views in
  `asset.extras.realvirtual.fmuBufferViews`. No Base64 in extras, no bytes in
  `userData`.
- **One store, keyed by content.** `binaryResources`
  ([rv-binary-resources.ts](src/core/engine/rv-binary-resources.ts)) maps
  `sha256 → bytes` and reference-counts the documents that hold a payload
  (`put` / `retain` / `releaseDocument`). A component looks its bytes up by SHA in
  `init()`; it never reads them from the scene graph.
- **Fed from the RAW GLB at every parse entry.** `GLTFLoader` drops bufferViews
  nothing references, so the bytes must be taken before it parses. All three entries
  — main load (`rv-scene-loader.ts`), placement cache (`rv-model-cache.ts`) and
  subtree/compose (`rv-glb-parse.ts`) — call ONE wrapper,
  `parseGlbCollectingResources(bytes, documentId, loader)`, which slices the wanted
  views into the store and then parses. A GLB without the marker string costs one
  byte scan, no second JSON parse. `tests/rv-binary-resources.test.ts` fails on any
  new `parseAsync(` outside the wrapper (the two writers are named exceptions). A new
  payload kind extends `collectFmuEmbeds` / `forEachFmuRecord` there instead of
  adding a parse path.
- **Written by the asset writer.** `exportAssetGlb`
  ([rv-asset-glb-export.ts](src/core/editor/rv-asset-glb-export.ts)) appends one
  bufferView per SHA from the store (`embedFmuPackages`) and prunes runtime children
  (`userData._rvFmuSignal`) before the export. A payload missing from the store is
  saved with `bufferView: -1` and a warning — never silently dropped.
- **Heavy parsers are lazy editor chunks.** Reading `modelDescription.xml` needs a
  zip and an XML parser (`fflate`, `fast-xml-parser`). They live in
  [rv-fmu-model-description.ts](src/core/engine/rv-fmu-model-description.ts), which
  only the editor path reaches via dynamic `import()` — only that one zip entry is
  inflated, with size limits. The runtime reads the parsed result from the extras and
  never loads the parser; `tests/bundle-splitting.test.ts` (T10/T11) keeps it out of
  the entry chunk.
- **Signal children with their own leaf name.** `addSignal(host, wireName, type,
  store, registry, { at: host, leafName })`
  ([rv-signal-construction.ts](src/core/engine/rv-signal-construction.ts)) creates
  the child `<host>/Signals/<leafName>` while the wire name stays unique
  (`<host>.<variable>`). Without `leafName` the leaf is named after the wire name.
  Children created this way at load time are addressable like authored signals —
  a `ComponentReference` to `<host>/Signals/<leaf>` in another component resolves to
  the signal once the host component has registered it.

## Project backends

A project's bytes live behind `ProjectBackend`, with three implementations:
`bundled` (a delivered build, read-only), `browser` (OPFS) and `folder` (File
System Access). Anything writing project data should go through the backend
rather than reaching for the filesystem, so it works on all three — that is what
lets a user on Firefox or Safari, where only the browser backend is writable,
save their own assets at all.

## Picking and cleanup

Community extensions can use the public
[RaycastManager](src/core/engine/rv-raycast-manager.ts) through
`viewer.raycastManager` (which can be null). Register helper geometry with
`addAuxRaycastTarget(mesh, owner)` so hits resolve to the intended model node.
Remove it with `removeAuxRaycastTarget(mesh)` before removing or disposing the
helper. Layer bits alone do not register auxiliary pick targets.

Everything else pickable is baked geometry. The pick surface is
`viewer.bakeRegistry.pickMeshes` — the chunk and keep meshes of every live
instance, the main model included. Iterate that, never the scene
graph: a per-node mesh to walk no longer exists. A hit is resolved back to a
node by the registry (`resolveHit(mesh, ownerOrdinal)` — the owner ordinal travels
on the intersection the backend pushed, as `rvOwner`), which the viewer's
`PickBackend` already does for ordinary picks. A plain `THREE.Raycaster` over
those meshes also works: an instance `.raycast` override answers from the same
pick structure with the nearest surface.

Two ownership rules follow, and both are load-bearing:

- **Never `dispose()` a chunk geometry.** It is shared by every instance of the
  asset. `disposeSubtree` / `disposeModelSubtree` skip geometries registered in
  `chunkMetaOf` for exactly that reason, and the `BakedAsset` frees them itself
  once its refcount reaches zero.
- **Remove a placement through the registry**, with
  `bakeRegistry.release(instance)` or `releaseByRoot(root)`. The registry fires
  its release listeners before it detaches anything, which is how the highlight
  manager drops `chunk-outline` / `chunk-overlay` proxies for that instance in
  time. Detaching or disposing the meshes by hand skips that step.

Highlights on a baked root go through those pooled wrapper proxies, which carry
their own `drawRange` over the chunk geometry — never set `drawRange` on the
chunk itself, it is shared. Dispose only geometry and materials your extension
created, never the model's.

Pair every registration with cleanup on model clear, user disable, relevant mode
exit and final plugin disposal. Make cleanup idempotent and cancel asynchronous
work so a late continuation cannot reinstall a removed overlay. See
[Lifecycle](doc-lifecycle.md) and [Events](doc-events-and-hooks.md).
