// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-path-network-ops.ts — pure topology ops of the path-network building kit
 * (plan-628 Phase 2: P4–P8, §2.4, §2.4a, SOL-R2 #2, R1 #4).
 *
 * Every op takes a snapshot of the network ({@link NetworkInput}: the path
 * nodes, the `PathBlock` nodes, the vehicles' resolved start addresses) and
 * returns a {@link NetworkEditResult}. Nothing is mutated; the caller (Phase 3
 * commands) translates the {@link NetworkEdit} 1:1 into ONE scene transaction
 * (`addNode` / `setField` / `removeNode`).
 *
 * How an op works: it edits a private working copy of the graph, then the
 * edit is the DIFF between snapshot and working copy. Consequences that hold
 * for every op without per-op bookkeeping:
 *   - an id that exists before and after is a `set` (never remove + add, so a
 *     relocated junction keeps its nodes — plan-628 N9);
 *   - a removed node that was not added by the editor (`imported`) rejects the
 *     WHOLE op before any change (`'imported-path'`, P7 / Thomas 2026-10-19);
 *   - a changed id that occurs twice in the snapshot rejects (`'id-collision'`,
 *     P4 — the 559 reporter owns the message, 628 only refuses to touch it);
 *   - the path network is ALWAYS tangential (plan-628 8.10, E52): an edge the
 *     op writes (new, or with an end that changed) must continue under
 *     `isPathLink` (≤ 5 mm, ≤ 2°). A violation rejects the whole op
 *     (`'not-tangential'`) — or, for a move, is released in the same edit
 *     ({@link KinkPolicy}). An edge that already had the same non-tangential
 *     geometry in the snapshot (loaded / foreign data, redirected unchanged) is
 *     inherited, not written; `path-kink` stays the guard for such data.
 *
 * The graph is built from the path NODES (plan-628 N8), not from
 * `RVPathNetwork.all()`, which keeps only the last path per id.
 *
 * Auto-link (P5, plan-633): END(A) → START(B) under `isPathLink` /
 * `PATH_LINK_TOLERANCE` — never start/start or end/end; paths with
 * `connectCheck === false` are never auto-linked. Existing successors are never
 * removed, except when their target is removed and the port edges of a moved
 * block (P6).
 */

import { Vector3 } from 'three';
import { isPathLink, PATH_LINK_TOLERANCE } from '../connect/path-link-tolerance';
import { findShortMergeEntries, type BodyEnvelope } from './rv-movement-authority';
import type { PathSegmentSpec } from './rv-path';
import { parsePathExtras } from './rv-path';
import { cloneSegmentSpecs, specListLength, MIN_PIECE_M } from './rv-path-edit';
import { RVPathNetwork } from './rv-path-network';
import {
  JUNCTION_KINDS,
  MERGE_OUT_M,
  MERGE_PRE_FALLBACK_M,
  MERGE_PRE_MAX_STEPS,
  MERGE_PRE_MIN_M,
  PN_PREFIX,
  applyRigidToPose,
  applyRigidXZ,
  blockTemplate,
  coalesceSpecs,
  cutSpecs,
  headingOf,
  nextFreeIndex,
  poseAtArcLength,
  poseForPort,
  resolveBlockParams,
  sameGeometry,
  specEnds,
  endFollowMotion,
  transformSpecs,
  type BlockPiece,
  type BlockPose,
  type PathBlockSpec,
  type RigidXZ,
} from './rv-path-blocks';
import { makePathBlockExtras, pathBlockTemplate, type PathBlockExtras } from './rv-path-block';

// ─── Snapshot types ──────────────────────────────────────────────────────

/** One path node of the network, mirrored from its `rv_extras.Path` (pure data). */
export interface PathGraphEntry {
  id: string;
  /** Node name (P4: generated ids must be free over ids AND node names). */
  nodeName: string;
  /** Node name of the owning `PathBlock` node; '' = block-free path. */
  block: string;
  segments: PathSegmentSpec[];
  successors: string[];
  zone?: string;
  zoneCapacity?: number;
  closed?: boolean;
  /** `connectCheck === false` opts the path out of the auto-link (plan-633). */
  connectCheck?: boolean;
  /** True when the node was NOT added by the editor (no `__rvAdded`) — it cannot be removed. */
  imported?: boolean;
  /**
   * plan-628 8.6 / plan-681: owner of generated content (`extras.realvirtual.Generated.owner`,
   * e.g. 'palletYard'). Composition-owned entries are read-only for every op ('composition-owned').
   */
  owner?: string;
}

/** One `PathBlock` node. */
export interface BlockEntry {
  /** Node name `PN_Block_<n>`. */
  id: string;
  extras: PathBlockExtras;
  /** True when the node was not added by the editor. */
  imported?: boolean;
  /** plan-628 8.6 / plan-681: owner of generated content — read-only for every op ('composition-owned'). */
  owner?: string;
  /** False when the node transform is not the identity (invariant §2.3). Default true. */
  transformIdentity?: boolean;
}

/** A vehicle's RESOLVED start address (Fleet handle: `startPathId` + `StartPosition`). */
export interface VehicleStart {
  agvNode: string;
  pathId: string;
  startPositionMm: number;
}

/** The snapshot an op works on. */
export interface NetworkInput {
  paths: readonly PathGraphEntry[];
  blocks?: readonly BlockEntry[];
  vehicles?: readonly VehicleStart[];
  /** Further taken node names (anything else in the document) — P4. */
  takenNames?: readonly string[];
  /** False when the `PathNetwork` node transform is not the identity. Default true. */
  rootTransformIdentity?: boolean;
}

// ─── Result types ────────────────────────────────────────────────────────

/** Path fields an edit writes. */
export type PathEditField = 'segments' | 'successors' | 'zone' | 'zoneCapacity';

/** One field write with its previous value (undo). */
export interface PathFieldSet {
  id: string;
  field: PathEditField;
  value: unknown;
  prev: unknown;
}

/** An Agv whose start address is rewritten in the same transaction (SOL-R2 #2). */
export interface AgvRewrite {
  agvNode: string;
  pathId: string;
  startPositionMm: number;
  prevPathId: string;
  prevStartPositionMm: number;
}

/** The edit, translated 1:1 into one transaction by the caller (plan §2.3). */
export interface NetworkEdit {
  /** New `PathBlock` nodes — add BEFORE their child paths. */
  addBlocks: BlockEntry[];
  /** New path nodes (`addNode` under their `block`, or under `PathNetwork`). */
  add: PathGraphEntry[];
  set: PathFieldSet[];
  setBlocks: { id: string; value: PathBlockExtras; prev: PathBlockExtras }[];
  /** Removed path ids — remove BEFORE `removeBlocks`. */
  remove: string[];
  removeBlocks: string[];
  agvRewrites: AgvRewrite[];
  /** P7: id of the new front fragment of a split host (scripts may address the old id). */
  renamedFront?: string;
}

/** Why an op refused — before any change. */
export type NetworkRejectReason =
  | 'unknown-path'
  | 'unknown-block'
  | 'wrong-kind'
  | 'invalid-link'
  | 'imported-path'
  | 'vehicle-on-removed-path'
  | 'host-too-short'
  | 'closed-host'
  | 'id-collision'
  | 'transform-not-identity'
  | 'block-edited'
  | 'has-hosted-junctions'
  | 'path-in-block'
  | 'not-healable'
  /** plan-628 8.10 (E52): the op would write an edge that is not tangential (> 2°) or not coincident (> 5 mm). */
  | 'not-tangential'
  /** plan-628 8.6 (Thomas 2026-10-25, plan-681): the op would change or remove generated (composition-owned) content. */
  | 'composition-owned';

/** What the op runner does with an edge an op would write non-tangentially (plan-628 8.10). */
export type KinkPolicy = 'reject' | 'release';

/** Human text of the `not-tangential` refusal (command error detail, toast). */
export const NOT_TANGENTIAL_TEXT = 'the path network is always tangential — this would connect paths with a kink or a gap';

/** Human text of the `composition-owned` refusal (command error detail, toast). */
export const COMPOSITION_OWNED_TEXT = 'generated content is read-only — change it through its generator (e.g. the PalletYard size); add your own blocks next to it';

/** How the merge lead-in was sized (P8/P11). */
export type MergeSizing = 'sized' | 'skipped' | 'unresolved';

/** Result of every op. On refusal `edit` is empty. */
export interface NetworkEditResult {
  ok: boolean;
  reason?: NetworkRejectReason;
  detail?: string;
  edit: NetworkEdit;
  /** Created block node name (place / junction). */
  blockId?: string;
  /** Created path ids, in creation order. */
  createdPaths: string[];
  /** Created zone ids. */
  zones: string[];
  /** Successor edges added / removed, `[from, to]`, sorted. */
  linked: [string, string][];
  unlinked: [string, string][];
  /** Junctions: the lead-in in meters and how it was sized. */
  preM?: number;
  mergeSizing?: MergeSizing;
}

/** A free placement (no port): pose of the block origin. */
export interface FreePose {
  x: number;
  z: number;
  headingDeg: number;
  y?: number;
}

/** A path end: `end` = the END (out) port, `start` = the START (in) port. */
export type PortRef = { pathId: string; end: 'start' | 'end' };

/** Where a junction goes: arc length `s` (m) on `pathId`, branch/stub `side`. */
export interface JunctionTarget {
  pathId: string;
  s: number;
  side?: 'left' | 'right';
}

/** Options of the junction ops. */
export interface JunctionOptions {
  /** Body envelope for the lead-in sizing (fleet > explicit, P11). Absent = fallback 1.8 m. */
  env?: BodyEnvelope;
}

// ─── Internals ───────────────────────────────────────────────────────────

class Reject extends Error {
  constructor(readonly reason: NetworkRejectReason, readonly detail?: string) {
    super(reason);
  }
}

function emptyEdit(): NetworkEdit {
  return { addBlocks: [], add: [], set: [], setBlocks: [], remove: [], removeBlocks: [], agvRewrites: [] };
}

function cloneEntry(e: PathGraphEntry): PathGraphEntry {
  const c: PathGraphEntry = {
    id: e.id,
    nodeName: e.nodeName,
    block: e.block ?? '',
    segments: cloneSegmentSpecs(e.segments),
    successors: [...e.successors],
  };
  if (e.zone !== undefined) c.zone = e.zone;
  if (e.zoneCapacity !== undefined) c.zoneCapacity = e.zoneCapacity;
  if (e.closed !== undefined) c.closed = e.closed;
  if (e.connectCheck !== undefined) c.connectCheck = e.connectCheck;
  if (e.imported !== undefined) c.imported = e.imported;
  if (e.owner !== undefined) c.owner = e.owner;
  return c;
}

function cloneExtras(x: PathBlockExtras): PathBlockExtras {
  return JSON.parse(JSON.stringify(x)) as PathBlockExtras;
}

function cloneBlock(b: BlockEntry): BlockEntry {
  const c: BlockEntry = { id: b.id, extras: cloneExtras(b.extras) };
  if (b.imported !== undefined) c.imported = b.imported;
  if (b.owner !== undefined) c.owner = b.owner;
  if (b.transformIdentity !== undefined) c.transformIdentity = b.transformIdentity;
  return c;
}

const eqJson = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);

/** A tracked vehicle start (meters on its current path). */
interface Tracker {
  agvNode: string;
  origPathId: string;
  origS: number;
  pathId: string;
  s: number;
}

/** Mutable working copy of the graph. */
class WorkGraph {
  readonly paths = new Map<string, PathGraphEntry>();
  readonly blocks = new Map<string, BlockEntry>();
  readonly taken = new Set<string>();
  readonly duplicates = new Set<string>();
  readonly trackers: Tracker[] = [];
  readonly createdPaths: string[] = [];
  /** Paths whose geometry changed by a rigid move (for the explicit Agv address). */
  readonly touched = new Set<string>();
  /** Healed pieces → the surviving path they were merged into. */
  readonly mergedInto = new Map<string, string>();

  constructor(net: NetworkInput) {
    for (const p of net.paths) {
      if (this.paths.has(p.id)) this.duplicates.add(p.id);
      else this.paths.set(p.id, cloneEntry(p));
      this.taken.add(p.id);
      this.taken.add(p.nodeName);
      if (p.zone) this.taken.add(p.zone);
    }
    for (const b of net.blocks ?? []) {
      this.blocks.set(b.id, cloneBlock(b));
      this.taken.add(b.id);
    }
    for (const n of net.takenNames ?? []) this.taken.add(n);
    for (const v of net.vehicles ?? []) {
      if (!this.paths.has(v.pathId)) continue;
      const s = (Number.isFinite(v.startPositionMm) ? v.startPositionMm : 0) / 1000;
      this.trackers.push({ agvNode: v.agvNode, origPathId: v.pathId, origS: s, pathId: v.pathId, s });
    }
  }

  path(id: string): PathGraphEntry {
    const p = this.paths.get(id);
    if (!p) throw new Reject('unknown-path', id);
    if (this.duplicates.has(id)) throw new Reject('id-collision', id);
    return p;
  }

  block(id: string): BlockEntry {
    const b = this.blocks.get(id);
    if (!b) throw new Reject('unknown-block', id);
    return b;
  }

  claimIndex(prefix: string, suffixes: readonly string[] = ['']): number {
    const n = nextFreeIndex(prefix, this.taken, suffixes);
    for (const s of suffixes) this.taken.add(`${prefix}${n}${s}`);
    return n;
  }

  claimId(prefix: string): string {
    return `${prefix}${this.claimIndex(prefix)}`;
  }

  addPath(e: PathGraphEntry): void {
    if (this.paths.has(e.id)) throw new Reject('id-collision', e.id);
    this.paths.set(e.id, e);
    this.taken.add(e.id);
    this.createdPaths.push(e.id);
  }

  /** Remove a path and every reference to it. A vehicle starting on it rejects. */
  removePath(id: string): void {
    if (!this.paths.delete(id)) return;
    if (this.trackers.some((t) => t.pathId === id)) throw new Reject('vehicle-on-removed-path', id);
    for (const q of this.paths.values()) {
      if (q.successors.includes(id)) q.successors = q.successors.filter((s) => s !== id);
    }
  }

  /** Point every predecessor of `from` (except `except`) at `to` instead. */
  redirectPredecessors(from: string, to: string, except: ReadonlySet<string>): void {
    for (const q of this.paths.values()) {
      if (except.has(q.id)) continue;
      const i = q.successors.indexOf(from);
      if (i < 0) continue;
      const next = q.successors.filter((s) => s !== from);
      if (!next.includes(to)) next.splice(i, 0, to);
      q.successors = next;
    }
  }

  /** Vehicles on `id` at arc length s move to the fragment covering s (ranges `[a, b)`, last inclusive). */
  remapSplit(id: string, fragments: readonly { id: string; a: number; b: number }[]): void {
    for (const t of this.trackers) {
      if (t.pathId !== id) continue;
      let f = fragments[fragments.length - 1];
      for (const fr of fragments) {
        if (t.s < fr.b - 1e-12) { f = fr; break; }
      }
      t.pathId = f.id;
      t.s = Math.max(0, t.s - f.a);
    }
  }

  /** Vehicles on any of `pieces` (with offsets) move onto `into`. */
  remapMerge(pieces: readonly { id: string; offset: number }[], into: string): void {
    for (const t of this.trackers) {
      const p = pieces.find((x) => x.id === t.pathId);
      if (!p) continue;
      t.pathId = into;
      t.s = t.s + p.offset;
    }
  }
}

/** World ends of an entry (cached per call through `specEnds`). */
function endsOf(e: PathGraphEntry): ReturnType<typeof specEnds> {
  if (e.closed) return null;
  return specEnds(e.segments);
}

const v3 = (t: readonly number[]): Vector3 => new Vector3(t[0], t[1], t[2]);

/** P5 auto-link: add END(a) → START(b) for every pair under the tolerance where a or b is in `touched`. */
function autoLink(w: WorkGraph, touched: ReadonlySet<string>): void {
  const all = [...w.paths.values()].filter((p) => !p.closed && p.connectCheck !== false && p.segments.length > 0);
  const ends = new Map(all.map((p) => [p.id, endsOf(p)]));
  for (const a of all) {
    const ea = ends.get(a.id);
    if (!ea) continue;
    for (const b of all) {
      if (a.id === b.id) continue;
      if (!touched.has(a.id) && !touched.has(b.id)) continue;
      if (a.successors.includes(b.id)) continue;
      const eb = ends.get(b.id);
      if (!eb) continue;
      if (isPathLink(v3(ea.end.position), v3(ea.end.tangent), v3(eb.start.position), v3(eb.start.tangent))) {
        a.successors = [...a.successors, b.id];
      }
    }
  }
}

/** True when END(a) continues into START(b) under the shared tolerance. */
function continues(a: PathGraphEntry, b: PathGraphEntry): boolean {
  const ea = specEnds(a.segments);
  const eb = specEnds(b.segments);
  if (!ea || !eb) return false;
  return isPathLink(v3(ea.end.position), v3(ea.end.tangent), v3(eb.start.position), v3(eb.start.tangent));
}

/** Front id for a split host: `PN_S<n>` / `PN_C<n>` for catalog pieces, else `<host>_F<k>` (P7). */
function frontIdFor(w: WorkGraph, hostId: string): string {
  const m = /^(PN_[SC])\d+$/.exec(hostId);
  if (m) return w.claimId(m[1]);
  return w.claimId(`${hostId}_F`);
}

function newEntry(id: string, block: string, segments: PathSegmentSpec[], successors: string[] = []): PathGraphEntry {
  return { id, nodeName: id, block, segments, successors };
}

/** plan-628 8.6: refuse any write to a composition-owned (generated) entry. */
function refuseOwned(e: { id: string; owner?: string } | undefined): void {
  if (e?.owner) throw new Reject('composition-owned', `${e.id} (owner ${e.owner}): ${COMPOSITION_OWNED_TEXT}`);
}

/** A block an op is about to change: refused up front when composition-owned (clear reason first). */
function writableBlock(w: WorkGraph, blockId: string): BlockEntry {
  const b = w.block(blockId);
  refuseOwned(b);
  return b;
}

/** Rebuild the result as the diff snapshot → working copy. */
function diff(net: NetworkInput, w: WorkGraph): NetworkEdit {
  const edit = emptyEdit();
  const before = new Map<string, PathGraphEntry>();
  for (const p of net.paths) if (!before.has(p.id)) before.set(p.id, p);
  const beforeBlocks = new Map((net.blocks ?? []).map((b) => [b.id, b]));
  // plan-628 8.6: generated (composition-owned) content is never written — one guard for every op.
  const owned = refuseOwned;

  for (const b of w.blocks.values()) {
    const prev = beforeBlocks.get(b.id);
    if (!prev) edit.addBlocks.push(cloneBlock(b));
    else if (!eqJson(prev.extras, b.extras)) {
      owned(prev);
      edit.setBlocks.push({ id: b.id, value: cloneExtras(b.extras), prev: cloneExtras(prev.extras) });
    }
  }
  for (const id of beforeBlocks.keys()) {
    if (w.blocks.has(id)) continue;
    owned(beforeBlocks.get(id));
    if (beforeBlocks.get(id)!.imported) throw new Reject('imported-path', id);
    edit.removeBlocks.push(id);
  }

  for (const p of w.paths.values()) {
    const prev = before.get(p.id);
    if (!prev) {
      edit.add.push(cloneEntry(p));
      continue;
    }
    const fields: [PathEditField, unknown, unknown][] = [
      ['segments', p.segments, prev.segments],
      ['successors', p.successors, prev.successors],
      ['zone', p.zone, prev.zone],
      ['zoneCapacity', p.zoneCapacity, prev.zoneCapacity],
    ];
    for (const [field, value, old] of fields) {
      if (eqJson(value ?? null, old ?? null)) continue;
      owned(prev);
      if (w.duplicates.has(p.id)) throw new Reject('id-collision', p.id);
      edit.set.push({
        id: p.id,
        field,
        value: value === undefined ? null : JSON.parse(JSON.stringify(value)),
        prev: old === undefined ? null : JSON.parse(JSON.stringify(old)),
      });
    }
  }
  for (const [id, prev] of before) {
    if (w.paths.has(id)) continue;
    owned(prev);
    if (prev.imported) throw new Reject('imported-path', id);
    if (w.duplicates.has(id)) throw new Reject('id-collision', id);
    edit.remove.push(id);
  }

  const changed = new Set<string>([...edit.set.map((s) => s.id), ...edit.remove, ...w.touched]);
  for (const t of w.trackers) {
    if (t.pathId === t.origPathId && Math.abs(t.s - t.origS) < 1e-12 && !changed.has(t.origPathId)) continue;
    edit.agvRewrites.push({
      agvNode: t.agvNode,
      pathId: t.pathId,
      startPositionMm: Math.round(t.s * 1000 * 1e6) / 1e6,
      prevPathId: t.origPathId,
      prevStartPositionMm: Math.round(t.origS * 1000 * 1e6) / 1e6,
    });
  }
  edit.set.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : a.field < b.field ? -1 : a.field > b.field ? 1 : 0));
  edit.setBlocks.sort((a, b) => (a.id < b.id ? -1 : 1));
  edit.remove.sort();
  edit.removeBlocks.sort();
  edit.agvRewrites.sort((a, b) => (a.agvNode < b.agvNode ? -1 : 1));
  return edit;
}

