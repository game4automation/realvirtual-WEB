// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * KinematicsList — the "Kinematics" section of the Quick Edit window: one row
 * per kinematic object (node carrying a Kinematic component) in the asset.
 *
 * Interactions per row:
 *  - Hover   → overlay-highlights the linked group's member meshes (same
 *              visual as the old Groups hover preview)
 *  - Click   → selects the kinematic object; the hierarchy reveals/follows
 *              and the selection keeps the group overlay-highlighted
 *  - Isolate → exclusive isolate of the linked group (click again to clear)
 *  - Eye     → hide/show the linked group
 *
 * Auto Assign mode (header toggle, see {@link AutoAssignToggle}): while ON and
 * a kinematic is selected ("armed"), clicking an object in the 3D view adds a
 * Group component linking it to the armed kinematic's group — the kinematic
 * stays selected, the clicked object does NOT. The armed group is hidden for
 * the duration, so assigned parts vanish from the raycast and only the ghost
 * overlay (selection-channel group preview) marks what is already collected:
 * every click always hits unassigned geometry. Disarming (toggle off, other
 * selection, unmount) restores the group's previous visibility.
 *
 * Hide/isolate are LIVE view state only — never persisted into the asset
 * (GLB export runs with onlyVisible:false, so a hidden group still exports).
 * The action icons fade in on row hover and stay visible while active, so
 * idle rows read as a clean list.
 */

import { useState, useEffect, useMemo, useCallback } from 'react';
import { Box, Button, IconButton, Tooltip, Typography } from '@mui/material';
import { Hub, Visibility, VisibilityOff, FilterCenterFocus, TouchApp } from '@mui/icons-material';
import { useViewer } from '../../../hooks/use-viewer';
import { useSelection } from '../../../hooks/use-selection';
import type { RVViewer } from '../../../core/rv-viewer';
import type { RvExtrasEditorPlugin } from '../../../core/hmi/rv-extras-editor';
import { getActiveAssetContext } from '../active-asset-store';
import { autoAssignToKinematic } from '../group-actions';
import { setAutoAssignTarget } from './auto-assign-store';

/** Kinematic accent — same color as the Kinematic badge in hierarchy/inspector. */
export const KINEMATIC_ACCENT = '#ce93d8';

const KINEMATIC_KEY_RE = /^Kinematic(_\d+)?$/;

/** Closest the Auto Assign focus may pull the camera, in scene units (metres).
 *  Small parts would otherwise fit-frame to a few centimetres and put the
 *  camera inside the surrounding assembly. */
const AUTO_ASSIGN_MIN_FOCUS_DISTANCE = 1;

interface KinematicEntry {
  /** Registry path of the kinematic node (selection target). */
  path: string;
  /** Display name (node name). */
  name: string;
  /** Linked group, or null when the Kinematic has no GroupName yet. */
  groupName: string | null;
  /** Member count of the linked group (0 when unlinked/empty). */
  memberCount: number;
  /** Live visibility of the linked group. */
  visible: boolean;
}

/** One row per Kinematic component in the scene, sorted by name. */
function scanKinematics(viewer: RVViewer): KinematicEntry[] {
  const root = viewer.currentModelRoot;
  if (!root) return [];
  const entries: KinematicEntry[] = [];
  root.traverse((node) => {
    const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
      Record<string, unknown> | undefined;
    if (!rv) return;
    for (const key of Object.keys(rv)) {
      if (!KINEMATIC_KEY_RE.test(key)) continue;
      const path = viewer.registry?.getPathForNode(node);
      if (!path) continue;
      const data = rv[key] as Record<string, unknown> | undefined;
      const rawName = data?.['GroupName'];
      const groupName = typeof rawName === 'string' && rawName.length > 0 ? rawName : null;
      const group = groupName ? viewer.groups?.get(groupName) : undefined;
      entries.push({
        path,
        name: node.name || path.split('/').pop() || path,
        groupName,
        memberCount: group?.nodes.length ?? 0,
        visible: group?.visible ?? true,
      });
    }
  });
  return entries.sort((a, b) => a.name.localeCompare(b.name));
}

/** Compact chip-toggle for the Auto Assign mode — lives in the Kinematics
 *  section header (right-aligned). Accent-filled while active. */
