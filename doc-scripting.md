# Component Scripting (JS-in-GLB)

realvirtual WEB lets you attach a JavaScript behavior directly to a node in the GLB. The script travels with the model — no separate signal map, no build step, no plugin registration. It runs in a sandboxed QuickJS virtual machine inside the browser, is authored in the built-in Monaco editor (TypeScript, checked against the SDK's own type declarations), and hot-reloads without a scene reload.

One script writes one behavior once. The same handler set runs unmodified against the continuous, real-time simulation kernel and — where a DES runner is present — against the event-based kernel, so a turntable or a supervisory cell coordinator written today keeps working if the model later runs headless at 1000× speed.

Script components are the general-purpose extension point below [Component Behaviors](doc-behaviors.md): behaviors wire existing native components (drives, sensors, transports) to a GLB from TypeScript files that ship with the viewer build; script components carry custom, per-model logic *inside* the GLB itself, written by whoever builds the model.

## Choosing your extension path

realvirtual WEB gives you two different ways to add custom logic, and they are not interchangeable — pick based on where the logic belongs.

**1. In-GLB scripting (this document).** You write JavaScript or TypeScript in the built-in Monaco editor, attached to a node. TypeScript is transpiled to conservative JS at save time — the GLB itself stays toolchain-free and self-describing, and the script travels with the scene: open the model anywhere and the behavior comes with it, no separate build or deployment step. You get the full `self` API described below: component handles, ports/MU material flow, script-to-script messaging, scheduling, error handling, and value-typed math — plus hot reload while the model stays loaded. The trade-off is the sandbox boundary: no DOM, no `fetch`, no network, no wall-clock timers, no direct Three.js access (only value-typed `NodeHandle` reads cross the boundary), a shared memory limit and a per-call interrupt deadline, and a trust gate that keeps scripts from an untrusted model from running until the user (or an explicit host setting) allows it. `self.random()` and `self.now` are deterministic (seeded PRNG, virtual time) by design, not wall-clock. This path fits component behavior, interlocks, routing logic, supervisory cell coordination, and anything meant to be shared as part of a reusable, portable model.

**2. Native TypeScript extension (plugins and behaviors in the viewer build).** You write a `RVViewerPlugin` (lifecycle hooks: `onModelLoaded`, `onModelCleared`, `onFixedUpdatePre`/`onFixedUpdatePost`, `onRender`, `dispose` — see [Extending realvirtual WEB](doc-extending-webviewer.md)) or a Component Behavior file (see [Component Behaviors](doc-behaviors.md)) as part of the viewer's own source tree, built with the project's Vite toolchain. This code runs unsandboxed, with full access to the live Three.js scene graph, the rich `MaterialFlowSelf` material-flow surface, React-based HMI panels via UI slots, and no memory or interrupt ceilings — at full bundle performance. The trade-off is distribution: the result is part of the *application*, not the model — it ships with a viewer build/deployment, not inside a GLB, and reaches every model loaded into that build rather than travelling with one specific scene.

| | In-GLB scripting | Native TypeScript extension |
|---|---|---|
| API surface | The `self` SDK (this document) | Full `RVViewerPlugin` / `RVBehavior` / `MaterialFlowSelf` API |
| Three.js scene access | None — value-typed `NodeHandle` reads only | Direct, full scene graph |
| Distribution | Inside the GLB — travels with the model | Part of the viewer build/deployment |
| Portability | Runs in any realvirtual WEB instance that opens the model | Runs only in builds that include the plugin/behavior |
| Sandbox / limits | QuickJS VM, shared memory limit, per-call interrupt deadline, trust gate | None — native JS execution |
| Determinism | Enforced (seeded random, virtual time, no wall clock) | Not enforced — full platform APIs available |
| Authoring | JS or TypeScript in the built-in Monaco editor, hot-reloaded live | TypeScript in the project source tree, requires a build |
| Custom HMI UI | Not available from the script itself | Full React UI slots (KPI cards, panels, overlays) |

**3. Project code (`documents[].scriptRef`).** A third way exists for code that belongs to neither the model nor the viewer, but to a **project**: a `.ts` module inside the project folder, bound to a document by a reference on its manifest row (`documents[].scriptRef` in `project.json`). It is the same native TypeScript plugin as path 2 — same API, same lack of a sandbox — with a different *binding*: which documents get it is stated in the manifest rather than in the module, so several documents can share one module (N:1) and renaming a GLB cannot break the binding. It replaces the module's own `models: string[]` self-declaration, which bound code to a file name. See [Extending realvirtual WEB](doc-extending-webviewer.md) for the authoring rules.

| | In-GLB scripting | Native TypeScript extension | Project code (`scriptRef`) |
|---|---|---|---|
| Belongs to | the model | the viewer application | the project folder |
| Binding | the node it is attached to | every model in the build | the document row that names it |
| Distribution | inside the GLB | the viewer build | the project directory (copy the folder, the code comes along) |
| Sandbox / limits | QuickJS VM, trust gate | None — native JS execution | None — native JS execution |

### How project code is loaded — two modes, one reference

The same `scriptRef` is resolved two ways, in this order:

1. **Build mode.** The module was part of the viewer build (`import.meta.glob` found it). Nothing extra is needed; the reference only says *which* bundled module belongs to *which* document.
2. **Runtime mode.** The module is **not** in the build — a project folder copied onto a machine whose viewer was built without it. The viewer then looks for the compiled **`.js` sibling** next to the referenced `.ts` (`scripts/a.ts` → `scripts/a.js`), reads it out of the project and imports it dynamically.

A `scriptRef` that resolves to neither loads **no** plugins. There is deliberately no fallback to the old name-based match: binding the wrong code is worse than binding none.

**Producing the sibling.** Compilation happens on the dev/delivery path, not in the browser:

```bash
npm run build:project-scripts -- <projectDir>          # build the .js siblings
npm run build:project-scripts -- <projectDir> --check  # CI gate: exit 3 if missing/stale
```

The artefact is a **self-contained ES module** (esbuild, `bundle: true`, `format: esm`): it is imported from a Blob URL, which has no directory, so a relative `import './util'` inside it could not resolve. Bare package imports (`three`, `react`, `@mui/material`) stay external and resolve against the viewer's copies.

**Consent.** Runtime-mode code is unsandboxed JavaScript that arrived with a project folder, so the first time a project wants to run some, the viewer asks once and remembers the answer **per project id**. Without consent the project still opens — only its own code stays off. The global scripting gate (the QuickJS trust gate above) is *not* a permission for this: it governs a different execution path. Build-mode code is not gated — it was compiled into this build from the repository and is as reviewable as the viewer around it.

If your logic belongs to the model, script it in the GLB. If you are extending the viewer application itself, use the native TypeScript plugin/behavior path. If it belongs to one customer's project, put it in the project folder and reference it from the manifest.

## The WebComponent data model

A script component is one `WebComponent` entry in a node's `rv_extras` (the `REALVIRTUAL` GLTF extension), sitting next to `Drive`, `Sensor`, `TransportSurface` and the other component blocks documented in the ODT schema.

| Field | Type | Default | Description |
|---|---|---|---|
| `Active` | boolean | `true` | If `false` the component is parsed but never executed. |
| `ApiVersion` | number | `1` | Component-SDK contract version the code was written against. The current build refuses to run code declaring a newer version than it supports. |
| `Language` | string | `"js"` | Source language of `Code`. Stored code is always conservative JavaScript — TypeScript authored in the editor is transpiled before it is saved. |
| `DesSafe` | boolean | `false` | Author claim that the script only uses event-driven primitives (checked by the DES lint, see below). |
| `TypeId` | string | `""` | Library/type identity for reuse, inspector display and statistics. |
| `Code` | string | `""` | The JavaScript source, following the global `setup(self)` contract described below. An empty string means no VM is created — the component stays inactive but remains editable. |

```json
{ "WebComponent": { "Active": true, "ApiVersion": 1, "TypeId": "Gate", "Code": "function setup(self){ return { continuous: {} }; }" } }
```

Any additional primitive field (number/string/boolean/null) placed on the same `WebComponent` object beyond these six reserved keys is exposed to the script as `self.prop` — a lightweight way to parametrize a script instance (e.g. `ProcessTime`, `RotationSpeed`) without touching the code.

## Security and trust

Script execution is **off by default** for every loaded model. Three things guard the boundary:

- **Sandbox isolation.** Each script runs in its own QuickJS guest context on a shared runtime. The guest sees only what the SDK's minimal ambient `lib.d.ts` exposes — no `window`, no `fetch`, no DOM, no Node APIs. `Date`, `setTimeout`, `setInterval` and `Math.random` are not exposed at all; using them is a `ReferenceError` at runtime and an explicit lint error at save time (see DES-safety lint below), because they would break the determinism the two simulation kernels rely on.
- **Resource limits.** The shared runtime enforces a guest heap limit (32 MB, covering *all* script contexts together) and every host→VM call (a tick, a handler invocation, `setup()` itself) runs under a wall-clock interrupt deadline (5 ms by default). A script that runs too long or allocates too much is aborted mid-call.
- **Trust gate.** Loading a GLB that contains `WebComponent` entries never runs them automatically. The viewer logs how many script components were found and stays inert until scripting is explicitly allowed — via the `?scripts` URL parameter, or programmatically via the plugin's `setAllowScripts(true)`. Toggling the gate off disposes every running instance; toggling it on re-wires the currently loaded model.
- **Poison backoff.** If a context is aborted by the interrupt deadline or a memory failure, it is marked poisoned *and* disabled: the disable callback fires once, and every further call returns a structured error without touching the VM again. There is no automatic retry per tick — that would turn a buggy `while (true)` into a poison loop. Re-enabling is an explicit, separate step; after a memory poison the practical fix is to dispose the instance and mint a fresh one with corrected code (which is exactly what a hot-reload does).

Within one running instance, failure isolation is layered further: if `setup()` throws, or the *first* tick's handler throws, the instance disables itself and the rest of the scene keeps running unaffected. A handler failure *after* the first successful tick only logs a warning — unless the script itself declares an `onError` handler and asks to keep running (see below).

## Component lifecycle

A script declares exactly one thing: a global function named `setup`.

```js
function setup(self) {
  // one-time setup — resolve components, subscribe, read initial signals
  return {
    // the handler object — everything here is optional
  };
}
```

`setup(self)` is called once per instance (again on every hot-reload — always a *cold* restart, see below). It receives the `self` API object and returns a plain object of lifecycle handlers. Nothing forces a script to declare all of them; an empty `return {}` is a valid, inert component.

### The returned handler object

```ts
interface Handlers {
  continuous?: {
    fixedUpdate?(dt: number): void;
    lateFixedUpdate?(dt: number): void;
    teardown?(): void;
  };
  des?: {
    canAccept?(mu: MU, port?: Port): boolean;
    onAccept?(mu: MU, port?: Port): boolean;
    on?(hook: string, mu: MU | null, data?: unknown): void;
    onDownstreamReady?(port: Port): void;
  };
  routing?: {
    selectNextPath?(candidateIds: string[], ctx: RouteContext): string | void;
    onArrive?(pathId: string, travelerId: string): void;
    requestDispatch?(travelerId: string): void;
  };
  onSignal?(name: string, value: boolean | number): void;
  onReset?(): void;
  onMessage?(topic: string, data: unknown, fromPath: string): void;
  onArrival?(mu: MU): void;
  onRequest?(topic: string, params: Record<string, unknown>,
             reply: (response?: Record<string, unknown>) => void): void;
  onError?(err: unknown, phase: ErrorPhase): boolean | void;
  onSnapshot?(): unknown;            // JSON value — persisted in DES snapshots
  onRestore?(state: unknown): void;  // re-inject the onSnapshot() payload
}

type ErrorPhase =
  'fixedUpdate' | 'hook' | 'signal' | 'message' | 'reset' | 'routing' | 'snapshot';
```

- **`continuous.fixedUpdate(dt)`** — runs every 60 Hz simulation tick, before the frame's drive physics settle (`WebComponentPlugin` calls it from `onFixedUpdatePre`). This is the tick-polling path; it only exists in the continuous kernel (see [DES-safe scripting](#writing-des-safe-scripts) below).
- **`continuous.lateFixedUpdate(dt)`** — an optional second continuous pass, run after drive physics and transport for the tick (`onFixedUpdatePost`).
- **`des.canAccept(mu, port)` / `des.onAccept(mu, port)` / `des.onDownstreamReady(port)`** — the same three-call contract every material-flow station uses: back-pressure probe, hand-off, and "a blocked output freed up" notification. Present in both kernels; the continuous kernel's ports/flow backend answers these the same way a native station would.
- **`des.on(hook, mu, data)`** — fires for every due event previously scheduled with `self.in` / `self.at` / `self.every`, in *both* kernels (the continuous kernel drains its own timer heap on every tick; the event kernel dispatches the same hooks through its scheduler). This is the event-driven backbone a DES-safe script is built from.
- **`routing.*`** — the AGV path-routing hooks. Declaring ANY of them makes this component the **project router** of the path network (one router per model — a second declaring component replaces the first with a warning). `selectNextPath(candidateIds, ctx)` picks the next path id at a junction (return one of `candidateIds`; anything else falls back to the default `candidateIds[0]`); `onArrive(pathId, travelerId)` fires whenever a vehicle completes a path (hand-off or dead-end stop); `requestDispatch(travelerId)` fires once when a vehicle goes idle at a dead end — the dispatch trigger for fleet logic. All signatures are id-based plain values; the dispatch is synchronous and identical in the continuous and DES kernels. Keep `selectNextPath` cheap and **deterministic** — the traffic look-ahead (headway leader search, zone claim walk) re-asks the same decision every tick. Vehicles WITHOUT a registered router simply follow `successors[0]`. See [`self.paths`](#path-graph--zones-agv) for the graph queries.
- **`onReset()`** — fires on a simulation reset; pending timers are cleared and the virtual clock is zeroed before the call.
- **`onMessage(topic, data, fromPath)`** — the receiver side of script-to-script messaging (see below).
- **`onArrival(mu)` / `onRequest(topic, params, reply)`** — the receiving side of a typed connection (see [Typed connections](#typed-connections) below).
- **`onError(err, phase)`** — a soft error layer. Every other handler call is wrapped; if it throws, `onError` is offered the exception and the phase it occurred in. Returning `true` means "handled, keep running" — the default behavior (first-tick failure disables the instance, later failures only log) is skipped. Phases map to handler groups, not to individual handlers: `continuous.*` reports `'fixedUpdate'`, every `des.*` handler plus `onArrival`/`onRequest` report `'hook'`, `routing.*` reports `'routing'`, and `onSnapshot`/`onRestore` report `'snapshot'`.
- **`onSnapshot()` / `onRestore(state)`** — the snapshot hooks (see below). Both MUST be synchronous.

### Snapshot / restore — persisting script state

When the DES workspace saves a snapshot, the engine captures each script
component's seeded `self.random()` position and FSM state automatically — but
it cannot see **free closure variables** inside your `setup()` scope. The
**only supported channel** for persistent script state is the hook pair:

```js
function setup(self) {
  let count = 0;
  let nextCycleAt = 0;
  return {
    des: { on(hook) { count++; nextCycleAt = self.now + 5; self.at(nextCycleAt, 'cycle'); } },
    onSnapshot() { return { count, nextCycleAt }; },       // any JSON value
    onRestore(s) { count = s.count; nextCycleAt = s.nextCycleAt; self.at(nextCycleAt, 'cycle'); },
  };
}
```

Rules:

- `onSnapshot()` returns a JSON-serializable value; it is stored in the DES
  snapshot and handed back to `onRestore(state)` after a load. Both hooks are
  synchronous — never `await` inside them (the restore is atomic by design).
- **Pending timers do not survive a restore.** Store the ABSOLUTE due time of
  anything you scheduled (`self.now + delay`) in `onSnapshot()` and re-arm it
  with `self.at(time, hook)` in `onRestore()` — that continues the run exactly
  where it left off.
- The `self.random()` stream position and the `self.setState()` FSM state are
  restored BEFORE `onRestore()` runs, so randomness continues seamlessly.
- **`self.prop` is read-only configuration.** Inside the sandbox, `self.prop`
  is a VM-local copy of the `WebComponent` extras — writes to it are never
  marshalled back to the host and are NOT persisted in snapshots. Use
  `onSnapshot`/`onRestore` for runtime state instead. (The DES-safety lint
  flags mutated closure variables in scripts without an `onSnapshot` hook as a
  reproducibility warning.)

### Hot reload is always cold

Editing and saving a script tears the old instance down completely — host-side subscriptions unsubscribed, pending `self.in`/`self.at`/`self.every` timers cancelled, VM handles released, the kernel adapter detached — and mints a brand-new one that runs `setup()` again from scratch. There is no warm state transfer: closure variables from the old instance are gone, exactly like a fresh simulation start for that one component. This keeps the reload path simple and guarantees a disposed instance can never leak a stray event into its successor.

## The `self` API

Everything a script can do goes through `self`, the single argument to `setup`. Only plain data crosses the VM boundary — nodes and components are represented as opaque handles whose reads and methods are host calls; there are no Three.js objects inside the sandbox, and world reads always come back as plain `{x,y,z}` / `{x,y,z,w}` / `number[16]` / `{min,max}` objects, never class instances.

### Identity, state, props

| Member | Description |
|---|---|
| `self.name` | The component node's leaf name. |
| `self.path` | Full hierarchy path of the component node (also the seed source for `self.random()`). |
| `self.self` | A `NodeHandle` for the component's own node. |
| `self.state` / `self.setState(name)` | A free-form state string, readable by other script components via `component(path).state` and mirrored into per-component statistics. Separate from `statState()` — the FSM phase never pollutes the utilization statistics. |
| `self.prop` | The `{ [key]: PropValue }` bag of extra fields on the `WebComponent` entry (numbers, strings, booleans, or `null`). **Read-only configuration** — writes stay VM-local, never reach the host and are not persisted; use `onSnapshot`/`onRestore` for runtime state. |
| `self.now` | Virtual simulation time in seconds — advances only through ticks (continuous) or the event scheduler (DES kernel). Never wall-clock. |
| `self.random()` | A seeded PRNG (mulberry32), seeded from `self.path` by default — the same component path always produces the same sequence, in either kernel. There is no `Math.random()` in the sandbox. |
| `self.enabled` | `false` once `self.disable(reason)` has been called on this instance. |
| `self.disable(reason)` | Disables the instance from within the script itself. |
| `self.log(...)` / `self.warn(...)` / `self.error(...)` | Debug-log sinks (console-backed by default), prefixed with the component's node path. |
| `self.raiseError(code, message)` | Raises a visible error: emits the `component-error` viewer event, sets the conventional `<Name>.Error` bool signal, and becomes readable by other components via `component(path).error`. Does **not** disable the instance. |
| `self.clearError()` | Clears the raised error state. |

### Node access

| Member | Description |
|---|---|
| `self.node(pathOrName)` | Resolves any node by hierarchy path or name; `null` if not found. |
| `self.children(type?)` | Direct child nodes of the component's own node; with a convention kind (`'drive'`, `'sensor'`, `'transport'`, …) all matching **descendant** nodes. |

`NodeHandle` (returned by `self.self`, `self.node(...)`, and every component handle's `.node`):

| Member | Description |
|---|---|
| `name`, `path` | Node identity. |
| `worldPosition()`, `worldQuaternion()` | World-space transform, as plain `{x,y,z}` / `{x,y,z,w}`. |
| `worldDirection(localAxis?)` | A local axis (default `(0,0,1)`) rotated into world space. |
| `localPosition()`, `localQuaternion()`, `scale()` | Local-space transform. |
| `worldMatrix()` | The 16-element world matrix as a flat `number[]`. |
| `worldToLocal(p)`, `localToWorld(p)` | Point conversion between spaces. |
| `bounds()` | Axis-aligned bounding box (`{min, max}`), computed on demand. |
| `parent()` | The parent `NodeHandle`, or `null` at the scene root. |
| `occupied()` | Surface-occupancy probe (true when something currently sits on this node's transport surface, when the host wires an occupancy backend). |

### Component handles

`self.find<T>(type, pathOrName)` resolves one component by its native type name (`'Drive'`, `'Sensor'`, `'Belt'`, `'TransportSurface'`, `'Source'`, `'Sink'`, `'Grip'`, `'LogicStep'`); `self.findAll<T>(type)` returns **every** component of that type in the scene — the supervisory pattern for "call a method on all of them":

```js
self.findAll('Drive').forEach(function (d) { d.stop(); });
```

The typed shortcuts resolve the same handles by path directly: `self.drive(p)`, `self.sensor(p)`, `self.belt(p)`, `self.transport(p)`, `self.source(p)`, `self.sink(p)`, `self.grip(p)`, `self.logicStep(p)` — each returns `null` when nothing resolves at that path or the host environment doesn't wire that kind.

| Handle | Reads | Methods |
|---|---|---|
| `DriveHandle` | `position`, `speed`, `isAtTarget`, `isMoving`, `targetSpeed` (settable), `node` | `moveTo(destination)`, `startMove(destination?)`, `jog(forward)`, `stop()` |
| `SensorHandle` | `occupied`, `mode` (`'Raycast' \| 'Collision'`), `node` | `on(cb)` → unsubscribe function. `cb` is `(occupied: boolean, mu?: MU \| null) => void` — the second argument carries the occupying `MU` on **enter**, and is `null` on exit or when the backend cannot resolve it. |
| `BeltHandle` | `occupied`, `speed`, `node` | `run(forward)` |
| `TransportHandle` | `direction`, `speed`, `radial`, `node` | — (read-only) |
| `SourceHandle` | `automatic` (settable), `interval` (settable) | `spawn()` → `MU` |
| `SinkHandle` | — | `on(cb)` → unsubscribe function, called with the arriving `MU` |
| `GripHandle` | `gripped` (`MU[]`), `range` | `pick()`, `place()` |
| `LogicStepHandle` | `state` (`'Idle'\|'Active'\|'Waiting'\|'Finished'`), `progress` | `start()`, `reset()` |

The host environment wires which kinds are actually available for a given deployment (the live viewer wires drive/sensor/belt/transport today; `source`/`sink`/`grip`/`logicStep` resolve `null` unless a host supplies them). A missing resolver is not an error — the script should always null-check before use, as every example in this document does.

### Signals

```js
self.signal('ConveyorStart').bool;         // read
self.signal('ConveyorSpeed').set(500);     // write
self.signal('PartAtSensor').on(function (v) { ... });  // subscribe, returns unsubscribe
self.setSignals({ ConveyorStart: true, ConveyorSpeed: 200 });  // bulk write
```

`self.signal(name)` and `self.signalAt(path)` both return the same `SignalHandle` shape: `.bool`, `.num`, `.int` reads, `.set(value)`, `.on(cb)`.

### Scheduling — the event backbone

```ts
self.in(delaySec, hook, mu?, data?): number;   // relative delay, returns an event id
self.at(timeSec, hook, mu?, data?): number;    // absolute virtual time
self.every(intervalSec, hook, data?): number;  // recurring, auto re-scheduled
self.cancel(eventId): void;                     // cancels a pending self.in/at/every event
```

Every fired event calls the script's `des.on(hook, mu, data)` handler — the *same* call, whichever kernel is running. `self.in`/`self.at` are kernel-agnostic Tier-0 primitives: the continuous kernel backs them with a per-component event heap drained on every tick (`time <= now`); the event kernel backs them with its own scheduler. `self.every` is DES-safe by construction — it is pure event re-scheduling, never a `dt`-accumulation loop. All pending timers are automatically cancelled when the instance is disposed (hot-reload, model clear) — a script never needs to unsubscribe or cancel manually for cleanup purposes.

### Material flow — ports, MUs, transfer

```ts
self.inputs(): Port[];
self.outputs(): Port[];
self.freeOutputs(mu?: MU): Port[];   // outputs not occupied (and, with an mu, that can accept it)
self.ports: ReadonlyArray<Port>;
self.downstreamOccupied(port?): boolean;
self.downstreamCanAccept(mu, port?): boolean;
self.transfer(mu, fromPort?): void;
self.spawn(): MU;
self.mus: ReadonlyArray<MU>;
self.currentLoad: number;
```

`Port` reflects the same snap-graph topology the native TypeScript behaviors resolve (direction-classified connections and single-successor pairings), re-resolved fresh on every call because the graph changes as the user places assets:

| Member | Description |
|---|---|
| `id` | The partner's snap id — stable identity across calls. |
| `role` | `'input' \| 'output'`. |
| `node` | This component's own local snap node (the angle-math frame for router-style logic). |
| `partner` | The connected partner component's root node. |
| `worldAngle?` | Optional world dispatch angle in degrees (for routers). |
| `occupied()` | True when the downstream behind this port cannot accept — reads the partner's per-port signal first, falling back to its root signal (the shared `Flow.Occupied` interlock convention; never reconstruct this signal name by hand). |
| `upstreamWaiting()` | True when a part waits on the connected upstream side. |
| `setOccupied(v)` | Publishes *this* component's per-port occupied state for exactly that connection. |

`MU` (a movable unit, value-typed):

| Member | Description |
|---|---|
| `id`, `type?`, `prop?` | Identity and data payload. |
| `node?` | Scene node of the MU, when the backend can resolve it. |
| `park()` | Holds this MU: in the continuous kernel this halts it on its surface; in the event kernel it keeps its capacity slot reserved. |
| `release()` | Undoes `park()`. |

The live viewer's continuous backend for `self.transfer`/`self.spawn`/`self.mus`/`self.currentLoad`/`mu.park`/`mu.release` is a self-contained per-instance MU ledger (`createLocalFlowBackend`); the event kernel wires its own runner-managed MU tracking behind the identical `self` surface, so the same script code works unmodified against either.

### Path graph + zones (AGV)

`self.paths` addresses the AGV path graph (`rv_extras.Path` nodes) **by id** — the query analogue of the `routing.*` handlers. Everything is plain JSON: no live handles, because path geometry and topology are parse-static. Lengths are in **millimeters** (drive parity — the same unit as `Agv.Position` and `TargetSpeed`).

```ts
self.paths.list(): PathDesc[];               // all registered paths
self.paths.get(id): PathDesc | null;
self.paths.successors(id): string[];         // ids only; [] at a dead end
self.paths.claim(zoneId, holderId?): boolean;
self.paths.release(zoneId, holderId?): void;
self.paths.isHolder(zoneId, holderId?): boolean;
```

`PathDesc`: `{ id, length /* mm */, closed, successorIds, predecessorIds, zone, zoneCapacity }`.

`claim`/`release`/`isHolder` participate in the **same zone registry** the AGV traffic control uses (control-point mutual exclusion): a script claiming a zone (a station, a charging bay) blocks vehicles from entering it, and vice versa. `holderId` defaults to this component's own path; pass an explicit id to act for a vehicle. Claims taken under the default holder are auto-released when the component is disposed or hot-reloaded; explicit-holder claims belong to that actor and must be released by the script.

Typical routing pattern — a static routing table plus a station reservation:

```js
function setup(self) {
  var routeTo = { M: 'B' };                  // junction path id → chosen successor id
  self.paths.claim('LoadingBay');            // reserve a zone for this station
  return {
    routing: {
      selectNextPath: function (ids, ctx) { return routeTo[ctx.currentPathId]; },
      onArrive: function (pathId, agvId) { /* track progress */ },
      requestDispatch: function (agvId) { /* assign the next order, e.g. update routeTo */ },
    },
  };
}
```

### Script-to-script messaging (supervisory patterns)

```ts
self.component(path): ScriptComponentHandle | null;
self.broadcast(topic, data?): number;   // returns receiver count
```

`ScriptComponentHandle` exposes `path`, the target's current `.state`, whether it's `.enabled`, its `.error` (from `raiseError`, or `null`), and `.send(topic, data?)`. Delivery is always deterministic in both kernels: a message is scheduled on the *target's* own event list at its current time, so it arrives via the target's `onMessage(topic, data, fromPath)` on its own next event dispatch — never synchronously, never re-entrant into the sender's current call. `broadcast` delivers to every other active script component the same way and returns how many received it.

This is the basis for a supervisory cell coordinator: one script that finds/holds references to several worker scripts and drives them by message rather than by reaching into their internals.

### Typed connections

Messaging above is address-by-path and untyped. A **connection** is the opposite: a directed, *typed* edge drawn between two components, persisted in the scene's `Connections` block (`{ id, source, target, type, config }` — a flat edge array, the same shape the inspector and the visible cable render from). A script never names the partner; it names the **connection type** and the engine routes over whatever edges exist.

Conceptually one connection is a **named bidirectional call**: the source sends request parameters, the target answers — usually deferred — through a reply handle.

```ts
self.connection(type: string): ConnectionHandle;

interface ConnectionHandle {
  readonly type: string;
  call(params?: Record<string, unknown> | null,
       onReply?: (response: Record<string, unknown>) => void): number;
}
```

- `call()` fires **all** outgoing edges of this component that carry `type` — it is 1:n, and returns the **delivered count**. `onReply` may therefore fire once *per replying target*.
- Replies are **always deferred**. A reply may originate inside another component's VM call, so the registry queues it and flushes after the tick pass — never synchronously inside `call()`, never re-entrant.
- `params` are validated against the type's declared signature before delivery.
- A cyclic edge set (A→B→A) is capped by a re-entrancy depth guard: the dispatch terminates instead of hanging.
- In a host environment without a connection backend, `call()` logs one warning and returns `0`.

Two categories of type share that one mechanism:

| Category | Signature lives in | Behavior lives in |
|---|---|---|
| **Built-in** (engine-semantic), e.g. `StopOnExit` | code (`registerBuiltinConnectionType`) | the engine |
| **User-defined** | data — a `connectionTypes` entry, `{ type, request, response }` with per-parameter wire types `bool \| int \| float \| string` | the scripts on both ends |

#### Receiving a request — `onRequest(topic, params, reply)`

The target of a user-defined connection declares `onRequest`. The `reply` handle is callable **exactly once** — a second call is a warned no-op — and may be called now or many ticks later:

```js
function setup(self) {
  return {
    onRequest: function (topic, params, reply) {
      if (topic !== 'Measure') return;
      // Answer later: park the reply handle and call it when the work is done.
      self.in(self.prop.MeasureTime || 2, 'measured', null, { reply: reply });
    },
    des: {
      on: function (hook, mu, data) {
        if (hook === 'measured') data.reply({ ok: true, value: 42 });
      },
    },
  };
}
```

And the calling side:

```js
self.connection('Measure').call({ target: 'A' }, function (resp) {
  self.log('measured', resp.value);
});
```

#### Receiving an MU — `onArrival(mu)`

The built-in **`StopOnExit`** type (per-edge config: `ProcessTime`, a float, default `0`) wires a sensor to a station script. When an MU reaches the connected sensor the **engine holds it** — an accumulating surface holds that single MU while the belt keeps running; a non-accumulating surface or an instanced MU stops the belt, which on a shared drive halts the whole line — and hands it to the target script:

```js
function setup(self) {
  return {
    // The MU arrives ALREADY HELD. Nothing releases it but this script.
    onArrival: function (mu) {
      self.in(self.prop.ProcessTime || 1, 'done', mu);
    },
    des: {
      on: function (hook, mu) {
        if (hook === 'done') mu.release();   // <- REQUIRED, or the line stays blocked
      },
    },
  };
}
```

> **The single rule of `onArrival`: the MU is already held when you get it.** There is no timeout and no automatic release. A script that forgets `mu.release()` blocks that station — and, on a shared drive, the line behind it — for the rest of the run.

### Math (pure in-VM value math)

`self.vec3`, `self.quat`, `self.mat4`, `self.aabb` are callable + method libraries operating purely on plain `{x,y,z}` / `{x,y,z,w}` / `number[]` / `{min,max}` values — no boundary crossing per call:

| Library | Selected members |
|---|---|
| `vec3` | `(x,y,z)` constructor, `add/sub/scale/dot/cross/length/lengthSq/normalize/distance/lerp/angleTo/project/reflect/applyQuat/applyMat4/negate/equals` |
| `quat` | `(x,y,z,w)` constructor, `fromAxisAngle/fromEuler/mul/conjugate/invert/normalize/slerp/angleTo/lookRotation` |
| `mat4` | `identity/multiply/invert/compose/transformPoint/transformDir` |
| `aabb` | `fromNodes/size/center/longestAxis/overlaps/contains` |

Plus `self.DEG2RAD`, `self.RAD2DEG`, and `self.clamp(x, lo, hi)`.

### Determinism

The sandbox deliberately does not expose `Date`, `Math.random()`, `setTimeout`, or `setInterval` — none of these exist inside the VM. Time comes only from `self.now` (virtual sim time) and randomness only from the seeded `self.random()`. This is what makes a script reproducible run-to-run and portable between the continuous kernel (real-time ticks) and the event kernel (time jumps between events) without behavior drift.

## Writing DES-safe scripts

A script is *DES-safe* when its only source of "doing things over time" is the event backbone (`self.in`/`self.at`/`self.every`, `sensor.on`, `signal.on`, `des.on`) rather than polling `continuous.fixedUpdate` every tick. DES-safe scripts run identically fast whether the model is being watched in real time or fast-forwarded through a headless event-based run.

The build-time save pipeline runs a text-based lint (`rv-des-lint`) over every script before it is allowed to swap in:

| Rule | Trigger | Severity |
|---|---|---|
| `fixed-update` | A `continuous.fixedUpdate` handler is declared at all. | Warning (component is continuous-only); **error** if the component declares `DesSafe: true`. |
| `dt-accumulation` | A `dt`-accumulation pattern (`x -= dt`, `x += dt`, `x = x - dt`) — a tick-polled timer that silently never fires in the event kernel. | Warning; **error** with `DesSafe: true`. Use `self.in(delaySec, hook)` instead. |
| `blocked-global` | `Date`, `Math.random()`, `setTimeout()`, `setInterval()` used anywhere in the code. | Always **error** — these are not exposed in the sandbox at all; the message explains why instead of leaving a bare `ReferenceError`. |
| `closure-state` | A `let`/`var` declared in the `setup()` closure and reassigned later — state that is silently **lost** on a DES snapshot/restore. Suppressed entirely when the script declares an `onSnapshot` hook; `for (let i = …)` loop counters are exempt. | Always **warning**, never escalated — legitimate transient locals would otherwise break the save gate. |
| `geometry-sampling` | `worldPosition()` / `worldQuaternion()` / `worldDirection()` used in a component that also declares a `des:` block. Such a script needs the runner's per-event-time tween settle to read exact positions — which is handled, but keeps the FastForward settle fast path off for the **whole model**. | Always **warning**, never escalated. Prefer carrying positions in event data. |

Setting `DesSafe: true` on the `WebComponent` entry is an author claim, checked (not proven) by this rule set. It escalates **only** `fixed-update` and `dt-accumulation` from advisory warnings to hard save-blocking errors — `blocked-global` is already an unconditional error, and `closure-state` / `geometry-sampling` stay advisory in every configuration. That escalation is the intended way to keep a station script honest as it evolves.

The turntable example below (see [Complete examples](#complete-examples)) shows the idiomatic split: `continuous.fixedUpdate` drives the plain real-time state machine (a rotary axis moving under real physics has no other sensible representation), while the exact same instance also declares `des.canAccept`/`des.onAccept`/`des.on` so the *same* script runs as a proper DES station when an event-based runner is present — computing its own duration with `self.in(...)` instead of counting frames.

## The script editor

Scripts are authored as TypeScript, not raw JavaScript, and validated before anything is swapped into the running scene:

- **Typed against the SDK.** Monaco is configured with `noLib: true` (no `window`/`fetch`/DOM — the author sees exactly the sandbox's surface) plus two injected declaration files: a minimal ambient `lib.d.ts` (the safe subset of `Boolean`/`Number`/`String`/`Array`/`Math`) and the generated `rv-sdk.d.ts` covering `Self`, every handle type, `Vec3`/`Quat`/`Mat4`/`AABB`, and the `Handlers`/`SetupFn` contract. Module syntax is rejected by the compiler options (`module: None`) — stored components are plain scripts against the global `setup` convention, never ES modules.
- **Save pipeline (TS → JS, then validated, then swapped):**
  1. The Monaco TypeScript worker transpiles the model to plain JS (type erasure only — no bundling).
  2. A parse check (`new Function(js)`, never executed) and an explicit module-syntax guard catch anything the transpiler let through structurally invalid or module-shaped.
  3. The DES-safety lint runs over the emitted JS (escalated by `DesSafe`).
  4. An `ApiVersion` check rejects code declaring a newer SDK contract version than the running build supports.
  5. Only if every check passes does the save apply: a `setCode` edit op persists into the scene's op log (undoable), followed by a hot-reload of the running instance — old code keeps running untouched if validation failed, so a syntax error or a lint violation never takes down the live component.
- **Editor access.** A toolbar button and an "Edit Script" action on any node's `WebComponent` section in the Property Inspector both open the same floating script editor panel, pointed at the selected node. Monaco itself loads lazily on first open — it is not part of the eager viewer bundle.

## Complete examples

The following scripts are taken directly from the SDK's own end-to-end tests, where they run against a real QuickJS VM (not a mock) — they are proof of what actually executes, not illustrative pseudocode.

### A simple processing gate

A sensor-triggered gate: a part occupies a sensor, the gate's drive swings open, a scheduled event closes it again and reports throughput on signals.

```js
function setup(self) {
  var drive = self.drive('Gate/Drive');
  var gate = self.sensor('Gate/Sensor');
  if (!drive || !gate) return self.disable('missing references');

  var processed = 0;
  self.setState('idle');

  gate.on(function (occ) {
    if (occ && self.state === 'idle') {
      self.setState('processing');
      drive.moveTo(90);
      var t = self.prop.ProcessTime || 1;
      self.in(t, 'done', { id: processed + 1 });
    }
  });

  return {
    des: {
      on: function (hook, mu, data) {
        if (hook === 'done') {
          processed++;
          self.signal('Gate.Done').set(true);
          self.setSignals({ 'Gate.Processed': processed });
          drive.moveTo(0);
          self.setState('idle');
        }
      },
    },
  };
}
```

This is fully DES-safe: it never touches `continuous.fixedUpdate`; all timing goes through `self.in`.

### A turntable (open angle math, snap-graph ports)

A rotary turntable that aligns to whichever conveyor is waiting, receives the part, rotates to a free output and discharges — the angle math is computed live from world positions rather than hard-coded per port, and the same instance answers both kernels' contracts.

```js
function setup(self) {
  const V = self.vec3, drive = self.drive('Drive-Rot-Y'), sensor = self.sensor('Sensor'), belt = self.belt('Transport');
  if (!drive) return self.disable('no rotary drive');

  // Rotation axis + a deterministic (u,v) basis perpendicular to it — computed once.
  const axis = V.normalize(drive.node.worldDirection(V(0, 1, 0)));
  const ref  = Math.abs(axis.x) > 0.9 ? V(0, 0, 1) : V(1, 0, 0);
  const u    = V.normalize(V.cross(axis, ref));
  const vAx  = V.cross(axis, u);

  // Open angle calculation: project the centre→port direction onto the (u,v) plane.
  const angleToPort = (port) => {
    const dir = V.normalize(V.sub(port.node.worldPosition(), self.self.worldPosition()));
    return Math.atan2(V.dot(dir, vAx), V.dot(dir, u)) * self.RAD2DEG;
  };

  let clearTimer = 0, selectedOut = null;
  self.signal('Flow.Run').set(true);
  self.setState('idle');

  sensor?.on((occ) => {
    if (occ && self.state === 'receiving') {
      const out = self.freeOutputs()[0];
      if (!out) return self.setState('holding');
      selectedOut = out.id; drive.moveTo(angleToPort(out)); self.setState('rotating_out');
    } else if (!occ && self.state === 'discharging') {
      clearTimer = 0.5; self.setState('discharge_clearing');
    }
  });

  return {
    continuous: {
      fixedUpdate(dt) {
        switch (self.state) {
          case 'idle':
            belt?.run(false);
            if (self.signal('Flow.Run').bool) {
              const p = self.inputs().find((x) => x.upstreamWaiting());
              if (p) { drive.moveTo(angleToPort(p)); self.setState('aligning_in'); }
            }
            break;
          case 'aligning_in':  if (drive.isAtTarget) { self.setState('receiving');  belt?.run(true); } break;
          case 'rotating_out': if (drive.isAtTarget) { self.setState('discharging'); belt?.run(true); } break;
          case 'discharge_clearing':
            clearTimer -= dt; if (clearTimer <= 0) { belt?.run(false); self.setState('idle'); }
            break;
        }
      },
    },
    des: {
      canAccept: (mu, port) => self.currentLoad < 1 && self.state === 'idle',
      onAccept(mu, port) {
        const out = self.freeOutputs()[0];
        if (!out) { self.setState('holding'); return true; }
        selectedOut = out.id;
        self.in(Math.abs(angleToPort(out)) / (self.prop.RotationSpeed ?? 45), 'rotated', mu);
        self.setState('rotating_out'); return true;
      },
      on(hook, mu) {
        if (hook === 'rotated') {
          self.transfer(mu, self.outputs().find((p) => p.id === selectedOut));
          self.setState('idle');
        }
      },
    },
  };
}
```

Note the honest limit here: `continuous.fixedUpdate` makes this component's real-time behavior continuous-only by the DES lint's own rule (a) — it is deliberately *not* claimed `DesSafe: true`. The `des` block lets the exact same script also run correctly under an event-based runner; the two code paths share the angle math and the port/state vocabulary, but the physical rotation itself is only simulated tick-by-tick in the continuous kernel.

### A supervisory cell coordinator

One script drives two worker scripts purely over messages, and reacts to an error raised by either of them:

```js
// worker script (used for both Cell/Worker1 and Cell/Worker2)
function setup(self) {
  self.setState('idle');
  return {
    onMessage: function (topic, data, from) {
      if (topic === 'start') self.setState('running');
      if (topic === 'halt') self.setState('halted');
    },
    jam: function () { self.raiseError('E1', 'jam'); },
  };
}
```

```js
// supervisor script (Cell/Supervisor)
function setup(self) {
  var workers = ['Cell/Worker1', 'Cell/Worker2'];
  var phase = 'boot';
  self.setState('boot');
  return {
    continuous: {
      fixedUpdate: function (dt) {
        if (phase === 'boot') {
          workers.forEach(function (w) { self.component(w).send('start', null); });
          phase = 'supervising'; self.setState('supervising');
          return;
        }
        if (phase === 'supervising') {
          for (var i = 0; i < workers.length; i++) {
            var w = self.component(workers[i]);
            if (w && w.error) {
              self.broadcast('halt', { because: w.path });
              phase = 'halted'; self.setState('halted');
              return;
            }
          }
        }
      },
    },
  };
}
```

Booting sends `start` to every worker (delivered on each worker's next tick, so `self.component(w).state` still reads `'idle'` in the same call that sent it). Once any worker raises an error, the supervisor broadcasts `halt` to all of them and halts itself — the whole cell reacts to one component's failure without any of the scripts reaching into each other's internals.

## Reference tables

### `self` — core

| Member | Signature |
|---|---|
| `self.name`, `self.path` | `string` |
| `self.self` | `NodeHandle` |
| `self.node(pathOrName)` | `(string) => NodeHandle \| null` |
| `self.find(type, pathOrName)` | `(string, string) => ComponentHandle \| null` |
| `self.findAll(type)` | `(string) => ComponentHandle[]` |
| `self.children(type?)` | `(string?) => NodeHandle[]` |
| `self.state` / `self.setState(next)` | `string` / `(string) => void` |
| `self.prop` | `{ [k: string]: number \| string \| boolean \| null }` |
| `self.now` | `number` |
| `self.random()` | `() => number` |
| `self.enabled` / `self.disable(reason)` | `boolean` / `(string) => void` |
| `self.log/warn/error(...args)` | `(...unknown[]) => void` |
| `self.raiseError(code, message?)` / `self.clearError()` | — |

### `self` — component shortcuts

| Member | Returns |
|---|---|
| `self.drive(p)` | `DriveHandle \| null` |
| `self.sensor(p)` | `SensorHandle \| null` |
| `self.belt(p)` | `BeltHandle \| null` |
| `self.transport(p)` | `TransportHandle \| null` |
| `self.source(p)` | `SourceHandle \| null` |
| `self.sink(p)` | `SinkHandle \| null` |
| `self.grip(p)` | `GripHandle \| null` |
| `self.logicStep(p)` | `LogicStepHandle \| null` |

### `self` — signals, scheduling, math

| Member | Signature |
|---|---|
| `self.signal(name)` / `self.signalAt(path)` | `SignalHandle` |
| `self.setSignals(updates)` | `({[k:string]: boolean\|number}) => void` |
| `self.in(delaySec, hook, mu?, data?)` | `=> number` (event id) |
| `self.at(timeSec, hook, mu?, data?)` | `=> number` |
| `self.every(intervalSec, hook, data?)` | `=> number` |
| `self.cancel(eventId)` | `(number) => void` |
| `self.vec3` / `self.quat` / `self.mat4` / `self.aabb` | Math libraries |
| `self.DEG2RAD` / `self.RAD2DEG` / `self.clamp(x,lo,hi)` | — |

### `self` — material flow and supervisory

| Member | Signature |
|---|---|
| `self.inputs()` / `self.outputs()` / `self.freeOutputs(mu?)` | `=> Port[]` |
| `self.ports` | `ReadonlyArray<Port>` |
| `self.downstreamOccupied(port?)` / `self.downstreamCanAccept(mu, port?)` | `=> boolean` |
| `self.transfer(mu, fromPort?)` / `self.spawn()` | — / `=> MU` |
| `self.mus` / `self.currentLoad` | `ReadonlyArray<MU>` / `number` |
| `self.statState(name)` / `self.statOutput(n?)` / `self.statCycleStart()` / `self.statCycleEnd()` | Statistics sink |
| `self.paths.list()` / `self.paths.get(id)` / `self.paths.successors(id)` | Path-graph queries (`PathDesc` plain JSON, mm lengths) |
| `self.paths.claim(zoneId, holderId?)` / `.release(...)` / `.isHolder(...)` | Zone reservation (shared with the AGV traffic control) |
| `self.component(path)` | `=> ScriptComponentHandle \| null` |
| `self.broadcast(topic, data?)` | `=> number` (receiver count) |
| `self.connection(type)` | `=> ConnectionHandle` — `.call(params?, onReply?) => number` (delivered count) |

### Handlers — the returned object

| Handler | Signature | Phase reported to `onError` |
|---|---|---|
| `continuous.fixedUpdate` / `lateFixedUpdate` / `teardown` | `(dt: number) => void` / `(dt: number) => void` / `() => void` | `'fixedUpdate'` |
| `des.canAccept` / `des.onAccept` | `(mu: MU, port?: Port) => boolean` | `'hook'` |
| `des.on` | `(hook: string, mu: MU \| null, data?: unknown) => void` | `'hook'` |
| `des.onDownstreamReady` | `(port: Port) => void` | `'hook'` |
| `routing.selectNextPath` | `(candidateIds: string[], ctx: RouteContext) => string \| void` | `'routing'` |
| `routing.onArrive` / `requestDispatch` | `(pathId, travelerId) => void` / `(travelerId) => void` | `'routing'` |
| `onSignal` | `(name: string, value: boolean \| number) => void` | `'signal'` |
| `onReset` | `() => void` | `'reset'` |
| `onMessage` | `(topic: string, data: unknown, fromPath: string) => void` | `'message'` |
| `onArrival` | `(mu: MU) => void` — **the MU is already held; call `mu.release()`** | `'hook'` |
| `onRequest` | `(topic, params, reply) => void` — `reply` callable exactly once | `'hook'` |
| `onSnapshot` / `onRestore` | `() => unknown` / `(state: unknown) => void` — both synchronous | `'snapshot'` |
| `onError` | `(err: unknown, phase: ErrorPhase) => boolean \| void` | — |

## See also

- [Component Behaviors](doc-behaviors.md) — the native-TypeScript wiring layer script components sit alongside.
- [Extending realvirtual WEB](doc-extending-webviewer.md) — plugins, UI slots, and how components map from Unity to the viewer.
