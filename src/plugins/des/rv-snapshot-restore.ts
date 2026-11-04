// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { preflightSnapshot, type PreflightContext, type Problem } from './rv-des-preflight';
import type { DESSnapshotV4 } from './rv-des-snapshot-v4';
import type { SnapshotRegistry } from './rv-snapshot-registry';

export interface DeferredReactionError { label: string | undefined; error: unknown }
export interface DeferredReactions {
  defer(fn: () => void, label?: string): void;
  runAll(): DeferredReactionError[];
  discard(): number;
  readonly size: number;
}

/** Transaction-local FIFO. Reactions queued by reactions are drained in the same run. */
export function createDeferredReactions(): DeferredReactions {
  const pending: Array<{ fn: () => void; label?: string }> = [];
  return {
    defer(fn, label) { pending.push({ fn, label }); },
    runAll() {
      const errors: DeferredReactionError[] = [];
      while (pending.length) {
        const { fn, label } = pending.shift()!;
        try { fn(); } catch (error) { errors.push({ label, error }); }
      }
      return errors;
    },
    discard() { const count = pending.length; pending.length = 0; return count; },
    get size() { return pending.length; },
  };
}

export type RestoreHookResult = void | { ok: true } | { ok: false; reason: unknown };
export interface RestoreHook { label: string; run(): RestoreHookResult }
export interface RestoreFailure {
  ok: false;
  stage: 'preflight' | 'prepare' | 'commit' | 'finalize';
  status: 'unchanged' | 'corrupt';
  participant?: string;
  hook?: string;
  problems?: Problem[];
  cause?: unknown;
  deferredErrors?: DeferredReactionError[];
  discarded: number;
  /** A reporting failure must never hide the original restore failure. */
  onCorruptCause?: unknown;
}
export type RestoreResult = { ok: true } | RestoreFailure;
export interface RestoreContext {
  registry: SnapshotRegistry;
  /** Participant versions/validators always come from registry.order(). */
  preflight: Omit<PreflightContext, 'participants'>;
  deferred: DeferredReactions;
  /** Stop external execution only; must not mutate snapshot state. */
  detach?(): void;
  hooks?: readonly RestoreHook[];
  onCorrupt?(info: RestoreFailure): void;
}

/** Also honor explicit failures from callbacks implemented outside TypeScript. */
function checkResult(result: unknown): void {
  if (result !== null && typeof result === 'object' && 'ok' in result && result.ok === false)
    throw ('reason' in result ? result.reason : result);
}

/** All prepares are pure allocations; commits only swap references on existing owners.
 * There is no rollback after the first commit attempt, including finalization failures.
 */
export function restoreTransaction(raw: unknown, ctx: RestoreContext): RestoreResult {
  let stage: RestoreFailure['stage'] = 'preflight';
  let participant: string | undefined;
  let hook: string | undefined;
  let committing = false;
  const fail = (details: Partial<RestoreFailure>): RestoreFailure => {
    const failure: RestoreFailure = {
      ok: false, stage, status: committing ? 'corrupt' : 'unchanged',
      participant, hook, ...details, discarded: ctx.deferred.discard(),
    };
    if (committing) try { ctx.onCorrupt?.(failure); }
    catch (error) { failure.onCorruptCause = error; }
    return failure;
  };
  try {
    ctx.detach?.();
    const ordered = ctx.registry.order();
    const preflight = preflightSnapshot(raw, {
      ...ctx.preflight, participants: new Map(ordered.map(p => [p.key, p])),
    });
    if (!preflight.ok) return fail({ problems: preflight.problems });
    const parts = new Map((raw as DESSnapshotV4).parts.map(p => [p.key, p]));
    stage = 'prepare';
    const prepared: unknown[] = [];
    for (const p of ordered) {
      participant = p.key;
      prepared.push(p.prepare(parts.get(p.key)!.state));
    }
    stage = 'commit';
    for (let i = 0; i < ordered.length; i++) {
      participant = ordered[i].key;
      committing = true;
      checkResult(ordered[i].commit(prepared[i]));
    }
    stage = 'finalize';
    for (const p of ordered) {
      participant = p.key;
      checkResult(p.onRestore?.());
    }
    participant = undefined;
    for (const h of ctx.hooks ?? []) {
      hook = h.label;
      checkResult(h.run());
    }
    hook = undefined;
    const errors = ctx.deferred.runAll();
    if (errors.length) return fail({ cause: errors[0].error, deferredErrors: errors });
    return { ok: true };
  } catch (cause) { return fail({ cause }); }
}
