// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ONE state collector for both test runners (plan-600 F5): Playwright reads it
 * through `page.evaluate` off the globally exposed `window.viewer`, vitest
 * calls it directly. There is no second projection of the viewer's state, and
 * a golden is only ever compared against what this function returns.
 *
 * The field list is CLOSED (plan 2.3). Adding a field is a plan decision, not
 * an implementation detail — every added field is a new source of golden churn.
 *
 * What is deliberately NOT in here: anything wall-clock derived (timestamps,
 * FPS, load durations, hash URLs). A golden containing one of those is a golden
 * that fails on a fast machine.
 *
 * The collector is duck-typed on purpose ({@link SnapshotSource}): a unit test
 * may hand in a minimal viewer-shaped object, and a real `RVViewer` satisfies
 * it structurally. Where a field cannot be read it is `null` — never guessed.
 */

import type { Object3D } from 'three';
import { deriveModelKey } from './rv-model-key';
import { getSceneStore } from '../hmi/scene/scene-store-singleton';
import { getProblems } from '../hmi/problems-store';

/**
 * Decimal places drive positions are rounded to before comparison.
 *
 * MEASURED, not assumed (plan 2.3 / section 6): two fresh runs of the final
 * test clock returned drive positions that were identical UNROUNDED over 21
 * drives and 5 intermediate states (`e2e/clock-determinism.spec.ts`), so
 * rounding buys no determinism — it is a margin against GPU/driver drift
 * between machines. Positions are millimetres, so 3 places is a micrometre:
 * far below anything a real change would hide, and far above float noise.
 */
export const DRIVE_ROUNDING_DECIMALS = 3;

/** Panel sides the snapshot records, in this order. */
const PANEL_SIDES = ['left', 'right'] as const;

/** The closed golden field list (plan 2.3). */
export interface StateSnapshot {
  /** `ModeManager.activeMode`. */
  mode: string | null;
  /** `SceneStore.openDocumentId`. */
  documentId: string | null;
  /** `deriveModelKey(currentModelUrl)` — no hash, no URL. */
  modelKey: string | null;
  /** Node path -> `currentPosition`, rounded to {@link DRIVE_ROUNDING_DECIMALS}. */
  drives: Record<string, number>;
  /** `signalStore.getAll()`, values EXACT (a signal value is data, not a measurement). */
  signals: Record<string, boolean | number | string>;
  /** Active errors as `path` strings, sorted (see {@link collectStateSnapshot}). */
  alarms: string[];
  /** `selectionManager.selectedPaths`, sorted. */
  selection: string[];
  /** `side:panelId` for each side with an active panel, sorted. */
  panels: string[];
  /** `registry.size.nodes`; `null` without a registry — not 0. */
  nodeCount: number | null;
  /** Problems with `severity === 'error'`, as `code` strings, sorted. */
  problems: string[];
}

/** Everything the collector reads — all optional, all read-only. */
export interface SnapshotSource {
  modes?: { activeMode?: string | null } | null;
  currentModelUrl?: string | null;
  drives?: ReadonlyArray<{ node?: Object3D; name?: string; currentPosition?: number }> | null;
  registry?: {
    size?: { nodes?: number } | null;
    getPathForNode?(node: Object3D): string | null;
  } | null;
  signalStore?: { getAll?(): Map<string, boolean | number> } | null;
  errorStore?: { getActive?(): ReadonlyArray<{ path?: string }> } | null;
  selectionManager?: { selectedPaths?: ReadonlyArray<string> } | null;
  leftPanelManager?: { getActive?(side: 'left' | 'right'): string | null } | null;
}

/** Rounds to {@link DRIVE_ROUNDING_DECIMALS}; leaves non-finite values alone. */
function roundDrive(value: number): number {
  if (!Number.isFinite(value)) return value;
  const f = 10 ** DRIVE_ROUNDING_DECIMALS;
  return Math.round(value * f) / f;
}

/** Inserts entries into a fresh object in sorted key order (stable diffs). */
function sortedRecord<T>(entries: Array<[string, T]>): Record<string, T> {
  const out: Record<string, T> = {};
  for (const [k, v] of entries.sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))) out[k] = v;
  return out;
}

/**
 * Collects the comparable state of a viewer.
 *
 * Two projections worth knowing about:
 *
 * - **`alarms` are `path` strings, not texts.** `ErrorEntry` (rv-error-store.ts)
 *   carries `path`, `text`, `active` and `since` — there is no `code` field.
 *   `path` IS its machine-readable identity (it is the store's map key), so it
 *   is what gets projected; `text` would make every wording change a red
 *   golden, which is exactly what plan 2.3 rules out.
 * - **`problems` are `code` strings** and filtered on `severity === 'error'`,
 *   the field the store maintains itself — never an allowlist of codes.
 *
 * The problems store is a module singleton rather than a viewer member, so it
 * is read here directly; that keeps "one collector" true for both runners.
 */
export function collectStateSnapshot(viewer: SnapshotSource): StateSnapshot {
  const registry = viewer.registry ?? null;

  const driveEntries: Array<[string, number]> = [];
  for (const drive of viewer.drives ?? []) {
    const path = (drive.node && registry?.getPathForNode?.(drive.node)) || drive.name || null;
    if (path === null) continue;
    driveEntries.push([path, roundDrive(drive.currentPosition ?? 0)]);
  }

  const signalEntries: Array<[string, boolean | number | string]> = [];
  const all = viewer.signalStore?.getAll?.();
  if (all) for (const [name, value] of all) signalEntries.push([name, value]);

  const alarms = [...(viewer.errorStore?.getActive?.() ?? [])]
    .map((e) => e.path ?? '')
    .filter((p) => p !== '')
    .sort();

  const panels: string[] = [];
  for (const side of PANEL_SIDES) {
    const active = viewer.leftPanelManager?.getActive?.(side) ?? null;
    if (active) panels.push(`${side}:${active}`);
  }

  const problems = getProblems()
    .filter((p) => p.severity === 'error')
    .map((p) => p.code)
    .sort();

  // Key order is the declaration order of StateSnapshot — a golden's JSON is
  // then byte-stable for an unchanged state.
  return {
    mode: viewer.modes?.activeMode ?? null,
    documentId: getSceneStore()?.openDocumentId ?? null,
    modelKey: deriveModelKey(viewer.currentModelUrl),
    drives: sortedRecord(driveEntries),
    signals: sortedRecord(signalEntries),
    alarms,
    selection: [...(viewer.selectionManager?.selectedPaths ?? [])].sort(),
    panels: panels.sort(),
    nodeCount: registry?.size?.nodes ?? null,
    problems,
  };
}
