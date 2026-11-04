// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2212 review (re-review HIGH) — snapshot / restore must not cross the
 * deferred material startup. While a run waits for its scripts, setup and the
 * generators have not run: a capture would save half-initialised state, and a
 * restore would be overrun when the barrier opens (state reset, generator
 * events twice). With a VALID fingerprint from an earlier bind:
 *  - the run start invalidates it (the deferred startup binds the new one);
 *  - capture and restore are refused with a visible reason while pending;
 *  - after the barrier the run is exactly a normal run (no duplicated
 *    generator events) and capture + restore work again.
 */

import { describe, it, expect } from 'vitest';
import { makeWorld } from './webcomponent-des-fixture';
import { whenDocumentHashesSettled } from '../../src/core/engine/rv-model-content-ledger';
import { getProblem, clearProblem } from '../../src/core/hmi/problems-store';

const COUNTER = `
function setup(self) {
  const st = self.persist({ n: 0 });
  self.every(1, 'beat');
  return {
    des: { on(hook) { if (hook === 'beat') st.n++; } },
    state() { return st; },
  };
}`;

const CODE = 'des-snapshot-scripts-pending';
type World = Awaited<ReturnType<typeof makeWorld>>;
const sinkOf = (w: World): number =>
  w.runner.liveInstances.find(i => i.adapter.node.name === 'Sink')!.adapter.totalProcessed;

describe('plan-2212 — no snapshot across the deferred material startup', () => {
  it('refuses capture and restore while the startup is pending; afterwards a normal run that can be saved', async () => {
    clearProblem(CODE);
    // Reference: an ordinary reset + run of the same scene and seed.
    const ref = await makeWorld({ scripts: [{ name: 'Counter', code: COUNTER }], flow: true });
    ref.start();
    ref.runner.reset();
    await ref.runTo(60);

    const w = await makeWorld({ scripts: [{ name: 'Counter', code: COUNTER }], flow: true });
    w.start();
    await whenDocumentHashesSettled();
    await w.runTo(15);
    expect('pending' in w.runner.fingerprintAtBind()).toBe(false);
    const earlier = w.runner.fullSnapshot();   // the fingerprint is valid now

    // New wiring in flight (trust gate re-opened), then a reset: the run waits.
    w.plugin.setAllowScripts(false);
    w.plugin.setAllowScripts(true);
    expect(w.plugin.wiringPending).toBe(true);
    w.runner.reset();
    expect(w.runner.scriptsPending).toBe(true);
    expect('pending' in w.runner.fingerprintAtBind()).toBe(true);
    expect(() => w.runner.fullSnapshot()).toThrow(CODE);
    expect(() => w.runner.restoreFull(earlier)).toThrow(CODE);
    expect(getProblem(CODE)?.detail).toContain(`[${CODE}]`);

    await w.plugin.whenWired();
    await new Promise(r => setTimeout(r, 0));
    expect(w.runner.scriptsPending).toBe(false);
    expect(getProblem(CODE)).toBeUndefined();
    // The sink's part counter is not cleared by a runner reset (the viewer's
    // statistics reset does that) - compare what this run added.
    const sinkBefore = sinkOf(w);
    await w.runTo(60);
    // Exactly one material startup: same flow and events as the reference run.
    expect(sinkOf(w) - sinkBefore).toBe(sinkOf(ref));
    expect(w.manager.totalEventsProcessed).toBe(ref.manager.totalEventsProcessed);
    expect(w.state('Counter')).toEqual(ref.state('Counter'));

    // After the startup: capture and restore work again.
    await whenDocumentHashesSettled();
    const snap = w.runner.fullSnapshot();
    await w.runTo(80);
    const after = w.state('Counter');
    w.runner.restoreFull(snap);
    expect((w.state('Counter') as { n: number }).n).toBe(60);
    await w.runTo(80);
    expect(w.state('Counter')).toEqual(after);
  });
});
