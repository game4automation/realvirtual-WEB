// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-265 §9.3 / §9.4 / §9.11 — the batch orchestrator (DesBatchRunner).
 *
 * Driven against a FAKE host so the orchestration contract is verified
 * deterministically: per-replication ordering (params → seed → reset → FF),
 * derived seed sequence, CRN disjoint seed space, auto-seed suppression, the
 * infinite-end-time refusal, cancel (partial → aborted) and quota handling.
 * (The REAL kernel re-config is proven separately in rv-des-batch-reconfig.)
 */

import { describe, it, expect } from 'vitest';
import {
  DesBatchRunner,
  batchSlotSeed,
  CRN_BASE,
  type BatchHost,
  type BatchExperimentSpec,
} from '@rv-private/plugins/des/des-batch-runner';
import { SEED_STRIDE } from '@rv-private/plugins/des/rv-des-experiment-model';

class FakeHost implements BatchHost {
  calls: string[] = [];
  seeds: number[] = [];
  scopes: Array<string | null> = [];
  autoSuppressed = false;   // true only WHILE a batch holds the suppression
  /** Optional per-FF hook (settable after construction) + quota-fail index. */
  onFF: ((i: number) => void) | null = null;
  failQuotaAt: number | null = null;
  scriptFails = false;
  private ffCount = 0;
  constructor(private specs: Map<string, BatchExperimentSpec>) {}

  readSpec(model: string, exp: string): Promise<BatchExperimentSpec | null> {
    return Promise.resolve(this.specs.get(`${model}/${exp}`) ?? null);
  }
  listEnabledExperiments(model: string): Promise<Array<{ model: string; exp: string }>> {
    return Promise.resolve(
      [...this.specs.values()].filter((s) => s.model === model && s.enabled)
        .map((s) => ({ model: s.model, exp: s.exp })),
    );
  }
  applyParams(): void { this.calls.push('applyParams'); }
  applyScript(): Promise<{ ok: boolean; message?: string }> {
    this.calls.push('applyScript');
    return Promise.resolve(this.scriptFails ? { ok: false, message: 'boom' } : { ok: true });
  }
  setSeed(seed: number): void { this.calls.push(`setSeed:${seed}`); this.seeds.push(seed); }
  beginRun(endTime: number): void { this.calls.push(`beginRun:${endTime}`); }
  fastForward(): Promise<boolean> {
    const i = this.ffCount++;
    this.calls.push('ff');
    this.onFF?.(i);
    if (this.failQuotaAt === i) {
      return Promise.reject(new DOMException('quota', 'QuotaExceededError'));
    }
    return Promise.resolve(true);
  }
  setScope(scope: { exp: string } | null): void {
    this.scopes.push(scope ? scope.exp : null);
    this.calls.push(scope ? `scope:${scope.exp}` : 'scope:null');
  }
  suppressAutoSeed(): () => void {
    this.autoSuppressed = true;
    return () => { this.autoSuppressed = false; };
  }
}

function spec(over: Partial<BatchExperimentSpec> & Pick<BatchExperimentSpec, 'exp'>): BatchExperimentSpec {
  return {
    model: 'M', baseSeed: 42, endTime: 100, replicationCount: 1, paramOverrides: [], enabled: true, ...over,
  };
}

describe('DesBatchRunner — seed derivation (9.4)', () => {
  it('per-replication seeds use baseSeed + i*STRIDE; CRN uses a disjoint high base', () => {
    expect(batchSlotSeed(42, 0, false)).toBe(42);
    expect(batchSlotSeed(42, 1, false)).toBe(42 + SEED_STRIDE);
    expect(batchSlotSeed(42, 0, true)).toBe(CRN_BASE);
    expect(batchSlotSeed(42, 2, true)).toBe(CRN_BASE + 2 * SEED_STRIDE);
  });

  it('CRN and non-CRN seed spaces never collide for realistic baseSeeds', () => {
    for (let base = 0; base < 100_000; base += 997) {
      for (let i = 0; i < 50; i++) {
        for (let j = 0; j < 50; j++) {
          expect(batchSlotSeed(base, i, false)).not.toBe(batchSlotSeed(0, j, true));
        }
      }
    }
  });
});

