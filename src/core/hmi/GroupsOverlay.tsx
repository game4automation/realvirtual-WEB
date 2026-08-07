// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * GroupsOverlay — Floating "Display" panel listing overlay categories,
 * auto-filter categories and explicit scene groups with visibility toggles
 * and isolate buttons.
 *
 * The list itself lives in {@link GroupsListContent} (shared with the editor's
 * Kinematics window); this shell owns the FloatingPanel chrome, the subtitle
 * counts and the groups-overlay-toggle open state.
 */

import { useState, useEffect, useCallback } from 'react';
import { useViewer } from '../../hooks/use-viewer';
import { useGroupsOverlayOpen } from '../../hooks/use-groups-overlay';
import { FloatingPanel } from './FloatingPanel';
import { BOTTOM_BAR_HEIGHT } from './layout-constants';
import { GroupsListContent, persistCurrentGroupVisibility } from './GroupsListContent';
import { useOverlayVisibilityState } from '../../hooks/use-overlay-visible';

const DEFAULT_W = 280;
const DEFAULT_H = 260;
const BOTTOM_MARGIN = BOTTOM_BAR_HEIGHT + 12;

export function GroupsOverlay() {
  const viewer = useViewer();
  const open = useGroupsOverlayOpen();
  const overlayCats = useOverlayVisibilityState().present;
  // Counts for the subtitle — refreshed on the same events the list uses.
  const [counts, setCounts] = useState({ filters: 0, groups: 0 });

  useEffect(() => {
    if (!open) return;
    const refresh = () => setCounts({
      filters: viewer.autoFilters?.getAll().length ?? 0,
      groups: viewer.groups?.getAll().length ?? 0,
    });
    refresh();
    const offGroups = viewer.on('groups-changed', refresh);
    const offModel = viewer.on('model-loaded', refresh);
    return () => { offGroups(); offModel(); };
  }, [open, viewer]);

  const handleClose = useCallback(() => {
    viewer.toggleGroupsOverlay(false);
    persistCurrentGroupVisibility(viewer);
  }, [viewer]);

  if (!open) return null;

  const parts: string[] = [];
  if (overlayCats.length > 0) parts.push(`${overlayCats.length} overlay${overlayCats.length !== 1 ? 's' : ''}`);
  if (counts.filters > 0) parts.push(`${counts.filters} filter${counts.filters !== 1 ? 's' : ''}`);
  if (counts.groups > 0) parts.push(`${counts.groups} group${counts.groups !== 1 ? 's' : ''}`);
  const subtitle = parts.length > 0 ? parts.join(', ') : undefined;

  return (
    <FloatingPanel
      open={open}
      onClose={handleClose}
      title="Display"
      titleColor="#4fc3f7"
      subtitle={subtitle}
      defaultWidth={DEFAULT_W}
      defaultHeight={DEFAULT_H}
      defaultPosition={{
        x: window.innerWidth - DEFAULT_W - 16,
        y: window.innerHeight - DEFAULT_H - BOTTOM_MARGIN,
      }}
    >
      <GroupsListContent active={open} />
    </FloatingPanel>
  );
}
