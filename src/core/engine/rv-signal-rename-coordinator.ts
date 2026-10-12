// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-signal-rename-coordinator.ts — executes a signal rename across stores
 * (plan-590 Phase 4).
 *
 * A rename touches up to five independent places: the CONNECT gateway, one or
 * two op-log documents (asset / scene overlay), the planner placements and the
 * historian selection. None of them can join a transaction of another, so the
 * coordinator keeps a JOURNAL per rename and orders the steps exactly as plan
 * §2.1 says:
 *
 *   0.  journal entry {state:'started', before:{heads, redo branches, placed,
 *       historian}} — BEFORE the first side effect
 *   0b. refuse when the old name has more than one model owner
 *   1.  `signalStore.beginRename(old, new)` (Rename-/Sync-Vertrag)
 *   2.  CONNECT apply with the plan's `renameRevision` and a fresh operation id —
 *       409 → nothing changed, journal 'aborted'; no answer → the status
 *       endpoint, and when that cannot tell either: 'unknown' (locks further
 *       renames, Problems entry with "Re-check")
 *   3.  per document ONE transaction tagged `meta.journalId` with every
 *       persisted change of that document (name, string fields, panel,
 *       metadata, ST code via the PLC seam's `writePlcCode`, node mappings)
 *   4.  placed mappings, historian selection — each recorded in `done`
 *   5.  `endRename(commit)`, journal 'committed'
 *
 * A failure after step 2 runs the REVERSE PHASE: `beginRename(new, old)`
 * first (so the editor sync migrates back instead of releasing and
 * re-registering), then every committed document entry is replayed backwards
 * (`RvDocument.replayHistory`, no new history) and its redo branch restored
 * from the journal, a failed transaction rolls back under the same phase
 * (`beforeRollback`), placements and historian come back from `before`, and
 * CONNECT gets the inverse rename with a NEW operation id. A step of the
 * reverse phase that fails leaves the journal 'inconsistent' and a Problems
 * error `signal-rename-inconsistent` with a repair action.
 *
 * Undo / Redo: the coordinator is the HISTORY INTERCEPTOR of every document a
 * rename wrote to. Undoing the tagged entry (from any of them) runs the same
 * reverse phase as a whole — never only the model part — after checking that
 * every involved document still has the rename on top (else 'refused', the
 * stacks stay). Redo is the forward phase over `replayHistory(…, 'redo')`.
 */

import type { RvDocument, RvHistoryDirection, RvHistoryVerdict } from '../ops/rv-document';
import type { RvOp } from '../ops/rv-unified-ops';
import type { SignalStore } from './rv-signal-store';
import {
  getSignalRenamePlcAdapter,
  planSignalRename,
  type SignalRenameCodeTarget,
  type SignalRenameConnectPort,
  type SignalRenameHistorianPort,
  type SignalRenameMapping,
  type SignalRenamePlacedPort,
  type SignalRenamePlan,
  type SignalRenamePlcAdapter,
  type SignalRenameStep,
  type SignalRenameViewerLike,
} from './rv-signal-rename';
import {
  fetchSignalRenameStatus, getConnectSnapshot, renameSignal as connectRenameSignal,
} from '../hmi/connect-store';
import { historianStore } from '../hmi/historian-store';
import {
  clearProblem, reportProblem, SIGNAL_RENAME_RECHECK_COMMAND, SIGNAL_RENAME_REPAIR_COMMAND, type ProblemInput,
} from '../hmi/problems-store';
import { getSceneStore } from '../hmi/scene/scene-store-singleton';
import { freshOpId } from '../ops/rv-op-utils';

// ─── Ports ───────────────────────────────────────────────────────────────

/** One op-log document a rename writes to. */
export interface SignalRenameDocTarget extends SignalRenameCodeTarget {
  /** Stable id — the journal's key for this document's history head. */
  id: string;
  /** Which lineage (what the journal's `done` records). */
  kind: 'asset-doc' | 'scene-doc';
  /** The document whose history carries the tagged entry. */
  document: RvDocument;
}

/** Where coordinator problems go (default: the Problems panel store). */
export interface SignalRenameProblemsPort {
  report(problem: ProblemInput): void;
  clear(id: string): void;
}

/** Everything a rename reads and writes besides the viewer. */
export interface SignalRenameEnvironment {
  /**
   * `model`: the open document (asset in the editor, else the scene) — name,
   * string fields, panel, metadata, ST code. `overlay`: the scene document the
   * node signal mappings live in; absent or the same document → `model`.
   */
  docs: { model: SignalRenameDocTarget | null; overlay?: SignalRenameDocTarget | null };
  connect?: SignalRenameConnectPort | null;
  placed?: SignalRenamePlacedPort | null;
  historian?: SignalRenameHistorianPort | null;
  /** Default: the registered PLC seam; `null` = no PLC. */
  plc?: SignalRenamePlcAdapter | null;
  problems?: SignalRenameProblemsPort | null;
  /** Lost-answer polling of the CONNECT status endpoint. Default 5 × 400 ms. */
  statusPoll?: { attempts: number; delayMs: number };
  /** Test seam for the polling delay. */
  sleep?: (ms: number) => Promise<void>;
  /** Test seam for journal / operation ids. */
  newId?: () => string;
}

// ─── Journal ─────────────────────────────────────────────────────────────

export type SignalRenameJournalState = 'started' | 'committed' | 'aborted' | 'inconsistent' | 'unknown';
export type SignalRenameJournalStep = 'connect' | 'asset-doc' | 'scene-doc' | 'placed' | 'historian';

/** History position of one document as the journal saw it. */
export interface SignalRenameHeadBefore {
  undoLen: number;
  redoLen: number;
  topId?: string;
  /** The redo branch BEFORE the rename — restored when the rename is taken back. */
  redo: RvOp[];
}

/** The journal entry of one rename (plan §2.4). */
export interface SignalRenameJournalEntry {
  id: string;
  oldName: string;
  newName: string;
  state: SignalRenameJournalState;
  /** Operation id of the LAST CONNECT apply of this entry. */
  operationId: string;
  done: SignalRenameJournalStep[];
  before: {
    placed?: Array<{ id: string; mappings: SignalRenameMapping[] }>;
    historian?: string[];
    heads: Record<string, SignalRenameHeadBefore>;
  };
  after?: { heads: Record<string, { undoLen: number; topId: string }> };
  renameRevisionBefore: string | null;
  renameRevisionAfter?: string | null;
  /** True while the rename is in effect (after commit / redo), false after undo or rollback. */
  applied: boolean;
  /** Ids of the documents carrying a tagged entry. */
  docIds: string[];
  /** Human-readable cause of the last failure. */
  error?: string;
  /** What a repair still has to bring back (inconsistent entries). */
  pendingRepair?: Array<'connect' | 'placed' | 'historian'>;
}

/** Outcome of {@link SignalRenameCoordinator.apply}. */
export interface SignalRenameApplyResult {
  status: 'committed' | 'refused' | 'aborted' | 'unknown' | 'inconsistent';
  journalId?: string;
  /** Why it was refused / aborted / left inconsistent. */
  reason?: string;
}

/** Problem code of a rename that left the stores disagreeing (plan F7). */
export const SIGNAL_RENAME_INCONSISTENT_CODE = 'signal-rename-inconsistent';
/**
 * Commands of the repair action and of the re-check action of an 'unknown' CONNECT outcome
 * (descriptors in `editor-command-descriptors.ts`). Defined in the dependency-free
 * `problems-store`, re-exported here.
 */
export { SIGNAL_RENAME_RECHECK_COMMAND, SIGNAL_RENAME_REPAIR_COMMAND };

/** Problem id of a journal entry. */
export function signalRenameProblemId(journalId: string): string {
  return `${SIGNAL_RENAME_INCONSISTENT_CODE}:${journalId}`;
}

/** A rename that is in progress and must not be interrupted by a second one. */
export class SignalRenameRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalRenameRefusedError';
  }
}

