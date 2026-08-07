// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * VisualSettingsManager — Manages tone mapping, shadows, lighting mode,
 * ground plane, DPR, and environment maps.
 *
 * Internal implementation detail of RVViewer — not part of public API.
 * Receives a reference to shared viewer state via ViewerVisualState.
 */

import {
  Scene,
  AmbientLight,
  DirectionalLight,
  WebGLRenderer,
  PMREMGenerator,
  NoToneMapping,
  PCFShadowMap,
  BasicShadowMap,
  Texture,
  Object3D,
} from 'three';
import type { ToneMapping as ThreeToneMapping } from 'three';
import type { Renderer } from 'three/webgpu';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import type { ToneMappingType, ShadowQuality } from './hmi/visual-settings-store';
import { getRenderMode, type RenderMode } from './rv-render-modes';

const TONE_MAP_LOOKUP: Record<ToneMappingType, ThreeToneMapping> = {
  none: NoToneMapping,
  linear: 1 as ThreeToneMapping, // LinearToneMapping
  reinhard: 2 as ThreeToneMapping, // ReinhardToneMapping
  cineon: 3 as ThreeToneMapping, // CineonToneMapping
  aces: 4 as ThreeToneMapping, // ACESFilmicToneMapping
  agx: 6 as ThreeToneMapping, // AgXToneMapping
  neutral: 7 as ThreeToneMapping, // NeutralToneMapping
};

const SHADOW_RES: Record<ShadowQuality, number> = { low: 512, medium: 1024, high: 2048 };

// Module-local warn-once flag (repo convention — no external warnOnce util).
let _warnedWebGPU = false;
function warnEnvMapWebGPUOnce(): void {
  if (_warnedWebGPU) return;
  _warnedWebGPU = true;
  console.warn(
    '[VisualSettings] WebGPU env-map generation failed — the classic ' +
    'PMREMGenerator is WebGL-only and the three/webgpu variant threw. ' +
    'Environment lighting and unlit reflections are unavailable.',
  );
}

/** Shared state that VisualSettingsManager reads/writes on the facade. */
export interface ViewerVisualState {
  scene: Scene;
  renderer: Renderer;
  /** True when the renderer is a WebGPURenderer — gates WebGL-only paths
   *  (PMREM env-map generation). Optional so tests can omit it. */
  isWebGPU?: boolean;
  ambientLight: AmbientLight;
  dirLight: DirectionalLight;
  sceneFixtures: Set<import('three').Object3D>;
  _shadowsDirty: boolean;
  _renderDirty: boolean;
  /** Optional viewer hook — when present, the manager registers its async
   *  IBL (env-map) generation here so that any in-flight `viewer.loadModel`
   *  or `viewer.loadScene` waits for the environment before resolving.
   *  Without this, the scene reveals unlit and lighting "pops in" later. */
  trackLoadingWork?: (p: Promise<unknown>) => void;
}

/**
 * VisualSettingsManager handles lighting, tone mapping, shadows,
 * environment maps, and rendering quality settings.
 */
export class VisualSettingsManager {
  private state: ViewerVisualState;
  private _lightingMode: RenderMode = 'simple';
  private _toneMapping: ToneMappingType = 'none';
  private _envMapTexture: Texture | null = null;
  /** Unlit-only: assign the HDRI env map for reflections while keeping the flat
   *  ambient look. Decoupled from the `environment` capability (Shaded mode). */
  private _unlitReflectionsEnabled = false;
  private _unlitReflectionsIntensity = 0.3;

  constructor(state: ViewerVisualState) {
    this.state = state;
  }

  // ─── Lighting Mode ────────────────────────────────────────────────

  get lightingMode(): RenderMode { return this._lightingMode; }
  set lightingMode(mode: RenderMode) {
    this._lightingMode = mode;
    this.applyLightingMode(mode);
  }

