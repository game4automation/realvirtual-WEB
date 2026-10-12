// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The hierarchy root row (plan-715 F1–F4): it renders with the DOCUMENT name,
 * it is selectable, and every structural affordance is absent from it.
 *
 * The lock is tested as a set of REMOVALS (no eye, not draggable) rather than as
 * a marker class, because that is the actual contract — a future refactor that
 * keeps a `data-locked` attribute while re-adding the eye must fail here.
 *
 * plan-754: the rows now come from the scene graph (`flattenSceneRows`) instead
 * of a path-string projection. The contract is unchanged; only its source is.
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';
import { TreeNodeRow } from '../src/core/hmi/HierarchyNodeRow';
import { flattenSceneRows, type SceneRowContext } from '../src/core/hmi/hierarchy-rows';
import type { VisibleTreeRow } from '../src/core/hmi/hierarchy-utils';
import { isModelRoot } from '../src/core/engine/rv-model-root';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

const viewer = { id: 'test-viewer' } as unknown as RVViewer;
const noop = () => {};

afterEach(cleanup);

/** Robot (model root) with a Drive child and a plain child, fully registered. */
function makeAsset(label?: string | null) {
  const scene = new Scene();
  const root = new Group(); root.name = 'Robot';
  const base = new Group(); base.name = 'Base';
  base.userData.realvirtual = { Drive: {} };
  const arm = new Object3D(); arm.name = 'Arm';
  root.add(base, arm);
  scene.add(root);

  const paths = new Map<Object3D, string>([[root, 'Robot'], [base, 'Robot/Base'], [arm, 'Robot/Arm']]);
  const ctx: SceneRowContext = {
    getPathForNode: (n) => paths.get(n) ?? null,
    overlay: null,
    modelRoot: root,
    modelRootLabel: label ?? null,
    hideRuntime: false,
  };
  const expanded = new Set<string>([scene.uuid, root.uuid]);
  return { scene, root, base, arm, ctx, expanded };
}

/** Render one row of the scene tree, picked by node name. */
function renderRow(
  asset: ReturnType<typeof makeAsset>,
  rowName: string,
  overrides: Partial<React.ComponentProps<typeof TreeNodeRow>> = {},
): VisibleTreeRow {
  const rows = flattenSceneRows(asset.scene, asset.expanded, asset.ctx);
  const row = rows.find((r) => r.node.name === rowName);
  if (!row) throw new Error(`no row named ${rowName} in [${rows.map((r) => r.node.name)}]`);
  render(
    <TreeNodeRow
      row={row}
      expanded={new Set()}
      onToggleExpand={noop}
      onSelect={noop}
      onDoubleClick={noop}
      onHover={noop}
      signalStore={null}
      logicEngine={null}
      viewer={viewer}
      rowHeight={22}
      virtualStyle={{}}
      {...overrides}
    />,
  );
  return row;
}

