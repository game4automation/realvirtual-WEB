// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-editor-guard — the mode gate every editor MCP tool starts with.
 *
 * Editor authoring tools only make sense while the asset editor owns an
 * AssetDocument (editor mode active). Outside it they return a uniform,
 * actionable error instead of half-working against the wrong store.
 */

import type { RVViewer } from '../../core/rv-viewer';
import {
  getActiveAssetContext,
  type ActiveAssetContext,
} from '../asset-editor/active-asset-store';

export type EditorGuardResult = ActiveAssetContext | { error: string };

/** Resolve the active editor context, or a uniform "not in editor mode" error. */
export function requireEditor(viewer: RVViewer | undefined): EditorGuardResult {
  if (!viewer) return { error: 'No viewer' };
  if (viewer.modes.activeMode !== 'editor') {
    return { error: 'Not in editor mode — call web_editor_open first' };
  }
  const ctx = getActiveAssetContext();
  if (!ctx) return { error: 'Editor mode is still activating — retry in a moment' };
  return ctx;
}

/** Type guard for the error branch. */
export function isGuardError(r: EditorGuardResult): r is { error: string } {
  return 'error' in r;
}
