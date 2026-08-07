// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Persists visual settings and camera bookmarks to localStorage. */

import { useSyncExternalStore } from 'react';
import { getAppConfig } from '../rv-app-config';
import { lsSave } from './ls-store-utils';
import { applyUIBlurScale, clampUIBlurScale, DEFAULT_UI_BLUR_SCALE } from './rv-ui-blur';
import { RENDER_MODES, RENDER_MODE_IDS, DEFAULT_RENDER_MODE, isRenderMode, type RenderMode } from '../rv-render-modes';
import {
  PHYSICS_FLAG_KEY,
  PHYSICS_FULL_FLAG_KEY,
  isPhysicsFlagEnabled,
  isFullPhysicsFlagEnabled,
  computePhysicsEnabled,
  computeFullPhysics,
  physicsSettings,
} from '../engine/rv-physics-registry';

const STORAGE_KEY = 'rv-visual-settings';
/** Standalone scalar key for the "show source markers" toggle (plan-181).
 *  Kept separate from the main `rv-visual-settings` blob so it can be flipped
 *  in isolation (and so existing visual-settings consumers don't see schema
 *  churn). Listed in `ALL_RV_STORAGE_KEYS` for cleanup-sweep coverage. */
const SOURCE_MARKERS_KEY = 'rv-source-markers-visible';

/** @deprecated Render modes are now defined in `rv-render-modes.ts`. Use `RenderMode`. */
export type LightingMode = RenderMode;
/** @deprecated Use `RENDER_MODES` / `RENDER_MODE_IDS` from `rv-render-modes.ts`. */
export const LIGHTING_MODES: readonly RenderMode[] = RENDER_MODE_IDS;
export { type RenderMode, RENDER_MODES } from '../rv-render-modes';

export type ToneMappingType = 'none' | 'linear' | 'reinhard' | 'cineon' | 'aces' | 'agx' | 'neutral';
export const TONE_MAPPING_OPTIONS: readonly ToneMappingType[] = ['none', 'linear', 'reinhard', 'cineon', 'aces', 'agx', 'neutral'] as const;

export type ShadowQuality = 'low' | 'medium' | 'high';
export const SHADOW_QUALITY_OPTIONS: readonly ShadowQuality[] = ['low', 'medium', 'high'] as const;

export type ProjectionType = 'perspective' | 'orthographic';

/** Ambient-occlusion backend selection.
 *  - `'off'`  : AO disabled entirely.
 *  - `'gtao'` : three.js built-in GTAOPass (current default, smaller bundle).
 *  - `'n8ao'` : N8AO pass (higher visual quality, lazy-loaded on first use). */
export type AOMode = 'off' | 'gtao' | 'n8ao';
export const AO_MODES: readonly AOMode[] = ['off', 'gtao', 'n8ao'] as const;

export interface LightingModeSettings {
  lightIntensity: number;
  toneMapping: ToneMappingType;
  toneMappingExposure: number;
  ambientColor: string;
  ambientIntensity: number;
  dirLightEnabled: boolean;
  dirLightColor: string;
  dirLightIntensity: number;
  shadowEnabled: boolean;
  shadowIntensity: number;
  shadowQuality: ShadowQuality;
}

export interface CameraBookmark {
  px: number; py: number; pz: number;
  tx: number; ty: number; tz: number;
}

