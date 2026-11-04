// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-757 Phase 1a — `prepareAndBake`, THE recipe (D1 / F1), as a pure
 * function of the bytes and the capability table:
 *
 *  - the same bytes yield the same template twice (names, chunk keys, aliases);
 *  - the material step is idempotent — measured on a TEXTURED fixture, the only
 *    kind on which `dedup → uber` changes anything (Phase 0, D6);
 *  - plugin claims reach the template only when the caller passes them (D5);
 *  - a stale epoch rejects with `BakeAbortedError` — an abort, not an error;
 *  - the Phase-0 fixture-(b) defect: a drive the `Kinematic` hook re-parented
 *    is re-stamped with its local TRS under the FINAL parent, so `initDrive()`
 *    puts it where the file authored it in the world.
 */
import { describe, it, expect } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Vector3, type Material } from 'three';
import '../src/core/engine/rv-scene-loader';
import { gltfLoader } from '../src/core/engine/rv-glb-parse';
import { objectToGlb, sceneMirroringLoad } from '../src/core/import/rv-import-object';
import { prepareAndBake, prepareMaterials, preparedMaterialsOf } from '../src/core/engine/rv-prepare-and-bake';
import { BakeAbortedError } from '../src/core/engine/rv-bake-pipeline';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { RV_DRIVE_HOME_KEY, type DriveHomePose } from '../src/core/engine/rv-pre-bake-keys';
import { inlinePickPort, makeTexture } from './fixtures/bake-fixture';

const uber = new RVUberMaterial(false);

function box(name: string, pos: [number, number, number], material: Material, extras?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), material);
  m.name = name;
  m.position.set(...pos);
  if (extras) m.userData.realvirtual = extras;
  return m;
}

function node(name: string, pos: [number, number, number] = [0, 0, 0], extras?: Record<string, unknown>): Object3D {
  const n = new Object3D();
  n.name = name;
  n.position.set(...pos);
  if (extras) n.userData.realvirtual = extras;
  return n;
}

/** Two drives + a bare `Label` leaf + a plain frame: ≥ 3 chunks, one claimable node. */
function buildPlant(): Group {
  const root = new Group();
  root.name = 'Plant';
  root.add(box('Frame', [0, 0, 0], new MeshStandardMaterial({ color: 0x777777 })));
  for (const [name, x] of [['Drive-A', 2], ['Drive-B', -2]] as const) {
    const d = node(name, [x, 0, 0], { Drive: { Direction: 'LinearX', TargetSpeed: 100 } });
    d.add(box('arm', [0, 1, 0], new MeshStandardMaterial({ color: 0x3366cc })));
    root.add(d);
  }
  root.add(box('Label', [0, 2, 0], new MeshStandardMaterial({ color: 0xffffff })));
  return root;
}

/** The root becomes the file's SCENE (what the loader hands the recipe as `tmp`). */
async function glb(root: Group): Promise<ArrayBuffer> {
  return objectToGlb(sceneMirroringLoad(root));
}

async function parse(bytes: ArrayBuffer): Promise<Object3D> {
  return (await gltfLoader.parseAsync(bytes.slice(0), '')).scene;
}

function names(root: Object3D): string[] {
  const out: string[] = [];
  root.traverse((n) => out.push(n.name));
  return out.sort();
}

function ctxOf(assetId: string, extra: Record<string, unknown> = {}) {
  return {
    assetId, renamedNodes: new Map<Object3D, string>(), signatureState: 'none' as const,
    uber, isWebGPU: false, pickPort: inlinePickPort(), ...extra,
  };
}

