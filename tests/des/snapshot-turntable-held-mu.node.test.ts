// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { buildWorld } from './continuation-turntable-conveyor-world';
import { rejectSnapshotWithoutMutation } from './snapshot-preflight-helpers';
import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';

type TurntableState = { muIds: number[]; prop: Record<string, unknown>; selfRunState: { fsmState: string } };
const part = (s: DESSnapshotV4) => s.parts.find(p => p.key === '#Subject@Turntable')!.state as unknown as TurntableState;

// plan-2059 findings: prop.heldMU used to be a bare id, resolved only in onDownstreamReady
// (after the destructive world replacement). It is now an id + generation pair checked in the preflight.
async function rotatingOut() {
  const w = buildWorld('Turntable');
  for (let t = 0.25; t <= 30; t += 0.25) {
    await w.step(t);
    const s = w.runner.fullSnapshot();
    if (part(s).selfRunState.fsmState === 'rotating_out' && part(s).muIds.length > 0) return { w, before: s };
  }
  w.dispose?.();
  throw new Error('Turntable never reached rotating_out');
}

const cases: Record<string, (p: TurntableState) => void> = {
  'unknown MU id': p => { p.prop.heldMU = 999999; p.prop.heldMUGen = 0; },
  'stale generation of an owned MU': p => { p.prop.heldMU = p.muIds[0]; p.prop.heldMUGen = 1000; },
  'owned MU id without generation': p => { p.prop.heldMU = p.muIds[0]; delete p.prop.heldMUGen; },
  'generation without MU': p => { p.prop.heldMU = null; p.prop.heldMUGen = 0; },
  'non-integer MU id': p => { p.prop.heldMU = 'x'; p.prop.heldMUGen = 0; },
};
for (const [name, mutate] of Object.entries(cases)) {
  it(`Turntable: rejects held MU with ${name} before replacing the world`, async () => {
    const { w, before } = await rotatingOut();
    try {
      const saved = structuredClone(before);
      mutate(part(saved));
      rejectSnapshotWithoutMutation(w.runner, before, saved);
    } finally { w.dispose?.(); }
  });
}

it('Turntable: rejects the holding phase without a held MU before replacing the world', async () => {
  const { w, before } = await rotatingOut();
  try {
    const saved = structuredClone(before);
    part(saved).selfRunState.fsmState = 'holding';
    part(saved).prop.heldMU = null; part(saved).prop.heldMUGen = null;
    rejectSnapshotWithoutMutation(w.runner, before, saved);
  } finally { w.dispose?.(); }
});

it('Turntable: accepts an owned held MU with its own generation', async () => {
  const { w, before } = await rotatingOut();
  try {
    const saved = structuredClone(before);
    const mus = saved.parts.find(p => p.key === 'des.mus')!.state as unknown as { records: Array<{ id: number; generation: number }> };
    const mu = mus.records.find(m => m.id === part(saved).muIds[0]);
    part(saved).prop.heldMU = part(saved).muIds[0];
    part(saved).prop.heldMUGen = mu?.generation ?? 0;
    expect(() => w.runner.restoreFull(saved)).not.toThrow();
  } finally { w.dispose?.(); }
});
