// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * bindings-overview-panel — the human's supervision of what a language model
 * bound (plan-425 F7, test 9.7).
 *
 * The panel exists because binding moved to MCP. An agent can make a hundred
 * links faster than a person can read one confirmation dialog, so oversight had
 * to stop being per-link and become per-scene: here is everything that IS
 * bound, jump to it, unbind it.
 *
 * Two behaviours are load-bearing rather than cosmetic and are asserted as such.
 * "Show in scene" must not navigate to a target the registry cannot resolve —
 * moving the camera somewhere arbitrary is worse than not moving it. And
 * "Reconnect" appears ONLY where exactly one component matched; an ambiguous
 * orphan gets an explanation and no button, because a repair that guessed would
 * silently rewire a machine.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { Object3D } from 'three';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import '../src/core/engine/rv-signal-construction';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { BindingsOverviewPanel } from '../src/plugins/signal-bind/BindingsOverviewPanel';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { createSignalBindingPersistence } from '../src/plugins/signal-bind/signal-binding-persistence';
import type { RVViewer } from '../src/core/rv-viewer';
import type { SignalMapping } from '../src/plugins/layout-planner/rv-layout-store';

const NOOP_TARGET: EditTarget = {
  available: true,
  setField: () => { /* accepted */ },
  unsetField: () => { /* accepted */ },
  withTransaction: async (_label, fn) => { await fn(); },
};

interface Fixture {
  viewer: RVViewer;
  mgr: SignalBindingManager;
  node: Object3D;
  selected: string[];
  focused: string[];
}

/** One drive node whose `Forward` slot can carry an external signal. */
function makeFixture(): Fixture {
  const store = new SignalStore();
  const registry = new NodeRegistry();
  const node = new Object3D();
  node.name = 'Conveyor';
  store.register('Conveyor.Forward', 'Conveyor/Forward', false, 'PLCOutputBool');
  store.setSignalMeta('Conveyor.Forward', { comment: 'Belt run command' });
  store.register('PLC.Run', 'plc/run', false, 'PLCOutputBool');
  store.registerSignalProvider({ interfaceId: 'plc-1', signal: 'PLC.Run' }, true);
  node.userData.realvirtual = {
    Drive_Simple: {
      Forward: { type: 'ComponentReference', path: 'Conveyor/Forward', componentType: 'PLCOutputBool' },
    },
  };
  registry.registerNode('Conveyor', node);
  registry.register('Drive_Simple', 'Conveyor', {
    Forward: 'Conveyor.Forward',
    Backward: null,
    commandBackward: () => { /* command sink */ },
    neutralizeBackward: () => { /* neutral */ },
  });

  const selected: string[] = [];
  const focused: string[] = [];
  const mgr = new SignalBindingManager(store, registry);
  const viewer = {
    registry,
    signalStore: store,
    signalBindingManager: mgr,
    getPlugin: () => undefined,
    behaviors: { getActiveBinds: () => [] },
    selectionManager: { select: (path: string) => selected.push(path) },
    focusByPath: (path: string) => focused.push(path),
  } as unknown as RVViewer;

  return { viewer, mgr, node, selected, focused };
}

const LINKED: SignalMapping = {
  kind: 'mapped-signal', componentPath: '.', componentType: 'Drive_Simple',
  slot: 'Forward', signal: 'PLC.Run', interfaceId: 'plc-1',
  direction: 'plcOutput', enabled: true,
};

/**
 * Bind the way the product binds: apply AND persist. The panel reads the
 * persistence adapter, because that is what survives a reload — a mapping held
 * only in the manager is a session artefact, not a binding.
 */
function bind(f: Fixture, mappings: SignalMapping[], targetId = 'Conveyor') {
  f.mgr.applyMappings(targetId, f.node, mappings);
  createSignalBindingPersistence(f.viewer, { kind: 'node', nodePath: targetId, node: f.node })
    .write(mappings);
}

function renderPanel(f: Fixture) {
  return render(<BindingsOverviewPanel viewer={f.viewer} open onClose={() => {}} />);
}

beforeEach(() => setActiveEditTarget(NOOP_TARGET));
afterEach(() => { cleanup(); setActiveEditTarget(null); });

