// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * unit-scale.ts — unit-aware signal binding (plan-512). React-free.
 *
 * A signal carries the raw value of its source, in the source's unit
 * (`SignalMeta.unit`, v1: FMU variables). A bindable slot declares the unit it
 * expects on the component side and the sibling number field that scales it
 * (`signalUnit` / `scaleField` in rv-ODT). Binding a signal with a known unit
 * writes ONE factor into that field, by ONE rule for command AND feedback slots:
 *
 *     scaleField = conversion(signal unit → slot unit).factor
 *
 * (command: `target = signal × S`; feedback: `signal = target / S` — both need
 * the same S). The factor is an ordinary, visible, undoable field value; the
 * SignalStore, the transports and the behavior formulas never change.
 *
 * Three parts:
 *  - {@link evaluateUnitBinding} — ONE read-only evaluator; the inspector badge,
 *    the Problems entries and the bind decision all derive from it, from the
 *    CURRENT state (never from stored provenance).
 *  - {@link bindWithUnitScale} / {@link resetScaleToAuto} — the write path: one
 *    document transaction per action, serialised per document (the queue lives in
 *    core/hmi/rv-bind-queue since plan-2233), in the order
 *    "deactivate the slot → set the factor → activate the slot", so the factor
 *    only ever changes while the slot is unbound (forward, undo and redo alike),
 *    verified from the resulting state before it commits.
 *  - {@link reconcileUnitProblems} — the Problems entries of one target,
 *    re-derived after every change of its binding set.
 *
 * v1 boundary: only main-model node targets (`kind: 'node'`) get the automatic
 * write; a planner placement's mapping write is not a document op, so it gets
 * the status `not-applied` and a Problems hint carrying the factor.
 */

import type { RVViewer } from '../../core/rv-viewer';
import { fromStoredMapping } from '../../core/engine/rv-signal-mapping-address';
import type { Object3D } from 'three';
import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import { getFieldDescriptor, getSchemaDefaults, type FieldDescriptor } from '../../core/engine/rv-component-registry';
import {
  approxEqualFactor,
  conversion,
  formatFactor,
  resolveSignalUnit,
} from '../../core/engine/rv-units';
import { NodeRegistry } from '../../core/engine/rv-node-registry';
import { getActiveEditTarget, type EditTarget } from '../../core/hmi/rv-edit-target';
import { enqueueBind, inBindQueue } from '../../core/hmi/rv-bind-queue';
import { isFieldOverridden } from '../../core/hmi/rv-field-override';
import { omitUndefined } from '../../core/hmi/rv-omit-undefined';
import {
  clearUnitProblem,
  reportUnitProblem,
  unitProblemId,
  unitProblemIdsOf,
  UNIT_PROBLEM_CODES,
} from '../../core/hmi/problems-store';
import type { SignalMapping } from '../layout-planner/rv-layout-store';
import type { PickerSignal, SlotRow } from '../../core/hmi/rv-signal-slot-row';
import type { SignalBindTarget } from './signal-bind-target';
import { signalBindTargetId } from './signal-bind-target';
import type { SignalBindingPersistenceAdapter } from './signal-binding-persistence';
import { createSignalBindingPersistence } from './signal-binding-persistence';
import { mappingMatchesRow, removeMappingForRow, upsertMappingForRow } from './slot-row-models';
import { mergeAppliedMappings } from './binding-inventory';

// ─── Status ─────────────────────────────────────────────────────────────

/** What the unit logic says about ONE bound slot. */
export type UnitBindingStatus =
  /** No source unit, no `scaleField`, or a quantity token without a drive. */
  | { kind: 'none' }
  /** The scale field holds the factor. */
  | { kind: 'auto'; field: string; factor: number; from: string; to: string }
  /** Compatible units, the scale field holds another value (the user's). */
  | { kind: 'manual'; field: string; factor: number; from: string; to: string; current: number }
  /** The scale field is shared with another slot that needs a different factor. */
  | { kind: 'conflict'; field: string; factor: number; from: string; to: string; current: number; otherSlot: string }
  /** Units not convertible by a factor. */
  | { kind: 'mismatch'; field: string; from: string; to: string; reason: 'incompatible' | 'offset' }
  /** The signal's unit is unknown (to its source and to the table). */
  | { kind: 'unknown'; field: string; from: string; to: string }
  /** The factor would be ignored or distorted by the feedback formula. */
  | { kind: 'not-effective'; field: string; factor: number; from: string; to: string; blockedBy: string }
  /** The target takes no automatic write (placement, no document). */
  | { kind: 'not-applied'; field: string; factor: number; from: string; to: string };

