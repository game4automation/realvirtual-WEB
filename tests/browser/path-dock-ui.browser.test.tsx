// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { useState, type ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { userEvent } from 'vitest/browser';
import { CssBaseline, ThemeProvider } from '@mui/material';
import { Object3D } from 'three';
import type { RVViewer } from '../../src/core/rv-viewer';
import { RVViewerProvider } from '../../src/hooks/use-viewer';
import { rvDarkTheme } from '../../src/core/hmi/theme';
import { ComponentSection } from '../../src/core/hmi/rv-component-section';
import { ContextMenuLayer } from '../../src/core/hmi/ContextMenuLayer';
import { contextMenuStore } from '../../src/core/hmi/context-menu-store';
import { commandRegistry } from '../../src/core/hmi/rv-command-registry';
import { componentActionRegistry } from '../../src/core/hmi/rv-component-action-registry';
import { clearBySource, getInstructions } from '../../src/core/hmi/instruction-store';
import { setActiveEditTarget } from '../../src/core/hmi/rv-edit-target';
import { SnapPointRegistry } from '../../src/core/engine/rv-snap-point-registry';
import { scanAndRegisterSnaps } from '../../src/core/connect/snap-scanner';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import '../../src/core/fleet/scene/fleet-components';
import { registerTransferStationDockUi } from '../../src/plugins/path-network/TransferStationDockAction';
import { ensurePathNetworkCommandsRegistered } from '../../src/plugins/path-network/path-network-commands';
import { setFieldOp } from '../../src/plugins/path-network/path-network-scene';
import { makeRig, type Rig } from '../path/path-network-rig';

const LABEL = 'Dock stub to path network';
const PATH = 'Root/Station';
let rig: Rig;
let viewer: RVViewer;
let station: Object3D;
let off: () => void;
let modes: { activeMode: string };

function mount(ui: ReactNode) {
  return render(<RVViewerProvider value={viewer}><ThemeProvider theme={rvDarkTheme}>
    <CssBaseline /><div style={{ width: 360 }}>{ui}</div>
  </ThemeProvider></RVViewerProvider>);
}

/** Real section, with its normal field callback committing to the rig's document. */
function Section({ componentType = 'TransferStation' }: { componentType?: string }) {
  const [, refresh] = useState(0);
  const data = station.userData.realvirtual[componentType];
  return <ComponentSection nodePath={PATH} componentType={componentType} data={{ ...data }}
    overriddenFields={new Set()} consumedOnly={false} viewer={viewer} signalStore={null}
    onFieldEdit={(field, value) => {
      void rig.doc.applyOp(setFieldOp(PATH, componentType, field, value, data[field]))
        .then(() => refresh(n => n + 1));
    }} onFieldReset={() => {}} onResetComponent={() => {}} />;
}

function openMenu() {
  act(() => {
    contextMenuStore.close();
    contextMenuStore.open({ x: 100, y: 100 }, {
      path: PATH, node: station, types: Object.keys(station.userData.realvirtual), extras: station.userData.realvirtual,
    });
  });
}

beforeEach(() => {
  getDefaultPathNetwork().clear();
  getDefaultZoneRegistry().clear();
  getDefaultAgvFleet().clear();
  rig = makeRig();
  modes = { activeMode: 'planner' };
  const snaps = new SnapPointRegistry();
  Object.assign(rig.stub, { modes, contextMenu: contextMenuStore,
    getPlugin: (id: string) => id === 'snap-point' ? { getRegistry: () => snaps }
      : id === 'path-visualizer' ? rig.plugin : undefined });
  Object.assign(rig.stub.registry, {
    getNode: (path: string) => rig.nodes.get(path) ?? null,
    findNodeForUser: (path: string) => { const node = rig.nodes.get(path); return node ? { node, via: 'runtime' } : null; },
  });
  viewer = rig.stub as unknown as RVViewer;
  station = new Object3D();
  station.name = 'Station';
  station.userData.realvirtual = { TransferStation: { DockPort: '' } };
  rig.root.add(station);
  rig.nodes.set(PATH, station);
  for (const name of ['Snap-ZB-path', 'Snap-XB-path']) {
    const port = new Object3D(); port.name = name; station.add(port);
  }
  station.updateMatrixWorld(true);
  scanAndRegisterSnaps(station, snaps, station);
  ensurePathNetworkCommandsRegistered();
  commandRegistry.attachViewer(viewer);
  off = registerTransferStationDockUi(viewer);
});

afterEach(() => {
  cleanup(); off(); contextMenuStore.close();
  clearBySource('path-network');
  vi.restoreAllMocks(); commandRegistry.attachViewer(undefined);
  rig.plugin.dispose(); setActiveEditTarget(null);
  getDefaultPathNetwork().clear(); getDefaultZoneRegistry().clear(); getDefaultAgvFleet().clear();
});

