// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useSyncExternalStore } from 'react';
import { useViewer } from './use-viewer';
import { useEditorState } from './use-editor-plugin';

/**
 * Reactive width (px) of the currently open left-docked window, or 0 if none.
 *
 * Single source of truth for shifting floating viewport controls (the mode
 * switcher, the floating tool toolbar) so they stay in the *visible* view next
 * to an open window — immediately and identically for every consumer.
 *
 * Hierarchy width comes from the editor plugin (it updates live on resize;
 * leftPanelManager's tracked hierarchy width is only set at open time). Every
 * other left window (settings, scene, connect, order, machine, …) reports its
 * live width through leftPanelManager — which is why resizable windows must
 * keep their lpm width in sync (e.g. SettingsPanel calls lpm.open on resize).
 */
export function useLeftWindowWidth(): number {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  const snap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  // A number slice, not the full state: this hook sits under the whole shell.
  const hierarchyWidth = useEditorState((state) => {
    const inspectorExtra = state.panelOpen && state.showInspector && state.selectedNodePath
      ? state.inspectorWidth : 0;
    return state.panelOpen && !state.settingsOpen ? state.panelWidth + inspectorExtra : 0;
  });
  const lpmWidth = snap.activePanel && snap.activePanel !== 'hierarchy'
    ? snap.activePanelWidth : 0;

  return Math.max(hierarchyWidth, lpmWidth);
}

/**
 * Reactive width (px) of the currently open RIGHT-docked window (e.g. the Layout
 * Planner library), or 0 if none. Used to shift floating top-right controls
 * (the camera / view cluster) left so they stay visible — same as the left side.
 */
export function useRightWindowWidth(): number {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  const snap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  return snap.right.activePanelWidth;
}