/** Everything the evaluator reads — accessors, so one context serves every mapping of a target. */
export interface UnitEvalContext {
  /** `getSignalMeta(signal)?.unit` / `unitDef`. */
  store: Pick<SignalStore, 'getSignalMeta'> | null | undefined;
  /** Schema descriptor of the mapping's slot (`signalUnit`, `scaleField`). */
  descriptorOf(mapping: SignalMapping): FieldDescriptor | undefined;
  /** `Drive.Direction` on the node carrying the mapping's component, if any. */
  driveDirectionOf(mapping: SignalMapping): string | undefined;
  /** Current values of the component carrying the mapping (live instance, else extras + schema defaults). */
  componentDataOf(mapping: SignalMapping): Record<string, unknown>;
  /** Every mapping of the target, in persisted order (the evaluated one included). */
  siblingMappings: readonly SignalMapping[];
  /** False when the target takes no automatic write (placement, no document). */
  writable: boolean;
}

type FactorResult =
  | { kind: 'none' }
  | { kind: 'unknown'; field: string; from: string; to: string }
  | { kind: 'mismatch'; field: string; from: string; to: string; reason: 'incompatible' | 'offset' }
  | { kind: 'factor'; field: string; factor: number; from: string; to: string };

function baseType(type: string | undefined): string {
  return (type ?? '').replace(/_\d+$/, '');
}

/** The factor a mapping needs — the unit half of the evaluator, without the field state. */
function resolveFactor(mapping: SignalMapping, ctx: UnitEvalContext): FactorResult {
  const desc = ctx.descriptorOf(mapping);
  if (!desc?.signalUnit || !desc.scaleField) return { kind: 'none' };
  const meta = ctx.store?.getSignalMeta(mapping.signal);
  const from = meta?.unit;
  if (!from) return { kind: 'none' };
  const to = resolveSignalUnit(desc.signalUnit, { driveDirection: ctx.driveDirectionOf(mapping) });
  if (!to) return { kind: 'none' };
  const field = desc.scaleField;
  const conv = conversion(from, to, { fromDef: meta?.unitDef });
  if (conv.ok) return { kind: 'factor', field, factor: conv.factor, from, to };
  if (conv.reason === 'incompatible' || conv.reason === 'offset') {
    return { kind: 'mismatch', field, from, to, reason: conv.reason };
  }
  return { kind: 'unknown', field, from, to };
}

/** Same component instance: same component path and component type (base). */
function sameComponent(a: SignalMapping, b: SignalMapping): boolean {
  return (a.componentPath ?? '.') === (b.componentPath ?? '.')
    && baseType(a.componentType) === baseType(b.componentType);
}

/**
 * Feedback formulas that ignore or distort the scale field (plan-512 F5, SOL R2
 * #2): `scaleFeedbackPosition` is a pass-through while `ScaleFeedbackPosition`
 * is false, and `Drive_FollowPosition.CurrentPosition` multiplies by
 * `CurrentPositionScale` on top. Returns what blocks, or null.
 */
const FEEDBACK_GATES: Readonly<Record<string, Readonly<Record<string, (d: Record<string, unknown>) => string | null>>>> = {
  Drive_FollowPosition: {
    CurrentPosition: (d) => {
      if (d.ScaleFeedbackPosition === false) return 'ScaleFeedbackPosition=false';
      const cps = d.CurrentPositionScale;
      if (typeof cps === 'number' && !approxEqualFactor(cps, 1)) return `CurrentPositionScale=${formatFactor(cps)}`;
      return null;
    },
  },
  Drive_Simple: { IsAtPosition: scaleFeedbackGate },
  Drive_Speed: { SignalCurrentPosition: scaleFeedbackGate },
  Drive_DestinationMotor: { IsAtPosition: scaleFeedbackGate },
  Drive_ContinousDestination: { SignalIsAtPosition: scaleFeedbackGate },
};

function scaleFeedbackGate(d: Record<string, unknown>): string | null {
  return d.ScaleFeedbackPosition === false ? 'ScaleFeedbackPosition=false' : null;
}

/**
 * THE evaluator (plan-512 F7/F8) — badge, Problems and bind decision all read
 * it; it reads only the current state.
 *
 * Shared scale fields: among the mappings of the same component whose slot uses
 * the same field and has a factor, the OWNER is the first one (persisted order)
 * that carries a write provenance for the field, else the first whose factor
 * the field already holds, else the first. Any other mapping with a different
 * factor is `conflict`; one with the same factor is simply evaluated.
 */