export interface VisualSettings {
  /** Active render mode. Drives the capability-gated pipeline + Visual settings UI. */
  renderMode: RenderMode;
  modeSettings: Record<RenderMode, LightingModeSettings>;
  projection: ProjectionType;
  fov: number;
  cameras: (CameraBookmark | null)[];
  /** Whether native MSAA antialiasing is enabled (requires page reload to change). */
  antialias: boolean;
  /** Shadow map resolution in pixels (512, 1024, or 2048). */
  shadowMapSize: number;
  /** Shadow softness radius (1-5). */
  shadowRadius: number;
  /** Maximum device pixel ratio (1.0 = performance, 1.5 = balanced, native = quality). */
  maxDpr: number;
  /** FPV walk speed in m/s. */
  fpvSpeed: number;
  /** FPV sprint speed in m/s. */
  fpvSprintSpeed: number;
  /** FPV mouse look sensitivity (radians per pixel). */
  fpvSensitivity: number;
  /** FPV eye height above ground in meters. */
  fpvEyeHeight: number;
  /** Ambient-occlusion backend: 'off' | 'gtao' | 'n8ao'. WebGL only; on WebGPU
   *  this is effectively ignored (AO is a no-op). Supersedes the legacy
   *  `ssaoEnabled` boolean — the boolean is derived from this for back-compat. */
  aoMode: AOMode;
  /** AO blend intensity (0 = invisible, 1 = full). Shared between backends. */
  ssaoIntensity: number;
  /** AO sampling radius in world units. Shared between backends. */
  ssaoRadius: number;
  /** Toon (cel) shading: number of discrete diffuse bands (2–6). */
  toonBands: number;
  /** Toon metallic look strength (0 = off, 1 = fully recoloured metal surfaces). */
  toonMetallic: number;
  /** Toon metallic tint colour as #rrggbb hex (applied to metal surfaces, cel-banded). */
  toonMetallicColor: string;
  /** Toon albedo grade: minimum brightness of the remapped albedo (0–1). */
  toonAlbedoMinBrightness: number;
  /** Toon albedo grade: maximum brightness of the remapped albedo (0–1). */
  toonAlbedoMaxBrightness: number;
  /** Toon albedo saturation (0 = greyscale, 1 = unchanged, 2 = boosted). */
  toonAlbedoSaturation: number;
  /** Toon outline (edge) strength / opacity (0 = off, 1 = full). */
  toonOutlineAmount: number;
  /** Toon outline thickness in pixels. */
  toonOutlineThickness: number;
  /** Toon outline edge threshold (0 = very sensitive, 1 = only strong edges). */
  toonOutlineThreshold: number;
  /** Toon outline max view distance in meters (0–100); edges fade out beyond it. */
  toonOutlineDistance: number;
  /** Toon outline: 2× supersample the depth/normal gbuffer for higher-quality
   *  edges (heavier). WebGL only. */
  toonOutlineSupersample: boolean;
  /** Toon outline color as #rrggbb hex. */
  toonOutlineColor: string;
  /** Toon: tint the dark bands slightly cool (blue) instead of just darker. */
  toonCoolShadows: boolean;
  /** Whether bloom (glow on bright areas) is enabled. WebGL only. */
  bloomEnabled: boolean;
  /** Bloom glow intensity (0–2). */
  bloomIntensity: number;
  /** Brightness threshold for bloom (0–1). Only pixels above this luminance bloom. */
  bloomThreshold: number;
  /** Bloom spread radius (0–1). */
  bloomRadius: number;
  /** Whether the ground (floor) plane is visible. */
  groundEnabled: boolean;
  /** Floor brightness multiplier (0 = black, 1 = default, 2 = double). */
  groundBrightness: number;
  /** Floor base color as #rrggbb hex. Combined with `groundBrightness` to drive
   *  the actual ground material tint (color × brightness, component-wise). */
  groundColor: string;
  /** Scene background brightness multiplier (0 = black, 1 = default gray, 2 = white). */
  backgroundBrightness: number;
  /** Floor checker pattern contrast multiplier (0 = flat midgray, 1 = default, 2 = doubled). */
  checkerContrast: number;
  /** Whether the optional floor reflection is enabled (WebGL only). */
  reflectionEnabled: boolean;
  /** Floor reflection strength (0 = none, 1 = full mirror). */
  reflectionStrength: number;
  /** Floor reflection blur / gloss (0 = sharp mirror, 1 = soft frosted gloss). */
  reflectionBlur: number;
  /** Unlit mode only: assign the HDRI env map so metallic/glossy surfaces get
   *  reflections while the flat ambient look is kept. Independent of the Shaded
   *  mode's full environment lighting. */
  envReflectionsEnabled: boolean;
  /** Unlit env-reflection strength → scene.environmentIntensity (0–2). */
  envReflectionsIntensity: number;
  /** Whether the drive axis gizmo (double arrow / rotation ring) is shown on
   *  selected Drive nodes (plan-249). */
  showDriveAxisGizmo: boolean;
  /** Zoom factor for the React HMI overlay (0.5–2.0, default 1.0). */
  uiZoom: number;
  /** Dimensionless scale for every HMI `backdrop-filter` blur radius (0.1–1,
   *  default 1 = every glass surface keeps its authored radius). Lowering it cuts
   *  the per-frame compositor cost of blurring the live 3D canvas behind the
   *  overlay; the `Fast` visual preset sets 0.25. See `rv-ui-blur.ts`. */
  uiBlurScale: number;
  /** OrbitControls rotate speed multiplier (0.1–3.0, default 1.0). */
  orbitRotateSpeed: number;
  /** OrbitControls pan speed multiplier (0.1–3.0, default 1.0). */
  orbitPanSpeed: number;
  /** OrbitControls zoom speed for mouse wheel, trackpad, and touch pinch (0.1–3.0, default 1.0). */
  orbitZoomSpeed: number;
  /** OrbitControls damping factor — inertia feel (0.01–0.5, default 0.2).
   *  Higher = more direct (shorter glide after the mouse stops). */
  orbitDampingFactor: number;
  /** Distance-adaptive navigation: scales zoom/pan speed proportionally to camera–target distance (opt-in). */
  distanceAdaptiveNav?: boolean;
}

/** Single source of truth for OrbitControls navigation-sensitivity ranges (UI sliders + clamping). */
export const NAVIGATION_RANGES = {
  rotateSpeed:   { min: 0.1,  max: 3.0, step: 0.05 },
  panSpeed:      { min: 0.1,  max: 3.0, step: 0.05 },
  zoomSpeed:     { min: 0.1,  max: 3.0, step: 0.1  },
  dampingFactor: { min: 0.01, max: 0.5, step: 0.01 },
} as const;

function clampNavNumber(raw: unknown, range: { min: number; max: number }, fallback: number): number {
  if (typeof raw !== 'number' || Number.isNaN(raw)) return fallback;
  if (raw < range.min || raw > range.max) return fallback;
  return raw;
}

const MODE_DEFAULTS: Record<RenderMode, LightingModeSettings> = {
  simple: {
    lightIntensity: 1.0, toneMapping: 'none', toneMappingExposure: 1.0,
    ambientColor: '#ffffff', ambientIntensity: 1.0,
    dirLightEnabled: false, dirLightColor: '#ffffff', dirLightIntensity: 1.5,
    shadowEnabled: false, shadowIntensity: 0.5, shadowQuality: 'medium',
  },
  default: {
    lightIntensity: 0.5, toneMapping: 'neutral', toneMappingExposure: 1.0,
    ambientColor: '#404040', ambientIntensity: 0.75,
    dirLightEnabled: true, dirLightColor: '#ffffff', dirLightIntensity: 1.5,
    shadowEnabled: true, shadowIntensity: 0.95, shadowQuality: 'medium',
  },
  toon: {
    // Lightweight cel look: a flat ambient fill (lightIntensity = ambient
    // brightness, since no environment) + a directional key light that the toon
    // material bands by direction and gives a hard specular highlight. No tone
    // mapping (flat crisp colours), no shadows.
    lightIntensity: 0.4, toneMapping: 'none', toneMappingExposure: 1.0,
    ambientColor: '#ffffff', ambientIntensity: 0.45,
    dirLightEnabled: true, dirLightColor: '#ffffff', dirLightIntensity: 2.0,
    shadowEnabled: false, shadowIntensity: 0.5, shadowQuality: 'medium',
  },
};

