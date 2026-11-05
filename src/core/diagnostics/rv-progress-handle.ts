// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Per-unit push handle for the {@link ProgressLedger} (plan-2241a Anhang P3, fix 2).
 *
 * A pushing instrumentation (e.g. the DES component lifecycle) holds one handle per unit and
 * writes its row directly - no string lookup per push. The handle is bound to ONE ledger for
 * its whole life (a replaced ledger gets new handles) and is valid for the ledger generation it
 * was claimed in: `reset`, `restoreState`, `unregister` and the removal in `sample` bump the
 * generation, so a handle never writes into a dropped or replaced row. `reported` is set only on
 * its false -> true transition. Domain-free core API: it knows units and kinds, nothing of DES.
 *
 * Kept out of rv-progress-ledger.ts on purpose: the ledger is on the eager startup path, its
 * only push user (the DES runner) is not.
 */

import type { ProgressEntry, ProgressLedger } from './rv-progress-ledger';
import type { UnitKind } from './rv-population-sources';

export class ProgressHandle {
  /** @internal */ gen = -1;
  /** @internal */ entry: ProgressEntry | null = null;
  /** @internal */ reported = false;
  constructor(readonly ledger: ProgressLedger, readonly unitId: string,
    readonly kind: UnitKind, readonly instrumentedBy: string) {}
}

/** Ensures the row; no lookup while the generation holds. True when the unit had to be
 * (re-)registered, i.e. the caller seeds it. */
export function claimProgress(h: ProgressHandle): boolean {
  const l = h.ledger;
  if (h.gen === l._gen) return false;
  const fresh = l.register(h.unitId, h.kind, h.instrumentedBy);
  h.entry = l._row(h.unitId) ?? null;
  h.reported = l._reported(h.unitId, false);
  h.gen = l._gen;
  return fresh;
}

/** The row, or null for an unclaimed / stale handle (the id path then decides, like `bump`). */
function live(h: ProgressHandle): ProgressEntry | null {
  return h.gen === h.ledger._gen ? h.entry : null;
}

/** Same effect as `ledger.arm(unitId, atSec)`. */
export function pushArm(h: ProgressHandle, atSec: number): void {
  const e = live(h);
  if (!e) { h.ledger.arm(h.unitId, atSec); return; }
  if (e.state !== 'armed') { e.state = 'armed'; e.lastChangeSec = atSec; }
}

/** Same effect as `ledger.inactive(unitId)`. */
export function pushInactive(h: ProgressHandle): void {
  const e = live(h);
  if (e) e.state = 'inactive'; else h.ledger.inactive(h.unitId);
}

/** Same effect as `ledger.bump(unitId, kind, by, atSec)`. */
export function pushBump(h: ProgressHandle, by = 1, atSec?: number): void {
  const e = live(h);
  if (!e || atSec === undefined) { h.ledger.bump(h.unitId, h.kind, by, atSec); return; }
  if (!Number.isFinite(by) || by <= 0) return;
  const next = e.count + by;
  if (!Number.isFinite(next) || next === e.count) return;
  e.count = next;
  if (!h.reported) h.reported = h.ledger._reported(h.unitId, true);
  e.lastChangeSec = atSec;
}
