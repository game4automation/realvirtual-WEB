// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';
import type { DESComponentSnapshot } from '../../src/plugins/des/rv-des-component';
import type { DESMUSnapshot } from '../../src/plugins/des/rv-des-mu';
import type { DESManager } from '../../src/plugins/des/rv-des-manager';
import type { ReservationRecord } from '../../src/core/material-flow/material-flow-self';
import type { TweenDataSnapshot } from '../../src/core/material-flow/tween-registry';

export function partState<T>(snapshot: DESSnapshotV4, key: string): T {
  const part = snapshot.parts.find(p => p.key === key);
  if (!part) throw new Error(`Missing snapshot part: ${key}`);
  return part.state as T;
}
export function componentState(snapshot: DESSnapshotV4, name: string): DESComponentSnapshot & { frozen?: Array<{ remaining: number; tween?: { pathRef?: string }; tweens?: unknown[] }> } {
  const id = snapshot.fingerprint.components.find(c => c.id === name || c.id.startsWith(name + '@') || c.id.startsWith('#' + name + '@'))?.id;
  if (!id) throw new Error(`Missing component: ${name}`);
  return partState(snapshot, id);
}
export const muRecords = (s: DESSnapshotV4) => partState<{ records: DESMUSnapshot[] }>(s, 'des.mus').records;
export const managerState = (s: DESSnapshotV4) => partState<ReturnType<DESManager['exportRunState']>>(s, 'des.manager');
export const reservations = (s: DESSnapshotV4) => partState<{ records: ReservationRecord[] }>(s, 'des.reservations').records;
export const tweenState = (s: DESSnapshotV4) => partState<TweenDataSnapshot[]>(s, 'des.tweens');
export function storedSnapshot(simTime: number, payload: import('../../src/plugins/des/rv-snapshot-contract').SnapshotJson = null): DESSnapshotV4 {
  return { version: 4, simTime, nextEventId: 0, muIds: [], eventQueue: [],
    fingerprint: { schemaVersion: 4, rngVersion: 1, modelHash: 'test', runConfigHash: 'run', components: [] },
    parts: [{ key: 'test.payload', version: 1, state: payload }] };
}
