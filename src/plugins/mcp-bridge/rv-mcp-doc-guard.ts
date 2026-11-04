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
 * 27 op kinds, and exactly four are `'both'` — `setField`, `unsetField`,
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

import { RV_OP_ORIGIN, type RvOpKind, type RvOpOrigin } from '../../core/ops/rv-unified-ops';
import type { DocumentProjection } from '../../core/editor/rv-editor-guard-core';

// plan-499 (spike finding 8): the gate itself moved to a CORE module so the
// command registry can use it without importing a plugin. Re-exported here
// unchanged — one implementation, the same strings, no importer had to move.
export {
  ERR_NO_VIEWER,
  ERR_NOT_EDITOR,
  ERR_EDITOR_ACTIVATING,
  ERR_EDITOR_UNAVAILABLE,
  ERR_DOCUMENT_CHANGED,
  isGuardError,
  resolveEditorContext,
  requireDocument,
  documentIdentity,
  sameDocument,
} from '../../core/editor/rv-editor-guard-core';
export type {
  DocumentNeed,
  DocumentProjection,
  DocumentHandle,
  DocumentGuardResult,
} from '../../core/editor/rv-editor-guard-core';

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
