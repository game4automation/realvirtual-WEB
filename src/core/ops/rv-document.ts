// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { bumpModelEditEpoch } from '../engine/rv-model-edit-epoch';
import { isDesRunConfigField, isRunConfigOnlyComponents } from '../material-flow/des-manager-settings';
/**
 * rv-document — ONE op-log document class (plan-703 Phase 1).
 *
 * Replaces the *pair* `SceneStore` (1889 lines, `EditOp`) / `AssetDocument`
 * (1282 lines, `AssetOp`), each of which carried its own single-flight queue,
 * transaction orchestration, coalescing, undo/redo and dirty tracking. This is
 * that machinery once, over the unified vocabulary, with the scene-vs-asset
 * difference reduced to a {@link RvDocumentMode} the executor routes on.
 *
 * IN PRODUCTION since plan-703 Phase 3. Both legacy classes still exist as
 * FACADES — `SceneStore` and `AssetDocument` keep their public APIs (39
 * `getSceneStore()` call sites, ~20 `AssetDocument` methods called straight from
 * the MCP editor tools, which are an external agent-facing surface) but hold one
 * of these instead of a private copy of the machinery. What stays with them is
 * op CONSTRUCTION and their own persistence; what moved here is op MECHANICS.
 *
 * ── Where the two templates disagreed, and what was chosen ──────────────────
 *
 * | Aspect          | SceneStore                    | AssetDocument              | Here |
 * |-----------------|-------------------------------|----------------------------|------|
 * | queue           | tail swallows, caller too     | tail swallows, caller sees | **AssetDocument** — a failed op must be survivable for the document AND observable for its caller |
 * | transaction     | no rollback ("caller's job")  | all-or-nothing + rollback  | **AssetDocument** — a half-applied structural batch is the one state an op log cannot describe |
 * | re-entrancy     | depth-counted                 | folds into the outer txn   | both, same behaviour: only the OUTERMOST commits |
 * | undo floor      | `_baselineOps` may not be undone | undo to zero            | **kept as a parameter** ({@link RvDocumentOptions.baselineFloor}) — scene needs the floor, asset passes 0 |
 * | dirty           | flag-ish                      | derived from the op ids    | **AssetDocument** — plan §5.2: "Dirty ist Ableitung des Op-Logs, kein Nebenflag" |
 * | coalesce guard  | only above the baseline       | unguarded                  | **SceneStore** (the stricter one) — coalescing into a protected op would corrupt its `prev` |
 * | history cap     | cap + baseline realignment    | cap only                   | **SceneStore** — dropping ops without moving the floor would strand it |
 *
 * ── Not here on purpose ─────────────────────────────────────────────────────
 *
 * Draft persistence. `RvDocument` only *announces* change (via
 * {@link subscribe} and the optional {@link RvDocumentOptions.onChanged} hook)
 * and never writes — which is also why `hasUnpersistedWork` is not an intrinsic
 * here: a document that knows no storage cannot know what is outstanding.
 *
 * Both lineages hang off that one hook since plan-710 Phase 2, in the two forms
 * their content actually has: the asset lineage writes an op draft through
 * `RvDraftAutosave` (the single writer, one slot per frame), the scene lineage
 * bakes GLB bytes. Neither is a second mechanism inside this class.
 */

import { MAX_OP_HISTORY } from './rv-op-utils';
import {
  canCoalesceRvOps,
  describeRvOp,
  foldKeyedComposite,
  journalIdOf,
  makeComposite,
  mergeRvOps,
  referenceRewriteRangesOf,
  type RvCompositeOp,
  type RvOp,
  type RvOpMeta,
  type RvPrimitiveOp,
} from './rv-unified-ops';
import type { RvDocumentMode, RvExecutor } from './rv-unified-executors';
import { planPlacedReplay, type RvPlacedReplaySkip } from './rv-placed-replay';

/**
 * plan-774 F3 / review fix E3: the gate a draft replay asks per op — "does this
 * op need placed content that is still materialising?" (`authoringReplayGate`
 * in `rv-authoring-load.ts`; structural here so core ops stay free of the
 * editor). `wait()` resolves true once the content arrived for THIS document,
 * false when another document took the viewer first.
 */
export interface RvDocumentReplayGate {
  needsWait(op: RvOp): boolean;
  wait(): Promise<boolean>;
}

/** Options of {@link RvDocument.replayOps}. */
export interface RvDocumentReplayOptions {
  /** Ops from the first one the gate must wait for on become the PENDING tail. */
  gate?: RvDocumentReplayGate;
  /**
   * How long the pending tail waits for its placements (the authoring join's
   * budget). After it the tail goes into the history UNAPPLIED (kept in the
   * draft, reported "still loading") and the document queue is free again.
   * Default {@link DEFAULT_REPLAY_WAIT_BUDGET_MS}.
   */
  waitBudgetMs?: number;
}

/** Default wait of a pending replay tail — the authoring join's default budget (60 s). */
export const DEFAULT_REPLAY_WAIT_BUDGET_MS = 60_000;

/**
 * The three document INTRINSICS every facade snapshot carries (plan-710 §2.4).
 *
 * Deliberately small. `SceneSnapshot` has eleven more fields — a materialised
 * `RvScene`, the catalogue, the published list — that have no asset counterpart,
 * and an earlier draft of the merge tried to force one shape over both. What is
 * genuinely the same question in both lineages is only this: has it changed, is
 * it working, and can the last change be taken back. Those three are derived
 * ONCE, here, and spread into whatever shape a layer needs around them.
 *
 * NOT in here, on purpose:
 *  - the undo/redo LABELS. The two layers word them differently today (the
 *    scene prefixes `Undo: `, the asset lineage does not) and that is UI copy,
 *    not a document fact — unifying it would change what the buttons say.
 *  - `hasUnpersistedWork`. `RvDocument` knows nothing about storage or timers;
 *    it only announces change (F7 wires it as a callback, plan-710 Phase 4).
 */