const DEFAULTS: VisualSettings = {
  renderMode: DEFAULT_RENDER_MODE,
  modeSettings: {
    simple:  { ...MODE_DEFAULTS.simple },
    default: { ...MODE_DEFAULTS.default },
    toon:    { ...MODE_DEFAULTS.toon },
  },
  projection: 'perspective' as ProjectionType,
  fov: 45,
  cameras: [null, null, null],
  antialias: true,
  shadowMapSize: 1024,
  shadowRadius: 2,
  maxDpr: 1.5,
  fpvSpeed: 2.5,
  fpvSprintSpeed: 5.0,
  fpvSensitivity: 0.002,
  fpvEyeHeight: 1.7,
  aoMode: 'gtao',
  ssaoIntensity: 0.35,
  ssaoRadius: 0.03,
  toonBands: 3,
  toonMetallic: 0.85,
  toonMetallicColor: '#b0b4bc',
  toonAlbedoMinBrightness: 0,
  toonAlbedoMaxBrightness: 1,
  toonAlbedoSaturation: 1,
  toonOutlineAmount: 1.0,
  toonOutlineThickness: 1.5,
  toonOutlineThreshold: 0.3,
  toonOutlineDistance: 100,
  toonOutlineSupersample: false,
  toonOutlineColor: '#1a1a1a',
  toonCoolShadows: true,
  bloomEnabled: true,
  bloomIntensity: 0.2,
  bloomThreshold: 0.85,
  bloomRadius: 0.4,
  groundEnabled: true,
  groundBrightness: 1.0,
  groundColor: '#ffffff',
  backgroundBrightness: 1.0,
  checkerContrast: 1.0,
  reflectionEnabled: false,
  reflectionStrength: 0.8,
  reflectionBlur: 1.0,
  envReflectionsEnabled: false,
  envReflectionsIntensity: 0.3,
  showDriveAxisGizmo: true,
  uiZoom: 1.0,
  uiBlurScale: DEFAULT_UI_BLUR_SCALE,
  orbitRotateSpeed: 1.0,
  orbitPanSpeed: 1.0,
  orbitZoomSpeed: 1.0,
  orbitDampingFactor: 0.2,
  distanceAdaptiveNav: false,
};

function migrateToneMapping(raw: unknown, mode: RenderMode): ToneMappingType {
  if (typeof raw === 'string' && (TONE_MAPPING_OPTIONS as readonly string[]).includes(raw)) return raw as ToneMappingType;
  if (raw === true) return 'neutral';
  if (raw === false) return 'none';
  return MODE_DEFAULTS[mode].toneMapping;
}

function parseModeSettings(raw: unknown): Record<RenderMode, LightingModeSettings> {
  const result: Record<RenderMode, LightingModeSettings> = {
    simple:  { ...MODE_DEFAULTS.simple },
    default: { ...MODE_DEFAULTS.default },
    toon:    { ...MODE_DEFAULTS.toon },
  };
  if (typeof raw !== 'object' || raw === null) return result;
  const obj = raw as Record<string, Partial<LightingModeSettings> & { toneMapping?: unknown }>;
  for (const mode of RENDER_MODE_IDS) {
    if (obj[mode]) {
      const d = MODE_DEFAULTS[mode];
      const s = obj[mode];
      result[mode].lightIntensity = s.lightIntensity ?? d.lightIntensity;
      result[mode].toneMapping = migrateToneMapping(s.toneMapping, mode);
      result[mode].toneMappingExposure = s.toneMappingExposure ?? d.toneMappingExposure;
      result[mode].ambientColor = s.ambientColor ?? d.ambientColor;
      result[mode].ambientIntensity = s.ambientIntensity ?? d.ambientIntensity;
      result[mode].dirLightEnabled = s.dirLightEnabled ?? d.dirLightEnabled;
      result[mode].dirLightColor = s.dirLightColor ?? d.dirLightColor;
      result[mode].dirLightIntensity = s.dirLightIntensity ?? d.dirLightIntensity;
      result[mode].shadowEnabled = s.shadowEnabled ?? d.shadowEnabled;
      result[mode].shadowIntensity = s.shadowIntensity ?? d.shadowIntensity;
      result[mode].shadowQuality = (s.shadowQuality && (SHADOW_QUALITY_OPTIONS as readonly string[]).includes(s.shadowQuality)) ? s.shadowQuality : d.shadowQuality;
    }
  }
  return result;
}

export function loadVisualSettings(): VisualSettings {
  const fromStorage = loadFromLocalStorage();
  const override = getAppConfig().visual;
  if (!override) return fromStorage;
  // Back-compat: accept the legacy `lightingMode` override key.
  const overrideMode = override.renderMode ?? override.lightingMode;
  return {
    renderMode: (overrideMode && isRenderMode(overrideMode)) ? overrideMode : fromStorage.renderMode,
    modeSettings: fromStorage.modeSettings,
    projection: override.projection ?? fromStorage.projection,
    fov: override.fov ?? fromStorage.fov,
    cameras: fromStorage.cameras,
    antialias: fromStorage.antialias,
    shadowMapSize: fromStorage.shadowMapSize,
    shadowRadius: fromStorage.shadowRadius,
    maxDpr: fromStorage.maxDpr,
    fpvSpeed: fromStorage.fpvSpeed,
    fpvSprintSpeed: fromStorage.fpvSprintSpeed,
    fpvSensitivity: fromStorage.fpvSensitivity,
    fpvEyeHeight: fromStorage.fpvEyeHeight,
    aoMode: fromStorage.aoMode,
    ssaoIntensity: fromStorage.ssaoIntensity,
    ssaoRadius: fromStorage.ssaoRadius,
    toonBands: fromStorage.toonBands,
    toonMetallic: fromStorage.toonMetallic,
    toonMetallicColor: fromStorage.toonMetallicColor,
    toonAlbedoMinBrightness: fromStorage.toonAlbedoMinBrightness,
    toonAlbedoMaxBrightness: fromStorage.toonAlbedoMaxBrightness,
    toonAlbedoSaturation: fromStorage.toonAlbedoSaturation,
    toonOutlineAmount: fromStorage.toonOutlineAmount,
    toonOutlineThickness: fromStorage.toonOutlineThickness,
    toonOutlineThreshold: fromStorage.toonOutlineThreshold,
    toonOutlineDistance: fromStorage.toonOutlineDistance,
    toonOutlineSupersample: fromStorage.toonOutlineSupersample,
    toonOutlineColor: fromStorage.toonOutlineColor,
    toonCoolShadows: fromStorage.toonCoolShadows,
    bloomEnabled: fromStorage.bloomEnabled,
    bloomIntensity: fromStorage.bloomIntensity,
    bloomThreshold: fromStorage.bloomThreshold,
    bloomRadius: fromStorage.bloomRadius,
    groundEnabled: fromStorage.groundEnabled,
    groundBrightness: fromStorage.groundBrightness,
    groundColor: fromStorage.groundColor,
    backgroundBrightness: fromStorage.backgroundBrightness,
    checkerContrast: fromStorage.checkerContrast,
    reflectionEnabled: fromStorage.reflectionEnabled,
    reflectionStrength: fromStorage.reflectionStrength,
    reflectionBlur: fromStorage.reflectionBlur,
    envReflectionsEnabled: fromStorage.envReflectionsEnabled,
    envReflectionsIntensity: fromStorage.envReflectionsIntensity,
    showDriveAxisGizmo: fromStorage.showDriveAxisGizmo,
    uiZoom: fromStorage.uiZoom,
    uiBlurScale: fromStorage.uiBlurScale,
    orbitRotateSpeed: clampNavNumber(
      override.orbitRotateSpeed,
      NAVIGATION_RANGES.rotateSpeed,
      fromStorage.orbitRotateSpeed,
    ),
    orbitPanSpeed: clampNavNumber(
      override.orbitPanSpeed,
      NAVIGATION_RANGES.panSpeed,
      fromStorage.orbitPanSpeed,
    ),
    orbitZoomSpeed: clampNavNumber(
      override.orbitZoomSpeed,
      NAVIGATION_RANGES.zoomSpeed,
      fromStorage.orbitZoomSpeed,
    ),
    orbitDampingFactor: clampNavNumber(
      override.orbitDampingFactor,
      NAVIGATION_RANGES.dampingFactor,
      fromStorage.orbitDampingFactor,
    ),
    distanceAdaptiveNav: fromStorage.distanceAdaptiveNav,
  };
}

