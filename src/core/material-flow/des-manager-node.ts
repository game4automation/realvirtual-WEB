// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * des-manager-node.ts — the DES clock settings as a SCENE COMPONENT (GLB-first).
 *
 * The simulation END time and the statistics-RESET (warmup) time are stored as a
 * `DESManager` component on a singleton `Simulation` node in the scene — the web
 * parallel to the Unity `DESManager` GameObject. This makes the settings part of
 * the scene's rv_extras: they round-trip through save / load, undo / redo and the
 * op log with NO side-channel. The DES runner READS them on start and applies
 * them to the live manager; the toolbar WRITES them through the op log (durable +
 * undoable) and creates the singleton node with its FIRST edit — DES-mode entry
 * only reads (plan-616 Teil 1).
 *
 * Time convention (JSON-safe — `Infinity` is not): `EndTime <= 0` means "infinite"
 * (run until the event queue empties); a positive value is the end in seconds.
 * `StatisticsResetTime <= 0` means "off" (no warmup discard).
 */

import type { Object3D } from 'three';
import { getSceneStore } from '../hmi/scene/scene-store-singleton';
import { persistFieldOp } from '../hmi/scene/scene-field-ops';
import { getActiveEditTarget } from '../hmi/rv-edit-target';
import { runLeaseBlocker } from '../hmi/rv-run-lease';
import { freshOpId } from '../hmi/scene/rv-scene-edits';
import type { RuntimeNodeSpec } from '../engine/rv-scene-loader';

import { DES_MANAGER_NODE, DES_MANAGER_COMPONENT, DES_END_TIME_FIELD, DES_STAT_RESET_FIELD, DES_MASTER_SEED_FIELD, findDesManager } from './des-manager-settings';
import type { DesManagerSettings } from './des-manager-settings';
import { DES_DEFAULT_END_TIME_S, DES_DEFAULT_MASTER_SEED, DES_CYCLE_TIME_FIELD, DES_DEFAULT_CYCLE_TIME, normalizeDesCycleTime } from './des-manager-settings';

export { DES_MANAGER_NODE, DES_MANAGER_COMPONENT, DES_END_TIME_FIELD, DES_STAT_RESET_FIELD, DES_MASTER_SEED_FIELD, findDesManager } from './des-manager-settings';
export type { DesManagerSettings } from './des-manager-settings';

/** Minimal viewer surface this helper needs (kept structural — no RVViewer import). */
export interface DesManagerViewerLike {
  readonly scene: Object3D;
  readonly registry: { getPathForNode(n: Object3D): string | null } | null;
}

/** Resolve a registered parent for the singleton node (a top-level scene node —
 *  the loaded model / layout root). The singleton lives under it so its path is
 *  stable across reloads. */
function resolveParentPath(viewer: DesManagerViewerLike): string | null {
  const reg = viewer.registry;
  if (!reg) return null;
  for (const child of viewer.scene.children) {
    const p = reg.getPathForNode(child);
    if (p != null) return p;
  }
  return null;
}

/** The settings of a scene without a DESManager node: one day end, no warmup,
 *  no seed override — exactly what a freshly created node holds. */
function liveDefault(): DesManagerSettings {
  return { path: DES_MANAGER_NODE, endTime: DES_DEFAULT_END_TIME_S, statResetTime: 0, masterSeed: 0, rawEndTime: DES_DEFAULT_END_TIME_S, rawStatReset: 0, rawMasterSeed: 0, cycleTime: DES_DEFAULT_CYCLE_TIME, rawCycleTime: DES_DEFAULT_CYCLE_TIME };
}

/**
 * Read the clock settings WITHOUT creating anything (plan-616 Teil 1).
 *
 * Entering the DES mode must not edit the document: an `addNode` op on mode
 * entry made every scene dirty without a user edit, and that dirty state is what
 * forked the editor's document on its next entry (LOP #196). The node is created
 * by the first toolbar EDIT instead ({@link ensureDesManagerNode}). Without a
 * node the answer is the live default, which equals a freshly created node.
 *
 * Note: the default's `path` is the bare `Simulation`, not the
 * `<parent>/Simulation` a created node gets — so it is no address to persist
 * against; a persister must go through {@link ensureDesManagerNode}.
 */
