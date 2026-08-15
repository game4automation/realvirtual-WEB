// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-document-stack — the document STACK (plan-703 Phase 4, §2.7.1).
 *
 * Phase 1 made one document class; this makes a stack of them. A frame is an
 * asset, its op log, its dirty bit, and the occurrence chain it was entered
 * through. Descending pushes a frame, Back pops one.
 *
 * ## Frame identity is per FRAME, never per asset id (§2.7.1, A8)
 *
 * The composition is a DAG: `A → B → A` is only a cycle when it is the *same*
 * resolution path (`rv-glb-compose.ts` scopes its `visited` set per path). So
 * the same asset may legitimately sit in the stack twice, and the two must be
 * two op logs, two dirty bits, two undo stacks. There is deliberately **no
 * instance cache keyed by asset id** here — `scene-store-singleton.ts` is the
 * house counter-example, and copying it would let an edit in the lower frame
 * contaminate the upper frame's history.
 *
 * The consequence has to be named rather than hidden: once the lower frame
 * SAVES, the upper frame of the same asset describes a file that has moved on.
 * {@link RvDocumentStack.markDocumentSaved} marks it {@link RvStackFrame.stale},
 * and the pop onto it reports that instead of quietly continuing.
 *
 * ## Isolation: the INTENT is stacked, not the snapshot (§2.7.2, A5)
 *
 * `RVViewer.isolateNodes` has exactly ONE slot and begins by calling
 * `exitIsolate()` itself ("takes over any prior isolate cleanly",
 * `rv-viewer.ts:4438`). A three-level descend would therefore leave the middle
 * frame with no snapshot to fall back to. The fix is not to copy the snapshot
 * into the frame — review round 2 measured that and rejected it, because
 * `isolateNodes` also drives `groups.setExternalIsolated()`
 * (`rv-group-registry.ts:316`), and through it the dimming, the pick gate
 * (`RaycastManager.setIsolationGate`, installed once at `rv-viewer.ts:3553`)
 * and the camera fit. Writing `.visible` back would restore one of four
 * effects.
 *
 * So each frame keeps the ROOTS IT ISOLATED, and a pop **calls
 * `isolateNodes(thoseRoots)` again**; an empty stack calls `exitIsolate()`.
 * The viewer's one-slot contract stays untouched, `rv-viewer.ts` needs no
 * change, and no second isolation mechanism enters the codebase (§5.1).
 *
 * ## What is NOT here
 *
 * Loading, composing and recomposing. This file is synchronous bookkeeping over
 * frames; everything that touches bytes, the loader or the viewer's scene lives
 * in `rv-document-recompose.ts`, which drives this class through a host.
 */

import type { Object3D } from 'three';
import { ROOT_OCCURRENCE, childOccurrence, getNodeId } from '../engine/rv-node-id';
import { getAssetOverrides } from '../engine/rv-asset-reference';
import type { RvDocument } from './rv-document';
import type { RvDraftFrameKey } from './rv-document-drafts';

// ─── The surfaces the stack speaks to ───────────────────────────────────

/**
 * The viewer surface the stack drives.
 *
 * Deliberately two methods wide. `RVViewer` satisfies it structurally, and a
 * renderer-free test can satisfy it with a real `GroupRegistry` plus stubs —
 * which is what keeps §9.4 out of a `WebGLRenderer`.
 */
export interface RvStackViewer {
  isolateNodes(nodes: Object3D[]): void;
  exitIsolate(): void;
}

/**
 * The document a frame holds.
 *
 * `AssetDocument` satisfies this structurally, so the stack does not import the
 * editor lineage — and a test can push a bare `RvDocument` wrapper.
 */
export interface RvStackDocument {
  readonly id: string;
  /** The unified op log of THIS frame. */
  readonly document: RvDocument;
  /**
   * Bind the document to this frame's slot in the Phase-2 draft keyspace.
   *
   * OPTIONAL because the interface is structural and a bare test double has no
   * persistence. Where it exists (`AssetDocument`), this is the Phase-3 →
   * Phase-4 hand-over: the legacy single-slot writer only knew one key because
   * nothing produced an occurrence chain until this class did.
   */
  setDraftFrame?(frame: RvDraftFrameKey | null): void;
  dispose(): void;
}

