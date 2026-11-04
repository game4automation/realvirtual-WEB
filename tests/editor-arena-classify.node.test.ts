// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-766 §9.4 — editor arena classification + planning (pure functions).
 */
import { describe, it, expect } from 'vitest';
import {
  BoxGeometry, Group, InstancedMesh, Mesh, MeshBasicMaterial, MeshStandardMaterial, ShaderMaterial,
} from 'three';
import {
  ARENA_INSTANCE_SLACK,
  UBER_ARENA_SIGNATURE,
  arenaCapacity,
  classifyMesh,
  classifyMeshDetailed,
  geometryKeyOf,
  planArenas,
} from '../src/core/editor/rv-editor-arena-classify';
import {
  EDITOR_UBER_LAYOUT,
  UBER_ARENA_LAYOUT,
  arenaLayoutSignature,
  editorTexturedLayoutOf,
} from '../src/core/engine/rv-mesh-merge-batch';
import { bakeRoleOf, registerComponentSchema } from '../src/core/engine/rv-component-registry';
import { buildArenaFixture, part, testRoleOf, texturedMat, uberMat, KEEP_KEY } from './helpers/editor-arena-fixture';

describe('classifyMesh — bucket rule', () => {
  it('untextured opaque standard material → uber', () => {
    expect(classifyMesh(part('a', uberMat()), testRoleOf)).toBe('uber');
  });

  it('textured material → material bucket', () => {
    expect(classifyMesh(part('a', texturedMat('T')), testRoleOf)).toBe('material');
  });

  it('non-standard but batchable material (Basic) → material bucket', () => {
    expect(classifyMesh(part('a', new MeshBasicMaterial()), testRoleOf)).toBe('material');
  });

  it('transparent / opacity < 1 / alphaTest > 0 → standalone', () => {
    const t = uberMat(); t.transparent = true;
    const o = uberMat(); o.opacity = 0.99;
    const a = uberMat(); a.alphaTest = 0.5;
    for (const m of [t, o, a]) {
      expect(classifyMeshDetailed(part('x', m), testRoleOf)).toEqual({ kind: 'standalone', reason: 'transparent' });
    }
  });

  it('material array (multi-material) and missing material → standalone', () => {
    expect(classifyMeshDetailed(part('x', [uberMat(), uberMat()]), testRoleOf).reason).toBe('multi-material');
    const none = part('y', uberMat());
    (none as unknown as { material: null }).material = null;
    expect(classifyMeshDetailed(none, testRoleOf).reason).toBe('no-material');
  });

  it('keep role on the node or ANY ancestor → standalone', () => {
    const lamp = new Group();
    lamp.userData.realvirtual = { [KEEP_KEY]: {} };
    const inner = new Group();
    const mesh = part('m', uberMat());
    lamp.add(inner); inner.add(mesh);
    expect(classifyMeshDetailed(mesh, testRoleOf)).toEqual({ kind: 'standalone', reason: 'keep' });
  });

  it('production roleOf: a registered bake:keep capability makes the mesh standalone', () => {
    registerComponentSchema('ArenaClassifyKeep', {}, { bake: 'keep' });
    const node = new Group();
    node.userData.realvirtual = { ArenaClassifyKeep: { enabled: true } };
    const mesh = part('m', uberMat());
    node.add(mesh);
    expect(classifyMesh(mesh, (n) => bakeRoleOf(n))).toBe('standalone');
  });

  it('skinned-like / morph / instanced / drawRange / groups / custom shader → standalone', () => {
    const morph = part('m', uberMat());
    morph.morphTargetInfluences = [0.5];
    expect(classifyMeshDetailed(morph, testRoleOf).reason).toBe('morph');

    const inst = new InstancedMesh(new BoxGeometry(), uberMat(), 2);
    expect(classifyMeshDetailed(inst, testRoleOf).reason).toBe('instanced');

    const dr = part('d', uberMat());
    dr.geometry.setDrawRange(0, 6);
    expect(classifyMeshDetailed(dr, testRoleOf).reason).toBe('draw-range');

    // Geometry groups with ONE material are ignored by three (and the arena):
    // BoxGeometry carries six — it stays batchable. With a material array → standalone.
    expect(part('g', uberMat()).geometry.groups.length).toBe(6);
    expect(classifyMesh(part('g', uberMat()), testRoleOf)).toBe('uber');
    expect(classifyMeshDetailed(part('g2', [uberMat(), uberMat()]), testRoleOf).reason).toBe('multi-material');

    expect(classifyMeshDetailed(part('s', new ShaderMaterial()), testRoleOf).reason).toBe('custom-shader');
    const patched = uberMat();
    patched.onBeforeCompile = () => {};
    expect(classifyMeshDetailed(part('p', patched), testRoleOf).reason).toBe('custom-shader');
  });
});

