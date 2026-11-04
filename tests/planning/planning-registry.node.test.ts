// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-630 test 9.2 — PlanningRegistry: live vs. reset, atomic setMany, change log and replay
 * order, normal reset, dormant scenario keys, redeclare, experiment lock, structural reset
 * serialisation. Pure: sim time and the Problems sink are injected.
 */
import { describe, expect, it } from 'vitest';
import { createPlanningRegistry } from '../../src/core/planning/rv-planning-registry';
import type { PlanningRegistryOptions } from '../../src/core/planning/rv-planning-registry';
import type {
  PendingLiveChange,
  PlanningDeclaration,
  PlanningParamDef,
  PlanningValue,
} from '../../src/core/planning/rv-planning-params';

function harness(extra: PlanningRegistryOptions = {}) {
  let t = 0;
  const reported: Array<{ id: string; code: string }> = [];
  const cleared: string[] = [];
  const registry = createPlanningRegistry({
    simTime: () => t,
    problems: { report: (p) => { reported.push({ id: p.id, code: p.code }); }, clear: (id) => { cleared.push(id); } },
    ...extra,
  });
  return { registry, reported, cleared, setTime: (v: number) => { t = v; } };
}

const PARAMS: PlanningParamDef[] = [
  { key: 'rate', label: 'Rate', type: 'number', unit: 'Pal/h', min: 0, max: 120, default: 40, group: 'Last', apply: 'live' },
  { key: 'pause', label: 'Pause', type: 'number', unit: 's', min: 0, default: 1200, group: 'Versand', apply: 'live' },
  { key: 'v1', label: 'V1', type: 'boolean', default: true, group: 'Flotte', apply: 'reset', ui: { chipRow: 'veh' } },
  { key: 'v2', label: 'V2', type: 'boolean', default: true, group: 'Flotte', apply: 'reset', ui: { chipRow: 'veh' } },
  { key: 'slots', label: 'Slots', type: 'integer', min: 0, max: 6, default: 6, group: 'Puffer', apply: 'reset' },
  { key: 'trace', label: 'Spur', type: 'boolean', default: false, group: 'Anzeige', apply: 'live', role: 'display' },
];

/** Owner with a live queue the test drains by hand. */
function yard(withOnLive = true): { decl: PlanningDeclaration; due: Array<{ change: PendingLiveChange; applied: (t: number) => void }> } {
  const due: Array<{ change: PendingLiveChange; applied: (t: number) => void }> = [];
  const decl: PlanningDeclaration = {
    owner: 'yard',
    title: 'Planung · Yard',
    params: PARAMS,
    validate: (v): Record<string, string> => (v.v1 === false && v.v2 === false ? { v2: 'mindestens ein Fahrzeug aktiv' } : {}),
    onLive: withOnLive ? (change, applied) => { due.push({ change, applied }); } : undefined,
  };
  return { decl, due };
}

describe('PlanningRegistry — reset values', () => {
  it('a reset value is pending, values() unchanged; commitPending takes it over at simTime 0, idempotent', () => {
    const { registry, setTime } = harness();
    const { decl } = yard();
    const h = registry.declare(decl);
    setTime(500);
    expect(registry.set('yard.slots', '2', 'ui')).toEqual({ ok: true, applied: 'pending' });
    expect(h.values().slots).toBe(6);
    const st = registry.list().find((p) => p.key === 'yard.slots')!;
    expect(st.pending).toBe(2);
    expect(st.pendingKind).toBe('reset');
    expect(registry.getSnapshot().pendingCount).toBe(1);

    h.commitPending();
    expect(h.values().slots).toBe(2);
    expect(h.get('slots')).toBe(2);
    expect(registry.changeLog()).toEqual([{ simTime: 0, seq: 0, key: 'yard.slots', from: 6, to: 2, origin: 'ui' }]);
    const snap = registry.getSnapshot();
    h.commitPending();
    expect(registry.getSnapshot()).toBe(snap);
    expect(registry.changeLog()).toHaveLength(1);
  });

  it('setting the committed value again withdraws the pending value', () => {
    const { registry } = harness();
    registry.declare(yard().decl);
    registry.set('yard.slots', 3, 'ui');
    expect(registry.set('yard.slots', 6, 'ui').applied).toBe('reverted');
    expect(registry.getSnapshot().pendingCount).toBe(0);
    registry.set('yard.slots', 3, 'ui');
    expect(registry.revertPending('yard.slots')).toBe(true);
    expect(registry.getSnapshot().pendingCount).toBe(0);
  });

  it('a normal sim reset does not take pending values over and drops the old log', () => {
    const { registry } = harness();
    const { decl } = yard(false);
    const h = registry.declare(decl);
    registry.set('yard.rate', 60, 'ui');
    registry.set('yard.slots', 2, 'ui');
    expect(registry.changeLog()).toHaveLength(1);
    registry.notifySimulationReset();
    expect(h.values().slots).toBe(6);
    expect(registry.getSnapshot().pendingCount).toBe(1);
    expect(registry.changeLog()).toEqual([]);
  });
});

