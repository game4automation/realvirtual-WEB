# Lifecycle — RVViewer

This document describes the **runtime lifecycle** of realvirtual WEB:
from construction to model load, the per-frame simulation/render loop, pause and
reset semantics, connection-state transitions, and teardown.

Use this as the single reference when wiring plugins, HMI components, or
integrations that must react to lifecycle transitions. The canonical source
remains [src/core/rv-viewer.ts](src/core/rv-viewer.ts); this document organises
what is otherwise spread across `rv-viewer.ts`, `rv-plugin.ts`,
`rv-simulation-loop.ts`, and the scene loader.

---

## 1. Lifecycle Overview

```
┌─────────────────────────────────────────────────────────────────────┐
│  await RVViewer.create(       Viewer constructed (Three.js scene,    │
│      container, options)      renderer, controls, RUNNING loop,      │
│                               plugins, UI registry — but NO model)   │
└─────────────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                       ┌──────────────────────┐
                       │ viewer.loadModel()   │  ──→ 'model-loaded'
                       │   or loadScene()     │      'scene-loaded'
                       └──────────────────────┘
                                  │
                                  ▼
   ┌──────────────────────────────────────────────────────────────┐
   │                  RUNNING (loop already started)              │
   │   per fixed step (60 Hz):  onFixedUpdatePre → drives →       │
   │                            transport → onFixedUpdatePost     │
   │   per animation frame:     onRender                          │
   │                                                              │
   │   setSimulationPaused(reason, true/false)                    │
   │     ↑↓                                  ──→ 'simulation-     │
   │   PAUSED  (rendering continues,             pause-changed'   │
   │            fixed step skipped)                               │
   │                                                              │
   │   resetSimulation()  — restore start state (reset→start):    │
   │                        behaviors/drives reset, MUs cleared   │
   └──────────────────────────────────────────────────────────────┘
                                  │
                                  ▼
                       ┌──────────────────────┐
                       │ viewer.clearModel()  │  ──→ 'model-cleared'
                       │   (or loadModel()    │
                       │    on new URL)       │
                       └──────────────────────┘
                                  │
                                  ▼
                       ┌──────────────────────┐
                       │ viewer.dispose()     │   (final teardown)
                       └──────────────────────┘
```

---

## 2. Viewer Construction

```typescript
const viewer = await RVViewer.create(container, options);
```

`static async create(container: HTMLElement, options?: RVViewerOptions)` is the **only**
entry point. The constructor is `private` — the renderer (`webgl` / `webgpu` /
`webgpu-gl`, with fallbacks) must be created and `init()`-ed asynchronously before the
instance exists, which a constructor cannot do. Note the argument is the **container
element**, not a canvas: the viewer creates and appends its own canvas and observes the
container for resizes.

`create()` builds the static infrastructure:

- Three.js `Scene`, `WebGLRenderer` (or WebGPU), camera, `OrbitControls`
- `SimulationLoop` — constructed **and started** right there (`loop.start()`, see §4).
  It runs from construction until `dispose()`; there is no separate start call.
- `GizmoManager`, `SelectionManager`, `HighlightManager`
- Plugin registry (no plugins active yet — use `viewer.use(plugin)`)
- UI slot registry (HMI mounts can read this)

What is **not** present after construction:

- `currentModel`, `drives`, `signalStore`, `transportManager`, `logicEngine`,
  `registry`, `groups`, `playback`, `raycastManager` — all `null` / empty
- No sources, sinks, sensors

Plugins registered before the first `loadModel()` receive `onModelLoaded`
when the model finally loads. Plugins registered **after** a model is
already loaded receive `onModelLoaded` **retroactively** with the last
`LoadResult`.

---

## 3. Model Load Pipeline

`viewer.loadModel(url, options?)` is the single entry point for replacing the
loaded GLB. `viewer.loadScene(scene)` wraps it for the Scene/Op-Log workflow.

### 3.1 Phases of `loadModel()`

