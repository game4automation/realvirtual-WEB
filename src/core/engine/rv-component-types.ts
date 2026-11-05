// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-component-types.ts — which component types a subtree carries (plan-652 Phase 3).
 *
 * The on-demand features (DES today) are activated by the component types a model
 * brings (`component:<type>` triggers). Component construction is synchronous, so the
 * feature must be active BEFORE it: the async load entries (`loadGLB`, the placement
 * instancer) collect the types with {@link collectComponentTypes} and await
 * `features.ensureForComponentTypes(types)` first.
 *
 * The synchronous entries (`processExtras`, `constructComponentOnNode`) cannot wait.
 * They report a type without a factory to the {@link setDeferredComponentHandler}
 * hook; the viewer answers with an activation and a visible warning. Without a
 * handler (embedder, unit tests) nothing happens — exactly the behaviour before.
 */

import type { Object3D } from 'three';
import type { RVExtrasOverlay } from './rv-extras-overlay-store';

/** Strips the `_<n>` suffix of a second component of the same type (`Drive_1`). */
function baseType(key: string): string {
  // Hot path of the prescan: no regex, no allocation unless the key ends in a digit.
  const last = key.charCodeAt(key.length - 1);
  if (last < 48 || last > 57) return key;
  let i = key.length - 1;
  while (i > 0 && key.charCodeAt(i - 1) >= 48 && key.charCodeAt(i - 1) <= 57) i--;
  return i >= 1 && key.charCodeAt(i - 1) === 95 /* _ */ ? key.slice(0, i - 1) : key;
}

/** A component field whose value needs another type's feature. */
interface FieldTypeTrigger {
  readonly field: string;
  readonly yields: string;
  readonly when: (value: unknown) => boolean;
}

const FIELD_TRIGGERS = new Map<string, FieldTypeTrigger[]>();

/**
 * Declares that a `type` component whose `field` satisfies `when` needs the feature of
 * `yields`, as if its node carried a `yields` component (plan-781 F21:
 * `Source.CollisionRoleForMUs ≠ None` needs `CollisionRole`). Registered by the module
 * that owns `yields`; idempotent per (type, field, yields).
 */
export function registerFieldTypeTrigger(
  type: string, field: string, yields: string, when: (value: unknown) => boolean,
): void {
  const list = FIELD_TRIGGERS.get(type) ?? [];
  if (list.some((t) => t.field === field && t.yields === yields)) return;
  list.push({ field, yields, when });
  FIELD_TRIGGERS.set(type, list);
}

/** The field triggers per type whose result is wanted (all of them when `wanted` is null). */
function fieldTriggersFor(wanted: ReadonlySet<string> | null): Map<string, FieldTypeTrigger[]> | null {
  if (FIELD_TRIGGERS.size === 0) return null;
  let out: Map<string, FieldTypeTrigger[]> | null = null;
  for (const [type, list] of FIELD_TRIGGERS) {
    const hits = wanted ? list.filter((t) => wanted.has(t.yields)) : list;
    if (hits.length > 0) (out ??= new Map()).set(type, hits);
  }
  return out;
}

/** Adds the types one component entry's field triggers yield; returns how many were new. */
function addFieldTypes(types: Set<string>, triggers: readonly FieldTypeTrigger[], fields: unknown): number {
  if (!fields || typeof fields !== 'object') return 0;
  let added = 0;
  for (const t of triggers) {
    if (types.has(t.yields) || !t.when((fields as Record<string, unknown>)[t.field])) continue;
    types.add(t.yields);
    added++;
  }
  return added;
}

/**
 * The component types (rv_extras keys of `userData.realvirtual`) of every node under
 * `root`, plus the types an overlay introduces (it is applied later, during the
 * traversal, and can add components). One cheap pass; keys only — except the one
 * field a registered field trigger reads ({@link registerFieldTypeTrigger}).
 *
 * With `wanted` (the trigger types of the declared, inactive features) only those
 * types are collected and the walk stops as soon as all of them were seen; an empty
 * `wanted` skips the walk. The walk is an explicit stack over `children` — no
 * closure call, no `Object.keys` array, no regex per node (plan-652: ≤ 15 ms on the
 * 193 MB model).
 */
