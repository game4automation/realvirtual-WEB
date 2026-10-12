// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * HierarchyBrowser — the scene graph, as a tree.
 *
 * Since plan-754 this panel renders `viewer.scene` itself: every `Object3D` is
 * a row, `children` is the whole truth, and the registry only decides whether a
 * row carries a PATH (and therefore the document's verbs) or is flagged
 * `runtime` (D1/D2). The path-string projection it used to rebuild — structure
 * tree, lazy injection, composition view, geometry fallback — is gone.
 *
 * Features:
 * - Search filter (name, path, component search text) over the graph
 * - Category filter chips with live counts (plan-597): one split chip per
 *   category present in the model, its ▾ menu narrows to one type label
 * - Component type badges with live signal values, plus `runtime` / `chunk`
 * - "Show runtime objects" icon toggle right of the search field (runtime hidden by default)
 * - "Show baked geometry" icon toggle (plan-505): chunk meshes fold behind one
 *   "Geometry · N chunks" row per boundary and are hidden by default; a
 *   selected chunk is revealed anyway (dimmed)
 * - LogicStep status dots with ISA-101 colors and pulse animation
 * - Click to select (selection identity is the object, not the path)
 * - Resizable width (drag right edge)
 * - Node count footer
 * - Reveal-and-scroll: external code can call plugin.selectAndReveal(path)
 *   to expand ancestor rows and scroll the selected node into view
 *
 * Composition (plan-177 Phase 5):
 * - Row adapter + scene walks live in `hierarchy-rows.ts`
 * - Generic row vocabulary lives in `hierarchy-utils.ts`
 * - Row components live in `HierarchyNodeRow.tsx`
 * - Badge primitives live in `hierarchy-badge-components.tsx`
 * - Signals sort toolbar lives in `SignalBrowser.tsx`
 */

import { useState, useMemo, useCallback, useRef, useEffect, useSyncExternalStore, useDeferredValue } from 'react';
import { useEditorPlugin } from '../../hooks/use-editor-plugin';
import { useSelection } from '../../hooks/use-selection';
import {
  Box,
  Typography,
  TextField,
  InputAdornment,
  IconButton,
  Collapse,
  Badge,
  Tooltip,
  Button,
} from '@mui/material';
import { Search, FilterList, Close as ClearIcon, BlurOn, ViewInAr } from '@mui/icons-material';
import { ACCENT_BORDER, ACCENT_TINT, ACCENT_TINT_HOVER, CHIP_HOVER, DIVIDER, ICON_SIZE, RV_SCROLL_CLASS } from './shared-sx';
import type { RVViewer } from '../rv-viewer';
import type { SnapPointPlugin } from '../../plugins/snap-point';
import type { ContextMenuTarget } from './context-menu-store';
import { HIERARCHY_MIN_WIDTH, HIERARCHY_MAX_WIDTH, type RvExtrasEditorPlugin } from './rv-extras-editor';
import { LeftPanel } from './LeftPanel';
import { getSceneStore } from './scene/scene-store-singleton';
import { requestDescend } from '../editor/rv-descend-request';
import { isInsideReference } from '../engine/rv-reference-scope';
import { isModelRoot } from '../engine/rv-model-root';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  computeAncestors,
  flattenVisibleTree,
  isLogicFilter,
  isSignalsFilter,
  migrateLegacyFilter,
  sortSignalNodes,
  type HierarchyFilterId,
  type SignalSort,
  type TreeNode,
} from './hierarchy-utils';
import {
  buildSceneSearchTree,
  collectTypeCounts,
  collectTypeRows,
  flattenSceneRows,
  isChunkMesh,
  matchesSearchTerm,
  mergedBoundaryName,
  revealExpandKeysFor,
  searchExpandKeys,
  structuralListenTargets,
  subscribeStructure,
  subtreeHasDrawable,
  watchHierarchyFilterValidation,
  type SceneRowContext,
  type SceneTreeNode,
} from './hierarchy-rows';
import { HierarchyCategoryChips } from './HierarchyCategoryChips';
import { FlatNodeRow, TreeNodeRow, rowDomId, type SelectMods, type DropZone } from './HierarchyNodeRow';
import { usePointerRowHeight } from '../../hooks/use-pointer-row-height';
import { getActiveEditTarget, subscribeEditTarget, getEditTargetVersion } from './rv-edit-target';
import { getActiveAssetContext, subscribeActiveAsset, getActiveAssetVersion, isAssetDocumentBusy } from '../editor/active-asset-store';
import { NodeRegistry } from '../engine/rv-node-registry';
import { tooltipRegistry } from './tooltip/tooltip-registry';
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
export type { TreeNode, HierarchyFilterId, SignalSort } from './hierarchy-utils';

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

// ─── Hierarchy panel state persistence ───────────────────────────────────

const LS_KEY_TREE_EXPANDED = 'rv-hierarchy-expanded';
// Renamed from `rv-hierarchy-hide-runtime` when the default flipped to hidden:
// the old key stored `false` for everyone who never touched it, so reusing it
// would have kept the runtime rows on for exactly those users.
const LS_KEY_SHOW_RUNTIME = 'rv-hierarchy-show-runtime';
/** plan-505: "Show baked geometry" — stored as SHOW (default absent = hidden),
 *  the same polarity as {@link LS_KEY_SHOW_RUNTIME}. */
export const LS_KEY_SHOW_BAKED = 'rv-hierarchy-show-baked';

/** Is baked geometry hidden? True unless the user switched it on. */
export function loadHideBaked(): boolean {
  try { return localStorage.getItem(LS_KEY_SHOW_BAKED) !== 'true'; } catch { return true; }
}

/** Persist the baked-geometry toggle (stored as its SHOW state). */
export function persistHideBaked(hide: boolean): void {
  try { localStorage.setItem(LS_KEY_SHOW_BAKED, String(!hide)); } catch { /* */ }
}

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

/** Component search text (AAS description, Metadata, …) — the extra input of
 *  the shared search predicate, module-level so memos need not depend on it. */
