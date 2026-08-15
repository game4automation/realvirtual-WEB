// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-delta-probes — verified effect deltas for writing MCP tools (plan-707 part c).
 *
 * A writing tool answers with the action it was ASKED to perform (`{ ok: true, … }`),
 * not with the effect it HAD. Two of the three documented dead ends are exactly
 * that gap: a library open that reported a document and delivered an empty one,
 * and a kinematic group assignment that reported success and moved nothing.
 *
 * This module closes it with the same shape `rv-mcp-editor-feedback.ts` already
 * uses for visual feedback — ONE policy table plus two hooks around
 * `method.apply`, never logic in 73 tool bodies:
 *
 *      snapshot = probe.before(ctx, args)      // cheap, argument-addressed
 *      result   = await method.apply(...)
 *      delta    = probe.after(ctx, args, snapshot, parseResult(result))
 *      send(mergeDelta(result, delta))         // rides in the result JSON
 *
 * The delta travels INSIDE the result string under `verified`, deliberately not
 * as a new schema field: CONNECT projects an announced tool onto exactly
 * Name/Description/InputSchema/Annotations (McpServerSetup.cs), so a new
 * top-level field would be visible over the Node fallback and silently dropped
 * over the default transport. The result string is forwarded verbatim by both.
 *
 * Three rules this module does not bend:
 *
 *  - **A probe may never break a call.** Both halves run inside {@link safeProbe};
 *    `mergeDelta` returns the ORIGINAL string on any doubt. Same discipline as
 *    `applyEditorFeedback`.
 *  - **A probe reads only argument-addressed state.** One signal by name, one
 *    drive by name, one placement by id, one op count — never a whole map and
 *    never a whole op log. `before` runs ahead of every matching write.
 *  - **A wrong delta is worse than none.** The WS handler is not serial
 *    (`onmessage` calls `_handleMessage` unawaited), so two writes can interleave
 *    their probe windows. Overlap on the same scope is REPORTED
 *    (`ambiguous: true`) rather than attributed. Deliberately not serialised:
 *    the document queue would deadlock (a probe window wrapping the tool body
 *    would wait on ops queued behind itself) and a bridge mutex would turn one
 *    hung tool into a stalled bridge.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { LayoutPlannerPlugin } from '../layout-planner';
// Both are core-side and already static dependencies of the bridge: the asset
// store is a module-level pointer with type-only imports, the speed override a
// single module-scope number. Neither drags a plugin chunk into the entry (NF4).
import { getActiveAssetContext } from '../../core/editor/active-asset-store';
import { getDriveSpeedOverride } from '../../core/engine/rv-speed-override';

type Rec = Record<string, unknown>;

// ─── Budget ─────────────────────────────────────────────────────────────

/**
 * Maximum `changed` lines in one delta.
 *
 * Phase-0 measurement (plan-707) of the write results this rides on:
 * `web_signal_set_bool` 48 B, `web_drive_jog` ~55 B, `web_layout_place` ~130 B,
 * the editor's `_statusJson` ~250 B. A delta line is ~25-45 B, so eight lines
 * (~320 B) is the point where the verification is at most comparable to the
 * answer it annotates rather than dominating it. Over eight distinct effects
 * the COUNT is the information, not the list — hence the `more` counter instead
 * of a longer array. Do not raise this without re-measuring the result sizes.
 */
export const DELTA_MAX_ENTRIES = 8;

/**
 * Hard byte ceiling on the serialised delta.
 *
 * Sized from the same Phase-0 numbers: eight capped lines plus the flags come
 * to ~400 B, and 600 B leaves headroom for long node paths without ever
 * approaching the bridge frame budget (`enforceEnvelopeBudget` remains the net
 * behind this, but a delta must never be the reason a frame is rejected — an
 * oversized frame CLOSES the CONNECT socket and takes every pending call with
 * it). Roughly 150 tokens worst case, ~1 % of a 1 M window over a 100-call
 * authoring session.
 */
export const DELTA_MAX_BYTES = 600;

/** Longest single `changed` line; longer ones are truncated, never dropped. */
export const DELTA_MAX_ENTRY_CHARS = 120;

// ─── Types ──────────────────────────────────────────────────────────────

