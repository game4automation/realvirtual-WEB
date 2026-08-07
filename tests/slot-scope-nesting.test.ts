// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Slot-scope boundary for NESTED bindable components (robot axis chains).
 *
 * A kinematic chain `A1/A2/A3` carries a drive on every axis, and each axis is
 * offered as its own bind target. Aggregating the whole subtree would make each
 * ancestor repeat the slots of every axis below it (the A1 badge listing all
 * three axes, A2 listing A2+A3) — `'own'` scope stops at the first slot-owning
 * descendant. Planner placements keep aggregating (`'aggregate'`).
 */

import { describe, expect, it } from 'vitest';
import { Object3D, Scene } from 'three';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { constructDrive } from '../src/core/engine/rv-signal-construction';
import { resolveComponentRefs, type ComponentContext } from '../src/core/engine/rv-component-registry';
import {
  ownsBindableSlots,
  resolveBindableSlots,
} from '../src/core/engine/rv-binding-slot-resolver';
import { SignalBindingManager } from '../src/core/engine/rv-signal-binding-manager';
import { findSignalBindTarget, signalBindTargetId } from '../src/plugins/signal-bind/signal-bind-target';
import { computeRowQualifiers, slotRowKey } from '../src/core/hmi/rv-signal-slot-row';
import type { RVViewer } from '../src/core/rv-viewer';

/** Root `Cell` with an axis chain A1 > A2 > A3, each carrying a Drive_Simple. */
function buildAxisChain(axisNames: string[]) {
  const scene = new Scene();
  const root = new Object3D();
  root.name = 'Cell';
  root.userData.realvirtual = { LayoutObject: { Label: 'Cell' } };
  scene.add(root);

  const registry = new NodeRegistry();
  const store = new SignalStore();
  registry.registerNode('Cell', root);

  const nodes: Record<string, Object3D> = {};
  const pending: ReturnType<typeof constructDrive>[] = [];
  let parent = root;
  let parentPath = 'Cell';
  for (const name of axisNames) {
    const node = new Object3D();
    node.name = name;
    parent.add(node);
    const path = `${parentPath}/${name}`;
    const rv = { Drive: { Direction: 'LinearX' }, Drive_Simple: {} };
    node.userData.realvirtual = rv;
    registry.registerNode(path, node);
    pending.push(constructDrive(node, rv, rv.Drive, path, registry, store));
    nodes[name] = node;
    parent = node;
    parentPath = path;
  }

  // A plain mesh below the last axis — what the user actually clicks in 3D.
  const mesh = new Object3D();
  mesh.name = 'Housing';
  parent.add(mesh);
  registry.registerNode(`${parentPath}/Housing`, mesh);

  store.buildIndex();
  const ctx = { registry, signalStore: store, scene, root } as ComponentContext;
  for (const result of pending) {
    for (const entry of result?.pendingBehaviors ?? []) {
      resolveComponentRefs(entry.component as unknown as Record<string, unknown>, registry);
      registry.register(entry.type, entry.path, entry.component);
      entry.component.init(ctx);
    }
  }
  return { root, nodes, mesh, registry, store };
}

function makeViewer(registry: NodeRegistry, manager: SignalBindingManager): RVViewer {
  return {
    registry,
    signalBindingManager: manager,
    behaviors: { getActiveBinds: () => [] },
    getPlugin: () => undefined,
  } as unknown as RVViewer;
}

