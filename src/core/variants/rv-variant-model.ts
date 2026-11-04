// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-variant-model — what a variant IS (plan-2013 §2.3). Pure, Node-testable, lazy.
 *
 * A variant is a named, sparse set of value overrides over the base document: only
 * values (T2), each `{address, component, field, value}`, at most once per field. "Back to
 * Base" for a field is removing its override, never a stored `null`. The block lives at
 * `scenes[0].extras.realvirtual.Variants` beside `DocumentInfo`.
 */

import type { BaseValue, FieldKey, FieldOp, ParamValue } from '../params/rv-param-field';

export type { FieldKey } from '../params/rv-param-field';

/** A variant value; `string` = an enum option. */
export type VariantValue = ParamValue;

/** One override of a variant. */
export interface VariantOverride {
  readonly address: string;
  readonly component: string;
  readonly field: string;
  readonly value: VariantValue;
}

/** One variant. */
export interface Variant {
  readonly id: string;
  readonly name: string;
  /** +1 on every change of the overrides (not on rename or a new description). */
  readonly revision: number;
  readonly overrides: readonly VariantOverride[];
  /** What this variant is meant to show — free text for people, never part of a run's identity. */
  readonly description?: string;
}

/** `scenes[0].extras.realvirtual.Variants`. */
export interface VariantsBlock {
  readonly version: 1;
  /** Variant id, or null = Base. */
  readonly active: string | null;
  readonly variants: readonly Variant[];
  /** Description of the Base configuration (the reference column). */
  readonly baseDescription?: string;
}

/** A finding while reading a block. */
export interface VariantIssue {
  readonly code: 'variants-version' | 'variants-malformed' | 'variant-duplicate' | 'variant-override-invalid';
  readonly detail: string;
}

/** A variant frozen for one run: a deep, immutable copy. */
export type FrozenVariant = Readonly<Variant>;

export const RV_VARIANTS_KEY = 'Variants';
export const MAX_VARIANT_NAME = 64;
/** Longest description of a variant or of Base, in characters. */
export const MAX_VARIANT_DESCRIPTION = 500;

/** A usable description: trimmed, capped, `undefined` when empty or not text. */
export function normalizeDescription(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const text = raw.trim().slice(0, MAX_VARIANT_DESCRIPTION);
  return text ? text : undefined;
}

/** Stable key of a field. */
export function overrideKey(k: FieldKey): string {
  return `${k.address}|${k.component}|${k.field}`;
}