| # | Phase | What happens | Hooks fired |
|---|-------|--------------|-------------|
| 1 | **Pre-clear** | `clearModel()` is called — see §6 | `onModelCleared`, `'model-cleared'` |
| 2 | **Track URL** | `_currentModelUrl` updated | — |
| 3 | **External plugins** (opt-in via `appConfig.externalPlugins`) | Probes `./project-plugin.js` + `./models/<name>/model-plugin.js`; runs default export with `this` | — |
| 4 | **ModelPluginManager** | Loads Vite-bundled per-model plugins (`plugins/models/*`) | `onModelLoading(url, viewer)` |
| 5 | **Load gate** | `await this.loadGate` (set by e.g. login flow) | — |
| 6 | **GLB parse** | `loadGLB(url, scene, { overlay, … })` — parses GLB, applies `rv_extras`, runs two-phase component construction | — |
| 7 | **Shader pre-compile** | `renderer.compileAsync()` (when available) | — |
| 8 | **State assignment** | `currentModel`, `drives`, `transportManager`, `signalStore`, `playback`, `replayRecordings`, `logicEngine`, `registry`, `groups` are set | — |
| 9 | **Wire subsystems** | Source-markers binding, `ComponentEventDispatcher`, `AutoFilterRegistry`, `SelectionManager.init()`, `RaycastManager`, isolation gate, core context-menu items | — |
| 9b | **Async BVH kickoff** | The BVH build for all raycast geometry starts in the background (one reused worker across loads; time-sliced inline fallback when no `Worker` is available). The load does NOT wait for it | — |
| 10 | **Plugin notification** | Every enabled plugin gets `onModelLoaded(result, viewer)` | `onModelLoaded` |
| 11 | **Re-evaluate physics** | `_physicsPluginActive` updated (plugins may have flipped `handlesTransport` in step 10) | — |
| 12 | **Emit event** | `'model-loaded'` event fires | `'model-loaded'` |
| 13 | **Drain async** | `await whenLoadingIdle()` — env-map IBL, deferred prefetch, etc. | — |
| 14 | **Resolve** | `loadModel` promise resolves with `LoadResult` | — |

> **Two-phase component construction** in step 6 mirrors Unity's
> `Awake()`/`Start()` lifecycle: all node registry entries are created first
> (Awake), then typed component instances are built and can resolve
> cross-references (Start). See [doc-signal-architecture.md](doc-signal-architecture.md) §2.

> **`model-loaded` timing and `raycast-ready`:** `loadModel()` does not wait
> for BVH construction. The GLB parse builds the merged raycast geometries
> without their BVH trees; the trees are then built asynchronously — merged
> groups first (indirect mode, preserving the face-range tables), then
> per-mesh geometries — through one sequential background worker. Until the
> build completes, hover and click raycasts run through the native three.js
> fallback: fully functional, just slower on large models. Once every
> eligible geometry carries its tree, the viewer emits `'raycast-ready'` and
> flags a re-render. A new `loadModel()` or a `clearModel()` during a running
> build aborts the whole remaining sequence and discards in-flight results;
> `'raycast-ready'` is not emitted for an aborted load.

### 3.2 `loadScene()` extension

`loadScene(scene)` adds these phases around `loadModel()`:

```
Phase 0 — materialise edits (ops → overlay + placements + cameraStart)
Phase 1 — resolve base URL ('empty' or scene.base.url)
Phase 2 — clear planner placements + sweep orphans
        ── stash _currentScene BEFORE loadModel so plugin onModelLoaded
           handlers (camera-startpos) can read it ──
Phase 3 — loadModel(url, { overlay })          ← emits 'model-loaded'
Phase 4 — planner.applyPlacements(...)
Phase 4b — keep planner authoring floor hidden
Phase 5 — whenLoadingIdle() again              ← in case step 4 queued work
        emit 'scene-loaded'
```

**Two events fire per scene load**, in this order:

1. `'model-loaded'` — base GLB is parsed, components built, plugins notified
2. `'scene-loaded'` — overlay edits + placements applied, scene fully ready

Subscribers that need the **final** placed-out world (e.g. per-scene camera
presets, scene-aware HMI overlays) should listen to `'scene-loaded'`.
Subscribers that only need the GLB and its `rv_extras` (e.g. raw signal
wiring, drive lists) can use `'model-loaded'`.

### 3.3 Error handling — known gap

Today there is **no** `'model-load-error'` event and no `'model-loading'`
event. If `loadGLB` throws, the promise from `loadModel` rejects but the
scene is in a half-cleared state (step 1 ran, steps 8–12 did not). Callers
must catch the rejection and decide on UX — there is no event-driven path
for plugins to observe load failures.

