// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-reference-field.ts — which structural reference fields the inspector lets
 * an author PICK in the editor, and what they may point at.
 *
 * A logic step, a Grip or a Gear drive names its target through a
 * `ComponentReference` field (`LogicStep_WaitForSensor.Sensor`,
 * `LogicStep_DriveTo.drive`, `Grip.SignalPick`, …). Before this module the
 * inspector showed such a field only when the GLB already carried a value, and
 * then read-only — a sequence built in the editor could not be wired by hand.
 *
 * Signal SLOTS (`desc.signal`) are not handled here: they have their own row
 * (SignalSlotRow, plan-325). This module covers the plain references.
 *
 * Target type: the rv-ODT `refType` keyword where the schema has one, else the
 * small table below. Fields without a known target stay as they were — never a
 * guessed picker. Pure and React-free: unit-testable.
 */

import type { Object3D } from 'three';
import { getFieldDescriptor, getRawOdtDef } from '../engine/rv-component-registry';

/** What a reference field may point at. */
export type ReferenceTarget =
  | { readonly kind: 'component'; readonly componentType: string }
  | { readonly kind: 'signal'; readonly signalTypes: readonly string[] };

const BOOL_SIGNALS: ReferenceTarget = { kind: 'signal', signalTypes: ['PLCInputBool', 'PLCOutputBool'] };
const FLOAT_SIGNALS: ReferenceTarget = { kind: 'signal', signalTypes: ['PLCInputFloat', 'PLCOutputFloat'] };
const DRIVE: ReferenceTarget = { kind: 'component', componentType: 'Drive' };

/**
 * Targets for reference fields whose schema entry carries no `refType`. Keyed
 * `Component.field`. Only the fields the Quick Edit palette creates components
 * for — the author must be able to finish what the panel started.
 */
const FALLBACK_TARGETS: Readonly<Record<string, ReferenceTarget>> = {
  'LogicStep_WaitForSensor.Sensor': { kind: 'component', componentType: 'Sensor' },
  'LogicStep_DriveTo.drive': DRIVE,
  'LogicStep_StartDriveTo.drive': DRIVE,
  'LogicStep_DriveToPosition.drive': DRIVE,
  'LogicStep_SetDriveSpeed.drive': DRIVE,
  'LogicStep_StartDriveSpeed.drive': DRIVE,
  'LogicStep_SetSignalBool.Signal': BOOL_SIGNALS,
  'LogicStep_WaitForSignalBool.Signal': BOOL_SIGNALS,
  'LogicStep_JumpOnSignal.Signal': BOOL_SIGNALS,
  'LogicStep_SetSignalFloat.Signal': FLOAT_SIGNALS,
  'LogicStep_WaitForSignalFloat.Signal': FLOAT_SIGNALS,
  'LogicStep_GripPick.Grip': { kind: 'component', componentType: 'Grip' },
  'LogicStep_GripPlace.Grip': { kind: 'component', componentType: 'Grip' },
  'Grip.SignalPick': BOOL_SIGNALS,
  'Grip.SignalPlace': BOOL_SIGNALS,
  'Drive_ErraticPosition.SignalEnable': BOOL_SIGNALS,
};

/** The PLC signal component types — a node carrying one IS a signal. */
const SIGNAL_TYPES = new Set([
  'PLCInputBool', 'PLCOutputBool', 'PLCInputInt', 'PLCOutputInt', 'PLCInputFloat', 'PLCOutputFloat',
]);

/**
 * The target of a pickable reference field, or null when the field is not a
 * plain single `ComponentReference` (a signal slot, an array, a value field) or
 * its target type is unknown.
 */
