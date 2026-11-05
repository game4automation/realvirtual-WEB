// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D } from 'three';
import { SceneButtonManager } from '../../src/core/engine/rv-scene-button-manager';
import { RVSceneButtonBase } from '../../src/core/engine/rv-scene-button-base';
import type { ComponentContext } from '../../src/core/engine/rv-component-registry';
import { ceilEventTimeFor } from '../../src/core/sim-event-facade';
import { cycleRunnerFixture } from './cycle-runner-fixture';

describe('scene button DES pulse', () => {
  it.each([false, true])('resyncs a restored toggle without writing or starting a timer (inverted=%s)', inverted => {
    const w = cycleRunnerFixture();
    const button = new RVSceneButtonBase(new Object3D());
    const cap = { setPressed: vi.fn(), setLight: vi.fn(), click: vi.fn(), hover: vi.fn(), release: vi.fn() };
    button.moveable = cap as unknown as RVSceneButtonBase['moveable'];
    button.isToggle = true; button.invertSignal = inverted;
    button.init({ signalStore: w.signalStore } as ComponentContext);
    w.signalStore.register('pressed', 'Signals/pressed', inverted, 'PLCInputBool');
    button.setStateSignal('Signals/pressed');
    button.click();
    const saved = new Map([['pressed', !inverted]]);
    button.click(); expect(button.active).toBe(false);
    const writes = vi.fn(); w.signalStore.observeWrites(writes);
    w.signalStore.restoreValuesSilently(saved);
    expect(button.active).toBe(true);
    expect(cap.setPressed).toHaveBeenLastCalledWith(true);
    expect(cap.setLight).toHaveBeenLastCalledWith(true);
    expect(button.timerRemaining).toBe(0);
    expect(writes).not.toHaveBeenCalled();
    button.click();
    expect(button.active).toBe(false);
    expect(w.signalStore.get('pressed')).toBe(inverted);
    expect(writes).toHaveBeenCalledOnce();
    button.dispose();
    cap.setPressed.mockClear();
    w.signalStore.restoreValuesSilently(saved);
    expect(cap.setPressed).not.toHaveBeenCalled();
  });

  it('ends a momentary timer on restored release without writing a signal', () => {
    const buttons = new SceneButtonManager();
    const w = cycleRunnerFixture({ host: { sceneButtonManager: buttons } });
    const button = new RVSceneButtonBase(new Object3D());
    button.init({ signalStore: w.signalStore, sceneButtonManager: buttons } as ComponentContext);
    w.signalStore.register('pressed', 'Signals/pressed', false, 'PLCInputBool');
    button.setStateSignal('Signals/pressed');
    button.click(); expect(button.timerRemaining).toBeGreaterThan(0);
    const writes = vi.fn(); w.signalStore.observeWrites(writes);
    w.signalStore.restoreValuesSilently(new Map([['pressed', false]]));
    expect(button.active).toBe(false); expect(button.timerRemaining).toBe(0);
    expect(buttons.update(10)).toBe(false);
    expect(writes).not.toHaveBeenCalled();
    button.dispose();
  });

  it.each([false, true])('releases at the exact sim deadline without render ticks (cycle=%s)', cycle => {
    const buttons = new SceneButtonManager();
    const w = cycleRunnerFixture({ core: cycle, host: { sceneButtonManager: buttons } });
    if (cycle) w.runner.simEvents.registerCycleParticipant('motion', 60, { step: () => {}, alive: () => false });
    const node = new Object3D(); node.name = 'Button'; w.scene.add(node);
    const button = new RVSceneButtonBase(node);
    button.init({ signalStore: w.signalStore, sceneButtonManager: buttons } as ComponentContext);
    w.signalStore.register('pressed', 'Signals/pressed', false, 'PLCInputBool');
    button.setStateSignal('Signals/pressed'); button.simpleClickTime = 0.1;
    w.start(); w.runner.step(); w.manager.processAnimated(0.1 + 0.2);
    const start = w.manager.currentTime;
    button.click();
    const end = ceilEventTimeFor(start * 1000 + 100, ms => ms - start * 1000 >= 100);
    expect(w.signalStore.get('pressed')).toBe(true);
    buttons.update(99); // Visual time must not shorten the pulse.
    expect(button.active).toBe(true); expect(w.runner.renderPhaseSignalWrites).toBe(0);
    expect(() => w.runner.fullSnapshot()).toThrow(/scene button pulse running:.*Button/);
    expect(w.runner.step()).toBe(true); // Start settle plans the deadline.
    expect(w.pending('Core.Due')).toHaveLength(1); expect(w.pending('Core.Due')[0].time).toBe(end);
    for (let n = 0; w.manager.currentTime < end && n < 10; n++) {
      expect(w.runner.step()).toBe(true); expect(button.active).toBe(true);
    }
    expect(w.manager.currentTime).toBe(end);
    expect(w.runner.step()).toBe(true); expect(button.active).toBe(false);
    expect(w.signalStore.get('pressed')).toBe(false); expect(w.pending('Core.Due')).toEqual([]);
    expect(() => w.runner.fullSnapshot()).not.toThrow();
    button.click(); w.runner.reset(); expect(button.active).toBe(false);
    expect(w.pending('Core.Due')).toEqual([]);
    button.dispose();
  });

  it('counts write batches only inside render phases and tears the observer down', () => {
    const w = cycleRunnerFixture(); w.start();
    vi.spyOn(w.core!, 'visuals').mockImplementation(() => { w.signalStore.setMany({ a: true, b: true }, 0); });
    w.signalStore.set('outside', true, 0); expect(w.runner.renderPhaseSignalWrites).toBe(0);
    w.runner.tick(0); expect(w.runner.renderPhaseSignalWrites).toBe(1);
    w.runner.tick(0); expect(w.runner.renderPhaseSignalWrites).toBe(1);
    w.runner.dispose(); w.signalStore.set('a', false, 0); expect(w.runner.renderPhaseSignalWrites).toBe(1);
  });
});