/** Why a frame no longer describes the file it was opened from. */
export type RvStackStaleReason =
  /** A lower frame of the same asset saved while this one was open (§2.7.1). */
  | 'saved-below'
  /** The child file was deleted or moved out from under the frame (§2.7.3). */
  | 'source-gone';

// ─── Frames ─────────────────────────────────────────────────────────────

export interface RvStackFrame {
  /** Identity of the DOCUMENT instance — unique per frame, never per asset. */
  readonly documentId: string;
  /** Identity of the ASSET. Two frames may legitimately share it. */
  readonly assetId: string;
  /** Occurrence chain from the root down to this frame; `''` is the root. */
  readonly occurrence: string;
  /** The reference node this frame was entered through; null for the root. */
  readonly referenceNodeId: string | null;
  /** Draft slot of this frame in the Phase-2 keyspace. */
  readonly draftFrame: RvDraftFrameKey;
  /** Display name, for the breadcrumb chip. */
  name: string;
  doc: RvStackDocument;
  /**
   * The roots THIS frame isolated — the isolation intent, replayed on pop.
   * Empty for a frame that isolates nothing (the root frame).
   */
  isolatedRoots: Object3D[];
  /**
   * How many component patches of the instance we descended FROM are hidden
   * while this frame is open (§2.7.2). 0 for the root frame.
   */
  suppressedOverrides: number;
  stale: boolean;
  staleReason: RvStackStaleReason | null;
}

/** One breadcrumb chip. Chip row form: `MobileSelectionSheet.tsx:98-118`. */
export interface RvStackCrumb {
  index: number;
  label: string;
  occurrence: string;
  /** The reference node id this crumb was entered through; null at the root. */
  referenceNodeId: string | null;
  dirty: boolean;
  stale: boolean;
  /** True for the frame currently being edited (the top). */
  current: boolean;
}

export interface RvStackSnapshot {
  depth: number;
  crumbs: RvStackCrumb[];
  topDocumentId: string | null;
  /** True when ANY frame is dirty — the project-level exit guard reads this. */
  anyDirty: boolean;
  /** Hint line for the top frame, or null when it suppresses nothing. */
  suppressionNotice: string | null;
}

export interface RvRootFrameInput {
  doc: RvStackDocument;
  assetId: string;
  name: string;
}

export interface RvChildFrameInput {
  doc: RvStackDocument;
  assetId: string;
  name: string;
  /** NodeId of the reference node in the PARENT frame. */
  referenceNodeId: string;
  /** What this frame isolates — usually the grafted child subtree root. */
  isolatedRoots: Object3D[];
  /** Patches of the parent instance that are hidden while this frame is open. */
  suppressedOverrides: number;
}

/**
 * The hint line §2.7.2 requires.
 *
 * German, because it is user-facing UI copy in a German-language product
 * surface and the plan quotes it verbatim.
 */
export function describeSuppressedOverrides(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 Override dieser Instanz ist ausgeblendet'
    : `${count} Overrides dieser Instanz sind ausgeblendet`;
}

/**
 * The unsaved half of the same question (plan-703 Phase 7, Lauf 12).
 *
 * A field the user has just typed inside a referenced subtree is a real
 * instance override — `guardReferenceOp` admits it as `scope: 'override'` and
 * the bake routes it into `AssetOverrides.byNodeId` — but until the document is
 * SAVED it exists only in the op log and in the inspector's overlay cache. The
 * descend hint reads persisted state, so without this it would say "0" about an
 * edit the descend is, in fact, about to hide.
 *
 * This is the SAME source the badge already unions in
 * (`rv-property-inspector.tsx:1096-1099` → `getOverriddenFields` over the
 * extras-editor overlay), passed in rather than imported: the overlay lives on
 * a React-bearing plugin module and this file is core. The host supplies it
 * (`RvRecomposeHost.pendingOverrides`), so nothing here learns about React or
 * about the registry.
 */