type ConnectMove =
  | { kind: 'committed'; revision: string | null }
  | { kind: 'rejected'; reason: string }
  | { kind: 'failed-after-persist' }
  | { kind: 'unknown' };

/** Order of field steps inside a document transaction: the name first (the sync moves the store with it). */
const DOC_STEP_ORDER: Record<string, number> = {
  'signal-name': 0, 'string-field': 1, 'operator-panel': 2, 'metadata': 3, 'plc-program': 4, 'signal-link': 5,
};

// ─── Coordinator ─────────────────────────────────────────────────────────

/**
 * Runs renames planned by {@link planSignalRename} and owns their undo/redo.
 * One per viewer ({@link getSignalRenameCoordinator}).
 */
export class SignalRenameCoordinator {
  private readonly _journal = new Map<string, SignalRenameJournalEntry>();
  /** Live targets of each entry (not part of the serialisable journal). */
  private readonly _targets = new Map<string, SignalRenameDocTarget[]>();
  /** ST edits of each entry, to point open editor buffers at the right code after a move. */
  private readonly _plcEdits = new Map<string, Array<{ nodePath: string; prevCode: string; nextCode: string }>>();
  /** Placement / historian values after the rename (redo). */
  private readonly _afterValues = new Map<string, { placed: Array<{ id: string; mappings: SignalRenameMapping[] }>; historian?: string[] }>();
  /** Documents this coordinator intercepts. */
  private readonly _intercepted = new Set<RvDocument>();
  /** CONNECT apply whose outcome is unknown, per entry (for the re-check). */
  private readonly _unknownMove = new Map<string, { from: string; to: string; operationId: string; resume: SignalRenameJournalState }>();
  private _busy = false;

  constructor(
    private readonly viewer: SignalRenameViewerLike,
    private readonly envProvider: () => SignalRenameEnvironment,
  ) {}

  // ── Read side ──

  /** Every journal entry, oldest first. */
  journal(): SignalRenameJournalEntry[] { return [...this._journal.values()]; }

  /** One journal entry. */
  entry(journalId: string): SignalRenameJournalEntry | undefined { return this._journal.get(journalId); }

  /** The entry whose CONNECT outcome is unknown — it locks further renames. */
  get lockedBy(): string | null {
    for (const e of this._journal.values()) if (e.state === 'unknown') return e.id;
    return null;
  }

  /** True while a rename / undo / redo runs. */
  get busy(): boolean { return this._busy; }

  /** Plan with this coordinator's environment (convenience for command / dialog). */
  plan(path: string, newName: string): Promise<SignalRenamePlan> {
    const env = this.envProvider();
    return planSignalRename(this.viewer, path, newName, {
      connect: env.connect ?? null,
      placed: env.placed ?? null,
      historian: env.historian ?? null,
      ...(env.plc !== undefined ? { plc: env.plc } : {}),
    });
  }

