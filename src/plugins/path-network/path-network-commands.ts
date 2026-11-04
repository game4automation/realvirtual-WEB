// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-network-commands — the path network's commands (plan-628 Phase 3).
 *
 * Command-centred (plan-641): every action is ONE registry command, reachable
 * by agents through `web_execute` / `web_batch`; there are no separate MCP
 * tools. Every writing command runs the same pipeline (§2.6, N2/N3):
 *
 *   lock (453 `isStructuralPathEditAllowed`) → snapshot from the nodes (N8) →
 *   pure op → ONE transaction labelled `Path verb: …` whose ops are PLANNED in
 *   the document queue and re-check the lock there (`sim-locked`; an executor
 *   failure rolls back as `commit-failed`) → snap sync → `network-changed` →
 *   `resetSimulation()`.
 *
 * Undo / redo of these entries are locked and followed by the reset through
 * the visualizer's history guard (same label prefix); this module adds only
 * its own observer for the snap sync and `network-changed`.
 *
 * | Command               | Op                                    |
 * |-----------------------|---------------------------------------|
 * | `layout.path.list`    | read only                             |
 * | `layout.path.place`   | `placeBlock` (straight / curve)       |
 * | `layout.path.junction`| `placeJunction` (diverge/merge/stub)  |
 * | `layout.path.move`    | `moveBlock` (+ `chain`) / `relocateJunction` |
 * | `layout.path.remove`  | `removeBlock` / `removePaths`         |
 * | `layout.path.setParams` | `setBlockParams` (+ `chain`, 8.11d) |
 * | `layout.path.replace` | `replaceBlock` (+ `chain`, 8.11e)     |
 * | `layout.path.copy`    | read only: `copyBlocks` -> clip JSON  |
 * | `layout.path.paste`   | `pasteBlocks` (clip + rigid motion)   |
 * | `layout.path.reset`   | `resetBlockToTemplate`                |
 * | `layout.path.validate`| read only (`validatePathNetwork`)     |
 */

import {
  commandRegistry,
  CommandError,
  type CommandArgType,
  type CommandContext,
  type CommandDescriptor,
  type CommandImpl,
  type CommandRegistry,
} from '../../core/hmi/rv-command-registry';
import { getActiveEditTarget } from '../../core/hmi/rv-edit-target';
import { RvDocument } from '../../core/ops/rv-document';
import type { RvOp } from '../../core/ops/rv-unified-ops';
import { specListLength } from '../../core/engine/rv-path-edit';
import { headingOf, specEnds, PATH_BLOCK_DEFAULTS, type PathBlockKind, type PathBlockSpec } from '../../core/engine/rv-path-blocks';
import { computeStubDock, hostByRay } from '../../core/engine/rv-path-stub-dock';
import { FleetAuthoringSource } from '../../core/fleet/scene/fleet-authoring-source';
import { inSubtree, resolveStationDock } from './path-network-dock';
import { isJunctionBlock } from '../../core/engine/rv-path-block';
import {
  copyBlocks,
  isBlockEdited,
  moveBlock,
  pasteBlocks,
  placeBlock,
  placeJunction,
  relocateJunction,
  removeBlock,
  removePaths,
  replaceBlock,
  resetBlockToTemplate,
  setBlockParams,
  type BlockClip,
  type NetworkEdit,
  type NetworkEditResult,
  type NetworkInput,
} from '../../core/engine/rv-path-network-ops';
import {
  PATH_NETWORK_GROUP,
  PATH_VERB_LABEL_PREFIX,
  isStructuralPathEditAllowed,
  type StructuralEditLockView,
} from '../path-visualizer-plugin';
import { emitPathNetworkChanged as emitNetworkChanged, onPathNetworkChanged } from './path-network-signal';
import { resolvePathEnvelope, validateSceneNetwork } from './path-network-validation';
import { foldEdit, networkEditToOps, NetworkLocateError, snapshotNetwork, setFieldOp, modelRootOf, type SceneNetwork } from './path-network-scene';

// ─── Args ───────────────────────────────────────────────────────────────

