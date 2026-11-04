// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * connection-mode.test.ts — plan-539 F15: Simulation / PLC mode.
 *
 * - load with / without a `ConnectionMode` component (absent → default Connected);
 * - toggle → the logic roots switch (Disconnected virtual PLC vs. Connected
 *   roots) and `StartMode` is written into the component + the document writer;
 * - F15b: a connected interface takes over ONLY with its first write to a
 *   model PLC output (`SIM_*` and non-model / input signals do not count); the
 *   takeover switches the logic before the batch lands, so the written value
 *   survives the virtual PLC's deactivation; disconnect (or no model output in
 *   its discovered signals any more) returns to the saved StartMode — all
 *   through the real `BaseIndustrialInterface` flush path;
 * - MCP `sim.connectionMode` / `sim.setConnectionMode` (incl. interfaceConnected / takeover);
 * - the toggle label.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import {
  ConnectionModeController,
  RVConnectionMode,
  parseStartMode,
  type ConnectionModeHost,
  type ConnectionStartMode,
} from '../src/core/engine/rv-connection-mode';
import { RVLogicEngine } from '../src/core/engine/rv-logic-engine';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { StepState } from '../src/core/engine/rv-logic-step';
import { BaseIndustrialInterface, type SignalDescriptor } from '../src/interfaces/base-industrial-interface';
import type { InterfaceSettings } from '../src/interfaces/interface-settings-store';
import { commandRegistry } from '../src/core/hmi/rv-command-registry';
import { McpCommandTools } from '../src/plugins/mcp-bridge/rv-mcp-command-tools';
import { ensureSimCommandsRegistered } from '../src/plugins/sim-controller/sim-commands';
import { connectionModeLabel } from '../src/core/hmi/ConnectionModeToggle';
import { registerSignal } from '../src/core/engine/rv-signal-construction';
import type { RVViewer } from '../src/core/rv-viewer';

/** A fake viewer: connection state + a logic engine with one root per Active value. */
function rig(component: ConnectionStartMode | null) {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Model';
  scene.add(root);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  // Model signals: a %Q output the virtual PLC writes, a SIM_ helper output, an %I input.
  const plc = new Object3D();
  plc.name = 'PLC';
  root.add(plc);
  for (const [name, type] of [['Out_Q', 'PLCOutputBool'], ['SIM_Helper', 'PLCOutputBool'], ['In_I', 'PLCInputBool']] as const) {
    const n = new Object3D();
    n.name = name;
    n.userData.realvirtual = { [type]: { Name: name, Status: { Value: false } } };
    plc.add(n);
  }
  for (const [name, active] of [['Logic_Virtual', 'Disconnected'], ['Logic_Real', 'Connected'], ['Logic_Plant', 'Always']] as const) {
    const r = new Object3D();
    r.name = name;
    r.userData.realvirtual = { LogicStep_SerialContainer: { Active: active } };
    if (name === 'Logic_Virtual') {
      const set = new Object3D();
      set.name = 'Virtual_SetQ';
      set.userData.realvirtual = { LogicStep_SetSignalBool: { Signal: { type: 'ComponentReference', path: 'Model/PLC/Out_Q', componentType: 'PLCOutputBool' }, SetToTrue: true } };
      r.add(set);
    }
    const d = new Object3D();
    d.name = `${name}_Wait`;
    d.userData.realvirtual = { LogicStep_Delay: { Duration: 1e9 } };
    r.add(d);
    root.add(r);
  }
  let modeComponent: RVConnectionMode | null = null;
  if (component) {
    const n = new Object3D();
    n.name = 'ConnectionMode';
    n.userData.realvirtual = { ConnectionMode: { StartMode: component } };
    root.add(n);
    modeComponent = new RVConnectionMode(n);
    modeComponent.StartMode = component;
    modeComponent.init();
    registry.register('ConnectionMode', 'Model/ConnectionMode', modeComponent);
  }
  root.traverse((n) => registry.registerNode(NodeRegistry.computeNodePath(n), n));
  plc.traverse((n) => {
    const rv = n.userData.realvirtual as Record<string, Record<string, unknown>> | undefined;
    const type = rv && Object.keys(rv)[0];
    if (type) registerSignal(n, type, rv![type], NodeRegistry.computeNodePath(n), store, registry);
  });
  store.buildIndex?.();
  const engine = RVLogicEngine.build(root, registry, store);
  const writes: Array<{ path: string; value: ConnectionStartMode; prev: ConnectionStartMode }> = [];
  const host: ConnectionModeHost & { connectionState: 'Connected' | 'Disconnected' } = {
    connectionState: 'Connected', // the viewer default
    setConnectionState(s) { this.connectionState = s; },
    syncLogicConnection: () => engine.setConnected(host.connectionState === 'Connected'),
  };
  const controller = new ConnectionModeController(host, (path, value, prev) => { writes.push({ path, value, prev }); return true; });
  /** Load: start mode before the first logic start (as `_attachLogicSystems`). */
  const load = () => {
    controller.attach(ConnectionModeController.find(registry), ConnectionModeController.outputNames(registry));
    engine.start(host.connectionState === 'Connected');
  };
  /** One tick of the per-root transitions (CoreSubsystems.early). */
  const tick = () => engine.setConnected(host.connectionState === 'Connected');
  const running = (name: string) => {
    const r = engine.roots.find((x) => x.name === name)!;
    return r.state === StepState.Active || r.state === StepState.Waiting;
  };
  /** A fake viewer around the rig, for the real interface flush path. */
  const viewer = {
    signalStore: store,
    emit: () => {},
    on: () => () => {},
    setConnectionState: (st: 'Connected' | 'Disconnected') => host.setConnectionState(st),
    connectionMode: controller,
  } as unknown as RVViewer;
  return { host, controller, engine, writes, load, tick, running, modeComponent, store, viewer };
}

