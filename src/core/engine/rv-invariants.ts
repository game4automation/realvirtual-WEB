// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The DEV-only invariant layer (plan-600 F8-F12): five statements the viewer
 * must never contradict, checked at named checkpoints and reported as
 * `console.error` WITH ITS CAUSE — never thrown, never written to the Problems
 * panel, never switchable on in production.
 *
 * | Id | Invariant |
 * |----|-----------|
 * | I1 | No NaN / Infinity in `position` / `quaternion` / `scale` of a registered node |
 * | I2 | Node-count drift across a RETURN into the same UI state is 0 |
 * | I3 | No listener without a living consumer, per signal name |
 * | I4 | No Problems entry with `severity === 'error'` |
 * | I5 | No renderer resource drift across a return cycle |
 *
 * **Synchronous vs. deferred — this is contract, not an implementation
 * choice (plan 2.6).** `checkInvariants` is synchronous, but I3 and I5 need a
 * frame that was ACTUALLY rendered afterwards. So:
 *
 * - **I1, I2, I4 measure synchronously** in the checkpoint and are done. Their
 *   violations are what `checkInvariants` RETURNS.
 * - **I3 and I5 are deferred**: a checkpoint files exactly ONE reservation,
 *   executed at the next actually rendered frame ({@link invariantsOnRenderedFrame}).
 *   "Actually rendered" matters because the viewer can skip a frame while
 *   shaders compile. Their violations appear ONLY as `console.error` — the
 *   return value never lies about completeness.
 * - **Invalidation:** a reservation is DISCARDED when `model-loaded`,
 *   `model-cleared` or a further mode switch arrives before its frame. A
 *   comparison against a state that is no longer the same state is a false
 *   alarm, not a finding. There is never more than one open reservation.
 *
 * **The baseline for I3/I5 is LOAD-BOUND, not `model-loaded`** (plan 2.6,
 * finding R3-1). `model-loaded` fires BEFORE `placements.sealLoad()` and before
 * `whenLoadingIdle()`, and `rv-viewer.ts:634-638` says in so many words that
 * the references of a layout document arrive seconds later. Taking the baseline
 * one frame after `model-loaded` would count those later materialisations as a
 * leak on the next return cycle — the exact false alarm F9 forbids. The marker
 * is therefore `placements-materialized` ({@link armInvariantBaseline}) plus one
 * rendered frame. `currentModelUrl` (50-68 frames early) and a `whenSceneReady()`
 * called BEFORE the load began (resolves at frame 0) are both forbidden markers.
 *
 * I3 and I5 compare **the same named UI state before and after a completed
 * cycle**, never a number against an earlier number taken at a different UI
 * state — that is what makes a legitimately mounted extra consumer harmless.
 */

import type { Object3D } from 'three';
import { getProblems } from '../hmi/problems-store';
import { noteInvariantReport } from './rv-invariant-report-count';

/** The checkpoints the layer is wired to, plus the explicit call. */
export type InvariantReason = 'model-loaded' | 'mode-changing' | 'mode-changed' | 'explicit';

/** True only in a development build. The ONLY switch — there is no override. */
export function invariantsEnabled(): boolean {
  return import.meta.env.DEV === true;
}

/** Everything the layer reads. All optional — a test may hand in a stub. */
export interface InvariantSource {
  modes?: { activeMode?: string | null } | null;
  registry?: {
    size?: { nodes?: number } | null;
    /** The registry's own public iteration API — no new accessor needed. */
    forEachNode?(cb: (path: string, node: Object3D) => void): void;
  } | null;
  signalStore?: { listenerCounts?(): Map<string, number> } | null;
  renderer?: { info?: { memory?: { geometries?: number; textures?: number }; programs?: { length: number } | null } | null } | null;
  leftPanelManager?: { getActive?(side: 'left' | 'right'): string | null } | null;
  on?(event: string, handler: (payload?: unknown) => void): unknown;
}

/** A filed, not-yet-executed deferred comparison. Never more than one. */
type Reservation =
  | { kind: 'baseline' }
  | { kind: 'compare'; uiKey: string };

interface Baseline {
  /** Signal name -> listener count at the baseline point. */
  listeners: Map<string, number>;
  geometries: number;
  textures: number;
  /** Observation only — never a violation (plan 2.6 I5). */
  programs: number;
  /** The named UI state the baseline belongs to. */
  uiKey: string;
}