export function readDesManagerSettings(viewer: DesManagerViewerLike): DesManagerSettings {
  if (!viewer.scene) return liveDefault();
  return findDesManager(viewer.scene) ?? liveDefault();
}

/**
 * Ensure the singleton `Simulation` node with a `DESManager` component exists,
 * creating it via an addNode op when absent (so it persists with the scene). Used
 * by the toolbar's EDITS, right before their `setField` op (plan-616 Teil 1 — DES
 * mode entry only reads, see {@link readDesManagerSettings}). Both ops go through
 * the same document queue, which runs them in call order, so the `addNode` lands
 * before the `setField` without an await. Returns the current settings; when no
 * SceneStore / parent is available it still returns a live-only default
 * (one day, no warmup) so callers degrade gracefully.
 */
export function ensureDesManagerNode(viewer: DesManagerViewerLike): DesManagerSettings {
  // Defensive: no scene yet (pre-load / unit mocks) → live-only default, no crash.
  if (!viewer.scene) return liveDefault();

  const existing = findDesManager(viewer.scene);
  if (existing) return existing;

  const store = getSceneStore();
  const parentPath = resolveParentPath(viewer);
  const nodePath = (parentPath ? parentPath + '/' : '') + DES_MANAGER_NODE;
  if (store && parentPath != null) {
    const spec: RuntimeNodeSpec = {
      parentPath,
      name: DES_MANAGER_NODE,
      position: [0, 0, 0],
      quaternion: [0, 0, 0, 1],
      scale: [1, 1, 1],
      components: { [DES_MANAGER_COMPONENT]: { [DES_END_TIME_FIELD]: DES_DEFAULT_END_TIME_S, [DES_STAT_RESET_FIELD]: 0, [DES_MASTER_SEED_FIELD]: 0, [DES_CYCLE_TIME_FIELD]: DES_DEFAULT_CYCLE_TIME } },
    };
    // Verified, not fire-and-forget: a document that refuses ops (a load or a
    // replace in progress) drops the op silently, and the `setField` that
    // follows would then address a node that does not exist.
    const scene = viewer.scene;
    Promise.resolve(store.applyOp({ id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'addNode', nodePath, spec }))
      .then(() => {
        if (!findDesManager(scene)) {
          console.warn(`[des-manager-node] '${nodePath}' was not created — the scene refused the edit; the DES setting is live-only.`);
        }
      }, (e: unknown) => {
        console.warn(`[des-manager-node] creating '${nodePath}' failed:`, e);
      });
  }
  return { ...liveDefault(), path: nodePath };
}

/**
 * Persist the sim END time durably (setField op). `seconds` infinite/`<= 0` is
 * stored as `0` (the "infinite" sentinel). `prev` is the prior raw field value
 * so undo restores it. No-op without a SceneStore (the live manager is already
 * updated by the caller).
 */
export function persistDesEndTime(settings: DesManagerSettings, seconds: number): void {
  const raw = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  persistFieldOp(settings.path, DES_MANAGER_COMPONENT, DES_END_TIME_FIELD, raw, settings.rawEndTime);
}

/** Persist the statistics-reset (warmup) time durably (setField op). */
export function persistDesStatReset(settings: DesManagerSettings, seconds: number): void {
  const raw = Number.isFinite(seconds) && seconds > 0 ? seconds : 0;
  persistFieldOp(settings.path, DES_MANAGER_COMPONENT, DES_STAT_RESET_FIELD, raw, settings.rawStatReset);
}

/** Persist the master seed durably (setField op). `<= 0` stores the "not set"
 *  sentinel (0) — the DES manager keeps its code default (B5). */
export function persistDesMasterSeed(settings: DesManagerSettings, seed: number): void {
  const raw = Number.isFinite(seed) && seed > 0 ? Math.floor(seed) : 0;
  persistFieldOp(settings.path, DES_MANAGER_COMPONENT, DES_MASTER_SEED_FIELD, raw, settings.rawMasterSeed);
}

/** Why a seed edit is refused while a variant is in the scene: the seed is a Base (scene) setting. */
export const SEED_IN_VARIANT_REASON = 'The random seed is a Base setting — return to Base to change it';
/** Why a seed edit is refused while an experiment batch holds the run lease. */
export const SEED_DURING_BATCH_REASON = 'An experiment is running; the seed cannot change now';