export interface RvDocumentCore {
  /** Differs from the last clean point (open / save). Derived, never a flag. */
  dirty: boolean;
  /** The op queue is working — a transaction counts as one busy span. */
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

/** Immutable UI snapshot (useSyncExternalStore-friendly). */
export interface RvDocumentSnapshot extends RvDocumentCore {
  id: string;
  name: string;
  mode: RvDocumentMode;
  undoLabel: string | null;
  redoLabel: string | null;
  opCount: number;
}

export interface RvDocumentOptions {
  id: string;
  name: string;
  mode: RvDocumentMode;
  executor: RvExecutor;
  /**
   * How many LEADING ops are protected from undo.
   *
   * The scene lineage opens a published scene with its own ops already in the
   * log; undoing into them would rewrite the published document. The asset
   * lineage has no such floor and passes 0 (the default).
   */
  baselineFloor?: number;
  createdAt?: number;
  /** Called after every committed change — Phase 2 hangs draft autosave here. */
  onChanged?: (doc: RvDocument) => void;
  /**
   * Checked INSIDE the queue, immediately before an op is applied. Returning
   * false drops the op silently: not applied, not recorded, no error.
   *
   * The scene lineage needs this and the asset lineage does not. A scene load
   * replays canonical state into the live viewer, and an op queued just before
   * it is stale by the time it runs — applying it would edit the wrong document,
   * recording it would put it in the new document's history. The check has to
   * happen inside the queue, not at the call site: the load can begin after the
   * caller returned and before the queued work is reached.
   */
  canApply?: () => boolean;
  /**
   * "Would closing the PAGE right now destroy work?" — asked of the layer that
   * owns this document's storage (plan-710 F7).
   *
   * A callback for the same reason `onChanged` and `canApply` are: this class
   * announces change and never writes, so it cannot know what is still
   * outstanding. The layer that scheduled the write does. Each lineage answers
   * with its own timer — the scene with its GLB-bake debounce, the asset
   * lineage with `RvDraftAutosave.hasPendingWrite` — and both answers reach the
   * ONE page unload guard through `ProjectStore.hasUnpersistedWork()`.
   *
   * Absent means "nothing is outstanding" rather than "unknown": a document
   * with no storage behind it (a test double, a headless boot) loses nothing to
   * a reload, and a guard that asks anyway is the guard people learn to dismiss.
   */
  hasUnpersistedWork?: () => boolean;
}

/** Opaque handle returned by {@link RvDocument.beginTransaction}. */
export interface RvTransactionToken { readonly _depth: number }

/** Options of {@link RvDocument.beginTransaction} / {@link RvDocument.withTransaction} (plan-590). */
export interface RvTransactionOptions {
  /**
   * Metadata stamped on the committed composite — at the TOP level, also when
   * this transaction is nested in an outer one (the first meta wins).
   */
  meta?: RvOpMeta;
  /**
   * Runs immediately BEFORE a failed or aborted transaction rolls back what it
   * applied. The signal-rename coordinator switches the SignalStore into its
   * reverse phase here, so the automatic rollback of the model step migrates
   * the signal back instead of releasing and re-registering it.
   */
  beforeRollback?: () => void;
  /**
   * Coalesce the committed entry with the previous entry of the SAME key into
   * one undo step (plan-621, Spike (b) V2 "keyed amend") — a live CAD sync
   * passes `solidcraft-sync:<session>`. See {@link RvDocument} `_recordKeyed`
   * for the exact merge conditions and the chain breaks. In memory only: the
   * key is never persisted, so after a reload there is no chain to continue.
   * A nested transaction's option is ignored (the outermost one commits).
   */
  coalesce?: RvCoalesceOptions;
}

/** {@link RvTransactionOptions.coalesce}. */
export interface RvCoalesceOptions {
  /** Chain identity — only entries of the same key merge. */
  key: string;
  /**
   * SLIDING quiet gap in ms (default {@link DEFAULT_COALESCE_WINDOW_MS}): measured
   * from the last step merged into the entry, not from the first, so a steady
   * 250 ms poll stays one entry for as long as it keeps arriving.
   */
  windowMs?: number;
}

/** Default sliding window of a keyed coalesce chain (plan-621 §2.3). */
export const DEFAULT_COALESCE_WINDOW_MS = 1000;

/** The open coalesce chain — in memory only, never persisted. */
interface RvCoalesceTail {
  key: string;
  /** Id of the history entry the chain amends. */
  entryId: string;
  /** ts of the last step merged into it — the sliding-window anchor. */
  lastTs: number;
  windowMs: number;
}

/** Counters of the keyed coalesce (tests, diagnostics). */
export interface RvCoalesceStats {
  /** Entries amended instead of pushed. */
  merged: number;
  /** Child ops folded away (their stash was released). */
  absorbed: number;
}

/** Direction of a history move. */
export type RvHistoryDirection = 'undo' | 'redo';

/**
 * Verdict of a {@link RvHistoryInterceptor}:
 *  - `handled`  — the interceptor moved the history itself (through
 *                 {@link RvDocument.replayHistory}); the document does nothing more;
 *  - `refused`  — the move is not possible right now; the stacks stay as they are;
 *  - `default`  — not mine; the document undoes / redoes the entry normally.
 */
export type RvHistoryVerdict = 'handled' | 'refused' | 'default';

/**
 * Asked before an entry carrying `meta.journalId` is undone or redone
 * (plan-590 History-Interceptor). Runs INSIDE the document's queue slot of that
 * undo/redo: it must not await the queue of the same document (use
 * {@link RvDocument.replayHistory}, which does not queue).
 */
export type RvHistoryInterceptor = (
  entry: RvOp,
  direction: RvHistoryDirection,
  doc: RvDocument,
) => Promise<RvHistoryVerdict>;

/**
 * Asked before ANY entry is undone or redone (plan-453 §2.6) — unlike the ONE
 * {@link RvHistoryInterceptor}, which is offered only journaled entries and
 * owns the slot. Synchronous and side-effect free: `false` refuses the move
 * (the stacks and the scene stay as they are, nothing is emitted), `true` lets
 * it through. A guard decides only for entries it recognises and returns
 * `true` for everything else. The structural path verbs use it so an undo of
 * a segment-list change obeys the same simulation lock as the verb itself.
 */
export type RvHistoryGuard = (entry: RvOp, direction: RvHistoryDirection) => boolean;

/**
 * Decides whether an op may be applied forward (plan-681 `structural-derived-locked`):
 * an `Error` refuses it (the entry rejects with that error, nothing is applied or
 * recorded), `null` lets it through. Synchronous and side-effect free.
 */
export type RvOpGuard = (op: RvOp) => Error | null;

/** Position of the history stacks — what a journal compares before it moves them. */
export interface RvHistoryHead {
  undoLen: number;
  redoLen: number;
  /** Id of the newest undoable entry. */
  topId?: string;
  /** Id of the newest redoable entry. */
  redoTopId?: string;
}

/** The last interception — the UI reads it to explain a refused undo (toast). */
export interface RvHistoryInterception {
  journalId: string;
  direction: RvHistoryDirection;
  verdict: RvHistoryVerdict;
}

/**
 * One actual change of the op stack (plan-641 M9) — see {@link RvDocument.onHistoryChange}.
 *
 *  - `record`   — a new entry was pushed (plain or keyed);
 *  - `coalesce` — the top entry was amended in place (same count, new content);
 *  - `undo` / `redo` — an entry moved between the stacks (incl. a journal replay);
 *  - `replace`  — the whole history was swapped (`restoreHistory` with announce,
 *                 a draft replay);
 *  - `rollback` — entries above a floor were taken back for good (`rollbackTo`).
 *
 * A history move that did nothing (undo on an empty stack, a refused
 * interception) fires NOTHING.
 */
export interface RvHistoryChange {
  kind: 'record' | 'coalesce' | 'undo' | 'redo' | 'replace' | 'rollback';
  /** Id of the entry concerned, when there is one. */
  opId?: string;
  /** {@link RvDocument.changeSeq} after this change. */
  seq: number;
}

/** A frozen photograph of a document's history — see {@link RvDocument.captureHistory}. */
export interface RvDocumentHistory {
  ops: RvOp[];
  redoOps: RvOp[];
  baselineIds: string[];
  baselineFloor: number;
  metaDirty: boolean;
}

export class RvDocument {
  readonly id: string;
  readonly executor: RvExecutor;

  /**
   * Which PROJECTION is active — see {@link setProjection} (plan-711 §2.3).
   *
   * Was a `readonly` field until plan-711. It still is for every document that
   * never changes projection (both lineages construct it once and leave it),
   * which is why the public shape is unchanged: a getter with the same name and
   * the same type.
   */
  private _mode: RvDocumentMode;

  private _name: string;
  private readonly _createdAt: number;
  private readonly _onChanged?: (doc: RvDocument) => void;
  /**
   * Additional commit-channel subscribers — see {@link attachCommitHook}.
   *
   * A SET beside `_onChanged` rather than a wrapper around it (plan-711
   * R2-Arch-F1): `_onChanged` is a private readonly field, so "compose a
   * wrapper at the bind point" was not buildable, and a second constructor
   * option would have made the count a compile-time fact when the whole point
   * is that hooks come and go with a binding.
   */
  private readonly _commitHooks = new Set<(doc: RvDocument) => void>();
  private readonly _canApply?: () => boolean;
  private readonly _hasUnpersistedWork?: () => boolean;

  private _ops: RvOp[] = [];
  /**
   * plan-774 review fix E3: the PENDING replay tail — recovered ops a draft
   * replay could not apply yet because the placed content they target was
   * still materialising. Not history (never applied, not undoable) but part of
   * the DOCUMENT: the draft recipe carries it ({@link draftOps}), `dirty` counts
   * it, a superseded wait keeps it and the next replay onto a fresh tree
   * (Back, recompose — {@link replayPendingLocked}) re-attempts it.
   */
  private _pendingReplay: RvOp[] = [];
  private _redo: RvOp[] = [];
  /** Ids of `_ops` at the last clean point (fresh open / save). */
  private _baselineIds: string[] = [];
  /** Leading ops that undo may not cross. */
  private _baselineFloor: number;

  /** Single-flight op queue tail. Never rejects — see {@link _enqueue}. */
  private _queue: Promise<void> = Promise.resolve();
  private _busyDepth = 0;

