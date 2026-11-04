// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Storage.ts -- `defineMaterialFlow` for the buffer/warehouse (Plan 194 P5, K4).
 *
 * Implements FIFO/LIFO/Priority buffering via the
 * unified `des` hooks. `kind:'storage'` ensures the unified architecture does
 * NOT silently ignore storage (Plan 194 K4). No clean continuous Storage
 * behaviour exists, so the `continuous` block is INERT — Storage is DES-ONLY.
 *
 * The retrieval strategy lives in the shared `logic` (mode-agnostic decision);
 * the `des` hooks express the timing/handshake. PRIVATE — DES-only wrapper,
 * imports only the PUBLIC material-flow types.
 */

import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../../core/material-flow/define-material-flow';
import type {
  MaterialFlowSelf,
  MU,
} from '../../../core/material-flow/material-flow-self';

type StorageStrategy = 'FIFO' | 'LIFO' | 'Priority';

interface StorageLocal {
  discharging: boolean;
  again: boolean;
  strategy: StorageStrategy;
  autoRelease: boolean;
  autoReleaseDelay: number;
}

type StorageSelf = MaterialFlowSelf<StorageLocal>;

function str(self: StorageSelf, key: string, def: string): string {
  const v = self.prop[key];
  return typeof v === 'string' ? v : def;
}
function num(self: StorageSelf, key: string, def: number): number {
  const v = self.prop[key];
  return typeof v === 'number' ? v : def;
}
function bool(self: StorageSelf, key: string, def: boolean): boolean {
  const v = self.prop[key];
  return typeof v === 'boolean' ? v : def;
}

function tryDischarge(self: StorageSelf): void {
  // A reservation batch is tentative until commit wakes this target.
  if (self.reservedLoad > 0) return;
  if (self.local.discharging) {
    self.local.again = true;
    return;
  }
  self.local.discharging = true;
  try {
    do {
      self.local.again = false;
      let mu: MU | null;
      while ((mu = Storage.logic!.retrieve(self) as MU | null)) {
        if (self.transfer(mu) !== 'moved') return;
      }
    } while (self.local.again);
  } finally {
    self.local.discharging = false;
    if (self.mus.length === 0) self.setState('Empty');
  }
}

export const Storage: MaterialFlowDefinition<StorageSelf> = defineMaterialFlow<StorageSelf>({
  type: 'Storage',
  kind: 'storage',
  models: ['*Storage*'],
  schema: {
    MaxCapacity: { type: 'number', default: 10 },
    Strategy: { type: 'string', default: 'FIFO' },
    // false: releases as soon as the successor can accept (plan-2006 E8);
    // true: minimum dwell time AutoReleaseDelay per MU.
    AutoRelease: { type: 'boolean', default: false },
    AutoReleaseDelay: { type: 'number', default: 0 },
  },

  setup(self: StorageSelf): void {
    self.local.discharging = false;
    self.local.again = false;
    const s = str(self, 'Strategy', 'FIFO');
    self.local.strategy = (s === 'LIFO' || s === 'Priority') ? s : 'FIFO';
    self.local.autoRelease = bool(self, 'AutoRelease', false);
    self.local.autoReleaseDelay = num(self, 'AutoReleaseDelay', 0);
  },

  // ── GETEILT: retrieval strategy (mode-agnostic decision) ──
  logic: {
    /** Pick the next MU to leave per the configured strategy. */
    retrieve(self: StorageSelf): MU | null {
      let best: MU | null = null;
      const mus = self.mus;
      for (let i = 0; i < mus.length; i++) {
        const mu = mus[i];
        if (mu.isBlocked || mu.inTransfer ||
          ((mu.prop?.__storageReleaseAt as number) ?? 0) > self.now) continue;
        if (!best || self.local.strategy === 'LIFO' ||
          (self.local.strategy === 'Priority' &&
            ((mu.prop?.priority as number) ?? 0) > ((best.prop?.priority as number) ?? 0))) best = mu;
        if (self.local.strategy === 'FIFO') break;
      }
      return best;
    },
  },

  // ── ADAPTER continuous: INERT (Storage is DES-only) ──
  continuous: {},

  // ── ADAPTER des: buffer on accept, release on downstream-ready / auto ──
  des: {
    onAccept(self: StorageSelf, mu: MU): boolean {
      const delay = self.local.autoRelease ? Math.max(0, self.local.autoReleaseDelay) : 0;
      mu.prop!.__storageReleaseAt = self.now + delay;
      self.setState('Working');
      if (self.local.autoRelease) {
        self.in(delay, 'AutoRelease', mu);
      }
      tryDischarge(self);
      return true;
    },
    onAutoRelease(self: StorageSelf, _mu: MU): void {
      tryDischarge(self);
    },
    onDownstreamReady(self: StorageSelf): void {
      tryDischarge(self);
    },
  },
});

export default Storage;