describe('PlanningRegistry — live values', () => {
  it('with onLive the value is visible only after applied(t); the log carries t, not the set time', () => {
    const { registry, setTime } = harness();
    const { decl, due } = yard();
    const h = registry.declare(decl);
    setTime(100);
    expect(registry.set('yard.rate', 70, 'ui').applied).toBe('queued');
    expect(h.values().rate).toBe(40);
    expect(registry.list().find((p) => p.key === 'yard.rate')!.pendingKind).toBe('live');
    expect(due).toHaveLength(1);
    expect(due[0].change).toMatchObject({ key: 'rate', effectiveKey: 'yard.rate', from: 40, to: 70, seq: 0 });
    due[0].applied(1800);
    expect(h.values().rate).toBe(70);
    expect(registry.changeLog()).toEqual([{ simTime: 1800, seq: 0, key: 'yard.rate', from: 40, to: 70, origin: 'ui' }]);
  });

  it('without onLive the value is committed now and logged with the current sim time', () => {
    const { registry, setTime } = harness();
    const h = registry.declare(yard(false).decl);
    setTime(42);
    expect(registry.set('yard.rate', 55, 'mcp').applied).toBe('applied');
    expect(h.values().rate).toBe(55);
    expect(registry.changeLog()[0]).toMatchObject({ simTime: 42, key: 'yard.rate', origin: 'mcp' });
  });

  it('two live changes at the same instant are logged in seq order even if applied out of order', () => {
    const { registry } = harness();
    const { decl, due } = yard();
    registry.declare(decl);
    registry.setMany({ 'yard.rate': 70, 'yard.pause': 900 }, 'ui');
    expect(due.map((d) => d.change.seq)).toEqual([0, 1]);
    due[1].applied(3600);
    due[0].applied(3600);
    expect(registry.changeLog().map((c) => c.key)).toEqual(['yard.rate', 'yard.pause']);
  });

  it('folds only unapplied changes of one key; applied changes stay in the log', () => {
    const { registry } = harness();
    const { decl, due } = yard();
    const h = registry.declare(decl);
    registry.set('yard.rate', 50, 'ui');
    registry.set('yard.rate', 60, 'ui');           // folds the unapplied 50
    due[0].applied(10);                             // expired: no effect
    expect(h.values().rate).toBe(40);
    due[1].applied(20);
    registry.set('yard.rate', 80, 'ui');
    due[2].applied(30);
    expect(registry.changeLog().map((c) => [c.simTime, c.to])).toEqual([[20, 60], [30, 80]]);
    expect(h.values().rate).toBe(80);
  });

  it('a live change overtaken by a reset expires and is not in the new log', () => {
    const { registry } = harness();
    const { decl, due } = yard();
    const h = registry.declare(decl);
    registry.set('yard.rate', 70, 'ui');
    registry.notifySimulationReset();
    due[0].applied(5);
    expect(h.values().rate).toBe(40);
    expect(registry.changeLog()).toEqual([]);
    expect(registry.list().find((p) => p.key === 'yard.rate')!.pending).toBeUndefined();
  });

  it('display switches are set now and never logged, and survive through the storage', () => {
    const store = new Map<string, Record<string, unknown>>();
    const storage = { load: (o: string) => store.get(o) ?? null, save: (o: string, v: Record<string, PlanningValue>) => { store.set(o, v); } };
    const { registry } = harness({ displayStorage: storage });
    const h = registry.declare(yard().decl);
    expect(registry.set('yard.trace', true, 'ui').applied).toBe('display');
    expect(h.values().trace).toBe(true);
    expect(registry.changeLog()).toEqual([]);
    const { registry: second } = harness({ displayStorage: storage });
    expect(second.declare(yard().decl).values().trace).toBe(true);
  });
});

