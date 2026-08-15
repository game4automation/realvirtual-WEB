// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Mesh merger — context-menu entry and preview flow (plan-372 section 9: test 9.16).
 *
 * The regression this guards is subtle and was found in review: a right-click on a
 * HIERARCHY row synthesises a `ContextMenuTarget` and highlights the row, but it does NOT
 * call `selectionManager.select()`. A condition of the shape "exactly one selected path
 * and it equals the target" — which the separator entry uses — therefore hides the entry
 * on a hierarchy right-click, or points it at whatever happens to be selected.
 */

import { describe, it, expect, afterEach } from 'vitest';
import {
  BufferAttribute,
  BufferGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Scene,
} from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import type { ContextMenuTarget } from '../src/core/hmi/context-menu-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { AssetDocument } from '../src/core/editor/rv-asset-document';
import { buildMergeMenuItem, disposeMergeClient } from '@rv-private/plugins/asset-editor/mesh-merge-actions';
import { setActiveAssetContext } from '../src/core/editor/active-asset-store';
import { getPendingDialog } from '@rv-private/plugins/asset-editor/editor-dialog-store';

function triangleGeometry(offset = 0): BufferGeometry {
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array([
    offset, 0, 0, offset + 1, 0, 0, offset, 1, 0,
  ]), 3));
  geom.setAttribute('normal', new BufferAttribute(new Float32Array([
    0, 0, 1, 0, 0, 1, 0, 0, 1,
  ]), 3));
  geom.setIndex(new BufferAttribute(new Uint32Array([0, 1, 2]), 1));
  return geom;
}

interface Harness {
  viewer: RVViewer;
  registry: NodeRegistry;
  model: Group;
  assembly: Group;
  leaf: Mesh;
  selected: string[];
  selectCalls: string[];
}

function makeHarness(mode = 'editor'): Harness {
  const scene = new Scene();
  const model = new Group();
  model.name = 'Asset';
  scene.add(model);

  const assembly = new Group();
  assembly.name = 'Assembly';
  model.add(assembly);
  const material = new MeshStandardMaterial({ name: 'Steel', color: 0x336699 });
  const leaf = new Mesh(triangleGeometry(0), material);
  leaf.name = 'PartA';
  assembly.add(leaf);
  const other = new Mesh(triangleGeometry(5), material);
  other.name = 'PartB';
  assembly.add(other);

  // A second, UNRELATED subtree — this is what stays "selected" in the test.
  const decoy = new Group();
  decoy.name = 'Decoy';
  model.add(decoy);
  const decoyMesh = new Mesh(triangleGeometry(20), material);
  decoyMesh.name = 'DecoyA';
  decoy.add(decoyMesh);

  const registry = new NodeRegistry();
  model.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  model.updateMatrixWorld(true);

  const selected = ['Asset/Decoy'];
  const selectCalls: string[] = [];
  const viewer = {
    scene,
    registry,
    drives: [] as unknown[],
    signalStore: null,
    transportManager: null,
    groups: null,
    logicRunState: 'active',
    get currentModelRoot() { return model; },
    modes: { activeMode: mode },
    instancePickIndex: { addSubtree() {}, removeSubtree() {}, bumpResolutionEpoch() {} },
    buildMeshBvhsAsync() {},
    registerDeferredLogic() {},
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    rebuildGroupedBvh() {},
    selectionManager: {
      getSnapshot: () => ({ selectedPaths: selected }),
      select: (path: string) => { selectCalls.push(path); },
    },
  } as unknown as RVViewer;

  return { viewer, registry, model, assembly, leaf, selected, selectCalls };
}

function targetFor(path: string, node: Object3D): ContextMenuTarget {
  return { path, node, types: [], extras: {} };
}

async function waitFor(predicate: () => boolean, label: string): Promise<void> {
  for (let i = 0; i < 400; i++) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 5));
  }
  throw new Error(`timed out waiting for ${label}`);
}

afterEach(() => {
  setActiveAssetContext(null);
  disposeMergeClient();
});