export interface RvPendingOverrideSource {
  /** `nodePath` → `componentType` → `fieldName` → value — the overlay verbatim. */
  readonly nodes: Readonly<Record<string, Record<string, Record<string, unknown>>>>;
  /** Scene path → live node. `NodeRegistry.getNode` satisfies it structurally. */
  resolve(nodePath: string): Object3D | null | undefined;
}

/** How a node inside a reference is addressed by an `AssetOverrides` key. */
interface ReferenceAddress {
  /** The node's own id — `byNodeId`'s key. Null when the node carries none. */
  nodeId: string | null;
  /**
   * Path relative to the GRAFTED CHILD ROOT — `byPath`'s key.
   *
   * The frame is `makeSubtreeResolvers(clone)`'s, where `clone` is the child
   * root composition added under the reference node
   * (`rv-glb-compose.ts:640-648`): the root itself contributes no segment, so
   * a direct child of it is addressed by its bare name. Any other frame would
   * silently fail to line pending edits up with persisted ones.
   */
  relPath: string;
}

/**
 * Where `node` sits inside `referenceNode`, or null when it is not inside it.
 *
 * Ancestry, not `outermostReference`: the question is "does the descend hide
 * this edit", and that is answered by the subtree about to be replaced — which
 * holds for a nested reference just the same.
 */
function addressInReference(referenceNode: Object3D, node: Object3D): ReferenceAddress | null {
  const segments: string[] = [];
  let cur: Object3D = node;
  while (cur.parent && cur.parent !== referenceNode) {
    segments.unshift(cur.name);
    cur = cur.parent;
  }
  if (!cur.parent) return null;
  return { nodeId: getNodeId(node), relPath: segments.join('/') };
}

/**
 * How many component patches a reference node carries.
 *
 * Counted per (node, component) pair, which is what the user sees as "an
 * override" in the inspector — not per field, and not per node.
 *
 * `pending` is optional and, when omitted, the result is exactly the persisted
 * count it always was. When given, an unsaved edit inside the subtree counts
 * too — unless the same (node, component) is ALREADY persisted, in which case
 * it is the same override being re-typed and the save will merge the two into
 * one entry. The de-duplication tries both addressings in the order
 * `applyAssetOverrides` resolves them (`byNodeId`, then `byPath`), because a
 * file written before ids existed addresses the same node the other way.
 */
export function countInstanceOverrides(
  referenceNode: Object3D,
  pending?: RvPendingOverrideSource | null,
): number {
  const overrides = getAssetOverrides(referenceNode);
  let count = 0;
  // Key namespaces stay separate (`id:` / `path:`) so this loop reproduces the
  // old plain sum: two entries addressing one node two ways were counted twice
  // before and still are. Only the PENDING side de-duplicates against them.
  const persisted = new Set<string>();
  for (const [nodeId, patch] of Object.entries(overrides?.byNodeId ?? {})) {
    for (const componentType of Object.keys(patch)) {
      persisted.add(`id:${nodeId} ${componentType}`);
      count++;
    }
  }
  for (const [relPath, patch] of Object.entries(overrides?.byPath ?? {})) {
    for (const componentType of Object.keys(patch)) {
      persisted.add(`path:${relPath} ${componentType}`);
      count++;
    }
  }

  if (!pending) return count;

  const seen = new Set<string>();
  for (const [nodePath, byComponent] of Object.entries(pending.nodes ?? {})) {
    const node = pending.resolve(nodePath);
    if (!node) continue;
    const address = addressInReference(referenceNode, node);
    if (!address) continue;
    for (const [componentType, fields] of Object.entries(byComponent ?? {})) {
      if (!fields || Object.keys(fields).length === 0) continue;
      if (address.nodeId && persisted.has(`id:${address.nodeId} ${componentType}`)) continue;
      if (address.relPath && persisted.has(`path:${address.relPath} ${componentType}`)) continue;
      // One overlay entry per node path, but two paths can resolve to the same
      // node (registry aliases after a kinematic reparent — `doc-node-paths.md`).
      const key = `${address.nodeId ?? `path:${address.relPath}`} ${componentType}`;
      if (seen.has(key)) continue;
      seen.add(key);
      count++;
    }
  }
  return count;
}

