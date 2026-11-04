// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { DesFingerprint } from './rv-des-fingerprint';
import type { PersistableQueueEvent } from './rv-des-action-schema';
import type { SnapshotPart } from './rv-snapshot-registry';

/** Full DES capture envelope; display metadata is ignored during restore. */
export interface DESSnapshotV4 {
  /** Display-only; never applied during restore. */
  statisticsCurrent?: Record<string, import('./rv-des-statistics').DESComponentStatsSnapshot>;
  version: 4;
  fingerprint: DesFingerprint;
  simTime: number;
  /** Render clock at capture (>= simTime; animated mode runs it ahead of the last event). Absent = simTime. */
  renderClock?: number;
  nextEventId: number;
  eventQueue: PersistableQueueEvent[];
  muIds: number[];
  parts: SnapshotPart[];
}

/** Envelope shape only. Numeric ranges, schemas and references require preflight. */
export function isV4Envelope(raw: unknown): raw is DESSnapshotV4 {
  const object = (v: unknown): v is Record<string, unknown> =>
    v !== null && typeof v === 'object' && !Array.isArray(v);
  if (!object(raw) || raw.version !== 4 || !object(raw.fingerprint)) return false;
  const f = raw.fingerprint;
  return f.schemaVersion === 4 && typeof f.rngVersion === 'number' && typeof f.modelHash === 'string'
    && Array.isArray(f.components) && f.components.every(c => object(c)
      && typeof c.id === 'string' && typeof c.type === 'string')
    && typeof raw.simTime === 'number' && typeof raw.nextEventId === 'number'
    && Array.isArray(raw.muIds) && raw.muIds.every(id => typeof id === 'number')
    && Array.isArray(raw.eventQueue) && raw.eventQueue.every(e => object(e)
      && typeof e.id === 'number' && typeof e.time === 'number' && typeof e.action === 'string'
      && (e.componentId === null || typeof e.componentId === 'string')
      && typeof e.muId === 'number' && typeof e.priority === 'number')
    && Array.isArray(raw.parts) && raw.parts.every(p => object(p)
      && typeof p.key === 'string' && typeof p.version === 'number' && Object.hasOwn(p, 'state'));
}
