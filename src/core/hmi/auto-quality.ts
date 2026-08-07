// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * auto-quality — Automatic visual-quality selection for weak devices.
 *
 * A single **boot seed** stage, switching to the published "Fast" preset
 * (Unlit render mode, no shadows, no antialias, lower DPR cap — see
 * public/presets/): on a fresh install (no persisted visual settings) the
 * initial preset is chosen from a cheap standalone WebGL probe plus mobile
 * detection, so weak devices boot on "Fast" instead of "Default". This runs
 * BEFORE the renderer exists (main.ts seeds the preset before
 * `RVViewer.create`, because antialias is a constructor-only param), hence the
 * standalone probe instead of `viewer.getGPUAnalysis()`.
 *
 * There is deliberately NO runtime FPS watchdog: quality never changes by
 * itself while the user is working. Once booted, the visual preset is the
 * user's to choose in Settings → Visual.
 *
 * The seed notifies the user through the AutoQualityDialog modal (dismissed
 * with OK) and acts AT MOST ONCE per device: the localStorage flag
 * {@link AUTO_QUALITY_APPLIED_KEY} is set on the first automatic action, and
 * every later run is a no-op — once the user has seen the downgrade, a manual
 * preset choice is never fought again.
 */

import { useSyncExternalStore } from 'react';
import { classifyGPU, type GPUTier } from '../engine/rv-gpu-info';
import { isMobileDevice } from '../../hooks/use-mobile-layout';
import { createStore } from './create-store';

/** Preset applied on weak devices. Must exist in public/presets/index.json. */
export const FAST_PRESET_NAME = 'Fast';
/** Preset seeded on capable devices (the regular fresh-install default). */
export const DEFAULT_PRESET_NAME = 'Default';

/** localStorage flag: the boot seed already picked a preset on this device.
 *  Registered in rv-storage-keys. */
export const AUTO_QUALITY_APPLIED_KEY = 'rv-auto-quality-applied';

/** Why the automatic action happened — drives the modal's message. */
export type AutoQualityReason = 'mobile' | 'weak-gpu';

// ─── Boot-time preset choice ───────────────────────────────────────────────

/** Probe the GPU tier WITHOUT a Three.js renderer: throwaway canvas + WebGL
 *  context with the same 'high-performance' hint the real renderer uses, so
 *  the probe sees the same adapter the viewer will get. Never throws. */
export function probeGPUTier(): GPUTier {
  try {
    const canvas = document.createElement('canvas');
    const attrs: WebGLContextAttributes = { powerPreference: 'high-performance' };
    const gl = (canvas.getContext('webgl2', attrs) ?? canvas.getContext('webgl', attrs)) as
      | WebGLRenderingContext
      | WebGL2RenderingContext
      | null;
    // No WebGL context at all — the viewer itself won't fare better; treat as
    // the weakest tier so the seed at least picks the cheapest preset.
    if (!gl) return 'software';
    const ext = gl.getExtension('WEBGL_debug_renderer_info') as
      | { UNMASKED_RENDERER_WEBGL: number }
      | null;
    const renderer = ext
      ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) ?? '')
      : String(gl.getParameter(gl.RENDERER) ?? '');
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    return classifyGPU({ vendor: '', renderer });
  } catch {
    return 'unknown';
  }
}

/** Pure decision: which preset should a fresh install seed? Weak devices
 *  (mobile, integrated or software GPU) get "Fast" with a reason; everything
 *  else — including 'unknown', where guessing low would punish capable
 *  hardware behind privacy-redacted GPU strings — gets "Default". */
export function pickInitialPreset(
  mobile: boolean,
  tier: GPUTier,
): { name: typeof FAST_PRESET_NAME | typeof DEFAULT_PRESET_NAME; reason?: AutoQualityReason } {
  if (mobile) return { name: FAST_PRESET_NAME, reason: 'mobile' };
  if (tier === 'integrated' || tier === 'software') return { name: FAST_PRESET_NAME, reason: 'weak-gpu' };
  return { name: DEFAULT_PRESET_NAME };
}

/** Impure wrapper for main.ts: probe the device and pick the seed preset.
 *  Skips the (context-creating) GPU probe on mobile, where the answer is
 *  already decided. */
export function chooseInitialQualityPreset(): ReturnType<typeof pickInitialPreset> {
  const mobile = isMobileDevice();
  return pickInitialPreset(mobile, mobile ? 'unknown' : probeGPUTier());
}

// ─── Once-per-device flag ──────────────────────────────────────────────────

export function hasAutoQualityApplied(): boolean {
  try { return localStorage.getItem(AUTO_QUALITY_APPLIED_KEY) === '1'; } catch { return false; }
}

export function markAutoQualityApplied(): void {
  try { localStorage.setItem(AUTO_QUALITY_APPLIED_KEY, '1'); } catch { /* private mode */ }
}

// ─── User notice (consumed by AutoQualityDialog) ───────────────────────────

export interface AutoQualityNotice {
  reason: AutoQualityReason;
  presetName: string;
}

const _notice = createStore<AutoQualityNotice | null>(null);

/** Queue the "quality was reduced" modal. Survives until the user clicks OK —
 *  the boot seed queues before React mounts and the dialog picks it up then. */
export function queueAutoQualityNotice(reason: AutoQualityReason): void {
  _notice.set(() => ({ reason, presetName: FAST_PRESET_NAME }));
}

export function clearAutoQualityNotice(): void {
  _notice.set(() => null);
}

export function getAutoQualityNotice(): AutoQualityNotice | null {
  return _notice.getSnapshot();
}

/** React hook — live notice state for the dialog. */
export function useAutoQualityNotice(): AutoQualityNotice | null {
  return useSyncExternalStore(_notice.subscribe, _notice.getSnapshot, _notice.getSnapshot);
}
