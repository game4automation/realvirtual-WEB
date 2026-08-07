// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Asset GLB export round-trip — the save/load contract of the asset editor:
 * `userData.realvirtual` (components + CADLink) must survive export →
 * GLTFLoader re-parse, internal `_`/`__` marker keys must be stripped, and
 * node names/paths must stay stable (rv_extras targeting depends on them).
 */
import { describe, it, expect } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { exportAssetGlb, sanitizeUserDataForExport, pruneRuntimeHelpers } from '../src/core/editor/rv-asset-glb-export';

function buildAssetTree(): Group {
  const root = new Group();
  root.name = 'Asset';

  const cadRoot = new Group();
  cadRoot.name = 'Gearbox';
  cadRoot.userData.realvirtual = {
    CADLink: { File: 'gearbox.step', Sha256: 'abc123', Quality: 'standard', ImportScaleFactor: 0.001, ZIsUpVector: true },
  };
  cadRoot.userData.__rvAdded = true; // internal marker — must be stripped
  root.add(cadRoot);

  const housing = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ color: 0x2288cc }));
  housing.name = 'Housing';
  housing.userData.realvirtual = {
    Drive: { Direction: 'LinearX', TargetSpeed: 100 },
    PLCOutputBool: { signalName: 'Housing_Run' },
    PLCOutputBool_1: { signalName: 'Housing_Fault' },
  };
  cadRoot.add(housing);

  const empty = new Object3D();
  empty.name = 'Pivot';
  empty.userData._layoutObject = true; // internal marker — must be stripped
  cadRoot.add(empty);

  return root;
}

async function parseGlb(buffer: ArrayBuffer): Promise<Object3D> {
  const loader = new GLTFLoader();
  const gltf = await loader.parseAsync(buffer, '');
  return gltf.scene;
}

function findByName(root: Object3D, name: string): Object3D | null {
  let found: Object3D | null = null;
  root.traverse((n) => { if (!found && n.name === name) found = n; });
  return found;
}

describe('sanitizeUserDataForExport', () => {
  it('strips underscore-prefixed keys, keeps realvirtual + user extras', () => {
    const root = buildAssetTree();
    (findByName(root, 'Gearbox')!.userData as Record<string, unknown>).customNote = 'keep me';
    sanitizeUserDataForExport(root);
    const gearbox = findByName(root, 'Gearbox')!;
    expect(gearbox.userData.__rvAdded).toBeUndefined();
    expect(gearbox.userData.customNote).toBe('keep me');
    expect((gearbox.userData.realvirtual as any).CADLink.File).toBe('gearbox.step');
    expect(findByName(root, 'Pivot')!.userData._layoutObject).toBeUndefined();
  });
});