/** Compact effect delta, carried in the result JSON under `verified`. */
export interface ToolDelta {
  /** What actually changed — one short line each, capped at {@link DELTA_MAX_ENTRIES}. */
  changed: string[];
  /** Entries dropped by the cap. Omitted when 0. */
  more?: number;
  /**
   * The valuable bit: the tool reported success and the probe found NOTHING.
   * Stays valid under overlap — "nothing happened" is independent of other calls.
   */
  noop?: true;
  /** Another call wrote the same scope inside this probe window; `changed` is withheld. */
  ambiguous?: true;
  /** Plain-text reason; set only alongside `noop` or `ambiguous`. */
  why?: string;
}

export interface ProbeContext {
  viewer: RVViewer;
  tool: string;
  /** The bridge call id — a delta belongs to a CALL, never to a bare op index. */
  callId: number;
}

export interface DeltaProbe {
  /** Cheap pre-snapshot; also registers this call's scope. Must not throw. */
  before(ctx: ProbeContext, args: Rec): unknown;
  /** Diff against the snapshot. `null` = this probe has nothing to report. */
  after(ctx: ProbeContext, args: Rec, snapshot: unknown, result: Rec | null): ToolDelta | null;
}

// ─── In-flight registry (overlap detection) ─────────────────────────────

/**
 * Which calls currently hold a probe window on which scope.
 *
 * A "scope" is the thing a probe family can collide on: the open document for
 * op-log probes, `family:key` for argument-addressed ones. Two
 * `web_signal_set_bool` calls on different signals never collide; two editor
 * writes on the same document always can.
 */
const inFlight = new Map<string, Set<number>>();

/**
 * Overlap is recorded when it HAPPENS, not when a window closes.
 *
 * Reading the registry at `after` time only would catch the call that arrives
 * second and miss the one that arrived first — by then the late call has
 * already left and the early one sees an empty scope, so exactly one of the two
 * would claim the other's ops as its own. That is the failure this whole
 * mechanism exists to prevent, so entering a busy scope taints BOTH directions.
 */
const overlapped = new Map<string, number>();

const seat = (scope: string, callId: number): string => `${scope}#${callId}`;

/** Snapshot shape every probe carries, so overlap handling lives in one place. */
interface ScopedSnapshot {
  scope: string;
}

function enterScope(scope: string, callId: number): ScopedSnapshot {
  let set = inFlight.get(scope);
  if (!set) { set = new Set(); inFlight.set(scope, set); }
  for (const other of set) {
    if (other === callId) continue;
    overlapped.set(seat(scope, callId), other);   // we saw them
    overlapped.set(seat(scope, other), callId);   // they saw us
  }
  set.add(callId);
  return { scope };
}

/** Leave the scope; returns the id of a call that shared the window, or null. */
function leaveScope(snap: ScopedSnapshot, callId: number): number | null {
  const key = seat(snap.scope, callId);
  const other = overlapped.get(key) ?? null;
  overlapped.delete(key);
  const set = inFlight.get(snap.scope);
  if (set) {
    set.delete(callId);
    if (set.size === 0) inFlight.delete(snap.scope);
  }
  return other;
}

/**
 * Drop every trace of a call from the registry — the cleanup that ALWAYS runs.
 *
 * `leaveScope` handles the happy path, but it lives in `probe.after`, and
 * `after` does not run when the tool body throws. Without this the failed call
 * would stay in its scope forever and every later call there would truthfully
 * report `ambiguous` about a call that ended minutes ago — one throwing tool
 * silently disabling the delta for the rest of the session. The dispatcher
 * calls this from its `finally`; it is idempotent.
 */
export function releaseCall(callId: number): void {
  for (const [scope, set] of inFlight) {
    if (set.delete(callId) && set.size === 0) inFlight.delete(scope);
  }
  const suffix = `#${callId}`;
  for (const key of overlapped.keys()) {
    if (key.endsWith(suffix)) overlapped.delete(key);
  }
}

/** Test hook — the registry is module state and must not leak between cases. */
export function _resetInFlightForTest(): void {
  inFlight.clear();
  overlapped.clear();
}

/** Test hook — how many calls the registry still believes are running. */
export function _inFlightCountForTest(): number {
  let n = 0;
  for (const set of inFlight.values()) n += set.size;
  return n;
}

// ─── Delta construction ─────────────────────────────────────────────────

function truncate(line: string): string {
  return line.length <= DELTA_MAX_ENTRY_CHARS
    ? line
    : `${line.slice(0, DELTA_MAX_ENTRY_CHARS - 1)}…`;
}

