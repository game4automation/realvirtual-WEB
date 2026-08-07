// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * create-actions — node/component/signal/LogicStep creation for the
 * Kinematics window, ported from Unity QuickEdit's creation sections.
 *
 * Everything is op-logged through the AssetDocument: multi-step actions are
 * ONE composite undo unit (createNode + addComponent, createNode + reparent×N).
 */

import type { RVViewer } from '../../../core/rv-viewer';
import type { AssetDocument } from '../../../core/editor/rv-asset-document';
import { getSchemaDefaults } from '../../../core/engine/rv-component-registry';
import { SIGNAL_TYPES } from '../../../core/engine/rv-signal-construction';
import { NodeRegistry } from '../../../core/engine/rv-node-registry';
import type { RvExtrasEditorPlugin } from '../../../core/hmi/rv-extras-editor';
import { pruneDescendantPaths } from '../delete-selection';
import type { QuickEditContext } from './quick-edit-context';

// ─── Empties ────────────────────────────────────────────────────────────

/** Create an empty child under the context node (local zero) and select it. */
export async function createEmptyChild(viewer: RVViewer, doc: AssetDocument, parentPath: string | null): Promise<void> {
  const path = await doc.createEmptyNode(parentPath, 'Empty');
  viewer.selectionManager.select(path);
}

/** Create an empty node at the asset root and select it. */
export async function createEmptyAtRoot(viewer: RVViewer, doc: AssetDocument): Promise<void> {
  const path = await doc.createEmptyNode(null, 'Empty');
  viewer.selectionManager.select(path);
}

/**
 * Create an empty next to the selection and move all selected nodes into it
 * (world poses preserved). One undo unit; the new empty ends up selected.
 */
export async function groupIntoEmpty(viewer: RVViewer, doc: AssetDocument, selectedPaths: ReadonlyArray<string>): Promise<void> {
  const pruned = pruneDescendantPaths([...selectedPaths]);
  if (pruned.length === 0) return;
  const firstNode = viewer.registry?.getNode(pruned[0]);
  if (!firstNode?.parent) return;
  const parentPath = firstNode.parent === viewer.currentModelRoot
    ? null
    : NodeRegistry.computeNodePath(firstNode.parent);
  let emptyPath = '';
  await doc.withTransaction(`Group ${pruned.length} object${pruned.length > 1 ? 's' : ''} into empty`, async () => {
    emptyPath = await doc.createEmptyNode(parentPath, 'Group');
    // Bulk path: one composite for the whole selection. The per-node
    // `reparentNodes` costs a full hierarchy re-scan and a BVH classification PER
    // NODE, which is what made grouping a large CAD selection crawl (plan-359).
    await doc.reparentNodesBatch(pruned, emptyPath);
  });
  if (emptyPath) {
    viewer.selectionManager.select(emptyPath);
  }
}

// ─── Kinematics ─────────────────────────────────────────────────────────

/**
 * A name that is free as a group name, as a kinematic GroupName reference AND
 * as a top-level node name — the axis node and its group share the name (same
 * convention as groupSelection). Empty groups referenced only by a Kinematic
 * are not in the group registry, so the userData scan is required too.
 */
function nextKinematicName(viewer: RVViewer): string {
  const used = new Set<string>(viewer.groups?.getGroupNames() ?? []);
  const root = viewer.currentModelRoot;
  for (const child of root?.children ?? []) used.add(child.name);
  root?.traverse((node) => {
    const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
      Record<string, unknown> | undefined;
    if (!rv) return;
    for (const key of Object.keys(rv)) {
      if (!/^Kinematic(_\d+)?$/.test(key)) continue;
      const groupName = (rv[key] as Record<string, unknown> | undefined)?.['GroupName'];
      if (typeof groupName === 'string' && groupName) used.add(groupName);
    }
  });
  for (let i = 0; ; i++) {
    const candidate = i === 0 ? 'Kinematic' : `Kinematic_${i}`;
    if (!used.has(candidate)) return candidate;
  }
}

/**
 * "Add Kinematic" button action: create a new top-level axis node carrying a
 * Kinematic component linked to a fresh (still empty) group of the same name,
 * as one undo step, then select and reveal it. The caller arms Auto Assign so
 * the very next 3D clicks populate the group — a kinematic without members is
 * flagged amber in the list until then.
 */
