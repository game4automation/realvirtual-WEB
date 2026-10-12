// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial } from 'three';
import { collectNodeMeshInfo } from '../src/core/engine/rv-node-mesh-info';
import { RV_BAKE_CHUNK_KEY, type ChunkHighlightSource } from '../src/core/engine/rv-bake-registry';
import { inspectorWritePath, meshInspectorRows } from '../src/core/hmi/rv-property-inspector';
import { RV_SYNTHETIC_KEY } from '../src/core/engine/rv-bake-chunk';

const BOX_TRIANGLES = 12;

function box(name: string): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 2, 3), new MeshStandardMaterial({ name: `${name}-mat` }));
  mesh.name = name;
  return mesh;
}

function chunkMesh(name: string): Mesh {
  const mesh = box(name);
  mesh.userData[RV_BAKE_CHUNK_KEY] = true;
  return mesh;
}

describe('collectNodeMeshInfo', () => {
  it('reports nothing for a plain group, even with meshes below it', () => {
    const root = new Group();
    root.add(box('child'));
    expect(collectNodeMeshInfo(root, null)).toEqual([]);
  });

  it('reports the own mesh and its data block', () => {
    const mesh = box('part');
    const [own] = collectNodeMeshInfo(mesh, null);
    expect(own.kind).toBe('own');
    expect(own.block).toBe(mesh.geometry.uuid.slice(0, 8));
    expect(own.triangles).toBe(BOX_TRIANGLES);
    expect(own.attributes[0]).toBe('index');
  });

  // plan-754 F12: the `Drawn` row is gone. Under the destructive bake a merged
  // source mesh is REMOVED rather than masked, so the state had one value; what
  // the section must still never do is invent a row for it.
  it('reports no draw-state row for an own mesh', () => {
    const [own] = collectNodeMeshInfo(box('part'), null);
    expect(meshInspectorRows([own]).map(([label]) => label)).not.toContain('Drawn');
    expect(meshInspectorRows([own]).map(([label]) => label))
      .toEqual(['Geometry', 'Triangles', 'Vertices', 'Material', 'Attributes']);
  });

  it('lists the chunk meshes parented to their owner, never a chunk as an own mesh', () => {
    const owner = new Group();
    const chunk = chunkMesh('static');
    owner.add(box('source'), chunk);
    expect(collectNodeMeshInfo(owner, null).map((e) => [e.kind, e.name])).toEqual([['chunk', 'static']]);
    expect(collectNodeMeshInfo(chunk, null)).toEqual([]);
  });

  it('reports the chunk window of a placement logic node', () => {
    const root = new Group();
    const logic = new Group();
    const chunk = chunkMesh('static');
    root.add(logic, chunk);
    const range = { indexStart: 6, indexCount: 18, centerX: 0, centerY: 0, centerZ: 0, radius: 1 };
    const source: ChunkHighlightSource = {
      chunkTargetsOf: (n) => (n === logic ? [{ mesh: chunk, range }] : n === root ? [{ mesh: chunk, range: null }] : null),
      onRelease: () => () => {},
    };

    // The root's whole-chunk target is the chunk mesh under it — listed once.
    expect(collectNodeMeshInfo(root, source).map((e) => e.kind)).toEqual(['chunk']);

    const [window] = collectNodeMeshInfo(logic, source);
    expect(window.kind).toBe('window');
    expect(window.triangles).toBe(6);
    expect(window.vertices).toBeNull();
    expect(meshInspectorRows([window])).toEqual([['Chunk window 1', 'static · 6 tris · idx 6 +18']]);
  });

  // plan-755 O2: a partitioned chunk hangs under the partition object the bake
  // created, so the BOUNDARY lists only its direct (unpartitioned) chunks and
  // the partition object lists its own — "direct children", nothing special.
  it('a partition object lists its chunks; the boundary lists only its direct ones', () => {
    const boundary = new Group();
    const direct = chunkMesh('mover:Axis');
    const partitionObject = new Group();
    partitionObject.name = 'Covers';
    partitionObject.userData[RV_SYNTHETIC_KEY] = true;
    const partitioned = chunkMesh('mover:Axis|grp:Covers');
    partitionObject.add(partitioned);
    boundary.add(direct, partitionObject);
    // Same answers the registry gives: whole-chunk targets for both nodes.
    const source: ChunkHighlightSource = {
      chunkTargetsOf: (n) => (n === boundary
        ? [{ mesh: direct, range: null }, { mesh: partitioned, range: null }]
        : n === partitionObject ? [{ mesh: partitioned, range: null }] : null),
      onRelease: () => () => {},
    };
    expect(collectNodeMeshInfo(boundary, source).map((e) => [e.kind, e.name])).toEqual([['chunk', 'mover:Axis']]);
    expect(collectNodeMeshInfo(partitionObject, source).map((e) => [e.kind, e.name]))
      .toEqual([['chunk', 'mover:Axis|grp:Covers']]);
  });
});

describe('inspectorWritePath (plan-755 F9)', () => {
  it('a registered document node is writable by its path', () => {
    expect(inspectorWritePath(new Group(), 'Plant/Axis')).toBe('Plant/Axis');
  });

  it('a synthetic partition object is READ-ONLY although it has a path — the runtime-selection branch', () => {
    const partitionObject = new Group();
    partitionObject.userData[RV_SYNTHETIC_KEY] = true;
    partitionObject.userData.realvirtual = { Group: { GroupName: 'Covers' } };
    // No write path → `isRuntimeSelection`: fields render through the read-only
    // pipeline, `handleFieldEdit` / `writeOverride` / Add Component are unreachable.
    expect(inspectorWritePath(partitionObject, 'Plant/Axis/Covers')).toBeNull();
    // Survives the JSON clone every placement makes of it.
    const clone = new Group();
    clone.userData = JSON.parse(JSON.stringify(partitionObject.userData));
    expect(inspectorWritePath(clone, 'Placed/Axis/Covers')).toBeNull();
  });

  it('no selection / no path stays null', () => {
    expect(inspectorWritePath(null, 'x')).toBeNull();
    expect(inspectorWritePath(new Group(), null)).toBeNull();
  });
});