/**
 * Build a capped delta from raw change lines.
 *
 * Enforces {@link DELTA_MAX_ENTRIES}, then {@link DELTA_MAX_BYTES} — the byte
 * pass matters because eight long node paths can exceed the ceiling that eight
 * short signal names never approach.
 */
export function makeDelta(lines: readonly string[], why?: string): ToolDelta {
  if (lines.length === 0) {
    return { changed: [], noop: true, ...(why ? { why } : {}) };
  }
  const kept = lines.slice(0, DELTA_MAX_ENTRIES).map(truncate);
  let dropped = lines.length - kept.length;
  let delta: ToolDelta = {
    changed: kept,
    ...(dropped > 0 ? { more: dropped } : {}),
    ...(why ? { why } : {}),
  };
  // Byte pass: shed entries from the end until the serialised delta fits.
  while (JSON.stringify(delta).length > DELTA_MAX_BYTES && delta.changed.length > 1) {
    delta.changed = delta.changed.slice(0, -1);
    dropped++;
    delta = { ...delta, changed: delta.changed, more: dropped };
  }
  return delta;
}

/** The `ambiguous` answer: overlap seen AND something changed. */
function ambiguousDelta(otherCallId: number): ToolDelta {
  return {
    changed: [],
    ambiguous: true,
    why: `overlapping call #${otherCallId} wrote the same scope — changes not attributable`,
  };
}

// ─── Result handling ────────────────────────────────────────────────────

/**
 * Turn a raw tool result into an object for `probe.after`, or `null`.
 *
 * THE one parse site: no tool body and no probe parses its own result. Returns
 * `null` rather than throwing for anything that is not a JSON OBJECT — image
 * payloads from `web_screenshot*` / `web_render`, JSON arrays, empty strings.
 * A probe must therefore tolerate `result === null`.
 */
export function parseResult(resultJson: unknown): Rec | null {
  if (typeof resultJson !== 'string' || resultJson.length === 0) return null;
  try {
    const parsed = JSON.parse(resultJson);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Rec;
  } catch { /* non-JSON results are normal, not exceptional */ }
  return null;
}

/**
 * Attach a delta to a result string. Defensive in every direction:
 *  - not a JSON object (images!) → returned unchanged
 *  - result carries `error`      → returned unchanged; a failure IS the answer,
 *                                  and errors must not migrate into `verified`
 *  - anything throws             → returned unchanged
 */
export function mergeDelta(resultJson: string, delta: ToolDelta | null): string {
  if (!delta) return resultJson;
  const parsed = parseResult(resultJson);
  if (!parsed) return resultJson;
  if (parsed['error'] !== undefined) return resultJson;
  try {
    return JSON.stringify({ ...parsed, verified: delta });
  } catch {
    return resultJson;
  }
}

/** Run a probe half; swallow everything. A probe failure is never a call failure (F9). */
export function safeProbe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

// ─── Probe helpers ──────────────────────────────────────────────────────

function str(args: Rec, key: string): string {
  const v = args[key];
  return typeof v === 'string' ? v : '';
}

function fmt(v: unknown): string {
  if (v === null) return 'null';
  if (v === undefined) return '—';
  if (typeof v === 'number') return String(+v.toFixed(4));
  if (typeof v === 'object') return Array.isArray(v) ? `[${v.map(fmt).join(',')}]` : '{…}';
  return String(v);
}

/**
 * The generic argument-addressed probe: read ONE value before, the same value
 * after, report the transition. `read` must be O(1) in the size of the model.
 */
function valueProbe(
  family: string,
  keyOf: (args: Rec) => string,
  read: (ctx: ProbeContext, args: Rec) => Record<string, unknown> | null,
): DeltaProbe {
  return {
    before(ctx, args) {
      const scope = `${family}:${keyOf(args)}`;
      return { ...enterScope(scope, ctx.callId), values: read(ctx, args) };
    },
    after(ctx, args, snapshot, _result) {
      const snap = snapshot as (ScopedSnapshot & { values: Record<string, unknown> | null }) | undefined;
      if (!snap) return null;
      const other = leaveScope(snap, ctx.callId);
      const before = snap.values;
      const after = read(ctx, args);
      if (before === null || after === null) return null;
      const lines: string[] = [];
      for (const key of Object.keys(after)) {
        if (Object.is(before[key], after[key])) continue;
        lines.push(`${keyOf(args) || family}.${key}: ${fmt(before[key])}→${fmt(after[key])}`);
      }
      if (lines.length > 0 && other !== null) return ambiguousDelta(other);
      return makeDelta(lines, lines.length === 0 ? 'no observable change' : undefined);
    },
  };
}