export async function createKinematicWithGroup(
  viewer: RVViewer, doc: AssetDocument, nameOverride?: string,
): Promise<string> {
  const name = nameOverride?.trim() || nextKinematicName(viewer);
  let path = '';
  await doc.withTransaction(`Add kinematic "${name}"`, async () => {
    path = await doc.createEmptyNode(null, name);
    doc.addComponent(path, 'Kinematic', {
      ...getSchemaDefaults('Kinematic'),
      GroupName: name,
      IntegrateGroupEnable: true,
    });
  });
  if (path) {
    viewer.selectionManager.select(path);
    // Same reveal behavior as the auto-create path in groupSelection().
    viewer.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor')?.selectAndRevealExclusive(path);
  }
  return path;
}

// ─── Components ─────────────────────────────────────────────────────────

/** Add a component with schema defaults. `Drive` gets an explicit
 *  `Direction` (the schema has no default and the loader requires it). */
export function addComponentTo(doc: AssetDocument, nodePath: string, baseType: string): void {
  const fields = { ...getSchemaDefaults(baseType) };
  if (baseType === 'Drive' && fields['Direction'] === undefined) {
    fields['Direction'] = 'LinearX';
  }
  if (baseType === 'Kinematic') {
    fields['GroupName'] = fields['GroupName'] ?? '';
    fields['IntegrateGroupEnable'] = fields['IntegrateGroupEnable'] ?? false;
  }
  doc.addComponent(nodePath, baseType, fields);
}

// ─── Signals ────────────────────────────────────────────────────────────

/** Default Status payload for a signal type. */
function signalDefaults(sigType: string): Record<string, unknown> {
  return { Status: { Value: sigType.includes('Bool') ? false : 0 } };
}

/** Create a child node named after the signal type carrying the signal
 *  component (Unity parity: new signal GameObjects are children named after
 *  the component). Selects the new node. */
export async function createSignalNode(viewer: RVViewer, doc: AssetDocument, parentPath: string, sigType: string): Promise<void> {
  let nodePath = '';
  await doc.withTransaction(`Add ${sigType}`, async () => {
    nodePath = await doc.createEmptyNode(parentPath, sigType);
    doc.addComponent(nodePath, sigType, signalDefaults(sigType));
  });
  if (nodePath) viewer.selectionManager.select(nodePath);
}

