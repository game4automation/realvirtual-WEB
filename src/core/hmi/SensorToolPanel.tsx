// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SensorToolPanel — left-side panel offering:
 * - Visibility toggle for all Web Sensor gizmos
 * - Shape override (Box / Transparent shell / Mesh overlay / Sphere / Sprite)
 * - Isolate mode (hide all non-sensor root meshes)
 * - Live sensor list with state badge; click focuses the camera on the node
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Box,
  Typography,
  FormControlLabel,
  Checkbox,
  RadioGroup,
  Radio,
  FormControl,
  FormLabel,
  Divider,
  List,
  ListItemButton,
  ListItemText,
} from '@mui/material';
import type { Object3D } from 'three';
import { useViewer } from '../../hooks/use-viewer';
import { LeftPanel } from './LeftPanel';
import { sensorViewStore, type SensorViewState } from './sensor-view-store';
import { RV_SCROLL_CLASS } from './shared-sx';
import { WebSensorConfig, type WebSensorState } from '../engine/rv-web-sensor';
import type { GizmoShape } from '../engine/rv-gizmo-manager';
import type { RVWebSensor } from '../engine/rv-web-sensor';

const PANEL_ID = 'sensor-tool';
const DEFAULT_WIDTH = 320;

const SHAPE_OPTIONS: { value: GizmoShape | ''; label: string }[] = [
  { value: '', label: 'Default (per-sensor)' },
  { value: 'box', label: 'Box (wireframe)' },
  { value: 'transparent-shell', label: 'Transparent shell' },
  { value: 'mesh-overlay', label: 'Mesh overlay' },
  { value: 'sphere', label: 'Sphere' },
  { value: 'sprite', label: 'Sprite' },
];

function stateColor(s: WebSensorState): string {
  const c = WebSensorConfig.stateStyles[s].color;
  return `#${c.toString(16).padStart(6, '0')}`;
}

function stateLabel(s: WebSensorState): string {
  return s.toUpperCase();
}

/** Collect all WebSensor nodes in the scene via userData. */
function collectSensorNodes(viewer: ReturnType<typeof useViewer>): Object3D[] {
  const result: Object3D[] = [];
  viewer.scene.traverse((n) => {
    if (n.userData?._rvWebSensor) result.push(n);
  });
  return result;
}

/** One-shot isolate: find all non-sensor meshes and hide them. */
function applyIsolate(
  viewer: ReturnType<typeof useViewer>,
  isolate: boolean,
  stash: Map<Object3D, boolean>,
): void {
  if (isolate) {
    // Build set of sensor nodes and their ancestors (keep visible)
    const keep = new Set<Object3D>();
    viewer.scene.traverse((n) => {
      if (n.userData?._rvWebSensor) {
        let cur: Object3D | null = n;
        while (cur) {
          keep.add(cur);
          cur = cur.parent;
        }
      }
    });
    // Hide everything that isn't in keep (only mesh nodes to avoid breaking structure)
    viewer.scene.traverse((n) => {
      const isMesh = (n as { isMesh?: boolean }).isMesh === true;
      if (!isMesh) return;
      if (n.userData?._rvGizmo) return;
      if (keep.has(n)) return;
      if (!stash.has(n)) stash.set(n, n.visible);
      n.visible = false;
    });
  } else {
    // Restore
    for (const [n, prev] of stash) {
      n.visible = prev;
    }
    stash.clear();
  }
}