function edges(paths: Iterable<PathGraphEntry>): Set<string> {
  const out = new Set<string>();
  for (const p of paths) for (const s of p.successors) out.add(`${p.id}\u0000${s}`);
  return out;
}

function edgeList(set: Iterable<string>): [string, string][] {
  return [...set].sort().map((k) => k.split('\u0000') as [string, string]);
}

/** Run an op on a working copy and turn the outcome into a result. */
function run(
  net: NetworkInput,
  op: (w: WorkGraph) => Partial<Pick<NetworkEditResult, 'blockId' | 'preM' | 'mergeSizing'>> & { renamedFront?: string } | void,
  kinks: KinkPolicy = 'reject',
): NetworkEditResult {
  const fail = (e: Reject): NetworkEditResult => ({
    ok: false, reason: e.reason, detail: e.detail, edit: emptyEdit(), createdPaths: [], zones: [], linked: [], unlinked: [],
  });
  try {
    const w = new WorkGraph(net);
    const extra = op(w) || {};
    enforceTangential(net, w, kinks);
    const edit = diff(net, w);
    if (extra.renamedFront) edit.renamedFront = extra.renamedFront;
    const e0 = edges(net.paths);
    const e1 = edges(w.paths.values());
    const zonesBefore = new Set(net.paths.map((p) => p.zone).filter((z): z is string => !!z));
    const zones = [...new Set([...w.paths.values()].map((p) => p.zone).filter((z): z is string => !!z && !zonesBefore.has(z)))].sort();
    return {
      ok: true,
      edit,
      blockId: extra.blockId,
      createdPaths: w.createdPaths.filter((id) => w.paths.has(id) && !net.paths.some((p) => p.id === id)),
      zones,
      linked: edgeList([...e1].filter((k) => !e0.has(k))),
      unlinked: edgeList([...e0].filter((k) => !e1.has(k))),
      preM: extra.preM,
      mergeSizing: extra.mergeSizing,
    };
  } catch (e) {
    if (e instanceof Reject) return fail(e);
    throw e;
  }
}

