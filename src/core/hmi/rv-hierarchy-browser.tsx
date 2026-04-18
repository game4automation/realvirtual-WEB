// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * HierarchyBrowser — Tree view of all GLB nodes with rv extras.
 *
 * Features:
 * - Search filter (case-insensitive path substring)
 * - Type filter buttons (All, Drives, Sensors, Signals, Logic)
 * - Component type badges with live signal values
 * - LogicStep status dots with ISA-101 colors and pulse animation
 * - Container progress counters (3/7 for Serial, 2/4 done for Parallel)
 * - Click to select (updates plugin state)
 * - Resizable width (drag right edge)
 * - Node count footer
 * - Reveal-and-scroll: external code can call plugin.selectAndReveal(path)
 *   to expand ancestor tree nodes and scroll the selected node into view
 */

import { useState, useMemo, useCallback, useRef, useEffect, memo } from 'react';
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { useSelection } from '../../hooks/use-selection';
import { useSignalTick } from '../../hooks/use-signal-tick';
import {
  Box,
  Typography,
  TextField,
  IconButton,
  InputAdornment,
  Chip,
  Tooltip,
} from '@mui/material';
import {
  Search,
  ExpandMore,
  ChevronRight,
} from '@mui/icons-material';
import { filterChipSx, RV_SCROLL_CLASS } from './shared-sx';
import type { RVViewer } from '../rv-viewer';
import type { ContextMenuTarget } from './context-menu-store';
import { HIERARCHY_MIN_WIDTH, HIERARCHY_MAX_WIDTH, type EditableNodeInfo } from './rv-extras-editor';
import { LeftPanel } from './LeftPanel';
import type { RVExtrasOverlay } from '../engine/rv-extras-overlay-store';
import type { SignalStore } from '../engine/rv-signal-store';
import { getDisplayName } from '../engine/rv-component-registry';
import type { RVLogicEngine, StepStateInfo } from '../engine/rv-logic-engine';
import { StepState } from '../engine/rv-logic-step';
import { STEP_STATE_COLORS, STEP_STATE_LABELS } from './rv-logic-step-colors';
import { componentColor } from './rv-inspector-helpers';
import { tooltipRegistry } from './tooltip/tooltip-registry';
import { useVirtualizer } from '@tanstack/react-virtual';
// ─── CSS Pulse Animation ─────────────────────────────────────────────────

const PULSE_STYLE_ID = 'rv-pulse-keyframes';

function ensurePulseAnimation(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(PULSE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = PULSE_STYLE_ID;
  style.textContent = `
    @keyframes rv-pulse {
      0%, 100% { opacity: 1; transform: scale(1); }
      50%      { opacity: 0.4; transform: scale(0.75); }
    }
    @media (prefers-reduced-motion: reduce) {
      @keyframes rv-pulse {
        0%, 100% { opacity: 0.7; }
      }
    }
  `;
  document.head.appendChild(style);
}

// ─── Type Filter ─────────────────────────────────────────────────────────

type TypeFilter = 'all' | 'drives' | 'sensors' | 'signals' | 'logic';

const TYPE_FILTERS: { key: TypeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'drives', label: 'Drives' },
  { key: 'sensors', label: 'Sensors' },
  { key: 'signals', label: 'Signals' },
  { key: 'logic', label: 'Logic' },
];

function matchesTypeFilter(types: string[], filter: TypeFilter): boolean {
  if (filter === 'all') return true;
  if (filter === 'drives') return types.some(t => t === 'Drive' || t.startsWith('Drive_'));
  if (filter === 'sensors') return types.some(t => t === 'Sensor' || t === 'WebSensor');
  if (filter === 'signals') return types.some(t => t.startsWith('PLCInput') || t.startsWith('PLCOutput'));
  if (filter === 'logic') return types.some(t => t.startsWith('LogicStep_'));
  return true;
}

// ─── Signal Sort ─────────────────────────────────────────────────────────

type SignalSort = 'name' | 'type';

