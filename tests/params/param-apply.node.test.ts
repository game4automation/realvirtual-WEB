// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2013 test 9.1 — the parameter apply transaction (Phase 1 spike).
 *
 * A fake viewer with the REAL `structuralEdit` semantics (every `resetSimulation()` inside
 * is withheld and flushed ONCE at the close), a fake registry of addressable nodes and a
 * fake "yard" whose structural field `Size` rebuilds module nodes `#m1..#mN` from a
 * template (`Rate = 1`). Covers atomic admission, dependent addresses, order, exactly one
 * reset on success and failure paths, the lock, the lease, validators after the rebuild,
 * rollback (structure first, then every previous value by address), `unset`, document
 * change, the full-target-state round trip 3 → 2 → 3 (Gate R2 #2) and the lazy adapter of
 * the old planning registry through the same hull.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  createParamApplyService,
  isParamApplyBusy,
  registerParamRebuild,
  registerParamValidator,
  type FieldOp,
  type ParamApplyViewer,
  type ParamFieldEnv,
} from '../../src/core/params/rv-param-apply';
import { acquireRunLease } from '../../src/core/hmi/rv-run-lease';
import { createPlanningRegistry } from '../../src/core/planning/rv-planning-registry';
import { createStructuralResetRunner } from '../../src/plugins/planning-parameters/structural-reset';

// ─── Fakes ─────────────────────────────────────────────────────────────────

interface FakeNode { name: string; userData: Record<string, unknown> }

function node(name: string, rv: Record<string, unknown>): FakeNode {
  return { name, userData: { realvirtual: rv } };
}

function makeWorld() {
  const nodes = new Map<string, FakeNode>();
  const log: string[] = [];
  let depth = 0;
  let resetOwed = false;
  const viewer = {
    isSimulationPaused: false,
    resets: 0,
    reconfigures: 0,
    setSimulationPaused(_r: string, p: boolean) { if (!p) return; },
    resetSimulation() {
      if (depth > 0) { resetOwed = true; return; }
      viewer.resets++;
      log.push('reset');
    },
    async structuralEdit<T>(fn: () => Promise<T> | T): Promise<T> {
      depth++;
      try { return await fn(); } finally {
        depth--;
        if (depth === 0 && resetOwed) { resetOwed = false; viewer.resets++; log.push('reset'); }
      }
    },
    simulationKernel: {
      mode: 'continuous',
      desControl: () => ({ reconfigureFromExtras: () => { viewer.reconfigures++; log.push('reconfigure'); } }),
    },
    registry: {
      getNodeByAddress: (id: string, occ = '') => (nodes.get(`${occ}#${id}`) ?? null) as never,
    },
  };
  return { nodes, log, viewer };
}

const env: ParamFieldEnv = {
  fieldInfo(component, field) {
    const t: Record<string, Record<string, { type: string; readonly?: boolean; signal?: string; refType?: string; enum?: string[] }>> = {
      Yard: { Size: { type: 'integer' } },
      Module: { Rate: { type: 'number' }, Mode: { type: 'enum', enum: ['a', 'b'] } },
      Src: { Interval: { type: 'number' }, Ro: { type: 'number', readonly: true }, Sig: { type: 'boolean', signal: 'in' }, Ref: { type: 'string', refType: 'Drive' }, Name: { type: 'string' } },
      Plain: { X: { type: 'number' } },
    };
    return t[component]?.[field] ?? null;
  },
  applyPathOf(component) {
    if (component === 'Yard') return 'rebuild';
    if (component === 'Module' || component === 'Src') return 'des-extras';
    return null;
  },
};

let world: ReturnType<typeof makeWorld>;
let docId = 'doc-1';
let abort = new AbortController();
const offs: Array<() => void> = [];

function service() {
  return createParamApplyService({
    viewer: world.viewer as unknown as ParamApplyViewer,
    documentLoadId: () => docId,
    signal: () => abort.signal,
    env,
  });
}

