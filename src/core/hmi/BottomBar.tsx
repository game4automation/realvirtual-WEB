// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Fragment, useState, useCallback, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';
import {
  TextField, InputAdornment, Box, Paper, IconButton, Button,
  Popover, Switch, Chip, FormControlLabel, Typography, Divider,
  List, ListItemButton, Tooltip, Link,
} from '@mui/material';
import { Search, Clear, MoreHoriz, CenterFocusStrong, AutoAwesome } from '@mui/icons-material';
import { useNodeFilter } from '../../hooks/use-node-filter';
import { useMobileLayout } from '../../hooks/use-mobile-layout';
import { useViewportInsets } from '../../hooks/use-viewport-insets';
import { useViewer } from '../../hooks/use-viewer';
import { componentColor } from './rv-inspector-helpers';
import { getCapabilities } from '../engine/rv-component-registry';
import { tooltipStore } from './tooltip/tooltip-store';
import { tooltipRegistry } from './tooltip/tooltip-registry';
import type { TooltipData } from './tooltip/tooltip-store';
import {
  loadSearchSettings, saveSearchSettings,
  getFilterSubscribers, type SearchSettings,
} from './search-settings-store';
import type { NodeSearchResult } from '../engine/rv-node-registry';
import { RvExtrasEditorPlugin } from './rv-extras-editor';
export { BOTTOM_BAR_HEIGHT } from './layout-constants';
import { RV_SCROLL_CLASS } from './shared-sx';
import {
  getSearchDiagnoseProvider,
  subscribeSearchDiagnoseProvider,
  getSearchDiagnoseProviderSnapshot,
} from '../../plugins/diagnose/search-diagnose-registry';
import { restoreFromHistory, runAiSearch } from './search-ai-store';
import {
  getSearchAiHistorySnapshot,
  subscribeSearchAiHistory,
} from './search-ai-history-store';
import { collectSearchAiContext, docHintsForNodes, withExtraDocHints } from './search-ai-context';
import { SearchAiDialog } from './SearchAiDialog';
import { groupSearchResults, flattenGroupedResults } from './search-result-grouping';
import { isSearchShortcut } from './search-shortcut';

const DEBOUNCE_MS = 250;
const ASK_AI_TOOLTIP = 'Ask the machine documentation (AI)';

/** Neutral accent for the untyped "All objects" category chip (Instrument Blue). */
const ALL_OBJECTS_COLOR = '#4fc3f7';

/**
 * Search-category chip style: filled in the component type's own color when
 * active — the same per-type colors as the hierarchy badges — and muted gray
 * when inactive. `color` must be a `#rrggbb` hex (hex-alpha suffixes appended).
 */
function categoryChipSx(active: boolean, color: string) {
  return {
    height: 18,
    fontSize: 9,
    fontWeight: active ? 700 : 400,
    bgcolor: active ? `${color}33` : 'transparent',
    color: active ? color : 'text.secondary',
    border: `1px solid ${active ? `${color}66` : 'rgba(255,255,255,0.1)'}`,
    '& .MuiChip-label': { px: 0.5 },
    cursor: 'pointer',
    '&:hover': { bgcolor: active ? `${color}40` : 'rgba(255,255,255,0.06)' },
  };
}

function truncateHistoryQuery(query: string, max = 40): string {
  return query.length > max ? `${query.slice(0, max - 1)}…` : query;
}

interface AskAiHistoryTooltipProps {
  historyEntries: ReturnType<typeof getSearchAiHistorySnapshot>;
  onOpenDialog: () => void;
  onOpenChange?: (open: boolean) => void;
  children: React.ReactElement;
}

