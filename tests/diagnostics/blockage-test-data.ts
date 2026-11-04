// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { ProgressEntry } from '../../src/core/diagnostics/rv-progress-ledger';
import type { WaitEdge } from '../../src/core/diagnostics/rv-wait-registry';
export const candidate = (unitId: string, lastChangeSec = 0): ProgressEntry => ({ unitId,
  lastChangeSec, firstSeenSec: 0, count: 0, state: 'armed', kind: 'vehicle', instrumentedBy: 'test' });
export const edge = (waiterId: string, resourceId: string, ownerIds: string[], extra: Partial<WaitEdge> = {}): WaitEdge => ({
  waiterId, resourceId, ownerIds, kind: 'zone-holder', sinceSimSec: 1, analysed: true, ...extra,
});
