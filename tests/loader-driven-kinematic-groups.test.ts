// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Only the kinematic groups a DRIVE moves are structure (2026-09-24).
 *
 * The Groups panel auto-excludes `result.kinematicGroupNames` and persists the
 * exclusion. A `Kinematic` with `IntegrateGroupEnable` and no drive is a rigid
 * group the operator toggles (Festo `Cover`), and it vanished from the panel
 * for good. `resolveDrivenKinematicGroupNames` is the narrower list the panel
 * excludes now; `resolveKinematicGroupNames` stays the full list for the
 * freeze pass and the editor.
 */
import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
import { GroupRegistry } from '../src/core/engine/rv-group-registry';
import { NodeRegistry } from '../src/core/engine/rv-node-registry';
import {
  resolveDrivenKinematicGroupNames, resolveKinematicGroupNames, type KinematicNodeEntry,
} from '../src/core/engine/rv-scene-loader';

function buildRegistry(root: Object3D): NodeRegistry {
  const reg = new NodeRegistry();
  root.traverse((node: Object3D) => reg.registerNode(NodeRegistry.computeNodePath(node), node));
  return reg;
}

function kin(name: string, data: Record<string, unknown>, rv: Record<string, unknown> = {}): { node: Object3D; entry: KinematicNodeEntry } {
  const node = new Object3D(); node.name = name;
  node.userData.realvirtual = { Kinematic: data, ...rv };
  return { node, entry: { node, data } };
}

describe('resolveDrivenKinematicGroupNames', () => {
  it('lists an axis with a Drive, not a drive-less Kinematic (the Festo Cover)', () => {
    const root = new Object3D(); root.name = 'Festo';
    const axis = kin('AxisLeft_Travel', { IntegrateGroupEnable: true, GroupName: 'AxisLeft_Travel' }, { Drive: { Direction: 'LinearX' } });
    const cover = kin('Cover', { IntegrateGroupEnable: true, GroupName: 'Cover' });
    const axisPart = new Object3D(); axisPart.name = 'Slide';
    const coverPart = new Object3D(); coverPart.name = 'E06780352_AF0';
    root.add(axis.node, cover.node, axisPart, coverPart);
    const groups = new GroupRegistry();
    groups.register('AxisLeft_Travel', axisPart);
    groups.register('Cover', coverPart);
    const registry = buildRegistry(root);
    const entries = [axis.entry, cover.entry];

    expect(resolveKinematicGroupNames(entries, groups, registry)).toEqual(['AxisLeft_Travel', 'Cover']);
    expect(resolveDrivenKinematicGroupNames(entries, groups, registry)).toEqual(['AxisLeft_Travel']);
  });

  it('counts a Drive on an ancestor and a KinematicParentEnable parent that is driven', () => {
    const root = new Object3D(); root.name = 'Festo';
    const travel = kin('AxisRight_Travel', { IntegrateGroupEnable: true, GroupName: 'AxisRight_Travel' }, { Drive: {} });
    // Lift physically under the driven travel axis (baked template).
    const lift = kin('AxisRight_Lift', { IntegrateGroupEnable: true, GroupName: 'AxisRight_Lift' });
    travel.node.add(lift.node);
    // Jaw NOT physically under its parent (authoring load) but pointing at it.
    const jaw = kin('RightJawRear', {
      IntegrateGroupEnable: true, GroupName: 'RightJawRear',
      // Registry paths are root-relative (`computeNodePath` stops at the scene root).
      KinematicParentEnable: true, Parent: 'AxisRight_Travel/AxisRight_Lift',
    });
    const loose = kin('Loose', { IntegrateGroupEnable: true, GroupName: 'Loose', KinematicParentEnable: true, Parent: 'Nowhere' });
    const parts: Object3D[] = [];
    for (const g of ['AxisRight_Travel', 'AxisRight_Lift', 'RightJawRear', 'Loose']) { const p = new Object3D(); p.name = g + 'Part'; parts.push(p); }
    root.add(travel.node, jaw.node, loose.node, ...parts);
    const groups = new GroupRegistry();
    ['AxisRight_Travel', 'AxisRight_Lift', 'RightJawRear', 'Loose'].forEach((g, i) => groups.register(g, parts[i]));
    const registry = buildRegistry(root);
    const entries = [travel.entry, lift.entry, jaw.entry, loose.entry];

    expect(resolveDrivenKinematicGroupNames(entries, groups, registry).sort())
      .toEqual(['AxisRight_Lift', 'AxisRight_Travel', 'RightJawRear']);
  });
});
