// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { constructDrive } from '../src/core/engine/rv-signal-construction';
import {
  resolveComponentRefs,
  type ComponentContext,
  type RVComponent,
} from '../src/core/engine/rv-component-registry';
import type { RVDrive } from '../src/core/engine/rv-drive';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

type DirectType = 'Drive_Simple' | 'Drive_Cylinder' | 'Drive_DestinationMotor';

interface Fixture {
  node: Object3D;
  store: SignalStore;
  registry: NodeRegistry;
  manager: SignalBindingManager;
  component: RVComponent & Record<string, unknown>;
  drive: RVDrive;
}

function fixture(type: DirectType, extras: Record<string, unknown> = {}): Fixture {
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'Axis';
  scene.add(node);
  const rv = { Drive: { Direction: 'LinearX' }, [type]: extras };
  node.userData.realvirtual = rv;
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Axis', node);
  const result = constructDrive(node, rv, rv.Drive, 'Axis', registry, store)!;
  store.buildIndex();
  const entry = result.pendingBehaviors[0];
  resolveComponentRefs(entry.component as unknown as Record<string, unknown>, registry);
  registry.register(entry.type, entry.path, entry.component);
  entry.component.init({ registry, signalStore: store, scene, root: node } as ComponentContext);
  return {
    node,
    store,
    registry,
    manager: new SignalBindingManager(store, registry),
    component: entry.component as RVComponent & Record<string, unknown>,
    drive: result.drive,
  };
}

function addSource(
  f: Fixture,
  signal: string,
  type = 'PLCOutputBool',
  value: boolean | number = false,
  interfaceId?: string,
  connected = true,
): void {
  f.store.register(signal, `__iface__/${signal}`, value, type);
  if (interfaceId) f.store.registerSignalProvider({ interfaceId, signal }, connected);
}

function direct(
  slot: string,
  signal: string,
  interfaceId?: string,
): SignalMapping {
  return {
    kind: 'direct-property',
    componentPath: '.',
    slot,
    signal,
    interfaceId,
    direction: 'plcOutput',
    enabled: true,
  };
}

