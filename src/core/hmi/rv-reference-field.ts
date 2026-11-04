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
import { getFieldDescriptor, getRawOdtDef, getRegisteredSchema } from '../engine/rv-component-registry';
import { RV_ORIG_NAME_KEY } from '../engine/rv-glb-parse';
import type { NodeRegistry } from '../engine/rv-node-registry';
import { isComponentReference, storedReferenceLabel, storedReferenceValue } from '../engine/rv-node-path-rewrite.mjs';

/** What a reference field may point at. */
export type ReferenceTarget =
  | { readonly kind: 'component'; readonly componentType: string }
  | { readonly kind: 'signal'; readonly signalTypes: readonly string[] }
  /** Any named node of the asset, also one without a component (plan-522); stored with `componentType: ''`. */
  | { readonly kind: 'node' };

/** A pickable reference field: its target and whether it holds a LIST of references. */
export interface PickableReferenceField {
  readonly field: string;
  readonly target: ReferenceTarget;
  readonly array: boolean;
}

const NODE_TARGET: ReferenceTarget = { kind: 'node' };

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
  const odt = odtReferenceTargetOf(componentType, fieldName);
  if (odt) return odt;
  const web = webSchemaReferenceOf(componentType, fieldName);
  return web && !web.array ? web.target : null;
}

/**
 * plan-522: a reference field of a REGISTERED web schema (no rv-ODT entry) that
 * declares `refTarget: 'node'` — single (`componentRef`) or list
 * (`componentRefArray`). Fields of rv-ODT components are never answered here,
 * so existing components keep exactly their pickers.
 */
export function webSchemaReferenceOf(componentType: string, fieldName: string): { target: ReferenceTarget; array: boolean } | null {
  if (getRawOdtDef(componentType)?.properties?.[fieldName]) return null;
  if (!getRegisteredSchema(componentType)) return null;
  const desc = getFieldDescriptor(componentType, fieldName);
  if (!desc || desc.signal) return null;
  // plan-522 Phase 7: a reference to a signal of several types (not a slot).
  if (desc.type === 'componentRef' && desc.refSignalTypes && desc.refSignalTypes.length > 0) {
    return { target: { kind: 'signal', signalTypes: [...desc.refSignalTypes] }, array: false };
  }
  if (desc.refTarget !== 'node') return null;
  if (desc.type === 'componentRef') return { target: NODE_TARGET, array: false };
  if (desc.type === 'componentRefArray') return { target: NODE_TARGET, array: true };
  return null;
}

