// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useRef } from 'react';
import { Typography, Box, Switch, Slider, Select, MenuItem, type SelectChangeEvent } from '@mui/material';
import { useViewer } from '../../../hooks/use-viewer';
import { loadVisualSettings, saveVisualSettings, type VisualSettings } from '../visual-settings-store';
import { ENVIRONMENT_PRESETS, matchEnvironmentPreset, markEnvironmentUserModified, type EnvironmentPresetName } from '../environment-presets';

export function EnvironmentTab() {
  const viewer = useViewer();
  const settingsRef = useRef(loadVisualSettings());

  const [bgBright, setBgBright] = useState<number>(settingsRef.current.backgroundBrightness);
  const [groundOn, setGroundOn] = useState<boolean>(settingsRef.current.groundEnabled);
  const [groundBright, setGroundBright] = useState<number>(settingsRef.current.groundBrightness);
  const [contrast, setContrast] = useState<number>(settingsRef.current.checkerContrast);

  const persist = (patch: Partial<VisualSettings>) => {
    Object.assign(settingsRef.current, patch);
    saveVisualSettings(settingsRef.current);
  };

  const applyPreset = (e: SelectChangeEvent<string>) => {
    const name = e.target.value as EnvironmentPresetName;
    const preset = ENVIRONMENT_PRESETS[name];
    if (!preset) return;
    viewer.backgroundBrightness = preset.background;
    viewer.groundBrightness = preset.floor;
    viewer.checkerContrast = preset.contrast;
    setBgBright(preset.background);
    setGroundBright(preset.floor);
    setContrast(preset.contrast);
    persist({
      backgroundBrightness: preset.background,
      groundBrightness: preset.floor,
      checkerContrast: preset.contrast,
    });
  };

  const currentPreset = matchEnvironmentPreset(bgBright, groundBright, contrast);

  const updateBgBright = (_: unknown, v: number | number[]) => {
    const val = v as number;
    viewer.backgroundBrightness = val;
    setBgBright(val);
    persist({ backgroundBrightness: val });
    markEnvironmentUserModified();
  };

  const updateGroundOn = (_: unknown, v: boolean) => {
    viewer.groundEnabled = v;
    setGroundOn(v);
    persist({ groundEnabled: v });
    markEnvironmentUserModified();
  };

  const updateGroundBright = (_: unknown, v: number | number[]) => {
    const val = v as number;
    viewer.groundBrightness = val;
    setGroundBright(val);
    persist({ groundBrightness: val });
    markEnvironmentUserModified();
  };

  const updateContrast = (_: unknown, v: number | number[]) => {
    const val = v as number;
    viewer.checkerContrast = val;
    setContrast(val);
    persist({ checkerContrast: val });
    markEnvironmentUserModified();
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      {/* Preset */}
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Preset
        </Typography>
        <Select
          size="small"
          fullWidth
          value={currentPreset === 'Custom' ? '' : currentPreset}
          displayEmpty
          onChange={applyPreset}
          renderValue={(v) => (v ? (v as string) : currentPreset)}
          sx={{ mt: 0.5 }}
        >
          {Object.keys(ENVIRONMENT_PRESETS).map((name) => (
            <MenuItem key={name} value={name}>{name}</MenuItem>
          ))}
        </Select>
      </Box>

      {/* Background */}
      <Box>
        <Typography variant="body2" sx={{ color: 'text.primary' }}>Background</Typography>
        <Box sx={{ mt: 1 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            Background Brightness
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
            <Slider size="small" min={0} max={2} step={0.05} value={bgBright} onChange={updateBgBright} sx={{ flex: 1 }} />
            <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
              {bgBright.toFixed(2)}
            </Typography>
          </Box>
        </Box>
      </Box>

      {/* Floor / Ground Plane */}
      <Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="body2" sx={{ color: 'text.primary' }}>Floor</Typography>
          <Switch size="small" checked={groundOn} onChange={updateGroundOn} />
        </Box>
        {groundOn && (
          <>
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                Floor Brightness
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                <Slider size="small" min={0} max={2} step={0.05} value={groundBright} onChange={updateGroundBright} sx={{ flex: 1 }} />
                <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                  {groundBright.toFixed(2)}
                </Typography>
              </Box>
            </Box>
            <Box sx={{ mt: 1 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                Checker Contrast
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                <Slider size="small" min={0} max={2} step={0.05} value={contrast} onChange={updateContrast} sx={{ flex: 1 }} />
                <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                  {contrast.toFixed(2)}
                </Typography>
              </Box>
            </Box>
          </>
        )}
      </Box>
    </Box>
  );
}
