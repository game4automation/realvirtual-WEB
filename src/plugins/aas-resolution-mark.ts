// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * aas-resolution-mark.ts — the node marking of the AAS resolution contract
 * (state type, userData key, readers, `markAasPending`), without any of the
 * resolution machinery.
 *
 * Split out of `aas-resolution.ts` for plan-596: the resolution pass now reads
 * the active AAS source, which reaches the project store. The scene loader and
 * the attach helper only need to MARK a node as pending; importing them from
 * here keeps the project store (and with it a cycle back into the scene loader)
 * out of the scene loader's static import graph. `aas-resolution.ts`
 * re-exports everything, so every other importer keeps its import path.
 */

import type { Object3D } from 'three';

/** Resolution state of a single AAS link. Stored as `node.userData._rvAasResolution`. */
export type AasResolution =
  | 'resolved'
  | 'unknown-id'
  | 'index-missing'
  | 'index-error'
  | 'pending';

/** userData key carrying the resolution. Kept as a constant so tests cannot drift. */
export const AAS_RESOLUTION_KEY = '_rvAasResolution';

/**
 * Read a node's AAS resolution. A node that carries an AAS link but no marking
 * yet counts as `'pending'` — never as resolved, so nothing is shown before the
 * index answered.
 */
export function getAasResolution(node: Object3D | null | undefined): AasResolution {
  const raw = node?.userData?.[AAS_RESOLUTION_KEY] as AasResolution | undefined;
  return raw ?? 'pending';
}

/**
 * True when every AAS surface must stay silent for this state: the id is unknown
 * or the index was never shipped. `'pending'` is handled by {@link isAasVisible}
 * (render nothing, but it is not a final answer).
 */
export function isAasUnresolvable(resolution: AasResolution): boolean {
  return resolution === 'unknown-id' || resolution === 'index-missing';
}

/** True when an AAS surface may render for this state (`resolved` or a visible error). */
export function isAasVisible(resolution: AasResolution): boolean {
  return resolution === 'resolved' || resolution === 'index-error';
}

/** True when the node carries an AAS link that may be shown. */
export function isAasNodeVisible(node: Object3D | null | undefined): boolean {
  return isAasVisible(getAasResolution(node));
}

/**
 * Mark a node as not-yet-classified. Called synchronously wherever an AAS link is
 * attached, so an unmarked AAS node never exists — a node without a marking would
 * otherwise be indistinguishable from one that resolved.
 */
export function markAasPending(node: Object3D | null | undefined): void {
  if (!node) return;
  const ud = node.userData as Record<string, unknown>;
  if (ud[AAS_RESOLUTION_KEY] === undefined) ud[AAS_RESOLUTION_KEY] = 'pending';
}
