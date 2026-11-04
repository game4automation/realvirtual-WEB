// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { getActionSchema } from './rv-des-named-actions';
import type { SnapshotJson } from './rv-snapshot-contract';

export interface PersistableQueueEvent {
  id: number;
  time: number;
  action: string;
  componentId: string | null;
  muId: number;
  priority: number;
  data?: SnapshotJson;
}

export interface PersistableQueueContext {
  participants: ReadonlySet<string>;
  replanOnRestore?: ReadonlySet<string>;
  componentTypeOf(componentId: string): string | undefined;
  /** Explicit DES owners for non-persistent actions; defaults to known components/participants. */
  desOwners?: ReadonlySet<string>;
}

export interface PersistableQueueError {
  code: 'des-snapshot-contract';
  eventId: number;
  action: string;
  reason: string;
}

/** Collect persistence diagnostics without touching the queue or dispatch tables. */
export function assertPersistableQueue(
  events: readonly PersistableQueueEvent[],
  ctx: PersistableQueueContext,
): PersistableQueueError[] {
  const errors: PersistableQueueError[] = [];
  for (const event of events) {
    const error = (reason: string): void => {
      errors.push({ code: 'des-snapshot-contract', eventId: event.id, action: event.action, reason });
    };
    const schema = getActionSchema(event.action);
    if (schema === undefined) {
      error('action has no persistence schema');
      continue;
    }
    if (schema !== 'non-persistent' && schema.originRequired) {
      const reason = callbackOriginProblem(event, ctx.replanOnRestore);
      if (reason) error(reason);
      continue;
    }
    if (schema === 'non-persistent') {
      const owner = event.componentId;
      if (owner !== null && (ctx.desOwners
        ? ctx.desOwners.has(owner)
        : ctx.participants.has(owner) || ctx.componentTypeOf(owner) !== undefined))
        error(`non-persistent action belongs to DES owner '${owner}'`);
      continue;
    }
    if (schema.owner === 'component') {
      const type = event.componentId === null ? undefined : ctx.componentTypeOf(event.componentId);
      if (type === undefined) error(`unknown component '${event.componentId}'`);
      else if (schema.targetType !== undefined && schema.targetType !== type)
        error(`target type '${type}' does not match '${schema.targetType}'`);
      if (event.componentId === null || !ctx.participants.has(event.componentId))
        error(`owner participant '${event.componentId}' is not registered`);
    } else if (!ctx.participants.has(schema.owner)) {
      error(`owner participant '${schema.owner}' is not registered`);
    }
    if (schema.payload === 'none') {
      if (event.data != null) error('action declares no payload');
    } else {
      // An absent payload has the same JSON representation as null.
      for (const reason of schema.payload(event.data ?? null)) error(reason);
    }
  }
  return errors;
}

/** Throw with the complete structured diagnostics attached for capture/preflight callers. */
export function assertPersistableQueueOrThrow(
  events: readonly PersistableQueueEvent[],
  ctx: PersistableQueueContext,
): void {
  const errors = assertPersistableQueue(events, ctx);
  if (errors.length) throw Object.assign(new Error(errors.map(e =>
    `${e.code}: event ${e.eventId} (${e.action}): ${e.reason}`).join('\n')),
  { ...errors[0], errors });
}

/** Shared by capture and preflight, including injected schema lookups. */
export function callbackOriginProblem(event: PersistableQueueEvent, owners?: ReadonlySet<string>): string | null {
  const data = event.data as { origin?: { owner?: unknown; kind?: unknown } } | undefined;
  const origin = data?.origin;
  return origin && typeof origin.owner === 'string' && origin.owner.length > 0
    && (origin.kind === 'ui' || origin.kind === 'replan' && owners?.has(origin.owner))
    ? null : 'callback without restorable origin';
}
