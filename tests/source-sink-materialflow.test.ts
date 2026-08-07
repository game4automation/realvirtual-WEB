// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Source / Sink as `defineMaterialFlow` definitions (Plan 194 §2.2, P3).
 *
 * Verifies:
 *   - both register with the correct kind/models,
 *   - des.onGenerate creates an MU + transfers it to the first output + re-arms,
 *   - des.onAccept destroys the MU + publishes Flow.Occupied = false,
 *   - the continuous blocks are INERT (no spawn/destroy on the default path —
 *     the engine RVSource / RVSink own the continuous work, no double effect).
 *
 * The des hooks are exercised against a hand-rolled MOCK self (mirrors the
 * mock-self pattern in tests/material-flow-self.test.ts) so the hooks can be
 * tested without a DESRunner: we capture transfers/schedules/signal writes.
 */

import { describe, it, expect } from 'vitest';
import { Object3D } from 'three';
// IMPORTANT — import behaviors.ts FIRST. registry.ts imports `matchesAny` from
// behaviors.ts, and behaviors.ts eager-globs every src/behaviors/*.ts (each of
// which calls defineMaterialFlow → registerMaterialFlow at module init). Loading
// behaviors.ts first lets its glob drive the (mutually-recursive) registry init in
// the order the app uses; entering registry.ts standalone first would read its
// `DES_HOOK_NAMES` const while still in the temporal dead zone. Same precondition
// every other behavior test (and the app) satisfies.
import '../src/core/behaviors';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import {
  createBindContext,
  iterateFixedUpdate,
  type BindContextHost,
} from '../src/core/behavior-runtime';
import {
  getMaterialFlow,
  matchMaterialFlows,
  getDesActionNames,
} from '../src/core/material-flow/registry';
import type { MaterialFlowSelf, MU, Port } from '../src/core/material-flow/material-flow-self';
import SourceBehavior from '../src/behaviors/Source';
import SinkBehavior from '../src/behaviors/Sink';

// The eager glob in behaviors.ts (imported above) runs each behavior's top-level
// defineMaterialFlow(), so the registry already holds Source/Sink. The registry is
// module-global; we do NOT reset it here (that would drop the registration).

// ─── Mock self (mirrors tests/material-flow-self.test.ts inline host) ───────

interface MockSelf extends MaterialFlowSelf {
  /** Captured transfers: [mu, fromPort]. */
  transfers: Array<{ mu: MU; from?: Port }>;
  /** Captured schedules: [delay, hook]. */
  schedules: Array<{ delay: number; hook: string }>;
  /** Captured signal writes. */
  writes: Map<string, boolean | number>;
}

function makeMockSelf(opts: {
  kind: MaterialFlowSelf['kind'];
  type: string;
  outputs?: Port[];
  props?: Record<string, unknown>;
  /** Whether the (mock) downstream can accept — drives the ZPA back-pressure path. */
  canAccept?: boolean;
} = { kind: 'source', type: 'Source' }): MockSelf {
  const transfers: MockSelf['transfers'] = [];
  const schedules: MockSelf['schedules'] = [];
  const writes = new Map<string, boolean | number>();
  const outs = opts.outputs ?? [];
  let muId = 0;

  const self: MockSelf = {
    type: opts.type,
    kind: opts.kind,
    root: new Object3D(),
    node: new Object3D(),
    entityId: 1,
    mode: 'des',
    signals: {
      get: <T = unknown>(n: string): T => writes.get(n) as unknown as T,
      set: (n: string, v: boolean | number) => { writes.set(n, v); },
      on: () => { /* not used by des hooks */ },
    },
    // Sink's signals block publishes `Flow.Occupied` via `self.sig.Occupied`
    // (namespace 'Conveyor'). Mirror that here so the des hook resolves it.
    sig: {
      Occupied: {
        get: (): boolean => writes.get('Flow.Occupied') === true,
        set: (v: boolean | number): void => { writes.set('Flow.Occupied', v); },
      },
    },
    signal: () => { /* declare — irrelevant in mock */ },
    in: (delay: number, hook: string) => { schedules.push({ delay, hook }); return schedules.length; },
    at: (time: number, hook: string) => { schedules.push({ delay: time, hook }); return schedules.length; },
    cancel: () => { /* no-op */ },
    now: 0,
    drive: () => null,
    ports: outs,
    inputs: () => [],
    outputs: () => outs,
    freeOutputs: () => outs,
    downstreamOccupied: () => false,
    setState: () => { /* no-op */ },
    statState: () => { /* no-op */ },
    state: 'idle',
    transfer: (mu: MU, from?: Port) => { transfers.push({ mu, from }); },
    spawn: (): MU => ({ id: ++muId, prop: {} }),
    downstreamCanAccept: () => opts.canAccept ?? true,
    mus: [],
    currentLoad: 0,
    contextMenu: () => { /* no-op */ },
    // Per-instance DES state slot (Source holds its pending ZPA MU here).
    local: { pending: null },
    prop: (opts.props ?? {}) as Record<string, never>,
    // Capture surface for assertions.
    transfers,
    schedules,
    writes,
  } as unknown as MockSelf;

  return self;
}

