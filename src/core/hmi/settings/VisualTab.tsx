// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useRef } from 'react';
import {
  Typography, Box, Button, ToggleButton, ToggleButtonGroup, Select, MenuItem, Switch,
  Dialog, DialogTitle, DialogContent, DialogActions, TextField, Tooltip,
} from '@mui/material';
import { RestartAlt, BookmarkAdd } from '@mui/icons-material';
import { useViewer } from '../../../hooks/use-viewer';
import { isSettingsLocked } from '../../rv-app-config';
import {
  loadVisualSettings, saveVisualSettings, setUIZoom,
  useSourceMarkersVisible,
  useToolbarShowLabels, setToolbarShowLabels,
  TONE_MAPPING_OPTIONS, SHADOW_QUALITY_OPTIONS,
  type VisualSettings, type ToneMappingType, type ShadowQuality, type ProjectionType,
  type AOMode,
} from '../visual-settings-store';
import {
  listPresets, applyVisualPreset, captureCurrentPreset, savePreset, matchPreset,
} from '../visual-presets';
import { markEnvironmentUserModified } from '../environment-presets';
import { showInfoOverlay } from '../info-overlay-store';
import { RENDER_MODES, getRenderMode, type RenderMode } from '../../rv-render-modes';
import { STATIC_MERGE_LS_KEY, isStaticMeshMergingEnabled } from '../../engine/rv-static-merge-flag';
import { SettingsSection, FieldRow, SliderRow } from './settings-helpers';

/** Outer wrapper: remounts the body (via `key`) after a preset is applied so all
 *  sliders/dropdowns re-read the freshly-applied visual settings. */
export function VisualTab() {
  const [version, setVersion] = useState(0);
  return <VisualTabBody key={version} onPresetApplied={() => setVersion((v) => v + 1)} />;
}

