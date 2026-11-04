// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-topology-check.ts — the load-time successor check of the path network
 * (plan-633 F8, Gate R1 #6, R2-2).
 *
 * A core service, registered by the viewer — NOT by the snap-point plugin,
 * which takes no part in the modes. It works in every mode and needs no snap
 * registry: it reads the network directly ({@link pairPathEnds}).
 *
 * When it runs:
 *   - after the scene is COMPLETE (`whenSceneReady()`), never on `model-loaded`
 *     alone — `loadScene` creates stored `addNode(Path)` nodes after it, and the
 *     placements of a layout document arrive later still;
 *   - triggered by `model-loaded`, `scene-loaded`, `placements-materialized`
 *     (not aborted), layout content added/removed and live path edits; all
 *     triggers until the scene is ready collapse into ONE check;
 *   - a superseded load (`model-cleared` in between) or a failed load (the
 *     scene gate's failure count moved) reports nothing.
 *
 * What it reports (problems-store, never a correction):
 *   - `path-successor-mismatch` (warning) per path — missing / extra / reversed
 *     / unknown successors compared with the geometry;
 *   - `path-end-near-miss` (info) per END → START pair 5…30 mm apart.
 * Paths with `connectCheck: false` are left out. Both codes are cleared on
 * every run and on `model-cleared`.
 */

import { clearProblemsOfCode, reportProblem } from '../hmi/problems-store';
import { getDefaultPathNetwork, type RVPathNetwork } from '../engine/rv-path-network';
import type { RVPath } from '../engine/rv-path';
import { PATH_LINK_TOLERANCE } from './path-link-tolerance';
import { analysePathEnds, diffSuccessors, type PathNearMiss, type SuccessorDiff } from './path-topology';

/** Problem code: authored successors disagree with the geometry. */
export const PATH_SUCCESSOR_MISMATCH = 'path-successor-mismatch';
/** Problem code: a path end stops 5…30 mm short of a path start. */
export const PATH_END_NEAR_MISS = 'path-end-near-miss';

/** What the check needs of the viewer. */
export interface PathTopologyCheckHost {
  on(event: string, cb: (data: unknown) => void): () => void;
  whenSceneReady(): Promise<void>;
  /** Failure count of the scene load gate — a load failing while the check waits suppresses it. */
  readonly sceneLoadGate?: { readonly failedLoads?: number };
  /** Document node path of a path's node (problem entry `nodePath`). */
  nodePathOfPath?(pathId: string): string | null;
  /**
   * All document node paths by path id, built ONCE per check run (plan-644).
   * Preferred over {@link nodePathOfPath}, which a host may answer with a scan
   * per call. Absent → per-id {@link nodePathOfPath}, memoised for the run.
   */
  nodePathsOfPaths?(): ReadonlyMap<string, string>;
  /**
   * The paths of the scene on screen. The viewer answers from its per-model
   * component registry: the shared default network is not emptied on a model
   * switch (path components are not disposed there), so `network.all()` can
   * still hold paths of an earlier model. Absent → `network.all()`.
   */
  scenePaths?(): readonly RVPath[];
}

/** Result of one check run. */
export interface PathTopologyCheckResult {
  readonly paths: number;
  readonly links: number;
  readonly mismatches: readonly SuccessorDiff[];
  readonly nearMisses: readonly PathNearMiss[];
}

/** The load-time successor check. One per viewer. */
export class PathTopologyCheck {
  private generation = 0;
  private pending: Promise<void> | null = null;
  private offs: (() => void)[] = [];
  private _runs = 0;
  private _skipped = 0;
  private _last: PathTopologyCheckResult | null = null;

  constructor(
    private readonly host: PathTopologyCheckHost,
    private readonly network: RVPathNetwork = getDefaultPathNetwork(),
  ) {}

  /** Subscribe to the load lifecycle. Returns the uninstall. Idempotent per instance. */
  install(): () => void {
    if (this.offs.length > 0) return () => this.dispose();
    const trigger = (): void => { void this.schedule(); };
    this.offs.push(
      this.host.on('model-loaded', trigger),
      this.host.on('scene-loaded', trigger),
      this.host.on('placements-materialized', (info) => {
        if (!(info as { aborted?: boolean } | undefined)?.aborted) trigger();
      }),
      this.host.on('layout-content-added', trigger),
      this.host.on('layout-content-removed', trigger),
      this.host.on('model-cleared', () => this.reset()),
      this.network.onPathChanged(trigger),
    );
    return () => this.dispose();
  }

  /** Completed check runs (tests / diagnostics). */
  get runs(): number { return this._runs; }
  /** Scheduled checks dropped because their load was superseded or failed. */
  get skipped(): number { return this._skipped; }
  /** The result of the last completed run, null before the first / after a model change. */
  get lastResult(): PathTopologyCheckResult | null { return this._last; }

  /**
   * Schedule ONE check after the scene is ready. Triggers while one is pending
   * join it. The returned promise settles when that check ran or was dropped.
   */
  schedule(): Promise<void> {
    if (this.pending) return this.pending;
    const gen = this.generation;
    const failed0 = this.host.sceneLoadGate?.failedLoads ?? 0;
    const slot: { run: Promise<void> | null } = { run: null };
    const run = (async (): Promise<void> => {
      // Let a synchronous burst of triggers join before waiting.
      await Promise.resolve();
      await this.host.whenSceneReady();
      if (this.pending === slot.run) this.pending = null;
      if (gen !== this.generation || (this.host.sceneLoadGate?.failedLoads ?? 0) !== failed0) {
        this._skipped++;
        return;
      }
      this.runNow();
    })();
    slot.run = run;
    this.pending = run;
    return run;
  }

  /** Settles when no check is pending. */
  async whenIdle(): Promise<void> {
    while (this.pending) await this.pending;
  }

  /** Run the check now and replace both problem codes with its findings. */
  runNow(): PathTopologyCheckResult {
    const paths = [...(this.host.scenePaths?.() ?? this.network.all())];
    const { links, nearMisses } = analysePathEnds(paths);
    const mismatches = diffSuccessors(paths, links);
    const optedOut = new Set(paths.filter((p) => !p.connectCheck).map((p) => p.id));
    const reportedNear = nearMisses.filter((n) => !optedOut.has(n.from) && !optedOut.has(n.to));

    clearProblemsOfCode(PATH_SUCCESSOR_MISMATCH);
    clearProblemsOfCode(PATH_END_NEAR_MISS);
    const nodePathOf = this.nodePathLookup();
    for (const d of mismatches) {
      const parts: string[] = [];
      if (d.missing.length) parts.push(`missing: ${d.missing.join(', ')}`);
      if (d.extra.length) parts.push(`declared without a matching end: ${d.extra.join(', ')}`);
      if (d.reversed.length) parts.push(`declared against the travel direction: ${d.reversed.join(', ')}`);
      if (d.unknown.length) parts.push(`unknown path ids: ${d.unknown.join(', ')}`);
      const nodePath = nodePathOf(d.pathId) ?? undefined;
      reportProblem({
        id: `${PATH_SUCCESSOR_MISMATCH}:${d.pathId}`,
        severity: 'warning',
        code: PATH_SUCCESSOR_MISMATCH,
        title: `Path '${d.pathId}': successors do not match the path ends`,
        detail: `${parts.join('; ')}. Ends link when the end of one path lies within `
          + `${PATH_LINK_TOLERANCE.distM * 1000} mm of the start of the next and their travel directions `
          + `differ by at most ${PATH_LINK_TOLERANCE.tangentDeg}°. Set connectCheck: false on a deliberate crossing.`,
        ...(nodePath ? { nodePath } : {}),
      });
    }
    for (const n of reportedNear) {
      const nodePath = nodePathOf(n.from) ?? undefined;
      reportProblem({
        id: `${PATH_END_NEAR_MISS}:${n.from}>${n.to}`,
        severity: 'info',
        code: PATH_END_NEAR_MISS,
        title: `Path '${n.from}' ends ${(n.distance * 1000).toFixed(1)} mm before path '${n.to}' starts`,
        detail: `End of '${n.from}' → start of '${n.to}': ${(n.distance * 1000).toFixed(1)} mm apart, more than the `
          + `${PATH_LINK_TOLERANCE.distM * 1000} mm link tolerance — the two paths are not connected geometrically.`,
        ...(nodePath ? { nodePath } : {}),
      });
    }
    this._runs++;
    this._last = { paths: paths.length, links: links.length, mismatches, nearMisses: reportedNear };
    return this._last;
  }

  /** Node-path lookup for ONE run: the host's map, else memoised per-id answers. */
  private nodePathLookup(): (pathId: string) => string | null {
    const all = this.host.nodePathsOfPaths?.();
    if (all) return (id) => all.get(id) ?? null;
    const memo = new Map<string, string | null>();
    return (id) => {
      if (!memo.has(id)) memo.set(id, this.host.nodePathOfPath?.(id) ?? null);
      return memo.get(id) ?? null;
    };
  }

  /** Model change: forget the pending check and drop both problem codes. */
  reset(): void {
    this.generation++;
    this.pending = null;
    this._last = null;
    clearProblemsOfCode(PATH_SUCCESSOR_MISMATCH);
    clearProblemsOfCode(PATH_END_NEAR_MISS);
  }

  /** Unsubscribe everything and clear the problems. */
  dispose(): void {
    for (const off of this.offs) {
      try { off(); } catch { /* already gone */ }
    }
    this.offs = [];
    this.reset();
  }
}