/** Interactive Ask-AI tooltip with optional session-history restore actions. */
export function AskAiHistoryTooltip({
  historyEntries,
  onOpenDialog,
  onOpenChange,
  children,
}: AskAiHistoryTooltipProps) {
  const [open, setOpen] = useState(false);

  const setTooltipOpen = (next: boolean) => {
    setOpen(next);
    onOpenChange?.(next);
  };

  const restoreEntry = (entry: (typeof historyEntries)[number]) => {
    restoreFromHistory(entry);
    setTooltipOpen(false);
    onOpenDialog();
  };

  const title = historyEntries.length === 0
    ? ASK_AI_TOOLTIP
    : (
      <Box sx={{ minWidth: 220, maxWidth: 320 }}>
        <Typography sx={{ px: 1, pt: 0.75, pb: 0.5, fontSize: 11 }}>
          {ASK_AI_TOOLTIP}
        </Typography>
        <Divider />
        <Typography sx={{ px: 1, pt: 0.5, pb: 0.25, fontSize: 9, color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 0.4 }}>
          Recent answers
        </Typography>
        <List dense disablePadding aria-label="Recent AI answers">
          {historyEntries.map((entry) => (
            <ListItemButton
              key={`${entry.at}-${entry.query}`}
              title={entry.query}
              aria-label={`Restore AI answer: ${entry.query}`}
              onClick={() => restoreEntry(entry)}
              sx={{ px: 1, py: 0.5, minHeight: 0 }}
            >
              <Typography noWrap sx={{ fontSize: 11 }}>
                {truncateHistoryQuery(entry.query)}
              </Typography>
            </ListItemButton>
          ))}
        </List>
      </Box>
    );

  return (
    <Tooltip
      title={title}
      open={open}
      onOpen={() => setTooltipOpen(true)}
      onClose={() => setTooltipOpen(false)}
      leaveDelay={historyEntries.length > 0 ? 150 : 0}
      slotProps={historyEntries.length > 0 ? { tooltip: { sx: { p: 0, maxWidth: 320 } } } : undefined}
    >
      {children}
    </Tooltip>
  );
}