describe('slot scope on nested bindable components', () => {
  it('recognises an axis node as slot-owning, a plain mesh as not', () => {
    const { nodes, mesh, registry } = buildAxisChain(['A1', 'A2']);
    expect(ownsBindableSlots(nodes.A1, registry)).toBe(true);
    expect(ownsBindableSlots(mesh, registry)).toBe(false);
  });

  it("'own' scope returns only the node's own slots, not those of nested axes", () => {
    const { nodes, registry, store } = buildAxisChain(['A1', 'A2', 'A3']);

    const own = resolveBindableSlots(nodes.A1, store, registry, 'own');

    expect(own.length).toBeGreaterThan(0);
    // Every row belongs to A1 itself.
    expect(new Set(own.map((s) => (s.kind === 'unavailable' ? '.' : s.componentPath)))).toEqual(new Set(['.']));
  });

  it("'aggregate' scope keeps the whole subtree (Planner placements)", () => {
    const { root, registry, store } = buildAxisChain(['A1', 'A2', 'A3']);

    const paths = new Set(
      resolveBindableSlots(root, store, registry, 'aggregate')
        .map((s) => (s.kind === 'unavailable' ? '.' : s.componentPath)),
    );

    expect(paths).toEqual(new Set(['A1', 'A1/A2', 'A1/A2/A3']));
  });

  it('defaults to aggregate when no scope is given (unchanged legacy behavior)', () => {
    const { root, registry, store } = buildAxisChain(['A1', 'A2']);
    // Identity, not deep equality: direct-property rows carry freshly allocated
    // command closures per call, so only the row set is comparable.
    const identify = (rows: ReturnType<typeof resolveBindableSlots>) =>
      rows.map((s) => `${s.kind}:${s.kind === 'unavailable' ? '.' : s.componentPath}:${s.slot}`);

    expect(identify(resolveBindableSlots(root, store, registry)))
      .toEqual(identify(resolveBindableSlots(root, store, registry, 'aggregate')));
  });

  it('offers the nearest axis as bind target and lists only its slots', () => {
    const { nodes, mesh, registry, store } = buildAxisChain(['A1', 'A2', 'A3']);
    const manager = new SignalBindingManager(store, registry);
    const viewer = makeViewer(registry, manager);

    // Clicking the housing below A3 resolves to A3 …
    const target = findSignalBindTarget(viewer, mesh);
    expect(target).toMatchObject({ kind: 'node', nodePath: 'Cell/A1/A2/A3' });

    // … and A1's own badge (resolved the same way the badge scan does) no
    // longer repeats A2/A3.
    findSignalBindTarget(viewer, nodes.A1);
    const a1Slots = manager.getElementSlots('Cell/A1', nodes.A1);
    expect(a1Slots.length).toBeGreaterThan(0);
    expect(new Set(a1Slots.map((s) => (s.kind === 'unavailable' ? '.' : s.componentPath)))).toEqual(new Set(['.']));
    expect(signalBindTargetId(target!)).toBe('Cell/A1/A2/A3');
  });

  it('registers the scope once so later scope-less calls stay consistent', () => {
    const { nodes, registry, store } = buildAxisChain(['A1', 'A2']);
    const manager = new SignalBindingManager(store, registry);

    manager.getElementSlots('Cell/A1', nodes.A1, 'own');
    expect(manager.getElementScope('Cell/A1')).toBe('own');

    const later = manager.getElementSlots('Cell/A1', nodes.A1);
    expect(new Set(later.map((s) => (s.kind === 'unavailable' ? '.' : s.componentPath)))).toEqual(new Set(['.']));
  });
});

describe('computeRowQualifiers', () => {
  it('prefixes only slot names that repeat, using the owning component node', () => {
    const a5 = { slot: 'Position', componentPath: 'A5' };
    const a6 = { slot: 'Position', componentPath: 'A6' };
    const gripper = { slot: 'Out', componentPath: 'Gripper' };
    const qualifiers = computeRowQualifiers([a5, a6, gripper]);

    expect(qualifiers.get(slotRowKey({ componentPath: 'A5', slot: 'Position' }))).toBe('A5');
    expect(qualifiers.get(slotRowKey({ componentPath: 'A6', slot: 'Position' }))).toBe('A6');
    expect(qualifiers.has(slotRowKey({ componentPath: 'Gripper', slot: 'Out' }))).toBe(false);
  });

  it('uses the last path segment and falls back to the component type at the root', () => {
    const qualifiers = computeRowQualifiers([
      { slot: 'IsOccupied', componentPath: 'Frame/Sensors/S1' },
      { slot: 'IsOccupied', componentPath: '.', componentType: 'Sensor' },
    ]);

    expect(qualifiers.get(slotRowKey({ componentPath: 'Frame/Sensors/S1', slot: 'IsOccupied' }))).toBe('S1');
    expect(qualifiers.get(slotRowKey({ componentPath: '.', slot: 'IsOccupied' }))).toBe('Sensor');
  });
});
