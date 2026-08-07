// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * slot-descriptors.ts — declares the BINDABLE standard-signal slots per
 * component type for the Planner Signal Linking feature.
 *
 * Each Planner component (Drive_Simple, Drive_Cylinder, Sensor, Conveyor, …)
 * exposes a fixed set of standard signals. A {@link SignalSlotDescriptor}
 * names one such slot, its value type, its default PLC direction, and optional
 * aliases used by the auto-matcher. The signal-bind picker and auto-matcher
 * read these descriptors to know what a placed element offers for binding.
 *
 * The slot name is the GENERIC name (e.g. `Flow.Run`, `Forward`). The binding
 * manager resolves the instance-scoped store name per placed component via
 * `instanceScope()` / `scopeSignalName()`.
 */

import type { SignalLinkDirection } from '../layout-planner/rv-layout-store';

export interface SignalSlotDescriptor {
  /** Generic slot name as registered (instance-scoped) in the SignalStore. */
  slot: string;
  /** Value type of the slot signal. */
  type: 'bool' | 'float' | 'int';
  /** Default PLC direction — plcInput = written by viewer, plcOutput = read. */
  direction: SignalLinkDirection;
  /** Alternative names / tokens for auto-matching (lowercased). */
  aliases?: string[];
  /**
   * Human-readable name shown in the UI (plan-341 Phase 4). The `slot` field
   * above stays the IDENTITY — persisted mappings, SlotIds, row keys and
   * auto-matcher tokens all use it verbatim. Omit to display the raw name.
   * Resolve through `slotDisplayLabel()`, never read this field directly.
   */
  label?: string;
}

/**
 * Bindable slots per component type.
 *
 * Keys are the rv_extras component-type names that appear in a placed node's
 * `userData.realvirtual`. A placed component may carry several of these types
 * (e.g. a node with both `Drive` and `Drive_Simple`); the descriptors of every
 * matching type are merged for that element.
 */
export const SLOT_DESCRIPTORS: Record<string, SignalSlotDescriptor[]> = {
  Drive_Simple: [
    { slot: 'Forward', type: 'bool', direction: 'plcOutput', aliases: ['fwd', 'jogforward', 'run', 'start'] },
    { slot: 'Backward', type: 'bool', direction: 'plcOutput', aliases: ['bwd', 'jogbackward', 'reverse'] },
  ],
  Drive_Cylinder: [
    { slot: 'Out', type: 'bool', direction: 'plcOutput', aliases: ['extend', 'advance'] },
    { slot: 'In', type: 'bool', direction: 'plcOutput', aliases: ['retract', 'home'] },
  ],
  // Position-controlled motor (plan-232). Command slots are written into the
  // drive (plcInput); feedback slots are read out of it (plcOutput).
  Drive_DestinationMotor: [
    { slot: 'Destination', type: 'float', direction: 'plcOutput', aliases: ['target', 'targetposition', 'setpoint', 'position'] },
    { slot: 'StartDrive', type: 'bool', direction: 'plcOutput', aliases: ['start', 'execute', 'go', 'move'] },
    { slot: 'TargetSpeed', type: 'float', direction: 'plcOutput', aliases: ['speed', 'velocity', 'maxspeed'] },
    { slot: 'Acceleration', type: 'float', direction: 'plcOutput', aliases: ['accel', 'acc'] },
    { slot: 'IsAtPosition', type: 'float', direction: 'plcInput', aliases: ['actualposition', 'currentposition', 'position'] },
    { slot: 'IsAtSpeed', type: 'float', direction: 'plcInput', aliases: ['actualspeed', 'currentspeed'] },
    { slot: 'IsAtDestination', type: 'bool', direction: 'plcInput', aliases: ['attarget', 'intargetposition', 'done', 'inposition'] },
    { slot: 'IsDriving', type: 'bool', direction: 'plcInput', aliases: ['moving', 'running', 'busy'] },
  ],
  Drive_FollowPosition: [
    { slot: 'Position', type: 'float', direction: 'plcOutput', aliases: ['position', 'setpoint', 'target', 'targetposition', 'joint', 'axis', 'jointposition'] },
    { slot: 'CurrentPosition', type: 'float', direction: 'plcInput', aliases: ['actualposition', 'currentposition', 'feedback', 'istposition'] },
  ],
  Sensor: [
    { slot: 'SensorOccupied', type: 'bool', direction: 'plcInput', aliases: ['occupied', 'presence', 'sensoroccupied', 'detected'] },
    { slot: 'SensorNotOccupied', type: 'bool', direction: 'plcInput', aliases: ['notoccupied', 'clear', 'free', 'sensornotoccupied'] },
  ],
  // Conveyor publishes the type-neutral material-flow `Flow.*` contract.
  Conveyor: [
    { slot: 'Flow.Run', type: 'bool', direction: 'plcOutput', aliases: ['run', 'start', 'motorrun', 'enable'] },
    { slot: 'Flow.Occupied', type: 'bool', direction: 'plcInput', aliases: ['occupied', 'partpresent'] },
    { slot: 'Flow.Running', type: 'bool', direction: 'plcInput', aliases: ['running', 'moving'] },
    { slot: 'Flow.PartCount', type: 'int', direction: 'plcInput', aliases: ['partcount', 'count'] },
  ],
};

/**
 * All bindable slot descriptors offered by a placed component, given the
 * rv_extras component-type names present on (or under) its root node.
 *
 * De-duplicated by slot name (first descriptor wins) so a node that carries
 * overlapping types does not produce duplicate slot rows.
 */
export function slotsForTypes(types: readonly string[]): SignalSlotDescriptor[] {
  const out: SignalSlotDescriptor[] = [];
  const seen = new Set<string>();
  for (const t of types) {
    const descs = SLOT_DESCRIPTORS[t];
    if (!descs) continue;
    for (const d of descs) {
      if (seen.has(d.slot)) continue;
      seen.add(d.slot);
      out.push(d);
    }
  }
  return out;
}