// ─── Signals ────────────────────────────────────────────────────────────

/**
 * O(1) by construction — `signals.get(name)`, never `getAll()`. A model with
 * 5000 signals must cost exactly the same as one with five.
 */
const signalProbe = valueProbe(
  'signal',
  (a) => str(a, 'name'),
  (ctx, a) => {
    const store = ctx.viewer.signalStore;
    const name = str(a, 'name');
    if (!store || !name) return null;
    return { value: store.get(name) };
  },
);

// ─── Drives ─────────────────────────────────────────────────────────────

/**
 * The COMMAND fields, not the position: a jog sets flags now and the position
 * only moves on the next tick, so a position diff would report `noop` on a
 * perfectly successful call.
 */
const driveProbe = valueProbe(
  'drive',
  (a) => str(a, 'name'),
  (ctx, a) => {
    const name = str(a, 'name');
    const d = ctx.viewer.drives?.find((x) => x.name === name);
    if (!d) return null;
    return {
      jogForward: d.jogForward,
      jogBackward: d.jogBackward,
      targetSpeed: d.targetSpeed,
    };
  },
);

/** Master speed factor — one global number, addressed by nothing. */
const speedOverrideProbe: DeltaProbe = {
  before(ctx, _args) {
    return { ...enterScope('drive:*speed', ctx.callId), factor: readSpeedOverride() };
  },
  after(ctx, _args, snapshot, _result) {
    const snap = snapshot as (ScopedSnapshot & { factor: number | null }) | undefined;
    if (!snap) return null;
    const other = leaveScope(snap, ctx.callId);
    const after = readSpeedOverride();
    if (snap.factor === null || after === null) return null;
    if (snap.factor === after) return makeDelta([], 'speed factor unchanged');
    if (other !== null) return ambiguousDelta(other);
    return makeDelta([`speedOverride: ${fmt(snap.factor)}→${fmt(after)}`]);
  },
};

function readSpeedOverride(): number | null {
  const v = getDriveSpeedOverride();
  return typeof v === 'number' ? v : null;
}

// ─── Simulation ─────────────────────────────────────────────────────────

const simProbe: DeltaProbe = {
  before(ctx, _args) {
    const v = ctx.viewer;
    return {
      ...enterScope('sim', ctx.callId),
      paused: v.isSimulationPaused,
      mus: v.transportManager?.mus.length ?? 0,
    };
  },
  after(ctx, _args, snapshot, _result) {
    const snap = snapshot as (ScopedSnapshot & { paused: boolean; mus: number }) | undefined;
    if (!snap) return null;
    const other = leaveScope(snap, ctx.callId);
    const v = ctx.viewer;
    const lines: string[] = [];
    const paused = v.isSimulationPaused;
    if (paused !== snap.paused) {
      lines.push(`sim: ${snap.paused ? 'paused' : 'running'}→${paused ? 'paused' : 'running'}`);
    }
    const mus = v.transportManager?.mus.length ?? 0;
    if (mus !== snap.mus) lines.push(`MUs: ${snap.mus}→${mus}`);
    if (lines.length > 0 && other !== null) return ambiguousDelta(other);
    return makeDelta(lines, lines.length === 0 ? 'simulation state unchanged' : undefined);
  },
};

// ─── Workspace mode ─────────────────────────────────────────────────────

const modeProbe: DeltaProbe = {
  before(ctx, _args) {
    return { ...enterScope('mode', ctx.callId), mode: ctx.viewer.modes.activeMode };
  },
  after(ctx, _args, snapshot, _result) {
    const snap = snapshot as (ScopedSnapshot & { mode: string | null }) | undefined;
    if (!snap) return null;
    const other = leaveScope(snap, ctx.callId);
    const after = ctx.viewer.modes.activeMode;
    if (after === snap.mode) {
      return makeDelta([], `mode stayed ${String(snap.mode)}`);
    }
    if (other !== null) return ambiguousDelta(other);
    return makeDelta([`mode: ${String(snap.mode)}→${String(after)}`]);
  },
};

