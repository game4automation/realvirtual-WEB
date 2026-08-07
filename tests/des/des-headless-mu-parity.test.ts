// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-headless-mu-parity.test.ts — plan-262 Phase 3 (headless MUs in
 * FastForward) + R5 (Turntable ride paths without a visual).
 *
 * The determinism gate of the phase: with the SAME seed and duration, a
 * FastForward run whose MUs spawn HEADLESS (`visual === null`, production
 * spawn gate `runner.headlessSpawnActive`) must produce results IDENTICAL to a
 * run whose MUs carry visuals —
 *  (a) a line with the REAL Turntable des hooks (ride-on / ride-off derive
 *      event TIMES from MU positions — the R5 gate: before the fix a null
 *      visual read the world origin and corrupted the ride times);
 *      identical totalEventsProcessed, identical hook order incl. event
 *      times, identical statistics();
 *  (b) FF-exit materialisation: every WIP MU gets a visual at the
 *      tween-correct position (quantitative, compared against the visual
 *      run's part positions per customId);
 *  (c) sink consume of a headless MU retires the slot (no leak);
 *  (d) snapshot JSON round-trip with `visual === null` MUs (the existing
 *      rv-des-snapshot tests never exercise the visual slot).
 *
 * Runs only in the private build (imports `@rv-private/plugins/des/*`).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Vector3, Mesh, BoxGeometry } from 'three';
import { DESRunner } from '@rv-private/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv-private/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv-private/plugins/des/rv-des-mu';
import type { DESMU } from '@rv-private/plugins/des/rv-des-mu';
import type { MaterialFlowAdapter } from '@rv-private/plugins/des/material-flow-adapter';
import { TurntableFlow } from '../../src/behaviors/Turntable';
import { schedulePositionMove } from '../../src/behaviors/_shared/drive-des';
import {
  setMuForward,
  muBugOffset,
  presetMuBugSize,
  measureMuVisualBugSize,
} from '../../src/behaviors/_shared/mu-reference';
import { registerEngineSourceForNode, type RVSource } from '../../src/core/engine/rv-source';
import {
  createSelf,
  type MaterialFlowSelf,
  type MU,
  type Port,
} from '../../src/core/material-flow/material-flow-self';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../src/core/material-flow/define-material-flow';
import { _resetMaterialFlowRegistry } from '../../src/core/material-flow/registry';
import {
  createBindContext,
  type BindContextHost,
  type KinematicsSpec,
  type RVBindContext,
} from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';

// ─── Shared fixtures ────────────────────────────────────────────────────────

/** The MU template size (world m); bug offset = half the +Z dim = 0.2. */
const TEMPLATE_SIZE = [0.4, 0.3, 0.4] as const;

interface FakeVisual {
  node: Object3D;
  isInstanced: boolean;
  markedForRemoval: boolean;
  disposed: boolean;
  setPosition(v: Vector3): void;
  dispose(): void;
}

/** An RVMovingUnit-shaped fake with real box geometry (bug measurement works). */
function makeVisual(): FakeVisual {
  const node = new Object3D();
  node.add(new Mesh(new BoxGeometry(TEMPLATE_SIZE[0], TEMPLATE_SIZE[1], TEMPLATE_SIZE[2])));
  node.updateMatrixWorld(true);
  return {
    node,
    isInstanced: false,
    markedForRemoval: false,
    disposed: false,
    setPosition(v: Vector3): void {
      this.node.position.copy(v);
      this.node.updateMatrixWorld(true);
    },
    dispose(): void {
      this.disposed = true;
    },
  };
}

function makeBindContext(root: Object3D): RVBindContext {
  const events = new EventEmitter<Record<string, unknown>>();
  const values = new Map<string, boolean | number>();
  const host: BindContextHost = {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => values.set(n, v),
      subscribe: () => () => {},
    } as never,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [] as never,
    registry: null,
    getPlugin: () => undefined,
  };
  const accum: KinematicsSpec = {};
  const { ctx } = createBindContext(root, host, accum);
  return ctx;
}

/** A port with an owner root + own snap node (router-test style). */
function makePort(
  id: string,
  role: 'input' | 'output',
  ownerRoot: Object3D,
  snapNode: Object3D,
): Port {
  return {
    id,
    role,
    ownerRoot,
    snapNode,
    ownerComponent: null,
    mySnapId: `tt-${id}`,
    partnerSnapId: id,
    partnerRoot: ownerRoot,
    partnerComponent: null,
    occupied: () => false,
    upstreamWaiting: () => false,
    setOccupied: () => {},
  } as unknown as Port;
}

