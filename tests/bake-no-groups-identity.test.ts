// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-755 §9.4 / N1 — a model WITHOUT any partition label bakes exactly as it
 * did before the partition existed: same chunk count, same template node count,
 * same chunk-key structure, and no `grp:` segment anywhere.
 *
 * Chunk keys carry `tex:<material.uuid>`, which is random per run (T1) — the
 * fixture PINS the uuids so the expectation below is a literal, not a pattern.
 * The literals follow the four key forms that existed before plan-755
 * (`static`, `tex:<uuid>`, `mover:<path>`, `mover:<path>|tex:<uuid>`); if they
 * move, the partition leaked into an unlabelled model.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D } from 'three';
import '../src/core/engine/rv-scene-loader';   // side effect: capabilities, schemas, built-in hooks
import { runPreBakeHooks } from '../src/core/engine/rv-pre-bake';
import { registerBuiltInPreBakeHooks } from '../src/core/engine/rv-pre-bake-hooks';
import { RV_PARTITION_KEY, RV_SYNTHETIC_KEY } from '../src/core/engine/rv-bake-chunk';
import { BakeRegistry } from '../src/core/engine/rv-bake-registry';
import { RVUberMaterial } from '../src/core/engine/rv-uber-material';
import { bakeAndPlace, chunkKeys, uberMesh } from './fixtures/bake-fixture';

const UUID_A = '00000000-0000-4000-8000-00000000000a';
const UUID_B = '00000000-0000-4000-8000-00000000000b';

function pinned(uuid: string, color: number): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ color });
  // `uuid` is readonly in the typings and a plain own property at runtime.
  (m as { uuid: string }).uuid = uuid;
  return m;
}

function mesh(name: string, material: MeshStandardMaterial, pos: [number, number, number], extras?: Record<string, unknown>): Mesh {
  const m = new Mesh(new BoxGeometry(1, 1, 1), material);
  m.name = name;
  m.position.set(...pos);
  if (extras) m.userData.realvirtual = extras;
  return m;
}

function node(name: string, extras: Record<string, unknown> | undefined, ...children: Object3D[]): Group {
  const g = new Group();
  g.name = name;
  if (extras) g.userData.realvirtual = extras;
  for (const c of children) g.add(c);
  return g;
}

/**
 *   Plant
 *   ├─ Frame (uber)  ├─ Skin (A)  ├─ Cad ─ Bolt (B)
 *   ├─ Info {RuntimeMetadata} (A, mesh)
 *   ├─ Axis {Drive} ─ Arm (uber), Plate (A), Inner {Drive} ─ Slide (B)
 *   └─ Beacon {Lamp} (A, keep)
 */
function buildPlant(uber: RVUberMaterial): Group {
  const a = pinned(UUID_A, 0x884422);
  const b = pinned(UUID_B, 0x224488);
  const root = node('Plant', undefined,
    uberMesh(uber, 'Frame', [0, 0, 0]),
    mesh('Skin', a, [2, 0, 0]),
    node('Cad', undefined, mesh('Bolt', b, [4, 0, 0])),
    mesh('Info', a, [6, 0, 0], { RuntimeMetadata: { Content: 'hello' } }),
    node('Axis', { Drive: { Direction: 'LinearX' } },
      uberMesh(uber, 'Arm', [8, 0, 0]),
      mesh('Plate', a, [10, 0, 0]),
      node('Inner', { Drive: { Direction: 'LinearY' } }, mesh('Slide', b, [12, 0, 0])),
    ),
    mesh('Beacon', a, [14, 0, 0], { Lamp: { OnColor: { r: 1, g: 0, b: 0, a: 1 } } }),
  );
  const holder = new Object3D();
  holder.add(root);
  return root;
}

beforeEach(() => { registerBuiltInPreBakeHooks(); });

describe('no partition label → the bake is unchanged (plan-755 N1)', () => {
  it('chunk keys, chunk count and template node count are the pre-plan-755 literals', async () => {
    const uber = new RVUberMaterial();
    const root = buildPlant(uber);
    // The hooks run like in the loader — and find nothing to stamp.
    runPreBakeHooks(root);
    let stamped = 0;
    root.traverse((n) => { if (n.userData?.[RV_PARTITION_KEY]) stamped++; });
    expect(stamped).toBe(0);

    const { baked, template } = await bakeAndPlace(root, new BakeRegistry(), { uber });

    expect(chunkKeys(baked)).toEqual([
      'mover:Axis',
      `mover:Axis/Inner|tex:${UUID_B}`,
      `mover:Axis|tex:${UUID_A}`,
      'static',
      `tex:${UUID_A}`,
      `tex:${UUID_B}`,
    ].sort());
    expect(baked.chunks.length).toBe(6);
    for (const c of baked.chunks) {
      expect(c.key.includes('grp:'), c.key).toBe(false);
      expect(c.partition).toBe('');
      expect(c.partitionLabels).toEqual([]);
      expect(c.groupObject).toBeNull();
      // Unpartitioned: the chunk mesh is a DIRECT child of its boundary.
      expect(c.templateMesh!.parent).toBe(c.owner);
    }

    // Template: Plant, Info, Axis, Inner, Beacon (keep) + 6 chunk meshes — no
    // synthetic node, no CAD leaf.
    let nodes = 0;
    let synthetic = 0;
    template.traverse((n) => { nodes++; if (n.userData?.[RV_SYNTHETIC_KEY]) synthetic++; });
    expect(synthetic).toBe(0);
    expect(nodes).toBe(5 + 6);
    expect(baked.keep.map((k) => k.mesh.name)).toEqual(['Beacon']);
    expect(baked.logicNodes.map((l) => l.path).sort()).toEqual(['Axis', 'Axis/Inner', 'Beacon', 'Info']);
  });
});
