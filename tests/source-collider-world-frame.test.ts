// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, it, expect, vi } from 'vitest';
import { BoxGeometry, Matrix4, Mesh, MeshBasicMaterial, Object3D, Quaternion, Vector3 } from 'three';
import { RVSource } from '../src/core/engine/rv-source';
import { readMUColliderTemplate } from '../src/core/engine/rv-mu-collider-template';

const box = { center: { x: .3, y: .2, z: -.1 }, size: { x: 2, y: 4, z: 6 } };
function fixture(scale: number, angle = 0) {
  const world = new Object3D(), ancestor = new Object3D(), template = new Object3D();
  ancestor.scale.set(scale, 1, 1); world.add(ancestor); ancestor.add(template);
  template.name = 'Part'; template.userData.realvirtual = { MU: {}, Rigidbody: { isKinematic: true } };
  const collider = new Mesh(new BoxGeometry(2, 4, 6), new MeshBasicMaterial());
  collider.position.set(.1, -.2, .4); collider.userData.realvirtual = { BoxCollider: box };
  template.add(collider);
  const node = new Object3D(); node.rotation.z = angle; world.add(node);
  const source = new RVSource(node); source.spawnParent = world; source.setTemplate(template);
  return { world, ancestor, template, source };
}
// Independent corner oracle: world corners expressed in the actual clone's rigid pose.
function oracle(clone: Object3D) {
  clone.updateWorldMatrix(true, true);
  const frame = new Matrix4().compose(clone.getWorldPosition(new Vector3()),
    clone.getWorldQuaternion(new Quaternion()), new Vector3(1, 1, 1)).invert();
  const child = clone.children[0];
  const points: Vector3[] = [];
  for (const x of [-1, 1]) for (const y of [-1, 1]) for (const z of [-1, 1]) {
    points.push(new Vector3(box.center.x + x, box.center.y + y * 2, box.center.z + z * 3)
      .applyMatrix4(child.matrixWorld).applyMatrix4(frame));
  }
  const min = new Vector3(Infinity, Infinity, Infinity), max = min.clone().negate();
  for (const point of points) { min.min(point); max.max(point); }
  return { halfExtents: max.clone().sub(min).multiplyScalar(.5), localOffset: max.clone().add(min).multiplyScalar(.5) };
}
function check(clone: Object3D) {
  const expected = oracle(clone), shape = clone.userData.physicsBody.shapes[0];
  for (const field of ['halfExtents', 'localOffset'] as const) for (const axis of ['x', 'y', 'z'] as const) {
    expect(shape[field][axis]).toBeCloseTo(expected[field][axis], 6);
  }
  expect(clone.userData.realvirtual).toBeUndefined();
}
function promoted(source: RVSource, angle: number) {
  const inst = { sourceName: 'test', id: 100, physicsMassKg: 1,
    getWorldPosition: (v: Vector3) => v.set(0, 0, 0),
    getQuaternion: () => new Quaternion().setFromAxisAngle(new Vector3(0, 0, 1), angle),
  } as unknown as Parameters<RVSource['buildPromotedClone']>[0];
  return source.buildPromotedClone(inst)!;
}
describe('MU collider rigid world frame', () => {
  for (const uniform of [false, true]) it(`scaled ancestor uses world metres (uniform=${uniform})`, () => {
    const { ancestor, template } = fixture(2);
    if (uniform) ancestor.scale.setScalar(2);
    const shape = readMUColliderTemplate(template)!.shapes[0];
    expect(shape.halfExtents.x).toBeCloseTo(2);
    expect(shape.halfExtents.y).toBeCloseTo(uniform ? 4 : 2);
    expect(shape.localOffset.x).toBeCloseTo(.8);
  });
  for (const scale of [1, 2]) for (const dest of [1, 2]) for (const angle of [0, Math.PI / 2]) {
    for (const mode of ['spawn', 'promoted']) it(`${mode}: template=${scale}, destination=${dest}, angle=${angle}`, () => {
      const { source, world } = fixture(scale, angle);
      const destination = new Object3D(); destination.scale.set(dest, 1, 1); world.add(destination);
      source.destination = destination;
      if (mode === 'promoted') source.spawnParent = destination;
      check((mode === 'spawn' ? source.spawnMU()! : promoted(source, angle)).node);
    });
  }
  it('destination changes recompute an already spawned source', () => {
    const { source, world } = fixture(2, Math.PI / 2);
    check(source.spawnMU()!.node);
    const dest = new Object3D(); dest.scale.set(2, 1, 1); world.add(dest); source.destination = dest;
    check(source.spawnMU()!.node);
  });
  it('shear still throws but both source builders spawn without a template and warn', () => {
    const { source, template, ancestor, world } = fixture(2, Math.PI / 4);
    template.rotation.z = Math.PI / 4;
    expect(() => readMUColliderTemplate(template)).toThrow('must align with its Rigidbody axes');
    template.rotation.z = 0; ancestor.scale.setScalar(1);
    const dest = new Object3D(); dest.scale.set(2, 1, 1); world.add(dest);
    source.destination = dest; source.spawnParent = dest;
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      for (const mu of [source.spawnMU()!, promoted(source, Math.PI / 4)]) {
        expect(mu).toBeTruthy(); expect(mu.node.userData.physicsBody).toBeUndefined();
      }
      expect(warn).toHaveBeenCalledTimes(2);
    } finally { warn.mockRestore(); }
  });
});
