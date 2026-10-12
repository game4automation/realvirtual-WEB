// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { OrthographicCamera, PerspectiveCamera } from 'three';
import type { RibbonManager } from './rv-ribbon-manager';
import { disposeArcGizmoMaterials } from './rv-arc-gizmo';

const DEBOUNCE_MS = 120;
const MAX_WAIT_MS = 400;

export interface RibbonEditorPreviewHost {
  readonly ribbonManager: RibbonManager;
  readonly activeMode: string | null;
  readonly camera?: PerspectiveCamera | OrthographicCamera;
  markRenderDirty(): void;
  markShadowsDirty(): void;
}

/** Coordinates side-effect-free ribbon definition previews in editor mode. */
export class RibbonEditorPreview {
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _maxTimer: ReturnType<typeof setTimeout> | null = null;
  private _signature = '';
  private _exportDepth = 0;

  constructor(private readonly _host: RibbonEditorPreviewHost) {}

  notifyDefinitionChanged(structural = false): void {
    if (this._host.activeMode !== 'editor') return;
    if (this._timer) clearTimeout(this._timer);
    this._timer = setTimeout(() => this._flush(structural), DEBOUNCE_MS);
    if (!this._maxTimer) this._maxTimer = setTimeout(() => this._flush(structural), MAX_WAIT_MS);
  }

  onRender(_dt: number): void {
    if (this._host.activeMode !== 'editor') return;
    const signature = this._makeSignature();
    if (signature === this._signature) return;
    this._solve(false, signature);
  }

  onModeChanged(event: { from: string | null; to: string }): void {
    if (event.to === 'editor') {
      this._signature = '';
      this.onRender(0);
    } else if (event.from === 'editor') this._deactivate();
  }

  onModelCleared(): void {
    this._deactivate();
    this._signature = '';
  }

  beginExportPass(): void {
    this._exportDepth++;
    this._setOverlays(false);
  }

  endExportPass(): void {
    if (this._exportDepth > 0) this._exportDepth--;
    if (this._exportDepth === 0 && this._host.activeMode === 'editor') this._setOverlays(true);
  }

  dispose(): void {
    this._deactivate();
  }

  private _flush(structural: boolean): void {
    this._cancelTimers();
    const signature = this._makeSignature();
    if (signature !== this._signature) this._solve(structural, signature);
  }

  private _solve(structural: boolean, signature: string): void {
    this._host.ribbonManager.solvePreview(structural);
    this._signature = signature;
    if (this._exportDepth === 0) this._setOverlays(true);
    this._host.markRenderDirty();
    this._host.markShadowsDirty();
  }

  private _makeSignature(): string {
    const values: string[] = [];
    for (const path of this._host.ribbonManager.paths) {
      path.node.updateWorldMatrix(true, false);
      values.push(path.node.uuid, ...path.node.matrixWorld.elements.map(String),
        String(path.Rollers.length), String(path.RibbonWidthMm), String(path.FullWidthMm),
        String(path.TextureLengthMm));
      for (const roller of path.rollers) {
        const config = roller as unknown as { RibbonSide?: string; RadiusMm?: number };
        roller.node.updateWorldMatrix(true, false);
        values.push(...roller.node.matrixWorld.elements.map(String));
        const p = roller.node.position;
        values.push(roller.node.uuid, String(p.x), String(p.y), String(p.z),
          config.RibbonSide ?? '', String(config.RadiusMm ?? roller.radiusMm));
        const dancer = roller as unknown as { TravelMinMm?: number; TravelMaxMm?: number; HomeMm?: number; Strands?: number };
        values.push(String(dancer.TravelMinMm ?? ''), String(dancer.TravelMaxMm ?? ''),
          String(dancer.HomeMm ?? ''), String(dancer.Strands ?? ''));
      }
    }
    return values.join('|');
  }

  private _setOverlays(active: boolean): void {
    for (const path of this._host.ribbonManager.paths) path.setEditorBandPreview(active);
  }

  private _deactivate(): void {
    this._cancelTimers();
    this._setOverlays(false);
    disposeArcGizmoMaterials();
  }

  private _cancelTimers(): void {
    if (this._timer) clearTimeout(this._timer);
    if (this._maxTimer) clearTimeout(this._maxTimer);
    this._timer = null;
    this._maxTimer = null;
  }
}
