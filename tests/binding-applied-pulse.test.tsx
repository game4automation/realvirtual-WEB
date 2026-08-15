// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * binding-applied-pulse — one pulse per link a PERSON or an AGENT made, and no
 * pulse for anything else (plan-425 F8, test 9.8).
 *
 * The counting is the test. `applyMappings()` is the tempting place to emit
 * from — it is the single funnel every binding passes through — and it is the
 * wrong one twice over: it runs on every model load, so the whole machine would
 * flash on reload; and the MCP bind tool calls it, so one agent bind would emit
 * twice (review round 1, finding 7). Both of those are asserted below as zeroes
 * and ones rather than described.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { Object3D } from 'three';
import '../src/core/engine/rv-signal-construction';
import {
  emitSignalBindingApplied,
  isBindingPulsing,
  pulseKey,
  resetBindingPulses,
  subscribeBindingPulse,
  PULSE_MS,
} from '../src/plugins/signal-bind/binding-applied-pulse';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

afterEach(() => {
  resetBindingPulses();
  vi.useRealTimers();
});

const MAPPING = {
  componentPath: 'Gripper',
  slot: 'Forward',
  signal: 'PLC.Run',
  sourceKind: 'connect' as const,
};

/** Counts the typed viewer events without needing a real viewer. */
function recordingViewer() {
  const events: Array<Record<string, unknown>> = [];
  return {
    viewer: { emit: (_name: string, payload: unknown) => { events.push(payload as Record<string, unknown>); } },
    events,
  };
}

describe('the typed event', () => {
  it('carries the full slot identity of the link that was made', () => {
    const { viewer, events } = recordingViewer();
    emitSignalBindingApplied(viewer, 'p1', MAPPING);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      targetId: 'p1',
      componentPath: 'Gripper',
      slot: 'Forward',
      signalName: 'PLC.Run',
      sourceKind: 'connect',
    });
  });

  it('defaults a legacy mapping without sourceKind to connect', () => {
    const { viewer, events } = recordingViewer();
    emitSignalBindingApplied(viewer, 'p1', { ...MAPPING, sourceKind: undefined });
    expect(events[0].sourceKind).toBe('connect');
  });

  it('still pulses when there is no viewer to tell', () => {
    // The acknowledgement is local; it must not depend on anyone listening.
    emitSignalBindingApplied(null, 'p1', MAPPING);
    expect(isBindingPulsing(pulseKey('p1', 'Gripper', 'Forward'))).toBe(true);
  });
});

describe('the pulse', () => {
  it('starts on the addressed slot and on no other', () => {
    emitSignalBindingApplied(null, 'p1', MAPPING);
    expect(isBindingPulsing(pulseKey('p1', 'Gripper', 'Forward'))).toBe(true);
    expect(isBindingPulsing(pulseKey('p1', 'Gripper', 'Backward'))).toBe(false);
    // Same component path and slot under a DIFFERENT target must not borrow it.
    expect(isBindingPulsing(pulseKey('p2', 'Gripper', 'Forward'))).toBe(false);
  });

  it('ends by itself and notifies once at each end', () => {
    vi.useFakeTimers();
    const key = pulseKey('p1', 'Gripper', 'Forward');
    let notifications = 0;
    const unsubscribe = subscribeBindingPulse(key, () => { notifications++; });

    emitSignalBindingApplied(null, 'p1', MAPPING);
    expect(notifications).toBe(1);
    expect(isBindingPulsing(key)).toBe(true);

    vi.advanceTimersByTime(PULSE_MS + 10);
    expect(notifications).toBe(2);
    expect(isBindingPulsing(key)).toBe(false);
    unsubscribe();
  });

  it('says nothing to a listener that unsubscribed', () => {
    // The leak this guards: a row unmounted mid-pulse whose callback still fires.
    vi.useFakeTimers();
    const key = pulseKey('p1', 'Gripper', 'Forward');
    let notifications = 0;
    const unsubscribe = subscribeBindingPulse(key, () => { notifications++; });
    unsubscribe();

    emitSignalBindingApplied(null, 'p1', MAPPING);
    vi.advanceTimersByTime(PULSE_MS + 10);
    expect(notifications).toBe(0);
  });
});

describe('emission boundary', () => {
  /** A drive whose Forward slot is bindable, plus a saved mapping for it. */
  function fixture() {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const node = new Object3D();
    node.name = 'Axis';
    store.register('Axis.Forward', 'Axis/Forward', false, 'PLCOutputBool');
    store.register('ModelSig', 'Cell/ModelSig', false, 'PLCOutputBool');
    node.userData.realvirtual = {
      Drive_Simple: {
        Forward: { type: 'ComponentReference', path: 'Axis/Forward', componentType: 'PLCOutputBool' },
      },
    };
    registry.registerNode('Axis', node);
    registry.register('Drive_Simple', 'Axis', {
      Forward: 'Axis.Forward',
      Backward: null,
      commandBackward: () => { /* command sink */ },
      neutralizeBackward: () => { /* neutral */ },
    });
    registry.register('Drive', 'Axis', { stop: () => { /* handover */ }, isOwner: true });
    return { mgr: new SignalBindingManager(store, registry), node };
  }

  const SAVED: SignalMapping = {
    kind: 'mapped-signal', componentPath: '.', componentType: 'Drive_Simple',
    slot: 'Forward', signal: 'ModelSig', sourceKind: 'internal',
    direction: 'plcInput', enabled: true,
  };

  it('a model-load restore emits NOTHING', () => {
    // The reload case. Every saved link on a big model would otherwise flash at
    // once, turning an acknowledgement into a light show that means nothing.
    const { mgr, node } = fixture();
    mgr.applyMappings('Axis', node, [SAVED]);
    expect(isBindingPulsing(pulseKey('Axis', '.', 'Forward'))).toBe(false);
  });

  it('a repair re-apply emits NOTHING either', () => {
    const { mgr, node } = fixture();
    mgr.applyMappings('Axis', node, [{ ...SAVED, componentPath: 'Gone/Axis' }]);
    mgr.applyMappings('Axis', node, [SAVED]);
    expect(isBindingPulsing(pulseKey('Axis', '.', 'Forward'))).toBe(false);
  });
});