> If your plugin needs to gate UI on "load is in progress", subscribe to
> `'model-cleared'` and treat the first `'model-loaded'` after it as the
> load-complete signal. A dedicated pair of events is on the roadmap.

### 3.4 Placement lifecycle — placeholder → swap

A Layout-Planner placement has a **second, per-object load pipeline** that runs
long after `'model-loaded'`. It is asynchronous by design: dragging a library
asset registers a placeholder synchronously and swaps the decoded geometry in
underneath the same root later, so the drag gesture and the drop never wait for
the GLB.

```
dragstart  → buildPlaceholderNode(entry)        wireframe box, < 1 ms
             addPlacedToScene(node, id, { mode: 'light' })
                 · unique name, objectMap, root in NodeRegistry,
                   raycast aux targets, markShadowsDirty
                 · NO processExtras, NO drives/signals, NO snap ports
             pending.begin(id, entry) → generation token
             void modelCache.getOrLoad(url, { signal })     ── async ──┐
                                                                      │
drop       → _commitDraft()   store entry + `addPlacement` undo op     │
             (commits immediately — the load is NOT awaited)           │
                                                                      │
decode lands ─────────────────────────────────────────────────────────┘
           → pending.isCurrent(id, gen)?   no → discard the result
           → swapPlacedGeometry(deps, id, realSource):
                1. root = objectMap.get(id)          (false if gone)
                2. keepY = root.position.y
                3. unregister the placeholder subtree
                4. detach children + disposePlaceholderNode(root)
                5. adopt realSource's children,
                   prepPlacedVisual({ skipAutoAlign: true }) + pivotToFloorCenter
                6. root.position.y = keepY
                7. registerPlaced(…, 'full')
                     · processExtras → signals, drives, components
                     · behaviors, LogicSteps, snap ports
                     · raycast aux targets, grouped-BVH rebuild
                     · markShadowsDirty, 'layout-content-added'
```

**The root object is never replaced — only its children are.** That is what lets
`objectMap`, the FloorGizmo's target, MultiSelectPivot members, the path-based
selection and the armed bbox-snap state survive the swap untouched. `alignToFloor`
is deliberately not re-run (it would rewrite `position.y` to 0 and drop every
placement parked on an elevated surface), which is why step 5 re-applies the
pivot by hand and step 6 re-asserts the height.

**The generation token is the guard against a resurrected node.** Every load
carries a monotonically increasing generation per placement id
(`pending-geometry.ts`), and `isCurrent(id, gen)` validates **both** the token
**and** that the placement still exists in the planner's object map — the second
half covers removal paths that never learned about the registry at all. A result
that fails either check is dropped without touching the scene.

Cancellation is centralised rather than wired per call site:

| Trigger | Where | Effect |
|---|---|---|
| Delete, undo, drag cancel, scene reload, <kbd>Del</kbd> key, hierarchy context menu | `LayoutPlannerPlugin._removePlacedFromScene` — the single choke point every removal path funnels through | `pending.cancel(id)` + pulse released; the resource dispose sits one level down in `scene-mutations.removePlacedFromScene` |
| `onModelCleared` (§6.1) | Plugin hook | `pending.cancelAll()` + `pulse.stopAll()` — placements are parented under `viewer.currentModel`, so a late swap would land under a parent that is being disposed |
| `dispose()` (§9) | Plugin teardown | `pending.cancelAll()` + `pulse.dispose()` before the object map is emptied |

> ⛔ A placeholder must **never** be torn down with `disposeSubtree`: that helper
> duck-types on `.geometry`/`.material` without an `isMesh` check, and the
> billboard is a `Sprite` whose geometry is a three.js **module singleton**.
> Use `disposePlaceholderNode` — the teardown loop in the planner's `dispose()`
> branches on `isPlaceholderNode` for exactly this reason.

Two further lifecycle notes:

- **The swap takes no pause reason.** `'layout-edit'` (§5.1) is held by the drag
  gesture, not by the load; a swap that landed after the user moved on would
  otherwise keep the simulation frozen.
- **Aborting is consumer-side only.** `getOrLoad(url, { signal })` detaches the
  cancelled consumer and lets the shared fetch/decode run to completion — both
  cache layers de-duplicate URL-wide, so a real abort would tear down an
  unrelated second placement of the same asset.

