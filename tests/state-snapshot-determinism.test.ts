// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-600 test 9.1 — the collector returns the same thing twice for an
 * unchanged state, and carries nothing wall-clock derived.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { collectStateSnapshot, type SnapshotSource } from '../src/core/engine/rv-state-snapshot';
import { clearAllProblems } from '../src/core/hmi/problems-store';

function makeViewer(): SnapshotSource {
  const nodeA = new Object3D();
  nodeA.name = 'DriveA';
  const nodeB = new Object3D();
  nodeB.name = 'DriveB';
  const paths = new Map<Object3D, string>([[nodeA, 'Cell/DriveA'], [nodeB, 'Cell/DriveB']]);
  return {
    modes: { activeMode: 'hmi' },
    currentModelUrl: 'models/DemoRealvirtualWeb.glb?v=7',
    drives: [
      { node: nodeB, name: 'DriveB', currentPosition: 1234.56789 },
      { node: nodeA, name: 'DriveA', currentPosition: -0.00049 },
    ],
    registry: { size: { nodes: 4242 }, getPathForNode: (n) => paths.get(n) ?? null },
    signalStore: { getAll: () => new Map<string, boolean | number>([['do5', true], ['ai1', 0.5]]) },
    errorStore: { getActive: () => [{ path: 'Cell/Z' }, { path: 'Cell/A' }] },
    selectionManager: { selectedPaths: ['Cell/DriveB', 'Cell/DriveA'] },
    leftPanelManager: { getActive: (side) => (side === 'left' ? 'hierarchy' : null) },
  };
}

describe('collectStateSnapshot', () => {
  beforeEach(() => { clearAllProblems(); });

  it('is identical on two consecutive calls', () => {
    const viewer = makeViewer();
    expect(collectStateSnapshot(viewer)).toEqual(collectStateSnapshot(viewer));
  });

  it('serialises byte-identically on two consecutive calls', () => {
    const viewer = makeViewer();
    expect(JSON.stringify(collectStateSnapshot(viewer)))
      .toBe(JSON.stringify(collectStateSnapshot(viewer)));
  });

  it('carries no wall-clock derived field', () => {
    const snap = collectStateSnapshot(makeViewer()) as unknown as Record<string, unknown>;
    for (const key of ['timestamp', 'fps', 'durationMs', 'loadedAt', 'at', 'since', 'simTime', 'url']) {
      expect(snap, `snapshot must not carry "${key}"`).not.toHaveProperty(key);
    }
  });

  it('exposes exactly the closed field list', () => {
    expect(Object.keys(collectStateSnapshot(makeViewer())).sort()).toEqual([
      'alarms', 'documentId', 'drives', 'mode', 'modelKey',
      'nodeCount', 'panels', 'problems', 'selection', 'signals',
    ]);
  });

  it('reads the model key without hash or URL', () => {
    expect(collectStateSnapshot(makeViewer()).modelKey).toBe('DemoRealvirtualWeb');
  });

  it('reports null — not 0 — for a field it cannot read', () => {
    const snap = collectStateSnapshot({});
    expect(snap.nodeCount).toBeNull();
    expect(snap.mode).toBeNull();
    expect(snap.modelKey).toBeNull();
    expect(snap.drives).toEqual({});
    expect(snap.signals).toEqual({});
  });
});
