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

import { useState, useCallback, useEffect, useMemo, useSyncExternalStore, memo, useRef, type ReactNode } from 'react';
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
import { LibrarySelector, type LibraryItem, type LibraryKind } from './LibrarySelector';
import {
  listLibrarySources,
  subscribeLibrarySources,
  getLibrarySourcesSnapshot,
  type LibrarySource,
  type RegisteredLibrarySource,
} from '../../core/library/library-source-registry';
import { PROJECT_LIBRARY_PROVIDER_ID } from '../../core/library/project-library-provider';
import { GLOBAL_LIBRARY_PROVIDER_ID } from '../../core/library/global-library-provider';
import { crossSourceKeyOf } from '../../core/hmi/projects/assets-library-groups';
import { PROJECT_PLACEMENT_PREFIX } from './planner-persistence';
import { deriveChips, filterByChip } from '../../core/library/library-chips';
import { AssetCard } from '../../core/library/AssetCard';
import { openProjectsDashboard } from '../../core/hmi/projects/projects-dashboard-store';
import { plannerThumbnailKey } from './planner-thumbnail-key';
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

/** Warm one card's geometry. A registry entry has no URL to key on, so the
 *  plugin warms it under its stable key instead (plan-723). */
function warmEntry(plugin: LayoutPlannerPlugin, entry: LibraryCatalogEntry): void {
  const url = prefetchableUrl(entry);
  if (url) { plugin.modelCache.prefetch(url); return; }
  if (entry.virtual === true || entry.splatUrl) return;
  plugin.prefetchEntry(entry);
}

// ─── Tab construction (plan-723 §2.3) ───────────────────────────────────
//
// Pure and exported on purpose: the panel has no mount precedent in the suite,
// and the interesting rules — project first, provider filter, dedup, the
// persistence read/write split — are all decisions about a LIST, not about a
// rendered tree. Testing them through a React mount would test MUI.

/** Provider id of the private Asset-Manager bridge. Rendered from `cloudStore`
 *  instead, so it is filtered OUT of the registry feed — otherwise every AM
 *  connection would appear twice. Symmetrical to the dashboard, which filters
 *  the project provider out of its catalog roots. */
const CLOUD_PROVIDER_ID = 'unity-asset-manager';

const AM_TAB_PREFIX = 'am:';
const GLOBAL_TAB_PREFIX = `${GLOBAL_LIBRARY_PROVIDER_ID}:`;

/** Panel-local record of the picked library. The store's own `activeTabUrl`
 *  can only hold a catalog URL, so it cannot express "the project" or "an AM
 *  connection" — but it stays the SSOT for catalog picks (plan-723 §2.4). */
export const LS_KEY_PLANNER_ACTIVE_LIBRARY = 'rv-planner-active-library';

export interface LibraryTab {
  /** `'<providerId>:<sourceId>'` for a registry tab, `'am:<connId>'` for cloud. */
  id: string;
  kind: LibraryKind;
  label: string;
  /** Registry provenance. Absent on `am:` tabs, which have no registry source. */
  providerId?: string;
  sourceId?: string;
  error?: string | null;
  loaded?: boolean;
  cloudStatus?: LibraryItem['cloudStatus'];
}

/** The half of an AM connection state this module reads. */
export interface AmConnectionLike {
  conn: { id: string; label: string };
  connected: boolean;
  connecting: boolean;
}

/** One broken provider must not blank the whole panel (plan-702 §5.1 R4). */
function safeListEntries(source: LibrarySource): LibraryCatalogEntry[] {
  try { return source.listEntries(); } catch { return []; }
}

export function registryTabId(providerId: string, sourceId: string): string {
  return `${providerId}:${sourceId}`;
}

/**
 * Canonical keys of everything the project already offers — or `null` when
 * there is no project, or its listing has not landed yet (F6).
 *
 * `null` means "do not dedup, do not hide anything". That is the whole reason
 * the loaded-gate exists: deduplicating against a half-filled project source
 * would make catalog cards blink out and back in during the async load.
 */
export function projectDedupKeys(sources: readonly RegisteredLibrarySource[]): Set<string> | null {
  const projectSources = sources.filter(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID);
  if (projectSources.length === 0) return null;
  if (!projectSources.every(s => s.source.loaded)) return null;

  const keys = new Set<string>();
  for (const { source } of projectSources) {
    for (const entry of safeListEntries(source)) {
      const key = crossSourceKeyOf(entry);
      if (key !== null) keys.add(key);
    }
  }
  return keys;
}

