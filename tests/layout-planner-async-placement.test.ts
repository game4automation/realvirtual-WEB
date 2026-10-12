// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-371 — instant placeholder + in-place geometry swap.
 *
 * Dragging a GLB out of the library no longer waits for the decode: a
 * catalog-sized wireframe placeholder is registered in `light` mode
 * synchronously, the drop commits immediately, and the real geometry swaps in
 * underneath the SAME root later.
 *
 * Covers T1–T8, T10–T12 and T14, T15, T16 of the plan.
 */
import { describe, it, expect } from 'vitest';
import { Box3, Sprite } from 'three';
import type { BufferGeometry, LineSegments, Mesh, Object3D } from 'three';

import { chunkMetaOf } from '../src/core/engine/rv-bake-chunk';
import { isChunkMesh } from '../src/core/engine/rv-node-classification';

import { serializeLayout } from '../src/plugins/layout-planner/rv-layout-store';
import { CONFLICT_BLINK_HZ } from '../src/plugins/signal-bind/conflict-blink';
import {
  setupPlanner,
  internals,
  dragAndDrop,
  flush,
  waitForThumbnail,
  trackDisposables,
  addElevatedSurface,
  addForeignSprite,
  makeFakeMedia,
  GLB_ENTRY,
  GLB_URL,
  VIRTUAL_ENTRY,
  SPLAT_ENTRY,
} from './_layout-planner-async-harness';

/**
 * Let a released decode run all the way through the bake. Since plan-756 1c
 * (a9ea8247, 2026-09-21) `bake()` awaits its pick-structure builds, and the
 * inline build slices on EVENT-LOOP turns (`scheduler.yield` / MessageChannel)
 * — a microtask-only `flush()` returns before the swap. A fixed number of
 * macrotask turns, not a wall-clock sleep, so a stalled load stays stalled.
 */
async function settle(turns = 25): Promise<void> {
  await flush();
  for (let i = 0; i < turns; i++) {
    await new Promise<void>((r) => setTimeout(r, 0));
    await flush();
  }
}

/** The placeholder's wireframe box. */
function findLine(root: Object3D): LineSegments {
  let found: LineSegments | null = null;
  root.traverse((n) => { if (!found && (n as LineSegments).isLine) found = n as LineSegments; });
  if (!found) throw new Error('no LineSegments under the placeholder');
  return found;
}

function countSprites(root: Object3D): number {
  let n = 0;
  root.traverse((child) => { if ((child as Sprite).isSprite) n++; });
  return n;
}

function countMeshes(root: Object3D): number {
  let n = 0;
  root.traverse((child) => { if ((child as Mesh).isMesh) n++; });
  return n;
}

