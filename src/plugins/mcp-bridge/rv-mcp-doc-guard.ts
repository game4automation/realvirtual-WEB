// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-doc-guard — ONE document gate for both tracks (plan-713 F7, Phase 3).
 *
 * Until plan-711 the two tracks were two stores, so an editor tool guarded with
 * `requireEditor` and a planner tool guarded with an ad-hoc `getSceneStore()`
 * null check, and neither could say anything about the other. Since 711 the
 * scene and the editor are two PROJECTIONS of one `RvDocument` instance, which
 * makes "is there a document, and am I allowed to write this kind of op to it
 * from here" a single question — asked here.
 *
 * ## Two things the gate answers, and why the second one exists
 *
 * 1. **Is a document available in the projection I need?** (`need`)
 * 2. **May this KIND of op be applied from this projection?** ({@link requireOpOrigin})
 *
 * The second is not pedantry. `RV_OP_ORIGIN` (rv-unified-ops.ts) classifies all
 * 26 op kinds, and exactly four are `'both'` — `setField`, `unsetField`,
 * `composite`, `transformNode`. Every other content op is asset-lineage. Once
 * one instance backs both projections, a naive "one toolset" would let an agent
 * in planner mode fire `renameNode` at it: the op is well-formed, the document
 * accepts it, and the planner projection simply never shows the result. A
 * refusal in words beats a write that half-works.
 *
 * ## `requireEditor` did not change, and must not
 *
 * The editor branch below IS the old `requireEditor` body, moved rather than
 * re-written, and `rv-mcp-editor-guard.ts` now forwards to it. That is what
 * keeps the three error strings identical for the fifty-odd editor tools that
 * return them — a parity this file's tests assert against
 * `rv-mcp-editor-guard.test.ts` rather than leave to review.
 *
 * ## R5 — identity at the call end
 *
 * A base swap between a tool's guard and its write silently drops the queued op
 * ("Ops queued during a base swap are dropped"). {@link documentIdentity} and
 * {@link sameDocument} let a tool state what it wrote against, so the drop
 * becomes a reported no-op instead of a silent one.
 */

import type { RVViewer } from '../../core/rv-viewer';
import {
  getActiveAssetContext,
  type ActiveAssetContext,
} from '../../core/editor/active-asset-store';
import { getActiveDocumentView } from '../../core/editor/active-document-view';
import { RV_OP_ORIGIN, type RvOpKind, type RvOpOrigin } from '../../core/ops/rv-unified-ops';

/** Which projection a tool needs. `any` takes whichever is active. */
export type DocumentNeed = 'editor' | 'scene' | 'any';

/** Which projection actually answered. */
export type DocumentProjection = 'editor' | 'scene';

/** The mode name the asset editor owns. */
const EDITOR_MODE = 'editor';

// ─── The three editor refusals, stated ONCE ─────────────────────────────
//
// Named constants rather than literals because `requireEditor` is exported from
// a second module and its texts are asserted in a third. A literal in two places
// is the drift this whole file is about.

export const ERR_NO_VIEWER = 'No viewer';
export const ERR_NOT_EDITOR = 'Not in editor mode — call web_editor_open first';
export const ERR_EDITOR_ACTIVATING = 'Editor mode is still activating — retry in a moment';

export interface DocumentHandle {
  /** The op-logged document, whichever projection produced it. */
  doc: ActiveAssetContext['doc'];
  projection: DocumentProjection;
  /**
   * The current breadcrumb frame, or null outside a stack.
   *
   * Read from the published `ActiveDocumentView` rather than from
   * `RvDocumentStack`: the stack lives in the private editor plugin, the view is
   * the core seam both writers publish into, and a guard that reached into the
   * plugin could not run in a build without it.
   */
  stackFrame: { index: number; label: string; occurrence: string } | null;
  /** Present only for `projection === 'editor'`. */
  editor: ActiveAssetContext | null;
  /** R5 — what {@link sameDocument} compares. */
  documentKey: string;
}

export type DocumentGuardResult = DocumentHandle | { error: string };

/** Type guard for the error branch. Shared by both guard modules. */
export function isGuardError<T extends object>(r: T | { error: string }): r is { error: string } {
  return 'error' in r;
}

/**
 * The editor context, or one of the three uniform refusals.
 *
 * The canonical implementation — `rv-mcp-editor-guard.requireEditor` forwards
 * here, so the texts cannot fork.
 */
export function resolveEditorContext(
  viewer: RVViewer | undefined,
): ActiveAssetContext | { error: string } {
  if (!viewer) return { error: ERR_NO_VIEWER };
  if (viewer.modes.activeMode !== EDITOR_MODE) return { error: ERR_NOT_EDITOR };
  const ctx = getActiveAssetContext();
  if (!ctx) return { error: ERR_EDITOR_ACTIVATING };
  return ctx;
}