  private _txnDepth = 0;
  private _txnOps: RvOp[] | null = null;
  private _txnLabel = '';
  /** First failure inside the open transaction, from a detached (void) apply. */
  private _txnError: unknown = null;
  /** The transaction owns one busy transition, since it suppresses the per-op ones. */
  private _txnBusy = false;
  /** True while a rollback drives the executor — no React wake-up per step. */
  private _notifyPaused = false;
  /** Meta of the open transaction (first one wins, plan-590). */
  private _txnMeta: RvOpMeta | null = null;
  /** Hooks to run before the open transaction rolls back (plan-590). */
  private _txnBeforeRollback: Array<() => void> = [];
  /** Coalesce option of the open transaction (the outermost one's, plan-621). */
  private _txnCoalesce: RvCoalesceOptions | null = null;
  /** The chain the next keyed entry may amend (plan-621) — null = broken. */
  private _coalesceTail: RvCoalesceTail | null = null;
  private readonly _coalesceStats: RvCoalesceStats = { merged: 0, absorbed: 0 };

  /** History interceptor (plan-590) — see {@link setHistoryInterceptor}. */
  private _historyInterceptor: RvHistoryInterceptor | null = null;
  /** History guards (plan-453) — asked for EVERY entry before it is undone / redone. */
  private readonly _historyGuards = new Set<RvHistoryGuard>();
  /** Op guards (plan-681) — asked for EVERY op before it is applied forward. */
  private readonly _opGuards = new Set<RvOpGuard>();
  /** True while the interceptor runs — an undo/redo from inside it is re-entrant. */
  private _intercepting = false;
  private _lastInterception: RvHistoryInterception | null = null;

  /** Metadata dirty (document rename) — OR'd into {@link dirty}. */
  private _metaDirty = false;
  private _disposed = false;

  private _snapshot: RvDocumentSnapshot | null = null;
  private readonly _listeners = new Set<() => void>();

  /** Monotone count of actual op-stack changes (plan-641 M9). */
  private _changeSeq = 0;
  private readonly _historyObservers = new Set<(change: RvHistoryChange) => void>();
  /**
   * Coalesce floor (plan-641 M8): while set, neither coalescing path may amend
   * an entry at an index below it. Null = no floor. Shifted with the history cap
   * exactly like `_baselineFloor`.
   */
  private _coalesceFloor: number | null = null;
  /** Token of the current floor owner — a stale release must not drop a newer floor. */
  private _coalesceFloorToken = 0;

  constructor(opts: RvDocumentOptions) {
    this.id = opts.id;
    this._mode = opts.mode;
    this.executor = opts.executor;
    this._name = opts.name;
    this._baselineFloor = Math.max(0, opts.baselineFloor ?? 0);
    this._createdAt = opts.createdAt ?? Date.now();
    this._onChanged = opts.onChanged;
    this._canApply = opts.canApply;
    this._hasUnpersistedWork = opts.hasUnpersistedWork;
  }

  // ─── State ──────────────────────────────────────────────────────────

  get name(): string { return this._name; }
  get createdAt(): number { return this._createdAt; }

  /** Which target this document writes to RIGHT NOW — see {@link setProjection}. */
  get mode(): RvDocumentMode { return this._mode; }

  /**
   * Switch the active PROJECTION of this document (plan-711 §2.3, F2).
   *
   * Two fields, one transition. `RvDocument.mode` decides how a transaction's
   * composite is origin-tagged and what the snapshot reports;
   * `RvUnifiedExecutor.mode` decides where the four `'both'` kinds are applied
   * (`resolveOpTarget`, rv-unified-executors.ts). They describe the SAME fact,
   * and a state in which they disagree is one where a `setField` is recorded as
   * belonging to one projection and applied to the other — so they move
   * together, here, and nowhere else.
   *
   * The executor half is optional (`setMode?`) because {@link RvExecutor} is the
   * mockable seam every document test drives; a double that does not project
   * simply does not implement it, and a document over it stays single-mode.
   *
   * NOT a recompose. Changing the projection changes where the NEXT op goes; it
   * does not re-materialise the log against a new tree. That is
   * `recomposeProjection` in `rv-document-projection.ts`, which calls this as
   * one of its steps.
   */
  setProjection(mode: RvDocumentMode): void {
    if (this._mode === mode) return;
    this._mode = mode;
    this.executor.setMode?.(mode);
    this._notify();
  }

  /**
   * Add a second listener on the COMMIT channel; call the result to remove it
   * (plan-711 R2-Arch-F1).
   *
   * Deliberately the same channel as {@link RvDocumentOptions.onChanged}, i.e.
   * `_changed()` — one call per committed change, never inside an open
   * transaction and never during a rollback — and NOT the broader
   * {@link subscribe}, which also fires for busy transitions and for
   * `restoreHistory`. A draft writer woken by those would write while a
   * recompose is mid-flight, which is the one moment the log does not describe
   * the tree.
   *
   * Exists because a bound document has TWO owners for the length of the
   * binding: the lineage that constructed it (through `onChanged`) and the one
   * that borrowed it. The second cannot be a constructor option — it comes and
   * goes with the binding.
   */
  attachCommitHook(cb: (doc: RvDocument) => void): () => void {
    this._commitHooks.add(cb);
    return () => { this._commitHooks.delete(cb); };
  }

  // ─── Change evidence (plan-641 M8/M9) ───────────────────────────────

  /**
   * Monotone counter of ACTUAL op-stack changes — one per
   * {@link RvHistoryChange}. Unlike `opCount` it moves on a coalesce (same
   * count, new content), and unlike the commit hook it does not move on an
   * undo that had nothing to undo.
   */
  get changeSeq(): number { return this._changeSeq; }

  /**
   * Observe every actual change of the op stack, SYNCHRONOUSLY and one call per
   * change (plan-641 M9). A recorder counts these per event — never by
   * comparing a "last state" — so an undo in between cannot be hidden by a
   * redo. Returns the unsubscribe.
   */
  onHistoryChange(cb: (change: RvHistoryChange) => void): () => void {
    this._historyObservers.add(cb);
    return () => { this._historyObservers.delete(cb); };
  }

  /**
   * Set a coalesce floor at the current top (plan-641 M8): no entry recorded
   * BEFORE this call can be amended afterwards — neither by the unkeyed
   * time-window coalescing nor by a keyed chain. Returns the release; a release
   * of a floor that has since been replaced by a newer one is a no-op.
   */
  markCoalesceFloor(): () => void {
    this._coalesceFloor = this._ops.length;
    this._coalesceTail = null;
    const token = ++this._coalesceFloorToken;
    return () => {
      if (this._coalesceFloorToken === token) this._coalesceFloor = null;
    };
  }

  /** The active coalesce floor, or null (tests, diagnostics). */
  get coalesceFloor(): number | null { return this._coalesceFloor; }

  /**
   * Mark document METADATA dirty without an op (plan-641 M5: a new macro line
   * belongs to the document and has to reach the next save).
   */
  markMetaDirty(): void {
    if (this._metaDirty) return;
    this._metaDirty = true;
    this._changed();
  }

  private async _applyModelForward(op: RvOp): Promise<void> {
    await this.executor.applyForward(op);
    this._recordModelEdit(op);
  }

  private async _applyModelInverse(op: RvOp): Promise<void> {
    await this.executor.applyInverse(op);
    this._recordModelEdit(op);
  }

  private _recordModelEdit(op: RvOp): void {
    // Adding the des.setEnd run-config holder neither.
    const holder = (s?: { position?: number[]; quaternion?: number[]; scale?: number[]; components?: unknown }): boolean =>
      !!s && isRunConfigOnlyComponents(s.components) && `${s.position}${s.quaternion}${s.scale}` === '0,0,00,0,0,11,1,1';
    // Camera ops share the document log, but carry view state only. Authored
    // setNodeVisible changes the file; groups-panel hide/isolate uses no op.
    // DESManager run parameters (end / warm-up / seed) are run configuration, not model.
    const authored = (item: RvOp): boolean => item.kind === 'composite'
      ? item.ops.some(authored)
      : item.kind !== 'setCamera'
        && !((item.kind === 'setField' || item.kind === 'unsetField') && isDesRunConfigField(item.componentType, item.fieldName))
        && !(item.kind === 'addNode' && holder(item.spec));
    if (authored(op)) bumpModelEditEpoch('document-edit');
  }

