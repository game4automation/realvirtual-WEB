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
 * - Container progress counters
 * - Click to select (updates plugin state)
 * - Resizable width (drag right edge)
 * - Node count footer
 * - Reveal-and-scroll: external code can call plugin.selectAndReveal(path)
 *   to expand ancestor tree nodes and scroll the selected node into view
 *
 * Composition (plan-177 Phase 5):
 * - Tree/badge utilities live in `hierarchy-utils.ts`
 * - Row components live in `HierarchyNodeRow.tsx`
 * - Badge primitives live in `hierarchy-badge-components.tsx`
 * - Signals sort toolbar lives in `SignalBrowser.tsx`
 * - Long-press logic is the shared `useLongPress` hook
 */

import { useState, useMemo, useCallback, useRef, useEffect, useSyncExternalStore, useDeferredValue } from 'react';
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { useSelection } from '../../hooks/use-selection';
import {
  Box,
  Typography,
  TextField,
  InputAdornment,
  Chip,
  IconButton,
  Collapse,
  Badge,
  Tooltip,
  Button,
} from '@mui/material';
import { Search, FilterList, Close as ClearIcon } from '@mui/icons-material';
import { filterChipSx, RV_SCROLL_CLASS } from './shared-sx';
import type { RVViewer } from '../rv-viewer';
import type { SnapPointPlugin } from '../../plugins/snap-point';
import type { ContextMenuTarget } from './context-menu-store';
import { HIERARCHY_MIN_WIDTH, HIERARCHY_MAX_WIDTH } from './rv-extras-editor';
import { LeftPanel } from './LeftPanel';
import { getSceneStore } from './scene/scene-store-singleton';
import { requestDescend } from '../editor/rv-descend-request';
import { isInsideReference } from '../engine/rv-reference-scope';
import { isModelRoot } from '../engine/rv-model-root';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  applyLazyInjection,
  buildStructureTree,
  computeAncestors,
  countNodes,
  filterTree,
  flattenVisibleTree,
  matchesTypeFilter,
  sortSignalNodes,
  type SignalSort,
  type TreeNode,
  type TypeFilter,
} from './hierarchy-utils';
import { FlatNodeRow, TreeNodeRow, rowDomId, type SelectMods, type DropZone } from './HierarchyNodeRow';
import { usePointerRowHeight } from '../../hooks/use-pointer-row-height';
import { getActiveEditTarget, subscribeEditTarget, getEditTargetVersion } from './rv-edit-target';
import { getActiveAssetContext, subscribeActiveAsset, getActiveAssetVersion } from '../editor/active-asset-store';
import { NodeRegistry } from '../engine/rv-node-registry';
import type { Object3D } from 'three';
import { SignalBrowser } from './SignalBrowser';
import { DocumentCard, DOCUMENT_CARD_UI_ID, DOCUMENT_CARD_VISIBILITY } from './scene/DocumentCard';
import {
  getActiveDocumentViewVersion,
  resolveActiveDocumentView,
  subscribeActiveDocumentView,
} from '../editor/active-document-view';
import { useUIVisible } from './ui-context-store';

// Re-exports for backwards compatibility — external callers (and tests) may
// import these symbols from `rv-hierarchy-browser`.
export { computeAncestors } from './hierarchy-utils';
export type { TreeNode, TypeFilter, SignalSort } from './hierarchy-utils';

// ─── CSS pulse animation ─────────────────────────────────────────────────

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

// ─── Type filter chips ───────────────────────────────────────────────────

const TYPE_FILTERS: { key: TypeFilter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'drives', label: 'Drives' },
  { key: 'sensors', label: 'Sensors' },
  { key: 'signals', label: 'Signals' },
  { key: 'logic', label: 'Logic' },
];

/** Empty result state with an in-place recovery action. `onClear` resets the
 *  search + type filter in one click so the user never has to hunt for the tiny
 *  clear-X and the funnel icon to escape a dead-end "No matching nodes". */
function NoMatchState({ onClear }: { onClear?: () => void }) {
  return (
    <Box sx={{ textAlign: 'center', py: 4, px: 2 }}>
      <Typography sx={{ fontSize: 12, color: 'text.disabled', mb: onClear ? 1 : 0 }}>
        No matching nodes
      </Typography>
      {onClear && (
        <Button size="small" onClick={onClear} sx={{ textTransform: 'none', fontSize: 11 }}>
          Clear filters
        </Button>
      )}
    </Box>
  );
}

/** Locate a node in the (filtered) tree by path, returning it plus the nearest
 *  ancestor path — used by ArrowLeft/Right keyboard navigation to expand/collapse
 *  or step to the parent. `parent` threads the last real path down the recursion. */
function findTreeNode(
  nodes: TreeNode[],
  path: string,
  parent: string | null = null,
): { node: TreeNode; parentPath: string | null } | null {
  for (const n of nodes) {
    if (n.path === path) return { node: n, parentPath: parent };
    const r = findTreeNode(n.children, path, n.path ?? parent);
    if (r) return r;
  }
  return null;
}

// ─── Hierarchy expand-state persistence ──────────────────────────────────

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

// ─── Main component ──────────────────────────────────────────────────────

export interface HierarchyBrowserProps {
  viewer: RVViewer;
}

