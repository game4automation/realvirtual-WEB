// SPDX-License-Identifier: AGPL-3.0-only
import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import { RVMovingUnit } from '../../src/core/engine/rv-mu';
import type { MU } from '../../src/core/material-flow/material-flow-self';
import { muBugOffset, presetMuBugSize, setMuForward } from '../../src/behaviors/_shared/mu-reference';
import { createDESMUForRestore, type DESMU } from '../../src/plugins/des/rv-des-mu';
import { applyMUSnapshot, serializeMU } from '../../src/plugins/des/rv-des-mu-snapshot';
import { lineFixture } from './runner-fixture';

const publicMU = (mu: DESMU) => mu as unknown as MU;
function nodeOf(mu: DESMU): Object3D {
  if (!(mu.visual instanceof RVMovingUnit)) throw new Error('Expected clone visual');
  return mu.visual.node;
}

describe('MU travel cache snapshot continuation', () => {
  for (const mode of ['A', 'B'] as const) {
    for (const materialization of ['restore', 'explicit', 'fastforward-exit'] as const) {
      it(`${mode}: keeps the cached heading independent of pose (${materialization})`, () => {
        const original = lineFixture();
        const register = (f: ReturnType<typeof lineFixture>) => {
          f.runner.registerMuVisualFactory('travel-test', () => {
            const node = new Object3D(); f.scene.add(node);
            return new RVMovingUnit(node, 'travel-test');
          });
        };
        register(original);
        const mu = original.runner.createMU('travel-test');
        setMuForward(publicMU(mu), 0, 1);
        presetMuBugSize(publicMU(mu), [0.8, 0.2, 1.2]);
        // A fork/slot can have changed the visual without changing travel state.
        nodeOf(mu).quaternion.set(0, 0, 1, 0);
        const saved = original.snapshot();
        nodeOf(mu).quaternion.set(0, 1, 0, 0);
        setMuForward(publicMU(mu), 0, 1);
        const uninterruptedDrop = nodeOf(mu).quaternion.toArray();
        expect(uninterruptedDrop).toEqual([0, 1, 0, 0]);
        const target = mode === 'A' ? original : lineFixture();
        if (mode === 'B') register(target);
        // Mode A must discard later cache values, not retain the live MU's state.
        setMuForward(publicMU(mu), 1, 0);
        mu._bugSize![2] = 99;
        if (materialization !== 'restore') target.runner.setSubMode('fastforward');
        target.restore(JSON.parse(JSON.stringify(saved)));
        const restored = target.manager.getMU(mu.id) as DESMU;
        expect(restored.forward).toEqual([0, 0, 1]);
        expect(muBugOffset(publicMU(restored))).toBe(0.6);
        if (materialization === 'explicit') {
          expect(restored.visual).toBeNull();
          expect(target.runner.materializeMu(publicMU(restored)).ok).toBe(true);
        } else if (materialization === 'fastforward-exit') {
          expect(restored.visual).toBeNull();
          target.runner.setSubMode('animated');
        }
        // Materialization must not replace the saved pose with the cached heading.
        expect(nodeOf(restored).quaternion.toArray()).toEqual([0, 0, 1, 0]);
        nodeOf(restored).quaternion.set(0, 1, 0, 0); // forklift turn before drop
        // This is the call made by TransitTimer.fromPose(commit) on conveyor accept.
        setMuForward(publicMU(restored), 0, 1);
        expect(nodeOf(restored).quaternion.toArray()).toEqual(uninterruptedDrop);
        setMuForward(publicMU(restored), 1, 0); // a different belt still turns it
        expect(nodeOf(restored).rotation.y).toBeCloseTo(Math.PI / 2);
      });
    }
  }

  it('keeps absent caches absent and detaches captured arrays', () => {
    const mu = createDESMUForRestore(0, 'test');
    const absent = serializeMU(mu);
    setMuForward(publicMU(mu), 0, 1);
    presetMuBugSize(publicMU(mu), [1, 2, 3]);
    const saved = serializeMU(mu);
    mu.forward![2] = -1;
    mu._bugSize![2] = 9;
    expect(saved.forward).toEqual([0, 0, 1]);
    expect(saved._bugSize).toEqual([1, 2, 3]);
    applyMUSnapshot(mu, absent, new Map());
    expect(mu.forward).toBeUndefined();
    expect(mu._bugSize).toBeUndefined();
  });
});
