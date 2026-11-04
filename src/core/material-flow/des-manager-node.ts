// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * des-manager-node.ts — the DES clock settings as a SCENE COMPONENT (GLB-first).
 *
 * The simulation END time and the statistics-RESET (warmup) time are stored as a
 * `DESManager` component on a singleton `Simulation` node in the scene — the web
 * parallel to the Unity `DESManager` GameObject. This makes the settings part of
 * the scene's rv_extras: they round-trip through save / load, undo / redo and the
 * op log with NO side-channel. The DES runner READS them on start and applies
 * them to the live manager; the toolbar WRITES them through the op log (durable +
 * undoable) and creates the singleton node with its FIRST edit — DES-mode entry
 * only reads (plan-616 Teil 1).
 *
 * Time convention (JSON-safe — `Infinity` is not): `EndTime <= 0` means "infinite"
 * (run until the event queue empties); a positive value is the end in seconds.
 * `StatisticsResetTime <= 0` means "off" (no warmup discard).
 */

import type { Object3D } from 'three';
import { getSceneStore } from '../hmi/scene/scene-store-singleton';
import { persistFieldOp } from '../hmi/scene/scene-field-ops';
import { getActiveEditTarget } from '../hmi/rv-edit-target';
import { runLeaseBlocker } from '../hmi/rv-run-lease';
import { freshOpId } from '../hmi/scene/rv-scene-edits';
import type { RuntimeNodeSpec } from '../engine/rv-scene-loader';

import { DES_MANAGER_NODE, DES_MANAGER_COMPONENT, DES_END_TIME_FIELD, DES_STAT_RESET_FIELD, DES_MASTER_SEED_FIELD, findDesManager } from './des-manager-settings';
import type { DesManagerSettings } from './des-manager-settings';
import { DES_DEFAULT_END_TIME_S } from './des-manager-settings';

export { DES_MANAGER_NODE, DES_MANAGER_COMPONENT, DES_END_TIME_FIELD, DES_STAT_RESET_FIELD, DES_MASTER_SEED_FIELD, findDesManager } from './des-manager-settings';
export type { DesManagerSettings } from './des-manager-settings';

/** Minimal viewer surface this helper needs (kept structural — no RVViewer import). */
export interface DesManagerViewerLike {
  readonly scene: Object3D;
  readonly registry: { getPathForNode(n: Object3D): string | null } | null;
}

/** Resolve a registered parent for the singleton node (a top-level scene node —
 *  the loaded model / layout root). The singleton lives under it so its path is
 *  stable across reloads. */
function resolveParentPath(viewer: DesManagerViewerLike): string | null {
  const reg = viewer.registry;
  if (!reg) return null;
  for (const child of viewer.scene.children) {
    const p = reg.getPathForNode(child);
    if (p != null) return p;
  }
  return null;
}

/** The settings of a scene without a DESManager node: one day end, no warmup,
 *  no seed override — exactly what a freshly created node holds. */
function liveDefault(): DesManagerSettings {
  return { path: DES_MANAGER_NODE, endTime: DES_DEFAULT_END_TIME_S, statResetTime: 0, masterSeed: 0, rawEndTime: DES_DEFAULT_END_TIME_S, rawStatReset: 0, rawMasterSeed: 0 };
}

/**
 * Read the clock settings WITHOUT creating anything (plan-616 Teil 1).
 *
 * Entering the DES mode must not edit the document: an `addNode` op on mode
 * entry made every scene dirty without a user edit, and that dirty state is what
 * forked the editor's document on its next entry (LOP #196). The node is created
 * by the first toolbar EDIT instead ({@link ensureDesManagerNode}). Without a
 * node the answer is the live default, which equals a freshly created node.
 *
 * Note: the default's `path` is the bare `Simulation`, not the
 * `<parent>/Simulation` a created node gets — so it is no address to persist
 * against; a persister must go through {@link ensureDesManagerNode}.
 */
export function readDesManagerSettings(viewer: DesManagerViewerLike): DesManagerSettings {
  if (!viewer.scene) return liveDefault();
  return findDesManager(viewer.scene) ?? liveDefault();
}

/**
 * Ensure the singleton `Simulation` node with a `DESManager` component exists,
 * creating it via an addNode op when absent (so it persists with the scene). Used
 * by the toolbar's EDITS, right before their `setField` op (plan-616 Teil 1 — DES
 * mode entry only reads, see {@link readDesManagerSettings}). Both ops go through
 * the same document queue, which runs them in call order, so the `addNode` lands
 * before the `setField` without an await. Returns the current settings; when no
 * SceneStore / parent is available it still returns a live-only default
 * (one day, no warmup) so callers degrade gracefully.
 */
export function ensureDesManagerNode(viewer: DesManagerViewerLike): DesManagerSettings {
  // Defensive: no scene yet (pre-load / unit mocks) → live-only default, no crash.
  if (!viewer.scene) return liveDefault();

  const existing = findDesManager(viewer.scene);
  if (existing) return existing;

  const store = getSceneStore();
  const parentPath = resolveParentPath(viewer);
  const nodePath = (parentPath ? parentPath + '/' : '') + DES_MANAGER_NODE;
  if (store && parentPath != null) {
    const spec: RuntimeNodeSpec = {
      parentPath,
      name: DES_MANAGER_NODE,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      components: { [DES_MANAGER_COMPONENT]: { [DES_END_TIME_FIELD]: DES_DEFAULT_END_TIME_S, [DES_STAT_RESET_FIELD]: 0, [DES_MASTER_SEED_FIELD]: 0 } },
    };
    // Verified, not fire-and-forget: a document that refuses ops (a load or a
    // replace in progress) drops the op silently, and the `setField` that
    // follows would then address a node that does not exist.
    const scene = viewer.scene;
    Promise.resolve(store.applyOp({ id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'addNode', nodePath, spec }))
      .then(() => {
        if (!findDesManager(scene)) {
          console.warn(`[des-manager-node] '${nodePath}' was not created — the scene refused the edit; the DES setting is live-only.`);
        }
      }, (e: unknown) => {
        console.warn(`[des-manager-node] creating '${nodePath}' failed:`, e);
      });
  }
  return { ...liveDefault(), path: nodePath };
}

