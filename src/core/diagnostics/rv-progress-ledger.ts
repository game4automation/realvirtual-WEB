// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { PopulationSource, UnitKind } from './rv-population-sources';
import type { BlockageFinding } from './rv-blockage-probes';

export interface ProgressEntry {
  readonly unitId: string;
  readonly kind: UnitKind;
  readonly instrumentedBy: string;
  count: number;
  lastChangeSec: number;
  firstSeenSec: number;
  state: 'armed' | 'complete' | 'inactive';
}

export interface Coverage {
  expected: number; registered: number; armed: number; complete: number; inactive: number;
  bySource: Readonly<Record<string, number>>;
  missing: readonly string[];
  unknown: readonly string[];
  coverageComplete: boolean;
}

/** Pure simulation-time progress accounting; population is independent of instrumentation. */
export class ProgressLedger {
  /** Last nonempty diagnostic snapshot survives completion until reset. */
  lastFindings: readonly BlockageFinding[] = [];
  private readonly adapters = new Set<{ id: string; sample(): void }>();
  /** Sample-time instrumentation, separate from the independently enumerated population. */
  addAdapter(adapter: { readonly id: string; sample(): void }): () => void {
    this.adapters.add(adapter);
    return () => { this.adapters.delete(adapter); };
  }
  adapterSources(): readonly string[] { return [...this.adapters].map(a => a.id).sort(); }
  unregister(unitId: string): void {
    this.entries.delete(unitId);
    this.reported.delete(unitId);
    this.observed.delete(unitId);
    this.expectedLast.delete(unitId);
  }
  private readonly entries = new Map<string, ProgressEntry>();
  private readonly populations = new Set<PopulationSource>();
  private readonly observed = new Set<string>();
  private readonly reported = new Map<string, boolean>();
  private expectedLast = new Set<string>();

  constructor(private readonly opts: { clock: { now(): number } }) {}

  addPopulation(src: PopulationSource): () => void {
    this.populations.add(src);
    return () => { this.populations.delete(src); };
  }

  register(unitId: string, kind: UnitKind, instrumentedBy: string): void {
    if (this.entries.has(unitId)) return;
    const now = this.opts.clock.now();
    this.entries.set(unitId, { unitId, kind, instrumentedBy, count: 0,
      firstSeenSec: now, lastChangeSec: now, state: 'inactive' });
    this.reported.set(unitId, false);
  }

  arm(unitId: string): void {
    const entry = this.entries.get(unitId);
    if (entry && entry.state !== 'armed') {
      entry.state = 'armed';
      entry.lastChangeSec = this.opts.clock.now();
    }
  }

  complete(unitId: string): void {
    const entry = this.entries.get(unitId);
    if (entry) entry.state = 'complete';
  }

  inactive(unitId: string): void {
    const entry = this.entries.get(unitId);
    if (entry) entry.state = 'inactive';
  }

  bump(unitId: string, _kind: UnitKind, by = 1): void {
    const entry = this.entries.get(unitId);
    if (!entry) { this.observed.add(unitId); return; }
    if (!Number.isFinite(by) || by <= 0) return;
    const next = entry.count + by;
    if (!Number.isFinite(next) || next === entry.count) return;
    entry.count = next;
    this.reported.set(unitId, true);
    entry.lastChangeSec = this.opts.clock.now();
  }

  sample(idleSec: number, now = this.opts.clock.now(), readOnly = false): {
    candidates: readonly Readonly<ProgressEntry>[]; coverage: Coverage;
  } {
    if (!readOnly) for (const adapter of this.adapters) adapter.sample();
    const expected = new Set<string>();
    const bySource: Record<string, number> = Object.create(null);
    for (const source of [...this.populations].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      const ids = new Set(source.expected());
      bySource[source.id] = ids.size;
      for (const id of ids) expected.add(id);
    }
    if (!readOnly) for (const [id, entry] of this.entries) {
      if (!expected.has(id)) {
        if (this.expectedLast.has(id)) this.observed.delete(id);
        else if (this.reported.get(id)) this.observed.add(id);
        entry.state = 'complete';
        this.entries.delete(id);
        this.reported.delete(id);
      }
    }
    const candidates: Readonly<ProgressEntry>[] = [];
    const coverage: Coverage = { expected: expected.size, registered: [...this.entries.keys()].filter(id => expected.has(id)).length,
      armed: 0, complete: 0, inactive: 0, bySource,
      missing: [...expected].filter(id => !this.entries.has(id)).sort(),
      unknown: [...this.observed].filter(id => !expected.has(id)).sort(), coverageComplete: false };
    for (const id of [...this.entries.keys()].sort()) {
      const entry = this.entries.get(id)!;
      if (!expected.has(id)) continue;
      coverage[entry.state]++;
      if (entry.state === 'armed' && now - entry.lastChangeSec >= idleSec) candidates.push({ ...entry });
    }
    coverage.coverageComplete = coverage.missing.length === 0 && coverage.unknown.length === 0;
    if (!readOnly) this.expectedLast = expected;
    return { candidates, coverage };
  }

  entry(unitId: string): Readonly<ProgressEntry> | null {
    const entry = this.entries.get(unitId);
    return entry ? { ...entry } : null;
  }

  snapshotState() {
    return { entries: [...this.entries].map(([id, entry]) => [id, { ...entry }] as const),
      observed: [...this.observed], reported: [...this.reported], expectedLast: [...this.expectedLast],
      lastFindings: this.lastFindings };
  }
  restoreState(state: ReturnType<ProgressLedger['snapshotState']>): void {
    this.entries.clear();
    for (const [id, entry] of state.entries) this.entries.set(id, entry);
    this.observed.clear(); state.observed.forEach(id => this.observed.add(id));
    this.reported.clear(); state.reported.forEach(([id, value]) => this.reported.set(id, value));
    this.expectedLast = new Set(state.expectedLast);
    this.lastFindings = state.lastFindings;
  }

  /** Reset runtime accounting; population subscriptions live until their unsubscribers run. */
  reset(): void {
    this.lastFindings = [];
    this.entries.clear();
    this.observed.clear();
    this.reported.clear();
    this.expectedLast.clear();
  }
}
