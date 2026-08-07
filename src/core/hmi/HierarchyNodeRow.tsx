// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Hierarchy row components.
 *
 * - `TreeNodeRow` — one virtualized tree row used by the "All" view
 * - `FlatNodeRow` — single-row component used by the virtualized type-filtered view
 *
 * Both are memoized so re-renders are limited to rows whose props have actually
 * changed. The parent `HierarchyBrowser` is responsible for keeping callbacks
 * stable via `useCallback` and the `selectedPaths` Set instance stable via
 * `useMemo`.
 *
 * Extracted from `rv-hierarchy-browser.tsx` (plan-177 Phase 5).
 */

import { useCallback, useMemo, memo } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import { ExpandMore, ChevronRight, VisibilityOutlined, VisibilityOffOutlined, OpenInNewRounded } from '@mui/icons-material';
import type { EditableNodeInfo } from './rv-extras-editor';
import type { RVViewer } from '../rv-viewer';
import type { SignalStore } from '../engine/rv-signal-store';
import type { RVLogicEngine } from '../engine/rv-logic-engine';
import { isLogicStepType, isSignalType, signalOwnerLabel, type VisibleTreeRow } from './hierarchy-utils';
import { NodeBadges, StepStateDot } from './hierarchy-badge-components';
import { useLongPress } from '../../hooks/use-long-press';
import { useStepState } from '../../hooks/use-step-state';

// ─── Selection click modifiers ───────────────────────────────────────────

/** Modifier state of a row click: `toggle` = Ctrl/Cmd (toggle one node),
 *  `shift` = Shift (range from the selection anchor). */
export interface SelectMods {
  shift?: boolean;
  toggle?: boolean;
}

// ─── Drag & drop (editor hierarchy reorder / reparent) ──────────────────────

/** Where a drop lands relative to the hovered row: `before`/`after` reorder the
 *  dragged node as a sibling at that slot; `onto` reparents it as a child. */
export type DropZone = 'before' | 'after' | 'onto';

/** Drag-insertion accent (matches the editor selection cyan). */
const DND_ACCENT = '79, 195, 247';

/** Classify the pointer's vertical position within a row into a drop zone:
 *  top ~25% = before, bottom ~25% = after, middle ~50% = onto (Unity model). */
function dropZoneFromPointer(e: React.DragEvent): DropZone {
  const rect = e.currentTarget.getBoundingClientRect();
  const rel = (e.clientY - rect.top) / Math.max(1, rect.height);
  if (rel < 0.25) return 'before';
  if (rel > 0.75) return 'after';
  return 'onto';
}

/** DnD wiring for a tree row — present only while the asset editor is active. */
export interface RowDndProps {
  /** Master switch: rows become draggable and accept drops only when true. */
  dndEnabled?: boolean;
  /** Drop indicator to paint on THIS row (null = none). Kept a primitive so
   *  memoized rows only re-render when their own indicator changes. */
  dropZone?: DropZone | null;
  onRowDragStart?: (path: string, e: React.DragEvent) => void;
  onRowDragOver?: (path: string, zone: DropZone, e: React.DragEvent) => void;
  onRowDrop?: (path: string, zone: DropZone, e: React.DragEvent) => void;
  onRowDragEnd?: () => void;
}

/** Stable, unique DOM id for a row from its scene path — the tree container's
 *  `aria-activedescendant` points here so screen readers track the keyboard
 *  cursor without per-row focus juggling. encodeURIComponent keeps spaces and
 *  slashes out of the id while staying 1:1 with the path. */
export const rowDomId = (path: string): string => `rvrow-${encodeURIComponent(path)}`;

// ─── Visibility (editor eye toggle) props ────────────────────────────────

/** Present only while the asset editor's EditTarget is active — rows render
 *  an eye toggle when these are passed AND the row has a registry path. */
export interface VisibilityRowProps {
  /** The node's OWN visible flag (eye icon state). */
  getNodeVisible?: (path: string) => boolean;
  /** False when the node OR an ancestor is hidden (row dimming). */
  getEffectiveVisible?: (path: string) => boolean;
  onToggleVisible?: (path: string) => void;
}

/** Trailing eye IconButton shared by both row variants. Hidden until row
 *  hover (opacity) unless the node is hidden — then always visible. */
