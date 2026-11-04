// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import { NodeRegistry } from '../engine/rv-node-registry';

/** Singleton node name carrying the DESManager component. */
export const DES_MANAGER_NODE = 'Simulation';
/** Default run duration when the scene has no DESManager component. */
export const DES_DEFAULT_END_TIME_S = 86400;
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

/**
 * True for the DESManager run-parameter fields (end time, warm-up, seed). They are
 * run configuration, not model: a DES snapshot restore never compares them
 * (plan-2059, Thomas 2026-11-01), so editing them is no model edit and the
 * snapshot fingerprint leaves them out of the scene rows.
 */
export function isDesRunConfigField(component: string, field: string): boolean {
  return component === DES_MANAGER_COMPONENT
    && (field === DES_END_TIME_FIELD || field === DES_STAT_RESET_FIELD || field === DES_MASTER_SEED_FIELD);
}

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
 * 86400 s (one day) end, no warmup).
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