describe('PlanningRegistry — atomic setMany', () => {
  it('cross rule refuses "all vehicles off"; one invalid value changes nothing and publishes nothing', () => {
    const { registry } = harness();
    registry.declare(yard().decl);
    expect(registry.set('yard.v1', false, 'ui').ok).toBe(true);
    let notified = 0;
    registry.subscribe(() => { notified++; });
    const before = registry.getSnapshot();

    const r = registry.set('yard.v2', false, 'ui'); // candidate = committed + pending(v1=false) + new
    expect(r).toEqual({ ok: false, error: 'mindestens ein Fahrzeug aktiv' });

    const m = registry.setMany({ 'yard.slots': 3, 'yard.rate': 500 }, 'mcp');
    expect(m.ok).toBe(false);
    expect(m.results['yard.rate'].ok).toBe(false);
    expect(m.results['yard.slots']).toEqual({ ok: false, error: 'not-applied' });
    expect(registry.setMany({ 'yard.nope': 1 }, 'mcp').results['yard.nope'].error).toBe('unknown-key');

    expect(notified).toBe(0);
    expect(registry.getSnapshot()).toBe(before);
  });

  it('a valid multi-key write publishes exactly one snapshot', () => {
    const { registry } = harness();
    registry.declare(yard(false).decl);
    let notified = 0;
    registry.subscribe(() => { notified++; });
    const r = registry.setMany({ 'yard.slots': 3, 'yard.rate': 90, 'yard.v1': false }, 'ui');
    expect(r.ok).toBe(true);
    expect(notified).toBe(1);
    const snap = registry.getSnapshot();
    expect(registry.getSnapshot()).toBe(snap);
    expect(registry.list()).toBe(snap.params);
  });
});

describe('PlanningRegistry — dormant keys and redeclare', () => {
  it('scenario values loaded before declare take effect on declare; orphans are reported, not deleted', () => {
    const { registry, reported } = harness();
    const r = registry.setMany({ 'yard.slots': 2, 'yard.rate': 60, 'other.x': 1 }, 'scenario');
    expect(r.results['yard.slots'].applied).toBe('dormant');
    const h = registry.declare(yard().decl);
    expect(h.values().slots).toBe(2);
    expect(h.values().rate).toBe(60);
    expect(registry.list().find((p) => p.key === 'yard.slots')!.source).toBe('scenario');
    expect(registry.dormant()).toEqual({ 'other.x': 1 });
    expect(registry.reportOrphans()).toEqual(['other.x']);
    expect(reported.map((p) => p.code)).toContain('planning-param-orphaned');
    expect(registry.dormant()).toEqual({ 'other.x': 1 });
  });

  it('an invalid scenario value is dropped with a Problems entry, never clamped; the default stays in effect (plan-630 Phase 3)', () => {
    const { registry, reported } = harness();
    registry.setMany({ 'yard.slots': 99 }, 'scenario');
    const h = registry.declare(yard().decl);
    expect(h.values().slots).toBe(6);
    expect(reported.map((p) => p.code)).toContain('planning-scenario-value-invalid');
    expect(registry.dormant()).toEqual({});
  });

  it('a scenario value that breaks a cross rule is dropped and reported', () => {
    const { registry, reported } = harness();
    registry.setMany({ 'yard.v1': false, 'yard.v2': false }, 'scenario');
    const h = registry.declare(yard().decl);
    expect(h.values().v1).toBe(false);   // valid on its own
    expect(h.values().v2).toBe(true);    // the one the rule names: dropped, default
    expect(reported.some((p) => p.id === 'planning-scenario-value-invalid:yard.v2')).toBe(true);
    expect(registry.dormant()).toEqual({});
  });

  it('redeclare with new instance keys keeps dormant values and parks values of dropped keys', () => {
    const { registry } = harness();
    registry.setMany({ 'yard.vehicle.S3.active': false }, 'scenario');
    const base: PlanningParamDef = { key: 'vehicle.S1.active', label: 'S1', type: 'boolean', default: true, group: 'Flotte', apply: 'reset' };
    const h = registry.declare({ owner: 'yard', title: 'Y', params: [base, { ...base, key: 'vehicle.S2.active', label: 'S2' }] });
    registry.set('yard.vehicle.S2.active', false, 'ui');
    h.commitPending();
    expect(registry.dormant()).toEqual({ 'yard.vehicle.S3.active': false });

    h.redeclare([base, { ...base, key: 'vehicle.S3.active', label: 'S3' }]);
    expect(h.values()).toEqual({ 'vehicle.S1.active': true, 'vehicle.S3.active': false });
    expect(registry.dormant()).toEqual({ 'yard.vehicle.S2.active': false });

    h.redeclare([base, { ...base, key: 'vehicle.S2.active', label: 'S2' }, { ...base, key: 'vehicle.S3.active', label: 'S3' }]);
    expect(h.values()['vehicle.S2.active']).toBe(false);
    expect(registry.dormant()).toEqual({});
  });

  it('an invalid declaration is reported to Problems and the valid rest is declared', () => {
    const { registry, reported } = harness();
    const h = registry.declare({ owner: 'o', title: 'O', params: [
      { key: 'a', label: 'A', type: 'number', min: 0, max: 10, default: 20, group: 'g', apply: 'live' },
      { key: 'b', label: 'B', type: 'number', default: 1, group: 'g', apply: 'live' },
    ] });
    expect(reported.map((p) => p.code)).toEqual(['planning-declaration-invalid']);
    expect(Object.keys(h.values())).toEqual(['b']);
    const inert = registry.declare({ owner: '', title: '', params: [] } as PlanningDeclaration);
    expect(inert.values()).toEqual({});
  });

  it('dispose removes the owner and parks non-default values for a re-declare', () => {
    const { registry } = harness();
    const h = registry.declare(yard(false).decl);
    registry.set('yard.rate', 90, 'ui');
    h.dispose();
    expect(registry.list()).toEqual([]);
    expect(registry.declare(yard(false).decl).values().rate).toBe(90);
  });
});

