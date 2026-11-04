# Entity stream: externally simulated objects in realvirtual WEB

Some simulations run outside the viewer, for example a traffic simulator, a DES engine or a customer's
host. They report positions at a fixed rate (typically 2 to 60 Hz), and the viewer has to draw
thousands of objects smoothly at display rate in between. Five core building blocks cover this, so
a project plugin only has to translate its own telegram:

| Building block | Where | What it does |
|---|---|---|
| `EntityStream` | `src/core/engine/rv-entity-stream.ts` | Entity table, motion along paths, anchoring to the host clock, extrapolation, correction blend, freeze, pause, timeouts, quality metrics |
| `EntityPool` | `src/core/engine/rv-entity-pool.ts`, `viewer.createEntityPool()` | Instanced rendering of externally posed objects, pickable, in the Groups panel, never in the transport manager |
| `onBeforeFrame` | `RVViewerPlugin.onBeforeFrame()`, `viewer.onBeforeFrame()` | Runs once per animation frame **before** the render, so poses set there appear in the same frame |
| `getAbsPose` | `RVPath.getAbsPose(s, outPos, outDir)` | Position and direction on a path in one segment lookup |
| Render hints | GLB `rv_extras`, applied by `applyRenderHints()` in `rv-scene-loader.ts` | `SuppressGround` and `DepthBias` from the model instead of plugin code |

The customer SPI vehicle project (`realvirtual-WebViewer-Private~/projects/aXite`) is the reference user: an SPI
telegram from a traffic simulation, 200 to 2,000 vehicles at 20 Hz.

## When to use it

Use the entity stream when an external system owns the motion and the viewer only displays it:
the entity's position comes from the host, not from drives, transport surfaces or physics. Entities
in a stream are not MUs of the transport manager. They take no part in transport, sensors,
collision or drop detection, because that work could only fight the host's pose.

If the objects should interact with the simulation in the viewer (conveyors, sensors, grippers),
use Sources and MUs instead.

## Minimal plugin

```ts
import { EntityStream } from '@rv/core/engine/rv-entity-stream';
import type { RVViewerPlugin } from '@rv/core/rv-plugin';

class MyStreamPlugin implements RVViewerPlugin {
  readonly id = 'my-stream';
  private stream!: EntityStream<string>;
  private pools = new Map<string, EntityPool>();       // one pool per template
  private viewer!: RVViewer;
  private readonly pose = { position: new Vector3(), quaternion: new Quaternion() };

  onModelLoaded(result: LoadResult, viewer: RVViewer): void {
    this.viewer = viewer;
    this.stream = new EntityStream<string>({
      // id → any object with `length` and `getAbsPose(s, outPos, outDir)`, e.g. an RVPath
      paths: { get: (id) => this.paths.get(id) ?? null },
      config: () => this.config,                     // return ONE reused object, not a new one per call
      onRemoved: (rec) => this.pools.get(rec.kind!)?.remove(rec.id),
    });
    // one pool per template node of the model (here: a Map<kind, Object3D> the plugin collected)
    for (const [kind, template] of this.templates) {
      this.pools.set(kind, viewer.createEntityPool({ template, name: kind, groupName: 'Vehicles' }));
    }
    viewer.on('simulation-pause-changed', ({ paused }) => this.stream.setPaused(paused, performance.now()));
  }

  // One telegram from the host
  onTelegram(frame: { simTime: number; entities: Telegram[] }, recvMs: number): void {
    this.stream.beginBatch(frame.simTime, recvMs);
    for (const e of frame.entities) this.stream.upsert({ id: e.id, pathId: e.path, s: e.s, v: e.v, a: e.a, kind: e.type });
    this.stream.endBatch();
  }

  onBeforeFrame(_dt: number, nowMs: number): void {
    this.stream.forEach((rec) => {
      if (this.stream.poseOf(rec, nowMs, this.pose)) this.pools.get(rec.kind!)?.set(rec.id, this.pose.position, this.pose.quaternion!);
    });
    for (const pool of this.pools.values()) pool.flush();
    this.viewer.markRenderDirty();                       // once per frame, while entities move
  }

  // Model switch: release the pools, otherwise their meshes and group entries outlive the model
  onModelCleared(): void {
    for (const pool of this.pools.values()) pool.dispose();
    this.pools.clear();
  }
}
```

Call `stream.housekeeping(now)` periodically (for example every 250 ms) so entities that stop
appearing in telegrams time out.

## EntityStream

**Batch API.** A telegram is one batch: `beginBatch(hostSimTimeS, recvMs)`, any number of
`upsert({ id, pathId, s, v, a, kind })`, then `endBatch()`. `remove(id)` and `clear()` drop
entities. `onAdded` / `onRemoved` let a renderer allocate and free its instances; the stream itself
knows only ids.

