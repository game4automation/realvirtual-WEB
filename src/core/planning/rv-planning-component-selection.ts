// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-planning-component-selection — WHICH existing component properties a document shows
 * in the planning window (plan-630 §2.14, Phase 8): the `selection[]` of the
 * `PlanningScenarios` block, read and written here. Small and eager on purpose (the block
 * is read on every load); the derivation, the key hash and the one writer live in
 * `rv-planning-component-params.ts`, which only the lazily loaded `component` owner needs.
 */

/** Owner of every component-property parameter. */
export const COMPONENT_PLANNING_OWNER = 'component';
/** Problems code: a selected property cannot be a planning parameter (type, readonly, signal, …). */
export const PROBLEM_SELECTION_INVALID = 'planning-selection-invalid';
/** Problems code: the property's component type has no re-config path. */
export const PROBLEM_SELECTION_UNSUPPORTED = 'planning-selection-unsupported';

/** What a component parameter points at. */
export interface ComponentParamTarget {
  /** Full NodeRegistry address `<occurrence>#<NodeId>` (plan-769). */
  readonly address: string;
  /** Component key under `userData.realvirtual` (`'Source'`, `'Drive_1'`). */
  readonly component: string;
  /** Field name or dotted field path (`'Interval'`, `'Values.speed'`). */
  readonly field: string;
}

/** One entry of the document's `selection[]`. */
export interface ComponentParamSelection extends ComponentParamTarget {
  label?: string;
  group?: string;
  /** Display narrowing only — never changes the schema type. Numeric fields only. */
  min?: number;
  max?: number;
  step?: number;
}

const SEGMENT = /^[A-Za-z0-9_-]+$/;
const FORBIDDEN_SEGMENTS: ReadonlySet<string> = new Set(['__proto__', 'prototype', 'constructor']);

/** Is `field` a field name or a dotted path of key-alphabet segments? */
export function isValidComponentFieldPath(field: unknown): field is string {
  if (typeof field !== 'string' || field === '') return false;
  return field.split('.').every((s) => SEGMENT.test(s) && !FORBIDDEN_SEGMENTS.has(s));
}

/** Is `component` a usable component key (`Source`, `Drive_1`)? */
export function isValidComponentKey(component: unknown): component is string {
  return typeof component === 'string' && SEGMENT.test(component) && !FORBIDDEN_SEGMENTS.has(component);
}

/** Same address, component and field? */
export function sameComponentTarget(a: ComponentParamTarget, b: ComponentParamTarget): boolean {
  return a.address === b.address && a.component === b.component && a.field === b.field;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Result of reading `selection[]`. */
export interface ComponentSelectionParseResult {
  selection: ComponentParamSelection[];
  /** One message per dropped entry. */
  issues: string[];
}

/**
 * Reads a stored `selection[]`. Never throws: an entry without a usable address,
 * component or field, or with a non-numeric range, is dropped and named in `issues`; a
 * duplicate keeps its first occurrence. Absent → empty.
 */
export function parseComponentSelection(raw: unknown): ComponentSelectionParseResult {
  const issues: string[] = [];
  if (raw === undefined) return { selection: [], issues };
  if (!Array.isArray(raw)) return { selection: [], issues: ['PlanningScenarios.selection is not a list; it is ignored.'] };
  const selection: ComponentParamSelection[] = [];
  for (const item of raw) {
    if (!isRecord(item)) { issues.push('A selection entry is not an object; dropped.'); continue; }
    const { address, component, field } = item;
    const name = `'${String(component)}.${String(field)}'`;
    if (typeof address !== 'string' || address === '' || !isValidComponentKey(component) || !isValidComponentFieldPath(field)) {
      issues.push(`Selection entry ${name} at '${String(address)}' is not usable; dropped.`);
      continue;
    }
    const entry: ComponentParamSelection = { address, component, field };
    if (selection.some((e) => sameComponentTarget(e, entry))) { issues.push(`Selection entry ${name} appears twice; the second one is dropped.`); continue; }
    const badRange = (['min', 'max', 'step'] as const).some((k) => item[k] !== undefined && !(typeof item[k] === 'number' && Number.isFinite(item[k])));
    if (badRange) { issues.push(`Selection entry ${name} has a non-numeric range; dropped.`); continue; }
    for (const k of ['min', 'max', 'step'] as const) if (item[k] !== undefined) entry[k] = item[k] as number;
    if (typeof item.label === 'string' && item.label.trim()) entry.label = item.label.trim();
    if (typeof item.group === 'string' && item.group.trim()) entry.group = item.group.trim();
    selection.push(entry);
  }
  return { selection, issues };
}

/** JSON payload of a selection (stable field order). */
export function componentSelectionPayload(selection: readonly ComponentParamSelection[]): Array<Record<string, unknown>> {
  return selection.map((e) => {
    const out: Record<string, unknown> = { address: e.address, component: e.component, field: e.field };
    for (const k of ['label', 'group', 'min', 'max', 'step'] as const) if (e[k] !== undefined) out[k] = e[k];
    return out;
  });
}

/** Same entries in the same order (all fields compared)? */
export function sameComponentSelection(
  a: readonly ComponentParamSelection[] | undefined,
  b: readonly ComponentParamSelection[] | undefined,
): boolean {
  return JSON.stringify(componentSelectionPayload(a ?? [])) === JSON.stringify(componentSelectionPayload(b ?? []));
}

/** Is `target` part of `selection`? */
export function isComponentSelected(selection: readonly ComponentParamSelection[] | undefined, target: ComponentParamTarget): boolean {
  return (selection ?? []).some((e) => sameComponentTarget(e, target));
}