export interface PathPlaceArgs {
  readonly block: 'straight' | 'curve';
  readonly lengthM?: number | null;
  readonly radiusM?: number | null;
  readonly degrees?: number | null;
  readonly side?: 'left' | 'right' | null;
  /** Attach at an end of this path (with `atEnd`); absent = free pose x/z/headingDeg. */
  readonly atPath?: string | null;
  readonly atEnd?: 'start' | 'end' | null;
  readonly x?: number | null;
  readonly z?: number | null;
  readonly y?: number | null;
  readonly headingDeg?: number | null;
}
export interface PathJunctionArgs {
  readonly kind: 'diverge' | 'merge' | 'stub';
  readonly pathId: string;
  /** Arc length in meters on `pathId`. */
  readonly s: number;
  readonly side?: 'left' | 'right' | null;
  readonly twin?: boolean | null;
  readonly radiusM?: number | null;
  readonly degrees?: number | null;
  readonly stubStraightM?: number | null;
}
export interface PathMoveArgs {
  readonly blockId: string;
  readonly dx?: number | null;
  readonly dz?: number | null;
  readonly dHeadingDeg?: number | null;
  /** Junction block: new arc length (m) on the host. */
  readonly s?: number | null;
  /** plan-628 8.8 (E35): take the downstream chain along (default false = the block alone, P6). */
  readonly chain?: boolean | null;
}
export interface PathRemoveArgs {
  /** Comma-separated block or path ids. */
  readonly ids: string;
}
export interface PathSetParamsArgs {
  readonly blockId: string;
  readonly lengthM?: number | null;
  readonly radiusM?: number | null;
  readonly degrees?: number | null;
  readonly side?: 'left' | 'right' | null;
  /** plan-628 8.11d: the downstream chain slides rigidly onto the new end (default false). */
  readonly chain?: boolean | null;
}
export interface PathReplaceArgs {
  readonly blockId: string;
  /** The replacement: a straight or a curve (same start pose). */
  readonly block: 'straight' | 'curve';
  readonly lengthM?: number | null;
  readonly radiusM?: number | null;
  readonly degrees?: number | null;
  readonly side?: 'left' | 'right' | null;
  /** plan-628 8.11e: move the downstream chain onto the new end (default false = keep it, release a non-fitting edge). */
  readonly chain?: boolean | null;
}
export interface PathCopyArgs {
  /** Comma-separated block ids. */
  readonly ids: string;
}
export interface PathPasteArgs {
  /** The clip as JSON (`layout.path.copy` -> `clip`). */
  readonly clip: string;
  /** Rigid motion: rotate about (pivotX, pivotZ) by dHeadingDeg, then translate by (dx, dz). */
  readonly dx?: number | null;
  readonly dz?: number | null;
  readonly dHeadingDeg?: number | null;
  readonly pivotX?: number | null;
  readonly pivotZ?: number | null;
}
export interface PathBlockIdArgs { readonly blockId: string }
export interface PathValidateArgs {
  /** Explicit envelope (m), used when the fleet has no vehicle (P11). */
  readonly front?: number | null;
  readonly rear?: number | null;
  readonly width?: number | null;
}

/** Issues answered at most by `layout.path.validate` (payload bound). */
const VALIDATE_MAX_ISSUES = 200;

/** What a writing command answers. */
export interface PathCommandResult {
  blockId?: string;
  createdPaths: string[];
  removedPaths: string[];
  zones: string[];
  linked: [string, string][];
  unlinked: [string, string][];
  renamedFront?: string;
  preM?: number;
  mergeSizing?: string;
  agvRewrites: { agvNode: string; pathId: string; startPositionMm: number }[];
}

// ─── Reasons ────────────────────────────────────────────────────────────

export const PATH_NO_DOCUMENT = 'No document open in the planner — open a model or layout first (web_document_open)';
export const PATH_SIM_LOCKED = 'sim-locked: stop/reset the simulation first (path edits need the reset state)';

// ─── network-changed (module signal, path-network-signal.ts) ────────────

export { onPathNetworkChanged };

// ─── Pipeline ───────────────────────────────────────────────────────────

type Viewer = CommandContext['viewer'];

function allowed(viewer: Viewer): boolean {
  return isStructuralPathEditAllowed(viewer as unknown as StructuralEditLockView);
}

/** The PLANNER's document behind the active edit target (null in the asset editor or pre-boot). */
function sceneDocument(): RvDocument | null {
  const key = getActiveEditTarget().documentKey;
  const doc = key instanceof RvDocument ? key : (key as { document?: unknown } | undefined)?.document;
  return doc instanceof RvDocument && doc.mode === 'scene' ? doc : null;
}

class PathCommit extends Error {
  constructor(readonly reason: 'sim-locked' | 'commit-failed') { super(reason); }
}

const observed = new WeakSet<RvDocument>();

/** Snap sync + `network-changed` after an undo / redo (the reset comes from the visualizer guard). */
function observe(viewer: Viewer, doc: RvDocument): void {
  if (observed.has(doc)) return;
  observed.add(doc);
  doc.onHistoryChange((c) => {
    if (c.kind !== 'undo' && c.kind !== 'redo') return;
    afterChange(viewer, false);
  });
}

