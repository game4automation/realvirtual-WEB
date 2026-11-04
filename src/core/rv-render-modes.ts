// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Render-mode registry — the single source of truth for the WebViewer's
 * rendering presets — four modes: "Unlit", "Shaded", "Toon" and "Ray traced".
 *
 * Note: the mode *ids* stay `'simple' | 'default' | 'toon' | 'raytraced'` (used
 * as keys in persisted settings, `modeSettings`, and preset files); only the
 * user-facing `label`s are "Unlit" / "Shaded" / "Toon" / "Ray traced".
 *
 * Backend gate (plan-762): a descriptor may declare `requires: 'compute'`. Such
 * a mode exists only on the real WebGPU backend (`hasCompute`) AND when a
 * backend implementation is registered (`backendRegistered`). The gate lives
 * HERE — {@link availableRenderModes} and {@link resolveRenderMode} are the only
 * two functions the UI, the commands, the MCP tools and the persistence path
 * use to decide; nobody re-implements the check. On `webgl` / `webgpu-gl` the
 * ray traced mode is not selectable anywhere and a persisted value falls back
 * to {@link DEFAULT_RENDER_MODE}.
 *
 * Each mode is described by a {@link RenderModeDescriptor} whose
 * {@link RenderModeCapabilities} flags drive BOTH:
 *  - the **UI** (which control blocks the Visual settings tab renders), and
 *  - the **pipeline** (which rendering features the viewer keeps active).
 *
 * Keeping these two concerns behind one descriptor means adding a new mode is a
 * single-entry change here — no scattered `mode === 'default'` branches.
 *
 * `'simple'` is intentionally minimal: a single flat AmbientLight, no
 * environment IBL, no tone mapping, no shadows, and no post-processing
 * (ambient occlusion / bloom). The composer is therefore never engaged
 * (see `PostProcessingManager.useComposer`), so Simple has zero unneeded
 * rendering work active. `'default'` enables the full feature set.
 */

export type RenderMode = 'simple' | 'default' | 'toon' | 'raytraced';

/**
 * Per-mode feature flags. Each flag gates one rendering feature in the
 * pipeline AND its corresponding control group in the Visual settings UI.
 *
 * Note: the global brightness control (`lightIntensity`) is shown in every
 * mode (its label switches to "Environment Intensity" when `environment` is
 * on), so it is deliberately NOT represented as a capability flag.
 */
export interface RenderModeCapabilities {
  /** Flat AmbientLight color + intensity (the "unlit" look used by Simple). */
  ambientLight: boolean;
  /** HDRI image-based lighting. Also relabels brightness as "Environment Intensity". */
  environment: boolean;
  /** Directional (key) light. */
  directionalLight: boolean;
  /** Filmic tone mapping (+ exposure). */
  toneMapping: boolean;
  /** Real-time shadow pass (implies {@link directionalLight}). */
  shadows: boolean;
  /** Ambient-occlusion post-processing (GTAO / N8AO). WebGL: composer passes; WebGPU: the TSL GTAO node (plan-271). */
  ambientOcclusion: boolean;
  /** Bloom post-processing. WebGL: UnrealBloomPass; WebGPU: the TSL bloom node (plan-763). */
  bloom: boolean;
  /** Floor mirror reflection. Both renderers since plan-763. Off in toon (the floor is the flat
   *  cel-shaded checker, no reflection). Also gates the Reflection control in
   *  the Environment settings tab. */
  reflection: boolean;
  /**
   * Cel / toon shading. When set, the viewer swaps every scene material to a
   * banded {@link import('three').MeshToonMaterial} and draws a screen-space
   * Sobel outline (depth + normals). Also gates the toon-specific control block
   * in the Visual settings UI (band count, outline thickness/color, cool
   * shadows). The outline runs as the composer Sobel pass on WebGL and as the
   * edge node of the TSL post pipeline on WebGPU (plan-763).
   */
  toon: boolean;
}

/** A render-mode preset: identity, display metadata, and its capabilities. */
export interface RenderModeDescriptor {
  id: RenderMode;
  label: string;
  description: string;
  capabilities: RenderModeCapabilities;
  /**
   * Backend requirement. Absent = available on every backend. `'compute'` = the
   * real WebGPU backend with compute AND a registered backend implementation
   * (see {@link RenderModeContext}).
   */
  requires?: 'compute';
}

/**
 * What the running viewer can offer, as seen by the render-mode gate. Both
 * fields are mandatory; a caller that does not know defaults them to `false`
 * (a community build without a backend therefore never offers a gated mode).
 */
export interface RenderModeContext {
  /** True only on the real WebGPU backend (compute shaders available). */
  hasCompute: boolean;
  /** True when a ray traced backend implementation is registered. */
  backendRegistered: boolean;
}

/** Gate context of a caller that knows nothing — every gated mode is unavailable. */
export const NO_RENDER_MODE_CONTEXT: RenderModeContext = Object.freeze({ hasCompute: false, backendRegistered: false });