export function collectComponentTypes(
  root: Object3D,
  overlay?: RVExtrasOverlay | null,
  wanted?: ReadonlySet<string> | null,
): Set<string> {
  const types = new Set<string>();
  if (wanted && wanted.size === 0) return types;
  let missing = wanted ? wanted.size : -1;
  const fieldTriggers = fieldTriggersFor(wanted ?? null);
  const stack: Object3D[] = [root];
  walk: while (stack.length > 0) {
    const node = stack.pop()!;
    const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
    if (rv && typeof rv === 'object') {
      for (const key in rv) {
        const type = baseType(key);
        const triggers = fieldTriggers?.get(type);
        if (triggers) {
          missing -= addFieldTypes(types, triggers, rv[key]);
          if (wanted && missing === 0) break walk;
        }
        if (wanted) {
          if (!wanted.has(type) || types.has(type)) continue;
          types.add(type);
          if (--missing === 0) break walk;
        } else {
          types.add(type);
        }
      }
    }
    const children = node.children;
    for (let i = children.length - 1; i >= 0; i--) stack.push(children[i]!);
  }
  if (wanted) {
    if (overlay?.nodes) {
      for (const t of addPatchTypes(new Set<string>(), overlay.nodes)) if (wanted.has(t)) types.add(t);
    }
  } else {
    addPatchTypes(types, overlay?.nodes);
  }
  return types;
}

/** Adds the component types of `{ <node>: { <type>: fields } }` patches (overlay, placement overrides). */
export function addPatchTypes(
  types: Set<string>,
  patches: Record<string, Record<string, unknown>> | null | undefined,
): Set<string> {
  if (!patches) return types;
  const fieldTriggers = fieldTriggersFor(null);
  for (const patch of Object.values(patches)) {
    if (!patch || typeof patch !== 'object') continue;
    for (const key of Object.keys(patch)) {
      const type = baseType(key);
      types.add(type);
      const triggers = fieldTriggers?.get(type);
      if (triggers) addFieldTypes(types, triggers, patch[key]);
    }
  }
  return types;
}

// ── Safety net for the synchronous build entries ─────────────────────────

/**
 * Answers a component type a synchronous build met without a factory.
 * `retry` (when given) builds the component once the feature is active.
 */
export interface DeferredComponentHandler {
  /** False when no on-demand feature with component triggers is waiting — skips the scan. */
  anyDeferred(): boolean;
  /** True when an on-demand feature declares this type and is not active yet. */
  isDeferred(type: string): boolean;
  /** Activates the feature; `where` names the build entry for the warning. */
  defer(type: string, where: string, retry?: () => void): void;
}

let handler: DeferredComponentHandler | null = null;

//! Installs (or clears with `null`) the handler — the viewer does this once.
export function setDeferredComponentHandler(next: DeferredComponentHandler | null): void {
  handler = next;
}

//! Clears the handler only when it is still `mine` (a later viewer may own it).
export function clearDeferredComponentHandler(mine: DeferredComponentHandler): void {
  if (handler === mine) handler = null;
}

//! Reports a type without factory; true when it belongs to an on-demand feature.
export function noteDeferredComponentType(type: string, where: string, retry?: () => void): boolean {
  if (!handler) return false;
  try {
    if (!handler.isDeferred(type)) return false;
    handler.defer(type, where, retry);
    return true;
  } catch {
    return false;
  }
}

//! Reports every on-demand type under `root` (a synchronous subtree build).
export function noteDeferredComponentTypes(root: Object3D, where: string): void {
  if (!handler || !handler.anyDeferred()) return;
  for (const type of collectComponentTypes(root)) noteDeferredComponentType(type, where);
}
