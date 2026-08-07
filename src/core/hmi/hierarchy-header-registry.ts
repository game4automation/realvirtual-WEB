// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * hierarchy-header-registry — mode-keyed top-of-hierarchy card slot.
 *
 * Plugins register a React component per workspace mode; the HierarchyBrowser
 * renders the component registered for the ACTIVE mode above the tree (e.g.
 * the asset editor's document card with name / dirty dot / Save). Follows the
 * codebase's registry-over-hard-wiring preference (componentActionRegistry,
 * fieldRendererRegistry, …) so the browser knows nothing about the editor.
 */

import type { ComponentType } from 'react';
import type { ModeId } from '../rv-mode-manager';

const _headers = new Map<ModeId, ComponentType>();
const _listeners = new Set<() => void>();
let _version = 0;

/** Register the header card for a mode. Returns an unregister function. */
export function registerHierarchyHeader(modeId: ModeId, component: ComponentType): () => void {
  _headers.set(modeId, component);
  _bump();
  return () => {
    if (_headers.get(modeId) === component) {
      _headers.delete(modeId);
      _bump();
    }
  };
}

/** The header component for a mode, or null. */
export function getHierarchyHeader(modeId: ModeId | null): ComponentType | null {
  return (modeId && _headers.get(modeId)) || null;
}

/** useSyncExternalStore plumbing. */
export function subscribeHierarchyHeaders(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

export function getHierarchyHeadersSnapshot(): number {
  return _version;
}

function _bump(): void {
  _version++;
  for (const fn of _listeners) fn();
}