describe('PlanningRegistry — experiment lock', () => {
  it('while an experiment runs, every factor change from ui/mcp answers experiment-running', () => {
    const { registry } = harness();
    registry.declare(yard().decl);
    registry.setExperimentRunning(true);
    expect(registry.set('yard.rate', 70, 'ui')).toEqual({ ok: false, error: 'experiment-running' });
    expect(registry.set('yard.rate', 70, 'mcp').error).toBe('experiment-running');
    // plan-2005 Phase 7: reset-class values too — the batch owns the registry (9.13).
    expect(registry.set('yard.slots', 2, 'ui')).toEqual({ ok: false, error: 'experiment-running' });
    // The experiment itself sets live factors as start values (pending until the structural reset).
    expect(registry.set('yard.rate', 70, 'experiment').applied).toBe('pending');
    registry.setExperimentRunning(false);
    expect(registry.set('yard.pause', 900, 'ui').ok).toBe(true);
  });
});

describe('PlanningRegistry — structural reset (default runner)', () => {
  it('commits pending values into a new run, calls onStructuralReset once per changed owner', async () => {
    const { registry } = harness({ documentLoadId: () => 'doc-1' });
    const calls: Array<{ committed: Readonly<Record<string, PlanningValue>>; doc: string }> = [];
    const { decl } = yard(false);
    const h = registry.declare({ ...decl, onStructuralReset: async (committed, ctx) => { calls.push({ committed, doc: ctx.documentLoadId }); } });
    registry.set('yard.rate', 60, 'ui');            // logged in the old run
    registry.set('yard.slots', 2, 'ui');
    const r = await registry.applyPendingAndReset();
    expect(r).toEqual({ ok: true, generation: 1 });
    expect(h.values().slots).toBe(2);
    expect(calls).toHaveLength(1);
    expect(calls[0].committed.slots).toBe(2);
    expect(calls[0].doc).toBe('doc-1');
    expect(registry.changeLog()).toEqual([{ simTime: 0, seq: 0, key: 'yard.slots', from: 6, to: 2, origin: 'ui' }]);
  });

  it('a second apply while one runs answers apply-in-progress', async () => {
    const { registry } = harness();
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    registry.declare({ ...yard().decl, onStructuralReset: () => gate });
    registry.set('yard.slots', 2, 'ui');
    const first = registry.applyPendingAndReset();
    const second = await registry.applyPendingAndReset();
    expect(second).toMatchObject({ ok: false, error: 'apply-in-progress' });
    release();
    expect((await first).ok).toBe(true);
  });

  it('a failing onStructuralReset reverts the values to pending and reports the failure', async () => {
    const { registry, reported } = harness();
    const seen: number[] = [];
    const h = registry.declare({
      ...yard().decl,
      onStructuralReset: async (committed) => {
        seen.push(committed.slots as number);
        if (committed.slots === 2) throw new Error('boom');
      },
    });
    registry.set('yard.slots', 2, 'ui');
    const r = await registry.applyPendingAndReset();
    expect(r).toMatchObject({ ok: false, error: 'materialize-failed', generation: 0 });
    expect(h.values().slots).toBe(6);
    expect(registry.getSnapshot().pendingCount).toBe(1);
    expect(seen).toEqual([2, 6]);                    // configured, then rolled back to the previous state
    expect(reported.map((p) => p.code)).toContain('planning-apply-failed');
    expect(registry.changeLog()).toEqual([]);
  });

  it('an installed runner replaces the default and is still serialised', async () => {
    const { registry } = harness();
    let runs = 0;
    registry.setApplyRunner(async (ctx) => { runs++; ctx.startNewRun(); ctx.commitAllPending(); return { ok: true }; });
    const h = registry.declare(yard().decl);
    registry.set('yard.slots', 1, 'ui');
    expect((await registry.applyPendingAndReset()).generation).toBe(1);
    expect(runs).toBe(1);
    expect(h.values().slots).toBe(1);
  });
});