  /** Remove the interceptor from every document this coordinator installed it on. */
  dispose(): void {
    for (const doc of this._intercepted) {
      if (doc.historyInterceptor === this._interceptor) doc.setHistoryInterceptor(null);
    }
    this._intercepted.clear();
  }

  // ── Apply ──

  /**
   * Execute a plan. `confirmWireChange` is required when the plan has wire
   * effects. Never throws for an expected outcome — the result says what
   * happened; the journal keeps the details.
   */
  async apply(plan: SignalRenamePlan, opts: { confirmWireChange?: boolean } = {}): Promise<SignalRenameApplyResult> {
    if (!plan.ok) return { status: 'refused', reason: plan.blockers.join(' ') || 'The rename is blocked.' };
    if (plan.requiresWireConfirmation && opts.confirmWireChange !== true) {
      return { status: 'refused', reason: 'The rename changes names on the wire — confirm the wire change first.' };
    }
    const locked = this.lockedBy;
    if (locked) {
      return { status: 'refused', reason: 'A previous rename has an unknown CONNECT outcome — re-check it first.' };
    }
    if (this._busy) return { status: 'refused', reason: 'Another signal rename is running.' };
    const store = this.viewer.signalStore ?? null;
    if (!store) return { status: 'refused', reason: 'No signal store.' };
    const env = this.envProvider();
    const { oldName, newName } = plan;

    // 0b. Several model owners: plan-589 allows colliding raw authored names.
    const owners = store.registeredPaths(oldName).filter((p) => !p.startsWith('__iface__/'));
    if (owners.length > 1) {
      return { status: 'refused', reason: `The name "${oldName}" is registered by ${owners.length} model nodes: ${owners.join(', ')}.` };
    }

    // Documents and their steps.
    const docSteps = new Map<SignalRenameDocTarget, SignalRenameStep[]>();
    for (const step of plan.steps) {
      if (!step.write || !step.doc) continue;
      const target = step.doc === 'overlay' ? (env.docs.overlay ?? env.docs.model) : env.docs.model;
      if (!target) return { status: 'refused', reason: 'No document is open to write the rename into.' };
      // Two roles on the same RvDocument are ONE transaction.
      const same = [...docSteps.keys()].find((t) => t.document === target.document);
      const key = same ?? target;
      const list = docSteps.get(key) ?? [];
      list.push(step);
      docSteps.set(key, list);
    }
    for (const t of docSteps.keys()) {
      if (t.document.inTransaction) return { status: 'refused', reason: `The document "${t.document.name}" is busy.` };
    }
    const plc = env.plc === undefined ? getSignalRenamePlcAdapter() : env.plc;
    const plcSteps = plan.steps.filter((s) => s.kind === 'plc-program');
    if (plcSteps.length > 0 && !plc) return { status: 'refused', reason: 'The PLC programs cannot be written (no PLC).' };
    const connectStep = plan.steps.some((s) => s.kind === 'connect');
    if (connectStep && !env.connect) return { status: 'refused', reason: 'CONNECT is not available.' };
    const placedSteps = plan.steps.filter((s) => s.kind === 'placed-mapping');
    if (placedSteps.length > 0 && !env.placed) return { status: 'refused', reason: 'The planner is not available.' };
    const historianStep = plan.steps.find((s) => s.kind === 'historian');
    if (historianStep && !env.historian) return { status: 'refused', reason: 'The historian is not available.' };

    this._busy = true;
    try {
      // 0. Journal BEFORE the first side effect.
      const id = this._newId(env);
      const targets = [...docSteps.keys()];
      const heads: Record<string, SignalRenameHeadBefore> = {};
      for (const t of targets) heads[t.id] = { ...t.document.historyHead(), redo: t.document.redoBranch() };
      const placedIds = new Set(placedSteps.map((s) => s.placedId!));
      const entry: SignalRenameJournalEntry = {
        id, oldName, newName, state: 'started', operationId: this._newId(env), done: [],
        before: {
          heads,
          ...(placedIds.size > 0 ? {
            placed: (env.placed?.list() ?? []).filter((p) => placedIds.has(p.id))
              .map((p) => ({ id: p.id, mappings: (p.signalMappings ?? []).map((m) => ({ ...m })) })),
          } : {}),
          ...(historianStep ? { historian: [...(env.historian?.selected() ?? [])] } : {}),
        },
        renameRevisionBefore: plan.renameRevision,
        applied: false,
        docIds: targets.map((t) => t.id),
      };
      this._journal.set(id, entry);
      this._targets.set(id, targets);
      this._plcEdits.set(id, plcSteps.map((s) => ({ nodePath: s.nodePath!, prevCode: String(s.prev ?? ''), nextCode: String(s.value) })));
      this._afterValues.set(id, {
        placed: placedSteps.map((s) => ({ id: s.placedId!, mappings: (s.value as SignalRenameMapping[]).map((m) => ({ ...m })) })),
        ...(historianStep ? { historian: [...(historianStep.value as string[])] } : {}),
      });

      // 1. Announce the rename (Rename-/Sync-Vertrag).
      store.beginRename(oldName, newName);
      const phase = { reversed: false };

      // 2. CONNECT.
      if (connectStep) {
        const move = await this._connectMove(env, entry, oldName, newName, plan.renameRevision, entry.operationId);
        if (move.kind === 'rejected') {
          store.endRename(oldName, newName, 'abort');
          entry.state = 'aborted';
          entry.error = move.reason;
          return { status: 'aborted', journalId: id, reason: move.reason };
        }
        if (move.kind === 'unknown') {
          store.endRename(oldName, newName, 'abort');
          this._markUnknown(env, entry, oldName, newName, entry.operationId, 'aborted');
          return { status: 'unknown', journalId: id, reason: entry.error };
        }
        entry.done.push('connect');
        if (move.kind === 'failed-after-persist') {
          return this._rollbackForward(env, store, entry, phase,
            new Error('CONNECT persisted the rename but could not finish it (failed-after-persist).'));
        }
        entry.renameRevisionAfter = move.revision;
      }

      try {
        // 3. One transaction per document.
        for (const [target, stepsOfDoc] of docSteps) {
          this.attach(target.document);
          const ordered = [...stepsOfDoc].sort((a, b) => (DOC_STEP_ORDER[a.kind] ?? 9) - (DOC_STEP_ORDER[b.kind] ?? 9));
          await target.document.withTransaction(`Rename signal ${oldName} → ${newName}`, async () => {
            for (const s of ordered) {
              if (s.kind === 'plc-program') {
                await plc!.writePlcCode(target, s.nodePath!, String(s.value), { signal: newName, absent: oldName });
              } else {
                await target.setField(s.nodePath!, s.componentType!, s.field!, s.value, s.prev);
              }
            }
          }, {
            meta: { journalId: id },
            // The automatic rollback of a failed transaction runs under the reverse phase.
            beforeRollback: () => this._enterReverse(store, entry, phase),
          });
          if (!target.document.isHistoryTop(id, 'undo')) {
            throw new Error(`The rename entry of "${target.document.name}" was not recorded.`);
          }
          entry.done.push(target.kind);
        }
        // Safety net: the editor sync moved the store with the name step; a
        // signal without a synced node (process image) is moved here. Idempotent.
        store.renameSignal(oldName, newName);
        for (const e of this._plcEdits.get(id) ?? []) plc?.refreshBuffer?.(e.nodePath, e.nextCode, e.prevCode);

        // 4. Placements and historian (journal only).
        const after = this._afterValues.get(id)!;
        if (after.placed.length > 0) {
          entry.done.push('placed');
          for (const p of after.placed) env.placed!.update(p.id, p.mappings.map((m) => ({ ...m })));
        }
        if (after.historian) {
          entry.done.push('historian');
          env.historian!.setSelected([...after.historian]);
        }
      } catch (e) {
        return this._rollbackForward(env, store, entry, phase, e);
      }

      // 5. Commit.
      store.endRename(oldName, newName, 'commit');
      entry.state = 'committed';
      entry.applied = true;
      entry.after = { heads: {} };
      for (const t of targets) {
        const h = t.document.historyHead();
        entry.after.heads[t.id] = { undoLen: h.undoLen, topId: h.topId ?? '' };
      }
      return { status: 'committed', journalId: id };
    } finally {
      this._busy = false;
    }
  }