function resetWorld(): void {
  _resetMaterialFlowRegistry();
  _resetDesHookCache();
  resetDESMUCounter();
}

beforeEach(resetWorld);

// ─── (a) Turntable line parity (the R5 gate) ────────────────────────────────

const TT_SEED = 42;
const TT_SPAWN_INTERVAL_S = 20;
const TT_DURATION_S = 41; // spawns at 0 / 20 / 40 → one MU is WIP at the end

interface TurntableRunResult {
  done: boolean;
  totalEventsProcessed: number;
  simTime: number;
  log: string[];
  consumed: number;
  statistics: unknown;
  runner: DESRunner;
  liveMUs: DESMU[];
}

/**
 * Source → REAL Turntable des hooks → Sink through the private DESRunner
 * (real event queue, real tween registry, real ride timing). `headless`
 * switches the production spawn gate (`runner.headlessSpawnActive`) on; the
 * control run always spawns visuals — everything else is identical.
 */
async function runTurntableLine(headless: boolean): Promise<TurntableRunResult> {
  resetWorld();

  const runner = new DESRunner({
    subMode: 'fastforward',
    durationSeconds: TT_DURATION_S,
    masterSeed: TT_SEED,
  });
  const log: string[] = [];
  const t = (): string => runner.simTime.toFixed(6);

  // Static geometry: rotary at the origin, input snap −Z, output snap +X.
  const scene = new Object3D();
  const rotary = new Object3D();
  rotary.name = 'Drive-Rot-Y';
  scene.add(rotary);
  const inSnap = new Object3D();
  inSnap.position.set(0, 0, -1);
  const outSnap = new Object3D();
  outSnap.position.set(1.5, 0, 0);
  scene.add(inSnap);
  scene.add(outSnap);
  scene.updateMatrixWorld(true);

  const srcRoot = new Object3D(); srcRoot.name = 'ParitySource1';
  const ttRoot = new Object3D(); ttRoot.name = 'Turntable1';
  const sinkRoot = new Object3D(); sinkRoot.name = 'ParitySink1';

  // ── Source def (spawns at the belt hand-off point, +Z heading) ──
  const sourceDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'ParitySource', kind: 'source', schema: {}, continuous: {},
    des: {
      onGenerate(self) {
        log.push(`src.gen@${t()}`);
        const mu = self.spawn();
        setMuForward(mu, 0, 1); // travelling +Z toward the turntable input snap
        const bug = muBugOffset(mu); // template-preset → identical both runs
        const node = (mu as { visual?: { node?: Object3D } | null }).visual?.node;
        if (node) {
          // The visual sits one bug-offset behind the entry snap — exactly
          // where a belt transit tween would have delivered it.
          node.position.set(0, 0, -1 - bug);
          node.updateMatrixWorld(true);
        }
        self.transfer(mu);
        self.in(TT_SPAWN_INTERVAL_S, 'Generate', null);
      },
    },
  }) as MaterialFlowDefinition;

  // ── Sink def ──
  let consumed = 0;
  const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'ParitySink', kind: 'sink', schema: {}, continuous: {},
    des: {
      onAccept(_self, mu) {
        log.push(`sink.accept@${t()}`);
        consumed++;
        const visual = (mu as { visual?: { markedForRemoval?: boolean } | null }).visual;
        if (visual) visual.markedForRemoval = true;
        return true;
      },
    },
  }) as MaterialFlowDefinition;

  // ── REAL Turntable des hooks, wrapped for the event-order log ──
  const ttDes = TurntableFlow.des;
  const ttDef = {
    ...TurntableFlow,
    setup: undefined,
    continuous: {},
    des: {
      ...ttDes,
      onAccept: (self: never, mu: never, port: never) => {
        log.push(`tt.accept@${t()}`);
        return ttDes.onAccept(self, mu, port);
      },
      onArrival: (self: never, mu: never) => {
        log.push(`tt.arrival@${t()}`);
        return ttDes.onArrival(self, mu);
      },
      onRotateComplete: (self: never, mu: never) => {
        log.push(`tt.rotate@${t()}`);
        return ttDes.onRotateComplete(self, mu);
      },
    },
  } as unknown as MaterialFlowDefinition;

  // ── Instances ──
  let srcAdapter: MaterialFlowAdapter;
  let ttAdapter: MaterialFlowAdapter;
  let sinkAdapter: MaterialFlowAdapter;

  const sourceSelf = createSelf(makeBindContext(srcRoot), sourceDef, {
    mode: 'des',
    scheduler: runner.makeScheduler(sourceDef, () => srcAdapter.entityId),
    onTransfer: (mu: MU) => runner.makeTransfer(srcAdapter)(mu),
    canAcceptDownstream: (mu: MU) => srcAdapter.nextComponents.some(c => c.canAccept(mu as never)),
    // The PRODUCTION spawn wiring (des-scene-binding): gate the mesh on
    // runner.headlessSpawnActive, pre-set the template bug size for BOTH paths.
    spawnMU: () => {
      const mu = runner.createMU();
      if (!headless || !runner.headlessSpawnActive) {
        (mu as unknown as { visual: unknown }).visual = makeVisual();
      }
      presetMuBugSize(mu as unknown as MU, TEMPLATE_SIZE);
      return mu;
    },
  });
  srcAdapter = runner.addInstance(sourceDef, sourceSelf, srcRoot);

  // Fake-but-complete Turntable self: the def's OWN state factory plus the
  // runner's REAL scheduler/transfer — so ride tweens, event times and the
  // handshake all run through the real engine (no FSM fake).
  const inPort = makePort('in', 'input', srcRoot, inSnap);
  const outPort = makePort('out', 'output', sinkRoot, outSnap);
  const local = (TurntableFlow.state as unknown as () => Record<string, unknown>)();
  local.rotaryNode = rotary;
  local.beltCalibrated = true;
  let ttState = 'idle';
  const ttSched = runner.makeScheduler(ttDef, () => ttAdapter.entityId);
  const boolSig = { get: () => true, set: () => {} };
  const ttSelf = {
    type: 'Turntable',
    kind: 'router',
    root: ttRoot,
    local,
    prop: { RotationSpeed: 90, MaxCapacity: 1, alignedPort: null } as Record<string, unknown>,
    get state() { return ttState; },
    setState(n: string) { ttState = n; },
    statState(n: string) { ttAdapter.setState(n); },
    get currentLoad() { return ttAdapter.currentLoad; },
    get mus() { return [] as MU[]; },
    signals: { get: () => undefined, set: () => {}, on: () => {} },
    sig: { Run: boolSig, Occupied: boolSig, Running: boolSig, PartCount: boolSig },
    inputs: () => [inPort],
    outputs: () => [outPort],
    freeOutputs: () => [outPort],
    in: (d: number, h: string, mu?: MU | null, data?: unknown) => ttSched.in(d, h as never, mu, data),
    at: (tm: number, h: string, mu?: MU | null, data?: unknown) => ttSched.at(tm, h as never, mu, data),
    cancel: (id: number) => ttSched.cancel(id),
    get now() { return ttSched.now; },
    transfer: (mu: MU) => runner.makeTransfer(ttAdapter)(mu),
  } as unknown as MaterialFlowSelf;
  ttAdapter = runner.addInstance(ttDef, ttSelf, ttRoot);

  const sinkSelf = createSelf(makeBindContext(sinkRoot), sinkDef, {
    mode: 'des',
    scheduler: runner.makeScheduler(sinkDef, () => sinkAdapter.entityId),
  });
  sinkAdapter = runner.addInstance(sinkDef, sinkSelf, sinkRoot);

  // Line topology: Source → Turntable → Sink.
  srcAdapter.nextComponents = [ttAdapter];
  ttAdapter.previousComponents = [srcAdapter];
  ttAdapter.nextComponents = [sinkAdapter];
  sinkAdapter.previousComponents = [ttAdapter];

  // Materialisation resolves its visual factory via the engine-source map.
  registerEngineSourceForNode(srcRoot, { spawnMU: () => makeVisual() } as unknown as RVSource);

  runner.start([sourceDef, ttDef, sinkDef], { root: new Object3D() });

  const done = await runner.runFastForward();

  const manager = runner.getManager();
  const liveMUs: DESMU[] = [];
  for (let i = 0; i < manager.muCount; i++) {
    const mu = manager.getMU(i) as DESMU | null;
    if (mu && !mu.retired) liveMUs.push(mu);
  }

  return {
    done,
    totalEventsProcessed: manager.totalEventsProcessed,
    simTime: runner.simTime,
    log,
    consumed,
    statistics: runner.statistics(),
    runner,
    liveMUs,
  };
}