export function evaluateUnitBinding(mapping: SignalMapping, ctx: UnitEvalContext): UnitBindingStatus {
  const r = resolveFactor(mapping, ctx);
  if (r.kind === 'none') return r;
  if (r.kind === 'unknown') return r;
  if (r.kind === 'mismatch') return r;
  const { field, factor, from, to } = r;
  const data = ctx.componentDataOf(mapping);
  const current = typeof data[field] === 'number' ? data[field] as number : Number.NaN;

  // Shared field: who sets it?
  const group: Array<{ m: SignalMapping; factor: number }> = [];
  let selfSeen = false;
  for (const m of ctx.siblingMappings) {
    const isSelf = m === mapping || (mappingMatchesRow(m, rowOf(mapping)) && sameComponent(m, mapping));
    if (isSelf) { selfSeen = true; group.push({ m: mapping, factor }); continue; }
    if (!sameComponent(m, mapping)) continue;
    if (ctx.descriptorOf(m)?.scaleField !== field) continue;
    const rm = resolveFactor(m, ctx);
    if (rm.kind === 'factor') group.push({ m, factor: rm.factor });
  }
  if (!selfSeen) group.push({ m: mapping, factor });
  if (group.length > 1) {
    const owner = group.find((g) => g.m.unitScale?.field === field)
      ?? group.find((g) => approxEqualFactor(current, g.factor))
      ?? group[0];
    if (owner.m !== mapping && !approxEqualFactor(owner.factor, factor)) {
      return { kind: 'conflict', field, factor, from, to, current, otherSlot: owner.m.slot };
    }
  }

  const gate = FEEDBACK_GATES[baseType(mapping.componentType)]?.[mapping.slot];
  const blockedBy = gate ? gate(data) : null;
  if (blockedBy) return { kind: 'not-effective', field, factor, from, to, blockedBy };

  if (approxEqualFactor(current, factor)) return { kind: 'auto', field, factor, from, to };
  if (!ctx.writable) return { kind: 'not-applied', field, factor, from, to };
  return { kind: 'manual', field, factor, from, to, current };
}

function rowOf(m: SignalMapping): Pick<SlotRow, 'slot' | 'componentPath' | 'kind'> {
  return { slot: m.slot, componentPath: m.componentPath, kind: m.kind };
}

/**
 * Write rule F6: write when the field is not overridden, OR when the replaced
 * mapping recorded an APPLIED factor that the field still holds. A value the
 * user set — even to the default `1` — is an override and stays.
 */
export function shouldWriteScale(args: {
  current: unknown;
  isOverridden: boolean;
  previous?: SignalMapping['unitScale'];
  factor: number;
}): boolean {
  if (!args.isOverridden) return true;
  return args.previous !== undefined && approxEqualFactor(args.current, args.previous.factor);
}

/** Status kinds that carry a factor the bind may write. */
function writableStatus(s: UnitBindingStatus): s is Extract<UnitBindingStatus, { kind: 'auto' | 'manual' | 'not-applied' }> {
  return s.kind === 'auto' || s.kind === 'manual' || s.kind === 'not-applied';
}

// ─── Context from the live viewer ───────────────────────────────────────

interface SlotInfo {
  nodePath: string;
  componentType: string | undefined;
}

/** Registry path of the node a mapping's `componentPath` addresses under the target root. */
function componentNodePath(viewer: RVViewer, target: SignalBindTarget, componentPath: string | undefined): string {
  const registry = viewer.registry;
  const rootPath = (target.kind === 'node' ? target.nodePath : undefined)
    ?? registry?.getPathForNode(target.node) ?? NodeRegistry.computeNodePath(target.node);
  if (!componentPath || componentPath === '.') return rootPath;
  const joined = rootPath ? `${rootPath}/${componentPath}` : componentPath;
  if (registry?.getNode(joined)) return joined;
  return componentPath;
}

/** Node path + concrete component key of the slot a mapping addresses. */
function slotInfoOf(viewer: RVViewer, target: SignalBindTarget, mapping: SignalMapping): SlotInfo {
  const mgr = viewer.signalBindingManager;
  const targetId = signalBindTargetId(target);
  let componentType = mapping.componentType;
  let componentPath = mapping.componentPath;
  if (mgr) {
    const slot = mgr.getElementSlots(targetId, target.node).find((s) =>
      s.kind !== 'unavailable' && mappingMatchesRow(mapping, s));
    if (slot && slot.kind !== 'unavailable') {
      componentType = slot.componentType ?? componentType;
      componentPath = slot.componentPath;
    }
  }
  return { nodePath: componentNodePath(viewer, target, componentPath), componentType };
}