  // ── Re-check / repair (Problems actions) ──

  /**
   * Ask CONNECT for the outcome of an 'unknown' apply. When it committed, the
   * gateway is put back (the local side never moved); when it was rejected or
   * never seen, nothing is to do. Either way the lock is lifted.
   */
  async recheck(journalId: string): Promise<SignalRenameJournalState | null> {
    const entry = this._journal.get(journalId);
    const move = this._unknownMove.get(journalId);
    if (!entry || entry.state !== 'unknown' || !move) return entry?.state ?? null;
    const env = this.envProvider();
    const status = await env.connect?.fetchStatus(move.operationId) ?? null;
    if (status === 'pending' || status === null) return entry.state;
    if (status === 'committed' || status === 'failed-after-persist') {
      const back = await this._connectMoveWithPreview(env, entry, move.to, move.from);
      if (back.kind !== 'committed') {
        entry.state = 'inconsistent';
        entry.pendingRepair = ['connect'];
        entry.error = `CONNECT renamed "${move.from}" to "${move.to}" and could not be put back: ${describeMove(back)}`;
        this._unknownMove.delete(journalId);
        this._reportInconsistent(env, entry);
        return entry.state;
      }
    }
    entry.state = move.resume;
    entry.error = undefined;
    this._unknownMove.delete(journalId);
    env.problems?.clear(signalRenameProblemId(journalId));
    return entry.state;
  }

  /**
   * Retry what the reverse phase of an 'inconsistent' entry could not bring
   * back (CONNECT, placements, historian). Document history that failed to
   * replay cannot be repaired here — the entry stays inconsistent then.
   */
  async repair(journalId: string): Promise<SignalRenameJournalState | null> {
    const entry = this._journal.get(journalId);
    if (!entry || entry.state !== 'inconsistent') return entry?.state ?? null;
    const env = this.envProvider();
    const pending = new Set(entry.pendingRepair ?? []);
    // The state the stores must reach: the rename in effect or not.
    const [from, to] = entry.applied ? [entry.oldName, entry.newName] : [entry.newName, entry.oldName];
    if (pending.has('connect')) {
      const move = await this._connectMoveWithPreview(env, entry, from, to);
      if (move.kind === 'committed') pending.delete('connect');
      else entry.error = `CONNECT could not be repaired: ${describeMove(move)}`;
    }
    if (pending.has('placed')) {
      try {
        const values = entry.applied ? this._afterValues.get(journalId)?.placed ?? [] : entry.before.placed ?? [];
        for (const p of values) env.placed?.update(p.id, p.mappings.map((m) => ({ ...m })));
        pending.delete('placed');
      } catch (e) { entry.error = `Planner bindings could not be repaired: ${errText(e)}`; }
    }
    if (pending.has('historian')) {
      try {
        const values = entry.applied ? this._afterValues.get(journalId)?.historian : entry.before.historian;
        if (values) env.historian?.setSelected([...values]);
        pending.delete('historian');
      } catch (e) { entry.error = `The historian selection could not be repaired: ${errText(e)}`; }
    }
    entry.pendingRepair = [...pending];
    if (pending.size === 0 && !entry.error?.startsWith('Document')) {
      entry.state = entry.applied ? 'committed' : 'aborted';
      entry.error = undefined;
      env.problems?.clear(signalRenameProblemId(journalId));
    } else {
      this._reportInconsistent(env, entry);
    }
    return entry.state;
  }

