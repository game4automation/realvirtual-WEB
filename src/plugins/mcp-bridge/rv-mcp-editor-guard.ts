// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-editor-guard — the mode gate every editor MCP tool starts with.
 *
 * Editor authoring tools only make sense while the asset editor owns an
 * AssetDocument (editor mode active). Outside it they return a uniform,
 * actionable error instead of half-working against the wrong store.
 *
 * ## Since plan-713 Phase 3 this is an ALIAS, and deliberately nothing more
 *
 * The gate itself moved to `rv-mcp-doc-guard.ts`, which answers the same
 * question for both projections (F7). This module stays because roughly fifty
 * editor tools import `requireEditor` by name and because its three error
 * strings are a contract those tools' callers have learnt — a rename would have
 * been a fifty-file diff that changed no behaviour, and a re-implementation
 * would have been a second copy of the three sentences.
 *
 * `requireEditor` therefore FORWARDS. It does not restate the checks, so the
 * texts cannot fork: there is one implementation, and
 * `rv-mcp-editor-guard.test.ts` passes unchanged against it.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { ActiveAssetContext } from '../../core/editor/active-asset-store';
import { resolveEditorContext } from './rv-mcp-doc-guard';

export type EditorGuardResult = ActiveAssetContext | { error: string };

/** Resolve the active editor context, or a uniform "not in editor mode" error. */
export function requireEditor(viewer: RVViewer | undefined): EditorGuardResult {
  return resolveEditorContext(viewer);
}

/** Type guard for the error branch. */
export function isGuardError(r: EditorGuardResult): r is { error: string } {
  return 'error' in r;
}
