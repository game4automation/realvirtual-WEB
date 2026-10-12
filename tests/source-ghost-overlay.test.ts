// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVSource ghost-overlay + cross-source template tests.
 *
 * Covers the unified source-ghost rework:
 *  - The source ghost keeps REAL materials and adds a translucent white overlay
 *    shell (`_isGhostOverlay`); the real template materials are NEVER mutated.
 *  - Spawned MUs carry real materials and NO ghost/overlay subtrees.
 *  - The "second placement spawns a ghost" bug: self-template detection must
 *    survive the Layout-Planner rename (uses `userData._originalName`).
 *  - `RVTransportManager.removeMU()` removes + disposes an MU immediately.
 */

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial, LineSegments, Object3D } from 'three';
import { RVSource } from '../src/core/engine/rv-source';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVTransportManager } from '../src/core/engine/rv-transport-manager';

/** Multi-mesh visual so analyzeTemplate() returns null → clone() spawn path. */
function makeMultiMeshNode(name: string): { node: Object3D; meshes: Mesh[] } {
  const node = new Object3D();
  node.name = name;
  const a = new Mesh(new BoxGeometry(1, 0.2, 0.8), new MeshStandardMaterial());
  a.name = 'PartA';
  const b = new Mesh(new BoxGeometry(0.3, 0.3, 0.3), new MeshStandardMaterial());
  b.name = 'PartB';
  node.add(a, b);
  return { node, meshes: [a, b] };
}

function hasOverlay(obj: Object3D): boolean {
  let found = false;
  obj.traverse((c) => { if (c.userData._isGhostOverlay) found = true; });
  return found;
}

function hasEdges(obj: Object3D): boolean {
  let found = false;
  obj.traverse((c) => { if (c instanceof LineSegments) found = true; });
  return found;
}

/** A mesh's fill is "hidden" (transparent-source look) when its material writes
 *  neither colour nor depth — set by RVSource without touching `visible`. */
function fillHidden(m: Mesh): boolean {
  const mat = m.material as { colorWrite?: boolean; depthWrite?: boolean };
  return mat.colorWrite === false && mat.depthWrite === false;
}

describe('RVSource — self-template ghost overlay', () => {
  it('hides the fill + adds a translucent white shell and edge outline', () => {
    const { node, meshes } = makeMultiMeshNode('Pallet');

    const source = new RVSource(node);
    source.sourceIsTemplate = true;
    source.spawnParent = new Object3D();
    source.setTemplate(node);

    for (const m of meshes) {
      // Mesh stays visible (so its overlay children render) but the real fill is
      // hidden (no colour/depth write → x-ray, no scene occlusion).
      expect(m.visible).toBe(true);
      expect(fillHidden(m)).toBe(true);
      // Exactly one translucent white shell mesh + one edge outline child.
      const fillShells = m.children.filter((c) => c.userData._isGhostOverlay && (c as Mesh).isMesh && !(c instanceof LineSegments));
      const edges = m.children.filter((c) => c instanceof LineSegments);
      expect(fillShells.length).toBe(1);
      expect((fillShells[0] as Mesh).material).toHaveProperty('transparent', true);
      expect(fillShells[0].userData._isSourceGhost).toBe(true);
      expect(edges.length).toBe(1);
      expect(edges[0].userData._isGhostOverlay).toBe(true);
      expect(edges[0].userData._isSourceGhost).toBe(true);
    }
  });

  // Regression guard: the original material must NOT be stashed in userData — a
  // spawned MU clone JSON-round-trips userData, which would corrupt a Material
  // into a plain object and make the spawn dissolve effect throw `mat.clone is
  // not a function` every frame (freezing the sim + navigation).
  it('spawned MU has REAL, cloneable materials and NO overlay/ghost/edge subtree', () => {
    const { node, meshes } = makeMultiMeshNode('Pallet');
    const originalMats = meshes.map((m) => m.material);
    const sceneRoot = new Object3D();

    const source = new RVSource(node);
    source.sourceIsTemplate = true;
    source.spawnParent = sceneRoot;
    source.spawnMode = 'Interval';
    source.spawnInterval = 0.01;
    source.setTemplate(node);

    const mu = source.update(1, /* spawningEnabled */ true);
    expect(mu).toBeTruthy();
    const spawned = sceneRoot.children.find((c) => c.name.startsWith('Pallet_'));
    expect(spawned, 'spawned clone added to spawn parent').toBeTruthy();
    expect(hasOverlay(spawned!)).toBe(false);
    expect(hasEdges(spawned!)).toBe(false);

    spawned!.traverse((c) => {
      if (!(c instanceof Mesh)) return;
      // Solid real fill (not the hidden no-write material) …
      expect(fillHidden(c)).toBe(false);
      // … and a genuine Material instance (the .clone() the dissolve effect needs).
      expect(c.material).toBeInstanceOf(MeshStandardMaterial);
      expect(typeof (c.material as MeshStandardMaterial).clone).toBe('function');
    });
    // The spawned materials are the source's real materials (shared by reference).
    const spawnedMats: unknown[] = [];
    spawned!.traverse((c) => { if (c instanceof Mesh) spawnedMats.push(c.material); });
    for (const om of originalMats) expect(spawnedMats).toContain(om);
  });

  it('dispose() restores the real fill material on the persisting source node', () => {
    const { node, meshes } = makeMultiMeshNode('Pallet');
    const originalMats = meshes.map((m) => m.material);

    const source = new RVSource(node);
    source.sourceIsTemplate = true;
    source.spawnParent = new Object3D();
    source.setTemplate(node);
    expect(fillHidden(meshes[0])).toBe(true);

    source.dispose();
    for (let i = 0; i < meshes.length; i++) {
      expect(meshes[i].material).toBe(originalMats[i]);
      expect(meshes[i].children.some((c) => c instanceof LineSegments)).toBe(false);
    }
  });
});