describe('DES headless-MU parity — Turntable line (plan-262 Phase 3 / R5)', () => {
  it('FF-headless vs FF-visual: identical event count, order (incl. times), KPIs', async () => {
    const visual = await runTurntableLine(false);
    const headless = await runTurntableLine(true);

    // Both runs completed and actually flowed parts through the router.
    expect(visual.done).toBe(true);
    expect(headless.done).toBe(true);
    expect(visual.consumed).toBeGreaterThan(0);

    // The headless run really was headless: MUs spawned without a visual …
    expect(headless.liveMUs.length).toBeGreaterThan(0);
    // (before materialisation — runFastForward keeps sub-mode 'fastforward')
    expect(headless.liveMUs.every(mu => mu.visual === null)).toBe(true);
    // … while the visual run's WIP MUs all carry one.
    expect(visual.liveMUs.every(mu => mu.visual !== null)).toBe(true);

    // The R5 determinism gate: identical event counts, identical hook ORDER
    // including the EVENT TIMES (ride times feed the next event time — the
    // world-origin bug produced different times here), identical statistics.
    expect(headless.totalEventsProcessed).toBe(visual.totalEventsProcessed);
    expect(headless.simTime).toBeCloseTo(visual.simTime, 9);
    expect(headless.log).toEqual(visual.log);
    expect(headless.consumed).toBe(visual.consumed);
    expect(headless.statistics).toEqual(visual.statistics);

    // FF exit materialises every WIP MU (visual spawned via the engine-source map).
    headless.runner.setSubMode('animated');
    for (const mu of headless.liveMUs) {
      if (mu.retired) continue;
      expect(mu.visual).not.toBeNull();
    }

    visual.runner.dispose();
    headless.runner.dispose();
  }, 60_000);
});

