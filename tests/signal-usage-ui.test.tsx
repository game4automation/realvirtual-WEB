// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-usage-ui — plan-566 Phase 3: the "Used by" list on screen.
 *
 *  - The inspector block groups the usages by kind; a click on a component
 *    usage navigates to its node (navigateToRef → selectAndReveal).
 *  - A PLC usage is clickable ONLY while a PlcNavigation is registered (R2) and
 *    then opens the editor at the line.
 *  - A process-image signal WITHOUT a scene node (only a CONNECT bridge names
 *    it) gets the count chip; its popover lists the bridge, and a click opens
 *    the CONNECT panel at the bridge row (R1, R2-1).
 *  - A name two signal nodes share shows the ambiguity hint (F9).
 *  - The tooltip model carries "used by N" (F7).
 *  - `web_signal_usage` returns the same list (F8).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queryCommand } from './helpers/query-command';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalUsageService, type SignalUsage } from '../src/core/engine/rv-signal-usage-index';
import { SignalUsageButton, SignalUsageSection } from '../src/core/hmi/rv-signal-usage-list';
import { buildSignalTooltipModel } from '../src/core/hmi/rv-signal-badge';
import { registerPlcNavigation } from '../src/core/plc-control';
import { getConnectBridges, requestConnectBridgeReveal } from '../src/core/hmi/connect-store';
import { registerSignal } from '../src/core/engine/rv-signal-construction';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { Object3D } from 'three';
import type { RVViewer } from '../src/core/rv-viewer';

const USAGES: SignalUsage[] = [
  { kind: 'component-field', signal: 'BT2_OpMode', label: 'Conveyor', detail: 'Drive_Simple.Forward', resolved: true, nodePath: 'Cell/Conveyor', componentType: 'Drive_Simple', field: 'Forward' },
  { kind: 'logic-step', signal: 'BT2_OpMode', label: 'I_03_SetAuto', detail: 'WaitForSignalBool.Signal', resolved: true, nodePath: 'Logic/I_03_SetAuto', componentType: 'LogicStep_WaitForSignalBool', field: 'Signal' },
  { kind: 'plc-program', signal: 'BT2_OpMode', label: 'Modes', detail: 'line 14 (read)', resolved: true, byName: true, plcProgramPath: 'PLC/Modes', plcProgramName: 'Modes', line: 14, access: 'read' },
  { kind: 'connect-mapping', signal: 'PI_Only', label: 'Bridge → MQTT.PI_Only', detail: '1:1 source', resolved: true, byName: true, connectBridgeKey: 'mapping:3' },
];

interface FakeViewer {
  signalUsage: SignalUsageService;
  signalStore: SignalStore;
  registry: null;
  signalBindingManager: null;
  leftPanelManager: { open: ReturnType<typeof vi.fn> };
  getPlugin: (id: string) => unknown;
}

let selectAndReveal: ReturnType<typeof vi.fn>;

function makeViewer(usages: SignalUsage[] = USAGES): FakeViewer {
  const service = new SignalUsageService();
  service.registerProvider('fixture', { collect: (sink) => { for (const u of usages) sink.add(u); } });
  selectAndReveal = vi.fn();
  return {
    signalUsage: service,
    signalStore: new SignalStore(),
    registry: null,
    signalBindingManager: null,
    leftPanelManager: { open: vi.fn() },
    getPlugin: (id: string) => (id === 'rv-extras-editor' ? { selectAndReveal } : undefined),
  };
}

const asViewer = (v: FakeViewer) => v as unknown as RVViewer;

beforeEach(() => registerPlcNavigation(null));
afterEach(() => {
  cleanup();
  registerPlcNavigation(null);
  requestConnectBridgeReveal(null);
});

