// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-button-click.test.ts — plan-417 §9.2.
 *
 * Click semantics and the WRITE MODEL. The operator pulse is the part that is
 * easy to get wrong and impossible to see in a unit-free review: a momentary
 * click must produce `true` AND a later `false` through the SAME operator
 * writer, or the PLC never sees the falling flank.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  claimBound,
  makeSignalChannelId,
  makeSlotId,
  registerSlotChannel,
  resetSlotAuthority,
} from '../src/core/engine/rv-slot-authority';
import { buildButtonScene, PATHS } from './scene-button-fixture';

afterEach(() => {
  resetSlotAuthority();
});

/** Advance the manager by `seconds` in 20 ms steps (fixed-timestep parity). */
function tick(h: ReturnType<typeof buildButtonScene>, seconds: number, step = 0.02): void {
  for (let t = 0; t < seconds - 1e-9; t += step) h.sceneButtonManager.update(step);
}

describe('SceneButton click semantics', () => {
  it('toggle click flips PLCInputBool in store and latches', () => {
    const h = buildButtonScene();
    const base = h.base(PATHS.emergencyNode);
    expect(base.isToggle).toBe(true);

    base.onClick();
    expect(h.signalStore.getByPath(PATHS.emergencySignal)).toBe(true);
    expect(base.active).toBe(true);

    // No timer for a toggle — it stays latched however long we tick.
    tick(h, 2);
    expect(h.signalStore.getByPath(PATHS.emergencySignal)).toBe(true);
    expect(base.active).toBe(true);

    base.onClick();
    expect(h.signalStore.getByPath(PATHS.emergencySignal)).toBe(false);
    expect(base.active).toBe(false);
  });

  it('simple click writes true and resets to false after the timer', () => {
    const h = buildButtonScene();
    const base = h.base(PATHS.pushBase);
    expect(base.isToggle).toBe(false);
    expect(base.simpleClickTime).toBe(0.3);   // PushButton3D.timer

    base.onClick();
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(true);

    tick(h, 0.2);
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(true);

    tick(h, 0.2);
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(false);
    expect(base.active).toBe(false);
  });

  it('re-click before timer expiry holds active and does not restart the timer', () => {
    const h = buildButtonScene();
    const base = h.base(PATHS.pushBase);

    base.onClick();
    tick(h, 0.2);
    const remaining = base.timerRemaining;
    base.onClick();                       // Unity parity: ignored while active
    expect(base.active).toBe(true);
    expect(base.timerRemaining).toBeCloseTo(remaining, 6);

    tick(h, 0.2);
    expect(base.active).toBe(false);
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(false);
  });

  it('activeOnStart clicks once on scene ready and is not repeated', () => {
    const h = buildButtonScene();
    // HandleSwitchOn has activeOnStart: true in the demo model.
    expect(h.signalStore.getByPath(PATHS.onSwitchSignal)).toBe(true);
    expect(h.base(PATHS.handleBase).active).toBe(true);

    // A second late pass must not toggle it back off.
    h.sceneReady();
    expect(h.signalStore.getByPath(PATHS.onSwitchSignal)).toBe(true);

    // A button without activeOnStart stays untouched.
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(false);
  });

  it('user click lands as an operator write when the slot authority is bound', () => {
    const h = buildButtonScene();
    const channel = h.signalStore.nameForPath(PATHS.automaticButtonSignal)!;
    const slotId = makeSlotId('demo', PATHS.pushWrapper, 'PushButton3D', 'stateSignal');
    registerSlotChannel(slotId, makeSignalChannelId(channel));
    claimBound(slotId);

    const base = h.base(PATHS.pushBase);
    base.onClick();
    // Operator kind ('hmi') is NOT a local-sim kind → the write goes through.
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(true);

    // ... and so does the falling flank of the SAME pulse.
    tick(h, 0.4);
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(false);
  });

  it('suppresses the autonomous activeOnStart write while liveControlled', () => {
    const h = buildButtonScene();
    const base = h.base(PATHS.pushBase);
    base.liveControlled = true;

    base.click('auto');
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(false);
    // The optics must not drift either — the live source owns the state.
    expect(base.active).toBe(false);

    // The operator pulse itself is never gated, live-controlled or not.
    base.click('operator');
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(true);
    expect(base.active).toBe(true);
  });

  it('a forced channel keeps its value — neither pulse flank overwrites the force', () => {
    const h = buildButtonScene();
    const channel = h.signalStore.nameForPath(PATHS.automaticButtonSignal)!;
    h.signalStore.forceSignal(channel, false);

    const base = h.base(PATHS.pushBase);
    base.onClick();
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(false);
    expect(h.signalStore.isForced(channel)).toBe(true);

    tick(h, 0.4);   // the release flank is dropped by the force as well
    expect(h.signalStore.getByPath(PATHS.automaticButtonSignal)).toBe(false);

    // Forcing the other way resynchronizes the optics through the stateSignal
    // subscription (confirmed state, plan-417 §2.5).
    h.signalStore.forceSignal(channel, true);
    expect(base.active).toBe(true);
  });

  it('follows a remote/PLC echo on the state signal without a local click', () => {
    const h = buildButtonScene();
    const base = h.base(PATHS.pushBase);
    const channel = h.signalStore.nameForPath(PATHS.automaticButtonSignal)!;

    h.signalStore.set(channel, true);
    expect(base.active).toBe(true);
    h.signalStore.set(channel, false);
    expect(base.active).toBe(false);
  });
});