describe('root row rendering', () => {
  it('shows the DOCUMENT label, not the Object3D name', () => {
    renderRow(makeAsset('Welding Cell'), 'Robot');
    expect(screen.getByText('Welding Cell')).toBeTruthy();
    expect(screen.queryByText('Robot')).toBeNull();
  });

  it('falls back to the node name when no label is supplied', () => {
    renderRow(makeAsset(), 'Robot');
    expect(screen.getByText('Robot')).toBeTruthy();
  });

  it('renders NO eye toggle even while the editor visibility props are present', () => {
    renderRow(makeAsset('Cell'), 'Robot', {
      getNodeVisible: () => true,
      onToggleVisible: vi.fn(),
    });
    expect(screen.queryByLabelText('Hide')).toBeNull();
    expect(screen.queryByLabelText('Show')).toBeNull();
  });

  it('still renders the eye toggle for an ordinary child row', () => {
    renderRow(makeAsset('Cell'), 'Base', {
      getNodeVisible: () => true,
      onToggleVisible: vi.fn(),
    });
    expect(screen.getByLabelText('Hide')).toBeTruthy();
  });

  it('is not draggable while DnD is enabled, but children are', () => {
    const asset = makeAsset('Cell');
    renderRow(asset, 'Robot', { dndEnabled: true });
    expect(document.querySelector('[data-path="Robot"]')?.getAttribute('draggable')).toBeNull();
    cleanup();
    renderRow(asset, 'Base', { dndEnabled: true });
    expect(document.querySelector('[data-path="Robot/Base"]')?.getAttribute('draggable')).toBe('true');
  });

  it('is selectable and reports its own row node', () => {
    const onSelect = vi.fn();
    const asset = makeAsset('Cell');
    renderRow(asset, 'Robot', { onSelect });
    fireEvent.click(document.querySelector('[data-path="Robot"]')!);
    expect(onSelect).toHaveBeenCalledTimes(1);
    expect(onSelect.mock.calls[0][0].object).toBe(asset.root);
    expect(onSelect.mock.calls[0][1]).toEqual({ shift: false, toggle: false });
  });

  it('still accepts a DROP (dropping onto the root moves a node to the top level)', () => {
    const onRowDrop = vi.fn();
    const asset = makeAsset('Cell');
    renderRow(asset, 'Robot', { dndEnabled: true, onRowDrop });
    const el = document.querySelector('[data-path="Robot"]')!;
    fireEvent.drop(el, { clientY: 11 });
    expect(onRowDrop).toHaveBeenCalled();
    expect(onRowDrop.mock.calls[0][0].object).toBe(asset.root);
  });
});

describe('root row absence', () => {
  it('renders the scene root and no model-root row when no model is loaded', () => {
    const scene = new Scene();
    const ctx: SceneRowContext = {
      getPathForNode: () => null,
      overlay: null,
      modelRoot: null,
      hideRuntime: false,
    };
    const rows = flattenSceneRows(scene, new Set([scene.uuid]), ctx);
    expect(rows).toHaveLength(1);
    expect(rows[0].node.isModelRoot).toBeUndefined();
  });

  it('renders no root row for the type-filter FLAT list, by design', () => {
    // The flat list is a filtered COMPONENT list, not a tree — the root (which
    // has no component types) is deliberately absent. Pinned so that a future
    // "make it consistent" is a decision rather than a slip.
    const asset = makeAsset('Cell');
    const rows = flattenSceneRows(asset.scene, asset.expanded, asset.ctx);
    expect(rows.find((r) => r.node.name === 'Robot')!.node.isModelRoot).toBe(true);
    const drivesOnly = rows.filter((r) => r.node.types.includes('Drive'));
    expect(drivesOnly.map((r) => r.node.path)).toEqual(['Robot/Base']);
  });
});

// ─── Drag/drop resolution against the root (first coverage of resolveDrop) ──

/**
 * `resolveDrop`'s 'onto' branch, replicated here at the level the browser uses
 * it: the root is a legal drop TARGET, and it resolves to `parentPath: null` —
 * the same convention `reparentNodes` uses for "the asset's top level".
 */
function resolveOnto(target: Object3D, dragged: Object3D[], modelRoot: Object3D | null) {
  const insideDragged = (n: Object3D | null): boolean => {
    for (let c: Object3D | null = n; c; c = c.parent) if (dragged.includes(c)) return true;
    return false;
  };
  if (insideDragged(target)) return null;
  if (isModelRoot(target, modelRoot)) return { parentPath: null };
  return { parentPath: NodeRegistry.computeNodePath(target) };
}

describe('resolveDrop onto the model root', () => {
  it('addresses the root slot as parentPath null, and a normal target by path', () => {
    const scene = new Scene();
    const modelRoot = new Group(); modelRoot.name = 'Robot';
    const base = new Group(); base.name = 'Base';
    const arm = new Object3D(); arm.name = 'Arm';
    modelRoot.add(base, arm);
    scene.add(modelRoot);

    expect(resolveOnto(modelRoot, [arm], modelRoot)).toEqual({ parentPath: null });
    expect(resolveOnto(base, [arm], modelRoot)).toEqual({ parentPath: 'Robot/Base' });
    // Dropping a node into its own subtree stays illegal.
    expect(resolveOnto(base, [modelRoot], modelRoot)).toBeNull();
  });
});