// ─── (b) Materialisation position parity (tween-window interpolation) ───────

const BELT_SPAWN_INTERVAL_S = 4;
const BELT_TRANSIT_S = 10;
const BELT_DURATION_S = 21;

interface BeltRunResult {
  done: boolean;
  totalEventsProcessed: number;
  consumed: number;
  runner: DESRunner;
  /** customId → live MU (non-retired). */
  live: Map<string, DESMU>;
}

/** Source → straight 10 s position-tween belt → Sink; WIP MUs mid-tween at end.
 *  `registerSource = false` leaves the engine-source map empty, so a restore /
 *  materialisation has NO visual factory (MUs stay headless). */
async function runBeltLine(headless: boolean, registerSource = true): Promise<BeltRunResult> {
  resetWorld();

  const runner = new DESRunner({
    subMode: 'fastforward',
    durationSeconds: BELT_DURATION_S,
    masterSeed: 7,
  });

  const srcRoot = new Object3D(); srcRoot.name = 'BeltSource1';
  const beltRoot = new Object3D(); beltRoot.name = 'Belt1';
  const sinkRoot = new Object3D(); sinkRoot.name = 'BeltSink1';

  const sourceDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'BeltSource', kind: 'source', schema: {}, continuous: {},
    des: {
      onGenerate(self) {
        const mu = self.spawn();
        self.transfer(mu);
        self.in(BELT_SPAWN_INTERVAL_S, 'Generate', null);
      },
    },
  }) as MaterialFlowDefinition;

  // A straight ride 0→10 m in +X over BELT_TRANSIT_S — the tween window the
  // materialisation interpolates.
  const beltDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'ParityBelt', kind: 'conveyor', schema: {}, continuous: {},
    des: {
      onAccept(self, mu) {
        schedulePositionMove(self, {
          target: (mu as { visual?: unknown }).visual ?? null,
          from: [0, 0, 0],
          to: [10, 0, 0],
          time: BELT_TRANSIT_S,
        }, 'Arrival', mu);
        return true;
      },
      onArrival(self, mu) { if (mu) self.transfer(mu); },
    },
  }) as MaterialFlowDefinition;

  let consumed = 0;
  const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'BeltSink', kind: 'sink', schema: {}, continuous: {},
    des: {
      onAccept(_self, mu) {
        consumed++;
        const visual = (mu as { visual?: { markedForRemoval?: boolean } | null }).visual;
        if (visual) visual.markedForRemoval = true;
        return true;
      },
    },
  }) as MaterialFlowDefinition;

  const adapters: MaterialFlowAdapter[] = [];
  const idAt = (i: number) => () => adapters[i].entityId;
  const add = (def: MaterialFlowDefinition, root: Object3D, index: number, extra?: Record<string, unknown>): void => {
    const self = createSelf(makeBindContext(root), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def, idAt(index)),
      onTransfer: (mu: MU) => runner.makeTransfer(adapters[index])(mu),
      canAcceptDownstream: (mu: MU) => adapters[index].nextComponents.some(c => c.canAccept(mu as never)),
      ...(extra ?? {}),
    });
    adapters.push(runner.addInstance(def, self, root));
  };

  add(sourceDef, srcRoot, 0, {
    spawnMU: () => {
      const mu = runner.createMU();
      if (!headless || !runner.headlessSpawnActive) {
        (mu as unknown as { visual: unknown }).visual = makeVisual();
      }
      presetMuBugSize(mu as unknown as MU, TEMPLATE_SIZE);
      return mu;
    },
  });
  add(beltDef, beltRoot, 1);
  add(sinkDef, sinkRoot, 2);

  adapters[1].MaxCapacity = 99; // parallel transit — no back-pressure in this model
  for (let i = 0; i < adapters.length - 1; i++) {
    adapters[i].nextComponents = [adapters[i + 1]];
    adapters[i + 1].previousComponents = [adapters[i]];
  }
  if (registerSource) {
    registerEngineSourceForNode(srcRoot, { spawnMU: () => makeVisual() } as unknown as RVSource);
  }

  runner.start([sourceDef, beltDef, sinkDef], { root: new Object3D() });
  const done = await runner.runFastForward();

  const manager = runner.getManager();
  const live = new Map<string, DESMU>();
  for (let i = 0; i < manager.muCount; i++) {
    const mu = manager.getMU(i) as DESMU | null;
    if (mu && !mu.retired) live.set(mu.customId, mu);
  }
  return { done, totalEventsProcessed: manager.totalEventsProcessed, consumed, runner, live };
}

