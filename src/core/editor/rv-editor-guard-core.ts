// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-editor-guard-core — the document gate as a CORE module (plan-499, spike finding 8).
 *
 * The command registry (`core/hmi/rv-command-registry.ts`) needs the editor
 * refusals, the document handle and the R5 identity check. Importing them from
 * `plugins/mcp-bridge/rv-mcp-doc-guard.ts` made a core module depend on a
 * plugin — and made every eager importer of the registry (the open
 * `ActionSegment`) pull the bridge module into the entry chunk.
 *
 * So the gate itself lives here, and `rv-mcp-doc-guard.ts` RE-EXPORTS it: one
 * implementation, the same error strings, and the fifty-odd editor tools that
 * import from the bridge module keep compiling unchanged.
 *
 * ## Two things the gate answers
 *
 * 1. **Is a document available in the projection I need?** (`requireDocument`)
 * 2. **Is it still the same document?** (`sameDocument`, R5)
 *
 * The op-origin rule (`requireOpOrigin`) stays in the bridge module: it is a
 * tool concern, not a question the registry ever asks.
 */

import type { RVViewer } from '../rv-viewer';
import { getActiveAssetContext, type ActiveAssetContext } from './active-asset-store';
import { getActiveDocumentView } from './active-document-view';

/** Which projection a caller needs. `any` takes whichever is active. */
export type DocumentNeed = 'editor' | 'scene' | 'any';

/** Which projection actually answered. */
export type DocumentProjection = 'editor' | 'scene';

/** The mode name the asset editor owns. */
const EDITOR_MODE = 'editor';

// ─── The editor refusals, stated ONCE ───────────────────────────────────

export const ERR_NO_VIEWER = 'No viewer';
export const ERR_NOT_EDITOR = 'Not in editor mode — call web_editor_open first';
export const ERR_EDITOR_ACTIVATING = 'Editor mode is still activating — retry in a moment';
/** plan-499 — the editor is not part of this build (community edition, stub `impls`). */
export const ERR_EDITOR_UNAVAILABLE = 'The asset editor is not available in this edition';
/** plan-499 F19 — the active document changed between guard and write; nothing was written. */
export const ERR_DOCUMENT_CHANGED = 'The active document changed during the call — nothing was written; retry';

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

/** Type guard for the error branch. Shared by every guard module. */
export function isGuardError<T extends object>(r: T | { error: string }): r is { error: string } {
  return 'error' in r;
}

/**
 * The editor context, or one of the three uniform refusals.
 *
 * The canonical implementation — `rv-mcp-editor-guard.requireEditor` forwards
 * here (through the bridge re-export), so the texts cannot fork.
 */
export function resolveEditorContext(
  viewer: RVViewer | undefined,
): ActiveAssetContext | { error: string } {
  if (!viewer) return { error: ERR_NO_VIEWER };
  // A viewer without a mode manager (headless host, embed) is not in the editor.
  if (viewer.modes?.activeMode !== EDITOR_MODE) return { error: ERR_NOT_EDITOR };
  const ctx = getActiveAssetContext();
  if (!ctx) return { error: ERR_EDITOR_ACTIVATING };
  return ctx;
}

/**
 * The top breadcrumb frame of the published view, or null. Defensive because a
 * frame is CONTEXT on a result — no caller should fail because its breadcrumb
 * could not be read.
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
 * Resolve a document in the projection the caller needs, or refuse in words.
 *
 * `need: 'editor'` is exactly the old editor gate. `need: 'scene'` refuses while
 * the editor owns the modes. `need: 'any'` takes whichever projection is active
 * and reports which one answered.
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
        ? 'No document is open — open one with web_document_open or web_execute("document.create", {name}).'
        : 'No document is open — open one with web_document_open, web_execute("document.create", {name}) or web_editor_open.',
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

// ─── R5 — document identity across a call ───────────────────────────────

/** A stable key for the document instance a call started against. */
function documentKeyOf(doc: { id?: string } | null | undefined): string {
  return doc?.id ?? '';
}

/** The key a caller should capture before its write and compare after it. */
export function documentIdentity(handle: DocumentHandle): string {
  return handle.documentKey;
}

/**
 * True when the document that answered the guard is still the active one.
 *
 * A base swap between guard and write drops the queued ops; this is how a
 * caller notices instead of reporting a success that never reached a document.
 */
export function sameDocument(handle: DocumentHandle): boolean {
  return documentKeyOf(getActiveAssetContext()?.doc) === handle.documentKey;
}
