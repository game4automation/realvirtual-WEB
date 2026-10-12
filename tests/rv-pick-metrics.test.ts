// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import {
  Group, Mesh, BoxGeometry, BufferGeometry, MeshBasicMaterial,
  PerspectiveCamera, Scene, Vector3,
} from 'three';
import { computeBoundsTree, disposeBoundsTree, acceleratedRaycast } from 'three-mesh-bvh';
import { PickMetrics } from '../src/core/engine/rv-pick-metrics';
import { RaycastManager } from '../src/core/engine/rv-raycast-manager';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { PickBackend } from '../src/core/engine/rv-pick-backend';
import { bakeAndPlace } from './fixtures/bake-fixture';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { registerComponentSchema } from '../src/core/engine/rv-component-registry';

// buildRaycastGroup calls geometry.computeBoundsTree() — installed lazily by
// the scene loader in production, so install it here for direct builder tests.
BufferGeometry.prototype.computeBoundsTree = computeBoundsTree;
BufferGeometry.prototype.disposeBoundsTree = disposeBoundsTree;
Mesh.prototype.raycast = acceleratedRaycast;

// Synthetic hoverable type (avoids importing heavy component modules).
registerComponentSchema('PickMetricsTestType', {}, { pick: 'select' });
registerComponentSchema('PickMetricsMover', {}, { pick: 'select', bake: 'chunk' });

// ─── PickMetrics unit ───────────────────────────────────────────────

describe('PickMetrics', () => {
  it('EMA starts at first sample and converges with alpha 0.2', () => {
    const m = new PickMetrics();
    m.recordRaycast(10, 4, 3, 3, true);
    expect(m.snapshot().raycastMs).toBeCloseTo(10, 6);
    m.recordRaycast(20, 8, 6, 6, true);
    // 10 + 0.2 * (20 - 10) = 12
    expect(m.snapshot().raycastMs).toBeCloseTo(12, 6);
    expect(m.snapshot().lastRaycastMs).toBeCloseTo(20, 6);
    expect(m.snapshot().raycastStaticMs).toBeCloseTo(4 + 0.2 * (8 - 4), 6);
  });

  it('counts picks and hits independently', () => {
    const m = new PickMetrics();
    m.recordRaycast(1, 1, 0, 0, true);
    m.recordRaycast(1, 1, 0, 0, false);
    m.recordRaycast(1, 1, 0, 0, true);
    const s = m.snapshot();
    expect(s.raycastCount).toBe(3);
    expect(s.hitCount).toBe(2);
  });

  it('records highlight strategy and overlay count', () => {
    const m = new PickMetrics();
    m.recordHighlight(3.5, 'overlay', 42);
    const s = m.snapshot();
    expect(s.highlightMs).toBeCloseTo(3.5, 6);
    expect(s.lastHighlightMs).toBeCloseTo(3.5, 6);
    expect(s.strategy).toBe('overlay');
    expect(s.overlayObjects).toBe(42);
  });

  it('records resolve time and bvh pending', () => {
    const m = new PickMetrics();
    m.recordResolve(0.5);
    m.setBvhPending(3);
    expect(m.snapshot().resolveMs).toBeCloseTo(0.5, 6);
    expect(m.snapshot().bvhPending).toBe(3);
  });

  it('reset() clears all series and counters', () => {
    const m = new PickMetrics();
    m.recordRaycast(10, 1, 1, 1, true);
    m.recordResolve(2);
    m.recordHighlight(3, 'bbox', 7);
    m.setBvhPending(2);
    m.reset();
    const s = m.snapshot();
    expect(s.raycastMs).toBe(0);
    expect(s.resolveMs).toBe(0);
    expect(s.highlightMs).toBe(0);
    expect(s.lastRaycastMs).toBe(0);
    expect(s.strategy).toBe('none');
    expect(s.raycastCount).toBe(0);
    expect(s.hitCount).toBe(0);
    expect(s.bvhPending).toBe(0);
    expect(s.overlayObjects).toBe(0);
  });
});

// ─── RaycastManager timed category-split integration ────────────────

function makeHighlighterMock() {
  const calls: string[] = [];
  return {
    calls,
    highlight() { calls.push('highlight'); },
    highlightInstancedMU() { calls.push('mu'); },
    clear() { calls.push('clear'); },
  };
}

/**
 * Scene layout (ray travels -Z from z=10), baked in place (plan-753):
 *   DriveBox mesh at z=2  (mover chunk,  dist 8 — CLOSER)
 *   StaticBox mesh at z=0 (static chunk, dist 10)
 * Both are hits of the chunk pick backend; the drive hit must win, proving
 * distance ordering is preserved across the backend's own hit order.
 */