/** Outcome of a DESManager setting write: `invalid` input, `refused` up front or by a change, `failed` write. */
export type DesManagerFieldResult = { ok: true } | { ok: false; code: 'invalid' | 'refused' | 'failed'; reason: string };
type DesManagerField = typeof DES_END_TIME_FIELD | typeof DES_STAT_RESET_FIELD | typeof DES_MASTER_SEED_FIELD | typeof DES_CYCLE_TIME_FIELD;
const RAW_OF: Record<DesManagerField, (s: DesManagerSettings) => number> = {
  [DES_CYCLE_TIME_FIELD]: s => s.rawCycleTime,
  [DES_END_TIME_FIELD]: s => s.rawEndTime,
  [DES_STAT_RESET_FIELD]: s => s.rawStatReset,
  [DES_MASTER_SEED_FIELD]: s => s.rawMasterSeed,
};
/**
 * The value a field EFFECTIVELY has — stored, or what an absent node / unset field means: end
 * 86400 s (`<= 0` → 0 = indefinite), warm-up 0, seed the code default 42. A write is checked
 * against this, so "already the effective value" is no write at all and an unset field that
 * means the requested value counts as stored.
 */
const EFFECTIVE: Record<DesManagerField, (s: DesManagerSettings | null) => number> = {
  [DES_CYCLE_TIME_FIELD]: s => s?.cycleTime ?? DES_DEFAULT_CYCLE_TIME,
  [DES_END_TIME_FIELD]: s => { const r = s ? s.rawEndTime : DES_DEFAULT_END_TIME_S; return r > 0 ? r : 0; },
  [DES_STAT_RESET_FIELD]: s => { const r = s ? s.rawStatReset : 0; return r > 0 ? r : 0; },
  [DES_MASTER_SEED_FIELD]: s => { const r = s ? s.rawMasterSeed : 0; return r > 0 ? r : DES_DEFAULT_MASTER_SEED; },
};

/** One field of a {@link applyDesManagerSettings} unit: the stored value and the live change. */
export interface DesManagerChange {
  field: DesManagerField; raw: number; live(): void;
  /** True when the running DES already has this value: with nothing to write, the live setter is skipped too. */
  liveMatches?(): boolean;
}

class Stop extends Error { constructor(readonly result: DesManagerFieldResult) { super(result.ok ? 'ok' : result.reason); } }

/** Settings operations run one after the other, page-wide: two never share a transaction or a read-back. */
let settingsQueue: Promise<unknown> = Promise.resolve();

/**
 * Write Base settings of the scene's DESManager (end time, warm-up, seed) as ONE unit, the safe way —
 * the des.setEnd / des.seed.set commands come through here, and the clock window through them.
 *
 * - Serialized: one settings operation at a time (comparison, writes, read-back, live apply).
 * - The context — edit target, its document, the viewer's model URL, scene, registry, simulation
 *   kernel and controller — is pinned when the CALL is made. Changed by the time the operation
 *   runs (a model swap while queued) → refused before anything is written.
 * - Refused up front with a variant in the scene (Base setting), during a batch (run lease) and
 *   while the document does not accept edits (load / replace).
 * - A field that already has the requested EFFECTIVE value is not written (the seed 42 of a scene
 *   that never stored one).
 * - No await between the last check and the writes: all writes of the unit are queued on the
 *   document in the same tick, inside one transaction, then read back. A context change while they
 *   ran ends the unit WITHOUT a rollback (inverses would go through the shared viewer into the
 *   replacement); a dropped write or a batch start in the same context rolls the unit back.
 * - Only after that the live changes, all of them. A failure means nothing changed live.
 *
 * Without a document (pre-boot) the values are live-only.
 */
export function applyDesManagerSettings(viewer: DesManagerViewerLike, control: unknown, changes: readonly DesManagerChange[],
  text: { subject: string; noun: string }): Promise<DesManagerFieldResult> {
  const pinned = contextOf(viewer);
  // Decided at CALL time, like the pin: a call made while the document loads (a write right after a
  // reset or a load, tutorial gap 13) targets the document that load brings - it waits for it instead
  // of being refused. A call made before a load started keeps refusing a document swapped under it.
  const deadline = Date.now() + DES_SETTINGS_LOAD_WAIT_MS;
  // Watched from the call on, not from the queue turn: the context is taken the moment the awaited
  // load ends, so a later load (same model or not) is a change, even while this call still queues.
  const watch = loading(pinned) ? settledAfterLoad(viewer, deadline) : null;
  const run = settingsQueue.then(async () => {
    const context = watch ? await afterLoad(viewer, pinned, await watch, deadline, text) : pinned;
    return 'ok' in context ? context : applyUnit(viewer, control, changes, text, context);
  });
  settingsQueue = run.catch(() => {});
  return run;
}