// ─── Always tangential (plan-628 8.10, E52) ──────────────────────────────

/** Ends of an entry for the tangency guard; null = closed / no geometry (not judged, like the validator). */
function judgeableEnds(e: PathGraphEntry | undefined): ReturnType<typeof specEnds> {
  if (!e || e.closed || e.segments.length === 0) return null;
  return specEnds(e.segments);
}

const sigNum = (v: number): string => (Math.round(v * 1e4) / 1e4).toFixed(4);
const sigVec = (t: readonly number[]): string => `${sigNum(t[0])},${sigNum(t[1])},${sigNum(t[2])}`;

/** Geometry signature of an edge END(a) → START(b) (0.1 mm / 1e-4 tangent). */
function edgeSig(ea: NonNullable<ReturnType<typeof specEnds>>, eb: NonNullable<ReturnType<typeof specEnds>>): string {
  return `${sigVec(ea.end.position)}|${sigVec(ea.end.tangent)}|${sigVec(eb.start.position)}|${sigVec(eb.start.tangent)}`;
}

/**
 * plan-628 8.10: the edges a working copy WRITES non-tangentially, `[from, to]`
 * sorted. An edge is written when it is new or when one of its two paths
 * changed its geometry; it violates when it fails `isPathLink` (> 5 mm or
 * > 2°). An edge whose geometry equals a non-tangential edge of the snapshot
 * sharing its source or target is inherited (e.g. the redirected predecessor
 * of loaded data), not written. Closed / empty paths are not judged.
 */
export function nonTangentialWrites(net: NetworkInput, w: { paths: ReadonlyMap<string, PathGraphEntry> }): [string, string][] {
  const before = new Map<string, PathGraphEntry>();
  for (const p of net.paths) if (!before.has(p.id)) before.set(p.id, p);
  const changed = (id: string): boolean => {
    const b = before.get(id);
    const a = w.paths.get(id);
    return !b || !a || !eqJson(a.segments, b.segments);
  };
  const ends = new Map<string, ReturnType<typeof specEnds>>();
  const endsOf = (m: ReadonlyMap<string, PathGraphEntry>, id: string, key: string): ReturnType<typeof specEnds> => {
    if (!ends.has(key)) ends.set(key, judgeableEnds(m.get(id)));
    return ends.get(key)!;
  };
  const candidates: { from: string; to: string; sig: string }[] = [];
  for (const a of w.paths.values()) {
    for (const to of a.successors) {
      const fresh = !before.get(a.id)?.successors.includes(to);
      if (!fresh && !changed(a.id) && !changed(to)) continue;
      const ea = endsOf(w.paths, a.id, `w:${a.id}`);
      const eb = endsOf(w.paths, to, `w:${to}`);
      if (!ea || !eb) continue;
      if (isPathLink(v3(ea.end.position), v3(ea.end.tangent), v3(eb.start.position), v3(eb.start.tangent))) continue;
      candidates.push({ from: a.id, to, sig: edgeSig(ea, eb) });
    }
  }
  if (candidates.length === 0) return [];
  const froms = new Set(candidates.map((c) => c.from));
  const tos = new Set(candidates.map((c) => c.to));
  const inherited = new Set<string>();
  for (const p of before.values()) {
    for (const to of p.successors) {
      if (!froms.has(p.id) && !tos.has(to)) continue;
      const ea = endsOf(before, p.id, `b:${p.id}`);
      const eb = endsOf(before, to, `b:${to}`);
      if (ea && eb) inherited.add(edgeSig(ea, eb));
    }
  }
  return candidates.filter((c) => !inherited.has(c.sig)).map((c): [string, string] => [c.from, c.to])
    .sort((x, y) => (x[0] + '\u0000' + x[1] < y[0] + '\u0000' + y[1] ? -1 : 1));
}

/** Reject (`'not-tangential'`) or release every edge the op would write non-tangentially (8.10). */
function enforceTangential(net: NetworkInput, w: WorkGraph, policy: KinkPolicy): void {
  const bad = nonTangentialWrites(net, w);
  if (bad.length === 0) return;
  if (policy === 'reject') {
    throw new Reject('not-tangential', `${bad.map(([a, b]) => `${a} -> ${b}`).join(', ')}: ${NOT_TANGENTIAL_TEXT}`);
  }
  for (const [from, to] of bad) {
    const p = w.paths.get(from);
    if (p) p.successors = p.successors.filter((s) => s !== to);
  }
}

