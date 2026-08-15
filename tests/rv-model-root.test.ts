// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The model-root predicate and the central write guards (plan-715 Phase 1).
 *
 * Before plan-715 the "is this the root" question was answered by nine separate
 * identity comparisons, and three write paths — rename, transform, visibility —
 * had simply never grown one. These tests pin both halves of the fix: the
 * predicate itself (identity, never name, null-safe) and the fact that
 * `AssetDocument` refuses those three verbs LOUDLY while the executor REPLAY
 * skips them quietly (crash recovery must never throw).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Object3D, Scene } from 'three';
import { isModelRoot, isModelRootPath } from '../src/core/engine/rv-model-root';

// ─── The predicate ────────────────────────────────────────────────────────

describe('isModelRoot', () => {
  it('identifies only the model root, never the scene and never _layoutRoot', () => {
    const scene = new Scene();
    const modelRoot = new Object3D(); modelRoot.name = 'Turntable';
    const layoutRoot = new Object3D(); layoutRoot.name = '_layoutRoot';
    const child = new Object3D(); child.name = 'Base';
    modelRoot.add(child);
    scene.add(modelRoot, layoutRoot);

    expect(isModelRoot(modelRoot, modelRoot)).toBe(true);
    expect(isModelRoot(layoutRoot, modelRoot)).toBe(false);
    expect(isModelRoot(scene, modelRoot)).toBe(false);
    expect(isModelRoot(child, modelRoot)).toBe(false);
  });

  it('returns false when no model is loaded (null root) or no node is given', () => {
    const node = new Object3D();
    expect(isModelRoot(node, null)).toBe(false);
    expect(isModelRoot(node, undefined)).toBe(false);
    expect(isModelRoot(null, node)).toBe(false);
    expect(isModelRoot(undefined, node)).toBe(false);
    expect(isModelRoot(null, null)).toBe(false);
  });

  it('is name-independent: empty root name and a name-colliding child', () => {
    // A name-based check would answer true for BOTH of these — which is exactly
    // why the predicate compares object identity.
    const modelRoot = new Object3D(); modelRoot.name = '';
    const twin = new Object3D(); twin.name = '';
    const collidingChild = new Object3D(); collidingChild.name = '';
    modelRoot.add(collidingChild);

    expect(isModelRoot(modelRoot, modelRoot)).toBe(true);
    expect(isModelRoot(twin, modelRoot)).toBe(false);
    expect(isModelRoot(collidingChild, modelRoot)).toBe(false);
  });
});

describe('isModelRootPath', () => {
  const modelRoot = new Object3D(); modelRoot.name = 'Turntable';
  const child = new Object3D(); child.name = 'Base';
  modelRoot.add(child);
  const registry = {
    getNode: (p: string) => (p === 'Turntable' ? modelRoot : p === 'Turntable/Base' ? child : null),
  };

  it('resolves the path through the registry before comparing identity', () => {
    expect(isModelRootPath('Turntable', registry, modelRoot)).toBe(true);
    expect(isModelRootPath('Turntable/Base', registry, modelRoot)).toBe(false);
    expect(isModelRootPath('Nope', registry, modelRoot)).toBe(false);
  });

  it('is safe with a missing path, registry or root', () => {
    expect(isModelRootPath('', registry, modelRoot)).toBe(false);
    expect(isModelRootPath('Turntable', null, modelRoot)).toBe(false);
    expect(isModelRootPath('Turntable', registry, null)).toBe(false);
  });
});

// ─── Central guards in AssetDocument ──────────────────────────────────────

/**
 * A minimal document stand-in: the real `AssetDocument` needs a live viewer,
 * an op store and an executor, none of which the GUARD depends on. What is
 * exercised here is the exact code path the real class runs — the guard method
 * and the three call sites — with `_voidApply` observed instead of applied.
 */
async function makeDocUnderTest(modelRoot: Object3D | null, registry: { getNode(p: string): Object3D | null }) {
  const { AssetDocument } = await import('../src/core/editor/rv-asset-document');
  const applied: string[] = [];
  const doc = Object.create(AssetDocument.prototype) as any;
  doc.viewer = { registry, currentModelRoot: modelRoot };
  doc._voidApply = (op: { kind: string }) => { applied.push(op.kind); };
  return { doc, applied };
}

