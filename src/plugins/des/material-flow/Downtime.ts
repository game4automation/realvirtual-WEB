// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Downtime.ts -- `defineMaterialFlow` for the failure/repair cycle (Plan 194 P5).
 *
 * Implements the MTBF/MTTR failure cycle via the unified
 * `des` hooks. `kind:'downtime'`. Downtime has NO material throughput and NO
 * continuous counterpart, so the `continuous` block is INERT — Downtime is
 * DES-ONLY. It schedules its own Failure/Repair events; the `onGenerate` hook
 * (fired by the runner for sources, and explicitly for downtime below) kicks the
 * first failure.
 *
 * Timing is FIXED by default: the first failure comes exactly MTBF after the
 * start, every repair takes exactly MTTR and the next failure follows exactly
 * MTBF after the repair. With `Stochastic` on (plan-2051) all three delays are
 * drawn from an exponential distribution with mean MTBF / MTTR from the
 * component's seeded RNG (`self.rng`: master seed + entity id) — reproducible
 * per seed, different across seeds, clamped to >= 0.001 s. PRIVATE — a
 * DES-only wrapper importing only the PUBLIC material-flow types.
 */

import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../../core/material-flow/define-material-flow';
import type {
  MaterialFlowSelf,
} from '../../../core/material-flow/material-flow-self';
import { DES } from '../rv-des-api';
import { MaterialFlowAdapter } from '../material-flow-adapter';
import { exponential } from '../../../core/rv-rng-distribution';

interface DowntimeLocal {
  mtbf: number;
  mttr: number;
  enabled: boolean;
  stochastic: boolean;
  failureCount: number;
  totalDowntime: number;
  targetComponentPath: string;
  target: MaterialFlowAdapter | null;
}

type DowntimeSelf = MaterialFlowSelf<DowntimeLocal>;

function num(self: DowntimeSelf, key: string, def: number): number {
  const v = self.prop[key];
  return typeof v === 'number' ? v : def;
}
function bool(self: DowntimeSelf, key: string, def: boolean): boolean {
  const v = self.prop[key];
  return typeof v === 'boolean' ? v : def;
}

/**
 * Delay (s) of the next failure (`mean` = MTBF) or repair (`mean` = MTTR): the
 * fixed mean by default; with `Stochastic` an exponential draw from the seeded
 * `self.rng` (null only outside DES — then the fixed mean as well).
 */
function delay(self: DowntimeSelf, mean: number, purpose: string): number {
  const rng = self.local.stochastic ? self.rngFor(purpose) : null;
  return rng ? exponential(rng, mean) : mean;
}

export const Downtime: MaterialFlowDefinition<DowntimeSelf> = defineMaterialFlow<DowntimeSelf>({
  type: 'Downtime',
  kind: 'downtime',
  models: ['*Downtime*'],
  schema: {
    MTBF: { type: 'number', default: 3600 },
    MTTR: { type: 'number', default: 300 },
    Enabled: { type: 'boolean', default: true },
    TargetComponentPath: { type: 'string', default: '' },
    // plan-2051: draw MTBF/MTTR exponentially from the seeded RNG instead of the fixed values.
    Stochastic: { type: 'boolean', default: false },
  },

  setup(self: DowntimeSelf): void {
    self.local.mtbf = num(self, 'MTBF', 3600);
    self.local.mttr = num(self, 'MTTR', 300);
    if (!Number.isFinite(self.local.mtbf) || self.local.mtbf <= 0) {
      throw new Error('Downtime: MTBF must be greater than zero');
    }
    if (!Number.isFinite(self.local.mttr) || self.local.mttr <= 0) {
      throw new Error('Downtime: MTTR must be greater than zero');
    }
    const targetPath = self.prop.TargetComponentPath;
    if (typeof targetPath !== 'string' || targetPath.trim() === '') {
      throw new Error('Downtime: TargetComponentPath must be a non-empty string');
    }
    self.local.targetComponentPath = targetPath.trim();
    self.local.target = null;
    self.local.enabled = bool(self, 'Enabled', true);
    self.local.stochastic = bool(self, 'Stochastic', false);
    self.local.failureCount = 0;
    self.local.totalDowntime = 0;
    self.prop['failureCount'] = 0;
    self.prop['totalDowntimeSeconds'] = 0;
  },

  // ── ADAPTER continuous: INERT (Downtime is DES-only) ──
  continuous: {},

  // ── ADAPTER des: schedule failure ↔ repair cycle ──
  des: {
    onRestore(self: DowntimeSelf): void {
      // These counters are persisted in prop. Rebuild their live mirrors:
      // same-world restore otherwise keeps future counts, fresh restore keeps zero.
      self.local.failureCount = num(self, 'failureCount', 0);
      self.local.totalDowntime = num(self, 'totalDowntimeSeconds', 0);
      const target = DES.getManager()?.getComponentByPath(self.local.targetComponentPath);
      self.local.target = target instanceof MaterialFlowAdapter ? target : null;
    },
    // Runner fires onGenerate for sources; the model-load wiring also fires it
    // for downtime to start the cycle.
    onGenerate(self: DowntimeSelf): void {
      if (!self.local.enabled) return;
      const target = DES.getManager()?.getComponentByPath(self.local.targetComponentPath);
      if (!(target instanceof MaterialFlowAdapter)) {
        throw new Error(
          `Downtime: TargetComponentPath '${self.local.targetComponentPath}' did not resolve to a runner adapter`,
        );
      }
      self.local.target = target;
      self.prop.targetResolvedPath = target.path;
      self.in(delay(self, self.local.mtbf, 'downtime:mtbf'), 'ProcessComplete', null); // ProcessComplete = "failure occurs"
      self.setState('Empty');
    },
    // ProcessComplete = failure event → enter Failure, schedule repair.
    onProcessComplete(self: DowntimeSelf): void {
      self.local.failureCount++;
      self.prop['failureCount'] = self.local.failureCount;
      self.prop['failureStartTime'] = self.now;
      self.local.target?.setFailure(true);
      self.setState('Failure');
      self.in(delay(self, self.local.mttr, 'downtime:mttr'), 'AutoRelease', null); // AutoRelease = "repair done"
    },
    // AutoRelease = repair event → clear Failure, track downtime, reschedule.
    onAutoRelease(self: DowntimeSelf): void {
      const start = (self.prop['failureStartTime'] as number) ?? self.now;
      self.local.totalDowntime += Math.max(0, self.now - start);
      self.prop['totalDowntimeSeconds'] = self.local.totalDowntime;
      self.local.target?.setFailure(false);
      self.setState('Empty');
      if (self.local.enabled) self.in(delay(self, self.local.mtbf, 'downtime:mtbf'), 'ProcessComplete', null);
    },
  },
});

export default Downtime;
