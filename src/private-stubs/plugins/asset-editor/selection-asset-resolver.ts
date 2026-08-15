// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plugins/asset-editor/selection-asset-resolver.ts — community stub for the COMMERCIAL asset editor (plan-434).
 *
 * The GLB authoring UI lives in the private sibling. Without it `@rv-private/*`
 * resolves here, so the core still type-checks, builds and runs — the editor is
 * simply absent. Every export is an inert no-op; nothing in this file is reached
 * unless the caller is an editor-only code path, which a community build never
 * enters (no AssetEditorPlugin, no Editor mode).
 */

export type SelectionAssetResolver = (path: string) => any;

//! No planner-to-editor resolution without an editor. Returns an inert unregister.
export function registerSelectionAssetResolver(_fn: SelectionAssetResolver): () => void {
  return () => undefined;
}
export function resolveSelectionAsset(_path: string): null { return null; }