/** The concrete rv_extras key of the signal on a node (`PLCOutputBool_1`). */
function findSignalKey(viewer: RVViewer, nodePath: string): string | null {
  const node = viewer.registry?.getNode(nodePath);
  const rv = (node?.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
    Record<string, unknown> | undefined;
  if (!rv) return null;
  for (const key of Object.keys(rv)) {
    if (SIGNAL_TYPES.includes(key.replace(/_\d+$/, ''))) return key;
  }
  return null;
}

/** Convert the selected signal to another datatype, keeping its direction
 *  and (where sensible) its value. Renames the node too when it still
 *  carries the old default name (Unity parity). */
export async function convertSignalType(
  viewer: RVViewer, doc: AssetDocument, signalNodePath: string, target: 'Bool' | 'Int' | 'Float',
): Promise<void> {
  const key = findSignalKey(viewer, signalNodePath);
  if (!key) return;
  const base = key.replace(/_\d+$/, '');
  const direction = base.startsWith('PLCOutput') ? 'PLCOutput' : 'PLCInput';
  const newType = `${direction}${target}`;
  if (base === newType) return;
  await swapSignalComponent(viewer, doc, signalNodePath, key, base, newType, `Convert to ${newType}`);
}

/** Flip the selected signal between PLC output and input, value preserved. */
export async function toggleSignalDirection(viewer: RVViewer, doc: AssetDocument, signalNodePath: string): Promise<void> {
  const key = findSignalKey(viewer, signalNodePath);
  if (!key) return;
  const base = key.replace(/_\d+$/, '');
  const newType = base.startsWith('PLCOutput')
    ? base.replace('PLCOutput', 'PLCInput')
    : base.replace('PLCInput', 'PLCOutput');
  await swapSignalComponent(viewer, doc, signalNodePath, key, base, newType, `Change direction to ${newType}`);
}

/** removeComponent(old) + addComponent(new) as one undo unit, migrating the
 *  fields; coerces Status.Value to the new datatype. Renames the node when
 *  it was still named after the old signal type. */
async function swapSignalComponent(
  viewer: RVViewer, doc: AssetDocument, nodePath: string,
  oldKey: string, oldBase: string, newType: string, label: string,
): Promise<void> {
  const node = viewer.registry?.getNode(nodePath);
  if (!node) return;
  const rv = (node.userData as Record<string, unknown>)['realvirtual'] as Record<string, unknown>;
  const oldFields = { ...(rv[oldKey] as Record<string, unknown> ?? {}) };
  const oldStatus = oldFields['Status'] as Record<string, unknown> | undefined;
  const oldValue = oldStatus?.['Value'];
  const toBool = newType.includes('Bool');
  const value = toBool
    ? Boolean(typeof oldValue === 'number' ? oldValue !== 0 : oldValue)
    : typeof oldValue === 'boolean' ? (oldValue ? 1 : 0) : Number(oldValue ?? 0);
  const fields = { ...oldFields, Status: { ...(oldStatus ?? {}), Value: value } };
  await doc.withTransaction(label, async () => {
    doc.removeComponent(nodePath, oldKey);
    doc.addComponent(nodePath, newType, fields);
    // Keep the node name in sync when it still carries the old default name.
    if (node.name === oldBase || node.name.startsWith(`${oldBase}_`)) {
      const suffix = node.name.slice(oldBase.length);
      doc.renameNode(nodePath, `${newType}${suffix}`, node.name);
    }
  });
}

// ─── LogicSteps ─────────────────────────────────────────────────────────

/** The Unity QuickEdit LogicStep palette — every entry is executable by the
 *  web logic engine (rv-logic-engine.ts). Defaults mirror its field reads. */
export const LOGIC_STEP_PALETTE: ReadonlyArray<{ type: string; label: string }> = [
  { type: 'LogicStep_SerialContainer', label: 'Serial Container' },
  { type: 'LogicStep_ParallelContainer', label: 'Parallel Container' },
  { type: 'LogicStep_DriveTo', label: 'Drive To' },
  { type: 'LogicStep_StartDriveTo', label: 'Start Drive' },
  { type: 'LogicStep_SetSignalBool', label: 'Set Signal' },
  { type: 'LogicStep_JumpOnSignal', label: 'Jump' },
  { type: 'LogicStep_WaitForSensor', label: 'Wait Sensor' },
  { type: 'LogicStep_WaitForSignalBool', label: 'Wait Signal' },
  { type: 'LogicStep_WaitForDrivesAtTarget', label: 'Wait Drives' },
  { type: 'LogicStep_Delay', label: 'Delay' },
  { type: 'LogicStep_Pause', label: 'Pause' },
];

const LOGIC_STEP_DEFAULTS: Record<string, Record<string, unknown>> = {
  LogicStep_SerialContainer: {},
  LogicStep_ParallelContainer: {},
  LogicStep_DriveTo: { Destination: 0, Relative: false },
  LogicStep_StartDriveTo: { Destination: 0, Relative: false },
  LogicStep_SetSignalBool: { SetToTrue: true },
  LogicStep_JumpOnSignal: { JumpOn: true, JumpToStep: '' },
  LogicStep_WaitForSensor: { WaitForOccupied: true },
  LogicStep_WaitForSignalBool: { WaitForTrue: true },
  LogicStep_WaitForDrivesAtTarget: { Drives: [] },
  LogicStep_Delay: { Duration: 1 },
  LogicStep_Pause: {},
};

/**
 * Add a LogicStep — Unity AddLogicStep semantics: when the context node has
 * no LogicStep yet the component goes onto the node itself; otherwise a new
 * sibling child node (named after the step) is created right after it, so
 * steps stay one-per-node in sequence order.
 */
export async function addLogicStep(viewer: RVViewer, doc: AssetDocument, ctx: QuickEditContext, stepType: string): Promise<void> {
  const node = ctx.node;
  const nodePath = ctx.nodePath;
  if (!node || !nodePath) return;
  const fields = { ...(LOGIC_STEP_DEFAULTS[stepType] ?? {}) };
  const shortName = stepType.replace('LogicStep_', '');

  if (!ctx.hasLogicStep) {
    doc.addComponent(nodePath, stepType, fields);
    return;
  }
  // Node already carries a step → new sibling right after it.
  const parent = node.parent;
  if (!parent) return;
  const parentPath = parent === viewer.currentModelRoot ? null : NodeRegistry.computeNodePath(parent);
  const index = parent.children.indexOf(node) + 1;
  let newPath = '';
  await doc.withTransaction(`Add ${shortName}`, async () => {
    newPath = await doc.createEmptyNode(parentPath, shortName, { index });
    doc.addComponent(newPath, stepType, fields);
  });
  if (newPath) viewer.selectionManager.select(newPath);
}