Nothing about this state is persisted; see [doc-persistence.md](doc-persistence.md)
§7.3. Feature overview: [doc-webviewer.md](doc-webviewer.md) → *Pending
placements (Planner)*.

---

## 4. The Run Loop (`SimulationLoop`)

[src/core/engine/rv-simulation-loop.ts](src/core/engine/rv-simulation-loop.ts)
runs an **accumulator-based fixed-timestep** loop at 60 Hz (`fixedTimeStep =
1/60`). The loop is started in viewer construction and stopped only on
`dispose()` — `clearModel()` does **not** stop the loop.

### 4.1 Per-frame order

```
requestAnimationFrame / renderer.setAnimationLoop tick
│
├── If isPaused → accumulator = 0, skip fixed step
│   else        → accumulator += frameDt, while ≥ fixedTimeStep:
│                   onFixedUpdate(fixedTimeStep)  ───┐
│                                                   │
└── onRender(frameDt)                               │
                                                    │
       ┌────────────────────────────────────────────┘
       ▼  RVViewer.fixedUpdate(dt):
       │
       │  ── Setup (runs before TickStages) ─────────────────────────────
       │  1. playback.update(dt)             (DrivesRecorder playback, Active-gated)
       │  2. logicEngine.fixedUpdate(dt)     (LogicSteps, Active-gated)
       │  3. ikPaths[].fixedUpdate(dt)       (robot IK path replay; after
       │                                      LogicStep, before the drive loop)
       │  4. for each replayRecording:       (ReplayRecording, Active-gated)
       │       rr.fixedUpdate(dt)
       │
       │  ── TickStage.PRE ──────────────────────────────────────────────
       │  5. _prePlugins[].onFixedUpdatePre(dt)      ← legacy plugin callbacks
       │       (ErraticDriver, replay, CAM, interface-write — set drive targets)
       │     + onTick(PRE) callbacks
       │
       │  ── TickStage.SIM ──────────────────────────────────────────────
       │  6. drives[].update(dt)             ← drive physics (motion + behaviors)
       │
       │  7. transportManager.update(dt)     (kinematic transport; skipped when
       │                                      a physics plugin handles transport)
       │
       │  8. CoreSubsystems.visuals(dt)      ← always runs, even when a physics
       │     transportManager.updateTextureAnimations(dt)   plugin or the DES
       │     tankFillManager.update()                       queue owns transport
       │     gizmoManager.tick(dt * 1000)
       │     lampManager.update(dt)
       │     energyChainManager.update(dt)   (after the drive stage, so the
       │                                      follower pose of this frame is set)
       │     pipeFlowManager.update(dt)
       │     collisionManager.update(dt)     ← deliberately LAST: drives,
       │                                      kinematics, transport and the
       │                                      energy-chain rig of THIS tick are
       │                                      all applied. A hit highlights and
       │                                      raises the modal in the same tick;
       │                                      the simulation is never stopped.
       │     + onTick(SIM) callbacks
       │
       │  9. behaviors.tick(dt)              (discrete material-flow / DES
       │                                      components; skipped when the unified
       │                                      simulation kernel is active)
       │
       │  ── TickStage.POST ─────────────────────────────────────────────
       │ 10. _postPlugins[].onFixedUpdatePost(dt)    ← legacy plugin callbacks
       │       (DriveRecorder, SensorMonitor, interface-read,
       │        chart sampling, event emission)
       │     + onTick(POST) callbacks
       │
       └─ Back to render
```

**Rules of thumb:**

- **Set drive targets** in `onFixedUpdatePre` or `onTick(TickStage.PRE)` —
  they will be honoured in the same tick.
- **Read drive results** in `onFixedUpdatePost` or `onTick(TickStage.POST)` —
  drives have already moved.
- **Plugins sort by `order` (lower = earlier).** Default `100`. Use
  `PLUGIN_ORDER` constants from `rv-plugin-order.ts` instead of magic numbers.
- A plugin with `handlesTransport: true` takes over kinematic transport;
  the core `transportManager.update(dt)` is skipped.
- `onRender(frameDt)` runs every animation frame regardless of pause state —
  the viewer stays interactive while paused.