interface State {
  baseline: Baseline | null;
  reservation: Reservation | null;
  /**
   * I2: node count per named UI state, recorded on ENTERING it. A return into
   * the same state must find the same number — see {@link checkNodeCountDrift}.
   */
  nodeCountByUiKey: Map<string, number>;
}

const STATES = new WeakMap<object, State>();
/** Viewers with an open reservation — drained by {@link invariantsOnRenderedFrame}. */
let pendingViewers: InvariantSource[] = [];

function stateOf(viewer: InvariantSource): State {
  let s = STATES.get(viewer as object);
  if (!s) {
    s = { baseline: null, reservation: null, nodeCountByUiKey: new Map() };
    STATES.set(viewer as object, s);
  }
  return s;
}

/** The named UI state I3/I5 compare within: active mode plus the open panels. */
function uiKeyOf(viewer: InvariantSource): string {
  const mode = viewer.modes?.activeMode ?? 'none';
  const left = viewer.leftPanelManager?.getActive?.('left') ?? '-';
  const right = viewer.leftPanelManager?.getActive?.('right') ?? '-';
  return `${mode}|${left}|${right}`;
}

/** True for a UI key sampled before any mode was active. */
function isModeless(uiKey: string): boolean {
  return uiKey.startsWith('none|');
}

function report(message: string): void {
  console.error(`[rv-invariants] ${message}`);
  noteInvariantReport();
}

// ─── Report counter (plan-615 F5: the dev toolbar's status line) ─────────────
// Lives in rv-invariant-report-count.ts so the dev toolbar can read it without
// importing this layer — only the viewer may reference this module, behind DEV.
export { getInvariantReportCount, subscribeInvariantReports } from './rv-invariant-report-count';

// ─── I1 — no NaN / Infinity in a registered node's transform ────────────────

const TRIPLE = ['x', 'y', 'z'] as const;
const QUAD = ['x', 'y', 'z', 'w'] as const;

/** Returns the violation messages for I1, naming the PATH and the field. */
export function checkNoNonFiniteTransforms(viewer: InvariantSource, limit = 20): string[] {
  const registry = viewer.registry;
  if (typeof registry?.forEachNode !== 'function') return [];
  const out: string[] = [];
  let truncated = false;
  registry.forEachNode((path, node) => {
    if (!node || out.length >= limit) { truncated ||= out.length >= limit; return; }
    for (const axis of TRIPLE) {
      if (!Number.isFinite(node.position?.[axis])) out.push(`I1 ${path}: position.${axis} is ${node.position?.[axis]}`);
      if (!Number.isFinite(node.scale?.[axis])) out.push(`I1 ${path}: scale.${axis} is ${node.scale?.[axis]}`);
    }
    for (const axis of QUAD) {
      if (!Number.isFinite(node.quaternion?.[axis])) out.push(`I1 ${path}: quaternion.${axis} is ${node.quaternion?.[axis]}`);
    }
  });
  if (truncated) out.push(`I1 … stopped after ${limit} findings`);
  return out;
}

// ─── I4 — no Problems entry with severity 'error' ───────────────────────────

/**
 * Returns the violation messages for I4. Filters on the `severity` field the
 * store maintains itself (`problems-store.ts:42`, `:48`) — NOT on a curated
 * list of codes. `warning` and `info` are information, not defects, and two
 * codes an earlier plan draft listed as errors (`placement-cap`,
 * `override-orphaned`) are in fact warnings.
 */
export function checkNoErrorProblems(): string[] {
  return getProblems()
    .filter((p) => p.severity === 'error')
    .map((p) => `I4 ${p.code}: ${p.title}`);
}

// ─── I2 — node-count drift across a completed mode switch ───────────────────

