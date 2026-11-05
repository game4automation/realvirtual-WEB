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
import { GroupsListContent, applyPersistedGroupVisibility, persistCurrentGroupVisibility } from './GroupsListContent';
import { useOverlayVisibilityState } from '../../hooks/use-overlay-visible';
import { getActiveAssetContext } from '../editor/active-asset-store';
import type { RVViewer } from '../rv-viewer';

const DEFAULT_W = 280;
const DEFAULT_H = 260;
const BOTTOM_MARGIN = BOTTOM_BAR_HEIGHT + 12;

/**
 * Close the Display panel and persist the current group visibility — unless
 * the asset editor is active (plan-760 F15).
 *
 * Rule: **Quick Edit = live, Display panel = persisted.** The editor's Quick
 * Edit lists (Kinematics, Groups) hide and isolate groups for the editing
 * session only and never write `rv-group-visibility`; the armed Auto Assign
 * target is even hidden by the editor itself. Persisting on close while the
 * editor is open would leak exactly that transient state into the HMI
 * profile, where it is restored on every later model load. Outside the
 * editor the behaviour is unchanged. Exported so the rule is testable
 * without rendering the panel.
 */
export function closeGroupsOverlay(viewer: RVViewer): void {
  viewer.toggleGroupsOverlay(false);
  if (getActiveAssetContext() !== null) return;
  persistCurrentGroupVisibility(viewer);
}

export function GroupsOverlay() {
  const viewer = useViewer();
  const open = useGroupsOverlayOpen();
  const overlayCats = useOverlayVisibilityState().present;
  // Counts for the subtitle — refreshed on the same events the list uses.
  const [counts, setCounts] = useState({ filters: 0, groups: 0 });

  // Restore persisted group visibility on EVERY model load, open or closed:
  // this host is always mounted (App.tsx), the list below is not. A restore
  // that ran only from the list applied only while the panel was open, so a
  // group hidden in the editor reappeared after the switch to the HMI and
  // back (2026-09-24). Listener order against the list does not matter: the
  // list renders the registry's shared `GroupInfo` objects, so it shows the
  // restored state whichever listener ran first (React runs child effects
  // before the parent's on a mount).
  useEffect(() => viewer.on('model-loaded', ({ result }) => {
    applyPersistedGroupVisibility(viewer, result);
  }), [viewer]);

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

  const handleClose = useCallback(() => closeGroupsOverlay(viewer), [viewer]);

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
      panelId="groups"
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