// ─── Editor: the op-log probe ───────────────────────────────────────────

/**
 * Reads `getSnapshot().opCount` before and the appended tail after.
 *
 * `before` deliberately does NOT touch the `ops` getter. That getter was an
 * O(n) re-map of the whole log until plan-710 made it a plain cast; a probe
 * that runs ahead of every editor write must not depend on that staying true.
 * `after` takes only the tail, through {@link AssetDocument.opsSince}.
 *
 * `composite` ops are FLATTENED and counted by primitive kind — that is exactly
 * the distinction the group-assignment dead end turned on: `setField×1` alone
 * means the group was NAMED, `reparentNode×N` means its members actually moved.
 */
interface EditorSnapshot extends ScopedSnapshot {
  opCount: number;
  docId: string | null;
}

/**
 * Two field reads and a Map insert — nothing that scales with the model.
 *
 * Deliberately does NOT count nodes. Counting means a full `traverse` of the
 * scene graph, which on a real CAD import is six figures of callback per
 * EDITOR WRITE, for a number this probe never reads. Only the lifecycle probe
 * needs a node count, it needs it once per open, and it takes it in `after`.
 */
function editorSnapshot(ctx: ProbeContext): EditorSnapshot | null {
  const doc = activeDoc(ctx);
  if (!doc) return null;
  const snap = doc.getSnapshot();
  return {
    ...enterScope(`editor:${snap.id}`, ctx.callId),
    opCount: snap.opCount,
    docId: snap.id,
  };
}

/** Count opCounts by primitive kind, flattening composites. */
function summariseOps(ops: readonly { kind: string; ops?: readonly { kind: string }[] }[]): string[] {
  const counts = new Map<string, number>();
  const bump = (kind: string): void => { counts.set(kind, (counts.get(kind) ?? 0) + 1); };
  for (const op of ops) {
    if (op.kind === 'composite' && Array.isArray(op.ops)) {
      for (const child of op.ops) bump(child.kind);
    } else {
      bump(op.kind);
    }
  }
  return [...counts.entries()]
    .sort((a, b) => (b[1] - a[1]) || a[0].localeCompare(b[0]))
    .map(([kind, n]) => `${kind}×${n}`);
}

const editorOpProbe: DeltaProbe = {
  before(ctx, _args) {
    return editorSnapshot(ctx) ?? undefined;
  },
  after(ctx, _args, snapshot, _result) {
    const snap = snapshot as EditorSnapshot | undefined;
    if (!snap) return null;
    const other = leaveScope(snap, ctx.callId);
    const doc = activeDoc(ctx);
    if (!doc) return makeDelta([], 'the document is gone — nothing to compare');
    const now = doc.getSnapshot();
    if (now.id !== snap.docId) {
      // A different document is open; op indices from the old one mean nothing.
      return makeDelta([`document: ${String(snap.docId)}→${now.id}`]);
    }
    if (now.opCount === snap.opCount) {
      // Valid even under overlap: if NOTHING was appended, this call appended
      // nothing either. That statement does not depend on the other call.
      return makeDelta([], 'the tool reported success but appended no op');
    }
    if (other !== null) return ambiguousDelta(other);
    const tail = doc.opsSince(snap.opCount);
    return makeDelta(summariseOps(tail as readonly { kind: string; ops?: readonly { kind: string }[] }[]));
  },
};

/**
 * Lifecycle probe for open / close: op indices are meaningless across a
 * document swap, so this one compares IDENTITY and node count.
 *
 * The `nodeCount <= 1` rule is the library dead end verbatim: a document that
 * declares a library GLB base and holds no tree did not open, whatever its
 * result said.
 */
