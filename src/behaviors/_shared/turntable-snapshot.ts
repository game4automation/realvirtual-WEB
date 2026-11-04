// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { BehaviourSnapshotContext } from '../../core/material-flow/define-material-flow';
import type { Object3D } from 'three';
import type { TurntableLocal } from '../Turntable';

// Rotation timing and lazy calibration affect the next DES move. Preserve both
// routing cursors, including the currently continuous-only input cursor.
export const turntableRunState = ['lastCommandedAngle', 'lastOutputPort', 'lastInputPort', 'beltCalibrated', 'beltNeutralAngle'] as const;
// Actuator handles are recreated during binding.
export const turntableServices = ['drive', 'belt'] as const;
// Geometry/topology comes from the fingerprint-protected model and setup.
export const turntableDerived = ['rotaryNode', 'sensorNode', 'beltNode', 'driveAxis', 'connections'] as const;
// Sensor callbacks and fixedUpdate advance these only in continuous mode.
// DES uses prop.alignedPort/heldMU and scheduled events instead of these timers.
// The vectors are temporary calibration workspaces.
export const turntableScratch = ['selectedInputPort', 'sensorOccupied', 'partCount', 'clearTimer', 'emptyFor', 'refreshTimer', '_dir', '_quat'] as const;

type MuRef = { id: number; gen: number };
type State = Pick<TurntableLocal, typeof turntableRunState[number]> & { ridingMUs?: MuRef[] };

const visualNode = (mu: unknown): Object3D | null =>
  (mu as { visual?: { node?: Object3D; isInstanced?: boolean } } | null)?.visual?.node ?? null;

/**
 * MUs whose visual is parented under the rotary (ride-on: rotary.attach). The MU snapshot stores the node's LOCAL
 * pose, so without this the restored MU keeps rotary-local numbers as scene coordinates and rides off from a wrong
 * point (plan-2059 O2).
 */
export function captureRidingMUs(local: TurntableLocal, mus: ReadonlyArray<{ id: number; generation?: number }>): MuRef[] {
  const rotary = local.rotaryNode;
  if (!rotary) return [];
  // A headless restored rider has no visual yet: its pending parent counts, or a second snapshot would lose it.
  return mus.filter(mu => visualNode(mu)?.parent === rotary
    || (mu as { restoredVisualParent?: Object3D }).restoredVisualParent === rotary).map(mu => ({ id: mu.id, gen: mu.generation ?? 0 }));
}

