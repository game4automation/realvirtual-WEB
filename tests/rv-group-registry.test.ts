// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D } from 'three';
import { GroupRegistry, ISOLATE_FOCUS_LAYER } from '../src/core/engine/rv-group-registry';

/** True if `node.layers` has the ISOLATE_FOCUS_LAYER bit enabled. */
function hasFocusLayer(node: Object3D): boolean {
  return (node.layers.mask & (1 << ISOLATE_FOCUS_LAYER)) !== 0;
}

describe('GroupRegistry', () => {
  let registry: GroupRegistry;

  beforeEach(() => {
    registry = new GroupRegistry();
  });

  it('registers nodes under a group name', () => {
    const node = new Object3D();
    registry.register('Conveyors', node);
    const groups = registry.getAll();
    expect(groups).toHaveLength(1);
    expect(groups[0].name).toBe('Conveyors');
    expect(groups[0].nodes).toContain(node);
  });

  it('registers multiple nodes under same group', () => {
    const a = new Object3D();
    const b = new Object3D();
    registry.register('Conveyors', a);
    registry.register('Conveyors', b);
    expect(registry.get('Conveyors')!.nodes).toHaveLength(2);
  });

  it('registers same node in multiple groups', () => {
    const node = new Object3D();
    registry.register('Conveyors', node);
    registry.register('Entry', node);
    expect(registry.getGroupNames()).toContain('Conveyors');
    expect(registry.getGroupNames()).toContain('Entry');
  });

  it('setVisible hides group root nodes only (no traverse)', () => {
    const root = new Object3D();
    const child = new Object3D();
    child.visible = true;
    root.add(child);
    registry.register('Robots', root);

    registry.setVisible('Robots', false);
    expect(root.visible).toBe(false);
    // Child retains its own visible state — Three.js skips subtree via parent
    expect(child.visible).toBe(true);
  });

  it('setVisible restores root visibility', () => {
    const node = new Object3D();
    registry.register('Robots', node);
    registry.setVisible('Robots', false);
    registry.setVisible('Robots', true);
    expect(node.visible).toBe(true);
  });

  it('isolate tags only target group subtree with focus layer', () => {
    const a = new Object3D();
    const b = new Object3D();
    const bChild = new Object3D();
    b.add(bChild);
    registry.register('Conveyors', a);
    registry.register('Robots', b);

    registry.isolate('Robots');

    // Isolate state reflects the call.
    expect(registry.isIsolateActive).toBe(true);
    expect(registry.isolatedGroupName).toBe('Robots');
    // Non-target group visibility is left alone — the viewer renders the
    // dim backdrop via camera layers, not visibility culling.
    expect(a.visible).toBe(true);
    expect(b.visible).toBe(true);
    // Focus layer is set on the target subtree only.
    expect(hasFocusLayer(b)).toBe(true);
    expect(hasFocusLayer(bChild)).toBe(true);
    expect(hasFocusLayer(a)).toBe(false);
  });

  it('isolate force-shows a defaultHidden target', () => {
    const a = new Object3D(); a.visible = false;
    registry.register('HiddenGroup', a);
    registry.setDefaultHiddenGroups(['HiddenGroup']);

    registry.isolate('HiddenGroup');

    // Force-visible so the focus pass isn't culled by Three.js before
    // layer testing kicks in.
    expect(a.visible).toBe(true);
    expect(hasFocusLayer(a)).toBe(true);
  });

  it('showAll clears focus layer and restores prior visibility', () => {
    const a = new Object3D();
    const b = new Object3D();
    const bChild = new Object3D();
    b.add(bChild);
    registry.register('Conveyors', a);
    registry.register('Robots', b);

    registry.isolate('Robots');
    registry.showAll();

    expect(registry.isIsolateActive).toBe(false);
    expect(registry.isolatedGroupName).toBeNull();
    expect(a.visible).toBe(true);
    expect(b.visible).toBe(true);
    expect(hasFocusLayer(b)).toBe(false);
    expect(hasFocusLayer(bChild)).toBe(false);
  });

  it('sequential isolate calls swap the focus layer', () => {
    const a = new Object3D();
    const b = new Object3D();
    registry.register('A', a);
    registry.register('B', b);

    registry.isolate('A');
    expect(hasFocusLayer(a)).toBe(true);
    expect(hasFocusLayer(b)).toBe(false);
    expect(registry.isolatedGroupName).toBe('A');

    registry.isolate('B');
    expect(hasFocusLayer(a)).toBe(false);
    expect(hasFocusLayer(b)).toBe(true);
    expect(registry.isolatedGroupName).toBe('B');
  });

  it('setVisible on unknown group is a no-op', () => {
    expect(() => registry.setVisible('NonExistent', false)).not.toThrow();
  });

  it('clear removes all groups', () => {
    registry.register('A', new Object3D());
    registry.clear();
    expect(registry.getAll()).toHaveLength(0);
  });

  // ── Kinematic group tracking ──

  it('markAsKinematic + isKinematic round-trip', () => {
    const node = new Object3D();
    registry.register('RobotArm', node);
    expect(registry.isKinematic('RobotArm')).toBe(false);
    registry.markAsKinematic('RobotArm');
    expect(registry.isKinematic('RobotArm')).toBe(true);
  });

  it('isKinematic returns false for unknown group', () => {
    expect(registry.isKinematic('NonExistent')).toBe(false);
  });

  it('markAsKinematic on unregistered group is no-op', () => {
    registry.markAsKinematic('Ghost');
    expect(registry.isKinematic('Ghost')).toBe(false);
  });

  it('getKinematicGroupNames returns only marked groups', () => {
    registry.register('A', new Object3D());
    registry.register('B', new Object3D());
    registry.markAsKinematic('A');
    expect(registry.getKinematicGroupNames()).toEqual(['A']);
  });

  it('clear removes kinematic group tracking', () => {
    registry.register('A', new Object3D());
    registry.markAsKinematic('A');
    registry.clear();
    expect(registry.isKinematic('A')).toBe(false);
    expect(registry.getKinematicGroupNames()).toEqual([]);
  });

  it('showAll respects defaultHiddenGroups', () => {
    const nodeA = new Object3D(); nodeA.name = 'A';
    const nodeB = new Object3D(); nodeB.name = 'B';
    registry.register('GroupA', nodeA);
    registry.register('GroupB', nodeB);
    registry.setDefaultHiddenGroups(['GroupB']);

    registry.isolate('GroupA');  // hides GroupB
    registry.showAll();          // should restore GroupA but keep GroupB hidden

    expect(registry.get('GroupA')!.visible).toBe(true);
    expect(registry.get('GroupB')!.visible).toBe(false);
  });
});