describe('layouts', () => {
  it('UBER_ARENA_LAYOUT (bake pin) is unchanged; editor uber layout is position+normal', () => {
    expect(UBER_ARENA_LAYOUT.map((s) => s.name)).toEqual(['position', 'normal', 'color', 'rmPacked']);
    expect(EDITOR_UBER_LAYOUT.map((s) => `${s.name}:${s.itemSize}`)).toEqual(['position:3', 'normal:3']);
    expect(UBER_ARENA_SIGNATURE).toBe('position:3|normal:3');
  });

  it('textured layout keeps position+normal+uv*, strips the rest, adds color/tangent only when read', () => {
    const g = new BoxGeometry();
    g.setAttribute('uv1', g.getAttribute('uv').clone());
    g.setAttribute('color', g.getAttribute('position').clone());
    expect(arenaLayoutSignature(editorTexturedLayoutOf(g, texturedMat('x'))))
      .toBe('position:3|normal:3|uv:2|uv1:2');
    const vc = new MeshStandardMaterial({ vertexColors: true });
    expect(arenaLayoutSignature(editorTexturedLayoutOf(g, vc)))
      .toBe('position:3|normal:3|uv:2|uv1:2|color:3');
  });
});

describe('planArenas', () => {
  it('fixture: 3 arenas (uber, A, B); C below threshold, transparent and keep standalone', () => {
    const f = buildArenaFixture();
    const plan = planArenas(f.all, { roleOf: testRoleOf });
    expect(plan.arenas.map((a) => a.kind)).toEqual(['uber', 'material', 'material']);
    expect(plan.arenas[1].material).toBe(f.matA);
    expect(plan.arenas[2].material).toBe(f.matB);
    expect(new Set(plan.standalone)).toEqual(new Set([...f.texC, f.transparent, f.keepMesh]));
    expect(plan.standaloneReasons.get(f.texC[0])).toBe('below-threshold');
    expect(plan.standaloneReasons.get(f.transparent)).toBe('transparent');
    expect(plan.standaloneReasons.get(f.keepMesh)).toBe('keep');
  });

  it('geometry dedup by (geometry, mirrored): shared geometry once, mirrored copy separate', () => {
    const f = buildArenaFixture();
    const plan = planArenas(f.all, { roleOf: testRoleOf });
    const uber = plan.arenas[0];
    expect(uber.meshes.length).toBe(7);
    // shared (U0,U1) + shared mirrored (Mirror) + U2..U5
    expect(uber.geometryKeys).toBe(6);
    // texA all share one geometry
    expect(plan.arenas[1].geometryKeys).toBe(1);
    expect(plan.arenas[2].geometryKeys).toBe(16);
    expect(geometryKeyOf(f.sharedGeometry, true)).not.toBe(geometryKeyOf(f.sharedGeometry, false));
  });

  it('capacity: instances n·1.25 + 64, vertices V·1.25, indices I·1.25 over distinct geometries', () => {
    const f = buildArenaFixture();
    const plan = planArenas(f.all, { roleOf: testRoleOf });
    const a = plan.arenas[1]; // 16 instances of one 24-vertex / 36-index box
    expect(a.vertices).toBe(24);
    expect(a.indices).toBe(36);
    expect(a.capacity).toEqual({ instances: 20 + ARENA_INSTANCE_SLACK, vertices: 30, indices: 45 });
    expect(arenaCapacity(100, 1000, 3000)).toEqual({ instances: 125 + 64, vertices: 1250, indices: 3750 });
  });

  it('threshold is tunable; uber bucket never needs the threshold', () => {
    const f = buildArenaFixture();
    const lowered = planArenas(f.all, { roleOf: testRoleOf, materialThreshold: 3 });
    expect(lowered.arenas.length).toBe(4);
    const single = planArenas([part('only', uberMat())]);
    expect(single.arenas.length).toBe(1);
    expect(single.arenas[0].kind).toBe('uber');
  });

  it('textured meshes with different attribute layouts land in separate arenas', () => {
    const mat = texturedMat('L');
    const plain: Mesh[] = [];
    const withUv1: Mesh[] = [];
    for (let i = 0; i < 16; i++) plain.push(part(`p${i}`, mat));
    for (let i = 0; i < 16; i++) {
      const g = new BoxGeometry();
      g.setAttribute('uv1', g.getAttribute('uv').clone());
      withUv1.push(part(`q${i}`, mat, [0, 0, 0], g));
    }
    const plan = planArenas([...plain, ...withUv1]);
    expect(plan.arenas.length).toBe(2);
    expect(plan.arenas.map((a) => a.signature).sort())
      .toEqual(['position:3|normal:3|uv:2', 'position:3|normal:3|uv:2|uv1:2']);
  });
});
