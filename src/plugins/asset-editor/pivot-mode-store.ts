// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * pivot-mode-store.ts — the editor's gizmo anchor mode (Unity's Pivot/Center
 * toolbar toggle).
 *
 *   - 'pivot'  — the node's own origin (authored pivot). Default.
 *   - 'center' — the bounding-box center of the selection. Rescues imported
 *     CAD whose pivots sit at the assembly world origin, far from the part.
 *
 * Module-level store (useSyncExternalStore-compatible) shared by the toolbar
 * button and the EditorTransformTool; persisted across sessions.
 */

export type PivotMode = 'pivot' | 'center';

const STORAGE_KEY = 'rv.editor.pivotMode';

function load(): PivotMode {
  try {
    return localStorage.getItem(STORAGE_KEY) === 'center' ? 'center' : 'pivot';
  } catch {
    return 'pivot';
  }
}

let _mode: PivotMode = load();
const _listeners = new Set<() => void>();

export function getPivotMode(): PivotMode {
  return _mode;
}

export function setPivotMode(mode: PivotMode): void {
  if (mode === _mode) return;
  _mode = mode;
  try { localStorage.setItem(STORAGE_KEY, mode); } catch { /* private mode */ }
  for (const l of _listeners) {
    try { l(); } catch (e) { console.error('[pivot-mode] listener error:', e); }
  }
}

export function togglePivotMode(): void {
  setPivotMode(_mode === 'pivot' ? 'center' : 'pivot');
}

export function subscribePivotMode(cb: () => void): () => void {
  _listeners.add(cb);
  return () => { _listeners.delete(cb); };
}
