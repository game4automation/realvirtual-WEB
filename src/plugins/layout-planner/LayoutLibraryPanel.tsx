// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LayoutLibraryPanel — Multi-tab library browser for the Layout Planner.
 *
 * Each library URL appears as its own tab. Users browse thumbnails by category,
 * drag components into the 3D scene, and manage grid/save/load settings.
 *
 * Relies on LayoutStore (useSyncExternalStore) for reactive state.
 */

import { useState, useCallback, useEffect, useSyncExternalStore, memo, useRef, type ReactNode } from 'react';
import {
  Box,
  Paper,
  Typography,
  IconButton,
  Button,
  Tooltip,
  Switch,
  MenuItem,
  ListItemIcon,
  Divider,
  CircularProgress,
  Menu,
} from '@mui/material';
import {
  Tune,
  CameraAlt,
  FolderOpen,
  ErrorOutline,
  Close,
  ViewSidebar,
  KeyboardArrowUp,
  MoreVert,
  Check,
  Refresh,
  Link as LinkIcon,
  Edit as EditIcon,
} from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { useActiveContexts } from '../../core/hmi/ui-context-store';
import { LeftPanel, WINDOW_DARK_BG } from '../../core/hmi/LeftPanel';
import { RV_SCROLL_CLASS } from '../../core/hmi/shared-sx';
import { LAYOUT_PANEL_WIDTH, LEFT_PANEL_ZINDEX } from '../../core/hmi/layout-constants';
import { showInfoOverlay } from '../../core/hmi/info-overlay-store';
import { setPendingAssetOpen } from '@rv-private/plugins/asset-editor/pending-open-store';
import { libraryDocumentBase } from '../../core/editor/active-asset-store';
import type { LayoutPlannerPlugin } from './index';
import type { LibraryCatalogEntry, LayoutSnapshot } from './rv-layout-store';
import { isGitHubRepoScanUrl } from './rv-layout-store';
import { setLayoutDragData, suppressDragImage } from './drag-types';
import { matchMaterialFlows } from '../../core/material-flow/registry';

/** Short, general behavior description for a library entry (hover tooltip). Resolves
 *  the entry to its behavior def by name (+ de-spaced variant + id), so e.g. "Chain
 *  Transfer Left" → ChainTransfer (model glob `*ChainTransfer*`). Null when none. */
function behaviorDescription(entry: LibraryCatalogEntry): string | null {
  for (const c of [entry.name, entry.name.replace(/\s+/g, ''), entry.id]) {
    const m = matchMaterialFlows(c);
    if (m.length && m[0].description) return m[0].description;
  }
  return null;
}
import { CatalogBrowser } from './CatalogBrowser';
import { LibrarySelector, type LibraryItem } from './LibrarySelector';
import { deriveChips, filterByChip } from '../../core/library/library-chips';
import { AssetCard } from '../../core/library/AssetCard';
import { openProjectsDashboard } from '../../core/hmi/projects/projects-dashboard-store';
import { buildThumbnailKey } from '../../core/thumbnails/thumbnail-key';
import { useThumbnailVisibility } from '../../core/thumbnails/use-thumbnail-visibility';
import { getProjectStore } from '../../core/project/project-store';
// Lives in its own module so the lazy-loading host (LayoutLibraryPanelHost) can
// show it WITHOUT pulling this panel's chunk (plan-344 Phase 4).
import { MobileLibraryTab } from './MobileLibraryTab';


// ─── Constants ──────────────────────────────────────────────────────────

const PANEL_ID = 'layout-planner';

/** Width (px) of one thumbnail card inside the mobile horizontal strip. */
const MOBILE_CARD_WIDTH = 84;
/** Height (px) of the bottom nav strips (ActivityBar / ButtonPanel) the mobile
 *  strip/tab sits flush on top of — no gap below it. The bars add the safe-area
 *  inset as bottom padding, so the strip adds the same inset on top of this. */
const MOBILE_NAV_CLEARANCE = 48;