function odtReferenceTargetOf(componentType: string, fieldName: string): ReferenceTarget | null {
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
export function pickableReferenceFields(componentType: string): PickableReferenceField[] {
  const out: PickableReferenceField[] = [];
  const props = getRawOdtDef(componentType)?.properties;
  if (props) {
    for (const field of Object.keys(props)) {
      const target = odtReferenceTargetOf(componentType, field);
      if (target) out.push({ field, target, array: false });
    }
    return out;
  }
  // plan-522: web-only schemas (maintenance components) — `refTarget: 'node'` fields.
  const schema = getRegisteredSchema(componentType);
  if (!schema) return out;
  for (const field of Object.keys(schema)) {
    const web = webSchemaReferenceOf(componentType, field);
    if (web) out.push({ field, target: web.target, array: web.array });
  }
  return out;
}

/** One entry of the picker: the node path stored in the reference, and the component type it names. */
export interface ReferenceCandidate {
  readonly path: string;
  readonly componentType: string;
  /** Short display name — the node's (authored) name. */
  readonly label: string;
  /**
   * plan-765 F4: more than one distinct node shares this authored path (true
   * sibling duplicates, legal in glTF and CAD) — the path cannot address one of
   * them, so the picker lists it disabled and never writes it. The key is
   * ABSENT on a normal candidate, never `false`.
   */
  readonly ambiguous?: true;
  /** How many distinct nodes share the path; present only with `ambiguous`. */
  readonly nodeCount?: number;
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

/** The authored name of one node: the loader's dedup stamp when present, else its name (plan-765). */
function authoredSegment(node: Object3D): string {
  const orig = node.userData?.[RV_ORIG_NAME_KEY];
  return typeof orig === 'string' && orig.length > 0 ? orig : node.name;
}

/**
 * THE writer of reference paths (plan-765 F3): {@link assetRelativePath}'s walk,
 * but every segment spelled in the AUTHORED name — `userData._rvOrigName` (the
 * name GLTFLoader's file-wide dedup took away: `NL6:501` instead of `NL6501_1`)
 * when it is a non-empty string, else `name`. That is the spelling Unity writes
 * and the editor save writes back, so a reference written here still resolves
 * after save and reload; a current `_N` name is load-order dependent and would
 * not. Every editor-side author of a reference path goes through this function.
 * Null when the node is not inside `root`.
 */
export function authoredAssetRelativePath(node: Object3D, root: Object3D | null | undefined): string | null {
  if (!root) return null;
  const names: string[] = [];
  let n: Object3D | null = node;
  while (n && n !== root) { names.unshift(authoredSegment(n)); n = n.parent; }
  return n === root && names.length > 0 ? names.join('/') : null;
}

/**
 * True when the authored path of `node` below `root` addresses more than one
 * node: some segment on the way is shared by a sibling (true sibling duplicates
 * `Pin`/`Pin`). Such a path cannot pin the node, so a writer must not produce it
 * (plan-765 F4). False when `node` is not inside `root`.
 */
export function authoredPathIsAmbiguous(node: Object3D, root: Object3D | null | undefined): boolean {
  if (!root) return false;
  for (let n: Object3D | null = node; n && n !== root; n = n.parent) {
    const parent: Object3D | null = n.parent;
    if (!parent) return false;
    const seg = authoredSegment(n);
    let same = 0;
    for (const sib of parent.children) if (authoredSegment(sib) === seg && ++same > 1) return true;
  }
  return false;
}

/**
 * The nodes a reference may point at, sorted by path. `forEachNode` is the
 * registry's iteration; `root` is the asset root the stored paths are relative
 * to; `owner` (the node carrying the reference) is left out — a step does not
 * wait for itself.
 *
 * Paths are spelled by {@link authoredAssetRelativePath} and grouped by that
 * spelling: the registry iterates alias entries too (the same node under its
 * authored path), and true sibling duplicates share one authored path. A path
 * claimed by more than one DISTINCT node becomes ONE `ambiguous` candidate with
 * its `nodeCount` (plan-765 F4) — before, the second node was silently dropped
 * and a pick wrote a path that lands on whichever sibling the resolver finds first.
 */
export function listReferenceCandidates(
  forEachNode: (cb: (path: string, node: Object3D) => void) => void,
  target: ReferenceTarget,
  root: Object3D | null | undefined,
  owner?: Object3D | null,
): ReferenceCandidate[] {
  const groups = new Map<string, { componentType: string; label: string; nodes: Set<Object3D> }>();
  const types = target.kind === 'component' ? [target.componentType] : target.kind === 'signal' ? target.signalTypes : [];
  forEachNode((_registryPath, node) => {
    if (node === owner) return;
    let hit = '';
    if (target.kind !== 'node') {
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv) return;
      const found = types.find((t) => rv[t] !== undefined && rv[t] !== null);
      if (!found) return;
      hit = found;
    } else if (!node.name) {
      return; // an unnamed node has no path to write
    }
    const path = authoredAssetRelativePath(node, root);
    if (!path) return;
    const group = groups.get(path);
    if (group) { group.nodes.add(node); return; }
    groups.set(path, { componentType: hit, label: authoredSegment(node) || path, nodes: new Set([node]) });
  });
  const out: ReferenceCandidate[] = [];
  for (const [path, g] of groups) {
    // A sibling twin WITHOUT the target component makes the path just as
    // unaddressable (the resolver may land on the twin) — counted structurally.
    let nodeCount = g.nodes.size;
    if (nodeCount === 1 && authoredPathIsAmbiguous([...g.nodes][0], root)) nodeCount = 2;
    out.push(nodeCount > 1
      ? { path, componentType: g.componentType, label: g.label, ambiguous: true, nodeCount }
      : { path, componentType: g.componentType, label: g.label });
  }
  out.sort((a, b) => a.path.localeCompare(b.path));
  return out;
}

/** Why an ambiguous candidate cannot be picked (plan-765 F4) — the picker row's tooltip. */
export function ambiguousReason(c: Pick<ReferenceCandidate, 'path' | 'nodeCount'>): string {
  return `${c.path}: ${c.nodeCount ?? 2} siblings share this name — not addressable by path; rename one in the source`;
}

/** The stored form of a picked reference — the rv-ODT `ComponentReference`. */
export function makeComponentReference(candidate: Pick<ReferenceCandidate, 'path' | 'componentType'>): {
  type: 'ComponentReference'; path: string; componentType: string;
} {
  return { type: 'ComponentReference', path: candidate.path, componentType: candidate.componentType };
}

/** The paths of a stored reference LIST (plan-522), '' entries dropped. */
export function referencePathsOf(value: unknown, resolve?: (ref: unknown) => string | null): string[] {
  if (!Array.isArray(value)) return [];
  const out: string[] = [];
  for (const v of value) { const p = referencePathOf(v, resolve); if (p) out.push(p); }
  return out;
}

/**
 * The path of a stored reference value, or '' when the field is empty. plan-769 § 2.7:
 * an address-form reference has no path — `resolve` names its target (the inspector
 * shows the path, the file stores `{ address }`); without one its label stands in.
 */
export function referencePathOf(value: unknown, resolve?: (ref: unknown) => string | null): string {
  if (typeof value !== 'object' || value === null) return '';
  const path = (value as Record<string, unknown>)['path'];
  if (typeof path === 'string') return path;
  if (!isComponentReference(value)) return '';
  return resolve?.(value) ?? storedReferenceLabel(value) ?? '';
}

/**
 * plan-769 § 2.7 — the node a stored reference value of `owner` names (any form: the
 * file's verdict / the address index, never a guess), or null.
 */
export function storedReferenceTargetOf(
  registry: Pick<NodeRegistry, 'readStoredRef'>,
  owner: Object3D | null,
  value: unknown,
): Object3D | null {
  const stored = storedReferenceValue(value);
  if (!owner || stored === null) return null;
  const r = registry.readStoredRef(owner, stored);
  return r.status === 'resolved' ? r.node : null;
}

/**
 * The path the inspector shows for an address-form reference: the target's AUTHORED
 * asset-relative path (the spelling the picker lists), else its registry path; null
 * when nothing answers (the caller shows the label).
 */
export function addressedReferencePath(
  registry: Pick<NodeRegistry, 'readStoredRef' | 'getPathForNode'>,
  owner: Object3D | null,
  root: Object3D | null | undefined,
  value: unknown,
): string | null {
  const node = storedReferenceTargetOf(registry, owner, value);
  if (!node) return null;
  return authoredAssetRelativePath(node, root) ?? registry.getPathForNode(node);
}

// ─── plan-769 D22: a reference field takes the object form ─────────────────

/**
 * Is `componentType.fieldName` a REFERENCE field, and of which shape? The fields
 * the inspector picks for without a schema descriptor ({@link FALLBACK_TARGETS}:
 * the logic steps, which have no registered runtime schema — `LogicStep_DriveTo.drive`,
 * `LogicStep_SetSignalBool.Signal`, …) are single references; otherwise the rv-ODT
 * definition decides (`$ref ComponentReference`, or an array of them), else a
 * registered web schema (`componentRef` / `componentRefArray`, plan-522). A
 * concrete key (`Drive_1`) is read as its base type. `null` = not a reference
 * field (or unknown).
 */
export function referenceFieldShape(componentType: string, fieldName: string): 'single' | 'array' | null {
  const base = componentType.replace(/_\d+$/, '');
  for (const type of base === componentType ? [componentType] : [componentType, base]) {
    if (FALLBACK_TARGETS[`${type}.${fieldName}`]) return 'single';
    const prop = getRawOdtDef(type)?.properties?.[fieldName] as
      (Record<string, unknown> & { items?: Record<string, unknown> }) | undefined;
    if (prop) {
      const isRef = (p: Record<string, unknown> | undefined): boolean =>
        typeof p?.['$ref'] === 'string' && (p['$ref'] as string).endsWith('/ComponentReference');
      if (isRef(prop)) return 'single';
      return prop['type'] === 'array' && isRef(prop.items) ? 'array' : null;
    }
    const desc = getFieldDescriptor(type, fieldName);
    if (desc) return desc.type === 'componentRef' ? 'single' : desc.type === 'componentRefArray' ? 'array' : null;
  }
  return null;
}

/**
 * plan-769 D22 — the refusal of a BARE STRING written into a reference field
 * (`editor.setField` / `web_editor_set_field`), or null when the value is
 * acceptable. A string is never converted into a reference: it would be a
 * guess at what the author meant, and a step reading it finds nothing
 * (`registry.resolve` takes the object form only). The message names the
 * expected form; the object form with a `path` is then stored as its target's
 * address by the writer (`addressedReferenceValue`). `null` / an object pass.
 */
export function bareStringReferenceRefusal(componentType: string, fieldName: string, value: unknown): string | null {
  const shape = referenceFieldShape(componentType, fieldName);
  if (!shape) return null;
  const bare = shape === 'array'
    ? typeof value === 'string' || (Array.isArray(value) && value.some((v) => typeof v === 'string'))
    : typeof value === 'string';
  if (!bare) return null;
  const form = '{"type":"ComponentReference","path":"<node path>","componentType":"<component type, e.g. realvirtual.Drive>"}';
  return `${componentType}.${fieldName} is a reference field — a bare string is not accepted. `
    + `Pass the object form ${form} (or "address" instead of "path")`
    + `${shape === 'array' ? ', as an array of such objects' : ''}; null clears the field.`;
}
