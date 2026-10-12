// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ground-reflector — Pure factory for the viewer's optional floor reflection.
 *
 * Creates a Three.js {@link Reflector} mirror plane that sits just beneath the
 * checker-fade ground plane (see {@link createGroundFade}). When enabled the
 * checker floor is made partly transparent so the mirror reads through, giving
 * a glossy "showroom" floor while keeping the familiar checker grid and its
 * soft circular edge fade.
 *
 * Several details make the reflection blend cleanly and read as a real surface:
 *
 *  1. **Identical disc fade.** The reflector's geometry is a 200×200 plane —
 *     the same base size as the checker plane — so the caller can apply the
 *     exact same `scale` / X-Z `position`. Its shader is patched (in place,
 *     since we own the ShaderMaterial) to multiply the output alpha by the
 *     same LINEAR radial fade the checker uses, derived from
 *     {@link FLOOR_FADE_START_RATIO} / {@link FLOOR_FADE_END_RATIO}. The mirror
 *     therefore fades out on exactly the same radius as the checker — no hard
 *     rectangle corners, no seam.
 *
 *  2. **Strength via overlay color.** The stock ReflectorShader blends the
 *     mirror texture with its `color` uniform using an overlay blend, where a
 *     mid-gray (0.5) reproduces the reflection unchanged. {@link setReflectorStrength}
 *     maps a 0..1 strength onto that gray (0 → black/off, 0.5 → full natural
 *     mirror).
 *
 *  3. **Fresnel falloff.** A view-angle term folded into the alpha makes the
 *     reflection strong at grazing angles and weak when looking straight down
 *     (never below {@link FRESNEL_MIN}), so the floor behaves like a real
 *     glossy surface instead of a flat uniform mirror.
 *
 *  4. **Floor exclusion.** The stock Reflector's virtual camera renders scene
 *     layer 0, which includes the checker plane → a faint doubled checker in
 *     the mirror. The wrapped `onBeforeRender` hides the checker for the
 *     reflection pass only.
 *
 *  5. **Gloss blur.** After the sharp reflection is rendered, an optional
 *     *iterated* separable blur softens it into a polished/frosted look — the
 *     standard half-res glossy-floor approach. Each H+V pass is a 9-tap Gaussian
 *     stepped by exactly ONE texel (offset = 1/size); that keeps the taps
 *     contiguous so they can't ghost into X/Y bands. Blur WIDTH comes from the
 *     iteration count (compounded Gaussians) — adjustable via the settings
 *     slider — not from widening the per-pass step. See {@link setReflectorBlur}.
 *
 * NOTE: this is a planar mirror — it re-renders the scene from a mirrored
 * camera, so view-dependent specular highlights (and the HDRI/IBL reflections
 * that dominate here) legitimately differ from the direct view; three.js also
 * does not correct winding/normals for a mirrored camera. The soft-gloss blur
 * default is intentional: it masks that (correct-but-different) specular so the
 * floor reads as polished. An exact match to the direct view would require
 * screen-space reflection, not a planar reflector.
 *
 * Like bloom / ambient-occlusion, the classic Reflector is **WebGL-only**
 * (it allocates a WebGLRenderTarget and renders via `onBeforeRender`), so on
 * the WebGPU backend the factory returns `null` and the caller skips it.
 */

import {
  Color,
  HalfFloatType,
  LinearFilter,
  type Mesh,
  PlaneGeometry,
  ShaderMaterial,
  UniformsUtils,
  WebGLRenderTarget,
} from 'three';
import { Reflector } from 'three/addons/objects/Reflector.js';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { HorizontalBlurShader } from 'three/addons/shaders/HorizontalBlurShader.js';
import { VerticalBlurShader } from 'three/addons/shaders/VerticalBlurShader.js';
import { FLOOR_FADE_START_RATIO, FLOOR_FADE_END_RATIO } from './rv-ground-plane';
import { drawCallsOf, addNestedDelta, getActiveFrameStats, type RenderInfoLike } from './rv-frame-stats';

/** Overlay-blend gray that reproduces an unmodified ("full") reflection. */
const FULL_MIRROR_GRAY = 0.5;

