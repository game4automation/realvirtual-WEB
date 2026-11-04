# Component Scripting (JS-in-GLB)

For event-kernel state, timers and continuation, see [DES scripting](doc-des-scripting.md). Scripts in the bundled demo project run without `?scripts`; see [Security and trust](#security-and-trust) for the trust boundary.

> **Applies to:** Community runtime and public extension APIs. Examples of commercial or optional integrations require the corresponding feature or separate product.
> **Reference baseline:** 6.3.43, documentation reviewed 2026-09-16.
> See the [edition comparison](README.md#community-edition-vs-commercial) and [getting started](doc-getting-started.md).

For a complete public project using `scriptRef`, follow the [Community project plugin](doc-project-plugin-example.md).

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

### Binding a script to a document

You do **not** edit `project.json` to make the binding. Open the project in the dashboard, select the document, and use the third reference slot on its hero card — **PLUGIN**, next to CONNECT and KNOWLEDGE:

- **Drag** a `.ts`/`.tsx` file from the project tree onto the slot. Only files under the project's `plugins/` folder are accepted; anything else is refused with the reason on the spot.
- **Or bind it from the keyboard** — the card's *Bind plugin…* entry opens a dialog listing the project's script files, so the binding needs no mouse.
- The chip then shows the bound file name. Clicking it jumps to the file; the **×** clears the binding.

The chip also carries the **state** of the binding, which is the part a JSON edit could never show: bound, loaded, a file that is not there any more, a file with no `registerModelPlugins`/`unregisterModelPlugins` pair, or an error while importing or registering. A binding that used to fail silently in the browser console is now visible on the card.

Over MCP the same write is `web_execute("document.bind", {document, field, ref})` — `field` takes `scriptRef` or its aliases `script` / `plugin`, and the binding is cleared when `ref` is omitted.

A document points at the module it wants, which may be the plugin file **itself** (`plugins/ribbon-tension-controls-plugin.tsx`). A collecting `plugins/index.ts` that re-exports several plugins is no longer needed and is no longer the recommended shape: one plugin, one file, one `scriptRef`.

### How project code is loaded — two modes, one reference

The same `scriptRef` is resolved two ways, in this order:

1. **Build mode.** The module was part of the viewer build (`import.meta.glob` found it). Nothing extra is needed; the reference only says *which* bundled module belongs to *which* document.
2. **Runtime mode.** The module is **not** in the build — a project folder copied onto a machine whose viewer was built without it. The viewer then looks for the compiled **`.js` sibling** next to the referenced `.ts` (`scripts/a.ts` → `scripts/a.js`), reads it out of the project and imports it dynamically.

A `scriptRef` that resolves to neither loads **no** plugins. There is deliberately no fallback to the old name-based match: binding the wrong code is worse than binding none.

**Producing the sibling.** Compilation happens on the dev/delivery path, not in the browser — and on the delivery path it happens **by itself**. A maintainer customer delivery (the private workspace’s `npm run deliver:customer`, not a command in this Community repository; see [Deployment](doc-deploy.md)) compiles every `scriptRef` of every delivered project in the **staged copy** it assembles, before anything is committed or pushed, and a script that does not compile stops the delivery. So nothing has to be built by hand before a delivery, and no `.js` is ever written into the source tree.

The command exists for the two cases the delivery does not cover — building the siblings locally to try runtime mode out, and verifying **between** deliveries that the sources still compile:

```bash
npm run build:project-scripts -- <projectDir>          # build the .js siblings locally
npm run build:project-scripts -- <projectDir> --check  # verification between deliveries: exit 3 if missing/stale
```

`--check` is a *reporting* gate: it never produces an artefact, so it can only be run where the siblings already exist. In a clean project tree there are none — which is exactly why it is not the delivery gate.

The artefact is a **self-contained ES module** (esbuild, `bundle: true`, `format: esm`): it is imported from a Blob URL, which has no directory, so a relative `import './util'` inside it could not resolve. Bare package imports (`three`, `react`, `@mui/material`, `@rv/*`) are left external by the compiler, but the viewer installs **no import map**: a Blob-URL module cannot resolve a bare specifier, so such an import fails at load time. Bundle what you need, or take it from the viewer/plugin context instead of importing it.

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
- **Trust gate.** Loading a GLB that contains `WebComponent` entries never runs them automatically. The viewer logs how many script components were found and stays inert until scripting is explicitly allowed — via the `?scripts` URL parameter, or programmatically via the plugin's `setAllowScripts(true)`. Toggling the gate off disposes every running instance; toggling it on re-wires the currently loaded model. One exception: a document of the **bundled demo project** — bytes read unmodified over HTTP, without a redirect, from this origin's own `<base>/demo-realvirtual/` folder and tokened at the fetch itself (a caller cannot name a source) — runs its own scripts without the opt-in, because those files carry the same trust as the viewer code served beside them (`src/core/engine/rv-script-trust.ts`; the log line then reads `execution enabled: bundled demo project`). The same GLB from another origin, a linked or local project folder, a file drop, a stored draft, a document with edits applied, an authoring load or content placed inside the demo document stays behind the gate.
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

- **`continuous.fixedUpdate(dt)`** — runs every 60 Hz simulation tick, before the frame's drive physics settle (`WebComponentPlugin` calls it from `onFixedUpdatePre`). In DES it is display-only and runs only with animation; see [Time model](#time-model).
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

See [DES snapshot developer contract](doc-des-snapshot.md) for participants, preflight and restore limits.

Call `self.persist(initial)` once during setup to declare runtime state. Keep the
returned live object; restore replaces its contents in place. Initial and captured
values must be plain JSON contract data: no functions, handles, aliases, cycles,
accessors, sparse arrays, reserved `$map`/`$set`/`$num` keys, non-finite numbers or `-0`.

```js
function setup(self) {
  const st = self.persist({ count: 0 });
  self.in(5, 'cycle');
  return {
    des: { on(hook) {
      if (hook !== 'cycle') return;
      st.count++;
      self.in(5, 'cycle');
    } },
  };
}
```

The snapshot also preserves seeded RNG position, FSM state, pending hook events
and `self.every` timer data and IDs. Do not re-arm timers in `onRestore`: doing so
duplicates restored events. `onSnapshot()` / `onRestore(state)` remain a synchronous
legacy facade with separately validated data; they do not exempt closure state
from the AST check. `self.prop` is read-only configuration; use `self.persist` for
runtime state.

Timers: use `self.in`, `self.at` and `self.every` only. Pending slices are saved with the
event queue; keep the id returned by `self.every` in the persist object if you need to
cancel it. `setTimeout`, `setInterval`, `Date` and `Math.random` are not available, and
`dt` countdowns in `continuous.fixedUpdate` must not drive DES state.

Not saved: callbacks registered after setup, script KPI statistics (`statState`
statistics) and `self.prop` writes. Register callbacks in `setup`.

Conversion pattern (closure variable to persisted state):

```js
// refused: des-script-undeclared-state
let count = 0;
function setup(self) { return { des: { on() { count++; } } }; }

// accepted
function setup(self) {
  const st = self.persist({ count: 0 });
  return { des: { on() { st.count++; } } };
}
```

Complete example: `examples/scripts/des-counter-persist.js` (persist object, `self.every`
timer id, no re-arming). For the user-facing page see "Saving and Restoring a Run" in the
DES documentation.

The Acorn AST gate refuses undeclared setup/module state, captured mutable locals,
factory-created handlers and writes to global or captured properties. Use literal
handlers with constants, `self`, their own locals and the persist object. Resolve
SDK handles inside handlers rather than storing them in setup bindings. In DES
mode `des-script-undeclared-state` is an error and the script is not bound; each
finding gives a line and the hint `use self.persist(...)`.

### Hot reload is always cold

Editing and saving a script tears the old instance down completely — host-side subscriptions unsubscribed, pending `self.in`/`self.at`/`self.every` timers cancelled, VM handles released, the kernel adapter detached — and mints a brand-new one that runs `setup()` again from scratch. There is no warm state transfer: closure variables from the old instance are gone, exactly like a fresh simulation start for that one component. This keeps the reload path simple and guarantees a disposed instance can never leak a stray event into its successor.

## The `self` API

Everything a script can do goes through `self`, the single argument to `setup`. Only plain data crosses the VM boundary — nodes and components are represented as opaque handles whose reads and methods are host calls; there are no Three.js objects inside the sandbox, and world reads always come back as plain `{x,y,z}` / `{x,y,z,w}` / `number[16]` / `{min,max}` objects, never class instances.

### Identity, state, props

| Member | Description |
|---|---|
| `self.name` | The component node's leaf name. |
| `self.path` | Full hierarchy path of the component node (also the default RNG v1 script seed source). |
| `self.self` | A `NodeHandle` for the component's own node. |
| `self.state` / `self.setState(name)` | A free-form state string, readable by other script components via `component(path).state` and mirrored into per-component statistics. Separate from `statState()` — the FSM phase never pollutes the utilization statistics. |
| `self.persist(initial)` | Call once during setup; returns the live JSON state object restored in place. |
| `self.prop` | The `{ [key]: PropValue }` bag of extra fields on the `WebComponent` entry (numbers, strings, booleans, or `null`). **Read-only configuration** — writes stay VM-local, never reach the host and are not persisted; use `self.persist(...)` for runtime state. |
| `self.now` | Virtual simulation time in seconds — advances only through ticks (continuous) or the event scheduler (DES kernel). Never wall-clock. |
| `self.random()` | Mulberry32: v1 defaults to a path-derived seed; DES v2 derives the seed from masterSeed, component id and purpose `script`. The same model, run seed and draw order reproduce the sequence. Setup draws and scripts created after start retain their initial seed until the next applicable reset/start. See [DES randomness](doc-des-randomness.md#script-rng-contract-v5). There is no `Math.random()` in the sandbox. |
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
| `SourceHandle` | `automatic` (settable), `interval` (settable) | `spawn()` → `MU` or `null` when disabled, capped, or missing a template |
| `SinkHandle` | — | `on(cb)` → unsubscribe function, called with the arriving `MU` |
| `GripHandle` | `gripped` (`MU[]`), `range` | `pick()`, `place()` |
| `LogicStepHandle` | `state` (`'Idle'\|'Active'\|'Waiting'\|'Finished'`), `progress`, `runId` | `start()`, `reset()`, `complete()` (JavaScript steps only) |

The live viewer wires drive, sensor, belt, transport, source, sink, grip and logic-step handles. Use full hierarchy paths and check for missing components. Source spawning goes through the continuous transport manager, including limits, counters, collision roles and lifecycle hooks. Sink subscriptions are removed when the script is disposed or reloaded.

### Scene component access

The web host exposes all registered scene components for discovery. Reads return schema fields and component live-state values as plain data; engine objects and private fields are not exposed.

```js
const sources = self.scene.list('Source'); // omit type to list all components
const values = self.scene.read('Festo/LogoSource', 'Source');
self.scene.set('Festo/LogoSource', 'Source', 'Enabled', true);
```

Writes accept editable runtime scalar, enum and vector fields. Vectors use viewer coordinates. Read-only fields, invalid values, private fields and live-controlled components reject writes. Use signal handles for signal values and the scene editor for changing component references. Complex engine objects read as `null`; scene access does not expose arbitrary engine methods. Use typed handles for commands. These writes affect the running simulation; they do not save changes into the GLB. Unity-only components without a web implementation are unavailable.

### Web-native JavaScript logic steps

On a node beneath your sequence, author both `LogicStep_JavaScript: { Active: true }` and a normal `WebComponent` containing its `Code`. This is a pure web feature and needs no Unity counterpart. Enable scripts through the existing script trust controls. Open the node's script editor to edit and hot-reload the code.

The sequence activates the step. The script reads `self.logicStep(self.path)` and calls `complete()` when its work is done. The sequence then advances. `runId` increases on each start, allowing the script to recognize a new cycle even when the sequence restarts within one frame. A disabled or failed script leaves the step waiting instead of silently advancing.

The complete [random Source example](examples/scripts/random-source-step.js) uses `self.random()` to generate 1–3 parts, spaces them by 0.3 simulation seconds, retries when the Source is capped, and completes the step after the final part. Keep the Source's independent interval and automatic generation disabled when the script should be its sole trigger. The saved pick-and-place sequence continues to generate exactly three parts; this example is optional.

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
self.at(timeSec, hook, mu?, data?): number;    // absolute virtual time (event kernel: < self.now throws)
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
  const st = self.persist({ routeTo: { M: 'B' } });                  // junction path id → chosen successor id
  self.paths.claim('LoadingBay');            // reserve a zone for this station
  return {
    routing: {
      selectNextPath: function (ids, ctx) { return st.routeTo[ctx.currentPathId]; },
      onArrive: function (pathId, agvId) { /* track progress */ },
      requestDispatch: function (agvId) { /* assign the next order, e.g. update st.routeTo */ },
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

## Time model

In continuous mode, Model-Scripts (`WebComponent`) use the frame clock. In every DES run (animated, fast-forward or batch, including every replication), `self.now` and `self.in` / `self.at` / `self.every` use the DES event clock. Each run or replication rebuilds every script from its initial state, including persist, FSM and timers. With RNG v2, the run seed is derived from the master seed and script address and is available already in `setup()`; legacy v1 keeps path-based seeding. After run end, instances keep their end state until rebind or unbind, so final KPI values remain readable.

During DES, `fixedUpdate` and `lateFixedUpdate` run only with animation (animated, hybrid or step), never in fast-forward or batch. They are display-only: SDK reads and logging are allowed; state-changing SDK calls throw `des-frame-hook-write`, with one warning per script instance. `self.random()` draws made in a frame hook are rolled back. Guest-local writes to persist or closure variables are **not prevented**: authors must not change them in frame hooks. The `fixed-update` lint warns about this pattern; put state and KPI changes in DES events.

## Writing DES-safe scripts

A script is *DES-safe* when its only source of "doing things over time" is the event backbone (`self.in`/`self.at`/`self.every`, `sensor.on`, `signal.on`, `des.on`) rather than polling `continuous.fixedUpdate` every tick. DES-safe scripts run identically fast whether the model is being watched in real time or fast-forwarded through a headless event-based run.

The save pipeline runs text rules and a lazy Acorn AST state check (`rv-des-lint`) over every script before it is allowed to swap in:

| Rule | Trigger | Severity |
|---|---|---|
| `fixed-update` | A `continuous.fixedUpdate` handler is declared at all. | Warning (display-only in DES); **error** if the component declares `DesSafe: true`. |
| `dt-accumulation` | A `dt`-accumulation pattern (`x -= dt`, `x += dt`, `x = x - dt`) — a tick-polled timer that silently never fires in the event kernel. | Warning; **error** with `DesSafe: true`. Use `self.in(delaySec, hook)` instead. |
| `blocked-global` | `Date`, `Math.random()`, `setTimeout()`, `setInterval()` used anywhere in the code. | Always **error** — these are not exposed in the sandbox at all; the message explains why instead of leaving a bare `ReferenceError`. |
| `des-script-undeclared-state` | Undeclared setup/module or captured state, factories, global/property writes. Legacy hooks do not exempt a script. | Warning, including at DES binding; **error** with `DesSafe: true`. Snapshot capture/restore refuses it. Use `self.persist(...)`. |
| `geometry-sampling` | `worldPosition()` / `worldQuaternion()` / `worldDirection()` used in a component that also declares a `des:` block. Such a script needs the runner's per-event-time tween settle to read exact positions — which is handled, but keeps the FastForward settle fast path off for the **whole model**. | Always **warning**, never escalated. Prefer carrying positions in event data. |

Setting `DesSafe: true` escalates tick polling and undeclared state to save-blocking
errors. Without that claim, undeclared-state warnings allow execution on the DES
clock, but snapshot capture/restore refuses them. Geometry sampling remains advisory.

### Fast-forward settle gate

In FastForward the DES runner settles every running tween at each new event time only while
something may read live geometry. A Model-Script turns this per-event settle on only when
(plan-2212 Phase 4b):

- it declares `des: { samplesLiveGeometry: true }` (explicit opt-in — always settle), or
- a conservative static check (`desScriptMayReadLiveGeometry`, Acorn) cannot prove the source
  geometry-free.

The check proves "geometry-free" only when all of these hold:

- `setup` is declared exactly once as a top-level `function setup(self)` or
  `const|let|var setup = function|arrow`, and the name `setup` occurs nowhere else;
- every use of `self` (and of setup's first parameter) is a plain, non-computed member access to
  one of `now`, `in`, `at`, `every`, `cancel`, `statValue`, `statState`, `statOutput`,
  `statCycleStart`, `statCycleEnd`, `persist`, `state`, `setState`, `prop`, `random`, `name`,
  `path`, `enabled`, `disable`, `log`, `warn`, `error`, `raiseError`, `clearError`, `sink`,
  `component`, `broadcast` and the math helpers (`vec3`, `quat`, `mat4`, `aabb`, `DEG2RAD`,
  `RAD2DEG`, `clamp`) — `sink` / `component` only as a direct call;
- handles stay opaque: every hook, callback and station argument (hydrated MUs, ports, message
  data), every `self.sink(...)` / `self.component(...)` result, every member read of one
  (`mu.id`, `mu.prop.sku`) and every call result of one (`s.on(cb)`, `p.occupied()`) may only be
  compared (`===`, `!==`, `==`, `!=`), tested (`if (s)`, `s &&`, `!s`, `typeof`), read further
  member by member, called, used as a bare statement or bound with `const`. Passing one to any
  function (also `self.log` / `self.statValue`), spreading, returning, storing (also
  `st.l.push(mu.id)`), iterating, templating or destructuring it keeps the settle on, and so does
  writing a member of one (`p.copy = ...`, `mu.n++`, `delete mu.x`);
- the source has no dynamic member access or key, no `.node` / `.partner` / `.worldAngle` /
  node-handle read / `position` / `direction` / `constructor` / `prototype` / `toJSON` /
  `valueOf` / `__*` name, no
  `onSignal` handler, and no `this`, `with`, `import()`, `globalThis`, `eval`, `Function`,
  `arguments` or reflection (`JSON`, `Object`, `Reflect`, `Proxy`, `structuredClone`, `Symbol`).

Anything else keeps the settle on: a needless settle costs time, a missing one would return
stale positions. The typical monitor (`self.sink(...).on` + `self.every` + `self.statValue` on
its own counters, MU fields only compared) runs without it; a monitor that stores or logs
`mu.id` keeps the settle on.

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
  const st = self.persist({ processed: 0 });
  self.setState('idle');

  self.sensor('Gate/Sensor').on(function (occ) {
    const drive = self.drive('Gate/Drive');
    if (occ && self.state === 'idle') {
      self.setState('processing');
      drive.moveTo(90);
      var t = self.prop.ProcessTime || 1;
      self.in(t, 'done', { id: st.processed + 1 });
    }
  });

  return {
    des: {
      on: function (hook, mu, data) {
        if (hook === 'done') {
          st.processed++;
          self.signal('Gate.Done').set(true);
          self.setSignals({ 'Gate.Processed': st.processed });
          self.drive('Gate/Drive').moveTo(0);
          self.setState('idle');
        }
      },
    },
  };
}
```

This is fully DES-safe: it never touches `continuous.fixedUpdate`; all timing goes through `self.in`.

### A turntable (open angle math, snap-graph ports)

A DES turntable computes its rotation duration inside the accepting handler and
persists only the selected output ID. Ports and drive handles remain local.

```js
function setup(self) {
  const st = self.persist({ selectedOut: null });
  self.setState('idle');
  return {
    des: {
      canAccept: (mu, port) => self.currentLoad < 1 && self.state === 'idle',
      onAccept(mu, port) {
        const out = self.freeOutputs()[0];
        if (!out) { self.setState('holding'); return true; }
        const V = self.vec3;
        const drive = self.drive('Drive-Rot-Y');
        const axis = V.normalize(drive.node.worldDirection(V(0, 1, 0)));
        const ref = Math.abs(axis.x) > 0.9 ? V(0, 0, 1) : V(1, 0, 0);
        const u = V.normalize(V.cross(axis, ref));
        const v = V.cross(axis, u);
        const dir = V.normalize(V.sub(out.node.worldPosition(), self.self.worldPosition()));
        const angle = Math.atan2(V.dot(dir, v), V.dot(dir, u)) * self.RAD2DEG;
        st.selectedOut = out.id;
        self.in(Math.abs(angle) / (self.prop.RotationSpeed ?? 45), 'rotated', mu);
        self.setState('rotating_out'); return true;
      },
      on(hook, mu) {
        if (hook === 'rotated') {
          self.transfer(mu, self.outputs().find(p => p.id === st.selectedOut));
          self.setState('idle');
        }
      },
    },
  };
}
```

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
| `self.statState(name)` / `self.statOutput(n?)` / `self.statCycleStart()` / `self.statCycleEnd()` | Material-flow kernel utilization/throughput statistics; do not create hub rows |
| `self.statValue(key, value, unit?, group?)` | `=> void` — row in Statistics → Scripts; `value: number \| string \| null` |
| `self.paths.list()` / `self.paths.get(id)` / `self.paths.successors(id)` | Path-graph queries (`PathDesc` plain JSON, mm lengths) |
| `self.paths.claim(zoneId, holderId?)` / `.release(...)` / `.isHolder(...)` | Zone reservation (shared with the AGV traffic control) |
| `self.component(path)` | `=> ScriptComponentHandle \| null` |
| `self.broadcast(topic, data?)` | `=> number` (receiver count) |
| `self.connection(type)` | `=> ConnectionHandle` — `.call(params?, onReply?) => number` (delivered count) |

### `self.statValue` — Statistics window rows

`self.statValue(key, value, unit?, group?)` shows a row in the **Statistics** window's
**Scripts** section. The last value for each key within a script instance wins. Rows group
by `group`, or by the script's node path when omitted (enable **Group by group** in the
window). Units are display-only. `value` must be `number | string | null`; anything else
throws. Rows disappear with the script instance, including hot reload and model clear.

```javascript
self.statValue('Waiting', self.currentLoad, 'items', 'Dispatch');
self.statValue('Status', 'Ready'); // grouped under this script's node path
```

`statState`, `statOutput` and `statCycle*` remain the material-flow kernel's
utilization/throughput statistics API, unchanged; they do not create hub rows. For plugin
and GLB-component contributions, see [Statistics contributions](doc-extending-webviewer.md#8e-statistics-contributions-plan-2011).

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

## Parametric part families (plan-650, preview)

A **parametric part family** is a document whose node carries a `ParametricComponent`: base
parts, a parameter schema and a small JavaScript *rule part*. Changing a value builds a new
**variant** from the same base parts — duplicated, stretched, bent and positioned — and bakes it.
It is the second, much narrower use of QuickJS next to script components: the rule part is a
**pure function** run once per variant, never during the simulation. The authoring recipe for
agents is `web_help("parametric")` (`src/plugins/mcp-bridge/help/parametric.md`); reference
rules are `examples/parametric/rm8110.js`, `rm8120.js` and `aluprofile.js`. The schema entry is
`schema/v1/specification.md` § 7a.67.

> **Preview.** `ParametricComponent` is not authorable from the Add Component menu yet
> (`PARAMETRIC_AUTHORABLE = false` in `src/core/engine/rv-parametric-component.ts`). Families are
> created with `web_editor_parametric_define`; everything else (inspector mask, placement
> parameters, share bundle) is live.

### Data model

```
<Family node>  [ParametricComponent: ApiVersion, Params, Values, Code, CodeHash,
 │                                   PartsRoot?, GeneratedRoot?, BakedInputHash?, Uses?]
 ├─ _Parts       (PartsRoot — the base parts, each direct child is one part; hidden)
 └─ _Generated   (GeneratedRoot — the baked variant for Values)
```

- `Params[]` — `{Name, Label?, Type: number|int|bool|enum, Unit?: mm|deg|'', Min?, Max?, Step?,
  Enum?, Default}`. Signal types are refused as parameters.
- `Values` — the values of the variant baked into `_Generated`. Before every run they are
  **normalized**: default filled in, `int` rounded, snapped to `Step`, clamped to `Min`/`Max`; an
  `enum` value outside `Enum` is an error, never silently clamped.
- `Code` defines `function generate(values, parts)`; `parts` is `[{name, boundsMm:{min,max}}]`.
- `Uses[]` — declared child families `{Family, FamilyNodeId, DocHash, Path?}` (see *Nested
  families*).

### Generator sandbox and budgets

`src/core/engine/rv-parametric-generator.ts` owns its **own QuickJS runtime** (separate from
`RVScriptHost`, so a generator never evicts running scripts): 16 MB heap, 512 KB stack, a fresh
context per run with no `self`, no host functions, `Date` and `Math.random` removed. A wrapper
calls `generate`, serializes the result with `JSON.stringify` **inside the VM** and checks its
length (≤ 2 MB) — all under the same interrupt budget. The binding budget is **400 interrupt
ticks** (`limit-ticks`); the 200 ms wallclock deadline is only an emergency brake
(`limit-deadline`). The host parses the string and validates the structure: finite numbers,
≤ 5000 instances, ≤ 2000 nodes, ≤ 500 components, ≤ 100 messages, ≤ 64 children, strings
≤ 256 characters, depth ≤ 8, ≤ 16 stretches per instance, ≤ 2 M generated vertices. There is
**no trust gate** — the sandbox has nothing to reach. Every failure is a visible error; the
previous variant stays.

The build plan the rule part returns:

```js
{ instances:  [{ part, name?, positionMm, rotationDeg?, stretch?: [{ axis, atMm, byMm }],
                 bend?: { axis, radiusMm, centerSide, pivot?: 'start' | 'center' } }],
  nodes?:      [{ name, positionMm, rotationDeg? }],     // Snap-*, markers
  components?: [{ node, type, fields }],                 // validated against the registry schemas
  children?:   [{ family, values, positionMm, rotationDeg? }],
  messages?:   [{ level: 'info' | 'warning', text }] }
```

### Assembly

`src/core/engine/rv-parametric-assembly.ts` turns the plan into the `_Generated` subtree.
Instances without stretch **share** the base part's geometry. `stretchGeometry` shifts every
vertex beyond the plane by `byMm` and checks the contract: every triangle crossing the plane must
contain the stretch axis, and a shortening must stop before the nearest shifted vertex — else
`stretch-plane-invalid`, never a silent normal recompute. `bendGeometry` maps a straight part onto
an arc (≤ 2° per segment, stretch runs first); `pivot: 'center'` puts the arc centre at the
instance origin, which a `Radial` `TransportSurface` needs. Coordinates are parts-local
millimetres (SolidCraft axes, Z up); the family converts once (−90° about X, 0.001). Components
with unknown types or fields, signal slots or a nested `ParametricComponent` are refused; a field
pointing across a child boundary (`_Children/…`) is `parametric-cross-reference`.

### Hash contract

One hash (`src/core/engine/rv-parametric-hash.ts`, canonical JSON + SHA-256):
`InputHash = sha256({ApiVersion, CodeHash, Values (normalized), PartsHash[, Uses]})`.
`PartsHash` covers every base part's `{name, localMatrix, geometryHash, materialKey}` — renaming,
moving or recolouring a base part changes it. `Uses` enters only when non-empty, so families
without children keep their hash. `BakedInputHash` is the `InputHash` of the variant baked into the
file; "unchanged" means `InputHash == BakedInputHash`, and then no code runs at all.

### Editor path

`web_editor_parametric_set` and the inspector mask run `regenerateParametric`
(`src/core/editor/rv-parametric-regenerate.ts`): generator → assembly → GLB of `_Generated` →
`putCadGlb` (converter `'parametric'`, `sha256 = InputHash`, `quality = 'param-v1'`) → one
`composite` op (`deleteNode(_Generated)` + `importCad` + `reparentNode` under the family +
`transformNode` + `setField(Values, BakedInputHash)`). One undo step; draft replay reads the same
cache triple. Manual attaches under `_Generated` are refused (`parametric-manual-attach`). The
editor never bakes and keeps `_Parts`.

### Variant cache (placements)

Values live **per placement** in
`AssetOverrides.byAddress["#<familyNodeId>"].ParametricComponent.Values` (an old `byNodeId` record is read as `#<id>`).
`PlacementInstancer.resolveBaked(ref, { overrides })` — used by place, copy, restore/undo and
nested references alike — normalizes them and asks `ModelCache` for a variant. The base key stays
unchanged; the variant key is derived internally as `<bakedKey>#param:<inputHash>` (combinable
with `#split:`). Each variant bakes from its own freshly decoded tree. Before `prepareAndBake` an
awaited step looks the variant up in the browser CAD-GLB cache (hit → no generator run), else runs
generator + assembly and stores the result. A `ParametricComponent` pre-bake hook **always removes
`_Parts`** — in the main model and in every placement. Equal values share one `BakedAsset`.
Limits: 16 unreferenced variants per asset (LRU, a referenced one is never evicted), 64 distinct
variants per scene (`parametric-variant-budget`). An invalidation of the base asset during a run
discards the result (epoch check). Nothing is written to the project — the cache is pure
acceleration.

**Standstill invariant:** the generator never runs while the simulation runs (`state ===
'detached'`, or `'paused'` with `simTime === 0` and DES render clock 0). A change made while the
simulation runs is deferred (`parametric-deferred`; the mask shows "Applied when the simulation
stops").

### Commands

| Command / tool | Where | Does |
|---|---|---|
| `web_editor_parametric_define(path, paramsJson, code, valuesJson?, partsRoot?)` | asset editor | writes the component and builds the first variant, one undo step |
| `web_editor_parametric_set(path, valuesJson)` | asset editor | partial values → normalize → regenerate, one undo step |
| `web_editor_parametric_inspect(path, valuesJson?, runGenerator?)` | read | values, hashes (`upToDate`), parts, build plan or generator error |
| `layout.setParams` `{id, values, family?}` | layout planner, `web_execute` | writes the placement overrides and swaps the variant (the new variant bakes first, the old instance stays on error); undo/redo, sequence-numbered — a stale result is dropped |
| `editor.parametricUse` `{path, family, glbUrl?, familyNodeId?, docHash?, assetPath?, remove?}` | asset editor, `web_execute` | adds, replaces or removes a `Uses` entry (≤ 32), reading `FamilyNodeId` + `DocHash` from `glbUrl`; one undo step including the regenerate |

`layout.setParams` and `editor.parametricUse` have no MCP mirror by design (plan-641: new
capabilities arrive as commands).

### Nested families

`children[]` places other families. The assembly emits one **empty, non-embedded
`AssetReference` node** per child (`_Generated/_Children/<i>`, NodeId
`<familyNodeId>:_Children:<i>`) carrying the child values as overrides (`byAddress`); the normal
`PlacementInstancer` materializes it as a nested placement after the parent (see
[doc-node-paths.md](doc-node-paths.md) § 9). Child content never enters the parent bake. A child
must be declared in `Uses` (`parametric-undeclared-child`); `DocHash` is the SHA-256 of the child
document's bytes. Limits per outermost placement: parametric depth ≤ 4 (`parametric-depth`),
cycles refused (`parametric-cycle`), ≤ 256 child placements and ≤ 2 M baked vertices
(`parametric-budget`) — each leaves a placeholder plus a problem, the rest stands. A warm load
reads the child list from the cached `_Generated` GLB: zero generator runs.

### Share bundle

`src/core/engine/rv-parametric-bundle.ts` + `src/core/editor/rv-parametric-share.ts`: a share
export (`exportAssetGlb` **with** share meta — plain save and GLB export stay byte-identical) packs
all child families flat and transitively as bufferViews, manifest
`asset.extras.realvirtual.parametricChildren`. A child whose bytes no longer match its `DocHash`
is not bundled but reported (`parametric-child-missing`, phase `export`). Importing the GLB
(`importObject` → `library/imports/`) unpacks the children **before** the weld into the project
library (`Path` if it is a `library/…glb`, else `library/parametric/<Family>.glb`, suffix `-2` on
a collision; a family the project already resolves is never overwritten) and adds manifest rows
with `id = Family`. Known gap: opening a share link directly, without import, does not resolve
children from the bundle yet — the parent stands, the child reports `parametric-child-missing`.

## See also

- [Component Behaviors](doc-behaviors.md) — the native-TypeScript wiring layer script components sit alongside.
- [Extending realvirtual WEB](doc-extending-webviewer.md) — plugins, UI slots, and how components map from Unity to the viewer.
