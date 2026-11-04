// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Run-time side of user-defined KPIs (see `des-kpi-defs.ts`): which sources a run of a model
 * tracks, and the tracker that turns their values into the archived {@link KpiTrack}.
 *
 * The tracker is fed from the DES manager's time-advance edge (called BEFORE the events of the
 * new time, so the value read there is the state held since the previous advance). It keeps,
 * per source, the value at warm-up end (statResetTime), the time integral and the maximum over
 * the measured window [statResetTime, end] and the end value — exactly, not at bucket
 * resolution. A warm-up is therefore never part of a KPI.
 */
import type { KpiTrack, KpiTrackValue } from '../sim-controller/des-kpi-defs';
export { setTrackedKpiSources, trackedKpiSources } from '../sim-controller/des-kpi-defs';

/** What a source provider is asked about: the run's model key and its project, when known. */
export interface KpiSourceRequest { readonly model: string; readonly projectId: string | null }
/**
 * Supplies the KPI sources of a model when nothing has published them in this session yet
 * (`trackedKpiSources(model)` undefined). May answer synchronously or later; a late answer is
 * still tracked as long as the warm-up end has not passed.
 */
export type KpiSourceProvider = (request: KpiSourceRequest) => readonly string[] | null | Promise<readonly string[] | null>;
const kpiSourceProviders = new Set<KpiSourceProvider>();
/** Register a source provider; returns the unregister function. Without one nothing is asked. */
export function registerKpiSourceProvider(provider: KpiSourceProvider): () => void {
  kpiSourceProviders.add(provider);
  return () => { kpiSourceProviders.delete(provider); };
}
/** The registered providers in registration order (RunIdentity asks them in turn). */
export function kpiSourceProviderList(): readonly KpiSourceProvider[] { return [...kpiSourceProviders]; }

/**
 * Reader of a value-row source `row:<section>/<rowKey>` over the statistics sections (e.g. a
 * script's `self.statValue`); null for any other key.
 */
export function rowSourceReader(key: string, sections: () => readonly { id: string; rows?: () => readonly { key: string; value?: unknown }[] }[]): KpiSourceReader | null {
  if (!key.startsWith('row:')) return null;
  const slash = key.indexOf('/', 4);
  if (slash < 0) return null;
  const sectionId = key.slice(4, slash), rowKey = key.slice(slash + 1);
  return () => {
    const section = sections().find(s => s.id === sectionId);
    return numericValue(section?.rows?.().find(r => r.key === rowKey)?.value);
  };
}


export type KpiSourceReader = () => number | undefined;
interface Acc { read: KpiSourceReader; warm: number | null; integral: number; max: number | null; last: number | null }

export class KpiTracker {
  private readonly acc = new Map<string, Acc>();
  private prevT: number | null = null;

  constructor(private readonly t0: number) {}

  get size(): number { return this.acc.size; }
  has(key: string): boolean { return this.acc.has(key); }

  /** Add a source; refused (false) once the warm-up end has passed — it could not be measured whole. */
  add(key: string, read: KpiSourceReader, now: number): boolean {
    if (this.acc.has(key)) return true;
    if (now > this.t0) return false;
    this.acc.set(key, { read, warm: null, integral: 0, max: null, last: null });
    return true;
  }

  /** Time-advance edge: the value read now is the state held over [prevT, t). */
  advance(t: number): void {
    const prev = this.prevT;
    for (const a of this.acc.values()) {
      const v = safeRead(a.read);
      if (v === undefined) continue;
      if (prev !== null && t > this.t0) {
        const from = Math.max(prev, this.t0);
        if (t > from) a.integral += v * (t - from);
        a.max = a.max === null ? v : Math.max(a.max, v);
      }
      if (a.warm === null && t >= this.t0) a.warm = v;
      a.last = v;
    }
    this.prevT = t;
  }

  /** Close the window at `t1` (the archived sim time); undefined when nothing is tracked. */
  finish(t1: number): KpiTrack | undefined {
    if (!this.acc.size) return undefined;
    this.advance(t1);
    const values: Record<string, KpiTrackValue> = {};
    const span = t1 - this.t0;
    for (const [key, a] of this.acc) {
      const end = safeRead(a.read) ?? a.last;
      if (end === null || end === undefined) continue;
      const measured = span > 0 && a.warm !== null;
      values[key] = {
        warm: measured ? a.warm : null, end,
        mean: measured ? a.integral / span : null,
        max: measured ? Math.max(a.max ?? end, end) : null,
      };
    }
    return { t0: this.t0, t1, values };
  }
}

function safeRead(read: KpiSourceReader): number | undefined {
  try {
    const v = read();
    return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
  } catch { return undefined; }
}

/** Numeric value of a field: numbers as is, booleans as 0 / 1. */
export function numericValue(v: unknown): number | undefined {
  if (typeof v === 'boolean') return v ? 1 : 0;
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}