- **Defensive iteration:** the pre/post plugin arrays are snapshotted before
  iteration. A plugin that removes itself during a tick does not corrupt the
  loop.

### 4.1b TickStage and simLoop.onTick()

As an alternative to `onFixedUpdatePre` / `onFixedUpdatePost` plugin callbacks,
use the `SimLoopFacade` accessible via `PluginContext`:

```typescript
import { TickStage } from './rv-tick-stages';
import { PLUGIN_ORDER } from './rv-plugin-order';

// In BaseViewerPlugin.init():
this.context.simLoop.onTick(TickStage.PRE, (dt) => {
  // Before drive physics — flush incoming signals here
}, PLUGIN_ORDER.INTERFACE_ADAPTER);  // optional order

this.context.simLoop.onTick(TickStage.POST, (dt) => {
  // After drive physics — sample data, emit events
});
```

`onFixedUpdatePre` / `onFixedUpdatePost` and `onTick()` coexist and run in
their declared order within each stage. Legacy plugins require no changes.

### 4.2 Pause semantics

When paused, the loop **drains the accumulator** (`accumulator = 0`). This
is deliberate: on resume, the simulation does not catch up by replaying
seconds of skipped ticks. Drives, sensors, and LogicSteps therefore "freeze
in place" rather than "fast-forward on resume".

---

## 5. Pause API

`RVViewer.setSimulationPaused(reason: string, paused: boolean)` is the
**only** supported way to pause/resume the fixed step.

### 5.1 Multi-reason pause set

`SimulationLoop` holds a `Set<string>` of active pause reasons. The
simulation runs **only when the set is empty**. Any caller can add a reason;
the loop resumes only after **every** reason has been released.

Conventions for `reason` strings:

| Reason | Constant | Owner |
|--------|----------|-------|
| `'user'` | `USER_PAUSE_REASON` (`core/engine/rv-constants.ts`) | UI pause button, Property Inspector edits, Set-Position dialog |
| `'layout-edit'` | `LAYOUT_EDIT_PAUSE_REASON` (same file) | Layout Planner edit mode — deliberately DISTINCT from `'user'` so the planner can auto-resume without clobbering a user pause |
| `'ar-placement'` | — (literal) | WebXR placement mode |
| `'layout-drag'`, `'layout-placement'` | — (literals) | Legacy Layout-Planner reasons; the planner only *releases* them today (defensive cleanup) |

Always use the constants for `'user'` and `'layout-edit'` rather than the string
literals — a typo there produces a pause reason nobody can release.

> **Best practice:** one plugin = one stable reason string. Same reason
> set/cleared multiple times is idempotent — only the set state matters.
> A plugin that owns a reason **must** release it in `dispose()` to avoid
> "stuck paused" after teardown.

### 5.2 Event: `'simulation-pause-changed'`

```typescript
viewer.on('simulation-pause-changed', ({ paused, reasons, reason }) => {
  // paused : new overall pause state (boolean)
  // reasons: snapshot of all active reasons (readonly string[])
  // reason : the specific reason that triggered THIS transition
});
```

**Fires only on the `idle ↔ paused` transition.** Adding or removing a
reason while the simulation is already paused does **not** emit. Re-entrant
calls from inside a handler (calling `setSimulationPaused` synchronously
from the listener) are suppressed for the nested emission — the set update
still happens.

### 5.3 Diagnostics

```typescript
viewer.isSimulationPaused              // boolean
viewer.simulationPauseReasons          // readonly string[]
viewer.clearPauseReasons()             // force-clear ALL (leak escape; logs warning)
viewer.clearPauseReasons('layout-edit')// force-clear a single leaked reason
```

`clearPauseReasons` is a **last-resort dev/debug escape** when a plugin
crashed before releasing its reason. Logs a warning so leaks are observable
in production.

---

## 6. Clear & Reset

The two operations are **not interchangeable**.

### 6.1 `clearModel()` — full teardown of the loaded scene

Steps in order:

1. Bump the load generation (aborts a running BVH build), reset the signature /
   logic-run state
2. `onModelCleared(viewer)` on every plugin that received this model
3. Close context menu
4. Reset dynamic UI contexts (preserving config-initial ones **and** the active
   workspace-mode context — a mode must survive a model switch)
5. `batchTable.dispose()` — the batched arenas hold geometry and indirect
   textures the generic traverse-dispose below would miss