function checkIdentity(net: NetworkInput, w: WorkGraph, blockIds: Iterable<string>): void {
  if (net.rootTransformIdentity === false) throw new Reject('transform-not-identity', 'PathNetwork');
  for (const id of blockIds) {
    if (w.block(id).transformIdentity === false) throw new Reject('transform-not-identity', id);
  }
}

// ─── Junction structure ──────────────────────────────────────────────────

/** The pieces of a junction block, derived from the structure (never stored). */
interface JunctionParts {
  front: PathGraphEntry;
  /** merge / stub: the zoned lead-in and merge piece. */
  inPiece?: PathGraphEntry;
  outPiece?: PathGraphEntry;
  /** The host piece after the node. */
  rest: PathGraphEntry;
  /** Branch / stub / mouth pieces (owned by the junction block). */
  branch: PathGraphEntry[];
}

function blockPaths(w: WorkGraph, blockId: string): PathGraphEntry[] {
  return [...w.paths.values()].filter((p) => p.block === blockId);
}

function junctionParts(w: WorkGraph, jb: BlockEntry): JunctionParts {
  const x = jb.extras;
  const own = new Set(blockPaths(w, jb.id).map((p) => p.id));
  const hostBlock = x.host ?? '';
  const front = x.frontPathId ? w.paths.get(x.frontPathId) : undefined;
  if (!front) throw new Reject('not-healable', `${jb.id}: front piece missing`);
  const pickRest = (from: PathGraphEntry): PathGraphEntry => {
    const cands = from.successors.map((s) => w.paths.get(s)).filter((p): p is PathGraphEntry => !!p && !own.has(p.id) && p.block === hostBlock);
    if (cands.length !== 1) throw new Reject('not-healable', `${jb.id}: host piece after the node is ambiguous`);
    return cands[0];
  };
  if (x.kind === 'diverge') {
    const rest = pickRest(front);
    return { front, rest, branch: blockPaths(w, jb.id) };
  }
  const ins = front.successors.filter((s) => own.has(s));
  if (ins.length !== 1) throw new Reject('not-healable', `${jb.id}: lead-in piece missing`);
  const inPiece = w.paths.get(ins[0])!;
  const outs = inPiece.successors.filter((s) => own.has(s));
  if (outs.length !== 1) throw new Reject('not-healable', `${jb.id}: merge piece missing`);
  const outPiece = w.paths.get(outs[0])!;
  const rest = pickRest(outPiece);
  const branch = blockPaths(w, jb.id).filter((p) => p.id !== inPiece.id && p.id !== outPiece.id);
  return { front, inPiece, outPiece, rest, branch };
}

/** Blocks whose `host` is `blockId`, newest first (heal order). */
function hostedBlocks(w: WorkGraph, blockId: string): BlockEntry[] {
  const num = (id: string): number => Number(/(\d+)$/.exec(id)?.[1] ?? 0);
  return [...w.blocks.values()].filter((b) => (b.extras.host ?? '') === blockId && JUNCTION_KINDS.has(b.extras.kind) && b.id !== blockId)
    .sort((a, b) => num(b.id) - num(a.id));
}

/** Junction blocks sitting on a block-free host path. */
function junctionsOnPath(w: WorkGraph, pathIds: ReadonlySet<string>): BlockEntry[] {
  const out: BlockEntry[] = [];
  for (const b of w.blocks.values()) {
    if (!JUNCTION_KINDS.has(b.extras.kind) || (b.extras.host ?? '') !== '') continue;
    try {
      const parts = junctionParts(w, b);
      if (pathIds.has(parts.front.id) || pathIds.has(parts.rest.id)) out.push(b);
    } catch { /* not resolvable — not ours to heal */ }
  }
  return out;
}

/** Update `hostPathId` of every junction block structurally (the piece after its node). */
function refreshJunctionRefs(w: WorkGraph): void {
  for (const b of w.blocks.values()) {
    if (!JUNCTION_KINDS.has(b.extras.kind)) continue;
    try {
      const parts = junctionParts(w, b);
      if (b.extras.hostPathId !== parts.rest.id) b.extras.hostPathId = parts.rest.id;
    } catch { /* leave as is; validation (Phase 4) reports broken structure */ }
  }
}

/**
 * Remove a junction block and heal its host (plan §2.4a): front + lead-in +
 * merge piece + rest become ONE path with the id of the rest (the original id,
 * P7), adjacent collinear pieces coalesced. Junctions hosted on this block are
 * healed first. A host that no longer continues seamlessly is NOT healed: the
 * junction pieces go and front and rest keep OPEN ends (plan-628 8.10, E52 —
 * never a kink or gap edge); the link is written only if the front still
 * continues into the rest under the shared tolerance.
 */
function healJunction(w: WorkGraph, jb: BlockEntry): { survivor: string; frontId: string; healed: boolean } {
  for (const h of hostedBlocks(w, jb.id)) healJunction(w, h);
  const parts = junctionParts(w, jb);
  const chain = parts.inPiece && parts.outPiece
    ? [parts.front, parts.inPiece, parts.outPiece, parts.rest]
    : [parts.front, parts.rest];
  let seamless = true;
  for (let i = 0; i + 1 < chain.length; i++) if (!continues(chain[i], chain[i + 1])) seamless = false;
  const removeSet = new Set([...blockPaths(w, jb.id).map((p) => p.id)]);
  if (seamless) {
    // Every vehicle on a chain piece (the rest included) lands on the survivor,
    // shifted by the length now in front of its piece (Rueckabbildung, SOL-R2 #2).
    const pieces: { id: string; offset: number }[] = [];
    let off = 0;
    for (const c of chain) { pieces.push({ id: c.id, offset: off }); off += specListLength(c.segments); }
    w.remapMerge(pieces, parts.rest.id);
    parts.rest.segments = coalesceSpecs(chain.flatMap((c) => c.segments));
    removeSet.add(parts.front.id);
    w.redirectPredecessors(parts.front.id, parts.rest.id, new Set(chain.map((c) => c.id)));
    for (const c of chain) if (c.id !== parts.rest.id) w.mergedInto.set(c.id, parts.rest.id);
    for (const id of removeSet) if (id !== parts.rest.id) w.removePath(id);
  } else {
    for (const id of removeSet) w.removePath(id);
    // A diverge's front already lists the rest: keep that edge only while it is tangential.
    if (continues(parts.front, parts.rest)) {
      if (!parts.front.successors.includes(parts.rest.id)) parts.front.successors = [...parts.front.successors, parts.rest.id];
    } else {
      parts.front.successors = parts.front.successors.filter((s) => s !== parts.rest.id);
    }
  }
  w.blocks.delete(jb.id);
  // Blocks that referenced a removed piece follow the survivor.
  for (const b of w.blocks.values()) {
    if (b.extras.hostPathId && !w.paths.has(b.extras.hostPathId)) b.extras.hostPathId = parts.rest.id;
    if (b.extras.frontPathId && !w.paths.has(b.extras.frontPathId) && seamless) b.extras.frontPathId = parts.rest.id;
  }
  return { survivor: parts.rest.id, frontId: parts.front.id, healed: seamless };
}

// ─── Merge lead-in sizing (P8) ───────────────────────────────────────────

/** True when the merge at `outId` has no too-short entry for `env` in the working copy. */
function mergeEntryOk(w: WorkGraph, outId: string, env: BodyEnvelope): boolean {
  const net = new RVPathNetwork();
  for (const p of w.paths.values()) {
    const rp = parsePathExtras({
      id: p.id, segments: cloneSegmentSpecs(p.segments), successors: [...p.successors],
      zone: p.zone, zoneCapacity: p.zoneCapacity, closed: p.closed === true,
    }, p.id);
    if (rp) net.register(rp);
  }
  net.resolveGraph();
  return findShortMergeEntries(net.all(), env).every((e) => e.mergePathId !== outId);
}

// ─── Ops ─────────────────────────────────────────────────────────────────

/**
 * Place a straight or curve block (F3). `at` = a path end (the block's start
 * snaps to an END port; the block's end snaps to a START port) or a free pose.
 * Links by auto-link in the same edit (P5).
 */
export function placeBlock(net: NetworkInput, block: PathBlockSpec, at: PortRef | FreePose): NetworkEditResult {
  return run(net, (w) => {
    if (block.kind !== 'straight' && block.kind !== 'curve') throw new Reject('wrong-kind', block.kind);
    const local = blockTemplate(block)[0].specs;
    let pose: BlockPose;
    let y = 0;
    if ('pathId' in at) {
      const target = w.path(at.pathId);
      if (target.closed) throw new Reject('invalid-link', `${at.pathId} is closed`);
      const ends = specEnds(target.segments);
      if (!ends) throw new Reject('invalid-link', at.pathId);
      if (at.end === 'end') {
        pose = poseForPort(ends.end);
        y = ends.end.position[1];
      } else {
        const le = specEnds(local)!.end;
        pose = poseForPort(ends.start, le.position, headingOf(le.tangent));
        y = ends.start.position[1];
      }
    } else {
      pose = [at.x, at.z, at.headingDeg];
      y = at.y ?? 0;
    }
    const n = w.claimIndex(PN_PREFIX.block);
    const blockId = `${PN_PREFIX.block}${n}`;
    const extras = makePathBlockExtras(block, pose, y ? { y } : undefined);
    w.blocks.set(blockId, { id: blockId, extras });
    const pid = w.claimId(block.kind === 'straight' ? PN_PREFIX.straight : PN_PREFIX.curve);
    w.addPath(newEntry(pid, blockId, transformSpecs(local, pose, y)));
    autoLink(w, new Set([pid]));
    if ('pathId' in at) {
      const target = w.paths.get(at.pathId)!;
      const ok = at.end === 'end' ? target.successors.includes(pid) : w.paths.get(pid)!.successors.includes(at.pathId);
      if (!ok) throw new Reject('invalid-link', `${at.pathId}.${at.end}`);
    }
    return { blockId };
  });
}

