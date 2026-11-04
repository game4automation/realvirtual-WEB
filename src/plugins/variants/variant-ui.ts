// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * variant-ui — the small shared state and helpers of the Concept D surface (plan-2013).
 *
 * Lazy: loaded with the variants runtime, never from the startup path. Holds
 *  - the runtime the inspector field rows see (they are rendered by the inspector, not by
 *    a slot, so they cannot be handed a runtime through props),
 *  - the open/closed state of the read-only compare table,
 *  - the field-level questions the marker and the popover ask: is this field variable, what
 *    is its Base value, and does an override happen to EQUAL Base (the second dimension of
 *    Concept D's icon — an explicit override that currently matches Base is still an
 *    override and must stay visible).
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import type { BaseValue, FieldKey } from '../../core/params/rv-param-field';
import { overrideKey, type Variant, type VariantValue } from '../../core/variants/rv-variant-model';
import { noVariantFieldInfo, type VariantFieldInfo } from '../../core/variants/rv-variant-index';
import type { VariantsRuntime } from './variants-runtime';

const listeners = new Set<() => void>();
let runtime: VariantsRuntime | null = null;
let compareOpen = false;
let version = 0;

function publish(): void {
  version++;
  for (const fn of [...listeners]) fn();
}

/** Subscribe for React (`useSyncExternalStore`). */
export function subscribeVariantUi(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

export function variantUiVersion(): number { return version; }

/** Published while the runtime's UI is registered. */
export function setVariantUiRuntime(next: VariantsRuntime | null): void {
  if (runtime === next) return;
  runtime = next;
  if (!next) compareOpen = false;
  publish();
}

export function getVariantUiRuntime(): VariantsRuntime | null { return runtime; }

export function isCompareOpen(): boolean { return compareOpen; }

export function setCompareOpen(open: boolean): void {
  if (compareOpen === open) return;
  compareOpen = open;
  publish();
}

// ─── Field questions ───────────────────────────────────────────────────────

/** The `FieldKey` of an inspector row, or null when its node has no address. */
export function fieldKeyOf(
  viewer: RVViewer | null,
  nodePath: string | undefined,
  component: string,
  field: string,
): FieldKey | null {
  if (!viewer || !nodePath) return null;
  const node: Object3D | null = viewer.registry?.getNode(nodePath) ?? null;
  const address = node ? viewer.registry?.getAddressForNode(node) ?? null : null;
  return address ? { address, component, field } : null;
}

/**
 * Can this field carry a variant value? The apply service's admission is the single
 * authority (number / integer / boolean / enum, not read-only, not a signal, not a
 * reference, not deprecated, and with a way into the model) — so the icon appears exactly
 * where a variant value would be accepted, and layout and reference rows get none.
 */
export function isVariableField(rt: VariantsRuntime | null, component: string, field: string): boolean {
  if (!rt) return false;
  try { return rt.service.checkValue(component, field, null).ok; } catch { return false; }
}

/** One field's icon state (`none` without a runtime). */
export function fieldInfoOf(rt: VariantsRuntime | null, key: FieldKey | null): VariantFieldInfo {
  if (!rt || !key) return noVariantFieldInfo();
  return rt.index.infoOf(key);
}

/**
 * The field's BASE value, or undefined when it cannot be known right now.
 *
 * The store caches the base of every field that entered a variant; while a variant drives
 * the scene the live value of ITS fields is the variant value, so for those the cache is
 * the only honest source — reading the scene would report the variant value as Base.
 */
export function baseValueOf(
  rt: VariantsRuntime | null,
  key: FieldKey | null,
  state: VariantFieldInfo['state'],
): BaseValue | undefined {
  if (!rt || !key) return undefined;
  const cached = rt.store.baseOf(key);
  if (cached) return cached;
  if (state === 'overridden') return undefined;
  return rt.service.readBase(key) ?? undefined;
}

/** `true` when an override is set here AND its value currently equals Base. */
export function overrideEqualsBase(base: BaseValue | undefined, value: VariantValue | undefined): boolean {
  if (value === undefined || !base || base.kind !== 'value') return false;
  return Object.is(base.value, value);
}

/** Variants that INHERIT Base for this field (they are affected by a Base edit). */
export function inheritingVariants(
  variants: readonly Variant[],
  info: VariantFieldInfo,
): readonly Variant[] {
  const setting = new Set(info.variants);
  return variants.filter((v) => !setting.has(v.id));
}

/** `Variant 2`, `Variant 3`, … — the first name not taken. */
export function nextVariantName(variants: readonly Variant[]): string {
  const names = new Set(variants.map((v) => v.name));
  let n = variants.length === 0 ? 1 : 2;
  while (names.has(`Variant ${n}`)) n++;
  return `Variant ${n}`;
}

/** `Fast copy`, `Fast copy 2`, … */
export function copyVariantName(name: string, variants: readonly Variant[]): string {
  const names = new Set(variants.map((v) => v.name));
  const first = `${name} copy`;
  if (!names.has(first)) return first;
  let n = 2;
  while (names.has(`${first} ${n}`)) n++;
  return `${first} ${n}`;
}

/** The human reason of a refused store/command result. */
export function resultProblem(result: { ok: boolean; error?: string; detail?: string }): string | null {
  if (result.ok) return null;
  if (result.error === 'name-taken') return 'A variant with this name already exists.';
  return result.detail ?? result.error ?? 'refused';
}

/** Stable key of a field, for React keys and test ids. */
export function fieldIdOf(key: FieldKey): string { return overrideKey(key); }
