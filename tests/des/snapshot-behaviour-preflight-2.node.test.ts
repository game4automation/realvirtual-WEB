// SPDX-License-Identifier: AGPL-3.0-only
import { expect, it } from 'vitest';
import { freezeWorld } from './continuation-freeze-world';
import { buildWorld } from './continuation-turntable-conveyor-world';
import { rejectSnapshotWithoutMutation } from './snapshot-preflight-helpers';
import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';

type Frozen = {
  action: string; payload?: unknown; remaining: number; muRef: { id: number; gen: number } | null;
  tween?: { kind: string; from?: number[]; remaining: number; muRef: { id: number; gen: number } | null };
  tweens?: Frozen['tween'][];
};
const cases: Record<string, (d: Frozen) => void> = {
  'missing tween.from': d => { delete d.tween!.from; },
  'negative remaining': d => { d.remaining = -1; },
  'unknown tween.kind': d => { d.tween!.kind = 'unknown'; },
  'unknown muRef': d => { d.muRef!.id = 999999; },
  'unknown action': d => { d.action = 'MF.Unknown.Arrival'; },
  'negative tween remaining': d => { d.tween!.remaining = -1; },
  'payload.tweens not an array': d => { d.payload = { ...(d.payload as object), tweens: 42 }; },
  'payload.tween forged': d => { d.payload = { ...(d.payload as object), tween: { kind: 'position' } }; },
  'payload.tweens entry forged': d => { d.payload = { ...(d.payload as object), tweens: [{ kind: 'path', pathRef: 'missing' }] }; },
  'payload.tweens axes without phases': d => { d.payload = { ...(d.payload as object), tweens: [{ kind: 'axes' }] }; },
  'payload.tweens axes with malformed axis': d => { d.payload = { ...(d.payload as object), tweens: [{ kind: 'axes', phases: [{ at0: 0, at1: 1, axes: [{ driveRef: 1 }] }] }] }; },
  'payload.tweens drive without from/to': d => { d.payload = { ...(d.payload as object), tweens: [{ kind: 'drive' }] }; },
  'payload.tweens drive with runtime target': d => { d.payload = { ...(d.payload as object), tweens: [{ kind: 'drive', from: 0, to: 1, drive: {} }] }; },
  'payload.tween position with runtime target': d => { d.payload = { ...(d.payload as object), tween: { kind: 'position', from: [0, 0, 0], to: [1, 0, 0], target: {} } }; },
  'missing tweens[].from': d => { d.tweens = [d.tween]; delete d.tween; delete d.tweens[0]!.from; },
};
for (const type of ['Conveyor', 'ChainTransfer'] as const) {
  for (const [name, mutate] of Object.entries(cases)) {
    it(`${type}: rejects frozen ${name} before replacing the world`, async () => {
      const w = freezeWorld(type);
      try {
        await w.step(10);
        const before = w.runner.fullSnapshot();
        const saved: DESSnapshotV4 = structuredClone(before);
        const state = saved.parts.find(p => p.key === `#Transfer@${type}`)!.state as unknown as { frozen: Frozen[] };
        expect(state.frozen).toHaveLength(1);
        expect(state.frozen[0].tween?.kind).toBe('position');
        mutate(state.frozen[0]);
        rejectSnapshotWithoutMutation(w.runner, before, saved);
      } finally { w.dispose?.(); }
    });
  }
  it(`${type}: accepts the unmodified snapshot during freeze`, async () => {
    const w = freezeWorld(type);
    try {
      await w.step(10);
      const saved = w.runner.fullSnapshot();
      expect(() => w.runner.restoreFull(structuredClone(saved))).not.toThrow();
      expect(w.runner.fullSnapshot()).toEqual(saved);
    } finally { w.dispose?.(); }
  });
}

it('Turntable: rejects empty RotateComplete in rotating_out before replacing the world', async () => {
  const w = buildWorld('Turntable');
  try {
    let before: DESSnapshotV4 | undefined;
    // Search real event boundaries; assert the phase rather than relying on a cut time.
    for (let t = 0.25; t <= 30; t += 0.25) {
      await w.step(t);
      const candidate = w.runner.fullSnapshot();
      const state = candidate.parts.find(p => p.key === '#Subject@Turntable')!.state as unknown as { selfRunState: { fsmState: string } };
      if (state.selfRunState.fsmState === 'rotating_out') { before = candidate; break; }
    }
    expect(before).toBeDefined();
    const saved = structuredClone(before!);
    const state = saved.parts.find(p => p.key === '#Subject@Turntable')!.state as unknown as { selfRunState: { fsmState: string } };
    expect(state.selfRunState.fsmState).toBe('rotating_out');
    const event = saved.eventQueue.find(e => e.componentId === '#Subject@Turntable' && e.action === 'MF.Turntable.RotateComplete');
    expect(event).toBeDefined();
    event!.muId = -1;
    rejectSnapshotWithoutMutation(w.runner, before!, saved);
    expect(() => w.runner.restoreFull(structuredClone(before!))).not.toThrow();
    expect(w.runner.fullSnapshot()).toEqual(before);
  } finally { w.dispose?.(); }
});

import { validateFrozen } from '../../src/plugins/des/rv-des-frozen-validation';
it('validateFrozen accepts the legitimate payload tween kinds (position, path, drive, axes)', () => {
  const action = 'MF.Conveyor.Arrival';
  const descriptor = (payload: unknown) => [{ action, muRef: null, payload, remaining: 1 }];
  const tweens = [
    { kind: 'position', from: [0, 0, 0], to: [1, 0, 0], muId: 3 },
    { kind: 'path', pathRef: 'p', fromS: 0, toS: 1 },
    { kind: 'drive', from: 0, to: 90 },
    { kind: 'axes', anchorRef: 'a', phases: [{ at0: 0, at1: 0.5, axes: [{ driveRef: 'd', from: 0, to: 1 }] }] },
  ];
  expect(() => validateFrozen(descriptor({ tweens }), () => {}, () => true)).not.toThrow();
  for (const t of tweens) expect(() => validateFrozen(descriptor({ tween: t }), () => {}, () => true)).not.toThrow();
});
