// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 test 9.2 — drive positions rounded, signal values NOT; arrays
 * sorted, key order stable; `alarms` / `problems` projected as machine-readable
 * strings rather than display text.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import {
  DRIVE_ROUNDING_DECIMALS,
  collectStateSnapshot,
  type SnapshotSource,
} from '../src/core/engine/rv-state-snapshot';
import { clearAllProblems, reportProblem } from '../src/core/hmi/problems-store';

function viewerWith(partial: SnapshotSource): SnapshotSource {
  return { modes: { activeMode: 'hmi' }, ...partial };
}

describe('collectStateSnapshot — rounding and projection', () => {
  beforeEach(() => { clearAllProblems(); });

  it('rounds drive positions to the documented decimal count', () => {
    expect(DRIVE_ROUNDING_DECIMALS).toBe(3);
    const node = new Object3D();
    const snap = collectStateSnapshot(viewerWith({
      drives: [{ node, name: 'D', currentPosition: 3796.6666666666665 }],
      registry: { getPathForNode: () => 'Line/D' },
    }));
    expect(snap.drives['Line/D']).toBe(3796.667);
  });

  it('leaves signal values EXACT — a signal value is data, not a measurement', () => {
    const snap = collectStateSnapshot(viewerWith({
      signalStore: { getAll: () => new Map<string, boolean | number>([['ai', 0.1234567891234], ['di', true]]) },
    }));
    expect(snap.signals.ai).toBe(0.1234567891234);
    expect(snap.signals.di).toBe(true);
  });

  it('sorts every array field', () => {
    const snap = collectStateSnapshot(viewerWith({
      errorStore: { getActive: () => [{ path: 'Z' }, { path: 'A' }, { path: 'M' }] },
      selectionManager: { selectedPaths: ['c', 'a', 'b'] },
    }));
    expect(snap.alarms).toEqual(['A', 'M', 'Z']);
    expect(snap.selection).toEqual(['a', 'b', 'c']);
  });

  it('keeps record keys in sorted order so a diff stays one line', () => {
    const n1 = new Object3D(); const n2 = new Object3D(); const n3 = new Object3D();
    const paths = new Map([[n1, 'zeta'], [n2, 'alpha'], [n3, 'mid']]);
    const snap = collectStateSnapshot(viewerWith({
      drives: [
        { node: n1, currentPosition: 1 },
        { node: n2, currentPosition: 2 },
        { node: n3, currentPosition: 3 },
      ],
      registry: { getPathForNode: (n) => paths.get(n) ?? null },
      signalStore: { getAll: () => new Map<string, boolean | number>([['zz', 1], ['aa', 2]]) },
    }));
    expect(Object.keys(snap.drives)).toEqual(['alpha', 'mid', 'zeta']);
    expect(Object.keys(snap.signals)).toEqual(['aa', 'zz']);
  });

  it('projects alarms as the machine-readable path, never the display text', () => {
    const snap = collectStateSnapshot(viewerWith({
      errorStore: { getActive: () => [{ path: 'Cell/Gripper' }] },
    }));
    expect(snap.alarms).toEqual(['Cell/Gripper']);
    expect(JSON.stringify(snap.alarms)).not.toContain('Error');
  });

  it('projects problems as `code` strings and only `severity: error`', () => {
    reportProblem({ id: 'p1', severity: 'error', code: 'missing-reference', title: 'Missing reference to Foo', detail: 'd' });
    reportProblem({ id: 'p2', severity: 'warning', code: 'placement-cap', title: 'Cap reached', detail: 'd' });
    reportProblem({ id: 'p3', severity: 'info', code: 'signal-reconcile', title: 'Reconciled', detail: 'd' });
    reportProblem({ id: 'p4', severity: 'error', code: 'bake-failed', title: 'Bake failed', detail: 'd' });

    const snap = collectStateSnapshot(viewerWith({}));
    expect(snap.problems).toEqual(['bake-failed', 'missing-reference']);
    expect(JSON.stringify(snap.problems)).not.toContain('Missing reference to Foo');
  });

  it('records the active panel per side as `side:panelId`', () => {
    const snap = collectStateSnapshot(viewerWith({
      leftPanelManager: { getActive: (side) => (side === 'left' ? 'hierarchy' : 'connect') },
    }));
    expect(snap.panels).toEqual(['left:hierarchy', 'right:connect']);
  });

  it('omits a side without an active panel instead of writing null', () => {
    const snap = collectStateSnapshot(viewerWith({
      leftPanelManager: { getActive: () => null },
    }));
    expect(snap.panels).toEqual([]);
  });
});
