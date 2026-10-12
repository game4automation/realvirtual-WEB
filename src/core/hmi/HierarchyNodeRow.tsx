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
 * stable via `useCallback`.
 *
 * Since plan-754 a row is backed by an `Object3D`, so every callback and getter
 * takes the ROW NODE rather than a path: an unregistered node (a chunk mesh, a
 * light, a hover overlay) has no path and is still a perfectly good row.
 *
 * Extracted from `rv-hierarchy-browser.tsx` (plan-177 Phase 5).
 */

import { useCallback, useMemo, memo } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import { ExpandMore, ChevronRight, VisibilityOutlined, VisibilityOffOutlined, OpenInNewRounded, Inventory2Outlined, LockOutlined } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import type { SignalStore } from '../engine/rv-signal-store';
import type { RVLogicEngine } from '../engine/rv-logic-engine';
import { isLogicStepType, isSignalType, signalOwnerLabel, type TreeNode, type VisibleTreeRow } from './hierarchy-utils';
import type { SceneTreeNode } from './hierarchy-rows';
import { NodeBadges, StateBadge, StepStateDot } from './hierarchy-badge-components';
import { useLongPress } from '../../hooks/use-long-press';
import { useStepState } from '../../hooks/use-step-state';
import { SignalUsageButton } from './rv-signal-usage-list';
import { signalNameForPath } from './use-signal-usages';

/**
 * "Used by N" chip of a SIGNAL row (plan-566 R1) — opens the cross-reference
 * list in a popover. Nothing for other rows, nothing while the signal is unused.
 */
const SignalRowUsage = memo(function SignalRowUsage({ node, viewer }: { node: TreeNode; viewer?: RVViewer }) {
  const name = node.path && viewer && node.types.some(isSignalType) ? signalNameForPath(viewer, node.path) : null;
  if (!name) return null;
  return <SignalUsageButton viewer={viewer} name={name} />;
});

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
 *  top ~25% = before, bottom ~25% = after, middle ~50% = onto (Unity model).
 *
 *  Exported since plan-703 Phase 6: the project tree drags files between
 *  folders with the same three zones and the same thresholds, and a second
 *  copy would be a second set of thresholds that could drift from this one. */
export function dropZoneFromPointer(e: React.DragEvent): DropZone {
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
  onRowDragStart?: (node: TreeNode, e: React.DragEvent) => void;
  onRowDragOver?: (node: TreeNode, zone: DropZone, e: React.DragEvent) => void;
  onRowDrop?: (node: TreeNode, zone: DropZone, e: React.DragEvent) => void;
  onRowDragEnd?: () => void;
}

// ─── Baked geometry (plan-505) ────────────────────────────────────────────

/** Tooltip of the disabled eye on a fold row and on a chunk row (F4): baked
 *  triangles are hidden through the boundary they were merged into, or through
 *  a group — never per chunk (D8). */
export const BAKED_EYE_REASON = 'Baked geometry — hide via its boundary or the Groups panel';

/** Tooltip of a row shown only because it is selected while "Show baked
 *  geometry" is off (F6). */
export const BAKED_REVEALED_TITLE = 'Shown despite filter (selected)';

/** Opacity of a revealed-despite-filter row. */
const REVEALED_OPACITY = 0.6;

/** Stable, unique DOM id for a row from its row key (the `Object3D.uuid` for
 *  scene rows, the path for file rows) — the tree container's
 *  `aria-activedescendant` points here so screen readers track the keyboard
 *  cursor without per-row focus juggling. encodeURIComponent keeps spaces and
 *  slashes out of the id while staying 1:1 with the key. */
export const rowDomId = (key: string): string => `rvrow-${encodeURIComponent(key)}`;

// ─── Visibility (editor eye toggle) props ────────────────────────────────

/** Present only while the asset editor's EditTarget is active — rows render
 *  an eye toggle when these are passed AND the row is hideable. */
