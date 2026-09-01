// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-activity-provider.test.ts — plan-234 §10-B.
 *
 * The source→connected heuristic and viewer-mode derivation that wire
 * SignalStore.getActivity() to the real CONNECT connection state. Pure over a
 * ConnectSnapshot so they are unit-testable in isolation (no gateway needed).
 */
import { describe, it, expect } from 'vitest';
import {
  isSourceConnected,
  deriveViewerModeFromConnect,
  type ConnectSnapshot,
  type ConnectInterface,
} from '../src/core/hmi/connect-store';

function snap(over: Partial<ConnectSnapshot>): ConnectSnapshot {
  return {
    serverUrl: 'http://localhost:5100',
    state: 'disconnected',
    errorMessage: '',
    serverVersion: '',
    serverBuild: '',
    serverBuildDate: '',
    gatewayUnreachable: false,
    lastStatusUpdate: 0,
    interfaces: [],
    interfaceStatus: {},
    activeProfile: null,
    activeProfileModel: null,
    availableTypes: null,
    activeInterfaceId: null,
    discoveredSignals: [],
    discoveryLoading: false,
    updateSupported: false,
    updateReason: null,
    revealSupported: false,
    ...over,
  };
}

function iface(over: Partial<ConnectInterface>): ConnectInterface {
  return { id: 'i1', type: 'MQTT', enabled: true, signals: [], ...over } as ConnectInterface;
}

describe('deriveViewerModeFromConnect', () => {
  it('is standalone when the gateway is not connected', () => {
    expect(deriveViewerModeFromConnect(snap({ state: 'disconnected' }))).toBe('standalone');
    expect(deriveViewerModeFromConnect(snap({ state: 'connecting' }))).toBe('standalone');
    expect(deriveViewerModeFromConnect(snap({ state: 'error' }))).toBe('standalone');
  });

  it('is direct when the gateway is connected (REST/MQTT, no Unity)', () => {
    expect(deriveViewerModeFromConnect(snap({ state: 'connected' }))).toBe('direct');
  });
});

describe('isSourceConnected', () => {
  it('is false when the gateway is disconnected', () => {
    expect(isSourceConnected(snap({ state: 'disconnected' }), 'MQTT · Data_I_1')).toBe(false);
  });

  it('is false for an empty source', () => {
    expect(isSourceConnected(snap({ state: 'connected' }), '')).toBe(false);
  });

  it('matches an interface whose type appears in the source and is Connected', () => {
    const s = snap({
      state: 'connected',
      interfaces: [iface({ id: 'm1', type: 'MQTT' })],
      interfaceStatus: { m1: { status: 'Connected' } },
    });
    expect(isSourceConnected(s, 'MQTT · Data_I_1')).toBe(true);
  });

  it('is false when the matched interface worker is not Connected', () => {
    const s = snap({
      state: 'connected',
      interfaces: [iface({ id: 'm1', type: 'MQTT' })],
      interfaceStatus: { m1: { status: 'Error' } },
    });
    expect(isSourceConnected(s, 'MQTT · Data_I_1')).toBe(false);
  });

  it('falls back to enabled+gateway-connected when no per-interface status exists', () => {
    const s = snap({
      state: 'connected',
      interfaces: [iface({ id: 'm1', type: 'MQTT' })],
      interfaceStatus: {},
    });
    expect(isSourceConnected(s, 'MQTT · Data_I_1')).toBe(true);
  });

  it('ignores disabled interfaces', () => {
    const s = snap({
      state: 'connected',
      interfaces: [iface({ id: 'm1', type: 'MQTT', enabled: false })],
      interfaceStatus: { m1: { status: 'Connected' } },
    });
    // No enabled matching interface → falls to the conservative "connected gateway,
    // unknown label" branch → true (prefers "supplied" over a false "no-source").
    expect(isSourceConnected(s, 'MQTT · Data_I_1')).toBe(true);
  });

  it('conservatively returns true for an unrecognized label on a connected gateway', () => {
    const s = snap({ state: 'connected', interfaces: [iface({ id: 's1', type: 'S7' })] });
    expect(isSourceConnected(s, 'SomeLegacyLabel')).toBe(true);
  });

  it('is true if ANY matching interface reports Connected (multi-interface)', () => {
    const s = snap({
      state: 'connected',
      interfaces: [
        iface({ id: 'm1', type: 'MQTT' }),
        iface({ id: 'm2', type: 'MQTT' }),
      ],
      interfaceStatus: { m1: { status: 'Error' }, m2: { status: 'Connected' } },
    });
    expect(isSourceConnected(s, 'MQTT · Data_I_1')).toBe(true);
  });
});
