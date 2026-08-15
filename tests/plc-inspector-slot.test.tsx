// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-418 9.7 (F6) — the Property Inspector row of a raw PLC signal node.
 *
 * The inspector is the ONLY surface that also explains a fail-closed slot: the
 * tree context menu deliberately hides itself for those (no disabled state in
 * the menu), so if the reason did not render here it would be invisible.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { registerSignal } from '../src/core/engine/rv-signal-construction';
import { PLC_SIGNAL_SLOT } from '../src/core/engine/rv-binding-slot-resolver';
import { resetSlotAuthority } from '../src/core/engine/rv-slot-authority';
import { PLCSignalSlot } from '../src/plugins/signal-bind/InlineSignalSlots';
import { setActiveEditTarget } from '../src/core/hmi/rv-edit-target';
import type { RVViewer } from '../src/core/rv-viewer';

const ROOT = 'DemoCell';

interface Fixture {
  root: Object3D;
  registry: NodeRegistry;
  store: SignalStore;
  viewer: RVViewer;
}

function fixture(withManager = true): Fixture {
  const scene = new Scene();
  const root = new Object3D();
  root.name = ROOT;
  scene.add(root);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode(ROOT, root);
  const manager = withManager ? new SignalBindingManager(store, registry) : null;
  const viewer = {
    registry,
    signalStore: store,
    signalBindingManager: manager,
    behaviors: { getActiveBinds: () => [] },
    getPlugin: () => undefined,
  } as unknown as RVViewer;
  return { root, registry, store, viewer };
}

function addSignal(
  f: Fixture,
  name: string,
  opts: { signalName?: string; register?: boolean } = {},
): string {
  const root = f.root;
  const node = new Object3D();
  node.name = name;
  root.add(node);
  const path = `${ROOT}/${name}`;
  const sigData = { Name: opts.signalName ?? name, Status: { Value: false } };
  node.userData.realvirtual = { PLCOutputBool: sigData };
  f.registry.registerNode(path, node);
  if (opts.register !== false) registerSignal(node, 'PLCOutputBool', sigData, path, f.store, f.registry);
  return path;
}

beforeEach(resetSlotAuthority);
afterEach(() => { cleanup(); setActiveEditTarget(null); resetSlotAuthority(); });

describe('PLCSignalSlot inspector row', () => {
  it('renders one bindable Value row for a registered signal node', () => {
    const f = fixture();
    const path = addSignal(f, 'EntryConveyorStart');
    f.store.buildIndex();

    render(<PLCSignalSlot viewer={f.viewer} nodePath={path} componentType="PLCOutputBool" />);

    const row = screen.getByTestId(`slot-row-.-mapped-signal-${PLC_SIGNAL_SLOT}`);
    expect(row.getAttribute('data-rv-slot-kind')).toBe('mapped-signal');
    // The row is interactive: it offers the picker.
    expect(screen.getByLabelText(`signal for ${PLC_SIGNAL_SLOT}`)).toBeTruthy();
  });

  it('opens the signal picker from the row', async () => {
    const f = fixture();
    const path = addSignal(f, 'EntryConveyorStart');
    f.store.register('PLC.Start', 'PLC/Start', false, 'PLCOutputBool');
    f.store.buildIndex();

    render(<PLCSignalSlot viewer={f.viewer} nodePath={path} componentType="PLCOutputBool" />);
    fireEvent.click(screen.getByLabelText(`signal for ${PLC_SIGNAL_SLOT}`));

    expect(await screen.findByText(`Link ${PLC_SIGNAL_SLOT}`)).toBeTruthy();
  });

  it('explains a duplicate signal name instead of offering a link', () => {
    const f = fixture();
    const a = addSignal(f, 'StartA', { signalName: 'Start' });
    addSignal(f, 'StartB', { signalName: 'Start' });
    f.store.buildIndex();

    render(<PLCSignalSlot viewer={f.viewer} nodePath={a} componentType="PLCOutputBool" />);

    const row = screen.getByTestId(`slot-row-unavailable-${PLC_SIGNAL_SLOT}`);
    expect(row.textContent).toContain('Another node registers the same signal name');
    expect(screen.queryByLabelText(`signal for ${PLC_SIGNAL_SLOT}`)).toBeNull();
  });

  it('explains an unregistered signal', () => {
    const f = fixture();
    const path = addSignal(f, 'Ghost', { register: false });
    f.store.buildIndex();

    render(<PLCSignalSlot viewer={f.viewer} nodePath={path} componentType="PLCOutputBool" />);

    expect(screen.getByTestId(`slot-row-unavailable-${PLC_SIGNAL_SLOT}`).textContent)
      .toContain('not registered in the loaded model');
  });

  it('renders read-only without a binding manager (A1 parity)', () => {
    const f = fixture(false);
    const path = addSignal(f, 'EntryConveyorStart');
    f.store.buildIndex();

    render(<PLCSignalSlot viewer={f.viewer} nodePath={path} componentType="PLCOutputBool" />);

    expect(screen.getByTestId(`slot-row-unavailable-${PLC_SIGNAL_SLOT}`)).toBeTruthy();
    expect(screen.queryByLabelText(`signal for ${PLC_SIGNAL_SLOT}`)).toBeNull();
  });

  it('renders nothing for a non-signal component type', () => {
    const f = fixture();
    const path = addSignal(f, 'EntryConveyorStart');
    f.store.buildIndex();

    const { container } = render(
      <PLCSignalSlot viewer={f.viewer} nodePath={path} componentType="Drive_Simple" />,
    );

    expect(container.firstChild).toBeNull();
  });
});