/** Current values of one component: the live instance where there is one, else extras over schema defaults. */
function componentData(viewer: RVViewer, nodePath: string, componentType: string | undefined): Record<string, unknown> {
  if (!componentType) return {};
  const registry = viewer.registry;
  const live = registry?.getComponentsAt(nodePath)?.find(([type]) => type === componentType)?.[1];
  if (live && typeof live === 'object') return live as Record<string, unknown>;
  const node = registry?.getNode(nodePath);
  const rv = node?.userData?.realvirtual as Record<string, Record<string, unknown> | undefined> | undefined;
  const extras = rv?.[componentType] ?? {};
  // Schema defaults for what the extras leave out (e.g. after an undo removed the key).
  return { ...getSchemaDefaults(baseType(componentType)), ...extras };
}

function driveDirectionAt(viewer: RVViewer, nodePath: string): string | undefined {
  const drive = viewer.registry?.getByPath<{ Direction?: string }>('Drive', nodePath);
  if (drive?.Direction) return drive.Direction;
  const node = viewer.registry?.getNode(nodePath);
  const rv = node?.userData?.realvirtual as Record<string, Record<string, unknown> | undefined> | undefined;
  const dir = rv?.Drive?.Direction;
  return typeof dir === 'string' ? dir : undefined;
}

/**
 * The evaluation context of one target from the live viewer. `writable`
 * follows the v1 boundary: a node target with an available document.
 */
export function buildUnitEvalContext(
  viewer: RVViewer,
  target: SignalBindTarget,
  mappings: readonly SignalMapping[],
  editTarget: EditTarget = getActiveEditTarget(),
): UnitEvalContext {
  const infos = new Map<SignalMapping, SlotInfo>();
  const info = (m: SignalMapping): SlotInfo => {
    let i = infos.get(m);
    if (!i) { i = slotInfoOf(viewer, target, m); infos.set(m, i); }
    return i;
  };
  // A mapping without a recorded type is evaluated under the resolved one, so
  // `sameComponent` compares like with like.
  const typed = mappings.map((m) => {
    const i = info(m);
    if (!i.componentType || m.componentType === i.componentType) return m;
    const copy = { ...m, componentType: i.componentType };
    infos.set(copy, i);
    return copy;
  });
  return {
    store: viewer.signalStore,
    descriptorOf: (m) => getFieldDescriptor(baseType(info(m).componentType), m.slot),
    driveDirectionOf: (m) => driveDirectionAt(viewer, info(m).nodePath),
    componentDataOf: (m) => componentData(viewer, info(m).nodePath, info(m).componentType),
    siblingMappings: typed,
    writable: target.kind === 'node' && editTarget.available,
  };
}

/** {@link evaluateUnitBinding} for every mapping of a target, in persisted order. */
export function evaluateTargetUnits(
  viewer: RVViewer,
  target: SignalBindTarget,
  mappings: readonly SignalMapping[],
  editTarget?: EditTarget,
): Array<{ mapping: SignalMapping; status: UnitBindingStatus; nodePath: string; componentType?: string }> {
  const ctx = buildUnitEvalContext(viewer, target, mappings, editTarget);
  return ctx.siblingMappings.map((mapping) => {
    const i = slotInfoOf(viewer, target, mapping);
    return { mapping, status: evaluateUnitBinding(mapping, ctx), nodePath: i.nodePath, componentType: i.componentType };
  });
}

// ─── Human text (badge tooltip + Problems) ──────────────────────────────

/** One sentence for the badge tooltip / Problems detail. */
export function describeUnitStatus(status: UnitBindingStatus, signal?: string): string {
  const sig = signal ? ` (${signal})` : '';
  switch (status.kind) {
    case 'none': return '';
    case 'auto':
      return `×${formatFactor(status.factor)} set automatically from the unit ${status.from} → ${status.to}${sig}.`;
    case 'manual':
      return `Manual value — automatic would be ×${formatFactor(status.factor)} (${status.from} → ${status.to}${sig}). Click to reset to automatic.`;
    case 'conflict':
      return `${status.field} is shared with slot "${status.otherSlot}", which needs another factor — this slot needs ×${formatFactor(status.factor)} (${status.from} → ${status.to}${sig}). ${status.field} was left at ${formatFactor(status.current)}; set it manually.`;
    case 'mismatch':
      return status.reason === 'offset'
        ? `Units ${status.from}${sig} → ${status.to} differ by an offset, which a scale factor cannot express. ${status.field} was left unchanged; set it manually.`
        : `Units incompatible: ${status.from}${sig} → ${status.to}. ${status.field} was left unchanged; set it manually.`;
    case 'unknown':
      return `Unknown unit "${status.from}"${sig} — neither the signal's source nor the built-in table defines it. ${status.field} was left unchanged; set it manually (the slot expects ${status.to}).`;
    case 'not-effective':
      return `×${formatFactor(status.factor)} (${status.from} → ${status.to}${sig}) would not take effect: ${status.blockedBy}. The feedback value is not scaled by ${status.field} as expected.`;
    case 'not-applied':
      return `Not set automatically here — enter ×${formatFactor(status.factor)} (${status.from} → ${status.to}${sig}) in ${status.field} manually.`;
  }
}

