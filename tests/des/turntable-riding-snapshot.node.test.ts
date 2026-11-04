// SPDX-License-Identifier: AGPL-3.0-only
// plan-2059 O2 (review): a headless restored rider has no visual yet; its pending parent must survive a second capture.
import { expect, it } from 'vitest';
import { Object3D } from 'three';
import { captureRidingMUs, restoreRidingMUs } from '../../src/behaviors/_shared/turntable-snapshot';
import type { TurntableLocal } from '../../src/behaviors/Turntable';

const local = (rotaryNode: Object3D) => ({ rotaryNode } as unknown as TurntableLocal);

it('captures a rider that is parented, and one that only waits for its visual', () => {
  const rotary = new Object3D(); const scene = new Object3D(); scene.add(rotary);
  const parented = { id: 1, generation: 0, visual: { node: new Object3D() } };
  rotary.add(parented.visual.node);
  const pending = { id: 2, generation: 3, visual: undefined as unknown, restoredVisualParent: rotary };
  const free = { id: 3, generation: 0, visual: { node: new Object3D() } };
  scene.add(free.visual.node);
  expect(captureRidingMUs(local(rotary), [parented, pending, free])).toEqual([{ id: 1, gen: 0 }, { id: 2, gen: 3 }]);
});

it('restore: headless MU keeps the pending parent only while it rides; a free one drops it', () => {
  const rotary = new Object3D(); const scene = new Object3D(); scene.add(rotary);
  const a = { id: 1, generation: 0 } as { id: number; generation: number; restoredVisualParent?: Object3D };
  const b = { id: 2, generation: 0, restoredVisualParent: rotary } as typeof a;
  restoreRidingMUs(local(rotary), [a, b], scene, { ridingMUs: [{ id: 1, gen: 0 }] });
  expect(a.restoredVisualParent).toBe(rotary);
  expect(b.restoredVisualParent).toBeUndefined();
});