describe('DesBatchRunner — runExperiment (9.3)', () => {
  it('runs N replications with the derived seed sequence in the §2.2 order', async () => {
    const host = new FakeHost(new Map([['M/E', spec({ exp: 'E', replicationCount: 3 })]]));
    const batch = new DesBatchRunner(host);
    await batch.runExperiment('M', 'E', { replications: 3, crn: false });

    expect(host.seeds).toEqual([42, 42 + SEED_STRIDE, 42 + 2 * SEED_STRIDE]);
    // Ordering per replication: applyParams → setSeed → beginRun → ff.
    expect(host.calls.slice(0, 5)).toEqual(['scope:E', 'applyParams', 'setSeed:42', 'beginRun:100', 'ff']);
    // Scope cleared at the end.
    expect(host.calls[host.calls.length - 1]).toBe('scope:null');
    expect(JSON.parse(batch.progressJson()!)).toMatchObject({ exp: 'E', total: 3, phase: 'done' });
    expect(host.autoSuppressed).toBe(false); // restored
  });

  it('the manifest replicationCount is used when no override is given', async () => {
    const host = new FakeHost(new Map([['M/E', spec({ exp: 'E', replicationCount: 2 })]]));
    const batch = new DesBatchRunner(host);
    await batch.runExperiment('M', 'E', { crn: false });
    expect(host.seeds).toHaveLength(2);
  });

  it('CRN seeds the slots from the disjoint base', async () => {
    const host = new FakeHost(new Map([['M/E', spec({ exp: 'E', replicationCount: 2 })]]));
    await new DesBatchRunner(host).runExperiment('M', 'E', { replications: 2, crn: true });
    expect(host.seeds).toEqual([CRN_BASE, CRN_BASE + SEED_STRIDE]);
  });

  it('suppresses the auto-seed roll for the whole batch (determinism guard)', async () => {
    let suppressedDuringFF = false;
    const host = new FakeHost(new Map([['M/E', spec({ exp: 'E', replicationCount: 1 })]]));
    host.onFF = () => { suppressedDuringFF = host.autoSuppressed; };
    await new DesBatchRunner(host).runExperiment('M', 'E', { replications: 1, crn: false });
    expect(suppressedDuringFF).toBe(true);   // forced fixed while running
    expect(host.autoSuppressed).toBe(false); // restored after
  });

  it('refuses an experiment with no finite end time (would hang FastForward)', async () => {
    const host = new FakeHost(new Map([['M/E', spec({ exp: 'E', endTime: 0, replicationCount: 3 })]]));
    await new DesBatchRunner(host).runExperiment('M', 'E', { replications: 3, crn: false });
    expect(host.seeds).toHaveLength(0);
    expect(host.calls).not.toContain('ff');
  });

  it('runs the param script in order (applyParams → applyScript → setSeed → beginRun → ff)', async () => {
    const host = new FakeHost(new Map([['M/E', spec({ exp: 'E', replicationCount: 1, paramScript: "self.setField('n','C','f',1)" })]]));
    await new DesBatchRunner(host).runExperiment('M', 'E', { replications: 1, crn: false });
    expect(host.calls.slice(0, 6)).toEqual(['scope:E', 'applyParams', 'applyScript', 'setSeed:42', 'beginRun:100', 'ff']);
  });

  it('a failing param script aborts the replication (no run for it)', async () => {
    const host = new FakeHost(new Map([['M/E', spec({ exp: 'E', replicationCount: 3, paramScript: 'bad(' })]]));
    host.scriptFails = true;
    const batch = new DesBatchRunner(host);
    await batch.runExperiment('M', 'E', { replications: 3, crn: false });
    expect(host.calls).not.toContain('ff');       // never reached FastForward
    expect(host.seeds).toHaveLength(0);            // aborted before seeding
    expect(JSON.parse(batch.progressJson()!).phase).toBe('aborted');
    expect(host.autoSuppressed).toBe(false);       // finally-restored
  });
});

describe('DesBatchRunner — cancel + quota (9.11)', () => {
  it('cancel mid-batch stops before the next replication and marks aborted', async () => {
    const host = new FakeHost(new Map([['M/E', spec({ exp: 'E', replicationCount: 5 })]]));
    const batch = new DesBatchRunner(host);
    host.onFF = (i) => { if (i === 1) batch.cancel(); };
    await batch.runExperiment('M', 'E', { replications: 5, crn: false });
    expect(host.seeds.length).toBeLessThan(5);        // did not run all
    expect(host.seeds.length).toBeGreaterThanOrEqual(2);
    expect(JSON.parse(batch.progressJson()!).phase).toBe('aborted');
    expect(host.calls[host.calls.length - 1]).toBe('scope:null'); // still cleaned up
    expect(host.autoSuppressed).toBe(false);
  });

  it('a storage-quota error stops the experiment; earlier replications stay done', async () => {
    const host = new FakeHost(new Map([['M/E', spec({ exp: 'E', replicationCount: 5 })]]));
    host.failQuotaAt = 2;
    const batch = new DesBatchRunner(host);
    await batch.runExperiment('M', 'E', { replications: 5, crn: false });
    expect(host.seeds).toHaveLength(3);   // 0,1,2 attempted; quota at 2 stops the loop
    expect(JSON.parse(batch.progressJson()!).phase).toBe('aborted');
    expect(host.autoSuppressed).toBe(false); // finally-restored even on error
  });
});

describe('DesBatchRunner — runAll (F16)', () => {
  it('runs only enabled experiments sequentially', async () => {
    const host = new FakeHost(new Map([
      ['M/A', spec({ exp: 'A', replicationCount: 1, enabled: true })],
      ['M/B', spec({ exp: 'B', replicationCount: 1, enabled: false })],
      ['M/C', spec({ exp: 'C', replicationCount: 1, enabled: true })],
    ]));
    await new DesBatchRunner(host).runAll('M', { crn: false });
    const scopedExps = host.scopes.filter((s): s is string => s !== null);
    expect(scopedExps).toEqual(['A', 'C']); // B skipped (disabled)
  });
});
