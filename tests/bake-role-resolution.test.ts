// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-753 §9.1 — role resolution of `bake()`.
 *
 * Capability role, `rv.BakeRole` override, inheritance down the tree and the
 * mover cut on a synthetic tree: Drive-in-Drive-in-Drive → three chunks; a
 * Lamp under a Drive → keep; a mover without meshes → no chunk; a
 * multi-material group under a `keep` override → keep; an unknown component →
 * merge. And every component of the Phase-1 table has an explicit, named role
 * — the bake follows the PLAN (TransportSurface/Cam = chunk, Sink = merge);
 * the Phase-1 `LEGACY_KEEP_OVERRIDE` went with the old pipelines in Phase 4b.
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, Mesh, MeshStandardMaterial } from 'three';
// Pull in every component registration (Drive, Lamp, TransportSurface, …).
import '../src/core/engine/rv-scene-loader';
import { getCapabilities, RV_BAKE_ROLE_KEY } from '../src/core/engine/rv-component-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { isMoverNode } from '../src/core/engine/rv-freeze-static';
import type { BakeRole } from '../src/core/engine/rv-bake-chunk';
import {
  bakeTree, chunkKeys, chunkByKey, group, uberMesh, withComponent, uberBakeGeometry, sourceTriangles, bakedTriangles, makeTexture,
} from './fixtures/bake-fixture';

const uber = new RVUberMaterial(false);