function fakePort(id: string): Port {
  return {
    id,
    role: 'output',
    mySnapId: 'my-' + id,
    partnerSnapId: id,
    partnerRoot: new Object3D(),
    partnerComponent: null,
    ownerRoot: new Object3D(),
    ownerComponent: null,
    occupied: () => false,
    upstreamWaiting: () => false,
    setOccupied: () => { /* no-op */ },
  } as Port;
}

// ─── BehaviorManager host (mirrors define-material-flow.test.ts) ────────────

function makeHost(root: Object3D): { host: BindContextHost; values: Map<string, boolean | number> } {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const host: BindContextHost = {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => { values.set(n, v); subs.get(n)?.forEach((cb) => cb(v)); },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = subs.get(n); if (!s) { s = new Set(); subs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
    },
    on: (e, cb) => new EventEmitter<Record<string, unknown>>().on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
  } as BindContextHost;
  return { host, values };
}

// ─── Registration ──────────────────────────────────────────────────────────

describe('Source / Sink — material-flow registration', () => {
  it('Source registers with kind "source" and models ["*Source*"]', () => {
    const def = getMaterialFlow('Source');
    expect(def).toBeDefined();
    expect(def!.kind).toBe('source');
    expect(def!.models).toEqual(['*Source*']);
  });

  it('Sink registers with kind "sink" and models ["*Sink*"]', () => {
    const def = getMaterialFlow('Sink');
    expect(def).toBeDefined();
    expect(def!.kind).toBe('sink');
    expect(def!.models).toEqual(['*Sink*']);
  });

  it('Source models[] match Source-named assets only', () => {
    expect(matchMaterialFlows('Source').map(d => d.type)).toContain('Source');
    expect(matchMaterialFlows('PartSource').map(d => d.type)).toContain('Source');
    expect(matchMaterialFlows('Conveyor').map(d => d.type)).not.toContain('Source');
  });

  it('Sink models[] match Sink-named assets only', () => {
    expect(matchMaterialFlows('Sink').map(d => d.type)).toContain('Sink');
    expect(matchMaterialFlows('PalletSink').map(d => d.type)).toContain('Sink');
    expect(matchMaterialFlows('Conveyor').map(d => d.type)).not.toContain('Sink');
  });

  it('reserves the DES action names for the present hooks', () => {
    expect(getDesActionNames('Source')).toContain('Source.Generate');
    expect(getDesActionNames('Sink')).toContain('Sink.Accept');
  });

  it('default exports are valid Behaviors', () => {
    expect(typeof SourceBehavior.bind).toBe('function');
    expect(SourceBehavior.models).toEqual(['*Source*']);
    expect(typeof SinkBehavior.bind).toBe('function');
    expect(SinkBehavior.models).toEqual(['*Sink*']);
  });
});

// ─── Source.des.onGenerate ───────────────────────────────────────────────────