  // ── History interceptor (undo / redo of a tagged entry) ──

  private readonly _interceptor = (entry: RvOp, direction: RvHistoryDirection, doc: RvDocument): Promise<RvHistoryVerdict> => {
    const id = entry.kind === 'composite' ? entry.meta?.journalId : undefined;
    if (!id) return Promise.resolve('default');
    return this._historyMove(id, direction, doc);
  };

  /**
   * Make this coordinator the history interceptor of `doc` (done for every
   * document a rename writes to; call it for a document that is opened with
   * tagged entries already in its log, so their undo is never model-only).
   */
  attach(doc: RvDocument): void {
    if (doc.historyInterceptor !== this._interceptor) doc.setHistoryInterceptor(this._interceptor);
    this._intercepted.add(doc);
  }

  /** Undo (direction `undo`) or redo a committed rename as a whole. */
  private async _historyMove(id: string, direction: RvHistoryDirection, initiator: RvDocument): Promise<RvHistoryVerdict> {
    const entry = this._journal.get(id);
    // A tagged entry without a journal (the page was reloaded) is never undone as model-only.
    if (!entry) return 'refused';
    if (this._busy || this.lockedBy) return 'refused';
    if (entry.state !== 'committed') return 'refused';
    if (direction === 'undo' ? !entry.applied : entry.applied) return 'refused';
    const store = this.viewer.signalStore ?? null;
    if (!store) return 'refused';
    const targets = this._targets.get(id) ?? [];
    // Every involved document must still have the rename on top (same head as the journal).
    for (const t of targets) {
      if (!t.document.isHistoryTop(id, direction)) return 'refused';
      if (direction === 'undo') {
        const h = t.document.historyHead();
        const want = entry.after?.heads[t.id];
        if (want && (h.undoLen !== want.undoLen || h.topId !== want.topId)) return 'refused';
      }
    }
    const env = this.envProvider();
    if (entry.done.includes('connect') && !env.connect) return 'refused';
    const plc = env.plc === undefined ? getSignalRenamePlcAdapter() : env.plc;
    const [from, to] = direction === 'undo' ? [entry.newName, entry.oldName] : [entry.oldName, entry.newName];

    this._busy = true;
    try {
      store.beginRename(from, to);
      const phase = { reversed: false };
      let connectMoved = false;
      if (entry.done.includes('connect')) {
        const operationId = this._newId(env);
        const revision = entry.renameRevisionAfter ?? null;
        const move = revision
          ? await this._connectMove(env, entry, from, to, revision, operationId)
          : await this._connectMoveWithPreview(env, entry, from, to, operationId);
        if (move.kind === 'rejected') {
          store.endRename(from, to, 'abort');
          entry.error = move.reason;
          return 'refused';
        }
        if (move.kind === 'unknown') {
          store.endRename(from, to, 'abort');
          this._markUnknown(env, entry, from, to, operationId, 'committed');
          return 'refused';
        }
        entry.operationId = operationId;
        connectMoved = true;
        if (move.kind === 'committed') entry.renameRevisionAfter = move.revision;
        else return await this._compensateHistoryMove(env, store, entry, from, to, [], connectMoved, phase, direction,
          new Error('CONNECT could not finish the rename (failed-after-persist).'));
      }
      const moved: SignalRenameDocTarget[] = [];
      try {
        for (const t of targets) {
          const run = () => t.document.replayHistory(id, direction);
          if (t.document === initiator) await run();
          else await t.document.runExclusive(run);
          moved.push(t);
        }
        store.renameSignal(from, to);
        const after = this._afterValues.get(id);
        const placed = direction === 'undo' ? entry.before.placed ?? [] : after?.placed ?? [];
        for (const p of placed) env.placed?.update(p.id, p.mappings.map((m) => ({ ...m })));
        const historian = direction === 'undo' ? entry.before.historian : after?.historian;
        if (historian) env.historian?.setSelected([...historian]);
      } catch (e) {
        return await this._compensateHistoryMove(env, store, entry, from, to, moved, connectMoved, phase, direction, e);
      }
      for (const e of this._plcEdits.get(id) ?? []) {
        plc?.refreshBuffer?.(e.nodePath, direction === 'undo' ? e.prevCode : e.nextCode,
          direction === 'undo' ? e.nextCode : e.prevCode);
      }
      store.endRename(from, to, 'commit');
      entry.applied = direction === 'redo';
      if (direction === 'redo') {
        entry.after = { heads: {} };
        for (const t of targets) {
          const h = t.document.historyHead();
          entry.after.heads[t.id] = { undoLen: h.undoLen, topId: h.topId ?? '' };
        }
      }
      return 'handled';
    } finally {
      this._busy = false;
    }
  }