describe('PlanningRegistry — key figures', () => {
  it('reads KPIs and turns throwing or non-finite readers into null', () => {
    const { registry } = harness();
    registry.declare({
      owner: 'sys', title: 'S', params: [],
      kpis: [
        { key: 'fps', label: 'FPS', kind: 'measured', read: () => 58 },
        { key: 'heap', label: 'Heap', kind: 'measured', read: () => null },
        { key: 'bad', label: 'Bad', kind: 'sim', read: () => { throw new Error('x'); } },
        { key: 'nan', label: 'NaN', kind: 'sim', read: () => Number.NaN },
      ],
    });
    expect(registry.kpis().map((k) => [k.key, k.kind, k.value])).toEqual([
      ['sys.fps', 'measured', 58], ['sys.heap', 'measured', null], ['sys.bad', 'sim', null], ['sys.nan', 'sim', null],
    ]);
  });
});

describe('resetToDefaults (Thomas 2026-10-26)', () => {
  it('puts every factor back on its default through the usual paths; display switches untouched', () => {
    const h = harness();
    const handle = h.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
    // committed non-defaults: a live value and a reset value taken over by a commit
    expect(h.registry.setMany({ 'yard.rate': 70, 'yard.slots': 3, 'yard.trace': true }, 'ui').ok).toBe(true);
    handle.commitPending();                        // slots 3 committed, v1 untouched
    h.registry.set('yard.v1', false, 'ui');        // pending only
    expect(h.registry.nonDefaultKeys('yard').sort()).toEqual(['yard.rate', 'yard.slots', 'yard.v1']);

    const r = h.registry.resetToDefaults('yard', 'ui');
    expect(r.ok).toBe(true);
    const byKey = Object.fromEntries(h.registry.list().map((p) => [p.key, p]));
    expect(byKey['yard.rate'].value).toBe(40);       // live without onLive: applied now
    expect(byKey['yard.slots'].value).toBe(3);       // reset: committed stays …
    expect(byKey['yard.slots'].pending).toBe(6);     // … the default waits for the apply
    expect(byKey['yard.v1'].pending).toBeUndefined(); // a pending non-default is withdrawn
    expect(byKey['yard.trace'].value).toBe(true);    // display untouched
    expect(h.registry.nonDefaultKeys('yard')).toEqual([]);
    handle.commitPending();
    expect(handle.values().slots).toBe(6);
  });

  it('is a no-op at the defaults and for an unknown owner', () => {
    const h = harness();
    h.registry.declare({ owner: 'yard', title: 'Yard', params: PARAMS });
    const v0 = h.registry.getSnapshot().version;
    expect(h.registry.resetToDefaults('yard', 'ui')).toEqual({ ok: true, results: {} });
    expect(h.registry.resetToDefaults('nobody', 'ui')).toEqual({ ok: true, results: {} });
    expect(h.registry.getSnapshot().version).toBe(v0);
  });
});

