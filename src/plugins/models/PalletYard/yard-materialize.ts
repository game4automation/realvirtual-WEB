// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * PalletYard size rebuild (plan-681 §2.2, Phase 3) — the target-state
 * materialisation that turns the loaded yard into `composeYard(n)`.
 *
 * Runs INSIDE the planning apply's structural transaction
 * (`viewer.structuralEdit`, opened by plan-630's `structural-reset.ts` around
 * commit → owners → rollback), so nothing it does restarts the simulation on
 * its own: the transaction performs the ONE reset when it closes. It never
 * diffs against a guessed state — every step compares the scene with the target
 * and changes only what differs (idempotent; an apply without a size change
 * changes nothing):
 *
 *  1. **path graph** (A2): the generated `PathBlock` / `Path` nodes under
 *     `PathNetwork` (marked `Generated.owner = 'palletYard'`) are replaced as a
 *     whole through `viewer.replaceRuntimeSubtree` — author blocks next to them
 *     stay. Paths FIRST, the placements bind their stich by Path-Id string.
 *  2. **floor slots**: the generated `Slot_P<k>` nodes under `PalletYardRoot`,
 *     the same way.
 *  3. **placements**: every target placement (modules, end caps, conveyors,
 *     sources, scanners, sinks, stackers, markings) — missing or a failed
 *     placeholder → placed; present but in another pose / configuration →
 *     removed and placed again (a component reads its configuration and pose at
 *     init — re-placing is the one way that reconfigures it for sure); one the
 *     target does not have → removed (`viewer.structural.removePlacement`, the
 *     core clean-up).
 *  3b. **AGV breakdowns**: one ENABLED `Downtime_<vehicle>` node per vehicle
 *     when `AgvMtbf > 0`, aimed at the vehicle's DES component path (read from
 *     where the yard stands). The document's own breakdown nodes (owner
 *     {@link DOWNTIME_OWNER}) are never removed or re-created: they are updated
 *     IN PLACE — re-parameterised, or `Enabled: false` when their vehicle is gone
 *     or `AgvMtbf` is 0 — and the DES re-reads them (`reconfigureFromExtras`).
 *     Only a vehicle the document has no node for gets a runtime node (owner
 *     {@link DOWNTIME_ADDED_OWNER}, replaced as a whole). Why: a re-created node
 *     gets a fresh runtime identity, which changes the DES base key, so every
 *     experiment result would turn stale the moment a variant hands the scene
 *     back to Base. In place, Base after any variant is byte-identical to Base
 *     after the load.
 *  4. **check** (A1): the instancer idle (`ctx.awaitPlacements`, NOT the
 *     once-per-load event), then id-exact: node there, not materialising,
 *     `instanceOf(node) !== null`, pose = target; every target path resolves in
 *     the network, every vehicle's start path too. A miss throws — the apply
 *     rolls the values back and calls this again with the previous size (A3),
 *     inside the same transaction.
 *
 * Poses: a reference node is positioned so its asset CONTENT stands at the
 * composition pose (`compensatedPose` of the generator, which needs the asset
 * root's own transform). The runtime cannot read the library file for that, so
 * it learns the compensation per asset from the LOADED document: for each asset
 * one reference node of the document's own composition, whose composition pose
 * and reference pose are both known ({@link learnYardTemplates}). The document is
 * a composition of the same generator, so every asset appears in it.
 *
 * Everything created or re-placed carries `userData._rvStructuralDerived =
 * 'palletYard'` (rv-structural-derived.ts): transient, never saved, locked
 * against authoring ops (`structural-derived-locked`).
 */

import { Euler, Object3D, Quaternion, Vector3 } from 'three';
import { getDefaultPathNetwork } from '@rv/core/engine/rv-path-network';
import { markStructuralDerived } from '@rv/core/engine/rv-structural-derived';
import type { RuntimeNodeSpec } from '@rv/core/engine/rv-scene-loader';
import type { StructuralPlacementSpec, ReplaceRuntimeSubtreeResult } from '@rv/core/engine/rv-structural-derived';
import type { StructuralResetContext } from '@rv/core/planning/rv-planning-params';
import { pathExtras, round } from './path-dsl.mjs';
import {
  DOWNTIME_ADDED_OWNER, DOWNTIME_OWNER, GENERATED_OWNER, composeYardBlocks, downtimeComponents, pathBlockExtras, type YardComposition,
} from './yard-compose';

/**
 * The DES component path of `node` (`DESComponent.path`: every name from the
 * node up to, not including, the topmost ancestor), e.g.
 * `PalletYard/PalletYardRoot/Stapler_1`. A `Downtime.TargetComponentPath` must
 * equal it exactly.
 */
export function desPathOf(node: Object3D): string {
  const parts: string[] = [];
  let cur: Object3D | null = node;
  while (cur && cur.parent) { parts.unshift(cur.name); cur = cur.parent; }
  return parts.join('/');
}

/** Name of the yard's scene root node (generator `ROOT_NAME`). */
export const YARD_ROOT_NAME = 'PalletYardRoot';
/** Name of the path network container (generator `PATH_NETWORK_NAME`, WebViewer `PATH_NETWORK_NODE`). */
export const PATH_NETWORK_NAME = 'PathNetwork';
/** NodeId prefix of every yard placement (generator `reference`). */
export const PLACEMENT_ID_PREFIX = 'pallet-yard-';
/** Position tolerance of the pose check (m). */
const POS_EPS = 1e-4;
/** Rotation tolerance of the pose check (|q·q'| deviation from 1). */
const ROT_EPS = 1e-6;

/** What the materialiser needs of the viewer (structural slice — the test drives the real one). */
export interface MaterializeViewer {
  readonly registry: { getPathForNode(node: Object3D): string | null } | null;
  /** The DES control, when the DES kernel runs: re-reads component extras changed in place. */
  readonly simulationKernel?: { desControl?(): { reconfigureFromExtras?(): void } | null | undefined } | null;
  readonly placements: {
    instanceOf(root: Object3D): unknown;
    isMaterializing(id: string): boolean;
    whenMaterialized(): Promise<void>;
  };
  readonly structural: {
    place(spec: StructuralPlacementSpec): Promise<Object3D>;
    removePlacement(root: Object3D): void;
  };
  replaceRuntimeSubtree(owner: string, specs: readonly RuntimeNodeSpec[], opts?: { under?: string }): ReplaceRuntimeSubtreeResult;
}

/** The compensation of one library asset, learned from the loaded document. */
export interface PlacementTemplate {
  assetRef: { assetId: string; path: string };
  /** Reference rotation = composition rotation · `qCorr` (the inverse of the asset root's rotation). */
  qCorr: Quaternion;
  /** The asset root's translation (in the reference frame). */
  tCorr: Vector3;
  /** The document's `AssetOverrides` of this asset (canonical, copied per placement). */
  overrides?: unknown;
}

/** Per asset path. */
export type YardTemplates = Map<string, PlacementTemplate>;

/** What one materialisation changed (diagnostics, tests). */
export interface MaterializeReport {
  size: number;
  pathsReplaced: boolean;
  slotsReplaced: boolean;
  /** Runtime breakdown nodes (vehicles the document has none for) were replaced. */
  downtimesReplaced: boolean;
  /** The document's breakdown nodes were re-parameterised / enabled / disabled in place. */
  downtimesReconfigured: boolean;
  placed: string[];
  removed: string[];
  kept: number;
}

// ─── Small helpers ─────────────────────────────────────────────────────────

const rvOf = (n: Object3D): Record<string, unknown> | undefined =>
  (n.userData as { realvirtual?: Record<string, unknown> } | undefined)?.realvirtual;

/** The node named `name` directly below `parent` (the generator writes flat children). */
function childNamed(parent: Object3D, name: string): Object3D | null {
  for (const c of parent.children) if (c.name === name) return c;
  return null;
}

/** First node named `name` below `root` (breadth-first, never inside a placement). */
export function findYardNode(root: Object3D, name: string): Object3D | null {
  const queue: Object3D[] = [root];
  while (queue.length > 0) {
    const n = queue.shift()!;
    if (n.name === name) return n;
    if (n !== root && rvOf(n)?.AssetReference) continue;
    queue.push(...n.children);
  }
  return null;
}

const yawQuat = (deg: number): Quaternion => new Quaternion().setFromEuler(new Euler(0, deg * Math.PI / 180, 0));

/** Every field of `want` equals `have` (numbers to 1e-6); `have` may carry more. */
export function subsetEqual(want: unknown, have: unknown): boolean {
  if (typeof want === 'number') return typeof have === 'number' && Math.abs(want - have) <= 1e-6;
  if (Array.isArray(want)) {
    return Array.isArray(have) && have.length === want.length && want.every((w, i) => subsetEqual(w, have[i]));
  }
  if (want && typeof want === 'object') {
    if (!have || typeof have !== 'object') return false;
    const h = have as Record<string, unknown>;
    return Object.entries(want as Record<string, unknown>).every(([k, v]) => subsetEqual(v, h[k]));
  }
  return want === have;
}

// ─── Templates ─────────────────────────────────────────────────────────────

/**
 * Learn the pose compensation of every asset from the loaded yard (see the
 * module doc). `docYard` = the composition the document was generated from
 * (`composeYard(PalletYard.Size)`). Call it right after the load, BEFORE any
 * rebuild — it reads the reference nodes as the file placed them.
 */
export function learnYardTemplates(root: Object3D, docYard: Pick<YardComposition, 'placements'>): YardTemplates {
  const out: YardTemplates = new Map();
  const yardRoot = findYardNode(root, YARD_ROOT_NAME) ?? root;
  for (const p of docYard.placements) {
    if (out.has(p.assetRef.path)) continue;
    const node = childNamed(yardRoot, p.id);
    if (!node) continue;
    const at = new Vector3(...p.position);
    const rot = yawQuat(p.yawDeg);
    const q0 = node.quaternion.clone();
    const qCorr = rot.clone().invert().multiply(q0);
    const tCorr = at.clone().sub(node.position).applyQuaternion(q0.clone().invert());
    const overrides = rvOf(node)?.AssetOverrides;
    out.set(p.assetRef.path, {
      assetRef: { ...p.assetRef },
      qCorr,
      tCorr,
      ...(overrides ? { overrides: structuredClone(overrides) } : {}),
    });
  }
  return out;
}

/** The reference pose of a target placement (the asset content at the composition pose). */
export function referencePose(p: YardComposition['placements'][number], t: PlacementTemplate): { position: Vector3; quaternion: Quaternion } {
  const quaternion = yawQuat(p.yawDeg).multiply(t.qCorr);
  const position = new Vector3(...p.position).sub(t.tCorr.clone().applyQuaternion(quaternion));
  return { position, quaternion };
}

function poseMatches(node: Object3D, pose: { position: Vector3; quaternion: Quaternion }): boolean {
  return node.position.distanceTo(pose.position) <= POS_EPS
    && 1 - Math.abs(node.quaternion.dot(pose.quaternion)) <= ROT_EPS;
}

// ─── Target specs ──────────────────────────────────────────────────────────

/** The runtime node specs of the generated path network (blocks, then their paths). */
export function pathNetworkSpecs(yard: Pick<YardComposition, 'geometry' | 'course' | 'pathGraph'>, networkPath: string): RuntimeNodeSpec[] {
  const out: RuntimeNodeSpec[] = [];
  const byId = new Map(yard.pathGraph.map((p) => [p.id, p]));
  const identity = { position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
  for (const b of composeYardBlocks(yard)) {
    out.push({ parentPath: networkPath, name: b.id, ...identity, components: { PathBlock: pathBlockExtras(b) } });
    for (const id of b.paths) {
      const p = byId.get(id)!;
      out.push({ parentPath: `${networkPath}/${b.id}`, name: p.id, ...identity, components: pathExtras(p) as Record<string, Record<string, unknown>> });
    }
  }
  return out;
}

/** The runtime node specs of the floor slots. */
export function slotSpecs(yard: Pick<YardComposition, 'slots'>, yardPath: string): RuntimeNodeSpec[] {
  return yard.slots.map((s) => ({
    parentPath: yardPath, name: s.node,
    position: [...s.position] as [number, number, number], quaternion: [0, 0, 0, 1], scale: [1, 1, 1],
    components: { BakeRole: 'merge' as unknown as Record<string, unknown> },
  }));
}

/** The generated nodes of `owner` directly below `parent`, in order. */
function generatedChildren(parent: Object3D): Object3D[] {
  return parent.children.filter((c) => {
    const g = rvOf(c)?.Generated as { owner?: unknown } | undefined;
    return g?.owner === GENERATED_OWNER;
  });
}

/** The scene's generated network equals the target specs (names, order, payloads). */
function networkMatches(network: Object3D, yard: YardComposition): boolean {
  const blocks = composeYardBlocks(yard);
  const have = generatedChildren(network);
  if (have.length !== blocks.length) return false;
  const byId = new Map(yard.pathGraph.map((p) => [p.id, p]));
  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const n = have[i];
    if (n.name !== b.id || !subsetEqual(pathBlockExtras(b), rvOf(n)?.PathBlock)) return false;
    const kids = generatedChildren(n);
    if (kids.length !== b.paths.length) return false;
    for (let k = 0; k < b.paths.length; k++) {
      const p = byId.get(b.paths[k])!;
      if (kids[k].name !== p.id || !subsetEqual(pathExtras(p).Path, rvOf(kids[k])?.Path)) return false;
    }
  }
  return true;
}

/** The children of `parent` whose `Generated.owner` is `owner`, in order. */
function ownedBy(parent: Object3D, owner: string): Object3D[] {
  return parent.children.filter((c) => (rvOf(c)?.Generated as { owner?: unknown } | undefined)?.owner === owner);
}

/** The scene's runtime breakdown nodes equal the target (names, order, payloads). */
function downtimesMatch(yardRoot: Object3D, want: ReturnType<typeof downtimeComponents>): boolean {
  const have = ownedBy(yardRoot, DOWNTIME_ADDED_OWNER);
  return have.length === want.length
    && want.every((w, i) => have[i].name === w.name && subsetEqual(w.Downtime, rvOf(have[i])?.Downtime));
}

/** The scene's generated slots equal the target. */
function slotsMatch(yardRoot: Object3D, yard: YardComposition): boolean {
  const have = generatedChildren(yardRoot);
  if (have.length !== yard.slots.length) return false;
  return yard.slots.every((s, i) => have[i].name === s.node
    && have[i].position.distanceTo(new Vector3(...s.position)) <= POS_EPS);
}

// ─── The materialisation ───────────────────────────────────────────────────

/**
 * Materialise `yard` (the target) in the loaded scene — see the module doc.
 * Must run inside `viewer.structuralEdit`. Throws on any miss (the caller —
 * the planning apply — rolls back by calling it again with the previous size).
 */
export async function materializeYard(
  viewer: MaterializeViewer,
  root: Object3D,
  yard: YardComposition,
  templates: YardTemplates,
  ctx: Pick<StructuralResetContext, 'awaitPlacements' | 'signal'>,
): Promise<MaterializeReport> {
  const report: MaterializeReport = { size: yard.size, pathsReplaced: false, slotsReplaced: false, downtimesReplaced: false, downtimesReconfigured: false, placed: [], removed: [], kept: 0 };
  const registry = viewer.registry;
  if (!registry) throw new Error('palletYard-materialize: no scene');
  const yardRoot = findYardNode(root, YARD_ROOT_NAME);
  const network = findYardNode(root, PATH_NETWORK_NAME);
  if (!yardRoot || !network) throw new Error(`palletYard-materialize: ${!yardRoot ? YARD_ROOT_NAME : PATH_NETWORK_NAME} missing`);
  const yardPath = registry.getPathForNode(yardRoot);
  const networkPath = registry.getPathForNode(network);
  if (!yardPath || !networkPath) throw new Error('palletYard-materialize: yard root / path network not registered');

  // A load that still materialises its own placements finishes first — through
  // the DOCUMENT-CHECKED wait: a document change during it throws before
  // anything is touched (Codex review #1).
  await ctx.awaitPlacements();

  // 1. Path graph (paths first: the conveyors bind their stich by Path-Id).
  if (!networkMatches(network, yard)) {
    const r = viewer.replaceRuntimeSubtree(GENERATED_OWNER, pathNetworkSpecs(yard, networkPath), { under: networkPath });
    if (r.failed.length > 0) throw new Error(`palletYard-materialize: path nodes not created: ${r.failed.slice(0, 5).join(', ')}`);
    for (const n of r.nodes) if (n.parent === network) markStructuralDerived(n, GENERATED_OWNER);
    report.pathsReplaced = true;
  }

  // 2. Floor slots.
  if (!slotsMatch(yardRoot, yard)) {
    const r = viewer.replaceRuntimeSubtree(GENERATED_OWNER, slotSpecs(yard, yardPath), { under: yardPath });
    if (r.failed.length > 0) throw new Error(`palletYard-materialize: slot nodes not created: ${r.failed.join(', ')}`);
    for (const n of r.nodes) markStructuralDerived(n, GENERATED_OWNER);
    report.slotsReplaced = true;
  }

  // 3. Placements against the target.
  const target = new Map(yard.placements.map((p) => [p.id, p]));
  for (const c of [...yardRoot.children]) {
    const rv = rvOf(c);
    const nodeId = typeof rv?.NodeId === 'string' ? rv.NodeId : '';
    if (!rv?.AssetReference || !nodeId.startsWith(PLACEMENT_ID_PREFIX) || target.has(c.name)) continue;
    viewer.structural.removePlacement(c);
    report.removed.push(c.name);
  }
  const pending: Array<Promise<Object3D>> = [];
  for (const p of yard.placements) {
    const t = templates.get(p.assetRef.path);
    if (!t) throw new Error(`palletYard-materialize: no template for ${p.assetRef.path} (asset not in the loaded document)`);
    const pose = referencePose(p, t);
    const node = childNamed(yardRoot, p.id);
    const nodeId = PLACEMENT_ID_PREFIX + p.id;
    if (node) {
      const placed = viewer.placements.instanceOf(node) !== null || viewer.placements.isMaterializing(nodeId);
      const sameConfig = Object.entries(p.extras).every(([k, v]) => subsetEqual(v, rvOf(node)?.[k]));
      if (placed && sameConfig && poseMatches(node, pose)) { report.kept++; continue; }
      viewer.structural.removePlacement(node);
      report.removed.push(p.id);
    }
    const extras: Record<string, unknown> = structuredClone(p.extras);
    if (t.overrides) extras.AssetOverrides = structuredClone(t.overrides);
    pending.push(viewer.structural.place({
      parentPath: yardPath,
      name: p.id,
      nodeId,
      // The document writes asset paths WITHOUT the leading slash (generator
      // `reference`); a re-placed vehicle must carry the same string, or the
      // DES base key changes and every experiment result turns stale after
      // the first variant switch.
      assetRef: { assetId: p.assetRef.assetId, path: p.assetRef.path.replace(/^\//, '') },
      // Rounded like the generator writes them (`round`, 1e-6): a re-placed node
      // then carries the document's exact numbers, and the DES base key (which
      // hashes bind poses at 1e-6) stays the one of the loaded document.
      position: pose.position.toArray().map(round) as [number, number, number],
      quaternion: pose.quaternion.toArray().map(round) as [number, number, number, number],
      extras,
    }).then((n) => { markStructuralDerived(n, GENERATED_OWNER); return n; }));
    report.placed.push(p.id);
  }
  await Promise.all(pending);
  if (ctx.signal.aborted) throw new Error('palletYard-materialize: document changed');

  // 3b. AGV breakdowns — after the placements, so the vehicles they aim at stand there.
  const want = new Map(downtimeComponents(yard, desPathOf(yardRoot)).map((d) => [d.name, d.Downtime]));
  for (const n of ownedBy(yardRoot, DOWNTIME_OWNER)) {
    const rv = rvOf(n);
    const current = (rv?.Downtime ?? {}) as Record<string, unknown>;
    const target = want.get(n.name);
    const next = target ? { ...current, ...target } : { ...current, Enabled: false };
    want.delete(n.name);
    if (rv && !subsetEqual(next, current)) { rv.Downtime = next; report.downtimesReconfigured = true; }
  }
  const added = [...want].map(([name, Downtime]) => ({ name, Downtime }));
  if (!downtimesMatch(yardRoot, added)) {
    const identity = { position: [0, 0, 0] as [number, number, number], quaternion: [0, 0, 0, 1] as [number, number, number, number], scale: [1, 1, 1] as [number, number, number] };
    const r = viewer.replaceRuntimeSubtree(DOWNTIME_ADDED_OWNER, added.map((d) => ({
      // A stable id per vehicle: the DES base key addresses nodes by id, and a fresh
      // id on every rebuild would mark every experiment result stale.
      parentPath: yardPath, name: d.name, nodeId: `palletyard-downtime-${d.name}`, ...identity, components: { Downtime: d.Downtime },
    })), { under: yardPath });
    if (r.failed.length > 0) throw new Error(`palletYard-materialize: downtime nodes not created: ${r.failed.join(', ')}`);
    for (const n of r.nodes) markStructuralDerived(n, GENERATED_OWNER);
    report.downtimesReplaced = true;
  }
  if (report.downtimesReconfigured) viewer.simulationKernel?.desControl?.()?.reconfigureFromExtras?.();

  // 4. Check — id-exact, never from the cumulative counters (A1).
  await ctx.awaitPlacements();
  if (ctx.signal.aborted) throw new Error('palletYard-materialize: document changed');
  const misses: string[] = [];
  for (const p of yard.placements) {
    const node = childNamed(yardRoot, p.id);
    const t = templates.get(p.assetRef.path)!;
    if (!node) { misses.push(`${p.id} (missing)`); continue; }
    if (viewer.placements.isMaterializing(PLACEMENT_ID_PREFIX + p.id)) { misses.push(`${p.id} (still materialising)`); continue; }
    if (viewer.placements.instanceOf(node) === null) { misses.push(`${p.id} (placeholder — asset not loaded)`); continue; }
    if (!poseMatches(node, referencePose(p, t))) misses.push(`${p.id} (pose)`);
  }
  const net = getDefaultPathNetwork();
  for (const p of yard.pathGraph) if (!net.get(p.id)) misses.push(`path ${p.id}`);
  for (const v of yard.vehicles) if (!net.get(v.startPathId)) misses.push(`${v.id}: start path ${v.startPathId}`);
  for (const d of yard.downtimes ?? []) {
    const node = childNamed(yardRoot, d.id);
    if (!node) misses.push(`${d.id} (missing)`);
    else if ((rvOf(node)?.Downtime as { Enabled?: unknown } | undefined)?.Enabled === false) misses.push(`${d.id} (disabled)`);
    if (!childNamed(yardRoot, d.vehicle)) misses.push(`${d.id}: vehicle ${d.vehicle} missing`);
  }
  if (misses.length > 0) {
    throw new Error(`palletYard-materialize: size ${yard.size} incomplete — ${misses.slice(0, 8).join(', ')}${misses.length > 8 ? ` (+${misses.length - 8})` : ''}`);
  }
  return report;
}
