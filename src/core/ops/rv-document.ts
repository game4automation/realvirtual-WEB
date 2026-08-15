// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

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
  makeComposite,
  mergeRvOps,
  type RvOp,
  type RvPrimitiveOp,
} from './rv-unified-ops';
import type { RvDocumentMode, RvExecutor } from './rv-unified-executors';

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

  /** Metadata dirty (document rename) — OR'd into {@link dirty}. */
  private _metaDirty = false;
  private _disposed = false;

  private _snapshot: RvDocumentSnapshot | null = null;
  private readonly _listeners = new Set<() => void>();

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
  /** The live op log. Treat as read-only — mutate through the op API. */
  get ops(): readonly RvOp[] { return this._ops; }
  get opCount(): number { return this._ops.length; }
  get baselineFloor(): number { return this._baselineFloor; }
  get isDisposed(): boolean { return this._disposed; }

  /** Derived from the op log, never a side flag (plan §5.2). */
  get dirty(): boolean {
    if (this._metaDirty) return true;
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
      await this.executor.applyForward(op);
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
    void this.applyOp(op).catch((e) => {
      if (this._txnOps && this._txnError === null) this._txnError = e;
    });
  }

  /** Undo the newest op, down to the baseline floor. */
  async undo(): Promise<void> {
    await this._enqueue(async () => {
      if (this._canApply && !this._canApply()) return;
      if (!this.canUndo()) return;
      const op = this._ops[this._ops.length - 1];
      // The stacks move only AFTER the inverse applied — popping first would
      // discard the entry on a failed undo, leaving the change with no way back.
      await this.executor.applyInverse(op);
      this._ops.pop();
      this._redo.push(op);
    });
    this._changed();
  }

  /** Redo the newest undone op. Same stack discipline as {@link undo}. */
  async redo(): Promise<void> {
    await this._enqueue(async () => {
      if (this._canApply && !this._canApply()) return;
      const op = this._redo[this._redo.length - 1];
      if (!op) return;
      await this.executor.applyForward(op);
      this._redo.pop();
      this._ops.push(op);
    });
    this._changed();
  }

  // ─── Transactions ───────────────────────────────────────────────────

  /**
   * Open a transaction: subsequent ops accumulate into ONE composite undo unit.
   * Reference-counted — only the outermost {@link endTransaction} commits.
   */
  beginTransaction(label: string): RvTransactionToken {
    if (this._txnDepth === 0) {
      this._txnLabel = label;
      this._txnError = null;
      // Publish "busy" BEFORE suppression starts — the only notification the UI
      // gets while the transaction runs (F6). ORDER IS LOAD-BEARING: `_notify`
      // returns early once `_txnOps` is set, so assigning the buffer first
      // swallows exactly the announcement this line exists to make, and a bulk
      // import leaves the toolbar looking idle for its whole duration.
      this._txnBusy = true;
      this._notify();
      this._txnOps = [];
    }
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
      this._closeTransaction();
      if (failure !== null) {
        await this._rollback(collected);
        throw failure;
      }
      if (collected.length === 0) return;
      // Composites never nest — flatten one level, exactly like both templates.
      const flattened = collected.flatMap(
        (o) => (o.kind === 'composite' ? o.ops : [o as RvPrimitiveOp]),
      );
      this._record(this._composite(label, flattened));
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
      this._closeTransaction();
      await this._rollback(collected);
    }).finally(() => { this._closeTransaction(); });
  }

  /**
   * RAII form. Re-entrant: a nested call folds into the OUTER transaction, so
   * compound tools can reuse actions that open their own.
   */
  async withTransaction<T>(label: string, fn: () => T | Promise<T>): Promise<T> {
    const token = this.beginTransaction(label);
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
          await this.executor.applyInverse(ops[i]);
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
  private _composite(label: string, ops: RvPrimitiveOp[]): RvOp {
    return makeComposite(this.mode, label, ops);
  }

  // ─── Replay / lifecycle ─────────────────────────────────────────────

  /**
   * Replay a recovered log onto the freshly loaded base.
   *
   * Ops are pushed WITHOUT coalescing and without clearing redo: a replay
   * reproduces a history, it does not author one. One notification at the end.
   */
  async replayOps(ops: readonly RvOp[]): Promise<void> {
    for (const op of ops) {
      await this.executor.applyForward(op);
      this._ops.push(op);
    }
    this._enforceCap();
    this._notify();
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
            await this.executor.applyInverse(doomed[i]);
          } catch (e) {
            console.error('[rv-document] discard rollback failed — the scene may be inconsistent:', e);
          }
        }
      } finally {
        this._notifyPaused = false;
      }
      this._ops.length = target;
      this._redo.length = 0;
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
    if (opts?.announce) this._changed();
    else this._notify();
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
    const last = this._ops[this._ops.length - 1];
    // The stricter of the two rules (SceneStore): never coalesce INTO a
    // protected baseline op — that would rewrite a `prev` undo can't reach.
    const headIsAboveFloor = this._ops.length > this._baselineFloor;
    if (last && headIsAboveFloor && canCoalesceRvOps(last, op)) {
      this._ops[this._ops.length - 1] = mergeRvOps(last, op);
    } else {
      this._ops.push(op);
    }
    this._redo.length = 0; // a new edit invalidates the redo branch
    this._enforceCap();
    this._changed();
  }

  /** Drop the oldest ops past the cap, keeping the undo floor aligned. */
  private _enforceCap(): void {
    if (this._ops.length <= MAX_OP_HISTORY) return;
    const drop = this._ops.length - MAX_OP_HISTORY;
    this._ops.splice(0, drop);
    this._baselineFloor = Math.max(0, this._baselineFloor - drop);
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