describe('DES headless-MU materialisation — tween-correct positions', () => {
  it('FF exit gives every WIP MU a visual at the interpolated tween position (== visual-run position)', async () => {
    const visual = await runBeltLine(false);
    const headless = await runBeltLine(true);

    expect(visual.done).toBe(true);
    expect(headless.done).toBe(true);
    expect(headless.totalEventsProcessed).toBe(visual.totalEventsProcessed);
    expect(headless.consumed).toBe(visual.consumed);

    // WIP exists and is headless before the exit.
    expect(headless.live.size).toBeGreaterThanOrEqual(2);
    expect([...headless.live.values()].every(mu => mu.visual === null)).toBe(true);

    // Leave FF on BOTH runs — visual run settles, headless run materialises.
    const simEnd = headless.runner.simTime;
    visual.runner.setSubMode('animated');
    headless.runner.setSubMode('animated');

    for (const [customId, mu] of headless.live) {
      expect(mu.visual).not.toBeNull();
      const matNode = (mu.visual as unknown as FakeVisual).node;

      // Quantitative: x = elapsed transit fraction × 10 m (tolerance 1e-3).
      const expectedX = Math.min(10, Math.max(0, simEnd - mu.creationTime));
      expect(matNode.position.x).toBeCloseTo(expectedX, 3);

      // Parity: identical to the visual run's part position (per customId).
      const twin = visual.live.get(customId);
      expect(twin).toBeDefined();
      const twinNode = (twin!.visual as unknown as FakeVisual).node;
      expect(matNode.position.x).toBeCloseTo(twinNode.position.x, 3);
      expect(matNode.position.y).toBeCloseTo(twinNode.position.y, 3);
      expect(matNode.position.z).toBeCloseTo(twinNode.position.z, 3);
    }

    // The re-connected tween keeps ANIMATING the materialised visual: one
    // animated tick moves it forward along the ride (seamless continuation).
    // Take the YOUNGEST MU (largest remaining transit) so the tick stays
    // inside its window.
    const sample = [...headless.live.values()]
      .reduce((a, b) => (a.creationTime > b.creationTime ? a : b));
    const nodeX = (): number => (sample.visual as unknown as FakeVisual).node.position.x;
    const before = nodeX();
    headless.runner.tick(1.0);
    headless.runner.lateTick(1.0);
    expect(nodeX()).toBeGreaterThan(before + 0.5);

    visual.runner.dispose();
    headless.runner.dispose();
  }, 60_000);

  it('template bug-size preset equals the per-visual measurement (parity of muBugOffset)', () => {
    // The preset the production binding caches per source template …
    const measured = measureMuVisualBugSize(makeVisual().node);
    expect(measured).not.toBeNull();
    expect(measured![0]).toBeCloseTo(TEMPLATE_SIZE[0], 6);
    expect(measured![2]).toBeCloseTo(TEMPLATE_SIZE[2], 6);

    // … gives a HEADLESS MU exactly the offset a visual MU measures itself.
    const headlessMu = { id: 1 } as unknown as MU;
    presetMuBugSize(headlessMu, measured);
    const visualMu = { id: 2, visual: { node: makeVisual().node } } as unknown as MU;
    expect(muBugOffset(headlessMu)).toBeCloseTo(muBugOffset(visualMu), 9);
    expect(muBugOffset(headlessMu)).toBeCloseTo(TEMPLATE_SIZE[2] / 2, 6);
  });
});

