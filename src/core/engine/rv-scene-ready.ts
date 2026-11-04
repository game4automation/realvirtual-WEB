// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-ready.ts — the ONE join point "the scene is complete" (plan-753
 * structure hardening, part 2).
 *
 * `model-loaded` means: the document's own GLB is parsed, registered and
 * announced to the plugins. It does NOT mean the scene is complete — the
 * placed references of a layout document are materialised asynchronously
 * AFTER it (`viewer.placements`, one bake per asset), which takes seconds on a
 * real layout. Until then they are missing from the scene graph, the
 * NodeRegistry, the SignalStore, snap pairing, bounds and transport topology.
 *
 * The contract, three names:
 *   - `viewer.placements.state` — `'idle' | 'materializing'`;
 *   - the viewer event `placements-materialized` — exactly once per load, also
 *     with zero references, `{ aborted: true }` when the document changed first;
 *   - `viewer.whenSceneReady()` — no load in flight AND placements idle.
 *
 * Everything that needs the WHOLE scene joins here instead of growing its own
 * `await` chain. Consumers that follow `layout-content-added` incrementally
 * (clip tools, AAS resolution, the planner's snap pairing, the transport
 * topology) are correct without it.
 */

import { Vector3 } from 'three';
import type { PlacementsProgress, PlacementsSettledInfo } from './rv-placement-instancer';

/** Counts loads in flight; `whenIdle()` resolves when none is. */
export class SceneLoadGate {
  private _inFlight = 0;
  private _failed = 0;
  private _waiters: Array<() => void> = [];

  get loading(): boolean { return this._inFlight > 0; }

  /**
   * Tracked loads that rejected (failed or superseded), monotonic. A consumer
   * that waited for the scene compares it before and after to tell a completed
   * load from one that ended in an error (plan-633 path-topology check).
   */
  get failedLoads(): number { return this._failed; }

  /** Track one load (`loadModel` / `loadScene`). Returns `p` unchanged. */
  track<T>(p: Promise<T>): Promise<T> {
    this._inFlight++;
    const done = (): void => {
      if (--this._inFlight > 0 || this._waiters.length === 0) return;
      const waiters = this._waiters;
      this._waiters = [];
      for (const w of waiters) w();
    };
    p.then(done, () => { this._failed++; done(); });
    return p;
  }

  whenIdle(): Promise<void> {
    if (this._inFlight === 0) return Promise.resolve();
    return new Promise<void>((resolve) => { this._waiters.push(resolve); });
  }
}

/** What {@link whenSceneReady} needs of the viewer. */
export interface SceneReadyHost {
  readonly sceneLoadGate: SceneLoadGate;
  readonly placements: { readonly state: 'idle' | 'materializing'; whenMaterialized(): Promise<void> };
}

/**
 * Resolves when no load is in flight AND every deferred placement of the
 * document on screen is materialised. A document change while waiting is
 * followed: the promise then resolves for the NEW document. Never rejects —
 * a failed load leaves "nothing in flight", which is ready.
 */
export async function whenSceneReady(host: SceneReadyHost): Promise<void> {
  // Bounded only by what the user does: each pass waits for a real transition.
  while (host.sceneLoadGate.loading || host.placements.state === 'materializing') {
    await host.sceneLoadGate.whenIdle();
    await host.placements.whenMaterialized();
  }
}

/** Outcome of {@link awaitSceneReady}. */
export interface SceneReadyReport {
  /** False when the budget ran out first — the scene is still filling up. */
  ready: boolean;
  placements: Pick<PlacementsProgress, 'total' | 'materialized' | 'pending' | 'missing'>;
  /** Present exactly when `ready` is false. */
  hint?: string;
}

/**
 * {@link whenSceneReady} with a time budget — for callers behind a transport
 * timeout (the MCP open verbs): answer "still filling" instead of hanging.
 */
export async function awaitSceneReady(
  host: SceneReadyHost & { readonly placements: SceneReadyHost['placements'] & { readonly progress: PlacementsProgress } },
  budgetMs: number,
): Promise<SceneReadyReport> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const ready = await Promise.race([
    whenSceneReady(host).then(() => true),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), Math.max(0, budgetMs)); }),
  ]);
  if (timer !== undefined) clearTimeout(timer);
  const { total, materialized, pending, missing } = host.placements.progress;
  const report: SceneReadyReport = { ready: ready && pending === 0, placements: { total, materialized, pending, missing } };
  if (!report.ready) {
    report.hint = `${pending} of ${total} placed references are still materializing — nodes, signals and `
      + 'web_query("layout.list", {}) are incomplete until then. Re-read web_status (placements.pending) before relying on them.';
  }
  return report;
}

