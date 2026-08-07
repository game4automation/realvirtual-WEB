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
 * undoable) and auto-creates the singleton node on DES-mode entry.
 *
 * Time convention (JSON-safe — `Infinity` is not): `EndTime <= 0` means "infinite"
 * (run until the event queue empties); a positive value is the end in seconds.
 * `StatisticsResetTime <= 0` means "off" (no warmup discard).
 */

import type { Object3D } from 'three';
import { NodeRegistry } from '../engine/rv-node-registry';
import { getSceneStore } from '../hmi/scene/scene-store-singleton';
import { persistFieldOp } from '../hmi/scene/scene-field-ops';
import { freshOpId } from '../hmi/scene/rv-scene-edits';
import type { RuntimeNodeSpec } from '../engine/rv-scene-loader';

/** Singleton node name carrying the DESManager component. */
export const DES_MANAGER_NODE = 'Simulation';
/** Component type (matches the Unity C# DESManager for porting parity). */
export const DES_MANAGER_COMPONENT = 'DESManager';
/** Field: sim end in seconds; `<= 0` = infinite. */
export const DES_END_TIME_FIELD = 'EndTime';
/** Field: statistics-reset (warmup) in seconds; `<= 0` = off. */
export const DES_STAT_RESET_FIELD = 'StatisticsResetTime';
/** Field: master PRNG seed. SENTINEL (plan-261 B5): missing or `<= 0` means
 *  "no override" — the DES manager's code default (42) stays active. Only an
 *  explicitly set POSITIVE seed overrides. (A naive `numField()` read would
 *  turn every legacy GLB without the field into seed 0 → different RNG stream
 *  → silently different results.) */
export const DES_MASTER_SEED_FIELD = 'MasterSeed';

/** Parsed DESManager clock settings + the bookkeeping the persister needs. */
export interface DesManagerSettings {
  /** Registry path of the DESManager-carrying node. */
  path: string;
  /** Sim end in seconds; `Infinity` = infinite. */
  endTime: number;
  /** Statistics-reset (warmup) in seconds; `0` = off. */
  statResetTime: number;
  /** Master PRNG seed; `0` = NOT SET (sentinel, B5) — caller keeps its default. */
  masterSeed: number;
  /** Raw `EndTime` field (`<= 0` = infinite) — the `prev` for a setField op. */
  rawEndTime: number;
  /** Raw `StatisticsResetTime` field — the `prev` for a setField op. */
  rawStatReset: number;
  /** Raw `MasterSeed` field — the `prev` for a setField op. */
  rawMasterSeed: number;
}

/** Minimal viewer surface this helper needs (kept structural — no RVViewer import). */
export interface DesManagerViewerLike {
  readonly scene: Object3D;
  readonly registry: { getPathForNode(n: Object3D): string | null } | null;
}

/** One DESManager hit while traversing the scene. */
interface DesManagerHit { node: Object3D; data: Record<string, unknown> }

interface RvUserData { realvirtual?: Record<string, Record<string, unknown>> }

function numField(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : 0;
}

/** Map a raw `EndTime` field to the live duration (`<= 0` → `Infinity`). */
function endTimeOf(rawEndTime: number): number {
  return rawEndTime > 0 ? rawEndTime : Infinity;
}

/**
 * Find the DESManager component anywhere in `root` and parse its clock fields.
 * Returns `null` when no node carries the component (defaults then apply:
 * infinite end, no warmup).
 */
export function findDesManager(root: Object3D): DesManagerSettings | null {
  const hits: DesManagerHit[] = [];
  root.traverse((n) => {
    if (hits.length) return; // first match wins (singleton)
    const data = (n.userData as RvUserData).realvirtual?.[DES_MANAGER_COMPONENT];
    if (data) hits.push({ node: n, data });
  });
  const found = hits[0];
  if (!found) return null;
  const rawEndTime = numField(found.data[DES_END_TIME_FIELD]);
  const rawStatReset = numField(found.data[DES_STAT_RESET_FIELD]);
  const rawMasterSeed = numField(found.data[DES_MASTER_SEED_FIELD]);
  return {
    path: NodeRegistry.computeNodePath(found.node),
    endTime: endTimeOf(rawEndTime),
    statResetTime: rawStatReset > 0 ? rawStatReset : 0,
    // B5 sentinel: missing / <= 0 → 0 = "no override" (code default 42 stays).
    masterSeed: rawMasterSeed > 0 ? rawMasterSeed : 0,
    rawEndTime,
    rawStatReset,
    rawMasterSeed,
  };
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

/**
 * Ensure the singleton `Simulation` node with a `DESManager` component exists,
 * creating it via an addNode op when absent (so it persists with the scene). Used
 * on DES-mode entry (auto-singleton, like the Unity DESManager). Returns the
 * current settings; when no SceneStore / parent is available it still returns a
 * live-only default (infinite, no warmup) so callers degrade gracefully.
 */
export function ensureDesManagerNode(viewer: DesManagerViewerLike): DesManagerSettings {
  // Defensive: no scene yet (pre-load / unit mocks) → live-only default, no crash.
  const liveDefault: DesManagerSettings = { path: DES_MANAGER_NODE, endTime: Infinity, statResetTime: 0, masterSeed: 0, rawEndTime: 0, rawStatReset: 0, rawMasterSeed: 0 };
  if (!viewer.scene) return liveDefault;

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
      components: { [DES_MANAGER_COMPONENT]: { [DES_END_TIME_FIELD]: 0, [DES_STAT_RESET_FIELD]: 0, [DES_MASTER_SEED_FIELD]: 0 } },
    };
    void store.applyOp({ id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'addNode', nodePath, spec });
  }
  return { path: nodePath, endTime: Infinity, statResetTime: 0, masterSeed: 0, rawEndTime: 0, rawStatReset: 0, rawMasterSeed: 0 };
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