/**
 * I2, measured over a RETURN CYCLE rather than over a single switch.
 *
 * **This differs from the plan's literal wording (`mode-changing` against
 * `mode-changed`) because that wording was MEASURED to be a false positive**
 * (plan-600 phase 4, `e2e/invariants-layout-reference.spec.ts`). On the pilot
 * document the counts are:
 *
 * | point | nodes |
 * |-------|-------|
 * | `hmi` | 315 |
 * | `mode-changed` into `commissioning` | 315 |
 * | one frame later, in `commissioning` | 317 |
 * | `mode-changing` out of `commissioning` | 317 |
 * | `mode-changed` back into `hmi` | **315** |
 *
 * So `commissioning` creates its own nodes lazily AFTER the switch and tears
 * them down correctly when it is left: a single switch legitimately reads
 * `317 -> 315`, and the literal comparison would report that healthy teardown
 * as drift. F9 forbids exactly that, and F9 is a HIGH requirement ranked equal
 * to the triggering tests.
 *
 * The invariant's stated purpose — "a mode that does not clean up when it is
 * left leaves trees behind" — is a statement about a RETURN, so that is what
 * is measured, in the same comparison geometry I5 uses: the count on entering
 * a named UI state must equal the count the last time that same state was
 * entered. It stays SYNCHRONOUS (the plan's split of I1/I2/I4 against I3/I5 is
 * untouched) and it stays exact — no tolerance band. A mode that really leaks
 * is still caught: returning to `hmi` would then read 315 -> 318.
 *
 * The first entry into a state records and does not compare — without a
 * reference nothing is checked, rather than compared against zero.
 */
function checkNodeCountDrift(viewer: InvariantSource, state: State): string[] {
  const after = viewer.registry?.size?.nodes ?? null;
  if (after === null) return [];
  const key = uiKeyOf(viewer);
  const before = state.nodeCountByUiKey.get(key);
  state.nodeCountByUiKey.set(key, after);
  if (before === undefined || before === after) return [];
  return [`I2 nodeCount: ${before} -> ${after} (returning to ${key})`];
}

// ─── I3 / I5 — the deferred pair ────────────────────────────────────────────

function sampleBaseline(viewer: InvariantSource): Baseline {
  const mem = viewer.renderer?.info?.memory;
  return {
    listeners: viewer.signalStore?.listenerCounts?.() ?? new Map<string, number>(),
    geometries: mem?.geometries ?? -1,
    textures: mem?.textures ?? -1,
    programs: viewer.renderer?.info?.programs?.length ?? -1,
    uiKey: uiKeyOf(viewer),
  };
}

/**
 * Compares the deferred pair against the baseline. Only names whose count is
 * HIGHER than at the baseline are violations; equality and a drop are fine.
 */
function compareDeferred(viewer: InvariantSource, base: Baseline): string[] {
  const out: string[] = [];

  // I3 — per signal name, over the `listeners` map.
  const now = viewer.signalStore?.listenerCounts?.() ?? new Map<string, number>();
  for (const [name, count] of now) {
    const was = base.listeners.get(name) ?? 0;
    if (count > was) out.push(`I3 ${name}: ${was} -> ${count}`);
  }

  // I5 — equality, no tolerance band. `programs` is observation only.
  const mem = viewer.renderer?.info?.memory;
  const geometries = mem?.geometries ?? -1;
  const textures = mem?.textures ?? -1;
  if (geometries !== base.geometries) out.push(`I5 geometries: ${base.geometries} -> ${geometries}`);
  if (textures !== base.textures) out.push(`I5 textures: ${base.textures} -> ${textures}`);

  return out;
}

/** Files `res` as THE one reservation of `viewer`, replacing any earlier one. */
function file(viewer: InvariantSource, state: State, res: Reservation | null): void {
  state.reservation = res;
  const i = pendingViewers.indexOf(viewer);
  if (res === null) {
    if (i >= 0) pendingViewers.splice(i, 1);
  } else if (i < 0) {
    pendingViewers.push(viewer);
  }
}

/**
 * Arms the I3 / I5 baseline at the LOAD-BOUND completion — wire this to
 * `placements-materialized`, never to `model-loaded` (see the module header).
 * The sample itself is taken one actually rendered frame later.
 */
export function armInvariantBaseline(viewer: InvariantSource): void {
  const state = stateOf(viewer);
  state.baseline = null;
  file(viewer, state, { kind: 'baseline' });
}

/** Drops baseline and reservation — a new or cleared model starts over. */
export function resetInvariants(viewer: InvariantSource): void {
  const state = stateOf(viewer);
  state.baseline = null;
  state.nodeCountByUiKey.clear();
  file(viewer, state, null);
}

/**
 * Checks the invariants at a checkpoint.
 *
 * Returns the SYNCHRONOUSLY found violations (I1, I2, I4). I3 and I5 are
 * deferred by contract and surface only as `console.error` at the next rendered
 * frame — a caller that wants to await them uses the helper in `e2e/_clock.ts`.
 * Every returned violation is also reported to the console.
 */