function loadFromLocalStorage(): VisualSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...DEFAULTS, modeSettings: { simple: { ...MODE_DEFAULTS.simple }, default: { ...MODE_DEFAULTS.default }, toon: { ...MODE_DEFAULTS.toon } }, cameras: [...DEFAULTS.cameras] };
    const parsed = JSON.parse(raw) as Partial<VisualSettings> & { lightIntensity?: number; qualityPreset?: string; lightingMode?: string };
    // Back-compat: the field was renamed `lightingMode` → `renderMode`.
    const rawMode = parsed.renderMode ?? parsed.lightingMode;
    const mode: RenderMode = isRenderMode(rawMode) ? rawMode : DEFAULTS.renderMode;
    const modeSettings = parseModeSettings(parsed.modeSettings);
    if (typeof parsed.lightIntensity === 'number' && !parsed.modeSettings) {
      modeSettings[mode].lightIntensity = parsed.lightIntensity;
    }
    const projection = (parsed.projection === 'perspective' || parsed.projection === 'orthographic') ? parsed.projection : DEFAULTS.projection;
    const antialiasRaw = (parsed as Record<string, unknown>).antialias;
    const antialias = typeof antialiasRaw === 'boolean' ? antialiasRaw : DEFAULTS.antialias;
    const shadowMapSizeRaw = (parsed as Record<string, unknown>).shadowMapSize;
    const shadowMapSize = (typeof shadowMapSizeRaw === 'number' && [512, 1024, 2048].includes(shadowMapSizeRaw))
      ? shadowMapSizeRaw : DEFAULTS.shadowMapSize;
    const shadowRadiusRaw = (parsed as Record<string, unknown>).shadowRadius;
    const shadowRadius = (typeof shadowRadiusRaw === 'number' && shadowRadiusRaw >= 1 && shadowRadiusRaw <= 5)
      ? shadowRadiusRaw : DEFAULTS.shadowRadius;
    const maxDprRaw = (parsed as Record<string, unknown>).maxDpr;
    const maxDpr = (typeof maxDprRaw === 'number' && maxDprRaw >= 0.5 && maxDprRaw <= 4)
      ? maxDprRaw : DEFAULTS.maxDpr;
    const fpvSpeedRaw = (parsed as Record<string, unknown>).fpvSpeed;
    const fpvSpeed = (typeof fpvSpeedRaw === 'number' && fpvSpeedRaw >= 0.5 && fpvSpeedRaw <= 20)
      ? fpvSpeedRaw : DEFAULTS.fpvSpeed;
    const fpvSprintSpeedRaw = (parsed as Record<string, unknown>).fpvSprintSpeed;
    const fpvSprintSpeed = (typeof fpvSprintSpeedRaw === 'number' && fpvSprintSpeedRaw >= 1 && fpvSprintSpeedRaw <= 40)
      ? fpvSprintSpeedRaw : DEFAULTS.fpvSprintSpeed;
    const fpvSensitivityRaw = (parsed as Record<string, unknown>).fpvSensitivity;
    const fpvSensitivity = (typeof fpvSensitivityRaw === 'number' && fpvSensitivityRaw >= 0.0005 && fpvSensitivityRaw <= 0.01)
      ? fpvSensitivityRaw : DEFAULTS.fpvSensitivity;
    const fpvEyeHeightRaw = (parsed as Record<string, unknown>).fpvEyeHeight;
    const fpvEyeHeight = (typeof fpvEyeHeightRaw === 'number' && fpvEyeHeightRaw >= 0.5 && fpvEyeHeightRaw <= 5)
      ? fpvEyeHeightRaw : DEFAULTS.fpvEyeHeight;
    // aoMode migration: prefer explicit `aoMode`; fall back to legacy
    // boolean `ssaoEnabled` (true → 'gtao', false → 'off'); finally DEFAULTS.
    const aoModeRaw = (parsed as Record<string, unknown>).aoMode;
    const ssaoEnabledRaw = (parsed as Record<string, unknown>).ssaoEnabled;
    let aoMode: AOMode;
    if (typeof aoModeRaw === 'string' && (AO_MODES as readonly string[]).includes(aoModeRaw)) {
      aoMode = aoModeRaw as AOMode;
    } else if (typeof ssaoEnabledRaw === 'boolean') {
      aoMode = ssaoEnabledRaw ? 'gtao' : 'off';
    } else {
      aoMode = DEFAULTS.aoMode;
    }
    const ssaoIntensityRaw = (parsed as Record<string, unknown>).ssaoIntensity;
    const ssaoIntensity = (typeof ssaoIntensityRaw === 'number' && ssaoIntensityRaw >= 0 && ssaoIntensityRaw <= 2)
      ? ssaoIntensityRaw : DEFAULTS.ssaoIntensity;
    const ssaoRadiusRaw = (parsed as Record<string, unknown>).ssaoRadius;
    const ssaoRadius = (typeof ssaoRadiusRaw === 'number' && ssaoRadiusRaw >= 0.01 && ssaoRadiusRaw <= 1)
      ? ssaoRadiusRaw : DEFAULTS.ssaoRadius;
    const toonBandsRaw = (parsed as Record<string, unknown>).toonBands;
    const toonBands = (typeof toonBandsRaw === 'number' && toonBandsRaw >= 2 && toonBandsRaw <= 6)
      ? Math.round(toonBandsRaw) : DEFAULTS.toonBands;
    const toonMetallicRaw = (parsed as Record<string, unknown>).toonMetallic;
    const toonMetallic = (typeof toonMetallicRaw === 'number' && toonMetallicRaw >= 0 && toonMetallicRaw <= 1)
      ? toonMetallicRaw : DEFAULTS.toonMetallic;
    const toonMetallicColorRaw = (parsed as Record<string, unknown>).toonMetallicColor;
    const toonMetallicColor = (typeof toonMetallicColorRaw === 'string' && /^#[0-9a-fA-F]{6}$/.test(toonMetallicColorRaw))
      ? toonMetallicColorRaw : DEFAULTS.toonMetallicColor;
    const toonAlbedoMinBrightnessRaw = (parsed as Record<string, unknown>).toonAlbedoMinBrightness;
    const toonAlbedoMinBrightness = (typeof toonAlbedoMinBrightnessRaw === 'number' && toonAlbedoMinBrightnessRaw >= 0 && toonAlbedoMinBrightnessRaw <= 1)
      ? toonAlbedoMinBrightnessRaw : DEFAULTS.toonAlbedoMinBrightness;
    const toonAlbedoMaxBrightnessRaw = (parsed as Record<string, unknown>).toonAlbedoMaxBrightness;
    const toonAlbedoMaxBrightness = (typeof toonAlbedoMaxBrightnessRaw === 'number' && toonAlbedoMaxBrightnessRaw >= 0 && toonAlbedoMaxBrightnessRaw <= 1)
      ? toonAlbedoMaxBrightnessRaw : DEFAULTS.toonAlbedoMaxBrightness;
    const toonAlbedoSaturationRaw = (parsed as Record<string, unknown>).toonAlbedoSaturation;
    const toonAlbedoSaturation = (typeof toonAlbedoSaturationRaw === 'number' && toonAlbedoSaturationRaw >= 0 && toonAlbedoSaturationRaw <= 2)
      ? toonAlbedoSaturationRaw : DEFAULTS.toonAlbedoSaturation;
    const toonOutlineAmountRaw = (parsed as Record<string, unknown>).toonOutlineAmount;
    const toonOutlineAmount = (typeof toonOutlineAmountRaw === 'number' && toonOutlineAmountRaw >= 0 && toonOutlineAmountRaw <= 1)
      ? toonOutlineAmountRaw : DEFAULTS.toonOutlineAmount;
    const toonOutlineThicknessRaw = (parsed as Record<string, unknown>).toonOutlineThickness;
    const toonOutlineThickness = (typeof toonOutlineThicknessRaw === 'number' && toonOutlineThicknessRaw >= 0 && toonOutlineThicknessRaw <= 5)
      ? toonOutlineThicknessRaw : DEFAULTS.toonOutlineThickness;
    const toonOutlineThresholdRaw = (parsed as Record<string, unknown>).toonOutlineThreshold;
    const toonOutlineThreshold = (typeof toonOutlineThresholdRaw === 'number' && toonOutlineThresholdRaw >= 0 && toonOutlineThresholdRaw <= 1)
      ? toonOutlineThresholdRaw : DEFAULTS.toonOutlineThreshold;
    const toonOutlineDistanceRaw = (parsed as Record<string, unknown>).toonOutlineDistance;
    const toonOutlineDistance = (typeof toonOutlineDistanceRaw === 'number' && toonOutlineDistanceRaw >= 0 && toonOutlineDistanceRaw <= 100)
      ? toonOutlineDistanceRaw : DEFAULTS.toonOutlineDistance;
    const toonOutlineSupersampleRaw = (parsed as Record<string, unknown>).toonOutlineSupersample;
    const toonOutlineSupersample = typeof toonOutlineSupersampleRaw === 'boolean'
      ? toonOutlineSupersampleRaw : DEFAULTS.toonOutlineSupersample;
    const toonOutlineColorRaw = (parsed as Record<string, unknown>).toonOutlineColor;
    const toonOutlineColor = (typeof toonOutlineColorRaw === 'string' && /^#[0-9a-fA-F]{6}$/.test(toonOutlineColorRaw))
      ? toonOutlineColorRaw : DEFAULTS.toonOutlineColor;
    const toonCoolShadowsRaw = (parsed as Record<string, unknown>).toonCoolShadows;
    const toonCoolShadows = typeof toonCoolShadowsRaw === 'boolean' ? toonCoolShadowsRaw : DEFAULTS.toonCoolShadows;
    const bloomEnabledRaw = (parsed as Record<string, unknown>).bloomEnabled;
    const bloomEnabled = typeof bloomEnabledRaw === 'boolean' ? bloomEnabledRaw : DEFAULTS.bloomEnabled;
    const bloomIntensityRaw = (parsed as Record<string, unknown>).bloomIntensity;
    const bloomIntensity = (typeof bloomIntensityRaw === 'number' && bloomIntensityRaw >= 0 && bloomIntensityRaw <= 2)
      ? bloomIntensityRaw : DEFAULTS.bloomIntensity;
    const bloomThresholdRaw = (parsed as Record<string, unknown>).bloomThreshold;
    const bloomThreshold = (typeof bloomThresholdRaw === 'number' && bloomThresholdRaw >= 0 && bloomThresholdRaw <= 1)
      ? bloomThresholdRaw : DEFAULTS.bloomThreshold;
    const bloomRadiusRaw = (parsed as Record<string, unknown>).bloomRadius;
    const bloomRadius = (typeof bloomRadiusRaw === 'number' && bloomRadiusRaw >= 0 && bloomRadiusRaw <= 1)
      ? bloomRadiusRaw : DEFAULTS.bloomRadius;
    const groundEnabledRaw = (parsed as Record<string, unknown>).groundEnabled;
    const groundEnabled = typeof groundEnabledRaw === 'boolean' ? groundEnabledRaw : DEFAULTS.groundEnabled;
    const groundBrightnessRaw = (parsed as Record<string, unknown>).groundBrightness;
    const groundBrightness = (typeof groundBrightnessRaw === 'number' && groundBrightnessRaw >= 0 && groundBrightnessRaw <= 2)
      ? groundBrightnessRaw : DEFAULTS.groundBrightness;
    const groundColorRaw = (parsed as Record<string, unknown>).groundColor;
    const groundColor = (typeof groundColorRaw === 'string' && /^#[0-9a-fA-F]{6}$/.test(groundColorRaw))
      ? groundColorRaw : DEFAULTS.groundColor;
    const backgroundBrightnessRaw = (parsed as Record<string, unknown>).backgroundBrightness;
    const backgroundBrightness = (typeof backgroundBrightnessRaw === 'number' && backgroundBrightnessRaw >= 0 && backgroundBrightnessRaw <= 2)
      ? backgroundBrightnessRaw : DEFAULTS.backgroundBrightness;
    const checkerContrastRaw = (parsed as Record<string, unknown>).checkerContrast;
    const checkerContrast = (typeof checkerContrastRaw === 'number' && checkerContrastRaw >= 0 && checkerContrastRaw <= 2)
      ? checkerContrastRaw : DEFAULTS.checkerContrast;
    const reflectionEnabledRaw = (parsed as Record<string, unknown>).reflectionEnabled;
    const reflectionEnabled = typeof reflectionEnabledRaw === 'boolean' ? reflectionEnabledRaw : DEFAULTS.reflectionEnabled;
    const reflectionStrengthRaw = (parsed as Record<string, unknown>).reflectionStrength;
    const reflectionStrength = (typeof reflectionStrengthRaw === 'number' && reflectionStrengthRaw >= 0 && reflectionStrengthRaw <= 1)
      ? reflectionStrengthRaw : DEFAULTS.reflectionStrength;
    const reflectionBlurRaw = (parsed as Record<string, unknown>).reflectionBlur;
    const reflectionBlur = (typeof reflectionBlurRaw === 'number' && reflectionBlurRaw >= 0 && reflectionBlurRaw <= 1)
      ? reflectionBlurRaw : DEFAULTS.reflectionBlur;
    const envReflectionsEnabledRaw = (parsed as Record<string, unknown>).envReflectionsEnabled;
    const envReflectionsEnabled = typeof envReflectionsEnabledRaw === 'boolean' ? envReflectionsEnabledRaw : DEFAULTS.envReflectionsEnabled;
    const envReflectionsIntensityRaw = (parsed as Record<string, unknown>).envReflectionsIntensity;
    const envReflectionsIntensity = (typeof envReflectionsIntensityRaw === 'number' && envReflectionsIntensityRaw >= 0 && envReflectionsIntensityRaw <= 2)
      ? envReflectionsIntensityRaw : DEFAULTS.envReflectionsIntensity;
    const showDriveAxisGizmoRaw = (parsed as Record<string, unknown>).showDriveAxisGizmo;
    const showDriveAxisGizmo = typeof showDriveAxisGizmoRaw === 'boolean'
      ? showDriveAxisGizmoRaw : DEFAULTS.showDriveAxisGizmo;
    const uiZoomRaw = (parsed as Record<string, unknown>).uiZoom;
    const uiZoom = (typeof uiZoomRaw === 'number' && uiZoomRaw >= 0.5 && uiZoomRaw <= 2)
      ? uiZoomRaw : DEFAULTS.uiZoom;
    // A blob written before plan-344 carries no `uiBlurScale`; the default (1)
    // then keeps every glass surface at exactly its authored radius, so no
    // migration is needed for existing installs.
    const uiBlurScaleRaw = (parsed as Record<string, unknown>).uiBlurScale;
    const uiBlurScale = typeof uiBlurScaleRaw === 'number'
      ? clampUIBlurScale(uiBlurScaleRaw) : DEFAULTS.uiBlurScale;
    const orbitRotateSpeed = clampNavNumber(
      (parsed as Record<string, unknown>).orbitRotateSpeed,
      NAVIGATION_RANGES.rotateSpeed,
      DEFAULTS.orbitRotateSpeed,
    );
    const orbitPanSpeed = clampNavNumber(
      (parsed as Record<string, unknown>).orbitPanSpeed,
      NAVIGATION_RANGES.panSpeed,
      DEFAULTS.orbitPanSpeed,
    );
    const orbitZoomSpeed = clampNavNumber(
      (parsed as Record<string, unknown>).orbitZoomSpeed,
      NAVIGATION_RANGES.zoomSpeed,
      DEFAULTS.orbitZoomSpeed,
    );
    const orbitDampingFactor = clampNavNumber(
      (parsed as Record<string, unknown>).orbitDampingFactor,
      NAVIGATION_RANGES.dampingFactor,
      DEFAULTS.orbitDampingFactor,
    );
    return {
      renderMode: mode,
      modeSettings,
      projection,
      fov: typeof parsed.fov === 'number' ? parsed.fov : DEFAULTS.fov,
      cameras: Array.isArray(parsed.cameras) ? parsed.cameras.slice(0, 3) : [...DEFAULTS.cameras],
      antialias,
      shadowMapSize,
      shadowRadius,
      maxDpr,
      fpvSpeed,
      fpvSprintSpeed,
      fpvSensitivity,
      fpvEyeHeight,
      aoMode,
      ssaoIntensity,
      ssaoRadius,
      toonBands,
      toonMetallic,
      toonMetallicColor,
      toonAlbedoMinBrightness,
      toonAlbedoMaxBrightness,
      toonAlbedoSaturation,
      toonOutlineAmount,
      toonOutlineThickness,
      toonOutlineThreshold,
      toonOutlineDistance,
      toonOutlineSupersample,
      toonOutlineColor,
      toonCoolShadows,
      bloomEnabled,
      bloomIntensity,
      bloomThreshold,
      bloomRadius,
      groundEnabled,
      groundBrightness,
      groundColor,
      backgroundBrightness,
      checkerContrast,
      reflectionEnabled,
      reflectionStrength,
      reflectionBlur,
      envReflectionsEnabled,
      envReflectionsIntensity,
      showDriveAxisGizmo,
      uiZoom,
      uiBlurScale,
      orbitRotateSpeed,
      orbitPanSpeed,
      orbitZoomSpeed,
      orbitDampingFactor,
      distanceAdaptiveNav: typeof (parsed as Record<string, unknown>).distanceAdaptiveNav === 'boolean'
        ? (parsed as Record<string, unknown>).distanceAdaptiveNav as boolean
        : DEFAULTS.distanceAdaptiveNav,
    };
  } catch {
    return { ...DEFAULTS, modeSettings: { simple: { ...MODE_DEFAULTS.simple }, default: { ...MODE_DEFAULTS.default }, toon: { ...MODE_DEFAULTS.toon } }, cameras: [...DEFAULTS.cameras] };
  }
}

export function saveVisualSettings(settings: VisualSettings): void {
  lsSave(STORAGE_KEY, settings);
  // Every settings change funnels through here (preset apply, Visual tab,
  // auto-quality watchdog), so pushing the blur factor to the CSS custom
  // property at this one point is what makes the token reactive — no new
  // subscription mechanism, and no MUI theme rebuild (the theme is memoised on
  // the branding colors only, App.tsx).
  applyUIBlurScale(settings.uiBlurScale);
}

/** True when the user already has persisted visual settings (i.e. NOT a fresh
 *  install). Used to decide whether to seed an initial visual preset at boot. */
export function hasStoredVisualSettings(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) !== null;
  } catch {
    return false;
  }
}

