// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * group-actions.ts — Group/Ungroup actions on the editor multi-selection.
 *
 * Backs the editor context menu's "Kinematic ▸" picker (also on the K
 * shortcut) and "Ungroup". Each action is ONE undo step (withTransaction).
 *
 * Group semantics mirror Unity's realvirtual.Group: a node can carry multiple
 * Group components (keys `Group`, `Group_1`, …) but never two with the same
 * GroupName — nodes already in the target group are skipped.
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { AssetDocument } from '../../core/editor/rv-asset-document';
import type { ContextMenuItem } from '../../core/hmi/context-menu-store';
import { assetOpHeader, dedupeComponentKey } from '../../core/editor/rv-asset-ops';
import { getGroupComponentKeys } from '../../core/engine/rv-group-sync';
import { getSchemaDefaults } from '../../core/engine/rv-component-registry';
import type { RvExtrasEditorPlugin } from '../../core/hmi/rv-extras-editor';
import { getActiveAssetContext } from './active-asset-store';

/** Kinematic component keys, tolerant of the `_N` dedup suffix. */
const KINEMATIC_KEY_RE = /^Kinematic(_\d+)?$/;

/** True when ANY Kinematic component in the live scene references the group.
 *  Scans userData directly (not GroupRegistry.isKinematic, which is only
 *  stamped at load time and misses Kinematics added during this edit session). */
export function sceneHasKinematicForGroup(viewer: RVViewer, groupName: string): boolean {
  const root = viewer.currentModelRoot;
  if (!root) return false;
  let found = false;
  root.traverse((node) => {
    if (found) return;
    const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
      Record<string, unknown> | undefined;
    if (!rv) return;
    for (const key of Object.keys(rv)) {
      if (!KINEMATIC_KEY_RE.test(key)) continue;
      const data = rv[key] as Record<string, unknown> | undefined;
      if (data && data['GroupName'] === groupName) { found = true; return; }
    }
  });
  return found;
}

/**
 * Member nodes of every group referenced by a Kinematic component on any of
 * the selected nodes. Backs the editor's selection-driven group preview:
 * selecting a kinematic axis overlay-highlights the meshes its group collects
 * (same visual as hovering the group in the Kinematics window's Groups list).
 */