describe('PlanningRegistry — document scenarios (plan-630 Phase 3)', () => {
  it('loadScenario: start values become COMMITTED (reset class included), not pending, and nothing is logged', () => {
    const { registry } = harness();
    registry.loadScenario({ 'yard.slots': 2, 'yard.rate': 60 });
    const h = registry.declare(yard().decl);
    expect(h.values().slots).toBe(2);
    expect(h.values().rate).toBe(60);
    expect(registry.getSnapshot().pendingCount).toBe(0);
    expect(registry.changeLog()).toEqual([]);
    expect(registry.list().find((p) => p.key === 'yard.slots')!.source).toBe('scenario');
  });

  it('loadScenario replaces the dormant values of the previous document', () => {
    const { registry } = harness();
    const h = registry.declare(yard().decl);
    registry.set('yard.slots', 3, 'ui');
    h.commitPending();
    h.dispose();                                   // the old document goes: its value parks dormant
    expect(registry.dormant()).toEqual({ 'yard.slots': 3 });
    registry.loadScenario({});                     // a new document without a block
    expect(registry.dormant()).toEqual({});
    expect(registry.declare(yard().decl).values().slots).toBe(6);
  });

  it('loadScenario on an owner that is already declared resets it to its defaults plus the scenario', () => {
    const { registry } = harness();
    const h = registry.declare(yard().decl);
    registry.set('yard.slots', 3, 'ui');           // pending
    registry.loadScenario({ 'yard.rate': 80 });
    expect(h.values().rate).toBe(80);
    expect(h.values().slots).toBe(6);
    expect(registry.getSnapshot().pendingCount).toBe(0);
  });

  it('loadScenario drops an out-of-range value and reports it', () => {
    const { registry, reported } = harness();
    const h = registry.declare(yard().decl);
    registry.loadScenario({ 'yard.rate': 500 });
    expect(h.values().rate).toBe(40);
    expect(reported.some((p) => p.id === 'planning-scenario-value-invalid:yard.rate')).toBe(true);
    expect(registry.dormant()).toEqual({});
  });

  it('applyScenario: one atomic write — live applied/queued, reset pending, absent keys back to default', () => {
    const { registry } = harness();
    const { decl, due } = yard();
    const h = registry.declare(decl);
    registry.set('yard.pause', 900, 'ui');
    due.splice(0).forEach((d) => d.applied(5));
    let notified = 0;
    registry.subscribe(() => { notified++; });
    const r = registry.applyScenario({ 'yard.rate': 70, 'yard.slots': 2 }, 'scenario');
    expect(r.ok).toBe(true);
    expect(notified).toBe(1);
    expect(registry.list().find((p) => p.key === 'yard.slots')!.pending).toBe(2);
    expect(due.map((d) => [d.change.key, d.change.to]).sort()).toEqual([['pause', 1200], ['rate', 70]]);
    expect(h.values().slots).toBe(6);
  });

  it('applyScenario drops an invalid value (reported) and keeps undeclared keys dormant', () => {
    const { registry, reported } = harness();
    registry.declare(yard(false).decl);
    const r = registry.applyScenario({ 'yard.rate': 'fast', 'script.speed': 3 }, 'scenario');
    expect(r.ok).toBe(true);
    expect(reported.some((p) => p.id === 'planning-scenario-value-invalid:yard.rate')).toBe(true);
    expect(registry.list().find((p) => p.key === 'yard.rate')!.value).toBe(40);
    expect(registry.dormant()).toEqual({ 'script.speed': 3 });
  });

  it('applyScenario that breaks a cross rule changes nothing', () => {
    const { registry } = harness();
    const h = registry.declare(yard(false).decl);
    const before = registry.getSnapshot();
    const r = registry.applyScenario({ 'yard.v1': false, 'yard.v2': false }, 'scenario');
    expect(r.ok).toBe(false);
    expect(registry.getSnapshot()).toBe(before);
    expect(h.values().v1).toBe(true);
  });
});
