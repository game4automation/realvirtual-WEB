// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-recovery — ONE truth per document after a crash (plan-711 §2.4,
 * F5).
 *
 * A shared document is persisted twice, and that is by design rather than by
 * accident: the op log goes into the frame keyspace (`rv-document-drafts`), and
 * the scene keeps baking GLB bytes so its own view survives a reload without
 * replaying anything. Two records, one document — so somebody has to decide
 * which one describes it, and the decision has to be the SAME on every path,
 * every time, or "one recovery truth" is just a sentence in a plan.
 *
 * ## The rule, in one line
 *
 * **The op record leads; the bytes are a cache of a PREFIX of it.**
 *
 * The log is the document (that is what the whole op model says); the bytes are
 * what `materialise()` could make of part of it, which is strictly less — the
 * spike measured `materialise` dropping all eleven asset-lineage kinds without
 * a word (MESSUNG b1). So a record and a slot never "compete": one is the
 * document, the other is a rendering of its first N ops.
 *
 * ## What the stamp buys, and the transition moment
 *
 * The cache is only USABLE when it can prove which prefix it holds — that is
 * {@link RvDraftBytesCache}: slot, revision, floor. Three things can go wrong,
 * and all three get the same, deterministic answer:
 *
 *  - **no stamp at all** — the record predates the stamp, or the bytes do. This
 *    is the transition moment the plan names by name (an old bytes slot beside
 *    a record written by a build that already knows about frames);
 *  - **another slot** — the bytes belong to a different address;
 *  - **another revision** — the bytes moved on after the record was written, so
 *    what prefix they hold is unknown.
 *
 * In every one of them the cache is STALE, which is a statement about the
 * cache and never about the truth: the record still decides, and it decides
 * that the bytes may not be used as a replay base. The caller then shows the
 * bytes as they are (they are a self-consistent older state of the same
 * document) and reports what could not be reinstated, rather than replaying a
 * log of unknown overlap onto them and doubling half of it.
 *
 * ## Why the foreign ops are counted rather than replayed
 *
 * The tail may hold ops of the OTHER projection. Replaying those into this one
 * does not fail — it runs against the wrong tree (Spike (a)/(e3)), which is the
 * measurement `rv-document-projection` exists for. So the tail is filtered with
 * the same {@link projectedOps} the recompose uses, and what it drops is
 * REPORTED. A recovery that silently reinstated 3 of 5 ops would be the exact
 * failure mode this module was written to end.
 */

import type { RvDocumentDraft } from './rv-document-drafts';
import { projectedOps } from './rv-document-projection';
import type { RvOp } from './rv-unified-ops';
import type { RvDocumentMode } from './rv-unified-executors';

/** The bytes projection as the caller finds it in storage right now. */
export interface RvRecoveryBytes {
  slot: string;
  revision: string;
}

/** Why the bytes cache may not serve as a replay base. */
export type RvRecoveryCacheState = 'valid' | 'unstamped' | 'moved' | 'absent';

export interface RvDocumentRecovery {
  /** Which record describes the document. `none` = nothing was left behind. */
  truth: 'ops' | 'bytes' | 'none';
  /** Whether the bytes may be used as the base the {@link tail} replays onto. */
  cache: RvRecoveryCacheState;
  /**
   * The ops to replay onto the bytes, already filtered to `projection`.
   *
   * Empty whenever the cache is not `valid` — not because there is nothing to
   * replay, but because replaying onto an unknown prefix is the one move that
   * can double an op. {@link unreinstated} says how many that cost.
   */
  tail: RvOp[];
  /**
   * Ops of the record that this recovery does NOT put back on screen: the
   * foreign-projection ones, plus everything in the tail when the cache is
   * stale. Reported so a caller cannot omit what it was never told about — the
   * same contract `cleanAncestors` has one module over.
   */
  unreinstated: number;
  /** The record that decided, when one did. */
  record: RvDocumentDraft | null;
}

/**
 * Decide, once, what a document's leftovers mean.
 *
 * Pure: two records in, one verdict out. No IndexedDB, no scene store, no
 * viewer — which is what lets the rule be pinned exhaustively
 * (`tests/shared-draft-recovery.test.ts`) instead of being re-derived at each
 * of the two call sites.
 */
export function decideDocumentRecovery(input: {
  frame: RvDocumentDraft | null;
  bytes: RvRecoveryBytes | null;
  /** The projection the caller is going to rebuild. */
  projection: RvDocumentMode;
}): RvDocumentRecovery {
  const { frame, bytes, projection } = input;

  // An empty log is not a truth about anything: the record exists but says the
  // document is at its baseline, so whatever bytes there are describe it.
  if (!frame || frame.ops.length === 0) {
    return {
      truth: bytes ? 'bytes' : 'none',
      cache: bytes ? 'valid' : 'absent',
      tail: [],
      unreinstated: 0,
      record: null,
    };
  }

  const stamp = frame.bytesCache ?? null;
  const cache: RvRecoveryCacheState = !bytes
    ? 'absent'
    : !stamp
      ? 'unstamped'
      : stamp.slot !== bytes.slot || stamp.revision !== bytes.revision
        ? 'moved'
        : 'valid';

  // `|| !stamp` is the type narrowing, not a second rule: `valid` already
  // implies a stamp, and spelling it out keeps the slice below total.
  if (cache !== 'valid' || !stamp) {
    return {
      truth: 'ops',
      cache,
      tail: [],
      // Nothing of the log is put back — the bytes stand as they are.
      unreinstated: frame.ops.length,
      record: frame,
    };
  }

  // `floor` is a count, not an index, and a record written by a build with a
  // different idea of either would otherwise slice nonsense. Clamped rather
  // than trusted, for the same reason `toDocumentDraft` recomputes the key.
  const floor = Math.max(0, Math.min(stamp.floor, frame.ops.length));
  const rest = frame.ops.slice(floor);
  const tail = projectedOps(rest, projection);
  return {
    truth: 'ops',
    cache,
    tail,
    unreinstated: rest.length - tail.length,
    record: frame,
  };
}

/** One line for the log, so a lossy recovery is never silent. */
export function describeDocumentRecovery(
  recovery: RvDocumentRecovery,
  name: string,
): string | null {
  if (recovery.truth !== 'ops') return null;
  if (recovery.cache === 'valid' && recovery.unreinstated === 0) {
    return recovery.tail.length > 0
      ? `Recovered ${recovery.tail.length} unsaved change(s) for "${name}".`
      : null;
  }
  const why = recovery.cache === 'valid'
    ? 'they belong to the other projection'
    : 'the stored bytes cannot be matched to the change log';
  return `"${name}" came back with ${recovery.unreinstated} unsaved change(s) left out — ${why}.`;
}