function afterChange(viewer: Viewer, reset: boolean): void {
  FleetAuthoringSource.of(viewer).invalidate();
  const snaps = viewer.getPlugin?.('snap-point') as { syncPathSnaps?: () => void } | undefined;
  snaps?.syncPathSnaps?.();
  // plan-628 8.9a: the plan-633 successor check runs on `onPathChanged`, i.e. in
  // the MIDDLE of a transaction (after the unlink, before the removal — a removed
  // path fires no change), and reported "missing: <deleted path>" until the next
  // edit. One more run once the step has settled reads the final network.
  (viewer as unknown as { pathTopologyCheck?: { schedule?: () => Promise<void> } }).pathTopologyCheck?.schedule?.();
  emitNetworkChanged();
  if (reset) (viewer as unknown as { resetSimulation?: () => void }).resetSimulation?.();
  viewer.markRenderDirty?.();
}

/** Book `ops` as ONE transaction; the lock is re-checked for every op inside the queue. */
async function commit(viewer: Viewer, label: string, ops: readonly RvOp[]): Promise<void> {
  const target = getActiveEditTarget();
  const doc = sceneDocument();
  if (!target.available || !doc) throw new CommandError(PATH_NO_DOCUMENT);
  const guards = viewer.getPlugin?.('path-visualizer') as { ensureHistoryGuards?: () => void } | undefined;
  guards?.ensureHistoryGuards?.();
  observe(viewer, doc);
  try {
    await target.withTransaction(`${PATH_VERB_LABEL_PREFIX}${label}`, async () => {
      for (const op of ops) {
        const applied = await doc.applyPlanned(() => (allowed(viewer)
          ? { op, result: true }
          : { op: null, result: false }));
        if (applied === null) throw new PathCommit('commit-failed');
        if (applied === false) throw new PathCommit('sim-locked');
      }
    });
  } catch (e) {
    if (e instanceof PathCommit) {
      throw new CommandError(e.reason === 'sim-locked' ? PATH_SIM_LOCKED : 'commit-failed: nothing was written', { reason: e.reason });
    }
    console.error(`[path-network] "${label}" failed — nothing was written:`, e);
    throw new CommandError('commit-failed: nothing was written', { reason: 'commit-failed', error: e instanceof Error ? e.message : String(e) });
  }
  afterChange(viewer, true);
}

function refusal(r: NetworkEditResult): CommandError {
  return new CommandError(`${r.reason}${r.detail ? `: ${r.detail}` : ''}`, { reason: r.reason, ...(r.detail ? { detail: r.detail } : {}) });
}

function emptyResult(): PathCommandResult {
  return { createdPaths: [], removedPaths: [], zones: [], linked: [], unlinked: [], agvRewrites: [] };
}

function addResult(acc: PathCommandResult, r: NetworkEditResult): void {
  if (r.blockId) acc.blockId = r.blockId;
  acc.createdPaths.push(...r.createdPaths);
  acc.removedPaths.push(...r.edit.remove);
  acc.zones.push(...r.zones);
  acc.linked.push(...r.linked);
  acc.unlinked.push(...r.unlinked);
  if (r.edit.renamedFront) acc.renamedFront = r.edit.renamedFront;
  if (r.preM !== undefined) acc.preM = r.preM;
  if (r.mergeSizing) acc.mergeSizing = r.mergeSizing;
  acc.agvRewrites.push(...r.edit.agvRewrites.map((a) => ({ agvNode: a.agvNode, pathId: a.pathId, startPositionMm: a.startPositionMm })));
}

/**
 * Run pure op(s) on the current snapshot and commit them as ONE step. `steps`
 * get the snapshot after the previous step (multi-id remove).
 */
async function runOps(
  viewer: Viewer,
  label: string,
  steps: readonly ((net: NetworkInput) => NetworkEditResult)[],
  finalOps?: () => readonly RvOp[],
): Promise<PathCommandResult> {
  if (!allowed(viewer)) throw new CommandError(PATH_SIM_LOCKED, { reason: 'sim-locked' });
  const scene: SceneNetwork = snapshotNetwork(viewer);
  let net = scene.input;
  const ops: RvOp[] = [];
  const acc = emptyResult();
  for (const step of steps) {
    const r = step(net);
    if (!r.ok) throw refusal(r);
    try {
      ops.push(...networkEditToOps(r.edit, scene.locator));
    } catch (e) {
      if (e instanceof NetworkLocateError) throw new CommandError(`commit-failed: ${e.message}`, { reason: 'commit-failed' });
      throw e;
    }
    net = foldEdit(net, r.edit);
    addResult(acc, r);
  }
  if (finalOps) ops.push(...finalOps());
  if (ops.length > 0) await commit(viewer, label, ops);
  return acc;
}

// ─── Helpers ────────────────────────────────────────────────────────────

const has = (v: unknown): boolean => v !== undefined && v !== null && v !== '';
const num = (v: unknown): number | undefined => (has(v) && Number.isFinite(Number(v)) ? Number(v) : undefined);

