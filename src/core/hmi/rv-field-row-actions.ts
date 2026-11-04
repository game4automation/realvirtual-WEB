// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-field-row-actions — small per-FIELD actions a plugin adds to the Property
 * Inspector's field rows (plan-630 Phase 8: "Show in planning window").
 *
 * `componentActionRegistry` adds buttons to a whole component section; a field row has
 * no such hook, and the inspector must not learn about every feature that wants one. A
 * plugin registers an action with a cheap, synchronous `applies` test and a component;
 * `FieldRow` renders the components of the actions that apply in its trailing slot —
 * inside a `Suspense`, so a `React.lazy` component keeps its code out of the entry chunk.
 * A row no action applies to renders exactly as before (no trailing slot at all).
 */

import type { ComponentType } from 'react';
import type { RVViewer } from '../rv-viewer';

/** What an action sees of the row. */
export interface FieldRowActionContext {
  readonly viewer: RVViewer | null;
  /** Registry path of the node that carries the field. */
  readonly nodePath?: string;
  /** Concrete component key of the section (`Source`, `Drive_1`). */
  readonly componentType: string;
  readonly fieldName: string;
}

/** One registered field-row action. */
export interface FieldRowAction {
  readonly id: string;
  /** Synchronous and cheap — runs for every field row on every render. */
  applies(ctx: FieldRowActionContext): boolean;
  /** Rendered in the row's trailing slot (may be `React.lazy`). */
  readonly component: ComponentType<FieldRowActionContext>;
  /** Subscribe and read a scalar snapshot for this row only. */
  subscribeValue?(listener: () => void): () => void;
  readValue?(ctx: FieldRowActionContext): unknown;
  /**
   * Optional row styling of an action that applies (plan-2013, Concept D: the row of a
   * field the variant in the scene overrides is "additionally marked"). Synchronous and
   * cheap, like `applies` — it runs for every row the action applies to. Merged into the
   * row's `sx` after the AI choreography, so a marked row still shows the afterglow.
   */
  rowSx?(ctx: FieldRowActionContext): Record<string, unknown> | undefined;
}

const actions: FieldRowAction[] = [];

/** Registers an action (replaces one with the same id); returns the unregister. */
export function registerFieldRowAction(action: FieldRowAction): () => void {
  const at = actions.findIndex((a) => a.id === action.id);
  if (at >= 0) actions.splice(at, 1, action);
  else actions.push(action);
  return () => {
    const i = actions.indexOf(action);
    if (i >= 0) actions.splice(i, 1);
  };
}

/** The actions that apply to one row, in registration order. */
export function fieldRowActionsFor(ctx: FieldRowActionContext): FieldRowAction[] {
  if (actions.length === 0) return [];
  const out: FieldRowAction[] = [];
  for (const a of actions) {
    try { if (a.applies(ctx)) out.push(a); } catch { /* a broken action must never break the inspector */ }
  }
  return out;
}

/** The merged row styling of the actions that apply (empty object when none styles the row). */
export function fieldRowDecorationFor(
  ctx: FieldRowActionContext,
  applying: readonly FieldRowAction[],
): Record<string, unknown> | undefined {
  let out: Record<string, unknown> | undefined;
  for (const a of applying) {
    if (!a.rowSx) continue;
    try {
      const sx = a.rowSx(ctx);
      if (sx) out = out ? { ...out, ...sx } : sx;
    } catch { /* a broken action must never break the inspector */ }
  }
  return out;
}
