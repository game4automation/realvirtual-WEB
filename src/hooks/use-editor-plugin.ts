// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * useEditorPlugin — Shared hook for subscribing to rv-extras-editor plugin state.
 *
 * Supports an optional selector to avoid re-renders when unrelated state changes.
 *
 * Usage:
 *   const { plugin, state } = useEditorPlugin();          // full state (legacy)
 *   const panelOpen = useEditorState(s => s.panelOpen);   // selective subscription
 */

import { useSyncExternalStore, useRef, useCallback } from 'react';
import { useViewer } from './use-viewer';
import type { RvExtrasEditorPlugin, ExtrasEditorState } from '../core/hmi/rv-extras-editor';
import { HIERARCHY_DEFAULT_WIDTH } from '../core/hmi/rv-extras-editor';

const NOOP_UNSUB = () => () => {};
const EMPTY_SNAPSHOT: ExtrasEditorState = {
  panelOpen: false,
  panelWidth: HIERARCHY_DEFAULT_WIDTH,
  overlay: null,
  editableNodes: [],
  selectedNodePath: null,
  revealPath: null,
  showInspector: false,
  settingsOpen: false,
};

/** Full-state subscription (legacy, re-renders on any state change). */
export function useEditorPlugin() {
  const viewer = useViewer();
  const plugin = viewer.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
  const state = useSyncExternalStore(
    plugin?.subscribe ?? NOOP_UNSUB,
    plugin?.getSnapshot ?? (() => EMPTY_SNAPSHOT),
  );
  return { plugin, state };
}

/**
 * Selective subscription — only re-renders when the selected slice changes.
 *
 * ```ts
 * const panelOpen = useEditorState(s => s.panelOpen);
 * const { editableNodes, overlay } = useEditorState(s => ({
 *   editableNodes: s.editableNodes,
 *   overlay: s.overlay,
 * }));
 * ```
 */
export function useEditorState<T>(selector: (state: ExtrasEditorState) => T): T {
  const viewer = useViewer();
  const plugin = viewer.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');

  const selectorRef = useRef(selector);
  selectorRef.current = selector;

  const getSnapshot = useCallback(() => {
    const snap = plugin?.getSnapshot() ?? EMPTY_SNAPSHOT;
    return selectorRef.current(snap);
  }, [plugin]);

  return useSyncExternalStore(
    plugin?.subscribe ?? NOOP_UNSUB,
    getSnapshot,
  );
}