export interface VisibilityRowProps {
  /** The node's OWN visible flag (eye icon state). */
  getNodeVisible?: (node: TreeNode) => boolean;
  /**
   * False when the row should be DIMMED.
   *
   * Two independent reasons, one styling (plan-703 §2.4.2): the node or an
   * ancestor is hidden (the eye), or the node lies inside an `AssetReference`
   * and its structure therefore belongs to another file. The caller folds both
   * in — a second reason must never grow a second visual, or "greyed out" stops
   * meaning one thing.
   *
   * Independent of {@link getNodeVisible}: the reference reason applies in every
   * mode, including those with no eye toggles at all.
   */
  getEffectiveVisible?: (node: TreeNode) => boolean;
  onToggleVisible?: (node: TreeNode) => void;
  /**
   * Why this row's eye is DISABLED, or null when it works (plan-754 D8).
   *
   * A node whose triangles were merged into an ancestor's chunk cannot be
   * hidden on its own — `.visible = false` there hides nothing. The affordance
   * stays visible but inert with the reason in its tooltip, which is honest;
   * silently doing nothing is not.
   */
  eyeDisabledReason?: (node: TreeNode) => string | null;
}

// ─── Lock (placed layout objects) props ──────────────────────────────────

/** Tooltip of the lock glyph on a locked placement row. */
export const LOCKED_ROW_TITLE = 'Locked — click to unlock';

/** Rows render a lock glyph when {@link TreeNode.locked} is set. The glyph is
 *  a button only when a handler is passed (the planner); otherwise it is a
 *  plain indicator. */
export interface LockRowProps {
  onUnlock?: (node: TreeNode) => void;
}

/** The lock glyph of a locked placement row. Always visible (unlike the eye,
 *  which hides at rest) because its whole job is to be seen at a glance. */
function LockToggle({ node, onUnlock }: { node: TreeNode; onUnlock?: (node: TreeNode) => void }) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onUnlock?.(node);
  }, [onUnlock, node]);
  return (
    <Tooltip title={onUnlock ? LOCKED_ROW_TITLE : 'Locked'} placement="left" disableInteractive>
      <IconButton
        size="small"
        aria-label={onUnlock ? 'Unlock' : 'Locked'}
        data-locked="true"
        onClick={onUnlock ? handleClick : (e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
        className="rv-lock-toggle"
        sx={{
          p: 0,
          ml: 0.25,
          flexShrink: 0,
          color: 'text.secondary',
          cursor: onUnlock ? 'pointer' : 'default',
          '&:hover': { color: onUnlock ? 'primary.main' : 'text.secondary' },
        }}
      >
        <LockOutlined sx={{ fontSize: 13 }} />
      </IconButton>
    </Tooltip>
  );
}

/** Trailing eye IconButton shared by both row variants. Hidden until row
 *  hover (opacity) unless the node is hidden — then always visible. */
function EyeToggle({
  node,
  visible,
  onToggle,
  disabledReason,
}: {
  node: TreeNode;
  visible: boolean;
  onToggle: (node: TreeNode) => void;
  disabledReason?: string | null;
}) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggle(node);
  }, [onToggle, node]);
  const disabled = !!disabledReason;
  const button = (
    <IconButton
      size="small"
      aria-label={visible ? 'Hide' : 'Show'}
      aria-disabled={disabled || undefined}
      disabled={disabled}
      onClick={disabled ? undefined : handleClick}
      onDoubleClick={(e) => e.stopPropagation()}
      className="rv-eye-toggle"
      sx={{
        p: 0,
        ml: 0.25,
        flexShrink: 0,
        color: visible ? 'text.disabled' : 'primary.main',
        opacity: disabled ? 0.25 : visible ? 0 : 1,
        transition: 'opacity 0.1s',
        '&.Mui-disabled': { color: 'text.disabled' },
        '&:hover': { color: visible ? 'text.secondary' : 'primary.main' },
      }}
    >
      {visible ? <VisibilityOutlined sx={{ fontSize: 14 }} /> : <VisibilityOffOutlined sx={{ fontSize: 14 }} />}
    </IconButton>
  );
  if (!disabled) return button;
  // A disabled MUI IconButton swallows pointer events, so the Tooltip needs a
  // wrapper to hear the hover — otherwise the explanation never shows.
  return (
    <Tooltip title={disabledReason} placement="left" disableInteractive>
      <Box component="span" sx={{ display: 'inline-flex' }} className="rv-eye-toggle-wrap">{button}</Box>
    </Tooltip>
  );
}