  private _emitHistory(kind: RvHistoryChange['kind'], opId?: string): void {
    this._changeSeq++;
    if (this._historyObservers.size === 0) return;
    const change: RvHistoryChange = { kind, seq: this._changeSeq, ...(opId ? { opId } : {}) };
    for (const cb of [...this._historyObservers]) {
      try { cb(change); } catch (e) { console.error('[rv-document] history observer failed:', e); }
    }
  }

  /** True when the top entry may still be amended (above the undo AND the coalesce floor). */
  private _topAboveFloors(): boolean {
    return this._ops.length > this._baselineFloor
      && (this._coalesceFloor === null || this._ops.length > this._coalesceFloor);
  }
  /** The live op log. Treat as read-only — mutate through the op API. */
  get ops(): readonly RvOp[] { return this._ops; }
  /** plan-774 review fix E3: recovered ops still waiting for their placed content (see {@link replayOps}). */
  get pendingReplayOps(): readonly RvOp[] { return this._pendingReplay; }
  /**
   * The draft recipe (plan-774 review fix E3): the history PLUS the pending
   * replay tail, in log order — what every draft writer stores, so leaving the
   * editor while the tail waits loses none of it.
   */
  get draftOps(): RvOp[] {
    return this._pendingReplay.length === 0 ? [...this._ops] : [...this._ops, ...this._pendingReplay];
  }
  get opCount(): number { return this._ops.length; }

  /** Keyed-coalesce counters (plan-621) — a copy, for tests and diagnostics. */
  get coalesceStats(): RvCoalesceStats { return { ...this._coalesceStats }; }
  get baselineFloor(): number { return this._baselineFloor; }
  get isDisposed(): boolean { return this._disposed; }

  /** Derived from the op log, never a side flag (plan §5.2). */
  get dirty(): boolean {
    if (this._metaDirty) return true;
    // A pending replay tail is recovered work the tree does not show yet.
    if (this._pendingReplay.length > 0) return true;
    if (this._ops.length !== this._baselineIds.length) return true;
    return this._ops.some((op, i) => op.id !== this._baselineIds[i]);
  }

  canUndo(): boolean { return this._ops.length > this._baselineFloor; }
  canRedo(): boolean { return this._redo.length > 0; }

  /**
   * Would leaving the PAGE right now destroy work? (plan-710 F7)
   *
   * A stricter question than {@link dirty}, and a different one: a dirty
   * document whose draft has already been written survives a reload intact,
   * while a write still sitting on a debounce timer does not. Answered by the
   * layer that owns the storage — see
   * {@link RvDocumentOptions.hasUnpersistedWork} — because this class has none.
   */
  hasUnpersistedWork(): boolean {
    return this._hasUnpersistedWork?.() === true;
  }

  /** True while the op queue (or an open transaction) is working. */
  get busy(): boolean { return this._busyDepth > 0 || this._txnBusy; }

  /**
   * The document-intrinsic part of a facade snapshot — see {@link RvDocumentCore}.
   *
   * Every layer spreads THIS rather than re-deriving `dirty`/`busy`/`canUndo`
   * from the document by hand, which is what let two snapshot builders drift
   * apart in the first place.
   */
  get core(): RvDocumentCore {
    return {
      dirty: this.dirty,
      busy: this.busy,
      canUndo: this.canUndo(),
      canRedo: this.canRedo(),
    };
  }

  describeUndo(): string | null {
    if (!this.canUndo()) return null;
    return `Undo: ${describeRvOp(this._ops[this._ops.length - 1])}`;
  }

  describeRedo(): string | null {
    if (!this.canRedo()) return null;
    return `Redo: ${describeRvOp(this._redo[this._redo.length - 1])}`;
  }

  /**
   * Set the name WITHOUT marking metadata dirty.
   *
   * For restore paths only ({@link restoreHistory} puts a frozen history back,
   * and the name travels with it). A user rename is {@link renameDocument}.
   */
  setNameSilently(name: string): void {
    this._name = name;
    this._notify();
  }

  /** Rename the DOCUMENT (not a scene node). Metadata only — not an op. */
  renameDocument(name: string): void {
    const trimmed = name.trim();
    if (!trimmed || trimmed === this._name) return;
    this._name = trimmed;
    this._metaDirty = true;
    this._changed();
  }

  // ─── Op API ─────────────────────────────────────────────────────────

  /**
   * Queue an op: forward-apply to the live scene, then record it.
   *
   * The returned promise REJECTS when the op did not apply, and the op is then
   * NOT recorded. Recording an op the executor never applied is what produced
   * "the scene disagrees with its own history" (plan-359 Phase 3).
   */
  applyOp(op: RvOp): Promise<void> {
    return this._enqueue(async () => {
      if (this._canApply && !this._canApply()) return;
      this._checkOpGuards(op);
      await this._applyModelForward(op);
      this._record(op);
    });
  }

  /**
   * `applyOp` for callers whose signature is `void` (UI event handlers), so
   * nobody holds the promise.
   *
   * Inside a transaction the failure is remembered, so the transaction still
   * rolls back and still rejects at the caller that opened it.
   */
  applyOpDetached(op: RvOp): void {
    this.trackDetached(this.applyOp(op));
  }

  /**
   * Plan an op and apply it in ONE queue slot (plan-610 §2.4 "Planung in der
   * Dokument-Queue").
   *
   * `plan` runs ON the queue, i.e. against the state every op queued before it
   * has already produced, and nothing can land between the scan it does and the
   * apply of the op it returns. That is what a reference rewrite needs: it reads
   * every referrer of the document, and an op still waiting in the queue would
   * otherwise change what was scanned before the composite runs.
   *
   * - `plan` THROWS → nothing is applied, the promise rejects with that error.
   * - `plan` returns `op: null` → nothing to apply, `result` is handed back.
   * - otherwise the op is applied and recorded exactly like {@link applyOp}
   *   (rejects without recording when the executor fails).
   *
   * Resolves to `null` when the document refuses ops right now (`canApply`,
   * e.g. a base swap) — `plan` is then not called, mirroring the silent drop
   * of {@link applyOp}.
   */
  applyPlanned<T>(plan: () => { op: RvOp | null; result: T }): Promise<T | null> {
    let out: T | null = null;
    return this._enqueue(async () => {
      if (this._canApply && !this._canApply()) return;
      const planned = plan();
      if (planned.op) {
        this._checkOpGuards(planned.op);
        await this._applyModelForward(planned.op);
        this._record(planned.op);
      }
      out = planned.result;
    }).then(() => out);
  }

  /**
   * Hold the failure of a promise nobody awaits (a `void` mutator's): inside a
   * transaction it is remembered, so the transaction still rolls back and
   * rejects at the caller that opened it. `benign` failures (a refusal the
   * mutator already reported) are swallowed without poisoning the transaction.
   */
  trackDetached(p: Promise<unknown>, benign?: (e: unknown) => boolean): void {
    void p.catch((e) => {
      if (benign?.(e)) return;
      if (this._txnOps && this._txnError === null) this._txnError = e;
    });
  }

  /** Undo the newest op, down to the baseline floor. */
  async undo(): Promise<void> {
    this._assertNotIntercepting('undo');
    await this._enqueue(async () => {
      if (this._canApply && !this._canApply()) return;
      if (!this.canUndo()) return;
      const op = this._ops[this._ops.length - 1];
      if (await this._intercept(op, 'undo')) return;
      // The stacks move only AFTER the inverse applied — popping first would
      // discard the entry on a failed undo, leaving the change with no way back.
      await this._applyModelInverse(op);
      this._ops.pop();
      this._redo.push(op);
      // plan-621: the next keyed step must never amend an entry below the one
      // the user just took back.
      this._coalesceTail = null;
      this._emitHistory('undo', op.id);
    });
    this._changed();
  }

  /** Redo the newest undone op. Same stack discipline as {@link undo}. */
  async redo(): Promise<void> {
    this._assertNotIntercepting('redo');
    await this._enqueue(async () => {
      if (this._canApply && !this._canApply()) return;
      const op = this._redo[this._redo.length - 1];
      if (!op) return;
      if (await this._intercept(op, 'redo')) return;
      await this._applyModelForward(op);
      this._redo.pop();
      this._ops.push(op);
      this._coalesceTail = null;
      this._emitHistory('redo', op.id);
    });
    this._changed();
  }

