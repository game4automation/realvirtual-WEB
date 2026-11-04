// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Station.ts -- `defineMaterialFlow` for the processing Station (Plan 194 P5).
 *
 * Implements station timing (hold for a processing time,
 * then transfer downstream) via the unified `des` hooks. There is no clean
 * continuous Station behaviour today, so the `continuous` block is INERT and the
 * Station is DES-ONLY — it does nothing in the continuous (Realtime) runner.
 *
 * PRIVATE — placed alongside the DES engine because it is a DES-only wrapper. It
 * imports only the PUBLIC `defineMaterialFlow`/`self` types (no private DES
 * class), so it carries no private dependency itself.
 */

import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../../core/material-flow/define-material-flow';
import type {
  MaterialFlowSelf,
  MU,
} from '../../../core/material-flow/material-flow-self';

interface StationLocal {
  /** Resolved processing time (seconds) for the next MU. */
  processingTime: number;
}

type StationSelf = MaterialFlowSelf<StationLocal>;

/** Read a numeric config from `self.prop` with a default. */
function num(self: StationSelf, key: string, def: number): number {
  const v = self.prop[key];
  return typeof v === 'number' ? v : def;
}

export const Station: MaterialFlowDefinition<StationSelf> = defineMaterialFlow<StationSelf>({
  type: 'Station',
  kind: 'station',
  models: ['*Station*'],
  schema: {
    ProcessingTime: { type: 'number', default: 5.0 },
    MaxCapacity: { type: 'number', default: 1 },
  },

  // Shared init: stamp default prop fields so DES hooks never read undefined.
  setup(self: StationSelf): void {
    self.local.processingTime = num(self, 'ProcessingTime', 5.0);
  },

  // ── GETEILT: routing decision (mode-agnostic) ──
  logic: {
    /** Processing time for an MU (hook-overridable; ≥ 0.001 guard like C#-DES). */
    processingTimeFor(self: StationSelf): number {
      const t = self.local.processingTime;
      return t <= 0 ? 0 : Math.max(0.001, t);
    },
  },

  // ── ADAPTER continuous: INERT (no continuous Station behaviour) ──
  continuous: {
    // Intentionally empty — Station is DES-only. In the Realtime runner it does
    // not participate (documented above). No fixedUpdate, no setup side effects.
  },

  // ── ADAPTER des: hold for processing time, then transfer downstream ──
  des: {
    onAccept(self: StationSelf, mu: MU): boolean {
      self.setState('Working');
      const raw = self.local.processingTime;
      const t = raw <= 0 ? 0 : Math.max(0.001, raw);
      if (t === 0) {
        // Skip processing — transfer immediately.
        self.transfer(mu);
      } else {
        self.in(t, 'ProcessComplete', mu);
      }
      return true;
    },
    onProcessComplete(self: StationSelf, mu: MU): void {
      self.transfer(mu);
      if (self.currentLoad <= 1) self.setState('Empty');
    },
  },
});

export default Station;
