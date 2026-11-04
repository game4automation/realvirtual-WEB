// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { Group, Mesh } from 'three';
import { singleMeshOf } from '../src/core/editor/rv-asset-executors';
import { isRuntimeHelperNode } from '../src/core/editor/rv-runtime-helper-node';
import { isRuntimeHelperNode as exportHelperPredicate } from '../src/core/editor/rv-asset-glb-export';

function addHelpers(root: Group): void {
  for (const marker of ['_rvGizmo', '_rvRuntimeVisual', '_highlightOverlay']) {
    const helper = new Mesh();
    helper.userData[marker] = true;
    root.add(helper);
  }
  const helperGroup = new Group();
  helperGroup.userData._rvRuntimeVisual = true;
  const nestedGroup = new Group();
  nestedGroup.add(new Mesh());
  helperGroup.add(nestedGroup);
  root.add(helperGroup);
}

describe('singleMeshOf with runtime children', () => {
  it('returns the authored mesh and skips helpers and their entire subtrees', () => {
    const root = new Group();
    const authored = new Mesh();
    addHelpers(root);
    root.add(authored);
    expect(singleMeshOf(root)).toBe(authored);
  });

  it('rejects two authored meshes even when helpers are present', () => {
    const root = new Group();
    root.add(new Mesh(), new Mesh());
    addHelpers(root);
    expect(singleMeshOf(root)).toBeNull();
  });

  it('returns a mesh root itself regardless of its children or helper marker', () => {
    const root = new Mesh();
    root.userData._rvRuntimeVisual = true;
    root.add(new Mesh(), new Mesh());
    expect(singleMeshOf(root)).toBe(root);
  });

  it('returns null when there is no authored mesh', () => {
    const root = new Group();
    expect(singleMeshOf(root)).toBeNull();
    addHelpers(root);
    expect(singleMeshOf(root)).toBeNull();
  });

  it('does not prune the traversal root itself', () => {
    const root = new Group();
    root.userData._rvRuntimeVisual = true;
    const authored = new Mesh();
    root.add(authored);
    expect(singleMeshOf(root)).toBe(authored);
  });

  it('shares the same predicate with the GLB exporter', () => {
    expect(exportHelperPredicate).toBe(isRuntimeHelperNode);
  });
});
