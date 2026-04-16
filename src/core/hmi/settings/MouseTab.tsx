// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useRef } from 'react';
import { Typography, Box, Button, Slider } from '@mui/material';
import { RestartAlt } from '@mui/icons-material';
import { useViewer } from '../../../hooks/use-viewer';
import { isSettingsLocked } from '../rv-app-config';
import {
  loadVisualSettings, saveVisualSettings, NAVIGATION_RANGES,
  type VisualSettings,
} from '../visual-settings-store';

/**
 * Settings panel tab — "Mouse & Touch".
 *
 * Controls pointer / touch navigation sensitivity for the OrbitControls camera:
 * rotate, pan, zoom speed (mouse wheel + trackpad + touch pinch) and damping.
 * Values persist to localStorage via visual-settings-store and can be overridden
 * via `settings.json` (key `visual.orbit*`).
 */
export function MouseTab() {
  const viewer = useViewer();
  const settingsRef = useRef(loadVisualSettings());
  const [orbitRotateSpeed, setOrbitRotateSpeed] = useState<number>(settingsRef.current.orbitRotateSpeed);
  const [orbitPanSpeed, setOrbitPanSpeed] = useState<number>(settingsRef.current.orbitPanSpeed);
  const [orbitZoomSpeed, setOrbitZoomSpeed] = useState<number>(settingsRef.current.orbitZoomSpeed);
  const [orbitDampingFactor, setOrbitDampingFactor] = useState<number>(settingsRef.current.orbitDampingFactor);
  const settingsLocked = isSettingsLocked();

  const persist = (patch: Partial<VisualSettings>) => {
    Object.assign(settingsRef.current, patch);
    saveVisualSettings(settingsRef.current);
  };

  const updateOrbitRotateSpeed = (_: unknown, v: number | number[]) => {
    const val = v as number;
    if (viewer.controls) viewer.controls.rotateSpeed = val;
    setOrbitRotateSpeed(val);
    persist({ orbitRotateSpeed: val });
  };
  const updateOrbitPanSpeed = (_: unknown, v: number | number[]) => {
    const val = v as number;
    if (viewer.controls) viewer.controls.panSpeed = val;
    setOrbitPanSpeed(val);
    persist({ orbitPanSpeed: val });
  };
  const updateOrbitZoomSpeed = (_: unknown, v: number | number[]) => {
    const val = v as number;
    if (viewer.controls) viewer.controls.zoomSpeed = val;
    setOrbitZoomSpeed(val);
    persist({ orbitZoomSpeed: val });
  };
  const updateOrbitDampingFactor = (_: unknown, v: number | number[]) => {
    const val = v as number;
    if (viewer.controls) viewer.controls.dampingFactor = val;
    setOrbitDampingFactor(val);
    persist({ orbitDampingFactor: val });
  };
  const resetNavigation = () => {
    const defaults = {
      orbitRotateSpeed: 1.0,
      orbitPanSpeed: 1.0,
      orbitZoomSpeed: 1.0,
      orbitDampingFactor: 0.08,
    };
    if (viewer.controls) {
      viewer.controls.rotateSpeed = defaults.orbitRotateSpeed;
      viewer.controls.panSpeed = defaults.orbitPanSpeed;
      viewer.controls.zoomSpeed = defaults.orbitZoomSpeed;
      viewer.controls.dampingFactor = defaults.orbitDampingFactor;
    }
    setOrbitRotateSpeed(defaults.orbitRotateSpeed);
    setOrbitPanSpeed(defaults.orbitPanSpeed);
    setOrbitZoomSpeed(defaults.orbitZoomSpeed);
    setOrbitDampingFactor(defaults.orbitDampingFactor);
    persist(defaults);
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Navigation Sensitivity
        </Typography>
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

      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Rotate Speed
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
          <Slider
            size="small"
            min={NAVIGATION_RANGES.rotateSpeed.min}
            max={NAVIGATION_RANGES.rotateSpeed.max}
            step={NAVIGATION_RANGES.rotateSpeed.step}
            value={orbitRotateSpeed}
            onChange={updateOrbitRotateSpeed}
            disabled={settingsLocked}
            sx={{ flex: 1 }}
          />
          <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
            {orbitRotateSpeed.toFixed(2)}
          </Typography>
        </Box>
      </Box>

      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Pan Speed
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
          <Slider
            size="small"
            min={NAVIGATION_RANGES.panSpeed.min}
            max={NAVIGATION_RANGES.panSpeed.max}
            step={NAVIGATION_RANGES.panSpeed.step}
            value={orbitPanSpeed}
            onChange={updateOrbitPanSpeed}
            disabled={settingsLocked}
            sx={{ flex: 1 }}
          />
          <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
            {orbitPanSpeed.toFixed(2)}
          </Typography>
        </Box>
      </Box>

      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Zoom Speed
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
          <Slider
            size="small"
            min={NAVIGATION_RANGES.zoomSpeed.min}
            max={NAVIGATION_RANGES.zoomSpeed.max}
            step={NAVIGATION_RANGES.zoomSpeed.step}
            value={orbitZoomSpeed}
            onChange={updateOrbitZoomSpeed}
            disabled={settingsLocked}
            sx={{ flex: 1 }}
          />
          <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
            {orbitZoomSpeed.toFixed(1)}
          </Typography>
        </Box>
        <Typography variant="caption" sx={{ color: 'text.disabled', display: 'block', fontSize: 10, mt: 0.25 }}>
          applies to mouse wheel, trackpad, pinch
        </Typography>
      </Box>

      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Inertia (Damping)
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
          <Slider
            size="small"
            min={NAVIGATION_RANGES.dampingFactor.min}
            max={NAVIGATION_RANGES.dampingFactor.max}
            step={NAVIGATION_RANGES.dampingFactor.step}
            value={orbitDampingFactor}
            onChange={updateOrbitDampingFactor}
            disabled={settingsLocked}
            sx={{ flex: 1 }}
          />
          <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
            {orbitDampingFactor.toFixed(2)}
          </Typography>
        </Box>
      </Box>
    </Box>
  );
}
