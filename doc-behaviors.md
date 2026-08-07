# Component Behaviors

realvirtual WEB is the open standard for browser-based 3D-HMI in manufacturing. Component Behaviors are the standard's wiring layer: they turn a generic GLB into a working machine — drives, sensors, transports, signals, AAS links and right-click menus — without touching the GLB or the engine.

There are three ways to declare wiring; all of them feed the same low-level core (`applyKinematicsSpec`):

1. **Behavior file** — one TypeScript file per GLB in `src/behaviors/`. Auto-discovered, full code access.
2. **Naming convention** — name a node `Drive-Lin-Y`, `Transport-X`, etc. and it becomes the matching component. Runs on every loaded GLB; no Unity marker required.
3. **Sidecar JSON** — `<glb>.kin.json` next to the GLB. Pure data, no code.

## 1. Behavior file

```ts
// src/behaviors/MyMachine.ts
import { defineBehavior } from '../core/behaviors';

export default defineBehavior({
  models: ['MyMachine', 'MyMachine_*'],

  bind(rv) {
    rv.drive('Axis1', 'LinearY', { speed: 500, acceleration: 2000 });
    rv.transport('Belt_In', '+X', { speed: 250 });
    rv.sensor('Photoeye', { size: [50, 200, 50] });
    rv.signal('Axis1.Pos', { type: 'PLCOutputFloat', drive: 'Axis1', binding: 'CurrentPosition' });

    rv.contextMenu('Axis1', [
      { id: 'home', label: 'Home', action: () => rv.drives.get('Axis1')?.moveTo(0) },
    ]);

    rv.onFixedUpdate((dt) => {
      // 60 Hz logic — auto-disposed on model-cleared.
    });
  },
});
```

**Discovery.** Every `src/behaviors/*.ts` module is loaded eagerly via `import.meta.glob`. Add a file, get a behavior. No imports, no manual registration.

**Match.** `models[]` matches the GLB **filename** (without `.glb`), not `root.name` from the GLB. Patterns:

- exact name: `'MyMachine'`
- glob: `'MyMachine_*'`, `'Belt_v?'`
- wildcard: `'*'` matches every loaded model

**Lifecycle.** The bind callback runs on every `model-logic-activated` event when `models[]` matches. For unsigned and validly signed models this follows `model-loaded` immediately. If a signed model is invalid or cannot be verified, geometry and HMI still load, but behaviors remain stopped until the user explicitly activates model logic. All hooks and subscriptions registered through `rv.*` are tracked per bind and automatically disposed on the next `model-cleared` event — no manual cleanup.

## 2. Naming convention

The scanner walks every loaded GLB and maps these node names to components automatically:

| Node name pattern        | Component                                |
|--------------------------|------------------------------------------|
| `Drive-Lin-X/Y/Z`        | Linear drive, `Direction = Linear{X,Y,Z}` |
| `Drive-Rot-X/Y/Z`        | Rotational drive                         |
| `Transport-X/Y/Z`        | Transport surface, +axis. A co-located linear Drive is synthesized on the same node and auto-linked at runtime (findInParent fallback). |
| `Sensor`, `Sensor-<id>`  | RVSensor (e.g. `Sensor`, `Sensor-1`, `Sensor-Infeed`). An optional exporter duplicate suffix like `_(1)` or `(1)` is tolerated. |
| `DriveMesh`, `Base`      | Structural tags only (no component)      |
| `Snap-<DIR>-<TYPEID>`    | Handled by the snap-point plugin (unchanged) |

No Unity-side marker is required — name a GameObject `Drive-Lin-Y` in your CAD or Unity authoring tool and it becomes a linear-Y drive in the viewer. The patterns are specific enough that false positives are unlikely; nodes that happen to use the same names but are not meant to be kinematized produce a component without speed or signal binding, so they have no runtime effect.

The scan deep-merges into existing `rv_extras`, so manually-authored fields (e.g. a `TargetSpeed` set in Unity via a `Drive` component) are always preserved.

### Optional `WebLibraryComponent` marker

An optional Unity-side marker component `WebLibraryComponent { TypeId, Version }` can be placed on a library asset root for diagnostics and future catalog metadata. It is **not required** for the naming-convention scan — the loader treats it as documentation only.

### Bindable follow-position drives

`Drive_FollowPosition` exposes `Position` as a float control slot and
`CurrentPosition` as a float feedback slot in Signal Link mode. When several
axes have no `LayoutObject` scope, give each signal an axis-qualified name such
as `A1.Position` and `A1.CurrentPosition`; unqualified names would share one
global store entry.

A live `Position` binding moves the drive to the supplied value and publishes
the resulting position through `CurrentPosition`. If the provider disconnects,
the drive holds its last live position instead of following the neutralized
zero. Reconnecting the provider or forcing the target signal releases this
latch, including when the forced value is zero.

