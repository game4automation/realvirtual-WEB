// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * connection-registry-nested-owners.node.test.ts — plan-644 § 9.5.
 *
 * Phase 2.4 changed only the MATRIX updates of the headless registry build
 * (one refresh per root before sampling, none per snap). Ownership and the
 * pairing must stay exactly as before:
 *   - owners are scanned in the given order, the FIRST scanning owner keeps a
 *     snap (`register()` ignores a known id) — nested owners in normal and in
 *     reversed list order;
 *   - pairing samples the drives' HOME pose and restores the live pose;
 *   - every sampled position equals the per-snap `updateWorldMatrix(true,false)`
 *     + `getWorldPosition` of the former code (reference recomputed here),
 *     including rotated / scaled parents.
 * The fixture snapshot below is the result on the pre-change commit
 * (8702f28d), written out by hand from the ownership rule.
 */

import { describe, it, expect } from 'vitest';
import { Object3D, Quaternion, Vector3 } from 'three';
import {
  buildConnectionRegistry,
  pairRegistryByProximity,
  type HomePoseDrive,
} from '../../src/core/connect/rv-connection-registry';
import { SnapPointRegistry } from '../../src/core/engine/rv-snap-point-registry';
import { scanAndRegisterSnaps } from '../../src/core/connect/snap-scanner';
import { computeProximityPairings, SNAP_PAIR_EPS_M, type RebuildSnapInput } from '../../src/core/connect/snap-pairing';

function node(name: string, parent: Object3D | null, pos: [number, number, number] = [0, 0, 0]): Object3D {
  const o = new Object3D();
  o.name = name;
  o.position.set(...pos);
  parent?.add(o);
  return o;
}

/**
 * Scene: an outer cell (rotated 90° about Y, scaled) holding a nested inner
 * station; a conveyor feeding the cell; a turntable whose platform is a drive
 * currently rotated away from its home pose.
 */
function fixture() {
  const scene = node('Scene', null);
  const cell = node('Cell', scene, [2, 0, 0]);
  cell.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2);
  cell.scale.set(1.5, 1, 1.5);
  node('Snap-XN-Conv', cell, [-1, 0, 0]);          // cell in-port
  const inner = node('Inner', cell, [0.5, 0, 0]);
  node('Snap-XP-Conv', inner, [0.2, 0, 0]);        // inner out-port
  node('Snap-XN-Pallet', inner, [-0.2, 0, 0]);

  const conv = node('Conv', scene, [0, 0, 0]);
  // Cell in-port in world: cell (2,0,0) + R90y(scale(-1,0,0)) = (2,0,1.5).
  node('Snap-XP-Conv', conv, [2, 0, 1.5]);

  const tt = node('Turntable', scene, [5, 0, 0]);
  const platform = node('Platform', tt);
  node('Snap-XB-Conv', platform, [0.5, 0, 0]);
  // Inner out-port in world: cell origin + R90y(scale(0.5+0.2,0,0)) = (2, 0, -1.05).
  const feeder = node('Feeder', scene, [0, 0, 0]);
  node('Snap-XN-Conv', feeder, [5.5, 0, 0]);       // matches the platform port in HOME pose only
  node('Snap-XP-Conv', feeder, [2, 0, -1.05]);     // a second out port next to the inner out-port

  const homeQ = new Quaternion();
  platform.quaternion.setFromAxisAngle(new Vector3(0, 1, 0), Math.PI / 2); // live pose ≠ home
  const drive: HomePoseDrive = {
    node: platform,
    getHomeLocalPosition: (out: Vector3) => out.set(0, 0, 0),
    getHomeLocalQuaternion: (out: Quaternion) => out.copy(homeQ),
  };
  return { scene, cell, inner, conv, tt, platform, feeder, drive };
}

/** owner name per snap name (scene path), sorted — the ownership fingerprint. */
function ownership(reg: SnapPointRegistry): string[] {
  return reg.getAll().map((sp) => `${sp.scenePath}=>${sp.ownerRoot.name}`).sort();
}

/** paired snap ids rendered as `ownerA.snap~ownerB.snap`, sorted. */
function pairing(reg: SnapPointRegistry): string[] {
  const out = new Set<string>();
  for (const sp of reg.getAll()) {
    if (!sp.pairedSnapId) continue;
    const other = reg.getById(sp.pairedSnapId)!;
    const a = `${sp.ownerRoot.name}.${sp.object3D.name}`;
    const b = `${other.ownerRoot.name}.${other.object3D.name}`;
    out.add(a < b ? `${a}~${b}` : `${b}~${a}`);
  }
  return [...out].sort();
}

