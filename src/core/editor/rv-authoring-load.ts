// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-authoring-load — the AUTHORING JOIN (plan-774 F3).
 *
 * Since plan-774 an editor load defers its references like every other load:
 * `viewer.loadModel` returns with the open document's OWN content (unbaked,
 * authorable) and EMPTY reference nodes, and `viewer.placements` materialises
 * the placed assets afterwards (baked, shared — the HMI's recipe). Everything
 * the editor does after a load — rebuild the arenas, replay a draft or a
 * recompose, hand the document to the tools — needs the placed content too,
 * because an instance override (`setField` inside a placement) addresses a node
 * of a placed instance.
 *
 * `loadAuthoringModel` is the one place that waits for it:
 *
 *   1. `viewer.loadModel(url, authoring flags)`;
 *   2. wait for `whenSceneReady()` with a time BUDGET (default 60 s) — a fetch
 *      or decode that never returns is the one way placements can hang
 *      (plan-774 Phase 0 spike (b)); every failure that ENDS settles;
 *   3. identity check: is the document on screen still the one this call
 *      loaded? `whenSceneReady` follows document switches, so after a switch it
 *      resolves for the NEW document — the caller must then abort silently
 *      instead of replaying onto someone else's tree.
 *
 * Steps 2 and 3 are {@link joinScenePlacements}, exported on its own for a load
 * site that calls `loadModel` with other flags — the editor's test run
 * (plan-769 Phase 7, D24).
 *
 * On budget expiry the result is `placementsReady: false`, a Problems entry
 * `placements-still-loading` is shown and the caller continues. Ops that target
 * placed content must not be replayed before the content exists: the result
 * carries `lateSettle` (true once the placements arrived for THIS document,
 * false when it was superseded first) and {@link authoringReplayGate} turns
 * that into the gate the replay loops use — every op BEFORE the first one that
 * targets placed content replays at once, that op and everything after it wait
 * for the late settle (the order of the log is never changed).
 */

import type { Object3D } from 'three';
import { getDeferredPlacement } from '../engine/rv-asset-reference';
import { pathInPlacedContent } from '../engine/rv-reference-scope';
import { identityIdOf } from '../engine/rv-decode-identity';
import { LoadAbortedError } from '../engine/rv-scene-loader';
import { clearPlacementsStillLoading, reportPlacementsStillLoading } from '../hmi/problems-store';
import { opTargetPaths } from '../ops/rv-reference-guard';
import type { RvOp } from '../ops/rv-unified-ops';

/** Default time budget of the join, in milliseconds (plan-774 F3). */
export const AUTHORING_JOIN_BUDGET_MS = 60_000;

/** The load flags of every editor document load (plan-727 / plan-774). */
export const AUTHORING_LOAD_FLAGS = Object.freeze({ preserveHierarchy: true, preserveAuthoringHierarchy: true });

/** "Is the document I loaded still the one the user asked for?" — the caller's half of the identity check. */
export interface AuthoringIdentity {
  /** Shown in the `placements-still-loading` entry. */
  label?: string;
  /**
   * The caller's own identity test (activation epoch, test-session generation,
   * stack frame). Optional: the join always checks that the model root this
   * load produced is still `viewer.currentModelRoot`.
   */
  isCurrent?(): boolean;
}

export interface AuthoringLoadOptions {
  identity: AuthoringIdentity;
  /**
   * plan-774 F6: keep the baked placed assets of the PREVIOUS document for
   * this load (`viewer.loadModel({ keepBaked })` → `clearModel` →
   * `PlacementInstancer.clearDocument` → `ModelCache.releaseDocument`). What
   * this load does not claim is retired once its placements settled. The
   * asset editor passes true everywhere (undo-by-recompose, reproject,
   * descend, Back, test-session stop, and the open itself — the viewer's own
   * default since plan-774 Phase 3); false retires every bake at the clear.
   */
  keepBaked: boolean;
  /**
   * plan-774 F6: with `keepBaked`, this load is a DESCEND into a child whose
   * parent comes back on Back — its settle must not retire the parent's
   * other kept assets. Also true for Back to a frame that is not the stack root.
   */
  holdKept?: boolean;
  /** Time budget of the join; default {@link AUTHORING_JOIN_BUDGET_MS}. */
  budgetMs?: number;
  /** The GLB bytes, when `url` only names them (`loadModel`'s `data`). */
  data?: ArrayBuffer;
}

export type AuthoringLoadResult =
  | {
      ok: true;
      /** False when the budget ran out first — the placements are still materialising. */
      placementsReady: boolean;
      /** Placements still materialising when the join returned (0 when ready). */
      pending: number;
      /** Placements of this load (direct and nested) known when the join returned. */
      total: number;
      /**
       * Resolves `true` once every placement of THIS document settled (at once
       * when `placementsReady`), `false` when another document took the viewer
       * first. Never rejects.
       */
      lateSettle: Promise<boolean>;
    }
  | { ok: false; reason: 'superseded' };

/**
 * Thrown by an editor load site that turned `{ ok: false, reason: 'superseded' }`
 * into an exception. A {@link LoadAbortedError}, so every existing
 * "supersede is not a failure" catch treats it silently.
 */
export class AuthoringLoadSupersededError extends LoadAbortedError {
  constructor(url: string) {
    super(url);
    this.name = 'AuthoringLoadSupersededError';
  }
}

/** True for any "a newer load took the viewer" rejection (loader abort or join supersede). */
export function isSupersededLoadError(e: unknown): boolean {
  return e instanceof LoadAbortedError
    || (e instanceof Error && (e.name === 'LoadAbortedError' || e.name === 'AuthoringLoadSupersededError'));
}

/** What the join needs of the viewer — a fake in the tests satisfies it with a few fields. */
export interface AuthoringLoadViewer {
  loadModel(url: string, options?: {
    preserveHierarchy?: boolean; preserveAuthoringHierarchy?: boolean; data?: ArrayBuffer;
    keepBaked?: boolean; holdKept?: boolean;
  }): Promise<unknown>;
  whenSceneReady(): Promise<void>;
  readonly currentModelRoot: Object3D | null;
  readonly placements?: {
    readonly progress?: { readonly total: number; readonly pending: number };
  };
}

/**
 * Load `url` as the editor's authoring document and join its placements.
 *
 * Rejects only when the load itself fails (bad bytes, a bake of the
 * placements never does — it settles into a placeholder); a superseded load —
 * the loader's own abort or a document switch during the join — is the
 * `{ ok: false, reason: 'superseded' }` result.
 */
export async function loadAuthoringModel(
  viewer: AuthoringLoadViewer,
  url: string,
  opts: AuthoringLoadOptions,
): Promise<AuthoringLoadResult> {
  try {
    const keep = opts.keepBaked ? { keepBaked: true, ...(opts.holdKept ? { holdKept: true } : {}) } : { keepBaked: false };
    await viewer.loadModel(url, opts.data ? { ...AUTHORING_LOAD_FLAGS, ...keep, data: opts.data } : { ...AUTHORING_LOAD_FLAGS, ...keep });
  } catch (e) {
    if (isSupersededLoadError(e)) return { ok: false, reason: 'superseded' };
    throw e;
  }
  return joinScenePlacements(viewer, opts);
}

/** What {@link joinScenePlacements} needs: the document identity and the time budget. */
export interface ScenePlacementsJoinOptions {
  identity: AuthoringIdentity;
  /** Time budget of the join; default {@link AUTHORING_JOIN_BUDGET_MS}. */
  budgetMs?: number;
}

/**
 * Join the placements of the document `viewer` just loaded — the second half
 * of {@link loadAuthoringModel}, for any load site that called `loadModel`
 * itself (plan-769 Phase 7, D24: the editor's test run, which loads with the
 * RUNTIME flags and must not report `running` before the placed content's
 * drives exist).
 *
 * Call it right after `loadModel` resolved: the model root on screen at that
 * moment is the document the identity check follows. Same budget, same
 * Problems entry, same `superseded` verdict as the authoring load.
 */
export async function joinScenePlacements(
  viewer: Pick<AuthoringLoadViewer, 'whenSceneReady' | 'currentModelRoot' | 'placements'>,
  opts: ScenePlacementsJoinOptions,
): Promise<AuthoringLoadResult> {
  const root = viewer.currentModelRoot;
  const stillCurrent = (): boolean =>
    root !== null && viewer.currentModelRoot === root && (opts.identity.isCurrent?.() ?? true);
  if (!stillCurrent()) return { ok: false, reason: 'superseded' };

  const settled = viewer.whenSceneReady().then(() => stillCurrent());
  const budget = Math.max(0, opts.budgetMs ?? AUTHORING_JOIN_BUDGET_MS);
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = await Promise.race([
    settled.then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), budget); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  if (!stillCurrent()) return { ok: false, reason: 'superseded' };

  const progress = viewer.placements?.progress;
  const total = progress?.total ?? 0;
  if (ready) {
    clearPlacementsStillLoading();
    return { ok: true, placementsReady: true, pending: 0, total, lateSettle: Promise.resolve(true) };
  }
  const pending = Math.max(1, progress?.pending ?? 1);
  reportPlacementsStillLoading({ label: opts.identity.label || 'The document', pending, total: Math.max(total, pending) });
  const lateSettle = settled.then((current) => {
    // Only the document that raised the entry may clear it; a successor's own
    // load clears it per document (`clearNestedReferenceProblems`).
    if (current) clearPlacementsStillLoading();
    return current;
  }, () => false);
  return { ok: true, placementsReady: false, pending, total: Math.max(total, pending), lateSettle };
}

// ─── Replay after the join ──────────────────────────────────────────────

/**
 * The gate a replay loop asks before each op (plan-774 F3). Shared shape with
 * `rv-document-projection.ts` (`RvReplayGate`), declared structurally there so
 * core ops stay free of this module.
 */
export interface AuthoringReplayGate {
  /** True when `op` targets placed content that has not arrived yet. */
  needsWait(op: RvOp): boolean;
  /** Resolves true once it has; false when the document was superseded (stop replaying). */
  wait(): Promise<boolean>;
}

/** What {@link opTargetsPlacedContent} needs to resolve a path. */
export interface PathResolver {
  getNode(path: string): Object3D | null | undefined;
}

/**
 * Does `op` address a node INSIDE a placed reference (below a non-embedded
 * reference node)? Answered by the path prefixes, so it works before the
 * placement has been materialised: the reference node itself is own content
 * and exists right after the load; only what lies below it is placed.
 */
export function opTargetsPlacedContent(op: RvOp, registry: PathResolver | null | undefined): boolean {
  if (!registry) return false;
  return opTargetPaths(op).some((path) => pathInPlacedContent(path, registry));
}

/**
 * The replay gate for one join result: no op waits when the placements were
 * ready (or for a superseded result — the caller never replays then).
 */
export function authoringReplayGate(
  viewer: { readonly registry?: PathResolver | null },
  result: AuthoringLoadResult,
): AuthoringReplayGate | undefined {
  if (!result.ok || result.placementsReady) return undefined;
  return {
    needsWait: (op) => opTargetsPlacedContent(op, viewer.registry ?? null),
    wait: () => result.lateSettle,
  };
}

/**
 * Split `ops` at the first op the gate must wait for: `[now, later]`. Without a
 * gate everything replays now.
 *
 * Classifies on the tree as it is NOW. A replay asks its gate per op instead
 * (plan-774 review fix E6: `RvDocument.replayOps({ gate })`,
 * `replayOntoTreeLocked(…, gate)`), so an earlier op of the same replay (a
 * rename above a reference node) counts — use this only to inspect a log.
 */
export function splitOpsAtGate(ops: readonly RvOp[], gate: AuthoringReplayGate | undefined): [RvOp[], RvOp[]] {
  if (!gate) return [[...ops], []];
  const at = ops.findIndex((op) => gate.needsWait(op));
  return at < 0 ? [[...ops], []] : [ops.slice(0, at), ops.slice(at)];
}

// ─── Descend verdict (F10) ──────────────────────────────────────────────

/**
 * plan-774 F10: is this reference node a placement the viewer is still
 * materialising? True while it carries the loader's deferred mark (queued in
 * a moment) or the instancer holds its id; false once it settled — into an
 * instance or into its placeholder. The asset editor's descend host answers
 * `RvRecomposeHost.isMaterializing` with it.
 */
export function isReferenceMaterializing(
  placements: { isMaterializing(id: string): boolean },
  reference: Object3D,
): boolean {
  if (getDeferredPlacement(reference)) return true;
  const id = identityIdOf(reference);
  return !!id && placements.isMaterializing(id);
}