/**
 * Link END(from) → START(to) explicitly (P5). Start/start and end/end are
 * refused (`'invalid-link'`), and so are ends more than 5 mm apart; ends that
 * meet but whose tangents differ by more than 2° are refused as
 * `'not-tangential'` (plan-628 8.10 — the network is always tangential).
 */
export function linkEnds(net: NetworkInput, from: PortRef, to: PortRef): NetworkEditResult {
  return run(net, (w) => {
    if (from.end !== 'end' || to.end !== 'start') throw new Reject('invalid-link', 'only end -> start');
    const a = w.path(from.pathId);
    const b = w.path(to.pathId);
    if (a.id === b.id || a.closed || b.closed) throw new Reject('invalid-link', `${a.id} -> ${b.id}`);
    if (!continues(a, b)) {
      const ea = specEnds(a.segments);
      const eb = specEnds(b.segments);
      const meet = !!ea && !!eb && v3(ea.end.position).distanceTo(v3(eb.start.position)) <= PATH_LINK_TOLERANCE.distM + 1e-9;
      if (meet) throw new Reject('not-tangential', `${a.id} -> ${b.id}: ${NOT_TANGENTIAL_TEXT}`);
      throw new Reject('invalid-link', `${a.id} -> ${b.id}: outside tolerance`);
    }
    if (!a.successors.includes(b.id)) a.successors = [...a.successors, b.id];
  });
}

/** Ids claimed up front for a junction (relocate reuses the old ones). */
interface JunctionIds {
  blockId: string;
  frontId: string;
  inId?: string;
  outId?: string;
  zoneM?: string;
  branchIds: string[];
  zoneK: string[];
}

function claimJunctionIds(w: WorkGraph, kind: PathBlockSpec['kind'], twin: boolean, hostId: string): JunctionIds {
  const blockId = `${PN_PREFIX.block}${w.claimIndex(PN_PREFIX.block)}`;
  const frontId = frontIdFor(w, hostId);
  if (kind === 'diverge') return { blockId, frontId, branchIds: [w.claimId(PN_PREFIX.curve)], zoneK: [] };
  const j = w.claimIndex(PN_PREFIX.junction, ['_In', '_Out']);
  const zoneM = w.claimId(PN_PREFIX.mergeZone);
  const ids: JunctionIds = { blockId, frontId, inId: `${PN_PREFIX.junction}${j}_In`, outId: `${PN_PREFIX.junction}${j}_Out`, zoneM, branchIds: [], zoneK: [] };
  if (kind === 'merge') ids.branchIds.push(w.claimId(PN_PREFIX.curve));
  else {
    for (let i = 0; i < (twin ? 2 : 1); i++) {
      const k = w.claimIndex(PN_PREFIX.stub, ['', '_Mouth']);
      ids.branchIds.push(`${PN_PREFIX.stub}${k}`, `${PN_PREFIX.stub}${k}_Mouth`);
      ids.zoneK.push(`${PN_PREFIX.stub}${k}`);
    }
  }
  return ids;
}

/** Build a junction on `hostId` at `s` with fixed ids. Returns the lead-in actually used. */
function buildJunction(
  w: WorkGraph,
  spec: PathBlockSpec,
  hostId: string,
  s: number,
  ids: JunctionIds,
  preM: number,
): void {
  const host = w.path(hostId);
  const L = specListLength(host.segments);
  const at = poseAtArcLength(host.segments, s);
  if (!at) throw new Reject('host-too-short', hostId);
  const pose: BlockPose = [at.position[0], at.position[2], headingOf(at.tangent)];
  const y = at.position[1];
  const hostBlock = host.block;
  const extras = makePathBlockExtras(spec, pose, { host: hostBlock, hostPathId: hostId, frontPathId: ids.frontId, ...(y ? { y } : {}) });
  w.blocks.set(ids.blockId, { id: ids.blockId, extras });
  const template = blockTemplate(spec);
  const own = ids.blockId;
  const chainIds = new Set<string>([ids.frontId, hostId]);

  if (spec.kind === 'diverge') {
    const pieces = cutSpecs(host.segments, [s]);
    if (!pieces) throw new Reject('host-too-short', `${hostId}: node too close to an end`);
    const [front, rest] = pieces;
    w.remapSplit(hostId, [{ id: ids.frontId, a: 0, b: s }, { id: hostId, a: s, b: L }]);
    const branchId = ids.branchIds[0];
    w.addPath(newEntry(ids.frontId, hostBlock, front, [hostId, branchId]));
    host.segments = rest;
    w.redirectPredecessors(hostId, ids.frontId, chainIds);
    w.addPath(newEntry(branchId, own, transformSpecs(template[0].specs, pose, y)));
    return;
  }

  const a = s - preM;
  const b = s + MERGE_OUT_M;
  const pieces = cutSpecs(host.segments, [a, s, b]);
  if (!(a > MIN_PIECE_M) || !(L - b > MIN_PIECE_M) || !pieces) {
    throw new Reject('host-too-short', `${hostId}: needs ${preM.toFixed(1)} m lead-in + ${MERGE_OUT_M} m run-out around s=${s.toFixed(3)} (length ${L.toFixed(3)} m)`);
  }
  const [front, lead, out, rest] = pieces;
  w.remapSplit(hostId, [
    { id: ids.frontId, a: 0, b: a },
    { id: ids.inId!, a, b: s },
    { id: ids.outId!, a: s, b },
    { id: hostId, a: b, b: L },
  ]);
  const zoneM = ids.zoneM!;
  w.addPath(newEntry(ids.frontId, hostBlock, front, [ids.inId!]));
  const inE = newEntry(ids.inId!, own, lead, [ids.outId!]);
  inE.zone = zoneM; inE.zoneCapacity = 1;
  w.addPath(inE);
  const outE = newEntry(ids.outId!, own, out, [hostId]);
  outE.zone = zoneM; outE.zoneCapacity = 1;
  w.addPath(outE);
  host.segments = rest;
  chainIds.add(ids.inId!); chainIds.add(ids.outId!);
  w.redirectPredecessors(hostId, ids.frontId, chainIds);

  if (spec.kind === 'merge') {
    const c = newEntry(ids.branchIds[0], own, transformSpecs(template[0].specs, pose, y), [ids.outId!]);
    c.zone = zoneM; c.zoneCapacity = 1;
    w.addPath(c);
    return;
  }
  // stub (+ twin): pairs (stub, mouth) in template order.
  for (let i = 0; i < ids.zoneK.length; i++) {
    const stubT = template[2 * i];
    const mouthT = template[2 * i + 1];
    const kId = ids.branchIds[2 * i];
    const mId = ids.branchIds[2 * i + 1];
    const k = newEntry(kId, own, transformSpecs(stubT.specs, pose, y), [mId]);
    k.zone = ids.zoneK[i]; k.zoneCapacity = 1;
    w.addPath(k);
    const m = newEntry(mId, own, transformSpecs(mouthT.specs, pose, y), [ids.outId!]);
    m.zone = zoneM; m.zoneCapacity = 1;
    w.addPath(m);
  }
}

/** Validate a junction target before sizing. */
function checkJunctionHost(net: NetworkInput, w: WorkGraph, spec: PathBlockSpec, on: JunctionTarget): PathGraphEntry {
  if (!JUNCTION_KINDS.has(spec.kind)) throw new Reject('wrong-kind', spec.kind);
  const host = w.path(on.pathId);
  refuseOwned(host);
  checkIdentity(net, w, host.block ? [host.block] : []);
  if (host.closed) throw new Reject('closed-host', host.id);
  if (spec.kind !== 'diverge' && host.zone) {
    throw new Reject('host-too-short', `${host.id} already lies in zone ${host.zone}`);
  }
  const L = specListLength(host.segments);
  if (!(on.s > MIN_PIECE_M) || !(L - on.s > MIN_PIECE_M)) throw new Reject('host-too-short', `${host.id}: s=${on.s} outside (0, ${L.toFixed(3)})`);
  return host;
}