6. `selectionManager.clear()` + `dispose()`
7. `raycastManager.dispose()`, drop the instance pick index and the highlight
   proxy provider
8. Drop source-markers / vanishing-MU subscriptions
9. `transportManager.reset()` then null it **before** scene traverse
   (MUs share geometry with templates by reference); `statisticsManager.clear()`;
   drop the simulation kernel
10. `collisionManager.clear()`, `lampManager.clear()`, `energyChainManager.clear()`
    — these restore material clones / original meshes **before** the geometry teardown
11. Sweep all `_rvModelRoot`-tagged children from the scene; dispose
    geometries and materials (skipping `_rvShared` material singletons)
12. Null out `currentModel`, `drives`, `ikPaths`, `playback`, `replayRecordings`,
    `logicEngine`, `tankFillManager`, `pipeFlowManager`, `signalStore`,
    `registry`, `groups`, `autoFilters`, `componentEventDispatcher`,
    `signalBindingManager`
13. Dispose `gizmoManager`; `resetSlotAuthority()` (unconditional — drops slot
    claims, slot↔channel indexes and the live-control gate); reset overlay producers
14. Emit `'model-cleared'`

The `SimulationLoop` keeps running. `onFixedUpdate` is still called but has
no drives/transport to advance.

### 6.2 `resetSimulation()` — "new demo run" without unload

Restores the running model to its freshly-loaded **start** state — like a
reload, but without re-fetching/re-parsing the GLB. Runs in three phases, each
surfaced as an event so components react:

1. **`'simulation-reset'`** — components restore their internal state to the
   start: behaviors (Conveyor / Turntable / ChainTransfer) reset their FSM, part
   counters, timers and routing bookkeeping; drives snap back to their authored
   `StartPosition` (`RVDrive.reset()`); conveyor belt textures rewind. Then the
   engine clears live MUs + transport counters (`transportManager.reset()`),
   resets LogicSteps to `Idle` (`logicEngine.reset()`), and resets the active
   DES executor.
2. **`'simulation-resetstat'`** — statistics accumulators are cleared
   (registrations persist). Also fired standalone for DES stat-only resets.
3. **`'simulation-start'`** — components (re)start from the clean state (e.g. a
   conveyor re-asserts `Run = true`).

Intentionally **untouched**:

- **Signals** are NOT blanket-reset — that would fight Live mode (Unity / PLC
  stream), where the next tick overwrites them anyway. Instead each component
  re-establishes only the signals it OWNS in its `onReset` / `onStart` handler
  (e.g. a conveyor zeroes `PartCount`, re-asserts `Run`).
- **Pause state** — reset can be invoked while paused or running.

Components subscribe via the bind-context hooks `onReset` / `onStart` /
`onResetStat` (a material-flow definition adds top-level `reset` / `start` /
`resetStat` blocks), or directly via `viewer.on('simulation-reset', …)`.

**Simulation runs.** When a DES run is in flight, the reset also ends the
run: the DES manager's reset hook archives it (seed, reached sim time,
statistics aggregate) into the experiment store and emits
`'simulation-run-ending'` — this happens DURING phase 1 (the executor reset
triggers the manager reset), so the archived statistics are the pre-reset
values. A subsequent engine start emits `'simulation-run-started'` with a
fresh run id. The archive hook lives in the DES manager itself (not only in
`resetSimulation()`), so native-DES resets that bypass the viewer are covered
too. Non-DES scenes never produce run events.

### 6.3 Side-by-side

| | drives | signals | MUs | LogicSteps | pause | camera | listeners |
|---|---|---|---|---|---|---|---|
| `resetSimulation()` | reset to StartPosition | component-owned only | cleared | reset | kept | kept | kept |
| `clearModel()` | gone | gone | gone | gone | kept | kept | kept |
| `loadModel(newUrl)` | replaced | replaced | replaced | replaced | kept | kept | kept |
| `dispose()` | gone | gone | gone | gone | gone | gone | gone |

---

## 7. Connection State

`viewer.connectionState` (a getter over the `SimulationRuntime`) reports the overall
Live/Direct connection. When it flips, `'connection-state-changed'` fires and every
enabled plugin receives `onConnectionStateChanged(state, viewer)`.

