// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-editor-draft-recovery — what the editor offers back after a crash.
 *
 * ## Why this exists as its own module
 *
 * plan-703 Phase 2 moved the draft WRITER onto a per-frame keyspace
 * (`rv-document-drafts`, one slot per stack frame, project-namespaced key) and
 * Phase 4 bound `AssetDocument` to it. The reader lagged behind in the single
 * legacy slot `drafts/current`, so this module was introduced to read BOTH and
 * lose nothing whichever one had written.
 *
 * Since plan-710 Phase 2 there is only one writer and only one keyspace: the
 * legacy slot is retired (its leftovers are discarded, not migrated — user
 * decision, §2.3), so what is left here is the part that never was about two
 * vocabularies — WHICH stack to offer, and what the offer has to admit it
 * cannot yet restore. It is pure over the record type — no IndexedDB, no
 * React — so the choice rule is testable without storage.
 *
 * ## Why the root has to be SEARCHED rather than computed
 *
 * A frame key is `<projectId>:<rootDocumentId>:<occurrence>`, and
 * `rootDocumentId` is the *document instance* id — freshly random on every
 * `new AssetDocument`. At the moment the editor opens there is no document yet,
 * so its key cannot be computed; the leftovers have to be enumerated and the
 * root picked out of them. {@link chooseRecoveryRoot} is that pick, and its rule
 * is "the most recently written stack wins", because that is the session the
 * user was actually in when the tab went away.
 *
 * ## Intermediate frames are not drafts
 *
 * {@link planStackRecovery} reports `cleanAncestors` — occurrence chains a
 * recovered frame descends *from* that carry no draft of their own, because the
 * user only passed through them. A restore built on "one draft per level" would
 * skip those silently. {@link describeStackRecovery} keeps them in the offer's
 * own summary so the UI cannot omit what it was never told about.
 */

import type { AssetDraft } from './rv-asset-draft-storage';
import type { RvDocumentDraft, RvStackRecoveryPlan } from '../ops/rv-document-drafts';

/**
 * Which keyspace a recovered draft came out of.
 *
 * One variant since plan-710 Phase 2 — the legacy slot is no longer read, and
 * plan-711 did not add a second keyspace: a shared document's record lives in
 * these same `frames`, under an identity-derived key, and is simply not the
 * editor's to offer ({@link assetDraftOfFrame} refuses it). Kept as a named
 * type because "where did this come from" is the question a genuinely second
 * store would re-open.
 */
export type EditorDraftSource = 'frame';

export interface EditorDraftChoice {
  draft: AssetDraft;
  source: EditorDraftSource;
  /**
   * The frames of the stack this draft is the ROOT of. Bottom first, root
   * included.
   */
  stack: RvDocumentDraft[];
  /** Occurrence chains in that stack with no draft — descended through, never edited. */
  cleanAncestors: string[];
}

// ─── Record conversion ──────────────────────────────────────────────────

/**
 * A per-frame record in the shape the editor's open path already speaks.
 *
 * Returns null for a base the editor cannot open — today that is exactly
 * `sceneGlbSlot`, the scene lineage's baked-bytes draft, which names a slot in
 * the scene-GLB store rather than an asset the editor can load. Refusing it here
 * is what keeps the editor from opening a scene draft as an asset; the scene
 * store remains its owner.
 *
 * The ops are carried over VERBATIM. Until plan-710 each one was pushed through
 * `downcastToAssetOp` and a rejected op dropped — a loop that existed only
 * because the frame keyspace and the editor's draft spoke two vocabularies. They
 * speak one now, so there is nothing left to convert and nothing left to drop.
 */
export function assetDraftOfFrame(record: RvDocumentDraft): AssetDraft | null {
  const base = record.shell.base;
  if (base.kind === 'sceneGlbSlot') return null;
  // …and a slot-addressed DOCUMENT for the same reason stated differently: the
  // editor cannot LOAD one from bytes (`_loadBase` has no branch for it,
  // deliberately — such a document enters the editor by being BOUND).
  //
  // Since plan-711 Phase 4 such records DO exist: a shared document writes its
  // op draft under an identity-derived frame key, in this same keyspace. It is
  // the SCENE's record — `SceneStore` recovers it on open and drops it when the
  // document is clean — and the refusal here is what keeps the editor from
  // offering somebody else's truth as an asset to open.
  //
  // plan-716 §2.6 narrows the test from a KIND to `path === ''`, which is the
  // same set: the collapse folded the former `projectDocument`/`libraryGlb`
  // into this kind, and those the editor has always been able to open. Testing
  // the kind alone here would start refusing every library asset's draft.
  if (base.kind === 'document' && !base.path) return null;

  return {
    shell: {
      id: record.shell.id,
      name: record.shell.name,
      base,
      createdAt: record.shell.createdAt,
    },
    ops: [...record.ops],
    savedAt: record.savedAt,
  };
}

/** Can the editor open this record's root at all? The one gate, asked twice. */
function canEditorOpen(record: RvDocumentDraft): boolean {
  return assetDraftOfFrame(record) !== null;
}