/** Trailing "open in inspector" affordance shown on the selected row. Makes the
 *  double-click-to-open gesture discoverable: after a single click selects a row,
 *  this ↗ appears (dimmed, brightening on hover) as an explicit way to open the
 *  property inspector — clicking it runs the same action as the row's dblclick. */
function OpenInspectorButton({ node, onOpen }: { node: TreeNode; onOpen: (node: TreeNode) => void }) {
  const handleClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onOpen(node);
  }, [onOpen, node]);
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

// ─── Shared row state badges ─────────────────────────────────────────────

/** `runtime` / `chunk` markers for a scene-backed row (plan-754 D2). Rendered
 *  before the component badges so the coloured type column stays a column. */
function RowStateBadges({ node }: { node: TreeNode }) {
  if (node.synthetic === 'baked-fold') {
    return <StateBadge label="baked" title="Baked geometry of this boundary — expand to list its chunks" />;
  }
  const scene = node as Partial<SceneTreeNode>;
  if (!scene.object) return null;
  return (
    <>
      {scene.chunk && <StateBadge label="chunk" title="Baked geometry — the merged triangles of this boundary" />}
      {scene.runtime && <StateBadge label="runtime" title="Not part of the document — created at runtime, read-only" />}
    </>
  );
}

// ─── TreeNodeRow ─────────────────────────────────────────────────────────