export function AutoAssignToggle({ checked, onChange }: {
  checked: boolean; onChange: (v: boolean) => void;
}) {
  return (
    <Tooltip
      placement="left"
      title={checked
        ? 'Auto Assign is ON — with a kinematic selected, clicking an object in the 3D view adds it to the kinematic\'s group'
        : 'Auto Assign: with a kinematic selected, click objects in the 3D view to add them to its group'}
    >
      <Box
        onClick={() => onChange(!checked)}
        sx={{
          display: 'flex', alignItems: 'center', gap: 0.25,
          px: 0.5, py: 0.125, borderRadius: 3, cursor: 'pointer', userSelect: 'none',
          border: `1px solid ${checked ? KINEMATIC_ACCENT : 'rgba(255,255,255,0.15)'}`,
          bgcolor: checked ? KINEMATIC_ACCENT + '2e' : 'transparent',
          color: checked ? KINEMATIC_ACCENT : 'rgba(255,255,255,0.4)',
          transition: 'all 120ms ease',
          '&:hover': { borderColor: KINEMATIC_ACCENT, color: KINEMATIC_ACCENT },
        }}
      >
        <TouchApp sx={{ fontSize: 12 }} />
        <Typography sx={{ fontSize: 9, fontWeight: 700, letterSpacing: 0.5, textTransform: 'uppercase', color: 'inherit' }}>
          Auto Assign
        </Typography>
      </Box>
    </Tooltip>
  );
}