/**
 * Hover-intent delay (ms) before a card starts prefetching its GLB (plan-371 F8).
 *
 * Prefetching on the very first `mouseenter` would fire for every card the
 * pointer merely crosses on its way somewhere else — "align prefetching with
 * intent, not hope". 65–100 ms is the established window; 80 ms is short enough
 * to be invisible to a user who is actually reaching for the card and long
 * enough to reject a scrub across the grid.
 */
export const PREFETCH_INTENT_MS = 80;

/** Whether an entry has a GLB worth prefetching (virtual/DES and splat entries
 *  never take the placeholder path, so warming them buys nothing). */
function prefetchableUrl(entry: LibraryCatalogEntry): string | null {
  if (entry.virtual === true || entry.splatUrl) return null;
  const url = entry.glbUrl?.trim();
  return url ? url : null;
}

// ─── Panel Component ────────────────────────────────────────────────────

// Stable fallback for the cloud store's useSyncExternalStore snapshot. Must be
// a module-level constant: returning a fresh object literal from the getSnapshot
// fallback makes useSyncExternalStore see a new reference every render, which in
// public builds (no cloud extension) triggers an infinite re-render loop
// (React "Maximum update depth exceeded", minified error #185).
const EMPTY_CLOUD_SNAPSHOT = { connections: [], activeConnectionId: null };

