// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// Criterion: all three drive channels record valid nonzero forces over 10 s (three path cycles).
// Uses the production fixedUpdate stages, including the mechanism manager and recorder POST.
import { afterAll, describe, expect, it } from 'vitest';
import { register, unregister, getActiveMechanismManager } from '@rv-private/features/kinematic-mechanism.register';
import { ensureForceRecorder } from '../../src/plugins/mechanism-force-recorder-plugin';
import { createAcceptanceViewer, loadAcceptanceModel, stepModel } from './_model-acceptance';
let h: Awaited<ReturnType<typeof createAcceptanceViewer>>;
afterAll(() => { unregister(); h?.dispose(); });
describe('Autonox model acceptance', () => {
  it('records valid forces for every drive axis', async ctx => {
    h = await createAcceptanceViewer();
    await register(h.viewer);
    if (!await getActiveMechanismManager()!.ensureSolverLoaded()) {
      ctx.skip('rv_kinematic_solver.wasm unavailable'); return;
    }
    await loadAcceptanceModel(h.viewer, '/demo-realvirtual/Autonox-DELTA-RL5-1900-6kg.glb');
    const plugin = ensureForceRecorder(h.viewer);
    h.viewer.runtime.beginEditorTest();
    plugin.start();
    try { await stepModel(h.viewer, 'Autonox', 10); } finally { plugin.stop(); h.viewer.runtime.endEditorTest(); }
    const recorder = plugin.recorder;
    for (const axis of ['J_Rev_000', 'J_Rev_120', 'J_Rev_240']) {
      const channels = recorder.series.filter(s => s.kind === 'drive' && (s.id.includes(axis) || s.label.includes(axis)));
      expect(channels.length, `Autonox ${axis}: ${channels.length} drive channels (expected 1)`).toBe(1);
      const m = recorder.metrics(channels[0].id);
      const message = `Autonox ${axis}: ${m.sampleCount}/${recorder.timeBuffer.count} valid samples, peak ${m.peak}, rms ${m.rms} after 10 s sim (expected all valid, count > 0, finite peak > 1 N·m, rms > 0)`;
      console.log(message);
      expect(m.sampleCount > 0 && m.sampleCount === recorder.timeBuffer.count && Number.isFinite(m.peak) && m.peak > 1 && m.rms > 0, message).toBe(true);
    }
  }, 240_000);
});
