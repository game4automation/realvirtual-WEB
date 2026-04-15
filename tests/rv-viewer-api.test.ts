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
import cameraManagerSrc from '../src/core/rv-camera-manager.ts?raw';
import visualSettingsSrc from '../src/core/rv-visual-settings-manager.ts?raw';

// ─── Exports ────────────────────────────────────────────────────────────

describe('rv-viewer exports', () => {
  it('exports RVViewer class', () => {
    expect(viewerSrc).toContain('export class RVViewer');
  });

  it('exports ViewerEvents interface', () => {
    expect(viewerSrc).toContain('export interface ViewerEvents');
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
    expect(viewerSrc).toContain('use(plugin: RVViewerPlugin)');
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

  it('CameraManager has applyViewportOffset', () => {
    expect(cameraManagerSrc).toContain('applyViewportOffset(');
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

describe('ViewerEvents type map', () => {
  const events = [
    'model-loaded', 'model-cleared', 'drive-hover', 'drive-focus',
    'connection-state-changed', 'sensor-changed', 'mu-spawned', 'mu-consumed',
    'object-hover', 'object-unhover', 'object-click',
    'xr-session-start', 'xr-session-end',
    'fpv-enter', 'fpv-exit',
    'context-menu-request',
    'selection-changed',
  ];

  for (const event of events) {
    it(`includes '${event}' event`, () => {
      expect(viewerSrc).toContain(`'${event}'`);
    });
  }

  it('uses void for parameterless XR events', () => {
    expect(viewerSrc).toMatch(/'xr-session-start':\s*void/);
    expect(viewerSrc).toMatch(/'xr-session-end':\s*void/);
  });

  it('uses void for parameterless FPV events', () => {
    expect(viewerSrc).toMatch(/'fpv-enter':\s*void/);
    expect(viewerSrc).toMatch(/'fpv-exit':\s*void/);
  });
});