// ─── Write path ─────────────────────────────────────────────────────────

/** Result of a bind or reset through the unit-aware path. */
export interface UnitBindResult {
  /** The mappings of the target as persisted afterwards. */
  mappings: SignalMapping[];
  /** Status of the bound slot, evaluated from the resulting state. */
  status: UnitBindingStatus;
  /** True when the resulting state was verified in the document (and, for a node target, at runtime). */
  persisted: boolean;
  /** The factor was written into the scale field. */
  wroteScale: boolean;
  /** Why the action did not stick, when `persisted` is false. */
  error?: string;
}

// Pending targets — slot rows show them busy while a bind runs.
const pendingTargets = new Map<string, number>();
const pendingListeners = new Set<() => void>();
let pendingVersion = 0;

function setPending(targetId: string, delta: 1 | -1): void {
  const n = (pendingTargets.get(targetId) ?? 0) + delta;
  if (n <= 0) pendingTargets.delete(targetId); else pendingTargets.set(targetId, n);
  pendingVersion++;
  for (const l of [...pendingListeners]) l();
}

/** True while a unit-aware bind of this target is queued or running. */
export function isBindPending(targetId: string): boolean {
  return pendingTargets.has(targetId);
}

/** `useSyncExternalStore` pair for {@link isBindPending}. */
export function subscribeBindPending(listener: () => void): () => void {
  pendingListeners.add(listener);
  return () => { pendingListeners.delete(listener); };
}
export function getBindPendingVersion(): number {
  return pendingVersion;
}

function readUserDataField(viewer: RVViewer, nodePath: string, componentType: string, field: string): unknown {
  const node = viewer.registry?.getNode(nodePath);
  const rv = node?.userData?.realvirtual as Record<string, Record<string, unknown> | undefined> | undefined;
  return rv?.[componentType]?.[field];
}

function readNodeMappings(target: SignalBindTarget, viewer: RVViewer): SignalMapping[] {
  const rv = target.node.userData?.realvirtual as Record<string, unknown> | undefined;
  const links = rv?.SignalLinks as { Mappings?: unknown } | undefined;
  if (!Array.isArray(links?.Mappings)) return [];
  // plan-769 F15: the stored record names the component by address — read it back.
  return (links!.Mappings as SignalMapping[]).map((m) =>
    fromStoredMapping(m, target.node as Object3D, viewer.registry ?? null, viewer.signalStore ?? null));
}

function sameUnitScale(a: SignalMapping['unitScale'], b: SignalMapping['unitScale']): boolean {
  if (!a || !b) return a === b;
  return a.field === b.field && a.from === b.from && a.to === b.to && approxEqualFactor(a.factor, b.factor);
}

interface BracketPlan {
  viewer: RVViewer;
  target: Extract<SignalBindTarget, { kind: 'node' }>;
  persistence: SignalBindingPersistenceAdapter;
  editTarget: EditTarget;
  label: string;
  row: Pick<SlotRow, 'slot' | 'componentPath' | 'kind'>;
  /** The slot is bound now — Op 1 deactivates it first. */
  hadMapping: boolean;
  /** Mappings with the slot removed (Op 1). */
  deactivated: SignalMapping[];
  /** Final mappings (Op 3). */
  final: SignalMapping[];
  /** The mapping of `row` inside `final`. */
  finalMapping: SignalMapping;
  /** Op 2 — the factor write, when the rule allows it. */
  scale?: { nodePath: string; componentType: string; field: string; factor: number };
}

/**
 * Check, from the RESULTING state, that the action took (SOL R3 #2) — and throw
 * otherwise, so the transaction rolls back. Three levels: the document (the
 * node's extras), the live component (the executor writes extras BEFORE the
 * instance and only warns when the second half fails), the binding manager.
 */
