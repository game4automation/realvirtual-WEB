// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useRef } from 'react';
import { Typography, Box, Button, ToggleButton, ToggleButtonGroup, Select, MenuItem, Switch, Slider } from '@mui/material';
import { RestartAlt } from '@mui/icons-material';
import { useViewer } from '../../../hooks/use-viewer';
import { isSettingsLocked } from '../../rv-app-config';
import {
  loadVisualSettings, saveVisualSettings, setUIZoom,
  LIGHTING_MODES, TONE_MAPPING_OPTIONS, SHADOW_QUALITY_OPTIONS,
  type VisualSettings, type LightingMode, type ToneMappingType, type ShadowQuality, type ProjectionType,
} from '../visual-settings-store';

export function VisualTab() {
  const viewer = useViewer();
  const settingsRef = useRef(loadVisualSettings());
  const initMs = settingsRef.current.modeSettings[settingsRef.current.lightingMode];
  const [mode, setMode] = useState<LightingMode>(settingsRef.current.lightingMode);
  const [lightInt, setLightInt] = useState(initMs.lightIntensity);
  const [toneMap, setToneMap] = useState<ToneMappingType>(initMs.toneMapping);
  const [exposure, setExposure] = useState(initMs.toneMappingExposure);
  const [ambColor, setAmbColor] = useState(initMs.ambientColor);
  const [ambInt, setAmbInt] = useState(initMs.ambientIntensity);
  const [dirEnabled, setDirEnabled] = useState(initMs.dirLightEnabled);
  const [dirColor, setDirColor] = useState(initMs.dirLightColor);
  const [dirInt, setDirInt] = useState(initMs.dirLightIntensity);
  const [shadowOn, setShadowOn] = useState(initMs.shadowEnabled);
  const [shadowInt, setShadowInt] = useState(initMs.shadowIntensity);
  const [shadowQual, setShadowQual] = useState<ShadowQuality>(initMs.shadowQuality);

  const [proj, setProj] = useState<ProjectionType>(settingsRef.current.projection);
  const [fov, setFov] = useState(settingsRef.current.fov);
  const [antialiasDesired, setAntialiasDesired] = useState<boolean>(settingsRef.current.antialias);
  const [shadowMapSize, setShadowMapSize] = useState<number>(settingsRef.current.shadowMapSize);
  const [shadowRadiusVal, setShadowRadiusVal] = useState<number>(settingsRef.current.shadowRadius);
  const [maxDpr, setMaxDpr] = useState<number>(settingsRef.current.maxDpr);
  const [ssaoOn, setSsaoOn] = useState<boolean>(settingsRef.current.ssaoEnabled);
  const [ssaoInt, setSsaoInt] = useState<number>(settingsRef.current.ssaoIntensity);
  const [ssaoRad, setSsaoRad] = useState<number>(settingsRef.current.ssaoRadius);
  const [bloomOn, setBloomOn] = useState<boolean>(settingsRef.current.bloomEnabled);
  const [bloomInt, setBloomInt] = useState<number>(settingsRef.current.bloomIntensity);
  const [bloomThresh, setBloomThresh] = useState<number>(settingsRef.current.bloomThreshold);
  const [bloomRad, setBloomRad] = useState<number>(settingsRef.current.bloomRadius);
  const [uiZoom, setUiZoom] = useState<number>(settingsRef.current.uiZoom);
  const settingsLocked = isSettingsLocked();

  const persist = (patch: Partial<VisualSettings>) => {
    Object.assign(settingsRef.current, patch);
    saveVisualSettings(settingsRef.current);
  };
  const persistMode = () => persist({ modeSettings: { ...settingsRef.current.modeSettings } });

  const updateMode = (newMode: LightingMode) => {
    // Save current values into old mode
    const old = settingsRef.current.modeSettings[mode];
    old.lightIntensity = lightInt; old.toneMapping = toneMap; old.toneMappingExposure = exposure;
    old.ambientColor = ambColor; old.ambientIntensity = ambInt;
    old.dirLightEnabled = dirEnabled; old.dirLightColor = dirColor; old.dirLightIntensity = dirInt;
    old.shadowEnabled = shadowOn; old.shadowIntensity = shadowInt; old.shadowQuality = shadowQual;
    // Switch mode — apply settings before lightingMode to avoid applyLightingMode resetting them
    setMode(newMode);
    const ms = settingsRef.current.modeSettings[newMode];
    viewer.toneMapping = ms.toneMapping;
    viewer.toneMappingExposure = ms.toneMappingExposure;
    viewer.ambientColor = ms.ambientColor;
    viewer.ambientIntensity = ms.ambientIntensity;
    viewer.dirLightColor = ms.dirLightColor;
    viewer.dirLightIntensity = ms.dirLightIntensity;
    viewer.shadowIntensity = ms.shadowIntensity;
    viewer.shadowQuality = ms.shadowQuality;
    viewer.dirLightEnabled = ms.dirLightEnabled;
    viewer.shadowEnabled = ms.shadowEnabled;
    viewer.lightingMode = newMode;
    viewer.lightIntensity = ms.lightIntensity;
    setLightInt(ms.lightIntensity); setToneMap(ms.toneMapping); setExposure(ms.toneMappingExposure);
    setAmbColor(ms.ambientColor); setAmbInt(ms.ambientIntensity);
    setDirEnabled(ms.dirLightEnabled); setDirColor(ms.dirLightColor); setDirInt(ms.dirLightIntensity);
    setShadowOn(ms.shadowEnabled); setShadowInt(ms.shadowIntensity); setShadowQual(ms.shadowQuality);
    persist({ lightingMode: newMode });
  };

  const updateLightInt = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.lightIntensity = val; setLightInt(val);
    settingsRef.current.modeSettings[mode].lightIntensity = val; persistMode();
  };
  const updateToneMap = (v: ToneMappingType) => {
    viewer.toneMapping = v; setToneMap(v);
    settingsRef.current.modeSettings[mode].toneMapping = v; persistMode();
  };
  const updateExposure = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.toneMappingExposure = val; setExposure(val);
    settingsRef.current.modeSettings[mode].toneMappingExposure = val; persistMode();
  };
  const updateAmbColor = (hex: string) => {
    viewer.ambientColor = hex; setAmbColor(hex);
    settingsRef.current.modeSettings[mode].ambientColor = hex; persistMode();
  };
  const updateAmbInt = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.ambientIntensity = val; setAmbInt(val);
    settingsRef.current.modeSettings[mode].ambientIntensity = val; persistMode();
  };
  const updateDirEnabled = (_: unknown, v: boolean) => {
    viewer.dirLightEnabled = v; setDirEnabled(v);
    if (!v) { viewer.shadowEnabled = false; setShadowOn(false); settingsRef.current.modeSettings[mode].shadowEnabled = false; }
    settingsRef.current.modeSettings[mode].dirLightEnabled = v; persistMode();
  };
  const updateDirColor = (hex: string) => {
    viewer.dirLightColor = hex; setDirColor(hex);
    settingsRef.current.modeSettings[mode].dirLightColor = hex; persistMode();
  };
  const updateDirInt = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.dirLightIntensity = val; setDirInt(val);
    settingsRef.current.modeSettings[mode].dirLightIntensity = val; persistMode();
  };
  const updateShadowOn = (_: unknown, v: boolean) => {
    viewer.shadowEnabled = v; setShadowOn(v);
    settingsRef.current.modeSettings[mode].shadowEnabled = v; persistMode();
  };
  const updateShadowInt = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.shadowIntensity = val; setShadowInt(val);
    settingsRef.current.modeSettings[mode].shadowIntensity = val; persistMode();
  };
  const updateShadowQual = (v: ShadowQuality) => {
    viewer.shadowQuality = v; setShadowQual(v);
    settingsRef.current.modeSettings[mode].shadowQuality = v; persistMode();
  };
  const updateAntialiasDesired = (_: unknown, v: boolean) => {
    setAntialiasDesired(v);
    persist({ antialias: v });
  };
  const updateShadowMapSize = (v: number) => {
    setShadowMapSize(v);
    viewer.shadowMapSize = v;
    persist({ shadowMapSize: v });
  };
  const updateShadowRadius = (_: unknown, v: number | number[]) => {
    const val = v as number;
    setShadowRadiusVal(val);
    viewer.shadowRadius = val;
    persist({ shadowRadius: val });
  };
  const updateMaxDpr = (_: unknown, v: number | number[]) => {
    const val = v as number;
    setMaxDpr(val);
    viewer.maxDpr = val;
    persist({ maxDpr: val });
  };

  const updateSsao = (_: unknown, v: boolean) => {
    viewer.ssaoEnabled = v; setSsaoOn(v);
    persist({ ssaoEnabled: v });
  };
  const updateSsaoInt = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.ssaoIntensity = val; setSsaoInt(val);
    persist({ ssaoIntensity: val });
  };
  const updateSsaoRad = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.ssaoRadius = val; setSsaoRad(val);
    persist({ ssaoRadius: val });
  };
  const updateBloom = (_: unknown, v: boolean) => {
    viewer.bloomEnabled = v; setBloomOn(v);
    persist({ bloomEnabled: v });
  };
  const updateBloomInt = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.bloomIntensity = val; setBloomInt(val);
    persist({ bloomIntensity: val });
  };
  const updateBloomThresh = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.bloomThreshold = val; setBloomThresh(val);
    persist({ bloomThreshold: val });
  };
  const updateBloomRad = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.bloomRadius = val; setBloomRad(val);
    persist({ bloomRadius: val });
  };
  const updateUiZoom = (val: number) => {
    setUiZoom(val); setUIZoom(val); persist({ uiZoom: val });
  };

  const updateProj = (v: ProjectionType) => {
    viewer.projection = v; setProj(v); persist({ projection: v });
  };
  const updateFov = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.fov = val; setFov(val); persist({ fov: val });
  };


  const antialiasMismatch = antialiasDesired !== viewer.antialiasActive;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      {/* UI Zoom */}
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          UI Zoom
        </Typography>
        <ToggleButtonGroup
          exclusive
          size="small"
          value={uiZoom}
          onChange={(_, v) => { if (v !== null) updateUiZoom(v); }}
          sx={{ mt: 0.5, display: 'flex', '& .MuiToggleButton-root': { flex: 1, fontSize: 12, py: 0.5, textTransform: 'none' } }}
        >
          {[0.75, 1.0, 1.25, 1.5, 2.0].map((z) => (
            <ToggleButton key={z} value={z}>{(z * 100).toFixed(0)}%</ToggleButton>
          ))}
        </ToggleButtonGroup>
      </Box>

      {/* Antialiasing */}
      <Box>
        <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <Typography variant="body2" sx={{ color: 'text.primary' }}>Antialiasing (MSAA)</Typography>
          <Switch size="small" checked={antialiasDesired} onChange={updateAntialiasDesired} />
        </Box>
        {antialiasMismatch && (
          <Box sx={{ mt: 0.5 }}>
            <Typography variant="caption" sx={{ color: '#ffb74d', display: 'block', mb: 0.5, fontSize: 11 }}>
              Antialiasing change requires page reload
            </Typography>
            <Button
              size="small"
              variant="outlined"
              onClick={() => window.location.reload()}
              startIcon={<RestartAlt />}
              sx={{ fontSize: 11, textTransform: 'none', borderColor: '#ffb74d', color: '#ffb74d' }}
            >
              Reload now
            </Button>
          </Box>
        )}
      </Box>

      {/* Ambient Occlusion (SSAO) */}
      {!viewer.isWebGPU && (
        <Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="body2" sx={{ color: 'text.primary' }}>Ambient Occlusion</Typography>
            <Switch size="small" checked={ssaoOn} onChange={updateSsao} />
          </Box>
          {ssaoOn && (
            <>
              <Box sx={{ mt: 1 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                  AO Intensity
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                  <Slider size="small" min={0} max={2} step={0.05} value={ssaoInt} onChange={updateSsaoInt} sx={{ flex: 1 }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                    {ssaoInt.toFixed(2)}
                  </Typography>
                </Box>
              </Box>
              <Box>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                  AO Radius
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                  <Slider size="small" min={0.01} max={0.5} step={0.01} value={ssaoRad} onChange={updateSsaoRad} sx={{ flex: 1 }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                    {ssaoRad.toFixed(2)}
                  </Typography>
                </Box>
              </Box>
            </>
          )}
        </Box>
      )}

      {/* Bloom */}
      {!viewer.isWebGPU && (
        <Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="body2" sx={{ color: 'text.primary' }}>Bloom</Typography>
            <Switch size="small" checked={bloomOn} onChange={updateBloom} />
          </Box>
          {bloomOn && (
            <>
              <Box sx={{ mt: 1 }}>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                  Intensity
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                  <Slider size="small" min={0} max={2} step={0.05} value={bloomInt} onChange={updateBloomInt} sx={{ flex: 1 }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                    {bloomInt.toFixed(2)}
                  </Typography>
                </Box>
              </Box>
              <Box>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                  Threshold
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                  <Slider size="small" min={0} max={1} step={0.05} value={bloomThresh} onChange={updateBloomThresh} sx={{ flex: 1 }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                    {bloomThresh.toFixed(2)}
                  </Typography>
                </Box>
              </Box>
              <Box>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                  Radius
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                  <Slider size="small" min={0} max={1} step={0.05} value={bloomRad} onChange={updateBloomRad} sx={{ flex: 1 }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                    {bloomRad.toFixed(2)}
                  </Typography>
                </Box>
              </Box>
            </>
          )}
        </Box>
      )}

      {/* Shadow Map Size */}
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Shadow Map Size
        </Typography>
        <Select
          size="small"
          fullWidth
          value={shadowMapSize}
          onChange={(e) => updateShadowMapSize(Number(e.target.value))}
          sx={{ mt: 0.5 }}
        >
          {[512, 1024, 2048].map((s) => (
            <MenuItem key={s} value={s}>{s}</MenuItem>
          ))}
        </Select>
      </Box>

      {/* Shadow Radius */}
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Shadow Radius
        </Typography>
        <Slider size="small" min={1} max={5} step={1} value={shadowRadiusVal} onChange={updateShadowRadius} valueLabelDisplay="auto" sx={{ mt: 1 }} />
      </Box>

      {/* Render Resolution (DPR) */}
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Render Resolution
        </Typography>
        <Slider size="small" min={0.5} max={2} step={0.25} value={maxDpr} onChange={updateMaxDpr}
          valueLabelDisplay="auto" valueLabelFormat={(v) => v >= 2 ? 'Native' : `${v}x`}
          marks={[{ value: 0.5, label: '0.5x' }, { value: 1, label: '1x' }, { value: 1.5, label: '1.5x' }, { value: 2, label: 'Native' }]}
          sx={{ mt: 1 }} />
      </Box>

      {/* Lighting Mode */}
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Lighting Mode
        </Typography>
        <Select
          size="small"
          fullWidth
          value={mode}
          onChange={(e) => updateMode(e.target.value as LightingMode)}
          sx={{ mt: 0.5 }}
        >
          {LIGHTING_MODES.map((m) => (
            <MenuItem key={m} value={m}>{m.charAt(0).toUpperCase() + m.slice(1)}</MenuItem>
          ))}
        </Select>
      </Box>

      {/* Ambient Light — simple mode only; default mode relies on the HDRI environment */}
      {mode !== 'default' && (
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            Ambient Light
          </Typography>
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 0.5 }}>
            <Slider size="small" min={0} max={2} step={0.05} value={ambInt} onChange={updateAmbInt} sx={{ flex: 1 }} />
            <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
              {ambInt.toFixed(2)}
            </Typography>
            <input
              type="color"
              value={ambColor}
              onChange={(e) => updateAmbColor(e.target.value)}
              style={{ width: 28, height: 28, border: 'none', borderRadius: 4, padding: 0, cursor: 'pointer', background: 'none' }}
            />
          </Box>
        </Box>
      )}

      {/* Global Lighting */}
      <Box>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          {mode === 'default' ? 'Environment Intensity' : 'Global Lighting'}
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
          <Slider size="small" min={0} max={2} step={0.05} value={lightInt} onChange={updateLightInt} sx={{ flex: 1 }} />
          <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
            {lightInt.toFixed(2)}
          </Typography>
        </Box>
      </Box>

      {/* Tone Mapping (default mode only) */}
      {mode === 'default' && (
        <>
          <Box>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
              Tone Mapping
            </Typography>
            <Select
              size="small"
              fullWidth
              value={toneMap}
              onChange={(e) => updateToneMap(e.target.value as ToneMappingType)}
              sx={{ mt: 0.5 }}
            >
              {TONE_MAPPING_OPTIONS.map((t) => (
                <MenuItem key={t} value={t}>{t === 'aces' ? 'ACES Filmic' : t === 'agx' ? 'AgX' : t.charAt(0).toUpperCase() + t.slice(1)}</MenuItem>
              ))}
            </Select>
          </Box>

          {toneMap !== 'none' && (
            <Box>
              <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                Exposure
              </Typography>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                <Slider size="small" min={0} max={3} step={0.05} value={exposure} onChange={updateExposure} sx={{ flex: 1 }} />
                <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                  {exposure.toFixed(2)}
                </Typography>
              </Box>
            </Box>
          )}
        </>
      )}

      {/* Directional Light (default mode only) */}
      {mode === 'default' && (
        <>
          <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)', pt: 2 }}>
            <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Typography variant="body2" sx={{ color: 'text.primary' }}>Directional Light</Typography>
              <Switch size="small" checked={dirEnabled} onChange={updateDirEnabled} />
            </Box>
          </Box>

          {dirEnabled && (
            <>
              <Box>
                <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                  Light Intensity
                </Typography>
                <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, mt: 0.5 }}>
                  <Slider size="small" min={0} max={3} step={0.05} value={dirInt} onChange={updateDirInt} sx={{ flex: 1 }} />
                  <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                    {dirInt.toFixed(2)}
                  </Typography>
                  <input
                    type="color"
                    value={dirColor}
                    onChange={(e) => updateDirColor(e.target.value)}
                    style={{ width: 28, height: 28, border: 'none', borderRadius: 4, padding: 0, cursor: 'pointer', background: 'none' }}
                  />
                </Box>
              </Box>

              {/* Shadows */}
              <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <Typography variant="body2" sx={{ color: 'text.primary' }}>Shadows</Typography>
                <Switch size="small" checked={shadowOn} onChange={updateShadowOn} />
              </Box>

              {shadowOn && (
                <>
                  <Box>
                    <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                      Shadow Intensity
                    </Typography>
                    <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
                      <Slider size="small" min={0} max={3} step={0.05} value={shadowInt} onChange={updateShadowInt} sx={{ flex: 1 }} />
                      <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                        {shadowInt.toFixed(2)}
                      </Typography>
                    </Box>
                  </Box>
                  <Box>
                    <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
                      Shadow Quality
                    </Typography>
                    <Select
                      size="small"
                      fullWidth
                      value={shadowQual}
                      onChange={(e) => updateShadowQual(e.target.value as ShadowQuality)}
                      sx={{ mt: 0.5 }}
                    >
                      {SHADOW_QUALITY_OPTIONS.map((q) => (
                        <MenuItem key={q} value={q}>{q.charAt(0).toUpperCase() + q.slice(1)}</MenuItem>
                      ))}
                    </Select>
                  </Box>
                </>
              )}
            </>
          )}
        </>
      )}

      {/* Renderer */}
      <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)', pt: 2 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Renderer
        </Typography>
        <Select
          size="small"
          fullWidth
          value={viewer.isWebGPU ? 'webgpu' : 'webgl'}
          onChange={(e) => { localStorage.setItem('rv-webviewer-renderer', e.target.value); window.location.reload(); }}
          sx={{ mt: 0.5, fontSize: 13, '& .MuiSelect-select': { py: 0.75 } }}
        >
          <MenuItem value="webgl" sx={{ fontSize: 13 }}>WebGL</MenuItem>
          <MenuItem value="webgpu" disabled={!navigator.gpu} sx={{ fontSize: 13 }}>
            WebGPU (experimental)
            {!navigator.gpu && (
              <Typography component="span" sx={{ ml: 1, fontSize: 10, color: 'text.disabled' }}>not available</Typography>
            )}
          </MenuItem>
        </Select>
      </Box>

      {/* Camera Projection & FOV */}
      <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)', pt: 2 }}>
        <Box>
          <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
            Projection
          </Typography>
          <Select
            size="small"
            fullWidth
            value={proj}
            onChange={(e) => updateProj(e.target.value as ProjectionType)}
            sx={{ mt: 0.5 }}
          >
            <MenuItem value="perspective">Perspective</MenuItem>
            <MenuItem value="orthographic">Orthographic</MenuItem>
          </Select>
        </Box>

        {proj === 'perspective' && (
          <Box sx={{ mt: 2 }}>
            <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
              Field of View
            </Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
              <Slider size="small" min={10} max={120} step={1} value={fov} onChange={updateFov} sx={{ flex: 1 }} />
              <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
                {fov}°
              </Typography>
            </Box>
          </Box>
        )}
      </Box>

    </Box>
  );
}