function needScene(): CommandEnabledResult {
  return sceneDocument() ? true : { reason: PATH_NO_DOCUMENT };
}
type CommandEnabledResult = ReturnType<CommandImpl['enabled']>;

function lockOrScene(ctx: CommandContext): CommandEnabledResult {
  const s = needScene();
  if (s !== true) return s;
  return allowed(ctx.viewer) ? true : { reason: PATH_SIM_LOCKED };
}

function specOf(kind: PathBlockKind, a: { lengthM?: number | null; radiusM?: number | null; degrees?: number | null; side?: string | null; twin?: boolean | null; stubStraightM?: number | null }): PathBlockSpec {
  const s: PathBlockSpec = { kind };
  const l = num(a.lengthM); if (l !== undefined) s.lengthM = l;
  const r = num(a.radiusM); if (r !== undefined) s.radiusM = r;
  const d = num(a.degrees); if (d !== undefined) s.degrees = d;
  if (a.side === 'left' || a.side === 'right') s.side = a.side;
  if (a.twin === true) s.twin = true;
  const st = num(a.stubStraightM); if (st !== undefined) s.stubStraightM = st;
  return s;
}

const r4 = (v: number): number => Math.round(v * 1e4) / 1e4;

/** The read model of `layout.path.list`. */
export function listPathNetwork(viewer: Viewer): Record<string, unknown> {
  const { input } = snapshotNetwork(viewer);
  const preds = new Map<string, number>();
  for (const p of input.paths) for (const s of p.successors) preds.set(s, (preds.get(s) ?? 0) + 1);
  const blocks = (input.blocks ?? []).map((b) => ({
    id: b.id,
    kind: b.extras.kind,
    pose: b.extras.pose.map(r4),
    ...(b.extras.host !== undefined && isJunctionBlock(b.extras) ? { host: b.extras.host, hostPathId: b.extras.hostPathId } : {}),
    edited: safeEdited(input, b.id),
    paths: input.paths.filter((p) => p.block === b.id).map((p) => p.id),
    ...(b.imported ? { imported: true } : {}),
    ...(b.owner ? { owner: b.owner } : {}),
  }));
  const freePorts: { pathId: string; end: 'start' | 'end'; position: number[]; headingDeg: number }[] = [];
  const paths = input.paths.map((p) => {
    if (!p.closed) {
      const ends = specEnds(p.segments);
      if (ends) {
        if (p.successors.length === 0) freePorts.push({ pathId: p.id, end: 'end', position: ends.end.position.map(r4), headingDeg: r4(headingOf(ends.end.tangent)) });
        if (!preds.get(p.id)) freePorts.push({ pathId: p.id, end: 'start', position: ends.start.position.map(r4), headingDeg: r4(headingOf(ends.start.tangent)) });
      }
    }
    return {
      id: p.id,
      block: p.block || null,
      lengthM: r4(specListLength(p.segments)),
      ...(p.zone ? { zone: p.zone } : {}),
      successors: p.successors,
      ...(p.closed ? { closed: true } : {}),
      ...(p.imported ? { imported: true } : {}),
      ...(p.owner ? { owner: p.owner } : {}),
    };
  });
  const group = viewer.groups?.get(PATH_NETWORK_GROUP);
  return { blocks, paths, freePorts, layerVisible: group ? group.visible : null, editable: allowed(viewer) };
}


function safeEdited(net: NetworkInput, id: string): boolean {
  try { return isBlockEdited(net, id); } catch { return false; }
}

// ─── Implementations ────────────────────────────────────────────────────

const list: CommandImpl<Record<string, never>, Record<string, unknown>> = {
  enabled: () => true,
  run: (ctx) => listPathNetwork(ctx.viewer),
};

const place: CommandImpl<PathPlaceArgs, PathCommandResult> = {
  enabled: (ctx, a) => {
    if (a?.block !== 'straight' && a?.block !== 'curve') return { reason: 'block must be "straight" or "curve" (junctions: layout.path.junction)' };
    if (has(a.atPath) && a.atEnd !== 'start' && a.atEnd !== 'end') return { reason: 'atEnd must be "start" or "end" with atPath' };
    return lockOrScene(ctx);
  },
  resolveArgs: (_ctx, a) => ({ ...a, atEnd: has(a.atPath) ? (a.atEnd ?? 'end') : null }),
  run: (ctx, a) => {
    const spec = specOf(a.block, a);
    const at = has(a.atPath)
      ? { pathId: String(a.atPath), end: (a.atEnd ?? 'end') as 'start' | 'end' }
      : { x: num(a.x) ?? 0, z: num(a.z) ?? 0, headingDeg: num(a.headingDeg) ?? 0, ...(num(a.y) !== undefined ? { y: num(a.y) } : {}) };
    return runOps(ctx.viewer, `place ${a.block}`, [(net) => placeBlock(net, spec, at)]);
  },
};