function verifyApplied(plan: BracketPlan): void {
  const { viewer, target, row, finalMapping, scale } = plan;
  const docMapping = readNodeMappings(target, viewer).find((m) => mappingMatchesRow(m, row));
  if (!docMapping || docMapping.signal !== finalMapping.signal) {
    throw new Error(`the mapping of slot "${row.slot}" did not reach the document`);
  }
  if (!sameUnitScale(docMapping.unitScale, finalMapping.unitScale)) {
    throw new Error(`the unit provenance of slot "${row.slot}" did not reach the document`);
  }
  if (scale) {
    const stored = readUserDataField(viewer, scale.nodePath, scale.componentType, scale.field);
    if (!approxEqualFactor(stored, scale.factor)) {
      throw new Error(`${scale.componentType}.${scale.field} did not reach the document`);
    }
    const live = viewer.registry?.getComponentsAt(scale.nodePath)?.find(([t]) => t === scale.componentType)?.[1] as
      Record<string, unknown> | undefined;
    if (live && !approxEqualFactor(live[scale.field], scale.factor)) {
      throw new Error(`${scale.componentType}.${scale.field} was not applied to the running component`);
    }
  }
  const mgr = viewer.signalBindingManager;
  const targetId = signalBindTargetId(target);
  if (mgr && mgr.getBindingLiveness(targetId, row.slot, row.componentPath) === undefined) {
    throw new Error(`slot "${row.slot}" is not bound at runtime`);
  }
}

async function setFieldAwaited(
  et: EditTarget, nodePath: string, componentType: string, field: string, value: unknown, prev: unknown,
): Promise<void> {
  if (et.setFieldAsync) { await et.setFieldAsync(nodePath, componentType, field, value, prev); return; }
  // Order holds without it (the document queue is FIFO); only a refusal goes unseen.
  et.setField(nodePath, componentType, field, value, prev);
}

async function writeMappings(p: SignalBindingPersistenceAdapter, mappings: SignalMapping[]): Promise<void> {
  if (p.writeAsync) await p.writeAsync(mappings);
  else p.write(mappings);
}

/**
 * THE bracket (plan-512 §2.4, spike ff676df4): one transaction —
 *   Op 1  Mappings := without the slot     (only when it is bound now)
 *   Op 2  scale field := factor            (only when the write rule allows)
 *   Op 3  Mappings := final                (the executor activates and samples)
 * so the factor changes while the slot is unbound in every direction: the
 * inverse of a composite runs backwards. No `applyMappings` here — activation is
 * the SignalLinks executor's job alone.
 */
async function runBracket(plan: BracketPlan): Promise<void> {
  const { editTarget: et, persistence, scale } = plan;
  await et.withTransaction(plan.label, async () => {
    if (plan.hadMapping) await writeMappings(persistence, plan.deactivated);
    if (scale) {
      const prev = readUserDataField(plan.viewer, scale.nodePath, scale.componentType, scale.field);
      await setFieldAwaited(et, scale.nodePath, scale.componentType, scale.field, scale.factor, prev);
    }
    await writeMappings(persistence, plan.final);
    verifyApplied(plan);
  });
}

export interface BindWithUnitScaleOptions {
  /** Edit target to write through (default: the active one). */
  editTarget?: EditTarget;
  /** Undo label (default "Bind <slot>"). */
  label?: string;
  /** Hold of the queue the caller holds (rv-bind-queue). */
  queueHold?: object;
}

/**
 * Bind `source` to `row` of `target`, writing the unit factor when the rules
 * allow it (plan-512 §2.4). Shared by the inspector slots, the planner popover
 * and MCP `web_signal_bind`. Serialised per document; resolves with the
 * verified outcome (never rejects for a refused bind — `persisted: false`).
 * Returns null when the pick is not bindable at all (conflict, no identity).
 */
export function bindWithUnitScale(
  viewer: RVViewer,
  target: SignalBindTarget,
  persistence: SignalBindingPersistenceAdapter,
  row: Pick<SlotRow, 'slot' | 'componentPath' | 'kind' | 'direction' | 'componentType'>,
  source: PickerSignal,
  opts: BindWithUnitScaleOptions = {},
): Promise<UnitBindResult | null> {
  const et = opts.editTarget ?? getActiveEditTarget();
  const targetId = signalBindTargetId(target);
  setPending(targetId, 1);
  const job = () => runBind(viewer, target, persistence, row, source, et, opts.label);
  return inBindQueue(et, opts.queueHold, job).finally(() => setPending(targetId, -1));
}