  /** Capabilities of the active render mode (drives feature gating below). */
  private get caps() { return getRenderMode(this._lightingMode).capabilities; }

  // ─── Tone Mapping ─────────────────────────────────────────────────

  get toneMapping(): ToneMappingType { return this._toneMapping; }
  set toneMapping(v: ToneMappingType) {
    this._toneMapping = v;
    this.state.renderer.toneMapping = this.caps.toneMapping
      ? TONE_MAP_LOOKUP[v]
      : NoToneMapping;
    this.recompileMaterials();
  }

  get toneMappingExposure(): number { return this.state.renderer.toneMappingExposure; }
  set toneMappingExposure(v: number) { this.state.renderer.toneMappingExposure = v; }

  // ─── Ambient Light ────────────────────────────────────────────────

  get ambientColor(): string { return '#' + this.state.ambientLight.color.getHexString(); }
  set ambientColor(hex: string) { this.state.ambientLight.color.set(hex); }

  get ambientIntensity(): number { return this.state.ambientLight.intensity; }
  set ambientIntensity(v: number) { this.state.ambientLight.intensity = v; }

  // ─── Directional Light ────────────────────────────────────────────

  get dirLightEnabled(): boolean { return !!this.state.dirLight.parent; }
  set dirLightEnabled(v: boolean) {
    if (v && !this.state.dirLight.parent) {
      this.state.scene.add(this.state.dirLight);
      this.state.scene.add(this.state.dirLight.target);
      this.state.sceneFixtures.add(this.state.dirLight);
      this.state.sceneFixtures.add(this.state.dirLight.target);
    } else if (!v && this.state.dirLight.parent) {
      this.state.scene.remove(this.state.dirLight);
      this.state.scene.remove(this.state.dirLight.target);
      this.state.sceneFixtures.delete(this.state.dirLight);
      this.state.sceneFixtures.delete(this.state.dirLight.target);
      this.shadowEnabled = false;
    }
  }

  get dirLightColor(): string { return '#' + this.state.dirLight.color.getHexString(); }
  set dirLightColor(hex: string) { this.state.dirLight.color.set(hex); }

  get dirLightIntensity(): number { return this.state.dirLight.intensity; }
  set dirLightIntensity(v: number) { this.state.dirLight.intensity = v; }

  // ─── Shadows ──────────────────────────────────────────────────────

  get shadowEnabled(): boolean { return this.state.renderer.shadowMap.enabled; }
  set shadowEnabled(v: boolean) {
    const effective = v && !!this.state.dirLight.parent;
    this.state.renderer.shadowMap.enabled = effective;
    // Toon mode uses hard-edged shadows (BasicShadowMap) for the stylized look;
    // all other modes use soft PCF.
    if (effective) this.state.renderer.shadowMap.type = this.caps.toon ? BasicShadowMap : PCFShadowMap;
    this.state.dirLight.castShadow = effective;
    if (effective) this.state._shadowsDirty = true;
    // Toggling shadows must force a re-render so the user sees the change
    // immediately — render-on-demand would otherwise skip the frame and
    // the shadow pass would never run.
    this.state._renderDirty = true;
    this.recompileMaterials();
  }

  get shadowIntensity(): number { return this.state.dirLight.shadow.intensity; }
  set shadowIntensity(v: number) { this.state.dirLight.shadow.intensity = v; }

  get shadowQuality(): ShadowQuality {
    const res = this.state.dirLight.shadow.mapSize.x;
    if (res <= 512) return 'low';
    if (res >= 2048) return 'high';
    return 'medium';
  }
  set shadowQuality(v: ShadowQuality) {
    const res = SHADOW_RES[v];
    this.state.dirLight.shadow.mapSize.set(res, res);
    if (this.state.dirLight.shadow.map) {
      this.state.dirLight.shadow.map.dispose();
      this.state.dirLight.shadow.map = null as unknown as typeof this.state.dirLight.shadow.map;
    }
    this.state.dirLight.shadow.camera.updateProjectionMatrix();
  }