export interface TreeNodeRowProps extends VisibilityRowProps, RowDndProps, LockRowProps {
  row: VisibleTreeRow;
  /** Is this row part of the current selection? */
  selected?: boolean;
  expanded: ReadonlySet<string>;
  onToggleExpand: (key: string) => void;
  onSelect: (node: TreeNode, mods?: SelectMods) => void;
  onDoubleClick: (node: TreeNode) => void;
  onHover: (node: TreeNode | null) => void;
  onContextMenu?: (e: React.MouseEvent, node: TreeNode) => void;
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
  selected = false,
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
  eyeDisabledReason,
  onUnlock,
  dndEnabled,
  dropZone,
  onRowDragStart,
  onRowDragOver,
  onRowDrop,
  onRowDragEnd,
}: TreeNodeRowProps) {
  const { node, depth, posInSet, setSize, rowKey } = row;
  const expandKey = node.expandKey ?? node.path ?? node.name;
  const isExpanded = expanded.has(expandKey);
  const hasChildren = node.hasChildren ?? node.children.length > 0;
  const hasComponents = node.types.length > 0;
  // The GLB root row (plan-715): selectable and inspectable, structurally frozen.
  // Everything gated on this is a REMOVAL — no eye, no drag handle — so the lock
  // is legible as "fewer affordances", not as a new decoration to learn.
  const isRootRow = node.isModelRoot === true;
  // A locked placement (LayoutObject.Locked): lock glyph, no drag source. The
  // eye and the drop target stay — the lock guards position and structure of
  // the object itself, not what you may look at.
  const isLocked = node.locked === true;
  const label = node.displayLabel ?? node.name;
  const isRuntime = (node as Partial<SceneTreeNode>).runtime === true;
  // plan-505: the fold row ("Geometry · N chunks") is display-only; a chunk row
  // is a real object whose eye cannot hide anything on its own.
  const isFold = node.synthetic === 'baked-fold';
  const isChunk = (node as Partial<SceneTreeNode>).chunk === true;
  const isBaked = isFold || isChunk;
  // Shown only because it is selected while the baked toggle hides it (F6).
  const isRevealed = (node as { revealed?: boolean }).revealed === true;
  // Everything the hierarchy shows is selectable since plan-754 — a scene row
  // IS an object. Only a synthetic row (file-tree group, baked fold) has neither.
  const isSelectable = !!node.path || !!(node as Partial<SceneTreeNode>).object;
  const isMeshOnly = isSelectable && !hasComponents;
  const isSelected = isSelectable && selected;
  // Memoized so the ARIA row id is not re-encoded on step-state updates.
  const domId = useMemo(() => rowDomId(rowKey), [rowKey]);

  // Editor eye toggle (props present only while the asset editor is active).
  // Never on the root: the asset root always stays visible (F4), and never on a
  // runtime row: the document does not own it.
  // Baked rows (fold + chunk) show the eye DISABLED with the way that works
  // instead (F4) — the old chunk eye was a silent no-op.
  const canToggleVis = !!(onToggleVisible && getNodeVisible) && !isRootRow && !isRuntime;
  const selfVisible = canToggleVis && !isFold ? getNodeVisible!(node) : true;
  const eyeReason = canToggleVis
    ? (isBaked ? BAKED_EYE_REASON : eyeDisabledReason?.(node) ?? null)
    : null;
  // NOT gated on `canToggleVis`: dimming now also carries "inside a reference",
  // which is true in modes that have no eye toggles (plan-703 §2.4.2).
  const effectiveVisible = getEffectiveVisible?.(node) ?? true;

  // Check if this node has a LogicStep component
  const hasLogicStep = node.types.some(isLogicStepType);
  const stepInfo = useStepState(
    hasLogicStep ? logicEngine : null,
    hasLogicStep ? node.path : null,
  );

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (isSelectable) {
      onSelect(node, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
    } else {
      onToggleExpand(expandKey);
    }
  }, [isSelectable, node, onSelect, onToggleExpand, expandKey]);

  const handleDblClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDoubleClick(node);
  }, [node, onDoubleClick]);

  // Stable identity so the memoized NodeBadges does not re-render per parent tick.
  const handleOpenInspector = useCallback(() => onDoubleClick(node), [node, onDoubleClick]);

  const handleExpandClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onToggleExpand(expandKey);
  }, [onToggleExpand, expandKey]);

  const handleMouseEnter = useCallback(() => {
    onHover(node);
  }, [node, onHover]);

  const handleMouseLeave = useCallback(() => {
    onHover(null);
  }, [onHover]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (onContextMenu) {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(e, node);
    }
  }, [node, onContextMenu]);

  // Long-press for touch context menu
  const handleLongPress = useCallback((x: number, y: number) => {
    if (onContextMenu) {
      onContextMenu(
        { clientX: x, clientY: y, preventDefault: () => {}, stopPropagation: () => {} } as unknown as React.MouseEvent,
        node,
      );
    }
  }, [node, onContextMenu]);

  const longPress = useLongPress({
    enabled: !!onContextMenu && !isFold,
    onLongPress: handleLongPress,
  });

  // The fold row is not focusable through the tree's active-descendant cursor
  // (it is not an object), so it takes its own focus and answers Enter/Space.
  const handleFoldKeyDown = useCallback((e: React.KeyboardEvent) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    e.preventDefault();
    e.stopPropagation();
    onToggleExpand(expandKey);
  }, [onToggleExpand, expandKey]);

  // ── Drag & drop (asset editor only) ──
  // The root is never a drag SOURCE (it has no parent to move within), but it
  // stays a drop TARGET: dropping onto it is how you move a node back to the
  // top level, which is existing behaviour and stays. A runtime row is not a
  // structural thing the document can move at all (D2).
  const canDrag = !!(dndEnabled && node.path) && !isRootRow && !isRuntime && !isLocked;
  const handleDragStart = useCallback((e: React.DragEvent) => {
    onRowDragStart?.(node, e);
  }, [node, onRowDragStart]);
  const handleDragOver = useCallback((e: React.DragEvent) => {
    if (!onRowDragOver) return;
    onRowDragOver(node, dropZoneFromPointer(e), e);
  }, [node, onRowDragOver]);
  const handleDrop = useCallback((e: React.DragEvent) => {
    if (!onRowDrop) return;
    onRowDrop(node, dropZoneFromPointer(e), e);
  }, [node, onRowDrop]);

  return (
    <Box
        data-path={node.path ?? undefined}
        data-row-key={rowKey}
        data-selectable={isSelectable || undefined}
        data-mesh-only={isMeshOnly || undefined}
        data-runtime={isRuntime || undefined}
        data-baked-fold={isFold || undefined}
        data-revealed={isRevealed || undefined}
        id={domId}
        role="treeitem"
        tabIndex={isFold ? 0 : undefined}
        onKeyDown={isFold ? handleFoldKeyDown : undefined}
        aria-level={depth + 1}
        aria-posinset={posInSet}
        aria-setsize={setSize}
        aria-selected={isSelectable ? isSelected : undefined}
        aria-expanded={hasChildren ? isExpanded : undefined}
        onClick={handleClick}
        onDoubleClick={handleDblClick}
        onContextMenu={isFold ? undefined : handleContextMenu}
        onPointerDown={longPress.onPointerDown}
        onPointerMove={longPress.onPointerMove}
        onPointerUp={longPress.onPointerUp}
        onPointerLeave={longPress.onPointerLeave}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
        draggable={canDrag || undefined}
        onDragStart={canDrag ? handleDragStart : undefined}
        onDragOver={dndEnabled && !isFold ? handleDragOver : undefined}
        onDrop={dndEnabled && !isFold ? handleDrop : undefined}
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

        {/* Root marker: one quiet glyph, no colour of its own. It says "this is
            the file", which is also why it is not an interactive control. */}
        {isRootRow && (
          <Inventory2Outlined
            aria-hidden
            sx={{ fontSize: 13, mr: 0.5, flexShrink: 0, color: isSelected ? 'primary.main' : 'text.disabled' }}
          />
        )}

        <Tooltip
          title={isRootRow
            ? `${label}\nModel root — locked (node: ${node.name})`
            : isRevealed
              ? `${label}\n${BAKED_REVEALED_TITLE}`
              : isFold ? label : (node.path ?? node.name)}
          placement="right"
          enterDelay={400}
          slotProps={{ tooltip: { sx: { fontSize: 10, whiteSpace: 'pre-line' } } }}
        >
          <Typography
            sx={{
              fontSize: 12,
              lineHeight: 1.3,
              // Selection carries a non-color cue (weight) too, not blue alone —
              // readable for low-vision users and in screenshots.
              fontWeight: isSelected || isRootRow ? 600 : hasComponents ? 400 : 500,
              color: isSelected
                ? 'primary.main'
                : isRootRow
                  ? 'text.primary'
                  : isMeshOnly
                    ? 'text.disabled'
                    : hasComponents
                      ? 'text.primary'
                      : 'text.secondary',
              fontStyle: isMeshOnly && !isRootRow ? 'italic' : 'normal',
              opacity: effectiveVisible ? (isRevealed ? REVEALED_OPACITY : 1) : 0.45,
              flex: 1,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              minWidth: 60,
              mr: 0.25,
            }}
          >
            {label}
          </Typography>
        </Tooltip>

        <Box sx={{ display: 'flex', gap: 0.25, flexShrink: 0, ml: 'auto', alignItems: 'center' }}>
          <RowStateBadges node={node} />
        </Box>

        {hasComponents && (
          <NodeBadges types={node.types} signalStore={signalStore} path={node.path} stepInfo={stepInfo} viewer={viewer} onOpenInspector={handleOpenInspector} />
        )}
        {hasComponents && <SignalRowUsage node={node} viewer={viewer} />}

        {isSelectable && isSelected && (
          <OpenInspectorButton node={node} onOpen={onDoubleClick} />
        )}

        {canToggleVis && (
          <EyeToggle node={node} visible={selfVisible} onToggle={onToggleVisible!} disabledReason={eyeReason} />
        )}

        {isLocked && <LockToggle node={node} onUnlock={onUnlock} />}

    </Box>
  );
});

