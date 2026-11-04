// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared builders for the plan-766 Phase 2 editor-arena tests (§9.4–9.10).
 *
 * Deliberately three-only (no bake pipeline import) so the node tests can use
 * it too. The canonical fixture tree (§9.5):
 *   - 6 untextured parts (uber bucket), two of them sharing one geometry,
 *     different colours / roughness / metalness
 *   - 16 parts of textured material A, 16 of textured material B (two arenas)
 *   - 3 parts of textured material C (below the threshold → standalone)
 *   - 1 transparent part, 1 part under a `keep` component node (standalone)
 *   - 1 mirrored uber part (scale.x = -1) sharing the shared geometry
 */

import {
  BoxGeometry,
  DataTexture,
  Group,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  Scene,
  type BufferGeometry,
  type Material,
  type Object3D,
} from 'three';
import type { BakeRole } from '../../src/core/engine/rv-bake-chunk';

/** rv extras key the tests treat as a `keep` component. */
export const KEEP_KEY = 'ArenaKeepTest';

/** Role lookup for tests that do not register a capability. */
export function testRoleOf(node: Object3D): BakeRole | undefined {
  const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
  return rv && rv[KEEP_KEY] ? 'keep' : undefined;
}

export function makeTexture(): DataTexture {
  const tex = new DataTexture(new Uint8Array([255, 255, 255, 255]), 1, 1, RGBAFormat);
  tex.needsUpdate = true;
  return tex;
}

export function uberMat(color = 0x3366aa, roughness = 0.5, metalness = 0): MeshStandardMaterial {
  return new MeshStandardMaterial({ color, roughness, metalness });
}

export function texturedMat(name: string): MeshStandardMaterial {
  const m = new MeshStandardMaterial({ map: makeTexture() });
  m.name = name;
  return m;
}

export function part(
  name: string, material: Material | Material[], pos: [number, number, number] = [0, 0, 0],
  geometry: BufferGeometry = new BoxGeometry(1, 1, 1),
): Mesh {
  const m = new Mesh(geometry, material);
  m.name = name;
  m.position.set(...pos);
  return m;
}

export interface ArenaFixture {
  scene: Scene;
  root: Group;
  uber: Mesh[];
  sharedGeometry: BufferGeometry;
  mirrored: Mesh;
  texA: Mesh[];
  texB: Mesh[];
  texC: Mesh[];
  transparent: Mesh;
  keepNode: Group;
  keepMesh: Mesh;
  matA: MeshStandardMaterial;
  matB: MeshStandardMaterial;
  matC: MeshStandardMaterial;
  all: Mesh[];
}

/** The §9.5 fixture under `scene/Asset`, world matrices updated. */
export function buildArenaFixture(): ArenaFixture {
  const scene = new Scene();
  const root = new Group();
  root.name = 'Asset';
  scene.add(root);

  const sharedGeometry = new BoxGeometry(1, 2, 1);
  const uber: Mesh[] = [];
  const colors = [0xff0000, 0x00ff00, 0x0000ff, 0xffff00, 0x00ffff, 0xff00ff];
  for (let i = 0; i < 6; i++) {
    const geo = i < 2 ? sharedGeometry : new BoxGeometry(1, 1, 1);
    uber.push(part(`U${i}`, uberMat(colors[i], 0.2 + 0.1 * i, i % 2 ? 1 : 0), [i * 2, 0, 0], geo));
  }
  const mirrored = part('Mirror', uberMat(0x808080, 0.9, 0), [0, 0, 6], sharedGeometry);
  mirrored.scale.set(-1, 1, 1);
  uber.push(mirrored);

  const matA = texturedMat('A');
  const matB = texturedMat('B');
  const matC = texturedMat('C');
  const texA: Mesh[] = [];
  const texB: Mesh[] = [];
  const texC: Mesh[] = [];
  const geoA = new BoxGeometry(0.5, 0.5, 0.5);
  for (let i = 0; i < 16; i++) texA.push(part(`A${i}`, matA, [i, 2, 0], geoA));
  for (let i = 0; i < 16; i++) texB.push(part(`B${i}`, matB, [i, 4, 0]));
  for (let i = 0; i < 3; i++) texC.push(part(`C${i}`, matC, [i, 6, 0]));

  const glass = uberMat(0xffffff);
  glass.transparent = true;
  glass.opacity = 0.5;
  const transparent = part('Glass', glass, [0, 8, 0]);

  const keepNode = new Group();
  keepNode.name = 'Lamp';
  keepNode.userData.realvirtual = { [KEEP_KEY]: { enabled: true } };
  const keepMesh = part('LampMesh', uberMat(0xffffff), [0, 10, 0]);
  keepNode.add(keepMesh);

  root.add(...uber, ...texA, ...texB, ...texC, transparent, keepNode);
  root.updateMatrixWorld(true);
  return {
    scene, root, uber, sharedGeometry, mirrored, texA, texB, texC, transparent, keepNode, keepMesh,
    matA, matB, matC, all: [...uber, ...texA, ...texB, ...texC, transparent, keepMesh],
  };
}

/** Every `_rvEditorArena` BatchedMesh in a scene. */
export function arenaMeshesIn(scene: Object3D): Object3D[] {
  const out: Object3D[] = [];
  scene.traverse((o) => { if (o.userData?._rvEditorArena) out.push(o); });
  return out;
}

/**
 * Minimal viewer stand-in for the op tests (pattern: rv-editor-pick-maintenance):
 * real scene + NodeRegistry injected by the caller, an `editorArena` slot.
 */
export function makeArenaViewerStub(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    signalStore: null,
    transportManager: null,
    instancePickIndex: null,
    editorArena: null,
    buildMeshBvhsAsync() {},
    markRenderDirty() {},
    markShadowsDirty() {},
    emit() {},
    on() { return () => {}; },
    selectionManager: { select() {} },
    ...extra,
  };
}
