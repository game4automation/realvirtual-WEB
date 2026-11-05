// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { BoxGeometry, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';
import type { SyncTrackerConfig } from '../../src/plugins/usd-live-link/sync-tracker';

export function byteStageRig() {
  const scene = new Scene(), root = new Object3D(); root.name = 'Cell'; scene.add(root); scene.position.x = 2;
  const geometry = new BoxGeometry(), material = new MeshStandardMaterial({ color: 0x336699 });
  for (const name of ['Axis', 'Axis', 'Geometry', 'Äxis']) { const child = new Mesh(geometry, material); child.name = name; root.add(child); }
  root.children[1].position.x = 3;
  return { root, templates: [root.children[2]], exclude: new Set<Object3D>(), preplaced: [{ muId: 8, node: root.children[1] }] };
}
export function trackerBytes(Tracker: new (config: SyncTrackerConfig) => { sample(session: number): number; requestFull(): void }) {
  const scene = new Scene(), root = new Object3D(), axis = new Object3D(), pre = new Object3D(), spawned = new Object3D();
  scene.add(root, spawned); root.add(axis, pre);
  const mu = (id: number, node: Object3D) => ({ id, node, isInstanced: false, getPosition: () => node.position, getQuaternion: () => node.quaternion });
  const mus = [mu(7, spawned), mu(8, pre)], bytes: string[] = [];
  const tracker = new Tracker({ nodes: [root, axis, pre], trackedIndices: [1], mus: () => mus, preplaced: new Map([[8, 2]]), templateIndexOf: () => 0, send: (b) => bytes.push(Buffer.from(b).toString('hex')) });
  tracker.sample(12); tracker.sample(12);
  axis.position.x = 1.23456; spawned.position.set(0.4, 0.5, 0.6); pre.position.y = 1;
  tracker.sample(12); root.attach(spawned); root.position.x = 5; tracker.sample(12);
  mus.shift(); tracker.sample(12);
  tracker.requestFull(); tracker.sample(13);
  return bytes;
}
