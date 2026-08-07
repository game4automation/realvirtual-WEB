// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * script-editor-store.ts — WebComponent script editor UI state (plan-210
 * phase 3). Tiny external store (useSyncExternalStore pattern, same shape as
 * the private plc-editor-store): the toolbar button, the 'Edit Script'
 * component action and the panel's own node picker all funnel through here;
 * `ScriptEditorPanel` renders from it. The code buffer itself lives in the
 * Monaco model — the store only carries WHICH node is being edited.
 */

export interface ScriptEditorState {
  /** Whether the script editor FloatingPanel is open. */
  open: boolean;
  /** Hierarchy path of the node whose script is edited (null = none picked). */
  nodePath: string | null;
}

let state: ScriptEditorState = { open: false, nodePath: null };
const listeners = new Set<() => void>();

function setState(patch: Partial<ScriptEditorState>): void {
  state = { ...state, ...patch };
  for (const cb of listeners) cb();
}

/** Subscribe to store changes. Returns an unsubscribe. */
export function subscribeScriptEditor(cb: () => void): () => void {
  listeners.add(cb);
  return () => listeners.delete(cb);
}

/** Current state snapshot (stable identity between changes). */
export function getScriptEditorState(): ScriptEditorState {
  return state;
}

/** Opens the editor panel, optionally pointing it at a node. */
export function openScriptEditor(nodePath?: string): void {
  setState({ open: true, ...(nodePath !== undefined ? { nodePath } : {}) });
}

/** Closes the editor panel (node selection is kept for re-open). */
export function closeScriptEditor(): void {
  if (state.open) setState({ open: false });
}

/** Toggles the editor panel. */
export function toggleScriptEditor(): void {
  setState({ open: !state.open });
}

/** Points the open editor at another node (panel node picker). */
export function setScriptEditorNode(nodePath: string | null): void {
  if (state.nodePath !== nodePath) setState({ nodePath });
}

/** Clears everything (model cleared / plugin disposed). Closes the panel. */
export function resetScriptEditorStore(): void {
  setState({ open: false, nodePath: null });
}
