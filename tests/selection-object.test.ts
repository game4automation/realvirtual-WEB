// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-754 §9.12 — selection identity is the `Object3D` (D10).
 *
 * The registry stays the document's address book, so `selectedPaths` and
 * `primaryPath` keep their meaning: what the document can address. A node it
 * does not know — a chunk mesh, a light, a hover overlay — is still perfectly
 * selectable and simply contributes no path.
 *
 * Selection is also NOT persisted any more: `rv-extras-editor-selected` was a
 * global key across documents, so it restored a path from one model into
 * whichever model happened to load next. `rv-hierarchy-expanded` stays.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshBasicMaterial, Object3D, Scene } from 'three';
import { SelectionManager } from '../src/core/engine/rv-selection-manager';

function makeViewer() {
  const scene = new Scene();
  const robot = new Group(); robot.name = 'Robot';
  const axis = new Group(); axis.name = 'Axis1';
  const chunk = new Mesh(new BoxGeometry(), new MeshBasicMaterial());
  chunk.name = 'mover:Robot/Axis1|tex:deadbeef';
  chunk.userData._rvBakeChunk = true;
  axis.add(chunk);
  robot.add(axis);
  scene.add(robot);

  const paths = new Map<Object3D, string>([[robot, 'Robot'], [axis, 'Robot/Axis1']]);
  const byPath = new Map([...paths].map(([n, p]) => [p, n] as const));

  const emitted: Array<{ event: string; data: unknown }> = [];
  const viewer = {
    scene,
    highlighter: { highlightSelection: vi.fn(), clearSelection: vi.fn() },
    registry: {
      getNode: (p: string) => byPath.get(p) ?? null,
      getPathForNode: (n: Object3D) => paths.get(n) ?? null,
    },
    emit: vi.fn((event: string, data: unknown) => { emitted.push({ event, data }); }),
  };
  return { viewer, emitted, scene, robot, axis, chunk, paths };
}

describe('selection on Object3D (§9.12)', () => {
  let world: ReturnType<typeof makeViewer>;
  let sm: SelectionManager;

  beforeEach(() => {
    localStorage.clear();
    world = makeViewer();
    sm = new SelectionManager();
    sm.init(world.viewer as never);
  });

  it('selects an UNREGISTERED object and reports it with a null primaryPath', () => {
    sm.selectNode(world.chunk);

    const snap = sm.getSnapshot();
    expect(snap.nodes).toEqual([world.chunk]);
    expect(snap.primaryNode).toBe(world.chunk);
    expect(snap.primaryPath).toBeNull();
    expect(snap.selectedPaths).toEqual([]);
    expect(sm.count).toBe(1);
    expect(sm.isNodeSelected(world.chunk)).toBe(true);
  });

  it('still highlights an unregistered selection — it is a real object', () => {
    sm.selectNode(world.chunk);
    expect(world.viewer.highlighter.highlightSelection).toHaveBeenCalledWith(
      [world.chunk], { includeChildDrives: false },
    );
  });

  it('derives the path of a registered object, and re-derives it after a reparent', () => {
    sm.selectNode(world.axis);
    expect(sm.getSnapshot().primaryPath).toBe('Robot/Axis1');

    // The document re-addresses the node; the selection follows without reselect.
    world.paths.set(world.axis, 'Robot/Arm/Axis1');
    sm.selectNode(world.robot);
    sm.selectNode(world.axis);
    expect(sm.getSnapshot().primaryPath).toBe('Robot/Arm/Axis1');
  });

  it('mixes registered and unregistered in one selection; paths list only the known ones', () => {
    sm.selectNodes([world.axis, world.chunk]);

    const snap = sm.getSnapshot();
    expect(snap.nodes).toEqual([world.axis, world.chunk]);
    expect(snap.selectedPaths).toEqual(['Robot/Axis1']);
    expect(snap.primaryNode).toBe(world.chunk);
    expect(snap.primaryPath).toBeNull();
  });

  it('toggleNode adds and removes by object identity', () => {
    sm.selectNode(world.axis);
    sm.toggleNode(world.chunk);
    expect(sm.count).toBe(2);
    sm.toggleNode(world.chunk);
    expect(sm.count).toBe(1);
    expect(sm.isNodeSelected(world.axis)).toBe(true);
  });

  it('keeps the path API working — select(path) still resolves and reports', () => {
    sm.select('Robot/Axis1');
    expect(sm.getSnapshot().primaryPath).toBe('Robot/Axis1');
    expect(sm.getSnapshot().primaryNode).toBe(world.axis);
    expect(sm.isSelected('Robot/Axis1')).toBe(true);
  });

  it('emits selection-changed carrying both the objects and the paths', () => {
    sm.selectNode(world.chunk);
    const event = world.emitted.find((e) => e.event === 'selection-changed')!;
    expect(event.data).toMatchObject({ selectedPaths: [], primaryPath: null });
    expect((event.data as { nodes: Object3D[] }).nodes).toEqual([world.chunk]);
  });

  it('writes NOTHING to localStorage — selection is not persisted (D10)', () => {
    sm.selectNode(world.chunk);
    sm.select('Robot/Axis1');
    sm.clear();
    expect(localStorage.length).toBe(0);
    expect(localStorage.getItem('rv-extras-editor-selected')).toBeNull();
  });

  it('leaves rv-hierarchy-expanded alone — expansion IS still persisted', () => {
    localStorage.setItem('rv-hierarchy-expanded', JSON.stringify(['uuid-a', 'uuid-b']));
    sm.selectNode(world.chunk);
    sm.clear();
    expect(JSON.parse(localStorage.getItem('rv-hierarchy-expanded')!)).toEqual(['uuid-a', 'uuid-b']);
  });
});
