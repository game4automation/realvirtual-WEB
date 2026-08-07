// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * active-asset-store — module-level handle to the live asset-editor context
 * (viewer + document). Set by the AssetEditorPlugin on mode activate/deactivate;
 * read by the hierarchy header card and the editor dialogs, which are rendered
 * through registries and therefore cannot receive the document as a prop.
 */

import type { RVViewer } from '../../core/rv-viewer';
import type { AssetDocument } from '../../core/editor/rv-asset-document';

export interface ActiveAssetContext {
  viewer: RVViewer;
  doc: AssetDocument;
}

let _current: ActiveAssetContext | null = null;
let _version = 0;
const _listeners = new Set<() => void>();

export function setActiveAssetContext(ctx: ActiveAssetContext | null): void {
  _current = ctx;
  _version++;
  for (const fn of _listeners) fn();
}

export function getActiveAssetContext(): ActiveAssetContext | null {
  return _current;
}

export function subscribeActiveAsset(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

export function getActiveAssetVersion(): number {
  return _version;
}