// ─── Camera refit ───────────────────────────────────────────────────────

/** What {@link installPlacementsRefit} needs of the viewer. */
export interface PlacementsRefitHost {
  readonly camera: { readonly position: Vector3 };
  readonly controls: { readonly target: Vector3 };
  on(event: string, cb: (data: unknown) => void): () => void;
  getPlugin?(id: string): unknown;
  frameSceneContent(animate?: boolean): void;
}

const POSE_EPS_SQ = 1e-10;

/**
 * Frame the COMPLETE layout once its placements arrived. The load's own fit
 * (`loadModel` inline, `loadScene` → `frameSceneContent`) only saw what was in
 * the graph at that time — for a layout document an empty root. Re-fits
 * exactly when nobody moved the camera since that framing: no user input, no
 * camera preset, no FPV. Allocation-free after install.
 */
export function installPlacementsRefit(viewer: PlacementsRefitHost): () => void {
  const pos = new Vector3();
  const target = new Vector3();
  let armed = false;
  const snapshot = (): void => {
    pos.copy(viewer.camera.position);
    target.copy(viewer.controls.target);
    armed = true;
  };
  const offs = [
    viewer.on('model-loaded', snapshot),
    viewer.on('scene-loaded', snapshot),
    viewer.on('placements-materialized', (data) => {
      const info = data as PlacementsSettledInfo;
      if (!armed || info.aborted || info.materialized === 0) return;
      armed = false;
      if (viewer.camera.position.distanceToSquared(pos) > POSE_EPS_SQ) return;
      if (viewer.controls.target.distanceToSquared(target) > POSE_EPS_SQ) return;
      const camStart = viewer.getPlugin?.('camera-startpos') as { resolvePreset?: (v: unknown) => unknown } | undefined;
      if (camStart?.resolvePreset?.(viewer)) return;
      if ((viewer.getPlugin?.('fpv') as { isActive?: boolean } | undefined)?.isActive === true) return;
      viewer.frameSceneContent();
    }),
  ];
  return () => { for (const off of offs) off(); };
}

// ─── Simulation hold ────────────────────────────────────────────────────

/** Pause reason held while placements materialise (Sim toolbar tooltip: "paused by: …"). */
export const PLACEMENTS_PAUSE_REASON = 'placements-materializing';

/** What {@link installPlacementsSimHold} needs of the viewer. */
export interface PlacementsSimHoldHost {
  readonly placements: { readonly progress: PlacementsProgress };
  on(event: string, cb: (data: unknown) => void): () => void;
  setSimulationPaused(reason: string, paused: boolean): void;
}

/**
 * Hold the fixed-timestep simulation while the scene is incomplete. A source
 * whose successor conveyor is not materialised yet would run its MUs into a
 * line end that is none — and with "Vanish MUs" on, the snap-connectivity gate
 * deletes them, because the pairing of a missing neighbour cannot exist. The
 * hold is a named pause reason (`setSimulationPaused`), so it composes with the
 * user's pause / the planner's drag hold and shows up in the Sim toolbar — the
 * busy indication the user gets without a new UI element. Rendering continues.
 */
export function installPlacementsSimHold(viewer: PlacementsSimHoldHost, log?: (msg: string) => void): () => void {
  let t0 = 0;
  return viewer.on('placements-state-changed', (data) => {
    const materializing = (data as { state: string }).state === 'materializing';
    viewer.setSimulationPaused(PLACEMENTS_PAUSE_REASON, materializing);
    const p = viewer.placements.progress;
    if (materializing) {
      t0 = performance.now();
      log?.(`Placements: ${p.pending} pending — simulation held until the scene is complete`);
    } else if (p.total === 0) {
      log?.('Placements: materialization abandoned — the document changed');
    } else {
      log?.(`Placements: ${p.materialized} of ${p.total} materialized in ${Math.round(performance.now() - t0)} ms`
        + (p.missing > 0 ? `, ${p.missing} missing` : ''));
    }
  });
}
