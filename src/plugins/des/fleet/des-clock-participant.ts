// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import type { Snapshottable } from '../rv-snapshot-registry';
import type { SnapshotJson } from '../rv-snapshot-contract';
import type { DesSimClock } from './des-sim-clock';

function validate(json: SnapshotJson): readonly string[] {
  return json !== null && typeof json === 'object' && !Array.isArray(json)
    && Object.keys(json).length === 1 && Number.isSafeInteger(json.generation)
    && Number(json.generation) >= 1 ? [] : ['expected {generation: safe integer >= 1}'];
}

export function fleetClockParticipant(clock: DesSimClock): Snapshottable {
  return {
    key: 'fleet.clock', version: 1, owner: clock, stateKeys: ['_generation'],
    services: ['runner', 'onRestart', 'live', 'offLifecycle', 'ended', 'disposed', 'restoredState', 'actions'],
    capture: () => clock.exportState(), validate,
    prepare: json => {
      const errors = validate(json);
      if (errors.length) throw new Error(`fleet.clock: ${errors.join('; ')}`);
      return (json as { generation: number }).generation;
    },
    commit: prepared => clock.restoreGeneration(prepared as number),
  };
}