  // ─── History interceptor (plan-590) ─────────────────────────────────

  /**
   * Install (or clear, with `null`) the history interceptor. Only entries that
   * carry `meta.journalId` are offered to it; every other undo/redo is
   * untouched. One interceptor per document — the signal-rename coordinator.
   */
  setHistoryInterceptor(interceptor: RvHistoryInterceptor | null): void {
    this._historyInterceptor = interceptor;
  }

  get historyInterceptor(): RvHistoryInterceptor | null { return this._historyInterceptor; }

  /**
   * Add a history guard (plan-453) — see {@link RvHistoryGuard}. Several guards
   * may coexist; ALL must agree. Returns the removal.
   */
  addHistoryGuard(guard: RvHistoryGuard): () => void {
    this._historyGuards.add(guard);
    return () => { this._historyGuards.delete(guard); };
  }

  /**
   * Add an op guard (plan-681) — asked for EVERY op `applyOp` / `applyPlanned`
   * is about to apply, BEFORE the executor runs. A guard returns an `Error` to
   * refuse (the entry rejects with it; scene and history stay as they are) or
   * `null` to let the op through. Several guards may coexist; the first refusal
   * wins. Undo / redo are guarded through {@link addHistoryGuard}. Returns the removal.
   */
  addOpGuard(guard: RvOpGuard): () => void {
    this._opGuards.add(guard);
    return () => { this._opGuards.delete(guard); };
  }

  private _checkOpGuards(op: RvOp): void {
    for (const guard of this._opGuards) {
      const refusal = guard(op);
      if (refusal) throw refusal;
    }
  }

  /** The verdict of the last intercepted undo/redo, or null. */
  get lastHistoryInterception(): RvHistoryInterception | null { return this._lastInterception; }

  /** Where the history stacks stand right now. */
  historyHead(): RvHistoryHead {
    const top = this._ops[this._ops.length - 1];
    const redoTop = this._redo[this._redo.length - 1];
    return {
      undoLen: this._ops.length,
      redoLen: this._redo.length,
      ...(top ? { topId: top.id } : {}),
      ...(redoTop ? { redoTopId: redoTop.id } : {}),
    };
  }

  /** A copy of the redo branch (oldest first) — what a journal keeps to restore it. */
  redoBranch(): RvOp[] { return [...this._redo]; }

  /**
   * Put a redo branch back verbatim (plan-590). The rename's rollback first
   * takes its own entry back — which leaves the entry on the redo stack — and
   * then restores the branch the user had BEFORE the rename, so a failed rename
   * costs nothing Redo could still have given back.
   */
  restoreRedoBranch(ops: readonly RvOp[]): void {
    this._redo = [...ops];
    this._notify();
  }

  /**
   * Execute the history entry of `journalId` in `direction` — the replay path
   * of the history interceptor (plan-590 Replay-Vertrag):
   *
   *  - WITHOUT asking the interceptor again (no re-entrance),
   *  - WITHOUT recording new history (no `_record`, the redo branch is kept),
   *  - WITHOUT waiting for this document's queue — it runs inside the queue
   *    slot of the undo/redo that called the interceptor, or inside a
   *    {@link runExclusive} of the caller.
   *
   * The entry must be the newest undoable (undo) resp. redoable (redo) one —
   * a journal never replays past another edit. Throws otherwise, or when the
   * executor fails; the stacks move only after the executor succeeded.
   */
  async replayHistory(journalId: string, direction: RvHistoryDirection): Promise<void> {
    this._coalesceTail = null;
    if (direction === 'undo') {
      const op = this._ops[this._ops.length - 1];
      if (!op || journalIdOf(op) !== journalId || !this.canUndo()) {
        throw new Error(`[rv-document] replayHistory: the newest undoable entry of "${this._name}" is not journal ${journalId}`);
      }
      await this._applyModelInverse(op);
      this._ops.pop();
      this._redo.push(op);
      this._emitHistory('undo', op.id);
    } else {
      const op = this._redo[this._redo.length - 1];
      if (!op || journalIdOf(op) !== journalId) {
        throw new Error(`[rv-document] replayHistory: the newest redoable entry of "${this._name}" is not journal ${journalId}`);
      }
      await this._applyModelForward(op);
      this._redo.pop();
      this._ops.push(op);
      this._emitHistory('redo', op.id);
    }
    this._changed();
  }

  /** True when the newest undoable (undo) / redoable (redo) entry belongs to `journalId`. */
  isHistoryTop(journalId: string, direction: RvHistoryDirection): boolean {
    const op = direction === 'undo'
      ? (this.canUndo() ? this._ops[this._ops.length - 1] : undefined)
      : this._redo[this._redo.length - 1];
    return journalIdOf(op) === journalId;
  }

  private _assertNotIntercepting(what: RvHistoryDirection): void {
    if (this._intercepting) {
      // Awaiting our own queue from inside the slot that runs the interceptor
      // would deadlock — the interceptor must use replayHistory instead.
      throw new Error(`[rv-document] re-entrant ${what} of "${this._name}" from inside the history interceptor`);
    }
  }

  /** Offer an entry to the interceptor. True when the document must not move the stacks itself. */
  private async _intercept(op: RvOp, direction: RvHistoryDirection): Promise<boolean> {
    // plan-453: a refusing guard keeps the stacks — before the journal interceptor.
    for (const guard of this._historyGuards) {
      let ok: boolean;
      try {
        ok = guard(op, direction);
      } catch (e) {
        console.error(`[rv-document] history guard of "${this._name}" threw — ${direction} refused:`, e);
        ok = false;
      }
      if (!ok) return true;
    }
    const journalId = journalIdOf(op);
    const interceptor = this._historyInterceptor;
    if (!journalId || !interceptor) return false;
    this._intercepting = true;
    let verdict: RvHistoryVerdict;
    try {
      verdict = await interceptor(op, direction, this);
    } finally {
      this._intercepting = false;
    }
    this._lastInterception = { journalId, direction, verdict };
    return verdict !== 'default';
  }

  // ─── Transactions ───────────────────────────────────────────────────

  /**
   * Open a transaction: subsequent ops accumulate into ONE composite undo unit.
   * Reference-counted — only the outermost {@link endTransaction} commits.
   */
  beginTransaction(label: string, opts?: RvTransactionOptions): RvTransactionToken {
    if (this._txnDepth === 0) {
      this._txnLabel = label;
      this._txnError = null;
      this._txnMeta = null;
      this._txnBeforeRollback = [];
      this._txnCoalesce = null;
      // Publish "busy" BEFORE suppression starts — the only notification the UI
      // gets while the transaction runs (F6). ORDER IS LOAD-BEARING: `_notify`
      // returns early once `_txnOps` is set, so assigning the buffer first
      // swallows exactly the announcement this line exists to make, and a bulk
      // import leaves the toolbar looking idle for its whole duration.
      this._txnBusy = true;
      this._notify();
      this._txnOps = [];
    }
    // plan-590: a nested transaction keeps its meta at the TOP level — the
    // outermost transaction is the one that commits, so it carries it.
    if (opts?.meta?.journalId && !this._txnMeta?.journalId) this._txnMeta = { ...this._txnMeta, ...opts.meta };
    // plan-610: a transaction opened AS a reference rewrite marks the whole
    // committed entry; the marker is sticky across nesting.
    if (opts?.meta?.referenceRewrite) this._txnMeta = { ...this._txnMeta, referenceRewrite: true };
    if (opts?.beforeRollback) this._txnBeforeRollback.push(opts.beforeRollback);
    // plan-621: only the transaction that COMMITS decides whether its entry
    // joins a chain — a nested caller cannot turn the outer edit into a sync step.
    if (opts?.coalesce && this._txnDepth === 0) this._txnCoalesce = { ...opts.coalesce };
    this._txnDepth++;
    return Object.freeze({ _depth: this._txnDepth });
  }