export function checkInvariants(viewer: InvariantSource, reason: InvariantReason): string[] {
  const state = stateOf(viewer);

  switch (reason) {
    case 'model-loaded':
      // A new model brings legitimately different numbers, and any reservation
      // filed before it would now compare against a different scene.
      resetInvariants(viewer);
      break;
    case 'mode-changing':
      // A further mode switch invalidates a still-open reservation.
      if (state.reservation?.kind === 'compare') file(viewer, state, null);
      break;
    case 'mode-changed':
      if (state.reservation?.kind === 'baseline') {
        // The load-bound baseline is still waiting for its frame. Replacing it
        // with a comparison would leave the model without any baseline for good;
        // the sample takes `uiKeyOf` at its own frame, i.e. WITH the new mode.
        break;
      }
      if (state.baseline && isModeless(state.baseline.uiKey)) {
        // Boot: `placements-materialized` fires before main.ts sets the first
        // mode, so the baseline was sampled at `none|-|-` and no later comparison
        // could ever match its UI state. The first mode entry IS the initial UI
        // state — re-take the baseline there instead of comparing against it.
        file(viewer, state, { kind: 'baseline' });
        break;
      }
      // One reservation, filed for THIS UI state.
      file(viewer, state, { kind: 'compare', uiKey: uiKeyOf(viewer) });
      break;
    case 'explicit':
      break;
  }

  const violations = [
    ...checkNoNonFiniteTransforms(viewer),
    ...(reason === 'mode-changed' ? checkNodeCountDrift(viewer, state) : []),
    ...checkNoErrorProblems(),
  ];
  for (const v of violations) report(`${v} (at ${reason})`);
  return violations;
}

/**
 * Executes at most one filed reservation per viewer. Call this at the END of a
 * frame that was ACTUALLY rendered.
 *
 * This is not a checking frame hook: it does no measuring of its own unless a
 * checkpoint filed a reservation, which the lifecycle contract in plan 2.6
 * requires. With nothing filed it is one array-length test and allocates
 * nothing.
 */
export function invariantsOnRenderedFrame(): void {
  if (pendingViewers.length === 0) return;
  const due = pendingViewers;
  pendingViewers = [];
  for (const viewer of due) {
    const state = STATES.get(viewer as object);
    const res = state?.reservation ?? null;
    if (!state || !res) continue;
    state.reservation = null;
    if (res.kind === 'baseline') {
      state.baseline = sampleBaseline(viewer);
      continue;
    }
    // A comparison needs a baseline AND the same named UI state. Without
    // either, nothing is checked — rather than compared against zero.
    const base = state.baseline;
    if (!base) continue;
    if (base.uiKey !== uiKeyOf(viewer)) continue;
    for (const v of compareDeferred(viewer, base)) report(`${v} (deferred, at ${base.uiKey})`);
  }
}

/** Test seam: the open reservation of a viewer, or null. */
export function pendingInvariantReservation(viewer: InvariantSource): 'baseline' | 'compare' | null {
  return STATES.get(viewer as object)?.reservation?.kind ?? null;
}

/** Test seam: how many viewers have an open reservation (never > 1 each). */
export function pendingInvariantViewerCount(): number {
  return pendingViewers.length;
}

/** Test seam: whether a baseline has been sampled for this viewer. */
export function hasInvariantBaseline(viewer: InvariantSource): boolean {
  return STATES.get(viewer as object)?.baseline != null;
}

/**
 * Wires the layer to its FOUR events — `model-loaded`, `mode-changing`,
 * `mode-changed` and `model-cleared` — plus `placements-materialized` for the
 * load-bound baseline. No-op outside a development build; returns whether it
 * wired anything.
 */
export function installInvariants(viewer: InvariantSource): boolean {
  if (!invariantsEnabled()) return false;
  if (typeof viewer.on !== 'function') return false;
  viewer.on('model-loaded', () => { checkInvariants(viewer, 'model-loaded'); });
  viewer.on('model-cleared', () => { resetInvariants(viewer); });
  viewer.on('mode-changing', () => { checkInvariants(viewer, 'mode-changing'); });
  viewer.on('mode-changed', () => { checkInvariants(viewer, 'mode-changed'); });
  viewer.on('placements-materialized', () => { armInvariantBaseline(viewer); });
  return true;
}