/** How long a settings write waits for a loading document before it gives up. */
export const DES_SETTINGS_LOAD_WAIT_MS = 30_000;
const LOAD_POLL_MS = 25;

function loading(context: DesContext): boolean {
  return (context.document as { acceptsOps?: boolean } | undefined)?.acceptsOps === false;
}

/**
 * Wait for the load that was running at call time: until the document accepts edits again and the
 * scene is complete (`whenSceneReady`), at most {@link DES_SETTINGS_LOAD_WAIT_MS}. Then pin the loaded
 * document - refused when it is another model, edit target or simulation controller than at call
 * time, or when a further load started after the awaited one (no write into a later replacement).
 */
/**
 * The context at the moment the awaited load ends. Taken synchronously from the document's change
 * notification where it has one (the SceneStore notifies when a load ends), so a further load that
 * starts right after cannot slip in before it; polled otherwise. Null when the deadline passes first.
 */
function settledAfterLoad(viewer: DesManagerViewerLike, deadline: number): Promise<DesContext | null> {
  return new Promise(resolve => {
    let done = false;
    let off: (() => void) | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const finish = (context: DesContext | null): void => {
      if (done) return;
      done = true;
      off?.();
      if (timer !== undefined) clearTimeout(timer);
      resolve(context);
    };
    const check = (): void => {
      const now = contextOf(viewer);
      if (!loading(now)) finish(now);
      else if (Date.now() >= deadline) finish(null);
      else timer = setTimeout(check, LOAD_POLL_MS);
    };
    const document = contextOf(viewer).document as { subscribe?(listener: () => void): () => void } | undefined;
    if (typeof document?.subscribe === 'function') {
      off = document.subscribe(() => { const now = contextOf(viewer); if (!loading(now)) finish(now); });
    }
    check();
  });
}

async function afterLoad(viewer: DesManagerViewerLike, pinned: DesContext, settled: DesContext | null, deadline: number,
  text: { noun: string }): Promise<DesContext | DesManagerFieldResult> {
  const stillLoading: DesManagerFieldResult = { ok: false, code: 'failed', reason: `The ${text.noun} was not saved: the scene is still loading; try again` };
  const changed: DesManagerFieldResult = { ok: false, code: 'refused', reason: `The document or the simulation changed while the ${text.noun} was saved; the live ${text.noun} was not changed` };
  // The awaited load has ended (`settled` = the context at that moment): from then on, nothing may
  // change but the scene filling up.
  if (!settled) return stillLoading;
  const ready = (viewer as { whenSceneReady?: () => Promise<void> }).whenSceneReady;
  if (typeof ready === 'function') {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const outcome = await Promise.race([
      ready.call(viewer).then(() => 'ready' as const),
      new Promise<'timeout'>(r => { timer = setTimeout(() => r('timeout'), Math.max(0, deadline - Date.now())); }),
    ]);
    if (timer !== undefined) clearTimeout(timer);
    if (outcome === 'timeout') return stillLoading;
  }
  const now = contextOf(viewer);
  if (loading(now) || !sameContext(settled, now)) return changed;
  if (now.target !== pinned.target || now.url !== pinned.url || now.control !== pinned.control) return changed;
  return now;
}

type DesContext = { target: ReturnType<typeof getActiveEditTarget>; document: unknown; url: unknown; load: unknown; scene: unknown; registry: unknown; kernel: unknown; control: unknown };
function contextOf(viewer: DesManagerViewerLike): DesContext {
  const target = getActiveEditTarget();
  const v = viewer as DesManagerViewerLike & { currentModelUrl?: unknown; loadGeneration?: unknown; simulationKernel?: { desControl?(): unknown } | null };
  const kernel = v.simulationKernel ?? null;
  return { target, document: target.documentKey, url: v.currentModelUrl, load: v.loadGeneration, scene: v.scene, registry: v.registry, kernel, control: kernel?.desControl?.() ?? null };
}
function sameContext(a: DesContext, b: DesContext): boolean {
  return a.target === b.target && a.document === b.document && a.url === b.url && a.load === b.load && a.scene === b.scene
    && a.registry === b.registry && a.kernel === b.kernel && a.control === b.control;
}