const editorLifecycleProbe: DeltaProbe = {
  before(ctx, _args) {
    const doc = activeDoc(ctx);
    const snap = doc?.getSnapshot() ?? null;
    return {
      ...enterScope('editor:lifecycle', ctx.callId),
      docId: snap?.id ?? null,
      name: snap?.name ?? null,
    };
  },
  after(ctx, _args, snapshot, _result) {
    const snap = snapshot as (ScopedSnapshot & { docId: string | null; name: string | null }) | undefined;
    if (!snap) return null;
    leaveScope(snap, ctx.callId);
    const doc = activeDoc(ctx);
    if (!doc) {
      return snap.docId === null
        ? makeDelta([], 'no document before and none after')
        : makeDelta([`document closed: ${snap.name ?? snap.docId}`]);
    }
    const now = doc.getSnapshot();
    const nodeCount = countNodes(ctx);
    const baseKind = String((now.base as { kind?: unknown } | null)?.kind ?? 'unknown');
    if (now.id === snap.docId) {
      return makeDelta([], `still the same document "${now.name}"`);
    }
    // plan-716 §2.6 renamed the kind this reads (`libraryGlb` → `document`).
    // `baseKind` is a stringified field, so the compiler could not flag the
    // stale literal — it would simply have gone silently false and taken the A2
    // dead-end warning with it, which is the one diagnostic that catches a
    // large saved asset opening empty.
    if (baseKind === 'document' && nodeCount <= 1) {
      return {
        changed: [`document: ${now.name} (${baseKind})`],
        noop: true,
        why: `opened from the library but the tree is empty (nodeCount ${nodeCount}) — `
          + 're-import from the project\'s imports/ folder',
      };
    }
    return makeDelta([`document: ${now.name} (${baseKind}, ${nodeCount} nodes)`]);
  },
};

/** Save: the observable effect is the dirty flag going down. */
const editorSaveProbe: DeltaProbe = {
  before(ctx, _args) {
    const snap = activeDoc(ctx)?.getSnapshot() ?? null;
    return { ...enterScope('editor:lifecycle', ctx.callId), dirty: snap?.dirty ?? null, name: snap?.name ?? null };
  },
  after(ctx, _args, snapshot, _result) {
    const snap = snapshot as (ScopedSnapshot & { dirty: boolean | null; name: string | null }) | undefined;
    if (!snap) return null;
    leaveScope(snap, ctx.callId);
    const now = activeDoc(ctx)?.getSnapshot() ?? null;
    if (snap.dirty === null || now === null) return null;
    const lines: string[] = [];
    if (now.dirty !== snap.dirty) lines.push(`dirty: ${snap.dirty}→${now.dirty}`);
    if (now.name !== snap.name) lines.push(`name: ${String(snap.name)}→${now.name}`);
    return makeDelta(lines, lines.length === 0 ? 'still dirty — nothing was persisted' : undefined);
  },
};

/**
 * The active document, reached WITHOUT importing the asset editor.
 *
 * `active-asset-store` lives in core and holds nothing but a module-level
 * pointer (the editor plugin sets it); the guard module that reads it is
 * already a static dependency of the editor tools. Nothing here pulls the
 * editor plugin chunk into the eager bundle.
 */
interface ProbeDoc {
  getSnapshot(): { id: string; name: string; opCount: number; dirty: boolean; base: unknown };
  opsSince(index: number): readonly unknown[];
}

/**
 * Test seam: a stand-in document, so the op-log probe can be exercised without
 * booting the asset-editor plugin. `null` restores the real store.
 */
let _docOverride: (() => ProbeDoc | null) | null = null;

/** Test hook — override the active-document lookup. */
export function _setActiveDocForTest(fn: (() => ProbeDoc | null) | null): void {
  _docOverride = fn;
}

function activeDoc(_ctx: ProbeContext): ProbeDoc | null {
  if (_docOverride) return _docOverride();
  return (getActiveAssetContext()?.doc as unknown as ProbeDoc | undefined) ?? null;
}

function countNodes(ctx: ProbeContext): number {
  let n = 0;
  ctx.viewer.currentModelRoot?.traverse(() => { n++; });
  return n;
}

// ─── Layout ─────────────────────────────────────────────────────────────

/**
 * Placement COUNT only — the transform of one placement lives behind the
 * planner plugin, and reaching for it would drag that plugin into the probe
 * path for a line an agent can read from `web_layout_list` anyway.
 */
function placementCount(ctx: ProbeContext): number | null {
  // Type-only import + runtime lookup by plugin id: no chunk is pulled in.
  const planner = ctx.viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  if (!planner) return null;
  return planner.snapshotPlacements().placements.length;
}