function EyeToggle({ path, visible, onToggle }: { path: string; visible: boolean; onToggle: (path: string) => void }) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(path);
  }, [onToggle, path]);
  return (
    <IconButton
      size="small"
      aria-label={visible ? 'Hide' : 'Show'}
      onClick={handleClick}
      onDoubleClick={(e) => e.stopPropagation()}
      className="rv-eye-toggle"
      sx={{
        p: 0,
        ml: 0.25,
        flexShrink: 0,
        color: visible ? 'text.disabled' : 'primary.main',
        opacity: visible ? 0 : 1,
        transition: 'opacity 0.1s',
        '&:hover': { color: visible ? 'text.secondary' : 'primary.main' },
      }}
    >
      {visible ? <VisibilityOutlined sx={{ fontSize: 14 }} /> : <VisibilityOffOutlined sx={{ fontSize: 14 }} />}
    </IconButton>
  );
}

/** Trailing "open in inspector" affordance shown on the selected row. Makes the
 *  double-click-to-open gesture discoverable: after a single click selects a row,
 *  this ↗ appears (dimmed, brightening on hover) as an explicit way to open the
 *  property inspector — clicking it runs the same action as the row's dblclick. */
function OpenInspectorButton({ path, onOpen }: { path: string; onOpen: (path: string) => void }) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onOpen(path);
  }, [onOpen, path]);
  return (
    <IconButton
      size="small"
      aria-label="Open in inspector"
      title="Open in inspector"
      onClick={handleClick}
      onDoubleClick={(e) => e.stopPropagation()}
      className="rv-open-inspector"
      sx={{
        p: 0,
        ml: 0.25,
        flexShrink: 0,
        color: 'text.disabled',
        opacity: 0.55,
        transition: 'opacity 0.1s, color 0.1s',
        '&:hover': { color: 'primary.main', opacity: 1 },
      }}
    >
      <OpenInNewRounded sx={{ fontSize: 13 }} />
    </IconButton>
  );
}

// ─── TreeNodeRow ─────────────────────────────────────────────────────────

export interface TreeNodeRowProps extends VisibilityRowProps, RowDndProps {
  row: VisibleTreeRow;
  selectedPaths: Set<string>;
  expanded: ReadonlySet<string>;
  onToggleExpand: (key: string) => void;
  onSelect: (path: string, mods?: SelectMods) => void;
  onDoubleClick: (path: string) => void;
  onHover: (path: string | null) => void;
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
  signalStore: SignalStore | null;
  logicEngine: RVLogicEngine | null;
  /** Viewer for interactive signal chips (tooltip/force/drag) — plan-246 F1. */
  viewer?: RVViewer;
  rowHeight: number;
  /** Absolute positioning style from the tree virtualizer. */
  virtualStyle: React.CSSProperties;
}