describe('plan-371 — async asset drag & placement', () => {
  // ── T1 ────────────────────────────────────────────────────────────────
  it('T1: shows a placeholder synchronously, before the GLB resolves', () => {
    const { plugin, cache } = setupPlanner();
    cache.stall(GLB_URL);

    // Deliberately NOT awaited — the placeholder must exist by the time
    // _startDraft returns control, not by the time its promise settles.
    void internals(plugin)._startDraft(GLB_ENTRY);

    const draft = internals(plugin)._draft;
    expect(draft).not.toBeNull();
    expect(draft!.node.userData._rvPendingPlaceholder).toBe(true);
    // Before plan-371 this was a no-op returning false until the decode landed.
    expect(internals(plugin)._moveDraft(1, 2)).toBe(true);
    expect(cache.isStalled(GLB_URL)).toBe(true);
  });

  it('T1b: the placeholder box follows the catalog footprint', () => {
    const { plugin, cache } = setupPlanner();
    cache.stall(GLB_URL);
    void internals(plugin)._startDraft(GLB_ENTRY);
    internals(plugin)._moveDraft(0, 0);

    const node = internals(plugin)._draft!.node;
    const box = new Box3();
    box.setFromObject(node);
    // footprintMm [1200, 400] → 1.2 m × 0.4 m in XZ.
    expect(box.max.x - box.min.x).toBeCloseTo(1.2, 2);
    expect(box.max.z - box.min.z).toBeCloseTo(0.4, 2);
  });

  // ── T2 ────────────────────────────────────────────────────────────────
  it('T2: commits the placement while the GLB is still loading', async () => {
    const { plugin, store, cache } = setupPlanner();
    cache.stall(GLB_URL);

    const id = await dragAndDrop(plugin, GLB_ENTRY, [1, 2]);

    expect(store.getSnapshot().placed.find(c => c.id === id)).toBeDefined();
    // The commit really did not wait for the decode.
    expect(cache.isStalled(GLB_URL)).toBe(true);
    expect(internals(plugin)._pending.statusOf(id)).toBe('loading');
  });

  // ── T3 ────────────────────────────────────────────────────────────────
  it('T3: keeps root identity, registry path and elevated Y across the swap', async () => {
    const { plugin, viewer, cache } = setupPlanner();
    addElevatedSurface(viewer, { y: 0.8 });
    cache.stall(GLB_URL);

    const id = await dragAndDrop(plugin, GLB_ENTRY, [3, 4]);

    const rootBefore = internals(plugin)._objectMap.get(id)!;
    const poseBefore = rootBefore.position.clone();
    expect(poseBefore.y).toBeGreaterThan(0.5);   // dropToSurface really fired

    await cache.resolve(GLB_URL);
    await settle();

    const rootAfter = internals(plugin)._objectMap.get(id)!;
    expect(rootAfter).toBe(rootBefore);                        // the SAME root
    expect(rootAfter.position.y).toBeCloseTo(poseBefore.y, 5); // no fall to 0 (B1)
    expect(rootAfter.position.x).toBeCloseTo(poseBefore.x, 5); // no pivot shift (R13)
    expect(rootAfter.position.z).toBeCloseTo(poseBefore.z, 5);
    expect(rootAfter.userData._rvPendingPlaceholder).toBeUndefined();
    // The real geometry is there and the root is still addressable by path.
    expect(rootAfter.children.length).toBeGreaterThan(0);
    const path = viewer.registry.getPathForNode(rootAfter);
    expect(path).not.toBeNull();
    expect(viewer.registry.getNode(path!)).toBe(rootAfter);
  });

  // ── T4 ────────────────────────────────────────────────────────────────
  // Two routes into the same guard. 'undo' reproduces exactly what the
  // SceneStore executor does for the inverse of an addPlacement op
  // (`rv-scene-executors.addPlacementInverse` → `planner.removePlacementById`);
  // 'delete' is the hierarchy/API removal.
  it.each([
    ['delete', (p: unknown, id: string) => (p as { removePlacementById(x: string): void }).removePlacementById(id)],
    ['undo', (p: unknown, id: string) => (p as { removePlacementById(x: string): void }).removePlacementById(id)],
  ])('T4: discards a swap whose placement was %s mid-load', async (_how, act) => {
    const { plugin, cache } = setupPlanner();
    cache.stall(GLB_URL);
    const id = await dragAndDrop(plugin, GLB_ENTRY, [0, 0]);
    const node = internals(plugin)._objectMap.get(id)!;

    act(plugin, id);

    await cache.resolve(GLB_URL);
    await settle();

    expect(internals(plugin)._objectMap.has(id)).toBe(false);
    expect(node.parent).toBeNull();
    expect(node.children.length).toBe(0);   // no geometry was grafted on
    expect(internals(plugin)._pending.pendingIds.size).toBe(0);
  });

  // ── T5 ────────────────────────────────────────────────────────────────
  it('T5: the placeholder never gets processExtras — only the real geometry does', async () => {
    const { plugin, viewer, cache } = setupPlanner();
    cache.stall(GLB_URL);
    const id = await dragAndDrop(plugin, GLB_ENTRY, [0, 0]);

    // LIGHT registration touches the ROOT only: no descendant of the
    // placeholder is in the node registry, and no drives/surfaces appeared.
    const placeholder = internals(plugin)._objectMap.get(id)!;
    const line = placeholder.children.find(c => (c as { isLine?: boolean }).isLine)!;
    expect(line).toBeDefined();
    expect(viewer.registry.getPathForNode(line)).toBeNull();
    expect(viewer.drives.length).toBe(0);
    expect(viewer.transportManager.surfaces.length).toBe(0);

    await cache.resolve(GLB_URL);
    await settle();

    // FULL registration after the swap: the swapped root is registered and the
    // real geometry arrived as the placement's baked chunk.
    //
    // plan-754 F13/D19: this used to read `getPathForNode(swapped.children[0])`.
    // That child is the CHUNK mesh of the baked placement, and since the ONE
    // init a chunk mesh is deliberately not registered — the same contract the
    // main model always had ("their path is computed, not registry-backed",
    // `web_node_tree`). The leaner `processExtras` traversal used to register it
    // under a phantom path, which is what the old assertion was reading.
    const swapped = internals(plugin)._objectMap.get(id)!;
    expect(viewer.registry.getPathForNode(swapped)).not.toBeNull();
    expect(swapped.children.some(c => isChunkMesh(c))).toBe(true);
  });

  // ── T6 ────────────────────────────────────────────────────────────────
  it('T6: disposes placeholder resources but never the shared GLB geometry', async () => {
    const { plugin, cache } = setupPlanner();
    cache.stall(GLB_URL);
    const id = await dragAndDrop(plugin, GLB_ENTRY, [0, 0]);

    const placeholder = internals(plugin)._objectMap.get(id)!;
    const sprite = await waitForThumbnail(placeholder);
    expect(sprite).not.toBeNull();      // the billboard really loaded
    const tracked = trackDisposables(placeholder);
    expect(tracked.lineGeometries.length).toBeGreaterThan(0);
    expect(tracked.spriteMaterials.length).toBeGreaterThan(0);
    expect(tracked.spriteTextures.length).toBeGreaterThan(0);

    await cache.resolve(GLB_URL);
    await settle();

    expect(tracked.lineGeometries.every(d => d.disposed)).toBe(true);
    expect(tracked.lineMaterials.every(d => d.disposed)).toBe(true);
    expect(tracked.spriteMaterials.every(d => d.disposed)).toBe(true);
    expect(tracked.spriteTextures.every(d => d.disposed)).toBe(true);
    // ⛔ The three.js Sprite geometry is a module singleton.
    expect(tracked.sharedSpriteGeometry!.disposed).toBe(false);
    // The shared resource every other placement of this asset draws from is
    // the CHUNK geometry, and it is alive with its asset.
    //
    // CHANGED by plan-754 Phase 1b: this used to read
    // `expect(cache.masterGeometryDisposed(GLB_URL)).toBe(false)` — the
    // plan-753 contract "clones share the master's BufferGeometry". The
    // destructive bake merges the master's source meshes into chunk geometry
    // and frees the sources (§2.4 step 4), so the source box IS disposed now,
    // by design; what must not be disposed moved one level.
    const placed = internals(plugin)._objectMap.get(id)!;
    const chunkGeometries: BufferGeometry[] = [];
    placed.traverse((n) => {
      const mesh = n as Mesh;
      if (mesh.isMesh && mesh.geometry && chunkMetaOf.has(mesh.geometry)) chunkGeometries.push(mesh.geometry);
    });
    expect(chunkGeometries.length).toBeGreaterThan(0);
    for (const g of chunkGeometries) {
      expect(chunkMetaOf.get(g)!.asset.disposed).toBe(false);
      expect(g.getAttribute('position').count).toBeGreaterThan(0);
    }
    expect(cache.masterGeometryDisposed(GLB_URL)).toBe(true);
  });

  // ── T7 ────────────────────────────────────────────────────────────────
  it('T7: the swap does not re-pause the simulation', async () => {
    const { plugin, cache } = setupPlanner();
    cache.stall(GLB_URL);

    plugin.setDragEntry(GLB_ENTRY);
    expect(internals(plugin)._editPauseDepth).toBe(1);
    internals(plugin)._moveDraft(0, 0);
    await internals(plugin)._commitDraft(GLB_ENTRY, [0, 0]);
    internals(plugin)._dropCommitted = true;
    plugin.setDragEntry(null);                  // dragend
    expect(internals(plugin)._editPauseDepth).toBe(0);

    await cache.resolve(GLB_URL);
    await settle();

    expect(internals(plugin)._editPauseDepth).toBe(0);
  });

  // ── T12 ───────────────────────────────────────────────────────────────
  it('T12: two concurrent placeholders of one entry stay independently addressable', async () => {
    const { plugin, viewer, cache } = setupPlanner();
    cache.stall(GLB_URL);

    const idA = await dragAndDrop(plugin, GLB_ENTRY, [0, 0]);
    const idB = await dragAndDrop(plugin, GLB_ENTRY, [5, 0]);
    expect(idA).not.toBe(idB);

    const a = internals(plugin)._objectMap.get(idA)!;
    const b = internals(plugin)._objectMap.get(idB)!;
    const pathA = viewer.registry.getPathForNode(a)!;
    const pathB = viewer.registry.getPathForNode(b)!;

    // resolveUniqueName runs in LIGHT mode too — otherwise the second
    // registerNode would silently overwrite the first (H1/R10).
    expect(pathA).not.toBe(pathB);
    expect(viewer.registry.getNode(pathA)).toBe(a);
    expect(viewer.registry.getNode(pathB)).toBe(b);

    await cache.resolve(GLB_URL);
    await settle();

    expect(internals(plugin)._objectMap.get(idA)!.userData._rvPendingPlaceholder).toBeUndefined();
    expect(internals(plugin)._objectMap.get(idB)!.userData._rvPendingPlaceholder).toBeUndefined();
    // NOTE: a single shared DECODE for both is the `_inflight` map from
    // Phase 5 (T17) and is deliberately not asserted here.
  });

  // ── T14 ───────────────────────────────────────────────────────────────
  it('T14: never disposes the shared three.js Sprite geometry', async () => {
    const { plugin, viewer, cache } = setupPlanner();
    const foreign = addForeignSprite(viewer);
    const foreignGeometry = trackDisposables(foreign);
    cache.stall(GLB_URL);

    const id = await dragAndDrop(plugin, GLB_ENTRY, [0, 0]);
    await waitForThumbnail(internals(plugin)._objectMap.get(id)!);

    plugin.removePlacementById(id);   // placeholder teardown
    plugin.dispose();                 // and the hard path

    expect(foreignGeometry.sharedSpriteGeometry!.disposed).toBe(false);
    // …and it really is the module-wide singleton.
    expect(foreign.geometry).toBe(new Sprite().geometry);
  });

  // ── T15 ───────────────────────────────────────────────────────────────
  it('T15: routes virtual and splat entries away from the placeholder path', async () => {
    const { plugin, cache } = setupPlanner();

    await internals(plugin)._startDraft(VIRTUAL_ENTRY);
    expect(internals(plugin)._draft).not.toBeNull();
    // Virtual entries carry glbUrl: '' — detected by the `virtual` flag, so
    // they never reach getOrLoad and never become pending.
    expect(cache.decodeCount('')).toBe(0);
    expect(internals(plugin)._draft!.node.userData._rvPendingPlaceholder).toBeUndefined();
    expect(internals(plugin)._pending.pendingIds.size).toBe(0);

    internals(plugin)._cancelDraft();
    await internals(plugin)._startDraft(SPLAT_ENTRY);   // pre-existing early return
    expect(internals(plugin)._draft).toBeNull();
    expect(internals(plugin)._pending.pendingIds.size).toBe(0);
  });

  // ── T16 ───────────────────────────────────────────────────────────────
  // The five paths that REMOVE the placement. All of them must cancel the load
  // AND free the placeholder's own resources — including `removeSelected` and
  // `removeByPaths`, which reach the scene mutation through
  // `_removeByPlacementIds` and bypass `removePlacementById` entirely (R15).
  it.each([
    ['dispose', (p: unknown) => (p as { dispose(): void }).dispose()],
    ['cancelDraft', (p: unknown) => internals(p as never)._cancelDraft()],
    ['clearPlaced', (p: unknown) => internals(p as never)._clearPlaced()],
    ['removeSelected', (p: unknown) => (p as { removeSelected(): Promise<void> }).removeSelected()],
    ['removeByPaths', (p: unknown, path: string) =>
      (p as { removeByPaths(x: string[]): Promise<void> }).removeByPaths([path])],
  ])('T16: %s cancels the pending load and frees placeholder resources', async (_name, act) => {
    const { plugin, viewer, cache } = setupPlanner();
    cache.stall(GLB_URL);

    // A gesture still in flight, so `_cancelDraft` has something to cancel.
    await internals(plugin)._startDraft(GLB_ENTRY);
    internals(plugin)._moveDraft(0, 0);
    const id = internals(plugin)._draft!.id;
    const node = internals(plugin)._objectMap.get(id)!;
    await waitForThumbnail(node);
    const tracked = trackDisposables(node);
    const path = viewer.registry.getPathForNode(node)!;

    await act(plugin, path);

    expect(internals(plugin)._pending.pendingIds.size).toBe(0);
    expect(tracked.lineGeometries.every(d => d.disposed)).toBe(true);
    expect(tracked.lineMaterials.every(d => d.disposed)).toBe(true);
    expect(tracked.spriteMaterials.every(d => d.disposed)).toBe(true);
    expect(tracked.spriteTextures.every(d => d.disposed)).toBe(true);
    expect(tracked.sharedSpriteGeometry!.disposed).toBe(false);

    // A late arrival must neither throw nor resurrect anything.
    await cache.resolve(GLB_URL);
    await settle();
    expect(internals(plugin)._objectMap.has(id)).toBe(false);
    expect(node.children.length).toBe(0);
  });

  // Model change is the one cancel path that must NOT delete anything: layout
  // state deliberately survives a model clear (`_layoutRoot` is a scene
  // fixture). It only has to stop the swap, because `prepPlacedVisual` parents
  // placements under `viewer.currentModel` — the node being disposed.
  it('T16b: a model change cancels pending loads without a late swap', async () => {
    const { plugin, cache } = setupPlanner();
    cache.stall(GLB_URL);
    const id = await dragAndDrop(plugin, GLB_ENTRY, [0, 0]);
    const node = internals(plugin)._objectMap.get(id)!;

    plugin.onModelCleared?.(null as never);
    expect(internals(plugin)._pending.pendingIds.size).toBe(0);

    await cache.resolve(GLB_URL);
    await settle();

    // Still a placeholder — the stale result was discarded, not grafted on.
    expect(node.userData._rvPendingPlaceholder).toBe(true);
  });

  // ── T8 ────────────────────────────────────────────────────────────────
  it('T8: marks the placeholder failed, keeps it, and recovers on retry', async () => {
    const { plugin, store, cache, gizmos } = setupPlanner();
    cache.fail(GLB_URL, new Error('404'));

    const id = await dragAndDrop(plugin, GLB_ENTRY, [0, 0]);
    await settle();

    const node = internals(plugin)._objectMap.get(id)!;
    expect(internals(plugin)._pending.statusOf(id)).toBe('error');
    // The placement STAYS. A failed load is not a rollback — the user chose to
    // put this asset here and only its geometry is missing.
    expect(internals(plugin)._objectMap.has(id)).toBe(true);
    expect(node.userData._rvPendingPlaceholder).toBe(true);

    // The failure reaches the HMI status line with the entry's name.
    const failedRow = store.getSnapshot().pendingPlacements.find(p => p.id === id);
    expect(failedRow?.status).toBe('error');
    expect(failedRow?.name).toBe(GLB_ENTRY.name);

    // The state is carried by more than colour: a dashed outline replaces the
    // solid one, and a worded warning badge appears (WCAG 1.4.1).
    const dashed = findLine(node);
    expect((dashed.material as { isLineDashedMaterial?: boolean }).isLineDashedMaterial).toBe(true);
    expect(countSprites(node)).toBeGreaterThanOrEqual(1);

    // Nothing is loading any more, so the motion cue is gone.
    expect(gizmos.liveFor(node)).toBeUndefined();

    // ── Retry ───────────────────────────────────────────────────────────
    const decodesBefore = cache.decodeCount(GLB_URL);
    cache.recover(GLB_URL);
    cache.stall(GLB_URL);
    plugin.retryPendingPlacement(id);
    await settle();

    expect(internals(plugin)._pending.statusOf(id)).toBe('loading');
    // The decisive assertion for §2.10 Rule 1: the retry really re-entered the
    // loader. Without the `_inflight` eviction on rejection it would have been
    // handed the cached failure again and could never succeed.
    expect(cache.decodeCount(GLB_URL)).toBe(decodesBefore + 1);
    // Error visuals cleared, pulse back.
    expect((findLine(node).material as { isLineDashedMaterial?: boolean }).isLineDashedMaterial)
      .toBeUndefined();
    expect(gizmos.liveFor(node)).toBeDefined();

    // ── Success ─────────────────────────────────────────────────────────
    await cache.resolve(GLB_URL);
    await settle();

    expect(internals(plugin)._pending.statusOf(id)).toBeUndefined();
    expect(internals(plugin)._objectMap.get(id)!.userData._rvPendingPlaceholder).toBeUndefined();
    expect(store.getSnapshot().pendingPlacements).toHaveLength(0);
  });

  // The plan sketched this as "an old load returns late after a retry". With
  // the §2.10 decode dedup in place that shape cannot occur through the FAILURE
  // path (a rejection evicts `_inflight`, so the retry starts a genuinely new
  // decode). The case that CAN occur is a retry issued while the first attempt
  // is still in flight: both consumers then await the SAME shared decode, and
  // only the current generation may act on it.
  it('T8b: a superseded generation ignores the shared result it also awaits', async () => {
    const { plugin, cache } = setupPlanner();
    cache.stall(GLB_URL);
    const id = await dragAndDrop(plugin, GLB_ENTRY, [0, 0]);

    // Supersede generation 1 while its load is still stalled.
    internals(plugin)._pending.retry(id);
    expect(cache.decodeCount(GLB_URL)).toBe(1); // joined, not re-decoded

    await cache.resolve(GLB_URL);
    await settle();

    const root = internals(plugin)._objectMap.get(id)!;
    expect(root.userData._rvPendingPlaceholder).toBeUndefined();
    // Exactly ONE swap: the stale consumer bailed at the generation check
    // instead of adopting a second copy of the geometry.
    expect(countMeshes(root)).toBe(1);
  });

  // ── T10 ───────────────────────────────────────────────────────────────
  it('T10: persists a valid placement while its geometry is still loading', async () => {
    const { plugin, store, cache } = setupPlanner();
    cache.stall(GLB_URL);
    const id = await dragAndDrop(plugin, GLB_ENTRY, [5, 6]);

    const snap = store.getSnapshot();
    const saved = serializeLayout('test', [...snap.placed], [], snap.gridSizeMm);

    // A pending placement's store entry is indistinguishable from a finished
    // one: `glbUrl` was there from the first frame, so a save mid-load writes a
    // correct layout with no guard in the persistence path.
    const comp = saved.components.find((c) => c.id === id);
    expect(comp).toBeDefined();
    expect(comp!.glbUrl).toBe(GLB_URL);

    // And nothing of the RUNTIME pending state leaks into the file.
    const json = JSON.stringify(saved);
    expect(json).not.toContain('_rvPendingPlaceholder');
    expect(json).not.toContain('pendingPlacements');
    expect(json).not.toContain('placeholder');
  });

  // ── T11 ───────────────────────────────────────────────────────────────
  it('T11: disables the pulse under prefers-reduced-motion', async () => {
    const media = makeFakeMedia(true);
    const { plugin, cache, gizmos } = setupPlanner({ matchMedia: media.matchMedia });
    cache.stall(GLB_URL);

    const id = await dragAndDrop(plugin, GLB_ENTRY, [0, 0]);
    const node = internals(plugin)._objectMap.get(id)!;

    // Reduced motion means NO motion, not gentler motion — the pulse is off
    // outright. The wireframe box and the status line still carry the message.
    expect(gizmos.liveFor(node)!.options.blinkHz).toBe(0);
  });

  it('T11b: pulses at 1.5 Hz without the preference, and reacts to a live flip', async () => {
    const media = makeFakeMedia(false);
    const { plugin, cache, gizmos } = setupPlanner({ matchMedia: media.matchMedia });
    cache.stall(GLB_URL);

    const id = await dragAndDrop(plugin, GLB_ENTRY, [0, 0]);
    const node = internals(plugin)._objectMap.get(id)!;
    const gizmo = gizmos.liveFor(node)!;

    // Half the WCAG 2.3.1 flash threshold, and the same constant the signal
    // badges use — the viewer has exactly one pulse speed.
    expect(gizmo.options.blinkHz).toBe(CONFLICT_BLINK_HZ);
    expect(gizmo.options.blinkHz).toBeLessThan(3);

    // Turning the OS preference on must take effect without a reload.
    media.set(true);
    expect(gizmo.updates.at(-1)).toEqual({ blinkHz: 0 });
  });

  it('T11c: the reduced-motion listener is released on teardown', async () => {
    const media = makeFakeMedia(false);
    const { plugin, cache } = setupPlanner({ matchMedia: media.matchMedia });
    cache.stall(GLB_URL);
    await dragAndDrop(plugin, GLB_ENTRY, [0, 0]);

    expect(media.listenerCount()).toBe(1);
    plugin.dispose();
    expect(media.listenerCount()).toBe(0);
  });
});
