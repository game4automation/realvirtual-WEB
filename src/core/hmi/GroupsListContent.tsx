// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GroupsListContent — the shared group/auto-filter/overlay visibility list:
 * search row, per-row eye toggle + isolate button, show-all, hover-highlight
 * and double-click-to-fit. Extracted from GroupsOverlay so the same content
 * renders both in the floating "Display" panel (HMI) and inside the editor's
 * Kinematics window (Groups section, overlays hidden there).
 *
 * All visibility state persists via `group-visibility-store` (localStorage);
 * the list refreshes on `groups-changed` and `model-loaded`.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Box, IconButton, Typography, List,
  ListItem, ListItemText, InputBase, Divider,
} from '@mui/material';
import { Visibility, VisibilityOff, FilterCenterFocus, Search, Close } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import type { RVViewer } from '../rv-viewer';
import { RV_SCROLL_CLASS } from './shared-sx';
import {
  loadGroupVisibilitySettings,
  saveGroupVisibilitySettings,
} from './group-visibility-store';
import type { GroupInfo } from '../engine/rv-group-registry';
import type { AutoFilterGroup } from '../engine/rv-auto-filter-registry';
import { useOverlayVisibilityState } from '../../hooks/use-overlay-visible';
import { setOverlayVisible, showAllOverlays } from '../overlay-visibility-store';

/** Persist the CURRENT visibility/isolate state of both registries. Reads
 *  the isolate state straight from the registries so it works without access
 *  to the list component's internals (used by close handlers). */
export function persistCurrentGroupVisibility(viewer: RVViewer): void {
  const current = loadGroupVisibilitySettings();
  const hiddenGroups = viewer.groups
    ? viewer.groups.getAll().filter(g => !g.visible).map(g => g.name)
    : current.hiddenGroups;
  const hiddenAutoFilters = viewer.autoFilters
    ? viewer.autoFilters.getAll().filter(f => !f.visible).map(f => f.type)
    : current.hiddenAutoFilters ?? [];
  saveGroupVisibilitySettings({
    ...current,
    hiddenGroups,
    isolatedGroup: viewer.groups?.isolatedGroupName ?? null,
    hiddenAutoFilters,
    isolatedAutoFilter: viewer.autoFilters?.isolatedFilterType ?? null,
  });
}