// ─── The stack ──────────────────────────────────────────────────────────

export interface RvDocumentStackOptions {
  viewer: RvStackViewer;
  /** Namespaces every draft key. Null is a real state — see `RvDraftFrameKey`. */
  projectId: string | null;
}

export class RvDocumentStack {
  private readonly _viewer: RvStackViewer;
  private readonly _projectId: string | null;
  private readonly _frames: RvStackFrame[] = [];
  private readonly _listeners = new Set<() => void>();
  private _snapshot: RvStackSnapshot | null = null;
  /** Per-frame unsubscribe from the document, so dirty changes wake the UI. */
  private readonly _unsubs = new Map<string, () => void>();

  constructor(opts: RvDocumentStackOptions) {
    this._viewer = opts.viewer;
    this._projectId = opts.projectId;
  }

  // ─── Reading ──────────────────────────────────────────────────────────

  get frames(): readonly RvStackFrame[] { return this._frames; }
  get depth(): number { return this._frames.length; }
  get isEmpty(): boolean { return this._frames.length === 0; }
  get root(): RvStackFrame | null { return this._frames[0] ?? null; }
  get top(): RvStackFrame | null { return this._frames[this._frames.length - 1] ?? null; }
  get projectId(): string | null { return this._projectId; }

  frameAt(index: number): RvStackFrame | null { return this._frames[index] ?? null; }

  /**
   * The breadcrumb.
   *
   * The chain is not re-derived here: `occurrenceSegments(top.occurrence)` IS
   * the address, and every frame's occurrence is a prefix of it by construction
   * ({@link _assertChain} proves that in debug builds). What this adds is only
   * what a chip needs on top of the id — the label and the two flags.
   */
  breadcrumb(): RvStackCrumb[] {
    const last = this._frames.length - 1;
    return this._frames.map((f, i) => ({
      index: i,
      label: f.name,
      occurrence: f.occurrence,
      referenceNodeId: f.referenceNodeId,
      dirty: f.doc.document.dirty,
      stale: f.stale,
      current: i === last,
    }));
  }

  /** Every dirty frame, bottom first. The project-level exit guard's input. */
  dirtyFrames(): RvStackFrame[] {
    return this._frames.filter((f) => f.doc.document.dirty);
  }

  /** True when any frame has unsaved work (§2.7.3: the guard spans the stack). */
  get anyDirty(): boolean {
    return this._frames.some((f) => f.doc.document.dirty);
  }

  /** Every frame holding the given asset — the staleness rule's input. */
  framesOfAsset(assetId: string): RvStackFrame[] {
    return this._frames.filter((f) => f.assetId === assetId);
  }

  /**
   * The dirty frames in the shape the project-level exit guard consumes.
   *
   * The consumer this method exists for lives in `project-store.ts`
   * (`setDirtyDocumentsProbe`), and the projection is here rather than there so
   * the store stays free of any knowledge of frames. Bottom first, because that
   * is the order the user descended in and therefore the order the question
   * "save these three?" reads in.
   */
  dirtyDocuments(): Array<{ name: string; depth: number }> {
    return this.dirtyFrames().map((f) => ({
      name: f.name,
      depth: this._frames.indexOf(f),
    }));
  }

  /** Hint line for the top frame (§2.7.2), or null when nothing is hidden. */
  suppressionNotice(): string | null {
    const top = this.top;
    return top ? describeSuppressedOverrides(top.suppressedOverrides) : null;
  }

  // ─── Pushing ──────────────────────────────────────────────────────────