describe('636 9.6 docking UI', () => {
  it.each(['planner', 'des'])('shows the context command in %s, including deduplicated components', async mode => {
    modes.activeMode = mode;
    station.userData.realvirtual = { TransferStation_2: { DockPort: '' } };
    mount(<ContextMenuLayer />);
    const execute = vi.spyOn(commandRegistry, 'execute');
    openMenu();
    await userEvent.click(await screen.findByText(LABEL));
    expect(execute).toHaveBeenCalledWith('layout.path.dock', { station: PATH }, expect.objectContaining({ origin: 'ui', viewer }));
    await execute.mock.results[0].value;
  });

  it('hides the context item without TransferStation and in viewer mode', () => {
    station.userData.realvirtual = {};
    openMenu();
    expect(contextMenuStore.getSnapshot().items.some(i => i.id === 'path-dock-stub')).toBe(false);
    station.userData.realvirtual = { TransferStation: {} };
    modes.activeMode = 'viewer';
    openMenu();
    expect(contextMenuStore.getSnapshot().items.some(i => i.id === 'path-dock-stub')).toBe(false);
  });

  it('renders the section action once and reports a command refusal as a toast', async () => {
    mount(<Section />);
    expect(componentActionRegistry.get('TransferStation').filter(a => a.id === 'dock-stub')).toHaveLength(1);
    const execute = vi.spyOn(commandRegistry, 'execute');
    await userEvent.click(await screen.findByRole('button', { name: LABEL }));
    expect(execute).toHaveBeenCalledWith('layout.path.dock', { station: PATH }, expect.objectContaining({ origin: 'ui', viewer }));
    await waitFor(() => expect(getInstructions().some(i => i.style === 'toast' && i.text?.includes('dock-port-ambiguous'))).toBe(true));
  });

  it('lists auto and both ports, writes one undo step, and marks a missing stored port red', async () => {
    station.userData.realvirtual = { TransferStation_2: { DockPort: 'RemovedPort' } };
    mount(<Section componentType="TransferStation_2" />);
    const select = await screen.findByRole('combobox', { name: 'Dock port' });
    expect(select.textContent).toContain('RemovedPort (missing)');
    expect(getComputedStyle(select).color).toBe('rgb(239, 83, 80)');
    await userEvent.click(select);
    expect(screen.getByRole('option', { name: '(auto)' })).toBeTruthy();
    expect(screen.getByRole('option', { name: 'Snap-XB-path' })).toBeTruthy();
    const before = rig.doc.historyHead().undoLen;
    await userEvent.click(screen.getByRole('option', { name: 'Snap-ZB-path' }));
    await waitFor(() => expect(station.userData.realvirtual.TransferStation_2.DockPort).toBe('Snap-ZB-path'));
    expect(rig.doc.historyHead().undoLen).toBe(before + 1);
    expect(select.textContent).toBe('Snap-ZB-path');
    await rig.doc.undo();
    expect(station.userData.realvirtual.TransferStation_2.DockPort).toBe('RemovedPort');
  });

  it('writes the empty string for auto', async () => {
    station.userData.realvirtual.TransferStation.DockPort = 'Snap-ZB-path';
    mount(<Section />);
    await userEvent.click(await screen.findByRole('combobox', { name: 'Dock port' }));
    await userEvent.click(screen.getByRole('option', { name: '(auto)' }));
    await waitFor(() => expect(station.userData.realvirtual.TransferStation.DockPort).toBe(''));
    expect(rig.doc.historyHead().undoLen).toBe(1);
  });

  it('Fleet length uses mm, writes 1750 in one undo step, and clamps negative input to zero', async () => {
    station.userData.realvirtual = { Fleet: { DesignVehicleLengthMm: 0 } };
    mount(<Section componentType="Fleet" />);
    // The generic field row shows the field name (schema `label` is only honoured by instance resolvers).
    const label = await screen.findByText(/^Design ?Vehicle ?Length( ?Mm)?$/i);
    const row = label.closest('[data-rv-button-id]')!;
    expect(row.textContent).toContain('mm');
    const input = row.querySelector('input')!;
    expect(input.type).not.toBe('number');
    const before = rig.doc.historyHead().undoLen;
    fireEvent.change(input, { target: { value: '1750' } });
    await waitFor(() => expect(station.userData.realvirtual.Fleet.DesignVehicleLengthMm).toBe(1750));
    expect(rig.doc.historyHead().undoLen).toBe(before + 1);
    fireEvent.change(input, { target: { value: '-10' } });
    fireEvent.blur(input);
    await waitFor(() => expect(input.value).toBe('0'));
    await waitFor(() => expect(station.userData.realvirtual.Fleet.DesignVehicleLengthMm).toBe(0));
  });

  it('reports the created stub and distance after a successful section action', async () => {
    station.userData.realvirtual.TransferStation.DockPort = 'Snap-ZB-path';
    station.position.set(2.7, 0, -4);
    station.updateMatrixWorld(true);
    const placed = await commandRegistry.execute('layout.path.place',
      { block: 'straight', lengthM: 20, x: 0, z: 0, headingDeg: 0 }, { origin: 'ui', viewer });
    expect(placed.ok).toBe(true);
    mount(<Section />);
    await userEvent.click(await screen.findByRole('button', { name: LABEL }));
    await waitFor(() => expect(getInstructions().some(i =>
      i.style === 'toast' && /^Stub PN_K\d+ docked \(s = 4\.20 m\)$/.test(i.text ?? ''))).toBe(true));
  });

  it('removes the context registration on dispose and does not duplicate section actions on re-init', () => {
    off();
    openMenu();
    expect(contextMenuStore.getSnapshot().items.some(i => i.id === 'path-dock-stub')).toBe(false);
    off = registerTransferStationDockUi(viewer);
    openMenu();
    expect(contextMenuStore.getSnapshot().items.filter(i => i.id === 'path-dock-stub')).toHaveLength(1);
    expect(componentActionRegistry.get('TransferStation').filter(a => a.id === 'dock-stub')).toHaveLength(1);
  });
});
