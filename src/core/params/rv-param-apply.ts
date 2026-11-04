// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-param-apply — THE way parameter values reach a running model (plan-2013 §2.5,
 * Phase 1). Lazy: reached only through `import()` (the old planning plugin through its
 * lazy adapter in `structural-reset.ts`, the variant runtime through its own chunk).
 *
 * Two layers:
 *
 * 1. {@link runTransaction} — the hull moved out of `structural-reset.ts` (plan-630 §2.5a,
 *    plan-681): one lock per page, document identity, halt (FastForward cancelled, own
 *    pause reason), ONE `viewer.structuralEdit()` around the body and the single
 *    `resetSimulation()` at its end (also on the failure path), then the wait for the DES
 *    runner's first `bound`, then the pause state of before. A body never resets itself.
 * 2. {@link createParamApplyService} — `apply(ops)` on top: address-free admission first
 *    (nothing happens on a schema error), then inside the hull
 *    4a structural ops → rebuild handlers, 4b resolve the rest NOW (nodes a rebuild created
 *    get their base value captured before the first write; still missing → `unresolved`,
 *    not an error), 4c component validators on the candidate, 4d the one writer + one
 *    `reconfigureFromExtras()`; 4e on any failure in 4a-4d: rebuild with the previous
 *    structural values FIRST, then every previously effective value of the op set written
 *    back by address — in the same hull, so it is still exactly one reset (Gate R1 #2,
 *    R2 #2).
 *
 * The service knows no variants and no experiments: the caller hands it the FULL target
 * state each time (Gate R2 #2) — a destructive rebuild then never loses a value.
 */

import type { Object3D } from 'three';
import { USER_PAUSE_REASON } from '../engine/rv-constants';
import { getMaterialFlow } from '../material-flow/registry';
import { describeComponentType } from '../engine/rv-component-schema-info';
import { paramApplyOf } from '../engine/rv-component-registry';
import { parseNodeAddress } from '../engine/rv-node-id';
import { reportProblem, clearProblem } from '../hmi/problems-store';
import { currentRunLease } from '../hmi/rv-run-lease';
import {
  baseComponentType,
  checkFieldValue,
  fieldKeyId,
  paramRebuildOf,
  paramValidatorOf,
  readBaseValue,
  restoreOp,
  writeFieldOp,
  type BaseValue,
  type FieldKey,
  type FieldOp,
  type FieldVerdict,
  type ParamApplyPath,
  type ParamFieldEnv,
  type ParamFieldInfo,
  type ParamRebuildContext,
  type ParamValue,
} from './rv-param-field';

export * from './rv-param-field';

/** Pause reason of an apply — its own, so releasing it leaves a user pause standing. */
export const PARAM_APPLY_PAUSE_REASON = 'param-apply';
/** Problems code when restoring the previous state failed. */
export const PROBLEM_PARAM_ROLLBACK = 'param-apply-rollback-failed';
const BOUND_TIMEOUT_MS = 10_000;

// ─── The slice of the viewer the hull uses ─────────────────────────────────

interface LifecycleEvent { readonly type: string; readonly generation?: number }
interface KernelSlice {
  readonly mode?: string;
  desControl?(): { cancelFastForward?(): void; reconfigureFromExtras?(): void } | null;
  onDesLifecycle?(fn: (e: LifecycleEvent) => void, opts?: { replay?: boolean }): () => void;
  hasDesLifecycle?(): boolean;
}

/** What the hull and the service need of the viewer (`RVViewer` satisfies it structurally). */
export interface ParamApplyViewer {
  setSimulationPaused(reason: string, paused: boolean): void;
  readonly isSimulationPaused: boolean;
  resetSimulation(): void;
  readonly simulationKernel?: KernelSlice | null;
  structuralEdit?<T>(fn: () => Promise<T> | T): Promise<T>;
  readonly placements?: { whenMaterialized?(): Promise<unknown> } | null;
  readonly registry?: { getNodeByAddress(nodeId: string, occurrence?: string): Object3D | null } | null;
}

/** Who runs a transaction: the viewer and the document identity. */
export interface TransactionHost {
  viewer: ParamApplyViewer;
  /** Identity of the loaded document — changes ONLY on a document change / reload. */
  documentLoadId(): string;
  /** Aborted on document change and on dispose. */
  signal(): AbortSignal;
  /** Told while a transaction is in flight (the old plugin keeps its reset listener quiet). */
  markApplying?(active: boolean): void;
  boundTimeoutMs?: number;
  /** Own pause reason (default {@link PARAM_APPLY_PAUSE_REASON}). */
  pauseReason?: string;
  /**
   * The document the caller started on, captured before an `await` (the lazy adapter
   * imports this module first): a change in between answers `document-changed`.
   */
  startDocument?: string;
}

/** What a transaction body may use. */
export interface TransactionContext extends ParamRebuildContext {
  /** Same document, not aborted. */
  alive(): boolean;
}

/** What a body answers; `document-changed` is detected by the hull as well. */
export type TransactionBodyResult = { ok: true } | { ok: false; error: string; detail?: string };

/** Outcome of {@link runTransaction}. */
export interface TransactionResult {
  ok: boolean;
  /** Body errors pass through; the hull adds `apply-in-progress`, `document-changed`, `bound-timeout`. */
  error?: string;
  detail?: string;
}

// ─── One lock per page ─────────────────────────────────────────────────────

let busy = false;
let idle: Promise<void> = Promise.resolve();

/** True while a transaction runs (any caller). */
export function isParamApplyBusy(): boolean { return busy; }
/** Resolves when no transaction runs. */
export function whenParamApplyIdle(): Promise<void> { return idle; }

class DocumentChangedError extends Error {
  constructor() { super('document-changed'); this.name = 'DocumentChangedError'; }
}

/**
 * The hull (plan-630 §2.5a, moved): lock → identity → halt → ONE structuralEdit with the
 * body and the single reset → wait for `bound` → pause state of before. A failed body
 * leaves the simulation paused at t = 0 under the USER pause (the play button lets it go).
 */
export async function runTransaction(
  host: TransactionHost,
  body: (ctx: TransactionContext) => Promise<TransactionBodyResult>,
): Promise<TransactionResult> {
  const { viewer, documentLoadId } = host;
  const startDocument = host.startDocument ?? documentLoadId();
  const abort = host.signal();
  const alive = (): boolean => documentLoadId() === startDocument && !abort.aborted;
  // A caller that awaited before the hull (the lazy adapter's import) may be stale: no side effect then.
  if (!alive()) return { ok: false, error: 'document-changed' };
  if (busy) return { ok: false, error: 'apply-in-progress' };
  busy = true;
  let release!: () => void;
  idle = new Promise<void>((r) => { release = r; });

  const pauseReason = host.pauseReason ?? PARAM_APPLY_PAUSE_REASON;
  const boundTimeout = host.boundTimeoutMs ?? BOUND_TIMEOUT_MS;
  const kernel = viewer.simulationKernel ?? null;
  const inDes = kernel?.mode === 'des' && kernel.hasDesLifecycle?.() === true;

  // Listener BEFORE anything changes: the close may already produce the `bound`.
  let boundSeen = 0;
  let onBound: (() => void) | null = null;
  const offLifecycle = inDes && kernel?.onDesLifecycle
    ? kernel.onDesLifecycle((e) => { if (e.type !== 'bound') return; boundSeen++; onBound?.(); })
    : () => {};

  host.markApplying?.(true);
  const pausedBefore = viewer.isSimulationPaused;
  try { kernel?.desControl?.()?.cancelFastForward?.(); } catch { /* an older runner has none */ }
  viewer.setSimulationPaused(pauseReason, true);

  const ctx: TransactionContext = {
    documentLoadId: startDocument,
    signal: abort,
    alive,
    awaitPlacements: async () => {
      // plan-681 A1: NOT the `placements-materialized` event (fires once per load).
      await viewer.placements?.whenMaterialized?.();
      if (!alive()) throw new DocumentChangedError();
    },
  };

  let outcome: TransactionResult = { ok: true };
  try {
    const wrapped = async (): Promise<void> => {
      try {
        const r = await body(ctx);
        outcome = r.ok ? { ok: true } : { ok: false, error: r.error, detail: r.detail };
      } catch (err) {
        outcome = err instanceof DocumentChangedError || !alive()
          ? { ok: false, error: 'document-changed' }
          : { ok: false, error: 'failed', detail: err instanceof Error ? err.message : String(err) };
      }
      // The single reset of the whole transaction — on the failure path too.
      if (!alive()) { outcome = { ok: false, error: 'document-changed' }; return; }
      viewer.resetSimulation();
    };
    await (viewer.structuralEdit ? viewer.structuralEdit(wrapped) : wrapped());
    if (!alive()) outcome = { ok: false, error: 'document-changed' };

    if (outcome.error !== 'document-changed' && inDes && boundSeen === 0) {
      const bound = await waitForBound(boundTimeout, abort, (fn) => { onBound = fn; });
      if (!alive()) outcome = { ok: false, error: 'document-changed' };
      else if (!bound) outcome = { ok: false, error: 'bound-timeout', detail: `the DES runner did not rebind within ${boundTimeout} ms` };
    }
    return outcome;
  } finally {
    offLifecycle();
    onBound = null;
    host.markApplying?.(false);
    if (!outcome.ok && outcome.error !== 'document-changed' && !pausedBefore && alive()) {
      viewer.setSimulationPaused(USER_PAUSE_REASON, true);
    }
    viewer.setSimulationPaused(pauseReason, false);
    busy = false;
    release();
  }
}

function waitForBound(timeoutMs: number, abort: AbortSignal, arm: (fn: () => void) => void): Promise<boolean> {
  return new Promise<boolean>((resolve) => {
    let settled = false;
    const done = (ok: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      abort.removeEventListener('abort', onAbort);
      resolve(ok);
    };
    const onAbort = () => done(false);
    const timer = setTimeout(() => done(false), timeoutMs);
    abort.addEventListener('abort', onAbort, { once: true });
    arm(() => done(true));
  });
}

// ─── The service ───────────────────────────────────────────────────────────

/** Who applies (diagnostics; `holder` is matched against the run lease). */
export interface ApplyOptions {
  origin: 'variant' | 'experiment' | 'mcp';
  /** The run-lease holder this apply belongs to (a batch applies under its own lease). */
  holder?: string;
}

/** Outcome of {@link ParamApplyService.apply}. */
export interface ApplyResult {
  ok: boolean;
  /** Ops whose field was written (or already had the value). */
  written: FieldKey[];
  /** Ops whose node does not exist in this configuration — nothing written, not an error. */
  unresolved: FieldKey[];
  /** Base values of nodes the rebuild created, read before the first write. */
  captured: Array<{ key: FieldKey; base: BaseValue }>;
  error?: 'apply-in-progress' | 'locked' | 'invalid' | 'rebuild-failed' | 'document-changed' | 'rollback-failed';
  detail?: string;
  /**
   * The values ARE in the scene and the reset ran, but something after it was not as
   * expected (`bound-timeout`: the DES runner did not rebind in time). `ok` stays true so
   * the caller's state matches the scene; the caller reports the warning.
   */
  warning?: string;
}

/** The apply service of one viewer session. */
export interface ParamApplyService {
  /** Address-free admission of a value (`null` = an unset). */
  checkValue(component: string, field: string, value: ParamValue | null): FieldVerdict;
  /** The node at `k.address`, or null when it does not exist (yet). */
  resolve(k: FieldKey): Object3D | null;
  /** The field's current value as a base value; null = node missing. */
  readBase(k: FieldKey): BaseValue | null;
  /** Makes `ops` the effective state (§2.5). */
  apply(ops: readonly FieldOp[], opts: ApplyOptions): Promise<ApplyResult>;
  /** The bare hull, for callers with their own body. */
  runTransaction(body: (ctx: TransactionContext) => Promise<TransactionBodyResult>): Promise<TransactionResult>;
  isBusy(): boolean;
  whenIdle(): Promise<void>;
}

function fieldInfoFromSchema(component: string, field: string): ParamFieldInfo | null {
  const info = describeComponentType(baseComponentType(component), null);
  const f = info?.fields.find((x) => x.name === field);
  if (!f) return null;
  const out: ParamFieldInfo = { type: f.type };
  if (f.unit) out.unit = f.unit;
  if (f.enum) out.enum = f.enum;
  if (f.default !== undefined) out.default = f.default;
  if (f.readonly) out.readonly = true;
  if (f.signal) out.signal = f.signal;
  if (f.refType) out.refType = f.refType;
  if (f.deprecated) out.deprecated = true;
  return out;
}

/**
 * The viewer's admission environment: schema from the component registry; `des-extras`
 * only for a field the DES definition of exactly that component key re-reads.
 */
export const viewerParamFieldEnv: ParamFieldEnv = {
  fieldInfo: fieldInfoFromSchema,
  applyPathOf(component, field) {
    const mode = paramApplyOf(component);
    if (mode !== 'des-extras') return mode;
    const schema = getMaterialFlow(component)?.schema as Record<string, unknown> | undefined;
    return schema && Object.prototype.hasOwnProperty.call(schema, field) ? 'des-extras' : null;
  },
};

/** Construction of {@link createParamApplyService}. */
export interface ParamApplyHost extends TransactionHost {
  /** Admission environment (default {@link viewerParamFieldEnv}). */
  env?: ParamFieldEnv;
}

class ValidationError extends Error {
  constructor(message: string) { super(message); this.name = 'ValidationError'; }
}

const keyOf = (op: FieldKey): FieldKey => ({ address: op.address, component: op.component, field: op.field });

/** Builds the apply service of one viewer session. */
export function createParamApplyService(host: ParamApplyHost): ParamApplyService {
  const env = host.env ?? viewerParamFieldEnv;

  function resolve(k: FieldKey): Object3D | null {
    const reg = host.viewer.registry;
    if (!reg) return null;
    const { occurrence, nodeId } = parseNodeAddress(k.address);
    return reg.getNodeByAddress(nodeId, occurrence);
  }

  function readBase(k: FieldKey): BaseValue | null {
    const node = resolve(k);
    return node ? readBaseValue(node as unknown as { userData: Record<string, unknown> }, k.component, k.field) : null;
  }

  async function apply(ops: readonly FieldOp[], opts: ApplyOptions): Promise<ApplyResult> {
    const result: ApplyResult = { ok: false, written: [], unresolved: [], captured: [] };

    // ── 1. address-free admission, no write ───────────────────────────────
    const modes = new Map<string, ParamApplyPath>();
    for (const op of ops) {
      const id = fieldKeyId(op);
      if (modes.has(id)) return { ...result, error: 'invalid', detail: `${op.component}.${op.field} at '${op.address}' appears twice` };
      const v = checkFieldValue(env, op.component, op.field, op.op === 'set' ? op.value : null);
      if (!v.ok) return { ...result, error: 'invalid', detail: v.detail };
      modes.set(id, v.mode);
    }

    // ── 2. lease (lock is the hull's) ─────────────────────────────────────
    const lease = currentRunLease();
    if (lease && lease.holder !== opts.holder) return { ...result, error: 'locked', detail: `the run lease is held by '${lease.holder}'` };

    let failure: ApplyResult['error'] | null = null;
    let failureDetail: string | undefined;

    const tx = await runTransaction(host, async (ctx) => {
      const check = (): void => { if (!ctx.alive()) throw new DocumentChangedError(); };
      const structural = ops.filter((op) => modes.get(fieldKeyId(op)) === 'rebuild');
      const plain = ops.filter((op) => modes.get(fieldKeyId(op)) !== 'rebuild');

      // What was in effect before — the rollback target (full op set, by address).
      const previous = new Map<string, { key: FieldKey; base: BaseValue }>();
      for (const op of ops) {
        const base = readBase(op);
        if (base) previous.set(fieldKeyId(op), { key: keyOf(op), base });
      }
      const structuralPrev = structural.filter((op) => previous.has(fieldKeyId(op)));
      let rebuildStarted = false;

      const rebuild = async (list: readonly FieldOp[]): Promise<void> => {
        const byType = new Map<string, FieldOp[]>();
        for (const op of list) {
          const t = op.component;
          byType.set(t, [...(byType.get(t) ?? []), op]);
        }
        for (const [type, typed] of byType) {
          const handler = paramRebuildOf(type);
          if (!handler) throw new Error(`no rebuild handler registered for '${type}'`);
          await handler(typed, ctx);
          check();
        }
      };

      try {
        // 4a structural first
        if (structural.length > 0) { rebuildStarted = true; await rebuild(structural); }
        // 4b resolve the rest now; capture bases of nodes the rebuild created
        const resolved: Array<{ op: FieldOp; node: Object3D }> = [];
        for (const op of ops) {
          const node = resolve(op);
          if (!node) { result.unresolved.push(keyOf(op)); continue; }
          if (!previous.has(fieldKeyId(op))) {
            const base = readBaseValue(node as unknown as { userData: Record<string, unknown> }, op.component, op.field);
            previous.set(fieldKeyId(op), { key: keyOf(op), base });
            result.captured.push({ key: keyOf(op), base });
          }
          resolved.push({ op, node });
        }
        // 4c validators on the candidate (current component values + the new ones)
        const groups = new Map<string, { address: string; component: string; node: Object3D; ops: FieldOp[] }>();
        for (const r of resolved) {
          const g = `${r.op.address}|${r.op.component}`;
          const e = groups.get(g) ?? { address: r.op.address, component: r.op.component, node: r.node, ops: [] };
          e.ops.push(r.op);
          groups.set(g, e);
        }
        for (const g of groups.values()) {
          const validator = paramValidatorOf(g.component);
          if (!validator) continue;
          const rv = (g.node.userData as Record<string, unknown>).realvirtual as Record<string, unknown> | undefined;
          const current = rv?.[g.component];
          const candidate: Record<string, unknown> = current && typeof current === 'object' ? { ...(current as Record<string, unknown>) } : {};
          for (const op of g.ops) {
            if (op.field.includes('.')) continue; // validators see top-level fields
            if (op.op === 'set') candidate[op.field] = op.value; else delete candidate[op.field];
          }
          const errs = Object.entries(validator(candidate, g.address)).filter(([, m]) => !!m);
          if (errs.length > 0) throw new ValidationError(errs.map(([f, m]) => `${g.component}.${f}: ${m}`).join('; '));
        }
        // 4d the one writer, then one re-config
        let desChanged = false;
        for (const r of resolved) {
          if (writeFieldOp(r.node as unknown as { userData: Record<string, unknown> }, r.op)
            && modes.get(fieldKeyId(r.op)) === 'des-extras') desChanged = true;
          result.written.push(keyOf(r.op));
        }
        if (desChanged) host.viewer.simulationKernel?.desControl?.()?.reconfigureFromExtras?.();
        return { ok: true };
      } catch (err) {
        if (err instanceof DocumentChangedError || !ctx.alive()) throw new DocumentChangedError();
        // 4e — previous structure FIRST, then every previously effective value by address.
        failure = err instanceof ValidationError ? 'invalid' : 'rebuild-failed';
        failureDetail = err instanceof Error ? err.message : String(err);
        result.written = [];
        result.unresolved = [];
        try {
          if (rebuildStarted && structuralPrev.length > 0) {
            await rebuild(structuralPrev.map((op) => restoreOp(op, previous.get(fieldKeyId(op))!.base)));
          }
          let desChanged = false;
          for (const { key, base } of previous.values()) {
            const node = resolve(key);
            if (!node) continue;
            if (writeFieldOp(node as unknown as { userData: Record<string, unknown> }, restoreOp(key, base))
              && modes.get(fieldKeyId(key)) === 'des-extras') desChanged = true;
          }
          if (desChanged) host.viewer.simulationKernel?.desControl?.()?.reconfigureFromExtras?.();
          clearProblem(PROBLEM_PARAM_ROLLBACK);
        } catch (rollbackErr) {
          if (rollbackErr instanceof DocumentChangedError || !ctx.alive()) throw new DocumentChangedError();
          failure = 'rollback-failed';
          failureDetail = `${failureDetail}; restoring failed: ${rollbackErr instanceof Error ? rollbackErr.message : String(rollbackErr)}`;
          reportProblem({
            id: PROBLEM_PARAM_ROLLBACK, severity: 'error', code: PROBLEM_PARAM_ROLLBACK,
            title: 'Restoring the previous parameter values failed — reload the document',
            detail: failureDetail,
          });
        }
        return { ok: false, error: failure, detail: failureDetail };
      }
    });

    if (tx.ok) return { ...result, ok: true };
    if (tx.error === 'apply-in-progress') return { ...result, written: [], error: 'apply-in-progress' };
    if (tx.error === 'document-changed') return { ...result, written: [], error: 'document-changed' };
    // The body succeeded, the values are written and reset — the scene IS the target state.
    if (tx.error === 'bound-timeout' && !failure) return { ...result, ok: true, warning: tx.detail ?? 'bound-timeout' };
    if (failure) return { ...result, written: [], error: failure, detail: failureDetail };
    return { ...result, written: [], error: 'rebuild-failed', detail: tx.detail ?? tx.error };
  }

  return {
    checkValue: (component, field, value) => checkFieldValue(env, component, field, value),
    resolve,
    readBase,
    apply,
    runTransaction: (body) => runTransaction(host, body),
    isBusy: isParamApplyBusy,
    whenIdle: whenParamApplyIdle,
  };
}
