// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * planner-parametric — parameters per placement (plan-650 Phase 5, F17).
 *
 * A placement of a parametric family carries its own values as
 * `AssetOverrides.byNodeId[<family NodeId>].ParametricComponent.Values` — the
 * existing override format, persisted by the routed `setField` of the family
 * node (rv-scene-glb-bake: an edit inside a live placement lands in that
 * placement's `AssetOverrides`). The flow is ONE path for do, undo and redo:
 *
 *   layout.setParams → normalize → setField(familyPath, ParametricComponent, Values)
 *     → scene executor → emitParametricValuesChanged
 *     → {@link handleValuesChanged} → (standstill?) → rematerialize(id, seq)
 *     → resolveBaked(ref, { overrides })  — the variant bake, cached per InputHash
 *     → the planner swaps the instance in place (old one stays until the new is ready)
 *
 * Undo / redo replay the `setField` inverse / forward, so they arrive here too.
 * Every rematerialisation carries a sequence number per placement; a request
 * overtaken by a newer one is dropped (§2.6 "Sequenznummer").
 *
 * The generator never runs while the simulation runs (§2.6a): the value is
 * written at once (inspector, save), the geometry follows at the next
 * standstill.
 *
 * Loaded by dynamic import only (the command impl, a copy of a parametric
 * placement).
 */

import type { Object3D } from 'three';
import type { RVViewer } from '../../core/rv-viewer';
import {
  PARAMETRIC_BUILT_KEY,
  PARAMETRIC_COMPONENT_TYPE,
  canRegenerate,
  stampParametricBuiltKey,
  normalizeValues,
  onParametricValuesChanged,
  parseParametricComponent,
  parametricRequestsOf,
  canonicalRequestKey,
  type ParamValue,
  type StandstillView,
} from '../../core/engine/rv-parametric-component';
import { getAssetOverrides, overrideAddressOf, type AssetOverrides, type ComponentPatch } from '../../core/engine/rv-asset-reference';
import { getNodeId } from '../../core/engine/rv-node-id';
import { getActiveEditTarget } from '../../core/hmi/rv-edit-target';
import { clearProblem, reportProblem } from '../../core/hmi/problems-store';
import type { LayoutPlannerPlugin } from './index';

/** Problem code of a placement whose variant could not be built. */
export const PROBLEM_PLACEMENT_PARAMS = 'parametric-placement-failed';

const BUILT_KEY = PARAMETRIC_BUILT_KEY;

// ─── Families of a placement ──────────────────────────────────────────────

export interface PlacementFamily {
  node: Object3D;
  nodeId: string;
  /** Path of the family node relative to the placement root ('' = the root). */
  relPath: string;
}

function relPathOf(root: Object3D, node: Object3D): string {
  const names: string[] = [];
  for (let n: Object3D | null = node; n && n !== root; n = n.parent) names.unshift(n.name);
  return names.join('/');
}

/** The parametric families of a placement (nested placements excluded — they own their values). */
export function familiesOfPlacement(root: Object3D): PlacementFamily[] {
  const out: PlacementFamily[] = [];
  const visit = (n: Object3D): void => {
    if (n !== root && n.userData?._layoutNestedOf !== undefined) return;
    const pc = n.userData?.realvirtual?.[PARAMETRIC_COMPONENT_TYPE];
    const id = getNodeId(n);
    if (pc && id) out.push({ node: n, nodeId: id, relPath: relPathOf(root, n) });
    for (const c of n.children) visit(c);
  };
  visit(root);
  return out;
}

function liveValuesOf(node: Object3D): Record<string, unknown> | undefined {
  const pc = node.userData?.realvirtual?.[PARAMETRIC_COMPONENT_TYPE] as { Values?: Record<string, unknown> } | undefined;
  return pc?.Values;
}

/**
 * `AssetOverrides` of a placement with the LIVE family values folded in.
 * `parametricOnly` drops every other override (a copy carries the values, not
 * the source's other patches — those were never copied).
 */
export function liveParametricOverrides(root: Object3D, parametricOnly = false): AssetOverrides | null {
  const families = familiesOfPlacement(root);
  const saved = parametricOnly ? null : getAssetOverrides(root);
  const byAddress: Record<string, ComponentPatch> = { ...(saved?.byAddress ?? {}) };
  let any = false;
  for (const f of families) {
    const values = liveValuesOf(f.node);
    if (!values) continue;
    const key = overrideAddressOf(f.nodeId);
    const slot: ComponentPatch = { ...(byAddress[key] ?? {}) };
    slot[PARAMETRIC_COMPONENT_TYPE] = { ...(slot[PARAMETRIC_COMPONENT_TYPE] ?? {}), Values: { ...values } };
    byAddress[key] = slot;
    any = true;
  }
  if (!any && !saved) return null;
  return {
    byAddress,
    ...(saved?.legacyByPath ? { legacyByPath: saved.legacyByPath } : {}),
  };
}


// ─── Rematerialisation (sequence numbers) ─────────────────────────────────

interface PlannerHost {
  planner: LayoutPlannerPlugin;
  viewer: RVViewer;
}

const latestSeq = new Map<string, number>();
const chains = new Map<string, Promise<void>>();
let seqCounter = 0;
const deferredIds = new Map<string, PlannerHost>();
let deferTimer: ReturnType<typeof setInterval> | null = null;
const DEFER_POLL_MS = 500;

export type RematerializeOutcome = 'applied' | 'unchanged' | 'superseded' | 'gone' | 'failed';

/** Queue a rematerialisation of placement `id`; resolves when THIS request settled. */
export function rematerialize(host: PlannerHost, id: string): Promise<RematerializeOutcome> {
  const seq = ++seqCounter;
  latestSeq.set(id, seq);
  let outcome: RematerializeOutcome = 'superseded';
  const prev = chains.get(id) ?? Promise.resolve();
  const step = prev.then(async () => { outcome = await runRematerialize(host, id, seq); });
  const tail = step.catch(() => { /* reported inside */ });
  chains.set(id, tail);
  void tail.then(() => { if (chains.get(id) === tail) chains.delete(id); });
  return step.then(() => outcome, () => 'failed' as const);
}

async function runRematerialize(host: PlannerHost, id: string, seq: number): Promise<RematerializeOutcome> {
  if (latestSeq.get(id) !== seq) return 'superseded';
  const root = host.planner.getPlacedRootById(id);
  if (!root) return 'gone';
  const overrides = liveParametricOverrides(root);
  const key = canonicalRequestKey(parametricRequestsOf(overrides));
  if (root.userData[BUILT_KEY] === key) return 'unchanged';
  const problemId = `${PROBLEM_PLACEMENT_PARAMS}:${id}`;
  try {
    const ok = await host.planner.rematerializePlacement(id, overrides, () => latestSeq.get(id) === seq);
    if (!ok) return latestSeq.get(id) === seq ? 'gone' : 'superseded';
    const fresh = host.planner.getPlacedRootById(id);
    if (fresh) stampParametricBuiltKey(fresh, overrides);
    clearProblem(problemId);
    return 'applied';
  } catch (e) {
    const code = (e as { code?: string })?.code ?? PROBLEM_PLACEMENT_PARAMS;
    reportProblem({
      id: problemId, severity: 'error', code,
      title: `Parametric placement could not be rebuilt (${code})`,
      detail: `${e instanceof Error ? e.message : String(e)} — the previous variant is kept.`,
      nodePath: host.viewer.registry?.getPathForNode(root) ?? undefined,
    });
    return 'failed';
  }
}

/** Placements whose new values wait for the next standstill. */
export function getDeferredPlacements(): string[] {
  return [...deferredIds.keys()];
}

function defer(host: PlannerHost, id: string): void {
  deferredIds.set(id, host);
  if (!deferTimer) deferTimer = setInterval(() => { void flushDeferredPlacements(); }, DEFER_POLL_MS);
}

/** Apply every deferred placement whose viewer is at a standstill. */
export async function flushDeferredPlacements(): Promise<RematerializeOutcome[]> {
  const out: RematerializeOutcome[] = [];
  for (const [id, host] of [...deferredIds]) {
    if (!canRegenerate(host.viewer as unknown as StandstillView)) continue;
    deferredIds.delete(id);
    out.push(await rematerialize(host, id));
  }
  if (deferredIds.size === 0 && deferTimer) { clearInterval(deferTimer); deferTimer = null; }
  return out;
}

/** Drop every deferred placement (tests, document change). */
export function clearDeferredPlacements(): void {
  deferredIds.clear();
  if (deferTimer) { clearInterval(deferTimer); deferTimer = null; }
}

/**
 * The placement `node` belongs to: the planner's own lookup first
 * (`findPlacedAncestor` — the id `layout.setParams` accepts, same as the
 * inspector mask), else the `_layoutId` record root. Exported for tests.
 */
export function placementIdAbove(
  node: Object3D,
  planner?: { findPlacedAncestor?(n: Object3D): { id: string; root: Object3D } | null } | null,
): string | null {
  const hit = planner?.findPlacedAncestor?.(node) ?? null;
  if (hit) return hit.id;
  for (let n: Object3D | null = node; n; n = n.parent) {
    if (typeof n.userData?._layoutId === 'string') return n.userData._layoutId as string;
  }
  return null;
}

/** Last outcome per placement from the values listener (the command awaits it). */
const lastRun = new Map<string, Promise<RematerializeOutcome | 'deferred'>>();

/** THE listener: a write to `ParametricComponent.Values` inside a placement. */
export function handleValuesChanged(viewer: RVViewer, nodePath: string): void {
  const node = viewer.registry?.getNode(nodePath);
  if (!node) return;
  const planner = viewer.getPlugin?.<LayoutPlannerPlugin>('layout-planner');
  if (!planner) return;
  const id = placementIdAbove(node, planner);
  if (!id) return;
  const host = { planner, viewer };
  if (!canRegenerate(viewer as unknown as StandstillView)) {
    defer(host, id);
    lastRun.set(id, Promise.resolve('deferred'));
    return;
  }
  lastRun.set(id, rematerialize(host, id));
}

let listening = false;
/** Install the values listener once (idempotent). */
export function ensureParametricPlacementListener(): void {
  if (listening) return;
  listening = true;
  onParametricValuesChanged((viewer, nodePath) => handleValuesChanged(viewer as RVViewer, nodePath));
}

/**
 * A copy of a parametric placement: record the family values of the new root
 * as routed `setField` ops (value = prev — the instance already IS that
 * variant), so the save writes them into the copy's `AssetOverrides`.
 */
export async function recordCopiedFamilyValues(viewer: RVViewer, root: Object3D): Promise<void> {
  ensureParametricPlacementListener();
  const target = getActiveEditTarget();
  if (!target.available) return;
  for (const fam of familiesOfPlacement(root)) {
    const values = liveValuesOf(fam.node);
    const path = viewer.registry?.getPathForNode(fam.node);
    if (!values || !path) continue;
    if (target.setFieldAsync) await target.setFieldAsync(path, PARAMETRIC_COMPONENT_TYPE, 'Values', { ...values }, { ...values });
    else target.setField(path, PARAMETRIC_COMPONENT_TYPE, 'Values', { ...values }, { ...values });
  }
}

// ─── The command body (layout.setParams) ──────────────────────────────────

export interface SetPlacementParamsResult {
  status: RematerializeOutcome | 'deferred';
  id: string;
  family: string;
  values: Record<string, ParamValue>;
  generatorRuns: number;
  variantBakes: number;
}

/** Resolve the one family of a placement a request targets (relPath, NodeId or the only one). */
export function pickFamily(root: Object3D, family?: string | null): PlacementFamily | { error: string } {
  const all = familiesOfPlacement(root);
  if (all.length === 0) return { error: 'placement has no parametric family (ParametricComponent)' };
  if (family) {
    const hit = all.find((f) => f.relPath === family || f.nodeId === family || f.node.name === family);
    return hit ?? { error: `no parametric family "${family}" in this placement (have: ${all.map((f) => f.relPath || '(root)').join(', ')})` };
  }
  if (all.length > 1) return { error: `placement has ${all.length} parametric families — pass family (${all.map((f) => f.relPath || '(root)').join(', ')})` };
  return all[0];
}

/** Validate + normalize the request against the family's schema. Throws with the reason. */
export function normalizeRequest(fam: PlacementFamily, values: Readonly<Record<string, unknown>>): Record<string, ParamValue> {
  const parsed = parseParametricComponent(fam.node.userData.realvirtual[PARAMETRIC_COMPONENT_TYPE]);
  if (!parsed.ok) throw new Error(`ParametricComponent is invalid: ${parsed.errors.join('; ')}`);
  return normalizeValues(parsed.value.Params, { ...(liveValuesOf(fam.node) ?? {}), ...values });
}

function sameValues(a: Readonly<Record<string, unknown>> | undefined, b: Readonly<Record<string, unknown>>): boolean {
  if (!a) return false;
  const ka = Object.keys(a);
  return ka.length === Object.keys(b).length && ka.every((k) => a[k] === b[k]);
}

/**
 * Set the values of one family of placement `id` (F17): ONE `setField` op
 * (undo / redo restore values AND variant through the listener), the variant
 * swap awaited. Throws with a user-facing reason on an invalid request.
 */
export async function setPlacementParams(
  viewer: RVViewer, planner: LayoutPlannerPlugin, id: string,
  values: Readonly<Record<string, unknown>>, family?: string | null,
): Promise<SetPlacementParamsResult> {
  ensureParametricPlacementListener();
  const root = planner.getPlacedRootById(id);
  if (!root) throw new Error(`No placement "${id}". Use web_query("layout.list", {}).`);
  const fam = pickFamily(root, family);
  if ('error' in fam) throw new Error(fam.error);
  const normalized = normalizeRequest(fam, values);
  const cache = planner.placements.modelCache;
  const before = cache.getParametricStats();
  const prev = liveValuesOf(fam.node);
  const base = { id, family: fam.relPath, values: normalized };
  if (sameValues(prev, normalized)) {
    const outcome = await rematerialize({ planner, viewer }, id); // heals a stale instance, else 'unchanged'
    return { ...base, status: outcome, generatorRuns: 0, variantBakes: 0 };
  }
  const nodePath = viewer.registry?.getPathForNode(fam.node) ?? null;
  if (!nodePath) throw new Error('the family node is not registered');
  const target = getActiveEditTarget();
  if (!target.available) throw new Error('no edit target — the values cannot be recorded');
  lastRun.delete(id);
  if (target.setFieldAsync) await target.setFieldAsync(nodePath, PARAMETRIC_COMPONENT_TYPE, 'Values', { ...normalized }, prev);
  else target.setField(nodePath, PARAMETRIC_COMPONENT_TYPE, 'Values', { ...normalized }, prev);
  // The executor's write reached the listener (or the target is not the scene store: run it here).
  const run = lastRun.get(id) ?? (canRegenerate(viewer as unknown as StandstillView)
    ? rematerialize({ planner, viewer }, id)
    : (defer({ planner, viewer }, id), Promise.resolve('deferred' as const)));
  const status = await run;
  const after = cache.getParametricStats();
  return {
    ...base, status,
    generatorRuns: after.generatorRuns - before.generatorRuns,
    variantBakes: after.variantBakes - before.variantBakes,
  };
}
