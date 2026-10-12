// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 "Transport-Erkennung": `BaseIndustrialInterface.connectedEndpoint`
 * reports the target the CURRENT connection reached (null otherwise), and
 * `InterfaceManager.getActiveEndpoint()` normalises it to the HTTP origin a
 * REST gateway compares against.
 */

import { describe, it, expect } from 'vitest';
import { BaseIndustrialInterface } from '../src/interfaces/base-industrial-interface';
import { InterfaceManager, normalizeEndpointOrigin } from '../src/interfaces/interface-manager';
import type { InterfaceSettings } from '../src/interfaces/interface-settings-store';
import type { SignalDescriptor } from '../src/interfaces/base-industrial-interface';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import type { RVViewer } from '../src/core/rv-viewer';

class EndpointInterface extends BaseIndustrialInterface {
  readonly id = 'endpoint-fake';
  readonly protocolName = 'Fake';
  target = 'ws://gateway.local:5100/ws?apikey=secret';
  fail = false;

  protected async doConnect(_settings: InterfaceSettings): Promise<void> {
    if (this.fail) throw new Error('refused');
    this.setConnectedEndpoint(this.target);
  }
  protected doDisconnect(): void { /* nothing */ }
  protected sendSignals(): void { /* nothing */ }
  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> { return []; }
}

function host(): RVViewer {
  return {
    signalStore: new SignalStore(),
    emit: () => {},
    on: () => () => {},
    setConnectionState: () => {},
  } as unknown as RVViewer;
}

const SETTINGS = {} as InterfaceSettings;

describe('connectedEndpoint / getActiveEndpoint', () => {
  it('is null before connecting, the real target (without credentials/query) while connected, null after disconnect', async () => {
    const iface = new EndpointInterface();
    iface.onModelLoaded?.({} as never, host());
    expect(iface.connectedEndpoint).toBeNull();
    await iface.connect(SETTINGS);
    expect(iface.connectedEndpoint?.href).toBe('ws://gateway.local:5100/ws');
    iface.disconnect();
    expect(iface.connectedEndpoint).toBeNull();
    iface.dispose?.();
  });

  it('a failed connect reports no endpoint', async () => {
    const iface = new EndpointInterface();
    iface.onModelLoaded?.({} as never, host());
    iface.fail = true;
    await expect(iface.connect(SETTINGS)).rejects.toThrow('refused');
    expect(iface.connectedEndpoint).toBeNull();
    iface.disconnect();
    iface.dispose?.();
  });

  it('InterfaceManager.getActiveEndpoint normalises ws→http / wss→https and default ports', async () => {
    const mgr = new InterfaceManager();
    const iface = new EndpointInterface();
    mgr.register(iface);
    expect(mgr.getActiveEndpoint()).toBeNull();
    await mgr.activate(iface.id, SETTINGS);
    expect(mgr.getActiveEndpoint()?.href).toBe('http://gateway.local:5100/');
    expect(mgr.getActiveEndpoint()?.origin).toBe(new URL('http://gateway.local:5100/api').origin);
    mgr.deactivate();
    expect(mgr.getActiveEndpoint()).toBeNull();
    mgr.dispose();
  });

  it('normalizeEndpointOrigin: default ports and secure schemes', () => {
    expect(normalizeEndpointOrigin(new URL('wss://h.example:443/x')).href).toBe('https://h.example/');
    expect(normalizeEndpointOrigin(new URL('ws://h.example:80/x')).href).toBe('http://h.example/');
    expect(normalizeEndpointOrigin(new URL('ws://h.example:8080/x?k=1')).href).toBe('http://h.example:8080/');
    expect(normalizeEndpointOrigin(new URL('wss://h.example/x')).origin).toBe('https://h.example');
    // Negative: another port is another origin.
    expect(normalizeEndpointOrigin(new URL('ws://h.example:5101/')).origin).not.toBe('http://h.example:5100');
  });
});
