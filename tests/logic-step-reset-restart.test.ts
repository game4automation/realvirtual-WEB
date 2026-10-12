// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * logic-step-reset-restart.test.ts — plan-502 Nachkorrektur (user decision
 * 2026-09-26): `resetSimulation()` (Shift+R) restarts the LogicSteps.
 *
 * The reset puts every root to Idle (`logicEngine.reset()`); the START phase
 * then starts them again from the first step, exactly as after a load — so a
 * top-level SerialContainer keeps running and its SetSignalBool fires again.
 * An engine that never ran (logic still held by a signature gate) stays Idle.
 * Runs the production `RVViewer.prototype.resetSimulation` on a narrow fake.
 */

import { describe, expect, it } from 'vitest';
import { RVViewer } from '../src/core/rv-viewer';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import {
  StepState,
  RVSerialContainer,
  RVSetSignalBool,
  RVDelay,
} from '../src/core/engine/rv-logic-step';

const SIG = 'Demo/Restart';

function makeFixture() {
  const store = new SignalStore();
  store.register(SIG, SIG, false);
  const pulse = new RVSetSignalBool(SIG, true, store);
  pulse.name = 'Pulse';
  const wait = new RVDelay(4);
  wait.name = 'Wait';
  const sequence = new RVSerialContainer([pulse, wait], true);
  sequence.name = 'Sequence';
  const engine = new RVLogicEngine();
  engine.roots.push(sequence);

  const order: string[] = [];
  const fakeViewer = {
    _simTime: 12,
    drives: [] as { reset(): void }[],
    chainManager: { resetAll() {} },
    ribbonManager: { resetAll() {} },
    transportManager: { reset() {} },
    logicEngine: engine as RVLogicEngine | null,
    _kernel: null,
    statisticsManager: { resetAll() {} },
    signalReapply: { reapplyAll() { order.push(`reapply:${sequence.state}`); } },
    emit(event: string) { order.push(`${event}:${sequence.state}`); },
  };
  const reset = RVViewer.prototype.resetSimulation as unknown as (this: typeof fakeViewer) => void;
  return { store, pulse, wait, sequence, engine, fakeViewer, order, reset: () => reset.call(fakeViewer) };
}

describe('resetSimulation() restarts the LogicSteps (plan-502)', () => {
  it('a running top-level SerialContainer runs again from its first step', () => {
    const f = makeFixture();
    f.engine.start();
    expect(f.store.getBoolByPath(SIG)).toBe(true);
    f.engine.fixedUpdate(0.5); // Pulse done → Wait active
    expect(f.sequence.currentIndex).toBe(1);

    f.store.setByPath(SIG, false); // the consumer took the pulse away
    f.reset();

    expect(f.sequence.state).toBe(StepState.Active);
    expect(f.sequence.currentIndex).toBe(0);
    expect(f.pulse.state).toBe(StepState.Finished);
    expect(f.store.getBoolByPath(SIG)).toBe(true); // SetSignalBool fired again

    // …and the sequence keeps cycling after the reset.
    f.engine.fixedUpdate(0.02);
    expect(f.sequence.currentIndex).toBe(1);
    expect(f.wait.state).toBe(StepState.Active);
  });

  it('restarts AFTER the simulation-start subscribers and BEFORE the live re-apply', () => {
    const f = makeFixture();
    f.engine.start();
    f.reset();
    expect(f.order).toEqual([
      'simulation-reset:Active',
      'simulation-resetstat:Idle',
      'simulation-start:Idle',
      'reapply:Active',
    ]);
  });

  it('an engine that never started (logic held by a gate) stays Idle', () => {
    const f = makeFixture();
    expect(f.engine.isStarted).toBe(false);
    f.reset();
    expect(f.sequence.state).toBe(StepState.Idle);
    expect(f.store.getBoolByPath(SIG)).toBe(false);
  });

  it('a viewer without LogicSteps resets without an engine', () => {
    const f = makeFixture();
    f.fakeViewer.logicEngine = null;
    expect(() => f.reset()).not.toThrow();
  });
});