/** Choose `preM` (P8/P11): with an envelope the smallest valid 0.1 m step ≥ 1.0 m, else 1.8 m. */
function sizeLeadIn(
  net: NetworkInput,
  spec: PathBlockSpec,
  on: JunctionTarget,
  ids: (wc: WorkGraph) => JunctionIds,
  env: BodyEnvelope | undefined,
): { preM: number; sizing: MergeSizing } {
  if (spec.kind === 'diverge') return { preM: 0, sizing: 'skipped' };
  if (!env) return { preM: MERGE_PRE_FALLBACK_M, sizing: 'skipped' };
  let lastFit: number | null = null;
  for (let k = 0; k < MERGE_PRE_MAX_STEPS; k++) {
    const preM = Math.round((MERGE_PRE_MIN_M * 10 + k)) / 10;
    const trial = new WorkGraph(net);
    try {
      const jid = ids(trial);
      buildJunction(trial, spec, on.pathId, on.s, jid, preM);
      lastFit = preM;
      if (mergeEntryOk(trial, jid.outId!, env)) return { preM, sizing: 'sized' };
    } catch (e) {
      if (e instanceof Reject && e.reason === 'host-too-short') break;
      throw e;
    }
  }
  if (lastFit === null) throw new Reject('host-too-short', `${on.pathId}: no room for a ${MERGE_PRE_MIN_M} m lead-in at s=${on.s}`);
  return { preM: lastFit, sizing: 'unresolved' };
}

/**
 * Set a diverge, merge or stub onto an existing path (F4/F5, P7/P8, §2.4).
 *
 * The original id stays on the piece with the original END (docks, stations,
 * successors stay valid); the front gets a new id and stays in the host block
 * (`renamedFront`). Merge and stub get their zones (`PN_M<n>`, `PN_K<n>`,
 * capacity 1). A host too short for lead-in + run-out (R1 #4), a node in an
 * existing zone, or a closed host refuse before any change.
 */
export function placeJunction(
  net: NetworkInput,
  spec: PathBlockSpec,
  on: JunctionTarget,
  opts: JunctionOptions = {},
): NetworkEditResult {
  const sided: PathBlockSpec = { ...spec, side: on.side ?? spec.side };
  return run(net, (w) => {
    checkJunctionHost(net, w, sided, on);
    const twin = resolveBlockParams(sided).twin && sided.kind === 'stub';
    const sizing = sizeLeadIn(net, sided, on, (wc) => claimJunctionIds(wc, sided.kind, twin, on.pathId), opts.env);
    const ids = claimJunctionIds(w, sided.kind, twin, on.pathId);
    buildJunction(w, sided, on.pathId, on.s, ids, sizing.preM);
    refreshJunctionRefs(w);
    return {
      blockId: ids.blockId,
      renamedFront: ids.frontId,
      preM: sided.kind === 'diverge' ? undefined : sizing.preM,
      mergeSizing: sided.kind === 'diverge' ? undefined : sizing.sizing,
    };
  });
}

/**
 * Remove block-free paths (F10 `web_layout_path_remove`): every predecessor
 * loses its reference. Paths inside a block are removed with their block
 * (`'path-in-block'`); imported paths are refused; a vehicle starting on a
 * removed path refuses (`'vehicle-on-removed-path'`).
 */
export function removePaths(net: NetworkInput, ids: readonly string[]): NetworkEditResult {
  return run(net, (w) => {
    const set = new Set(ids);
    for (const id of ids) {
      const p = w.path(id);
      refuseOwned(p);
      if (p.block) throw new Reject('path-in-block', `${id} belongs to ${p.block}`);
      if (p.imported) throw new Reject('imported-path', id);
    }
    for (const jb of junctionsOnPath(w, set)) healJunction(w, jb);
    for (const id of ids) {
      let cur = id;
      while (!w.paths.has(cur) && w.mergedInto.has(cur)) cur = w.mergedInto.get(cur)!;
      w.removePath(cur);
    }
  });
}

/**
 * Remove a block (F12/F13, §2.4a "Loeschen"): hosted junctions heal first,
 * then the block's own paths go and every predecessor is unlinked. Removing a
 * junction block heals its host.
 */
export function removeBlock(net: NetworkInput, blockId: string): NetworkEditResult {
  return run(net, (w) => {
    const b = writableBlock(w, blockId);
    if (JUNCTION_KINDS.has(b.extras.kind)) {
      healJunction(w, b);
      refreshJunctionRefs(w);
      return;
    }
    for (const h of hostedBlocks(w, blockId)) healJunction(w, h);
    for (const p of blockPaths(w, blockId)) w.removePath(p.id);
    w.blocks.delete(blockId);
    refreshJunctionRefs(w);
  });
}

/** Options of {@link moveBlock}. */
export interface MoveBlockOptions {
  /**
   * plan-628 8.8 (E35): move the DOWNSTREAM CHAIN with the block
   * ({@link chainMoveSet}), so the edges inside the chain stay. Absent/false =
   * the block alone (P6).
   */
  chain?: boolean;
}

/**
 * Move / rotate a straight or curve block as a unit (F12, §2.4a). The rigid
 * motion is applied to the CURRENT segments of the block and of every junction
 * block it hosts (transitively), so single edits survive (P2a). Port edges
 * between the moved set and the rest are released and re-formed by auto-link
 * at the new place (P6); internal edges stay. Arc-length addresses stay valid.
 * Any edge that would end non-tangential or non-coincident is released in the
 * same edit (plan-628 8.10 — a move never leaves a kink).
 */
export function moveBlock(net: NetworkInput, blockId: string, delta: RigidXZ, opts: MoveBlockOptions = {}): NetworkEditResult {
  return run(net, (w) => {
    const b = writableBlock(w, blockId);
    if (JUNCTION_KINDS.has(b.extras.kind)) throw new Reject('wrong-kind', `${blockId} is a junction — use relocateJunction`);
    const moved = new Set<string>(opts.chain ? chainMoveSet(net, blockId).blockIds : [blockId]);
    for (let grew = true; grew;) {
      grew = false;
      for (const x of w.blocks.values()) {
        if (!moved.has(x.id) && x.extras.host && moved.has(x.extras.host)) { moved.add(x.id); grew = true; }
      }
    }
    checkIdentity(net, w, moved);
    const movedPaths = new Set([...w.paths.values()].filter((p) => moved.has(p.block)).map((p) => p.id));
    for (const p of w.paths.values()) {
      if (movedPaths.has(p.id)) p.successors = p.successors.filter((s) => movedPaths.has(s));
      else p.successors = p.successors.filter((s) => !movedPaths.has(s));
    }
    for (const id of movedPaths) {
      const p = w.paths.get(id)!;
      p.segments = applyRigidXZ(p.segments, delta);
      w.touched.add(id);
    }
    for (const id of moved) {
      const x = w.blocks.get(id)!;
      x.extras.pose = applyRigidToPose(x.extras.pose, delta);
    }
    autoLink(w, movedPaths);
  }, 'release');
}

/**
 * Slide a junction block along its host to arc length `s` (F13, §2.4a):
 * heal + set again in ONE edit; the junction keeps its block id, piece ids and
 * zone ids (relocation is a field write on the existing nodes, N9). `s` is
 * measured on the HEALED host piece (the one with the original id).
 */
export function relocateJunction(net: NetworkInput, blockId: string, s: number, opts: JunctionOptions = {}): NetworkEditResult {
  return run(net, (w) => {
    const jb = writableBlock(w, blockId);
    if (!JUNCTION_KINDS.has(jb.extras.kind)) throw new Reject('wrong-kind', blockId);
    if (hostedBlocks(w, blockId).length > 0) throw new Reject('has-hosted-junctions', blockId);
    const parts = junctionParts(w, jb);
    const spec: PathBlockSpec = { kind: jb.extras.kind, ...jb.extras.params };
    const ids: JunctionIds = {
      blockId,
      frontId: parts.front.id,
      inId: parts.inPiece?.id,
      outId: parts.outPiece?.id,
      zoneM: parts.outPiece?.zone,
      branchIds: parts.branch.map((p) => p.id).sort(stubOrder),
      zoneK: parts.branch.filter((p) => p.zone && p.zone !== parts.outPiece?.zone).map((p) => p.zone!).sort(),
    };
    const healed = healJunction(w, jb);
    if (!healed.healed) throw new Reject('not-healable', `${blockId}: host does not continue seamlessly`);
    // The healed host may now be referenced by the sizing trial: snapshot it.
    const snap: NetworkInput = { ...net, paths: [...w.paths.values()], blocks: [...w.blocks.values()], vehicles: w.trackers.map((t) => ({ agvNode: t.agvNode, pathId: t.pathId, startPositionMm: t.s * 1000 })) };
    const on: JunctionTarget = { pathId: healed.survivor, s, side: spec.side };
    checkJunctionHost(net, w, spec, on);
    const sizing = sizeLeadIn(snap, spec, on, () => ids, opts.env);
    // Re-use the freed ids: they are no longer in the working copy.
    buildJunction(w, spec, healed.survivor, s, ids, sizing.preM);
    refreshJunctionRefs(w);
    return { blockId, preM: spec.kind === 'diverge' ? undefined : sizing.preM, mergeSizing: spec.kind === 'diverge' ? undefined : sizing.sizing };
  });
}

/** Stub pieces in (K, K_Mouth) pairs, ordered by K. */
function stubOrder(a: string, b: string): number {
  const base = (x: string): string => x.replace(/_Mouth$/, '');
  if (base(a) !== base(b)) return base(a) < base(b) ? -1 : 1;
  return a.endsWith('_Mouth') ? 1 : -1;
}

// ─── "edited" / reset / parameters (P2a) ─────────────────────────────────