/**
 * The entries a tab shows: everything the source lists, minus what the project
 * already offers under the same canonical key ("project wins", F6).
 *
 * Entries without a `library/` segment have no cross-source identity and are
 * never deduplicated — a coincidental name match between two genuinely
 * different libraries must not hide a card.
 */
export function dedupedEntries(
  registered: RegisteredLibrarySource,
  dedupKeys: Set<string> | null,
): LibraryCatalogEntry[] {
  const entries = safeListEntries(registered.source);
  if (dedupKeys === null || registered.providerId === PROJECT_LIBRARY_PROVIDER_ID) return entries;
  return entries.filter(entry => {
    const key = crossSourceKeyOf(entry);
    return key === null || !dedupKeys.has(key);
  });
}

/**
 * The library dropdown, in display order: the active project first, then the
 * subscribed catalogs, then the Asset-Manager connections (F1).
 *
 * A catalog tab whose every entry was deduplicated away disappears entirely —
 * an empty tab is worse than no tab. A tab that is merely still LOADING has no
 * entries either and must stay, which is why the rule tests `loaded` and the
 * pre-dedup count before it hides anything.
 */
export function buildLibraryTabs(
  sources: readonly RegisteredLibrarySource[],
  amConnections: readonly AmConnectionLike[],
): LibraryTab[] {
  const dedupKeys = projectDedupKeys(sources);
  const registry = sources.filter(s => s.providerId !== CLOUD_PROVIDER_ID);
  const ordered = [
    ...registry.filter(s => s.providerId === PROJECT_LIBRARY_PROVIDER_ID),
    ...registry.filter(s => s.providerId !== PROJECT_LIBRARY_PROVIDER_ID),
  ];

  const tabs: LibraryTab[] = [];
  for (const registered of ordered) {
    const { providerId, source } = registered;
    if (providerId !== PROJECT_LIBRARY_PROVIDER_ID && dedupKeys !== null && source.loaded) {
      const raw = safeListEntries(source);
      if (raw.length > 0 && dedupedEntries(registered, dedupKeys).length === 0) continue;
    }
    tabs.push({
      id: registryTabId(providerId, source.id),
      kind: source.kind,
      label: source.label,
      providerId,
      sourceId: source.id,
      error: source.error ?? null,
      loaded: source.loaded,
    });
  }

  for (const cs of amConnections) {
    tabs.push({
      id: AM_TAB_PREFIX + cs.conn.id,
      kind: 'cloud',
      label: cs.conn.label,
      loaded: true,
      cloudStatus: cs.connected ? 'connected' : cs.connecting ? 'connecting' : 'error',
    });
  }

  return tabs;
}

/**
 * Bring a persisted selection into the tab-id namespace.
 *
 * Two records exist and the panel key wins: it can express every tab, the
 * store's legacy `activeTabUrl` only a catalog URL. A legacy value is a bare
 * URL, so it is re-prefixed; an unrecognisable one simply fails to match a tab
 * and falls through to the default (best-effort migration, never a throw).
 */
export function normalizePersistedTab(
  panelValue: string | null,
  legacyActiveTabUrl: string | null | undefined,
): string | null {
  if (panelValue) return panelValue;
  if (!legacyActiveTabUrl) return null;
  const alreadyPrefixed =
    legacyActiveTabUrl.startsWith(GLOBAL_TAB_PREFIX) ||
    legacyActiveTabUrl.startsWith(PROJECT_PLACEMENT_PREFIX) ||
    legacyActiveTabUrl.startsWith(AM_TAB_PREFIX);
  return alreadyPrefixed ? legacyActiveTabUrl : GLOBAL_TAB_PREFIX + legacyActiveTabUrl;
}

/**
 * The active tab: the persisted pick when it still exists, otherwise the first
 * tab — which is the project whenever there is one (F2).
 */
export function resolveDefaultTab(tabs: readonly LibraryTab[], persisted: string | null): string | null {
  if (persisted && tabs.some(t => t.id === persisted)) return persisted;
  return tabs[0]?.id ?? null;
}