describe('Source — des.onGenerate', () => {
  it('creates an MU, transfers it to the first output, and re-arms', () => {
    const def = getMaterialFlow('Source')!;
    const out = fakePort('line-in');
    const self = makeMockSelf({ kind: 'source', type: 'Source', outputs: [out], props: { Interval: 2 } });

    def.des!.onGenerate!(self);

    // One MU transferred to the first output.
    expect(self.transfers).toHaveLength(1);
    expect(self.transfers[0].from).toBe(out);
    expect(self.transfers[0].mu.id).toBe(1);

    // Re-armed: next generation scheduled at the schema interval.
    expect(self.schedules).toHaveLength(1);
    expect(self.schedules[0]).toEqual({ delay: 2, hook: 'Generate' });
  });

  it('uses the default 3 s cadence when no Interval is set', () => {
    const def = getMaterialFlow('Source')!;
    const self = makeMockSelf({ kind: 'source', type: 'Source', outputs: [fakePort('o')] });
    def.des!.onGenerate!(self);
    expect(self.schedules[0].delay).toBe(3);
  });

  it('mints a fresh MU id on each generation', () => {
    const def = getMaterialFlow('Source')!;
    const self = makeMockSelf({ kind: 'source', type: 'Source', outputs: [fakePort('o')] });
    def.des!.onGenerate!(self);
    def.des!.onGenerate!(self);
    expect(self.transfers.map(t => t.mu.id)).toEqual([1, 2]);
  });

  // ── ZPA back-pressure (plan-225 F5/B2) ──

  it('holds the MU and keeps RETRYING when the downstream is full (ZPA heartbeat)', () => {
    const def = getMaterialFlow('Source')!;
    const out = fakePort('line-in');
    const self = makeMockSelf({ kind: 'source', type: 'Source', outputs: [out], canAccept: false });
    def.des!.onGenerate!(self);
    // Full downstream → nothing handed over, the MU is held...
    expect(self.transfers).toHaveLength(0);
    // ...but generation RE-ARMS a retry tick (heartbeat), so a missed one-shot
    // onDownstreamReady wake can never permanently stall the source.
    expect(self.schedules).toHaveLength(1);
    expect(self.schedules[0].hook).toBe('Generate');
  });

  it('does not spawn a second MU while one is pending (no flood, only retries the held one)', () => {
    const def = getMaterialFlow('Source')!;
    const out = fakePort('line-in');
    const self = makeMockSelf({ kind: 'source', type: 'Source', outputs: [out], canAccept: false });
    def.des!.onGenerate!(self); // spawn id 1 → blocked → held
    def.des!.onGenerate!(self); // still blocked + already held → retries the SAME MU, no new spawn
    expect(self.transfers).toHaveLength(0);
    // Free the downstream and pull: the transferred MU must be id 1 — proof that
    // no second MU was minted while one was pending (id 2 would mean a flood).
    (self as unknown as { downstreamCanAccept: () => boolean }).downstreamCanAccept = () => true;
    def.des!.onDownstreamReady!(self, undefined as never);
    expect(self.transfers).toHaveLength(1);
    expect(self.transfers[0].mu.id).toBe(1);
  });

  it('resumes on onDownstreamReady once the downstream frees up (pull)', () => {
    const def = getMaterialFlow('Source')!;
    const out = fakePort('line-in');
    const self = makeMockSelf({ kind: 'source', type: 'Source', outputs: [out], canAccept: false });
    def.des!.onGenerate!(self);               // blocked → held, no transfer
    expect(self.transfers).toHaveLength(0);

    // Downstream frees up → pull resumes.
    (self as unknown as { downstreamCanAccept: () => boolean }).downstreamCanAccept = () => true;
    def.des!.onDownstreamReady!(self, undefined as never);

    expect(self.transfers).toHaveLength(1);
    expect(self.transfers[0].from).toBe(out);
    expect(self.schedules).toHaveLength(1);
    expect(self.schedules[0].hook).toBe('Generate');
  });
});

// ─── Sink.des.onAccept ───────────────────────────────────────────────────────

describe('Sink — des.onAccept', () => {
  it('destroys the MU, publishes Flow.Occupied=false, and accepts', () => {
    const def = getMaterialFlow('Sink')!;
    const self = makeMockSelf({ kind: 'sink', type: 'Sink' });
    const mu: MU = { id: 9, prop: {} };

    const accepted = def.des!.onAccept!(self, mu);

    expect(accepted).toBe(true);
    expect(mu.prop!['consumed']).toBe(true);
    expect(self.writes.get('Flow.Occupied')).toBe(false);
  });

  it('flags the visual for removal when present (RVSink interop)', () => {
    const def = getMaterialFlow('Sink')!;
    const self = makeMockSelf({ kind: 'sink', type: 'Sink' });
    const visual = { markedForRemoval: false };
    const mu: MU = { id: 10, prop: {}, visual };
    def.des!.onAccept!(self, mu);
    expect(visual.markedForRemoval).toBe(true);
  });
});

// ─── Continuous blocks are INERT (no double-spawn / double-destroy) ──────────

describe('Source / Sink — continuous blocks are inert (no double effect)', () => {
  it('Source.continuous registers no fixedUpdate (engine RVSource owns spawning)', () => {
    const def = getMaterialFlow('Source')!;
    expect(def.continuous.fixedUpdate).toBeUndefined();
  });

  it('Sink.continuous registers no fixedUpdate (engine RVSink owns consumption)', () => {
    const def = getMaterialFlow('Sink')!;
    expect(def.continuous.fixedUpdate).toBeUndefined();
  });

  it('binding Source spawns nothing and ticks no fixedUpdate', () => {
    const root = new Object3D(); root.name = 'Source';
    const { host } = makeHost(root);
    const { ctx, handle } = createBindContext(root, host, {});
    const children = root.children.length;
    SourceBehavior.bind(ctx);
    // No fixedUpdate registered → ticking is a pure no-op (no spawned children).
    iterateFixedUpdate(handle, 1 / 60);
    iterateFixedUpdate(handle, 1 / 60);
    expect(root.children.length).toBe(children); // nothing spawned under the source
  });

  it('binding Sink publishes the successor-clear interlock, destroys nothing', () => {
    const root = new Object3D(); root.name = 'Sink';
    root.userData.realvirtual = { LayoutObject: { Label: 'Sink', CatalogId: 'c', Locked: false } };
    const { host, values } = makeHost(root);
    const { ctx, handle } = createBindContext(root, host, {});
    SinkBehavior.bind(ctx);
    // setup() published Occupied=false so an upstream conveyor discharges into the sink.
    expect(values.get('Sink.Flow.Occupied')).toBe(false);
    // Ticking does nothing (no fixedUpdate) — no MU handling on the continuous path.
    iterateFixedUpdate(handle, 1 / 60);
    expect(values.get('Sink.Flow.Occupied')).toBe(false);
  });
});