```typescript
viewer.on('connection-state-changed', ({ state, previous }) => {
  // state, previous: 'Connected' | 'Disconnected'
});
```

This is the **viewer-wide** connection. Industrial-interface plugins
additionally emit `'interface-connected'` / `'interface-disconnected'` /
`'interface-error'` per-interface — see [doc-webviewer-interface.md](doc-webviewer-interface.md).

Drives, LogicSteps, ReplayRecordings, and the playback subsystem have an
`activeOnly` flag (`'EditorAndPlay'` / `'PlayMode'` / `'EditorOnly'`). The
fixed-update gate `isActiveForState(activeOnly, isConnected)` decides
whether they tick in the current connection state.

---

## 8. Plugin Lifecycle Hooks

The full plugin interface lives in [src/core/rv-plugin.ts](src/core/rv-plugin.ts).

| Hook | When |
|------|------|
| `init?(viewer, context?)` | Called synchronously inside `viewer.use()`, **before** any model load. Receives the `PluginContext` facade. `BaseViewerPlugin.init()` stores the context in `this.context`. |
| `onModelLoaded(result, viewer)` | After step 8 of §3.1 (state assigned), **before** `'model-loaded'` emits. Also called retroactively for plugins registered after a model is already loaded. |
| `onModelCleared(viewer)` | First step of `clearModel()`, **before** state is reset. |
| `onConnectionStateChanged(state, viewer)` | When viewer-wide connection flips. |
| `onModeActivate(mode, viewer)` | The plugin's workspace mode becomes active. Build mode-scoped resources here. The plugin instance itself persists across mode switches. |
| `onModeDeactivate(from, viewer)` | The plugin's mode is left (`from` is `null` only for the initial boot). Tear down whatever `onModeActivate` created. |
| `onRenderBackendChanged(backend, viewer)` | The render backend flips between `'three'` and `'omniverse'`. |
| `onFixedUpdatePre(dt)` | 60 Hz, before drive physics (TickStage.PRE). Use to set drive targets. |
| `onFixedUpdatePost(dt)` | 60 Hz, after drive physics + transport (TickStage.POST). Use to read results / sample data / emit events. |
| `onRender(frameDt)` | Per animation frame, after `renderer.render()`. |
| `dispose()` | Viewer teardown. **Must release any held pause reasons here.** |

A plugin declares its mode membership with the optional `modes?: ModeId[]` field
(omitted = active in every mode). `core: true` is orthogonal to it: the runtime hooks
of a core plugin run everywhere, while `modes` still gates its UI slots.

For stage-based tick registration without subclassing, use `this.context.simLoop.onTick(stage, callback)` from inside `init()`. See §4.1b above.

Every callback is isolated with try/catch — a faulty plugin cannot freeze
the simulation. Disabled plugins (via UI or `_disabledIds`) are skipped for
all lifecycle callbacks except (current behaviour) `dispose`.

`order` controls invocation order in pre/post/render lists. Lower is
earlier. Default `100`. `core: true` plugins always activate even in
selective mode (`rv_plugins` declared on the GLB).

---

## 9. Final Teardown — `dispose()`

```
viewer.dispose():
  1. for each plugin: callPlugin(p, 'dispose')
  2. loop.stop()
  3. clearModel()                ← emits 'model-cleared'
  4. window.removeEventListener('resize', …)
  5. resizeObserver.disconnect()
  6. controls.dispose()
  7. renderer.dispose()
  8. stats.dispose() (if active)
  9. removeAllListeners()
```

After `dispose()` the viewer instance is unusable. Plugin `dispose` runs
**first**, so plugins still have a live `viewer` reference while cleaning
up. After `removeAllListeners()`, any deferred async work that later tries
to emit will silently no-op.

---

## 10. Lifecycle Event Reference

Snapshot of the lifecycle-relevant events from `ViewerEvents` in
[src/core/rv-viewer-events.ts](src/core/rv-viewer-events.ts).
For the complete list (hover, selection, charts, XR, FPV, layout, etc.) see
[doc-extending-webviewer.md](doc-extending-webviewer.md) §4.