const searchableText = (obj: Object3D): readonly string[] => tooltipRegistry.getSearchableText(obj);

/** The scene object behind a row, or null for a synthetic group row. */
function objectOf(node: TreeNode): Object3D | null {
  return (node as Partial<SceneTreeNode>).object ?? null;
}

// ─── Main component ──────────────────────────────────────────────────────

export interface HierarchyBrowserProps {
  viewer: RVViewer;
}

/**
 * Gate on the editor plugin BEFORE any of the panel's hooks run. The plugin is
 * looked up, not subscribed to (`viewer.getPlugin`), so it can be absent on
 * one render and present on the next — e.g. right after a mode switch or a
 * model load. An early `return null` in the middle of the panel's hook list
 * then changes the hook count between renders, React throws #310 and the
 * whole HMI overlay goes down with it while the 3D scene keeps running.
 * Splitting the gate from the body keeps every render of the body on the
 * same hook order.
 */
export function HierarchyBrowser({ viewer }: HierarchyBrowserProps) {
  const { plugin } = useEditorPlugin();
  if (!plugin) return null;
  return <HierarchyBrowserPanel viewer={viewer} plugin={plugin} />;
}

function HierarchyBrowserPanel({ viewer, plugin }: HierarchyBrowserProps & { plugin: RvExtrasEditorPlugin }) {
  const { state } = useEditorPlugin();
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

  // Multi-select aware: Set for O(1) identity lookups in the row map.
  const selectedObjects = useMemo(
    () => new Set<Object3D>(selection.nodes),
    [selection.nodes],
  );

  const [searchTerm, setSearchTerm] = useState('');
  const deferredTerm = useDeferredValue(searchTerm);
  const isSearchPending = searchTerm !== deferredTerm;
  // Category filter (plan-597): `all`, `cat:<id>` or `cat:<id>/<label>`. The
  // persisted value is migrated (pre-597 `drives`/… ids) and validated against
  // the known categories here; whether it has hits in the MODEL is checked after
  // each load (validation effect below).
  const [typeFilter, setTypeFilterRaw] = useState<HierarchyFilterId>(() => {
    try { return migrateLegacyFilter(localStorage.getItem('rv-hierarchy-type-filter')); } catch { return 'all'; }
  });
  const signalsView = isSignalsFilter(typeFilter);
  const setTypeFilter = useCallback((v: HierarchyFilterId) => {
    setTypeFilterRaw(v);
    try { localStorage.setItem('rv-hierarchy-type-filter', v); } catch { /* */ }
  }, []);
  /**
   * Hide what the document does not own (plan-754 D2).
   *
   * ON by default: lights, helpers and gizmos are noise for anyone working on
   * the document. Nothing becomes unreachable — chunk meshes are never runtime,
   * a search ignores the toggle, and the footer says how many rows it hides.
   */
  const [hideRuntime, setHideRuntimeRaw] = useState<boolean>(() => {
    try { return localStorage.getItem(LS_KEY_SHOW_RUNTIME) !== 'true'; } catch { return true; }
  });
  const toggleHideRuntime = useCallback(() => {
    setHideRuntimeRaw((prev) => {
      const next = !prev;
      try { localStorage.setItem(LS_KEY_SHOW_RUNTIME, String(!next)); } catch { /* */ }
      return next;
    });
  }, []);
  /**
   * Hide baked chunk meshes (plan-505 F5).
   *
   * ON by default: the merged triangles of a boundary are noise for an end
   * user. Nothing becomes unreachable — a search ignores the toggle, a
   * selected chunk is revealed anyway (F6), and the footer says how many
   * chunks it hides.
   */
  const [hideBaked, setHideBakedRaw] = useState<boolean>(() => loadHideBaked());
  const toggleHideBaked = useCallback(() => {
    setHideBakedRaw((prev) => {
      const next = !prev;
      persistHideBaked(next);
      return next;
    });
  }, []);
  // Chunks that must stay visible while the toggle hides them: the selected
  // ones. Keyed on their uuids so a selection change that does not touch a
  // chunk does not rebuild the row context (and re-walk the counts).
  const revealChunkKey = hideBaked
    ? selection.nodes.filter(isChunkMesh).map((n) => n.uuid).join('|')
    : '';
  const revealObjects = useMemo<ReadonlySet<Object3D>>(
    () => new Set(hideBaked ? selection.nodes.filter(isChunkMesh) : []),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [revealChunkKey],
  );
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
  const [pendingKeyboardKey, setPendingKeyboardKey] = useState<string | null>(null);

  const onToggleExpand = useCallback((key: string) => {
    setExpanded(prev => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key); else next.add(key);
      persistTreeExpandedSet(next);
      return next;
    });
  }, []);

  // ── Structural change (R8) ──
  // One tick for "the graph changed": the editor plugin's own structureVersion
  // (model load, editor op, placement) plus the three.js `childadded` /
  // `childremoved` events the effect below subscribes to. Coalesced to at most
  // one re-flatten per animation frame, which is what keeps hover overlays —
  // added and removed under an expanded row EVERY frame — from re-rendering the
  // list sixty times a second.
  const [mutationTick, setMutationTick] = useState(0);
  const mutationFrameRef = useRef(0);
  const bumpMutation = useCallback(() => {
    if (mutationFrameRef.current) return;
    mutationFrameRef.current = requestAnimationFrame(() => {
      mutationFrameRef.current = 0;
      setMutationTick((t) => t + 1);
    });
  }, []);
  useEffect(() => () => {
    if (mutationFrameRef.current) cancelAnimationFrame(mutationFrameRef.current);
  }, []);

  // Viewer-level structural events. `editor-structure-changed` already arrives
  // through the plugin's `structureVersion`, so it is deliberately not here.
  useEffect(() => {
    const unsubs = [
      viewer.on('model-loaded', bumpMutation),
      viewer.on('model-cleared', bumpMutation),
      viewer.on('placements-materialized', bumpMutation),
    ];
    return () => { for (const u of unsubs) u(); };
  }, [viewer, bumpMutation]);

  const structureTick = `${state.structureVersion}:${mutationTick}`;

  /**
   * The subtree the panel renders. `viewer.scene` by default — the literal
   * graph, floor and lights included (D1) — or the preview subtree an active
   * hierarchy root override points at (plan-301 "Runtime view").
   */
  const rootObject = plugin.hierarchyRootOverride ?? viewer.scene;

  /**
   * The model root, for the label + lock (plan-715 §2.4.2).
   *
   * Two cases deliberately answer null:
   * - no model loaded — there is no root row and nothing to label;
   * - an active hierarchy root override pointed at something OTHER than the
   *   model root, so the tree on screen is not the document and must not be
   *   dressed up as it.
   *
   * The label follows the DOCUMENT (plan-709), not `Object3D.name`: renaming the
   * root would rewrite the first segment of every node path (doc-node-paths.md).
   * Fallback chain: document name → GLB file name without extension → the node's
   * own name.
   */
  const modelRootInfo = useMemo(() => {
    const root = viewer.currentModelRoot;
    if (!root) return null;
    const override = plugin.hierarchyRootOverride;
    if (override && override !== root) return null;
    const fileName = viewer.currentModelUrl?.split('/').pop()?.replace(/\.[^.]+$/, '') ?? '';
    return { root, label: sceneSnap?.draft?.name || fileName || root.name };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewer, plugin, sceneSnap?.draft?.name, structureTick]);

  /**
   * Everything the row adapter reads. One object, so a row is a Map lookup.
   *
   * Keyed on the plugin SNAPSHOT, not on `state.overlay`: the plugin mutates
   * its overlay object in place (`updateOverlayField` writes into it and then
   * notifies), so the overlay reference never changes and a memo on it would
   * miss every override edit — the lock glyph and the override badge would
   * only refresh on the next selection change. The snapshot is a new object
   * per notify, and a re-flatten costs only the rows on screen.
   */
  const rowCtx = useMemo<SceneRowContext>(() => ({
    getPathForNode: (node: Object3D) => viewer.registry?.getPathForNode(node) ?? null,
    overlay: state.overlay,
    modelRoot: modelRootInfo?.root ?? null,
    modelRootLabel: modelRootInfo?.label ?? null,
    hideRuntime,
    hideBaked,
    revealObjects,
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), [viewer, state, modelRootInfo, hideRuntime, hideBaked, revealObjects]);

  // ── Rows ──
  // A search prunes the graph to matching branches and force-opens them, so a
  // hit never hides under a collapsed ancestor; otherwise the user's own expand
  // state decides, and only expanded branches are walked at all.
  const searchTree = useMemo(
    () => (typeFilter === 'all' && deferredTerm)
      ? buildSceneSearchTree(rootObject, deferredTerm, rowCtx, searchableText)
      : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [typeFilter, deferredTerm, rootObject, rowCtx, structureTick],
  );

  const visibleRows = useMemo(() => {
    if (typeFilter !== 'all') return [];
    if (searchTree) return flattenVisibleTree(searchTree, searchExpandKeys(searchTree));
    return flattenSceneRows(rootObject, expanded, rowCtx);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [typeFilter, searchTree, rootObject, expanded, rowCtx, structureTick]);

  // Flat list ONLY when a type filter is active (Drives/Sensors/Signals/Logic).
  // A plain "All" search stays in TREE mode. Both match with the ONE predicate
  // `matchesSearchTerm` (name + label + full path + component metadata), so the
  // "3/21" chip counts are exactly the rows a click on the chip shows
  // (plan-597 Phase 6b; the flat list used to match path only).
  const flatFiltered = useMemo(() => {
    if (typeFilter === 'all') return null;
    let rows = collectTypeRows(rootObject, typeFilter, rowCtx);
    if (deferredTerm) {
      const lower = deferredTerm.toLowerCase();
      rows = rows.filter(r => matchesSearchTerm(r.object, r.path, lower, rowCtx, searchableText));
    }
    if (signalsView) rows = sortSignalNodes(rows, signalSort);
    return rows;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rootObject, rowCtx, typeFilter, signalsView, deferredTerm, signalSort, structureTick]);

  // Compute relative depth for flat filtered nodes (for indentation in Logic view)
  const flatDepths = useMemo(() => {
    if (!flatFiltered || flatFiltered.length === 0) return new Map<string, number>();
    const depths = new Map<string, number>();
    const segs = (r: SceneTreeNode) => (r.path ? r.path.split('/').length : 1);
    const minSegments = Math.min(...flatFiltered.map(segs));
    for (const r of flatFiltered) depths.set(r.object.uuid, segs(r) - minSegments);
    return depths;
  }, [flatFiltered]);

  /** Row counts per category / label + the footer total. One scene walk per change. */
  const counts = useMemo(
    () => collectTypeCounts(rootObject, rowCtx),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [rootObject, rowCtx, structureTick],
  );
  /** The same counts restricted to the search hits — the "3" of the chips'
   *  "3/21" (plan-597 Phase 6b). One extra walk, ONLY while a term is active;
   *  memoised on term + structure like the counts above. */
  const matchCounts = useMemo(
    () => (deferredTerm ? collectTypeCounts(rootObject, rowCtx, { term: deferredTerm, searchText: searchableText }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deferredTerm, rootObject, rowCtx, structureTick],
  );

  // ── Filter validation after a model load (plan-597 §2.3) ──
  // A persisted filter on a category the freshly loaded model does not have
  // falls back to All — ONCE per load, counted fresh after whenSceneReady(),
  // never while an asset document is active or still opening (draft replay),
  // never on an in-session edit. Read through refs so the subscription is made
  // once per viewer, not per render.
  const validationRef = useRef({ rootObject, rowCtx, typeFilter });
  validationRef.current = { rootObject, rowCtx, typeFilter };
  useEffect(() => watchHierarchyFilterValidation({
    viewer,
    getRoot: () => validationRef.current.rootObject,
    getCtx: () => validationRef.current.rowCtx,
    getFilter: () => validationRef.current.typeFilter,
    onInvalid: () => setTypeFilter('all'),
    isAssetBusy: isAssetDocumentBusy,
  }), [viewer, setTypeFilter]);

  // ── Live structural subscription (plan-754 §2.7) ──
  // Three.js dispatches `childadded`/`childremoved` on the DIRECT parent and
  // does not bubble, so the listeners go on the objects that are ON SCREEN —
  // the subscription count follows the UI state, never the graph size.
  useEffect(() => {
    if (visibleRows.length === 0) return;
    return subscribeStructure(structuralListenTargets(visibleRows), bumpMutation);
  }, [visibleRows, bumpMutation]);

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

  // ── Consume revealPath: expand ancestors and scroll to selected ──
  useEffect(() => {
    const requestedPath = state.revealPath;
    if (!requestedPath) return;

    // Expansion keys are OBJECT uuids now, so the ancestor chain is walked on
    // the graph. A path that no longer resolves falls back to the legacy path
    // keys — harmless, and it keeps a reveal issued before registration working.
    const target = viewer.registry?.getNode(requestedPath) ?? null;
    const ancestors: string[] = [];
    if (target) {
      for (let a: Object3D | null = target.parent; a; a = a.parent) {
        ancestors.unshift(a.uuid);
        if (a === rootObject) break;
      }
    } else {
      ancestors.push(...computeAncestors(requestedPath));
    }

    if (state.revealCollapseOthers) {
      // Exclusive reveal: the revealed node's ancestor chain becomes the ONLY
      // expanded set — every other branch collapses.
      setExpanded(() => {
        const next = new Set(ancestors);
        persistTreeExpandedSet(next);
        return next;
      });
    } else if (ancestors.length > 0) {
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

    // Scroll the revealed row into view. `center` keeps it around the middle of
    // the viewport instead of nudging it to the nearest edge.
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (flatFiltered) {
          const idx = flatFiltered.findIndex(r => r.path === requestedPath);
          if (idx >= 0) flatVirtualizerRef.current.scrollToIndex(idx, { align: 'center' });
        } else {
          const idx = visibleRowsRef.current.findIndex((row) => row.node.path === requestedPath);
          if (idx >= 0) treeVirtualizerRef.current.scrollToIndex(idx, { align: 'center' });
        }
      }, 150);
    });
  }, [state.revealPath, state.revealCollapseOthers, plugin, viewer, rootObject, flatFiltered]);

  // ── Consume revealObject: the same, for a node WITHOUT a path (plan-505) ──
  // A chunk mesh picked in 3D or via MCP has no path to reveal by. Walk its
  // parent chain by uuid (the same expand keys the path branch derives) and
  // open the chunk's fold row; `revealObjects` keeps the row itself visible
  // while the baked toggle is off.
  useEffect(() => {
    const target = state.revealObject;
    if (!target) return;
    const keys = revealExpandKeysFor(target, rootObject);
    if (keys.length > 0) {
      setExpanded((prev) => {
        let next: Set<string> | null = null;
        for (const k of keys) {
          if (!prev.has(k)) { (next ??= new Set(prev)).add(k); }
        }
        if (!next) return prev;
        persistTreeExpandedSet(next);
        return next;
      });
    }
    plugin.clearReveal();
    requestAnimationFrame(() => {
      setTimeout(() => {
        if (flatFiltered) {
          const idx = flatFiltered.findIndex((r) => r.object === target);
          if (idx >= 0) flatVirtualizerRef.current.scrollToIndex(idx, { align: 'center' });
        } else {
          const idx = visibleRowsRef.current.findIndex((row) => row.rowKey === target.uuid);
          if (idx >= 0) treeVirtualizerRef.current.scrollToIndex(idx, { align: 'center' });
        }
      }, 150);
    });
  }, [state.revealObject, plugin, rootObject, flatFiltered]);

  // ── Keep the focused node visible across hierarchy view changes ──
  // Toggling the type filter rebuilds the view; the selected node's ancestors
  // may be collapsed or the node may fall outside the viewport. Re-reveal the
  // current selection. primaryPath is read via ref so this fires only on filter
  // changes (and mount), not on every selection change.
  const primaryPathRef = useRef(selection.primaryPath);
  primaryPathRef.current = selection.primaryPath;
  useEffect(() => {
    const p = primaryPathRef.current;
    if (p) plugin.requestReveal(p);
  }, [typeFilter, plugin]);

  // Same for the baked-geometry toggle (plan-505): switching it rebuilds the
  // tree around a possibly selected chunk, which has no path — reveal it by
  // object then. Skipped on mount (the typeFilter effect above covers that).
  const primaryNodeRef = useRef(selection.primaryNode);
  primaryNodeRef.current = selection.primaryNode;
  const hideBakedMountedRef = useRef(false);
  useEffect(() => {
    if (!hideBakedMountedRef.current) { hideBakedMountedRef.current = true; return; }
    const p = primaryPathRef.current;
    if (p) plugin.requestReveal(p);
    else if (primaryNodeRef.current) plugin.requestRevealObject(primaryNodeRef.current);
  }, [hideBaked, plugin]);

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
   * The document row starts EXPANDED, and so does the scene root above it — a
   * hierarchy whose only visible row is a collapsed root would be a worse tree
   * than the one before plan-715.
   *
   * Applied once per root object rather than on every render: the expand set is
   * localStorage-persisted, so re-asserting it would override a user who
   * deliberately collapsed the root.
   */
  const defaultedRootsRef = useRef<Set<string>>(new Set());
  useEffect(() => {
    const keys = [rootObject.uuid, modelRootInfo?.root.uuid].filter((k): k is string => !!k);
    const fresh = keys.filter((k) => !defaultedRootsRef.current.has(k));
    if (fresh.length === 0) return;
    for (const k of fresh) defaultedRootsRef.current.add(k);
    setExpanded((prev) => {
      if (fresh.every((k) => prev.has(k))) return prev;
      const next = new Set(prev);
      for (const k of fresh) next.add(k);
      persistTreeExpandedSet(next);
      return next;
    });
  }, [rootObject, modelRootInfo]);

  // ── Editor eye toggles (asset editor only) ──
  // The EditTarget installs asynchronously after mode activation — subscribe
  // so the eyes appear/disappear with it.
  useSyncExternalStore(subscribeEditTarget, getEditTargetVersion);
  const canToggleVisibility = !!getActiveEditTarget().setNodeVisible;

  const getNodeVisible = useCallback(
    (node: TreeNode) => objectOf(node)?.visible ?? true,
    [],
  );

  /**
   * Why this row's eye does nothing (plan-754 D8).
   *
   * A node whose triangles were merged into an ancestor's chunk owns no
   * drawable of its own, so `.visible = false` on it hides nothing. Memoised
   * per object on the bake revision — the draw state only changes when the bake
   * does.
   */
  const bakeRevision = viewer.bakeRegistry?.revision ?? 0;
  const eyeDisabledReason = useCallback((node: TreeNode): string | null => {
    const object = objectOf(node);
    if (!object) return null;
    if (subtreeHasDrawable(object, bakeRevision)) return null;
    const boundary = mergedBoundaryName(object);
    return boundary
      ? `Merged into ${boundary} — cannot be hidden separately`
      : 'Nothing is drawn here — cannot be hidden separately';
  }, [bakeRevision]);

  /**
   * Should this row be dimmed? Two reasons, ONE styling (plan-703 §2.4.2).
   *
   * 1. Hidden — the node or an ancestor has `visible === false` (the eye).
   * 2. Inside a reference — the node's structure lives in another file, so the
   *    structural verbs do not reach it (F8). Its VALUES stay editable; the
   *    dimming says "locked shape", not "read-only".
   *
   * Deliberately not two opacities, two colours or an icon: `2.4.2` says a
   * second predicate, not a second visual.
   */
  const getEffectiveVisible = useCallback((node: TreeNode) => {
    const object = objectOf(node);
    if (!object) return true;
    for (let cur: Object3D | null = object; cur && cur !== viewer.scene; cur = cur.parent) {
      if (!cur.visible) return false;
    }
    // Inclusive: the reference row itself dims too, exactly as §3.3 draws it.
    return !isInsideReference(object, viewer.currentModelRoot);
  }, [viewer]);

  const onToggleVisible = useCallback((node: TreeNode) => {
    const object = objectOf(node);
    if (!object || !node.path) return;
    if (isModelRoot(object, viewer.currentModelRoot)) return; // asset root stays visible
    getActiveEditTarget().setNodeVisible?.(node.path, !object.visible);
  }, [viewer]);

  /** Unlock a locked placement from its row glyph — the same overlay field the
   *  context menu's Lock/Unlock writes, so undo and the op log see one thing. */
  const onUnlock = useCallback((node: TreeNode) => {
    if (!node.path) return;
    plugin.updateOverlayField(node.path, 'LayoutObject', 'Locked', false);
  }, [plugin]);

  // ── Drag & drop reorder / reparent (asset editor only) ──
  // Unity-style: drag a row and drop it BETWEEN two rows to reorder it as a
  // sibling, or ONTO a row to reparent it as that node's child (world transform
  // preserved). Enabled only in the plain tree view (no type filter / search,
  // where sibling order and indices are unambiguous) while an asset document is
  // active, and only for rows the document owns.
  useSyncExternalStore(subscribeActiveAsset, getActiveAssetVersion);
  const dndEnabled = typeFilter === 'all' && !deferredTerm && !!getActiveAssetContext();

  const dragPathsRef = useRef<string[]>([]);
  const [dropTarget, setDropTarget] = useState<{ key: string; zone: DropZone } | null>(null);
  const dropTargetRef = useRef<{ key: string; zone: DropZone } | null>(null);
  const autoExpandRef = useRef<{ key: string; timer: ReturnType<typeof setTimeout> } | null>(null);

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
    (targetNode: TreeNode, zone: DropZone): { parentPath: string | null; index?: number } | null => {
      const registry = viewer.registry;
      const dragged = dragPathsRef.current;
      const targetObject = objectOf(targetNode);
      if (!registry || dragged.length === 0 || !targetObject || !targetNode.path) return null;
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
        if (insideDragged(targetObject)) return null;
        // Dropping ONTO the model root stays legal (it is the asset's own parent
        // slot), but `reparentNodes` addresses that slot as `null` — the same
        // convention the reorder branch below uses. Passing the root's PATH here
        // would look equivalent and is not: it re-resolves through the registry
        // and diverges the moment the root name is deduped.
        if (isModelRoot(targetObject, viewer.currentModelRoot)) return { parentPath: null };
        return { parentPath: targetNode.path }; // target becomes the new parent (append)
      }

      const parent = targetObject.parent;
      if (!parent || insideDragged(parent)) return null;
      const childIndex = parent.children.indexOf(targetObject);
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

  const handleRowDragOver = useCallback((node: TreeNode, zone: DropZone, e: React.DragEvent) => {
    const object = objectOf(node);
    const res = object ? resolveDrop(node, zone) : null;
    if (!res || !object) {
      // Illegal target — no preventDefault so the browser shows a no-drop cursor.
      if (dropTargetRef.current) { dropTargetRef.current = null; setDropTarget(null); }
      clearAutoExpand();
      return;
    }
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const key = object.uuid;
    const cur = dropTargetRef.current;
    if (cur?.key !== key || cur.zone !== zone) {
      dropTargetRef.current = { key, zone };
      setDropTarget({ key, zone });
      clearAutoExpand();
      // Hovering ONTO a collapsed node briefly springs it open so you can drop
      // into deep trees (Unity spring-loaded folders).
      if (zone === 'onto' && !expanded.has(key) && object.children.length > 0) {
        autoExpandRef.current = { key, timer: setTimeout(() => onToggleExpand(key), 600) };
      }
    }
  }, [resolveDrop, clearAutoExpand, expanded, onToggleExpand]);

  const handleRowDrop = useCallback((node: TreeNode, zone: DropZone, e: React.DragEvent) => {
    e.preventDefault();
    const res = resolveDrop(node, zone);
    const paths = dragPathsRef.current.slice();
    clearDrag();
    if (!res || paths.length === 0) return;
    const ctx = getActiveAssetContext();
    if (!ctx) return;
    void ctx.doc.reparentNodes(paths, res.parentPath, res.index !== undefined ? { index: res.index } : undefined);
  }, [resolveDrop, clearDrag]);

  const displayCount = flatFiltered !== null ? flatFiltered.length : visibleRows.length;

  // ── Hover highlight (orange, temporary) ──
  // Selection highlight (cyan, persistent) is handled by SelectionManager.
  // Debounced to avoid blocking the UI when scrolling over many hierarchy rows.

  const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ── Snap 3D-highlight (A5) ──
  // A snap Empty has no mesh, so the outline highlighter shows nothing. When a
  // hierarchy row is a snap node, drive the snap-point plugin's marker highlight
  // instead (hover = temporary, select = persistent). The snap id is the node's
  // Object3D.uuid (== SnapPoint.id).
  const snapIdForObject = useCallback((object: Object3D | null): string | null => {
    if (!object) return null;
    const reg = viewer.getPlugin<SnapPointPlugin>('snap-point')?.getRegistry();
    return reg?.getById(object.uuid) ? object.uuid : null;
  }, [viewer]);

  const highlightSnap = useCallback((snapId: string | null) => {
    viewer.getPlugin<SnapPointPlugin>('snap-point')?.highlightSnap(snapId);
  }, [viewer]);

  const handleHover = useCallback((node: TreeNode | null) => {
    if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
    const object = node ? objectOf(node) : null;
    if (!object) { viewer.highlighter.clear(); highlightSnap(null); return; }
    hoverTimerRef.current = setTimeout(() => {
      hoverTimerRef.current = null;
      // Hover shows the plain hover highlight only - no attention pulse. The
      // blinking glow hull on top of it read as a second, competing overlay.
      viewer.highlighter.highlight(object, true, { includeChildDrives: false });
      // Snap node → also show the 3D marker highlight (temporary hover).
      highlightSnap(snapIdForObject(object));
    }, 80);
  }, [viewer, highlightSnap, snapIdForObject]);

  // Refs so handleSelect stays referentially stable (memoized rows) while the
  // Shift-range still reads the CURRENT visible row order.
  const anchorRef = useRef<Object3D | null>(null);
  const flatFilteredRef = useRef(flatFiltered);
  flatFilteredRef.current = flatFiltered;

  // The flat, render-order list of visible objects — the ground truth for
  // Shift-range and keyboard Arrow navigation (flat list in a type filter, else
  // the expanded tree). Kept in a ref so the handlers stay referentially stable.
  const visibleOrder = useMemo(
    () => flatFiltered
      ? flatFiltered.map((r) => r.object)
      : visibleRows.flatMap((row) => { const o = objectOf(row.node); return o ? [o] : []; }),
    [flatFiltered, visibleRows],
  );
  const visibleOrderRef = useRef(visibleOrder);
  visibleOrderRef.current = visibleOrder;

  const flatVirtualItems = flatRowVirtualizer.getVirtualItems();
  const treeVirtualItems = treeRowVirtualizer.getVirtualItems();
  const mountedKeys = new Set<string>();
  if (flatFiltered) {
    for (const item of flatVirtualItems) {
      const key = flatFiltered[item.index]?.object.uuid;
      if (key) mountedKeys.add(key);
    }
  } else {
    for (const item of treeVirtualItems) {
      const key = visibleRows[item.index]?.rowKey;
      if (key) mountedKeys.add(key);
    }
  }

  const handleSelect = useCallback(
    (node: TreeNode, mods?: SelectMods) => {
      const object = objectOf(node);
      if (!object) return;
      const sm = viewer.selectionManager;
      if (mods?.toggle) {
        // Ctrl/Cmd+click — toggle this node in/out of the selection.
        sm.toggleNode(object);
        anchorRef.current = object;
      } else if (mods?.shift && anchorRef.current && anchorRef.current !== object) {
        // Shift+click — contiguous range over the currently visible rows,
        // anchored at the last plain/toggle click. Missing indices (anchor
        // removed / filtered away) fall back to a plain select.
        const order = visibleOrderRef.current;
        const a = order.indexOf(anchorRef.current);
        const b = order.indexOf(object);
        if (a >= 0 && b >= 0) {
          sm.selectNodes(order.slice(Math.min(a, b), Math.max(a, b) + 1));
          // Anchor stays — repeated shift-clicks re-range from the same anchor.
        } else {
          sm.selectNode(object);
          anchorRef.current = object;
        }
      } else {
        sm.selectNode(object);
        anchorRef.current = object;
      }
      // Persistent snap highlight on select; clears when a non-snap is selected.
      highlightSnap(snapIdForObject(object));
      // Single click selects only — it does NOT force the property inspector
      // open (that is the double-click gesture). `getSnapshot()` reads the live
      // value (this callback is memoized and would otherwise close over a stale
      // `showInspector`).
      plugin.selectObject(object, plugin.getSnapshot().showInspector, false);
    },
    [viewer, plugin, highlightSnap, snapIdForObject],
  );

  const handleRowDragStart = useCallback((node: TreeNode, e: React.DragEvent) => {
    const object = objectOf(node);
    // The model root is not a draggable thing (plan-715 F4), and neither is a
    // row the document does not own. The row already renders undraggable; this
    // is the second lock, for a synthetic event or a future row variant.
    if (!object || !node.path || isModelRoot(object, viewer.currentModelRoot)) {
      e.preventDefault();
      return;
    }
    // Dragging a row that is part of a multi-selection moves the whole set;
    // dragging an unselected row moves (and selects) just that row.
    const paths = selectedObjects.has(object) && selectedObjects.size > 1
      ? [...selection.selectedPaths]
      : [node.path];
    if (!selectedObjects.has(object)) handleSelect(node);
    dragPathsRef.current = paths;
    e.dataTransfer.effectAllowed = 'move';
    try { e.dataTransfer.setData('text/plain', paths.join('\n')); } catch { /* jsdom */ }
  }, [selectedObjects, selection.selectedPaths, handleSelect, viewer]);

  const handleDoubleClick = useCallback(
    (node: TreeNode) => {
      const object = objectOf(node);
      if (!object) return;
      // On a resolvable AssetReference the double-click is a DESCEND, not an
      // inspector toggle (plan-703 §3.4): the reference node itself has almost
      // nothing to inspect, and the gesture the user means is "open this".
      // `requestDescend` answers false when there is no editor stack or the node
      // is not descendable, so the ordinary behaviour below stays the default.
      if (node.path && requestDescend(node.path)) return;

      // Double click is the gesture that opens the property inspector. The node
      // is already selected by the preceding click of the double-click sequence,
      // so this just flips the inspector visible for it.
      plugin.selectObject(object, true, false);
      viewer.fitToNodes([object]); // viewer auto-applies panel offset
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
      const cur = viewer.selectionManager.primaryNode;
      const idx = cur ? order.indexOf(cur) : -1;
      const selectAt = (i: number) => {
        const bounded = Math.max(0, Math.min(order.length - 1, i));
        const object = order[bounded];
        if (!object) return;
        if (flatFilteredRef.current) {
          flatVirtualizerRef.current.scrollToIndex(bounded, { align: 'center' });
        } else {
          const rowIndex = visibleRowsRef.current.findIndex((row) => row.rowKey === object.uuid);
          if (rowIndex >= 0) treeVirtualizerRef.current.scrollToIndex(rowIndex, { align: 'center' });
        }
        setPendingKeyboardKey(object.uuid);
      };
      switch (key) {
        case 'ArrowDown': e.preventDefault(); selectAt(idx < 0 ? 0 : idx + 1); break;
        case 'ArrowUp': e.preventDefault(); selectAt(idx < 0 ? 0 : idx - 1); break;
        case 'Home': e.preventDefault(); selectAt(0); break;
        case 'End': e.preventDefault(); selectAt(order.length - 1); break;
        case 'Enter': {
          e.preventDefault();
          const row = cur ? visibleRowsRef.current.find((r) => r.rowKey === cur.uuid) : undefined;
          if (row) handleDoubleClick(row.node);
          break;
        }
        case 'ArrowRight':
        case 'ArrowLeft': {
          e.preventDefault();
          // Flat mode (type filter) has no hierarchy — step like Up/Down.
          if (flatFilteredRef.current || !cur) { selectAt(key === 'ArrowRight' ? idx + 1 : idx - 1); break; }
          const expandable = cur.children.length > 0;
          // During a search everything is force-expanded, so toggling the real
          // expand set does nothing visible — just navigate.
          const searching = deferredTerm.length > 0;
          const isExp = expanded.has(cur.uuid);
          if (key === 'ArrowRight') {
            if (expandable && !isExp && !searching) onToggleExpand(cur.uuid);
            else if (expandable) selectAt(idx + 1); // already open → first child
          } else if (expandable && isExp && !searching) {
            onToggleExpand(cur.uuid);
          } else if (cur.parent) {
            selectAt(order.indexOf(cur.parent));
          }
          break;
        }
      }
    },
    [viewer, handleDoubleClick, onToggleExpand, expanded, deferredTerm],
  );

  // Keyboard navigation scrolls first. Selection (and therefore the ARIA
  // anchor) is committed only after the target row is mounted by the virtualizer.
  useEffect(() => {
    if (!pendingKeyboardKey || !mountedKeys.has(pendingKeyboardKey)) return;
    const row = visibleRowsRef.current.find((r) => r.rowKey === pendingKeyboardKey)
      ?? flatFilteredRef.current?.find((r) => r.object.uuid === pendingKeyboardKey);
    const node = row && 'node' in row ? row.node : row;
    if (node) handleSelect(node as TreeNode);
    setPendingKeyboardKey(null);
  }, [pendingKeyboardKey, mountedKeys, handleSelect]);

  const handleContextMenu = useCallback(
    (e: React.MouseEvent, node: TreeNode) => {
      const object = objectOf(node);
      // Every menu entry addresses the node by path, so a runtime row has no
      // menu — not an empty one (D2: runtime rows are read-only).
      if (!viewer.registry || !object || !node.path) return;
      const target: ContextMenuTarget = {
        path: node.path,
        node: object,
        types: viewer.registry.getComponentTypes(node.path),
        extras: (object.userData?.realvirtual ?? {}) as Record<string, unknown>,
      };
      // Highlight the node and hold hover while context menu is open
      const isLayout = !!(object.userData?.realvirtual as Record<string, unknown> | undefined)?.LayoutObject;
      viewer.highlighter.highlight(object, false, { includeChildDrives: isLayout });
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
  const primaryKey = selection.primaryNode?.uuid ?? null;
  const activeDescendant = primaryKey && mountedKeys.has(primaryKey)
    ? rowDomId(primaryKey)
    : undefined;

  // A filter is "active" when it actually narrows the tree — drives the badge
  // dot on the header filter icon so a collapsed-but-filtering state is never
  // invisible to the user.
  // The runtime toggle is the default state, so only SHOWING runtime counts as a
  // deviation worth flagging on the filter icon.
  // Likewise for the baked toggle: only SHOWING baked geometry is a deviation.
  const hasActiveFilters = searchTerm.length > 0 || typeFilter !== 'all' || !hideRuntime || !hideBaked;

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
        <>
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
        </>
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
            {isFlat || deferredTerm
              ? `${displayCount} of ${counts.total} node${counts.total !== 1 ? 's' : ''}`
              : `${counts.total} node${counts.total !== 1 ? 's' : ''}`}
            {counts.withOverrides > 0 && (
              <> &middot; {counts.withOverrides} with override{counts.withOverrides !== 1 ? 's' : ''}</>
            )}
            {counts.runtimeHidden > 0 && !deferredTerm && (
              <> &middot;{' '}
                <Box
                  component="span"
                  role="button"
                  tabIndex={0}
                  title="Show runtime objects (lights, helpers, gizmos)"
                  onClick={toggleHideRuntime}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHideRuntime(); } }}
                  sx={{ cursor: 'pointer', textDecoration: 'underline dotted', '&:hover': { color: 'text.secondary' } }}
                >
                  {counts.runtimeHidden} runtime hidden
                </Box>
              </>
            )}
            {counts.bakedHidden > 0 && !deferredTerm && (
              <> &middot;{' '}
                <Box
                  component="span"
                  role="button"
                  tabIndex={0}
                  title="Show baked geometry (merged chunk meshes)"
                  data-testid="hierarchy-baked-hidden"
                  onClick={toggleHideBaked}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleHideBaked(); } }}
                  sx={{ cursor: 'pointer', textDecoration: 'underline dotted', '&:hover': { color: 'text.secondary' } }}
                >
                  {counts.bakedHidden} baked chunk{counts.bakedHidden !== 1 ? 's' : ''} hidden
                </Box>
              </>
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
        {/* Search row: the field plus the runtime / baked toggles to its right
            (plan-597 Phase 6b — they were a chip row of their own). They live in
            the collapsible section with the search: collapsed, they stay
            reachable through the header filter icon (its badge dot flags a
            shown runtime / baked state) and the footer "… hidden" hints. */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, px: 0.75, pt: 0.5, pb: 0.5 }}>
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
                // the first row of the pruned tree in an "All" search.
                if (flatFiltered && flatFiltered.length > 0) handleSelect(flatFiltered[0]);
                else if (visibleRows.length > 0) handleSelect(visibleRows[0].node);
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
              flex: 1,
              minWidth: 0,
              '& .MuiOutlinedInput-root': {
                bgcolor: 'rgba(255, 255, 255, 0.04)',
                '& fieldset': { borderColor: 'rgba(255, 255, 255, 0.08)' },
                '&:hover fieldset': { borderColor: 'rgba(255, 255, 255, 0.15)' },
                '&.Mui-focused fieldset': { borderColor: 'primary.main' },
              },
            }}
          />
          {/* Runtime objects (lights, helpers, gizmos) and baked geometry (chunk
              meshes, plan-505) — both hidden by default. */}
          <SearchRowToggle
            label="Show runtime objects"
            pressed={!hideRuntime}
            onToggle={toggleHideRuntime}
            icon={<BlurOn sx={{ fontSize: ICON_SIZE.md }} />}
          />
          <SearchRowToggle
            label="Show baked geometry"
            pressed={!hideBaked}
            onToggle={toggleHideBaked}
            icon={<ViewInAr sx={{ fontSize: ICON_SIZE.md }} />}
          />
        </Box>

        {/* Category filter chips (plan-597) — only categories the model has,
            in a fixed order; each carries its live count ("3/21" while a
            search runs), a ▾ narrows to one type label. */}
        <Box sx={{ borderBottom: `1px solid ${DIVIDER}` }}>
          <HierarchyCategoryChips counts={counts} matchCounts={matchCounts} value={typeFilter} onChange={setTypeFilter} />
        </Box>
      </Collapse>

      {/* Signal sort buttons (only when Signals filter active) */}
      {signalsView && (
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
                    key={info.object.uuid}
                    node={info}
                    rowKey={info.object.uuid}
                    selected={selectedObjects.has(info.object)}
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
                    eyeDisabledReason={eyeDisabledReason}
                    onUnlock={onUnlock}
                    depth={isLogicFilter(typeFilter) ? (flatDepths.get(info.object.uuid) ?? 0) : 0}
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
                const object = objectOf(row.node);
                return (
                  <TreeNodeRow
                    key={row.rowKey}
                    row={row}
                    selected={!!object && selectedObjects.has(object)}
                    expanded={expanded}
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
                    eyeDisabledReason={eyeDisabledReason}
                    onUnlock={onUnlock}
                    dndEnabled={dndEnabled}
                    dropZone={dropTarget && dropTarget.key === row.rowKey ? dropTarget.zone : null}
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
          ) : (
            <NoMatchState onClear={hasActiveFilters ? clearAllFilters : undefined} />
          )
        )}
      </Box>
    </LeftPanel>
  );
}

/** Height of the search field — the toggles beside it match it. */
const SEARCH_ROW_HEIGHT = 26;

/**
 * A compact icon toggle in the search row (plan-597 Phase 6b): `aria-pressed`,
 * the action as accessible name and tooltip, Instrument Blue only while pressed.
 */
export function SearchRowToggle({ label, pressed, onToggle, icon }: {
  label: string;
  pressed: boolean;
  onToggle(): void;
  icon: React.ReactNode;
}) {
  return (
    <Tooltip title={label} disableInteractive>
      <IconButton
        size="small"
        aria-label={label}
        aria-pressed={pressed}
        onClick={onToggle}
        sx={{
          flexShrink: 0,
          width: SEARCH_ROW_HEIGHT,
          height: SEARCH_ROW_HEIGHT,
          p: 0,
          borderRadius: 1,
          border: `1px solid ${pressed ? ACCENT_BORDER : 'transparent'}`,
          color: pressed ? 'primary.main' : 'text.secondary',
          bgcolor: pressed ? ACCENT_TINT : 'transparent',
          '&:hover': { bgcolor: pressed ? ACCENT_TINT_HOVER : CHIP_HOVER },
        }}
      >
        {icon}
      </IconButton>
    </Tooltip>
  );
}