// ─── Choosing which stack to offer ──────────────────────────────────────

export interface RecoveryRoot {
  projectId: string | null;
  rootDocumentId: string;
}

/**
 * Which root document's stack to offer back, out of everything left behind.
 *
 * Scoped to `projectId` first: a leftover from another project is that
 * project's business, and offering it here would reopen the wrong document —
 * the very confusion the namespaced key was introduced to prevent.
 *
 * Among what remains, the stack with the newest `savedAt` wins. Newest rather
 * than deepest: depth says how far the user had descended, `savedAt` says which
 * session was live, and after a crash it is the live session that has to come
 * back.
 */
export function chooseRecoveryRoot(
  drafts: readonly RvDocumentDraft[],
  projectId: string | null,
): RecoveryRoot | null {
  let best: RvDocumentDraft | null = null;
  for (const d of drafts) {
    if ((d.frame.projectId ?? null) !== projectId) continue;
    // A SHARED document's record lives in this same keyspace since plan-711
    // §2.4 — one frame for a document two projections take turns showing — and
    // it is the SCENE's to recover, not the editor's (`assetDraftOfFrame`
    // refuses it, deliberately). Skipping it here is not tidiness: "newest
    // wins" would otherwise let a scene record be picked as the root, come back
    // as null from `chooseEditorDraft`, and take the editor's own recoverable
    // draft down with it — a leftover that hides work rather than offering it.
    if (!canEditorOpen(d)) continue;
    if (!best || (d.savedAt ?? 0) > (best.savedAt ?? 0)) best = d;
  }
  return best
    ? { projectId: best.frame.projectId ?? null, rootDocumentId: best.frame.rootDocumentId }
    : null;
}

/**
 * Turn a recovery plan into the offer the editor opens from.
 *
 * The plan's ROOT frame is what opens; the deeper frames travel along in
 * {@link EditorDraftChoice.stack} so the caller can reinstate the descent once
 * the stack UI exists. Until then they are reported rather than silently
 * dropped, which is the difference between "not implemented yet" and "lost".
 *
 * Nothing is ever deleted here — this decides what to *offer*, and discarding is
 * a separate, explicit act. Null means either no plan or a root frame the editor
 * cannot open (a scene-lineage `sceneGlbSlot`, which {@link assetDraftOfFrame}
 * refuses).
 */
export function chooseEditorDraft(plan: RvStackRecoveryPlan | null): EditorDraftChoice | null {
  const root = plan?.frames[0] ?? null;
  const draft = root ? assetDraftOfFrame(root) : null;
  if (!draft || !plan) return null;
  return {
    draft,
    source: 'frame',
    stack: [...plan.frames],
    cleanAncestors: [...plan.cleanAncestors],
  };
}

// ─── What the offer says ────────────────────────────────────────────────

/**
 * One line describing a recovered stack, or null when there is nothing extra
 * to say (a plain single-document draft).
 *
 * Names the frames the user cannot see yet — the deeper ones and the clean
 * intermediates — because until the descent can actually be reinstated, saying
 * so is the whole of the honesty the plan asks for here.
 */
export function describeStackRecovery(choice: EditorDraftChoice): string | null {
  const deeper = Math.max(0, choice.stack.length - 1);
  const passed = choice.cleanAncestors.length;
  if (deeper === 0 && passed === 0) return null;

  const parts: string[] = [];
  if (deeper > 0) {
    parts.push(deeper === 1
      ? '1 further document below it also has unsaved changes'
      : `${deeper} further documents below it also have unsaved changes`);
  }
  if (passed > 0) {
    parts.push(passed === 1
      ? '1 level was descended through without edits'
      : `${passed} levels were descended through without edits`);
  }
  return `${parts.join('; ')}.`;
}

/**
 * The recovered stack in the shape the offer dialog renders.
 *
 * Pure and here rather than in the dialog store, because the interesting part
 * is not the markup — it is the decision of WHAT the offer has to mention, and
 * that is a property of the recovery plan. `savedAt` is the NEWEST timestamp in
 * the stack, not the root's: after a crash the user recognises the session by
 * when they last touched it, and the last touch may well have been three levels
 * down.
 */
export interface DraftRecoveryInfo {
  name: string;
  savedAt: number;
  opCount: number;
  deeperFrames: Array<{ name: string; depth: number; opCount: number }>;
  cleanAncestors: number;
  note: string | null;
}

export function describeDraftRecovery(choice: EditorDraftChoice): DraftRecoveryInfo {
  const deeperFrames = choice.stack.slice(1).map((f) => ({
    name: f.shell.name,
    depth: f.depth,
    opCount: f.ops.length,
  }));
  const savedAt = choice.stack.reduce(
    (newest, f) => Math.max(newest, f.savedAt ?? 0),
    choice.draft.savedAt,
  );
  return {
    name: choice.draft.shell.name,
    savedAt,
    opCount: choice.draft.ops.length,
    deeperFrames,
    cleanAncestors: choice.cleanAncestors.length,
    note: describeStackRecovery(choice),
  };
}
