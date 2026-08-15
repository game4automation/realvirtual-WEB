// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-418 Nachtrag — schema-DERIVED bind-target discovery.
 *
 * The regression this suite locks down: `PushButton3D`, `EmergencyButton3D`,
 * `HandleSwitch3D` and `Lamp` all declare `componentRef + signal` schema fields,
 * so `resolveBindableSlots()` has resolved their slots generically since
 * plan-325 — but discovery scanned a HAND-WRITTEN key list that nobody extended
 * when those components arrived. Result: no link-mode badge and no drop target
 * on any button or lamp ("why don't we have connector icons for buttons and
 * lamps?"). The key list is now derived from the same schema rule the resolver
 * uses, so the two cannot drift apart again.
 *
 * Both discovery entry points are exercised, as in bindable-targets-plc.test.ts:
 * the badge scan (`enumerateAllBindableTargets`) and the drag scan
 * (`enumerateCompatibleTargets`).
 *
 * The buttons come from the shared plan-417 harness, i.e. through the REAL
 * loader pipeline (`processExtras`), not from hand-wired instances.
 */

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { RVLamp } from '../src/core/engine/rv-lamp';
import {
  bindingSlotRvKeys,
  hasResolverComponent,
} from '../src/core/engine/rv-binding-slot-resolver';
import type { ComponentContext } from '../src/core/engine/rv-component-registry';
import { enumerateAllBindableTargets } from '../src/plugins/signal-bind/bindable-targets';
import { enumerateCompatibleTargets } from '../src/plugins/signal-bind/compatible-targets';
import { buildButtonScene, PATHS } from './scene-button-fixture';
import type { RVViewer } from '../src/core/rv-viewer';

function viewerOf(
  registry: NodeRegistry,
  manager: SignalBindingManager,
  planner?: unknown,
): RVViewer {
  return {
    registry,
    signalBindingManager: manager,
    behaviors: { getActiveBinds: () => [] },
    getPlugin: (id: string) => (id === 'layout-planner' ? planner : undefined),
  } as unknown as RVViewer;
}

/** A Lamp with its `SignalLampOn` wired, registered the way the loader does. */
function lampFixture() {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Cell';
  scene.add(root);

  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Cell', root);

  const node = new Object3D();
  node.name = 'SignalLamp';
  root.add(node);
  node.userData.realvirtual = { Lamp: { OnColor: { r: 1, g: 0.7, b: 0, a: 1 } } };
  registry.registerNode('Cell/SignalLamp', node);

  store.register('LampOn', 'Cell/PLCInterface/LampOn', false);
  store.buildIndex();

  const lamp = new RVLamp(node);
  lamp.SignalLampOn = 'Cell/PLCInterface/LampOn';
  lamp.init({ scene, root, registry, signalStore: store } as ComponentContext);
  registry.register('Lamp', 'Cell/SignalLamp', lamp);

  return { scene, root, node, registry, store };
}

const BOOL_OUTPUT_PAYLOAD = {
  name: 'PLC.LampOn',
  interfaceId: 'plc',
  direction: 'output' as const,
  origin: 'connect' as const,
  plcType: 'PLCOutputBool',
};

const BOOL_INPUT_PAYLOAD = {
  name: 'PLC.ButtonPressed',
  interfaceId: 'plc',
  direction: 'input' as const,
  origin: 'connect' as const,
  plcType: 'PLCInputBool',
};

describe('derived discovery key list', () => {
  it('contains every registered schema type that declares a signal slot', () => {
    lampFixture();                 // ensures the Lamp module registered
    buildButtonScene();            // ensures the button modules registered
    const keys = bindingSlotRvKeys();

    for (const type of ['PushButton3D', 'EmergencyButton3D', 'HandleSwitch3D', 'Lamp']) {
      expect(keys, `${type} must be discoverable`).toContain(type);
    }
    // The pre-existing entries are derived by the same rule, not lost.
    for (const type of ['Drive_Simple', 'Drive_Cylinder', 'Drive_DestinationMotor', 'Sensor']) {
      expect(keys).toContain(type);
    }
    // Synthetic (descriptor-driven, no schema signal fields) — still explicit.
    expect(keys).toContain('Conveyor');
    expect(keys).toContain('ConveyorBehavior');
    // Raw PLC signal nodes (plan-418).
    expect(keys).toContain('PLCOutputBool');
    expect(keys).toContain('PLCInputFloat');
  });

  it('excludes registered types without signal slots', () => {
    buildButtonScene();
    const keys = bindingSlotRvKeys();
    // SceneButtonBase is the click target and carries no signal slot of its own
    // (stateSignal lives on the wrappers) — it must not become a bind target.
    expect(keys).not.toContain('SceneButtonBase');
    expect(keys).not.toContain('SceneButtonMoveable');
    expect(keys).not.toContain('Drive');
  });
});

describe('discovery pre-filter on buttons and lamps', () => {
  it('accepts a button wrapper node and rejects its inner click target', () => {
    const h = buildButtonScene();
    const wrapper = h.registry.getNode(PATHS.pushWrapper)!;
    const base = h.registry.getNode(PATHS.pushBase)!;

    expect(hasResolverComponent(wrapper)).toBe(true);
    expect(hasResolverComponent(base)).toBe(false);
  });

  it('accepts a Lamp node', () => {
    const f = lampFixture();
    expect(hasResolverComponent(f.node)).toBe(true);
    expect(hasResolverComponent(f.root)).toBe(false);
  });
});

describe('enumerateAllBindableTargets with buttons and lamps', () => {
  it('lists all three button wrappers as their own node targets', () => {
    const h = buildButtonScene();
    const manager = new SignalBindingManager(h.signalStore, h.registry);
    const ids = enumerateAllBindableTargets(viewerOf(h.registry, manager)).map((t) => t.id);

    expect(ids).toContain(PATHS.pushWrapper);
    expect(ids).toContain(PATHS.emergencyWrapper);
    expect(ids).toContain(PATHS.handleWrapper);
    // The click target below the wrapper is NOT a target of its own.
    expect(ids).not.toContain(PATHS.pushBase);
  });

  it('offers the push button its two wired schema slots', () => {
    const h = buildButtonScene();
    const manager = new SignalBindingManager(h.signalStore, h.registry);
    const wrapper = h.registry.getNode(PATHS.pushWrapper)!;

    const slots = manager.getElementSlots(PATHS.pushWrapper, wrapper, 'own');
    expect(slots.filter((s) => s.kind === 'mapped-signal').map((s) => s.slot).sort())
      .toEqual(['lightSignal', 'stateSignal']);
    // Signal direction follows the PLC convention of the schema field.
    const state = slots.find((s) => s.kind !== 'unavailable' && s.slot === 'stateSignal')!;
    const light = slots.find((s) => s.kind !== 'unavailable' && s.slot === 'lightSignal')!;
    expect(state).toMatchObject({ direction: 'plcInput', type: 'bool', componentType: 'PushButton3D' });
    expect(light).toMatchObject({ direction: 'plcOutput', type: 'bool', componentType: 'PushButton3D' });
  });

  it('lists a Lamp node with its SignalLampOn slot', () => {
    const f = lampFixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    const targets = enumerateAllBindableTargets(viewerOf(f.registry, manager));

    expect(targets.map((t) => t.id)).toEqual(['Cell/SignalLamp']);
    expect(targets[0].kind).toBe('node');
    const slots = manager.getElementSlots('Cell/SignalLamp', f.node, 'own');
    expect(slots.find((s) => s.kind === 'mapped-signal' && s.slot === 'SignalLampOn'))
      .toMatchObject({ targetName: 'LampOn', direction: 'plcOutput', type: 'bool' });
  });

  it('keeps Planner placement aggregation unchanged — one target, inner slots on it', () => {
    const h = buildButtonScene();
    const manager = new SignalBindingManager(h.signalStore, h.registry);
    const planner = {
      store: { getSnapshot: () => ({ placed: [{ id: 'placed-cell' }] }) },
      getPlacedRootById: () => h.root,
      findPlacedAncestor: (node: Object3D) => {
        for (let cur: Object3D | null = node; cur; cur = cur.parent) {
          if (cur === h.root) return { id: 'placed-cell', root: h.root };
        }
        return null;
      },
    };

    const targets = enumerateAllBindableTargets(viewerOf(h.registry, manager, planner));
    expect(targets.map((t) => t.id)).toEqual(['placed-cell']);

    // The newly discovered button components must not ADD rows to a placement:
    // aggregate resolution is de-duplicated by store name, and the demo's four
    // PLC signal nodes sit before the buttons in the subtree, so each of the
    // three wired button signals is already represented by its signal node's
    // `Value` row. One row per store name, exactly as before this change.
    const names = manager.getElementSlots('placed-cell', h.root, 'aggregate')
      .filter((s) => s.kind === 'mapped-signal')
      .map((s) => s.targetName);
    expect(new Set(names).size).toBe(names.length);
    expect(new Set(names)).toEqual(
      new Set(['AutomaticButton', 'AutomaticLight', 'EmergencyButton', 'OnSwitch']),
    );
  });
});

describe('enumerateCompatibleTargets with buttons and lamps', () => {
  it('offers the lamp for a PLC-output Bool payload', () => {
    const f = lampFixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    const compatible = enumerateCompatibleTargets(viewerOf(f.registry, manager), BOOL_OUTPUT_PAYLOAD);

    expect(compatible.map((t) => t.id)).toEqual(['Cell/SignalLamp']);
    expect(compatible[0].compatibleSlotCount).toBe(1);
  });

  it('rejects a viewer→PLC payload on the lamp (direction check)', () => {
    const f = lampFixture();
    const manager = new SignalBindingManager(f.store, f.registry);
    expect(enumerateCompatibleTargets(viewerOf(f.registry, manager), BOOL_INPUT_PAYLOAD)).toEqual([]);
  });

  it('splits the button wrappers by slot direction', () => {
    const h = buildButtonScene();
    const manager = new SignalBindingManager(h.signalStore, h.registry);
    const viewer = viewerOf(h.registry, manager);

    // stateSignal is a PLCInput on all three wrappers (viewer writes it).
    const inputs = enumerateCompatibleTargets(viewer, BOOL_INPUT_PAYLOAD).map((t) => t.id);
    expect(inputs).toContain(PATHS.pushWrapper);
    expect(inputs).toContain(PATHS.emergencyWrapper);
    expect(inputs).toContain(PATHS.handleWrapper);

    // Only the push button has a lightSignal (PLCOutput).
    const outputs = enumerateCompatibleTargets(viewer, BOOL_OUTPUT_PAYLOAD).map((t) => t.id);
    expect(outputs).toContain(PATHS.pushWrapper);
    expect(outputs).not.toContain(PATHS.emergencyWrapper);
    expect(outputs).not.toContain(PATHS.handleWrapper);
  });
});