const junction: CommandImpl<PathJunctionArgs, PathCommandResult> = {
  enabled: (ctx, a) => {
    if (a?.kind !== 'diverge' && a?.kind !== 'merge' && a?.kind !== 'stub') return { reason: 'kind must be "diverge", "merge" or "stub"' };
    if (!has(a.pathId)) return { reason: 'pathId is required' };
    if (num(a.s) === undefined) return { reason: 's (meters on pathId) is required' };
    return lockOrScene(ctx);
  },
  resolveArgs: (_ctx, a) => a,
  run: (ctx, a) => {
    const spec = specOf(a.kind, a);
    const side = a.side === 'left' || a.side === 'right' ? a.side : undefined;
    // P11: fleet bodies, then the Fleet design vehicle, otherwise the 1.8 m fallback.
    const { env } = resolvePathEnvelope(ctx.viewer);
    return runOps(ctx.viewer, `place ${a.kind}`, [(net) => placeJunction(net, spec, { pathId: a.pathId, s: Number(a.s), ...(side ? { side } : {}) }, env ? { env } : {})]);
  },
};

export interface PathDockArgs {
  station: string;
  pathId?: string;
  port?: string;
  radiusM?: number;
  maxDepthM?: number;
}

/** Stub role is structural: a straight branch followed by its own curved mouth. */
function isStubPath(net: NetworkInput, id: string): boolean {
  const p = net.paths.find(p => p.id === id);
  const b = net.blocks?.find(b => b.id === p?.block);
  return !!p && b?.extras.kind === 'stub' && p.segments.length === 1 && p.segments[0].kind === 'line'
    && p.successors.some(id => net.paths.some(m => m.id === id && m.block === p.block && m.segments[0]?.kind === 'arc'));
}

const dock: CommandImpl<PathDockArgs, Record<string, unknown>> = {
  enabled: (ctx, a) => has(a?.station) ? lockOrScene(ctx) : { reason: 'station is required' },
  resolveArgs: (_ctx, a) => a,
  run: async (ctx, a) => {
    const viewer = ctx.viewer;
    const station = viewer.registry?.findNodeForUser(a.station)?.node;
    const fail = (reason: string, detail?: string): never => { throw new CommandError(`${reason}${detail ? `: ${detail}` : ''}`, { reason, detail }); };
    if (!station || !Object.keys(station.userData.realvirtual ?? {}).some(k => /^TransferStation(?:_\d+)?$/.test(k))) {
      return fail('no-transfer-station');
    }
    const root = modelRootOf(viewer);
    const nodePath = viewer.registry?.getPathForNode(station);
    let editable = !!root && inSubtree(station, root);
    // Document placements can live beside the model, under the planner's layout root.
    for (let n: typeof station | null = station; !editable && n; n = n.parent) {
      const instance = viewer.placements?.instanceOf(n);
      if (instance && !instance.released && inSubtree(instance.root, viewer.scene)) editable = true;
    }
    if (!sceneDocument() || !getActiveEditTarget().available || ctx.mode === 'viewer' || viewer.modes?.activeMode === 'viewer' || !editable || !nodePath) return fail('station-not-editable');
    const resolved = resolveStationDock(viewer, station, { port: a.port });
    if ('reason' in resolved) return fail(resolved.reason, resolved.detail);
    const { env, source: envelopeSource } = resolvePathEnvelope(viewer);
    const radiusM = num(a.radiusM) ?? PATH_BLOCK_DEFAULTS.radiusM;
    const maxDepthM = num(a.maxDepthM) ?? 10;
    if (!(radiusM > 0) || !(maxDepthM > 0)) return fail('dock-internal-mismatch', 'radiusM and maxDepthM must be positive.');
    let replacedBlockId: string | undefined;
    let previousHost: string | undefined;
    let stubPathId = '';
    let geometry: Extract<ReturnType<typeof computeStubDock>, { ok: true }> | undefined;
    const result = await runOps(viewer, 'Dock stub to station', [net => {
      const previous = net.paths.find(p => p.id === String(resolved.transferStation.PathId ?? '').trim());
      if (!previous) return removePaths(net, []);
      if (!isStubPath(net, previous.id)) return fail('already-docked-foreign', previous.id);
      const block = net.blocks!.find(b => b.id === previous.block)!;
      replacedBlockId = block.id;
      previousHost = block.extras.hostPathId;
      return removeBlock(net, block.id);
    }, net => {
      let hostId = a.pathId || previousHost;
      if (!hostId) {
        const hit = hostByRay(net.paths, resolved.seat, resolved.portDir, maxDepthM);
        if ('reason' in hit) return fail(hit.reason);
        hostId = hit.pathId;
      }
      const host = net.paths.find(p => p.id === hostId);
      if (!host) return fail('dock-no-host', hostId);
      const computed = computeStubDock({ host, seat: resolved.seat, portDir: resolved.portDir,
        loadOffsetM: resolved.loadOffset.mm / 1000, radiusM });
      if (!computed.ok) return fail(computed.reason, computed.detail);
      geometry = computed;
      const placed = placeJunction(net, { kind: 'stub', radiusM, stubStraightM: computed.stubStraightM, side: computed.side },
        { pathId: hostId, s: computed.s, side: computed.side }, env ? { env } : {});
      if (placed.ok) {
        const after = foldEdit(net, placed.edit);
        stubPathId = placed.edit.add.find(p => p.block === placed.blockId && isStubPath(after, p.id))?.id ?? '';
        if (!stubPathId) return fail('dock-internal-mismatch', 'The junction produced no stub.');
      }
      return placed;
    }], () => [
      setFieldOp(nodePath, resolved.componentType, 'PathId', stubPathId, resolved.transferStation.PathId),
      setFieldOp(nodePath, resolved.componentType, 'DockPort', resolved.port.object3D.name, resolved.transferStation.DockPort),
    ]);
    const warnings = resolved.loadOffset.issues.map(i => i.code.replace(/^fleet-/, ''));
    if (env && geometry!.stubStraightM < env.front + env.rear) warnings.push('stub-shorter-than-body');
    return { blockId: result.blockId, stubPathId, hostPathId: geometry!.pathId, s: geometry!.s, side: geometry!.side,
      stubStraightM: geometry!.stubStraightM, dockPort: resolved.port.object3D.name,
      ...(replacedBlockId ? { replacedBlockId } : {}), loadOffsetMm: resolved.loadOffset.mm,
      loadOffsetSource: resolved.loadOffset.source, envelopeSource, ...(warnings.length ? { warnings } : {}) };
  },
};