/**
 * Persist the sim END time durably (setField op). `seconds` infinite/`<= 0` is
 * stored as `0` (the "infinite" sentinel). `prev` is the prior raw field value
 * so undo restores it. No-op without a SceneStore (the live manager is already
 * updated by the caller).
 */
export function persistDesEndTime(settings: DesManagerSettings, seconds: number): void {
  const raw = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  persistFieldOp(settings.path, DES_MANAGER_COMPONENT, DES_END_TIME_FIELD, raw, settings.rawEndTime);
}

/** Persist the statistics-reset (warmup) time durably (setField op). */
export function persistDesStatReset(settings: DesManagerSettings, seconds: number): void {
  const raw = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  persistFieldOp(settings.path, DES_MANAGER_COMPONENT, DES_STAT_RESET_FIELD, raw, settings.rawStatReset);
}

/** Persist the master seed durably (setField op). `<= 0` stores the "not set"
 *  sentinel (0) — the DES manager keeps its code default (B5). */
export function persistDesMasterSeed(settings: DesManagerSettings, seed: number): void {
  const raw = Number.isFinite(seed) && seed > 0 ? Math.floor(seed) : 0;
  persistFieldOp(settings.path, DES_MANAGER_COMPONENT, DES_MASTER_SEED_FIELD, raw, settings.rawMasterSeed);
}

/** Why a seed edit is refused while a variant is in the scene: the seed is a Base (scene) setting. */
export const SEED_IN_VARIANT_REASON = 'The random seed is a Base setting — return to Base to change it';
/** Why a seed edit is refused while an experiment batch holds the run lease. */
export const SEED_DURING_BATCH_REASON = 'An experiment is running; the seed cannot change now';

/**
 * Set the master seed — the seed field of the clock window and `des.seed.set` (plan-2208b B3).
 *
 * The scene write comes first and is awaited; only when it is accepted does the live DES get the
 * new seed, so a refused, dropped or failed write changes nothing live. "Accepted" is read back from
 * the scene: the document drops ops silently while it loads or is replaced (`canApply`), so a
 * resolved write alone proves nothing. With a variant in the scene the seed is refused up front (the
 * variant edit target cannot hold DESManager.MasterSeed). After the write, the run lease, the edit
 * target, its document and the DES controller are checked again: a batch that started meanwhile
 * must not have its replication reseeded. Without a document (pre-boot) the seed is live-only.
 */
export async function applyDesMasterSeed(viewer: DesManagerViewerLike, control: { setMasterSeed?(seed: number): void } | null | undefined, seed: number): Promise<{ ok: true } | { ok: false; code: 'invalid' | 'refused' | 'failed'; reason: string }> {
  const value = Math.floor(seed);
  if (!Number.isFinite(value) || value <= 0) return { ok: false, code: 'invalid', reason: 'The seed must be a positive integer' };
  const target = getActiveEditTarget();
  if (target.persistsTo === 'variant') return { ok: false, code: 'refused', reason: SEED_IN_VARIANT_REASON };
  if (runLeaseBlocker()) return { ok: false, code: 'refused', reason: SEED_DURING_BATCH_REASON };
  // Read through the viewer every time: a model replacement swaps the kernel, and the old one keeps
  // answering with its (detached) controller.
  const kernelOf = () => (viewer as { simulationKernel?: { desControl?(): unknown } | null }).simulationKernel ?? null;
  const kernel = kernelOf();
  const document = target.documentKey;
  if (target.available) {
    const settings = ensureDesManagerNode(viewer);
    const pre = target.trySetField?.(settings.path, DES_MANAGER_COMPONENT, DES_MASTER_SEED_FIELD, value);
    if (pre && !pre.ok) return { ok: false, code: 'refused', reason: pre.reason };
    try {
      if (target.setFieldAsync) await target.setFieldAsync(settings.path, DES_MANAGER_COMPONENT, DES_MASTER_SEED_FIELD, value, settings.rawMasterSeed);
      else await target.setField(settings.path, DES_MANAGER_COMPONENT, DES_MASTER_SEED_FIELD, value, settings.rawMasterSeed);
    } catch (e) {
      return { ok: false, code: 'failed', reason: `The seed was not saved: ${e instanceof Error ? e.message : String(e)}` };
    }
    const stored = viewer.scene ? findDesManager(viewer.scene) : null;
    if (!stored || stored.rawMasterSeed !== value) {
      return { ok: false, code: 'failed', reason: 'The seed was not saved: the scene did not accept the edit (it may be loading); try again' };
    }
  }
  // Everything the write waited for may have changed: never reseed a batch or another document's run.
  if (runLeaseBlocker()) return { ok: false, code: 'refused', reason: SEED_DURING_BATCH_REASON };
  const now = getActiveEditTarget();
  const nowKernel = kernelOf();
  if (now !== target || now.documentKey !== document || nowKernel !== kernel || (nowKernel && nowKernel.desControl?.() !== control)) {
    return { ok: false, code: 'refused', reason: 'The document or the simulation changed while the seed was saved; the live seed was not changed' };
  }
  control?.setMasterSeed?.(value);
  return { ok: true };
}
