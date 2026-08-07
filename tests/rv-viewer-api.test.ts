// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-viewer-api.test.ts — Public API spot-check for rv-viewer.ts
 *
 * Phase 8 of Plan 125: Verifies that key exports and public surface remain
 * stable after internal decomposition (CameraManager, VisualSettingsManager).
 *
 * These tests use ?raw source imports so they don't need a real WebGL context.
 */
import { describe, it, expect } from 'vitest';
import viewerSrc from '../src/core/rv-viewer.ts?raw';
import eventsSrc from '../src/core/rv-viewer-events.ts?raw';
import cameraManagerSrc from '../src/core/rv-camera-manager.ts?raw';
import visualSettingsSrc from '../src/core/rv-visual-settings-manager.ts?raw';

// ─── Exports ────────────────────────────────────────────────────────────

describe('rv-viewer exports', () => {
  it('exports RVViewer class', () => {
    expect(viewerSrc).toContain('export class RVViewer');
  });

  it('re-exports ViewerEvents (extracted to rv-viewer-events.ts, plan-182 Phase 1)', () => {
    // The interface was extracted to rv-viewer-events.ts; rv-viewer.ts now re-exports it.
    expect(viewerSrc).toMatch(/export\s+type\s*\{\s*ViewerEvents[^}]*\}\s*from\s+['"]\.\/rv-viewer-events['"]/);
  });

  it('exports RVViewerOptions interface', () => {
    expect(viewerSrc).toContain('export interface RVViewerOptions');
  });

  it('exports callPlugin function', () => {
    expect(viewerSrc).toContain('export function callPlugin');
  });

  it('re-exports ViewportOffset from CameraManager', () => {
    expect(viewerSrc).toContain("export type { ViewportOffset } from './rv-camera-manager'");
  });
});

// ─── Public API surface ─────────────────────────────────────────────────

describe('RVViewer public API surface', () => {
  it('has static create factory', () => {
    expect(viewerSrc).toContain('static async create(');
  });

  it('exposes scene, renderer, controls, loop readonly fields', () => {
    expect(viewerSrc).toContain('readonly scene: Scene');
    expect(viewerSrc).toContain('readonly renderer: Renderer');
    expect(viewerSrc).toContain('readonly controls: OrbitControls');
    expect(viewerSrc).toContain('readonly loop: SimulationLoop');
  });

  it('has camera getter', () => {
    expect(viewerSrc).toContain('get camera()');
  });

  it('has connectionState getter and setter', () => {
    expect(viewerSrc).toContain('get connectionState()');
    expect(viewerSrc).toContain('setConnectionState(');
  });

  it('has use() for plugin registration', () => {
    expect(viewerSrc).toContain('use(plugin: RVViewerPlugin, origin?: PluginOrigin)');
  });

  it('has getPlugin()', () => {
    expect(viewerSrc).toContain('getPlugin<');
  });

  it('has loadModel / clearModel / reloadModel', () => {
    expect(viewerSrc).toContain('async loadModel(');
    expect(viewerSrc).toContain('clearModel()');
    expect(viewerSrc).toContain('async reloadModel()');
  });

  it('has dispose()', () => {
    expect(viewerSrc).toContain('dispose()');
  });

  it('has filterDrives / filterNodes', () => {
    expect(viewerSrc).toContain('filterDrives(');
    expect(viewerSrc).toContain('filterNodes(');
  });

  it('has highlightByPath / clearHighlight', () => {
    expect(viewerSrc).toContain('highlightByPath(');
    expect(viewerSrc).toContain('clearHighlight()');
  });

  it('has markRenderDirty / markShadowsDirty', () => {
    expect(viewerSrc).toContain('markRenderDirty()');
    expect(viewerSrc).toContain('markShadowsDirty()');
  });

  it('has selectionManager, uiRegistry, leftPanelManager, contextMenu', () => {
    expect(viewerSrc).toContain('readonly uiRegistry');
    expect(viewerSrc).toContain('readonly leftPanelManager');
    expect(viewerSrc).toContain('readonly selectionManager');
    expect(viewerSrc).toContain('readonly contextMenu');
  });
});

// ─── Delegation to extracted managers ───────────────────────────────────

describe('CameraManager delegation', () => {
  it('CameraManager exists as separate module', () => {
    expect(cameraManagerSrc).toContain('export class CameraManager');
  });

  it('CameraManager has animateCameraTo', () => {
    expect(cameraManagerSrc).toContain('animateCameraTo(');
  });

  it('RVViewer frames selections with panel-aware distance (pivot stays on bbox center)', () => {
    // Panel compensation pulls the camera back symmetrically instead of shifting
    // the orbit target, so the rotation pivot always sits on the bounding-box
    // center. (Replaces the former CameraManager.applyViewportOffset, which
    // shifted the orbit target laterally and moved the pivot off-center.)
    expect(viewerSrc).toContain('_panelFitScale(');
  });

  it('CameraManager has cancelCameraAnimation', () => {
    expect(cameraManagerSrc).toContain('cancelCameraAnimation(');
  });

  it('RVViewer delegates to CameraManager', () => {
    expect(viewerSrc).toContain('_cameraManager');
  });
});

describe('VisualSettingsManager delegation', () => {
  it('VisualSettingsManager exists as separate module', () => {
    expect(visualSettingsSrc).toContain('export class VisualSettingsManager');
  });

  it('VisualSettingsManager manages lighting mode', () => {
    expect(visualSettingsSrc).toContain('applyLightingMode(');
  });

  it('VisualSettingsManager has recompileMaterials', () => {
    expect(visualSettingsSrc).toContain('recompileMaterials(');
  });

  it('RVViewer delegates to VisualSettingsManager', () => {
    expect(viewerSrc).toContain('_visualSettings');
  });
});

// ─── ViewerEvents type map ──────────────────────────────────────────────
// Events are now declared in rv-viewer-events.ts (plan-182 Phase 1).
// Tests check eventsSrc (the extracted module) rather than viewerSrc.

describe('ViewerEvents type map', () => {
  const events = [
    'model-loaded', 'model-cleared',
    'connection-state-changed',
    'component-event',
    'object-hover', 'object-unhover', 'object-click',
    'object-focus', 'object-blur',
    'xr-session-start', 'xr-session-end',
    'fpv-enter', 'fpv-exit',
    'context-menu-request',
    'selection-changed',
  ];

  for (const event of events) {
    it(`includes '${event}' event`, () => {
      expect(eventsSrc).toContain(`'${event}'`);
    });
  }

  it('uses void for parameterless XR events', () => {
    expect(eventsSrc).toMatch(/'xr-session-start':\s*void/);
    expect(eventsSrc).toMatch(/'xr-session-end':\s*void/);
  });

  it('uses void for parameterless FPV events', () => {
    expect(eventsSrc).toMatch(/'fpv-enter':\s*void/);
    expect(eventsSrc).toMatch(/'fpv-exit':\s*void/);
  });
});

// ─── Ground / checker-floor sizing ──────────────────────────────────────
// Locks in the floor-resize wiring so the disc never reverts to the previous
// "frozen at load size" behavior (floor looked too small on empty / planner
// scenes). See _updateGroundPlane / _fitGroundToContent in rv-viewer.ts.

describe('checker floor sizing', () => {
  it('has a single _updateGroundPlane sizing helper', () => {
    expect(viewerSrc).toContain('_updateGroundPlane(center: Vector3, fullExtent: number)');
  });

  it('defines an authoring minimum floor extent', () => {
    expect(viewerSrc).toContain('MIN_AUTHORING_GROUND_EXTENT');
  });

  it('loadEmptyScene resets the floor to the playground size', () => {
    // loadEmptyScene must call the sizing helper (clearModel alone leaves the
    // ground frozen at the previous model's size).
    expect(viewerSrc).toMatch(/loadEmptyScene[\s\S]*?_updateGroundPlane\(\s*new Vector3\(0, 0, 0\),\s*MIN_AUTHORING_GROUND_EXTENT\s*\)/);
  });

  it('grows the floor on layout placement / drag (coalesced)', () => {
    expect(viewerSrc).toContain("this.on('layout-transform-update', () => this._queueGroundFit())");
    expect(viewerSrc).toContain("this.on('layout-drag-end', () => this._queueGroundFit())");
    expect(viewerSrc).toContain('requestAnimationFrame(');
  });

  it('floor fit is grow-only (never shrinks on edits)', () => {
    expect(viewerSrc).toMatch(/_fitGroundToContent[\s\S]*?desiredGroundSize <= currentGroundSize \* 1\.001[\s\S]*?return/);
  });

  it('floor fit clamps to the authoring minimum', () => {
    expect(viewerSrc).toMatch(/_fitGroundToContent[\s\S]*?Math\.max\(size\.x, size\.z, MIN_AUTHORING_GROUND_EXTENT\)/);
  });
});