const move: CommandImpl<PathMoveArgs, PathCommandResult> = {
  enabled: (ctx, a) => {
    if (!has(a?.blockId)) return { reason: 'blockId is required' };
    if (!has(a.s) && !has(a.dx) && !has(a.dz) && !has(a.dHeadingDeg)) return { reason: 'pass dx/dz/dHeadingDeg (block) or s (junction)' };
    return lockOrScene(ctx);
  },
  resolveArgs: (_ctx, a) => a,
  run: (ctx, a) => runOps(ctx.viewer, `move ${a.blockId}`, [(net) => {
    const b = (net.blocks ?? []).find((x) => x.id === a.blockId);
    if (b && isJunctionBlock(b.extras)) {
      const s = num(a.s);
      if (s === undefined) throw new CommandError(`${a.blockId} is a junction — pass s (meters on its host)`);
      return relocateJunction(net, a.blockId, s);
    }
    const pivot: [number, number] = b ? [b.extras.pose[0], b.extras.pose[1]] : [0, 0];
    return moveBlock(net, a.blockId, { dx: num(a.dx) ?? 0, dz: num(a.dz) ?? 0, dHeadingDeg: num(a.dHeadingDeg) ?? 0, pivot }, { chain: a.chain === true });
  }]),
};

const splitIds = (s: unknown): string[] => String(s ?? '').split(',').map((x) => x.trim()).filter(Boolean);

const remove: CommandImpl<PathRemoveArgs, PathCommandResult> = {
  enabled: (ctx, a) => (splitIds(a?.ids).length === 0 ? { reason: 'ids is required (comma-separated block or path ids)' } : lockOrScene(ctx)),
  resolveArgs: (_ctx, a) => ({ ids: splitIds(a.ids).join(',') }),
  run: (ctx, a) => {
    const ids = splitIds(a.ids);
    const { input } = snapshotNetwork(ctx.viewer);
    const blockIds = ids.filter((id) => (input.blocks ?? []).some((b) => b.id === id));
    const pathIds = ids.filter((id) => !blockIds.includes(id));
    // plan-628 8.9a: a multi-block delete (selection, chain) may name a junction
    // whose host was removed by an earlier step — the host removal already healed
    // it away, so that step is an empty edit, not an unknown-block refusal.
    const steps: ((net: NetworkInput) => NetworkEditResult)[] = blockIds.map((id) => (net: NetworkInput) => (
      (net.blocks ?? []).some((b) => b.id === id) ? removeBlock(net, id) : removePaths(net, [])
    ));
    if (pathIds.length > 0) {
      steps.push((net) => removePaths(net, blockIds.length ? pathIds.filter((id) => net.paths.some((p) => p.id === id)) : pathIds));
    }
    return runOps(ctx.viewer, `remove ${ids.join(', ')}`, steps);
  },
};