describe('DirectPropertyBinding', () => {
  it('relays through the command sink without writing the auto-provisioned store slot', () => {
    const f = fixture('Drive_Simple');
    addSource(f, 'PLC.Forward', 'PLCOutputBool', false, 'connect');
    f.manager.bind('axis', f.node, direct('Forward', 'PLC.Forward', 'connect'));
    f.manager.tick(1 / 60);

    f.store.set('PLC.Forward', true);
    expect(f.drive.jogForward).toBe(true);
    expect(f.store.getBool('Forward')).toBe(false);
    expect(f.component.liveControlled).toBe(true);
    expect(f.manager.getElementState('axis')).toBe('live');
  });

  it('stays publicly pending without a CONNECT provider despite a same-named local signal', () => {
    const f = fixture('Drive_Simple');
    addSource(f, 'PLC.Forward');
    f.manager.bind('axis', f.node, direct('Forward', 'PLC.Forward'));
    f.manager.tick(1 / 60);

    expect(f.manager.getBindingLiveness('axis', 'Forward', '.')).toBe('pending');
    expect(f.manager.getElementState('axis')).toBe('pending');
    expect(f.manager.isLive('axis')).toBe(false);
    expect(f.drive.jogForward).toBe(false);
  });

  it('aggregates element state as conflict > live > pending > disconnected > unbound', () => {
    const f = fixture('Drive_Simple');
    addSource(f, 'Conflict', 'PLCOutputBool', false, 'conflict');
    addSource(f, 'Live', 'PLCOutputBool', false, 'live');
    addSource(f, 'Pending');
    addSource(f, 'Disconnected', 'PLCOutputFloat', 0, 'offline', false);
    f.manager.bind('axis', f.node, direct('Speed', 'Conflict', 'conflict'));
    f.manager.bind('axis', f.node, direct('Forward', 'Live', 'live'));
    f.manager.bind('axis', f.node, direct('Backward', 'Pending'));
    f.manager.bind('axis', f.node, direct('Accelaration', 'Disconnected', 'offline'));
    f.manager.tick(1 / 60);
    expect(f.manager.getElementState('axis')).toBe('conflict');

    f.manager.unbind('axis', 'Speed', '.');
    expect(f.manager.getElementState('axis')).toBe('live');
    f.manager.unbind('axis', 'Forward', '.');
    expect(f.manager.getElementState('axis')).toBe('pending');
    f.manager.unbind('axis', 'Backward', '.');
    expect(f.manager.getElementState('axis')).toBe('disconnected');
    f.manager.unbind('axis', 'Accelaration', '.');
    expect(f.manager.getElementState('axis')).toBe('unbound');
  });

  it('uses the shared 800 ms hold then neutralizes a held jog', () => {
    const f = fixture('Drive_Simple');
    addSource(f, 'PLC.Forward', 'PLCOutputBool', true, 'connect');
    f.manager.bind('axis', f.node, direct('Forward', 'PLC.Forward', 'connect'));
    f.manager.tick(1 / 60);
    expect(f.drive.jogForward).toBe(true);

    f.store.setSignalProviderConnected({ interfaceId: 'connect' }, false);
    f.manager.tick(0.4);
    expect(f.manager.getBindingLiveness('axis', 'Forward', '.')).toBe('hold');
    expect(f.drive.jogForward).toBe(true);
    f.manager.tick(0.41);
    expect(f.manager.getBindingLiveness('axis', 'Forward', '.')).toBe('disconnected');
    expect(f.drive.jogForward).toBe(false);
  });

  it.each([
    ['two-bit', {}],
    ['one-bit', { OneBitCylinder: true }],
    ['inverted', { InvertOutputLogic: true }],
  ])('hold expiry, disable and unbind neutralize the %s cylinder with drive.stop', (_name, extras) => {
    const f = fixture('Drive_Cylinder', extras);
    const commandValue = 'InvertOutputLogic' in extras && extras.InvertOutputLogic ? false : true;
    addSource(f, 'PLC.Out', 'PLCOutputBool', commandValue, 'connect');
    const stop = vi.spyOn(f.drive, 'stop');
    const mapping = direct('Out', 'PLC.Out', 'connect');
    f.manager.bind('axis', f.node, mapping);
    f.manager.tick(1 / 60);
    expect(f.drive.isRunning).toBe(true);

    mapping.enabled = false;
    f.manager.tick(1 / 60);
    expect(f.drive.isRunning).toBe(false);
    mapping.enabled = true;
    f.manager.tick(1 / 60);
    expect(f.drive.isRunning).toBe(true);
    f.store.setSignalProviderConnected({ interfaceId: 'connect' }, false);
    f.manager.tick(0.81);
    expect(stop).toHaveBeenCalled();
    expect(f.drive.isRunning).toBe(false);
    f.manager.unbind('axis', 'Out', '.');
    expect(f.drive.jogForward).toBe(false);
    expect(f.drive.jogBackward).toBe(false);
  });

  it('never seeds an edge-triggered StartDrive slot on connect or reconnect', () => {
    const f = fixture('Drive_DestinationMotor');
    addSource(f, 'PLC.Start', 'PLCOutputBool', true, 'connect');
    const start = vi.spyOn(f.drive, 'startMove');
    f.manager.bind('axis', f.node, direct('StartDrive', 'PLC.Start', 'connect'));
    f.manager.tick(1 / 60);
    expect(start).not.toHaveBeenCalled();

    f.store.set('PLC.Start', false);
    f.store.set('PLC.Start', true);
    expect(start).toHaveBeenCalledTimes(1);
    f.store.setSignalProviderConnected({ interfaceId: 'connect' }, false);
    f.manager.tick(0.81);
    f.store.setSignalProviderConnected({ interfaceId: 'connect' }, true);
    f.manager.tick(1 / 60);
    expect(start).toHaveBeenCalledTimes(1);
  });

  it('keeps the last numeric command on disconnect neutralize', () => {
    const f = fixture('Drive_DestinationMotor');
    addSource(f, 'PLC.Destination', 'PLCOutputFloat', 25, 'connect');
    f.manager.bind('axis', f.node, direct('Destination', 'PLC.Destination', 'connect'));
    f.manager.tick(1 / 60);
    expect(f.drive.targetPosition).toBe(25);
    f.store.setSignalProviderConnected({ interfaceId: 'connect' }, false);
    f.manager.tick(0.81);
    expect(f.drive.targetPosition).toBe(25);
  });

  it('shares one component gate and releases it only after the final live binding is removed', () => {
    const f = fixture('Drive_Simple');
    addSource(f, 'PLC.Forward', 'PLCOutputBool', false, 'connect');
    addSource(f, 'PLC.Backward', 'PLCOutputBool', false, 'connect');
    f.manager.bind('axis', f.node, direct('Forward', 'PLC.Forward', 'connect'));
    f.manager.bind('axis', f.node, direct('Backward', 'PLC.Backward', 'connect'));
    f.manager.tick(1 / 60);
    expect(f.component.liveControlled).toBe(true);

    f.manager.unbind('axis', 'Forward', '.');
    expect(f.component.liveControlled).toBe(true);
    f.manager.unbind('axis', 'Backward', '.');
    expect(f.component.liveControlled).toBe(false);
    expect(f.manager.isLive('axis')).toBe(false);
  });

  it('unbind is composite-keyed, stops the relay and neutralizes the selected slot', () => {
    const f = fixture('Drive_Simple');
    addSource(f, 'PLC.Forward', 'PLCOutputBool', true, 'connect');
    f.manager.bind('axis', f.node, direct('Forward', 'PLC.Forward', 'connect'));
    f.manager.tick(1 / 60);
    f.manager.unbind('axis', 'Forward', '.');
    f.store.set('PLC.Forward', true);
    expect(f.drive.jogForward).toBe(false);
    expect(f.manager.getBindingLiveness('axis', 'Forward', '.')).toBeUndefined();
  });
});
