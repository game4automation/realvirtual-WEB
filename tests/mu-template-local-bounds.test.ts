// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { Box3, BoxGeometry, Group, Mesh, MeshBasicMaterial, Vector3 } from 'three';
import { computeTemplateAABBInfo, RVMovingUnit } from '../src/core/engine/rv-mu';

it('keeps a rotated, offset CAD template collider aligned after reparenting at spawn', () => {
  const importRoot = new Group();
  importRoot.rotation.x = Math.PI / 2;
  const template = new Group();
  template.rotation.z = -Math.PI / 2;
  template.position.set(-0.28, -0.2, -0.86);
  importRoot.add(template);
  const mesh = new Mesh(new BoxGeometry(0.061, 0.101, 0.04), new MeshBasicMaterial());
  mesh.position.z = -0.02;
  template.add(mesh);
  importRoot.updateMatrixWorld(true);
  const info = computeTemplateAABBInfo(template);
  const clone = template.clone();
  template.getWorldPosition(clone.position);
  template.getWorldQuaternion(clone.quaternion);
  const mu = new RVMovingUnit(clone, 'box', info.halfSize, info.localCenter);
  clone.updateMatrixWorld(true);
  mu.updateAABB();
  const visual = new Box3().setFromObject(clone);
  expect(mu.aabb.min.distanceTo(visual.min)).toBeLessThan(1e-6);
  expect(mu.aabb.max.distanceTo(visual.max)).toBeLessThan(1e-6);
  expect(info.localCenter.distanceTo(new Vector3(0, 0, -0.02))).toBeLessThan(1e-6);
});
