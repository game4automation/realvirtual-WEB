// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-734 F4 — resolution stage 4: sanitize-normalized full-path match.
 *
 * Why the stage exists at all: an already-DELIVERED GLB was loaded by a viewer
 * whose alias registration wrote the wrong spelling, and no re-export is coming
 * for it. Stage 4 maps the authored spelling and the loader-assigned one onto
 * one key, so those models resolve without touching the file.
 *
 * Why it is the LAST stage and never overturns a refusal: stages 1-3 exist to
 * refuse to guess. `sanitizeLikeThree` REMOVES `[ ] . : /` rather than
 * replacing them, so it can collapse two genuinely different paths onto one key
 * — the stage therefore carries its own ambiguity refusal, and a path that
 * stage 3 already refused stays refused.
 *
 * Why the index is maintained incrementally: `MuReconciler.reconcile()` calls
 * `registerNode` / `unregisterSubtree` EVERY FRAME while the layout planner
 * runs. A dirty-flag + rebuild scheme would discard the index several times a
 * second and pay O(nodes) on the next miss — hence the build-counter assertion.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Object3D } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

/** A child named `name` under `parent`. */
function child(parent: Object3D, name: string): Object3D {
  const node = new Object3D();
  node.name = name;
  parent.add(node);
  return node;
}