describe('exportAssetGlb round-trip', () => {
  it('realvirtual extras (incl. CADLink + suffixed signals) survive; node names stable', async () => {
    const root = buildAssetTree();
    const glb = await exportAssetGlb(root);
    expect(glb.byteLength).toBeGreaterThan(0);

    const scene = await parseGlb(glb);

    const gearbox = findByName(scene, 'Gearbox');
    expect(gearbox).not.toBeNull();
    const cadlink = (gearbox!.userData.realvirtual as any)?.CADLink;
    expect(cadlink).toEqual({
      File: 'gearbox.step', Sha256: 'abc123', Quality: 'standard',
      ImportScaleFactor: 0.001, ZIsUpVector: true,
    });
    expect(gearbox!.userData.__rvAdded).toBeUndefined();

    const housing = findByName(scene, 'Housing');
    expect(housing).not.toBeNull();
    const rv = housing!.userData.realvirtual as any;
    expect(rv.Drive).toEqual({ Direction: 'LinearX', TargetSpeed: 100 });
    expect(rv.PLCOutputBool).toEqual({ signalName: 'Housing_Run' });
    expect(rv.PLCOutputBool_1).toEqual({ signalName: 'Housing_Fault' });

    // Component-bearing nodes keep their name-path (rv_extras targeting).
    expect(findByName(scene, 'Pivot')).not.toBeNull();
    expect(housing!.parent?.name).toBe('Gearbox');
  });

  it('export does not mutate the live tree (works on a sanitized clone)', async () => {
    const root = buildAssetTree();
    await exportAssetGlb(root);
    // Internal markers still present on the ORIGINAL after export.
    expect(findByName(root, 'Gearbox')!.userData.__rvAdded).toBe(true);
  });

  it('prunes __raycastBVH helper meshes from the export, keeps them live', async () => {
    const root = buildAssetTree();
    // The grouped raycast BVH parks invisible merged meshes INSIDE the asset
    // root (static under root, kinematic under Drive nodes).
    const staticBvh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    staticBvh.name = '__raycastBVH_static';
    root.add(staticBvh);
    const driveBvh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    driveBvh.name = '__raycastBVH_Housing';
    findByName(root, 'Housing')!.add(driveBvh);

    const glb = await exportAssetGlb(root);
    const scene = await parseGlb(glb);
    expect(findByName(scene, '__raycastBVH_static')).toBeNull();
    expect(findByName(scene, '__raycastBVH_Housing')).toBeNull();
    expect(findByName(scene, 'Housing')).not.toBeNull(); // real content untouched

    // Live tree keeps its helpers — picking must survive a save.
    expect(findByName(root, '__raycastBVH_static')).not.toBeNull();
    expect(findByName(root, '__raycastBVH_Housing')).not.toBeNull();
  });

  it('authored-hidden nodes (visible=false + rv.Hidden) SURVIVE the export', async () => {
    // GLTFExporter defaults to onlyVisible:true — without the explicit
    // override, "hide + save" would silently delete the node from the GLB.
    const root = buildAssetTree();
    const housing = findByName(root, 'Housing')!;
    housing.visible = false;
    (housing.userData.realvirtual as Record<string, unknown>).Hidden = true;

    const scene = await parseGlb(await exportAssetGlb(root));
    const reloaded = findByName(scene, 'Housing');
    expect(reloaded).not.toBeNull();
    expect((reloaded!.userData.realvirtual as any).Hidden).toBe(true);
    // Its components round-trip too.
    expect((reloaded!.userData.realvirtual as any).Drive.TargetSpeed).toBe(100);
  });

  it('authored-hidden nodes reload with visible=false through the full loadGLB pipeline', async () => {
    // The GLB carries rv.Hidden but glTF has no node visibility — the scene
    // loader must re-apply `.visible = false` so "hide + save + reopen" keeps
    // the node hidden (and out of the marquee-selectable set).
    const root = buildAssetTree();
    const housing = findByName(root, 'Housing')!;
    housing.visible = false;
    (housing.userData.realvirtual as Record<string, unknown>).Hidden = true;

    const glb = await exportAssetGlb(root);
    const { loadGLB } = await import('../src/core/engine/rv-scene-loader');
    const { Scene } = await import('three');
    const result = await loadGLB('memory-asset.glb', new Scene(), {
      data: glb,
      preserveHierarchy: true,
    });
    const reloaded = findByName(result.root, 'Housing');
    expect(reloaded).not.toBeNull();
    expect(reloaded!.visible).toBe(false);
    // Sibling content stays visible.
    expect(findByName(result.root, 'Pivot')!.visible).toBe(true);
  });
});

describe('pruneRuntimeHelpers', () => {
  it('removes all __raycastBVH* nodes in place', () => {
    const root = buildAssetTree();
    const bvh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    bvh.name = '__raycastBVH';
    root.add(bvh);
    pruneRuntimeHelpers(root);
    expect(findByName(root, '__raycastBVH')).toBeNull();
    expect(findByName(root, 'Gearbox')).not.toBeNull();
  });

  it('removes runtime overlay helpers that onlyVisible:false would otherwise export', () => {
    const root = buildAssetTree();
    const overlay = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    overlay.name = 'HousingOverlay';
    overlay.userData._highlightOverlay = true;
    root.add(overlay);
    const gizmo = new Object3D();
    gizmo.name = 'Gizmo';
    gizmo.userData._rvGizmo = true;
    root.add(gizmo);
    const sensorViz = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    sensorViz.name = 'S1_sensorViz';
    root.add(sensorViz);
    const tankViz = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    tankViz.name = '_tankFillViz';
    root.add(tankViz);

    pruneRuntimeHelpers(root);
    expect(findByName(root, 'HousingOverlay')).toBeNull();
    expect(findByName(root, 'Gizmo')).toBeNull();
    expect(findByName(root, 'S1_sensorViz')).toBeNull();
    expect(findByName(root, '_tankFillViz')).toBeNull();
    expect(findByName(root, 'Gearbox')).not.toBeNull();
  });
});

