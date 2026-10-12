// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-scene-ready.ts — the MCP open verbs' share of the scene-ready
 * contract (`core/engine/rv-scene-ready.ts`, plan-753).
 *
 * `web_document_open` / `web_project_open` used to answer the moment the
 * document's own GLB was in. For a layout document that is a scene WITHOUT its
 * placed references: `web_layout_list`, `web_node_find`, `web_signal_list`
 * called right after read a half-filled scene. The open verbs now wait for
 * `viewer.whenSceneReady()` — within a budget, because the bridge in front of
 * them times out at 15 s while the call itself keeps running: a tool that
 * hangs is worse than one that says "still filling".
 */

import { awaitSceneReady, type SceneReadyHost, type SceneReadyReport } from '../../core/engine/rv-scene-ready';
import type { PlacementsProgress } from '../../core/engine/rv-placement-instancer';
import { bakeRemovalReport, type BakeRemovalReport } from '../../core/engine/rv-bake-survival';

/** How long an open verb waits for the placements before answering `pending > 0`. */
let _budgetMs = 8_000;

/** Test seam — returns the previous budget. */
export function setSceneReadyBudgetMs(ms: number): number {
  const prev = _budgetMs;
  _budgetMs = ms;
  return prev;
}

type ReadyViewer = SceneReadyHost & { placements: SceneReadyHost['placements'] & { readonly progress: PlacementsProgress } };

function isReadyViewer(v: unknown): v is ReadyViewer {
  const c = v as Partial<ReadyViewer> | null | undefined;
  return !!c?.sceneLoadGate && !!c.placements && typeof c.placements.whenMaterialized === 'function'
    && !!c.placements.progress;
}

/** Fields an open verb spreads into its answer: `placements` and, while pending, `placementsHint`. */
export async function sceneReadyFields(viewer: unknown): Promise<{
  placements?: SceneReadyReport['placements'];
  placementsHint?: string;
}> {
  if (!isReadyViewer(viewer)) return {};
  const report = await awaitSceneReady(viewer, _budgetMs);
  return report.ready
    ? { placements: report.placements }
    : { placements: report.placements, placementsHint: report.hint };
}

/**
 * `web_status.placements.survival` (plan-757 F12): what the ONE recipe
 * removed and kept across the PLACED assets of the open document — summed
 * over the latest removal report of every distinct baked asset that has a
 * live non-identity instance (`ModelCache._bake` writes one per asset since
 * Phase 1a). `null` when nothing is placed.
 */
export interface PlacementSurvival {
  /** Distinct baked assets behind the live placements. */
  assets: number;
  /** Of those, how many have a removal report (an asset baked before the
   *  report existed, or through a foreign cache, has none). */
  reported: number;
  nodes: number;
  survivors: number;
  removed: number;
  unresolvedReferences: number;
  unresolvedClaims: number;
  g1Violations: number;
}

export function placementSurvival(viewer: unknown): PlacementSurvival | null {
  const v = viewer as {
    bakeRegistry?: { instances?: ReadonlySet<{ identity: boolean; baked: { assetId: string } }> };
  } | null | undefined;
  const instances = v?.bakeRegistry?.instances;
  if (!instances) return null;
  const assetIds = new Set<string>();
  for (const inst of instances) if (!inst.identity) assetIds.add(inst.baked.assetId);
  if (assetIds.size === 0) return null;
  const out: PlacementSurvival = {
    assets: assetIds.size, reported: 0, nodes: 0, survivors: 0, removed: 0,
    unresolvedReferences: 0, unresolvedClaims: 0, g1Violations: 0,
  };
  // Latest report per asset id wins (the list is oldest-first).
  const latest = new Map<string, BakeRemovalReport>();
  for (const r of bakeRemovalReport) if (assetIds.has(r.assetId)) latest.set(r.assetId, r);
  for (const r of latest.values()) {
    out.reported++;
    out.nodes += r.counts.nodes;
    out.survivors += r.counts.survivors;
    out.removed += r.counts.removed;
    out.unresolvedReferences += r.counts.unresolvedReferences;
    out.unresolvedClaims += r.unresolvedClaims.length;
    out.g1Violations += r.g1Violations.length;
  }
  return out;
}

/** `web_status.placements` — live state, no waiting. Existing fields unchanged; `survival` is additive (F12). */
export function placementsStatus(viewer: unknown): (PlacementsProgress & { loading: boolean; survival: PlacementSurvival | null }) | null {
  if (!isReadyViewer(viewer)) return null;
  return { ...viewer.placements.progress, loading: viewer.sceneLoadGate.loading, survival: placementSurvival(viewer) };
}
