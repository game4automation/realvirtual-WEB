// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Regression tests for DriveOrderPlugin.
 *
 * The plugin topologically sorts viewer.drives so CAM/Gear masters update before
 * their slaves. It rewrites the array IN PLACE (`length = 0` + `push`), which is
 * only safe when the sorted result is a DIFFERENT array instance.
 *
 * `topologicalSort` returns the SAME array when there is nothing to reorder (no
 * CAM/Gear dependencies at all). Emptying viewer.drives then also emptied the
 * "sorted" array (they alias), so the push re-added nothing and EVERY drive was
 * silently dropped from the simulation — drives stopped ticking and jog did
 * nothing. Models with no CAM/Gear behavior (e.g. a plain CAD import) lost all
 * of their drives.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { DriveOrderPlugin } from '../src/plugins/drive-order-plugin';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';

// NodeRegistry.computeNodePath() walks up via `parent`, so a DETACHED node
// resolves to '' — the drive nodes must hang off a scene root for the
// MasterDrive path refs to resolve at all.
const root = new Object3D();

function makeDrive(name: string, behaviorExtras: Record<string, unknown> = {}) {
  const node = new Object3D();
  node.name = name;
  root.add(node);
  return { name, node, BehaviorExtras: behaviorExtras } as any;
}

/** Minimal viewer stand-in. Since plan-411 the plugin also SUBSCRIBES to
 *  `drives-changed`, so the fake carries an `on` that hands back a disposer —
 *  the runtime-add case that subscription exists for lives in
 *  mechanism-drive-live.test.ts, this file stays about the sort itself. */
const load = (drives: any[]) => {
  const viewer = { drives, on: () => () => { /* no listener bookkeeping needed */ } } as any;
  new DriveOrderPlugin().onModelLoaded({} as any, viewer);
  return viewer;
};

describe('DriveOrderPlugin', () => {
  it('keeps every drive when there are no CAM/Gear dependencies (aliasing regression)', () => {
    const viewer = load([makeDrive('A'), makeDrive('B'), makeDrive('C')]);

    // Before the fix this was [] — all drives wiped.
    expect(viewer.drives).toHaveLength(3);
    expect(viewer.drives.map((d: any) => d.name)).toEqual(['A', 'B', 'C']);
  });

  it('does not drop a single lone drive', () => {
    const viewer = load([makeDrive('Solo')]);
    expect(viewer.drives.map((d: any) => d.name)).toEqual(['Solo']);
  });

  it('still orders a Gear master before its slave', () => {
    const master = makeDrive('Master');
    const masterPath = NodeRegistry.computeNodePath(master.node);
    const slave = makeDrive('Slave', { Drive_Gear: { MasterDrive: { path: masterPath } } });

    const viewer = load([slave, master]); // slave deliberately first

    expect(viewer.drives).toHaveLength(2);
    expect(viewer.drives.map((d: any) => d.name)).toEqual(['Master', 'Slave']);
  });

  it('still orders a CAM master before its slave', () => {
    const master = makeDrive('CamMaster');
    const masterPath = NodeRegistry.computeNodePath(master.node);
    const slave = makeDrive('CamSlave', { Drive_CAM: { MasterDrive: { path: masterPath } } });

    const viewer = load([slave, master]);

    expect(viewer.drives.map((d: any) => d.name)).toEqual(['CamMaster', 'CamSlave']);
  });
});
