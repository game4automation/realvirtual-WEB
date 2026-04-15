// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GroupsOverlay — Floating panel listing all scene groups with visibility
 * toggle switches and isolate buttons.
 *
 * Uses ChartPanel for the reusable drag/resize/title-bar infrastructure.
 * Responds to groups-overlay-toggle events from RVViewer.
 */

import { useState, useEffect, useCallback, useMemo, useRef } from 'react';
import {
  Box, IconButton, Typography, List,
  ListItem, ListItemText, InputBase,
} from '@mui/material';
import { Visibility, VisibilityOff, FilterCenterFocus, Search, Close } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { useGroupsOverlayOpen } from '../../hooks/use-groups-overlay';
import { ChartPanel } from './ChartPanel';
import { BOTTOM_BAR_HEIGHT } from './layout-constants';
import { RV_SCROLL_CLASS } from './shared-sx';
import {
  loadGroupVisibilitySettings,
  saveGroupVisibilitySettings,
  type GroupVisibilitySettings,
} from './group-visibility-store';
import type { GroupInfo } from '../engine/rv-group-registry';

const DEFAULT_W = 280;
const DEFAULT_H = 260;
const BOTTOM_MARGIN = BOTTOM_BAR_HEIGHT + 12;

export function GroupsOverlay() {
  const viewer = useViewer();
  const open = useGroupsOverlayOpen();
  const [groups, setGroups] = useState<GroupInfo[]>([]);
  const [isolatedGroup, setIsolatedGroup] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const filterRef = useRef<HTMLInputElement>(null);
  // Trigger re-render when visibility changes
  const [, setTick] = useState(0);

  const filteredGroups = useMemo(() => {
    // Filter out groups excluded from overlay via settings
    const settings = loadGroupVisibilitySettings();
    const excluded = settings.excludedFromOverlay ?? [];
    let result = groups.filter(g => !excluded.includes(g.name));
    if (filter) {
      const lc = filter.toLowerCase();
      result = result.filter(g => g.name.toLowerCase().includes(lc));
    }
    return result;
  }, [groups, filter]);

  // Load groups when overlay opens or model changes
  useEffect(() => {
    if (!open) return;
    const registry = viewer.groups;
    if (!registry) {
      setGroups([]);
      return;
    }
    setGroups(registry.getAll());

    // Apply persisted visibility state
    const saved = loadGroupVisibilitySettings();
    if (saved.isolatedGroup && registry.get(saved.isolatedGroup)) {
      registry.isolate(saved.isolatedGroup);
      setIsolatedGroup(saved.isolatedGroup);
      viewer.markShadowsDirty();
    } else if (saved.hiddenGroups.length > 0) {
      for (const name of saved.hiddenGroups) {
        registry.setVisible(name, false);
      }
      viewer.markShadowsDirty();
    }
    setTick(t => t + 1);
  }, [open, viewer, viewer.groups]);

  // Also refresh groups list when model loads
  useEffect(() => {
    const off = viewer.on('model-loaded', ({ result }) => {
      if (viewer.groups) {
        setGroups(viewer.groups.getAll());
        // Apply persisted state on new model load
        const saved = loadGroupVisibilitySettings();

        // Auto-exclude kinematic groups from overlay (merge with existing exclusions)
        const kinNames = result.kinematicGroupNames ?? [];
        if (kinNames.length > 0) {
          const existingExcluded = saved.excludedFromOverlay ?? [];
          const merged = [...new Set([...existingExcluded, ...kinNames])];
          saved.excludedFromOverlay = merged;
          saveGroupVisibilitySettings(saved);
        }

        // Set defaultHiddenGroups on registry so showAll() respects them
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
          // No user session state — apply default hidden groups
          for (const name of defaultHidden) {
            viewer.groups.setVisible(name, false);
          }
          viewer.markShadowsDirty();
        }
        setTick(t => t + 1);
      }
    });
    return off;
  }, [viewer]);

  const persistState = useCallback(() => {
    if (!viewer.groups) return;
    const all = viewer.groups.getAll();
    const hidden = all.filter(g => !g.visible).map(g => g.name);
    const current = loadGroupVisibilitySettings();
    const settings: GroupVisibilitySettings = {
      hiddenGroups: hidden,
      isolatedGroup: isolatedGroup,
      excludedFromOverlay: current.excludedFromOverlay,
      defaultHiddenGroups: current.defaultHiddenGroups,
    };
    saveGroupVisibilitySettings(settings);
  }, [viewer, isolatedGroup]);

  const handleToggle = useCallback((name: string, visible: boolean) => {
    if (!viewer.groups) return;
    viewer.groups.setVisible(name, visible);
    setIsolatedGroup(null);
    viewer.markShadowsDirty();
    setTick(t => t + 1);
    // Persist after state update — preserve excludedFromOverlay and defaultHiddenGroups
    const all = viewer.groups.getAll();
    const hidden = all.filter(g => !g.visible).map(g => g.name);
    const current = loadGroupVisibilitySettings();
    saveGroupVisibilitySettings({
      hiddenGroups: hidden,
      isolatedGroup: null,
      excludedFromOverlay: current.excludedFromOverlay,
      defaultHiddenGroups: current.defaultHiddenGroups,
    });
  }, [viewer]);

  const handleIsolate = useCallback((name: string) => {
    if (!viewer.groups) return;
    const current = loadGroupVisibilitySettings();
    if (isolatedGroup === name) {
      // Un-isolate: show all (respects defaultHiddenGroups)
      viewer.groups.showAll();
      setIsolatedGroup(null);
      viewer.markShadowsDirty();
      setTick(t => t + 1);
      const all = viewer.groups.getAll();
      const hidden = all.filter(g => !g.visible).map(g => g.name);
      saveGroupVisibilitySettings({
        hiddenGroups: hidden,
        isolatedGroup: null,
        excludedFromOverlay: current.excludedFromOverlay,
        defaultHiddenGroups: current.defaultHiddenGroups,
      });
    } else {
      viewer.groups.isolate(name);
      setIsolatedGroup(name);
      viewer.markShadowsDirty();
      setTick(t => t + 1);
      saveGroupVisibilitySettings({
        hiddenGroups: [],
        isolatedGroup: name,
        excludedFromOverlay: current.excludedFromOverlay,
        defaultHiddenGroups: current.defaultHiddenGroups,
      });
    }
  }, [viewer, isolatedGroup]);

  const handleShowAll = useCallback(() => {
    if (!viewer.groups) return;
    viewer.groups.showAll();
    setIsolatedGroup(null);
    viewer.markShadowsDirty();
    setTick(t => t + 1);
    // showAll() already respects defaultHiddenGroups — persist correctly
    const all = viewer.groups.getAll();
    const hidden = all.filter(g => !g.visible).map(g => g.name);
    const current = loadGroupVisibilitySettings();
    saveGroupVisibilitySettings({
      hiddenGroups: hidden,
      isolatedGroup: null,
      excludedFromOverlay: current.excludedFromOverlay,
      defaultHiddenGroups: current.defaultHiddenGroups,
    });
  }, [viewer]);

  const handleHover = useCallback((group: GroupInfo | null) => {
    if (group && group.nodes.length > 0) {
      viewer.highlighter.highlightMultiple(group.nodes);
    } else {
      viewer.highlighter.clear();
    }
  }, [viewer]);

  const handleSelect = useCallback((group: GroupInfo) => {
    if (!viewer.registry) return;
    const paths: string[] = [];
    for (const node of group.nodes) {
      const p = viewer.registry.getPathForNode(node);
      if (p) paths.push(p);
    }
    if (paths.length > 0) {
      viewer.selectionManager.selectPaths(paths);
    }
  }, [viewer]);

  const handleDoubleClick = useCallback((group: GroupInfo) => {
    // Focus camera on all nodes in this group
    if (group.nodes.length > 0) {
      viewer.fitToNodes(group.nodes);
    }
  }, [viewer]);

  const handleClose = useCallback(() => {
    viewer.toggleGroupsOverlay(false);
    persistState();
  }, [viewer, persistState]);

  if (!open) return null;

  const hasGroups = groups.length > 0;
  const anyHidden = groups.some(g => !g.visible);

  return (
    <ChartPanel
      open={open}
      onClose={handleClose}
      title="Groups"
      titleColor="#4fc3f7"
      subtitle={hasGroups ? `${groups.length} group${groups.length !== 1 ? 's' : ''}` : undefined}
      defaultWidth={DEFAULT_W}
      defaultHeight={DEFAULT_H}
      panelId="groups"
      defaultPosition={{
        x: window.innerWidth - DEFAULT_W - 16,
        y: window.innerHeight - DEFAULT_H - BOTTOM_MARGIN,
      }}
    >
      {!hasGroups ? (
        <Box sx={{ p: 2, textAlign: 'center' }}>
          <Typography variant="body2" color="text.secondary">
            No groups found in this model
          </Typography>
        </Box>
      ) : (
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
              title="Show all groups"
              sx={{
                p: 0.3, ml: 0.5, flexShrink: 0,
                color: anyHidden ? 'rgba(255,255,255,0.7)' : 'rgba(255,255,255,0.15)',
              }}
              disabled={!anyHidden}
            >
              <Visibility sx={{ fontSize: 16 }} />
            </IconButton>
          </Box>

          {/* Groups list */}
          <List
            dense
            disablePadding
            className={RV_SCROLL_CLASS}
            sx={{ flex: 1, overflow: 'auto', minHeight: 0 }}
          >
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
                  onMouseEnter={() => handleHover(group)}
                  onMouseLeave={() => handleHover(null)}
                  onClick={() => handleSelect(group)}
                  onDoubleClick={() => handleDoubleClick(group)}
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
                    onClick={() => handleIsolate(group.name)}
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
                    onClick={() => handleToggle(group.name, !group.visible)}
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
          </List>
        </Box>
      )}
    </ChartPanel>
  );
}