/** Register every descendant of `root` under its canonical path. */
function registerAll(registry: NodeRegistry, root: Object3D): void {
  root.traverse((node) => {
    if (node === root) return;
    registry.registerNode(NodeRegistry.computeNodePath(node), node);
  });
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('NodeRegistry stage 4 — sanitize-normalized fallback (plan-734)', () => {
  it('finds a node by its authored path when NO alias was registered', () => {
    // Exactly the delivered-GLB situation: the registry only ever saw the
    // loader-sanitized spelling, and nothing published the authored one.
    const root = new Object3D(); root.name = 'Scene';
    const branch = child(root, 'Zweig2');
    const leaf = child(child(branch, 'A_B1'), 'Volumen');
    registerAll(new NodeRegistry(), root); // no-op guard against fixture drift

    const registry = new NodeRegistry();
    registerAll(registry, root);

    expect(registry.getNode('Zweig2/A B:1/Volumen')).toBe(leaf);
  });

  it('matches in the other direction too (sanitized query, authored registration)', () => {
    const root = new Object3D(); root.name = 'Scene';
    const leaf = child(child(child(root, 'Zweig1'), 'A B:1'), 'Volumen');
    const registry = new NodeRegistry();
    registerAll(registry, root);

    expect(registry.getNode('Zweig1/A_B1/Volumen')).toBe(leaf);
  });

  it('refuses to guess when two paths sanitize to the same key', () => {
    // `A.B` and `A:B` both sanitize to `AB` — genuinely different nodes.
    const root = new Object3D(); root.name = 'Scene';
    child(root, 'A.B');
    child(root, 'A:B');
    const registry = new NodeRegistry();
    registerAll(registry, root);

    expect(registry.getNode('AB')).toBeNull();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0][0])).toContain('refusing to guess');
  });

  it('warns about an ambiguous sanitized key only ONCE', () => {
    const root = new Object3D(); root.name = 'Scene';
    child(root, 'A.B');
    child(root, 'A:B');
    const registry = new NodeRegistry();
    registerAll(registry, root);

    registry.getNode('AB');
    registry.getNode('AB');
    registry.getNode('AB');
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('does NOT rescue a path that stage 3 refused as ambiguous', () => {
    // Two branches, same leaf path suffix → the F10 suffix refusal. That is a
    // DECISION, not a miss; stage 4 must not overturn it even though the
    // sanitized key would happily pick one.
    const root = new Object3D(); root.name = 'Scene';
    child(child(root, 'CellA'), 'Motor');
    child(child(root, 'CellB'), 'Motor');
    const registry = new NodeRegistry();
    registerAll(registry, root);

    expect(registry.getNode('Motor')).toBeNull();
    expect(String(warn.mock.calls[0][0])).toContain('Ambiguous suffix match');
    // …and no second (stage-4) warning was emitted on top of it.
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it('leaves the exact-hit fast path untouched (index never even built)', () => {
    const root = new Object3D(); root.name = 'Scene';
    const motor = child(child(root, 'CellA'), 'Motor');
    const registry = new NodeRegistry();
    registerAll(registry, root);

    expect(registry.getNode('CellA/Motor')).toBe(motor);
    expect(registry.sanitizedIndexBuildCount()).toBe(0);
  });

  it('a genuine miss stays a miss', () => {
    const root = new Object3D(); root.name = 'Scene';
    child(child(root, 'CellA'), 'Motor');
    const registry = new NodeRegistry();
    registerAll(registry, root);

    expect(registry.getNode('CellZ/Nothing')).toBeNull();
  });

  describe('incremental index maintenance', () => {
    it('follows registerNode / unregisterSubtree WITHOUT a rebuild', () => {
      const root = new Object3D(); root.name = 'Scene';
      const cell = child(root, 'Cell');
      const registry = new NodeRegistry();
      registerAll(registry, root);

      // First stage-4 lookup builds the index (build #1).
      expect(registry.getNode('Cell')).toBe(cell);
      expect(registry.getNode('Ce ll')).toBeNull(); // sanitizes to 'Ce_ll' — miss, but builds
      expect(registry.sanitizedIndexBuildCount()).toBe(1);

      // A node arrives at runtime (MU spawn).
      const spawned = child(cell, 'MU A:1');
      registry.registerNode('Cell/MU A:1', spawned);
      expect(registry.getNode('Cell/MU_A1')).toBe(spawned);
      expect(registry.sanitizedIndexBuildCount()).toBe(1);

      // …and is consumed again.
      cell.remove(spawned);
      registry.unregisterSubtree(spawned);
      expect(registry.getNode('Cell/MU_A1')).toBeNull();
      expect(registry.sanitizedIndexBuildCount()).toBe(1);
    });

    it('follows an alias registration and its takedown', () => {
      const root = new Object3D(); root.name = 'Scene';
      const part = child(root, 'A_B1_1');
      const registry = new NodeRegistry();
      registerAll(registry, root);

      registry.getNode('nothing'); // build the index first
      expect(registry.sanitizedIndexBuildCount()).toBe(1);

      registry.registerAlias('A B:1', part);
      // The alias is an exact hit, so this does not even reach stage 4 — but the
      // sanitized spelling of the alias now resolves through it.
      expect(registry.getNode('A B:1')).toBe(part);
      expect(registry.getNode('A_B1')).toBe(part);

      root.remove(part);
      registry.unregisterSubtree(part);
      expect(registry.getNode('A_B1')).toBeNull();
      expect(registry.sanitizedIndexBuildCount()).toBe(1);
    });

    it('follows recomputePathsForSubtrees after re-parenting', () => {
      const root = new Object3D(); root.name = 'Scene';
      const cad = child(root, 'CadRoot');
      const kine = child(root, 'Kine');
      const part = child(cad, 'Part X:1');
      const registry = new NodeRegistry();
      registerAll(registry, root);

      expect(registry.getNode('CadRoot/Part_X1')).toBe(part);
      expect(registry.sanitizedIndexBuildCount()).toBe(1);

      kine.add(part); // Phase 8b re-parent
      registry.recomputePathsForSubtrees([kine]);

      expect(registry.getNode('Kine/Part_X1')).toBe(part);
      expect(registry.getNode('CadRoot/Part_X1')).toBeNull();
      expect(registry.sanitizedIndexBuildCount()).toBe(1);
    });
  });

  describe('registerAlias reports what it discarded (F8)', () => {
    it('returns false when the path is already claimed', () => {
      const root = new Object3D(); root.name = 'Scene';
      const a = child(root, 'Taken');
      const b = child(root, 'Other');
      const registry = new NodeRegistry();
      registerAll(registry, root);

      expect(registry.registerAlias('Fresh', b)).toBe(true);
      expect(registry.registerAlias('Taken', b)).toBe(false);
      // …and the real registration still wins.
      expect(registry.getNode('Taken')).toBe(a);
    });
  });
});