describe('AssetDocument root guards', () => {
  const modelRoot = new Object3D(); modelRoot.name = 'Turntable';
  const child = new Object3D(); child.name = 'Base'; child.visible = true;
  modelRoot.add(child);
  const registry = {
    getNode: (p: string) => (p === 'Turntable' ? modelRoot : p === 'Turntable/Base' ? child : null),
  };
  const T = { position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };

  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('renameNode / transformNode / setNodeVisible refuse the root — no op, loud warning', async () => {
    const { doc, applied } = await makeDocUnderTest(modelRoot, registry);
    doc.renameNode('Turntable', 'NewName', 'Turntable');
    doc.transformNode('Turntable', T, T);
    doc.setNodeVisible('Turntable', false);

    expect(applied).toEqual([]);
    // Filtered rather than counted raw: the first dynamic import of the editor
    // modules emits unrelated registry chatter on this shared console.
    const refusals = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('model root'));
    expect(refusals).toHaveLength(3);
    expect(refusals.map((c: unknown[]) => String(c[0]))).toEqual([
      expect.stringContaining('renameNode'),
      expect.stringContaining('transformNode'),
      expect.stringContaining('setNodeVisible'),
    ]);
    // The refusal is a no-op on the scene too — the root stays visible.
    expect(modelRoot.visible).toBe(true);
  });

  it('lets the same three verbs through for a normal child node', async () => {
    const { doc, applied } = await makeDocUnderTest(modelRoot, registry);
    doc.renameNode('Turntable/Base', 'Plate', 'Base');
    doc.transformNode('Turntable/Base', T, T);
    doc.setNodeVisible('Turntable/Base', false);

    expect(applied).toEqual(['renameNode', 'transformNode', 'setNodeVisible']);
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('model root'))).toHaveLength(0);
  });

  it('guards nothing when no model is loaded (every path is a normal node)', async () => {
    const { doc, applied } = await makeDocUnderTest(null, registry);
    doc.renameNode('Turntable', 'NewName', 'Turntable');
    expect(applied).toEqual(['renameNode']);
  });
});

// ─── Executor replay: SKIP, never throw ───────────────────────────────────

/**
 * The replay path runs on draft/crash recovery, so a historical root op — one
 * written before the guards above existed — must be dropped, not raised. The
 * executor's private methods are reached through the same
 * `Object.create(prototype)` seam: what matters is that `_rename` and
 * `_applyTransform` return early and leave the node untouched.
 */
async function makeExecutorUnderTest(modelRoot: Object3D, nodes: Record<string, Object3D>) {
  const { AssetExecutorContext: AssetExecutor } = await import('../src/core/editor/rv-asset-executors');
  const exec = Object.create(AssetExecutor.prototype) as any;
  exec.viewer = {
    currentModelRoot: modelRoot,
    registry: {
      getNode: (p: string) => nodes[p] ?? null,
      recomputePathsForSubtrees: () => {},
    },
    instancePickIndex: null,
    markRenderDirty: () => {},
    markShadowsDirty: () => {},
  };
  exec._node = (p: string) => nodes[p] ?? null;
  return exec;
}

describe('executor replay skips root ops', () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('skips a replayed root rename with a warning instead of throwing', async () => {
    const modelRoot = new Object3D(); modelRoot.name = 'Turntable';
    const exec = await makeExecutorUnderTest(modelRoot, { Turntable: modelRoot });

    expect(() => exec._rename('Turntable', 'Renamed')).not.toThrow();
    expect(modelRoot.name).toBe('Turntable');
    const skips = warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('skipping replayed'));
    expect(skips).toHaveLength(1);
    expect(String(skips[0][0])).toContain('renameNode');
  });

  it('skips a replayed root transform with a warning instead of throwing', async () => {
    const modelRoot = new Object3D(); modelRoot.name = 'Turntable';
    const exec = await makeExecutorUnderTest(modelRoot, { Turntable: modelRoot });

    expect(() => exec._applyTransform('Turntable', {
      position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
    })).not.toThrow();
    expect(modelRoot.position.toArray()).toEqual([0, 0, 0]);
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('skipping replayed'))).toHaveLength(1);
  });

  it('still applies a replayed rename/transform to a normal child', async () => {
    const modelRoot = new Object3D(); modelRoot.name = 'Turntable';
    const child = new Object3D(); child.name = 'Base';
    modelRoot.add(child);
    const exec = await makeExecutorUnderTest(modelRoot, { Turntable: modelRoot, 'Turntable/Base': child });

    exec._rename('Turntable/Base', 'Plate');
    exec._applyTransform('Turntable/Base', {
      position: [1, 2, 3], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
    });
    expect(child.name).toBe('Plate');
    expect(child.position.toArray()).toEqual([1, 2, 3]);
    expect(warn.mock.calls.filter((c: unknown[]) => String(c[0]).includes('skipping replayed'))).toHaveLength(0);
  });
});