export function KinematicsList({ autoAssign = false }: { autoAssign?: boolean }) {
  const viewer = useViewer();
  const selection = useSelection();
  const [tick, setTick] = useState(0);
  const [isolated, setIsolated] = useState<string | null>(
    () => viewer.groups?.isolatedGroupName ?? null,
  );

  // Re-scan on structural edits (component add/remove/undo/redo) and on live
  // group membership changes (rv-group-sync emits 'groups-changed').
  useEffect(() => viewer.on('editor-structure-changed', () => setTick(t => t + 1)), [viewer]);
  useEffect(() => viewer.on('groups-changed', () => setTick(t => t + 1)), [viewer]);

  const entries = useMemo(
    () => scanKinematics(viewer),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [viewer, tick],
  );

  // ── Auto Assign: armed = mode ON + a group-linked kinematic is selected ──
  const armed = useMemo(() => {
    if (!autoAssign) return null;
    const entry = entries.find(e => e.path === selection.primaryPath);
    return entry?.groupName ? entry : null;
  }, [autoAssign, entries, selection.primaryPath]);
  const armedPath = armed?.path ?? null;
  const armedGroup = armed?.groupName ?? null;
  // A freshly created kinematic's group has no members and thus no registry
  // entry yet — it materializes on the first Auto Assign click. Track its
  // existence so the hide effect below re-runs at that moment (re-renders
  // happen via `tick` on 'groups-changed', so this stays current).
  const armedGroupExists = armedGroup !== null && viewer.groups?.get(armedGroup) !== undefined;

  // Publish the armed target for consumers outside React — the plugin's
  // marquee reads it to turn pink and to route boxed paths into the group.
  useEffect(() => {
    if (!armedPath || !armedGroup) return;
    setAutoAssignTarget({ kinematicPath: armedPath, groupName: armedGroup });
    return () => setAutoAssignTarget(null);
  }, [armedPath, armedGroup]);

  // While armed, keep the hierarchy still: every collected part fires a
  // select → assign → re-select cycle, and revealing each one would expand
  // branches and scroll-jump the tree under the user. The hierarchy still
  // follows the selection, it just does not reveal.
  useEffect(() => {
    if (!armedPath) return;
    const editor = viewer.getPlugin<RvExtrasEditorPlugin>('rv-extras-editor');
    editor?.setRevealSuppressed(true);
    return () => editor?.setRevealSuppressed(false);
  }, [viewer, armedPath]);

  // While armed, hide the group (assigned parts leave the raycast; the
  // selection-channel ghost overlay keeps marking them). Restores the
  // group's previous visibility on disarm/unmount.
  useEffect(() => {
    if (!armedGroup || !viewer.groups) return;
    const prevVisible = viewer.groups.get(armedGroup)?.visible ?? true;
    viewer.groups.setVisible(armedGroup, false);
    viewer.markShadowsDirty();
    viewer.markRenderDirty();
    setTick(t => t + 1);
    return () => {
      if (viewer.groups?.get(armedGroup)) {
        viewer.groups.setVisible(armedGroup, prevVisible);
        viewer.markShadowsDirty();
        viewer.markRenderDirty();
        setTick(t => t + 1);
      }
    };
    // armedGroupExists: re-run when the armed group first materializes so a
    // brand-new (empty) group gets hidden once its first member registers.
  }, [armedGroup, armedGroupExists, viewer]);

  // While armed, a 3D-view click assigns the clicked object to the armed
  // group instead of selecting it. 'object-clicked' fires ONLY for canvas
  // clicks (hierarchy/list clicks don't), AFTER the click already moved the
  // selection — re-selecting the kinematic restores it in the same task, so
  // the kinematic stays selected and the ghost overlay refreshes to include
  // the new member. Clicking another kinematic re-arms onto it instead.
  useEffect(() => {
    if (!armedPath || !armedGroup) return;
    return viewer.on('object-clicked', ({ path, node }) => {
      if (path === armedPath) return;
      const rv = (node.userData as Record<string, unknown> | undefined)?.['realvirtual'] as
        Record<string, unknown> | undefined;
      if (rv && Object.keys(rv).some(k => KINEMATIC_KEY_RE.test(k))) return;
      const ctx = getActiveAssetContext();
      if (!ctx) return;
      void (async () => {
        // Same action the marquee commit uses — one undo step, re-selects the
        // kinematic so the ghost overlay refreshes to include the new member.
        await autoAssignToKinematic(viewer, ctx.doc, [path], armedGroup, armedPath);
        // Frame the just-clicked object so the user sees what they collected
        // (bounds come from geometry, so it works even though it is now hidden).
        // Floored at 1 m so small parts (screws, sensors) don't pull the
        // camera inside the surrounding assembly.
        viewer.fitToNodes([node], undefined, { minDistance: AUTO_ASSIGN_MIN_FOCUS_DISTANCE });
      })();
    });
  }, [viewer, armedPath, armedGroup]);

  const handleHover = useCallback((entry: KinematicEntry | null) => {
    // A selected kinematic's group is already overlay-highlighted through the
    // SELECTION channel (asset-editor group preview). The hover preview lives
    // on the independent HOVER channel, so drawing it too would stack a second
    // overlay on the same meshes — skip it for selected rows.
    const alreadyShown = entry !== null && selection.selectedPaths.includes(entry.path);
    const nodes = entry?.groupName && !alreadyShown
      ? viewer.groups?.get(entry.groupName)?.nodes ?? []
      : [];
    if (nodes.length > 0) {
      viewer.highlighter.highlightMultiple(nodes, { visual: 'overlay' });
    } else {
      viewer.highlighter.clear();
    }
    viewer.markRenderDirty();
  }, [viewer, selection.selectedPaths]);

  const handleSelect = useCallback((path: string) => {
    // Scene selection is the single source of truth: the hierarchy follows via
    // 'selection-changed' and the editor's kinematic-group selection preview
    // keeps the group overlay-highlighted while selected. Drop the hover-channel
    // preview — the selection channel owns the group overlay from here on.
    viewer.selectionManager.select(path);
    viewer.highlighter.clear();
  }, [viewer]);

  const handleToggleVisible = useCallback((groupName: string, visible: boolean) => {
    if (!viewer.groups) return;
    viewer.groups.setVisible(groupName, visible);
    setIsolated(viewer.groups.isolatedGroupName ?? null);
    viewer.markShadowsDirty();
    viewer.markRenderDirty();
    setTick(t => t + 1);
  }, [viewer]);

  const handleIsolate = useCallback((groupName: string) => {
    if (!viewer.groups) return;
    if (isolated === groupName) {
      viewer.groups.showAll();
      setIsolated(null);
    } else {
      viewer.groups.isolate(groupName);
      setIsolated(groupName);
    }
    viewer.markShadowsDirty();
    viewer.markRenderDirty();
    setTick(t => t + 1);
  }, [viewer, isolated]);

  const handleShowAll = useCallback(() => {
    viewer.groups?.showAll();
    setIsolated(null);
    viewer.markShadowsDirty();
    viewer.markRenderDirty();
    setTick(t => t + 1);
  }, [viewer]);

  if (entries.length === 0) {
    return (
      <Typography sx={{ fontSize: 11, color: 'text.disabled', px: 0.5, py: 0.5 }}>
        No kinematic objects yet. Click Add Kinematic below and click objects
        in the 3D view to collect them, or assign objects to a group — the
        kinematic axis object is created automatically.
      </Typography>
    );
  }

  const anyOff = isolated !== null || entries.some(e => !e.visible);

  return (
    <Box>
      {/* Auto Assign status line — tells the user what the next click does. */}
      {autoAssign && (
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 0.5, px: 0.5, py: 0.375, mb: 0.25,
          borderRadius: 1,
          bgcolor: armed ? KINEMATIC_ACCENT + '14' : 'rgba(255,255,255,0.03)',
        }}>
          <TouchApp sx={{ fontSize: 12, color: armed ? KINEMATIC_ACCENT : 'text.disabled', flexShrink: 0 }} />
          <Typography sx={{ fontSize: 10, color: armed ? KINEMATIC_ACCENT : 'text.disabled', lineHeight: 1.3 }}>
            {armed
              ? `Click objects in the 3D view to add them to "${armedGroup}"`
              : 'Select a kinematic below to start auto-assigning'}
          </Typography>
        </Box>
      )}
      {entries.map((entry) => {
        const selected = selection.selectedPaths.includes(entry.path);
        const isIsolated = entry.groupName !== null && isolated === entry.groupName;
        const actionsActive = isIsolated || !entry.visible;
        return (
          <Box
            key={entry.path}
            onMouseEnter={() => handleHover(entry)}
            onMouseLeave={() => handleHover(null)}
            onClick={() => handleSelect(entry.path)}
            sx={{
              display: 'flex', alignItems: 'center', gap: 0.5,
              px: 0.5, minHeight: 24, borderRadius: 1, cursor: 'pointer',
              bgcolor: selected ? KINEMATIC_ACCENT + '1a' : 'transparent',
              opacity: entry.visible ? 1 : 0.45,
              '&:hover': { bgcolor: selected ? KINEMATIC_ACCENT + '26' : 'rgba(255,255,255,0.04)' },
              '&:hover .rv-kin-actions': { opacity: 1 },
            }}
          >
            <Hub sx={{ fontSize: 14, color: KINEMATIC_ACCENT, flexShrink: 0 }} />
            <Typography noWrap sx={{
              flex: 1, minWidth: 0, fontSize: 11,
              color: selected ? KINEMATIC_ACCENT : 'text.primary',
              fontWeight: selected ? 600 : 400,
            }}>
              {entry.name}
            </Typography>
            {/* Group link status: member count (amber 0 = empty group flags a
                not-yet-working kinematic), or "no group" when unlinked. */}
            <Tooltip
              placement="left"
              title={entry.groupName
                ? (entry.memberCount > 0
                  ? `Group "${entry.groupName}" — ${entry.memberCount} object${entry.memberCount !== 1 ? 's' : ''}`
                  : `Group "${entry.groupName}" has no members yet`)
                : 'No group assigned — set GroupName on the Kinematic'}
            >
              <Typography sx={{
                fontSize: 9, flexShrink: 0,
                color: entry.groupName
                  ? (entry.memberCount > 0 ? 'text.disabled' : '#ffa726')
                  : '#ffa726',
              }}>
                {entry.groupName ? entry.memberCount : 'no group'}
              </Typography>
            </Tooltip>
            <Box
              className="rv-kin-actions"
              sx={{
                display: 'flex', alignItems: 'center', flexShrink: 0,
                opacity: actionsActive ? 1 : 0, transition: 'opacity 120ms ease',
              }}
            >
              <Tooltip title={isIsolated ? 'Clear isolate' : 'Isolate group'} placement="top">
                <span>
                  <IconButton
                    size="small"
                    disabled={!entry.groupName}
                    onClick={(e) => { e.stopPropagation(); if (entry.groupName) handleIsolate(entry.groupName); }}
                    sx={{ p: 0.25, color: isIsolated ? 'primary.main' : 'text.disabled', '&:hover': { color: 'primary.main' } }}
                  >
                    <FilterCenterFocus sx={{ fontSize: 14 }} />
                  </IconButton>
                </span>
              </Tooltip>
              <Tooltip title={entry.visible ? 'Hide group' : 'Show group'} placement="top">
                <span>
                  <IconButton
                    size="small"
                    disabled={!entry.groupName}
                    onClick={(e) => { e.stopPropagation(); if (entry.groupName) handleToggleVisible(entry.groupName, !entry.visible); }}
                    sx={{ p: 0.25, color: entry.visible ? 'text.disabled' : '#ffa726', '&:hover': { color: 'text.primary' } }}
                  >
                    {entry.visible ? <Visibility sx={{ fontSize: 14 }} /> : <VisibilityOff sx={{ fontSize: 14 }} />}
                  </IconButton>
                </span>
              </Tooltip>
            </Box>
          </Box>
        );
      })}
      {anyOff && (
        <Box sx={{ display: 'flex', justifyContent: 'flex-end', mt: 0.25 }}>
          <Button
            size="small"
            variant="text"
            startIcon={<Visibility sx={{ fontSize: 12 }} />}
            onClick={handleShowAll}
            sx={{ fontSize: 10, textTransform: 'none', color: 'text.secondary', py: 0, px: 0.5, minWidth: 0 }}
          >
            Show all
          </Button>
        </Box>
      )}
    </Box>
  );
}
