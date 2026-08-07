// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * RVPump — Process-industry pump component.
 *
 * Drives flow through a connected pipe. `flowRate > 0` means running; 0 means stopped.
 * Carries optional industry-typical instrumentation (suction/discharge pressure,
 * differential head, VFD speed, motor power & current, bearing/motor temperature,
 * vibration ISO 10816, NPSH margin, run hours, fault state).
 * The class owns its tooltip content via `getTooltipData()` and keeps
 * `node.userData._rvPump` in sync for tooltip consumers.
 */

import type { Object3D } from 'three';
import type { ComponentSchema } from './rv-component-registry';
import { applySchema, setComponentInstance, loadSchemaFromSpec } from './rv-component-registry';
import { validateExtras } from './rv-extras-validator';
import { NodeRegistry } from './rv-node-registry';
import { registerTooltipComponent } from './rv-tooltip-component';

interface ComponentRefRaw {
  path?: string;
  type?: string;
}

/** Pump operating state — drives the status dot color in the tooltip. */
export type PumpState = 'ok' | 'warning' | 'fault';

export class RVPump {
  static readonly type = 'Pump';
  static readonly tooltipType = 'pump';
  static readonly displayName = 'Pump';

  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Pump');

  readonly node: Object3D;

  flowRate = 0;
  pipePath: string | null = null;
  circuitId = -1;
  resourceName = '';
  state: PumpState = 'ok';
  suctionPressure = 0;
  dischargePressure = 0;
  speedRpm = 0;
  speedPercent = 0;
  powerKw = 0;
  currentA = 0;
  bearingTempC = 0;
  motorTempC = 0;
  vibrationMmS = 0;
  npshAvailable = 0;
  npshRequired = 0;
  runHours = 0;

  constructor(node: Object3D, extras: Record<string, unknown>) {
    this.node = node;
    validateExtras(RVPump.type, extras);
    applySchema(this as unknown as Record<string, unknown>, RVPump.schema, extras);
    const ref = (this as unknown as { pipe?: ComponentRefRaw | null }).pipe;
    this.pipePath = ref?.path ?? null;
    // Defensive: schema can hold any string; clamp to known states.
    if (this.state !== 'ok' && this.state !== 'warning' && this.state !== 'fault') {
      this.state = 'ok';
    }

    setComponentInstance(node, this);
    node.userData._rvType = 'Pump';
    this.syncUserData();
  }

  /** Plugin API: start the pump at the given rate (l/min). */
  start(rate: number): void {
    this.flowRate = Math.abs(rate);
    this.syncUserData();
  }

  /** Plugin API: stop the pump. */
  stop(): void {
    this.flowRate = 0;
    this.syncUserData();
  }

  /** Plugin API: set operational state (ok / warning / fault). */
  setState(state: PumpState): void {
    this.state = state;
    this.syncUserData();
  }

  /** Plugin API: set the medium currently flowing through this pump. Used by
   *  ProcessIndustryPlugin to keep all members of a fluid circuit (tanks +
   *  pipes + pumps) in sync, including for color-mode tinting. */
  setResource(name: string): void {
    this.resourceName = name;
    this.syncUserData();
  }

  get isRunning(): boolean {
    return this.flowRate > 0;
  }

  /** Differential head across the pump (discharge − suction). */
  get differentialPressure(): number {
    return this.dischargePressure - this.suctionPressure;
  }

  /** NPSH margin. Positive = safe; <= 0 indicates cavitation risk. Returns null
   *  when neither value has been provided so the tooltip can hide the row. */
  get npshMargin(): number | null {
    if (this.npshAvailable === 0 && this.npshRequired === 0) return null;
    return this.npshAvailable - this.npshRequired;
  }

  getTooltipData(): { type: 'pump'; nodePath: string } {
    return { type: 'pump', nodePath: NodeRegistry.computeNodePath(this.node) };
  }

  private syncUserData(): void {
    this.node.userData._rvPump = {
      flowRate: this.flowRate,
      pipePath: this.pipePath,
      circuitId: this.circuitId,
      resourceName: this.resourceName,
      state: this.state,
      suctionPressure: this.suctionPressure,
      dischargePressure: this.dischargePressure,
      differentialPressure: this.differentialPressure,
      speedRpm: this.speedRpm,
      speedPercent: this.speedPercent,
      powerKw: this.powerKw,
      currentA: this.currentA,
      bearingTempC: this.bearingTempC,
      motorTempC: this.motorTempC,
      vibrationMmS: this.vibrationMmS,
      npshAvailable: this.npshAvailable,
      npshRequired: this.npshRequired,
      npshMargin: this.npshMargin,
      runHours: this.runHours,
    };
  }
}

registerTooltipComponent(RVPump, {
  hoverable: true,
  badgeColor: '#7e57c2',
  filterLabel: 'Pumps',
  hoverEnabledByDefault: true,
  hoverPriority: 10,
  pinPriority: 5,
});
