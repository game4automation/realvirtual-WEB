// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVProcessingUnit — Process-industry processing unit (reactor / mixer / filter
 * / column / kettle, etc.). Acts as a fluid barrier in the pipe network and
 * carries Overall Equipment Effectiveness (OEE) telemetry for the tooltip.
 *
 * OEE = Availability × Performance × Quality (each 0..1).
 * The class owns its tooltip content via `getTooltipData()` and keeps
 * `node.userData._rvProcessingUnit` in sync for legacy consumers.
 */

import type { Object3D } from 'three';
import type { ComponentSchema } from './rv-component-registry';
import { applySchema, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';
import { validateExtras } from './rv-extras-validator';
import { NodeRegistry } from './rv-node-registry';
import { registerTooltipComponent } from './rv-tooltip-component';

/** Operational state for the unit — drives the status dot in the tooltip. */
export type ProcessingUnitState = 'running' | 'idle' | 'down' | 'setup' | 'maintenance';

interface ComponentRefRaw {
  path?: string;
  type?: string;
}

export class RVProcessingUnit {
  static readonly type = 'ProcessingUnit';
  static readonly tooltipType = 'processing-unit';
  static readonly displayName = 'ProcessingUnit';

  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('ProcessingUnit');

  readonly node: Object3D;

  connectionPaths: string[] = [];
  state: ProcessingUnitState = 'idle';
  availability = 0;
  performance = 0;
  quality = 0;
  cycleTimeS = 0;
  cycleTargetS = 0;
  throughputPerHour = 0;
  goodCount = 0;
  scrapCount = 0;
  mtbfHours = 0;
  mttrMinutes = 0;
  runHours = 0;
  downHours = 0;
  lastFault = '';

  constructor(node: Object3D, extras: Record<string, unknown>) {
    this.node = node;
    validateExtras(RVProcessingUnit.type, extras);
    applySchema(this as unknown as Record<string, unknown>, RVProcessingUnit.schema, extras);

    const conns = (this as unknown as { connections?: ComponentRefRaw[] | null }).connections;
    this.connectionPaths = Array.isArray(conns)
      ? conns.map(r => r?.path ?? '').filter((p): p is string => p.length > 0)
      : [];

    if (
      this.state !== 'running' && this.state !== 'idle' &&
      this.state !== 'down'    && this.state !== 'setup' &&
      this.state !== 'maintenance'
    ) {
      this.state = 'idle';
    }

    setComponentInstance(node, this);
    node.userData._rvType = 'ProcessingUnit';
    this.syncUserData();
  }

  /** Plugin API: set operational state. */
  setState(state: ProcessingUnitState): void {
    this.state = state;
    this.syncUserData();
  }

  /** Plugin API: update OEE component values (each clamped to 0..1). */
  setOee(availability: number, performance: number, quality: number): void {
    this.availability = clamp01(availability);
    this.performance = clamp01(performance);
    this.quality = clamp01(quality);
    this.syncUserData();
  }

  /** Plugin API: set production counters. */
  setCounts(good: number, scrap: number): void {
    this.goodCount = Math.max(0, good);
    this.scrapCount = Math.max(0, scrap);
    this.syncUserData();
  }

  /** Plugin API: record the latest cycle (current actual seconds). */
  setCycleTime(seconds: number): void {
    this.cycleTimeS = Math.max(0, seconds);
    this.syncUserData();
  }

  /** Derived OEE % = A × P × Q × 100 (0..100). */
  get oeePercent(): number {
    return this.availability * this.performance * this.quality * 100;
  }

  /** Total units produced shift-to-date (good + scrap). */
  get totalCount(): number {
    return this.goodCount + this.scrapCount;
  }

  getTooltipData(): { type: 'processing-unit'; nodePath: string } {
    return { type: 'processing-unit', nodePath: NodeRegistry.computeNodePath(this.node) };
  }

  private syncUserData(): void {
    this.node.userData._rvProcessingUnit = {
      connectionPaths: this.connectionPaths,
      state: this.state,
      availability: this.availability,
      performance: this.performance,
      quality: this.quality,
      oeePercent: this.oeePercent,
      cycleTimeS: this.cycleTimeS,
      cycleTargetS: this.cycleTargetS,
      throughputPerHour: this.throughputPerHour,
      goodCount: this.goodCount,
      scrapCount: this.scrapCount,
      totalCount: this.totalCount,
      mtbfHours: this.mtbfHours,
      mttrMinutes: this.mttrMinutes,
      runHours: this.runHours,
      downHours: this.downHours,
      lastFault: this.lastFault,
    };
  }
}

function clamp01(v: number): number {
  if (!Number.isFinite(v)) return 0;
  return Math.max(0, Math.min(1, v));
}

registerTooltipComponent(RVProcessingUnit, {
  hoverable: true,
  badgeColor: '#ff8a65',
  filterLabel: 'Processing Units',
  hoverEnabledByDefault: true,
  hoverPriority: 10,
  pinPriority: 5,
});