/** Fresh deep clone of the built-in default visual settings (no localStorage /
 *  appConfig overlay). Used as the baseline for building visual presets. */
export function getDefaultVisualSettings(): VisualSettings {
  return {
    ...DEFAULTS,
    modeSettings: {
      simple:  { ...MODE_DEFAULTS.simple },
      default: { ...MODE_DEFAULTS.default },
      toon:    { ...MODE_DEFAULTS.toon },
    },
    cameras: [...DEFAULTS.cameras],
  };
}

// ─── Reactive UI Zoom Store ────────────────────────────────────────────
// Tiny reactive store so HMIShell can subscribe to zoom changes in real time.

let _uiZoom: number = loadVisualSettings().uiZoom;
const _zoomListeners = new Set<() => void>();

function notifyZoom(): void { for (const l of _zoomListeners) l(); }

/** Update the live UI zoom factor (also persists to visual settings). */
export function setUIZoom(zoom: number): void {
  _uiZoom = zoom;
  notifyZoom();
}

/** Read the current UI zoom value (non-reactive). */
export function getUIZoom(): number { return _uiZoom; }

/** Subscribe to zoom changes. Returns unsubscribe function. */
export function subscribeUIZoom(cb: () => void): () => void {
  _zoomListeners.add(cb);
  return () => { _zoomListeners.delete(cb); };
}

