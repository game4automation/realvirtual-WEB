// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Plain executor data; reading status never advances the simulation. */
export interface VehicleStatusInput {
  jobKind?: string | null;
  leg: string;
  overLimit?: boolean;
  reportedKind?: string | null;
  speed?: number;
  phase?: string;
  soc?: number;
}
export interface VehicleStatusFlags {
  free: boolean;
  orderActive: boolean;
  busy: boolean;
  handling: boolean;
  charging: boolean;
  fault: boolean;
  moving: boolean;
  faultCode?: number;
  soc?: number;
}

/** Stable codes; append new wait kinds without renumbering existing ones. */
export const WAIT_FAULT_CODES: Readonly<Record<string, number>> = {
  fork: 1, exit: 2, target: 3, charge: 4, standstill: 5,
};
export const WAIT_FAULT_REASONS: Readonly<Record<number, string>> = {
  1: 'fork-wait-timeout', 2: 'exit-timeout', 3: 'target-wait-timeout',
  4: 'charge-wait-timeout', 5: 'standstill-timeout',
};

/** Flags can overlap; display rank is fault > charging > handling > busy > free. */
export function deriveVehicleStatus(input: VehicleStatusInput, out = {} as VehicleStatusFlags): VehicleStatusFlags {
  const busy = input.jobKind === 'pick' || input.jobKind === 'retrieve' || input.jobKind === 'charge';
  const fault = input.overLimit === true || !!input.reportedKind;
  out.free = !busy && !fault;
  out.orderActive = out.busy = busy;
  out.handling = input.leg === 'atFrom' || input.leg === 'atTo';
  out.charging = input.leg === 'charging';
  out.fault = fault;
  out.faultCode = input.reportedKind ? WAIT_FAULT_CODES[input.reportedKind] ?? 0 : 0;
  out.moving = input.speed !== undefined ? input.speed > 1e-3 : input.phase === 'driving' || input.phase === 'cruising';
  out.soc = input.soc;
  return out;
}