async function runBind(
  viewer: RVViewer,
  target: SignalBindTarget,
  persistence: SignalBindingPersistenceAdapter,
  row: Pick<SlotRow, 'slot' | 'componentPath' | 'kind' | 'direction' | 'componentType'>,
  source: PickerSignal,
  et: EditTarget,
  label: string | undefined,
): Promise<UnitBindResult | null> {
  const mgr = viewer.signalBindingManager;
  if (!mgr) return null;
  const targetId = signalBindTargetId(target);
  const before = persistence.read();
  const previous = before.find((m) => mappingMatchesRow(m, row));
  const deactivated = removeMappingForRow(before, row);
  const upserted = upsertMappingForRow(deactivated, row, source);
  if (!upserted) return null;
  // Unresolvable links of the same target survive (plan-425, SOL R1 #5).
  const merged = mergeAppliedMappings(upserted, mgr.previewMappings(targetId, target.node, upserted));
  const index = merged.findIndex((m) => mappingMatchesRow(m, row));
  const newMapping = merged[index];

  // No document (reine Laufzeit) or a placement: the pre-plan-512 path, no field write.
  if (target.kind !== 'node' || !et.available) {
    const applied = mgr.applyMappings(targetId, target.node, merged);
    persistence.write(mergeAppliedMappings(merged, applied));
    const after = persistence.read();
    const mapping = after.find((m) => mappingMatchesRow(m, row));
    const status = mapping
      ? evaluateUnitBinding(mapping, buildUnitEvalContext(viewer, target, after, et))
      : { kind: 'none' as const };
    const bound = mgr.getBindingLiveness(targetId, row.slot, row.componentPath) !== undefined;
    return { mappings: after, status, persisted: !!mapping && bound, wroteScale: false };
  }

  const ctx = buildUnitEvalContext(viewer, target, merged, et);
  const status0 = evaluateUnitBinding(newMapping, ctx);
  let scale: BracketPlan['scale'];
  let finalMapping = newMapping;
  if (writableStatus(status0)) {
    const info = slotInfoOf(viewer, target, newMapping);
    const componentType = info.componentType;
    const current = ctx.componentDataOf(newMapping)[status0.field];
    const prevScale = previous?.unitScale?.field === status0.field ? previous.unitScale : undefined;
    if (componentType && shouldWriteScale({
      current,
      isOverridden: isFieldOverridden(viewer, info.nodePath, componentType, status0.field),
      previous: prevScale,
      factor: status0.factor,
    })) {
      scale = { nodePath: info.nodePath, componentType, field: status0.field, factor: status0.factor };
      finalMapping = omitUndefined({
        ...newMapping,
        unitScale: { field: status0.field, factor: status0.factor, from: status0.from, to: status0.to },
      });
    }
  }
  const final = merged.map((m, i) => (i === index ? finalMapping : m));
  return runPlanned(viewer, target, persistence, et, {
    viewer, target, persistence, editTarget: et,
    label: label ?? `Bind ${row.slot}`,
    row, hadMapping: !!previous,
    deactivated: mergeAppliedMappings(deactivated, mgr.previewMappings(targetId, target.node, deactivated)),
    final, finalMapping, scale,
  });
}

async function runPlanned(
  viewer: RVViewer,
  target: Extract<SignalBindTarget, { kind: 'node' }>,
  persistence: SignalBindingPersistenceAdapter,
  et: EditTarget,
  plan: BracketPlan,
): Promise<UnitBindResult> {
  let error: string | undefined;
  try {
    await runBracket(plan);
  } catch (e) {
    error = (e as Error)?.message ?? String(e);
  }
  const after = persistence.read();
  const mapping = after.find((m) => mappingMatchesRow(m, plan.row));
  const status = mapping
    ? evaluateUnitBinding(mapping, buildUnitEvalContext(viewer, target, after, et))
    : { kind: 'none' as const };
  return {
    mappings: after,
    status,
    persisted: error === undefined,
    wroteScale: error === undefined && !!plan.scale,
    ...(error !== undefined ? { error } : {}),
  };
}

/**
 * Reset a `manual` scale field to its automatic factor (plan-512 F6, SOL R2 #3):
 * ONE transaction of the same bracket — the field gets the factor AND the
 * mapping gets the `unitScale` provenance, so the state afterwards really is
 * `auto` and a later re-bind may rewrite it. Only for node targets with a
 * document; resolves null when there is nothing to reset.
 */