export function SensorToolPanel() {
  const viewer = useViewer();
  const lpm = viewer.leftPanelManager;
  const panelSnap = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot);
  const isOpen = panelSnap.activePanel === PANEL_ID;
  const state: SensorViewState = useSyncExternalStore(
    sensorViewStore.subscribe,
    sensorViewStore.getSnapshot,
  );

  // Isolate stash (restored when isolate turned off)
  const [stash] = useState<Map<Object3D, boolean>>(() => new Map());

  // Apply state changes to gizmoManager
  useEffect(() => {
    viewer.gizmoManager.setGlobalVisibility(state.visible);
  }, [viewer, state.visible]);

  useEffect(() => {
    viewer.gizmoManager.setGlobalShapeOverride(state.shapeOverride ?? null);
  }, [viewer, state.shapeOverride]);

  useEffect(() => {
    applyIsolate(viewer, state.isolate, stash);
  }, [viewer, state.isolate, stash]);

  // Rescan sensor nodes when panel opens
  const [sensors, setSensors] = useState<Object3D[]>([]);
  useEffect(() => {
    if (!isOpen) return;
    setSensors(collectSensorNodes(viewer));
  }, [viewer, isOpen]);

  const handleClose = useCallback(() => lpm.close(PANEL_ID), [lpm]);

  const handleFocus = useCallback((node: Object3D) => {
    viewer.fitToNodes([node]);
  }, [viewer]);

  // Map of sensorNode → state (snapshot — not reactive; simple panel refresh on toggle)
  const stateMap = useMemo(() => {
    const m = new Map<Object3D, WebSensorState>();
    for (const n of sensors) {
      const inst = n.userData?._rvWebSensor as RVWebSensor | undefined;
      if (inst) m.set(n, inst.getCurrentState());
    }
    return m;
  }, [sensors]);

  if (!isOpen) return null;

  return (
    <LeftPanel
      title="Web Sensors"
      width={DEFAULT_WIDTH}
      onClose={handleClose}
      resizable
    >
      <Box className={RV_SCROLL_CLASS} sx={{ flex: 1, overflow: 'auto', p: 1 }}>
        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={state.visible}
              onChange={(e) => sensorViewStore.setVisible(e.target.checked)}
            />
          }
          label={<Typography sx={{ fontSize: 12 }}>Show sensor gizmos</Typography>}
        />

        <Divider sx={{ my: 1 }} />

        <FormControl component="fieldset" size="small">
          <FormLabel sx={{ fontSize: 11, mb: 0.5 }}>Gizmo shape</FormLabel>
          <RadioGroup
            value={state.shapeOverride ?? ''}
            onChange={(e) => {
              const v = e.target.value as GizmoShape | '';
              sensorViewStore.setShapeOverride(v === '' ? null : v);
            }}
          >
            {SHAPE_OPTIONS.map((opt) => (
              <FormControlLabel
                key={opt.value || 'default'}
                value={opt.value}
                control={<Radio size="small" />}
                label={<Typography sx={{ fontSize: 12 }}>{opt.label}</Typography>}
              />
            ))}
          </RadioGroup>
        </FormControl>

        <Divider sx={{ my: 1 }} />

        <FormControlLabel
          control={
            <Checkbox
              size="small"
              checked={state.isolate}
              onChange={(e) => sensorViewStore.setIsolate(e.target.checked)}
            />
          }
          label={<Typography sx={{ fontSize: 12 }}>Isolate sensors</Typography>}
        />

        <Divider sx={{ my: 1 }} />

        <Typography sx={{ fontSize: 11, color: 'text.secondary', mb: 0.5 }}>
          Sensor list ({sensors.length})
        </Typography>

        <List dense disablePadding>
          {sensors.map((n, i) => {
            const inst = n.userData?._rvWebSensor as RVWebSensor | undefined;
            const label = inst?.Label || n.name || `Sensor ${i + 1}`;
            const st = stateMap.get(n) ?? 'low';
            return (
              <ListItemButton
                key={i}
                onClick={() => handleFocus(n)}
                sx={{ borderRadius: 0.5, py: 0.25 }}
              >
                <ListItemText
                  primary={label}
                  primaryTypographyProps={{ sx: { fontSize: 12 } }}
                />
                <Box
                  sx={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: 0.5,
                    fontSize: 10,
                    color: stateColor(st),
                    fontWeight: 600,
                  }}
                >
                  <Box
                    sx={{
                      width: 8,
                      height: 8,
                      borderRadius: '50%',
                      bgcolor: stateColor(st),
                    }}
                  />
                  {stateLabel(st)}
                </Box>
              </ListItemButton>
            );
          })}
          {sensors.length === 0 && (
            <Typography sx={{ fontSize: 11, color: 'text.secondary', p: 1 }}>
              No Web Sensors in current scene.
            </Typography>
          )}
        </List>
      </Box>
    </LeftPanel>
  );
}