  /** A history move failed half way: bring every moved part back to where it was. */
  private async _compensateHistoryMove(
    env: SignalRenameEnvironment, store: SignalStore, entry: SignalRenameJournalEntry,
    from: string, to: string, moved: SignalRenameDocTarget[], connectMoved: boolean,
    phase: { reversed: boolean }, direction: RvHistoryDirection, cause: unknown,
  ): Promise<RvHistoryVerdict> {
    const failures: string[] = [];
    store.endRename(from, to, 'abort');
    store.beginRename(to, from);
    phase.reversed = true;
    const back: RvHistoryDirection = direction === 'undo' ? 'redo' : 'undo';
    for (const t of [...moved].reverse()) {
      try { await t.document.runExclusive(() => t.document.replayHistory(entry.id, back)); }
      catch (e) { failures.push(`Document "${t.document.name}": ${errText(e)}`); }
    }
    try { store.renameSignal(to, from); } catch (e) { failures.push(`Signal store: ${errText(e)}`); }
    const after = this._afterValues.get(entry.id);
    try {
      const placed = direction === 'undo' ? after?.placed ?? [] : entry.before.placed ?? [];
      for (const p of placed) env.placed?.update(p.id, p.mappings.map((m) => ({ ...m })));
    } catch (e) { failures.push(`Planner bindings: ${errText(e)}`); }
    try {
      const historian = direction === 'undo' ? after?.historian : entry.before.historian;
      if (historian) env.historian?.setSelected([...historian]);
    } catch (e) { failures.push(`Historian: ${errText(e)}`); }
    let connectFailed = false;
    if (connectMoved) {
      const move = await this._connectMoveWithPreview(env, entry, to, from);
      if (move.kind !== 'committed') { connectFailed = true; failures.push(`CONNECT: ${describeMove(move)}`); }
      else entry.renameRevisionAfter = move.revision;
    }
    store.endRename(to, from, 'commit');
    entry.error = `${direction === 'undo' ? 'Undo' : 'Redo'} failed: ${errText(cause)}`;
    if (failures.length > 0) {
      entry.state = 'inconsistent';
      entry.pendingRepair = connectFailed ? ['connect'] : [];
      entry.error += ` — not restored: ${failures.join('; ')}`;
      this._reportInconsistent(env, entry);
    }
    return 'refused';
  }

  // ── Forward rollback (reverse phase) ──

  /** Switch the store from the forward rename into its reverse phase — once. */
  private _enterReverse(store: SignalStore, entry: SignalRenameJournalEntry, phase: { reversed: boolean }): void {
    if (phase.reversed) return;
    phase.reversed = true;
    store.endRename(entry.oldName, entry.newName, 'abort');
    store.beginRename(entry.newName, entry.oldName);
  }

  /** A forward step failed after CONNECT was (possibly) applied: take everything back. */
  private async _rollbackForward(
    env: SignalRenameEnvironment, store: SignalStore, entry: SignalRenameJournalEntry,
    phase: { reversed: boolean }, cause: unknown,
  ): Promise<SignalRenameApplyResult> {
    this._enterReverse(store, entry, phase);
    const failures: string[] = [];
    const pendingRepair: Array<'connect' | 'placed' | 'historian'> = [];
    const targets = this._targets.get(entry.id) ?? [];
    // Committed document entries, newest first; then their redo branches.
    for (const t of [...targets].reverse()) {
      if (!entry.done.includes(t.kind) || !t.document.isHistoryTop(entry.id, 'undo')) continue;
      try {
        await t.document.runExclusive(() => t.document.replayHistory(entry.id, 'undo'));
        t.document.restoreRedoBranch(entry.before.heads[t.id]?.redo ?? []);
      } catch (e) {
        failures.push(`Document "${t.document.name}": ${errText(e)}`);
      }
    }
    try { store.renameSignal(entry.newName, entry.oldName); } catch (e) { failures.push(`Signal store: ${errText(e)}`); }
    const plc = env.plc === undefined ? getSignalRenamePlcAdapter() : env.plc;
    for (const e of this._plcEdits.get(entry.id) ?? []) plc?.refreshBuffer?.(e.nodePath, e.prevCode, e.nextCode);
    if (entry.done.includes('placed')) {
      try {
        for (const p of entry.before.placed ?? []) env.placed?.update(p.id, p.mappings.map((m) => ({ ...m })));
      } catch (e) { failures.push(`Planner bindings: ${errText(e)}`); pendingRepair.push('placed'); }
    }
    if (entry.done.includes('historian')) {
      try {
        if (entry.before.historian) env.historian?.setSelected([...entry.before.historian]);
      } catch (e) { failures.push(`Historian: ${errText(e)}`); pendingRepair.push('historian'); }
    }
    if (entry.done.includes('connect')) {
      const operationId = this._newId(env);
      const move = entry.renameRevisionAfter
        ? await this._connectMove(env, entry, entry.newName, entry.oldName, entry.renameRevisionAfter, operationId)
        : await this._connectMoveWithPreview(env, entry, entry.newName, entry.oldName, operationId);
      if (move.kind === 'committed') entry.renameRevisionAfter = move.revision;
      else { failures.push(`CONNECT: ${describeMove(move)}`); pendingRepair.push('connect'); }
    }
    store.endRename(entry.newName, entry.oldName, 'commit');
    entry.applied = false;
    entry.error = errText(cause);
    if (failures.length > 0) {
      entry.state = 'inconsistent';
      entry.pendingRepair = pendingRepair;
      entry.error += ` — not restored: ${failures.join('; ')}`;
      this._reportInconsistent(env, entry);
      return { status: 'inconsistent', journalId: entry.id, reason: entry.error };
    }
    entry.state = 'aborted';
    return { status: 'aborted', journalId: entry.id, reason: entry.error };
  }

