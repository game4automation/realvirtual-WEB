// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.9 live-control-replacement — the former rv-live-control consumers behave
 * identically through the slot-authority service.
 *
 *  - rv-live-control.ts is a THIN adapter: its exports ARE the service
 *    functions (one shared state, no second registry).
 *  - The SignalBindingManager gate written through the service is visible
 *    through the adapter exactly as before (consumer contract: rv-logic-step
 *    queries by scoped name, material-flow `self.isWired` by prefix).
 *  - The `liveControlled` instance flag stays a cached boolean field on the
 *    component/drive (hot-path read rule — per-tick readers like
 *    rv-transport-manager:548 and rv-drives-playback never call the service).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import * as adapter from '../src/core/engine/rv-live-control';
import * as service from '../src/core/engine/rv-slot-authority';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { scopeSignalName } from '../src/core/engine/rv-instance-scope';

afterEach(() => service.resetSlotAuthority());

describe('live-control replacement (9.9)', () => {
  it('re-exports the identical service functions (single shared state)', () => {
    expect(adapter.setSignalLiveControlled).toBe(service.setSignalLiveControlled);
    expect(adapter.isSignalLiveControlled).toBe(service.isSignalLiveControlled);
    expect(adapter.isAnyLiveControlled).toBe(service.isAnyLiveControlled);
    expect(adapter.liveControlledCount).toBe(service.liveControlledCount);
    expect(adapter.clearLiveControl).toBe(service.clearLiveControl);

    service.setSignalLiveControlled('X.Run', true);
    expect(adapter.isSignalLiveControlled('X.Run')).toBe(true);
    adapter.clearLiveControl();
    expect(service.liveControlledCount()).toBe(0);
  });

  it('the binding-manager gate reads identically through adapter and service', () => {
    const store = new SignalStore();
    const registry = new NodeRegistry();
    const root = new Object3D();
    root.name = 'Conv';
    root.userData.realvirtual = { LayoutObject: { Label: 'Conv' }, Conveyor: {} };
    registry.registerNode('Conv', root);
    const target = scopeSignalName('Conv', 'Flow.Run');
    store.register(target, 'Conv/Flow.Run', false, 'PLCInputBool');
    store.register('Src.Run', '__iface__/Src.Run', true, 'PLCOutputBool');
    const manager = new SignalBindingManager(store, registry);
    manager.bind('Conv', root, {
      slot: 'Flow.Run', signal: 'Src.Run', direction: 'plcInput', enabled: true,
    });
    manager.tick(1 / 60);

    // Consumer views: scoped-name query (rv-logic-step) and prefix query
    // (material-flow self.isWired) — via the ADAPTER path, as before.
    expect(adapter.isSignalLiveControlled(target)).toBe(true);
    expect(adapter.isAnyLiveControlled('Conv.')).toBe(true);
    expect(adapter.isAnyLiveControlled('Conv_2.')).toBe(false);

    manager.unbindAll('Conv');
    expect(adapter.isSignalLiveControlled(target)).toBe(false);
    expect(adapter.isAnyLiveControlled('Conv.')).toBe(false);
  });

  it('keeps the cached liveControlled instance field for per-tick readers', () => {
    const instance: { liveControlled?: boolean } = {};
    service.setInstanceLiveControlled(instance, true);
    // A 60Hz reader (transport manager / playback) sees a plain field —
    // no service round-trip involved in the read.
    expect(instance.liveControlled).toBe(true);
    service.setInstanceLiveControlled(instance, false);
    expect(instance.liveControlled).toBe(false);
  });
});
