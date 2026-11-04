// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { TweenRegistry } from '../../src/core/material-flow/tween-registry';

it('preserves staggered axis windows, easing and write policy across a JSON round trip', () => {
  const a = new TweenRegistry();
  let x = 0, y = 0;
  const node = {};
  const targetA = { node, setPosition(v: number) { x = v; } };
  const targetB = { node, setPosition(v: number) { y = v; } };
  a.addDrive(targetA, 0, 90, 0, 4, { ease: 'scurve', writePolicy: 'finalOnly' });
  a.addDrive(targetA, 90, 180, 5, 4, { ease: 'scurve', writePolicy: 'finalOnly' });
  a.onRender(2, 'animated');
  const saved = JSON.parse(JSON.stringify(a.toSnapshot(() => '#axis', () => 7)));
  const b = new TweenRegistry();
  b.fromSnapshot(saved, () => null, () => null, () => targetB);
  expect(b.toSnapshot(() => '#axis', () => 7)).toEqual(saved);
  for (const t of [2, 3, 4, 5, 6, 7, 9]) {
    a.onRender(t, 'animated'); b.onRender(t, 'animated'); expect(y).toBe(x);
  }
});