/**
 * The catalog URL a selection should write into the LibraryStore, or `null`
 * when the tab is not store-backed.
 *
 * The `null` case is the bypass: `LibraryStore.setActiveTab` silently ignores
 * anything that is not a known catalog URL, so a project or AM tab handed to it
 * would leave the store pointing at the PREVIOUS catalog — a selection that
 * looks persisted and is not.
 */
export function storeTabUrlOf(tabId: string): string | null {
  return tabId.startsWith(GLOBAL_TAB_PREFIX) ? tabId.slice(GLOBAL_TAB_PREFIX.length) : null;
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

  // The registry is the listing feed for the project and every subscribed
  // catalog (plan-723 §2.1). Read through the VERSION COUNTER, never through a
  // freshly built object — see the note on `getLibrarySourcesSnapshot`.
  const registryVersion = useSyncExternalStore(subscribeLibrarySources, getLibrarySourcesSnapshot);
  const registrySources = useMemo(() => listLibrarySources(), [registryVersion]);
  const dedupKeys = useMemo(() => projectDedupKeys(registrySources), [registrySources]);
  const amConnections = cloudSnapshot.connections;
  const tabs = useMemo(
    () => buildLibraryTabs(registrySources, amConnections),
    [registrySources, amConnections],
  );

  // Active tab: a registry tab id ("<provider>:<source>") or "am:<connectionId>".
  // Seeded from the panel key so the first paint after a reload already shows
  // the library the user last picked, rather than flashing the default.
  const [activeTabId, setActiveTabId] = useState<string | null>(() => {
    try { return localStorage.getItem(LS_KEY_PLANNER_ACTIVE_LIBRARY); } catch { return null; }
  });

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
    // Panel key first — it is the only record that can express every tab kind.
    try { localStorage.setItem(LS_KEY_PLANNER_ACTIVE_LIBRARY, id); } catch { /* ignore */ }
    // Store second, and ONLY for a store-backed catalog: handing it a project
    // or AM id would be silently dropped and leave the store pointing at the
    // previously picked catalog (plan-723 §2.4).
    const storeUrl = storeTabUrlOf(id);
    if (storeUrl !== null) store?.setActiveTab(storeUrl);
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

  // Resolve the active tab: panel key → legacy store selection (re-prefixed) →
  // the first tab, which is the project whenever there is one (F2).
  const resolvedActiveTabId = resolveDefaultTab(
    tabs,
    normalizePersistedTab(activeTabId, snapshot.activeTabUrl),
  );
  const activeTab = tabs.find(t => t.id === resolvedActiveTabId) ?? null;
  const isAmTab = resolvedActiveTabId?.startsWith(AM_TAB_PREFIX) ?? false;

  // Active (non-AM) source + the shared chip/filter pipeline. Every public
  // tab — the project, a remote URL, a GitHub scan — now runs through the same
  // CatalogBrowser shell driven by these values.
  const activeSource = activeTab && !isAmTab
    ? registrySources.find(s =>
        s.providerId === activeTab.providerId && s.source.id === activeTab.sourceId) ?? null
    : null;
  const activeError = activeTab?.error ?? null;
  const fullEntries = activeSource ? dedupedEntries(activeSource, dedupKeys) : [];
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

  // Library dropdown items — one per tab, carrying the kind/status the selector
  // needs to render its icon.
  const libraryItems: LibraryItem[] = tabs.map((tab): LibraryItem => ({
    id: tab.id,
    label: tab.label,
    kind: tab.kind,
    ...(tab.cloudStatus ? { cloudStatus: tab.cloudStatus } : {}),
    error: !!tab.error,
  }));

  const handleSelectLibrary = (id: string): void => {
    switchToLibrary(id);
  };

  // Chip row is redundant when a single facet already covers every entry
  // (e.g. one category == all items). Show it only when it adds filtering value.
  const showChips = chips.length > 1 || (chips.length === 1 && chips[0].count < fullEntries.length);

  // Resolve the single "empty" state shown instead of the card grid (null =>
  // render the grid). Order: no libraries → load error → no results.
  let emptyContent: ReactNode = null;
  if (tabs.length === 0) {
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
    // A source that has not published its listing yet is LOADING, not empty —
    // the distinction is what keeps a slow project from reading as a broken one.
    const loading = activeTab?.loaded === false;
    emptyContent = (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary' }}>
          {filtering ? 'No matching components' : loading ? 'Loading…' : 'No components'}
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

  // Virtual/DES and splat entries never take the placeholder path, so warming
  // them buys nothing — and a registry entry has no URL to test, which is why
  // the gate is on the entry KIND rather than on `prefetchableUrl` (plan-723).
  const warmable = entry.virtual !== true && !entry.splatUrl;

  const startPrefetchIntent = useCallback(() => {
    if (!warmable) return;
    cancelPrefetchIntent();
    prefetchTimer.current = setTimeout(() => {
      prefetchTimer.current = null;
      warmEntry(plugin, entry);
    }, PREFETCH_INTENT_MS);
  }, [entry, plugin, warmable, cancelPrefetchIntent]);

  const prefetchNow = useCallback(() => {
    if (!warmable) return;
    cancelPrefetchIntent();
    warmEntry(plugin, entry);
  }, [entry, plugin, warmable, cancelPrefetchIntent]);

  useEffect(() => cancelPrefetchIntent, [cancelPrefetchIntent]);

  // ── Visibility-scheduled preview (plan-372 §2.7/§2.8) ────────────────
  // Previews are pulled, not pushed: the card asks for its picture once it
  // enters the prefetch band and withdraws the request when it leaves. The
  // service de-duplicates by key, so re-entering the viewport is free.
  const { ref: cardRef, visible } = useThumbnailVisibility<HTMLDivElement>();
  // A project document has no `glbUrl` and its picture is written by the SAVE
  // path, not here — but until one exists the card may still render an
  // in-memory preview through the resolve path (plan-723 F9).
  const isProjectEntry = entry.id.startsWith(PROJECT_PLACEMENT_PREFIX);
  const needsPreview = !entry.thumbnailUrl && !entry.virtual && !entry.splatUrl
    && (!!entry.glbUrl || isProjectEntry);

  useEffect(() => {
    if (!needsPreview || !viewer) return;
    // Optional chaining is deliberate: a missing preview service must never
    // throw out of a card render. Constrained shells and test doubles hand back
    // viewers that do not carry it, and a card without a picture is a far
    // better outcome than a broken library panel.
    const service = viewer.thumbnails;
    if (!service?.isAvailable) return;  // WebGPU / unavailable — manual button remains
    const key = plannerThumbnailKey(entry.id);

    let cancelled = false;
    if (!visible) { service.cancel(key); return; }

    plugin.store.setThumbnailPending(entry.id, true);
    void service
      .enqueue(key, () => plugin.loadEntryModel(entry), 1)
      .then((blob) => {
        if (cancelled || !blob) return;
        plugin.store.setEntryThumbnail(entry.id, URL.createObjectURL(blob));
      })
      .finally(() => {
        if (!cancelled) plugin.store.setThumbnailPending(entry.id, false);
      });

    return () => { cancelled = true; };
  }, [visible, needsPreview, viewer, plugin, entry]);

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
      // No manual "Generate preview" for a project document: its thumbnail is
      // written by the SAVE path (`doc.thumbnail`), and this button's only
      // persistence route is the dev-server catalog middleware, which would
      // never reach the project (plan-723 F9). The automatic in-memory preview
      // above still fills the card.
      placeholderAction={isProjectEntry ? undefined : (
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
      )}
    />
    <Menu
      open={ctxPos !== null}
      onClose={() => setCtxPos(null)}
      anchorReference="anchorPosition"
      anchorPosition={ctxPos ? { top: ctxPos.y, left: ctxPos.x } : undefined}
    >
      {!isProjectEntry && (
        <MenuItem
          onClick={handleCtxUpdate}
          disabled={generating || !entry.glbUrl}
          sx={{ fontSize: 12 }}
        >
          <CameraAlt sx={{ fontSize: 14, mr: 1 }} />
          {entry.thumbnailUrl ? 'Update Preview' : 'Generate Preview'}
        </MenuItem>
      )}
      {/* Local work-folder GLBs can be opened in the asset editor. Saving
          always lands in library/Custom/, regardless of where the source
          asset lives. A project document has no `glbUrl` and is opened by its
          own path — hence the `isProjectEntry` arm (plan-723). */}
      {entry.localPath && (entry.glbUrl || isProjectEntry) && !entry.splatUrl && !entry.localPath.startsWith('splats/') && (
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