**Motion model.** Each entity moves along a path with arc length `s`, speed `v` and acceleration
`a`. Between telegrams the stream extrapolates `s(t) = s0 + v·dt + ½·a·dt²`, never backwards and
at most `maxExtrapolationMs` past the last telegram. A new telegram that disagrees with the drawn
pose is blended in over `correctionBlendMs` (along the path) and `headingBlendMs` (heading and
lateral offset). A correction larger than `snapDistanceM`, or a change of path, snaps.

**Time base: the host clock, not the arrival time.** The state of a batch is valid at the host's
`simTime`, not when the WebSocket message arrived. Arrival carries every main-thread delay (parse,
garbage collection, a long frame, network batching). Anchored to arrival, each delay would become
a position error of `v · delay` that the correction blend smears in. That is the visible jitter.
The stream keeps a smoothed offset between local and host clock that works like a jitter buffer:
an earlier arrival than expected is taken at once, a later one moves the offset by 2 %. The offset
restarts when the simulation rate changes or the host stands still. The rate itself is estimated
from the telegrams (`simRate`, 0 while the host's `simTime` stands).

**Freeze and pause.**
- `freeze(now)` holds every entity at its drawn pose. Call it when the link goes stale.
- `setPaused(true, now)` freezes as well, keeps only the newest batch, and suspends timeouts.
- `setPaused(false, now)` re-anchors the clock and applies that batch through the normal
  correction. A host that paused too continues without a jump. One that kept running moves to its
  true state.

**Quality metrics.** `correction` is a ring of correction jumps in metres: p95 is the smoothness
figure. A flat level means small, steady corrections; isolated spikes mean jumps. The share of
drawn frames that were extrapolated (no telegram for that frame) is reported alongside.

## EntityPool

`viewer.createEntityPool({ template | geometry + material, name, groupName, pickable, initialCapacity, growth })`.
Per frame:
- `set(id, position, quaternion)` places an entity. It allocates a slot the first time an id
  appears and allocates nothing after that.
- `flush()` uploads the changed poses once.
- `remove(id)` frees the slot.

`idAt(instanceId)` maps a raycast hit back to the entity id.

The pool:
- grows by `growth` (default ×2) when full;
- registers itself in the Groups panel under `groupName`;
- re-registers the viewer's pick targets when it enters the scene, grows or is disposed (never per
  frame);
- uploads only the active part of the instance buffer.

It never registers with the transport manager.

## onBeforeFrame

`RVViewerPlugin.onBeforeFrame(dtSeconds, nowMs)`, or `viewer.onBeforeFrame(cb)` (which returns an
unsubscribe function), is called once per animation frame before the viewer decides whether to
render. Poses written here appear in the same frame. Updates done in `onRender`, which runs after
the render, reach the screen one frame later. The dispatch allocates nothing and marks nothing
dirty. Call `viewer.markRenderDirty()` yourself while something moves.

## RVPath.getAbsPose

`path.getAbsPose(s, outPos, outDir)` writes the world position and the unit direction at arc
length `s` with one segment lookup. `getAbsPosition` and `getAbsDirection` remain available.

## Render hints in the GLB

Both hints are read from the parsed GLB before the bake (`applyRenderHints()` runs ahead of `prepareAndBake()`), applied on model load and released when the model is cleared.

| `rv_extras` key | Where | Effect |
|---|---|---|
| `SuppressGround: true` | scene extras | Hides the viewer's ground plane and its mirror while the model is loaded (`viewer.suppressGround('model', true)`). For models that bring their own floor, such as an aerial photo or a hall floor. The user's ground setting is left untouched. |
| `DepthBias: { factor, units }` or a number (= units) | node or material extras, inherited by the subtree | `polygonOffset` on the materials below. Pushes a large flat surface back in depth so surfaces a few millimetres above it do not z-fight at overview distance. |

Plugins can also call `viewer.suppressGround(owner, on)` directly. The ground is hidden while any
owner suppresses it.

## Performance

Measured with the customer SPI vehicle project, 20 Hz telegrams. Machine: Snapdragon X Elite with integrated
Adreno X1-85, Chromium, canvas 1667 × 976. Ambient occlusion and bloom were off.

| Entities | fps | stream + pool per frame (p95) | parse per telegram (p95) |
|---:|---:|---:|---:|
| 200 | 60 | 0.2–0.3 ms | 0.4–0.5 ms |
| 1,000 | 60 | 0.8 ms | 2.2 ms |
| 2,000 | 50 | 1.3 ms | 2.1 ms |

- **Up to 2,000 entities**, the frame budget goes to the GPU (triangles per entity × entities), not
  to the stream.
- **Above that**, the per-telegram JSON parse becomes the limit. The next steps, in order:
  1. a binary or delta telegram;
  2. decoding and extrapolation in a Web Worker writing into a `SharedArrayBuffer`;
  3. extrapolation in the vertex shader;
  4. LOD for distant entities.

## See also

- [doc-extending-webviewer.md](doc-extending-webviewer.md): plugin system
- [doc-events-and-hooks.md](doc-events-and-hooks.md): `simulation-pause-changed` and other events
- [doc-path-fleet-control.md](doc-path-fleet-control.md): paths and path networks