/** Re-establish the saved parenting of this turntable's MU visuals; `add` keeps the restored local pose. */
export function restoreRidingMUs(local: TurntableLocal, mus: ReadonlyArray<{ id: number; generation?: number }>,
  scene: Object3D | undefined, value: unknown): void {
  const riding = (value as { ridingMUs?: MuRef[] } | null)?.ridingMUs;
  const rotary = local.rotaryNode;
  if (!riding || !rotary) return;
  for (const mu of mus) {
    const node = visualNode(mu);
    const rides = riding.some(r => r.id === mu.id && r.gen === (mu.generation ?? 0));
    // Headless MU: the visual is materialized later; the runner parents it then.
    const pending = mu as { restoredVisualParent?: Object3D };
    if (!node) { if (rides) pending.restoredVisualParent = rotary; else delete pending.restoredVisualParent; continue; }
    if (rides && node.parent !== rotary) rotary.add(node);
    else if (!rides && node.parent === rotary && scene) scene.add(node);
  }
}
export function captureTurntable(local: TurntableLocal, mus: ReadonlyArray<{ id: number; generation?: number }> = []): State {
  return { ridingMUs: captureRidingMUs(local, mus), lastCommandedAngle: local.lastCommandedAngle, lastOutputPort: local.lastOutputPort,
    lastInputPort: local.lastInputPort, beltCalibrated: local.beltCalibrated, beltNeutralAngle: local.beltNeutralAngle };
}
export function validateTurntable(value: unknown, ctx?: BehaviourSnapshotContext): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid Turntable snapshot');
  const s = value as Record<string, unknown>;
  for (const key of ['lastCommandedAngle', 'beltNeutralAngle']) {
    if (typeof s[key] !== 'number' || !Number.isFinite(s[key])) throw new Error('Invalid Turntable angle');
  }
  for (const key of ['lastInputPort', 'lastOutputPort']) {
    if (s[key] !== null && (!Number.isSafeInteger(s[key]) || (s[key] as number) < 0 || (ctx?.portCounts && (s[key] as number) >= ctx.portCounts[key === 'lastInputPort' ? 'inputs' : 'outputs']))) throw new Error('Invalid Turntable port');
  }
  if (typeof s.beltCalibrated !== 'boolean') throw new Error('Invalid Turntable calibration');
  if (s.ridingMUs !== undefined) {
    const list = s.ridingMUs;
    if (!Array.isArray(list) || !list.every(r => r && typeof r === 'object' && Number.isSafeInteger((r as MuRef).id)
      && Number.isSafeInteger((r as MuRef).gen) && (!ctx || ctx.ownsMU((r as MuRef).id, (r as MuRef).gen)))) {
      throw new Error('Invalid Turntable riding MUs');
    }
  }
  if (!ctx) return;
  for (const [key, count] of [['alignedPort', ctx.portCounts?.inputs], ['selectedOutput', ctx.portCounts?.outputs]] as const) {
    const index = ctx.prop?.[key];
    if (index != null && (!Number.isSafeInteger(index) || (index as number) < 0 || (count !== undefined && (index as number) >= count))) throw new Error('Invalid Turntable prop port');
  }
  const check = (action: string, id: number, gen?: number) => {
    // Return rotation is empty. All other RotateComplete branches ride a MU.
    // The clearing Arrival runs after transfer and does not dereference its MU.
    const needsMU = action === 'MF.Turntable.RotateComplete' && ctx.fsmState !== 'returning_in'
      || action === 'MF.Turntable.Arrival' && (ctx.fsmState === 'receiving' || ctx.fsmState === 'discharging');
    if (needsMU && !ctx.ownsMU(id, gen)) throw new Error('Invalid Turntable event MU for saved phase');
  };
  for (const e of ctx.events) {
    if (e.componentId !== ctx.componentId) continue;
    // Dispatch prefers the decoded payload MU to the queue MU.
    const payloadId = (e.data as { muId?: number } | null)?.muId;
    check(e.action, payloadId ?? e.muId);
  }
  for (const e of ctx.frozen) check(e.action, e.muRef?.id ?? -1, e.muRef?.gen);
  // prop.heldMU/heldMUGen is resolved only later, in onDownstreamReady. Check it here,
  // before any mutation: a held MU is an owned reference with a matching generation,
  // it is mandatory in the holding phase and stays set until the hand-off.
  const held = ctx.prop?.heldMU;
  const heldGen = ctx.prop?.heldMUGen;
  if (held == null || held === undefined) {
    if (heldGen != null) throw new Error('Invalid Turntable held MU generation without MU');
    if (ctx.fsmState === 'holding') throw new Error('Turntable holding phase without held MU');
    return;
  }
  if (!Number.isSafeInteger(held) || !Number.isSafeInteger(heldGen)) throw new Error('Invalid Turntable held MU reference');
  if (!ctx.ownsMU(held as number, heldGen as number)) throw new Error('Unknown or unowned Turntable held MU');
}
export function restoreTurntable(local: TurntableLocal, value: unknown): void {
  validateTurntable(value);
  const s = value as Record<string, unknown>;
  Object.assign(local, { lastCommandedAngle: s.lastCommandedAngle, beltNeutralAngle: s.beltNeutralAngle,
    lastInputPort: s.lastInputPort, lastOutputPort: s.lastOutputPort, beltCalibrated: s.beltCalibrated });
}