describe('plan-539 F15 — ConnectionMode at load', () => {
  it('without the component the model starts in Simulation: the virtual PLC runs', () => {
    const r = rig(null);
    r.load();
    expect(r.host.connectionState).toBe('Disconnected');
    expect(r.controller.state).toMatchObject({ mode: 'Simulation', source: 'default', startMode: null, locked: false });
    expect(r.running('Logic_Virtual')).toBe(true);
    expect(r.running('Logic_Real')).toBe(false);
    expect(r.running('Logic_Plant')).toBe(true);
  });

  it('StartMode Simulation → Disconnected before the logic starts: the virtual PLC runs', () => {
    const r = rig('Simulation');
    r.load();
    expect(r.host.connectionState).toBe('Disconnected');
    expect(r.controller.state).toMatchObject({ mode: 'Simulation', source: 'model', startMode: 'Simulation' });
    expect(r.controller.state.componentPath).toBeTruthy();
    expect(r.running('Logic_Virtual')).toBe(true);
    expect(r.running('Logic_Real')).toBe(false);
  });

  it('StartMode PLC → Connected', () => {
    const r = rig('PLC');
    r.load();
    expect(r.host.connectionState).toBe('Connected');
    expect(r.controller.state).toMatchObject({ mode: 'PLC', source: 'model', startMode: 'PLC' });
    expect(r.running('Logic_Virtual')).toBe(false);
  });

  it('an unknown authored value reads as Simulation (schema default)', () => {
    expect(parseStartMode('nonsense')).toBe('Simulation');
    expect(parseStartMode('PLC')).toBe('PLC');
  });
});

describe('plan-539 F15 — toggle', () => {
  it('switches the roots and writes StartMode into the component and the document', () => {
    const r = rig('Simulation');
    r.load();
    const res = r.controller.setMode('PLC');
    expect('error' in res).toBe(false);
    r.tick();
    expect(r.running('Logic_Virtual')).toBe(false);
    expect(r.running('Logic_Real')).toBe(true);
    expect(r.controller.state).toMatchObject({ mode: 'PLC', source: 'toggle', startMode: 'PLC' });
    expect(r.modeComponent!.StartMode).toBe('PLC');
    expect((r.modeComponent!.node.userData.realvirtual as Record<string, Record<string, unknown>>).ConnectionMode.StartMode).toBe('PLC');
    expect(r.writes).toEqual([{ path: r.controller.state.componentPath, value: 'PLC', prev: 'Simulation' }]);
    expect((res as { persisted: boolean }).persisted).toBe(true);
    r.controller.setMode('Simulation');
    r.tick();
    expect(r.running('Logic_Virtual')).toBe(true);
    expect(r.writes[1]).toMatchObject({ value: 'Simulation', prev: 'PLC' });
  });

  it('without a component the toggle switches the state but persists nothing', () => {
    const r = rig(null);
    r.load();
    const res = r.controller.setMode('Simulation') as { persisted: boolean };
    expect(r.host.connectionState).toBe('Disconnected');
    expect(res.persisted).toBe(false);
    expect(r.writes).toEqual([]);
  });

  it('notifies subscribers', () => {
    const r = rig('Simulation');
    let n = 0;
    const off = r.controller.subscribe(() => { n++; });
    r.load();
    r.controller.setMode('PLC');
    off();
    r.controller.setMode('Simulation');
    expect(n).toBe(2);
  });
});