/**
 * The top breadcrumb frame of the published view, or null.
 *
 * Read from the core view seam, never from `RvDocumentStack`: the stack is owned
 * by the private editor plugin, and a guard that reached into it could not run
 * in a build without that plugin. Defensive because a frame is CONTEXT on a
 * result — no tool should fail because its breadcrumb could not be read.
 */
function topFrame(): DocumentHandle['stackFrame'] {
  try {
    const crumbs = getActiveDocumentView()?.crumbs ?? [];
    const current = crumbs.find((c) => c.current) ?? crumbs.at(-1) ?? null;
    return current
      ? { index: current.index, label: current.label, occurrence: current.occurrence }
      : null;
  } catch { return null; }
}

/**
 * Resolve a document in the projection this tool needs, or refuse in words.
 *
 * `need: 'editor'` is exactly the old editor gate. `need: 'scene'` refuses while
 * the editor owns the modes — the mirror case, and the one a "one toolset"
 * change makes newly reachable. `need: 'any'` takes whichever projection is
 * active and reports which one answered, so a tool that genuinely works in both
 * can still branch on it.
 */
export function requireDocument(
  viewer: RVViewer | undefined,
  need: DocumentNeed = 'any',
): DocumentGuardResult {
  if (!viewer) return { error: ERR_NO_VIEWER };
  const inEditor = viewer.modes?.activeMode === EDITOR_MODE;

  if (need === 'editor' || (need === 'any' && inEditor)) {
    const ctx = resolveEditorContext(viewer);
    if (isGuardError(ctx)) return ctx;
    return {
      doc: ctx.doc,
      projection: 'editor',
      stackFrame: topFrame(),
      editor: ctx,
      documentKey: documentKeyOf(ctx.doc),
    };
  }

  if (need === 'scene' && inEditor) {
    return {
      error: 'Not in a scene projection — the asset editor is open. '
        + 'Leave it with web_editor_close, or use the web_editor_* tools instead.',
    };
  }

  // Scene projection. Since plan-711 the instance behind it may be the SAME
  // document the editor projects, which is why the handle carries the
  // projection: identical `doc`, different rules about what may be written.
  const ctx = getActiveAssetContext();
  if (!ctx) {
    return {
      error: need === 'scene'
        ? 'No document is open — open one with web_document_open or web_document_new.'
        : 'No document is open — open one with web_document_open, web_document_new or web_editor_open.',
    };
  }
  return {
    doc: ctx.doc,
    projection: 'scene',
    stackFrame: topFrame(),
    editor: null,
    documentKey: documentKeyOf(ctx.doc),
  };
}

// ─── Origin (R6) ────────────────────────────────────────────────────────

/** Where an op kind may originate. Re-exported so tools need one import. */
export function originOf(kind: RvOpKind): RvOpOrigin {
  return RV_OP_ORIGIN[kind];
}

/**
 * Refuse an op kind the current projection may not originate, or return null.
 *
 * Only ever refuses ASSET-lineage kinds in a SCENE projection: the reverse
 * (a scene-lineage kind from the editor) is refused by the editor executor
 * itself, and duplicating that refusal here would mean two sentences for one
 * rule. `'both'` kinds pass everywhere by definition.
 */
export function requireOpOrigin(
  kind: RvOpKind,
  projection: DocumentProjection,
): { error: string } | null {
  const origin = RV_OP_ORIGIN[kind];
  if (!origin) return { error: `Unknown op kind "${kind}".` };
  if (origin === 'both') return null;
  // The two vocabularies are NOT the same word. `RV_OP_ORIGIN` speaks LINEAGE
  // (`asset` / `scene`); a projection is named after the surface showing it
  // (`editor` / `scene`). They coincide on one side and differ on the other,
  // which is exactly the shape that makes a bare `origin === projection` look
  // right and let every asset op through the editor gate as "wrong lineage".
  const lineage = projection === 'editor' ? 'asset' : 'scene';
  if (origin === lineage) return null;
  if (origin === 'asset' && projection === 'scene') {
    return {
      error: `"${kind}" is a content edit and can only be applied in the asset editor. `
        + 'The scene projection shows the same document but does not render structural '
        + 'edits, so this would have written something you could not see. '
        + 'Open the editor with web_editor_open and repeat the call.',
    };
  }
  return {
    error: `"${kind}" is a scene-lineage op and cannot be applied from the asset editor.`,
  };
}

// ─── R5 — document identity across a call ───────────────────────────────

/** A stable key for the document instance a call started against. */
function documentKeyOf(doc: { id?: string } | null | undefined): string {
  return doc?.id ?? '';
}

/** The key a tool should capture before its write and compare after it. */
export function documentIdentity(handle: DocumentHandle): string {
  return handle.documentKey;
}

/**
 * True when the document that answered the guard is still the active one.
 *
 * The check R5 asks for: a base swap between guard and write drops the queued
 * ops, and this is how a tool notices instead of reporting a success that never
 * reached a document.
 */
export function sameDocument(handle: DocumentHandle): boolean {
  return documentKeyOf(getActiveAssetContext()?.doc) === handle.documentKey;
}