/** The yard's rebuild handler: Size n → module nodes #m1..#mn with the template Rate 1. */
function installYard(opts: { failAt?: number; onRebuild?: (n: number) => void } = {}) {
  world.nodes.set('#yard', node('Yard', { Yard: { Size: 3 } }));
  for (let i = 1; i <= 3; i++) world.nodes.set(`#m${i}`, node(`M${i}`, { Module: { Rate: 1 } }));
  offs.push(registerParamRebuild('Yard', (ops) => {
    const size = ops.find((o) => o.field === 'Size');
    const n = size && size.op === 'set' ? Number(size.value) : 3;
    world.log.push(`rebuild:${n}`);
    opts.onRebuild?.(n);
    if (opts.failAt === n) throw new Error(`cannot build size ${n}`);
    for (const k of [...world.nodes.keys()]) if (/^#m\d+$/.test(k)) world.nodes.delete(k);
    for (let i = 1; i <= n; i++) world.nodes.set(`#m${i}`, node(`M${i}`, { Module: { Rate: 1 } }));
  }));
}

const set = (address: string, component: string, field: string, value: number | boolean | string): FieldOp =>
  ({ address, component, field, op: 'set', value });
const rv = (address: string) => world.nodes.get(address)!.userData.realvirtual as Record<string, Record<string, unknown>>;

beforeEach(() => {
  world = makeWorld();
  docId = 'doc-1';
  abort = new AbortController();
  world.nodes.set('#src', node('Src', { Src: { Interval: 10 } }));
});
afterEach(() => { for (const off of offs.splice(0)) off(); });

// ─── Admission ─────────────────────────────────────────────────────────────

describe('admission (address-free, before anything happens)', () => {
  it('one schema error ⇒ nothing written, no transaction, no reset', async () => {
    const r = await service().apply([set('#src', 'Src', 'Interval', 4), set('#src', 'Src', 'Interval_bad', 1)], { origin: 'variant' });
    expect(r).toMatchObject({ ok: false, error: 'invalid' });
    expect(rv('#src').Src.Interval).toBe(10);
    expect(world.viewer.resets).toBe(0);
  });

  it('checkValue refuses readonly / signal / reference / no apply path / wrong type / unknown enum', () => {
    const s = service();
    expect(s.checkValue('Src', 'Ro', 1)).toMatchObject({ ok: false, reason: 'readonly' });
    expect(s.checkValue('Src', 'Sig', true)).toMatchObject({ ok: false, reason: 'signal' });
    expect(s.checkValue('Src', 'Ref', 'x')).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(s.checkValue('Plain', 'X', 1)).toMatchObject({ ok: false, reason: 'unsupported' });
    expect(s.checkValue('Src', 'Name', 'x')).toMatchObject({ ok: false, reason: 'type' });
    expect(s.checkValue('Src', 'Interval', 'x')).toMatchObject({ ok: false, reason: 'type' });
    expect(s.checkValue('Module', 'Mode', 'c')).toMatchObject({ ok: false, reason: 'out-of-range' });
    expect(s.checkValue('Module', 'Mode', 'b')).toMatchObject({ ok: true, mode: 'des-extras' });
    expect(s.checkValue('Yard', 'Size', 2.5)).toMatchObject({ ok: false, reason: 'type' });
    expect(s.checkValue('Yard', 'Size', 2)).toMatchObject({ ok: true, mode: 'rebuild' });
  });

  it('the same field twice in one op set is invalid', async () => {
    const r = await service().apply([set('#src', 'Src', 'Interval', 4), set('#src', 'Src', 'Interval', 5)], { origin: 'variant' });
    expect(r.error).toBe('invalid');
  });
});

// ─── The transaction ───────────────────────────────────────────────────────

describe('the transaction (§2.5)', () => {
  it('writes, re-configures once and resets exactly once — in that order', async () => {
    const r = await service().apply([set('#src', 'Src', 'Interval', 4)], { origin: 'variant' });
    expect(r.ok).toBe(true);
    expect(rv('#src').Src.Interval).toBe(4);
    expect(world.log).toEqual(['reconfigure', 'reset']);
    expect(world.viewer.resets).toBe(1);
  });

  it('an op on a node the rebuild creates is resolved after it (Gate R1 #1); order rebuild → capture → validate → write → reconfigure → reset', async () => {
    installYard();
    offs.push(registerParamValidator('Module', (c) => { world.log.push(`validate:${String(c.Rate)}`); return {}; }));
    const r = await service().apply([set('#yard', 'Yard', 'Size', 5), set('#m5', 'Module', 'Rate', 7)], { origin: 'variant' });
    expect(r.ok).toBe(true);
    expect(r.unresolved).toEqual([]);
    expect(r.captured).toEqual([{ key: { address: '#m5', component: 'Module', field: 'Rate' }, base: { kind: 'value', value: 1 } }]);
    expect(rv('#m5').Module.Rate).toBe(7);
    expect(rv('#yard').Yard.Size).toBe(5);
    expect(world.log).toEqual(['rebuild:5', 'validate:7', 'reconfigure', 'reset']);
  });

  it('an op whose node does not exist after the rebuild is unresolved, not an error', async () => {
    installYard();
    const r = await service().apply([set('#yard', 'Yard', 'Size', 2), set('#m3', 'Module', 'Rate', 7)], { origin: 'variant' });
    expect(r.ok).toBe(true);
    expect(r.unresolved).toEqual([{ address: '#m3', component: 'Module', field: 'Rate' }]);
    expect(world.nodes.has('#m3')).toBe(false);
    expect(world.viewer.resets).toBe(1);
  });

  it('a second apply meanwhile → apply-in-progress; the old registry shares the lock', async () => {
    installYard();
    let release!: () => void;
    const held = new Promise<void>((r) => { release = r; });
    offs.push(registerParamRebuild('Yard', async () => { await held; }));
    const s = service();
    const first = s.apply([set('#yard', 'Yard', 'Size', 4)], { origin: 'variant' });
    await Promise.resolve();
    expect(isParamApplyBusy()).toBe(true);
    expect((await s.apply([set('#src', 'Src', 'Interval', 4)], { origin: 'variant' })).error).toBe('apply-in-progress');
    release();
    expect((await first).ok).toBe(true);
    expect(isParamApplyBusy()).toBe(false);
  });

  it('a foreign run lease → locked, nothing written; its holder may apply', async () => {
    const lease = acquireRunLease(docId, 'batch-1')!;
    try {
      const s = service();
      expect((await s.apply([set('#src', 'Src', 'Interval', 4)], { origin: 'variant' })).error).toBe('locked');
      expect(rv('#src').Src.Interval).toBe(10);
      expect((await s.apply([set('#src', 'Src', 'Interval', 4)], { origin: 'experiment', holder: 'batch-1' })).ok).toBe(true);
    } finally { lease.release(); }
  });

  it('a validator failing AFTER the rebuild rolls back in the same hull: old structure, old values, one reset', async () => {
    installYard();
    offs.push(registerParamValidator('Module', (c): Record<string, string> => (Number(c.Rate) > 100 ? { Rate: 'too fast' } : {})));
    const r = await service().apply([set('#yard', 'Yard', 'Size', 4), set('#m4', 'Module', 'Rate', 500)], { origin: 'variant' });
    expect(r).toMatchObject({ ok: false, error: 'invalid' });
    expect(r.detail).toMatch(/too fast/);
    expect(world.log).toEqual(['rebuild:4', 'rebuild:3', 'reset']);
    expect(world.nodes.has('#m4')).toBe(false);
    expect(rv('#yard').Yard.Size).toBe(3);
    expect(world.viewer.resets).toBe(1);
  });

  it('a throwing rebuild → written fields back + rebuild with the old values; one reset', async () => {
    installYard({ failAt: 6 });
    const r = await service().apply([set('#yard', 'Yard', 'Size', 6), set('#src', 'Src', 'Interval', 4)], { origin: 'variant' });
    expect(r).toMatchObject({ ok: false, error: 'rebuild-failed' });
    expect(world.log).toEqual(['rebuild:6', 'rebuild:3', 'reset']);
    expect(rv('#src').Src.Interval).toBe(10);
    expect(rv('#yard').Yard.Size).toBe(3);
    expect(world.viewer.resets).toBe(1);
  });

  it('unset removes a field the document never had; readBase answers absent again (Gate R1 #3)', async () => {
    const s = service();
    const k = { address: '#src', component: 'Src', field: 'Interval' } as const;
    world.nodes.set('#src', node('Src', { Src: {} }));
    expect(s.readBase(k)).toEqual({ kind: 'absent' });
    expect((await s.apply([set('#src', 'Src', 'Interval', 4)], { origin: 'variant' })).ok).toBe(true);
    expect(s.readBase(k)).toEqual({ kind: 'value', value: 4 });
    expect((await s.apply([{ ...k, op: 'unset' }], { origin: 'variant' })).ok).toBe(true);
    expect(s.readBase(k)).toEqual({ kind: 'absent' });
    expect(rv('#src').Src).toEqual({});
    expect(s.readBase({ ...k, address: '#nowhere' })).toBeNull();
  });

  it('a document change during the apply → document-changed, no rollback onto the new document, no reset', async () => {
    installYard();
    offs.push(registerParamRebuild('Yard', () => { docId = 'doc-2'; abort.abort(); }));
    const r = await service().apply([set('#yard', 'Yard', 'Size', 4), set('#src', 'Src', 'Interval', 4)], { origin: 'variant' });
    expect(r.error).toBe('document-changed');
    expect(world.viewer.resets).toBe(0);
  });
});

describe('review fixes', () => {
  it('#1 a caller whose document changed before the hull opened gets document-changed with no side effect', async () => {
    const s = createParamApplyService({
      viewer: world.viewer as unknown as ParamApplyViewer, documentLoadId: () => docId, signal: () => abort.signal, env,
      startDocument: 'doc-0',
    });
    const r = await s.apply([set('#src', 'Src', 'Interval', 4)], { origin: 'variant' });
    expect(r.error).toBe('document-changed');
    expect(rv('#src').Src.Interval).toBe(10);
    expect(world.viewer.resets).toBe(0);
  });

  it('#2 a missing DES rebind after a successful body is ok with a warning — the scene IS the target state', async () => {
    const kernel = world.viewer.simulationKernel as Record<string, unknown>;
    kernel.mode = 'des';
    kernel.hasDesLifecycle = () => true;
    kernel.onDesLifecycle = () => () => {};
    const s = createParamApplyService({
      viewer: world.viewer as unknown as ParamApplyViewer, documentLoadId: () => docId, signal: () => abort.signal, env, boundTimeoutMs: 20,
    });
    const r = await s.apply([set('#src', 'Src', 'Interval', 4)], { origin: 'variant' });
    expect(r.ok).toBe(true);
    expect(r.warning).toMatch(/did not rebind/);
    expect(rv('#src').Src.Interval).toBe(4);
  });
});

// ─── Full target state over a destructive rebuild (Gate R2 #2) ─────────────

describe('full target state over a destructive rebuild', () => {
  it('Size 3 + A3 → Size 2 (A3 unresolved, value kept by the caller) → Size 3: A3 carries the variant value again', async () => {
    installYard();
    const s = service();
    const a3 = set('#m3', 'Module', 'Rate', 7);
    expect((await s.apply([set('#yard', 'Yard', 'Size', 3), a3], { origin: 'variant' })).ok).toBe(true);
    expect(rv('#m3').Module.Rate).toBe(7);
    const down = await s.apply([set('#yard', 'Yard', 'Size', 2), a3], { origin: 'variant' });
    expect(down.ok).toBe(true);
    expect(down.unresolved).toEqual([{ address: '#m3', component: 'Module', field: 'Rate' }]);
    const up = await s.apply([set('#yard', 'Yard', 'Size', 3), a3], { origin: 'variant' });
    expect(up.ok).toBe(true);
    expect(up.captured).toEqual([{ key: { address: '#m3', component: 'Module', field: 'Rate' }, base: { kind: 'value', value: 1 } }]);
    expect(rv('#m3').Module.Rate).toBe(7);
    expect(world.viewer.resets).toBe(3);
  });

  it('a failure after a destructive rebuild restores the old structure FIRST, then A3 with its previous value (not the template)', async () => {
    installYard();
    offs.push(registerParamValidator('Src', (c): Record<string, string> => (Number(c.Interval) < 1 ? { Interval: 'must be ≥ 1' } : {})));
    const s = service();
    expect((await s.apply([set('#yard', 'Yard', 'Size', 3), set('#m3', 'Module', 'Rate', 7)], { origin: 'variant' })).ok).toBe(true);
    world.log.length = 0;
    const r = await s.apply([
      set('#yard', 'Yard', 'Size', 4), set('#m3', 'Module', 'Rate', 9), set('#src', 'Src', 'Interval', 0),
    ], { origin: 'variant' });
    expect(r.error).toBe('invalid');
    expect(world.log).toEqual(['rebuild:4', 'rebuild:3', 'reconfigure', 'reset']);
    expect(rv('#m3').Module.Rate).toBe(7);           // previous value, not the template's 1
    expect(world.nodes.has('#m4')).toBe(false);
    expect(rv('#src').Src.Interval).toBe(10);
  });
});

// ─── The old registry through the lazy adapter ─────────────────────────────

describe('lazy adapter of the old planning registry', () => {
  it('applyPendingAndReset runs through the same hull (shared lock, one reset)', async () => {
    const registry = createPlanningRegistry({ simTime: () => 0, documentLoadId: () => docId });
    let busyInside = false;
    registry.declare({
      owner: 'yard', title: 'Yard',
      params: [{ key: 'n', label: 'N', type: 'integer', default: 1, group: 'g', apply: 'reset' }],
      onStructuralReset: async () => { busyInside = isParamApplyBusy(); world.viewer.resetSimulation(); },
    });
    registry.setApplyRunner(createStructuralResetRunner({
      viewer: world.viewer as never,
      documentLoadId: () => docId,
      signal: () => abort.signal,
    }));
    registry.set('yard.n', 2, 'ui');
    const r = await registry.applyPendingAndReset();
    expect(r.ok).toBe(true);
    expect(busyInside).toBe(true);
    expect(world.viewer.resets).toBe(1);   // the owner's own reset inside was withheld
  });
});