| Event | Payload | Fires when | Typical subscriber |
|-------|---------|-----------|--------------------|
| `'model-loaded'` | `{ result: LoadResult }` | After `loadModel()` step 12 | HMI tiles, KPI cards, MCP bridge, chart subscribers |
| `'model-logic-activated'` | `{ result: LoadResult }` | Executable model logic is bound — immediately for `none`/`valid` signatures, or after an explicit late activation for `invalid`/unverifiable ones. Geometry/HMI lifecycle stays on `'model-loaded'` | Anything that must not run untrusted model logic before it is cleared |
| `'signature-state-changed'` | `{ signatureState, logicRunState }` | Model-signature verification result or the `active`/`gated`/`activating` run gate changes | Signature banner, logic activation UX |
| `'raycast-ready'` | `void` | Background BVH build completed for every eligible geometry (not emitted for aborted loads) | Plugins wanting BVH-accelerated raycasts from the first query |
| `'model-cleared'` | `void` | First step of `clearModel()` | HMI reset, listener cleanup |
| `'scene-loaded'` | `{ scene: RvScene }` | After `loadScene()` Phase 5 | camera-startpos plugin, scene-aware overlays |
| `'simulation-pause-changed'` | `{ paused, reasons, reason }` | On `idle ↔ paused` transition only | External PLC I/O, animations, recorders |
| `'simulation-reset'` | `void` | `resetSimulation()` phase 1 | Behaviors / drives restoring start state (bind-context `onReset`) |
| `'simulation-resetstat'` | `void` | `resetSimulation()` phase 2 (or DES stat-only reset) | Statistics accumulators (bind-context `onResetStat`) |
| `'simulation-start'` | `void` | `resetSimulation()` phase 3 | Behaviors (re)starting from the clean state (bind-context `onStart`) |
| `'simulation-run-started'` | `{ runId, seed }` | DES engine (re)start with live material-flow components | Run-history panel, external run trackers |
| `'simulation-run-ending'` | `{ runId, seed, simTime, status, reason }` | DES run archived — on reset (`aborted`) or sim end reached (`completed`), during reset phase 1 | Run-history panel, KPI exporters |
| `'mode-changing'` | `{ from, to }` | BEFORE a workspace-mode switch begins (plugins deactivate/activate, UI swaps). Distinct from the kernel's `'simulation-mode-changed'` | Anything that must save state before the UI swaps |
| `'mode-changed'` | `{ from, to }` | AFTER a workspace-mode switch has fully applied. The viewer itself listens to re-attach/detach the runtime and re-apply the collision highlight | Highlight policy, mode-gated overlays |
| `'connection-state-changed'` | `{ state, previous }` | Viewer-wide Live/Direct flip | Status badges, reconnection UX |
| `'interface-connected'` | `{ interfaceId, type }` | Industrial interface attaches | Connection status per interface |
| `'interface-disconnected'` | `{ interfaceId, reason? }` | Industrial interface drops | Reconnect UX, alarm raising |
| `'interface-error'` | `{ interfaceId, error }` | Interface reports an error | Log panel, alarm system |
| `'component-event'` | `{ componentType, kind, path, payload? }` | Generic component lifecycle event: `mu/spawned`, `mu/consumed`, `sensor/changed`, … | OEE / parts counters, sensor monitor, plugin charts |

### Known gaps (events that do **not** exist yet)

- `'model-loading'` — would let plugins show a spinner during step 3 of §3.1
- `'model-load-error'` — see §3.3

If you need one of these today, the workaround is documented inline above.

---

## 11. Cross-References

- [doc-extending-webviewer.md](doc-extending-webviewer.md) — full plugin API,
  `ViewerEvents` reference, UI slot registration
- [doc-webviewer.md](doc-webviewer.md) — architecture overview, MCP control,
  reset semantics
- [doc-signal-architecture.md](doc-signal-architecture.md) — signal lifecycle,
  two-phase component construction
- [doc-persistence.md](doc-persistence.md) — when `scene-loaded` is the right
  hook for storage operations
- [doc-webviewer-interface.md](doc-webviewer-interface.md) — connection
  lifecycle for industrial interfaces (per-interface, separate from
  viewer-wide `'connection-state-changed'`)
- [src/core/rv-viewer.ts](src/core/rv-viewer.ts) — canonical source
- [src/core/rv-plugin.ts](src/core/rv-plugin.ts) — plugin interface
- [src/core/engine/rv-simulation-loop.ts](src/core/engine/rv-simulation-loop.ts)
  — fixed-step accumulator