export function kinematicGroupNodesForSelection(
  viewer: RVViewer,
  selectedPaths: readonly string[],
): Object3D[] {
  const groups = viewer.groups;
  if (!groups) return [];
  const members = new Set<Object3D>();
  for (const path of selectedPaths) {
    const node = viewer.registry?.getNode(path);
    const rv = (node?.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
      Record<string, unknown> | undefined;
    if (!rv) continue;
    for (const key of Object.keys(rv)) {
      if (!KINEMATIC_KEY_RE.test(key)) continue;
      const groupName = (rv[key] as Record<string, unknown> | undefined)?.['GroupName'];
      if (typeof groupName !== 'string' || !groupName) continue;
      for (const member of groups.get(groupName)?.nodes ?? []) members.add(member);
    }
  }
  return [...members];
}

/** True when the node already carries a Group component with this GroupName. */
export function nodeHasGroupNamed(node: Object3D, groupName: string): boolean {
  const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
    Record<string, unknown> | undefined;
  for (const key of getGroupComponentKeys(rv)) {
    const data = rv?.[key] as Record<string, unknown> | undefined;
    if (data && data['GroupName'] === groupName) return true;
  }
  return false;
}

/** Names of every group referenced by a Kinematic component anywhere in the
 *  scene. Scans userData directly (not GroupRegistry.isKinematic, which is only
 *  stamped at load time and misses Kinematics added during this edit session).
 *  Computed once per assign so the per-node replace check stays O(1). */
export function collectKinematicGroupNames(viewer: RVViewer): Set<string> {
  const names = new Set<string>();
  const root = viewer.currentModelRoot;
  if (!root) return names;
  root.traverse((node) => {
    const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
      Record<string, unknown> | undefined;
    if (!rv) return;
    for (const key of Object.keys(rv)) {
      if (!KINEMATIC_KEY_RE.test(key)) continue;
      const gn = (rv[key] as Record<string, unknown> | undefined)?.['GroupName'];
      if (typeof gn === 'string' && gn) names.add(gn);
    }
  });
  return names;
}

/** Group components on `node` whose group is a DIFFERENT kinematic group than
 *  `targetName`. Assigning an object to a kinematic removes these so it is never
 *  driven by two kinematics at once; NON-kinematic groups (visibility, highlight,
 *  …) are deliberately kept. Returns the keys + their fields for a removeComponent
 *  op (whose undo restores the exact component). */
export function kinematicGroupsToReplace(
  node: Object3D,
  targetName: string,
  kinematicGroupNames: ReadonlySet<string>,
): { componentType: string; prevFields: Record<string, unknown> }[] {
  const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
    Record<string, unknown> | undefined;
  const out: { componentType: string; prevFields: Record<string, unknown> }[] = [];
  for (const key of getGroupComponentKeys(rv)) {
    const data = rv?.[key] as Record<string, unknown> | undefined;
    if (!data || typeof data !== 'object') continue;
    const gname = data['GroupName'];
    if (typeof gname !== 'string' || !gname || gname === targetName) continue;
    if (!kinematicGroupNames.has(gname)) continue; // keep non-kinematic memberships
    out.push({ componentType: key, prevFields: { ...data } });
  }
  return out;
}

/** dedupeComponentKey for a new 'Group', treating `excludeKeys` as absent so a
 *  replaced kinematic Group's freed key can be reused for the new one. */
function dedupeGroupKeyExcluding(
  rv: Record<string, unknown> | undefined,
  excludeKeys: string[],
): string {
  if (!rv || excludeKeys.length === 0) return dedupeComponentKey(rv, 'Group');
  const projected: Record<string, unknown> = { ...rv };
  for (const k of excludeKeys) delete projected[k];
  return dedupeComponentKey(projected, 'Group');
}

/** Group names offered in the context menu (kinematic groups excluded). */
export function listGroupNamesForMenu(viewer: RVViewer): string[] {
  const groups = viewer.groups;
  if (!groups) return [];
  return groups.getGroupNames().filter((n) => !groups.isKinematic(n));
}

/**
 * Kinematics offered in the K picker: one entry per distinct group linked by
 * a Kinematic component, labeled with the axis node's name. Kinematics
 * without a GroupName are skipped (nothing to assign to yet).
 */
export function listKinematicsForMenu(viewer: RVViewer): { label: string; groupName: string }[] {
  const root = viewer.currentModelRoot;
  if (!root) return [];
  const byGroup = new Map<string, string>();
  root.traverse((node) => {
    const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
      Record<string, unknown> | undefined;
    if (!rv) return;
    for (const key of Object.keys(rv)) {
      if (!KINEMATIC_KEY_RE.test(key)) continue;
      const groupName = (rv[key] as Record<string, unknown> | undefined)?.['GroupName'];
      if (typeof groupName !== 'string' || !groupName || byGroup.has(groupName)) continue;
      byGroup.set(groupName, node.name || groupName);
    }
  });
  return [...byGroup]
    .map(([groupName, label]) => ({ label, groupName }))
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Menu items of the Kinematic picker: one entry per existing kinematic
 * (assigns the selection to its group) plus a "New kinematic…" input row
 * (creates the named kinematic axis + group and assigns the selection —
 * groupSelection does both in one undo step). Used by the context menu's
 * "Kinematic ▸" submenu AND the K keyboard shortcut (which opens the same
 * list standalone at the cursor via ContextMenuStore.openItems).
 */
export function buildKinematicMenuItems(viewer: RVViewer): ContextMenuItem[] {
  const selectedPaths = () => viewer.selectionManager.getSnapshot().selectedPaths;
  const apply = (name: string) => {
    const ctx = getActiveAssetContext();
    if (ctx) void groupSelection(viewer, ctx.doc, [...selectedPaths()], name);
  };
  return [
    ...listKinematicsForMenu(viewer).map(({ label, groupName }, i): ContextMenuItem => ({
      id: `editor.kinematic.${groupName}`,
      label,
      order: i,
      action: () => apply(groupName),
    })),
    {
      id: 'editor.kinematic.new',
      label: 'New kinematic…',
      order: 10_000,
      dividerBefore: true,
      input: {
        placeholder: 'Kinematic name',
        onSubmit: (value: string) => apply(value),
      },
    },
  ];
}

/** True when any selected node carries at least one Group component. */
export function selectionHasAnyGroup(viewer: RVViewer, nodePaths: string[]): boolean {
  for (const path of nodePaths) {
    const node = viewer.registry?.getNode(path);
    if (!node) continue;
    const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
      Record<string, unknown> | undefined;
    if (getGroupComponentKeys(rv).length > 0) return true;
  }
  return false;
}

/**
 * Add a Group component with the given name to every selected node.
 * Nodes that already belong to the group are skipped. One undo step.
 *
 * When no Kinematic component in the scene references the group yet, a new
 * top-level node named after the group is created in the same undo step,
 * gets a Kinematic component linked to the group (IntegrateGroupEnable),
 * and ends up selected — the axis object is ready for a Drive right away.
 */
export async function groupSelection(
  viewer: RVViewer,
  doc: AssetDocument,
  nodePaths: string[],
  groupName: string,
): Promise<void> {
  const name = groupName.trim();
  if (!name || nodePaths.length === 0) return;

  // Collect targets first — skip missing nodes and existing members. An object
  // already in ANOTHER kinematic group is MOVED here: its other kinematic Group
  // component(s) are removed so it isn't driven by two kinematics at once, while
  // any non-kinematic groups it belongs to are left intact.
  const kinNames = collectKinematicGroupNames(viewer);
  const targets: { nodePath: string; componentType: string; removals: { componentType: string; prevFields: Record<string, unknown> }[] }[] = [];
  for (const nodePath of nodePaths) {
    const node = viewer.registry?.getNode(nodePath);
    if (!node || nodeHasGroupNamed(node, name)) continue;
    const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
      Record<string, unknown> | undefined;
    const removals = kinematicGroupsToReplace(node, name, kinNames);
    const componentType = dedupeGroupKeyExcluding(rv, removals.map(r => r.componentType));
    targets.push({ nodePath, componentType, removals });
  }
  if (targets.length === 0) return;

  // Decide BEFORE mutating: does any Kinematic already own this group?
  const needsKinematic = !sceneHasKinematicForGroup(viewer, name);

  let kinematicPath = '';
  await doc.withTransaction(`Group ${targets.length} object(s) into "${name}"`, async () => {
    for (const { nodePath, componentType, removals } of targets) {
      // Move out of any other kinematic group first (one undo unit for all).
      for (const r of removals) {
        await doc.applyOp({
          ...assetOpHeader(),
          kind: 'removeComponent',
          nodePath,
          componentType: r.componentType,
          prevFields: r.prevFields,
        });
      }
      await doc.applyOp({
        ...assetOpHeader(),
        kind: 'addComponent',
        nodePath,
        componentType,
        fields: { GroupName: name },
      });
    }
    if (needsKinematic) {
      kinematicPath = await doc.createEmptyNode(null, name);
      doc.addComponent(kinematicPath, 'Kinematic', {
        ...getSchemaDefaults('Kinematic'),
        GroupName: name,
        IntegrateGroupEnable: true,
      });
    }
  });
  if (kinematicPath) {
    viewer.selectionManager.select(kinematicPath);
    // Focus the new axis node in the hierarchy: reveal it and collapse every
    // other top-level branch so it is the only open line of the tree.
    viewer.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor')?.selectAndRevealExclusive(kinematicPath);
  }
}

/**
 * Auto Assign: add the given nodes to the armed kinematic's group as ONE undo
 * step, then restore the kinematic as the selection. Nodes already in the
 * group, missing nodes, and other kinematic axes are skipped (boxing over a
 * kinematic must not fold it into another kinematic's group).
 *
 * Shared by both Auto Assign gestures — single 3D click and marquee.
 */
export async function autoAssignToKinematic(
  viewer: RVViewer,
  doc: AssetDocument,
  nodePaths: readonly string[],
  groupName: string,
  kinematicPath: string,
): Promise<void> {
  const kinNames = collectKinematicGroupNames(viewer);
  const targets: { nodePath: string; componentType: string; removals: { componentType: string; prevFields: Record<string, unknown> }[] }[] = [];
  for (const nodePath of nodePaths) {
    if (nodePath === kinematicPath) continue;
    const node = viewer.registry?.getNode(nodePath);
    if (!node || nodeHasGroupNamed(node, groupName)) continue;
    const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
      Record<string, unknown> | undefined;
    if (rv && Object.keys(rv).some((k) => KINEMATIC_KEY_RE.test(k))) continue;
    // Move the object out of any other kinematic group (keep non-kinematic ones).
    const removals = kinematicGroupsToReplace(node, groupName, kinNames);
    const componentType = dedupeGroupKeyExcluding(rv, removals.map(r => r.componentType));
    targets.push({ nodePath, componentType, removals });
  }
  if (targets.length === 0) {
    viewer.selectionManager.select(kinematicPath);
    return;
  }
  // Awaited so the group registry has every new member (and has applied the
  // group's hidden state) BEFORE the re-select refreshes the ghost overlay.
  await doc.withTransaction(
    `Assign ${targets.length} object(s) to "${groupName}"`,
    async () => {
      for (const { nodePath, componentType, removals } of targets) {
        for (const r of removals) {
          await doc.applyOp({
            ...assetOpHeader(),
            kind: 'removeComponent',
            nodePath,
            componentType: r.componentType,
            prevFields: r.prevFields,
          });
        }
        await doc.applyOp({
          ...assetOpHeader(),
          kind: 'addComponent',
          nodePath,
          componentType,
          fields: { GroupName: groupName },
        });
      }
    },
  );
  viewer.selectionManager.select(kinematicPath);
}

/**
 * Remove ALL Group components from every selected node. One undo step —
 * undo restores every component under its exact original key with its
 * original fields.
 */
export async function ungroupSelection(
  viewer: RVViewer,
  doc: AssetDocument,
  nodePaths: string[],
): Promise<void> {
  // Collect (path, key, prevFields) before mutating anything.
  const removals: { nodePath: string; componentType: string; prevFields: Record<string, unknown> }[] = [];
  for (const nodePath of nodePaths) {
    const node = viewer.registry?.getNode(nodePath);
    if (!node) continue;
    const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
      Record<string, unknown> | undefined;
    for (const key of getGroupComponentKeys(rv)) {
      const data = rv?.[key];
      const prevFields = data && typeof data === 'object'
        ? { ...(data as Record<string, unknown>) }
        : {};
      removals.push({ nodePath, componentType: key, prevFields });
    }
  }
  if (removals.length === 0) return;

  await doc.withTransaction(`Ungroup ${nodePaths.length} object(s)`, async () => {
    for (const { nodePath, componentType, prevFields } of removals) {
      await doc.applyOp({
        ...assetOpHeader(),
        kind: 'removeComponent',
        nodePath,
        componentType,
        prevFields,
      });
    }
  });
}