  set shadowMapSize(size: number) {
    this.state.dirLight.shadow.mapSize.set(size, size);
    if (this.state.dirLight.shadow.map) {
      this.state.dirLight.shadow.map.dispose();
      this.state.dirLight.shadow.map = null as unknown as typeof this.state.dirLight.shadow.map;
    }
    this.state.dirLight.shadow.camera.updateProjectionMatrix();
    this.state._shadowsDirty = true;
    this.state._renderDirty = true;
  }

  set shadowRadius(radius: number) {
    this.state.dirLight.shadow.radius = radius;
    this.state._shadowsDirty = true;
    this.state._renderDirty = true;
  }

  // ─── DPR ──────────────────────────────────────────────────────────

  get effectiveDpr(): number {
    return this.state.renderer.getPixelRatio();
  }

  set maxDpr(cap: number) {
    const effective = cap >= 2 ? window.devicePixelRatio : Math.min(window.devicePixelRatio, cap);
    this.state.renderer.setPixelRatio(effective);
    this.state._renderDirty = true;
  }

  // ─── Light Intensity ──────────────────────────────────────────────

  get lightIntensity(): number {
    if (this.caps.environment) return this.state.scene.environmentIntensity;
    return this.state.ambientLight.intensity / 1.8;
  }
  set lightIntensity(v: number) {
    if (this.caps.environment) {
      this.state.scene.environmentIntensity = v;
    } else {
      this.state.ambientLight.intensity = 1.8 * v;
    }
    this.state._renderDirty = true;
  }

  // ─── Unlit Environment Reflections ────────────────────────────────

  get unlitReflectionsEnabled(): boolean { return this._unlitReflectionsEnabled; }
  set unlitReflectionsEnabled(v: boolean) {
    if (this._unlitReflectionsEnabled === v) return;
    this._unlitReflectionsEnabled = v;
    // Re-run the env assignment for the active mode (no-op unless mode is 'simple').
    this.applyLightingMode(this._lightingMode);
  }

  get unlitReflectionsIntensity(): number { return this._unlitReflectionsIntensity; }
  set unlitReflectionsIntensity(v: number) {
    this._unlitReflectionsIntensity = v;
    if (this._lightingMode === 'simple' && this._unlitReflectionsEnabled) {
      this.state.scene.environmentIntensity = v;
      this.state._renderDirty = true;
    }
  }

