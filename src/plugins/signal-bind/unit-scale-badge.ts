// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * unit-scale-badge.ts — the inspector side of plan-512: which number field of
 * a component section is the scale field of a bound slot, and what the ONE
 * evaluator (`evaluateUnitBinding`) says about it. `ComponentSection` hands the
 * result to `FieldRow.derived`; the rendering lives there.
 */

import { useCallback, useMemo, useSyncExternalStore } from 'react';
import type { RVViewer } from '../../core/rv-viewer';
import { getEditTargetVersion, subscribeEditTarget } from '../../core/hmi/rv-edit-target';
import type { SignalMapping } from '../layout-planner/rv-layout-store';
import { findSignalBindTarget } from './signal-bind-target';
import { createSignalBindingPersistence } from './signal-binding-persistence';
import {
  describeUnitStatus,
  evaluateTargetUnits,
  resetScaleToAuto,
  type UnitBindingStatus,
} from './unit-scale';

/** What a scale field's row shows (plan-512 F8). */
export interface UnitScaleDerived {
  status: Exclude<UnitBindingStatus, { kind: 'none' }>;
  /** Tooltip sentence (the same text the Problems entry uses). */
  tooltip: string;
  /** `manual` only: one transaction back to the automatic factor (+ provenance). */
  onResetToAuto?: () => void;
}

const EMPTY: ReadonlyMap<string, UnitScaleDerived> = new Map();

/** Which status a shared field shows when several slots speak about it — the most urgent. */
const RANK: Record<UnitBindingStatus['kind'], number> = {
  none: 0, auto: 1, 'not-applied': 2, manual: 3, 'not-effective': 4, unknown: 5, mismatch: 6, conflict: 7,
};

function sameNode(viewer: RVViewer, a: string, b: string): boolean {
  if (a === b) return true;
  const registry = viewer.registry;
  const na = registry?.getNode(a);
  return !!na && na === registry?.getNode(b);
}

/** Pure part of {@link useUnitScaleBadges} — testable without React. */
export function computeUnitScaleBadges(
  viewer: RVViewer,
  nodePath: string,
  componentType: string,
): ReadonlyMap<string, UnitScaleDerived> {
  const node = viewer.registry?.getNode(nodePath);
  if (!node || !viewer.signalBindingManager) return EMPTY;
  const target = findSignalBindTarget(viewer, node);
  if (!target) return EMPTY;
  const persistence = createSignalBindingPersistence(viewer, target);
  const mappings = persistence.read();
  if (mappings.length === 0) return EMPTY;
  const out = new Map<string, UnitScaleDerived>();
  for (const e of evaluateTargetUnits(viewer, target, mappings)) {
    if (e.status.kind === 'none') continue;
    if (e.componentType !== componentType || !sameNode(viewer, e.nodePath, nodePath)) continue;
    const status = e.status;
    const prev = out.get(status.field);
    if (prev && RANK[prev.status.kind] >= RANK[status.kind]) continue;
    const mapping: SignalMapping = e.mapping;
    out.set(status.field, {
      status,
      tooltip: describeUnitStatus(status, mapping.signal),
      ...(status.kind === 'manual'
        ? {
          onResetToAuto: () => {
            void resetScaleToAuto(viewer, target, persistence, {
              slot: mapping.slot, componentPath: mapping.componentPath, kind: mapping.kind,
            });
          },
        }
        : {}),
    });
  }
  return out;
}

/**
 * The unit badges of one component section, keyed by scale-field name. Live:
 * re-derived when the target's mappings change, when the section's data
 * changes (`dataKey`), and when the edit target switches (writability).
 */
export function useUnitScaleBadges(
  viewer: RVViewer | null,
  nodePath: string,
  componentType: string,
  dataKey: unknown,
): ReadonlyMap<string, UnitScaleDerived> {
  const node = viewer?.registry?.getNode(nodePath) ?? null;
  const target = useMemo(
    () => (viewer?.signalBindingManager && node ? findSignalBindTarget(viewer, node) : null),
    [viewer, node],
  );
  const persistence = useMemo(
    () => (viewer && target ? createSignalBindingPersistence(viewer, target) : null),
    [viewer, target],
  );
  const subscribe = useCallback(
    (listener: () => void) => persistence?.subscribe(listener) ?? (() => {}),
    [persistence],
  );
  const snapshot = useCallback(() => (persistence ? JSON.stringify(persistence.read()) : ''), [persistence]);
  const mappingsKey = useSyncExternalStore(subscribe, snapshot);
  const editTargetVersion = useSyncExternalStore(subscribeEditTarget, getEditTargetVersion);
  return useMemo(
    () => (viewer && target ? computeUnitScaleBadges(viewer, nodePath, componentType) : EMPTY),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewer, target, nodePath, componentType, mappingsKey, dataKey, editTargetVersion],
  );
}
