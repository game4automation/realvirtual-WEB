// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { constructDrive } from '../src/core/engine/rv-signal-construction';
import {
  resolveComponentRefs,
  type ComponentContext,
} from '../src/core/engine/rv-component-registry';
import {
  resolveBindableSlots,
  type UnavailableSlot,
} from '../src/core/engine/rv-binding-slot-resolver';
import { enumerateCompatibleTargets } from '../src/plugins/signal-bind/compatible-targets';
import { SignalBindPopover } from '../src/plugins/signal-bind/SignalBindPopover';
import type { RVViewer } from '../src/core/rv-viewer';

afterEach(cleanup);

function missingContractFixture() {
  const scene = new Scene();
  const node = new Object3D();
  node.name = 'Axis';
  scene.add(node);
  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Axis', node);
  const rv = { Drive: { Direction: 'LinearX' }, Drive_Simple: {} };
  node.userData.realvirtual = rv;
  const result = constructDrive(node, rv, rv.Drive, 'Axis', registry, store)!;
  const pending = result.pendingBehaviors[0];
  const component = pending.component as unknown as Record<string, unknown>;
  component.commandSpeed = undefined;
  registry.register(pending.type, pending.path, pending.component);
  resolveComponentRefs(component, registry);
  pending.component.init({ registry, signalStore: store, scene, root: node } as ComponentContext);
  return { node, registry, store };
}

describe('unavailable slot contract', () => {
  it('returns the canonical unavailable shape when a runtime contract is missing', () => {
    const f = missingContractFixture();
    const slot = resolveBindableSlots(f.node, f.store, f.registry)
      .find((candidate) => candidate.slot === 'Speed');

    expect(slot).toEqual({
      kind: 'unavailable',
      slot: 'Speed',
      reason: 'Missing command contract for Drive_Simple.Speed',
    });
  });

  it('renders the reason but exposes no picker, drop target or auto assignment', () => {
    const onBind = vi.fn();
    const unavailable: UnavailableSlot = {
      kind: 'unavailable',
      slot: 'Speed',
      reason: 'Missing command contract for Drive_Simple.Speed',
    };
    render(<SignalBindPopover
      label="Axis"
      slots={[unavailable]}
      signals={[{ name: 'Speed', interfaceId: 'plc', direction: 'output', dataType: 'PLCOutputFloat' }]}
      state="unbound"
      onBind={onBind}
      onUnbind={vi.fn()}
      onClose={vi.fn()}
    />);

    const row = screen.getByTestId('slot-row-unavailable-Speed');
    expect(row.textContent).toContain('Missing command contract for Drive_Simple.Speed');
    expect(row.getAttribute('data-rv-slot-kind')).toBe('unavailable');
    expect(screen.queryByLabelText('signal for Speed')).toBeNull();
    // Bulk actions live in the component-section header since plan-325 F5.
    expect(screen.queryByText('Auto-assign')).toBeNull();
    expect(onBind).not.toHaveBeenCalled();
  });

  it('excludes unavailable slots from scene drag compatibility', () => {
    const node = new Object3D();
    node.name = 'Axis';
    node.userData.realvirtual = { Drive_Simple: {} };
    new Scene().add(node);
    const registry = new NodeRegistry();
    registry.registerNode('Axis', node);
    const manager = {
      getElementSlots: () => [{
        kind: 'unavailable',
        slot: 'Speed',
        reason: 'Missing command contract',
      }],
    };
    const viewer = {
      registry,
      signalBindingManager: manager,
      behaviors: { getActiveBinds: () => [] },
      getPlugin: () => undefined,
    } as unknown as RVViewer;

    expect(enumerateCompatibleTargets(viewer, {
      name: 'Speed',
      interfaceId: 'plc',
      direction: 'output',
      origin: 'connect' as const,
      plcType: 'PLCOutputFloat',
    })).toEqual([]);
  });

  it('rejects unavailable mappings from bind and persistence output', () => {
    const f = missingContractFixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    const mapping = {
      kind: 'direct-property' as const,
      componentPath: '.',
      slot: 'Speed',
      signal: 'PLC.Speed',
      interfaceId: 'plc',
      direction: 'plcOutput' as const,
      enabled: true,
    };

    manager.bind('axis', f.node, mapping);
    expect(manager.getBindingLiveness('axis', 'Speed', '.')).toBeUndefined();
    expect(manager.applyMappings('axis', f.node, [mapping])).toEqual([]);
    expect(manager.getLinkedSourceNames()).toEqual(new Set());
  });

  it('explains the no-model-signal case in user terms without the word "Direct"', async () => {
    render(<SignalBindPopover
      label="Axis"
      slots={[{
        kind: 'direct-property',
        componentPath: '.',
        slot: 'Speed',
        type: 'float',
        direction: 'plcOutput',
        aliases: [],
      }]}
      signals={[]}
      state="unbound"
      onBind={vi.fn()}
      onUnbind={vi.fn()}
      onClose={vi.fn()}
    />);

    // plan-325 §2.4: the word "Direct" left the UI; the explanation moved to a
    // row tooltip phrased in the user's domain.
    expect(screen.queryByText('Direct')).toBeNull();
    const row = screen.getByTestId('slot-row-.-direct-property-Speed');
    fireEvent.mouseOver(row.firstElementChild as Element);
    expect(await screen.findByText(/no model signal — values go straight to the component/i))
      .toBeTruthy();
    expect(screen.queryByText(/Missing command contract/)).toBeNull();
  });
});