async function applyUnit(viewer: DesManagerViewerLike, control: unknown, changes: readonly DesManagerChange[],
  text: { subject: string; noun: string }, pinned: DesContext): Promise<DesManagerFieldResult> {
  const { target } = pinned;
  const changed: DesManagerFieldResult = { ok: false, code: 'refused', reason: `The document or the simulation changed while the ${text.noun} was saved; the live ${text.noun} was not changed` };
  const duringBatch: DesManagerFieldResult = { ok: false, code: 'refused', reason: `An experiment is running; the ${text.noun} cannot change now` };
  if (target.persistsTo === 'variant') return { ok: false, code: 'refused', reason: `${text.subject} is a Base setting — return to Base to change it` };
  const contextHolds = (): boolean => sameContext(pinned, contextOf(viewer)) && (pinned.kernel === null || pinned.control === control);
  if (runLeaseBlocker()) return duringBatch;
  if (!contextHolds()) return changed;
  const written = new Set<DesManagerChange>();
  if (target.available) {
    const current = viewer.scene ? findDesManager(viewer.scene) : null;
    const writes = changes.filter(c => EFFECTIVE[c.field](current) !== c.raw);
    for (const c of writes) written.add(c);
    if (writes.length > 0) {
      if ((pinned.document as { acceptsOps?: boolean } | undefined)?.acceptsOps === false) {
        return { ok: false, code: 'failed', reason: `The ${text.noun} was not saved: the scene does not accept edits right now (it is loading); try again` };
      }
      const settings = ensureDesManagerNode(viewer);
      for (const c of writes) {
        const pre = target.trySetField?.(settings.path, DES_MANAGER_COMPONENT, c.field, c.raw);
        if (pre && !pre.ok) return { ok: false, code: 'refused', reason: pre.reason };
      }
      try {
        const state: { outcome: 'ok' | 'changed' } = { outcome: 'ok' };
        await target.withTransaction(`DES ${text.noun}`, async () => {
          // Same tick as the checks above: every write of the unit is queued now, none later.
          await Promise.all(writes.map(c => {
            const prev = RAW_OF[c.field](settings);
            return target.setFieldAsync ? target.setFieldAsync(settings.path, DES_MANAGER_COMPONENT, c.field, c.raw, prev)
              : target.setField(settings.path, DES_MANAGER_COMPONENT, c.field, c.raw, prev);
          }));
          // Another model now: keep what went into the old document, never roll back into the new one.
          if (!contextHolds()) { state.outcome = 'changed'; return; }
          if (runLeaseBlocker()) throw new Stop(duringBatch);
          const stored = viewer.scene ? findDesManager(viewer.scene) : null;
          if (!stored || writes.some(c => EFFECTIVE[c.field](stored) !== c.raw)) {
            throw new Stop({ ok: false, code: 'failed', reason: `The ${text.noun} was not saved: the scene did not accept the edit (it may be loading); try again` });
          }
        });
        if (state.outcome === 'changed') return changed;
      } catch (e) {
        if (e instanceof Stop) return e.result;
        return { ok: false, code: 'failed', reason: `The ${text.noun} was not saved: ${e instanceof Error ? e.message : String(e)}` };
      }
    }
  }
  // Never touch a batch or another document's run.
  if (runLeaseBlocker()) return duringBatch;
  if (!contextHolds()) return changed;
  // A field neither written nor different live is a no-op: re-setting it would re-arm the DES (a
  // warm-up re-set after its time resets the statistics again).
  for (const c of changes) if (written.has(c) || !c.liveMatches?.()) c.live();
  return { ok: true };
}

/** One DESManager field through {@link applyDesManagerSettings}. */
export function applyDesManagerField(viewer: DesManagerViewerLike, control: unknown, field: DesManagerField, raw: number,
  applyLive: () => void, text: { subject: string; noun: string }, liveMatches?: () => boolean): Promise<DesManagerFieldResult> {
  return applyDesManagerSettings(viewer, control, [{ field, raw, live: applyLive, liveMatches }], text);
}