/** React hook: returns the current UI zoom factor (reactive). */
export function useUIZoom(): number {
  return useSyncExternalStore(
    (cb) => { _zoomListeners.add(cb); return () => { _zoomListeners.delete(cb); }; },
    () => _uiZoom,
  );
}

// ─── Persisted scalar-boolean store factory ───────────────────────────
// One implementation for all the toggle flags below (source markers, vanish
// MUs, toolbar labels, snap-flip icons): load-from-localStorage with default,
// early-return set with best-effort persist, subscribe set, stable hook fns.

interface PersistedBoolStore {
  get(): boolean;
  set(value: boolean): void;
  subscribe(cb: () => void): () => void;
  /** Stable pair for useSyncExternalStore — call as `useSyncExternalStore(s.subscribe, s.get)`. */
}

function createPersistedBoolStore(key: string, defaultValue: boolean): PersistedBoolStore {
  const load = (): boolean => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return defaultValue;
      return raw === 'true';
    } catch {
      return defaultValue;
    }
  };
  let value = load();
  const listeners = new Set<() => void>();
  return {
    get: () => value,
    set(next: boolean): void {
      if (value === next) return;
      value = next;
      try {
        localStorage.setItem(key, next ? 'true' : 'false');
      } catch {
        /* quota exceeded or storage disabled — ignore */
      }
      for (const l of listeners) l();
    },
    subscribe(cb: () => void): () => void {
      listeners.add(cb);
      return () => { listeners.delete(cb); };
    },
  };
}