  /**
   * Commit the transaction. Empty transactions are no-ops.
   *
   * ALL-OR-NOTHING: if any op inside failed, everything the transaction did
   * apply is rolled back, nothing is recorded, and the failure is re-thrown.
   */
  endTransaction(_token?: RvTransactionToken): Promise<void> {
    if (this._txnDepth === 0) return Promise.resolve();
    this._txnDepth--;
    if (this._txnDepth > 0) return Promise.resolve(); // the outer one commits
    // Commit INSIDE the queue, so no other op can interleave.
    return this._enqueue(async () => {
      const collected = this._txnOps ?? [];
      const failure = this._txnError;
      const label = this._txnLabel;
      const meta = this._txnMeta;
      const beforeRollback = this._txnBeforeRollback;
      const coalesce = this._txnCoalesce;
      this._closeTransaction();
      if (failure !== null) {
        runBeforeRollback(beforeRollback);
        await this._rollback(collected);
        throw failure;
      }
      if (collected.length === 0) return;
      // Composites never nest — flatten one level, exactly like both templates.
      // A child composite's journal id survives the flattening at the TOP
      // level (plan-590): it is what routes the undo of the whole entry.
      let journalId = meta?.journalId;
      // plan-610: a reference-rewrite composite folded into the transaction
      // keeps its BOUNDARIES, not a top-level marker — the entry records the
      // index range of every rewrite group over the flattened list, so its
      // undo/redo/replay defers the re-bind for exactly those ops while the
      // unmarked siblings keep their immediate behaviour (SOL R3 #2).
      const wholeEntry = meta?.referenceRewrite === true;
      const ranges: Array<[number, number]> = [];
      const flattened: RvPrimitiveOp[] = [];
      for (const o of collected) {
        if (o.kind !== 'composite') { flattened.push(o as RvPrimitiveOp); continue; }
        journalId ??= journalIdOf(o);
        const base = flattened.length;
        for (const [start, end] of referenceRewriteRangesOf(o)) ranges.push([base + start, base + end]);
        for (const child of o.ops) flattened.push(child);
      }
      const extra: RvOpMeta = {};
      if (journalId) extra.journalId = journalId;
      if (wholeEntry) extra.referenceRewrite = true;
      else if (ranges.length > 0) extra.referenceRewriteRanges = ranges;
      const outMeta: RvOpMeta | undefined = Object.keys(extra).length > 0 ? { ...meta, ...extra } : undefined;
      const entry = this._composite(label, flattened, outMeta) as RvCompositeOp;
      if (coalesce) this._recordKeyed(entry, coalesce);
      else this._record(entry);
    }).finally(() => { this._closeTransaction(); });
  }

  /**
   * Abandon the transaction and ROLL BACK everything it applied.
   *
   * Deliberately stronger than `SceneStore.abortTransaction`, which discarded
   * the buffer and left the forward applies on the live scene with the comment
   * "caller is responsible for any rollback". That contract is not carried over:
   * it is the mechanism behind a scene that disagrees with its own history.
   */
  abortTransaction(_token?: RvTransactionToken): Promise<void> {
    if (this._txnDepth === 0) return Promise.resolve();
    this._txnDepth--;
    if (this._txnDepth > 0) return Promise.resolve();
    return this._enqueue(async () => {
      const collected = this._txnOps ?? [];
      const beforeRollback = this._txnBeforeRollback;
      this._closeTransaction();
      runBeforeRollback(beforeRollback);
      await this._rollback(collected);
    }).finally(() => { this._closeTransaction(); });
  }

  /**
   * RAII form. Re-entrant: a nested call folds into the OUTER transaction, so
   * compound tools can reuse actions that open their own.
   */
  async withTransaction<T>(label: string, fn: () => T | Promise<T>, opts?: RvTransactionOptions): Promise<T> {
    const token = this.beginTransaction(label, opts);
    let result: T;
    try {
      result = await fn();
    } catch (e) {
      await this.abortTransaction(token);
      throw e;
    }
    await this.endTransaction(token);
    return result;
  }

  /** True while a transaction is collecting. */
  get inTransaction(): boolean { return this._txnDepth > 0; }

  private _closeTransaction(): void {
    this._txnDepth = 0;
    this._txnOps = null;
    this._txnLabel = '';
    this._txnError = null;
    this._txnBusy = false;
    this._txnMeta = null;
    this._txnBeforeRollback = [];
    this._txnCoalesce = null;
  }

  /**
   * Reverse what a failed transaction applied, newest first.
   *
   * Individual rollback failures are logged, never re-thrown: the caller must
   * learn the ORIGINAL error, and there is nothing better left to try.
   */
  private async _rollback(ops: RvOp[]): Promise<void> {
    if (ops.length === 0) return;
    this._notifyPaused = true;
    try {
      for (let i = ops.length - 1; i >= 0; i--) {
        try {
          await this._applyModelInverse(ops[i]);
        } catch (e) {
          console.error('[rv-document] transaction rollback failed — the scene may be inconsistent:', e);
        }
      }
    } finally {
      this._notifyPaused = false;
    }
  }

  /**
   * The one composite constructor of both modes, origin-typed by `this.mode`.
   *
   * The lineage is genuinely known here — a document's mode is readonly and set
   * at construction — so the transaction's composite is built through the same
   * origin-typed helper an explicit mutator would use, rather than assembling
   * the record inline and bypassing the one place that guarantee lives.
   */
  private _composite(label: string, ops: RvPrimitiveOp[], meta?: RvOpMeta): RvOp {
    return makeComposite(this.mode, label, ops, meta);
  }

  // ─── Replay / lifecycle ─────────────────────────────────────────────

  /**
   * Replay a recovered log onto the freshly loaded base.
   *
   * Ops are pushed WITHOUT coalescing and without clearing redo: a replay
   * reproduces a history, it does not author one. One notification at the end.
   *
   * plan-774 F8 / review fixes E4, E5 (`planPlacedReplay`, shared with the
   * recompose replay): an op whose target inside PLACED content is missing is
   * not applied — dropped from the history when its placement is materialised
   * (the bake merged the node away), KEPT unapplied when it is not (placeholder:
   * the next load that brings the asset applies it); a composite loses only its
   * missing placed children. Every skip is reported (Problems
   * `replay-op-skipped` through the executor), never lost silently.
   *
   * Review fixes E3 / E6: with `opts.gate` the gate is asked per op, on the
   * tree as the ops before it left it — from the first op that must wait for
   * placed content on, the rest becomes the PENDING tail ({@link pendingReplayOps},
   * part of the draft) and is applied on the document's own queue once the
   * placements arrived, so a user edit made meanwhile lands behind it. The
   * wait is bounded by `opts.waitBudgetMs`; a superseded wait keeps the tail
   * pending (re-attempted by {@link replayPendingLocked} on Back / recompose,
   * or by the next load from the draft).
   *
   * @returns the skips of the part replayed now.
   */
  async replayOps(ops: readonly RvOp[], opts: RvDocumentReplayOptions = {}): Promise<RvPlacedReplaySkip[]> {
    // plan-621: a replay reproduces a history — nothing authored before it may
    // be amended by the next keyed step.
    this._coalesceTail = null;
    const { skipped, rest } = await this._replayRun(ops, opts.gate);
    if (rest.length > 0 && opts.gate) {
      this._pendingReplay.push(...rest);
      this._notify();
      const gate = opts.gate;
      const budget = opts.waitBudgetMs ?? DEFAULT_REPLAY_WAIT_BUDGET_MS;
      void this.runExclusive(() => this._settlePendingReplay(gate, budget)).catch((e) => {
        console.error(`[rv-document] replaying the pending tail of '${this._name}' failed:`, e);
      });
    }
    return skipped;
  }

  /**
   * Re-attempt the pending replay tail onto a FRESH tree (plan-774 review fix
   * E3) — Back from a descend, a recompose. The caller MUST hold the document's
   * queue (it is the inside of `recomposeProjection`). `gate` is that reload's
   * own (placements not ready in time): the wait is bounded like the first one.
   * No-op without a pending tail.
   */
  async replayPendingLocked(gate?: RvDocumentReplayGate, waitBudgetMs?: number): Promise<void> {
    if (this._pendingReplay.length === 0) return;
    if (gate && this._pendingReplay.some((op) => gate.needsWait(op))) {
      await this._settlePendingReplay(gate, waitBudgetMs ?? DEFAULT_REPLAY_WAIT_BUDGET_MS);
      return;
    }
    const tail = this._pendingReplay;
    this._pendingReplay = [];
    await this._replayRun(tail, undefined);
  }

