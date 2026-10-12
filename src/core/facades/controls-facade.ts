// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ControlsFacadeImpl — OrbitControls property writes for plugins/settings.
 * Phase 4a of plan-182.
 */

import { Vector3 } from 'three';
import type { ControlsFacade } from '../rv-plugin-context';
import type { RVViewer } from '../rv-viewer';

export class ControlsFacadeImpl implements ControlsFacade {
  constructor(private readonly _viewer: RVViewer) {}

  setRotateSpeed(value: number): void {
    const c = this._viewer.controls;
    if (c) c.rotateSpeed = value;
  }

  setPanSpeed(value: number): void {
    const c = this._viewer.controls;
    if (c) c.panSpeed = value;
  }

  setZoomSpeed(value: number): void {
    const c = this._viewer.controls;
    if (c) c.zoomSpeed = value;
  }

  setDampingFactor(value: number): void {
    const c = this._viewer.controls;
    if (c) c.dampingFactor = value;
  }

  setEnabled(enabled: boolean): void {
    const c = this._viewer.controls;
    if (c) c.enabled = enabled;
  }

  setTarget(target: Vector3): void {
    const c = this._viewer.controls;
    if (c) c.target.copy(target);
  }

  setConfig(cfg: Partial<{
    rotateSpeed: number;
    panSpeed: number;
    zoomSpeed: number;
    dampingFactor: number;
    enabled: boolean;
    wheelZoomToCursor: boolean;
    navigateAroundCursorPoint: boolean;
  }>): void {
    const c = this._viewer.controls;
    if (!c) return;
    if (cfg.rotateSpeed   !== undefined) c.rotateSpeed   = cfg.rotateSpeed;
    if (cfg.panSpeed      !== undefined) c.panSpeed      = cfg.panSpeed;
    if (cfg.zoomSpeed     !== undefined) c.zoomSpeed     = cfg.zoomSpeed;
    if (cfg.dampingFactor !== undefined) c.dampingFactor = cfg.dampingFactor;
    if (cfg.enabled       !== undefined) c.enabled       = cfg.enabled;
    const nav = this._viewer.navController;
    if (cfg.wheelZoomToCursor !== undefined && nav) nav.wheelZoomToCursor = cfg.wheelZoomToCursor;
    if (cfg.navigateAroundCursorPoint !== undefined && nav) nav.navigateAroundCursorPoint = cfg.navigateAroundCursorPoint;
  }
}