// ─── Reactive Source-Markers-Visible Store (plan-181) ─────────────────
// Pure scalar boolean persisted to its own localStorage slot so other
// `VisualSettings` consumers don't have to know about it. Default: true.

const _sourceMarkers = createPersistedBoolStore(SOURCE_MARKERS_KEY, true);

/** Read the current source-markers-visible toggle (non-reactive). */
export function getSourceMarkersVisible(): boolean { return _sourceMarkers.get(); }

/**
 * Update the source-markers-visible flag, persist to localStorage, and
 * notify subscribers. Plugins (e.g. `RVViewer.setSourceMarkersVisible`)
 * subscribe via {@link subscribeSourceMarkersVisible} to apply the change
 * to every source's `_markerNode.visible`.
 */
export function setSourceMarkersVisible(visible: boolean): void { _sourceMarkers.set(visible); }

/** Subscribe to source-markers-visible changes. Returns unsubscribe handle. */
export function subscribeSourceMarkersVisible(cb: () => void): () => void { return _sourceMarkers.subscribe(cb); }

/** React hook: returns the current source-markers-visible flag (reactive). */
export function useSourceMarkersVisible(): boolean {
  return useSyncExternalStore(_sourceMarkers.subscribe, _sourceMarkers.get);
}

// ─── Reactive Vanish-MUs Store ────────────────────────────────────────
// When ON, an MU that runs off the end of a transport line (no successor belt)
// is auto-deleted after a short delay. Toggled from the Layout-Planner toolbar
// and applied to the live RVTransportManager by `RVViewer.setVanishMUs`.
// Pure scalar boolean persisted to its own localStorage slot. Default: true
// (an MU that runs off the end of a line should disappear, not pile up).

const _vanishMUs = createPersistedBoolStore('rv-vanish-mus', true);

/** Read the current vanish-MUs toggle (non-reactive). */
export function getVanishMUs(): boolean { return _vanishMUs.get(); }

/**
 * Update the vanish-MUs flag, persist to localStorage, and notify subscribers.
 * `RVViewer.setVanishMUs` subscribes via {@link subscribeVanishMUs} to push the
 * value onto the live transport manager.
 */
export function setVanishMUs(enabled: boolean): void { _vanishMUs.set(enabled); }