/** Ordered list of all render modes (drives the Render Mode dropdown). */
export const RENDER_MODES: readonly RenderModeDescriptor[] = [
  {
    id: 'simple',
    label: 'Unlit',
    description: 'Unlit, minimal — fastest',
    capabilities: {
      ambientLight: true,
      environment: false,
      directionalLight: false,
      toneMapping: false,
      shadows: false,
      ambientOcclusion: false,
      bloom: false,
      reflection: true,
      toon: false,
    },
  },
  {
    id: 'default',
    label: 'Shaded',
    description: 'Fully rendered',
    capabilities: {
      ambientLight: false,
      environment: true,
      directionalLight: true,
      toneMapping: true,
      shadows: true,
      ambientOcclusion: true,
      bloom: true,
      reflection: true,
      toon: false,
    },
  },
  {
    id: 'toon',
    label: 'Toon',
    description: 'Cel-shaded, stylized',
    capabilities: {
      // Lightweight cel look: a flat ambient fill (brightness control) + a
      // single directional key light. A toon material bands the diffuse by
      // light direction and adds a hard specular highlight from the key light.
      // No HDRI environment (grey sky), no shadows, no tone mapping — just the
      // banded materials plus the screen-space Sobel edge (the `toon` flag).
      ambientLight: true,
      environment: false,
      directionalLight: true,
      toneMapping: false,
      shadows: false,
      ambientOcclusion: false,
      bloom: false,
      reflection: false,
      toon: true,
    },
  },
  {
    id: 'raytraced',
    label: 'Ray traced',
    description: 'Ray traced lighting (WebGPU)',
    requires: 'compute',
    capabilities: {
      // Hybrid: rasterised primary hit + traced diffuse / specular lighting from
      // the HDRI environment only. No key light (2026-10-20): the directional
      // light leaves the scene, so the raster fallback (pixels without history)
      // matches the traced image. Shadow map, AO, bloom, the toon look, the flat
      // ambient fill and the floor mirror are all off — shadows and AO fall out
      // of the traced bounce, and WebGPU has no reflector.
      ambientLight: false,
      environment: true,
      directionalLight: false,
      toneMapping: true,
      shadows: false,
      ambientOcclusion: false,
      bloom: false,
      reflection: false,
      toon: false,
    },
  },
] as const;

/** Convenience list of mode ids (mirrors the legacy `LIGHTING_MODES` order). */
export const RENDER_MODE_IDS: readonly RenderMode[] = RENDER_MODES.map((m) => m.id);

/** Default mode used when a stored/looked-up id is missing or invalid. */
export const DEFAULT_RENDER_MODE: RenderMode = 'default';

/**
 * Look up a render-mode descriptor by id. Falls back to the
 * {@link DEFAULT_RENDER_MODE} descriptor for unknown ids so callers never
 * have to null-check.
 */
export function getRenderMode(id: RenderMode | string | undefined): RenderModeDescriptor {
  const found = RENDER_MODES.find((m) => m.id === id);
  return found ?? RENDER_MODES.find((m) => m.id === DEFAULT_RENDER_MODE)!;
}

/** True if the given mode supports a specific rendering capability. */
export function modeSupports(id: RenderMode | string | undefined, feature: keyof RenderModeCapabilities): boolean {
  return getRenderMode(id).capabilities[feature];
}

/** Type guard: is the value a known render-mode id? */
export function isRenderMode(value: unknown): value is RenderMode {
  return typeof value === 'string' && RENDER_MODES.some((m) => m.id === value);
}

/** True when the descriptor's backend requirement is met by the context. */
function modeAvailableIn(m: RenderModeDescriptor, ctx: RenderModeContext): boolean {
  return !m.requires || (ctx.hasCompute === true && ctx.backendRegistered === true);
}

/** True when the mode id is known AND available in the given gate context. */
export function isRenderModeAvailable(id: unknown, ctx: RenderModeContext): boolean {
  return isRenderMode(id) && modeAvailableIn(getRenderMode(id), ctx);
}

/**
 * The render modes selectable in the given context, in registry order. Without
 * compute or without a registered backend these are the three ungated modes.
 */
export function availableRenderModes(ctx: RenderModeContext): readonly RenderModeDescriptor[] {
  return RENDER_MODES.filter((m) => modeAvailableIn(m, ctx));
}

/**
 * Resolve a requested / persisted mode id against the gate: the id itself when
 * it is a known mode available in `ctx`, else {@link DEFAULT_RENDER_MODE}.
 * Pure — no viewer import; the single place that maps an unavailable mode to
 * the default.
 */
export function resolveRenderMode(id: unknown, ctx: RenderModeContext): RenderMode {
  return isRenderModeAvailable(id, ctx) ? (id as RenderMode) : DEFAULT_RENDER_MODE;
}

/**
 * Why a mode is not available in `ctx`, or `null` when it is. The texts are
 * user-facing (command `enabled()` reason, MCP refusal). `unavailableMessage`
 * is the text for "compute present, but no backend registered".
 */
export function renderModeUnavailableReason(
  id: unknown,
  ctx: RenderModeContext,
  unavailableMessage: string,
): string | null {
  if (!isRenderMode(id)) return null;
  const m = getRenderMode(id);
  if (!m.requires) return null;
  if (!ctx.hasCompute) return `${m.label} needs the WebGPU backend`;
  if (!ctx.backendRegistered) return unavailableMessage;
  return null;
}