export function GroupsListContent({
  showOverlaysSection = true,
  active = true,
  hoverPreview = 'outline',
}: {
  /** Render the "Overlays" category rows (HMI Display panel only). */
  showOverlaysSection?: boolean;
  /** Gate for the load-and-apply-persisted-state effect (panel visibility). */
  active?: boolean;
  /** Hover-preview visual for group/filter rows: 'outline' = OutlinePass
   *  silhouette (default), 'overlay' = transparent fill + edges on every
   *  member mesh (the editor's Kinematics window uses this so each grouped
   *  mesh reads clearly, not just the combined silhouette). */
  hoverPreview?: 'outline' | 'overlay';
}) {
  const viewer = useViewer();
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [autoFilters, setAutoFilters] = useState<AutoFilterGroup[]>([]);
  const [isolatedGroup, setIsolatedGroup] = useState<string | null>(
    () => viewer.groups?.isolatedGroupName ?? null,
  );
  const [isolatedFilter, setIsolatedFilter] = useState<string | null>(
    () => viewer.autoFilters?.isolatedFilterType ?? null,
  );
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  // Trigger re-render when visibility changes
  const [, setTick] = useState(0);
  // Overlay-visibility categories (plan-250) — only those with a live producer.
  const overlayState = useOverlayVisibilityState();
  const overlayCats = showOverlaysSection ? overlayState.present : [];

  /** Toggle an overlay category and force a redraw so on-demand overlays
   *  (highlights, gizmos) update immediately in render-on-demand mode. */
  const handleOverlayToggle = useCallback((id: import('../overlay-visibility-store').OverlayCategory, visible: boolean) => {
    setOverlayVisible(id, visible);
    viewer.markRenderDirty?.();
  }, [viewer]);

  const filteredGroups = useMemo(() => {
    const settings = loadGroupVisibilitySettings();
    const excluded = settings.excludedFromOverlay ?? [];
    let result = groups.filter(g => !excluded.includes(g.name));
    if (filter) {
      const lc = filter.toLowerCase();
      result = result.filter(g => g.name.toLowerCase().includes(lc));
    }
    return result;
  }, [groups, filter]);

  const filteredAutoFilters = useMemo(() => {
    if (!filter) return autoFilters;
    const lc = filter.toLowerCase();
    return autoFilters.filter(f => f.label.toLowerCase().includes(lc));
  }, [autoFilters, filter]);

  // Refresh when group memberships change through editing (asset editor)
  useEffect(() => {
    const off = viewer.on('groups-changed', () => {
      setGroups(viewer.groups ? viewer.groups.getAll() : []);
      setTick(t => t + 1);
    });
    return off;
  }, [viewer]);

  // Load groups + auto-filters when the host becomes active or model changes
  useEffect(() => {
    if (!active) return;
    if (viewer.groups) setGroups(viewer.groups.getAll());
    else setGroups([]);
    if (viewer.autoFilters) setAutoFilters(viewer.autoFilters.getAll());
    else setAutoFilters([]);

    // Apply persisted visibility state
    const saved = loadGroupVisibilitySettings();

    // Auto-filters
    if (viewer.autoFilters) {
      const hiddenAF = saved.hiddenAutoFilters ?? [];
      for (const type of hiddenAF) {
        viewer.autoFilters.setVisible(type, false);
      }
      if (saved.isolatedAutoFilter && viewer.autoFilters.get(saved.isolatedAutoFilter)) {
        viewer.autoFilters.isolate(saved.isolatedAutoFilter);
        setIsolatedFilter(saved.isolatedAutoFilter);
        viewer.markShadowsDirty();
      }
    }

    // Groups
    if (viewer.groups) {
      if (!saved.isolatedAutoFilter) {
        if (saved.isolatedGroup && viewer.groups.get(saved.isolatedGroup)) {
          viewer.groups.isolate(saved.isolatedGroup);
          setIsolatedGroup(saved.isolatedGroup);
          viewer.markShadowsDirty();
        } else if (saved.hiddenGroups.length > 0) {
          for (const name of saved.hiddenGroups) {
            viewer.groups.setVisible(name, false);
          }
          viewer.markShadowsDirty();
        }
      }
    }
    setTick(t => t + 1);
  }, [active, viewer, viewer.groups, viewer.autoFilters]);

  // Also refresh when model loads
  useEffect(() => {
    const off = viewer.on('model-loaded', ({ result }) => {
      if (viewer.groups) {
        setGroups(viewer.groups.getAll());
        const saved = loadGroupVisibilitySettings();

        // Auto-exclude kinematic groups from overlay
        const kinNames = result.kinematicGroupNames ?? [];
        if (kinNames.length > 0) {
          const existingExcluded = saved.excludedFromOverlay ?? [];
          const merged = [...new Set([...existingExcluded, ...kinNames])];
          saved.excludedFromOverlay = merged;
          saveGroupVisibilitySettings(saved);
        }

        const defaultHidden = saved.defaultHiddenGroups ?? [];
        viewer.groups.setDefaultHiddenGroups(defaultHidden);

        if (saved.isolatedGroup && viewer.groups.get(saved.isolatedGroup)) {
          viewer.groups.isolate(saved.isolatedGroup);
          setIsolatedGroup(saved.isolatedGroup);
          viewer.markShadowsDirty();
        } else if (saved.hiddenGroups.length > 0) {
          for (const name of saved.hiddenGroups) {
            viewer.groups.setVisible(name, false);
          }
          viewer.markShadowsDirty();
        } else if (defaultHidden.length > 0) {
          for (const name of defaultHidden) {
            viewer.groups.setVisible(name, false);
          }
          viewer.markShadowsDirty();
        }
      }

      // Auto-filters
      if (viewer.autoFilters) {
        setAutoFilters(viewer.autoFilters.getAll());
        const saved = loadGroupVisibilitySettings();
        const hiddenAF = saved.hiddenAutoFilters ?? [];
        for (const type of hiddenAF) {
          viewer.autoFilters.setVisible(type, false);
        }
        if (saved.isolatedAutoFilter && viewer.autoFilters.get(saved.isolatedAutoFilter)) {
          viewer.autoFilters.isolate(saved.isolatedAutoFilter);
          setIsolatedFilter(saved.isolatedAutoFilter);
          viewer.markShadowsDirty();
        }
      }

      setTick(t => t + 1);
    });
    return off;
  }, [viewer]);

  // ─── Group handlers ───────────────────────────────────────────

  const handleToggle = useCallback((name: string, visible: boolean) => {
    if (!viewer.groups) return;
    viewer.groups.setVisible(name, visible);
    setIsolatedGroup(null);
    setIsolatedFilter(null);
    if (viewer.autoFilters?.isIsolateActive) viewer.autoFilters.showAll();
    viewer.markShadowsDirty();
    setTick(t => t + 1);
    const current = loadGroupVisibilitySettings();
    const hidden = viewer.groups.getAll().filter(g => !g.visible).map(g => g.name);
    saveGroupVisibilitySettings({
      ...current,
      hiddenGroups: hidden,
      isolatedGroup: null,
      isolatedAutoFilter: null,
    });
  }, [viewer]);

  const handleIsolate = useCallback((name: string) => {
    if (!viewer.groups) return;
    // Clear any auto-filter isolate first
    if (viewer.autoFilters?.isIsolateActive) {
      viewer.autoFilters.showAll();
      setIsolatedFilter(null);
    }
    const current = loadGroupVisibilitySettings();
    if (isolatedGroup === name) {
      viewer.groups.showAll();
      setIsolatedGroup(null);
      viewer.markShadowsDirty();
      setTick(t => t + 1);
      const hidden = viewer.groups.getAll().filter(g => !g.visible).map(g => g.name);
      saveGroupVisibilitySettings({
        ...current,
        hiddenGroups: hidden,
        isolatedGroup: null,
        isolatedAutoFilter: null,
      });
    } else {
      viewer.groups.isolate(name);
      setIsolatedGroup(name);
      viewer.markShadowsDirty();
      setTick(t => t + 1);
      saveGroupVisibilitySettings({
        ...current,
        hiddenGroups: [],
        isolatedGroup: name,
        isolatedAutoFilter: null,
      });
    }
  }, [viewer, isolatedGroup]);

  // ─── Auto-filter handlers ─────────────────────────────────────

  const handleFilterToggle = useCallback((type: string, visible: boolean) => {
    if (!viewer.autoFilters) return;
    viewer.autoFilters.setVisible(type, visible);
    setIsolatedFilter(null);
    setIsolatedGroup(null);
    if (viewer.groups?.isIsolateActive) viewer.groups.showAll();
    viewer.markShadowsDirty();
    setTick(t => t + 1);
    const current = loadGroupVisibilitySettings();
    const hiddenAF = viewer.autoFilters.getAll().filter(f => !f.visible).map(f => f.type);
    saveGroupVisibilitySettings({
      ...current,
      hiddenAutoFilters: hiddenAF,
      isolatedGroup: null,
      isolatedAutoFilter: null,
    });
  }, [viewer]);

  const handleFilterIsolate = useCallback((type: string) => {
    if (!viewer.autoFilters) return;
    // Clear any group isolate first
    if (viewer.groups?.isIsolateActive) {
      viewer.groups.showAll();
      setIsolatedGroup(null);
    }
    const current = loadGroupVisibilitySettings();
    if (isolatedFilter === type) {
      viewer.autoFilters.showAll();
      setIsolatedFilter(null);
      viewer.markShadowsDirty();
      setTick(t => t + 1);
      const hiddenAF = viewer.autoFilters.getAll().filter(f => !f.visible).map(f => f.type);
      saveGroupVisibilitySettings({
        ...current,
        hiddenAutoFilters: hiddenAF,
        isolatedGroup: null,
        isolatedAutoFilter: null,
      });
    } else {
      viewer.autoFilters.isolate(type);
      setIsolatedFilter(type);
      viewer.markShadowsDirty();
      setTick(t => t + 1);
      saveGroupVisibilitySettings({
        ...current,
        hiddenAutoFilters: [],
        isolatedGroup: null,
        isolatedAutoFilter: type,
      });
    }
  }, [viewer, isolatedFilter]);

  // ─── Shared handlers ──────────────────────────────────────────

  const handleShowAll = useCallback(() => {
    if (viewer.groups) viewer.groups.showAll();
    if (viewer.autoFilters) viewer.autoFilters.showAll();
    showAllOverlays();
    setIsolatedGroup(null);
    setIsolatedFilter(null);
    viewer.markRenderDirty?.();
    viewer.markShadowsDirty();
    setTick(t => t + 1);
    const current = loadGroupVisibilitySettings();
    const hiddenGroups = viewer.groups
      ? viewer.groups.getAll().filter(g => !g.visible).map(g => g.name)
      : [];
    saveGroupVisibilitySettings({
      ...current,
      hiddenGroups,
      isolatedGroup: null,
      hiddenAutoFilters: [],
      isolatedAutoFilter: null,
    });
  }, [viewer]);

  const handleHover = useCallback((nodes: import('three').Object3D[] | null) => {
    if (nodes && nodes.length > 0) {
      viewer.highlighter.highlightMultiple(
        nodes,
        hoverPreview === 'overlay' ? { visual: 'overlay' } : undefined,
      );
    } else {
      viewer.highlighter.clear();
    }
  }, [viewer, hoverPreview]);

  const handleDoubleClick = useCallback((nodes: import('three').Object3D[]) => {
    if (nodes.length > 0) {
      viewer.fitToNodes(nodes);
    }
  }, [viewer]);

  const hasGroups = filteredGroups.length > 0;
  const hasFilters = filteredAutoFilters.length > 0;
  const hasOverlays = overlayCats.length > 0;
  const hasContent = hasGroups || hasFilters || hasOverlays || autoFilters.length > 0 || groups.length > 0;
  const anyHidden = groups.some(g => !g.visible) || autoFilters.some(f => !f.visible)
    || overlayCats.some(c => overlayState.hidden.has(c.id));

  if (!hasContent) {
    return (
      <Box sx={{ p: 2, textAlign: 'center' }}>
        <Typography variant="body2" color="text.secondary">
          No groups found in this model
        </Typography>
      </Box>
    );
  }

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', flex: 1, minHeight: 0 }}>
      {/* Filter + Show All row */}
      <Box sx={{
        display: 'flex', alignItems: 'center', px: 1, py: 0.25,
        borderBottom: '1px solid rgba(255,255,255,0.08)',
      }}>
        <Search sx={{ fontSize: 16, color: 'rgba(255,255,255,0.3)', mr: 0.5, flexShrink: 0 }} />
        <InputBase
          inputRef={filterRef}
          placeholder="Filter..."
          value={filter}
          onChange={e => setFilter(e.target.value)}
          sx={{
            flex: 1, fontSize: 12, color: 'white',
            '& input': { py: 0.25, px: 0 },
            '& input::placeholder': { color: 'rgba(255,255,255,0.3)', opacity: 1 },
          }}
        />
        {filter && (
          <IconButton size="small" onClick={() => setFilter('')} sx={{ p: 0.25, color: 'rgba(255,255,255,0.4)' }}>
            <Close sx={{ fontSize: 14 }} />
          </IconButton>
        )}
        <IconButton
          size="small"
          onClick={handleShowAll}
          title="Show all"
          sx={{
            p: 0.3, ml: 0.5, flexShrink: 0,
            color: anyHidden ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.15)',
          }}
          disabled={!anyHidden}
        >
          <Visibility sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      {/* Scrollable list with filters + groups */}
      <List
        dense
        disablePadding
        className={RV_SCROLL_CLASS}
        sx={{ flex: 1, overflow: 'auto', minHeight: 0 }}
      >
        {/* ─── Overlays section (plan-250) ─── */}
        {hasOverlays && (
          <>
            <ListItem sx={{ py: 0.25, px: 1, pointerEvents: 'none' }}>
              <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.35)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
                Overlays
              </Typography>
            </ListItem>
            {overlayCats.map((cat) => {
              const visible = !overlayState.hidden.has(cat.id);
              return (
                <ListItem
                  key={`ov-${cat.id}`}
                  sx={{
                    py: 0.25, px: 1,
                    opacity: visible ? 1 : 0.4,
                    '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
                  }}
                >
                  <ListItemText
                    primary={cat.label}
                    primaryTypographyProps={{
                      variant: 'body2', noWrap: true,
                      sx: { cursor: 'default', userSelect: 'none', fontSize: 13 },
                    }}
                    sx={{ minWidth: 0, my: 0 }}
                  />
                  <IconButton
                    size="small"
                    onClick={() => handleOverlayToggle(cat.id, !visible)}
                    title={visible ? `Hide ${cat.label}` : `Show ${cat.label}`}
                    sx={{
                      p: 0.3,
                      color: visible ? 'rgba(255,255,255,0.5)' : 'rgba(255,255,255,0.2)',
                      '&:hover': { color: visible ? 'white' : 'rgba(255,255,255,0.5)' },
                    }}
                  >
                    {visible
                      ? <Visibility sx={{ fontSize: 16 }} />
                      : <VisibilityOff sx={{ fontSize: 16 }} />}
                  </IconButton>
                </ListItem>
              );
            })}
            {(hasFilters || hasGroups) && (
              <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', my: 0.25 }} />
            )}
          </>
        )}

        {/* ─── Auto-filter section ─── */}
        {hasFilters && (
          <>
            <ListItem sx={{ py: 0.25, px: 1, pointerEvents: 'none' }}>
              <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.35)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
                Filters
              </Typography>
            </ListItem>
            {filteredAutoFilters.map((af) => {
              const isIso = isolatedFilter === af.type;
              return (
                <ListItem
                  key={`af-${af.type}`}
                  sx={{
                    py: 0.25,
                    px: 1,
                    opacity: af.visible ? 1 : 0.4,
                    cursor: 'pointer',
                    '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
                  }}
                  onMouseEnter={() => handleHover(af.nodes)}
                  onMouseLeave={() => handleHover(null)}
                  onDoubleClick={() => handleDoubleClick(af.nodes)}
                >
                  {/* Colored dot */}
                  <Box sx={{
                    width: 8, height: 8, borderRadius: '50%',
                    bgcolor: af.badgeColor, mr: 1, flexShrink: 0,
                  }} />
                  <ListItemText
                    primary={af.label}
                    primaryTypographyProps={{
                      variant: 'body2',
                      noWrap: true,
                      sx: {
                        cursor: 'default',
                        userSelect: 'none',
                        fontSize: 13,
                        fontWeight: isIso ? 700 : 400,
                        color: isIso ? '#4fc3f7' : 'inherit',
                      },
                    }}
                    sx={{ minWidth: 0, my: 0 }}
                  />
                  {/* Count badge */}
                  <Typography variant="caption" sx={{
                    color: 'rgba(255,255,255,0.3)',
                    fontSize: 10, mr: 0.5, flexShrink: 0,
                  }}>
                    {af.nodes.length}
                  </Typography>
                  <IconButton
                    size="small"
                    onClick={(e) => { e.stopPropagation(); handleFilterIsolate(af.type); }}
                    title={isIso ? `Stop isolating "${af.label}"` : `Isolate "${af.label}"`}
                    sx={{
                      p: 0.3,
                      color: isIso ? '#4fc3f7' : 'rgba(255,255,255,0.25)',
                      '&:hover': { color: '#4fc3f7' },
                    }}
                  >
                    <FilterCenterFocus sx={{ fontSize: 16 }} />
                  </IconButton>
                  <IconButton
                    size="small"
                    onClick={(e) => { e.stopPropagation(); handleFilterToggle(af.type, !af.visible); }}
                    title={af.visible ? `Hide "${af.label}"` : `Show "${af.label}"`}
                    sx={{
                      p: 0.3,
                      color: af.visible
                        ? 'rgba(255,255,255,0.5)'
                        : 'rgba(255,255,255,0.2)',
                      '&:hover': { color: af.visible ? 'white' : 'rgba(255,255,255,0.5)' },
                    }}
                  >
                    {af.visible
                      ? <Visibility sx={{ fontSize: 16 }} />
                      : <VisibilityOff sx={{ fontSize: 16 }} />}
                  </IconButton>
                </ListItem>
              );
            })}
          </>
        )}

        {/* Divider between sections */}
        {hasFilters && hasGroups && (
          <Divider sx={{ borderColor: 'rgba(255,255,255,0.08)', my: 0.25 }} />
        )}

        {/* ─── Groups section ─── */}
        {hasGroups && (
          <>
            {hasFilters && (
              <ListItem sx={{ py: 0.25, px: 1, pointerEvents: 'none' }}>
                <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.35)', fontSize: 10, textTransform: 'uppercase', letterSpacing: 1 }}>
                  Groups
                </Typography>
              </ListItem>
            )}
            {filteredGroups.map((group) => {
              const isIsolated = isolatedGroup === group.name;
              return (
                <ListItem
                  key={group.name}
                  sx={{
                    py: 0.25,
                    px: 1,
                    opacity: group.visible ? 1 : 0.4,
                    cursor: 'pointer',
                    '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
                  }}
                  onMouseEnter={() => handleHover(group.nodes)}
                  onMouseLeave={() => handleHover(null)}
                  onDoubleClick={() => handleDoubleClick(group.nodes)}
                >
                  <ListItemText
                    primary={group.name}
                    primaryTypographyProps={{
                      variant: 'body2',
                      noWrap: true,
                      sx: {
                        cursor: 'default',
                        userSelect: 'none',
                        fontSize: 13,
                        fontWeight: isIsolated ? 700 : 400,
                        color: isIsolated ? '#4fc3f7' : 'inherit',
                      },
                    }}
                    sx={{ minWidth: 0, my: 0 }}
                  />
                  <IconButton
                    size="small"
                    onClick={(e) => { e.stopPropagation(); handleIsolate(group.name); }}
                    title={isIsolated ? `Stop isolating "${group.name}"` : `Isolate "${group.name}"`}
                    sx={{
                      p: 0.3,
                      color: isIsolated ? '#4fc3f7' : 'rgba(255,255,255,0.25)',
                      '&:hover': { color: '#4fc3f7' },
                    }}
                  >
                    <FilterCenterFocus sx={{ fontSize: 16 }} />
                  </IconButton>
                  <IconButton
                    size="small"
                    onClick={(e) => { e.stopPropagation(); handleToggle(group.name, !group.visible); }}
                    title={group.visible ? `Hide "${group.name}"` : `Show "${group.name}"`}
                    sx={{
                      p: 0.3,
                      color: group.visible
                        ? 'rgba(255,255,255,0.5)'
                        : 'rgba(255,255,255,0.2)',
                      '&:hover': { color: group.visible ? 'white' : 'rgba(255,255,255,0.5)' },
                    }}
                  >
                    {group.visible
                      ? <Visibility sx={{ fontSize: 16 }} />
                      : <VisibilityOff sx={{ fontSize: 16 }} />}
                  </IconButton>
                </ListItem>
              );
            })}
          </>
        )}
      </List>
    </Box>
  );
}