describe('RVSource — separate-template ghost clone', () => {
  it('builds a ghost clone with hidden fill + edge outline; template materials untouched', () => {
    const sceneRoot = new Object3D();
    const sourceNode = new Object3D();
    sourceNode.name = 'Spawner';
    const { node: template, meshes: tMeshes } = makeMultiMeshNode('Box');
    const originalMats = tMeshes.map((m) => m.material);
    sceneRoot.add(sourceNode, template);

    const source = new RVSource(sourceNode);
    source.sourceIsTemplate = false;
    source.muName = 'Box';
    source.spawnParent = sceneRoot;
    source.setTemplate(template);

    const ghost = sourceNode.children.find((c) => c.name === 'Box_ghost');
    expect(ghost, 'ghost clone exists under the source').toBeTruthy();
    expect(hasOverlay(ghost!)).toBe(true);
    expect(hasEdges(ghost!)).toBe(true);
    // The ghost clone's own fill is hidden (transparent look)…
    ghost!.traverse((c) => {
      if (c instanceof Mesh && !c.userData._isGhostOverlay) expect(fillHidden(c)).toBe(true);
    });
    // …while the separate template (what spawned MUs clone) is hidden and its
    // materials are untouched.
    expect(template.visible).toBe(false);
    for (let i = 0; i < tMeshes.length; i++) {
      expect(tMeshes[i].material).toBe(originalMats[i]);
    }
  });
});

describe('RVSource — self-template detection survives planner rename', () => {
  it('uses _originalName so a renamed 2nd placement stays self-template', () => {
    const { node } = makeMultiMeshNode('Pallet_2'); // renamed by resolveUniqueName (any _N suffix)
    node.userData._originalName = 'Pallet';          // original GLB root name

    const source = new RVSource(node);
    source.ThisObjectAsMU = 'Pallet';                // authored self-reference
    source.computeSpawnConfig({});

    expect(source.sourceIsTemplate).toBe(true);
    expect(source.muName).toBe('Pallet');
  });

  it('without _originalName a renamed node would mis-detect (regression guard)', () => {
    const { node } = makeMultiMeshNode('Pallet_2');
    const source = new RVSource(node);
    source.ThisObjectAsMU = 'Pallet';
    source.computeSpawnConfig({});
    // Demonstrates the original bug condition this fix addresses.
    expect(source.sourceIsTemplate).toBe(false);
  });
});

describe('RVTransportManager.removeMU', () => {
  it('removes and disposes a clone MU immediately (even while paused)', () => {
    const tm = new RVTransportManager();
    const parent = new Object3D();
    const node = new Mesh(new BoxGeometry(0.2, 0.2, 0.2), new MeshStandardMaterial());
    parent.add(node);
    const mu = new RVMovingUnit(node, 'src');
    tm.mus.push(mu);

    expect(tm.mus.length).toBe(1);
    tm.removeMU(mu);
    expect(tm.mus.length).toBe(0);
    expect(node.parent).toBeNull();
  });

  it('is a no-op for an MU not currently tracked', () => {
    const tm = new RVTransportManager();
    const node = new Object3D();
    const mu = new RVMovingUnit(node, 'src');
    expect(() => tm.removeMU(mu)).not.toThrow();
    expect(tm.mus.length).toBe(0);
  });
});