export const TreeNodeRow = memo(function TreeNodeRow({
  row,
  selectedPaths,
  expanded,
  onToggleExpand,
  onSelect,
  onDoubleClick,
  onHover,
  onContextMenu,
  signalStore,
  logicEngine,
  viewer,
  rowHeight,
  virtualStyle,
  getNodeVisible,
  getEffectiveVisible,
  onToggleVisible,
  dndEnabled,
  dropZone,
  onRowDragStart,
  onRowDragOver,
  onRowDrop,
  onRowDragEnd,
}: TreeNodeRowProps) {
  const { node, depth, posInSet, setSize } = row;
  const expandKey = node.path ?? node.name;
  const isExpanded = expanded.has(expandKey);
  const hasChildren = node.children.length > 0 || node.canExpandLazy === true;
  const hasComponents = node.types.length > 0;
  // Mesh-only children get a path but no component types; the caret icon
  // handles expand/collapse via stopPropagation so row clicks still select.
  const isSelectable = !!node.path;
  const isMeshOnly = isSelectable && !hasComponents;
  const isSelected = isSelectable && selectedPaths.has(node.path!);
  // Memoized so the ARIA row id is not re-encoded on step-state updates.
  const domId = useMemo(() => (node.path ? rowDomId(node.path) : undefined), [node.path]);

  // Editor eye toggle (props present only while the asset editor is active).
  const canToggleVis = !!(onToggleVisible && getNodeVisible && node.path);
  const selfVisible = canToggleVis ? getNodeVisible!(node.path!) : true;
  const effectiveVisible = canToggleVis ? (getEffectiveVisible?.(node.path!) ?? true) : true;

  // Check if this node has a LogicStep component
  const hasLogicStep = node.types.some(isLogicStepType);
  const stepInfo = useStepState(
    hasLogicStep ? logicEngine : null,
    hasLogicStep ? node.path : null,
  );

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (isSelectable && node.path) {
      onSelect(node.path, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
    } else {
      onToggleExpand(expandKey);
    }
  }, [isSelectable, node.path, onSelect, onToggleExpand, expandKey]);

  const handleDblClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    if (node.path) onDoubleClick(node.path);
  }, [node.path, onDoubleClick]);

  const handleExpandClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand(expandKey);
  }, [onToggleExpand, expandKey]);

  const handleMouseEnter = useCallback(() => {
    if (node.path) onHover(node.path);
  }, [node.path, onHover]);

  const handleMouseLeave = useCallback(() => {
    onHover(null);
  }, [onHover]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (node.path && onContextMenu) {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(e, node.path);
    }
  }, [node.path, onContextMenu]);

  // Long-press for touch context menu
  const handleLongPress = useCallback((x: number, y: number) => {
    if (node.path && onContextMenu) {
      onContextMenu(
        { clientX: x, clientY: y, preventDefault: () => {}, stopPropagation: () => {} } as unknown as React.MouseEvent,
        node.path,
      );
    }
  }, [node.path, onContextMenu]);

  const longPress = useLongPress({
    enabled: !!(node.path && onContextMenu),
    onLongPress: handleLongPress,
  });

  // ── Drag & drop (asset editor only) ──
  const canDrag = !!(dndEnabled && isSelectable && node.path);
  const handleDragStart = useCallback((e: React.DragEvent) => {
    if (node.path) onRowDragStart?.(node.path, e);
  }, [node.path, onRowDragStart]);
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!node.path || !onRowDragOver) return;
    onRowDragOver(node.path, dropZoneFromPointer(e), e);
  }, [node.path, onRowDragOver]);
  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!node.path || !onRowDrop) return;
    onRowDrop(node.path, dropZoneFromPointer(e), e);
  }, [node.path, onRowDrop]);

  return (
    <Box
        data-path={node.path ?? undefined}
        data-selectable={isSelectable || undefined}
        data-mesh-only={isMeshOnly || undefined}
        id={domId}
        role="treeitem"
        aria-level={depth + 1}
        aria-posinset={posInSet}
        aria-setsize={setSize}
        aria-selected={isSelectable ? isSelected : undefined}
        aria-expanded={hasChildren ? isExpanded : undefined}
        onClick={handleClick}
        onDoubleClick={handleDblClick}
        onContextMenu={handleContextMenu}
        onPointerDown={longPress.onPointerDown}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.onPointerUp}
        onPointerLeave={longPress.onPointerLeave}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        draggable={canDrag || undefined}
        onDragStart={canDrag ? handleDragStart : undefined}
        onDragOver={dndEnabled ? handleDragOver : undefined}
        onDrop={dndEnabled ? handleDrop : undefined}
        onDragEnd={dndEnabled ? onRowDragEnd : undefined}
        style={virtualStyle}
        sx={{
          display: 'flex',
          alignItems: 'center',
          pl: depth * 1 + 0.5,
          pr: 2,
          py: 0,
          cursor: 'pointer',
          userSelect: 'none',
          borderRadius: 0.5,
          minWidth: 0,
          position: 'relative',
          bgcolor: dropZone === 'onto'
            ? `rgba(${DND_ACCENT}, 0.22)`
            : isSelected ? 'rgba(79, 195, 247, 0.15)' : 'transparent',
          // before/after → insertion line at the row's top/bottom edge; onto →
          // a ring around the whole row (it becomes the new parent). Inset so the
          // row never shifts while a drag hovers it.
          boxShadow: dropZone === 'before'
            ? `inset 0 2px 0 0 rgba(${DND_ACCENT}, 0.95)`
            : dropZone === 'after'
              ? `inset 0 -2px 0 0 rgba(${DND_ACCENT}, 0.95)`
              : dropZone === 'onto'
                ? `inset 0 0 0 1px rgba(${DND_ACCENT}, 0.7)`
                : 'none',
          '&:hover': {
            bgcolor: isSelected ? 'rgba(79, 195, 247, 0.2)' : 'rgba(255, 255, 255, 0.04)',
            // Reveal clickable type chips as targets while the row is hovered
            // (BadgeChip reads this inherited var — see hierarchy-badge-components).
            '--rv-chip-border': 'rgba(255,255,255,0.22)',
          },
          '&:hover .rv-eye-toggle': { opacity: 1 },
          height: rowHeight,
          minHeight: rowHeight,
        }}
      >
        {hasChildren ? (
          <IconButton
            size="small"
            aria-label={isExpanded ? 'Collapse' : 'Expand'}
            onClick={handleExpandClick}
            sx={{ p: 0, mr: 0.25, color: 'text.secondary' }}
          >
            {isExpanded ? <ExpandMore sx={{ fontSize: 14 }} /> : <ChevronRight sx={{ fontSize: 14 }} />}
          </IconButton>
        ) : (
          <Box sx={{ width: 16, flexShrink: 0 }} />
        )}

        {/* Status dot for LogicStep nodes */}
        {stepInfo && <StepStateDot stepState={stepInfo.state} />}

        <Tooltip title={node.name} placement="right" enterDelay={400} slotProps={{ tooltip: { sx: { fontSize: 10 } } }}>
          <Typography
            sx={{
              fontSize: 12,
              lineHeight: 1.3,
              // Selection carries a non-color cue (weight) too, not blue alone —
              // readable for low-vision users and in screenshots.
              fontWeight: isSelected ? 600 : hasComponents ? 400 : 500,
              color: isSelected
                ? 'primary.main'
                : isMeshOnly
                  ? 'text.disabled'
                  : hasComponents
                    ? 'text.primary'
                    : 'text.secondary',
              fontStyle: isMeshOnly ? 'italic' : 'normal',
              opacity: effectiveVisible ? 1 : 0.45,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 60,
              mr: 0.25,
            }}
          >
            {node.name}
          </Typography>
        </Tooltip>

        {hasComponents && (
          <NodeBadges types={node.types} signalStore={signalStore} path={node.path} stepInfo={stepInfo} viewer={viewer} onOpenInspector={onDoubleClick} />
        )}

        {isSelectable && node.path && isSelected && (
          <OpenInspectorButton path={node.path} onOpen={onDoubleClick} />
        )}

        {canToggleVis && (
          <EyeToggle path={node.path!} visible={selfVisible} onToggle={onToggleVisible!} />
        )}

    </Box>
  );
});