  // ── CONNECT ──

  /** One CONNECT apply, with the lost-answer protocol (status endpoint). */
  private async _connectMove(
    env: SignalRenameEnvironment, entry: SignalRenameJournalEntry,
    from: string, to: string, revision: string | null, operationId: string,
  ): Promise<ConnectMove> {
    const port = env.connect;
    if (!port) return { kind: 'rejected', reason: 'CONNECT is not available.' };
    let out;
    try {
      out = await port.renameSignal(from, to, revision, false, operationId);
    } catch (e) {
      out = { kind: 'error' as const, message: errText(e) };
    }
    entry.operationId = operationId;
    switch (out.kind) {
      case 'ok': return { kind: 'committed', revision: out.result.renameRevision ?? null };
      case 'revision-mismatch': return { kind: 'rejected', reason: 'The CONNECT configuration changed since the preview — plan the rename again.' };
      case 'name-collision': return { kind: 'rejected', reason: `CONNECT already has a signal named "${to}".` };
      case 'validation': return { kind: 'rejected', reason: `CONNECT rejected the rename: ${out.detail}` };
      case 'unsupported': return { kind: 'rejected', reason: 'This CONNECT version cannot rename signals — update CONNECT.' };
      case 'failed-after-persist': return { kind: 'failed-after-persist' };
      default: break;
    }
    // No answer: ask the status endpoint until the outcome is known.
    const poll = env.statusPoll ?? { attempts: 5, delayMs: 400 };
    const sleep = env.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
    for (let i = 0; i < poll.attempts; i++) {
      let status = null;
      try { status = await port.fetchStatus(operationId); } catch { status = null; }
      if (status === 'committed') {
        // The revision after the commit: a dry run of the way back reports it.
        let revisionAfter: string | null = null;
        try {
          const preview = await port.renameSignal(to, from, null, true, null);
          if (preview.kind === 'ok') revisionAfter = preview.result.renameRevision ?? null;
        } catch { /* stays null — the next move previews again */ }
        return { kind: 'committed', revision: revisionAfter };
      }
      if (status === 'rejected') return { kind: 'rejected', reason: 'CONNECT rejected the rename.' };
      if (status === 'failed-after-persist') return { kind: 'failed-after-persist' };
      if (i < poll.attempts - 1) await sleep(poll.delayMs);
    }
    return { kind: 'unknown' };
  }

  /** A CONNECT move without a known revision: preview first, then apply with the previewed revision. */
  private async _connectMoveWithPreview(
    env: SignalRenameEnvironment, entry: SignalRenameJournalEntry, from: string, to: string,
    operationId = this._newId(env),
  ): Promise<ConnectMove> {
    const port = env.connect;
    if (!port) return { kind: 'rejected', reason: 'CONNECT is not available.' };
    let revision: string | null = null;
    try {
      const preview = await port.renameSignal(from, to, null, true, null);
      if (preview.kind !== 'ok') return { kind: 'rejected', reason: `CONNECT dry run failed (${preview.kind}).` };
      revision = preview.result.renameRevision ?? null;
    } catch (e) {
      return { kind: 'rejected', reason: `CONNECT is not reachable: ${errText(e)}` };
    }
    return this._connectMove(env, entry, from, to, revision, operationId);
  }

  // ── Problems ──

  private _markUnknown(
    env: SignalRenameEnvironment, entry: SignalRenameJournalEntry,
    from: string, to: string, operationId: string, resume: SignalRenameJournalState,
  ): void {
    entry.state = 'unknown';
    entry.error = `CONNECT did not answer whether "${from}" was renamed to "${to}".`;
    this._unknownMove.set(entry.id, { from, to, operationId, resume });
    env.problems?.report({
      id: signalRenameProblemId(entry.id),
      severity: 'error',
      code: SIGNAL_RENAME_INCONSISTENT_CODE,
      title: `Signal rename "${entry.oldName}" → "${entry.newName}": CONNECT outcome unknown`,
      detail: `${entry.error} Further signal renames are locked until the outcome is known. `
        + 'Re-check asks CONNECT again and puts its configuration back if it did rename.',
      action: { label: 'Re-check', commandId: SIGNAL_RENAME_RECHECK_COMMAND, args: { journalId: entry.id } },
    });
  }

  private _reportInconsistent(env: SignalRenameEnvironment, entry: SignalRenameJournalEntry): void {
    env.problems?.report({
      id: signalRenameProblemId(entry.id),
      severity: 'error',
      code: SIGNAL_RENAME_INCONSISTENT_CODE,
      title: `Signal rename "${entry.oldName}" → "${entry.newName}" left an inconsistent state`,
      detail: entry.error ?? 'Not every part of the rename could be taken back.',
      action: { label: 'Repair', commandId: SIGNAL_RENAME_REPAIR_COMMAND, args: { journalId: entry.id } },
    });
  }

  private _newId(env: SignalRenameEnvironment): string {
    return env.newId ? env.newId() : `sr_${freshOpId().replace(/^op_/, '')}`;
  }
}

