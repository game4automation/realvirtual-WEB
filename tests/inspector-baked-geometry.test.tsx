// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-505 §9.4 — the inspector's "Baked geometry" section for a selected chunk.
 *
 * Built from real chunks (`bake-fixture.ts`, destructive bake → `chunkMetaOf`),
 * so the section reads the same metadata the running viewer reads.
 */

import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BoxGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, type Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';
import { RVUberMaterial, isUberMaterial } from '../src/core/engine/rv-uber-material';
import { RV_PARTITION_KEY, chunkMetaOf, type BakedAsset, type BakedChunk } from '../src/core/engine/rv-bake-chunk';
import { isRuntimeRow, type RuntimeRowSpec } from '../src/core/hmi/rv-component-section';
import {
  BAKED_GEOMETRY_SECTION,
  MERGED_MATERIAL_TEXT,
  buildBakedGeometryVirtualComponent,
} from '../src/core/hmi/rv-baked-geometry-section';
import { formatCountFull } from '../src/core/hmi/chunk-row-labels';
import type { RVViewer } from '../src/core/rv-viewer';
import { bakeTree, group, makeTexture, texturedMesh, uberMesh } from './fixtures/bake-fixture';
import topBarSource from '../src/core/hmi/TopBar.tsx?raw';

afterEach(cleanup);

const uber = new RVUberMaterial(false);

function partition<T extends Object3D>(node: T, ...labels: string[]): T {
  node.userData[RV_PARTITION_KEY] = labels;
  return node;
}

/** A viewer double: a registry that knows only `known`, and an editor plugin spy. */
function makeViewer(known: Map<Object3D, string>) {
  const selectAndReveal = vi.fn();
  const viewer = {
    registry: {
      getPathForNode: (n: Object3D) => known.get(n) ?? null,
      getNode: () => null,
      resolvePath: () => null,
    },
    getPlugin: (id: string) => (id === 'rv-extras-editor' ? { selectAndReveal } : null),
  } as unknown as RVViewer;
  return { viewer, selectAndReveal };
}

async function bakeAll(): Promise<{ asset: BakedAsset; root: Object3D }> {
  const root = group('Asset');
  root.add(uberMesh(uber, 'a', [0, 0, 0]));
  root.add(uberMesh(uber, 'b', [2, 0, 0]));
  const steel = new MeshStandardMaterial({ map: makeTexture(), color: 0x8a8f94 });
  steel.name = 'Brushed Steel';
  root.add(texturedMesh('t', steel, [4, 0, 0]));
  root.add(partition(uberMesh(uber, 'p', [6, 0, 0]), 'MC01.13'));
  const asset = await bakeTree(root, { uber, destructive: true });
  return { asset, root: asset.template };
}

function row(data: Record<string, unknown>, key: string): RuntimeRowSpec {
  const v = data[key];
  expect(isRuntimeRow(v), key).toBe(true);
  return v as RuntimeRowSpec;
}

function meshOf(chunk: BakedChunk): Mesh {
  expect(chunk.templateMesh).toBeTruthy();
  return chunk.templateMesh!;
}