const setParams: CommandImpl<PathSetParamsArgs, PathCommandResult> = {
  enabled: (ctx, a) => (has(a?.blockId) ? lockOrScene(ctx) : { reason: 'blockId is required' }),
  resolveArgs: (_ctx, a) => a,
  run: (ctx, a) => {
    const p: Omit<PathBlockSpec, 'kind'> = {};
    const l = num(a.lengthM); if (l !== undefined) p.lengthM = l;
    const r = num(a.radiusM); if (r !== undefined) p.radiusM = r;
    const d = num(a.degrees); if (d !== undefined) p.degrees = d;
    if (a.side === 'left' || a.side === 'right') p.side = a.side;
    return runOps(ctx.viewer, `set params ${a.blockId}`, [(net) => setBlockParams(net, a.blockId, p, { chain: a.chain === true })]);
  },
};

const replace: CommandImpl<PathReplaceArgs, PathCommandResult> = {
  enabled: (ctx, a) => {
    if (!has(a?.blockId)) return { reason: 'blockId is required' };
    if (a.block !== 'straight' && a.block !== 'curve') return { reason: 'block must be "straight" or "curve"' };
    return lockOrScene(ctx);
  },
  resolveArgs: (_ctx, a) => a,
  run: (ctx, a) => runOps(ctx.viewer, `replace ${a.blockId} with ${a.block}`, [(net) => replaceBlock(net, a.blockId, specOf(a.block, a), { chain: a.chain === true })]),
};

const copy: CommandImpl<PathCopyArgs, { clip: string; blocks: number; skipped?: string[] }> = {
  enabled: (_ctx, a) => (splitIds(a?.ids).length === 0 ? { reason: 'ids is required (comma-separated block ids)' } : true),
  run: (ctx, a) => {
    const ids = splitIds(a.ids);
    const clip = copyBlocks(snapshotNetwork(ctx.viewer).input, ids);
    // plan-628 8.6 (E82): junction, generated and unknown ids are skipped — named here, never silent.
    const copied = new Set(clip.blocks.map((b) => b.id));
    const skipped = ids.filter((id) => !copied.has(id));
    return { clip: JSON.stringify(clip), blocks: clip.blocks.length, ...(skipped.length ? { skipped } : {}) };
  },
};

/** Parse a clip argument (JSON of {@link BlockClip}); null when it is not one. */
function parseClip(raw: unknown): BlockClip | null {
  try {
    const c = (typeof raw === 'string' ? JSON.parse(raw) : raw) as BlockClip;
    return c && Array.isArray(c.blocks) ? c : null;
  } catch {
    return null;
  }
}

const paste: CommandImpl<PathPasteArgs, PathCommandResult & { blockIds: string[] }> = {
  enabled: (ctx, a) => (parseClip(a?.clip) ? lockOrScene(ctx) : { reason: 'clip is required (the JSON of layout.path.copy)' }),
  resolveArgs: (_ctx, a) => a,
  run: async (ctx, a) => {
    const clip = parseClip(a.clip)!;
    const motion = { dx: num(a.dx) ?? 0, dz: num(a.dz) ?? 0, dHeadingDeg: num(a.dHeadingDeg) ?? 0, pivot: [num(a.pivotX) ?? 0, num(a.pivotZ) ?? 0] as [number, number] };
    let blockIds: string[] = [];
    const res = await runOps(ctx.viewer, `paste ${clip.blocks.length} block${clip.blocks.length === 1 ? '' : 's'}`, [(net) => {
      const r = pasteBlocks(net, clip, motion);
      blockIds = r.blockIds;
      return r;
    }]);
    return { ...res, blockIds };
  },
};

const reset: CommandImpl<PathBlockIdArgs, PathCommandResult> = {
  enabled: (ctx, a) => (has(a?.blockId) ? lockOrScene(ctx) : { reason: 'blockId is required' }),
  resolveArgs: (_ctx, a) => a,
  run: (ctx, a) => runOps(ctx.viewer, `reset ${a.blockId}`, [(net) => resetBlockToTemplate(net, a.blockId)]),
};