describe('exportAssetGlb — glTF wrapper accumulation', () => {
  /** Depth of the deepest branch, root = 1. */
  function depth(node: Object3D): number {
    if (node.children.length === 0) return 1;
    return 1 + Math.max(...node.children.map(depth));
  }

  function names(node: Object3D): string[] {
    const out: string[] = [];
    node.traverse((n) => { if (n !== node) out.push(n.name); });
    return out.sort();
  }

  it('is a fixed point: repeated editor round trips add no wrapper levels', async () => {
    // The regression: GLTFExporter wraps a non-Scene input in a synthetic
    // Scene named AuxScene. The editor's load path keeps gltf.scene as the
    // asset root, so that wrapper came back as the root and got re-exported
    // as a content node — one extra AuxScene_N level per save.
    let root: Object3D = buildAssetTree();
    let baselineNames: string[] = [];
    let baselineDepth = 0;

    for (let i = 0; i < 4; i++) {
      root = await parseGlb(await exportAssetGlb(root, 'GearboxCell'));

      // The scene name is the asset name → the planner's placement label.
      expect(root.name).toBe('GearboxCell');
      expect(root.children.map((c) => c.name)).toEqual(['Gearbox']);

      if (i === 0) {
        baselineNames = names(root);
        baselineDepth = depth(root);
      } else {
        expect(names(root)).toEqual(baselineNames);
        expect(depth(root)).toBe(baselineDepth);
      }
    }
  });

  it('collapses a legacy AuxScene chain in a single save', async () => {
    // What an asset saved by the old exporter looks like after three round
    // trips: nested wrapper nodes above the real content.
    const content = buildAssetTree();
    const inner = new Group();
    inner.name = 'AuxScene_1_1';
    inner.add(content);
    const middle = new Group();
    middle.name = 'AuxScene_1';
    middle.add(inner);
    const outer = new Group();
    outer.name = 'AuxScene';
    outer.add(middle);

    const healed = await parseGlb(await exportAssetGlb(outer, 'GearboxCell'));

    expect(healed.name).toBe('GearboxCell');
    // 'Asset' is the legacy content root — it too is flattened away, because
    // the exported Scene IS the asset root.
    expect(healed.children.map((c) => c.name)).toEqual(['Gearbox']);
    expect(names(healed).some((n) => /^AuxScene/i.test(n))).toBe(false);
    expect(findByName(healed, 'Housing')).not.toBeNull();
  });

  it('keeps a transformed content root as a node under the asset-named scene', async () => {
    // A glTF scene cannot carry a transform, so flattening would move the
    // asset. The level stays and keeps its OWN name — the scene above it
    // carries the asset name, and reusing that name here would make the
    // loader dedup the node to `<asset>_1`.
    const root = buildAssetTree();
    root.position.set(1, 2, 3);

    const parsed = await parseGlb(await exportAssetGlb(root, 'ShiftedCell'));

    expect(parsed.name).toBe('ShiftedCell');
    const kept = parsed.children[0];
    expect(kept.name).toBe('Asset');
    expect(kept.position.toArray()).toEqual([1, 2, 3]);
  });

  it('a transformed root is a fixed point across round trips too', async () => {
    let root: Object3D = buildAssetTree();
    root.position.set(1, 2, 3);
    let baseline: string[] = [];
    for (let i = 0; i < 3; i++) {
      root = await parseGlb(await exportAssetGlb(root, 'ShiftedCell'));
      expect(root.name).toBe('ShiftedCell');
      if (i === 0) baseline = names(root);
      else expect(names(root)).toEqual(baseline);
    }
  });

  it('falls back to the content root name when no asset name is given', async () => {
    const parsed = await parseGlb(await exportAssetGlb(buildAssetTree()));
    expect(parsed.name).toBe('Asset');
  });
});