describe('inspector "Used by" section', () => {
  it('groups the usages by kind with the count in the heading', () => {
    const v = makeViewer();
    render(<SignalUsageSection viewer={asViewer(v)} name="BT2_OpMode" />);
    expect(screen.getByText('Used by (3)')).toBeTruthy();
    expect(screen.getByTestId('signal-usage-group-component-field').textContent).toContain('Conveyor');
    expect(screen.getByTestId('signal-usage-group-logic-step').textContent).toContain('I_03_SetAuto');
    expect(screen.getByTestId('signal-usage-group-plc-program').textContent).toContain('line 14 (read)');
  });

  it('a click on a component usage navigates to its node', () => {
    const v = makeViewer();
    render(<SignalUsageSection viewer={asViewer(v)} name="BT2_OpMode" />);
    fireEvent.click(screen.getByText('Conveyor'));
    expect(selectAndReveal).toHaveBeenCalledWith('Cell/Conveyor', true);
  });

  it('a PLC usage is not clickable without the PLC plugin (R2)', () => {
    const v = makeViewer();
    render(<SignalUsageSection viewer={asViewer(v)} name="BT2_OpMode" />);
    const row = screen.getAllByTestId('signal-usage-row').find((r) => r.dataset.usageKind === 'plc-program')!;
    expect(row.dataset.navigable).toBe('false');
    fireEvent.click(row);
    expect(selectAndReveal).not.toHaveBeenCalled();
  });

  it('with a PlcNavigation a PLC usage opens the editor at the line', () => {
    const revealLine = vi.fn();
    registerPlcNavigation({ revealLine });
    const v = makeViewer();
    render(<SignalUsageSection viewer={asViewer(v)} name="BT2_OpMode" />);
    const row = screen.getAllByTestId('signal-usage-row').find((r) => r.dataset.usageKind === 'plc-program')!;
    expect(row.dataset.navigable).toBe('true');
    fireEvent.click(row);
    expect(revealLine).toHaveBeenCalledWith('PLC/Modes', 14);
  });

  it('a shared signal name is flagged and grouped by path (F9)', () => {
    const v = makeViewer([
      { kind: 'component-field', signal: 'Dup', label: 'A', resolved: true, nodePath: 'A', signalPath: 'Cell_1/Dup' },
      { kind: 'component-field', signal: 'Dup', label: 'B', resolved: true, nodePath: 'B', signalPath: 'Cell_2/Dup' },
    ]);
    const registry = new NodeRegistry();
    for (const path of ['Cell_1/Dup', 'Cell_2/Dup']) {
      registerSignal(new Object3D(), 'PLCOutputBool', { Name: 'Dup' }, path, v.signalStore, registry);
    }
    render(<SignalUsageSection viewer={asViewer(v)} name="Dup" />);
    expect(screen.getByTestId('signal-usage-ambiguous')).toBeTruthy();
    expect(screen.getByText('Cell_1/Dup')).toBeTruthy();
    expect(screen.getByText('Cell_2/Dup')).toBeTruthy();
  });
});

describe('usage chip + popover (hierarchy / CONNECT row)', () => {
  it('a signal without a scene node lists its CONNECT bridge and opens the panel there (R1, R2-1)', () => {
    const v = makeViewer();
    render(<SignalUsageButton viewer={asViewer(v)} name="PI_Only" />);
    fireEvent.click(screen.getByTestId('signal-usage-button'));
    expect(screen.getByTestId('signal-usage-popover-title').textContent).toContain('PI_Only');
    fireEvent.click(screen.getByText('Bridge → MQTT.PI_Only'));
    expect(v.leftPanelManager.open).toHaveBeenCalledWith('connect', expect.any(Number));
    expect(getConnectBridges().revealKey).toBe('mapping:3');
  });

  it('renders nothing for an unused signal', () => {
    const v = makeViewer();
    const { container } = render(<SignalUsageButton viewer={asViewer(v)} name="Unused" />);
    expect(container.textContent).toBe('');
  });
});

describe('tooltip and MCP', () => {
  it('the tooltip model carries "used by N" (F7)', () => {
    const model = buildSignalTooltipModel({
      name: 'BT2_OpMode', plcType: 'PLCInputBool', direction: 'input', shown: false, forced: false,
      meta: undefined, hint: '', usedBy: 3,
    });
    expect(model.usedBy).toBe(3);
    const none = buildSignalTooltipModel({
      name: 'X', plcType: 'PLCInputBool', direction: 'input', shown: false, forced: false, meta: undefined, hint: '',
    });
    expect('usedBy' in none).toBe(false);
  });

  it('web_signal_usage returns the same grouped list (F8)', async () => {
    const v = makeViewer();

    const out = await queryCommand(asViewer(v), 'signal.usage', { name: 'BT2_OpMode' });
    expect(out.signal).toBe('BT2_OpMode');
    expect(out.count).toBe(3);
    expect(out.groups.map((g: { kind: string }) => g.kind)).toEqual(['component-field', 'logic-step', 'plc-program']);
    expect(out.groups[2].usages[0]).toMatchObject({ line: 14, access: 'read', navigable: false });
    expect(await queryCommand(asViewer(v), 'signal.usage', { name: '' })).toEqual({ error: 'name is required' });
  });
});