function errText(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function describeMove(m: ConnectMove): string {
  switch (m.kind) {
    case 'rejected': return m.reason;
    case 'failed-after-persist': return 'CONNECT could not finish the rename (failed-after-persist)';
    case 'unknown': return 'CONNECT did not answer';
    default: return 'ok';
  }
}

// ─── Default wiring ──────────────────────────────────────────────────────

/** Read one field from the live tree (what a document target's `readField` does). */
function readLiveField(
  viewer: SignalRenameViewerLike, nodePath: string, componentType: string, fieldName: string,
): unknown {
  const node = viewer.registry?.getNode(nodePath) ?? null;
  const rv = node?.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined;
  return rv?.[componentType]?.[fieldName];
}

/**
 * A document target over an `RvDocument` and its awaitable `setField`
 * (`AssetDocument.setFieldAwaited`, a SceneStore `applyOp` of a setField op).
 */
export function createSignalRenameDocTarget(opts: {
  viewer: SignalRenameViewerLike;
  kind: 'asset-doc' | 'scene-doc';
  document: RvDocument;
  setField(nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): Promise<void>;
  id?: string;
}): SignalRenameDocTarget {
  return {
    id: opts.id ?? opts.document.id,
    kind: opts.kind,
    document: opts.document,
    setField: opts.setField,
    readField: (nodePath, componentType, fieldName) => readLiveField(opts.viewer, nodePath, componentType, fieldName),
  };
}

/** Document target of an `AssetDocument` (structural — no editor import). */
export function signalRenameDocTargetForAsset(
  viewer: SignalRenameViewerLike,
  asset: {
    readonly document: RvDocument;
    setFieldAwaited(nodePath: string, componentType: string, fieldName: string, value: unknown, prev: unknown): Promise<void>;
  },
): SignalRenameDocTarget {
  return createSignalRenameDocTarget({
    viewer, kind: 'asset-doc', document: asset.document,
    setField: (p, c, f, v, prev) => asset.setFieldAwaited(p, c, f, v, prev),
  });
}

/** Document target of a `SceneStore` (structural). */
export function signalRenameDocTargetForScene(
  viewer: SignalRenameViewerLike,
  scene: { readonly document: RvDocument; applyOp(op: never): Promise<void> },
): SignalRenameDocTarget {
  return createSignalRenameDocTarget({
    viewer, kind: 'scene-doc', document: scene.document,
    setField: (nodePath, componentType, fieldName, value, prev) => scene.applyOp({
      id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'setField', nodePath, componentType, fieldName, value, prev,
    } as never),
  });
}

/** The CONNECT port over `connect-store`. */
export const connectStoreSignalRenamePort: SignalRenameConnectPort = {
  isConnected: () => getConnectSnapshot().state === 'connected',
  interfaces: () => getConnectSnapshot().interfaces,
  renameSignal: (oldName, newName, renameRevision, preview, operationId) =>
    connectRenameSignal(oldName, newName, renameRevision, preview, operationId),
  fetchStatus: (operationId) => fetchSignalRenameStatus(operationId),
};

/** The historian port over `historian-store`. */
export const historianSignalRenamePort: SignalRenameHistorianPort = {
  selected: () => historianStore.getSnapshot().selectedSignals,
  setSelected: (names) => historianStore.setSelectedSignals(names),
};

/** The Problems port over `problems-store`. */
export const problemsSignalRenamePort: SignalRenameProblemsPort = {
  report: (p) => { reportProblem(p); },
  clear: (id) => clearProblem(id),
};

/** Structural slice of the layout-planner plugin. */
interface PlannerLike {
  store: {
    getSnapshot(): { placed: ReadonlyArray<{ id: string; label?: string; signalMappings?: SignalRenameMapping[] }> };
    updateSignalMappings(id: string, mappings: SignalRenameMapping[]): void;
  };
}

/**
 * The default environment: CONNECT, historian, problems and the planner of
 * this viewer; documents as given — the scene store when none is given.
 * The asset editor passes its `AssetDocument` as `model` (Teil 3 command).
 */
export function createDefaultSignalRenameEnvironment(
  viewer: SignalRenameViewerLike & { getPlugin?(id: string): unknown },
  docs?: SignalRenameEnvironment['docs'],
): SignalRenameEnvironment {
  let resolvedDocs = docs;
  if (!resolvedDocs) {
    const scene = getSceneStore();
    const target = scene ? signalRenameDocTargetForScene(viewer, scene as never) : null;
    resolvedDocs = { model: target };
  }
  const planner = viewer.getPlugin?.('layout-planner') as PlannerLike | undefined;
  return {
    docs: resolvedDocs,
    connect: connectStoreSignalRenamePort,
    historian: historianSignalRenamePort,
    problems: problemsSignalRenamePort,
    placed: planner?.store ? {
      list: () => planner.store.getSnapshot().placed,
      update: (id, mappings) => planner.store.updateSignalMappings(id, mappings),
    } : null,
  };
}

const _coordinators = new WeakMap<object, SignalRenameCoordinator>();

/**
 * The coordinator of a viewer (created on first use). `envProvider` is read on
 * every apply / undo, so the documents follow the editor mode; it is only
 * taken from the FIRST call.
 */
export function getSignalRenameCoordinator(
  viewer: SignalRenameViewerLike & { getPlugin?(id: string): unknown },
  envProvider?: () => SignalRenameEnvironment,
): SignalRenameCoordinator {
  let c = _coordinators.get(viewer);
  if (!c) {
    c = new SignalRenameCoordinator(viewer, envProvider ?? (() => createDefaultSignalRenameEnvironment(viewer)));
    _coordinators.set(viewer, c);
  }
  return c;
}