/** A fake live interface; `push` emulates values arriving from the PLC. */
class FakeInterface extends BaseIndustrialInterface {
  readonly id: string;
  readonly protocolName = 'Fake';
  discovered: SignalDescriptor[] = [];
  constructor(id = 'fake-plc') { super(); this.id = id; }
  protected async doConnect(): Promise<void> {}
  protected doDisconnect(): void {}
  protected sendSignals(): void {}
  protected async doDiscoverSignals(): Promise<SignalDescriptor[]> { return this.discovered; }
  push(values: Record<string, boolean>): void { for (const [k, v] of Object.entries(values)) this.pendingIncoming.set(k, v); }
  async redo(): Promise<void> { await this.rediscover(); }
}

describe('plan-539 F15b — an interface takes over only when it writes model outputs', () => {
  it('connected without model-output writes → Simulation stays, the virtual PLC runs', async () => {
    const r = rig('Simulation');
    r.load();
    const iface = new FakeInterface();
    iface.onModelLoaded?.({} as never, r.viewer);
    await iface.connect({} as InterfaceSettings);
    r.tick();
    expect(r.controller.state).toMatchObject({ mode: 'Simulation', source: 'model', locked: false, takeover: false, interfaceConnected: true });
    expect(r.running('Logic_Virtual')).toBe(true);
    expect(connectionModeLabel(r.controller.state)).toBe('Simulation · interface connected');
    iface.disconnect();
    expect(r.controller.state.interfaceConnected).toBe(false);
    expect(r.host.connectionState).toBe('Disconnected');
    iface.dispose?.();
  });

  it('writes only to SIM_ helpers, %I inputs or non-model signals → no takeover', async () => {
    const r = rig('Simulation');
    r.load();
    const iface = new FakeInterface();
    iface.onModelLoaded?.({} as never, r.viewer);
    await iface.connect({} as InterfaceSettings);
    iface.push({ SIM_Helper: true, In_I: true, Unrelated_Topic: true });
    iface.onFixedUpdatePre(1 / 60);
    r.tick();
    expect(r.controller.state).toMatchObject({ mode: 'Simulation', takeover: false });
    expect(r.running('Logic_Virtual')).toBe(true);
    iface.dispose?.();
  });

  it('first write to a model %Q → PLC (interface), roots off, written value kept; disconnect → Simulation, roots restart', async () => {
    const r = rig('Simulation');
    r.load();
    r.tick();
    expect(r.store.get('Out_Q')).toBe(true); // the virtual PLC wrote it
    const iface = new FakeInterface();
    iface.onModelLoaded?.({} as never, r.viewer);
    await iface.connect({} as InterfaceSettings);
    iface.push({ Out_Q: true });
    iface.onFixedUpdatePre(1 / 60);
    expect(r.controller.state).toMatchObject({ mode: 'PLC', source: 'interface', locked: true, takeover: true });
    expect(r.running('Logic_Virtual')).toBe(false);
    expect(r.running('Logic_Real')).toBe(true);
    // The deactivation ran BEFORE the batch: the PLC's value stands, also on later ticks.
    expect(r.store.get('Out_Q')).toBe(true);
    r.tick();
    expect(r.store.get('Out_Q')).toBe(true);
    expect('error' in r.controller.setMode('Simulation')).toBe(true);
    expect(connectionModeLabel(r.controller.state)).toBe('PLC (interface)');
    iface.disconnect();
    expect(r.controller.state).toMatchObject({ mode: 'Simulation', source: 'model', locked: false, takeover: false });
    r.tick();
    expect(r.running('Logic_Virtual')).toBe(true);
    iface.dispose?.();
  });

  it('a takeover ends when the interface no longer sources any model output (rediscovery)', async () => {
    const r = rig('Simulation');
    r.load();
    const iface = new FakeInterface();
    iface.discovered = [{ name: 'Out_Q', type: 'bool', direction: 'output' } as SignalDescriptor];
    iface.onModelLoaded?.({} as never, r.viewer);
    await iface.connect({} as InterfaceSettings);
    iface.push({ Out_Q: false });
    iface.onFixedUpdatePre(1 / 60);
    expect(r.controller.state.takeover).toBe(true);
    iface.discovered = [{ name: 'Unrelated_Topic', type: 'bool', direction: 'output' } as SignalDescriptor];
    await iface.redo();
    expect(r.controller.state).toMatchObject({ takeover: false, mode: 'Simulation', interfaceConnected: true });
    iface.disconnect();
    iface.dispose?.();
  });

  it('a model loaded while an interface has taken over stays connected', () => {
    const r = rig('Simulation');
    r.controller.interfaceConnected('x');
    r.controller.attach(null, ['Out_Q']);
    expect(r.controller.interfaceWrites('x', ['Out_Q'])).toBe(true);
    r.load();
    expect(r.host.connectionState).toBe('Connected');
    expect(r.running('Logic_Virtual')).toBe(false);
  });

  it('without a component a released takeover falls back to Disconnected (behaviour before plan-539)', () => {
    const r = rig(null);
    r.load();
    r.controller.interfaceConnected('x');
    r.controller.interfaceWrites('x', ['Out_Q']);
    r.controller.interfaceDisconnected('x');
    expect(r.host.connectionState).toBe('Disconnected');
  });
});

