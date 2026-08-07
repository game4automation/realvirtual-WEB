// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * EditorToolbarButtons — asset-editor buttons for the shared floating viewport
 * toolbar (`button-group` UI slot / ButtonPanel), mirroring the planner's
 * toolbar look 1:1 (PlannerToolbarButtons.tsx):
 *
 * - `EditorUndoButton` / `EditorRedoButton` — drive the AssetDocument op log
 *   (same history as Ctrl+Z / Ctrl+Y and the hierarchy header card); tooltips
 *   carry the op labels ("Hide Housing", "Delete 3 objects", …).
 * - `EditorDeleteButton` — deletes the current selection as one undo unit via
 *   the shared `deleteSelectedNodes` path (same as the Delete key).
 *
 * Registered by AssetEditorPlugin.slots; the UI registry auto-gates them to
 * `mode:editor`, so no explicit visibilityRule is needed.
 */

import { useSyncExternalStore } from 'react';
import { CircularProgress, IconButton, Tooltip } from '@mui/material';
import { CenterFocusStrong, DeleteOutline, GpsFixed, Palette, PrecisionManufacturing, Redo, Undo, VisibilityOutlined } from '@mui/icons-material';
import { useSelection } from '../../hooks/use-selection';
import { useViewer } from '../../hooks/use-viewer';
import { getStoredKinematicsPanelWidth, getStoredMaterialsPanelWidth } from '../../core/hmi/layout-constants';
import { LS_KEY_MATERIALS_OPEN } from './materials/MaterialsPanel';
import { getActiveAssetContext, subscribeActiveAsset, getActiveAssetVersion } from './active-asset-store';
import { deleteSelectedNodes } from './delete-selection';
import { getPivotMode, subscribePivotMode, togglePivotMode } from './pivot-mode-store';
// Type-only — erased at compile time, so the index↔toolbar cycle is harmless.
import type { AssetEditorPlugin } from './index';

// Stable no-op fallbacks for useSyncExternalStore while no asset document is
// active (brief window during editor-mode activation).
const _noopSubscribe = () => () => {};
const _nullSnapshot = () => null;

/** One history button on the AssetDocument op log. */
function EditorHistoryButton({ kind }: { kind: 'undo' | 'redo' }) {
  useSyncExternalStore(subscribeActiveAsset, getActiveAssetVersion);
  const ctx = getActiveAssetContext();
  const snap = useSyncExternalStore(
    ctx?.doc.subscribe ?? _noopSubscribe,
    ctx?.doc.getSnapshot ?? _nullSnapshot,
  );
  if (!ctx || !snap) return null;

  const enabled = (kind === 'undo' ? snap.canUndo : snap.canRedo) === true;
  const opLabel = kind === 'undo' ? snap.undoLabel : snap.redoLabel;
  const base = kind === 'undo' ? 'Undo' : 'Redo';
  const label = opLabel ? `${base}: ${opLabel}` : base;
  const run = () => { void (kind === 'undo' ? ctx.doc.undo() : ctx.doc.redo()); };

  return (
    <Tooltip title={label} placement="right">
      {/* Tooltip on a disabled IconButton needs a wrapping span. */}
      <span>
        <IconButton
          size="small"
          onClick={run}
          disabled={!enabled}
          sx={{ p: 0.75, color: enabled ? 'text.secondary' : 'text.disabled' }}
          aria-label={base}
        >
          {kind === 'undo' ? <Undo sx={{ fontSize: 18 }} /> : <Redo sx={{ fontSize: 18 }} />}
        </IconButton>
      </span>
    </Tooltip>
  );
}

export function EditorUndoButton() { return <EditorHistoryButton kind="undo" />; }
export function EditorRedoButton() { return <EditorHistoryButton kind="redo" />; }

/**
 * Cycling toggle for the transform gizmo's anchor (Unity's Pivot/Center):
 * 'pivot' anchors at the node origin, 'center' at the bounding-box center of
 * the selection. The icon shows the CURRENT mode; a click switches. Feeds the
 * EditorTransformTool via pivot-mode-store (persisted).
 */
