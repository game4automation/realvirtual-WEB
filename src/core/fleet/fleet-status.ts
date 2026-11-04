// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { AgvFleet, AgvSignalStatus } from '../engine/rv-agv-fleet';

export const VEHICLE_STATUS_SIGNALS = {
  free: 'Status.Free', busy: 'Status.Busy', handling: 'Status.Handling',
  charging: 'Status.Charging', fault: 'Status.Fault', moving: 'Status.Moving',
  faultCode: 'Status.FaultCode', soc: 'Status.Soc',
} as const;

/** Shared with the executor's pure status derivation. */
export { WAIT_FAULT_REASONS as FAULT_CODE_REASONS } from './exec/vehicle-status';
import { WAIT_FAULT_REASONS as FAULT_CODE_REASONS } from './exec/vehicle-status';

export interface SignalReader { get(name: string): boolean | number | undefined }
export interface VehicleStatus {
  id: string;
  state: 'free' | 'order' | 'handling' | 'charging' | 'fault' | 'idle';
  faultReason: string | null;
  job: string | null;
  position: { node: string | null; leg: string | null };
  waitingOn: string | null;
  battery: { soc: number } | null;
  moving: boolean | null;
  fromSignals: boolean;
}

const scratch: AgvSignalStatus = { run: false, moving: false, blocked: false, speed: 0 };

/** Read only registered vehicles; status signals never create fleet members. */
export function readFleetStatus(fleet: AgvFleet, signals: SignalReader): VehicleStatus[] {
  return fleet.all().sort((a, b) => a.id < b.id ? -1 : a.id === b.id ? 0 : 1).map(handle => {
    const read = (key: keyof typeof VEHICLE_STATUS_SIGNALS) => signals.get(`${handle.id}.${VEHICLE_STATUS_SIGNALS[key]}`);
    const fromSignals = read('fault') !== undefined;
    const state: VehicleStatus['state'] = fromSignals
      ? read('fault') ? 'fault' : read('charging') ? 'charging' : read('handling') ? 'handling'
        : read('busy') ? 'order' : read('free') ? 'free' : 'idle'
      : handle.phase === 'servicing' ? 'handling' : handle.phase === 'idle' ? 'idle' : 'order';
    const code = read('faultCode');
    const soc = read('soc');
    scratch.blocked = false;
    handle.signalStatus?.(scratch);
    return {
      id: handle.id, state,
      faultReason: state === 'fault' ? (typeof code === 'number' ? FAULT_CODE_REASONS[code] : undefined) ?? 'fault' : null,
      job: handle.task?.destination ?? null,
      position: { node: handle.node?.name ?? null, leg: handle.startPathId ?? null },
      waitingOn: scratch.blocked ? 'blocked' : null,
      battery: fromSignals && typeof soc === 'number' ? { soc } : null,
      moving: fromSignals ? Boolean(read('moving')) : handle.phase == null ? null
        : handle.phase === 'driving' || handle.phase === 'cruising',
      fromSignals,
    };
  });
}