/** Reflection minimum when viewed straight down (Fresnel floor). */
const FRESNEL_MIN = 0.25;
/** Fresnel exponent — higher = reflection concentrates toward grazing angles. */
const FRESNEL_POWER = 3.0;

/** Iterated H+V blur pairs at blur = 1 (the settings slider scales this). Each
 *  pass is a STANDARD 9-tap Gaussian stepped by exactly one texel (offset =
 *  1/size) so its taps stay contiguous and never ghost; blur WIDTH comes from
 *  the iteration count (compounded Gaussians) and from running at half res. */
const MAX_BLUR_ITERATIONS = 8;

/** Mirror render-target edge length (px). 1024² is ample for a floor mirror
 *  and keeps the extra per-frame render cheap; scaled by DPR and capped. */
const REFLECTOR_RT_BASE = 1024;
const REFLECTOR_RT_MAX = 2048;

/** Per-reflector blur state, stashed on `reflector.userData._rvReflection`. */
interface ReflectionControl {
  sharpRT: WebGLRenderTarget;
  blurRT1: WebGLRenderTarget;
  blurRT2: WebGLRenderTarget;
  fsQuad: FullScreenQuad;
  hMat: ShaderMaterial;
  vMat: ShaderMaterial;
  /** Number of iterated H+V blur pairs; 0 = sharp (blur skipped). */
  blurIterations: number;
  /** `[sharpRT, blurRT1, blurRT2]` — cached for the render-target census. */
  renderTargets: readonly WebGLRenderTarget[];
}

function getControl(reflector: Reflector): ReflectionControl {
  return (reflector.userData as { _rvReflection: ReflectionControl })._rvReflection;
}

/**
 * The render targets a ground reflector owns (mirror + the two half-res blur
 * ping-pong targets), for `countRenderTargets` — the mirror texture is one of
 * the `info.memory.textures` the DevTools tab has to explain.
 */
export function getReflectorRenderTargets(reflector: Reflector | null): readonly WebGLRenderTarget[] {
  return reflector ? getControl(reflector).renderTargets : EMPTY_TARGETS;
}
const EMPTY_TARGETS: readonly WebGLRenderTarget[] = [];

/**
 * Create the floor reflection mirror, or `null` on WebGPU (WebGL-only feature).
 *
 * The returned mesh is rotated horizontal, tagged `renderOrder = -2` (so it
 * composites *before* the checker plane at -1), starts `visible = false`, and
 * fades to transparent on the same disc profile as the checker floor.
 *
 * @param isWebGPU   When true the Reflector is unsupported — returns `null`.
 * @param checkerMesh The checker ground plane, hidden during the reflection
 *  pass so it does not appear doubled inside the mirror.
 */