  /**
   * Install the bottom frame.
   *
   * Does NOT isolate: the root document owns the whole viewport, which is what
   * "not isolated" means. Replacing an existing root is refused — the stack is
   * torn down and rebuilt for a new root document, so that a half-swapped stack
   * cannot exist.
   */
  pushRoot(input: RvRootFrameInput): RvStackFrame {
    if (this._frames.length > 0) {
      throw new Error('RvDocumentStack: the stack already has a root — clear() it first.');
    }
    const frame: RvStackFrame = {
      documentId: input.doc.id,
      assetId: input.assetId,
      occurrence: ROOT_OCCURRENCE,
      referenceNodeId: null,
      draftFrame: {
        projectId: this._projectId,
        rootDocumentId: input.doc.id,
        occurrence: ROOT_OCCURRENCE,
      },
      name: input.name,
      doc: input.doc,
      isolatedRoots: [],
      suppressedOverrides: 0,
      stale: false,
      staleReason: null,
    };
    this._frames.push(frame);
    this._watch(frame);
    input.doc.setDraftFrame?.(frame.draftFrame);
    this._changed();
    return frame;
  }

  /**
   * Push a child frame and isolate it.
   *
   * The isolate is performed here rather than by the caller so that the intent
   * and the call that realises it can never drift apart — the pop replays
   * exactly what the push recorded.
   */
  push(input: RvChildFrameInput): RvStackFrame {
    const parent = this.top;
    if (!parent) {
      throw new Error('RvDocumentStack: push() needs a root frame — call pushRoot() first.');
    }
    const occurrence = childOccurrence(parent.occurrence, input.referenceNodeId);
    const frame: RvStackFrame = {
      documentId: input.doc.id,
      assetId: input.assetId,
      occurrence,
      referenceNodeId: input.referenceNodeId,
      draftFrame: {
        projectId: this._projectId,
        // The BOTTOM document namespaces the whole stack — not this frame's.
        rootDocumentId: this._frames[0].documentId,
        occurrence,
      },
      name: input.name,
      doc: input.doc,
      isolatedRoots: [...input.isolatedRoots],
      suppressedOverrides: input.suppressedOverrides,
      stale: false,
      staleReason: null,
    };
    this._frames.push(frame);
    this._watch(frame);
    input.doc.setDraftFrame?.(frame.draftFrame);
    this._applyIsolation(frame);
    this._assertChain();
    this._changed();
    return frame;
  }

  // ─── Popping ──────────────────────────────────────────────────────────

  /**
   * Remove the top frame and restore the isolation of the one below.
   *
   * The popped frame's document is NOT disposed here — the caller recomposes
   * with it first (it still holds the op log the recomposition replays) and
   * disposes it afterwards. What this does own is the isolation replay, because
   * that is stack state and nothing else can get it right.
   *
   * An open transaction on the popped frame is ABORTED (§9.5): a composite that
   * was never committed describes work in a document that is going away, and
   * handing it upwards would record it against the parent's history.
   */
  pop(): RvStackFrame | null {
    const frame = this._frames.pop();
    if (!frame) return null;
    const unsub = this._unsubs.get(frame.documentId);
    if (unsub) { unsub(); this._unsubs.delete(frame.documentId); }
    if (frame.doc.document.inTransaction) {
      // Detached: the abort runs on the document's own queue and the frame is
      // already off the stack. Failures there are the document's to log.
      void frame.doc.document.abortTransaction();
    }
    this._restoreIsolation();
    this._changed();
    return frame;
  }

  /**
   * Re-assert the isolation of the current top.
   *
   * Public because a recomposition REPLACES the parent's subtree: the roots the
   * frame recorded are then stale `Object3D`s, and the caller has to hand in the
   * new ones before the isolate can be replayed against the live tree.
   */
  reisolate(newRoots?: Object3D[]): void {
    const top = this.top;
    if (top && newRoots) top.isolatedRoots = [...newRoots];
    this._restoreIsolation();
  }

  private _restoreIsolation(): void {
    const top = this.top;
    if (!top || top.isolatedRoots.length === 0) {
      // Empty stack — or a root frame, which owns the whole viewport.
      this._viewer.exitIsolate();
      return;
    }
    this._applyIsolation(top);
  }