// ─── FlatNodeRow (virtualized type-filtered view) ────────────────────────

export interface FlatNodeRowProps extends VisibilityRowProps {
  info: EditableNodeInfo;
  selectedPaths: Set<string>;
  onSelect: (path: string, mods?: SelectMods) => void;
  onDoubleClick: (path: string) => void;
  onHover: (path: string | null) => void;
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
  signalStore: SignalStore | null;
  logicEngine: RVLogicEngine | null;
  /** Viewer for interactive signal chips (tooltip/force/drag) — plan-246 F1. */
  viewer?: RVViewer;
  /** Relative indentation depth (0 = top-level in filtered view). */
  depth?: number;
  /** Absolute positioning style from virtualizer (when virtualized). */
  virtualStyle?: React.CSSProperties;
  rowHeight: number;
}

export const FlatNodeRow = memo(function FlatNodeRow({
  info,
  selectedPaths,
  onSelect,
  onDoubleClick,
  onHover,
  onContextMenu,
  signalStore,
  logicEngine,
  viewer,
  depth = 0,
  virtualStyle,
  rowHeight,
  getNodeVisible,
  getEffectiveVisible,
  onToggleVisible,
}: FlatNodeRowProps) {
  const leaf = info.path.split('/').pop() ?? info.path;
  // Signal nodes in the flat list get an owner-qualified dot-symbol label so the
  // same leaf on different instances ("Flow.Occupied") is distinguishable; the
  // full node path stays in the tooltip. Non-signal rows keep the bare leaf.
  const isSignal = info.types.some(isSignalType);
  const name = isSignal ? signalOwnerLabel(info.path) : leaf;
  const tooltipTitle = isSignal ? info.path : leaf;
  const isSelected = selectedPaths.has(info.path);

  const hasLogicStep = info.types.some(isLogicStepType);
  const stepInfo = useStepState(
    hasLogicStep ? logicEngine : null,
    hasLogicStep ? info.path : null,
  );
  const isContainer = info.types.some(t => t === 'LogicStep_SerialContainer' || t === 'LogicStep_ParallelContainer');

  // Editor eye toggle (props present only while the asset editor is active).
  const canToggleVis = !!(onToggleVisible && getNodeVisible);
  const domId = useMemo(() => rowDomId(info.path), [info.path]);
  const selfVisible = canToggleVis ? getNodeVisible!(info.path) : true;
  const effectiveVisible = canToggleVis ? (getEffectiveVisible?.(info.path) ?? true) : true;

  const handleClick = useCallback((e: React.MouseEvent) => {
    onSelect(info.path, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
  }, [info.path, onSelect]);

  const handleDblClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDoubleClick(info.path);
  }, [info.path, onDoubleClick]);

  const handleCtxMenu = useCallback((e: React.MouseEvent) => {
    if (onContextMenu) {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(e, info.path);
    }
  }, [info.path, onContextMenu]);

  const handleMouseEnter = useCallback(() => onHover(info.path), [info.path, onHover]);
  const handleMouseLeave = useCallback(() => onHover(null), [onHover]);

  const handleLongPress = useCallback((x: number, y: number) => {
    if (onContextMenu) {
      onContextMenu(
        { clientX: x, clientY: y, preventDefault: () => {}, stopPropagation: () => {} } as unknown as React.MouseEvent,
        info.path,
      );
    }
  }, [info.path, onContextMenu]);

  const longPress = useLongPress({
    enabled: !!onContextMenu,
    onLongPress: handleLongPress,
  });

  return (
    <Box
      data-path={info.path}
      id={domId}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={isSelected}
      onClick={handleClick}
      onDoubleClick={handleDblClick}
      onContextMenu={handleCtxMenu}
      onPointerDown={longPress.onPointerDown}
      onPointerMove={longPress.onPointerMove}
      onPointerUp={longPress.onPointerUp}
      onPointerLeave={longPress.onPointerLeave}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      style={virtualStyle}
      sx={{
        display: 'flex',
        alignItems: 'center',
        pl: depth > 0 ? 1 : 0.5,
        pr: 2,
        py: 0,
        cursor: 'pointer',
        userSelect: 'none',
        borderRadius: 0.5,
        bgcolor: isSelected ? 'rgba(79, 195, 247, 0.15)' : isContainer ? 'rgba(255, 255, 255, 0.04)' : 'transparent',
        '&:hover': {
          bgcolor: isSelected ? 'rgba(79, 195, 247, 0.2)' : 'rgba(255, 255, 255, 0.06)',
          // Reveal clickable type chips as targets while the row is hovered.
          '--rv-chip-border': 'rgba(255,255,255,0.22)',
        },
        '&:hover .rv-eye-toggle': { opacity: 1 },
        height: rowHeight,
        minWidth: 0,
        // Container rows get top margin for visual group separation
        ...(isContainer && { mt: '4px' }),
        // Left border line for indented children (more prominent)
        ...(depth > 0 && {
          borderLeft: '2px solid rgba(79, 195, 247, 0.25)',
          ml: `${(depth - 1) * 14 + 8}px`,
        }),
      }}
    >
      {/* Status dot for LogicStep nodes — only Active/Waiting */}
      {stepInfo && <StepStateDot stepState={stepInfo.state} />}

      <Tooltip title={tooltipTitle} placement="right" enterDelay={400} slotProps={{ tooltip: { sx: { fontSize: 10 } } }}>
        <Typography
          sx={{
            fontSize: 12,
            lineHeight: 1.3,
            color: isSelected ? 'primary.main' : 'text.primary',
            // Non-color selection cue (weight), not blue alone.
            fontWeight: isSelected || isContainer ? 600 : 400,
            opacity: effectiveVisible ? 1 : 0.45,
            flex: 1,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            minWidth: 60,
            mr: 0.5,
          }}
        >
          {name}
        </Typography>
      </Tooltip>

      <NodeBadges types={info.types} signalStore={signalStore} path={info.path} stepInfo={stepInfo} viewer={viewer} onOpenInspector={onDoubleClick} />

      {isSelected && (
        <OpenInspectorButton path={info.path} onOpen={onDoubleClick} />
      )}

      {canToggleVis && (
        <EyeToggle path={info.path} visible={selfVisible} onToggle={onToggleVisible!} />
      )}
    </Box>
  );
});