async function buildPickScene() {
  const root = new Group();
  root.name = 'Root';

  const staticParent = new Group();
  staticParent.name = 'StaticBox';
  staticParent.userData.realvirtual = { PickMetricsTestType: {} };
  staticParent.userData._rvType = 'PickMetricsTestType';
  const staticMesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  staticMesh.name = 'StaticMesh';
  staticParent.add(staticMesh);
  root.add(staticParent);

  const driveNode = new Group();
  driveNode.name = 'DriveBox';
  driveNode.userData.realvirtual = { PickMetricsMover: {} };
  driveNode.userData._rvType = 'PickMetricsMover';
  const driveMesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshBasicMaterial());
  driveMesh.name = 'DriveMesh';
  driveMesh.position.set(0, 0, 2);
  driveNode.add(driveMesh);
  root.add(driveNode);

  root.updateMatrixWorld(true);

  // plan-754: the destructive bake replaces the survivors, so both the
  // registry and the nodes under test come from the placed TEMPLATE.
  const bakeRegistry = new BakeRegistry();
  const placed = await bakeAndPlace(root, bakeRegistry);

  const registry = new NodeRegistry();
  placed.template.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));

  return {
    root: placed.template,
    registry,
    bakeRegistry,
    staticParent: placed.node(staticParent.name),
    driveNode: placed.node(driveNode.name),
  };
}

function makeManager(registry: NodeRegistry, highlighter: ReturnType<typeof makeHighlighterMock>) {
  const canvas = document.createElement('canvas');
  const renderer = { domElement: canvas };
  const camera = new PerspectiveCamera();
  const scene = new Scene();
  const emitter = { emit() {} };
  return new RaycastManager(
    renderer as unknown as { readonly domElement: HTMLCanvasElement },
    () => camera, scene, registry,
    highlighter as unknown as import('../src/core/engine/rv-highlight-manager').RVHighlightManager,
    emitter,
  );
}

function install(rm: RaycastManager, bakeRegistry: BakeRegistry): void {
  rm.addBackend(new PickBackend(bakeRegistry));
  rm.enableHoverType('PickMetricsTestType', true);
  rm.enableHoverType('PickMetricsMover', true);
}

describe('RaycastManager timed intersect (metrics installed)', () => {
  it('keeps distance ordering across backend hits and populates metrics', async () => {
    const { registry, bakeRegistry, driveNode } = await buildPickScene();
    const highlighter = makeHighlighterMock();
    const rm = makeManager(registry, highlighter);
    const metrics = new PickMetrics();
    rm.setMetrics(metrics);
    install(rm, bakeRegistry);

    rm.updateFromXRController(new Vector3(0, 0, 10), new Vector3(0, 0, -1));

    // Drive mesh (z=2) is closer than static mesh (z=0) — must win regardless
    // of the order the backend appended its hits.
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(driveNode));

    const s = metrics.snapshot();
    expect(s.raycastCount).toBe(1);
    expect(s.hitCount).toBe(1);
    expect(s.raycastMs).toBeGreaterThanOrEqual(0);
    expect(s.lastRaycastMs).toBeGreaterThanOrEqual(0);
    expect(s.resolveMs).toBeGreaterThanOrEqual(0);
    rm.dispose();
  });

  it('resolves the static node when the drive is not in the ray', async () => {
    const { registry, bakeRegistry, staticParent, driveNode } = await buildPickScene();
    // Move the drive out of the ray path (its mover chunk follows the node).
    driveNode.position.set(50, 0, 0);
    driveNode.updateMatrixWorld(true);

    const highlighter = makeHighlighterMock();
    const rm = makeManager(registry, highlighter);
    const metrics = new PickMetrics();
    rm.setMetrics(metrics);
    install(rm, bakeRegistry);

    rm.updateFromXRController(new Vector3(0, 0, 10), new Vector3(0, 0, -1));
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(staticParent));
    rm.dispose();
  });

  it('records a miss without clearing prior counters', async () => {
    const { registry, bakeRegistry } = await buildPickScene();
    const highlighter = makeHighlighterMock();
    const rm = makeManager(registry, highlighter);
    const metrics = new PickMetrics();
    rm.setMetrics(metrics);
    install(rm, bakeRegistry);

    rm.updateFromXRController(new Vector3(0, 0, 10), new Vector3(0, 0, -1));
    rm.updateFromXRController(new Vector3(500, 500, 10), new Vector3(0, 0, -1));

    const s = metrics.snapshot();
    expect(s.raycastCount).toBe(2);
    expect(s.hitCount).toBe(1);
    expect(rm.hoveredNodePath).toBeNull();
    rm.dispose();
  });

  it('behaves identically without a metrics sink (fallback _collectHits)', async () => {
    const { registry, bakeRegistry, driveNode } = await buildPickScene();
    const highlighter = makeHighlighterMock();
    const rm = makeManager(registry, highlighter);
    install(rm, bakeRegistry);

    rm.updateFromXRController(new Vector3(0, 0, 10), new Vector3(0, 0, -1));
    expect(rm.hoveredNodePath).toBe(registry.getPathForNode(driveNode));
    rm.dispose();
  });
});
