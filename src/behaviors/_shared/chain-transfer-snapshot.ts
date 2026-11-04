// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { BehaviourSnapshotContext } from '../../core/material-flow/define-material-flow';
import { validateTransitState } from './transit-snapshot-validation';

import type { ChainTransferLocal, ChainTransferSelf } from '../ChainTransfer';

// Only these queues change in DES; selfRunState already owns FSM name and lastStat.
export const chainTransferRunState = ['blockedMUs', 'transitMUs'] as const;
// Live continuous-mode actuator services are recreated by setup, never serialized.
export const chainTransferServices = ['zBelt', 'lift'] as const;
// Model nodes and the transit-timing.ts timer closure (speed, length, entryPos,
// exitPos) are derived geometry, rebuilt by setup and protected by the fingerprint.
export const chainTransferDerived = ['zNode', 'xNode', 'liftNode', 'sensorNode', 'timer'] as const;
// Continuous-only FSM/topology/countdowns are reset/rebuilt by setup; vectors are
// temporary geometry workspaces. None of these fields is advanced by DES hooks.
export const chainTransferScratch = [
  'sensorOccupied', 'partCount', 'state', 'clearTimer', 'refreshTimer',
  'connections', 'branchSnapId', 'forwardGoesToBranch', 'selectedInputId',
  'inAxis', 'outAxis', '_xDir', '_v', '_pos', '_center',
] as const;

type MuRef = { id: number; gen: number };
type SavedMU = { muRef: MuRef };
type Transit = SavedMU;
interface ChainTransferState { blockedMUs: SavedMU[]; transitMUs: Transit[] }

export function captureChainTransfer(local: ChainTransferLocal, mus: ChainTransferSelf['mus']): ChainTransferState {
  return {
    blockedMUs: local.blockedMUs.map(mu => ({ muRef: { id: mu.id, gen: integer(mu.generation) } })),
    transitMUs: [...local.transitMUs.keys()].map(id => {
      const mu = mus.find(mu => mu.id === id);
      if (!mu) throw new Error(`Unknown ChainTransfer transit MU ${id}`);
      return { muRef: { id, gen: integer(mu.generation) } };
    }),
  };
}

function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid ChainTransfer snapshot record');
  return value as Record<string, unknown>;
}
function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new Error('Invalid ChainTransfer snapshot integer');
  return value;
}
export function validateChainTransfer(state: unknown, ctx?: BehaviourSnapshotContext): void {
  const saved = record(state);
  validateTransitState(saved.blockedMUs, saved.transitMUs, 'ChainTransfer', ctx);
}
export function restoreChainTransfer(self: ChainTransferSelf, state: unknown): void {
  validateChainTransfer(state);
  const saved = record(state);
  if (!Array.isArray(saved.blockedMUs) || !Array.isArray(saved.transitMUs)) throw new Error('Invalid ChainTransfer snapshot arrays');
  const resolve = (value: unknown) => {
    const ref = record(record(value).muRef);
    const id = integer(ref.id), gen = integer(ref.gen);
    const mu = self.mus.find(mu => mu.id === id && mu.generation === gen);
    if (!mu) throw new Error(`Unknown ChainTransfer MU ${id}:${gen}`);
    return mu;
  };
  // Validate and resolve everything before replacing either live queue.
  const blocked = saved.blockedMUs.map(resolve);
  // The handle is bookkeeping only; membership is state. New events carry their own IDs.
  // Restore uses the sentinel handle -1.
  const transit = saved.transitMUs.map(value => [resolve(value).id, -1] as const);
  self.local.blockedMUs = blocked;
  self.local.transitMUs = new Map(transit);
}