export function referenceTargetOf(componentType: string, fieldName: string): ReferenceTarget | null {
  // The rv-ODT definition is the source: logic steps have no registered runtime
  // schema (they are read raw by the logic engine), so the registry descriptor
  // alone would miss exactly the fields this module exists for.
  const prop = getRawOdtDef(componentType)?.properties?.[fieldName] as
    (Record<string, unknown> & { refType?: string; signal?: string }) | undefined;
  const isSingleRef = typeof prop?.['$ref'] === 'string' && (prop['$ref'] as string).endsWith('/ComponentReference');
  if (!prop || !isSingleRef || prop.signal) return null;
  // A registered descriptor that declares the field a signal slot wins too.
  if (getFieldDescriptor(componentType, fieldName)?.signal) return null;
  const fallback = FALLBACK_TARGETS[`${componentType}.${fieldName}`];
  if (fallback) return fallback;
  const refType = prop.refType;
  if (!refType) return null;
  return SIGNAL_TYPES.has(refType)
    ? { kind: 'signal', signalTypes: [refType] }
    : { kind: 'component', componentType: refType };
}

/** Every pickable reference field of a component type, in schema order. */
export function pickableReferenceFields(componentType: string): Array<{ field: string; target: ReferenceTarget }> {
  const props = getRawOdtDef(componentType)?.properties;
  if (!props) return [];
  const out: Array<{ field: string; target: ReferenceTarget }> = [];
  for (const field of Object.keys(props)) {
    const target = referenceTargetOf(componentType, field);
    if (target) out.push({ field, target });
  }
  return out;
}

/** One entry of the picker: the node path stored in the reference, and the component type it names. */
export interface ReferenceCandidate {
  readonly path: string;
  readonly componentType: string;
  /** Short display name — the node's name. */
  readonly label: string;
}

/**
 * The path a reference stores: ASSET-RELATIVE — the node names from below the
 * asset root down to the node (`Mount/Kine`), the form the ONE reference
 * resolver reads first (`rv-reference-resolver.ts`, doc-node-paths § 9).
 * NOT the registry path: in the editor that starts with the document root's
 * transient name (`/Empty`, `Untitled_2/Empty` in a test run) and resolves
 * nowhere else. Null when the node is not inside `root`.
 */
export function assetRelativePath(node: Object3D, root: Object3D | null | undefined): string | null {
  if (!root) return null;
  const names: string[] = [];
  let n: Object3D | null = node;
  while (n && n !== root) { names.unshift(n.name); n = n.parent; }
  return n === root && names.length > 0 ? names.join('/') : null;
}

/**
 * The nodes a reference may point at, sorted by path. `forEachNode` is the
 * registry's iteration; `root` is the asset root the stored paths are relative
 * to; `owner` (the node carrying the reference) is left out — a step does not
 * wait for itself.
 */
export function listReferenceCandidates(
  forEachNode: (cb: (path: string, node: Object3D) => void) => void,
  target: ReferenceTarget,
  root: Object3D | null | undefined,
  owner?: Object3D | null,
): ReferenceCandidate[] {
  const out: ReferenceCandidate[] = [];
  const seen = new Set<string>();
  forEachNode((_registryPath, node) => {
    if (node === owner) return;
    const path = assetRelativePath(node, root);
    if (!path || seen.has(path)) return;
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (!rv) return;
    const types = target.kind === 'component' ? [target.componentType] : target.signalTypes;
    const hit = types.find((t) => rv[t] !== undefined && rv[t] !== null);
    if (!hit) return;
    seen.add(path);
    out.push({ path, componentType: hit, label: node.name || path });
  });
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** The stored form of a picked reference — the rv-ODT `ComponentReference`. */
export function makeComponentReference(candidate: Pick<ReferenceCandidate, 'path' | 'componentType'>): {
  type: 'ComponentReference'; path: string; componentType: string;
} {
  return { type: 'ComponentReference', path: candidate.path, componentType: candidate.componentType };
}

/** The path of a stored reference value, or '' when the field is empty. */
export function referencePathOf(value: unknown): string {
  if (typeof value !== 'object' || value === null) return '';
  const path = (value as Record<string, unknown>)['path'];
  return typeof path === 'string' ? path : '';
}
