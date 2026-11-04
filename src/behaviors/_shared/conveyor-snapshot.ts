// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { BehaviourSnapshotContext } from '../../core/material-flow/define-material-flow';
import { validateTransitState } from './transit-snapshot-validation';

import type { ConveyorLocal, ConveyorSelf } from '../Conveyor';
// Queue membership affects release and utilization; handles are bookkeeping only.
export const conveyorRunState = ['blockedMUs', 'transitMUs', 'partAtSensor', 'partCount'] as const;
// Handles/subscription are binding services, recreated by setup.
export const conveyorServices = ['beltHandle', 'interlock', 'runWakeSubscribed'] as const;
// Model geometry and timer are fingerprint protected; blockedTarget is the
// first output port, used only for diagnostics and reconstructed on refusal.
// runWasOn is resynchronized from the restored Flow.Run signal by onRestore.
export const conveyorDerived = ['belt', 'sensor', 'timer', 'blockedTarget', 'runWasOn'] as const;
// Sensor/count also change on DES arrival and are captured above.
// waking only guards synchronous re-entrancy, never spans DES events.
export const conveyorScratch = ['waking'] as const;

type MuRef = { id: number; gen: number };
type SavedMU = { muRef: MuRef };
type Transit = SavedMU;
interface ConveyorState { partAtSensor: boolean; partCount: number; blocked: SavedMU[]; transit: Transit[] }

export function captureConveyor(local: ConveyorLocal, mus: ConveyorSelf['mus']): ConveyorState {
  return {
    partAtSensor: local.partAtSensor, partCount: integer(local.partCount),
    blocked: local.blockedMUs.map(mu => ({ muRef: { id: mu.id, gen: integer(mu.generation) } })),
    transit: [...local.transitMUs.keys()].map(id => {
      const mu = mus.find(mu => mu.id === id);
      if (!mu) throw new Error(`Unknown Conveyor transit MU ${id}`);
      return { muRef: { id, gen: integer(mu.generation) } };
    }),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Conveyor snapshot record');
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid Conveyor snapshot integer');
  return value;
}
export function validateConveyor(state: unknown, ctx?: BehaviourSnapshotContext): void {
  const saved = record(state);
  if (typeof saved.partAtSensor !== 'boolean') throw new Error('Invalid Conveyor sensor');
  integer(saved.partCount);
  validateTransitState(saved.blocked, saved.transit, 'Conveyor', ctx);
}
export function restoreConveyor(self: ConveyorSelf, state: unknown): void {
  validateConveyor(state);
  const saved = record(state);
  if (!Array.isArray(saved.blocked) || !Array.isArray(saved.transit)) throw new Error('Invalid Conveyor snapshot arrays');
  if (typeof saved.partAtSensor !== 'boolean') throw new Error('Invalid Conveyor sensor');
  const partCount = integer(saved.partCount);
  const resolve = (value: unknown) => {
    const ref = record(record(value).muRef);
    const id = integer(ref.id), gen = integer(ref.gen);
    const mu = self.mus.find(mu => mu.id === id && mu.generation === gen);
    if (!mu) throw new Error(`Unknown Conveyor MU ${id}:${gen}`);
    return mu;
  };
  // Validate and resolve everything before replacing either live queue.
  const blocked = saved.blocked.map(resolve);
  // The handle is bookkeeping only; membership is state. New events carry their own IDs.
  // Restore uses the sentinel handle -1.
  const transit = saved.transit.map(value => [resolve(value).id, -1] as const);
  self.local.partAtSensor = saved.partAtSensor;
  self.local.partCount = partCount;
  self.local.blockedMUs = blocked;
  self.local.transitMUs = new Map(transit);
}