/** Subscribe to vanish-MUs changes. Returns unsubscribe handle. */
export function subscribeVanishMUs(cb: () => void): () => void { return _vanishMUs.subscribe(cb); }

/** React hook: returns the current vanish-MUs flag (reactive). */
export function useVanishMUs(): boolean {
  return useSyncExternalStore(_vanishMUs.subscribe, _vanishMUs.get);
}

// ─── Reactive Physics-Whole-Scene Store (plan-276 F10/F16) ────────────
// Settings → Simulation → "Physics (whole scene)". Deliberately NOT a
// createPersistedBoolStore: the persisted value lives under the engine's
// `rv.physics` activation key with 'on' / 'off' semantics (rv-physics-registry
// reads it at boot via isPhysicsFlagEnabled). Load-time-only: flipping the
// toggle takes effect on the NEXT model load (physicsSettings is written once
// at boot / evaluated by the physics plugin per load).

let _physicsWholeScene = isPhysicsFlagEnabled();
const _physicsListeners = new Set<() => void>();
const _physicsSubscribe = (cb: () => void): (() => void) => {
  _physicsListeners.add(cb);
  return () => { _physicsListeners.delete(cb); };
};
const _physicsGet = (): boolean => _physicsWholeScene;

/** Read the current physics-whole-scene toggle (non-reactive). */
export function getPhysicsWholeScene(): boolean { return _physicsWholeScene; }

/** Update the physics toggle: persists 'on' / 'off' under `rv.physics` and
 *  refreshes the LIVE gate so the next model load picks it up without a page
 *  reload (still load-time-only for the running model, plan-276 F10). */
export function setPhysicsWholeScene(enabled: boolean): void {
  if (_physicsWholeScene === enabled) return;
  _physicsWholeScene = enabled;
  try {
    localStorage.setItem(PHYSICS_FLAG_KEY, enabled ? 'on' : 'off');
  } catch {
    /* quota exceeded or storage disabled — ignore */
  }
  // Keep the load-time gate coherent for the NEXT model load (the settings.json
  // kill-switch still wins — same AND as the boot block in main.ts). The
  // derived full gate (F17) depends on `enabled`, so it is re-evaluated too.
  physicsSettings.enabled = computePhysicsEnabled(getAppConfig().simulation?.physicsEnabled);
  physicsSettings.full = computeFullPhysics(getAppConfig().simulation?.physicsEnabled);
  for (const l of _physicsListeners) l();
}

/** React hook: returns the current physics-whole-scene flag (reactive). */
export function usePhysicsWholeScene(): boolean {
  return useSyncExternalStore(_physicsSubscribe, _physicsGet);
}

// ─── Reactive Full-Physics Store (plan-276 F17, Beta) ─────────────────
// Settings → Simulation → "Full physics — all conveyors (Beta)". Same
// engine-key semantics as the whole-scene toggle above: persisted 'on'/'off'
// under `rv.physics.full`, load-time-only. Only EFFECTIVE when the main
// physics toggle is also on (strict AND — computeFullPhysics); the UI
// disables this switch while the main toggle is off.

let _physicsFull = isFullPhysicsFlagEnabled();
const _physicsFullListeners = new Set<() => void>();
const _physicsFullSubscribe = (cb: () => void): (() => void) => {
  _physicsFullListeners.add(cb);
  return () => { _physicsFullListeners.delete(cb); };
};
const _physicsFullGet = (): boolean => _physicsFull;

/** Read the current full-physics (Beta) toggle (non-reactive). */
export function getPhysicsFull(): boolean { return _physicsFull; }

/** Update the full-physics (Beta) toggle: persists 'on' / 'off' under
 *  `rv.physics.full` and refreshes the LIVE derived gate for the next model
 *  load (still load-time-only for the running model, plan-276 F17). */
export function setPhysicsFull(enabled: boolean): void {
  if (_physicsFull === enabled) return;
  _physicsFull = enabled;
  try {
    localStorage.setItem(PHYSICS_FULL_FLAG_KEY, enabled ? 'on' : 'off');
  } catch {
    /* quota exceeded or storage disabled — ignore */
  }
  physicsSettings.full = computeFullPhysics(getAppConfig().simulation?.physicsEnabled);
  for (const l of _physicsFullListeners) l();
}

/** React hook: returns the current full-physics (Beta) flag (reactive). */
export function usePhysicsFull(): boolean {
  return useSyncExternalStore(_physicsFullSubscribe, _physicsFullGet);
}

// ─── Reactive Toolbar-Show-Labels Store ───────────────────────────────
// Controls whether the top-left toolbar's window-opening buttons (Hierarchy,
// Models, Annotations, Multiuser, VR/AR, Settings) render a text label next
// to their icon. Always collapsed on mobile regardless of this setting.

const _toolbarLabels = createPersistedBoolStore('rv-toolbar-show-labels', false);

export function getToolbarShowLabels(): boolean { return _toolbarLabels.get(); }

export function setToolbarShowLabels(show: boolean): void { _toolbarLabels.set(show); }

export function useToolbarShowLabels(): boolean {
  return useSyncExternalStore(_toolbarLabels.subscribe, _toolbarLabels.get);
}

// ─── Reactive Snap-Flip-Icons Store (plan-190) ────────────────────────
// Controls whether the layout planner shows a clickable "flip orientation"
// icon over a hovered/selected placed component that has a second compatible
// snap. Default: true. Kept as its own scalar key so existing visual-settings
// consumers stay schema-stable.

const _snapFlipIcons = createPersistedBoolStore('rv-snap-flip-icons-visible', true);

/** Read the current snap-flip-icons-visible toggle (non-reactive). */
export function getSnapFlipIconsVisible(): boolean { return _snapFlipIcons.get(); }

/** Set the snap-flip-icons-visible flag and persist to localStorage. */
export function setSnapFlipIconsVisible(visible: boolean): void { _snapFlipIcons.set(visible); }

/** Subscribe to snap-flip-icons-visible changes. Returns unsubscribe handle. */
export function subscribeSnapFlipIconsVisible(cb: () => void): () => void { return _snapFlipIcons.subscribe(cb); }

/** React hook: returns the current snap-flip-icons-visible flag (reactive). */
export function useSnapFlipIconsVisible(): boolean {
  return useSyncExternalStore(_snapFlipIcons.subscribe, _snapFlipIcons.get);
}