## 3. Sidecar JSON

If an unsigned `mymachine.glb` ships with `mymachine.kin.json` next to it, the loader fetches it automatically and applies the spec. Silent on 404, warning on parse error. A GLB carrying `scenes[scene ?? 0].extras.rv_sig` is self-contained, so its sidecar is never applied, regardless of the verification result.

```json
{
  "drives": [
    { "target": "Axis1", "direction": "LinearY", "speed": 500 }
  ],
  "transports": [
    { "target": "Belt_In", "direction": "+X", "speed": 250, "drive": "Axis1" }
  ],
  "sensors": [
    { "target": "Photoeye", "size": [50, 200, 50] }
  ]
}
```

Spec shape = `KinematicsSpec` interface. No code deployment needed — ideal for third-party GLBs.

## RVBindContext reference

The single argument to `bind(rv)`. All methods are chainable (return `this`). In a **behavior file** subscriptions are auto-disposed on `model-cleared` (the BehaviorManager tracks them per bind); through the low-level `viewer.bind()` entry they are **not** — see [Low-level API](#low-level-api).

### Kinematics

- `rv.drive(target, direction, opts?)` — create or override a drive.
- `rv.drive(target, opts)` — tune existing drive without touching `Direction` (deep-merge speed/acceleration).
- `rv.transport(target, direction, opts?)` — direction as axis code (`'+X'`, `'-Z'`) or vector `[1,0,0]`.
- `rv.transport(target, opts)` — tune-only overload.
- `rv.sensor(target, opts?)` — `opts.size = [w, h, d]` in mm.
- `rv.snap(target, direction, typeId)` — direction is `'XN' | 'XP' | 'YN' | 'YP' | 'ZN' | 'ZP'`.

### Signals

- `rv.signal(name, { type, drive?, binding?, initialValue? })` — register a PLC signal. `type` is one of `PLCInputBool`, `PLCOutputBool`, `PLCInputFloat`, `PLCOutputFloat`, `PLCInputInt`, `PLCOutputInt`.
- `rv.signals.get(name)` / `rv.signals.set(name, value)` — read/write at runtime.
- `rv.signals.on(name, cb)` — subscribe to changes.

### Hooks

- `rv.onFixedUpdate((dt) => { ... })` — 60 Hz logic.
- `rv.on(event, cb)` — subscribe to any viewer event (e.g. `'sensor:Name:enter'`).

### AAS links

- `rv.aas(target, aasxFile, { tab?, idShort?, description?, serverUrl?, overwrite? })` — registers an Asset Administration Shell link; consumed by the AAS-link plugin. `overwrite` follows the same merge semantics as every other entry (see [Merge semantics](#merge-semantics)).

### Context menus

- `rv.contextMenu(target, items, { includeChildren? })` — register right-click items for a node (and optionally its subtree). Item shape: `{ id, label, action, condition?, danger?, dividerBefore? }`.

### Navigation

- `rv.find(name)` — resolve a node by plain name (BFS).
- `rv.path('A', 'B', 'C')` — resolve by slash-path.
- `rv.drives.get(target)` — return the running `RVDrive` instance for direct method calls (`moveTo`, `jog`, `stop`).

## Node references

Anywhere a `target` is accepted you may pass:

- A plain name (`'Axis1'`) — resolved BFS under the model root.
- A slash-path (`'Axis1/Tool/Tip'`) — resolved by walking segments.
- An `Object3D` reference — used directly.

A string containing `/` is always treated as a path. The root node's own name is optional as the first segment.

## Low-level API

`viewer.bind(root, specOrCallback, { strict?, overwrite? })` applies a spec (or runs a bind callback) directly. Used internally by the behavior manager, sidecar loader, and the naming-convention loader. Useful for ad-hoc scripting and tests.

```ts
viewer.bind(root, {
  drives: [{ target: 'Axis1', direction: 'LinearY', speed: 500 }],
});
```

**No auto-dispose here.** The "auto-disposed on `model-cleared`" promise belongs to behavior **files**, where the BehaviorManager tracks every `rv.*` registration per bind. The low-level entry does not: subscriptions made through the callback form — `rv.onFixedUpdate`, `rv.signals.on`, `rv.contextMenu` — survive a model clear, and the caller must dispose them itself (e.g. by listening to `model-cleared`). If you want the disposal, use a behavior file.

## Merge semantics

By default `applyKinematicsSpec` deep-merges into existing `rv_extras`: an existing field is kept, a new field is added. This means three configuration paths (sidecar → naming-convention → behavior) can all contribute to the same node without stepping on each other.

To force overwrite, pass `{ overwrite: true }` either at spec-level (every entry overwrites) or per-entry (e.g. on a single `rv.drive(..., { overwrite: true, ... })`).

In strict mode (`{ strict: true }`) missing targets throw; default is to log a warning and skip.