/** The in-line geometry of a straight/curve block: its paths in travel order, through hosted junctions. */
function blockLine(w: WorkGraph, blockId: string): PathSegmentSpec[] {
  const own = blockPaths(w, blockId);
  const inline = new Set(own.map((p) => p.id));
  for (const h of hostedBlocks(w, blockId)) {
    try {
      const parts = junctionParts(w, h);
      if (parts.inPiece) inline.add(parts.inPiece.id);
      if (parts.outPiece) inline.add(parts.outPiece.id);
    } catch { /* broken junction: the comparison reads "edited" */ }
  }
  const hasPred = new Set<string>();
  for (const id of inline) for (const s of w.paths.get(id)!.successors) if (inline.has(s)) hasPred.add(s);
  const starts = own.filter((p) => !hasPred.has(p.id));
  if (starts.length !== 1) return own.flatMap((p) => p.segments);
  const out: PathSegmentSpec[] = [];
  const seen = new Set<string>();
  let cur: PathGraphEntry | undefined = starts[0];
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(...cur.segments);
    const nextOwn: string | undefined = cur.successors.find((s) => own.some((p) => p.id === s));
    const next: string | undefined = nextOwn ?? cur.successors.find((s) => inline.has(s));
    cur = next ? w.paths.get(next) : undefined;
  }
  return out;
}

/**
 * True when the block's geometry deviates from `template(kind, params, pose)`
 * (P2a — derived, never stored). Straight/curve: the in-line geometry through
 * hosted junctions; junctions: the branch / stub / mouth pieces.
 */
export function isBlockEdited(net: NetworkInput, blockId: string): boolean {
  const w = new WorkGraph(net);
  const b = w.block(blockId);
  const tmpl = pathBlockTemplate(b.extras);
  if (!JUNCTION_KINDS.has(b.extras.kind)) return !sameGeometry(blockLine(w, blockId), tmpl.flatMap((p) => p.specs));
  let parts: JunctionParts;
  try { parts = junctionParts(w, b); } catch { return true; }
  const branch = [...parts.branch];
  if (branch.length !== tmpl.length) return true;
  return !tmpl.every((t: BlockPiece) => branch.some((p) => sameGeometry(p.segments, t.specs)));
}

/** Replace the geometry of a straight/curve block (shared by reset and parameter change). */
function rebuildMain(w: WorkGraph, net: NetworkInput, blockId: string, extras: PathBlockExtras): void {
  const own = blockPaths(w, blockId);
  if (hostedBlocks(w, blockId).length > 0) throw new Reject('has-hosted-junctions', blockId);
  if (own.length !== 1) throw new Reject('not-healable', `${blockId}: ${own.length} paths`);
  checkIdentity(net, w, [blockId]);
  const p = own[0];
  const ids = new Set([p.id]);
  for (const q of w.paths.values()) {
    if (q.id === p.id) q.successors = [];
    else q.successors = q.successors.filter((s) => !ids.has(s));
  }
  p.segments = pathBlockTemplate(extras).flatMap((x) => x.specs);
  w.touched.add(p.id);
  w.blocks.get(blockId)!.extras = extras;
  autoLink(w, ids);
}

/** "Reset to template" (P2a) for a straight/curve block with one path and no hosted junctions. */
export function resetBlockToTemplate(net: NetworkInput, blockId: string): NetworkEditResult {
  return run(net, (w) => {
    const b = writableBlock(w, blockId);
    if (JUNCTION_KINDS.has(b.extras.kind)) throw new Reject('wrong-kind', `${blockId}: reset of junction blocks is not supported yet`);
    rebuildMain(w, net, blockId, cloneExtras(b.extras));
  });
}

/** Options of {@link setBlockParams} / {@link replaceBlock}. */
export interface RebuildOptions {
  /**
   * plan-628 8.11d/e: the downstream chain ({@link chainMoveSet} without the
   * block itself) slides rigidly onto the block's NEW end — position and
   * heading — so the edges inside the chain and the edge block → chain stay
   * tangential. Absent/false = the chain stays where it is (the edge to it
   * is released when it no longer fits; never a kink).
   */
  chain?: boolean;
}

function editedRefusal(blockId: string): NetworkEditResult {
  return { ok: false, reason: 'block-edited', detail: blockId, edit: emptyEdit(), createdPaths: [], zones: [], linked: [], unlinked: [] };
}

/**
 * Rebuild a straight/curve block from `extras` (same start pose) and, with
 * `chain`, take its downstream chain along: the rigid motion that maps the
 * block's OLD end port onto its NEW end port (rotate about the old end by the
 * heading change, then translate). The predecessor edge is untouched — the
 * block's start does not move. Port edges between the moved chain and the rest
 * are released and re-formed by auto-link (as {@link moveBlock}).
 */
function rebuildFollowing(w: WorkGraph, net: NetworkInput, blockId: string, extras: PathBlockExtras, chain: boolean): void {
  const own = blockPaths(w, blockId);
  const oldEnds = own.length === 1 ? specEnds(own[0].segments) : null;
  const downstream = new Set<string>(chain ? chainMoveSet(net, blockId).blockIds.filter((id) => id !== blockId) : []);
  rebuildMain(w, net, blockId, extras);
  if (downstream.size === 0 || !oldEnds) return;
  const p = blockPaths(w, blockId)[0];
  const newEnds = specEnds(p.segments);
  if (!newEnds) return;
  checkIdentity(net, w, downstream);
  const delta = endFollowMotion(oldEnds.end, newEnds.end);
  const movedPaths = new Set([...w.paths.values()].filter((q) => downstream.has(q.block)).map((q) => q.id));
  for (const q of w.paths.values()) {
    if (movedPaths.has(q.id)) q.successors = q.successors.filter((s) => movedPaths.has(s));
    else q.successors = q.successors.filter((s) => !movedPaths.has(s));
  }
  for (const id of movedPaths) {
    const q = w.paths.get(id)!;
    q.segments = applyRigidXZ(q.segments, delta);
    w.touched.add(id);
  }
  for (const id of downstream) {
    const x = w.blocks.get(id)!;
    x.extras.pose = applyRigidToPose(x.extras.pose, delta);
  }
  autoLink(w, new Set([p.id, ...movedPaths]));
}

/**
 * Change the parameters of an UNEDITED straight/curve block (P2a: edited →
 * reset first). With `chain` (plan-628 8.11d, the length / radius handle) the
 * downstream chain slides rigidly onto the new end; anything that would end
 * non-tangential is released in the same edit (8.10, never a kink).
 */
export function setBlockParams(net: NetworkInput, blockId: string, params: Omit<PathBlockSpec, 'kind'>, opts: RebuildOptions = {}): NetworkEditResult {
  if (blockIdExists(net, blockId) && isBlockEdited(net, blockId)) return editedRefusal(blockId);
  return run(net, (w) => {
    const b = writableBlock(w, blockId);
    if (JUNCTION_KINDS.has(b.extras.kind)) throw new Reject('wrong-kind', blockId);
    const next = makePathBlockExtras({ ...b.extras.params, ...params, kind: b.extras.kind }, b.extras.pose,
      b.extras.y ? { y: b.extras.y } : undefined);
    rebuildFollowing(w, net, blockId, next, opts.chain === true);
  }, opts.chain ? 'release' : 'reject');
}

/**
 * plan-628 8.11e: replace a straight/curve block by another straight/curve
 * block (`spec`, e.g. straight ↔ curve, curve left ↔ right) at the SAME start
 * pose — the block keeps its id and its path keeps its id (vehicles,
 * references and the predecessor edge stay valid; the predecessor edge stays
 * because the start tangent does not change). With `chain` the downstream
 * chain moves rigidly onto the new end (connection kept, as the length
 * handle); without it the successor edge stays only when the new end still
 * meets it tangentially, else it is released. Junction blocks are refused
 * (`wrong-kind`), like an edited block (`block-edited`, P2a — reset first).
 */
export function replaceBlock(net: NetworkInput, blockId: string, spec: PathBlockSpec, opts: RebuildOptions = {}): NetworkEditResult {
  if (blockIdExists(net, blockId) && isBlockEdited(net, blockId)) return editedRefusal(blockId);
  return run(net, (w) => {
    const b = writableBlock(w, blockId);
    if (JUNCTION_KINDS.has(b.extras.kind)) throw new Reject('wrong-kind', `${blockId} is a ${b.extras.kind} junction — it cannot be replaced`);
    if (spec.kind !== 'straight' && spec.kind !== 'curve') throw new Reject('wrong-kind', `replace with ${spec.kind}: only straight or curve`);
    const next = makePathBlockExtras(spec, b.extras.pose, b.extras.y ? { y: b.extras.y } : undefined);
    rebuildFollowing(w, net, blockId, next, opts.chain === true);
  }, opts.chain ? 'release' : 'reject');
}

// ─── Copy / paste (plan-628 8.11f) ───────────────────────────────────────

/** One copied path: its geometry (world, at copy time) and its edges INSIDE the clip. */
export interface ClipPath {
  id: string;
  segments: PathSegmentSpec[];
  successors: string[];
}

/** One copied straight/curve block. */
export interface ClipBlock {
  id: string;
  extras: PathBlockExtras;
  paths: ClipPath[];
}

/** What Ctrl+C keeps of the path network: whole blocks, world coordinates, inner edges only. */
export interface BlockClip {
  blocks: ClipBlock[];
}

/**
 * plan-628 8.11f: copy the straight/curve blocks `blockIds` (in order). A
 * junction block is not copied (it lives on its host); a block that hosts
 * junctions is copied as its template line (its pieces belong to the junction
 * structure). Only edges between copied paths are kept. Pure.
 */