/** Sort signal nodes: 'name' = alphabetical by leaf name, 'type' = group by In/Out then alphabetical. */
function sortSignalNodes(nodes: EditableNodeInfo[], sort: SignalSort): EditableNodeInfo[] {
  const sorted = [...nodes];
  if (sort === 'name') {
    sorted.sort((a, b) => {
      const nameA = (a.path.split('/').pop() ?? a.path).toLowerCase();
      const nameB = (b.path.split('/').pop() ?? b.path).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  } else {
    // Group by type: Outputs first, then Inputs
    sorted.sort((a, b) => {
      const aIsOut = a.types.some(t => t.startsWith('PLCOutput'));
      const bIsOut = b.types.some(t => t.startsWith('PLCOutput'));
      if (aIsOut !== bIsOut) return aIsOut ? -1 : 1;
      const nameA = (a.path.split('/').pop() ?? a.path).toLowerCase();
      const nameB = (b.path.split('/').pop() ?? b.path).toLowerCase();
      return nameA.localeCompare(nameB);
    });
  }
  return sorted;
}

// ─── Tree Data Structure ─────────────────────────────────────────────────

interface TreeNode {
  name: string;
  path: string | null;
  types: string[];
  hasOverrides: boolean;
  children: TreeNode[];
}

/** Internal tree node augmented with a child lookup map for O(1) insertion. */
interface BuildTreeNode extends TreeNode {
  _childMap?: Map<string, BuildTreeNode>;
}

function buildTree(
  nodes: EditableNodeInfo[],
  overlay: RVExtrasOverlay | null,
): TreeNode[] {
  const root: BuildTreeNode = { name: '', path: null, types: [], hasOverrides: false, children: [], _childMap: new Map() };

  for (const info of nodes) {
    const segments = info.path.split('/');
    let current = root;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;

      const fullPath = segments.slice(0, i + 1).join('/');
      const childMap = current._childMap ?? (current._childMap = new Map());
      let child = childMap.get(seg);
      if (!child) {
        child = {
          name: seg,
          path: fullPath,
          types: isLast ? info.types : [],
          hasOverrides: false,
          children: [],
          _childMap: new Map(),
        };
        childMap.set(seg, child);
        current.children.push(child);
      }

      if (isLast) {
        child.path = info.path;
        child.types = info.types;
        child.hasOverrides = overlay ? !!overlay.nodes[info.path] : false;
      }

      current = child;
    }
  }

  // Clean up temporary lookup maps to reduce memory
  function stripMaps(node: BuildTreeNode): void {
    delete node._childMap;
    for (const child of node.children) stripMaps(child as BuildTreeNode);
  }
  stripMaps(root);

  // Flatten GLB root wrapper: if top level has a single child with no component types
  // (the synthetic gltf.scene node like "demoglb"), skip it and show its children instead.
  let topNodes = root.children;
  while (topNodes.length === 1 && topNodes[0].types.length === 0 && topNodes[0].children.length > 0) {
    topNodes = topNodes[0].children;
  }

  return topNodes;
}

function filterTree(nodes: TreeNode[], term: string, viewer?: RVViewer): TreeNode[] {
  if (!term) return nodes;
  const lower = term.toLowerCase();

  function filterRecursive(node: TreeNode): TreeNode | null {
    const nameMatches = node.name.toLowerCase().includes(lower);
    const pathMatches = node.path ? node.path.toLowerCase().includes(lower) : false;

    // Check component search resolvers (AAS description, Metadata content, etc.)
    let componentMatches = false;
    if (!nameMatches && !pathMatches && node.path && viewer?.registry) {
      const obj3d = viewer.registry.getNode(node.path);
      if (obj3d) {
        const searchTexts = tooltipRegistry.getSearchableText(obj3d);
        componentMatches = searchTexts.some(t => t.toLowerCase().includes(lower));
      }
    }

    const filteredChildren: TreeNode[] = [];
    for (const child of node.children) {
      const result = filterRecursive(child);
      if (result) filteredChildren.push(result);
    }

    if (nameMatches || pathMatches || componentMatches || filteredChildren.length > 0) {
      return { ...node, children: filteredChildren };
    }
    return null;
  }

  const result: TreeNode[] = [];
  for (const node of nodes) {
    const filtered = filterRecursive(node);
    if (filtered) result.push(filtered);
  }
  return result;
}

function countNodes(nodes: EditableNodeInfo[], overlay: RVExtrasOverlay | null): { total: number; withOverrides: number } {
  let withOverrides = 0;
  if (overlay) {
    for (const info of nodes) {
      if (overlay.nodes[info.path]) withOverrides++;
    }
  }
  return { total: nodes.length, withOverrides };
}

// ─── Signal Helpers ──────────────────────────────────────────────────────

function isSignalType(type: string): boolean {
  return type.startsWith('PLCInput') || type.startsWith('PLCOutput');
}

function isBoolSignal(type: string): boolean {
  return type.includes('Bool');
}

/** Split types into [nonSignals, signals] so signals render last (right-most). */
function splitTypes(types: string[]): [string[], string[]] {
  const nonSignals: string[] = [];
  const signals: string[] = [];
  for (const t of types) {
    if (isSignalType(t)) signals.push(t);
    else nonSignals.push(t);
  }
  return [nonSignals, signals];
}

/** Format a signal value for badge display. */
function formatSignalValue(type: string, signalStore: SignalStore | null, path: string | null): string {
  if (!signalStore || !path) return '\u2014';
  const value = signalStore.getByPath(path);
  if (value === undefined) return '\u2014';

  if (isBoolSignal(type)) {
    return value === true ? '\u25CF' : '\u25CB'; // filled or hollow circle
  }

  if (typeof value === 'number') {
    return type.includes('Int') ? Math.trunc(value).toString() : value.toFixed(1);
  }
  return '\u2014';
}

/** Get signal badge color based on live value. Bool: green when true, grey when false. */
function signalBadgeColor(type: string, signalStore: SignalStore | null, path: string | null): string {
  if (!signalStore || !path) return componentColor(type);
  const value = signalStore.getByPath(path);
  if (value === undefined) return componentColor(type);

  if (isBoolSignal(type)) {
    if (value === true) {
      return type.startsWith('PLCInput') ? '#ef5350' : '#66bb6a';
    }
    return '#808080';
  }
  return componentColor(type);
}

// ─── LogicStep Helpers ───────────────────────────────────────────────────

function isLogicStepType(type: string): boolean {
  return type.startsWith('LogicStep_');
}

/** Get badge color for a component type — dynamic for LogicStep types (Active/Waiting only). */
function badgeColor(type: string, stepState?: StepState): string {
  if (isLogicStepType(type) && (stepState === StepState.Active || stepState === StepState.Waiting)) {
    return STEP_STATE_COLORS[stepState];
  }
  return componentColor(type);
}

/** Get step info from the logic engine for a given hierarchy path. */
function getStepInfoForPath(engine: RVLogicEngine | null, path: string | null): StepStateInfo | null {
  if (!engine || !path) return null;
  return engine.getStepInfo(path);
}

/** Format container progress text. */
function formatContainerProgress(info: StepStateInfo): string | null {
  if (info.type === 'Delay' && info.state === StepState.Active && info.elapsed !== undefined && info.duration !== undefined) {
    return `${info.elapsed.toFixed(1)}s/${info.duration.toFixed(1)}s`;
  }
  return null;
}

// ─── Badge label ─────────────────────────────────────────────────────────

/** Shorten verbose LogicStep type names to fit in compact badges. */
function shortStepType(type: string): string {
  const raw = type.replace('LogicStep_', '');
  switch (raw) {
    case 'SerialContainer':   return 'Serial';
    case 'ParallelContainer': return 'Parallel';
    case 'SetSignalBool':     return 'SetBool';
    case 'WaitForSignalBool': return 'WaitBool';
    case 'WaitForSensor':     return 'WaitSens';
    case 'DriveToPosition':
    case 'DriveTo':           return 'DriveTo';
    case 'SetDriveSpeed':     return 'SetSpd';
    case 'Enable':            return 'Enable';
    case 'Delay':             return 'Delay';
    case 'Pause':             return 'Pause';
    default:                  return raw;
  }
}

function badgeLabel(type: string, stepState?: StepState): string {
  if (isLogicStepType(type)) {
    const shortType = shortStepType(type);
    // Only show state label for Active/Waiting — Idle and Finished are not shown
    if (stepState === StepState.Active || stepState === StepState.Waiting) {
      return `${shortType} ${STEP_STATE_LABELS[stepState]}`;
    }
    return shortType;
  }
  if (type === 'RuntimeMetadata') return 'Metadata';
  if (type === 'ConnectSignal') return 'Conn';
  if (type === 'TransportSurface') return 'TS';
  if (type === 'DrivesRecorder') return 'Rec';
  if (type === 'ReplayRecording') return 'Replay';
  if (type === 'PLCOutputBool') return 'OutBool';
  if (type === 'PLCOutputFloat') return 'OutFloat';
  if (type === 'PLCOutputInt') return 'OutInt';
  if (type === 'PLCInputBool') return 'InBool';
  if (type === 'PLCInputFloat') return 'InFloat';
  if (type === 'PLCInputInt') return 'InInt';
  if (type.startsWith('PLCOutput')) return 'Out:' + type.replace('PLCOutput', '');
  if (type.startsWith('PLCInput')) return 'In:' + type.replace('PLCInput', '');
  if (type.startsWith('Drive_')) return type.replace('Drive_', 'D:');
  // Components can declare a custom display name via registerComponent({ displayName })
  return getDisplayName(type);
}

// ─── Badge Chip ─────────────────────────────────────────────────────────

function BadgeChip({ color, label }: { color: string; label: string }) {
  return (
    <Chip
      label={label}
      size="small"
      sx={{
        height: 14,
        fontSize: 8,
        fontWeight: 600,
        letterSpacing: 0.3,
        bgcolor: color + '22',
        color: color,
        border: `1px solid ${color}44`,
        flexShrink: 0,
        maxWidth: 100,
        '& .MuiChip-label': { px: 0.4, py: 0, overflow: 'hidden', textOverflow: 'ellipsis' },
      }}
    />
  );
}

// ─── Step Status Dot ─────────────────────────────────────────────────────

function StepStateDot({ stepState }: { stepState: StepState }) {
  // Only show dot for Active (pulsing green) and Waiting (pulsing amber). No dot for Idle/Finished.
  if (stepState === StepState.Idle || stepState === StepState.Finished) return null;
  return (
    <Box
      sx={{
        width: 8,
        height: 8,
        borderRadius: '50%',
        bgcolor: STEP_STATE_COLORS[stepState],
        flexShrink: 0,
        mr: 0.5,
        animation: 'rv-pulse 1.5s ease-in-out infinite',
      }}
    />
  );
}

// ─── Container Progress Badge ─────────────────────────────────────────────

function ContainerProgressBadge({ text }: { text: string }) {
  return (
    <Typography
      component="span"
      sx={{
        fontSize: 8,
        fontFamily: 'monospace',
        color: 'text.secondary',
        ml: 0.25,
        flexShrink: 0,
      }}
    >
      {text}
    </Typography>
  );
}

// ─── Badges Row ─────────────────────────────────────────────────────────

/** Renders component badges + signal badges (signals always right-most with live values). */
const NodeBadges = memo(function NodeBadges({
  types,
  signalStore,
  path,
  stepInfo,
}: {
  types: string[];
  signalStore: SignalStore | null;
  path: string | null;
  stepInfo?: StepStateInfo | null;
}) {
  const [nonSignalTypes, signalTypes] = useMemo(() => splitTypes(types), [types]);

  if (nonSignalTypes.length === 0 && signalTypes.length === 0) return null;

  const stepState = stepInfo?.state;
  const progressText = stepInfo ? formatContainerProgress(stepInfo) : null;

  return (
    <Box sx={{ display: 'flex', gap: 0.25, flexShrink: 1, ml: 'auto', alignItems: 'center', overflow: 'hidden', minWidth: 0 }}>
      {nonSignalTypes.map((type) => (
        <BadgeChip
          key={type}
          color={badgeColor(type, isLogicStepType(type) ? stepState : undefined)}
          label={badgeLabel(type, isLogicStepType(type) ? stepState : undefined)}
        />
      ))}
      {progressText && <ContainerProgressBadge text={progressText} />}
      {signalTypes.length > 0 && nonSignalTypes.length > 0 && (
        <Box sx={{ width: 2, flexShrink: 0 }} />
      )}
      {signalTypes.map((type) => (
        <BadgeChip
          key={type}
          color={signalBadgeColor(type, signalStore, path)}
          label={`${badgeLabel(type)} ${formatSignalValue(type, signalStore, path)}`}
        />
      ))}
    </Box>
  );
});

// ─── Hierarchy expand state persistence ──────────────────────────────────

const LS_KEY_TREE_EXPANDED = 'rv-hierarchy-expanded';

function loadTreeExpanded(): Set<string> {
  try {
    const raw = localStorage.getItem(LS_KEY_TREE_EXPANDED);
    return raw ? new Set(JSON.parse(raw) as string[]) : new Set();
  } catch { return new Set(); }
}

/** Debounce timer for batching LS writes of expanded state. */
let expandPersistTimer: ReturnType<typeof setTimeout> | null = null;

function persistTreeExpandedSet(expanded: Set<string>): void {
  if (expandPersistTimer) clearTimeout(expandPersistTimer);
  expandPersistTimer = setTimeout(() => {
    localStorage.setItem(LS_KEY_TREE_EXPANDED, JSON.stringify([...expanded]));
  }, 300);
}

// ─── Ancestor path computation ──────────────────────────────────────────

/** Compute all ancestor path segments for a given path.
 *  E.g. "A/B/C/D" -> ["A", "A/B", "A/B/C"] */
export function computeAncestors(path: string): string[] {
  const segments = path.split('/');
  const ancestors: string[] = [];
  for (let i = 0; i < segments.length - 1; i++) {
    ancestors.push(segments.slice(0, i + 1).join('/'));
  }
  return ancestors;
}

// ─── Tree Node Renderer (lifted expand state) ───────────────────────────

interface TreeNodeRowProps {
  node: TreeNode;
  depth: number;
  selectedPaths: Set<string>;
  expanded: Set<string>;
  onToggleExpand: (key: string) => void;
  onSelect: (path: string, shiftKey?: boolean) => void;
  onDoubleClick: (path: string) => void;
  onHover: (path: string | null) => void;
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
  signalStore: SignalStore | null;
  logicEngine: RVLogicEngine | null;
  /** Incrementing tick to bust memo cache for live step/signal updates. */
  liveTick: number;
}

const TreeNodeRow = memo(function TreeNodeRow({
  node,
  depth,
  selectedPaths,
  expanded,
  onToggleExpand,
  onSelect,
  onDoubleClick,
  onHover,
  onContextMenu,
  signalStore,
  logicEngine,
  liveTick,
}: TreeNodeRowProps) {
  const expandKey = node.path ?? node.name;
  const isExpanded = expanded.has(expandKey);
  const hasChildren = node.children.length > 0;
  const hasComponents = node.types.length > 0;
  const isSelected = hasComponents && !!node.path && selectedPaths.has(node.path);

  // Check if this node has a LogicStep component
  const hasLogicStep = node.types.some(isLogicStepType);
  const stepInfo = hasLogicStep ? getStepInfoForPath(logicEngine, node.path) : null;

  const handleClick = useCallback((e: React.MouseEvent) => {
    if (hasComponents && node.path) {
      onSelect(node.path, e.shiftKey);
    } else {
      onToggleExpand(expandKey);
    }
  }, [hasComponents, node.path, onSelect, onToggleExpand, expandKey]);

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

  // Long-press state for touch context menu
  const longPressTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const longPressPosRef = useRef<{ x: number; y: number } | null>(null);

  const cancelRowLongPress = useCallback(() => {
    if (longPressTimerRef.current) {
      clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = null;
    }
    longPressPosRef.current = null;
  }, []);

  const handlePointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch' && node.path && onContextMenu) {
      cancelRowLongPress();
      longPressPosRef.current = { x: e.clientX, y: e.clientY };
      longPressTimerRef.current = setTimeout(() => {
        longPressTimerRef.current = null;
        if (node.path && onContextMenu) {
          onContextMenu(
            { clientX: longPressPosRef.current!.x, clientY: longPressPosRef.current!.y, preventDefault: () => {}, stopPropagation: () => {} } as unknown as React.MouseEvent,
            node.path,
          );
          navigator.vibrate?.(50);
        }
      }, 500);
    }
  }, [node.path, onContextMenu, cancelRowLongPress]);

  const handlePointerMoveRow = useCallback((e: React.PointerEvent) => {
    if (longPressTimerRef.current && longPressPosRef.current) {
      const dx = e.clientX - longPressPosRef.current.x;
      const dy = e.clientY - longPressPosRef.current.y;
      if (dx * dx + dy * dy > 64) cancelRowLongPress(); // 8px threshold
    }
  }, [cancelRowLongPress]);

  return (
    <>
      <Box
        data-path={node.path ?? undefined}
        onClick={handleClick}
        onDoubleClick={handleDblClick}
        onContextMenu={handleContextMenu}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMoveRow}
        onPointerUp={cancelRowLongPress}
        onPointerLeave={cancelRowLongPress}
        onMouseEnter={handleMouseEnter}
        onMouseLeave={handleMouseLeave}
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
          bgcolor: isSelected ? 'rgba(79, 195, 247, 0.15)' : 'transparent',
          '&:hover': {
            bgcolor: isSelected ? 'rgba(79, 195, 247, 0.2)' : 'rgba(255, 255, 255, 0.04)',
          },
          minHeight: 20,
        }}
      >
        {hasChildren ? (
          <IconButton size="small" onClick={handleExpandClick} sx={{ p: 0, mr: 0.25, color: 'text.secondary' }}>
            {isExpanded ? <ExpandMore sx={{ fontSize: 14 }} /> : <ChevronRight sx={{ fontSize: 14 }} />}
          </IconButton>
        ) : (
          <Box sx={{ width: 16, flexShrink: 0 }} />
        )}

        {/* Status dot for LogicStep nodes */}
        {stepInfo && <StepStateDot stepState={stepInfo.state} />}

        <Tooltip title={node.name} placement="top" enterDelay={400} slotProps={{ tooltip: { sx: { fontSize: 10 } } }}>
          <Typography
            sx={{
              fontSize: 12,
              lineHeight: 1.3,
              fontWeight: hasComponents ? 400 : 500,
              color: isSelected ? 'primary.main' : hasComponents ? 'text.primary' : 'text.secondary',
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
          <NodeBadges types={node.types} signalStore={signalStore} path={node.path} stepInfo={stepInfo} />
        )}

      </Box>

      {hasChildren && isExpanded && node.children.map((child, i) => (
        <TreeNodeRow
          key={child.name + '-' + i}
          node={child}
          depth={depth + 1}
          selectedPaths={selectedPaths}
          expanded={expanded}
          onToggleExpand={onToggleExpand}
          onSelect={onSelect}
          onDoubleClick={onDoubleClick}
          onHover={onHover}
          onContextMenu={onContextMenu}
          signalStore={signalStore}
          logicEngine={logicEngine}
          liveTick={liveTick}
        />
      ))}
    </>
  );
});