/**
 * Set the master seed — the seed field of the clock window and `des.seed.set` (plan-2208b B3),
 * through {@link applyDesManagerSettings}.
 */
export async function applyDesMasterSeed(viewer: DesManagerViewerLike, control: { setMasterSeed?(seed: number): void; readonly masterSeed?: number } | null | undefined, seed: number): Promise<DesManagerFieldResult> {
  const value = Math.floor(seed);
  if (!Number.isFinite(value) || value <= 0) return { ok: false, code: 'invalid', reason: 'The seed must be a positive integer' };
  return applyDesManagerField(viewer, control, DES_MASTER_SEED_FIELD, value, () => control?.setMasterSeed?.(value), { subject: 'The random seed', noun: 'seed' }, () => control?.masterSeed === value);
}

/** The stored end: `<= 0` / infinite is 0 (= indefinite). */
function endRaw(seconds: number): number { return Number.isFinite(seconds) && seconds > 0 ? seconds : 0; }

/**
 * Set the simulation end and / or the statistics reset (warm-up) as ONE unit — the clock window and
 * `des.setEnd`. An end `<= 0` or infinite is stored as 0 and applied live as `Infinity`, so the run
 * now and after a reload agree; a warm-up `<= 0` is off.
 */
export function applyDesClockSettings(viewer: DesManagerViewerLike,
  control: { setEndTime?(seconds: number): void; setStatResetTime?(seconds: number): void; readonly endTime?: number; readonly statResetTime?: number } | null | undefined,
  values: { end?: number; statReset?: number }): Promise<DesManagerFieldResult> {
  const { end, statReset } = values;
  if (end !== undefined && Number.isNaN(end)) return Promise.resolve({ ok: false, code: 'invalid', reason: 'The end time must be a number of seconds' });
  if (statReset !== undefined && Number.isNaN(statReset)) return Promise.resolve({ ok: false, code: 'invalid', reason: 'The warm-up must be a number of seconds' });
  const changes: DesManagerChange[] = [];
  if (end !== undefined) {
    const raw = endRaw(end);
    changes.push({ field: DES_END_TIME_FIELD, raw, live: () => control?.setEndTime?.(raw > 0 ? raw : Infinity), liveMatches: () => control?.endTime === (raw > 0 ? raw : Infinity) });
  }
  if (statReset !== undefined) {
    const raw = endRaw(statReset);
    changes.push({ field: DES_STAT_RESET_FIELD, raw, live: () => control?.setStatResetTime?.(raw), liveMatches: () => control?.statResetTime === raw });
  }
  const text = end !== undefined && statReset !== undefined ? { subject: 'The simulation end and warm-up', noun: 'end time and warm-up' }
    : end !== undefined ? { subject: 'The simulation end', noun: 'end time' } : { subject: 'The statistics reset (warm-up)', noun: 'warm-up' };
  return applyDesManagerSettings(viewer, control, changes, text);
}

/** Set the simulation end — see {@link applyDesClockSettings}. */
export function applyDesEndTime(viewer: DesManagerViewerLike, control: { setEndTime?(seconds: number): void } | null | undefined, seconds: number): Promise<DesManagerFieldResult> {
  return applyDesClockSettings(viewer, control, { end: seconds });
}

/** Set the statistics reset (warm-up) — see {@link applyDesClockSettings}. */
export function applyDesStatReset(viewer: DesManagerViewerLike, control: { setStatResetTime?(seconds: number): void } | null | undefined, seconds: number): Promise<DesManagerFieldResult> {
  return applyDesClockSettings(viewer, control, { statReset: seconds });
}

/** Persist the model's motion step before applying it to the active executor. */
export function applyDesCycleTime(viewer: DesManagerViewerLike,
  control: { setCycleTime?(seconds: number): void; readonly cycleTime?: number } | null | undefined,
  seconds: number): Promise<DesManagerFieldResult> {
  const value = normalizeDesCycleTime(seconds);
  return applyDesManagerField(viewer, control, DES_CYCLE_TIME_FIELD, value,
    () => control?.setCycleTime?.(value), { subject: 'The cycle time', noun: 'cycle time' },
    () => control?.cycleTime === value);
}