  /**
   * Apply `ops` in order (the history part of a replay); stops at the first op
   * `gate` must wait for and hands that op and everything after it back as
   * `rest`. Reports the placed skips once.
   */
  private async _replayRun(
    ops: readonly RvOp[],
    gate: RvDocumentReplayGate | undefined,
  ): Promise<{ skipped: RvPlacedReplaySkip[]; rest: RvOp[] }> {
    const skipped: RvPlacedReplaySkip[] = [];
    let rest: RvOp[] = [];
    // plan-766 §2.4.4: one bracket around the whole replay, so observers that
    // rebuild per op (the editor arenas) build once at the end instead.
    this.executor.beginReplay?.();
    try {
      for (let i = 0; i < ops.length; i++) {
        const op = ops[i];
        // E6: asked HERE, per op — an earlier op of this replay (a rename of the
        // reference node, say) has already changed the tree the gate reads.
        if (gate?.needsWait(op)) {
          rest = ops.slice(i);
          break;
        }
        const plan = planPlacedReplay(this.executor, op);
        skipped.push(...plan.skips);
        if (plan.apply) await this._applyModelForward(plan.apply);
        if (plan.keep) this._ops.push(plan.keep);
      }
    } finally {
      this.executor.endReplay?.();
    }
    this._enforceCap();
    if (ops.length > 0) this._emitHistory('replace');
    this._notify();
    this._reportReplaySkips(skipped);
    return { skipped, rest };
  }

