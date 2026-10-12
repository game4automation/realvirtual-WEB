// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A live editor Drive must follow the node it sits on.
 *
 * In the editor the Drive family is constructed live on add (plan-411) and
 * caches the node pose of that moment as its home. Every later inspector edit
 * runs `reapplyConfig()` → `applyToNode()`, which rewrites the node FROM that
 * cache — so a pivot moved AFTER the Drive was added ("Pivot to Object", a
 * transform op, a re-parent) snapped back on the next Direction change. The
 * executor now refreshes the drive's home whenever an op moves its node.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Scene, Group, Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';
import type { RVDrive } from '../src/core/engine/rv-drive';
import { __clearDraftStoresForTests } from '../src/core/ops/rv-document-drafts';
import { scratchAssetDocument } from './helpers/scratch-asset-document';

function makeViewer() {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);
  const axis = new Object3D();
  axis.name = 'Axis';
  axis.userData.realvirtual = {};
  model.add(axis);
  const child = new Object3D();
  child.name = 'Part';
  axis.add(child);

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  const transportManager = new RVTransportManager();
  transportManager.scene = scene;
  const drives: RVDrive[] = [];
  const viewer = {
    scene, registry,
    signalStore: new SignalStore(),
    transportManager,
    get currentModelRoot() { return model; },
    addDrive(d: RVDrive) { drives.push(d); return true; },
    removeDrive(d: RVDrive) { const i = drives.indexOf(d); if (i >= 0) drives.splice(i, 1); return i >= 0; },
    on() { return () => {}; },
    emit() {},
    markRenderDirty() {},
    markShadowsDirty() {},
    rebuildGroupedBvh() {},
    refitRaycastSubtrees() {},
  } as unknown as RVViewer;
  return { viewer, model, axis, child, registry, drives, axisPath: NodeRegistry.computeNodePath(axis) };
}

const IDENTITY = { position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };

beforeEach(async () => { await __clearDraftStoresForTests(); });

describe('asset executors — live Drive home follows the node', () => {
  it('a transform op after addComponent(Drive) survives a Direction edit', async () => {
    const w = makeViewer();
    const doc = scratchAssetDocument(w.viewer);

    doc.addComponent(w.axisPath, 'Drive', { Direction: 'LinearX' });
    await doc.whenIdle();
    expect(w.drives).toHaveLength(1); // a LIVE drive, exactly as in the editor
    expect(w.registry.getByPath('Drive', w.axisPath)).toBe(w.drives[0]);

    // "Pivot to Object" = a transformNode op on the axis (children compensated).
    doc.transformNode(w.axisPath, { ...IDENTITY, position: [1, 2, 3] }, IDENTITY);
    await doc.whenIdle();
    expect(w.axis.position.toArray()).toEqual([1, 2, 3]);

    // The inspector edit that used to snap the pivot back to (0,0,0).
    doc.setField(w.axisPath, 'Drive', 'Direction', 'LinearY', 'LinearX');
    await doc.whenIdle();
    expect(w.drives[0].Direction).toBe('LinearY');
    expect(w.axis.position.toArray()).toEqual([1, 2, 3]);

    // Undo of the transform is a transform op too — the home follows it back.
    await doc.undo(); // Direction
    await doc.undo(); // transform
    expect(w.axis.position.toArray()).toEqual([0, 0, 0]);
    doc.setField(w.axisPath, 'Drive', 'Direction', 'LinearZ', 'LinearX');
    await doc.whenIdle();
    expect(w.axis.position.toArray()).toEqual([0, 0, 0]);
    doc.dispose();
  });

  it('a re-parent (world-preserving local change) refreshes the drive home too', async () => {
    const w = makeViewer();
    const doc = scratchAssetDocument(w.viewer);
    const holder = new Object3D();
    holder.name = 'Holder';
    holder.position.set(5, 0, 0);
    w.model.add(holder);
    w.registry.registerNode(NodeRegistry.computeNodePath(holder), holder);
    w.model.updateMatrixWorld(true);

    doc.addComponent(w.axisPath, 'Drive', { Direction: 'LinearX' });
    await doc.whenIdle();

    // Move the axis under Holder keeping world pose: local becomes (-5,0,0).
    await doc.reparentNodes([w.axisPath], NodeRegistry.computeNodePath(holder));
    await doc.whenIdle();
    expect(w.axis.position.x).toBeCloseTo(-5, 6);

    doc.setField('Asset/Holder/Axis', 'Drive', 'Direction', 'LinearY', 'LinearX');
    await doc.whenIdle();
    expect(w.axis.position.x).toBeCloseTo(-5, 6);
    doc.dispose();
  });
});