  /** Seed the unlit-reflection config WITHOUT re-applying — used by
   *  `applyVisualSettings` right before it sets `lightingMode`, whose
   *  `applyLightingMode` then reads these fields. */
  configureUnlitReflections(enabled: boolean, intensity: number): void {
    this._unlitReflectionsEnabled = enabled;
    this._unlitReflectionsIntensity = intensity;
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private applyLightingMode(mode: RenderMode): void {
    const caps = getRenderMode(mode).capabilities;

    // Ambient light — present only for modes that use the flat ambient ("unlit")
    // look. Modes driven by the HDRI environment remove the AmbientLight so it
    // does not stack on top of the environment.
    if (caps.ambientLight) {
      if (!this.state.ambientLight.parent) {
        this.state.scene.add(this.state.ambientLight);
        this.state.sceneFixtures.add(this.state.ambientLight);
      }
    } else if (this.state.ambientLight.parent) {
      this.state.scene.remove(this.state.ambientLight);
      this.state.sceneFixtures.delete(this.state.ambientLight);
    }

    // Directional light — force off for modes that don't support it (this also
    // cascades shadows off via the dirLightEnabled setter). Supporting modes
    // leave it to the caller (applyVisualSettings / VisualTab) to enable.
    if (!caps.directionalLight) this.dirLightEnabled = false;

    // Tone mapping — only applied when the mode supports it; otherwise raw output.
    this.state.renderer.toneMapping = caps.toneMapping ? TONE_MAP_LOOKUP[this._toneMapping] : NoToneMapping;

    // Shadow edge style follows the mode (hard BasicShadowMap for toon, soft PCF
    // otherwise). Set here too — switching INTO toon via the VisualTab applies
    // `shadowEnabled` while the previous mode's caps are still active, so the
    // type must be re-evaluated once the new mode is in effect.
    if (this.state.renderer.shadowMap.enabled) {
      this.state.renderer.shadowMap.type = caps.toon ? BasicShadowMap : PCFShadowMap;
      this.state._shadowsDirty = true;
      this.state._renderDirty = true;
    }

    // Environment (HDRI image-based lighting).
    if (caps.environment) {
      // Track the IBL load with the viewer so a concurrent model-load doesn't
      // reveal the scene before the environment is applied. Re-entry is fine:
      // loadEnvMap is cached (returns immediately after first success), and a
      // resolved promise just no-ops the drain.
      const envPromise = this.loadEnvMap().then(() => {
        if (getRenderMode(this._lightingMode).capabilities.environment) {
          this.state.scene.environment = this._envMapTexture;
        }
      });
      this.state.trackLoadingWork?.(envPromise);
    } else if (mode === 'simple' && this._unlitReflectionsEnabled) {
      // Unlit reflections: assign the same cubemap for specular reflections on
      // metallic/glossy surfaces, keeping the flat AmbientLight. The brightness
      // slider still drives ambientLight.intensity (caps.environment is false),
      // so reflection strength lives on scene.environmentIntensity independently.
      const envPromise = this.loadEnvMap().then(() => {
        if (this._lightingMode === 'simple' && this._unlitReflectionsEnabled) {
          this.state.scene.environment = this._envMapTexture;
          this.state.scene.environmentIntensity = this._unlitReflectionsIntensity;
        }
      });
      this.state.trackLoadingWork?.(envPromise);
    } else {
      this.state.scene.environment = null;
    }

    this.recompileMaterials();
  }

  recompileMaterials(root: Object3D = this.state.scene): void {
    root.traverse((node) => {
      const mesh = node as { material?: { needsUpdate?: boolean } };
      if (mesh.material) mesh.material.needsUpdate = true;
    });
  }

  async loadEnvMap(): Promise<void> {
    if (this._envMapTexture) return;
    const loader = new RGBELoader();
    const hdrTexture = await loader.loadAsync(`${import.meta.env.BASE_URL}envmaps/empty_warehouse_01_1k.hdr`);

    // WebGPU path (plan-271): the classic PMREMGenerator is WebGL-only, but
    // three/webgpu ships its own — use the async variant (waits for backend
    // init). Dynamic import keeps three/webgpu in the async chunk (NFR 9.8).
    // Without an env map, PBR metals render nearly black under WebGPU.
    if (this.state.isWebGPU) {
      try {
        const { PMREMGenerator: PMREMGeneratorGPU } = await import('three/webgpu');
        // @types/three 0.185 lags the runtime: fromEquirectangularAsync exists
        // on the three/webgpu PMREMGenerator but is not declared yet.
        const pmrem = new PMREMGeneratorGPU(this.state.renderer as never) as unknown as {
          fromEquirectangularAsync(t: Texture): Promise<{ texture: Texture }>;
          dispose(): void;
        };
        const envMap = await pmrem.fromEquirectangularAsync(hdrTexture);
        this._envMapTexture = envMap.texture;
        pmrem.dispose();
      } catch {
        warnEnvMapWebGPUOnce();
      } finally {
        hdrTexture.dispose();
      }
      return;
    }

    const pmrem = new PMREMGenerator(this.state.renderer as unknown as WebGLRenderer);
    const envMap = pmrem.fromEquirectangular(hdrTexture);
    this._envMapTexture = envMap.texture;
    hdrTexture.dispose();
    pmrem.dispose();
  }
}