export function BottomBar() {
  const viewer = useViewer();
  const { filter, filteredNodes, tooMany, setFilter } = useNodeFilter();
  const MAX_DROPDOWN = 20;
  const displayedNodes = tooMany ? filteredNodes.slice(0, MAX_DROPDOWN) : filteredNodes;
  // Grouped dropdown (plan-283 review): categories with headers; keyboard
  // navigation runs over the SAME flattened order the groups render in.
  const resultGroups = useMemo(() => groupSearchResults(displayedNodes), [displayedNodes]);
  const flatResults = useMemo(() => flattenGroupedResults(resultGroups), [resultGroups]);
  const [inputValue, setInputValue] = useState('');
  const [settings, setSettings] = useState<SearchSettings>(loadSearchSettings);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const isMobile = useMobileLayout();
  // Hide the mobile search FAB while the planner library strip is open — it docks
  // bottom-right and would overlap the strip / its thumbnails.
  const lpm = viewer.leftPanelManager;
  const lpmSnap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const libraryOpen = isMobile && lpmSnap.right.activePanel === 'layout-planner';
  // Center the search bar over the actual 3D view (between the docked windows),
  // not the whole window, so it tracks the viewport as panels open/resize.
  const insets = useViewportInsets();
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  const [selectedIdx, setSelectedIdx] = useState(-1);
  const [dropdownVisible, setDropdownVisible] = useState(true);
  const listRef = useRef<HTMLUListElement>(null);
  const programmaticScroll = useRef(false);

  // Re-render when model loads (so groups icon appears)
  const [, setModelTick] = useState(0);
  useEffect(() => {
    const handler = () => setModelTick(t => t + 1);
    viewer.on('model-loaded', handler);
    return () => { viewer.off('model-loaded', handler); };
  }, [viewer]);

  // Settings popover anchor
  const [settingsAnchor, setSettingsAnchor] = useState<HTMLElement | null>(null);
  const settingsOpen = Boolean(settingsAnchor);

  // ── AI documentation search (plan-283) ──
  // The "Ask AI" affordance only exists while a diagnose provider is
  // registered (private SearchAiPlugin after a successful CONNECT capability
  // probe) — the search bar knows nothing about CONNECT.
  useSyncExternalStore(subscribeSearchDiagnoseProvider, getSearchDiagnoseProviderSnapshot);
  const aiAvailable = getSearchDiagnoseProvider() !== null;
  const aiHistory = useSyncExternalStore(
    subscribeSearchAiHistory,
    getSearchAiHistorySnapshot,
  );
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const aiTooltipOpenRef = useRef(false);
  const handleAskAi = useCallback(() => {
    const query = inputValueRef.current.trim();
    if (!query) return;                 // button is disabled when empty
    // plan-295: always attach machine status and add selected-node context when
    // available. F10: additionally boost the docs of the top
    // node search hits so a question that NAMES a part gets a part-specific answer
    // even without a selection.
    const machineContext = collectSearchAiContext(viewer);
    const queryHints = docHintsForNodes(viewer, filteredNodes.slice(0, 3).map((r) => r.path));
    runAiSearch(query, withExtraDocHints(machineContext, queryHints));
    setAiDialogOpen(true);
  }, [viewer, filteredNodes]);

  // ─── Collapsible search bar (desktop) ───────────────────────────
  // The bar shows only a magnifier by default and expands to the full
  // search field on click/hover, collapsing again once the mouse leaves
  // (unless it still has focus, text, or the settings popover is open).
  const [searchExpanded, setSearchExpanded] = useState(false);
  const collapseTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const inputValueRef = useRef(inputValue);
  inputValueRef.current = inputValue;
  const settingsOpenRef = useRef(settingsOpen);
  settingsOpenRef.current = settingsOpen;
  const barExpanded = isMobile || searchExpanded;

  const expandSearch = useCallback((focusInput: boolean) => {
    if (collapseTimer.current) { clearTimeout(collapseTimer.current); collapseTimer.current = null; }
    setSearchExpanded(true);
    if (focusInput) setTimeout(() => inputRef.current?.focus(), 60);
  }, []);

  const scheduleCollapse = useCallback(() => {
    if (collapseTimer.current) clearTimeout(collapseTimer.current);
    collapseTimer.current = setTimeout(() => {
      const hasFocus = !!inputRef.current && document.activeElement === inputRef.current;
      if (hasFocus || inputValueRef.current || settingsOpenRef.current || aiTooltipOpenRef.current) return;
      setSearchExpanded(false);
    }, 200);
  }, []);

  useEffect(() => () => { if (collapseTimer.current) clearTimeout(collapseTimer.current); }, []);

  // Global keyboard route to the search: `/` (Onshape pattern) or Ctrl/Cmd+K
  // expands + focuses the field. Guarded against editable contexts in
  // isSearchShortcut() so it never steals focus mid-typing; preventDefault
  // stops Firefox quick-find and the `/` being typed twice.
  useEffect(() => {
    if (isMobile) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (!isSearchShortcut(e)) return;
      e.preventDefault();
      expandSearch(true);
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [isMobile, expandSearch]);

  // Debounced filter
  const applyFilter = useCallback(
    (val: string) => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      debounceRef.current = setTimeout(() => setFilter(val), DEBOUNCE_MS);
    },
    [setFilter],
  );

  const handleChange = useCallback(
    (e: React.ChangeEvent<HTMLInputElement>) => {
      const val = e.target.value;
      setInputValue(val);
      setSelectedIdx(-1);
      setDropdownVisible(true);
      applyFilter(val);
    },
    [applyFilter],
  );

  const handleClear = useCallback(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    setInputValue('');
    setFilter('');
    setMobileSearchOpen(false);
    setSettingsAnchor(null);
  }, [setFilter]);

  // Enter → focus camera on highlighted nodes (use first MAX_DROPDOWN when many)
  const handleFocus = useCallback(() => {
    if (filteredNodes.length > 0) {
      const subset = tooMany ? filteredNodes.slice(0, MAX_DROPDOWN) : filteredNodes;
      const nodes = subset.map(r => r.node);
      viewer.fitToNodes(nodes);
    }
  }, [viewer, filteredNodes, tooMany]);

  // Hover search result → show component tooltips at the 3D object's position
  const searchHoverIds = useRef<string[]>([]);
  const handleResultHover = useCallback(
    (result: NodeSearchResult | null) => {
      // Clear previous hover tooltips and highlight
      for (const id of searchHoverIds.current) tooltipStore.hide(id);
      searchHoverIds.current = [];
      if (!result) { viewer.highlighter.clear(); return; }

      const node = viewer.registry?.getNode(result.path);
      if (!node) return;
      const rv = node.userData?.realvirtual as Record<string, unknown> | undefined;
      if (!rv) return;

      // Highlight the node in 3D
      viewer.highlighter.highlight(node, true);

      for (const key of Object.keys(rv)) {
        if (typeof rv[key] !== 'object') continue;
        const caps = getCapabilities(key);
        if (!caps.tooltipType) continue;
        const resolver = tooltipRegistry.getDataResolver(caps.tooltipType);
        if (!resolver) continue;
        const data = resolver(node, viewer);
        if (!data) continue;

        const hoverId = `search-hover:${caps.tooltipType}`;
        searchHoverIds.current.push(hoverId);
        tooltipStore.show({
          id: hoverId,
          lifecycle: 'hover',
          targetPath: result.path,
          data: data as TooltipData,
          mode: 'world',
          worldTarget: node,
          priority: caps.hoverPriority ?? 5,
        });
      }
    },
    [viewer],
  );

  // Click/select result → focus by path, select in hierarchy, hide dropdown
  const handleResultClick = useCallback(
    (result: NodeSearchResult) => {
      // Select the node (triggers pinned tooltips via GenericTooltipController)
      viewer.selectionManager.select(result.path);
      // Focus camera on the result (viewer auto-applies panel offset)
      viewer.focusByPath(result.path);
      // Select and reveal in hierarchy (opens panel if needed, expands ancestors, scrolls)
      const editorPlugin = viewer.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
      if (editorPlugin) editorPlugin.selectAndReveal(result.path);
      // Hide dropdown (keep search text)
      setDropdownVisible(false);
      setSelectedIdx(-1);
    },
    [viewer],
  );

  const visibleCount = flatResults.length;

  // Group headers sit between rows, so index-based child lookup no longer
  // works — rows carry data-result-idx for the keyboard-scroll instead.
  const scrollResultIntoView = useCallback((idx: number) => {
    programmaticScroll.current = true;
    listRef.current
      ?.querySelector(`[data-result-idx="${idx}"]`)
      ?.scrollIntoView({ block: 'nearest' });
  }, []);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        handleClear();
        setSelectedIdx(-1);
        (e.target as HTMLElement).blur();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIdx(prev => {
          const next = Math.min(prev + 1, visibleCount - 1);
          scrollResultIntoView(next);
          return next;
        });
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIdx(prev => {
          const next = Math.max(prev - 1, 0);
          scrollResultIntoView(next);
          return next;
        });
      } else if (e.key === 'Enter' && !e.shiftKey) {
        // Multiline field: plain Enter keeps its action semantics (no newline),
        // Shift+Enter falls through to insert a line break.
        e.preventDefault();
        if (selectedIdx >= 0 && selectedIdx < flatResults.length) {
          handleResultClick(flatResults[selectedIdx]);
        } else {
          handleFocus();
          setDropdownVisible(false);
          setSelectedIdx(-1);
        }
      }
    },
    [handleClear, handleFocus, handleResultClick, flatResults, selectedIdx, visibleCount, scrollResultIntoView],
  );

  // Cleanup debounce on unmount
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
  }, []);

  // ─── Settings handlers ──────────────────────────────────────────

  const updateSettings = useCallback((patch: Partial<SearchSettings>) => {
    setSettings(prev => {
      const next = { ...prev, ...patch };
      saveSearchSettings(next);
      return next;
    });
  }, []);

  // Re-trigger filter when settings change (highlight or type toggles)
  const settingsRef = useRef(settings);
  settingsRef.current = settings;
  useEffect(() => {
    if (filter) setFilter(filter);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings.highlightEnabled, settings.nodesEnabled, settings.disabledTypes.join(',')]);

  // Toggle every component type that shares one filter label at once. Many
  // types collapse to a single label — e.g. all library *Behavior components
  // default to 'Behavior' — so the settings row must drive the whole group,
  // not one arbitrary member.
  const toggleGroup = useCallback((ids: readonly string[], enable: boolean) => {
    setSettings(prev => {
      const disabled = new Set(prev.disabledTypes);
      for (const id of ids) { if (enable) disabled.delete(id); else disabled.add(id); }
      const next = { ...prev, disabledTypes: [...disabled] };
      saveSearchSettings(next);
      return next;
    });
  }, []);

  // "All" / "None" shortcuts: flip every category (typed groups + untyped
  // objects) at once. Reads the live subscriber list so late-registered types
  // are covered too.
  const setAllCategories = useCallback((enable: boolean) => {
    setSettings(prev => {
      const disabledTypes = enable ? [] : getFilterSubscribers().map(s => s.id);
      const next = { ...prev, nodesEnabled: enable, disabledTypes };
      saveSearchSettings(next);
      return next;
    });
  }, []);

  // Collapse filter subscribers by display label so N types sharing a label
  // (the 'Behavior' default across every library component) render as ONE
  // category row instead of a stack of identical "Behavior" toggles. Each
  // group carries all its member ids so a single toggle drives the whole set.
  const subscribers = getFilterSubscribers();
  const filterGroups = useMemo(() => {
    const byLabel = new Map<string, { label: string; ids: string[]; componentType: string }>();
    for (const sub of subscribers) {
      const existing = byLabel.get(sub.label);
      if (existing) existing.ids.push(sub.id);
      else byLabel.set(sub.label, { label: sub.label, ids: [sub.id], componentType: sub.componentType });
    }
    return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
    // subscribers is a stable module-level array; re-group when its length grows
    // (types self-register during async model load) or the popover re-opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subscribers.length, settingsOpen]);
  const showResults = filter && filteredNodes.length > 0 && dropdownVisible;
  const resultCount = filteredNodes.length;

  // Count badge text
  const badgeText = filter ? `${resultCount} found` : null;

  return (
    <>
    {/* Mobile: search toggle FAB (hidden while the library strip is open) */}
    {isMobile && !libraryOpen && (
      <IconButton
        onClick={() => mobileSearchOpen ? handleClear() : setMobileSearchOpen(true)}
        sx={{
          position: 'fixed',
          bottom: 'calc(60px + env(safe-area-inset-bottom, 0px))',
          right: 12,
          zIndex: 1201,
          bgcolor: 'background.paper',
          boxShadow: 4,
          width: 40,
          height: 40,
          pointerEvents: 'auto',
        }}
      >
        {mobileSearchOpen ? <Clear /> : <Search />}
      </IconButton>
    )}
    <Box
      sx={{
        position: 'fixed',
        bottom: isMobile ? 'calc(56px + env(safe-area-inset-bottom, 0px))' : 8,
        left: insets.left,
        right: insets.right,
        zIndex: 1200,
        pointerEvents: 'none',
        ...(isMobile && {
          transform: mobileSearchOpen ? 'translateY(0)' : 'translateY(calc(100% + 80px))',
          transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
        }),
      }}
    >
      {/* Centered search bar + results */}
      <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
        {/* Result dropdown (above search bar) */}
        {showResults && (
          <Paper
            elevation={4}
            className={RV_SCROLL_CLASS}
            onScroll={() => { if (programmaticScroll.current) programmaticScroll.current = false; else if (selectedIdx >= 0) setSelectedIdx(-1); }}
            sx={{
              width: { xs: 'calc(100vw - 24px)', sm: aiAvailable ? 'min(560px, calc(100vw - 24px))' : 388 },
              mb: 0.5,
              borderRadius: 2,
              pointerEvents: 'auto',
            }}
          >
            <List dense disablePadding ref={listRef}>
              {resultGroups.map((group) => (
                <Fragment key={group.label}>
                  {/* Category header — ink-low, passive (never selectable) */}
                  <Typography
                    noWrap
                    sx={{
                      fontSize: 10, fontWeight: 600, letterSpacing: 0.4,
                      color: 'text.disabled', px: 1.5, pt: 0.5, pb: 0.25,
                    }}
                  >
                    {group.label} ({group.items.length})
                  </Typography>
                  {group.items.map((r, gi) => {
                    const i = group.startIndex + gi;   // index in flatResults
                    const nodeName = r.path.split('/').pop() ?? r.path;
                    const label = r.displayText ?? nodeName;
                    // Show where the match was found: matchedBy component, or primary type for name matches
                    const badgeType = r.matchedBy ?? (r.types.length > 0 ? r.types[0] : 'Node');
                    const isSelected = i === selectedIdx;
                    return (
                      <Tooltip key={r.path} title={r.path} placement="right" enterDelay={800} slotProps={{ tooltip: { sx: { fontSize: 10 } } }}>
                      <ListItemButton
                        data-result-idx={i}
                        selected={isSelected}
                        onClick={() => { handleResultHover(null); handleResultClick(r); }}
                        onMouseEnter={() => { setSelectedIdx(i); handleResultHover(r); }}
                        onMouseMove={() => { if (selectedIdx !== i) { setSelectedIdx(i); handleResultHover(r); } }}
                        onMouseLeave={() => handleResultHover(null)}
                        sx={{ py: 0.25, px: 1.5, minHeight: 0 }}
                      >
                        <Typography variant="body2" noWrap sx={{ flex: 1 }}>{label}</Typography>
                        {badgeType && (
                          <Typography variant="caption" noWrap sx={{
                            ml: 0.5, fontSize: 10, fontWeight: 600,
                            color: componentColor(badgeType), opacity: 0.8,
                          }}>
                            {badgeType}
                          </Typography>
                        )}
                      </ListItemButton>
                      </Tooltip>
                    );
                  })}
                </Fragment>
              ))}
              {resultCount > MAX_DROPDOWN && (
                <Typography variant="caption" sx={{ display: 'block', textAlign: 'center', py: 0.5, color: 'text.disabled' }}>
                  and {resultCount - MAX_DROPDOWN} more — type to narrow
                </Typography>
              )}
            </List>
          </Paper>
        )}

        {/* Search bar — collapses to a magnifier on desktop, expands on click/hover */}
        <Paper
          elevation={4}
          data-ui-panel
          onMouseEnter={isMobile ? undefined : () => expandSearch(false)}
          onMouseLeave={isMobile ? undefined : scheduleCollapse}
          sx={{
            py: 0,
            pl: 0,
            pr: barExpanded ? 1.5 : 0,
            borderRadius: 2,
            pointerEvents: 'auto',
            // With the AI provider registered the expanded bar takes typed
            // questions, not just node names — give it room (plan-283).
            width: barExpanded
              ? { xs: 'calc(100vw - 24px)', sm: aiAvailable ? 'min(560px, calc(100vw - 24px))' : 380 }
              : 40,
            // minHeight instead of a fixed height: long AI questions wrap and the
            // bar grows upward (the container is bottom-anchored).
            minHeight: 40,
            display: 'flex',
            alignItems: 'center',
            overflow: 'hidden',
            transition: 'width 0.25s cubic-bezier(0.4, 0, 0.2, 1), padding 0.25s',
          }}
        >
          {/* Magnifier — always visible; click (or `/`) to open + focus */}
          <Tooltip title="Search ( / )">
            <IconButton
              size="small"
              aria-label="Search"
              onClick={() => expandSearch(true)}
              sx={{ width: 40, height: 40, flexShrink: 0, color: filter ? 'primary.main' : 'text.secondary' }}
            >
              <Search fontSize="small" />
            </IconButton>
          </Tooltip>

          {/* Collapsible content */}
          <Box
            sx={{
              display: 'flex',
              alignItems: 'center',
              flex: 1,
              minWidth: 0,
              // Collapsed: the hidden multiline content must not contribute to
              // layout height, otherwise a wrapped query/placeholder keeps the
              // 40px pill tall while only the magnifier is visible.
              maxHeight: barExpanded ? 'none' : 40,
              overflow: 'hidden',
              opacity: barExpanded ? 1 : 0,
              pointerEvents: barExpanded ? 'auto' : 'none',
              transition: 'opacity 0.2s',
            }}
          >
            <TextField
              placeholder="Search drives, sensors, objects..."
              size="small"
              fullWidth
              variant="standard"
              multiline
              maxRows={4}
              value={inputValue}
              inputRef={inputRef}
              onChange={handleChange}
              onKeyDown={handleKeyDown}
              onFocus={() => expandSearch(false)}
              onBlur={isMobile ? undefined : scheduleCollapse}
              slotProps={{
                input: {
                  disableUnderline: true,
                  endAdornment: (
                    <InputAdornment position="end">
                      {badgeText && (
                        <Typography variant="caption" sx={{ color: 'primary.main', mr: 0.5, whiteSpace: 'nowrap' }}>
                          {badgeText}
                        </Typography>
                      )}
                      {/* Focus button (touch alternative to Enter) */}
                      {filter && filteredNodes.length > 0 && (
                        <IconButton size="small" onClick={handleFocus} sx={{ p: 0.25 }} title="Focus camera (Enter)">
                          <CenterFocusStrong sx={{ fontSize: 16, color: 'primary.main' }} />
                        </IconButton>
                      )}
                      {filter && (
                        <IconButton size="small" onClick={handleClear} sx={{ p: 0.25 }}>
                          <Clear sx={{ fontSize: 16, color: 'text.secondary' }} />
                        </IconButton>
                      )}
                    </InputAdornment>
                  ),
                },
              }}
            />
            <IconButton
              size="small"
              onClick={(e) => setSettingsAnchor(e.currentTarget)}
              sx={{ ml: 0.5, p: 0.25 }}
            >
              <MoreHoriz sx={{ fontSize: 18, color: 'text.secondary' }} />
            </IconButton>
            {/* Ask AI — only rendered while a diagnose provider is registered
                (plan-283 capability gate). Disabled until a question is typed;
                the span wrapper keeps the tooltip alive on the disabled button. */}
            {aiAvailable && (
              <AskAiHistoryTooltip
                historyEntries={aiHistory}
                onOpenDialog={() => setAiDialogOpen(true)}
                onOpenChange={(open) => {
                  aiTooltipOpenRef.current = open;
                  if (!open && !isMobile) scheduleCollapse();
                }}
              >
                <span style={{ flexShrink: 0 }}>
                  <Button
                    size="small"
                    startIcon={<AutoAwesome sx={{ fontSize: 14 }} />}
                    onClick={handleAskAi}
                    disabled={!inputValue.trim()}
                    aria-label={ASK_AI_TOOLTIP}
                    sx={{ ml: 0.5, px: 1, minWidth: 0, whiteSpace: 'nowrap', textTransform: 'none', fontSize: 12 }}
                  >
                    Ask AI
                  </Button>
                </span>
              </AskAiHistoryTooltip>
            )}
          </Box>
        </Paper>
      </Box>

      {/* AI answer dialog (plan-283) — closing aborts an in-flight request. */}
      <SearchAiDialog open={aiDialogOpen} onClose={() => setAiDialogOpen(false)} />

      {/* Camera / view controls live in the top app bar (TopBar.tsx right
          region). The Groups overlay moved OUT of this component in plan-387:
          it is mounted as a sibling of <BottomBar /> in App.tsx so it survives
          in the Viewer workspace, where the search bar is gated away. It always
          portalled to #rv-floating-panel-root and owned its own open state, so
          the move is visually a no-op. */}

      {/* Search settings popover */}
      <Popover
        open={settingsOpen}
        anchorEl={settingsAnchor}
        onClose={() => { setSettingsAnchor(null); if (!isMobile) scheduleCollapse(); }}
        anchorOrigin={{ vertical: 'top', horizontal: 'center' }}
        transformOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        slotProps={{ paper: { sx: { p: 1.5, minWidth: 232, pointerEvents: 'auto' } } }}
      >
        <Typography variant="subtitle2" sx={{ mb: 1 }}>Search Settings</Typography>
        <FormControlLabel
          control={
            <Switch
              size="small"
              checked={settings.highlightEnabled}
              onChange={(_, checked) => updateSettings({ highlightEnabled: checked })}
            />
          }
          label={<Typography variant="body2">Highlight in 3D</Typography>}
          sx={{ ml: 0 }}
        />
        <Divider sx={{ my: 1 }} />
        {/* Category filter — one chip per display label (same chip style as the
            hierarchy type filter). Multiple component types that share a label
            (all library *Behavior default to 'Behavior') collapse into a single
            chip here; toggling it drives the whole group. */}
        <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', mb: 0.75 }}>
          <Typography
            variant="caption"
            sx={{ color: 'text.disabled', fontWeight: 600, letterSpacing: 0.4 }}
          >
            INCLUDE IN RESULTS
          </Typography>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Link component="button" type="button" underline="hover"
              onClick={() => setAllCategories(true)}
              sx={{ fontSize: 11, color: 'text.secondary' }}>
              All
            </Link>
            <Link component="button" type="button" underline="hover"
              onClick={() => setAllCategories(false)}
              sx={{ fontSize: 11, color: 'text.secondary' }}>
              None
            </Link>
          </Box>
        </Box>
        <Box
          className={RV_SCROLL_CLASS}
          sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-start', gap: 0.5, maxHeight: 260, overflowY: 'auto' }}
        >
          <Chip
            label="All objects"
            size="small"
            onClick={() => updateSettings({ nodesEnabled: !settings.nodesEnabled })}
            sx={categoryChipSx(settings.nodesEnabled, ALL_OBJECTS_COLOR)}
          />
          {filterGroups.map((group) => {
            const enabled = group.ids.some((id) => !settings.disabledTypes.includes(id));
            return (
              <Chip
                key={group.label}
                label={group.label}
                size="small"
                onClick={() => toggleGroup(group.ids, !enabled)}
                sx={categoryChipSx(enabled, componentColor(group.componentType))}
              />
            );
          })}
        </Box>
      </Popover>
    </Box>
    </>
  );
}
