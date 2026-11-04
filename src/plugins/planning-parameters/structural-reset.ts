// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * structural-reset — the ONE apply path of the planning parameters (plan-630 §2.5a).
 *
 * The structure of a plant never changes while its simulation runs (Thomas,
 * 2026-10-24). So everything structural — an output switched off, a buffer with
 * fewer slots, a scene component reconfigured, and later the size of the whole
 * plant (plan-681) — happens in one asynchronous ritual at a standstill:
 *
 *   1. lock + identity   a second apply answers `apply-in-progress`; the
 *                        document's load id is remembered, and a document change
 *                        aborts from here on
 *   2. halt              FastForward cancelled, simulation paused — nothing runs,
 *                        MUs stay where they are
 *   3. commit            pending values become committed (log rows at t = 0)
 *   4. reconfigure       every owner's `onStructuralReset`
 *   5. one runner reset  `resetSimulation()` ONCE, then wait for the DES runner's
 *                        first `bound` (plan-645) so the owner has rebound before
 *                        the simulation is let go
 *   6. start             the pause state of before is restored; a failed apply
 *                        leaves the simulation paused at t = 0
 *
 * ## One transaction (plan-681 Gate-R1 #1 / R2 #1)
 *
 * Steps 3-5 run inside `viewer.structuralEdit()` (plan-681 §2.3, `rv-viewer.ts`):
 * the transaction withholds the automatic rebind of plan-645 and every
 * `resetSimulation()` (the path-verb resets included), and flushes exactly one
 * reset when it closes — with a raised scene generation when an owner placed,
 * removed or replaced content (the PalletYard size), so the DES runner rebinds
 * once. The `bound` handler then always sees values and structure that belong
 * together (new/new or old/old). A viewer without the method (a test double)
 * runs the body directly, which is equivalent for owners that change
 * configuration only.
 *
 * An apply works at ANY time (Thomas 2026-10-26: "jederzeit neu aufbauen, Reset
 * der Simulation ist dafuer erlaubt"): a running simulation is halted in step 2,
 * rebuilt, reset, and resumes in step 6.
 *
 * ## What is NOT compared against what (plan-630 §2.3, Gate-R2 #2)
 *
 * `documentLoadId` is the ONLY identity that means "another document": the
 * viewer's scene generation rises from the apply's own work, and the runner
 * generation counts runs. A document change during the wait answers
 * `document-changed` and does nothing further — the new load binds itself.
 *
 * `ctx.awaitPlacements()` deliberately does NOT wait for the
 * `placements-materialized` event: it fires once per load (`sealLoad`) and never
 * again afterwards — measured 0 events for runtime placements (plan-681 spike,
 * 2026-10-25, auflage A1). It waits for `viewer.placements.whenMaterialized()`;
 * the id-exact check of the owner's own placements is the OWNER's job (it alone
 * knows its target state), and plan-630 has no owner that places anything.
 */

import type {
  PlanningApplyContext,
  PlanningApplyResult,
  PlanningApplyRunner,
} from '../../core/planning/rv-planning-registry';
import { structuralApplyTargets } from '../../core/planning/rv-planning-registry';
import type { StructuralResetContext } from '../../core/planning/rv-planning-params';
import { clearProblem } from '../../core/hmi/problems-store';

/** Pause reason of the apply itself — its own, so releasing it leaves a user pause standing. */
export const PLANNING_APPLY_PAUSE_REASON = 'planning-apply';

const PROBLEM_APPLY = 'planning-apply-failed';
const PROBLEM_ROLLBACK = 'planning-apply-rollback-failed';

// ─── The slice of the viewer this runner uses ──────────────────────────────

/** DES lifecycle event as `onDesLifecycle` delivers it (structural subset). */
interface LifecycleEvent {
  readonly type: string;
  /** The runner's own counter — read for diagnostics only, never compared. */
  readonly generation?: number;
}

/** The DES control surface this runner touches. */
interface DesControlSlice {
  cancelFastForward?(): void;
}

/** The simulation kernel slice this runner touches. */
interface KernelSlice {
  readonly mode?: string;
  desControl?(): DesControlSlice | null;
  onDesLifecycle?(fn: (e: LifecycleEvent) => void, opts?: { replay?: boolean }): () => void;
  hasDesLifecycle?(): boolean;
}

/**
 * What the runner needs of the viewer — a narrow slice, so the test drives it
 * with a fake instead of a loaded scene (`RVViewer` satisfies it structurally).
 */
export interface StructuralResetViewer {
  setSimulationPaused(reason: string, paused: boolean): void;
  readonly isSimulationPaused: boolean;
  resetSimulation(): void;
  readonly simulationKernel?: KernelSlice | null;
  /** plan-681 §2.3 — present only once that plan has landed; feature-detected. */
  structuralEdit?<T>(fn: () => Promise<T> | T): Promise<T>;
  readonly placements?: { whenMaterialized?(): Promise<unknown> } | null;
}

/** Construction options of {@link createStructuralResetRunner}. */
export interface StructuralResetOptions {
  viewer: StructuralResetViewer;
  /** Identity of the loaded document — changes ONLY on a document change / reload. */
  documentLoadId(): string;
  /** Aborted on document change and on dispose. */
  signal(): AbortSignal;
  /**
   * Told while an apply is in flight. The plugin uses it to keep its
   * `simulation-reset` listener off the change log: the reset in step 5 is the
   * apply's own, and the commit rows at t = 0 belong to the run it starts.
   * Set HERE rather than around the registry call, so it is true however the
   * apply was reached (overlay button, MCP, experiment batch).
   */
  markApplying?(active: boolean): void;
  /** Overridable for the test; default 10 000 ms (the hull's). */
  boundTimeoutMs?: number;
}

// ─── The runner ────────────────────────────────────────────────────────────

type HullModule = typeof import('../../core/params/rv-param-apply');

/** The hull once loaded (page-wide): from then on an apply reaches its owners synchronously. */
let hullCache: HullModule | null = null;
let hullLoading: Promise<HullModule> | null = null;

/**
 * Loads the lazy hull chunk (`core/params/rv-param-apply`). Called when a runner is
 * installed — long before the first apply — so the old apply keeps its synchronous start.
 */
export function preloadStructuralResetHull(): Promise<HullModule> {
  hullLoading ??= import('../../core/params/rv-param-apply').then((m) => (hullCache = m));
  return hullLoading;
}

/**
 * Builds the §2.5a runner the planning plugin installs with
 * `registry.setApplyRunner()`. The registry serialises the calls
 * (`apply-in-progress`) and counts the generation; the hull (lock, halt, the ONE
 * structural transaction with its single reset, the `bound` wait, the pause state)
 * lives in `core/params/rv-param-apply.ts` since plan-2013 Phase 1 and is reached
 * through `import()` — the lazy adapter that keeps the apply service off the startup
 * path (Gate R1 #6). What stays here is the planning body: commit, owners, rollback.
 */
export function createStructuralResetRunner(options: StructuralResetOptions): PlanningApplyRunner {
  const { viewer, documentLoadId, signal } = options;
  preloadStructuralResetHull().catch(() => { /* reported by the apply that needs it */ });

  return async function runStructuralReset(ctx: PlanningApplyContext) {
    // Identity BEFORE any await: a document change meanwhile is document-changed.
    const startDocument = documentLoadId();
    const startSignal = signal();
    const { runTransaction } = hullCache ?? await preloadStructuralResetHull();
    let outcome: Omit<PlanningApplyResult, 'generation'> = { ok: true };

    const tx = await runTransaction({
      viewer,
      documentLoadId,
      signal: () => startSignal,
      startDocument,
      markApplying: options.markApplying,
      boundTimeoutMs: options.boundTimeoutMs,
      pauseReason: PLANNING_APPLY_PAUSE_REASON,
    }, async (txCtx) => {
      const abort = txCtx.signal;
      const changed = (): boolean => documentLoadId() !== startDocument || abort.aborted;
      const resetCtx: StructuralResetContext = {
        documentLoadId: startDocument,
        awaitPlacements: () => txCtx.awaitPlacements(),
        signal: abort,
      };
      ctx.startNewRun();
      const record = ctx.commitAllPending();
      try {
        for (const { owner, committed } of structuralApplyTargets(ctx, record)) {
          const decl = ctx.declarationOf(owner);
          if (!decl?.onStructuralReset) continue;
          await decl.onStructuralReset(committed, resetCtx);
          if (changed()) throw new DocumentChangedError();
        }
        clearProblem(PROBLEM_APPLY);
        return { ok: true };
      } catch (err) {
        // Whatever the owner threw: if the document changed under it, that is
        // the cause — no rollback onto the new document (plan-681 Codex review #1).
        if (err instanceof DocumentChangedError || changed()) {
          outcome = { ok: false, error: 'document-changed' };
          return { ok: false, error: 'document-changed' };
        }
        const detail = err instanceof Error ? err.message : String(err);
        ctx.revertCommit(record);
        ctx.report({
          id: PROBLEM_APPLY,
          severity: 'error',
          code: PROBLEM_APPLY,
          title: 'Applying planning parameters failed',
          detail,
        });
        // The owner configures the PREVIOUS state back, on the same path and
        // inside the same transaction, so it still is exactly one reset.
        try {
          for (const r of record._restore) {
            if (changed()) throw new DocumentChangedError();
            await ctx.declarationOf(r.owner)?.onStructuralReset?.(ctx.valuesOf(r.owner), resetCtx);
            if (changed()) throw new DocumentChangedError();
          }
        } catch (rollbackErr) {
          if (rollbackErr instanceof DocumentChangedError || changed()) {
            outcome = { ok: false, error: 'document-changed' };
            return { ok: false, error: 'document-changed' };
          }
          ctx.report({
            id: PROBLEM_ROLLBACK,
            severity: 'error',
            code: PROBLEM_ROLLBACK,
            title: 'Restoring the previous planning configuration failed — reload the document',
            detail: rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr),
          });
        }
        outcome = { ok: false, error: 'materialize-failed', detail };
        return { ok: false, error: 'materialize-failed', detail };
      }
    });

    if (tx.ok) return outcome;
    if (tx.error === 'document-changed') return { ok: false, error: 'document-changed' };
    if (tx.error === 'apply-in-progress') return { ok: false, error: 'apply-in-progress' };
    if (tx.error === 'bound-timeout') {
      const detail = tx.detail ?? 'the DES runner did not rebind';
      ctx.report({ id: PROBLEM_APPLY, severity: 'error', code: PROBLEM_APPLY, title: 'Applying planning parameters failed', detail });
      return { ok: false, error: 'materialize-failed', detail };
    }
    if (!outcome.ok) return outcome;
    return { ok: false, error: 'materialize-failed', detail: tx.detail ?? tx.error };
  };
}

/** Internal marker: the document changed under the apply (never surfaced as a message). */
class DocumentChangedError extends Error {
  constructor() { super('document-changed'); this.name = 'DocumentChangedError'; }
}