// ─── (c) Sink consume of a headless MU → slot recycling ─────────────────────

describe('DES headless-MU sink consume — slot recycling (no leak)', () => {
  it('retires a consumed headless MU and reuses its slot id', () => {
    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'HeadlessSink', kind: 'sink', schema: {}, continuous: {},
      des: {
        onAccept(_self, mu) {
          const visual = (mu as { visual?: { markedForRemoval?: boolean } | null }).visual;
          if (visual) visual.markedForRemoval = true; // headless: stays null — must not throw
          return true;
        },
      },
    }) as MaterialFlowDefinition;

    const runner = new DESRunner({ subMode: 'animated' });
    const node = new Object3D(); node.name = 'HeadlessSink1';
    let adapter: MaterialFlowAdapter;
    const self = createSelf(makeBindContext(node), def, {
      mode: 'des',
      scheduler: runner.makeScheduler(def, () => adapter.entityId),
    });
    adapter = runner.addInstance(def, self, node);
    runner.start([def], { root: node });

    const manager = runner.getManager();
    for (let i = 0; i < 500; i++) {
      const mu = runner.createMU(); // visual === null (headless)
      expect(mu.visual).toBeNull();
      expect(adapter.acceptMU(mu as never)).toBe(true);
      runner.lateTick(0.016); // sweep → retire (null-safe path)
    }
    // 500 produced + consumed headless, never more than 1 alive → slots recycled.
    expect(manager.muCount).toBeLessThanOrEqual(2);
    runner.dispose();
  });
});

// ─── (d) Snapshot round-trip with visual === null MUs ───────────────────────

describe('DES headless-MU snapshot — JSON round-trip with visual === null', () => {
  it('serialises and restores headless MUs (no crash, state preserved, visual stays null)', async () => {
    // registerSource=false → NO engine-source visual factory: the restored MUs
    // must come back HEADLESS through the same muFactory the UI restore uses.
    const run = await runBeltLine(true, false); // headless FF run with WIP
    const runner = run.runner;
    expect(run.live.size).toBeGreaterThan(0);
    expect([...run.live.values()].every(mu => mu.visual === null)).toBe(true);

    const beforeIds = [...run.live.values()].map(mu => mu.id).sort((a, b) => a - b);
    const beforeTime = runner.simTime;
    const beforeProps = new Map(
      [...run.live.values()].map(mu => [mu.id, { customId: mu.customId, creationTime: mu.creationTime }]),
    );

    // Full JSON round-trip (the string transport the Save/Load UI uses).
    const json = runner.snapshotJson();
    expect(() => JSON.parse(json)).not.toThrow();

    runner.restoreJson(json);

    const manager = runner.getManager();
    expect(runner.simTime).toBeCloseTo(beforeTime, 9);

    const restored: DESMU[] = [];
    for (let i = 0; i < manager.muCount; i++) {
      const mu = manager.getMU(i) as DESMU | null;
      if (mu && !mu.retired) restored.push(mu);
    }
    expect(restored.map(mu => mu.id).sort((a, b) => a - b)).toEqual(beforeIds);
    for (const mu of restored) {
      const prev = beforeProps.get(mu.id)!;
      expect(mu.customId).toBe(prev.customId);
      expect(mu.creationTime).toBeCloseTo(prev.creationTime, 9);
      expect(mu.visual).toBeNull(); // no visual factory → stays headless
    }

    runner.dispose();
  }, 60_000);
});