function VisualTabBody({ onPresetApplied }: { onPresetApplied: () => void }) {
  const viewer = useViewer();
  const settingsRef = useRef(loadVisualSettings());
  const initMs = settingsRef.current.modeSettings[settingsRef.current.renderMode];
  const [mode, setMode] = useState<RenderMode>(settingsRef.current.renderMode);
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
  const [aoMode, setAoMode] = useState<AOMode>(settingsRef.current.aoMode);
  const [ssaoInt, setSsaoInt] = useState<number>(settingsRef.current.ssaoIntensity);
  const [ssaoRad, setSsaoRad] = useState<number>(settingsRef.current.ssaoRadius);
  const [bloomOn, setBloomOn] = useState<boolean>(settingsRef.current.bloomEnabled);
  const [bloomInt, setBloomInt] = useState<number>(settingsRef.current.bloomIntensity);
  const [bloomThresh, setBloomThresh] = useState<number>(settingsRef.current.bloomThreshold);
  const [bloomRad, setBloomRad] = useState<number>(settingsRef.current.bloomRadius);
  const [toonBands, setToonBands] = useState<number>(settingsRef.current.toonBands);
  const [toonCoolShadows, setToonCoolShadows] = useState<boolean>(settingsRef.current.toonCoolShadows);
  const [toonMetallic, setToonMetallic] = useState<number>(settingsRef.current.toonMetallic);
  const [toonMetallicCol, setToonMetallicCol] = useState<string>(settingsRef.current.toonMetallicColor);
  const [toonAlbedoMin, setToonAlbedoMin] = useState<number>(settingsRef.current.toonAlbedoMinBrightness);
  const [toonAlbedoMax, setToonAlbedoMax] = useState<number>(settingsRef.current.toonAlbedoMaxBrightness);
  const [toonAlbedoSat, setToonAlbedoSat] = useState<number>(settingsRef.current.toonAlbedoSaturation);
  const [toonOutlineAmount, setToonOutlineAmount] = useState<number>(settingsRef.current.toonOutlineAmount);
  const [toonOutlineThick, setToonOutlineThick] = useState<number>(settingsRef.current.toonOutlineThickness);
  const [toonOutlineThreshold, setToonOutlineThreshold] = useState<number>(settingsRef.current.toonOutlineThreshold);
  const [toonOutlineDist, setToonOutlineDist] = useState<number>(settingsRef.current.toonOutlineDistance);
  const [toonOutlineSS, setToonOutlineSS] = useState<boolean>(settingsRef.current.toonOutlineSupersample);
  const [toonOutlineCol, setToonOutlineCol] = useState<string>(settingsRef.current.toonOutlineColor);
  const [uiZoom, setUiZoom] = useState<number>(settingsRef.current.uiZoom);
  // Environment / Floor (moved from the former Environment tab — these fields
  // already live in VisualSettings).
  const [bgBright, setBgBright] = useState<number>(settingsRef.current.backgroundBrightness);
  const [groundOn, setGroundOn] = useState<boolean>(settingsRef.current.groundEnabled);
  const [groundBright, setGroundBright] = useState<number>(settingsRef.current.groundBrightness);
  const [groundColor, setGroundColor] = useState<string>(settingsRef.current.groundColor);
  const [contrast, setContrast] = useState<number>(settingsRef.current.checkerContrast);
  const [reflectionOn, setReflectionOn] = useState<boolean>(settingsRef.current.reflectionEnabled);
  const [reflectionStrength, setReflectionStrength] = useState<number>(settingsRef.current.reflectionStrength);
  const [reflectionBlur, setReflectionBlur] = useState<number>(settingsRef.current.reflectionBlur);
  // Unlit-only HDRI reflections
  const [envReflOn, setEnvReflOn] = useState<boolean>(settingsRef.current.envReflectionsEnabled);
  const [envReflInt, setEnvReflInt] = useState<number>(settingsRef.current.envReflectionsIntensity);

  // Visual presets
  const [presetDialogOpen, setPresetDialogOpen] = useState(false);
  const [presetName, setPresetName] = useState('');
  const [savingPreset, setSavingPreset] = useState(false);

  const sourceMarkersVisible = useSourceMarkersVisible();
  const toolbarShowLabels = useToolbarShowLabels();
  const settingsLocked = isSettingsLocked();
  const [driveAxisGizmoOn, setDriveAxisGizmoOn] = useState<boolean>(settingsRef.current.showDriveAxisGizmo);

  const updateSourceMarkersVisible = (_: unknown, v: boolean): void => {
    viewer.setSourceMarkersVisible(v);
  };

  const persist = (patch: Partial<VisualSettings>) => {
    Object.assign(settingsRef.current, patch);
    saveVisualSettings(settingsRef.current);
  };

  const updateDriveAxisGizmo = (_: unknown, v: boolean): void => {
    viewer.showDriveAxisGizmo = v; setDriveAxisGizmoOn(v); persist({ showDriveAxisGizmo: v });
  };
  const persistMode = () => persist({ modeSettings: { ...settingsRef.current.modeSettings } });

  const updateMode = (newMode: RenderMode) => {
    // Save current values into old mode
    const old = settingsRef.current.modeSettings[mode];
    old.lightIntensity = lightInt; old.toneMapping = toneMap; old.toneMappingExposure = exposure;
    old.ambientColor = ambColor; old.ambientIntensity = ambInt;
    old.dirLightEnabled = dirEnabled; old.dirLightColor = dirColor; old.dirLightIntensity = dirInt;
    old.shadowEnabled = shadowOn; old.shadowIntensity = shadowInt; old.shadowQuality = shadowQual;
    // Switch mode. Apply the per-mode lighting values BEFORE viewer.renderMode so
    // the manager's applyLightingMode doesn't reset them. The renderMode setter
    // itself gates AO / bloom / shadows by the mode's capabilities, so we don't
    // toggle those manually here.
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
    viewer.renderMode = newMode;
    viewer.lightIntensity = ms.lightIntensity;
    setLightInt(ms.lightIntensity); setToneMap(ms.toneMapping); setExposure(ms.toneMappingExposure);
    setAmbColor(ms.ambientColor); setAmbInt(ms.ambientIntensity);
    setDirEnabled(ms.dirLightEnabled); setDirColor(ms.dirLightColor); setDirInt(ms.dirLightIntensity);
    setShadowOn(ms.shadowEnabled); setShadowInt(ms.shadowIntensity); setShadowQual(ms.shadowQuality);
    persist({ renderMode: newMode });
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

  const updateAoMode = (next: AOMode) => {
    viewer.aoMode = next;
    setAoMode(next);
    persist({ aoMode: next });
    // If the viewer refused the N8AO switch (lazy-load failure), it will have
    // reverted its own aoMode to 'gtao'. Give it a tick to settle, then
    // reconcile local state so the dropdown reflects reality.
    if (next === 'n8ao') {
      setTimeout(() => {
        const actual = viewer.aoMode;
        if (actual !== next) {
          setAoMode(actual);
          persist({ aoMode: actual });
        }
      }, 250);
    }
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
  const updateToonBands = (v: number) => {
    viewer.toonBands = v; setToonBands(v); persist({ toonBands: v });
  };
  const updateToonCoolShadows = (_: unknown, v: boolean) => {
    viewer.toonCoolShadows = v; setToonCoolShadows(v); persist({ toonCoolShadows: v });
  };
  const updateToonMetallic = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.toonMetallic = val; setToonMetallic(val); persist({ toonMetallic: val });
  };
  const updateToonMetallicColor = (hex: string) => {
    viewer.toonMetallicColor = hex; setToonMetallicCol(hex); persist({ toonMetallicColor: hex });
  };
  const updateToonAlbedoMin = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.toonAlbedoMinBrightness = val; setToonAlbedoMin(val); persist({ toonAlbedoMinBrightness: val });
  };
  const updateToonAlbedoMax = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.toonAlbedoMaxBrightness = val; setToonAlbedoMax(val); persist({ toonAlbedoMaxBrightness: val });
  };
  const updateToonAlbedoSat = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.toonAlbedoSaturation = val; setToonAlbedoSat(val); persist({ toonAlbedoSaturation: val });
  };
  const updateToonOutlineAmount = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.toonOutlineAmount = val; setToonOutlineAmount(val); persist({ toonOutlineAmount: val });
  };
  const updateToonOutlineThick = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.toonOutlineThickness = val; setToonOutlineThick(val); persist({ toonOutlineThickness: val });
  };
  const updateToonOutlineThreshold = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.toonOutlineThreshold = val; setToonOutlineThreshold(val); persist({ toonOutlineThreshold: val });
  };
  const updateToonOutlineDist = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.toonOutlineDistance = val; setToonOutlineDist(val); persist({ toonOutlineDistance: val });
  };
  const updateToonOutlineSS = (_: unknown, v: boolean) => {
    viewer.toonOutlineSupersample = v; setToonOutlineSS(v); persist({ toonOutlineSupersample: v });
  };
  const updateToonOutlineCol = (hex: string) => {
    viewer.toonOutlineColor = hex; setToonOutlineCol(hex); persist({ toonOutlineColor: hex });
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

  // ─── Environment / Floor updaters (moved from EnvironmentTab) ───────────
  const updateBgBright = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.backgroundBrightness = val; setBgBright(val);
    persist({ backgroundBrightness: val }); markEnvironmentUserModified();
  };
  const updateGroundOn = (_: unknown, v: boolean) => {
    viewer.groundEnabled = v; setGroundOn(v); persist({ groundEnabled: v }); markEnvironmentUserModified();
  };
  const updateGroundBright = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.groundBrightness = val; setGroundBright(val);
    persist({ groundBrightness: val }); markEnvironmentUserModified();
  };
  const updateGroundColor = (hex: string) => {
    viewer.groundColor = hex; setGroundColor(hex); persist({ groundColor: hex }); markEnvironmentUserModified();
  };
  const updateContrast = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.checkerContrast = val; setContrast(val);
    persist({ checkerContrast: val }); markEnvironmentUserModified();
  };
  const updateReflectionOn = (_: unknown, v: boolean) => {
    viewer.reflectionEnabled = v; setReflectionOn(v); persist({ reflectionEnabled: v }); markEnvironmentUserModified();
  };
  const updateReflectionStrength = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.reflectionStrength = val; setReflectionStrength(val);
    persist({ reflectionStrength: val }); markEnvironmentUserModified();
  };
  const updateReflectionBlur = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.reflectionBlur = val; setReflectionBlur(val);
    persist({ reflectionBlur: val }); markEnvironmentUserModified();
  };
  const updateEnvReflOn = (_: unknown, v: boolean) => {
    viewer.unlitReflectionsEnabled = v; setEnvReflOn(v); persist({ envReflectionsEnabled: v });
  };
  const updateEnvReflInt = (_: unknown, v: number | number[]) => {
    const val = v as number; viewer.unlitReflectionsIntensity = val; setEnvReflInt(val);
    persist({ envReflectionsIntensity: val });
  };

  // ─── Visual presets ────────────────────────────────────────────────────
  const presets = listPresets();
  const currentPresetName = matchPreset(presets) ?? '';

  const applyPreset = (name: string) => {
    const p = presets.find((x) => x.name === name);
    if (!p) return;
    applyVisualPreset(viewer, p);
    onPresetApplied(); // remount body so every control reflects the applied preset
  };

  const handleSavePreset = async () => {
    const name = presetName.trim();
    if (!name) return;
    setSavingPreset(true);
    const where = await savePreset(captureCurrentPreset(name));
    setSavingPreset(false);
    setPresetDialogOpen(false);
    setPresetName('');
    showInfoOverlay(where === 'file'
      ? `Preset "${name}" saved to public/presets (part of the published source).`
      : `Preset "${name}" saved locally (this browser only).`);
    onPresetApplied(); // remount so the new preset appears in the dropdown
  };


  const antialiasMismatch = antialiasDesired !== viewer.antialiasActive;
  // Capabilities of the active render mode drive which control blocks render.
  const caps = getRenderMode(mode).capabilities;
  const colorInputStyle = { width: 28, height: 22, border: 'none', borderRadius: 4, padding: 0, cursor: 'pointer', background: 'none' } as const;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>

      {/* Visual Presets — full-look snapshots (render mode + environment + post). */}
      <SettingsSection id="visual-presets" title="Visual Presets">
        <FieldRow label="Preset">
          <Select
            size="small"
            fullWidth
            value={currentPresetName}
            displayEmpty
            onChange={(e) => applyPreset(e.target.value as string)}
            renderValue={(v) => (v ? (v as string) : 'Custom')}
            disabled={settingsLocked}
          >
            {presets.map((p) => (
              <MenuItem key={p.name} value={p.name}>{p.name}</MenuItem>
            ))}
          </Select>
        </FieldRow>
        <Tooltip title="Capture the current visual settings (render mode, environment, lighting, post-processing, antialias) as a reusable preset." placement="bottom">
          <span>
            <Button
              size="small"
              variant="outlined"
              fullWidth
              startIcon={<BookmarkAdd sx={{ fontSize: 16 }} />}
              onClick={() => { setPresetName(''); setPresetDialogOpen(true); }}
              disabled={settingsLocked}
              sx={{ textTransform: 'none', fontSize: 12, mt: 0.5 }}
            >
              Save settings as preset
            </Button>
          </span>
        </Tooltip>
      </SettingsSection>

      {/* Render Mode + appearance basics */}
      <SettingsSection id="visual-rendermode" title="Render Mode">
        <FieldRow label="Mode" hint={getRenderMode(mode).description}>
          <Select
            size="small"
            fullWidth
            value={mode}
            onChange={(e) => updateMode(e.target.value as RenderMode)}
            disabled={settingsLocked}
          >
            {RENDER_MODES.map((m) => (
              <MenuItem key={m.id} value={m.id}>{m.label}</MenuItem>
            ))}
          </Select>
        </FieldRow>

        {/* Brightness — shown in every mode (labelled by the environment capability) */}
        <SliderRow label={caps.environment ? 'Environment' : 'Brightness'} min={0} max={2} step={0.05} value={lightInt} onChange={updateLightInt} />

        {/* Base color — flat-ambient ("unlit") modes only */}
        {caps.ambientLight && (
          <FieldRow label="Base Color" hint="Flat tint applied across all surfaces.">
            <input type="color" value={ambColor} onChange={(e) => updateAmbColor(e.target.value)} style={colorInputStyle} />
          </FieldRow>
        )}
      </SettingsSection>

      {/* Environment / Floor — moved from the former Environment tab. */}
      <SettingsSection id="visual-environment" title="Environment / Floor">
        <SliderRow label="Background" min={0} max={2} step={0.05} value={bgBright} onChange={updateBgBright} />
        <FieldRow label="Floor">
          <Switch size="small" checked={groundOn} onChange={updateGroundOn} />
        </FieldRow>
        {groundOn && (
          <>
            <SliderRow label="Floor Brightness" min={0} max={2} step={0.05} value={groundBright} onChange={updateGroundBright} />
            <FieldRow label="Floor Color">
              <input type="color" value={groundColor} onChange={(e) => updateGroundColor(e.target.value)} style={colorInputStyle} />
            </FieldRow>
            <SliderRow label="Checker Contrast" min={0} max={2} step={0.05} value={contrast} onChange={updateContrast} />
            {caps.reflection && (
              <>
                <FieldRow label="Reflection">
                  <Switch size="small" checked={reflectionOn} onChange={updateReflectionOn} />
                </FieldRow>
                {reflectionOn && (
                  <>
                    <SliderRow label="Reflection Strength" min={0} max={1} step={0.05} value={reflectionStrength} onChange={updateReflectionStrength} />
                    <SliderRow label="Reflection Blur" min={0} max={1} step={0.05} value={reflectionBlur} onChange={updateReflectionBlur} />
                  </>
                )}
              </>
            )}
          </>
        )}
      </SettingsSection>

      {/* Reflections — Unlit only. HDRI env reflections on metallic/glossy
          surfaces, decoupled from the flat ambient look. */}
      {mode === 'simple' && (
        <SettingsSection id="visual-unlit-reflections" title="Reflections">
          <FieldRow label="Environment" hint="Reflect the HDRI environment on metallic and glossy surfaces while keeping the flat unlit look.">
            <Switch size="small" checked={envReflOn} onChange={updateEnvReflOn} />
          </FieldRow>
          {envReflOn && (
            <SliderRow label="Intensity" min={0} max={2} step={0.05} value={envReflInt} onChange={updateEnvReflInt} />
          )}
        </SettingsSection>
      )}

      {/* Tone Mapping */}
      {caps.toneMapping && (
        <SettingsSection id="visual-tonemapping" title="Tone Mapping">
          <FieldRow label="Mode">
            <Select
              size="small"
              fullWidth
              value={toneMap}
              onChange={(e) => updateToneMap(e.target.value as ToneMappingType)}
            >
              {TONE_MAPPING_OPTIONS.map((t) => (
                <MenuItem key={t} value={t}>{t === 'aces' ? 'ACES Filmic' : t === 'agx' ? 'AgX' : t.charAt(0).toUpperCase() + t.slice(1)}</MenuItem>
              ))}
            </Select>
          </FieldRow>

          {toneMap !== 'none' && (
            <SliderRow label="Exposure" min={0} max={3} step={0.05} value={exposure} onChange={updateExposure} />
          )}
        </SettingsSection>
      )}

      {/* Lighting & Shadows */}
      {caps.directionalLight && (
        <SettingsSection id="visual-lighting" title="Lighting & Shadows">
          <FieldRow label="Directional Light">
            <Switch size="small" checked={dirEnabled} onChange={updateDirEnabled} />
          </FieldRow>

          {dirEnabled && (
            <>
              <SliderRow label="Light Intensity" min={0} max={3} step={0.05} value={dirInt} onChange={updateDirInt} />
              <FieldRow label="Light Color">
                <input type="color" value={dirColor} onChange={(e) => updateDirColor(e.target.value)} style={colorInputStyle} />
              </FieldRow>

              {/* Shadows — only for modes that support the shadow pass */}
              {caps.shadows && (
                <>
                  <FieldRow label="Shadows">
                    <Switch size="small" checked={shadowOn} onChange={updateShadowOn} />
                  </FieldRow>

                  {shadowOn && (
                    <>
                      <SliderRow label="Shadow Intensity" min={0} max={3} step={0.05} value={shadowInt} onChange={updateShadowInt} />
                      <FieldRow label="Shadow Quality">
                        <Select
                          size="small"
                          fullWidth
                          value={shadowQual}
                          onChange={(e) => updateShadowQual(e.target.value as ShadowQuality)}
                        >
                          {SHADOW_QUALITY_OPTIONS.map((q) => (
                            <MenuItem key={q} value={q}>{q.charAt(0).toUpperCase() + q.slice(1)}</MenuItem>
                          ))}
                        </Select>
                      </FieldRow>
                      <FieldRow label="Shadow Map">
                        <Select
                          size="small"
                          fullWidth
                          value={shadowMapSize}
                          onChange={(e) => updateShadowMapSize(Number(e.target.value))}
                        >
                          {[512, 1024, 2048].map((s) => (
                            <MenuItem key={s} value={s}>{s}</MenuItem>
                          ))}
                        </Select>
                      </FieldRow>
                      <SliderRow label="Shadow Radius" min={1} max={5} step={1} value={shadowRadiusVal} onChange={updateShadowRadius} format={(v) => String(v)} />
                    </>
                  )}
                </>
              )}
            </>
          )}
        </SettingsSection>
      )}

      {/* Post-Processing (ambient occlusion + bloom) — WebGL only */}
      {(caps.ambientOcclusion || caps.bloom) && !viewer.isWebGPU && (
        <SettingsSection id="visual-postfx" title="Post-Processing">
          {/* Ambient Occlusion (Off / GTAO / N8AO) */}
          {caps.ambientOcclusion && (
            <>
              <FieldRow label="Ambient Occl.">
                <Select
                  size="small"
                  fullWidth
                  value={aoMode}
                  onChange={(e) => updateAoMode(e.target.value as AOMode)}
                >
                  <MenuItem value="off">Off</MenuItem>
                  <MenuItem value="gtao">GTAO · Built-in</MenuItem>
                  <MenuItem value="n8ao">N8AO · High quality</MenuItem>
                </Select>
              </FieldRow>
              {aoMode !== 'off' && (
                <>
                  <SliderRow label="AO Intensity" min={0} max={2} step={0.05} value={ssaoInt} onChange={updateSsaoInt} />
                  <SliderRow label="AO Radius" min={0.01} max={0.5} step={0.01} value={ssaoRad} onChange={updateSsaoRad} />
                </>
              )}
            </>
          )}

          {/* Bloom */}
          {caps.bloom && (
            <>
              <FieldRow label="Bloom">
                <Switch size="small" checked={bloomOn} onChange={updateBloom} />
              </FieldRow>
              {bloomOn && (
                <>
                  <SliderRow label="Intensity" min={0} max={2} step={0.05} value={bloomInt} onChange={updateBloomInt} />
                  <SliderRow label="Threshold" min={0} max={1} step={0.05} value={bloomThresh} onChange={updateBloomThresh} />
                  <SliderRow label="Radius" min={0} max={1} step={0.05} value={bloomRad} onChange={updateBloomRad} />
                </>
              )}
            </>
          )}
        </SettingsSection>
      )}

      {/* Toon — direction-based shading (caps.toon only) */}
      {caps.toon && (
        <SettingsSection id="visual-toon-shading" title="Toon">
          <FieldRow label="Bands" hint="Number of discrete shading steps (banded by light direction).">
            <ToggleButtonGroup
              exclusive
              size="small"
              value={toonBands}
              onChange={(_, v) => { if (v !== null) updateToonBands(v as number); }}
              sx={{ flex: 1, display: 'flex', '& .MuiToggleButton-root': { flex: 1, fontSize: 11, py: 0.25, textTransform: 'none' } }}
            >
              {[2, 3, 4, 5, 6].map((b) => (
                <ToggleButton key={b} value={b}>{b}</ToggleButton>
              ))}
            </ToggleButtonGroup>
          </FieldRow>

          <FieldRow label="Cool shadows" hint="Tint the dark bands slightly blue for a more illustrated look.">
            <Switch size="small" checked={toonCoolShadows} onChange={updateToonCoolShadows} />
          </FieldRow>

          <SliderRow label="Min Brightness" min={0} max={1} step={0.05} value={toonAlbedoMin} onChange={updateToonAlbedoMin} />
          <SliderRow label="Max Brightness" min={0} max={1} step={0.05} value={toonAlbedoMax} onChange={updateToonAlbedoMax} />
          <SliderRow label="Saturation" min={0} max={2} step={0.05} value={toonAlbedoSat} onChange={updateToonAlbedoSat} />

          <SliderRow label="Metallic" min={0} max={1} step={0.05} value={toonMetallic} onChange={updateToonMetallic} />
          <FieldRow label="Metallic Color" hint="Flat tint applied to metallic surfaces (kept cel-banded).">
            <input type="color" value={toonMetallicCol} onChange={(e) => updateToonMetallicColor(e.target.value)} style={colorInputStyle} />
          </FieldRow>
        </SettingsSection>
      )}

      {/* Toon — edge / outline (caps.toon only; WebGL only) */}
      {caps.toon && (
        <SettingsSection id="visual-toon-edge" title="Edge">
          {!viewer.isWebGPU ? (
            <>
              <SliderRow label="Amount" min={0} max={1} step={0.05} value={toonOutlineAmount} onChange={updateToonOutlineAmount} />
              <SliderRow label="Thickness" min={0} max={5} step={0.5} value={toonOutlineThick} onChange={updateToonOutlineThick} />
              <SliderRow label="Threshold" min={0} max={1} step={0.02} value={toonOutlineThreshold} onChange={updateToonOutlineThreshold} />
              <SliderRow label="Distance (m)" min={0} max={100} step={1} value={toonOutlineDist} onChange={updateToonOutlineDist} />
              <FieldRow label="Color" hint="Color of the silhouette + crease lines.">
                <input type="color" value={toonOutlineCol} onChange={(e) => updateToonOutlineCol(e.target.value)} style={colorInputStyle} />
              </FieldRow>
              <FieldRow label="Supersample x2" hint="Render the edge depth buffer at 2× for higher-quality, smoother edges (heavier on the GPU).">
                <Switch size="small" checked={toonOutlineSS} onChange={updateToonOutlineSS} />
              </FieldRow>
            </>
          ) : (
            <Typography variant="caption" sx={{ color: '#999', fontSize: 11 }}>
              Edge outlines require WebGL (not available on WebGPU).
            </Typography>
          )}
        </SettingsSection>
      )}

      {/* Display (mode-independent) */}
      <SettingsSection id="visual-display" title="Display">
        {/* UI Zoom */}
        <FieldRow label="UI Zoom">
          <ToggleButtonGroup
            exclusive
            size="small"
            value={uiZoom}
            onChange={(_, v) => { if (v !== null) updateUiZoom(v); }}
            sx={{ flex: 1, display: 'flex', '& .MuiToggleButton-root': { flex: 1, fontSize: 11, py: 0.25, textTransform: 'none' } }}
          >
            {[0.75, 1.0, 1.25, 1.5, 2.0].map((z) => (
              <ToggleButton key={z} value={z}>{(z * 100).toFixed(0)}%</ToggleButton>
            ))}
          </ToggleButtonGroup>
        </FieldRow>

        {/* Source markers (plan-181) — floor ring + label under each Source */}
        <FieldRow label="Source markers" hint="Floor ring + label under each source to identify spawn locations.">
          <Switch
            size="small"
            checked={sourceMarkersVisible}
            onChange={updateSourceMarkersVisible}
            disabled={settingsLocked}
          />
        </FieldRow>

        {/* Drive axis gizmo (plan-249) — motion axis overlay on selected drives */}
        <FieldRow label="Drive axis gizmo" hint="Show the motion axis (double arrow / rotation ring) on selected drives.">
          <Switch
            size="small"
            checked={driveAxisGizmoOn}
            onChange={updateDriveAxisGizmo}
          />
        </FieldRow>

        {/* Toolbar button labels — show text next to icons in top-left toolbar */}
        <FieldRow label="Toolbar labels" hint="Show text labels next to icons in the top-left toolbar. Always collapsed on mobile.">
          <Switch
            size="small"
            checked={toolbarShowLabels}
            onChange={(_, v) => setToolbarShowLabels(v)}
          />
        </FieldRow>

        {/* Antialiasing */}
        <FieldRow label="Antialiasing">
          <Switch size="small" checked={antialiasDesired} onChange={updateAntialiasDesired} />
        </FieldRow>
        {antialiasMismatch && (
          <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 1 }}>
            <Typography variant="caption" sx={{ color: '#ffb74d', fontSize: 11 }}>
              Reload required
            </Typography>
            <Button
              size="small"
              variant="outlined"
              onClick={() => window.location.reload()}
              startIcon={<RestartAlt />}
              sx={{ fontSize: 11, textTransform: 'none', py: 0, borderColor: '#ffb74d', color: '#ffb74d' }}
            >
              Reload now
            </Button>
          </Box>
        )}

        {/* Render Resolution (DPR) */}
        <SliderRow label="Resolution" min={0.5} max={2} step={0.25} value={maxDpr} onChange={updateMaxDpr}
          valueText={maxDpr >= 2 ? 'Native' : `${maxDpr}x`} />
      </SettingsSection>

      {/* Renderer */}
      <SettingsSection id="visual-renderer" title="Renderer">
        <FieldRow label="Backend">
          <Select
            size="small"
            fullWidth
            value={viewer.rendererKind}
            onChange={(e) => { localStorage.setItem('rv-webviewer-renderer', e.target.value); window.location.reload(); }}
          >
            <MenuItem value="webgl" sx={{ fontSize: 13 }}>WebGL</MenuItem>
            <MenuItem value="webgpu" disabled={!navigator.gpu} sx={{ fontSize: 13 }}>
              WebGPU (experimental)
              {!navigator.gpu && (
                <Typography component="span" sx={{ ml: 1, fontSize: 10, color: 'text.disabled' }}>not available</Typography>
              )}
            </MenuItem>
            {/* Internal-only TSL test path (plan-271): WebGPURenderer({forceWebGL:true}).
                Deliberately NEVER disabled on !navigator.gpu — this path exists exactly
                for devices WITHOUT a WebGPU adapter (review finding 4). */}
            {__RV_INTERNAL__ && (
              <MenuItem value="webgpu-gl" sx={{ fontSize: 13 }}>WebGPU (GL backend)</MenuItem>
            )}
          </Select>
        </FieldRow>
        {/* Static mesh batching (BatchedMesh arenas, per-instance visibility):
            group/auto-filter hide and isolate work per instance. The switch
            remains as a kill-switch for render problems — off renders every
            static mesh individually (see rv-static-merge-flag.ts). */}
        <FieldRow label="Static mesh batching" hint="Collapses static geometry into a few multi-draw batches. Disable only as a kill-switch for render problems. Reloads the viewer.">
          <Switch
            size="small"
            checked={isStaticMeshMergingEnabled()}
            onChange={(_, v) => { localStorage.setItem(STATIC_MERGE_LS_KEY, v ? '1' : '0'); window.location.reload(); }}
          />
        </FieldRow>
      </SettingsSection>

      {/* Camera */}
      <SettingsSection id="visual-camera" title="Camera">
        <FieldRow label="Projection">
          <Select
            size="small"
            fullWidth
            value={proj}
            onChange={(e) => updateProj(e.target.value as ProjectionType)}
          >
            <MenuItem value="perspective">Perspective</MenuItem>
            <MenuItem value="orthographic">Orthographic</MenuItem>
          </Select>
        </FieldRow>

        {proj === 'perspective' && (
          <SliderRow label="Field of View" min={10} max={120} step={1} value={fov} onChange={updateFov} valueText={`${fov}°`} />
        )}
      </SettingsSection>

      {/* Save-as-preset dialog */}
      <Dialog open={presetDialogOpen} onClose={() => setPresetDialogOpen(false)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 14 }}>Save settings as preset</DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Preset name"
            placeholder="e.g. Showroom"
            value={presetName}
            onChange={(e) => setPresetName(e.target.value)}
            onKeyDown={(e) => { if (e.key === 'Enter') void handleSavePreset(); }}
            sx={{ mt: 1 }}
          />
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block', mt: 1 }}>
            {import.meta.env.DEV
              ? 'Saved into public/presets/ — commit it to ship the preset with the build.'
              : 'Saved in this browser only (production cannot write to the published source).'}
          </Typography>
        </DialogContent>
        <DialogActions>
          <Button onClick={() => setPresetDialogOpen(false)} sx={{ textTransform: 'none' }}>Cancel</Button>
          <Button
            variant="contained"
            onClick={() => void handleSavePreset()}
            disabled={!presetName.trim() || savingPreset}
            sx={{ textTransform: 'none' }}
          >
            {savingPreset ? 'Saving…' : 'Save'}
          </Button>
        </DialogActions>
      </Dialog>

    </Box>
  );
}