export function copyBlocks(net: NetworkInput, blockIds: readonly string[]): BlockClip {
  const w = new WorkGraph(net);
  // plan-628 8.6 (E82): generated (composition-owned) blocks are skipped like junctions — UI and MCP alike.
  const ids = [...new Set(blockIds)].filter((id) => w.blocks.has(id) && !JUNCTION_KINDS.has(w.blocks.get(id)!.extras.kind)
    && !isOwnedBlockEntry(w, id));
  const blocks: ClipBlock[] = [];
  for (const id of ids) {
    const b = w.blocks.get(id)!;
    const own = blockPaths(w, id);
    const plain = own.length === 1 && hostedBlocks(w, id).length === 0;
    const paths: ClipPath[] = plain
      ? [{ id: own[0].id, segments: cloneSegmentSpecs(own[0].segments), successors: [...own[0].successors] }]
      : [{ id: `${id}#line`, segments: cloneSegmentSpecs(pathBlockTemplate(b.extras).flatMap((x) => x.specs)), successors: [] }];
    blocks.push({ id, extras: cloneExtras(b.extras), paths });
  }
  const inClip = new Set(blocks.flatMap((b) => b.paths.map((p) => p.id)));
  for (const b of blocks) for (const p of b.paths) p.successors = p.successors.filter((s) => inClip.has(s));
  return { blocks };
}

/** plan-628 8.6: a block that is generated content — the block itself or one of its paths carries an owner. */
function isOwnedBlockEntry(w: WorkGraph, blockId: string): boolean {
  if (w.blocks.get(blockId)?.owner) return true;
  return blockPaths(w, blockId).some((p) => !!p.owner);
}

/** The first free START of a clip (a path without a predecessor inside it, clip order) — the docking anchor. */
export function clipAnchor(clip: BlockClip): { position: [number, number, number]; headingDeg: number } | null {
  const hasPred = new Set<string>();
  for (const b of clip.blocks) for (const p of b.paths) for (const s of p.successors) hasPred.add(s);
  for (const b of clip.blocks) {
    for (const p of b.paths) {
      if (hasPred.has(p.id)) continue;
      const e = specEnds(p.segments);
      if (e) return { position: [e.start.position[0], e.start.position[1], e.start.position[2]], headingDeg: headingOf(e.start.tangent) };
    }
  }
  return null;
}

/**
 * plan-628 8.11f: paste a clip moved by `motion` as NEW blocks — new block and
 * path ids (P4: `PN_Block_<n>`, `PN_S<n>` / `PN_C<n>`), the inner edges kept,
 * then auto-link (P5) docks the copy onto a FREE end it meets tangentially (an
 * end that already has a successor / predecessor is never joined — no merge or
 * diverge by accident).
 * Anything non-tangential is released (8.10, never a kink). Answers the new
 * block ids in `blockIds` (clip order), the first as `blockId`.
 */
export function pasteBlocks(net: NetworkInput, clip: BlockClip, motion: RigidXZ): NetworkEditResult & { blockIds: string[] } {
  const created: string[] = [];
  const r = run(net, (w) => {
    if (clip.blocks.length === 0) throw new Reject('unknown-block', 'the clipboard holds no path blocks');
    const idMap = new Map<string, string>();
    const fresh: PathGraphEntry[] = [];
    for (const cb of clip.blocks) {
      if (cb.extras.kind !== 'straight' && cb.extras.kind !== 'curve') throw new Reject('wrong-kind', `${cb.id}: only straight / curve blocks are pasted`);
      const blockId = `${PN_PREFIX.block}${w.claimIndex(PN_PREFIX.block)}`;
      const extras = cloneExtras(cb.extras);
      extras.pose = applyRigidToPose(extras.pose, motion);
      w.blocks.set(blockId, { id: blockId, extras });
      created.push(blockId);
      for (const cp of cb.paths) {
        const pid = w.claimId(cb.extras.kind === 'straight' ? PN_PREFIX.straight : PN_PREFIX.curve);
        idMap.set(cp.id, pid);
        const e = newEntry(pid, blockId, applyRigidXZ(cloneSegmentSpecs(cp.segments), motion), [...cp.successors]);
        w.addPath(e);
        fresh.push(e);
      }
    }
    for (const e of fresh) e.successors = e.successors.map((s) => idMap.get(s)).filter((s): s is string => !!s);
    // Docking only onto FREE ends: a paste never turns an occupied end into a
    // merge / diverge by accident (e.g. Ctrl+V twice at the same spot).
    const freshIds = new Set(fresh.map((e) => e.id));
    const endTaken = new Set<string>();
    const startTaken = new Set<string>();
    for (const p of w.paths.values()) {
      if (freshIds.has(p.id)) continue;
      if (p.successors.length > 0) endTaken.add(p.id);
      for (const s of p.successors) startTaken.add(s);
    }
    autoLink(w, freshIds);
    for (const p of w.paths.values()) {
      if (freshIds.has(p.id)) p.successors = p.successors.filter((s) => freshIds.has(s) || !startTaken.has(s));
      else if (endTaken.has(p.id)) p.successors = p.successors.filter((s) => !freshIds.has(s));
    }
    return { blockId: created[0] };
  }, 'release');
  return { ...r, blockIds: r.ok ? created : [] };
}

function blockIdExists(net: NetworkInput, id: string): boolean {
  return (net.blocks ?? []).some((b) => b.id === id);
}

// ─── UI read helpers (plan-628 Phase 5) ──────────────────────────────────

/**
 * The healed host line of a junction block — the geometry its `s`
 * (`relocateJunction`) is measured on — and the paths that make it up, in
 * travel order. Read only (the working copy is discarded); null when the
 * block is no junction or its structure is not healable.
 */
export function junctionHostLine(net: NetworkInput, blockId: string): { specs: PathSegmentSpec[]; pathIds: string[] } | null {
  try {
    const w = new WorkGraph(net);
    const jb = w.block(blockId);
    if (!JUNCTION_KINDS.has(jb.extras.kind)) return null;
    const parts = junctionParts(w, jb);
    const chain = parts.inPiece && parts.outPiece
      ? [parts.front, parts.inPiece, parts.outPiece, parts.rest]
      : [parts.front, parts.rest];
    return { specs: cloneSegmentSpecs(chain.flatMap((p) => p.segments)), pathIds: chain.map((p) => p.id) };
  } catch {
    return null;
  }
}

/**
 * The blocks that move together with `blockId` (the block plus every junction
 * hosted on it, transitively) and their paths — the preview set of the block
 * gizmo (§2.4a "Bewegungsmenge").
 */
export function blockMoveSet(net: NetworkInput, blockId: string): { blockIds: string[]; pathIds: string[] } {
  const blocks = net.blocks ?? [];
  const ids = new Set<string>([blockId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const b of blocks) {
      if (!ids.has(b.id) && JUNCTION_KINDS.has(b.extras.kind) && ids.has(b.extras.host ?? '')) { ids.add(b.id); grew = true; }
    }
  }
  return { blockIds: [...ids], pathIds: net.paths.filter((p) => !!p.block && ids.has(p.block)).map((p) => p.id) };
}

/**
 * plan-628 8.8 (E35): the blocks a DRAG of `blockId` takes along — the block's
 * move set ({@link blockMoveSet}) plus every straight/curve block downstream of
 * it, transitively over the successor (port) edges, each with its own move set.
 * The walk stops at junction blocks (a successor owned by a diverge / merge /
 * stub that is not hosted on the chain), at block-free paths, and at blocks
 * already taken (a loop is moved once, never twice). Successors are followed
 * only out of straight/curve paths: a junction's branch leads somewhere else.
 * A junction `blockId` answers its own move set (it slides, it does not drag).
 */
export function chainMoveSet(net: NetworkInput, blockId: string): { blockIds: string[]; pathIds: string[] } {
  const blocks = new Map((net.blocks ?? []).map((b) => [b.id, b]));
  const start = blockMoveSet(net, blockId);
  const own = blocks.get(blockId);
  if (!own || JUNCTION_KINDS.has(own.extras.kind)) return start;
  const pathById = new Map<string, PathGraphEntry>();
  for (const p of net.paths) if (!pathById.has(p.id)) pathById.set(p.id, p);
  const blockIds = new Set(start.blockIds);
  const pathIds = new Set(start.pathIds);
  const queue = [...start.pathIds];
  while (queue.length > 0) {
    const p = pathById.get(queue.shift()!);
    if (!p) continue;
    const pb = blocks.get(p.block);
    if (!pb || JUNCTION_KINDS.has(pb.extras.kind)) continue;
    for (const sid of p.successors) {
      if (pathIds.has(sid)) continue;
      const q = pathById.get(sid);
      if (!q || !q.block || blockIds.has(q.block)) continue;
      const qb = blocks.get(q.block);
      if (!qb || JUNCTION_KINDS.has(qb.extras.kind)) continue;
      const set = blockMoveSet(net, q.block);
      for (const id of set.blockIds) blockIds.add(id);
      for (const id of set.pathIds) if (!pathIds.has(id)) { pathIds.add(id); queue.push(id); }
    }
  }
  return { blockIds: [...blockIds], pathIds: net.paths.filter((p) => pathIds.has(p.id)).map((p) => p.id) };
}
