// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { assertContinuation, canonicalJson } from '../helpers/des-continuation-harness';
import { buildWorld } from './continuation-turntable-conveyor-world';

function rotationCut() {
  const w = buildWorld('Turntable', true);
  try {
    for (let t = 0.25; t <= 60; t += 0.25) {
      w.step(t);
      const s = w.runner.fullSnapshot();
      const part = s.parts.find(p => p.key === 'des.tweens');
      const windows = part?.state as unknown as { kind: string; t0: number; t1: number }[];
      if (windows?.some(v => v.kind === 'drive' && v.t0 < t && t < v.t1)) return t;
    }
    throw new Error('Turntable did not rotate by 60 s');
  } finally { w.dispose?.(); }
}

for (const mode of ['A', 'B', 'B-immediate'] as const) {
  it(`${mode}: real rotary drive continues from its original mid-rotation window`, async () => {
    const T = rotationCut();
    await assertContinuation({ buildWorld: () => buildWorld('Turntable', true), mode,
      T, TPrime: T + 2, T2: T + 10 });
  });
}

it('rejects an unknown tween drive before replacing the live world', () => {
  const T = rotationCut();
  const w = buildWorld('Turntable', true);
  try {
    w.step(T);
    const saved = w.runner.fullSnapshot();
    const bad = structuredClone(saved);
    const windows = bad.parts.find(p => p.key === 'des.tweens')!.state as unknown as { kind: string; driveRef: string }[];
    windows.find(t => t.kind === 'drive')!.driveRef = 'unknown-drive';
    expect(() => w.runner.restoreFull(bad)).toThrow('des-snapshot-contract');
    expect(canonicalJson(w.runner.fullSnapshot())).toBe(canonicalJson(saved));
  } finally { w.dispose?.(); }
});

function frozenWorld(at: number, until: number) {
  const w = buildWorld('Turntable', true);
  const subject = w.runner.liveInstances.find(i => i.def.type === 'Turntable')!.adapter;
  return { ...w, step(to: number) {
    const manager = w.runner.getManager();
    while (manager.currentTime < to) {
      const next = Math.min(manager.currentTime + 0.25, to);
      w.step(next);
      if (next === at) subject.setFailure(true);
      if (next === until) subject.setFailure(false);
    }
  } };
}

for (const mode of ['A', 'B', 'B-immediate'] as const) {
  it(`${mode}: a freeze after restore retains and resumes rotary drive handles`, async () => {
    const T = rotationCut();
    await assertContinuation({ buildWorld: () => frozenWorld(T + 0.25, T + 2.25), mode,
      T, TPrime: T + 4, T2: T + 10 });
    await assertContinuation({ buildWorld: () => frozenWorld(T, T + 2), mode,
      T: T + 1, TPrime: T + 4, T2: T + 10 });
  });
}