const validate: CommandImpl<PathValidateArgs, Record<string, unknown>> = {
  enabled: () => true,
  run: (ctx, a) => {
    const front = num(a?.front), rear = num(a?.rear), width = num(a?.width);
    const explicit = front !== undefined || width !== undefined
      ? { front: front ?? 0, rear: rear ?? 0, width: width ?? 0 }
      : null;
    const res = validateSceneNetwork(ctx.viewer, explicit);
    const counts: Record<string, number> = {};
    for (const i of res.issues) counts[i.severity] = (counts[i.severity] ?? 0) + 1;
    return {
      issues: res.issues.slice(0, VALIDATE_MAX_ISSUES).map((i) => ({
        code: i.code, severity: i.severity,
        ...(i.pathId ? { pathId: i.pathId } : {}),
        ...(i.blockId ? { blockId: i.blockId } : {}),
        ...(i.position ? { position: i.position.map(r4) } : {}),
        detail: i.detail,
      })),
      counts,
      ...(res.issues.length > VALIDATE_MAX_ISSUES ? { truncated: res.issues.length } : {}),
      envelope: res.envelope,
      envelopeSource: res.envelopeSource,
      skipped: res.skipped,
    };
  },
};

// ─── Descriptors ────────────────────────────────────────────────────────

interface Spec {
  readonly id: string;
  readonly label: string;
  readonly readOnly: boolean;
  readonly destructive?: boolean;
  readonly argsSchema: Readonly<Record<string, CommandArgType>>;
  readonly impl: CommandImpl<never, unknown>;
}

const SHAPE = { lengthM: 'number', radiusM: 'number', degrees: 'number', side: 'string' } as const;

const SPECS: readonly Spec[] = [
  {
    id: 'layout.path.dock', label: 'Dock stub to station', readOnly: false,
    argsSchema: { station: 'string', pathId: 'string', port: 'string', radiusM: 'number', maxDepthM: 'number' },
    impl: dock as CommandImpl<never, unknown>,
  },
  { id: 'layout.path.list', label: 'List path network', readOnly: true, argsSchema: {}, impl: list as CommandImpl<never, unknown> },
  {
    id: 'layout.path.place', label: 'Place path block', readOnly: false,
    argsSchema: { block: 'string', ...SHAPE, atPath: 'string', atEnd: 'string', x: 'number', z: 'number', y: 'number', headingDeg: 'number' },
    impl: place as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.path.junction', label: 'Place path junction', readOnly: false,
    argsSchema: { kind: 'string', pathId: 'string', s: 'number', side: 'string', twin: 'boolean', radiusM: 'number', degrees: 'number', stubStraightM: 'number' },
    impl: junction as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.path.move', label: 'Move path block', readOnly: false,
    argsSchema: { blockId: 'string', dx: 'number', dz: 'number', dHeadingDeg: 'number', s: 'number', chain: 'boolean' },
    impl: move as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.path.remove', label: 'Remove path blocks', readOnly: false, destructive: true,
    argsSchema: { ids: 'string' }, impl: remove as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.path.setParams', label: 'Set path block parameters', readOnly: false,
    argsSchema: { blockId: 'string', ...SHAPE, chain: 'boolean' }, impl: setParams as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.path.replace', label: 'Replace path block', readOnly: false,
    argsSchema: { blockId: 'string', block: 'string', ...SHAPE, chain: 'boolean' }, impl: replace as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.path.copy', label: 'Copy path blocks', readOnly: true,
    argsSchema: { ids: 'string' }, impl: copy as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.path.paste', label: 'Paste path blocks', readOnly: false,
    argsSchema: { clip: 'string', dx: 'number', dz: 'number', dHeadingDeg: 'number', pivotX: 'number', pivotZ: 'number' },
    impl: paste as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.path.reset', label: 'Reset path block to template', readOnly: false,
    argsSchema: { blockId: 'string' }, impl: reset as CommandImpl<never, unknown>,
  },
  {
    id: 'layout.path.validate', label: 'Validate path network', readOnly: true,
    argsSchema: { front: 'number', rear: 'number', width: 'number' }, impl: validate as CommandImpl<never, unknown>,
  },
];

/** Every path-network command id. */
export const PATH_NETWORK_COMMAND_IDS: readonly string[] = SPECS.map((s) => s.id);

/** Build the descriptors (testable seam: no registry side effect). */
export function createPathNetworkCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return SPECS.map((s): CommandDescriptor<never, unknown> => ({
    id: s.id,
    label: s.label,
    readOnly: s.readOnly,
    ...(s.destructive ? { destructive: true } : {}),
    ...(s.readOnly ? {} : { undoLabel: `${PATH_VERB_LABEL_PREFIX}${s.label}`, macro: true }),
    scope: 'none',
    available: true,
    unavailableReason: PATH_NO_DOCUMENT,
    argsSchema: s.argsSchema,
    eagerImpl: s.impl,
    impl: () => Promise.resolve(s.impl),
  }));
}

const registered = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the path-network commands. */
export function ensurePathNetworkCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createPathNetworkCommandDescriptors()) registry.register(d);
}

/** Exposed for tests: the pure edit list a command would book (no commit). */
export type { NetworkEdit };