describe('9.16 hierarchy right-click without a selection', () => {
  it('shows the entry for a NON-selected subtree row', () => {
    const { viewer, assembly, leaf, selected } = makeHarness();
    const item = buildMergeMenuItem(viewer);

    // The selection points somewhere else entirely — the entry must still appear.
    expect(selected).toEqual(['Asset/Decoy']);
    expect(item.condition!(targetFor('Asset/Assembly', assembly))).toBe(true);
    // A leaf can never be merged — that much IS free to decide at menu-open time.
    expect(item.condition!(targetFor('Asset/Assembly/PartA', leaf))).toBe(false);
    // Static label, no analysis while the menu opens.
    expect(item.label).toBe('Merge into one mesh…');
  });

  it('is hidden outside editor mode', () => {
    const { viewer, assembly } = makeHarness('hmi');
    const item = buildMergeMenuItem(viewer);
    expect(item.condition!(targetFor('Asset/Assembly', assembly))).toBe(false);
  });

  it('acts on the CLICKED row, not on the current selection', async () => {
    const harness = makeHarness();
    const { viewer, registry, assembly } = harness;
    const doc = AssetDocument.newUntitled(viewer);
    setActiveAssetContext({ viewer, doc });

    const item = buildMergeMenuItem(viewer);
    item.action!(targetFor('Asset/Assembly', assembly));

    await waitFor(() => getPendingDialog()?.kind === 'merge-preview', 'the preview dialog');
    const dialog = getPendingDialog();
    expect(dialog).not.toBeNull();
    if (dialog?.kind !== 'merge-preview') throw new Error('wrong dialog');
    await waitFor(() => {
      const d = getPendingDialog();
      return d?.kind === 'merge-preview' && d.status === 'ready';
    }, 'the analysis');

    const ready = getPendingDialog();
    if (ready?.kind !== 'merge-preview') throw new Error('wrong dialog');
    expect(ready.nodeName).toBe('Assembly');
    expect(ready.sourceCount).toBe(2);
    expect(ready.outputCount).toBe(1);
    ready.resolve(true);

    await waitFor(() => doc.getSnapshot().opCount === 1, 'the merge op');

    const merged = registry.getNode('Asset/Assembly') as Mesh;
    expect((merged as { isMesh?: boolean }).isMesh).toBe(true);
    expect(merged.geometry.getAttribute('position').count).toBe(6);
    // The decoy — the SELECTED subtree — was never touched.
    expect(registry.getNode('Asset/Decoy/DecoyA')).not.toBeNull();
    // Selection follows the result, at the clicked path.
    expect(harness.selectCalls).toEqual(['Asset/Assembly']);
    doc.dispose();
  });

  it('reports an ineligible subtree in the dialog and creates no op', async () => {
    const harness = makeHarness();
    const { viewer, registry } = harness;
    const doc = AssetDocument.newUntitled(viewer);
    setActiveAssetContext({ viewer, doc });

    const decoy = registry.getNode('Asset/Decoy')!; // one mesh only
    const item = buildMergeMenuItem(viewer);
    item.action!(targetFor('Asset/Decoy', decoy));

    await waitFor(() => {
      const d = getPendingDialog();
      return d?.kind === 'merge-preview' && d.status === 'ineligible';
    }, 'the ineligible state');
    const dialog = getPendingDialog();
    if (dialog?.kind !== 'merge-preview') throw new Error('wrong dialog');
    expect(dialog.reason).toMatch(/Fewer than two mergeable meshes/);
    dialog.resolve(false);

    expect(doc.getSnapshot().opCount).toBe(0);
    doc.dispose();
  });

  it('cancel leaves the tree untouched', async () => {
    const harness = makeHarness();
    const { viewer, registry, assembly } = harness;
    const doc = AssetDocument.newUntitled(viewer);
    setActiveAssetContext({ viewer, doc });

    const item = buildMergeMenuItem(viewer);
    item.action!(targetFor('Asset/Assembly', assembly));
    await waitFor(() => {
      const d = getPendingDialog();
      return d?.kind === 'merge-preview' && d.status === 'ready';
    }, 'the analysis');
    const open = getPendingDialog();
    if (open?.kind !== 'merge-preview') throw new Error('wrong dialog');
    open.resolve(false);

    await new Promise((r) => setTimeout(r, 30));
    expect(doc.getSnapshot().opCount).toBe(0);
    expect(registry.getNode('Asset/Assembly')).toBe(assembly);
    expect(registry.getNode('Asset/Assembly/PartA')).not.toBeNull();
    doc.dispose();
  });
});