describe('bake() — role resolution (plan-753 §9.1)', () => {
  it('Drive-in-Drive-in-Drive → three chunks, one per mover, nested keys', async () => {
    const root = group('Asset');
    const a = withComponent(group('A'), 'Drive');
    const b = withComponent(group('B'), 'Drive');
    const c = withComponent(group('C'), 'Drive');
    root.add(a); a.add(b); b.add(c);
    a.add(uberMesh(uber, 'ma', [0, 0, 0]));
    b.add(uberMesh(uber, 'mb', [2, 0, 0]));
    c.add(uberMesh(uber, 'mc', [4, 0, 0]));

    const asset = await bakeTree(root, { uber });
    expect(chunkKeys(asset)).toEqual(['mover:A', 'mover:A/B', 'mover:A/B/C']);
    expect(chunkByKey(asset, 'mover:A').ownerPath).toBe('A');
    expect(chunkByKey(asset, 'mover:A/B/C').owner).toBe(c);
    expect(bakedTriangles(asset)).toBe(sourceTriangles(root));
    // The parent chain of a nested mover stays a logic node.
    expect(asset.logicNodes.map((l) => l.path)).toEqual(['A', 'A/B', 'A/B/C']);
  });

  it('a plain group under a Drive inherits the mover role — its mesh lands in the drive chunk', async () => {
    const root = group('Asset');
    const drive = withComponent(group('Drive-Rot-Y'), 'Drive');
    const sub = group('Housing');
    root.add(drive); drive.add(sub);
    sub.add(uberMesh(uber, 'part'));
    root.add(uberMesh(uber, 'frame', [5, 0, 0]));

    const asset = await bakeTree(root, { uber });
    expect(chunkKeys(asset)).toEqual(['mover:Drive-Rot-Y', 'static']);
    expect(chunkByKey(asset, 'mover:Drive-Rot-Y').geometry.getAttribute('position').count).toBe(24);
  });

  it('a Lamp under a Drive → keep (original mesh, relative path)', async () => {
    const root = group('Asset');
    const drive = withComponent(group('D'), 'Drive');
    const lamp = withComponent(group('Lamp'), 'Lamp');
    const lampMesh = uberMesh(uber, 'bulb');
    root.add(drive); drive.add(uberMesh(uber, 'arm')); drive.add(lamp); lamp.add(lampMesh);

    const asset = await bakeTree(root, { uber });
    expect(chunkKeys(asset)).toEqual(['mover:D']);
    expect(asset.keep).toHaveLength(1);
    expect(asset.keep[0].mesh).toBe(lampMesh);
    expect(asset.keep[0].path).toBe('D/Lamp/bulb');
  });

  it('a mover without meshes opens no chunk but is a logic node', async () => {
    const root = group('Asset');
    const drive = withComponent(group('Drive-Lin-Z'), 'Drive');
    drive.add(group('Snap-ZP-convroll'));
    root.add(drive);
    root.add(uberMesh(uber, 'frame'));

    const asset = await bakeTree(root, { uber });
    expect(chunkKeys(asset)).toEqual(['static']);
    expect(asset.logicNodes.map((l) => l.path)).toEqual(['Drive-Lin-Z', 'Drive-Lin-Z/Snap-ZP-convroll']);
  });

  it('a multi-material group under an rv.BakeRole:keep override → keep, never split', async () => {
    const root = group('Asset');
    const kept = group('Kept');
    kept.userData.realvirtual = { [RV_BAKE_ROLE_KEY]: 'keep' };
    const geo = uberBakeGeometry(new BoxGeometry(1, 1, 1));
    geo.clearGroups();
    geo.addGroup(0, 18, 0);
    geo.addGroup(18, 18, 1);
    const multi = new Mesh(geo, [uber, new MeshStandardMaterial()]);
    multi.name = 'multi';
    root.add(kept); kept.add(multi);
    root.add(uberMesh(uber, 'frame'));

    const asset = await bakeTree(root, { uber });
    expect(chunkKeys(asset)).toEqual(['static']);
    expect(asset.keep.map((k) => k.path)).toEqual(['Kept/multi']);
  });

  it('an rv.BakeRole:chunk override on a plain node opens a chunk', async () => {
    const root = group('Asset');
    const forced = group('Forced');
    forced.userData.realvirtual = { [RV_BAKE_ROLE_KEY]: 'chunk' };
    forced.add(uberMesh(uber, 'm'));
    root.add(forced);

    const asset = await bakeTree(root, { uber });
    expect(chunkKeys(asset)).toEqual(['mover:Forced']);
  });

  it('an unknown component → merge into the enclosing chunk', async () => {
    const root = group('Asset');
    const odd = withComponent(group('Odd'), 'SomethingNobodyRegistered');
    odd.add(uberMesh(uber, 'm'));
    root.add(odd);

    const asset = await bakeTree(root, { uber });
    expect(chunkKeys(asset)).toEqual(['static']);
    expect(asset.keep).toHaveLength(0);
  });

  it('Unity export markers (renderer/rigidbody) are no role — a marked mesh still inherits keep', async () => {
    const root = group('Asset');
    const lamp = withComponent(group('Lamp'), 'Lamp');
    const bulb = uberMesh(uber, 'bulb');
    // What every Unity-exported mesh carries: a `renderer` block (registered, hidden marker).
    withComponent(bulb, 'renderer', { type: 'MeshRenderer', enabled: true });
    lamp.add(bulb);
    const frame = uberMesh(uber, 'frame', [3, 0, 0]);
    withComponent(frame, 'renderer', { type: 'MeshRenderer', enabled: true });
    root.add(lamp, frame);

    const asset = await bakeTree(root, { uber });
    expect(chunkKeys(asset)).toEqual(['static']);
    expect(asset.keep.map((k) => k.path)).toEqual(['Lamp/bulb']);
    // Marker-only meshes are not logic nodes either.
    expect(asset.logicNodes.map((l) => l.path)).toEqual(['Lamp']);
  });

  it('PlacementMeta / LayoutObject are markers, not roles — their subtree merges', async () => {
    const root = group('Asset');
    const pm = withComponent(group('Nested'), 'PlacementMeta');
    pm.add(uberMesh(uber, 'm'));
    root.add(pm);

    const asset = await bakeTree(root, { uber });
    expect(chunkKeys(asset)).toEqual(['static']);
  });

  it('Sensor: housing merges, the Ray marker mesh is kept at mesh level', async () => {
    const root = group('Asset');
    const sensor = withComponent(group('Sensor'), 'Sensor');
    const housing = uberMesh(uber, 'Light');
    const ray = uberMesh(uber, 'Ray', [0, 0, 1]);
    const viz = uberMesh(uber, 'Sensor_sensorViz', [0, 0, 2]);
    sensor.add(housing, ray, viz);
    root.add(sensor);

    const asset = await bakeTree(root, { uber });
    expect(chunkKeys(asset)).toEqual(['static']);
    expect(asset.keep.map((k) => k.path).sort()).toEqual(['Sensor/Ray', 'Sensor/Sensor_sensorViz']);
  });

  it('a textured belt mesh under a TransportSurface is kept at mesh level (per-instance map scroll)', async () => {
    const root = group('Asset');
    const ts = withComponent(group('Transport-Z'), 'TransportSurface');
    withComponent(ts, 'Drive');
    const belt = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial({ map: makeTexture() }));
    belt.name = 'Belt';
    ts.add(belt, uberMesh(uber, 'Roll', [1, 0, 0]));
    root.add(ts);

    const asset = await bakeTree(root, { uber });
    expect(chunkKeys(asset)).toEqual(['mover:Transport-Z']);
    expect(asset.keep.map((k) => k.path)).toEqual(['Transport-Z/Belt']);
  });
});