export function EditorPivotModeButton() {
  useSyncExternalStore(subscribeActiveAsset, getActiveAssetVersion);
  const mode = useSyncExternalStore(subscribePivotMode, getPivotMode);
  if (!getActiveAssetContext()) return null;

  const isCenter = mode === 'center';
  const label = isCenter
    ? 'Gizmo anchor: Center (bounding box) — click for Pivot'
    : 'Gizmo anchor: Pivot (object origin) — click for Center';
  return (
    <Tooltip title={label} placement="right">
      <IconButton
        size="small"
        onClick={togglePivotMode}
        sx={{ p: 0.75, color: 'text.secondary' }}
        aria-label={label}
      >
        {isCenter
          ? <CenterFocusStrong sx={{ fontSize: 18 }} />
          : <GpsFixed sx={{ fontSize: 18 }} />}
      </IconButton>
    </Tooltip>
  );
}

/**
 * Toggle for the right-docked Quick Edit window (the QuickEdit port; the panel
 * id stays 'kinematics' for persistence compatibility). Mirrors the planner's
 * Library toggle: active color while the window is open, open/close through
 * the LeftPanelManager's RIGHT slot. The user's choice is remembered so mode
 * activation can restore it.
 */
export function EditorKinematicsButton() {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  const snap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  useSyncExternalStore(subscribeActiveAsset, getActiveAssetVersion);
  if (!getActiveAssetContext()) return null;

  const isOpen = snap.right.activePanel === 'kinematics';
  const toggle = () => {
    if (isOpen) lpm.close('kinematics');
    else lpm.open('kinematics', getStoredKinematicsPanelWidth(), 'right');
    try { localStorage.setItem('rv-editor-kinematics-open', String(!isOpen)); } catch { /* private mode */ }
  };

  return (
    <Tooltip title={isOpen ? 'Hide Quick Edit' : 'Show Quick Edit'} placement="right">
      <IconButton
        size="small"
        onClick={toggle}
        sx={{ p: 0.75, color: isOpen ? 'primary.main' : 'text.disabled' }}
        aria-label="Toggle Quick Edit window"
      >
        <PrecisionManufacturing sx={{ fontSize: 18 }} />
      </IconButton>
    </Tooltip>
  );
}

/**
 * Toggle the Materials window.
 *
 * Shares the right dock slot with Quick Edit — the LeftPanelManager holds one
 * active right panel, so opening this closes that one. The lit button is what
 * makes the swap legible.
 */
export function EditorMaterialsButton() {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  const snap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  useSyncExternalStore(subscribeActiveAsset, getActiveAssetVersion);
  if (!getActiveAssetContext()) return null;

  const isOpen = snap.right.activePanel === 'materials';
  const toggle = () => {
    if (isOpen) lpm.close('materials');
    else lpm.open('materials', getStoredMaterialsPanelWidth(), 'right');
    try { localStorage.setItem(LS_KEY_MATERIALS_OPEN, String(!isOpen)); } catch { /* private mode */ }
  };

  return (
    <Tooltip title={isOpen ? 'Hide Materials' : 'Show Materials'} placement="right">
      <IconButton
        size="small"
        onClick={toggle}
        sx={{ p: 0.75, color: isOpen ? 'primary.main' : 'text.disabled' }}
        aria-label="Toggle Materials window"
      >
        <Palette sx={{ fontSize: 18 }} />
      </IconButton>
    </Tooltip>
  );
}

/**
 * Delete the current selection from the asset document. Disabled state
 * reactively tracks the SelectionManager, exactly like the planner's button.
 */
export function EditorDeleteButton() {
  useSyncExternalStore(subscribeActiveAsset, getActiveAssetVersion);
  const ctx = getActiveAssetContext();
  const selection = useSelection();
  if (!ctx) return null;

  const count = selection.selectedPaths.length;
  const disabled = count === 0;
  const tooltip = disabled
    ? 'Delete (select something first)'
    : count === 1 ? 'Delete' : `Delete ${count} items`;

  return (
    <Tooltip title={tooltip} placement="right">
      {/* Tooltip on a disabled IconButton needs a wrapping span. */}
      <span>
        <IconButton
          size="small"
          onClick={() => { void deleteSelectedNodes(ctx.viewer, ctx.doc); }}
          disabled={disabled}
          sx={{
            p: 0.75,
            color: disabled ? 'text.disabled' : '#ef5350',
          }}
          aria-label="Delete selected"
        >
          <DeleteOutline sx={{ fontSize: 18 }} />
        </IconButton>
      </span>
    </Tooltip>
  );
}