/** The former per-snap sampling (home pose), as reference pairing input. */
function referencePairs(owners: Object3D[], drives: HomePoseDrive[]): string[] {
  const reg = new SnapPointRegistry();
  for (const o of owners) scanAndRegisterSnaps(o, reg, o);
  const restore = drives.map((d) => ({ d, p: d.node.position.clone(), q: d.node.quaternion.clone() }));
  for (const d of drives) { d.getHomeLocalPosition(d.node.position); d.getHomeLocalQuaternion(d.node.quaternion); }
  for (const r of owners) r.updateWorldMatrix(true, true);
  const wp = new Vector3();
  const inputs: RebuildSnapInput[] = [];
  for (const sp of reg.getAll()) {
    sp.object3D.updateWorldMatrix(true, false);
    sp.object3D.getWorldPosition(wp);
    inputs.push({ id: sp.id, typeId: sp.typeId, flow: sp.flow, owner: sp.ownerRoot, x: wp.x, y: wp.y, z: wp.z });
  }
  for (const r of restore) { r.d.node.position.copy(r.p); r.d.node.quaternion.copy(r.q); }
  for (const r of owners) r.updateWorldMatrix(true, true);
  return computeProximityPairings(inputs, SNAP_PAIR_EPS_M).map(({ aId, bId }) => {
    const a = reg.getById(aId)!, b = reg.getById(bId)!;
    const x = `${a.ownerRoot.name}.${a.object3D.name}`, y = `${b.ownerRoot.name}.${b.object3D.name}`;
    return x < y ? `${x}~${y}` : `${y}~${x}`;
  }).sort();
}

describe('headless connection registry — nested owners (plan-644 § 9.5)', () => {
  it('outer before inner: the outer cell owns the inner snaps (first scanner wins)', () => {
    const f = fixture();
    const owners = [f.cell, f.inner, f.conv, f.tt, f.feeder];
    const reg = buildConnectionRegistry(owners, { drives: [f.drive] });
    expect(ownership(reg)).toHaveLength(7);
    // Explicit snapshot: owner per snap (parent/name keys are unique in the fixture).
    const byName = Object.fromEntries(reg.getAll().map((sp) => [`${sp.object3D.parent!.name}/${sp.object3D.name}`, sp.ownerRoot.name]));
    expect(byName).toEqual({
      'Cell/Snap-XN-Conv': 'Cell',
      'Inner/Snap-XP-Conv': 'Cell',
      'Inner/Snap-XN-Pallet': 'Cell',
      'Conv/Snap-XP-Conv': 'Conv',
      'Platform/Snap-XB-Conv': 'Turntable',
      'Feeder/Snap-XN-Conv': 'Feeder',
      'Feeder/Snap-XP-Conv': 'Feeder',
    });
    expect(pairing(reg)).toEqual(referencePairs(owners, [f.drive]));
  });

  it('inner before outer (reversed list): the inner station keeps its own snaps', () => {
    const f = fixture();
    const owners = [f.feeder, f.tt, f.conv, f.inner, f.cell];
    const reg = buildConnectionRegistry(owners, { drives: [f.drive] });
    const byName = Object.fromEntries(reg.getAll().map((sp) => [`${sp.object3D.parent!.name}/${sp.object3D.name}`, sp.ownerRoot.name]));
    expect(byName).toEqual({
      'Cell/Snap-XN-Conv': 'Cell',
      'Inner/Snap-XP-Conv': 'Inner',
      'Inner/Snap-XN-Pallet': 'Inner',
      'Conv/Snap-XP-Conv': 'Conv',
      'Platform/Snap-XB-Conv': 'Turntable',
      'Feeder/Snap-XN-Conv': 'Feeder',
      'Feeder/Snap-XP-Conv': 'Feeder',
    });
    expect(pairing(reg)).toEqual(referencePairs(owners, [f.drive]));
  });

  it('pairs in the HOME pose and restores the live pose', () => {
    const f = fixture();
    const liveQ = f.platform.quaternion.clone();
    const reg = buildConnectionRegistry([f.cell, f.inner, f.conv, f.tt, f.feeder], { drives: [f.drive] });
    const pairs = pairing(reg);
    expect(pairs).toContain('Feeder.Snap-XN-Conv~Turntable.Snap-XB-Conv'); // home-pose match
    expect(pairs).toContain('Cell.Snap-XN-Conv~Conv.Snap-XP-Conv');       // rotated + scaled parent
    expect(f.platform.quaternion.equals(liveQ)).toBe(true);
  });

  it('a snap outside every refreshed root still samples its own world position', () => {
    // Registry built by hand; roots cover only part of the snaps.
    const f = fixture();
    const reg = new SnapPointRegistry();
    for (const o of [f.cell, f.conv]) scanAndRegisterSnaps(o, reg, o);
    const n = pairRegistryByProximity(reg, { roots: [f.conv] }); // the cell is NOT a refreshed root
    expect(n).toBe(1);
    expect(pairing(reg)).toEqual(['Cell.Snap-XN-Conv~Conv.Snap-XP-Conv']);
  });
});