// ─── Flat Node Row (type-filtered view) ──────────────────────────────────

const FLAT_ROW_HEIGHT = 20;

interface FlatNodeRowProps {
  info: EditableNodeInfo;
  selectedPaths: Set<string>;
  onSelect: (path: string, shiftKey?: boolean) => void;
  onDoubleClick: (path: string) => void;
  onHover: (path: string | null) => void;
  onContextMenu?: (e: React.MouseEvent, path: string) => void;
  signalStore: SignalStore | null;
  logicEngine: RVLogicEngine | null;
  /** Relative indentation depth (0 = top-level in filtered view). */
  depth?: number;
  /** Absolute positioning style from virtualizer (when virtualized). */
  virtualStyle?: React.CSSProperties;
}

const FlatNodeRow = memo(function FlatNodeRow({ info, selectedPaths, onSelect, onDoubleClick, onHover, onContextMenu, signalStore, logicEngine, depth = 0, virtualStyle }: FlatNodeRowProps) {
  const name = info.path.split('/').pop() ?? info.path;
  const isSelected = selectedPaths.has(info.path);

  const hasLogicStep = info.types.some(isLogicStepType);
  const stepInfo = hasLogicStep ? getStepInfoForPath(logicEngine, info.path) : null;
  const isContainer = info.types.some(t => t === 'LogicStep_SerialContainer' || t === 'LogicStep_ParallelContainer');

  const handleClick = useCallback((e: React.MouseEvent) => {
    onSelect(info.path, e.shiftKey);
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

  // Long-press state for touch context menu
  const flatLpTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flatLpPosRef = useRef<{ x: number; y: number } | null>(null);

  const cancelFlatLp = useCallback(() => {
    if (flatLpTimerRef.current) {
      clearTimeout(flatLpTimerRef.current);
      flatLpTimerRef.current = null;
    }
    flatLpPosRef.current = null;
  }, []);

  const handleFlatPointerDown = useCallback((e: React.PointerEvent) => {
    if (e.pointerType === 'touch' && onContextMenu) {
      cancelFlatLp();
      flatLpPosRef.current = { x: e.clientX, y: e.clientY };
      flatLpTimerRef.current = setTimeout(() => {
        flatLpTimerRef.current = null;
        if (onContextMenu) {
          onContextMenu(
            { clientX: flatLpPosRef.current!.x, clientY: flatLpPosRef.current!.y, preventDefault: () => {}, stopPropagation: () => {} } as unknown as React.MouseEvent,
            info.path,
          );
          navigator.vibrate?.(50);
        }
      }, 500);
    }
  }, [info.path, onContextMenu, cancelFlatLp]);

  const handleFlatPointerMove = useCallback((e: React.PointerEvent) => {
    if (flatLpTimerRef.current && flatLpPosRef.current) {
      const dx = e.clientX - flatLpPosRef.current.x;
      const dy = e.clientY - flatLpPosRef.current.y;
      if (dx * dx + dy * dy > 64) cancelFlatLp(); // 8px threshold
    }
  }, [cancelFlatLp]);

  return (
    <Box
      data-path={info.path}
      onClick={handleClick}
      onDoubleClick={handleDblClick}
      onContextMenu={handleCtxMenu}
      onPointerDown={handleFlatPointerDown}
      onPointerMove={handleFlatPointerMove}
      onPointerUp={cancelFlatLp}
      onPointerLeave={cancelFlatLp}
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
        },
        height: FLAT_ROW_HEIGHT,
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

      <Tooltip title={name} placement="top" enterDelay={400} slotProps={{ tooltip: { sx: { fontSize: 10 } } }}>
        <Typography
          sx={{
            fontSize: 12,
            lineHeight: 1.3,
            color: isSelected ? 'primary.main' : 'text.primary',
            fontWeight: isContainer ? 600 : 400,
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

      <NodeBadges types={info.types} signalStore={signalStore} path={info.path} stepInfo={stepInfo} />
    </Box>
  );
});

// ─── Main Component ──────────────────────────────────────────────────────

export interface HierarchyBrowserProps {
  viewer: RVViewer;
}

export function HierarchyBrowser({ viewer }: HierarchyBrowserProps) {
  const { plugin, state } = useEditorPlugin();
  const selection = useSelection();

  // Ensure pulse animation CSS is injected
  useEffect(() => { ensurePulseAnimation(); }, []);

  if (!plugin) return null;

  // Multi-select aware: Set for O(1) lookups in row components
  const selectedPathsSet = useMemo(
    () => new Set(selection.selectedPaths),
    [selection.selectedPaths],
  );

  const [searchTerm, setSearchTerm] = useState('');
  const [typeFilter, setTypeFilterRaw] = useState<TypeFilter>(() => {
    try { const v = localStorage.getItem('rv-hierarchy-type-filter'); return (v as TypeFilter) ?? 'all'; } catch { return 'all'; }
  });
  const setTypeFilter = useCallback((v: TypeFilter) => {
    setTypeFilterRaw(v);
    try { localStorage.setItem('rv-hierarchy-type-filter', v); } catch { /* */ }
  }, []);
  const [signalSort, setSignalSortRaw] = useState<SignalSort>(() => {
    try { const v = localStorage.getItem('rv-hierarchy-signal-sort'); return (v as SignalSort) ?? 'name'; } catch { return 'name'; }
  });
  const setSignalSort = useCallback((v: SignalSort) => {
    setSignalSortRaw(v);
    try { localStorage.setItem('rv-hierarchy-signal-sort', v); } catch { /* */ }
  }, []);
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  const signalStore = viewer.signalStore;
  const logicEngine = viewer.logicEngine;

  // Consolidated live data polling at 200ms (for both signals and step states)
  const liveTick = useSignalTick(signalStore, 200);

  // ── Lifted expand state (shared across all TreeNodeRows) ──
  const [expanded, setExpanded] = useState<Set<string>>(() => loadTreeExpanded());

  const onToggleExpand = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      persistTreeExpandedSet(next);
      return next;
    });
  }, []);

  // Flat list when type filter is active OR search is active (bypasses tree hierarchy)
  const flatFiltered = useMemo(() => {
    if (typeFilter === 'all' && !searchTerm) return null;
    let nodes = typeFilter !== 'all'
      ? state.editableNodes.filter(n => matchesTypeFilter(n.types, typeFilter))
      : state.editableNodes;
    if (searchTerm) {
      const lower = searchTerm.toLowerCase();
      nodes = nodes.filter(n => {
        const leafName = n.path.split('/').pop() ?? n.path;
        return leafName.toLowerCase().includes(lower);
      });
    }
    if (typeFilter === 'signals') {
      nodes = sortSignalNodes(nodes, signalSort);
    }
    return nodes;
  }, [state.editableNodes, typeFilter, searchTerm, signalSort]);

  // Compute relative depth for flat filtered nodes (for indentation in Logic view)
  const flatDepths = useMemo(() => {
    if (!flatFiltered || flatFiltered.length === 0) return new Map<string, number>();
    const depths = new Map<string, number>();
    const minSegments = Math.min(...flatFiltered.map(n => n.path.split('/').length));
    for (const n of flatFiltered) {
      depths.set(n.path, n.path.split('/').length - minSegments);
    }
    return depths;
  }, [flatFiltered]);

  // Flat list virtualizer (only active when typeFilter !== 'all')
  // Container rows have 4px top margin, so estimate slightly larger
  const flatRowVirtualizer = useVirtualizer({
    count: flatFiltered?.length ?? 0,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: (index) => {
      if (!flatFiltered) return FLAT_ROW_HEIGHT;
      const info = flatFiltered[index];
      const isContainer = info.types.some(t => t === 'LogicStep_SerialContainer' || t === 'LogicStep_ParallelContainer');
      return isContainer ? FLAT_ROW_HEIGHT + 4 : FLAT_ROW_HEIGHT;
    },
    overscan: 10,
  });

  // Ref to access virtualizer without adding it to effect deps (new object every render)
  const flatVirtualizerRef = useRef(flatRowVirtualizer);
  flatVirtualizerRef.current = flatRowVirtualizer;

  // ── Consume revealPath: expand ancestors and scroll to selected ──
  useEffect(() => {
    const revealPath = state.revealPath;
    if (!revealPath) return;

    // Expand all ancestor tree nodes
    const ancestors = computeAncestors(revealPath);
    if (ancestors.length > 0) {
      setExpanded(prev => {
        const next = new Set(prev);
        let changed = false;
        for (const a of ancestors) {
          if (!next.has(a)) { next.add(a); changed = true; }
        }
        if (changed) persistTreeExpandedSet(next);
        return changed ? next : prev;
      });
    }

    // Clear the reveal request after consuming
    plugin.clearReveal();

    // Scroll the selected node into view
    // Flat mode: use virtualizer scrollToIndex; Tree mode: use DOM scrollIntoView
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (flatFiltered) {
          // Flat virtualized list — find index and scroll via virtualizer
          const idx = flatFiltered.findIndex(n => n.path === revealPath);
          if (idx >= 0) flatVirtualizerRef.current.scrollToIndex(idx, { align: 'auto' });
        } else {
          // Tree mode — use DOM query
          const container = scrollContainerRef.current;
          if (!container) return;
          const el = container.querySelector(`[data-path="${CSS.escape(revealPath)}"]`);
          if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }
      }, 150);
    });
  }, [state.revealPath, plugin, flatFiltered]);

  // Tree view (only when typeFilter === 'all')
  const tree = useMemo(
    () => typeFilter === 'all' ? buildTree(state.editableNodes, state.overlay) : [],
    [state.editableNodes, state.overlay, typeFilter],
  );

  const filteredTree = useMemo(
    () => typeFilter === 'all' ? filterTree(tree, searchTerm, viewer) : [],
    [tree, searchTerm, typeFilter, viewer],
  );

  const counts = useMemo(
    () => countNodes(state.editableNodes, state.overlay),
    [state.editableNodes, state.overlay],
  );

  const displayCount = flatFiltered !== null ? flatFiltered.length : counts.total;

  // ── Hover highlight (orange, temporary) ──
  // Selection highlight (cyan, persistent) is handled by SelectionManager.
  // Debounced to avoid blocking the UI when scrolling over many hierarchy rows.

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleHover = useCallback((path: string | null) => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    if (!path) { viewer.highlighter.clear(); return; }
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      const node = viewer.registry?.getNode(path);
      if (node) {
        viewer.highlighter.highlight(node, true, { includeChildDrives: true });
      } else {
        viewer.highlighter.clear();
      }
    }, 80);
  }, [viewer]);

  const handleSelect = useCallback(
    (path: string, shiftKey = false) => {
      if (shiftKey) {
        viewer.selectionManager.toggleWithChildren(path);
      } else {
        viewer.selectionManager.select(path);
      }
      plugin.selectNode(path, true);
    },
    [viewer, plugin],
  );

  const handleDoubleClick = useCallback(
    (path: string) => {
      if (!viewer.registry) return;
      const node = viewer.registry.getNode(path);
      if (node) {
        viewer.fitToNodes([node]); // viewer auto-applies panel offset
      }
    },
    [viewer],
  );

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, path: string) => {
      if (!viewer.registry) return;
      const node = viewer.registry.getNode(path);
      if (!node) return;
      const target: ContextMenuTarget = {
        path,
        node,
        types: viewer.registry.getComponentTypes(path),
        extras: (node.userData?.realvirtual ?? {}) as Record<string, unknown>,
      };
      // Highlight the node and hold hover while context menu is open
      const isLayout = !!(node.userData?.realvirtual as Record<string, unknown> | undefined)?.LayoutObject;
      viewer.highlighter.highlight(node, false, { includeChildDrives: isLayout });
      if (viewer.raycastManager) viewer.raycastManager.holdHover = true;
      viewer.contextMenu.open({ x: e.clientX, y: e.clientY }, target);
    },
    [viewer],
  );

  // Clear hover highlight when panel closes
  useEffect(() => {
    return () => { viewer.highlighter.clear(); };
  }, [viewer]);

  const handleClose = useCallback(() => {
    viewer.highlighter.clear();
    plugin.togglePanel();
  }, [plugin, viewer]);

  const isFlat = flatFiltered !== null;

  return (
    <LeftPanel
      title="Hierarchy"
      onClose={handleClose}
      width={state.panelWidth}
      resizable
      minWidth={HIERARCHY_MIN_WIDTH}
      maxWidth={HIERARCHY_MAX_WIDTH}
      onResize={(w) => plugin.setPanelWidth(w)}
      footer={
        <Box sx={{ px: 1, py: 0.25, display: 'flex', alignItems: 'center' }}>
          <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
            {isFlat
              ? `${displayCount} of ${counts.total} node${counts.total !== 1 ? 's' : ''}`
              : `${counts.total} node${counts.total !== 1 ? 's' : ''}`}
            {counts.withOverrides > 0 && (
              <> &middot; {counts.withOverrides} with override{counts.withOverrides !== 1 ? 's' : ''}</>
            )}
          </Typography>
        </Box>
      }
    >
      {/* Search */}
      <Box sx={{ px: 0.75, py: 0.5, borderBottom: '1px solid rgba(255, 255, 255, 0.05)', flexShrink: 0 }}>
        <TextField
          size="small"
          fullWidth
          placeholder="Search nodes..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && flatFiltered && flatFiltered.length > 0) {
              handleSelect(flatFiltered[0].path);
            }
          }}
          slotProps={{
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <Search sx={{ fontSize: 16, color: 'text.disabled' }} />
                </InputAdornment>
              ),
              sx: { fontSize: 12, height: 26 },
            },
          }}
          sx={{
            '& .MuiOutlinedInput-root': {
              bgcolor: 'rgba(255, 255, 255, 0.04)',
              '& fieldset': { borderColor: 'rgba(255, 255, 255, 0.08)' },
              '&:hover fieldset': { borderColor: 'rgba(255, 255, 255, 0.15)' },
              '&.Mui-focused fieldset': { borderColor: 'primary.main' },
            },
          }}
        />
      </Box>

      {/* Type filter buttons */}
      <Box sx={{ display: 'flex', gap: 0.25, px: 0.75, py: 0.5, borderBottom: '1px solid rgba(255, 255, 255, 0.05)', flexShrink: 0 }}>
        {TYPE_FILTERS.map(({ key, label }) => (
          <Chip
            key={key}
            label={label}
            size="small"
            onClick={() => setTypeFilter(key)}
            sx={filterChipSx(typeFilter === key)}
          />
        ))}
      </Box>

      {/* Signal sort buttons (only when Signals filter active) */}
      {typeFilter === 'signals' && (
        <Box sx={{ display: 'flex', gap: 0.25, px: 0.75, py: 0.25, borderBottom: '1px solid rgba(255, 255, 255, 0.05)', flexShrink: 0, alignItems: 'center' }}>
          {([['name', 'A\u2013Z'], ['type', 'In / Out']] as const).map(([key, label]) => (
            <Chip
              key={key}
              label={label}
              size="small"
              onClick={() => setSignalSort(key)}
              sx={filterChipSx(signalSort === key, 16, 8)}
            />
          ))}
        </Box>
      )}

      {/* Tree / Flat list — own scroll container for useVirtualizer compatibility */}
      <Box
        ref={scrollContainerRef}
        className={RV_SCROLL_CLASS}
        sx={{
          flex: 1,
          overflow: 'auto',
          py: 0.5,
        }}
      >
        {isFlat ? (
          // Virtualized flat list (type filter active — no tree hierarchy)
          flatFiltered.length > 0 ? (
            <div style={{ height: flatRowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
              {flatRowVirtualizer.getVirtualItems().map((virtualRow) => {
                const info = flatFiltered[virtualRow.index];
                return (
                  <FlatNodeRow
                    key={info.path}
                    info={info}
                    selectedPaths={selectedPathsSet}
                    onSelect={handleSelect}
                    onDoubleClick={handleDoubleClick}
                    onHover={handleHover}
                    onContextMenu={handleContextMenu}
                    signalStore={signalStore}
                    logicEngine={logicEngine}
                    depth={typeFilter === 'logic' ? (flatDepths.get(info.path) ?? 0) : 0}
                    virtualStyle={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                  />
                );
              })}
            </div>
          ) : (
            <Typography sx={{ fontSize: 12, color: 'text.disabled', textAlign: 'center', py: 4 }}>
              No matching nodes
            </Typography>
          )
        ) : (
          // Tree view (All filter)
          filteredTree.length > 0 ? (
            filteredTree.map((node, i) => (
              <TreeNodeRow
                key={node.name + '-' + i}
                node={node}
                depth={0}
                selectedPaths={selectedPathsSet}
                expanded={expanded}
                onToggleExpand={onToggleExpand}
                onSelect={handleSelect}
                onDoubleClick={handleDoubleClick}
                onHover={handleHover}
                onContextMenu={handleContextMenu}
                signalStore={signalStore}
                logicEngine={logicEngine}
                liveTick={liveTick}
              />
            ))
          ) : (
            <Typography sx={{ fontSize: 12, color: 'text.disabled', textAlign: 'center', py: 4 }}>
              {state.editableNodes.length === 0 ? 'No model loaded' : 'No matching nodes'}
            </Typography>
          )
        )}
      </Box>
    </LeftPanel>
  );
}
