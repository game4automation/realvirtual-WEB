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
  Texture,
} from 'three';
import type { ToneMapping as ThreeToneMapping } from 'three';
import type { Renderer } from 'three/webgpu';
import { RGBELoader } from 'three/examples/jsm/loaders/RGBELoader.js';
import type { ToneMappingType, ShadowQuality, LightingMode } from './hmi/visual-settings-store';

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

/** Shared state that VisualSettingsManager reads/writes on the facade. */
export interface ViewerVisualState {
  scene: Scene;
  renderer: Renderer;
  ambientLight: AmbientLight;
  dirLight: DirectionalLight;
  sceneFixtures: Set<import('three').Object3D>;
  _shadowsDirty: boolean;
  _renderDirty: boolean;
}

/**
 * VisualSettingsManager handles lighting, tone mapping, shadows,
 * environment maps, and rendering quality settings.
 */
export class VisualSettingsManager {
  private state: ViewerVisualState;
  private _lightingMode: LightingMode = 'simple';
  private _toneMapping: ToneMappingType = 'none';
  private _envMapTexture: Texture | null = null;

  constructor(state: ViewerVisualState) {
    this.state = state;
  }

  // ─── Lighting Mode ────────────────────────────────────────────────

  get lightingMode(): LightingMode { return this._lightingMode; }
  set lightingMode(mode: LightingMode) {
    this._lightingMode = mode;
    this.applyLightingMode(mode);
  }

  // ─── Tone Mapping ─────────────────────────────────────────────────

  get toneMapping(): ToneMappingType { return this._toneMapping; }
  set toneMapping(v: ToneMappingType) {
    this._toneMapping = v;
    this.state.renderer.toneMapping = (this._lightingMode === 'default')
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
    if (effective) this.state.renderer.shadowMap.type = PCFShadowMap;
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
    if (this._lightingMode === 'default') return this.state.scene.environmentIntensity;
    return this.state.ambientLight.intensity / 1.8;
  }
  set lightIntensity(v: number) {
    if (this._lightingMode === 'default') {
      this.state.scene.environmentIntensity = v;
    } else {
      this.state.ambientLight.intensity = 1.8 * v;
    }
    this.state._renderDirty = true;
  }

  // ─── Internal ─────────────────────────────────────────────────────

  private applyLightingMode(mode: LightingMode): void {
    if (!this.state.ambientLight.parent) this.state.scene.add(this.state.ambientLight);

    if (mode === 'default') {
      this.state.renderer.toneMapping = TONE_MAP_LOOKUP[this._toneMapping];
      this.loadEnvMap().then(() => {
        if (this._lightingMode === 'default') {
          this.state.scene.environment = this._envMapTexture;
        }
      });
    } else {
      this.state.scene.environment = null;
      this.state.renderer.toneMapping = NoToneMapping;
      this.dirLightEnabled = false;
    }
    this.recompileMaterials();
  }

  recompileMaterials(): void {
    this.state.scene.traverse((node) => {
      const mesh = node as { material?: { needsUpdate?: boolean } };
      if (mesh.material) mesh.material.needsUpdate = true;
    });
  }

  async loadEnvMap(): Promise<void> {
    if (this._envMapTexture) return;
    const loader = new RGBELoader();
    const hdrTexture = await loader.loadAsync(`${import.meta.env.BASE_URL}envmaps/empty_warehouse_01_1k.hdr`);
    const pmrem = new PMREMGenerator(this.state.renderer as unknown as WebGLRenderer);
    const envMap = pmrem.fromEquirectangular(hdrTexture);
    this._envMapTexture = envMap.texture;
    hdrTexture.dispose();
    pmrem.dispose();
  }
}
