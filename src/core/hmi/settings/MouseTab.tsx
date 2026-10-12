// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useRef } from 'react';
import { Box, Button, Switch } from '@mui/material';
import { RestartAlt } from '@mui/icons-material';
import { useViewer } from '../../../hooks/use-viewer';
import { isSettingsLocked } from '../rv-app-config';
import {
  loadVisualSettings, saveVisualSettings, getDefaultVisualSettings, NAVIGATION_RANGES,
  type VisualSettings,
} from '../visual-settings-store';
import { FieldRow, SettingsSection, SliderRow } from './settings-helpers';

/**
 * Settings panel tab — "Mouse & Touch".
 *
 * Controls pointer / touch navigation sensitivity for the OrbitControls camera:
 * rotate, pan, zoom speed (mouse wheel + trackpad + touch pinch) and damping.
 * The zoom speed also scales the wheel step toward the surface (plan-515
 * NavigationController). "Zoom to mouse cursor" picks the mouse-wheel anchor:
 * on (default) = the point under the cursor, off = the middle of the viewport;
 * a trackpad or touch pinch always zooms under the fingers. "Orbit around point
 * under cursor" picks the orbit / pan anchor: off (default) = orbit about the
 * fixed focus point and pan in the plane through it (the classic feel), on =
 * orbit about and pan by the surface point under the cursor.
 * Values persist to localStorage via visual-settings-store and can be overridden
 * via `settings.json` (keys `visual.orbit*`, `visual.wheelZoomToCursor`,
 * `visual.navigateAroundCursorPoint`).
 */
