// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { BehaviourSnapshotContext } from '../../core/material-flow/define-material-flow';
// Same name scheme as des-hook-adapter mfActionName; not imported because behaviours are
// startup code and must not value-import the DES body (des-public-boundary).
const mfActionName = (type: string, suffix: string): string => `MF.${type}.${suffix}`;

type SavedMU = { muRef: { id: number; gen: number } };
type Transit = SavedMU;

/** Shared shape/reference/uniqueness checks; no live services or mutations. */
export function validateTransitState(
  blocked: unknown, transit: unknown, type: string, ctx?: BehaviourSnapshotContext,
): asserts transit is Transit[] {
  const fail = (): never => { throw new Error(`Invalid ${type} snapshot transit/blocked state`); };
  const record = (v: unknown): Record<string, unknown> => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return fail();
    return v as Record<string, unknown>;
  };
  const integer = (v: unknown): number => {
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < 0) return fail();
    return v;
  };
  if (!Array.isArray(blocked) || !Array.isArray(transit)) return fail();
  const seen = new Set<number>();
  const ref = (v: unknown): number => {
    const r = record(record(v).muRef);
    const id = integer(r.id), gen = integer(r.gen);
    if (seen.has(id)) return fail();
    seen.add(id);
    if (ctx && !ctx.ownsMU(id, gen)) throw new Error(`Unknown or unowned ${type} MU ${id}:${gen}`);
    return id;
  };
  blocked.forEach(ref);
  const action = mfActionName(type, 'Arrival');
  const members = new Map<number, number>();
  for (const v of transit) {
    const id = ref(v);
    members.set(id, integer(record(record(v).muRef).gen));
  }
  if (!ctx) return;
  const anchored = new Set<number>();
  const anchor = (id: number, gen?: number) => {
    if (!members.has(id) || anchored.has(id)
      || (gen !== undefined && members.get(id) !== gen)) return fail();
    anchored.add(id);
  };
  for (const e of ctx.events) {
    if (e.componentId !== ctx.componentId || e.action !== action) continue;
    // The hook dispatcher prefers a payload MU over the event MU: a conflicting
    // payload would process a different MU than the validated transit member.
    const payloadMu = (e.data as { muId?: unknown } | null | undefined)?.muId;
    if (payloadMu !== undefined && payloadMu !== e.muId) return fail();
    anchor(e.muId);
  }
  for (const e of ctx.frozen) {
    if (e.action !== action) continue;
    if (!e.muRef) return fail();
    anchor(integer(e.muRef.id), integer(e.muRef.gen));
  }
  if (anchored.size !== members.size) return fail();
}