describe('bound rows', () => {
  it('says so plainly when nothing is linked', () => {
    renderPanel(makeFixture());
    expect(screen.getByText(/Nothing is linked/)).toBeTruthy();
  });

  it('lists a linked slot with its external signal and its comment', () => {
    const f = makeFixture();
    bind(f, [LINKED]);
    renderPanel(f);
    expect(screen.getByText('PLC.Run')).toBeTruthy();
    // The comment is what makes a row readable to someone who did not bind it.
    expect(screen.getByText('Belt run command')).toBeTruthy();
  });

  it('jumps to the object — selection AND camera', () => {
    const f = makeFixture();
    bind(f, [LINKED]);
    renderPanel(f);
    fireEvent.click(screen.getByLabelText(/show Conveyor in scene/i));
    expect(f.selected).toEqual(['Conveyor']);
    expect(f.focused).toEqual(['Conveyor']);
  });

  it('unbinds in one click and drops the row', async () => {
    const f = makeFixture();
    bind(f, [LINKED]);
    renderPanel(f);
    fireEvent.click(screen.getByLabelText(/unbind Forward/i));
    await waitFor(() => expect(screen.getByText(/Nothing is linked/)).toBeTruthy());
    expect(f.mgr.getBindingLiveness('Conveyor', 'Forward', '.')).toBeUndefined();
  });
});

describe('orphan rows', () => {
  /** A saved link whose component path this model no longer has. */
  const LOST: SignalMapping = { ...LINKED, componentPath: 'OldArm/Welder' };

  it('shows a broken link with the reason it cannot be repaired', () => {
    const f = makeFixture();
    bind(f, [LOST]);
    renderPanel(f);
    expect(screen.getByTestId('orphan-section')).toBeTruthy();
    expect(screen.getByText(/No component of this type and name is left/)).toBeTruthy();
    // No button: nothing matched, so there is nothing to offer.
    expect(screen.queryByText('Reconnect')).toBeNull();
  });

  it('explains a LEGACY orphan differently — the key was never complete', () => {
    const legacy: SignalMapping = { ...LOST };
    delete legacy.componentType;
    const f = makeFixture();
    bind(f, [legacy]);
    renderPanel(f);
    expect(screen.getByText(/Saved before components were identified by type/)).toBeTruthy();
    expect(screen.queryByText('Reconnect')).toBeNull();
  });

  it('does NOT navigate to a target the registry cannot resolve', () => {
    // The real case is a Planner placement, whose target id is a placement id
    // and not a node path — `focusByPath` on it would move the camera nowhere
    // in particular, which is worse than not moving it. Simulated here by a
    // registry that has stopped resolving the id after the rows were built.
    const f = makeFixture();
    bind(f, [LINKED]);
    renderPanel(f);
    const registry = f.viewer.registry as unknown as { getNode: (p: string) => unknown };
    const real = registry.getNode.bind(registry);
    registry.getNode = (path: string) => (path === 'Conveyor' ? undefined : real(path));

    fireEvent.click(screen.getByLabelText(/show Conveyor in scene/i));
    expect(f.focused).toEqual([]);
    expect(f.selected).toEqual([]);
  });
});

describe('filtering', () => {
  it('narrows the table to matching rows', () => {
    const f = makeFixture();
    bind(f, [LINKED]);
    renderPanel(f);
    expect(screen.getByText('PLC.Run')).toBeTruthy();

    fireEvent.change(screen.getByLabelText('Filter bindings'), { target: { value: 'nothing' } });
    expect(screen.queryByText('PLC.Run')).toBeNull();
  });
});

describe('lazy loading', () => {
  it('does not pull the panel into the button chunk', async () => {
    // The panel drags the whole binding inventory behind it; a viewer that
    // never opens the table must not pay for it at start-up.
    const source = (await import('../src/plugins/signal-bind/BindingsOverviewButton.tsx?raw')).default;
    expect(source).toContain('lazy(');
    expect(source).not.toMatch(/^import \{ BindingsOverviewPanel \}/m);
  });
});

// The store is shared across cases; a leaked binding would make the "nothing is
// linked" assertions order-dependent.
afterEach(() => vi.restoreAllMocks());