export function createGroundReflector(isWebGPU: boolean, checkerMesh: Mesh): Reflector | null {
  if (isWebGPU) return null;

  const dpr = typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1;
  const rt = Math.min(REFLECTOR_RT_MAX, Math.round(REFLECTOR_RT_BASE * dpr));

  const geo = new PlaneGeometry(200, 200);
  const reflector = new Reflector(geo, {
    clipBias: 0.003,
    textureWidth: rt,
    textureHeight: rt,
    color: 0x000000, // strength applied via setReflectorStrength (starts off)
  });

  reflector.rotation.x = -Math.PI / 2;
  reflector.renderOrder = -2;
  reflector.visible = false;

  const reflectorMat = reflector.material as ShaderMaterial;
  patchDiscFade(reflectorMat);

  // ── Blur resources (standard half-res iterated Gaussian) ──
  // Gloss blur runs at HALF resolution: cheap, and the larger half-res texels
  // let each pass cover more area. The two RTs ping-pong; the first H pass
  // bilinear-downsamples the full-res MSAA-resolved sharp reflection into the
  // half-res target. Each pass steps by exactly one texel (see the render loop).
  const sharpRT = reflector.getRenderTarget() as WebGLRenderTarget;
  const blurSize = Math.max(256, Math.round(rt / 2));
  const blurOpts = { type: HalfFloatType, minFilter: LinearFilter, magFilter: LinearFilter, depthBuffer: false, generateMipmaps: false };
  const blurRT1 = new WebGLRenderTarget(blurSize, blurSize, blurOpts);
  const blurRT2 = new WebGLRenderTarget(blurSize, blurSize, blurOpts);
  const hMat = new ShaderMaterial({
    uniforms: UniformsUtils.clone(HorizontalBlurShader.uniforms),
    vertexShader: HorizontalBlurShader.vertexShader,
    fragmentShader: HorizontalBlurShader.fragmentShader,
  });
  const vMat = new ShaderMaterial({
    uniforms: UniformsUtils.clone(VerticalBlurShader.uniforms),
    vertexShader: VerticalBlurShader.vertexShader,
    fragmentShader: VerticalBlurShader.fragmentShader,
  });
  const fsQuad = new FullScreenQuad();

  const ctrl: ReflectionControl = {
    sharpRT, blurRT1, blurRT2, fsQuad, hMat, vMat, blurIterations: 0,
    renderTargets: [sharpRT, blurRT1, blurRT2],
  };
  reflector.userData._rvReflection = ctrl;

  // ── Wrap onBeforeRender: exclude the checker from the reflection pass, then
  //    optionally blur the rendered mirror in place. ──
  //
  // Frame accounting (rv-frame-stats.ts): three fires `onBeforeRender` in
  // EVERY `renderer.render` whose render list holds this mesh — the
  // RenderPass, the AO gbuffer renders and the OutlinePass depth pass (an
  // `overrideMaterial` does not suppress it; the stock Reflector only guards
  // against recursion by setting `scope.visible = false` around its inner
  // render). Each firing re-renders the whole scene into the mirror target,
  // so the delta of this wrapper (mirror render + blur quads) is booked to
  // `reflection` and taken out of the pass bucket that is running.
  const origOnBeforeRender = reflector.onBeforeRender;
  reflector.onBeforeRender = function (renderer, scene, camera, geometry, material, group) {
    const stats = getActiveFrameStats();
    const info = renderer.info as unknown as RenderInfoLike;
    const c0 = drawCallsOf(info);
    const t0 = info.render.triangles;
    try {
      renderReflection(renderer, scene, camera, geometry, material, group);
    } finally {
      if (stats) addNestedDelta(stats, 'reflection', info, c0, t0);
    }
  };
  const renderReflection: Reflector['onBeforeRender'] = (renderer, scene, camera, geometry, material, group) => {
    const checkerWasVisible = checkerMesh.visible;
    checkerMesh.visible = false;
    origOnBeforeRender.call(reflector, renderer, scene, camera, geometry, material, group); // fills sharpRT
    checkerMesh.visible = checkerWasVisible;

    const iterations = ctrl.blurIterations;
    if (iterations > 0) {
      const prevRT = renderer.getRenderTarget();
      const prevAutoClear = renderer.autoClear;
      renderer.autoClear = true;
      // Iterated separable blur, ping-ponging blurRT1 ↔ blurRT2 at half res.
      // The first H pass reads the MSAA-resolved sharp reflection (downsampling
      // to half res); every later pass reads blurRT2. CRITICAL: the kernel steps
      // by exactly ONE texel (1/size) — the 9-tap shader is a Gaussian tuned for
      // that, so taps stay contiguous and never ghost into X/Y bands. Width
      // comes from the iteration count. Result always ends in blurRT2.
      const texel = 1 / ctrl.blurRT1.width;
      for (let i = 0; i < iterations; i++) {
        hMat.uniforms.tDiffuse.value = (i === 0) ? ctrl.sharpRT.texture : ctrl.blurRT2.texture;
        hMat.uniforms.h.value = texel;
        renderer.setRenderTarget(ctrl.blurRT1);
        fsQuad.material = hMat;
        fsQuad.render(renderer);

        vMat.uniforms.tDiffuse.value = ctrl.blurRT1.texture;
        vMat.uniforms.v.value = texel;
        renderer.setRenderTarget(ctrl.blurRT2);
        fsQuad.material = vMat;
        fsQuad.render(renderer);
      }
      renderer.setRenderTarget(prevRT);
      renderer.autoClear = prevAutoClear;
      reflectorMat.uniforms.tDiffuse.value = ctrl.blurRT2.texture;
    } else {
      reflectorMat.uniforms.tDiffuse.value = ctrl.sharpRT.texture;
    }
  };

  // ── Wrap dispose to free the extra blur resources too. ──
  const origDispose = reflector.dispose.bind(reflector);
  reflector.dispose = function () {
    origDispose();
    blurRT1.dispose();
    blurRT2.dispose();
    hMat.dispose();
    vMat.dispose();
    fsQuad.dispose();
  };

  return reflector;
}