describe('Baked geometry section (plan-505 §9.4)', () => {
  it('describes an uber chunk: boundary link, merged material, full counts, segments', async () => {
    const { asset } = await bakeAll();
    const merged = asset.chunks.find((c) => isUberMaterial(c.material) && c.partition === '')!;
    const { viewer, selectAndReveal } = makeViewer(new Map([[merged.owner, 'Asset']]));
    const vc = buildBakedGeometryVirtualComponent(viewer, meshOf(merged))!;
    expect(vc).not.toBeNull();
    expect(vc.type).toBe(BAKED_GEOMETRY_SECTION);
    expect(row(vc.data, 'Boundary').display).toBe(merged.owner.name);
    expect(row(vc.data, 'Partition').display).toBe('—');
    expect(row(vc.data, 'Material').display).toBe(MERGED_MATERIAL_TEXT);
    expect(row(vc.data, 'Triangles').display).toBe(formatCountFull(merged.triangles));
    expect(row(vc.data, 'Vertices').display)
      .toBe(formatCountFull(merged.geometry.getAttribute('position').count));
    expect(row(vc.data, 'Segments').display).toBe(formatCountFull(merged.pick.segmentCount));
    expect(row(vc.data, 'Chunk key').display).toBe(merged.key);
    expect(vc.extraContent).toBeUndefined();   // no swatch for a merged chunk

    // The boundary link navigates to the owner's registered path.
    const link = row(vc.data, 'Boundary');
    expect(link.onClick).toBeTypeOf('function');
    link.onClick!();
    expect(selectAndReveal).toHaveBeenCalledWith('Asset', true);
  });

  it('groups large counts', async () => {
    const { asset } = await bakeAll();
    const merged = asset.chunks.find((c) => isUberMaterial(c.material) && c.partition === '')!;
    const { viewer } = makeViewer(new Map());
    const original = merged.triangles;
    merged.triangles = 84213;
    try {
      const vc = buildBakedGeometryVirtualComponent(viewer, meshOf(merged))!;
      expect(row(vc.data, 'Triangles').display).toBe('84,213');
    } finally {
      merged.triangles = original;
    }
  });

  it('shows a texture-mapped chunk by name, without a (misleading) swatch', async () => {
    const { asset } = await bakeAll();
    const textured = asset.chunks.find((c) => !isUberMaterial(c.material))!;
    const { viewer } = makeViewer(new Map());
    const vc = buildBakedGeometryVirtualComponent(viewer, meshOf(textured))!;
    expect(row(vc.data, 'Material').display).toBe('Brushed Steel');
    expect(vc.extraContent).toBeUndefined();
  });

  it('shows an untextured colour material with an sRGB swatch', () => {
    const material = new MeshStandardMaterial({ color: 0x8a8f94 });
    material.name = 'Grey Paint';
    const mesh = new Mesh(new BoxGeometry(), material);
    mesh.userData._rvBakeChunk = true;
    const chunk = {
      key: 'tex:grey', partition: '', partitionLabels: [], geometry: mesh.geometry, material,
      templateMesh: mesh, groupObject: null, ownerPath: null, owner: group('Owner'),
      triangles: 12, pick: { segmentCount: 1 }, blocks: true,
    } as unknown as BakedChunk;
    chunkMetaOf.set(mesh.geometry, { chunk, asset: {} as BakedAsset });
    const { viewer } = makeViewer(new Map());
    const vc = buildBakedGeometryVirtualComponent(viewer, mesh)!;
    expect(row(vc.data, 'Material').display).toBe('Grey Paint');
    expect(vc.extraContent).toBeTruthy();
    render(<>{vc.extraContent}</>);
    expect(screen.getByText('#8a8f94')).toBeTruthy();
    const swatch = screen.getByTestId('baked-geometry-swatch');
    expect(getComputedStyle(swatch).backgroundColor).toBe('rgb(138, 143, 148)');
  });

  it('lists the partition of a partitioned chunk', async () => {
    const { asset } = await bakeAll();
    const part = asset.chunks.find((c) => c.partition === 'MC01.13')!;
    const { viewer } = makeViewer(new Map());
    const vc = buildBakedGeometryVirtualComponent(viewer, meshOf(part))!;
    expect(row(vc.data, 'Partition').display).toBe('MC01.13');
  });

  it('falls back to the nearest registered ancestor, else renders an inert boundary', async () => {
    const { asset } = await bakeAll();
    const merged = asset.chunks.find((c) => isUberMaterial(c.material) && c.partition === '')!;
    const { viewer: none } = makeViewer(new Map());
    const inert = buildBakedGeometryVirtualComponent(none, meshOf(merged))!;
    expect(row(inert.data, 'Boundary').onClick).toBeUndefined();

    // Owner unregistered, but an ancestor is.
    const parent = group('Layout');
    parent.add(merged.owner);
    const { viewer, selectAndReveal } = makeViewer(new Map([[parent, 'Layout']]));
    const vc = buildBakedGeometryVirtualComponent(viewer, meshOf(merged))!;
    row(vc.data, 'Boundary').onClick!();
    expect(selectAndReveal).toHaveBeenCalledWith('Layout', true);
  });

  it('renders nothing for a non-chunk node or a chunk without bake meta', () => {
    const { viewer } = makeViewer(new Map());
    const plain = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    expect(buildBakedGeometryVirtualComponent(viewer, plain)).toBeNull();
    const foreign = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
    foreign.userData._rvBakeChunk = true;
    expect(buildBakedGeometryVirtualComponent(viewer, foreign)).toBeNull();
    expect(buildBakedGeometryVirtualComponent(viewer, null)).toBeNull();
  });
});

describe('the desktop inspector mounts for a path-less selection (plan-505 F7)', () => {
  // TopBar is not mountable in isolation (the whole shell behind it), so this
  // pins the mount gate in its source, the same way hmi-mode-regression does:
  // a chunk mesh has no path, and gating on `selectedNodePath` alone made the
  // "Baked geometry" section unreachable on desktop.
  it('gates <PropertyInspector> on the selected node, not only on its path', () => {
    const gate = topBarSource.slice(
      topBarSource.indexOf('pluginState.showInspector'),
      topBarSource.indexOf('<PropertyInspector'),
    );
    expect(gate).toContain('pluginState.selectedNode)');
    expect(gate).toMatch(/pluginState\.selectedNodePath \|\| pluginState\.selectedNode\b/);
  });
});