describe('prepareAndBake — the recipe (plan-757 D1)', () => {
  it('the same bytes yield the same template twice', async () => {
    const bytes = await glb(buildPlant());
    const a = await prepareAndBake(await parse(bytes), ctxOf('twice'));
    const b = await prepareAndBake(await parse(bytes), ctxOf('twice'));
    expect(names(b.template)).toEqual(names(a.template));
    expect(b.chunks.map((c) => c.key).sort()).toEqual(a.chunks.map((c) => c.key).sort());
    expect(b.aliases.map((x) => x.path).sort()).toEqual(a.aliases.map((x) => x.path).sort());
    expect(a.signatureState).toBe('none');
    // The bare leaf is nobody's: not in the template of either bake (D2 —
    // what is in the template exists, and nothing else).
    expect(names(a.template)).not.toContain('Label');
    expect(names(a.template)).not.toContain('Frame');
    a.dispose(); b.dispose();
  });

  it('the material step is idempotent on a TEXTURED tree (D6)', async () => {
    // Two textured meshes on IDENTICAL-but-distinct material instances (what a
    // GLTFLoader parse hands back), plus an untextured one the uber pass absorbs.
    const build = (): Group => {
      const root = new Group();
      root.name = 'Tex';
      const tex = makeTexture();
      root.add(box('A', [0, 0, 0], new MeshStandardMaterial({ map: tex })));
      root.add(box('B', [2, 0, 0], new MeshStandardMaterial({ map: tex })));
      root.add(box('C', [4, 0, 0], new MeshStandardMaterial({ color: 0x336699 })));
      return root;
    };
    const once = build();
    const first = prepareMaterials(once, uber, false);
    const again = prepareMaterials(once, uber, false);
    expect(again).toBe(first);                       // the done-marker answers, nothing runs twice
    expect(first.dedup.originalCount).toBe(3);
    expect(first.dedup.uniqueMaterials.size).toBeLessThan(3); // the two textured instances collapsed (dedup) …
    expect(first.uber.bakedMeshCount).toBe(1);        // … and the untextured one went onto the uber material

    const bakedTwice = await prepareAndBake(once, ctxOf('tex-twice'));
    const bakedOnce = await prepareAndBake(build(), ctxOf('tex-once'));
    expect(bakedTwice.chunks.length).toBe(bakedOnce.chunks.length);
    // Exactly one textured bucket (dedup collapsed the two instances) + the uber chunk.
    expect(bakedOnce.chunks.filter((c) => c.key.startsWith('tex:')).length).toBe(1);
    expect(bakedOnce.chunks.length).toBe(2);
    // The template answers for its tree's material results.
    expect(preparedMaterialsOf(bakedTwice.template)).toBe(first);
    bakedTwice.dispose(); bakedOnce.dispose();
  });

  it('plugin claims reach the template only when passed (D5)', async () => {
    const bytes = await glb(buildPlant());
    const unclaimed = await prepareAndBake(await parse(bytes), ctxOf('claims-none'));
    expect(names(unclaimed.template)).not.toContain('Label');
    const claimed = await prepareAndBake(await parse(bytes), ctxOf('claims-yes', {
      // Paths as the pre-bake registry spells them — ROOT-INCLUSIVE on every
      // path: the recipe parks a parentless `tmp` under a holder for `prepare`.
      claims: { list: [{ path: 'Plant/Label', role: 'merge' }], complete: true },
    }));
    expect(names(claimed.template)).toContain('Label');
    unclaimed.dispose(); claimed.dispose();
  });

  it('an authored-hidden bare part survives the bake and stays hidden (rv.Hidden)', async () => {
    // The editor's eye toggle persists as `rv.Hidden`. A bare CAD part claims
    // nothing, so before the fix it was merged into the parent's chunk and drawn
    // again in every runtime load (the DELTA robot's work envelope in a test run).
    const build = (): Group => {
      const root = buildPlant();
      root.add(box('Envelope', [0, 3, 0], new MeshStandardMaterial({ color: 0xeeeeee }), { Hidden: true }));
      return root;
    };
    const baked = await prepareAndBake(await parse(await glb(build())), ctxOf('hidden'));
    let envelope: Object3D | undefined;
    baked.template.traverse((n) => { if (n.name === 'Envelope') envelope = n; });
    expect(envelope).toBeDefined();
    expect(envelope!.visible).toBe(false);
    // The visible bare leaf next to it is still merged away (D2 unchanged).
    expect(names(baked.template)).not.toContain('Label');
    baked.dispose();
  });

  it('a stale epoch rejects with BakeAbortedError', async () => {
    const root = await parse(await glb(buildPlant()));
    await expect(prepareAndBake(root, ctxOf('abort', { isEpochCurrent: () => false })))
      .rejects.toBeInstanceOf(BakeAbortedError);
  });

  it('a drive the Kinematic hook re-parented is re-stamped under its FINAL parent (fixture (b) defect)', async () => {
    // Fixture (b): Mount (Drive) at (0,0.2,0); Cad at (1,0,0) holding Kine
    // (Drive + KinematicParentEnable → Mount) at local (0,0.4,0) — world (1,0.4,0).
    const root = new Group();
    root.name = 'Chain';
    root.add(box('Base', [0, 0.1, 0], new MeshStandardMaterial({ color: 0x555555 })));
    const mount = node('Mount', [0, 0.2, 0], { Drive: { Direction: 'LinearZ', TargetSpeed: 100 } });
    mount.add(box('MountBody', [0, 0.15, 0], new MeshStandardMaterial({ color: 0x336699 })));
    root.add(mount);
    const cad = node('Cad', [1, 0, 0]);
    const kine = node('Kine', [0, 0.4, 0], {
      Kinematic: { KinematicParentEnable: true, Parent: 'Mount' },
      Drive: { Direction: 'LinearX', TargetSpeed: 100 },
    });
    kine.add(box('Tool', [0, 0.1, 0], new MeshStandardMaterial({ color: 0x99cc33 })));
    cad.add(kine);
    root.add(cad);

    const baked = await prepareAndBake(await parse(await glb(root)), ctxOf('restamp'));
    const kineT = baked.template.getObjectByName('Kine')!;
    expect(kineT.parent?.name).toBe('Mount');
    const home = kineT.userData[RV_DRIVE_HOME_KEY] as DriveHomePose;
    // Local TRS under Mount, world-preserving: (1, 0.4, 0) − (0, 0.2, 0).
    expect(home.p.map((v) => Math.round(v * 1e4) / 1e4)).toEqual([1, 0.2, 0]);
    expect(new Vector3(...home.p).distanceTo(kineT.position)).toBeLessThan(1e-6);
    // The authored path of the moved subtree travels on the asset (D4).
    expect(baked.aliases.map((a) => a.path)).toContain('Cad/Kine');
    expect(baked.aliases.find((a) => a.path === 'Cad/Kine')!.template).toBe(kineT);
    // … flagged as a SUBTREE alias: the place step registers it as a prefix alias too (plan-610 Phase 5c).
    expect(baked.aliases.find((a) => a.path === 'Cad/Kine')!.subtree).toBe(true);
    baked.dispose();
  });
});
