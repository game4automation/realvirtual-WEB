// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * render-mode-controller — THE one setter for the viewer's render mode
 * (plan-761). The Visual tab's dropdown, the toolbar pill and the MCP tool
 * `web_view_render_mode` are views of the command `view.renderMode`, whose
 * implementation is {@link setRenderMode}; nobody else writes
 * `viewer.renderMode` (the only other writer is the viewer's internal
 * `lightingMode` alias).
 *
 * The pill is a UI single axis over TWO state fields: the persisted
 * `renderMode` (`simple | default | toon`) and the transient editor flag
 * `wireframe`. {@link deriveRenderModeValue} is the one rule that folds them:
 * `wireframeActive ? 'wireframe' : renderMode`. `wireframeActive` (the APPLIED
 * state, editor mode only), not `wireframe` (the latent toggle): leaving the
 * editor drops the applied state and keeps the toggle, so a shading click in
 * viewer mode must not clear a setting the user will find again in the editor.
 *
 * `import type { RVViewer }` only — rv-viewer.ts itself imports hmi/ modules,
 * a runtime import here would be a cycle (pattern: sim-commands.ts).
 */

import type { RVViewer } from '../rv-viewer';
import type { RenderMode } from '../rv-render-modes';
import { isTabLocked } from '../rv-app-config';
import { loadVisualSettings, saveVisualSettings } from './visual-settings-store';

/** What the pill shows: a shading mode, or `'wireframe'` while that view is applied. */
export type RenderModeValue = RenderMode | 'wireframe';

/** The reason a locked deployment refuses render-mode changes. */
export const RENDER_MODE_LOCKED = 'Visual settings are locked by this deployment';

/** The ONE derivation rule shared by the pill, the tests and MCP. */
export function deriveRenderModeValue(viewer: RVViewer): RenderModeValue {
  return viewer.wireframeActive ? 'wireframe' : viewer.renderMode;
}

/**
 * Subscribe to everything that can change {@link deriveRenderModeValue}: the
 * mode setter (`render-mode-changed`), the wireframe toggle
 * (`wireframe-changed`) and an app-mode switch (`mode-changed` — the viewer
 * re-syncs the applied wireframe in that handler and emits nothing else).
 * Returns the combined unsubscribe.
 */
export function subscribeRenderModeValue(viewer: RVViewer, cb: () => void): () => void {
  const offs = [
    viewer.on('render-mode-changed', cb),
    viewer.on('wireframe-changed', cb),
    viewer.on('mode-changed', cb),
  ];
  return () => { for (const off of offs) off(); };
}

/**
 * Why render-mode changes are refused right now, or null.
 *
 * `isTabLocked('visual')` covers BOTH `lockSettings` and `lockedTabs: ['visual']`;
 * `isSettingsLocked()` alone would miss the second.
 */
export function renderModeLockReason(): string | null {
  return isTabLocked('visual') ? RENDER_MODE_LOCKED : null;
}

/**
 * Switch the render mode. Order (every step is load-bearing, see plan-761 §2.3):
 *
 *  0. Same-mode guard: the mode is already active and no wireframe is applied →
 *     return. The lighting pre-pushes below (`toneMapping`, `shadowEnabled`, …)
 *     trigger a full `recompileMaterials()`; a click on the active segment must
 *     cost nothing.
 *  1. Wireframe off — only the APPLIED wireframe, BEFORE the mode switch (the
 *     per-frame `_suppressWireframeEnvironment` would otherwise remember the
 *     shadows/AO/reflection the mode setter restores and put the wrong state
 *     back later). The latent editor toggle in viewer mode is left alone.
 *  2. Per-mode lighting values pushed BEFORE `viewer.renderMode` so the
 *     manager's `applyLightingMode` does not reset them — ten pushes, 1:1 from
 *     the former `VisualTab.updateMode`, `dirLightEnabled` before `shadowEnabled`.
 *  3. Persist BEFORE the setter: the setter emits `render-mode-changed`, and a
 *     listener that reloads the store must already see the new mode.
 *  4. `viewer.renderMode = mode` (VisualSettingsManager, toon swap, the event).
 *  5. `lightIntensity` last, as before.
 */
export function setRenderMode(viewer: RVViewer, mode: RenderMode): void {
  if (viewer.renderMode === mode && !viewer.wireframeActive) return;
  if (viewer.wireframeActive) viewer.wireframe = false;
  const settings = loadVisualSettings();
  // Always populated: parseModeSettings fills all three modes from MODE_DEFAULTS.
  const ms = settings.modeSettings[mode];
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
  saveVisualSettings({ ...settings, renderMode: mode });
  viewer.renderMode = mode;
  viewer.lightIntensity = ms.lightIntensity;
}