export function resetScaleToAuto(
  viewer: RVViewer,
  target: SignalBindTarget,
  persistence: SignalBindingPersistenceAdapter,
  row: Pick<SlotRow, 'slot' | 'componentPath' | 'kind'>,
  opts: BindWithUnitScaleOptions = {},
): Promise<UnitBindResult | null> {
  const et = opts.editTarget ?? getActiveEditTarget();
  const targetId = signalBindTargetId(target);
  setPending(targetId, 1);
  return enqueueBind(et, async () => {
    const mgr = viewer.signalBindingManager;
    if (!mgr || target.kind !== 'node' || !et.available) return null;
    const before = persistence.read();
    const index = before.findIndex((m) => mappingMatchesRow(m, row));
    if (index < 0) return null;
    const current = before[index];
    const ctx = buildUnitEvalContext(viewer, target, before, et);
    const status = evaluateUnitBinding(current, ctx);
    if (!writableStatus(status)) return null;
    const info = slotInfoOf(viewer, target, current);
    if (!info.componentType) return null;
    const finalMapping = omitUndefined({
      ...current,
      unitScale: { field: status.field, factor: status.factor, from: status.from, to: status.to },
    });
    const deactivated = removeMappingForRow(before, row);
    return runPlanned(viewer, target, persistence, et, {
      viewer, target, persistence, editTarget: et,
      label: opts.label ?? `Reset ${status.field} to unit factor`,
      row, hadMapping: true, deactivated,
      final: before.map((m, i) => (i === index ? finalMapping : m)),
      finalMapping,
      scale: { nodePath: info.nodePath, componentType: info.componentType, field: status.field, factor: status.factor },
    });
  }).finally(() => setPending(targetId, -1));
}

// ─── Problems reconcile ─────────────────────────────────────────────────

interface PlannerLike extends RVViewerPlugin {
  getPlacedRootById?(id: string): import('three').Object3D | null;
}

/** The bind target behind an element id (placement id or node path), or null. */
export function targetForId(viewer: RVViewer, targetId: string): SignalBindTarget | null {
  const planner = viewer.getPlugin?.<PlannerLike>('layout-planner');
  const placedRoot = planner?.getPlacedRootById?.(targetId) ?? null;
  if (placedRoot) return { kind: 'placed', placedId: targetId, node: placedRoot, label: placedRoot.name };
  const node = viewer.registry?.getNode(targetId);
  return node ? { kind: 'node', nodePath: targetId, node, label: node.name } : null;
}

const PROBLEM_TITLES: Record<string, string> = {
  mismatch: 'Unit mismatch',
  unknown: 'Unknown signal unit',
  conflict: 'Unit scale conflict',
  'not-effective': 'Unit scale not effective',
  'not-applied': 'Unit scale not applied',
};

const PROBLEM_CODE_OF: Record<string, string> = {
  mismatch: UNIT_PROBLEM_CODES.mismatch,
  unknown: UNIT_PROBLEM_CODES.unknown,
  conflict: UNIT_PROBLEM_CODES.conflict,
  'not-effective': UNIT_PROBLEM_CODES.notEffective,
  'not-applied': UNIT_PROBLEM_CODES.notApplied,
};

/**
 * Re-derive the unit Problems of ONE target from its current state (plan-512
 * F7) — `applied` is the mapping list the binding manager just installed
 * (default: the persisted list): report what the evaluator flags, clear everything else of this target —
 * including entries of mappings that no longer exist. Writes no field, ever.
 * `not-applied` is reported for placements only (the v1 boundary); a node
 * without a document is a transient state, not a finding.
 */
export function reconcileUnitProblems(
  viewer: RVViewer,
  targetId: string,
  applied?: readonly SignalMapping[],
): void {
  const target = targetForId(viewer, targetId);
  const keep = new Set<string>();
  if (target) {
    // The list the manager just installed wins over the persisted one: the
    // inspector's unbind applies FIRST and persists after.
    const mappings = applied ?? createSignalBindingPersistence(viewer, target).read();
    for (const { mapping, status, nodePath, componentType } of evaluateTargetUnits(viewer, target, mappings)) {
      const k = status.kind;
      const reportable = k === 'mismatch' || k === 'unknown' || k === 'conflict' || k === 'not-effective'
        || (k === 'not-applied' && target.kind === 'placed');
      if (!reportable) continue;
      const id = unitProblemId(targetId, mapping.componentPath ?? '.', mapping.slot);
      keep.add(id);
      const where = `${target.label ?? targetId} › ${baseType(componentType ?? mapping.componentType) || 'component'}.${mapping.slot}`;
      reportUnitProblem({
        id,
        code: PROBLEM_CODE_OF[k],
        severity: k === 'not-applied' ? 'info' : 'warning',
        title: `${PROBLEM_TITLES[k]} on ${where}`,
        detail: `Signal "${mapping.signal}" → slot ${mapping.slot}: ${describeUnitStatus(status, mapping.signal)}`,
        nodePath,
      });
    }
  }
  for (const id of unitProblemIdsOf(targetId)) if (!keep.has(id)) clearUnitProblem(id);
}