export function LayoutLibraryPanel() {
  const viewer = useViewer();
  const isMobile = useMobileLayout();
  const activeContexts = useActiveContexts();
  const lpm = viewer.leftPanelManager;
  const lpmSnapshot = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  // Planner docks to the right slot — read its state directly so it stays
  // independent of whatever (hierarchy / settings / ...) is open on the left.
  const isOpen = lpmSnapshot.right.activePanel === PANEL_ID;

  const plugin = viewer.getPlugin<LayoutPlannerPlugin>('layout-planner');
  const store = plugin?.store;

  // Subscribe to store
  const snapshot = useSyncExternalStore(
    store?.subscribe ?? (() => () => {}),
    store?.getSnapshot ?? (() => null as unknown as LayoutSnapshot),
  );

  // Unity Asset Manager store (lives on the plugin for restore access)
  const cloudStore = plugin?.cloudStore ?? null;
  const cloudSnapshot = useSyncExternalStore(
    cloudStore?.subscribe ?? (() => () => {}),
    cloudStore?.getSnapshot ?? (() => EMPTY_CLOUD_SNAPSHOT),
  );

  // Active tab: either a catalog URL or "am:<connectionId>"
  const [activeTabId, setActiveTabId] = useState<string | null>(null);

  const [searchText, setSearchText] = useState('');
  // Save / Load / Clear dialogs were removed when those actions migrated
  // to the unified Scene window — see footer note in this file's render.
  //
  // The Add-Library and Edit-Connection dialogs and their fourteen state
  // variables went the same way in plan-702: library MANAGEMENT now lives
  // exclusively in the Projects dashboard's Assets tab, and this panel keeps
  // only what browsing needs (pick, search, filter, drag, refresh, re-grant).

  // Selected filter chip (null = "All"). Shared across every tab type:
  // collections when the catalog defines them, otherwise the category enum
  // (see `deriveChips` / `filterByChip`). Reset when switching tabs.
  const [selectedChip, setSelectedChip] = useState<string | null>(null);

  // Closing the library only HIDES the panel. The library is optional in planner
  // mode — the plugin's lpm subscription keeps edit bindings active while in
  // planner mode (and releases them only in the standalone, pre-mode path), so
  // we must NOT call setActive(false) here.
  const handleClose = useCallback(() => {
    lpm.close(PANEL_ID);
  }, [lpm]);

  // Make `id` the active library: update both the React tab state and (for
  // store-backed catalogs) the store's activeTabUrl so the grid, chips and
  // count all read the same catalog. Used by add + dropdown-select.
  const switchToLibrary = useCallback((id: string) => {
    setActiveTabId(id);
    setSelectedChip(null);
    if (!id.startsWith('am:')) store?.setActiveTab(id);
  }, [store]);

  /**
   * The panel's single management route (plan-702 F8).
   *
   * Everything that used to live here — add URL / GitHub / Asset Manager,
   * remove, edit connection — is now one door into the Projects
   * dashboard's Assets tab, which groups the same libraries by source and can
   * attach new ones.
   */
  const handleManageLibraries = useCallback(() => {
    openProjectsDashboard({ kind: 'globalLibraries' });
  }, []);

  if (!plugin || !store || !snapshot) return null;

  // The panel itself:
  if (!isOpen) {
    // Compact layout: the library doesn't auto-open on phones, so while the
    // planner is active show a small bottom tab to reveal the horizontal strip.
    // Desktop (or planner inactive): render nothing.
    if (isMobile && activeContexts.has('planner')) {
      return <MobileLibraryTab onOpen={() => lpm.open(PANEL_ID, LAYOUT_PANEL_WIDTH, 'right')} />;
    }
    return null;
  }

  // Build unified tab list: [catalog URLs...] + [AM connections...]
  const visibleCatalogUrls = snapshot.catalogUrls.filter(u => u !== 'bundled://unity-cloud');
  const amConnections = cloudSnapshot.connections;

  // All tab IDs in order
  const allTabIds: string[] = [
    ...visibleCatalogUrls,
    ...amConnections.map(c => `am:${c.conn.id}`),
  ];

  // Resolve active tab
  const resolvedActiveTabId = activeTabId && allTabIds.includes(activeTabId)
    ? activeTabId
    : (snapshot.activeTabUrl && visibleCatalogUrls.includes(snapshot.activeTabUrl))
      ? snapshot.activeTabUrl
      : allTabIds[0] ?? null;
  const isAmTab = resolvedActiveTabId?.startsWith('am:') ?? false;

  // Active (non-AM) catalog + the shared chip/filter pipeline. Every public
  // tab — remote URL, GitHub scan — now runs through the same CatalogBrowser
  // shell driven by these values.
  const activeError = resolvedActiveTabId ? snapshot.catalogErrors.get(resolvedActiveTabId) : null;
  const activeCatalog = !isAmTab && resolvedActiveTabId ? snapshot.catalogs.get(resolvedActiveTabId) : null;
  const fullEntries = activeCatalog?.entries ?? [];
  // Chips/counts use the UNFILTERED entries so totals stay stable while the
  // user types in the search field (matching the prior Local/Cloud UX).
  const chips = deriveChips(fullEntries);
  // Displayed grid: search filter then the selected chip. Both derive from
  // `fullEntries` (the resolved active catalog) so grid + chips never disagree.
  const q = searchText.trim().toLowerCase();
  const searchedEntries = q
    ? fullEntries.filter(e =>
        e.name.toLowerCase().includes(q) ||
        e.category.toLowerCase().includes(q) ||
        e.tags?.some(t => t.toLowerCase().includes(q)),
      )
    : fullEntries;
  const displayedEntries = filterByChip(searchedEntries, selectedChip);

  // Library dropdown items — catalog URLs (url / github) + Asset
  // Manager connections, each carrying the kind/status the selector needs to
  // render its icon and per-row remove/refresh actions.
  const libraryItems: LibraryItem[] = [
    ...visibleCatalogUrls.map((url): LibraryItem => {
      const catalog = snapshot.catalogs.get(url);
      const err = snapshot.catalogErrors.get(url);
      return {
        id: url,
        label: catalog?.name ?? (err ? 'Error' : 'Loading…'),
        kind: isGitHubRepoScanUrl(url) ? 'github' : 'url',
        error: !!err,
      };
    }),
    ...amConnections.map((cs): LibraryItem => ({
      id: `am:${cs.conn.id}`,
      label: cs.conn.label,
      kind: 'cloud',
      cloudStatus: cs.connected ? 'connected' : cs.connecting ? 'connecting' : 'error',
    })),
  ];

  const handleSelectLibrary = (id: string): void => {
    switchToLibrary(id);
  };

  // Chip row is redundant when a single facet already covers every entry
  // (e.g. one category == all items). Show it only when it adds filtering value.
  const showChips = chips.length > 1 || (chips.length === 1 && chips[0].count < fullEntries.length);

  // Resolve the single "empty" state shown instead of the card grid (null =>
  // render the grid). Order: no libraries → load error → no results.
  let emptyContent: ReactNode = null;
  if (allTabIds.length === 0) {
    emptyContent = (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          No libraries loaded. Attach one via “Manage libraries…” in the library dropdown.
        </Typography>
      </Box>
    );
  } else if (activeError) {
    emptyContent = (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography variant="caption" sx={{ color: '#ef5350' }}>
          Library unavailable: {activeError}
        </Typography>
      </Box>
    );
  } else if (displayedEntries.length === 0) {
    const filtering = searchText.trim() !== '' || selectedChip !== null;
    emptyContent = (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {filtering ? 'No matching components' : 'Loading...'}
        </Typography>
      </Box>
    );
  }

  // Small count caption — only when the grid is showing AND the chip row is
  // hidden (otherwise the "All (N)" chip already carries the count).
  const countLabel = emptyContent === null && !showChips && fullEntries.length > 0
    ? `${fullEntries.length} component${fullEntries.length !== 1 ? 's' : ''}`
    : undefined;

  return (
    <>
      {isMobile ? (
        /* Compact layout: a horizontal thumbnail strip docked above the bottom
           nav instead of the fullscreen panel — keeps the scene visible. */
        <MobileLibraryStrip
          entries={displayedEntries}
          plugin={plugin}
          snapshot={snapshot}
          isAmTab={isAmTab}
          libraryItems={libraryItems}
          activeId={resolvedActiveTabId}
          onSelect={handleSelectLibrary}
          onManage={handleManageLibraries}
          onClose={handleClose}
        />
      ) : (
      /* Right-docked library window (toggled from the toolbar Library button). */
      <LeftPanel
        title="Library"
        anchor="right"
        onClose={handleClose}
        // Width is driven by the panel manager — it owns persistence via
        // localStorage. Falling back to the default keeps the panel usable
        // before the first resize is recorded.
        width={lpmSnapshot.right.activePanelWidth || LAYOUT_PANEL_WIDTH}
        resizable
        minWidth={280}
        maxWidth={600}
        onResize={(w) => lpm.open(PANEL_ID, w, 'right')}
        footer={
          snapshot.placed.length > 0 ? (
            <Box sx={{ px: 1.5, py: 0.75 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', fontSize: 10 }}>
                {snapshot.placed.length} object{snapshot.placed.length !== 1 ? 's' : ''} placed
              </Typography>
            </Box>
          ) : null
        }
      >
        {/* Library switcher — full-width dropdown, plus the one management
            route into the Projects dashboard (plan-702 F8). */}
        <LibrarySelector
          items={libraryItems}
          activeId={resolvedActiveTabId}
          onSelect={handleSelectLibrary}
          onManage={handleManageLibraries}
        />

        {/* Every catalog source shares the CatalogBrowser shell. (The private
            Asset-Manager `cloudTabComponent` escape hatch was removed in
            plan-372 Phase 13; the branch that rendered it had been dead in
            every build since, and went with it in plan-702.) */}
        <CatalogBrowser
          headerText={countLabel}
          searchText={searchText}
          onSearchChange={setSearchText}
          searchPlaceholder="Search..."
          chips={showChips ? chips : []}
          totalCount={fullEntries.length}
          selectedChip={selectedChip}
          onSelectChip={setSelectedChip}
          empty={emptyContent !== null}
          emptyContent={emptyContent}
        >
          {displayedEntries.map((entry) => (
            <ThumbnailCard
              key={entry.id}
              entry={entry}
              isPlacing={snapshot.placementMode === entry.id}
              isPending={snapshot.thumbnailPending.has(entry.id)}
              plugin={plugin}
            />
          ))}
        </CatalogBrowser>
      </LeftPanel>
      )}
    </>
  );
}

// ─── Mobile: horizontal strip ───────────────────────────────────────────

interface MobileLibraryStripProps {
  entries: LibraryCatalogEntry[];
  plugin: LayoutPlannerPlugin;
  snapshot: LayoutSnapshot;
  isAmTab: boolean;
  libraryItems: LibraryItem[];
  activeId: string | null;
  onSelect: (id: string) => void;
  /** Open the Projects dashboard's Assets tab — the one management route. */
  onManage: () => void;
  onClose: () => void;
}

/** Compact-layout library: a one-row, horizontally scrollable thumbnail strip
 *  docked above the bottom nav. Keeps the 3D scene visible (unlike the
 *  fullscreen panel) — tap a card to enter placement mode, then tap the scene. */
function MobileLibraryStrip({
  entries, plugin, snapshot, isAmTab, libraryItems, activeId,
  onSelect, onManage, onClose,
}: MobileLibraryStripProps) {
  // Single combined menu (library switch + manage) opened from the floating ⋮.
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const closeMenu = () => setMenuAnchor(null);
  const activeItem = libraryItems.find((i) => i.id === activeId) ?? null;

  return (
    <Box
      sx={{
        position: 'fixed', left: 0, right: 0,
        bottom: `calc(${MOBILE_NAV_CLEARANCE}px + env(safe-area-inset-bottom, 0px))`,
        zIndex: LEFT_PANEL_ZINDEX, pointerEvents: 'none',
      }}
    >
      <Paper
        elevation={6}
        data-ui-panel
        sx={{
          position: 'relative',
          pointerEvents: 'auto',
          backgroundColor: `${WINDOW_DARK_BG} !important`,
          borderRadius: 0, overflow: 'hidden',
          display: 'flex', flexDirection: 'column',
        }}
      >
        {/* No header row — just the scrollable thumbnail row. Right padding clears
            the floating controls so the last card isn't hidden behind them. */}
        <Box
          className={RV_SCROLL_CLASS}
          sx={{
            display: 'flex', flexDirection: 'row', gap: 0.5, p: 0.75, pr: 8,
            overflowX: 'auto', overflowY: 'hidden', WebkitOverflowScrolling: 'touch',
            '& > *': { flexShrink: 0 },
          }}
        >
          {entries.length === 0 ? (
            <Typography variant="caption" sx={{ color: 'text.secondary', px: 1, py: 1.5 }}>
              {isAmTab ? 'Asset Manager not available on mobile' : 'No components'}
            </Typography>
          ) : (
            entries.map((entry) => (
              <Box key={entry.id} sx={{ width: MOBILE_CARD_WIDTH }}>
                <ThumbnailCard
                  entry={entry}
                  isPlacing={snapshot.placementMode === entry.id}
                  isPending={snapshot.thumbnailPending.has(entry.id)}
                  plugin={plugin}
                />
              </Box>
            ))
          )}
        </Box>

        {/* Tap-to-place hint (no drag-and-drop on touch). Reflects the current
            placement state so the user knows what to tap next. */}
        {entries.length > 0 && (
          <Box sx={{ px: 1, pb: 0.5, pt: 0.25 }}>
            <Typography
              sx={{
                fontSize: 9.5, textAlign: 'center',
                color: snapshot.placementMode ? 'primary.light' : 'text.disabled',
              }}
            >
              {snapshot.placementMode ? 'Tap in the scene to place · tap part again to cancel' : 'Tap a part, then tap the scene to place'}
            </Typography>
          </Box>
        )}

        {/* Floating controls (top-right): combined library/actions menu + close.
            No header row keeps the strip as low as possible. */}
        <Box sx={{ position: 'absolute', top: 2, right: 2, display: 'flex', gap: 0.25 }}>
          <IconButton
            size="small"
            onClick={(e) => setMenuAnchor(e.currentTarget)}
            sx={{ color: 'text.secondary', bgcolor: 'rgba(0,0,0,0.45)', '&:hover': { bgcolor: 'rgba(0,0,0,0.65)' }, p: 0, width: 22, height: 22 }}
            aria-label="Library menu"
          >
            <MoreVert sx={{ fontSize: 15 }} />
          </IconButton>
          <IconButton
            size="small"
            onClick={onClose}
            sx={{ color: 'text.secondary', bgcolor: 'rgba(0,0,0,0.45)', '&:hover': { bgcolor: 'rgba(0,0,0,0.65)' }, p: 0, width: 22, height: 22 }}
            aria-label="Close library"
          >
            <Close sx={{ fontSize: 15 }} />
          </IconButton>
        </Box>

        {/* Combined menu: switch active library + manage (refresh/remove/add). */}
        <Menu anchorEl={menuAnchor} open={!!menuAnchor} onClose={closeMenu}>
          {libraryItems.map((item) => (
            <MenuItem
              key={item.id}
              selected={item.id === activeId}
              onClick={() => { onSelect(item.id); closeMenu(); }}
              sx={{ fontSize: 12 }}
            >
              <ListItemIcon sx={{ minWidth: 26 }}>
                {item.id === activeId
                  ? <Check sx={{ fontSize: 16, color: 'primary.main' }} />
                  : <LinkIcon sx={{ fontSize: 16 }} />}
              </ListItemIcon>
              {item.label}
            </MenuItem>
          ))}
          {libraryItems.length > 0 && <Divider />}
          {/* Full library management lives in the Projects dashboard
              (plan-372 Phase 8, sole route since plan-702). This panel keeps
              the fast path — pick a library, search, filter, drag — and hands
              off everything else. */}
          <MenuItem
            onClick={() => { closeMenu(); onManage(); }}
            sx={{ fontSize: 12 }}
          >
            <ListItemIcon sx={{ minWidth: 26 }}><Tune sx={{ fontSize: 16 }} /></ListItemIcon>
            Manage libraries…
          </MenuItem>
        </Menu>
      </Paper>
    </Box>
  );
}

// ─── Thumbnail Card (draggable) ─────────────────────────────────────────

interface ThumbnailCardProps {
  entry: LibraryCatalogEntry;
  isPlacing: boolean;
  /** True while the preview is being auto-generated in the background. */
  isPending: boolean;
  plugin: LayoutPlannerPlugin;
}

export const ThumbnailCard = memo(function ThumbnailCard({ entry, isPlacing, isPending, plugin }: ThumbnailCardProps) {
  const viewer = useViewer();
  // Hover-intent prefetch (plan-371 F8). The timer is the whole mechanism:
  // start on enter, drop on leave, so only a deliberate rest over the card
  // warms its GLB. Touch has no hover at all — `pointerdown` stands in and
  // fires immediately, which on a tap-then-drag still wins the decode race.
  const prefetchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const cancelPrefetchIntent = useCallback(() => {
    if (prefetchTimer.current === null) return;
    clearTimeout(prefetchTimer.current);
    prefetchTimer.current = null;
  }, []);

  const startPrefetchIntent = useCallback(() => {
    const url = prefetchableUrl(entry);
    if (!url) return;
    cancelPrefetchIntent();
    prefetchTimer.current = setTimeout(() => {
      prefetchTimer.current = null;
      plugin.modelCache.prefetch(url);
    }, PREFETCH_INTENT_MS);
  }, [entry, plugin, cancelPrefetchIntent]);

  const prefetchNow = useCallback(() => {
    const url = prefetchableUrl(entry);
    if (!url) return;
    cancelPrefetchIntent();
    plugin.modelCache.prefetch(url);
  }, [entry, plugin, cancelPrefetchIntent]);

  useEffect(() => cancelPrefetchIntent, [cancelPrefetchIntent]);

  // ── Visibility-scheduled preview (plan-372 §2.7/§2.8) ────────────────
  // Previews are pulled, not pushed: the card asks for its picture once it
  // enters the prefetch band and withdraws the request when it leaves. The
  // service de-duplicates by key, so re-entering the viewport is free.
  const { ref: cardRef, visible } = useThumbnailVisibility<HTMLDivElement>();
  const needsPreview = !entry.thumbnailUrl && !entry.virtual && !!entry.glbUrl;

  useEffect(() => {
    if (!needsPreview || !viewer) return;
    // Optional chaining is deliberate: a missing preview service must never
    // throw out of a card render. Constrained shells and test doubles hand back
    // viewers that do not carry it, and a card without a picture is a far
    // better outcome than a broken library panel.
    const service = viewer.thumbnails;
    if (!service?.isAvailable) return;  // WebGPU / unavailable — manual button remains
    const glbUrl = entry.glbUrl!;
    const key = buildThumbnailKey({
      projectId: getProjectStore().getProject()?.id ?? '',
      providerId: 'layout-planner',
      // Entry ids are unique across the planner's catalogs, which is what the
      // previous glbUrl-wide lookup already relied on. Phase 10 replaces this
      // with the real (providerId, sourceId) pair from the source registry.
      sourceId: 'catalogs',
      assetId: entry.id,
    });

    let cancelled = false;
    if (!visible) { service.cancel(key); return; }

    plugin.store.setThumbnailPending(entry.id, true);
    void service
      .enqueue(key, () => plugin.modelCache.getOrLoad(glbUrl), 1)
      .then((blob) => {
        if (cancelled || !blob) return;
        plugin.store.setEntryThumbnail(entry.id, URL.createObjectURL(blob));
      })
      .finally(() => {
        if (!cancelled) plugin.store.setThumbnailPending(entry.id, false);
      });

    return () => { cancelled = true; };
  }, [visible, needsPreview, viewer, plugin, entry.id, entry.glbUrl]);

  // Preview generation state — kept local because it only matters for the
  // single card showing the camera button. Multiple cards can generate in
  // parallel; each tracks its own progress.
  const [generating, setGenerating] = useState(false);
  const [genError, setGenError] = useState<string | null>(null);
  const errorClearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [ctxPos, setCtxPos] = useState<{ x: number; y: number } | null>(null);
  // Hover tooltip showing the component's general behavior description. Suppressed
  // while dragging (controlled `open`) so it doesn't float over the drag ghost.
  const [dragging, setDragging] = useState(false);
  const [hovered, setHovered] = useState(false);
  const description = behaviorDescription(entry);

  const handleClick = () => {
    // Splat entries: place directly at origin (no drag/placement mode — splats are too large).
    // Surface placement failures so the click doesn't appear to do nothing
    // when the gaussian-splat library throws (e.g. unsupported format).
    if (entry.splatUrl) {
      plugin.placeComponent(entry, [0, 0, 0]).catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[LayoutPlanner] Failed to place splat "${entry.name}":`, err);
        showInfoOverlay(`Splat konnte nicht platziert werden: ${msg}`);
      });
      return;
    }
    // Toggle: click same entry again to cancel
    plugin.store.setPlacementMode(isPlacing ? null : entry.id);
  };

  const runGeneratePreview = useCallback(async () => {
    if (generating) return;
    if (errorClearTimer.current) {
      clearTimeout(errorClearTimer.current);
      errorClearTimer.current = null;
    }
    setGenerating(true);
    setGenError(null);
    try {
      const result = await plugin.saveThumbnail(entry.id, entry.glbUrl ?? '');
      // `result` is null when generation succeeded in-memory but persistence
      // was skipped (e.g. user denied write access on the local folder, or
      // the dev-server route is unavailable). The in-memory thumbnail is
      // still set on the store, so the card switches away from the camera
      // fallback — no error in that case.
      if (!result && !entry.thumbnailUrl) {
        setGenError('Preview konnte nicht erzeugt werden — Schreibrechte verweigert oder GLB-Ladefehler');
      }
    } catch (err) {
      setGenError(err instanceof Error ? err.message : String(err));
    } finally {
      setGenerating(false);
      // Auto-dismiss the error indicator after a while so the card returns
      // to a neutral state and the user can retry without manual cleanup.
      errorClearTimer.current = setTimeout(() => setGenError(null), 6000);
    }
  }, [generating, plugin, entry.id, entry.glbUrl, entry.thumbnailUrl]);

  const handleGeneratePreview = useCallback((e: React.MouseEvent) => {
    e.stopPropagation();
    void runGeneratePreview();
  }, [runGeneratePreview]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxPos({ x: e.clientX, y: e.clientY });
  }, []);

  const handleCtxUpdate = useCallback(() => {
    setCtxPos(null);
    void runGeneratePreview();
  }, [runGeneratePreview]);

  const handleDragStart = (e: React.DragEvent) => {
    setDragging(true);
    setHovered(false);
    setLayoutDragData(e.dataTransfer, entry);
    e.dataTransfer.effectAllowed = 'copy';

    // Store footprint as a MIME type for dragover to read
    if (entry.footprintMm) {
      e.dataTransfer.setData(`x-footprint/${entry.footprintMm[0]}/${entry.footprintMm[1]}`, '');
    }

    // Set drag entry so the 3D ghost preview appears during drag
    plugin.setDragEntry(entry);

    // Hide the browser's default HTML5 drag preview (card clone) —
    // the 3D ghost on the floor replaces it.
    suppressDragImage(e);
  };

  const handleDragEnd = () => {
    setDragging(false);
    plugin.setDragEntry(null);
  };

  const isSplat = !!entry.splatUrl;

  return (
    <>
    <AssetCard
      ref={cardRef}
      entry={entry}
      variant="compact"
      draggable={!isSplat}
      cursor={isSplat ? 'pointer' : (isPlacing ? 'crosshair' : 'grab')}
      selected={isPlacing}
      tooltip={description ?? ''}
      tooltipOpen={!!description && hovered && !dragging}
      onDragStart={isSplat ? undefined : handleDragStart}
      onDragEnd={isSplat ? undefined : handleDragEnd}
      onClick={handleClick}
      onContextMenu={handleContextMenu}
      onMouseEnter={() => { setHovered(true); startPrefetchIntent(); }}
      onMouseLeave={() => { setHovered(false); cancelPrefetchIntent(); }}
      onPointerDown={prefetchNow}
      placeholderAction={
        <Tooltip
          title={
            (generating || isPending) ? 'Generating preview…'
              : genError ? genError
              : 'Generate preview'
          }
          placement="top"
        >
          <Box component="span" sx={{ display: 'inline-flex' }}>
            <IconButton
              size="small"
              disabled={generating || isPending}
              sx={{
                color: genError ? '#ef5350' : 'rgba(255,255,255,0.25)',
                '&:hover': { color: genError ? '#ef5350' : 'rgba(79,195,247,0.8)' },
                '&.Mui-disabled': { color: 'rgba(79,195,247,0.6)' },
              }}
              onClick={handleGeneratePreview}
            >
              {(generating || isPending)
                ? <CircularProgress size={18} sx={{ color: 'rgba(79,195,247,0.8)' }} />
                : genError
                  ? <ErrorOutline sx={{ fontSize: 20 }} />
                  : <CameraAlt sx={{ fontSize: 20 }} />
              }
            </IconButton>
          </Box>
        </Tooltip>
      }
    />
    <Menu
      open={ctxPos !== null}
      onClose={() => setCtxPos(null)}
      anchorReference="anchorPosition"
      anchorPosition={ctxPos ? { top: ctxPos.y, left: ctxPos.x } : undefined}
    >
      <MenuItem
        onClick={handleCtxUpdate}
        disabled={generating || !entry.glbUrl}
        sx={{ fontSize: 12 }}
      >
        <CameraAlt sx={{ fontSize: 14, mr: 1 }} />
        {entry.thumbnailUrl ? 'Update Preview' : 'Generate Preview'}
      </MenuItem>
      {/* Local work-folder GLBs can be opened in the asset editor. Saving
          always lands in library/Custom/, regardless of where the source
          asset lives. */}
      {entry.localPath && entry.glbUrl && !entry.splatUrl && !entry.localPath.startsWith('splats/') && (
        <MenuItem
          onClick={() => {
            setCtxPos(null);
            setPendingAssetOpen(libraryDocumentBase(entry.localPath!));
            void viewer.modes.requestMode('editor');
          }}
          sx={{ fontSize: 12 }}
        >
          <EditIcon sx={{ fontSize: 14, mr: 1 }} />
          Edit asset
        </MenuItem>
      )}
    </Menu>
    </>
  );
});
