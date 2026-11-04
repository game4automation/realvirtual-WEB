// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-des-named-actions.ts -- Named Action registry for DES event dispatch.
 *
 * Actions are registered at module load time. Each action gets an integer index
 * for O(1) dispatch from the event queue (no Map lookup in hot path).
 */

import type { ActionContext } from './rv-des-event';
import type { SnapshotJson } from './rv-snapshot-contract';

export interface ActionSchema {
  owner: 'component' | 'global' | string;
  targetType?: string;
  originRequired?: boolean;
  nonPersistent?: boolean;
  payload: 'none' | ((data: SnapshotJson) => readonly string[]);
  /** Paths in the owner's state holding event handles for this action. */
  handleFields?: readonly string[];
}

// ── Registry arrays ──

/** O(1) dispatch: ACTION_BY_INDEX[actionIdx](ctx) */
export const ACTION_BY_INDEX: Array<(ctx: ActionContext) => void> = [];

/** Name -> uint32 index (for queue storage when scheduling by name). */
export const ACTION_INDEX = new Map<string, number>();

/** Index -> name (for snapshot serialization). */
export const ACTION_NAME = new Map<number, string>();

/** Optional persistence metadata; never consulted during dispatch. */
export const ACTION_SCHEMA = new Map<string, ActionSchema | 'non-persistent'>();

export function getActionSchema(name: string): ActionSchema | 'non-persistent' | undefined {
  return ACTION_SCHEMA.get(name);
}

// ── Registration ──

/**
 * Register a named action. Called at module load time.
 * Throws on duplicate registration.
 *
 * @returns The integer index for this action.
 */
export function registerAction(
  name: string,
  fn: (ctx: ActionContext) => void,
  schema?: ActionSchema | 'non-persistent',
): number {
  if (ACTION_INDEX.has(name)) {
    throw new Error(`DES: duplicate action '${name}'`);
  }
  const idx = ACTION_BY_INDEX.length;
  ACTION_BY_INDEX.push(fn);
  ACTION_INDEX.set(name, idx);
  ACTION_NAME.set(idx, name);
  if (schema !== undefined) ACTION_SCHEMA.set(name, schema);
  return idx;
}

/**
 * Look up an action index by name. Throws if not registered.
 */
export function getActionIndex(name: string): number {
  const idx = ACTION_INDEX.get(name);
  if (idx === undefined) {
    throw new Error(`DES: unknown action '${name}'`);
  }
  return idx;
}

/**
 * Look up an action name by index. Returns undefined if not found.
 */
export function getActionName(index: number): string | undefined {
  return ACTION_NAME.get(index);
}
