// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { BaseIndustrialInterface, type SignalDescriptor } from '../src/interfaces/base-industrial-interface';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import type { InterfaceSettings } from '../src/interfaces/interface-settings-store';
import type { LoadResult } from '../src/core/engine/rv-scene-loader';
import type { RVViewer } from '../src/core/rv-viewer';

class ReloadInterface extends BaseIndustrialInterface {
  readonly id = 'reload-interface';
  readonly protocolName = 'Reload';
  readonly sent: Record<string, boolean | number>[] = [];
  protected async doConnect(): Promise<void> {}
  protected doDisconnect(): void {}
  protected sendSignals(signals: Record<string, boolean | number>): void { this.sent.push(signals); }
  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> {
    return [{ name: 'Sensor.Feedback', type: 'bool', direction: 'input', initialValue: false }];
  }
}

function viewer(signalStore: SignalStore): RVViewer {
  return {
    signalStore,
    emit: () => {},
    setConnectionState: () => {},
  } as unknown as RVViewer;
}

describe('industrial interface store rebind', () => {
  it('re-registers discovery and outgoing subscriptions after model reload', async () => {
    const iface = new ReloadInterface();
    const first = new SignalStore();
    iface.onModelLoaded({} as LoadResult, viewer(first));
    await iface.connect({} as InterfaceSettings);
    first.set('Sensor.Feedback', true);
    iface.onFixedUpdatePost(0.02);
    expect(iface.sent).toEqual([{ 'Sensor.Feedback': true }]);

    const second = new SignalStore();
    iface.onModelLoaded({} as LoadResult, viewer(second));
    expect(second.getBool('Sensor.Feedback')).toBe(false);
    expect(second.hasSignalProvider({ interfaceId: iface.id, signal: 'Sensor.Feedback' })).toBe(true);
    second.set('Sensor.Feedback', true);
    iface.onFixedUpdatePost(0.02);

    expect(iface.sent).toEqual([
      { 'Sensor.Feedback': true },
      { 'Sensor.Feedback': true },
    ]);
  });
});