/**
 * Set the reflection strength (0..1) by mapping it onto the mirror's overlay
 * color: 0 → black (no reflection), 1 → mid-gray (full natural mirror).
 */
export function setReflectorStrength(reflector: Reflector, strength: number): void {
  const s = Math.max(0, Math.min(1, strength));
  const gray = FULL_MIRROR_GRAY * s;
  const color = (reflector.material as ShaderMaterial).uniforms.color.value as Color;
  color.setScalar(gray);
}

/**
 * Set the reflection blur / gloss (0 = sharp mirror, 1 = soft frosted gloss).
 * Maps onto a resolution-independent UV-space blur spread.
 */
export function setReflectorBlur(reflector: Reflector, blur: number): void {
  const b = Math.max(0, Math.min(1, blur));
  getControl(reflector).blurIterations = Math.round(b * MAX_BLUR_ITERATIONS);
}

/**
 * Patch the ReflectorShader (in place — we own this ShaderMaterial) so the
 * mirror (a) fades to transparent using the SAME linear radial profile as the
 * checker floor, and (b) applies a Fresnel view-angle falloff. The opaque
 * inner radius equals FLOOR_FADE_START_RATIO / FLOOR_FADE_END_RATIO of the disc
 * (matching the checker's alpha map), then a linear fade to zero at the
 * inscribed edge; the Fresnel term multiplies that alpha.
 */
function patchDiscFade(mat: ShaderMaterial): void {
  mat.transparent = true;
  mat.depthWrite = false;

  const opaqueRatio = (FLOOR_FADE_START_RATIO / FLOOR_FADE_END_RATIO).toFixed(6);

  mat.vertexShader = mat.vertexShader
    .replace(
      'varying vec4 vUv;',
      'varying vec4 vUv;\n\t\t\tvarying vec2 vDiscUv;\n\t\t\tvarying vec3 vViewDir;',
    )
    .replace(
      'vUv = textureMatrix * vec4( position, 1.0 );',
      'vUv = textureMatrix * vec4( position, 1.0 );\n' +
        '\t\t\t\tvDiscUv = uv;\n' +
        '\t\t\t\tvec4 _wp = modelMatrix * vec4( position, 1.0 );\n' +
        '\t\t\t\tvViewDir = cameraPosition - _wp.xyz;',
    );

  mat.fragmentShader = mat.fragmentShader
    .replace(
      'varying vec4 vUv;',
      'varying vec4 vUv;\n\t\t\tvarying vec2 vDiscUv;\n\t\t\tvarying vec3 vViewDir;',
    )
    .replace(
      'gl_FragColor = vec4( blendOverlay( base.rgb, color ), 1.0 );',
      `float _r = length( vDiscUv - vec2( 0.5 ) ) * 2.0;\n` +
        `\t\t\t\tfloat _mask = clamp( 1.0 - ( _r - ${opaqueRatio} ) / ( 1.0 - ${opaqueRatio} ), 0.0, 1.0 );\n` +
        `\t\t\t\tfloat _ndotv = clamp( normalize( vViewDir ).y, 0.0, 1.0 );\n` +
        `\t\t\t\tfloat _fres = mix( ${FRESNEL_MIN.toFixed(3)}, 1.0, pow( 1.0 - _ndotv, ${FRESNEL_POWER.toFixed(3)} ) );\n` +
        `\t\t\t\tgl_FragColor = vec4( blendOverlay( base.rgb, color ), _mask * _fres );`,
    );

  mat.needsUpdate = true;
}