  private _applyIsolation(frame: RvStackFrame): void {
    if (frame.isolatedRoots.length === 0) return;
    // The one-slot takeover is the viewer's, unchanged. Calling it again is the
    // whole mechanism — see the header.
    this._viewer.isolateNodes(frame.isolatedRoots);
  }

  // ─── Staleness ────────────────────────────────────────────────────────

  /**
   * Record that `documentId` saved, and mark every OTHER frame of the same
   * asset stale (§2.7.1).
   *
   * Deliberately not silent and deliberately not automatic-discard: the upper
   * frame may hold work the user wants. Popping onto a stale frame is what
   * surfaces the choice.
   */
  markDocumentSaved(documentId: string): RvStackFrame[] {
    const saved = this._frames.find((f) => f.documentId === documentId);
    if (!saved) return [];
    const affected: RvStackFrame[] = [];
    for (const frame of this._frames) {
      if (frame === saved || frame.assetId !== saved.assetId || frame.stale) continue;
      frame.stale = true;
      frame.staleReason = 'saved-below';
      affected.push(frame);
    }
    if (affected.length > 0) this._changed();
    return affected;
  }

  /** Mark one frame stale for a reason the stack cannot observe itself. */
  markStale(frame: RvStackFrame, reason: RvStackStaleReason): void {
    if (frame.stale && frame.staleReason === reason) return;
    frame.stale = true;
    frame.staleReason = reason;
    this._changed();
  }

  /** Rename a frame (document rename) so the breadcrumb chip follows. */
  renameFrame(frame: RvStackFrame, name: string): void {
    if (frame.name === name) return;
    frame.name = name;
    this._changed();
  }

  // ─── Teardown ─────────────────────────────────────────────────────────

  /**
   * Drop every frame, top first, disposing each document.
   *
   * For a project switch or a new root document — never for a Back, which has
   * to recompose. Leaves the viewer un-isolated.
   */
  clear(): void {
    for (let i = this._frames.length - 1; i >= 0; i--) {
      const frame = this._frames[i];
      this._unsubs.get(frame.documentId)?.();
      this._unsubs.delete(frame.documentId);
      frame.doc.dispose();
    }
    this._frames.length = 0;
    this._viewer.exitIsolate();
    this._changed();
  }

  // ─── React store ──────────────────────────────────────────────────────

  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  getSnapshot = (): RvStackSnapshot => {
    if (!this._snapshot) {
      this._snapshot = {
        depth: this._frames.length,
        crumbs: this.breadcrumb(),
        topDocumentId: this.top?.documentId ?? null,
        anyDirty: this.anyDirty,
        suppressionNotice: this.suppressionNotice(),
      };
    }
    return this._snapshot;
  };

  // ─── internals ────────────────────────────────────────────────────────

  private _watch(frame: RvStackFrame): void {
    this._unsubs.set(frame.documentId, frame.doc.document.subscribe(() => this._changed()));
  }

  private _changed(): void {
    this._snapshot = null;
    for (const fn of this._listeners) fn();
  }

  /**
   * Every frame's occurrence is the previous one plus its reference node id.
   *
   * A violation would make the breadcrumb, the draft keys and the override
   * addressing disagree about where the user is, each in a different way. Cheap
   * enough to run on every push, and it fails loudly rather than producing a
   * plausible-looking wrong chain.
   */
  private _assertChain(): void {
    let expected = ROOT_OCCURRENCE;
    for (const frame of this._frames) {
      if (frame.occurrence !== expected) {
        throw new Error(
          `RvDocumentStack: occurrence chain broken — frame '${frame.name}' claims `
          + `'${frame.occurrence}', the chain says '${expected}'.`,
        );
      }
      // The NEXT frame's occurrence is this one plus the reference node it was
      // entered through; the root contributes nothing.
      const next = this._frames[this._frames.indexOf(frame) + 1];
      if (next?.referenceNodeId) expected = childOccurrence(expected, next.referenceNodeId);
    }
  }
}