// ─── FlatNodeRow (virtualized type-filtered view) ────────────────────────

export interface FlatNodeRowProps extends VisibilityRowProps, LockRowProps {
  node: TreeNode;
  selected?: boolean;
  onSelect: (node: TreeNode, mods?: SelectMods) => void;
  onDoubleClick: (node: TreeNode) => void;
  onHover: (node: TreeNode | null) => void;
  onContextMenu?: (e: React.MouseEvent, node: TreeNode) => void;
  signalStore: SignalStore | null;
  logicEngine: RVLogicEngine | null;
  /** Viewer for interactive signal chips (tooltip/force/drag) — plan-246 F1. */
  viewer?: RVViewer;
  /** Relative indentation depth (0 = top-level in filtered view). */
  depth?: number;
  /** Absolute positioning style from virtualizer (when virtualized). */
  virtualStyle?: React.CSSProperties;
  rowHeight: number;
  /** Row key for the ARIA id (the object uuid for scene rows). */
  rowKey: string;
}

export const FlatNodeRow = memo(function FlatNodeRow({
  node,
  selected = false,
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
  rowKey,
  getNodeVisible,
  getEffectiveVisible,
  onToggleVisible,
  eyeDisabledReason,
  onUnlock,
}: FlatNodeRowProps) {
  const leaf = node.path ? node.path.split('/').pop() ?? node.path : (node.displayLabel ?? node.name);
  // Signal nodes in the flat list get an owner-qualified dot-symbol label so the
  // same leaf on different instances ("Flow.Occupied") is distinguishable; the
  // full node path stays in the tooltip. Non-signal rows keep the bare leaf.
  const isSignal = node.types.some(isSignalType);
  const name = isSignal && node.path ? signalOwnerLabel(node.path) : leaf;
  const tooltipTitle = isSignal && node.path ? node.path : leaf;
  const isRuntime = (node as Partial<SceneTreeNode>).runtime === true;

  const hasLogicStep = node.types.some(isLogicStepType);
  const stepInfo = useStepState(
    hasLogicStep ? logicEngine : null,
    hasLogicStep ? node.path : null,
  );
  const isContainer = node.types.some(t => t === 'LogicStep_SerialContainer' || t === 'LogicStep_ParallelContainer');

  // Editor eye toggle (props present only while the asset editor is active).
  const canToggleVis = !!(onToggleVisible && getNodeVisible) && !isRuntime;
  const domId = useMemo(() => rowDomId(rowKey), [rowKey]);
  const selfVisible = canToggleVis ? getNodeVisible!(node) : true;
  const eyeReason = canToggleVis ? eyeDisabledReason?.(node) ?? null : null;
  // See TreeNodeRow: dimming is independent of the eye toggle since plan-703.
  const effectiveVisible = getEffectiveVisible?.(node) ?? true;

  const handleClick = useCallback((e: React.MouseEvent) => {
    onSelect(node, { shift: e.shiftKey, toggle: e.ctrlKey || e.metaKey });
  }, [node, onSelect]);

  const handleDblClick = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    onDoubleClick(node);
  }, [node, onDoubleClick]);

  const handleOpenInspector = useCallback(() => onDoubleClick(node), [node, onDoubleClick]);

  const handleCtxMenu = useCallback((e: React.MouseEvent) => {
    if (onContextMenu) {
      e.preventDefault();
      e.stopPropagation();
      onContextMenu(e, node);
    }
  }, [node, onContextMenu]);

  const handleMouseEnter = useCallback(() => onHover(node), [node, onHover]);
  const handleMouseLeave = useCallback(() => onHover(null), [onHover]);

  const handleLongPress = useCallback((x: number, y: number) => {
    if (onContextMenu) {
      onContextMenu(
        { clientX: x, clientY: y, preventDefault: () => {}, stopPropagation: () => {} } as unknown as React.MouseEvent,
        node,
      );
    }
  }, [node, onContextMenu]);

  const longPress = useLongPress({
    enabled: !!onContextMenu,
    onLongPress: handleLongPress,
  });

  return (
    <Box
      data-path={node.path ?? undefined}
      data-row-key={rowKey}
      id={domId}
      role="treeitem"
      aria-level={depth + 1}
      aria-selected={selected}
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
        bgcolor: selected ? 'rgba(79, 195, 247, 0.15)' : isContainer ? 'rgba(255, 255, 255, 0.04)' : 'transparent',
        '&:hover': {
          bgcolor: selected ? 'rgba(79, 195, 247, 0.2)' : 'rgba(255, 255, 255, 0.06)',
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
            color: selected ? 'primary.main' : 'text.primary',
            // Non-color selection cue (weight), not blue alone.
            fontWeight: selected || isContainer ? 600 : 400,
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

      <Box sx={{ display: 'flex', gap: 0.25, flexShrink: 0, alignItems: 'center' }}>
        <RowStateBadges node={node} />
      </Box>

      <NodeBadges types={node.types} signalStore={signalStore} path={node.path} stepInfo={stepInfo} viewer={viewer} onOpenInspector={handleOpenInspector} />
      {isSignal && <SignalRowUsage node={node} viewer={viewer} />}

      {selected && (
        <OpenInspectorButton node={node} onOpen={onDoubleClick} />
      )}

      {canToggleVis && (
        <EyeToggle node={node} visible={selfVisible} onToggle={onToggleVisible!} disabledReason={eyeReason} />
      )}
      {node.locked === true && <LockToggle node={node} onUnlock={onUnlock} />}
    </Box>
  );
});