export function HierarchyBrowser({ viewer }: HierarchyBrowserProps) {
  const { plugin, state } = useEditorPlugin();
  const selection = useSelection();

  // Read the active model name from SceneStore — used as the panel title so
  // the Hierarchy header mirrors the Models window's "current scene" framing.
  const sceneStore = getSceneStore();
  const sceneSnap = useSyncExternalStore(
    sceneStore?.subscribe ?? (() => () => {}),
    sceneStore?.getSnapshot ?? (() => null),
  );
  const modelName = sceneSnap?.draft?.name ?? 'Hierarchy';

  // The document card, mounted DIRECTLY (plan-709 §2.1.2). It used to arrive
  // through a mode-keyed registry, which was the vehicle for "one card per
  // mode"; with one card for every mode the registry carried nothing, and with
  // it goes the question of who registers before the first render.
  //
  // Whether it renders is the card's own answer (the view seam reports a
  // document or it does not); whether it MAY render is the usual visibility
  // axis — a kiosk/viewer deploy shows no document chrome at all.
  useSyncExternalStore(viewer.modes.subscribe, viewer.modes.getSnapshot);
  const showDocumentCard = useUIVisible(DOCUMENT_CARD_UI_ID, DOCUMENT_CARD_VISIBILITY as never);
  const activeMode = viewer.modes.activeMode;
  // The card owns the header row only when it has something to say — with no
  // open document it renders nothing, and an empty header would be worse than
  // the model name it replaced.
  const documentViewVersion = useSyncExternalStore(
    subscribeActiveDocumentView,
    getActiveDocumentViewVersion,
  );
  const hasDocumentView = useMemo(
    () => resolveActiveDocumentView(activeMode) !== null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [documentViewVersion, activeMode],
  );

  // Ensure pulse animation CSS is injected
  useEffect(() => { ensurePulseAnimation(); }, []);

  if (!plugin) return null;

  // Multi-select aware: Set for O(1) lookups in row components
  const selectedPathsSet = useMemo(
    () => new Set(selection.selectedPaths),
    [selection.selectedPaths],
  );

  const [searchTerm, setSearchTerm] = useState('');
  const deferredTerm = useDeferredValue(searchTerm);
  const isSearchPending = searchTerm !== deferredTerm;
  const [typeFilter, setTypeFilterRaw] = useState<TypeFilter>(() => {
    try { const v = localStorage.getItem('rv-hierarchy-type-filter'); return (v as TypeFilter) ?? 'all'; } catch { return 'all'; }
  });
  const setTypeFilter = useCallback((v: TypeFilter) => {
    setTypeFilterRaw(v);
    try { localStorage.setItem('rv-hierarchy-type-filter', v); } catch { /* */ }
  }, []);
  // Search + type-filter controls are collapsed behind the header filter icon.
  // Start expanded when a persisted type filter is active, so the user
  // immediately sees WHY the tree is filtered.
  const [filtersOpen, setFiltersOpen] = useState<boolean>(() => typeFilter !== 'all');
  const filtersOpenedByUser = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const toggleFilters = useCallback(() => {
    filtersOpenedByUser.current = true;
    setFiltersOpen(o => !o);
  }, []);
  // Autofocus the search field when the USER opens the section (not when it
  // auto-opens on mount due to a persisted filter — that would steal focus).
  useEffect(() => {
    if (filtersOpen && filtersOpenedByUser.current) searchInputRef.current?.focus();
  }, [filtersOpen]);

  const [signalSort, setSignalSortRaw] = useState<SignalSort>(() => {
    try { const v = localStorage.getItem('rv-hierarchy-signal-sort'); return (v as SignalSort) ?? 'name'; } catch { return 'name'; }
  });
  const setSignalSort = useCallback((v: SignalSort) => {
    setSignalSortRaw(v);
    try { localStorage.setItem('rv-hierarchy-signal-sort', v); } catch { /* */ }
  }, []);
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const rowHeight = usePointerRowHeight();

  const signalStore = viewer.signalStore;
  const logicEngine = viewer.logicEngine;

  // ── Lifted expand state (shared across all TreeNodeRows) ──
  const [expanded, setExpanded] = useState<Set<string>>(() => loadTreeExpanded());
  const [pendingKeyboardPath, setPendingKeyboardPath] = useState<string | null>(null);

  const onToggleExpand = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      persistTreeExpandedSet(next);
      return next;
    });
  }, []);

  // Flat list ONLY when a type filter is active (Drives/Sensors/Signals/Logic).
  // A plain "All" search stays in TREE mode and goes through filterTree, so it
  // matches name + full path + component metadata (AAS/Metadata) instead of the
  // leaf-name-only match this flat path does. Search within a type filter keeps
  // the flat leaf/path match (the list is already scoped to one category).
  const flatFiltered = useMemo(() => {
    if (typeFilter === 'all') return null;
    let nodes = state.editableNodes.filter(n => matchesTypeFilter(n.types, typeFilter));
    if (deferredTerm) {
      const lower = deferredTerm.toLowerCase();
      nodes = nodes.filter(n => n.path.toLowerCase().includes(lower));
    }
    if (typeFilter === 'signals') {
      nodes = sortSignalNodes(nodes, signalSort);
    }
    return nodes;
  }, [state.editableNodes, typeFilter, deferredTerm, signalSort]);

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
      if (!flatFiltered) return rowHeight;
      const info = flatFiltered[index];
      const isContainer = info.types.some(t => t === 'LogicStep_SerialContainer' || t === 'LogicStep_ParallelContainer');
      return isContainer ? rowHeight + 4 : rowHeight;
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

    const ancestors = computeAncestors(revealPath);
    if (state.revealCollapseOthers) {
      // Exclusive reveal: the revealed node's ancestor chain becomes the ONLY
      // expanded set — every other branch (incl. other top-level nodes) collapses.
      setExpanded(() => {
        const next = new Set(ancestors);
        persistTreeExpandedSet(next);
        return next;
      });
    } else if (ancestors.length > 0) {
      // Expand all ancestor tree nodes
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
          // Flat virtualized list — find index and scroll via virtualizer.
          // `center` keeps the revealed row around the middle of the viewport
          // instead of just nudging it to the nearest edge.
          const idx = flatFiltered.findIndex(n => n.path === revealPath);
          if (idx >= 0) flatVirtualizerRef.current.scrollToIndex(idx, { align: 'center' });
        } else {
          // Tree mode — use DOM query. `block: 'center'` positions the node
          // near the middle of the scroll container rather than the nearest edge.
          const idx = visibleRowsRef.current.findIndex((row) => row.node.path === revealPath);
          if (idx >= 0) treeVirtualizerRef.current.scrollToIndex(idx, { align: 'center' });
        }
      }, 150);
    });
  }, [state.revealPath, state.revealCollapseOthers, plugin, flatFiltered]);

  // ── Keep the focused node visible across hierarchy view changes ──
  // Toggling the type filter (e.g. Drives filter on/off) rebuilds the tree/flat
  // view; the selected node's ancestors may be collapsed or the node may fall
  // outside the viewport. Re-reveal the current selection so the focused element
  // stays visible. primaryPath is read via ref so this fires only on filter
  // changes (and mount), not on every selection change.
  const primaryPathRef = useRef(selection.primaryPath);
  primaryPathRef.current = selection.primaryPath;
  useEffect(() => {
    const p = primaryPathRef.current;
    if (p) plugin.requestReveal(p);
  }, [typeFilter, plugin]);

  // Same for the search filter, but only when it is CLEARED (non-empty -> empty).
  // Revealing on every keystroke would scroll the list away while typing; we only
  // want to bring the selection back once the user removes the search filter.
  const prevSearchRef = useRef(searchTerm);
  useEffect(() => {
    const wasFiltering = prevSearchRef.current.length > 0;
    prevSearchRef.current = searchTerm;
    if (wasFiltering && searchTerm.length === 0) {
      const p = primaryPathRef.current;
      if (p) plugin.requestReveal(p);
    }
  }, [searchTerm, plugin]);

  /**
   * The model root as path-space keys, or null when there is no row to lock
   * (plan-715 §2.4.2). Resolved HERE because this is the layer that holds the
   * real `Object3D` and can compare by identity; `buildStructureTree` only ever
   * sees the derived keys.
   *
   * Two cases deliberately answer null:
   * - no model loaded — there is no root row and nothing to label;
   * - an active hierarchy root override ("Runtime view", plan-301) pointed at
   *   something OTHER than the model root. That scan lists a preview subtree, so
   *   the root of the tree on screen is not the model root and must not be
   *   dressed up as it.
   *
   * The label follows the DOCUMENT (plan-709), not `Object3D.name`: renaming the
   * root would rewrite the first segment of every node path (doc-node-paths.md).
   * Fallback chain: document name → GLB file name without extension → the node's
   * own name (which may carry a `_N` dedup suffix — accepted, it is the last resort).
   */
  const modelRootInfo = useMemo(() => {
    const root = viewer.currentModelRoot;
    if (!root) return null;
    const override = plugin.hierarchyRootOverride;
    if (override && override !== root) return null;
    const rootPath = viewer.registry?.getPathForNode(root) ?? NodeRegistry.computeNodePath(root);
    if (!rootPath) return null;
    const fileName = viewer.currentModelUrl?.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
    return { rootPath, label: sceneSnap?.draft?.name || fileName || root.name || rootPath };
    // `state.editableNodes` is the re-scan signal: every model load / structural
    // change refreshes it, which is exactly when the root identity can change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, plugin, sceneSnap?.draft?.name, state.editableNodes]);

  /**
   * The root row starts EXPANDED — a hierarchy whose only visible row is a
   * collapsed root would be a worse tree than the one before plan-715.
   *
   * Applied once per root path (`defaultedRootsRef`) rather than on every
   * render: the expand set is localStorage-persisted, so re-asserting it would
   * override a user who deliberately collapsed the root, and re-asserting it on
   * a model swap that happens to reuse the root name is the one case where the
   * persisted state is misleading anyway.
   */
  const defaultedRootsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const rootPath = modelRootInfo?.rootPath;
    if (!rootPath || defaultedRootsRef.current.has(rootPath)) return;
    defaultedRootsRef.current.add(rootPath);
    setExpanded((prev) => {
      if (prev.has(rootPath)) return prev;
      const next = new Set(prev);
      next.add(rootPath);
      persistTreeExpandedSet(next);
      return next;
    });
  }, [modelRootInfo?.rootPath]);

  // Build the expensive path structure independently from expansion changes.
  const structureTree = useMemo(
    () => typeFilter === 'all' ? buildStructureTree(state.editableNodes, state.overlay, modelRootInfo) : [],
    [state.editableNodes, state.overlay, typeFilter, modelRootInfo],
  );

  // Expanded LayoutObject/CADLink raw children are injected persistently so
  // unaffected branches retain their structural node identity.
  const tree = useMemo(
    () => typeFilter === 'all'
      ? applyLazyInjection(structureTree, viewer, expanded, state.overlay)
      : [],
    [structureTree, typeFilter, viewer, expanded, state.overlay],
  );

  const filteredTree = useMemo(
    () => typeFilter === 'all' ? filterTree(tree, deferredTerm, viewer) : [],
    [tree, deferredTerm, typeFilter, viewer],
  );

  // While an "All" search is active, filterTree prunes to matching branches +
  // their ancestors, but rows still render children only when their expand key
  // is in the expanded set. Auto-expand every node in the pruned tree so matches
  // buried under collapsed ancestors are actually visible; when not searching,
  // the user's own expand state applies.
  const searchExpanded = useMemo(() => {
    if (!deferredTerm || typeFilter !== 'all') return null;
    const keys = new Set<string>();
    const walk = (n: TreeNode) => { keys.add(n.path ?? n.name); n.children.forEach(walk); };
    filteredTree.forEach(walk);
    return keys;
  }, [deferredTerm, typeFilter, filteredTree]);
  const renderExpanded = searchExpanded ?? expanded;

  const visibleRows = useMemo(
    () => flattenVisibleTree(filteredTree, renderExpanded),
    [filteredTree, renderExpanded],
  );

  const treeRowVirtualizer = useVirtualizer({
    count: visibleRows.length,
    getScrollElement: () => scrollContainerRef.current,
    estimateSize: () => rowHeight,
    getItemKey: (index) => visibleRows[index]?.rowKey ?? index,
    overscan: 10,
  });
  const treeVirtualizerRef = useRef(treeRowVirtualizer);
  treeVirtualizerRef.current = treeRowVirtualizer;
  const visibleRowsRef = useRef(visibleRows);
  visibleRowsRef.current = visibleRows;

  // Match count for the footer + first match for Enter, in tree-search mode
  // (flat mode reports its own count/first-result). Counts path-bearing nodes in
  // the pruned tree — an approximation that includes kept ancestors, but it
  // communicates "narrowed" honestly instead of showing the full total.
  const [treeVisibleCount, firstTreeMatchPath] = useMemo((): [number | null, string | null] => {
    if (typeFilter !== 'all' || !deferredTerm) return [null, null];
    let count = 0;
    let first: string | null = null;
    const walk = (n: TreeNode) => {
      if (n.path) { count++; if (!first) first = n.path; }
      n.children.forEach(walk);
    };
    filteredTree.forEach(walk);
    return [count, first];
  }, [typeFilter, deferredTerm, filteredTree]);

  // ── Editor eye toggles (asset editor only) ──
  // The EditTarget installs asynchronously after mode activation — subscribe
  // so the eyes appear/disappear with it. Rows re-render on visibility ops
  // through editor-structure-changed → refreshEditableNodes → new tree.
  useSyncExternalStore(subscribeEditTarget, getEditTargetVersion);
  const canToggleVisibility = !!getActiveEditTarget().setNodeVisible;

  const getNodeVisible = useCallback(
    (path: string) => viewer.registry?.getNode(path)?.visible ?? true,
    [viewer],
  );

  /**
   * Should this row be dimmed? Two reasons, ONE styling (plan-703 §2.4.2).
   *
   * 1. Hidden — the node or an ancestor has `visible === false` (the eye).
   * 2. Inside a reference — the node's structure lives in another file, so the
   *    structural verbs do not reach it (F8). Its VALUES stay editable; the
   *    dimming says "locked shape", not "read-only".
   *
   * Deliberately not two opacities, two colours or an icon: `2.4.2` says a
   * second predicate, not a second visual. And deliberately not a 3D effect —
   * decision 21 keeps the viewport untouched, which is also why this plan never
   * comes near `BatchVisibilityService` (§5.1).
   */
  const getEffectiveVisible = useCallback((path: string) => {
    const node = viewer.registry?.getNode(path) ?? null;
    if (!node) return true;
    let cur: Object3D | null = node;
    while (cur && cur !== viewer.scene) {
      if (!cur.visible) return false;
      cur = cur.parent;
    }
    // Inclusive: the reference row itself dims too, exactly as §3.3 draws it.
    return !isInsideReference(node, viewer.currentModelRoot);
  }, [viewer]);

  const onToggleVisible = useCallback((path: string) => {
    const node = viewer.registry?.getNode(path);
    if (!node || isModelRoot(node, viewer.currentModelRoot)) return; // asset root stays visible
    getActiveEditTarget().setNodeVisible?.(path, !node.visible);
  }, [viewer]);

  // ── Drag & drop reorder / reparent (asset editor only) ──
  // Unity-style: drag a row and drop it BETWEEN two rows to reorder it as a
  // sibling, or ONTO a row to reparent it as that node's child (world transform
  // preserved). Enabled only in the plain tree view (no type filter / search,
  // where sibling order and indices are unambiguous) while an asset document is
  // active. All the heavy lifting — world-preserving TRS, undo, GLB round-trip —
  // lives in AssetDocument.reparentNodes; this only computes the target slot.
  useSyncExternalStore(subscribeActiveAsset, getActiveAssetVersion);
  const dndEnabled = typeFilter === 'all' && !deferredTerm && !!getActiveAssetContext();

  const dragPathsRef = useRef<string[]>([]);
  const [dropTarget, setDropTarget] = useState<{ path: string; zone: DropZone } | null>(null);
  const dropTargetRef = useRef<{ path: string; zone: DropZone } | null>(null);
  const autoExpandRef = useRef<{ path: string; timer: ReturnType<typeof setTimeout> } | null>(null);

  const clearAutoExpand = useCallback(() => {
    if (autoExpandRef.current) { clearTimeout(autoExpandRef.current.timer); autoExpandRef.current = null; }
  }, []);

  const clearDrag = useCallback(() => {
    dragPathsRef.current = [];
    dropTargetRef.current = null;
    setDropTarget(null);
    clearAutoExpand();
  }, [clearAutoExpand]);

  /** Resolve a hovered (row, zone) into the target parent path + sibling index
   *  the drag would land at, or null when the move is illegal (dropping a node
   *  onto itself/a descendant, or a same-parent reorder to its own slot). The
   *  index is expressed against the parent's children with the moved nodes
   *  excluded — exactly what AssetDocument.reparentNodes expects. */
  const resolveDrop = useCallback(
    (targetPath: string, zone: DropZone): { parentPath: string | null; index?: number } | null => {
      const registry = viewer.registry;
      const dragged = dragPathsRef.current;
      if (!registry || dragged.length === 0) return null;
      const targetNode = registry.getNode(targetPath);
      if (!targetNode) return null;
      const draggedNodes = dragged
        .map((p) => registry.getNode(p))
        .filter((n): n is Object3D => !!n);
      if (draggedNodes.length === 0) return null;
      // True when `n` is one of the dragged nodes or lives inside one — the new
      // parent must never be a dragged node or its descendant (would be a cycle).
      const insideDragged = (n: Object3D | null): boolean => {
        for (let c: Object3D | null = n; c; c = c.parent) {
          if (draggedNodes.includes(c)) return true;
        }
        return false;
      };

      if (zone === 'onto') {
        if (insideDragged(targetNode)) return null;
        // Dropping ONTO the model root stays legal (it is the asset's own parent
        // slot), but `reparentNodes` addresses that slot as `null` — the same
        // convention the reorder branch below uses. Passing the root's PATH here
        // would look equivalent and is not: it re-resolves through the registry
        // and diverges the moment the root name is deduped.
        if (isModelRoot(targetNode, viewer.currentModelRoot)) return { parentPath: null };
        return { parentPath: targetPath }; // target becomes the new parent (append)
      }

      const parent = targetNode.parent;
      if (!parent || insideDragged(parent)) return null;
      const childIndex = parent.children.indexOf(targetNode);
      const rawInsert = zone === 'before' ? childIndex : childIndex + 1;

      // Dropping immediately above/below the single node being dragged (within
      // its own parent) is a no-op — reject so no indicator shows.
      if (draggedNodes.length === 1 && draggedNodes[0].parent === parent) {
        const selfIdx = parent.children.indexOf(draggedNodes[0]);
        if (rawInsert === selfIdx || rawInsert === selfIdx + 1) return null;
      }

      // Convert the full-array insertion point to the moved-nodes-excluded index.
      let excludedBefore = 0;
      for (const dn of draggedNodes) {
        if (dn.parent === parent && parent.children.indexOf(dn) < rawInsert) excludedBefore++;
      }
      const index = Math.max(0, rawInsert - excludedBefore);
      const parentPath = isModelRoot(parent, viewer.currentModelRoot)
        ? null
        : NodeRegistry.computeNodePath(parent);
      return { parentPath, index };
    },
    [viewer],
  );

  const handleRowDragOver = useCallback((path: string, zone: DropZone, e: React.DragEvent) => {
    const res = resolveDrop(path, zone);
    if (!res) {
      // Illegal target — no preventDefault so the browser shows a no-drop cursor.
      if (dropTargetRef.current) { dropTargetRef.current = null; setDropTarget(null); }
      clearAutoExpand();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const cur = dropTargetRef.current;
    if (cur?.path !== path || cur.zone !== zone) {
      dropTargetRef.current = { path, zone };
      setDropTarget({ path, zone });
      clearAutoExpand();
      // Hovering ONTO a collapsed node briefly springs it open so you can drop
      // into deep trees (Unity spring-loaded folders).
      if (zone === 'onto' && !expanded.has(path)) {
        const node = viewer.registry?.getNode(path);
        if (node && node.children.length > 0) {
          autoExpandRef.current = { path, timer: setTimeout(() => onToggleExpand(path), 600) };
        }
      }
    }
  }, [resolveDrop, clearAutoExpand, expanded, viewer, onToggleExpand]);

  const handleRowDrop = useCallback((path: string, zone: DropZone, e: React.DragEvent) => {
    e.preventDefault();
    const res = resolveDrop(path, zone);
    const paths = dragPathsRef.current.slice();
    clearDrag();
    if (!res || paths.length === 0) return;
    const ctx = getActiveAssetContext();
    if (!ctx) return;
    void ctx.doc.reparentNodes(paths, res.parentPath, res.index !== undefined ? { index: res.index } : undefined);
  }, [resolveDrop, clearDrag]);

  const counts = useMemo(
    () => countNodes(state.editableNodes, state.overlay),
    [state.editableNodes, state.overlay],
  );

  const displayCount = flatFiltered !== null ? flatFiltered.length : (treeVisibleCount ?? counts.total);

  // ── Hover highlight (orange, temporary) ──
  // Selection highlight (cyan, persistent) is handled by SelectionManager.
  // Debounced to avoid blocking the UI when scrolling over many hierarchy rows.

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Snap 3D-highlight (A5) ──
  // A snap Empty has no mesh, so the outline highlighter shows nothing. When a
  // hierarchy row is a snap node, drive the snap-point plugin's marker highlight
  // instead (hover = temporary, select = persistent). The snap id is the node's
  // Object3D.uuid (== SnapPoint.id).
  const snapIdForPath = useCallback((path: string | null): string | null => {
    if (!path) return null;
    const node = viewer.registry?.getNode(path);
    if (!node) return null;
    const reg = viewer.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry();
    return reg?.getById(node.uuid) ? node.uuid : null;
  }, [viewer]);

  const highlightSnap = useCallback((snapId: string | null) => {
    viewer.getPlugin<SnapPointPlugin>('snap-point')?.highlightSnap(snapId);
  }, [viewer]);

  const handleHover = useCallback((path: string | null) => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    if (!path) { viewer.highlighter.clear(); highlightSnap(null); return; }
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      const node = viewer.registry?.getNode(path);
      if (node) {
        // Hover shows the plain hover highlight only - no attention pulse. The
        // blinking glow hull on top of it read as a second, competing overlay.
        viewer.highlighter.highlight(node, true, { includeChildDrives: false });
        // Snap node → also show the 3D marker highlight (temporary hover).
        highlightSnap(snapIdForPath(path));
      } else {
        viewer.highlighter.clear();
        highlightSnap(null);
      }
    }, 80);
  }, [viewer, highlightSnap, snapIdForPath]);

  // Refs so handleSelect stays referentially stable (memoized rows) while the
  // Shift-range still reads the CURRENT visible row order.
  const anchorRef = useRef<string | null>(null);
  const flatFilteredRef = useRef(flatFiltered);
  flatFilteredRef.current = flatFiltered;
  const filteredTreeRef = useRef(filteredTree);
  filteredTreeRef.current = filteredTree;
  // Track the EFFECTIVE expansion (search auto-expand included) so a Shift-range
  // over visibleTreePaths matches exactly the rows the user currently sees.
  const expandedRef = useRef(renderExpanded);
  expandedRef.current = renderExpanded;
  const searchExpandedRef = useRef(searchExpanded);
  searchExpandedRef.current = searchExpanded;

  // The flat, render-order list of visible row paths — the ground truth for
  // keyboard Arrow navigation (flat list in a type filter, else the expanded
  // tree). Kept in a ref so the key handler stays referentially stable.
  const visibleOrder = useMemo(
    () => flatFiltered
      ? flatFiltered.map((n) => n.path)
      : visibleRows.flatMap((row) => row.node.path ? [row.node.path] : []),
    [flatFiltered, visibleRows],
  );
  const visibleOrderRef = useRef(visibleOrder);
  visibleOrderRef.current = visibleOrder;

  const flatVirtualItems = flatRowVirtualizer.getVirtualItems();
  const treeVirtualItems = treeRowVirtualizer.getVirtualItems();
  const mountedPaths = new Set<string>();
  if (flatFiltered) {
    for (const item of flatVirtualItems) {
      const path = flatFiltered[item.index]?.path;
      if (path) mountedPaths.add(path);
    }
  } else {
    for (const item of treeVirtualItems) {
      const path = visibleRows[item.index]?.node.path;
      if (path) mountedPaths.add(path);
    }
  }

  const handleSelect = useCallback(
    (path: string, mods?: SelectMods) => {
      const sm = viewer.selectionManager;
      if (mods?.toggle) {
        // Ctrl/Cmd+click — toggle this node in/out of the selection.
        sm.toggle(path);
        anchorRef.current = path;
      } else if (mods?.shift && anchorRef.current && anchorRef.current !== path) {
        // Shift+click — contiguous range over the currently visible rows,
        // anchored at the last plain/toggle click. Missing indices (anchor
        // deleted / filtered away) fall back to a plain select.
        const flat = flatFilteredRef.current;
        const order = flat
          ? flat.map((n) => n.path)
          : visibleRowsRef.current.flatMap((row) => row.node.path ? [row.node.path] : []);
        const a = order.indexOf(anchorRef.current);
        const b = order.indexOf(path);
        if (a >= 0 && b >= 0) {
          sm.selectPaths(order.slice(Math.min(a, b), Math.max(a, b) + 1));
          // Anchor stays — repeated shift-clicks re-range from the same anchor.
        } else {
          sm.select(path);
          anchorRef.current = path;
        }
      } else {
        sm.select(path);
        anchorRef.current = path;
      }
      // Persistent snap highlight on select; clears when a non-snap is selected.
      highlightSnap(snapIdForPath(path));
      // Single click selects only — it does NOT force the property inspector
      // open (that is the double-click gesture, see handleDoubleClick). If the
      // inspector is already open it follows the new selection; if closed it
      // stays closed. `getSnapshot()` reads the live value (this callback is
      // memoized and would otherwise close over a stale `showInspector`).
      plugin.selectNode(path, plugin.getSnapshot().showInspector);
    },
    [viewer, plugin, highlightSnap, snapIdForPath],
  );

  const handleRowDragStart = useCallback((path: string, e: React.DragEvent) => {
    // The model root is not a draggable thing (plan-715 F4). The row already
    // renders undraggable; this is the second lock, for the case where a drag
    // reaches the handler anyway (a synthetic event, a future row variant).
    if (isModelRoot(viewer.registry?.getNode(path), viewer.currentModelRoot)) {
      e.preventDefault();
      return;
    }
    // Dragging a row that is part of a multi-selection moves the whole set;
    // dragging an unselected row moves (and selects) just that row.
    const sel = selectedPathsSet;
    const paths = sel.has(path) && sel.size > 1 ? [...selection.selectedPaths] : [path];
    if (!sel.has(path)) handleSelect(path);
    dragPathsRef.current = paths;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', paths.join('\n')); } catch { /* jsdom */ }
  }, [selectedPathsSet, selection.selectedPaths, handleSelect, viewer]);

  const handleDoubleClick = useCallback(
    (path: string) => {
      // On a resolvable AssetReference the double-click is a DESCEND, not an
      // inspector toggle (plan-703 §3.4): the reference node itself has almost
      // nothing to inspect, and the gesture the user means is "open this".
      // `requestDescend` answers false when there is no editor stack or the node
      // is not descendable (an embedded reference, a placeholder), so the
      // ordinary behaviour below stays the default rather than the exception.
      if (requestDescend(path)) return;

      // Double click is the gesture that opens the property inspector. The node
      // is already selected by the preceding click of the double-click sequence,
      // so this just flips the inspector visible for it.
      plugin.selectNode(path, true);
      if (!viewer.registry) return;
      const node = viewer.registry.getNode(path);
      if (node) {
        viewer.fitToNodes([node]); // viewer auto-applies panel offset
      }
    },
    [viewer, plugin],
  );

  // Keyboard navigation for the tree (WAI-ARIA tree pattern). The container
  // holds focus and tracks the active row via aria-activedescendant; arrows move
  // selection through the visible row order, Enter opens the inspector, and
  // Left/Right expand/collapse (or step to parent/child) in tree mode. All paths
  // reuse the existing select/open/expand handlers, so behavior matches the mouse.
  const handleTreeKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      const key = e.key;
      if (!['ArrowDown', 'ArrowUp', 'ArrowRight', 'ArrowLeft', 'Enter', 'Home', 'End'].includes(key)) return;
      const order = visibleOrderRef.current;
      if (order.length === 0) return;
      const cur = primaryPathRef.current;
      const idx = cur ? order.indexOf(cur) : -1;
      const selectAt = (i: number) => {
        const bounded = Math.max(0, Math.min(order.length - 1, i));
        const p = order[bounded];
        if (!p) return;
        if (flatFilteredRef.current) {
          flatVirtualizerRef.current.scrollToIndex(bounded, { align: 'center' });
        } else {
          const rowIndex = visibleRowsRef.current.findIndex((row) => row.node.path === p);
          if (rowIndex >= 0) treeVirtualizerRef.current.scrollToIndex(rowIndex, { align: 'center' });
        }
        setPendingKeyboardPath(p);
      };
      switch (key) {
        case 'ArrowDown': e.preventDefault(); selectAt(idx < 0 ? 0 : idx + 1); break;
        case 'ArrowUp': e.preventDefault(); selectAt(idx < 0 ? 0 : idx - 1); break;
        case 'Home': e.preventDefault(); selectAt(0); break;
        case 'End': e.preventDefault(); selectAt(order.length - 1); break;
        case 'Enter': e.preventDefault(); if (cur) handleDoubleClick(cur); break;
        case 'ArrowRight':
        case 'ArrowLeft': {
          e.preventDefault();
          // Flat mode (type filter) has no hierarchy — step like Up/Down.
          if (flatFilteredRef.current || !cur) { selectAt(key === 'ArrowRight' ? idx + 1 : idx - 1); break; }
          const found = findTreeNode(filteredTreeRef.current, cur);
          if (!found) break;
          const { node, parentPath } = found;
          const expandKey = node.path ?? node.name;
          const expandable = node.children.length > 0 || node.canExpandLazy === true;
          // During a search everything is force-expanded (searchExpanded), so
          // toggling the real expand set does nothing visible — just navigate.
          const searching = !!searchExpandedRef.current;
          const isExp = expandedRef.current.has(expandKey);
          if (key === 'ArrowRight') {
            if (expandable && !isExp && !searching) onToggleExpand(expandKey);
            else if (expandable) selectAt(idx + 1); // already open → first child
          } else if (expandable && isExp && !searching) {
            onToggleExpand(expandKey);
          } else if (parentPath) {
            selectAt(order.indexOf(parentPath));
          }
          break;
        }
      }
    },
    [handleSelect, handleDoubleClick, onToggleExpand, plugin],
  );

  // Keyboard navigation scrolls first. Selection (and therefore the ARIA
  // anchor) is committed only after the target row is mounted by the virtualizer.
  useEffect(() => {
    if (!pendingKeyboardPath || !mountedPaths.has(pendingKeyboardPath)) return;
    handleSelect(pendingKeyboardPath);
    setPendingKeyboardPath(null);
  }, [pendingKeyboardPath, mountedPaths, handleSelect]);

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

  // Clear hover + snap highlight when panel closes / unmounts
  useEffect(() => {
    return () => { viewer.highlighter.clear(); highlightSnap(null); };
  }, [viewer, highlightSnap]);

  const handleClose = useCallback(() => {
    viewer.highlighter.clear();
    highlightSnap(null);
    plugin.togglePanel();
  }, [plugin, viewer, highlightSnap]);

  // One-click escape from a dead-end result: reset search + type filter.
  const clearAllFilters = useCallback(() => {
    setSearchTerm('');
    setTypeFilter('all');
  }, [setTypeFilter]);

  const isFlat = flatFiltered !== null;
  const activeDescendant = selection.primaryPath && mountedPaths.has(selection.primaryPath)
    ? rowDomId(selection.primaryPath)
    : undefined;

  // A filter is "active" when it actually narrows the tree — drives the badge
  // dot on the header filter icon so a collapsed-but-filtering state is never
  // invisible to the user.
  const hasActiveFilters = searchTerm.length > 0 || typeFilter !== 'all';

  return (
    <LeftPanel
      title={
        // ONE row for the open document: the card's breadcrumb ends in the
        // document's own name, so a separate header title printing that name
        // again was the same fact twice. Without a card (viewer deploys) the
        // header falls back to the loaded model's name.
        showDocumentCard && hasDocumentView ? (
          <DocumentCard variant="compact" activeMode={activeMode} />
        ) : (
          <Typography
            variant="subtitle2"
            sx={{
              fontWeight: 600,
              fontSize: '0.8rem',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
            }}
            title={modelName}
          >
            {modelName}
          </Typography>
        )
      }
      onClose={handleClose}
      toolbar={
        <Tooltip title={filtersOpen ? 'Hide search & filter' : 'Search & filter'} disableInteractive>
          <IconButton
            size="small"
            onClick={toggleFilters}
            sx={{
              p: 0.25,
              flexShrink: 0,
              color: filtersOpen || hasActiveFilters ? 'primary.main' : 'text.secondary',
              bgcolor: filtersOpen ? 'rgba(79, 195, 247, 0.12)' : 'transparent',
              '&:hover': { bgcolor: filtersOpen ? 'rgba(79, 195, 247, 0.18)' : 'rgba(255, 255, 255, 0.08)' },
            }}
          >
            <Badge
              color="primary"
              variant="dot"
              invisible={!hasActiveFilters}
              sx={{ '& .MuiBadge-badge': { minWidth: 6, height: 6, top: 1, right: 1 } }}
            >
              <FilterList sx={{ fontSize: 16 }} />
            </Badge>
          </IconButton>
        </Tooltip>
      }
      width={state.panelWidth}
      resizable
      minWidth={HIERARCHY_MIN_WIDTH}
      maxWidth={HIERARCHY_MAX_WIDTH}
      onResize={(w) => plugin.setPanelWidth(w)}
      headerSx={{ px: 1.5, py: 1.25 }}
      footer={
        <Box sx={{ px: 1, py: 0.25, display: 'flex', alignItems: 'center' }}>
          <Typography sx={{ fontSize: 10, color: 'text.disabled' }}>
            {isFlat || treeVisibleCount !== null
              ? `${displayCount} of ${counts.total} node${counts.total !== 1 ? 's' : ''}`
              : `${counts.total} node${counts.total !== 1 ? 's' : ''}`}
            {counts.withOverrides > 0 && (
              <> &middot; {counts.withOverrides} with override{counts.withOverrides !== 1 ? 's' : ''}</>
            )}
            {isSearchPending && <> &middot; filtering&hellip;</>}
          </Typography>
        </Box>
      }
    >
      {/* Search + type filter — collapsed behind the header filter icon.
          Children stay mounted while collapsed so an active search/type filter
          keeps narrowing the tree (the badge dot on the icon signals this). */}
      <Collapse in={filtersOpen} timeout={150} sx={{ flexShrink: 0 }}>
        {/* Search */}
        <Box sx={{ px: 0.75, pt: 0.5, pb: 0.25 }}>
          <TextField
            size="small"
            fullWidth
            placeholder="Search nodes..."
            value={searchTerm}
            inputRef={searchInputRef}
            onChange={(e) => setSearchTerm(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                // Select the first match: flat list in a type filter, otherwise
                // the first node of the pruned tree in an "All" search.
                if (flatFiltered && flatFiltered.length > 0) handleSelect(flatFiltered[0].path);
                else if (firstTreeMatchPath) handleSelect(firstTreeMatchPath);
              }
              // Escape: clear the search first; a second Escape collapses the section.
              if (e.key === 'Escape') {
                if (searchTerm) setSearchTerm('');
                else setFiltersOpen(false);
              }
            }}
            slotProps={{
              input: {
                startAdornment: (
                  <InputAdornment position="start" sx={{ mr: 0.5 }}>
                    <Search sx={{ fontSize: 16, color: 'text.disabled' }} />
                  </InputAdornment>
                ),
                endAdornment: searchTerm ? (
                  <InputAdornment position="end">
                    <IconButton
                      size="small"
                      onClick={() => { setSearchTerm(''); searchInputRef.current?.focus(); }}
                      sx={{ p: 0.25, color: 'text.disabled' }}
                    >
                      <ClearIcon sx={{ fontSize: 13 }} />
                    </IconButton>
                  </InputAdornment>
                ) : undefined,
                sx: { fontSize: 12, height: 26, pl: 1.25 },
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
        <Box sx={{ display: 'flex', gap: 0.25, px: 0.75, pt: 0.25, pb: 0.5, borderBottom: '1px solid rgba(255, 255, 255, 0.05)' }}>
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
      </Collapse>

      {/* Signal sort buttons (only when Signals filter active) */}
      {typeFilter === 'signals' && (
        <SignalBrowser sort={signalSort} onSortChange={setSignalSort} />
      )}

      {/* Tree / Flat list — own scroll container for useVirtualizer compatibility.
          Also the ARIA tree: it holds focus and tracks the active row via
          aria-activedescendant; handleTreeKeyDown drives arrow navigation. */}
      <Box
        ref={scrollContainerRef}
        className={RV_SCROLL_CLASS}
        role="tree"
        aria-label="Scene hierarchy"
        aria-multiselectable
        tabIndex={0}
        aria-activedescendant={activeDescendant}
        onKeyDown={handleTreeKeyDown}
        // Clicking a row selects it but doesn't focus this div (rows aren't
        // focusable), so focus it on pointer-down to keep keyboard nav working
        // right after a mouse click. preventScroll: don't jump the list.
        onMouseDown={() => scrollContainerRef.current?.focus({ preventScroll: true })}
        sx={{
          flex: 1,
          overflow: 'auto',
          py: 0.5,
          '&:focus-visible': { outline: '1px solid rgba(79,195,247,0.5)', outlineOffset: '-1px' },
        }}
      >
        {isFlat ? (
          // Virtualized flat list (type filter active — no tree hierarchy)
          flatFiltered.length > 0 ? (
            <div role="presentation" style={{ height: flatRowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
              {flatVirtualItems.map((virtualRow) => {
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
                    viewer={viewer}
                    getNodeVisible={canToggleVisibility ? getNodeVisible : undefined}
                    getEffectiveVisible={getEffectiveVisible}
                    onToggleVisible={canToggleVisibility ? onToggleVisible : undefined}
                    depth={typeFilter === 'logic' ? (flatDepths.get(info.path) ?? 0) : 0}
                    rowHeight={rowHeight}
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
            <NoMatchState onClear={clearAllFilters} />
          )
        ) : (
          // Tree view (All filter)
          visibleRows.length > 0 ? (
            <div role="presentation" style={{ height: treeRowVirtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
              {treeVirtualItems.map((virtualRow) => {
                const row = visibleRows[virtualRow.index];
                return (
                  <TreeNodeRow
                    key={row.rowKey}
                    row={row}
                    selectedPaths={selectedPathsSet}
                    expanded={renderExpanded}
                    onToggleExpand={onToggleExpand}
                    onSelect={handleSelect}
                    onDoubleClick={handleDoubleClick}
                    onHover={handleHover}
                    onContextMenu={handleContextMenu}
                    signalStore={signalStore}
                    logicEngine={logicEngine}
                    viewer={viewer}
                    rowHeight={rowHeight}
                    virtualStyle={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      height: virtualRow.size,
                      transform: `translateY(${virtualRow.start}px)`,
                    }}
                    getNodeVisible={canToggleVisibility ? getNodeVisible : undefined}
                    getEffectiveVisible={getEffectiveVisible}
                    onToggleVisible={canToggleVisibility ? onToggleVisible : undefined}
                    dndEnabled={dndEnabled}
                    dropZone={dropTarget && dropTarget.path === row.node.path ? dropTarget.zone : null}
                    onRowDragStart={handleRowDragStart}
                    onRowDragOver={handleRowDragOver}
                    onRowDrop={handleRowDrop}
                    onRowDragEnd={clearDrag}
                  />
                );
              })}
            </div>
          ) : isSearchPending ? (
            <Typography sx={{ fontSize: 12, color: 'text.disabled', textAlign: 'center', py: 4 }}>
              Filtering&hellip;
            </Typography>
          ) : state.editableNodes.length === 0 ? (
            <Typography sx={{ fontSize: 12, color: 'text.disabled', textAlign: 'center', py: 4 }}>
              No model loaded
            </Typography>
          ) : (
            <NoMatchState onClear={hasActiveFilters ? clearAllFilters : undefined} />
          )
        )}
      </Box>
    </LeftPanel>
  );
}