describe('plan-539 F15/F15b — MCP sim connection commands and the toggle label', () => {
  afterEach(() => commandRegistry.attachViewer(undefined));
  it('reads and sets the mode (incl. interfaceConnected / takeover); refuses while an interface has taken over', async () => {
    const r = rig('Simulation');
    r.load();
    ensureSimCommandsRegistered();
    const tool = new McpCommandTools(() => ({ connectionMode: r.controller } as unknown as RVViewer));
    expect(JSON.parse(await tool.webQuery('sim.connectionMode')).value).toMatchObject({ mode: 'Simulation', source: 'model', label: 'Simulation' });
    expect(JSON.parse(await tool.webExecute('sim.setConnectionMode', JSON.stringify({ mode: 'plc' }))).value).toMatchObject({ mode: 'PLC', source: 'toggle', persisted: true });
    expect(JSON.parse(await tool.webExecute('sim.setConnectionMode', JSON.stringify({ mode: 'bogus' }))).value.error).toMatch(/Unknown mode/);
    r.controller.interfaceConnected('plc');
    expect(JSON.parse(await tool.webQuery('sim.connectionMode')).value).toMatchObject({ interfaceConnected: true, takeover: false, label: 'PLC · interface connected' });
    r.controller.interfaceWrites('plc', ['Out_Q']);
    const refused = JSON.parse(await tool.webExecute('sim.setConnectionMode', JSON.stringify({ mode: 'Simulation' }))).value;
    expect(refused.error).toMatch(/interface/);
    expect(refused.source).toBe('interface');
    expect(JSON.parse(await tool.webQuery('sim.connectionMode')).value).toMatchObject({ label: 'PLC (interface)', takeover: true, interfaceConnected: true });
  });

  it('labels: Simulation / PLC / PLC (interface)', () => {
    expect(connectionModeLabel({ mode: 'Simulation', source: 'model' })).toBe('Simulation');
    expect(connectionModeLabel({ mode: 'PLC', source: 'toggle' })).toBe('PLC');
    expect(connectionModeLabel({ mode: 'PLC', source: 'interface' })).toBe('PLC (interface)');
    expect(connectionModeLabel({ mode: 'Simulation', source: 'model', interfaceConnected: true })).toBe('Simulation · interface connected');
  });
});