export function MouseTab() {
  const viewer = useViewer();
  const settingsRef = useRef(loadVisualSettings());
  const [orbitRotateSpeed, setOrbitRotateSpeed] = useState<number>(settingsRef.current.orbitRotateSpeed);
  const [orbitPanSpeed, setOrbitPanSpeed] = useState<number>(settingsRef.current.orbitPanSpeed);
  const [orbitZoomSpeed, setOrbitZoomSpeed] = useState<number>(settingsRef.current.orbitZoomSpeed);
  const [orbitDampingFactor, setOrbitDampingFactor] = useState<number>(settingsRef.current.orbitDampingFactor);
  const [wheelZoomToCursor, setWheelZoomToCursor] = useState<boolean>(settingsRef.current.wheelZoomToCursor);
  const [navigateAroundCursorPoint, setNavigateAroundCursorPoint] = useState<boolean>(settingsRef.current.navigateAroundCursorPoint);
  const settingsLocked = isSettingsLocked();

  const persist = (patch: Partial<VisualSettings>) => {
    Object.assign(settingsRef.current, patch);
    saveVisualSettings(settingsRef.current);
  };

  const updateOrbitRotateSpeed = (_: unknown, v: number | number[]) => {
    const val = v as number;
    viewer.setControlsConfig({ rotateSpeed: val });
    setOrbitRotateSpeed(val);
    persist({ orbitRotateSpeed: val });
  };
  const updateOrbitPanSpeed = (_: unknown, v: number | number[]) => {
    const val = v as number;
    viewer.setControlsConfig({ panSpeed: val });
    setOrbitPanSpeed(val);
    persist({ orbitPanSpeed: val });
  };
  const updateOrbitZoomSpeed = (_: unknown, v: number | number[]) => {
    const val = v as number;
    viewer.setControlsConfig({ zoomSpeed: val });
    setOrbitZoomSpeed(val);
    persist({ orbitZoomSpeed: val });
  };
  const updateOrbitDampingFactor = (_: unknown, v: number | number[]) => {
    const val = v as number;
    viewer.setControlsConfig({ dampingFactor: val });
    setOrbitDampingFactor(val);
    persist({ orbitDampingFactor: val });
  };
  const updateWheelZoomToCursor = (_: unknown, checked: boolean) => {
    viewer.setControlsConfig({ wheelZoomToCursor: checked });
    setWheelZoomToCursor(checked);
    persist({ wheelZoomToCursor: checked });
  };
  const updateNavigateAroundCursorPoint = (_: unknown, checked: boolean) => {
    viewer.setControlsConfig({ navigateAroundCursorPoint: checked });
    setNavigateAroundCursorPoint(checked);
    persist({ navigateAroundCursorPoint: checked });
  };
  const resetNavigation = () => {
    const defaults = {
      orbitRotateSpeed: 1.0,
      orbitPanSpeed: 1.0,
      orbitZoomSpeed: 1.0,
      // plan-515: the reset matches the store default (0.2), not the old 0.08.
      orbitDampingFactor: getDefaultVisualSettings().orbitDampingFactor,
      wheelZoomToCursor: getDefaultVisualSettings().wheelZoomToCursor,
      navigateAroundCursorPoint: getDefaultVisualSettings().navigateAroundCursorPoint,
    };
    viewer.setControlsConfig({
      rotateSpeed: defaults.orbitRotateSpeed,
      panSpeed: defaults.orbitPanSpeed,
      zoomSpeed: defaults.orbitZoomSpeed,
      dampingFactor: defaults.orbitDampingFactor,
      wheelZoomToCursor: defaults.wheelZoomToCursor,
      navigateAroundCursorPoint: defaults.navigateAroundCursorPoint,
    });
    setOrbitRotateSpeed(defaults.orbitRotateSpeed);
    setOrbitPanSpeed(defaults.orbitPanSpeed);
    setOrbitZoomSpeed(defaults.orbitZoomSpeed);
    setOrbitDampingFactor(defaults.orbitDampingFactor);
    setWheelZoomToCursor(defaults.wheelZoomToCursor);
    setNavigateAroundCursorPoint(defaults.navigateAroundCursorPoint);
    persist(defaults);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <SettingsSection id="mouse-navigation" title="Navigation Sensitivity">
        <Box sx={{ display: 'flex', justifyContent: 'flex-end' }}>
          <Button
            size="small"
            variant="text"
            onClick={resetNavigation}
            disabled={settingsLocked}
            startIcon={<RestartAlt />}
            sx={{ fontSize: 11, textTransform: 'none', py: 0, minWidth: 0 }}
          >
            Reset defaults
          </Button>
        </Box>

        <SliderRow
          label="Rotate Speed"
          min={NAVIGATION_RANGES.rotateSpeed.min}
          max={NAVIGATION_RANGES.rotateSpeed.max}
          step={NAVIGATION_RANGES.rotateSpeed.step}
          value={orbitRotateSpeed}
          onChange={updateOrbitRotateSpeed}
          disabled={settingsLocked}
        />

        <SliderRow
          label="Pan Speed"
          min={NAVIGATION_RANGES.panSpeed.min}
          max={NAVIGATION_RANGES.panSpeed.max}
          step={NAVIGATION_RANGES.panSpeed.step}
          value={orbitPanSpeed}
          onChange={updateOrbitPanSpeed}
          disabled={settingsLocked}
        />

        <SliderRow
          label="Zoom Speed"
          min={NAVIGATION_RANGES.zoomSpeed.min}
          max={NAVIGATION_RANGES.zoomSpeed.max}
          step={NAVIGATION_RANGES.zoomSpeed.step}
          value={orbitZoomSpeed}
          onChange={updateOrbitZoomSpeed}
          disabled={settingsLocked}
          format={(v) => v.toFixed(1)}
          hint="applies to mouse wheel, trackpad, pinch"
        />

        <FieldRow
          label="Zoom to mouse cursor"
          hint="On: the mouse wheel zooms toward the point under the cursor. Off: toward the middle of the view. Pinch always zooms under the fingers."
        >
          <Switch
            size="small"
            checked={wheelZoomToCursor}
            onChange={updateWheelZoomToCursor}
            disabled={settingsLocked}
            inputProps={{ 'aria-label': 'Zoom to mouse cursor' }}
          />
        </FieldRow>

        <FieldRow
          label="Orbit around point under cursor"
          hint="On: rotate around and pan by the surface point under the cursor. Off: rotate around the focus point."
        >
          <Switch
            size="small"
            checked={navigateAroundCursorPoint}
            onChange={updateNavigateAroundCursorPoint}
            disabled={settingsLocked}
            inputProps={{ 'aria-label': 'Orbit around point under cursor' }}
          />
        </FieldRow>

        <SliderRow
          label="Inertia (Damping)"
          min={NAVIGATION_RANGES.dampingFactor.min}
          max={NAVIGATION_RANGES.dampingFactor.max}
          step={NAVIGATION_RANGES.dampingFactor.step}
          value={orbitDampingFactor}
          onChange={updateOrbitDampingFactor}
          disabled={settingsLocked}
        />

      </SettingsSection>
    </Box>
  );
}