const layoutProbe: DeltaProbe = {
  before(ctx, _args) {
    return {
      ...enterScope('layout', ctx.callId),
      count: placementCount(ctx),
    };
  },
  after(ctx, _args, snapshot, _result) {
    const snap = snapshot as (ScopedSnapshot & { count: number | null }) | undefined;
    if (!snap) return null;
    const other = leaveScope(snap, ctx.callId);
    const after = placementCount(ctx);
    if (snap.count === null || after === null) return null;
    if (after === snap.count) {
      return makeDelta([], 'the placement count did not change');
    }
    if (other !== null) return ambiguousDelta(other);
    return makeDelta([`placements: ${snap.count}→${after}`]);
  },
};

// ─── The policy table ───────────────────────────────────────────────────

/**
 * Tool name → probe. Absence is a DECISION, not an omission:
 *
 *  - `web_camera_*`, `web_view_*`, `web_select*`, `web_node_bounds` are
 *    classified as writes because a watching operator sees the view jump — they
 *    persist nothing, so a before/after over a camera matrix would be pure
 *    noise charged against the token budget.
 *  - `web_editor_verify_drive` and `web_editor_mechanism_jog` are transient by
 *    design (no ops, no undo entry); reporting `noop` on them would be
 *    technically true and actively misleading.
 *  - read-only tools have nothing to verify.
 */
export const DELTA_PROBES: Record<string, DeltaProbe> = {
  // Signals
  web_signal_set_bool: signalProbe,
  web_signal_set_float: signalProbe,

  // Drives
  web_drive_jog: driveProbe,
  web_drive_stop: driveProbe,
  web_drive_speed_override: speedOverrideProbe,

  // Simulation
  web_sim_play_pause: simProbe,
  web_sim_reset: simProbe,

  // Workspace
  web_mode_set: modeProbe,

  // Layout
  web_layout_place: layoutProbe,
  web_layout_move: layoutProbe,
  web_layout_remove: layoutProbe,
  web_layout_snap_attach: layoutProbe,

  // Asset editor — lifecycle
  web_editor_open: editorLifecycleProbe,
  web_editor_close: editorLifecycleProbe,
  web_editor_save: editorSaveProbe,

  // Asset editor — everything that appends ops
  web_editor_undo: editorOpProbe,
  web_editor_redo: editorOpProbe,
  web_editor_transform: editorOpProbe,
  web_editor_zero_position: editorOpProbe,
  web_editor_rotate90: editorOpProbe,
  web_editor_to_ground: editorOpProbe,
  web_editor_pivot: editorOpProbe,
  web_editor_rename: editorOpProbe,
  web_editor_delete: editorOpProbe,
  web_editor_set_visible: editorOpProbe,
  web_editor_create_empty: editorOpProbe,
  web_editor_reparent: editorOpProbe,
  web_editor_add_component: editorOpProbe,
  web_editor_remove_component: editorOpProbe,
  web_editor_set_field: editorOpProbe,
  web_editor_create_kinematic: editorOpProbe,
  web_editor_assign_to_kinematic: editorOpProbe,
  web_editor_kinematize: editorOpProbe,
  web_editor_add_signal: editorOpProbe,
  web_editor_convert_signal: editorOpProbe,
  web_editor_toggle_signal_direction: editorOpProbe,
  web_editor_add_logic_step: editorOpProbe,
  web_editor_assign_material: editorOpProbe,
  web_editor_materialize: editorOpProbe,
  web_editor_import_glb: editorOpProbe,
  web_editor_import_cad: editorOpProbe,
  web_editor_mechanism_create: editorOpProbe,
  web_editor_mechanism_add_joint: editorOpProbe,
  web_editor_mechanism_set_anchor: editorOpProbe,
  web_editor_mechanism_assign_drive: editorOpProbe,
  // plan-706: the rest of the mechanism authoring surface. All six go through
  // the same `_mechCommit` → `runMechanismPlan` → ONE `withTransaction`, so the
  // op-count probe reports them exactly like every other composite — no new
  // probe, no logic in the tool bodies. `_statics`, `_test_start` and
  // `_test_stop` are deliberately absent: they are transient by design (no ops,
  // no undo entry), and a `noop` on them would be true and misleading at once.
  web_editor_mechanism_set_anchor_snap: editorOpProbe,
  web_editor_mechanism_set_axis: editorOpProbe,
  web_editor_mechanism_add_body: editorOpProbe,
  web_editor_mechanism_set_mass: editorOpProbe,
  web_editor_mechanism_set_limits: editorOpProbe,
  web_editor_mechanism_fix: editorOpProbe,
  web_editor_shortcut: editorOpProbe,
};