/**
 * Every component of the Phase-1 table has an explicit role in the NEW bake.
 * `MOVER_KEY` ∪ `EXCLUDED_SUBTREE_KEYS` of the old pipelines is covered element
 * by element (plan-753 F6 / review A2).
 */
const ROLE_TABLE: Record<string, BakeRole> = {
  Drive: 'chunk',
  Kinematic: 'chunk',
  TransportSurface: 'chunk',   // plan F6 (Phase 1 had 'keep' for arena parity)
  Grip: 'chunk',
  GripTarget: 'chunk',
  Cam: 'chunk',                // plan F6 (Phase 1 had 'keep')
  ChainElement: 'chunk',
  SceneButtonMoveable: 'chunk',
  WebVisibility: 'chunk',
  Path: 'chunk',
  PlacementMeta: 'chunk',      // registered as chunk for freezeStaticMatrices; a MARKER for bake()
  Lamp: 'keep',
  Sensor: 'merge',             // housing merges; `_sensorViz` / Ray are mesh-level keep
  Pipe: 'keep',
  Tank: 'keep',
  EnergyChain: 'keep',
  Chain: 'keep',
  MachiningVolume: 'keep',
  RibbonPath: 'keep',
  RibbonWinder: 'keep',
  RibbonRoller: 'keep',
  RibbonDancer: 'keep',
  MU: 'keep',
  Source: 'keep',
  Sink: 'merge',               // plan F6 (Phase 1 had 'keep')
};

describe('bake roles — every Phase-1 component has an explicit role', () => {
  for (const [type, role] of Object.entries(ROLE_TABLE)) {
    it(`${type} → ${role}`, () => {
      expect(getCapabilities(type).bake).toBe(role);
    });
  }

  it('the role decides where a component node\'s mesh lands in bake()', async () => {
    for (const [type, role] of Object.entries(ROLE_TABLE)) {
      if (type === 'PlacementMeta') continue; // marker — merges (tested above)
      const root = group('Asset');
      const node = withComponent(group(type), type);
      node.add(uberMesh(uber, 'part'));
      root.add(node);
      const asset = await bakeTree(root, { uber });
      if (role === 'chunk') {
        expect(chunkKeys(asset), type).toEqual(['mover:' + type]);
      } else if (role === 'keep') {
        expect(chunkKeys(asset), type).toEqual([]);
        expect(asset.keep.map((k) => k.path), type).toEqual([type + '/part']);
      } else {
        expect(chunkKeys(asset), type).toEqual(['static']);
      }
    }
  });
});

describe('the plan roles are the only source (Phase 4b: no LEGACY_KEEP_OVERRIDE)', () => {
  it('TransportSurface and Cam are movers, Sink merges — for the freeze pass too', () => {
    for (const [type, mover] of [['TransportSurface', true], ['Cam', true], ['Sink', false]] as const) {
      const root = group('Model');
      const node = withComponent(group(type), type);
      const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
      node.add(mesh);
      root.add(node);
      root.updateMatrixWorld(true);
      expect(getCapabilities(type).bake, type).toBe(mover ? 'chunk' : 'merge');
      expect(isMoverNode(node), type).toBe(mover);
    }
  });
});