/** The empty block (Base only). */
export function emptyVariantsBlock(): VariantsBlock {
  return { version: 1, active: null, variants: [] };
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isScalar(v: unknown): v is VariantValue {
  return (typeof v === 'number' && Number.isFinite(v)) || typeof v === 'boolean' || typeof v === 'string';
}

/**
 * Reads the block from `extras.realvirtual` (or the block itself). Unknown versions are not
 * read (the document keeps them untouched); duplicate ids / names / fields are dropped and
 * reported. `block === null` = nothing usable.
 */
export function parseVariantsBlock(raw: unknown): { block: VariantsBlock | null; issues: VariantIssue[] } {
  const issues: VariantIssue[] = [];
  const src = isRecord(raw) && isRecord(raw[RV_VARIANTS_KEY]) ? raw[RV_VARIANTS_KEY] : raw;
  if (src === undefined || src === null) return { block: null, issues };
  if (!isRecord(src)) return { block: null, issues: [{ code: 'variants-malformed', detail: 'the Variants block is not an object' }] };
  if (src.version !== 1) {
    return { block: null, issues: [{ code: 'variants-version', detail: `Variants version ${String(src.version)} is not supported` }] };
  }
  const list = Array.isArray(src.variants) ? src.variants : [];
  const ids = new Set<string>();
  const names = new Set<string>();
  const variants: Variant[] = [];
  for (const v of list) {
    if (!isRecord(v) || typeof v.id !== 'string' || !v.id || typeof v.name !== 'string' || !v.name) {
      issues.push({ code: 'variants-malformed', detail: 'a variant without id or name was dropped' });
      continue;
    }
    if (ids.has(v.id) || names.has(v.name)) {
      issues.push({ code: 'variant-duplicate', detail: `variant '${v.name}' (${v.id}) appears twice — the second was dropped` });
      continue;
    }
    const seen = new Set<string>();
    const overrides: VariantOverride[] = [];
    for (const o of Array.isArray(v.overrides) ? v.overrides : []) {
      if (!isRecord(o) || typeof o.address !== 'string' || typeof o.component !== 'string'
        || typeof o.field !== 'string' || !isScalar(o.value)) {
        issues.push({ code: 'variant-override-invalid', detail: `an override of '${v.name}' was dropped` });
        continue;
      }
      const ov: VariantOverride = { address: o.address, component: o.component, field: o.field, value: o.value };
      const key = overrideKey(ov);
      if (seen.has(key)) {
        issues.push({ code: 'variant-duplicate', detail: `'${v.name}' sets ${o.component}.${o.field} twice — the second was dropped` });
        continue;
      }
      seen.add(key);
      overrides.push(ov);
    }
    ids.add(v.id);
    names.add(v.name);
    const revision = typeof v.revision === 'number' && Number.isInteger(v.revision) && v.revision >= 0 ? v.revision : 0;
    const description = normalizeDescription(v.description);
    variants.push({ id: v.id, name: v.name, revision, overrides, ...(description ? { description } : {}) });
  }
  const active = typeof src.active === 'string' && ids.has(src.active) ? src.active : null;
  const baseDescription = normalizeDescription(src.baseDescription);
  return { block: { version: 1, active, variants, ...(baseDescription ? { baseDescription } : {}) }, issues };
}

/** JSON payload of the block; `null` when there is no variant (the block is removed). */
export function serializeVariantsBlock(b: VariantsBlock): Record<string, unknown> | null {
  if (b.variants.length === 0) return null;
  return JSON.parse(JSON.stringify({ version: 1, active: b.active, variants: b.variants,
    ...(b.baseDescription ? { baseDescription: b.baseDescription } : {}) })) as Record<string, unknown>;
}

/** A deep, frozen copy of a variant (one run uses exactly this revision). */
export function freezeVariant(v: Variant): FrozenVariant {
  const overrides = Object.freeze(v.overrides.map((o) => Object.freeze({ ...o })));
  return Object.freeze({ id: v.id, name: v.name, revision: v.revision, overrides });
}

/**
 * The full target op set when `to` replaces `from` in the scene (§2.5): every value of `to`,
 * plus "back to base" for every field only `from` set. A field without a base-cache entry
 * (its node did not exist at Base) gets no restore op — Base has nothing to restore there.
 */
export function targetOps(
  from: Variant | null,
  to: Variant | null,
  base: (key: string) => BaseValue | undefined,
): FieldOp[] {
  const ops: FieldOp[] = [];
  const toKeys = new Set<string>();
  for (const o of to?.overrides ?? []) {
    toKeys.add(overrideKey(o));
    ops.push({ address: o.address, component: o.component, field: o.field, op: 'set', value: o.value });
  }
  for (const o of from?.overrides ?? []) {
    const key = overrideKey(o);
    if (toKeys.has(key)) continue;
    const b = base(key);
    if (!b) continue;
    ops.push(b.kind === 'value'
      ? { address: o.address, component: o.component, field: o.field, op: 'set', value: b.value }
      : { address: o.address, component: o.component, field: o.field, op: 'unset' });
  }
  return ops;
}

/** One row of the variant table / `variant.diff`. */
export interface VariantDiffRow {
  readonly address: string;
  readonly component: string;
  readonly field: string;
  /** Base value; `absent` = schema default; `null` = not in this configuration. */
  readonly base: BaseValue | null;
  /** Per variant id: its override value, or undefined = inherits Base. */
  readonly values: Readonly<Record<string, VariantValue | undefined>>;
}

/** Rows = every field any variant overrides, in first-appearance order; Base first. */
export function diffRows(b: VariantsBlock, base: (k: FieldKey) => BaseValue | null): VariantDiffRow[] {
  const rows = new Map<string, { key: FieldKey; values: Record<string, VariantValue | undefined> }>();
  for (const v of b.variants) {
    for (const o of v.overrides) {
      const k = overrideKey(o);
      const row = rows.get(k) ?? { key: { address: o.address, component: o.component, field: o.field }, values: {} };
      row.values[v.id] = o.value;
      rows.set(k, row);
    }
  }
  return [...rows.values()].map((r) => ({ ...r.key, base: base(r.key), values: r.values }));
}

/** A new variant id. */
export function newVariantId(): string {
  const c = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  return `v_${c?.randomUUID ? c.randomUUID() : `${Date.now().toString(36)}${Math.random().toString(36).slice(2)}`}`;
}

/** Name rule: 1-64 characters after trimming. */
export function checkVariantName(name: string): string | null {
  const n = name.trim();
  if (n.length === 0) return 'a variant needs a name';
  if (n.length > MAX_VARIANT_NAME) return `a variant name has at most ${MAX_VARIANT_NAME} characters`;
  return null;
}
