// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-781 §9.6 / 9.8b — motion awareness (F5, F10, F16).
 *
 *  - nothing moves → no pair is tested at all (after the first evaluation);
 *  - one body moves → only ITS pairs are tested;
 *  - a latched pair is never narrowphased again (F10);
 *  - FRESH poses: a drive that moved in this tick is seen in the same tick even
 *    though the render has not refreshed `matrixWorld` yet — and the check
 *    writes no `matrixWorld` (the render must still see the move as pending);
 *  - dragging the placement root moves every part;
 *  - the result does not depend on the registration (pair) order.
 */
import { beforeEach, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import { __resetCollisionAlertStore } from '../src/core/hmi/collision-alert-store';
import { bakeCollisionScene, bodyNode, plainGroup } from './collision-fixture';

const DT = 1 / 60;

async function scene(order: 'forward' | 'reverse' = 'forward') {
  const s = await bakeCollisionScene(plainGroup('Asset',
    bodyNode('Frame', { role: 'Machine', size: [1, 1, 1] }),
    bodyNode('Guard', { role: 'Environment', at: [4, 0, 0], size: [0.5, 2, 2] }),
    bodyNode('Axis', { role: 'Robot', mover: true, at: [2, 0, 0], size: [0.6, 0.6, 0.6] }),
    bodyNode('Tool', { role: 'Tool', mover: true, at: [2, 3, 0], size: [0.3, 0.3, 0.3] }),
  ));
  const names = ['Frame', 'Guard', 'Axis', 'Tool'];
  const roles = { Frame: 'Machine', Guard: 'Environment', Axis: 'Robot', Tool: 'Tool' } as const;
  for (const n of order === 'forward' ? names : [...names].reverse()) {
    s.manager.register(s.node(n), roles[n as keyof typeof roles]);
  }
  return s;
}

function reported(s: { manager: import('../src/core/engine/rv-collision-manager').RVCollisionManager }): string[] {
  return s.manager.activePairs.map((p) => [p.aPath, p.bPath].sort().join('|')).sort();
}

beforeEach(() => __resetCollisionAlertStore());

describe('motion awareness', () => {
  it('with no movement, no pair is tested over 100 ticks', async () => {
    const s = await scene();
    s.manager.update(DT);                          // first evaluation of every pair
    s.manager.resetCounters();
    for (let i = 0; i < 100; i++) s.manager.update(DT);
    expect(s.manager.counters.pairsEvaluated).toBe(0);
    expect(s.manager.counters.partPairs).toBe(0);
    expect(s.manager.counters.trianglesTested).toBe(0);
  });

  it('a moving part → only its pairs are tested', async () => {
    const s = await scene();
    s.manager.update(DT);
    s.manager.resetCounters();
    const axis = s.node('Axis');
    for (let i = 0; i < 10; i++) {
      axis.position.y += 0.01;
      s.manager.update(DT);
    }
    // Axis pairs: Frame, Guard, Tool — 3 per tick; the other 3 pairs stay quiet.
    expect(s.manager.pairs).toHaveLength(6);
    expect(s.manager.counters.pairsEvaluated).toBe(30);
  });

  it('an already latched pair is never narrowphased again (F10)', async () => {
    const s = await scene();
    s.manager.update(DT);
    const axis = s.node('Axis');
    axis.position.set(0.6, 0.1, 0.05);             // into the frame
    s.manager.update(DT);
    expect(reported(s)).toEqual(['Axis|Frame']);
    s.manager.resetCounters();
    for (let i = 0; i < 20; i++) {
      axis.position.x = 0.6 + ((i + 1) % 2) * 0.01; // keeps moving inside the frame
      s.manager.update(DT);
    }
    // Only the two other Axis pairs (Guard, Tool) are tested — never Axis↔Frame.
    expect(s.manager.counters.pairsEvaluated).toBe(40);
  });

  it('sees a drive move in the SAME tick without a render, and writes no matrixWorld (F16)', async () => {
    const s = await scene();
    s.manager.update(DT);
    const axis = s.node('Axis');
    const chunk = axis.children.find((c) => (c as { isMesh?: boolean }).isMesh) as Object3D;
    const staleBefore = chunk.matrixWorld.elements[12];
    axis.position.set(0.6, 0.1, 0.05);             // NO updateMatrixWorld — like a drive substep
    s.manager.update(DT);
    expect(reported(s)).toEqual(['Axis|Frame']);
    // The check computed its own pose: the chunk's matrixWorld is untouched, so
    // the render's matrix update still sees the move as pending and draws it.
    expect(chunk.matrixWorld.elements[12]).toBe(staleBefore);
    s.scene.updateMatrixWorld();
    expect(chunk.matrixWorld.elements[12]).toBeCloseTo(0.6, 6);
  });

  it('dragging the placement root moves every part', async () => {
    const s = await scene();
    s.manager.update(DT);
    s.manager.resetCounters();
    s.template.position.z = 0.5;                   // the whole asset moves together
    s.manager.update(DT);
    expect(s.manager.counters.pairsEvaluated).toBe(6);
    expect(s.manager.bodies.every((b) => b.moved)).toBe(true);
    expect(reported(s)).toEqual([]);               // relative poses unchanged
  });

  it('is deterministic under a different registration (pair) order', async () => {
    const results: string[][] = [];
    for (const order of ['forward', 'reverse'] as const) {
      __resetCollisionAlertStore();
      const s = await scene(order);
      s.manager.update(DT);
      s.node('Axis').position.set(0.6, 0.1, 0.05);
      s.node('Tool').position.set(4.2, 0.5, 0.2);  // through the guard's face
      s.manager.update(DT);
      results.push(reported(s));
    }
    expect(results[0]).toEqual(['Axis|Frame', 'Guard|Tool']);
    expect(results[1]).toEqual(results[0]);
  });
});