  /**
   * The pending tail's wait (on the queue): placements arrived → applied;
   * superseded → kept pending; the budget ran out → moved into the history
   * UNAPPLIED (kept in the draft, reported "still loading") so the queue is
   * free again — never an endless `runExclusive`.
   */
  private async _settlePendingReplay(gate: RvDocumentReplayGate, budgetMs: number): Promise<void> {
    if (this._disposed || this._pendingReplay.length === 0) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race<boolean | 'timeout'>([
      gate.wait().catch(() => false),
      new Promise<'timeout'>((resolve) => { timer = setTimeout(() => resolve('timeout'), Math.max(0, budgetMs)); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (this._disposed) return;
    if (outcome === false) {
      // Another document took the viewer (a descend, a switch): the tail stays
      // pending — the draft keeps it, Back / the next load re-attempts it.
      console.warn(`[rv-document] '${this._name}': ${this._pendingReplay.length} recovered op(s) wait for placed content of a document that is not on screen — kept`);
      return;
    }
    const tail = this._pendingReplay;
    this._pendingReplay = [];
    if (outcome === 'timeout') {
      // In log order: an op on placed content goes into the history UNAPPLIED
      // (kept — the draft and every later recompose carry it); an own-content op
      // of the tail is applied as usual, its targets do not wait for anything.
      const skipped: RvPlacedReplaySkip[] = [];
      this.executor.beginReplay?.();
      try {
        for (const op of tail) {
          const target = this.executor.replayTargetInPlacedContent?.(op) ?? null;
          if (target) {
            skipped.push({ kind: op.kind, nodePath: target.nodePath, reason: 'still-loading' });
          } else {
            await this._applyModelForward(op);
          }
          this._ops.push(op);
        }
      } finally {
        this.executor.endReplay?.();
      }
      this._enforceCap();
      this._emitHistory('replace');
      this._notify();
      this._reportReplaySkips(skipped);
      return;
    }
    await this._replayRun(tail, undefined);
  }

  private _reportReplaySkips(skipped: readonly RvPlacedReplaySkip[]): void {
    if (skipped.length === 0) return;
    console.warn(`[rv-document] replay onto '${this._name}': ${skipped.length} op(s) on placed content not applied`);
    try { this.executor.reportReplaySkips?.(skipped, this._name); } catch (e) {
      console.warn('[rv-document] reporting skipped replay ops failed:', e);
    }
  }

  /**
   * Declare the current state clean (fresh open / save).
   *
   * `opts.floor` re-arms the undo floor — a scene that just saved its ops into
   * its base has a new set of protected leading ops.
   */
  markSaved(opts?: { name?: string; floor?: number }): void {
    if (opts?.name) this._name = opts.name;
    if (opts?.floor !== undefined) this._baselineFloor = Math.max(0, opts.floor);
    this._baselineIds = this._ops.map((o) => o.id);
    this._metaDirty = false;
    // plan-621: a save is a clean point — the next keyed step must not amend an
    // entry that is part of the saved state.
    this._coalesceTail = null;
    this._changed();
  }

  /**
   * Really take back everything above `floor`: apply the inverses, newest
   * first, and cut the log (plan-711 R1-S1).
   *
   * The DISCARD of a binding, and deliberately not {@link markSaved}. A
   * `markSaved({floor})` rebases the clean point onto the ops that are there,
   * so at a document that dies straight afterwards it reads as "discarded" —
   * but a SHARED document does not die at the end of a projection, and the
   * rebase would hand the ops the user just threw away to the other projection
   * as a clean, saved state. Verbs have to mean what they say at a document
   * that outlives the verb.
   *
   * On the queue, so nothing lands between the last inverse and the cut. An
   * individual inverse that fails is logged and skipped for the same reason
   * `_rollback` does it: there is nothing better left to try, and stopping
   * half-way leaves a state the log cannot describe. The redo branch goes too —
   * discarded work is not offered back through Redo.
   *
   * @returns how many ops were taken back.
   */
  rollbackTo(floor: number): Promise<number> {
    const target = Math.max(0, Math.min(floor, this._ops.length));
    return this.runExclusive(async () => {
      const doomed = this._ops.slice(target);
      if (doomed.length === 0) return 0;
      this._notifyPaused = true;
      try {
        for (let i = doomed.length - 1; i >= 0; i--) {
          try {
            await this._applyModelInverse(doomed[i]);
          } catch (e) {
            console.error('[rv-document] discard rollback failed — the scene may be inconsistent:', e);
          }
        }
      } finally {
        this._notifyPaused = false;
      }
      this._ops.length = target;
      this._redo.length = 0;
      this._coalesceTail = null;
      if (this._coalesceFloor !== null) this._coalesceFloor = Math.min(this._coalesceFloor, target);
      this._emitHistory('rollback');
      this._changed();
      return doomed.length;
    });
  }

  /** Wait for every queued op to finish (save pipelines call this first). */
  whenIdle(): Promise<void> { return this._queue; }

  /**
   * Run `work` ON the op queue, so no op can interleave with it.
   *
   * `whenIdle()` is not a substitute: it resolves against the tail as it was at
   * the moment of the call, so an op queued while `work` runs slips in
   * underneath. Anything that MATERIALISES the op log — a save, a bake, writing
   * settings into the model — has to hold the queue for its whole duration, or
   * it can read a log that gained an op after it started.
   *
   * Failures propagate to the caller and never poison the tail, exactly as for
   * an op.
   */
  runExclusive<T>(work: () => Promise<T>): Promise<T> {
    this._busyDepth++;
    this._notify();
    let result!: T;
    let failure: unknown = null;
    let failed = false;
    const tail = this._queue.then(async () => {
      try {
        result = await work();
      } catch (e) {
        failure = e;
        failed = true;
      } finally {
        this._busyDepth--;
        this._notify();
      }
    });
    this._queue = tail;
    return tail.then(() => { if (failed) throw failure; return result; });
  }

  /**
   * Everything the document's HISTORY consists of, frozen.
   *
   * Not a draft: a draft is a REPLAY recipe, this is a state photograph. The
   * caller restores the SCENE by other means (re-loading an exported blob) and
   * uses this only to re-attach the history to it — see
   * {@link restoreHistory}. Every array is copied; the live stacks keep moving.
   */
  captureHistory(): RvDocumentHistory {
    return {
      ops: [...this._ops],
      redoOps: [...this._redo],
      baselineIds: [...this._baselineIds],
      baselineFloor: this._baselineFloor,
      metaDirty: this._metaDirty,
    };
  }

  /**
   * Put a {@link captureHistory} snapshot back WITHOUT replaying anything.
   *
   * Replaying instead would re-apply ops a `markSaved` has already baked into
   * the base, so a clean document would come back dirty. Used by the in-place
   * editor test session (plan-410 §2.4), and by the document stack when a frame
   * is restored (plan-703 Phase 4).
   */
  restoreHistory(state: RvDocumentHistory, opts?: { announce?: boolean }): void {
    this._coalesceTail = null;
    this._ops = [...state.ops];
    this._redo = [...state.redoOps];
    this._baselineIds = [...state.baselineIds];
    this._baselineFloor = Math.max(0, state.baselineFloor);
    this._metaDirty = state.metaDirty;
    // `announce` is for the one caller that restores a DIFFERENT history than
    // it froze: the undo-by-recompose (plan-711 §2.3), where the log genuinely
    // changed and the draft writers have to hear about it. Every other restore
    // puts back what was already there — announcing that would wake a draft
    // write for a document that did not change.
    if (this._coalesceFloor !== null) this._coalesceFloor = Math.min(this._coalesceFloor, this._ops.length);
    if (opts?.announce) {
      // plan-641 M9: an announced restore is a DIFFERENT history — a change.
      this._emitHistory('replace');
      this._changed();
    } else this._notify();
  }

  dispose(): void {
    this._disposed = true;
    this.executor.dispose?.();
    this._listeners.clear();
    this._commitHooks.clear();
  }

  // ─── React store ────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  getSnapshot = (): RvDocumentSnapshot => {
    if (!this._snapshot) {
      const lastOp = this._ops[this._ops.length - 1] ?? null;
      const nextRedo = this._redo[this._redo.length - 1] ?? null;
      this._snapshot = {
        ...this.core,
        id: this.id,
        name: this._name,
        mode: this.mode,
        undoLabel: lastOp && this.canUndo() ? describeRvOp(lastOp) : null,
        redoLabel: nextRedo ? describeRvOp(nextRedo) : null,
        opCount: this._ops.length,
      };
    }
    return this._snapshot;
  };

  // ─── internals ──────────────────────────────────────────────────────

  private _record(op: RvOp): void {
    if (this._txnOps) {
      // Inside a transaction: collect, don't touch history yet.
      this._txnOps.push(op);
      return;
    }
    // plan-621: every entry recorded WITHOUT a coalesce key (a user edit, an
    // un-keyed transaction) breaks the open keyed chain.
    this._coalesceTail = null;
    const last = this._ops[this._ops.length - 1];
    // The stricter of the two rules (SceneStore): never coalesce INTO a
    // protected baseline op — that would rewrite a `prev` undo can't reach.
    // plan-641 M8: a coalesce floor (macro recording) protects like the baseline.
    const headIsAboveFloor = this._topAboveFloors();
    let kind: RvHistoryChange['kind'] = 'record';
    let opId = op.id;
    if (last && headIsAboveFloor && canCoalesceRvOps(last, op)) {
      this._ops[this._ops.length - 1] = mergeRvOps(last, op);
      // The merged op keeps `last`'s id and inverse payload, so whatever the
      // executor stashed for `op` (the intermediate material / geometry) is
      // unreachable from here on (plan-621).
      this.executor.releaseAbsorbed?.([op.id]);
      kind = 'coalesce';
      opId = last.id;
    } else {
      this._ops.push(op);
    }
    this._redo.length = 0; // a new edit invalidates the redo branch
    this._enforceCap();
    this._emitHistory(kind, opId);
    this._changed();
  }

  /**
   * Record a KEYED transaction entry (plan-621, Spike (b) V2): amend the top
   * entry when the chain is unbroken, push it otherwise.
   *
   * Merge only when ALL hold:
   *  1. a chain is open with the same key and the top entry IS the chain's
   *     entry — any other record, undo, redo, journal replay, save, draft
   *     replay, history restore or rollback cleared the chain;
   *  2. the step arrives within the SLIDING window of the last merged step;
   *  3. the top entry is above the undo floor AND not part of the clean point
   *     (`_baselineIds`) — the asset lineage has floor 0, so the floor alone
   *     does not protect a saved entry;
   *  4. {@link foldKeyedComposite} accepts (neither side is journaled).
   *
   * A failed (rolled back) step never reaches this method, so it leaves the
   * chain standing. A different key starts a new chain.
   */
  private _recordKeyed(op: RvCompositeOp, coalesce: RvCoalesceOptions): void {
    const windowMs = coalesce.windowMs ?? DEFAULT_COALESCE_WINDOW_MS;
    const top = this._ops[this._ops.length - 1];
    const tail = this._coalesceTail;
    const canMerge = !!top && top.kind === 'composite' && !!tail
      && tail.key === coalesce.key
      && tail.entryId === top.id
      && op.ts >= tail.lastTs && op.ts - tail.lastTs <= tail.windowMs
      && this._topAboveFloors()
      && !this._baselineIds.includes(top.id);
    const fold = canMerge ? foldKeyedComposite(top as RvCompositeOp, op) : null;
    if (fold) {
      this._ops[this._ops.length - 1] = fold.merged;
      this._coalesceStats.merged++;
      this._coalesceStats.absorbed += fold.absorbed.length;
      if (fold.absorbed.length > 0) this.executor.releaseAbsorbed?.(fold.absorbed);
      this._redo.length = 0;
      this._coalesceTail = { key: coalesce.key, entryId: fold.merged.id, lastTs: op.ts, windowMs };
      this._emitHistory('coalesce', fold.merged.id);
      this._changed();
      return;
    }
    this._ops.push(op);
    this._redo.length = 0;
    this._enforceCap();
    this._coalesceTail = { key: coalesce.key, entryId: op.id, lastTs: op.ts, windowMs };
    this._emitHistory('record', op.id);
    this._changed();
  }

  /** Drop the oldest ops past the cap, keeping the undo floor aligned. */
  private _enforceCap(): void {
    if (this._ops.length <= MAX_OP_HISTORY) return;
    const drop = this._ops.length - MAX_OP_HISTORY;
    this._ops.splice(0, drop);
    this._baselineFloor = Math.max(0, this._baselineFloor - drop);
    // plan-641 M8: the coalesce floor moves with the entries it protects.
    if (this._coalesceFloor !== null) this._coalesceFloor = Math.max(0, this._coalesceFloor - drop);
    if (this._baselineIds.length > 0) {
      this._baselineIds = this._baselineIds.slice(Math.min(drop, this._baselineIds.length));
    }
  }

  /**
   * Run `work` on the single-flight queue.
   *
   * Two promises, deliberately: the QUEUE TAIL never rejects (a rejected tail
   * would fail every later op through `.then`), while the promise handed to the
   * CALLER does. That split is what lets a failed op be both survivable for the
   * document and observable for whoever asked for it.
   */
  private _enqueue(work: () => Promise<void>): Promise<void> {
    this._busyDepth++;
    this._notify();
    let failure: unknown = null;
    let failed = false;
    const tail = this._queue.then(async () => {
      try {
        await work();
      } catch (e) {
        failure = e;
        failed = true;
        console.warn('[rv-document] op failed:', e);
      } finally {
        this._busyDepth--;
        this._notify();
      }
    });
    this._queue = tail;
    return tail.then(() => { if (failed) throw failure; });
  }

  private _changed(): void {
    this._notify();
    if (this._txnOps || this._notifyPaused) return;
    this._onChanged?.(this);
    // Copied before iterating: a hook that detaches itself (the unbind path
    // does exactly that) must not mutate the set mid-loop.
    for (const hook of [...this._commitHooks]) hook(this);
  }

  /**
   * Invalidate the snapshot and wake the store.
   *
   * Coalesced while a transaction is open or a rollback runs: `_enqueue`
   * notifies twice per op, so a 434-node bulk edit produced 868 store updates
   * and blew React's update-depth limit mid-apply (plan-359). The transaction
   * always ends with notifications that DO pass — the composite `_record` and
   * `_enqueue`'s own `finally` both run after the buffer is cleared.
   */
  private _notify(): void {
    if (this._txnOps || this._notifyPaused) return;
    this._snapshot = null;
    for (const fn of this._listeners) fn();
  }
}

/** Run the before-rollback hooks of a transaction; a failing hook never stops the rollback. */
function runBeforeRollback(hooks: ReadonlyArray<() => void>): void {
  for (const hook of hooks) {
    try { hook(); } catch (e) { console.error('[rv-document] beforeRollback hook failed:', e); }
  }
}
