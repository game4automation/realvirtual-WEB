// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-source-pose-handover.test.ts — plan-638: a generic `Source` lying ON its
 * belt (`contained` link, plan-633) hands its MU over AT the spawn pose
 * (plan-631 pose API) instead of letting it jump to the belt entry.
 *
 * Everything runs through the production path: `bindSceneToRunner` (topology,
 * contained link, the pose backend) → the real `Source` / `Conveyor` / `Sink`
 * definitions on a real `DESRunner`, the MU visual cloned by a real engine
 * `RVSource`. Runs are bounded by step counts and SIM time, never wall clock.
 *
 *  9.1  free belt: the first tween pose IS the spawn pose (≤ 2 mm), rest time (L − s)/v
 *  9.2  belt occupied: nothing spawned, nothing pending; the wake spawns exactly one
 *  9.3  roll-back / repeated refusal: one spawn, one production, one output (R1 #7)
 *  9.4  fallbacks (target without acceptsPose, async accept, source Processing,
 *       no template size): standard transfer + exactly one Problems info
 *  9.5  regression: no contained link → no pose call at all; continuous self
 *  9.6  Animated ≡ FastForward; reset and rebind keep the pose path
 *  R1 #2 / R2-2 / R2-3  pending state machine, path switch, re-entrancy, exception
 *  R1 #4 / R3-1  loop saturation, disabled source, quantity limit → blocked
 *  R3-1 / R3-2  standard headless-first unchanged; templateSize() has no side effect
 *  Spike C2–C5, C7b  templateSizeOf == clone measurement (`_bugSize`)
 *
 * Imports `@rv/plugins/des/*` — DES is core code since plan-680.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  Object3D, Mesh, BoxGeometry, MeshStandardMaterial, Scene, Vector3,
} from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { bindSceneToRunner, containedTargetOf } from '@rv/plugins/des/des-scene-binding';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { resetDESMUCounter, type DESMU } from '@rv/plugins/des/rv-des-mu';
import { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import Source from '../src/behaviors/Source';
import Sink from '../src/behaviors/Sink';
import { ConveyorFlow } from '../src/behaviors/Conveyor';
import {
  _resetMaterialFlowRegistry,
  getMaterialFlow,
  registerMaterialFlow,
} from '../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../src/core/material-flow/define-material-flow';
import { createSelf, type MU } from '../src/core/material-flow/material-flow-self';
import { createBindContext, type BindContextHost, type KinematicsSpec } from '../src/core/behavior-runtime';
import { EventEmitter } from '../src/core/rv-events';
import { ContextMenuStore } from '../src/core/hmi/context-menu-store';
import { SignalStore } from '../src/core/engine/rv-signal-store';
import { RVSource, registerEngineSourceForNode } from '../src/core/engine/rv-source';
import { measureMuVisualBugSize, templateSizeOf } from '../src/behaviors/_shared/mu-reference';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { getProblems, resetProblemsForTests } from '../src/core/hmi/problems-store';

void Source; void Sink;

type V3 = [number, number, number];

// ─── Definitions ────────────────────────────────────────────────────────────

const SourceDef = getMaterialFlow('Source')!;
const SinkDef = getMaterialFlow('Sink')!;
const ConveyorDef = ConveyorFlow as unknown as MaterialFlowDefinition;
/** A conveyor type WITHOUT `des.acceptsPose` (9.4 `pose-unsupported`). */
const PlainConveyorDef = {
  ...ConveyorFlow,
  type: 'PlainConveyor',
  models: ['*PlainConveyor*'],
  des: { ...ConveyorFlow.des, acceptsPose: false },
} as unknown as MaterialFlowDefinition;
/** A conveyor that defers its accept (Processing at `accept`, 9.4 `async-accept`). */
const AsyncConveyorDef = {
  ...ConveyorFlow,
  type: 'AsyncConveyor',
  models: ['*AsyncConveyor*'],
  processingAttachmentPoint: 'accept',
} as unknown as MaterialFlowDefinition;

const DEFS: MaterialFlowDefinition[] = [SourceDef, SinkDef, ConveyorDef, PlainConveyorDef, AsyncConveyorDef];

function resetWorld(): void {
  _resetMaterialFlowRegistry();
  for (const d of DEFS) registerMaterialFlow(d);
  _resetDesHookCache();
  resetDESMUCounter();
  resetProblemsForTests();
}

// ─── Scene (metres; belts flow along local +Z, roller top at y = 0.1) ────────

const BELT_LENGTH = 1.6;
const BELT_TOP = 0.1;
const SPEED_MM_S = 500;
/** Pallet template: deck 1.2 × 0.14 × 0.8 + carton; origin = underside centre. */
const PALLET_SIZE: V3 = [1.2, 0.74, 0.8];
const BUG = PALLET_SIZE[2] / 2;

interface SceneOpts {
  /** Source position (world, origin of the MU). Default: on the belt, z = −0.3. */
  sourceAt?: V3;
  /** Type of the belt the source lies on. */
  beltType?: 'Conveyor' | 'PlainConveyor' | 'AsyncConveyor';
  /** Engine RVSource for the source node (the MU template). Default true. */
  engine?: boolean;
  /** Extra conveyors (loop-saturation zones), placed far away, unconnected. */
  extraBelts?: number;
  /** Yaw (rad) and offset of the whole line — the parent transform. */
  lineYaw?: number;
  lineOffset?: V3;
}

interface Built {
  scene: Scene;
  line: Object3D;
  host: BindContextHost;
  source: Object3D;
  belt: Object3D;
  sink: Object3D;
  engine: RVSource | null;
}

function belt(parent: Object3D, drives: unknown[], name: string, type: string, z: number, x = 0): Object3D {
  const root = new Object3D();
  root.name = name;
  root.position.set(x, 0, z);
  root.userData.realvirtual = { [type]: {} };
  const b = new Mesh(new BoxGeometry(0.9, 0.1, BELT_LENGTH));
  b.name = 'Transport-Z';
  b.position.set(0, 0.05, 0);
  root.add(b);
  // Side guides: the conveyor's AABB reaches above the pallet centre, as on a real
  // roller conveyor with guide rails — the source centre lies INSIDE (contained).
  for (const side of [-0.48, 0.48]) {
    const g = new Mesh(new BoxGeometry(0.04, 0.9, BELT_LENGTH));
    g.name = 'Guide';
    g.position.set(side, 0.45, 0);
    root.add(g);
  }
  const s = new Object3D(); s.name = 'Sensor'; root.add(s);
  parent.add(root);
  drives.push({ name: 'Transport-Z', node: b, TargetSpeed: SPEED_MM_S });
  return root;
}

function palletMeshes(root: Object3D): void {
  const deck = new Mesh(new BoxGeometry(1.2, 0.14, 0.8), new MeshStandardMaterial());
  deck.name = 'Deck';
  deck.position.set(0, 0.07, 0);
  const box = new Mesh(new BoxGeometry(0.6, 0.6, 0.6), new MeshStandardMaterial());
  box.name = 'Carton';
  box.position.set(0, 0.44, 0);
  root.add(deck, box);
}

function buildScene(o: SceneOpts = {}): Built {
  const scene = new Scene();
  const line = new Object3D();
  line.name = 'Line';
  if (o.lineYaw) line.rotation.y = o.lineYaw;
  if (o.lineOffset) line.position.set(...o.lineOffset);
  scene.add(line);
  const drives: unknown[] = [];
  const beltRoot = belt(line, drives, 'Conveyor_1', o.beltType ?? 'Conveyor', 0);
  for (let i = 0; i < (o.extraBelts ?? 0); i++) belt(line, drives, `Conveyor_X${i}`, 'Conveyor', 0, 20 + 5 * i);

  const source = new Object3D();
  source.name = 'PalletSource';
  source.userData.realvirtual = { Source: { AutomaticGeneration: true, Interval: 0 } };
  const at = o.sourceAt ?? [0, BELT_TOP, -0.3];
  source.position.set(...at);
  palletMeshes(source);
  line.add(source);

  const sink = new Object3D();
  sink.name = 'Sink_1';
  sink.userData.realvirtual = { Sink: {} };
  sink.position.set(0, 0, 1.0);
  const sb = new Mesh(new BoxGeometry(0.4, 0.4, 0.4));
  sb.name = 'SinkBody';
  sink.add(sb);
  line.add(sink);

  scene.updateMatrixWorld(true);
  let engine: RVSource | null = null;
  if (o.engine !== false) {
    engine = new RVSource(source);
    engine.ThisObjectAsMU = source.name;
    (engine as unknown as { sourceIsTemplate: boolean }).sourceIsTemplate = true;
    engine.spawnParent = scene;
    engine.setTemplate(source);
    registerEngineSourceForNode(source, engine);
  }
  // Deterministic uuids (the resolver tie-breaks by uuid).
  let i = 0;
  scene.traverse((n) => { n.uuid = `00000000-0000-4000-8638-${String(i++).padStart(12, '0')}`; });

  const events = new EventEmitter<Record<string, unknown>>();
  const host = {
    signalStore: new SignalStore(),
    on: (e: string, cb: (...args: unknown[]) => void) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives,
    registry: null,
    getPlugin: () => undefined,
  } as unknown as BindContextHost;
  return { scene, line, host, source, belt: beltRoot, sink, engine };
}

// ─── Run harness ────────────────────────────────────────────────────────────

interface Rig {
  b: Built;
  runner: DESRunner;
  /** Accepted hand-overs `t:mu>node`, in event order (all adapters). */
  trace: string[];
  /** Number of `runner.createMU` calls (spawns) so far. */
  spawnCalls: () => number;
  adapter(name: string): MaterialFlowAdapter;
  self(name: string): { local: Record<string, unknown>; poseReadiness(): unknown };
  /** Advance the animated clock in fixed steps until `pred` or `maxSteps`. */
  stepUntil(pred: () => boolean, maxSteps: number, dt?: number): number;
  dispose(): void;
}

let accSpy: { mockRestore(): void } | null = null;
const traceSink: {
  t: () => number;
  out: string[] | null;
  objs: Array<{ mu: DESMU; node: string }> | null;
} = { t: () => 0, out: null, objs: null };
/** How often exactly THIS MU object was accepted by `node` (MU ids are recycled). */
const acceptsOf = (mu: unknown, node: string): number =>
  (traceSink.objs ?? []).filter((e) => e.mu === mu && e.node === node).length;

beforeEach(() => {
  resetWorld();
  const orig = MaterialFlowAdapter.prototype.acceptMU;
  accSpy = vi.spyOn(MaterialFlowAdapter.prototype, 'acceptMU').mockImplementation(function (this: MaterialFlowAdapter, mu: DESMU) {
    const ok = orig.call(this, mu);
    if (ok && traceSink.out) traceSink.out.push(`${traceSink.t().toFixed(6)}:${mu.id}>${this.node.name}`);
    if (ok && traceSink.objs) traceSink.objs.push({ mu, node: this.node.name });
    return ok;
  });
});
afterEach(() => {
  accSpy?.mockRestore();
  accSpy = null;
  traceSink.out = null;
  traceSink.objs = null;
  _resetMaterialFlowRegistry();
});

/**
 * Bind the scene through the production binding, let `prep` configure the bound
 * adapters (attachments, failures) BEFORE the first emission, then start (the
 * start kick emits the first MU at t = 0).
 */
function startRig(b: Built, mode: 'animated' | 'fastforward' = 'animated', prep?: (rig: Rig) => void): Rig {
  const runner = new DESRunner({ subMode: mode, durationSeconds: 120, masterSeed: 5 });
  const trace: string[] = [];
  traceSink.out = trace;
  traceSink.objs = [];
  traceSink.t = () => runner.getManager().currentTime;
  const create = vi.spyOn(runner, 'createMU');
  const byName = (name: string) => {
    const inst = runner.liveInstances.find((i) => i.self.root.name === name);
    expect(inst, `instance ${name}`).toBeDefined();
    return inst!;
  };
  const rig: Rig = {
    b, runner, trace,
    spawnCalls: () => create.mock.calls.length,
    adapter: (name) => byName(name).adapter as MaterialFlowAdapter,
    self: (name) => byName(name).self as never,
    stepUntil(pred, maxSteps, dt = 0.05) {
      let i = 0;
      for (; i < maxSteps && !pred(); i++) { runner.tick(dt); runner.lateTick(dt); }
      return i;
    },
    dispose() {
      traceSink.out = null;
      runner.dispose();
    },
  };
  b.host.signalStore!.set('Flow.Run', true);
  const quiet = vi.spyOn(console, 'info').mockImplementation(() => {});
  try {
    bindSceneToRunner(runner, b.scene, b.host);
    prep?.(rig);
    runner.start([...DEFS], { root: b.scene, host: b.host });
  } finally {
    quiet.mockRestore();
  }
  return rig;
}

const worldPos = (n: Object3D): V3 => {
  n.updateWorldMatrix(true, false);
  const v = n.getWorldPosition(new Vector3());
  return [v.x, v.y, v.z];
};
const dist = (a: readonly number[], b: readonly number[]): number => Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
const visualNode = (mu: unknown): Object3D | null =>
  ((mu as { visual?: { node?: Object3D } | null }).visual?.node) ?? null;
const sourceProblems = () => getProblems().filter((p) => p.code === 'source-pose-unsupported');

/** The MUs currently held by an adapter. */
const held = (a: MaterialFlowAdapter): DESMU[] => [...a.heldMUs];

// ─── 9.1 ────────────────────────────────────────────────────────────────────

describe('9.1 free belt — the MU starts AT the spawn pose', () => {
  it('first tween pose == spawn pose (≤ 2 mm), rest time (L − s)/v, contained link used', () => {
    const b = buildScene();
    const rig = startRig(b);
    const conv = rig.adapter('Conveyor_1');
    const src = rig.adapter('PalletSource');
    expect(containedTargetOf(src), 'contained target').toBe(conv);
    // The first MU was spawned and handed over inside start() (t = 0).
    expect(rig.spawnCalls()).toBe(1);
    const mu = held(conv)[0];
    expect(mu, 'MU on the belt').toBeDefined();
    const node = visualNode(mu);
    expect(node, 'visual').not.toBeNull();
    const spawn = worldPos(b.source);
    expect(dist(worldPos(node!), spawn), 'visual at spawn').toBeLessThanOrEqual(0.002);
    // One render step: the tween writes its first pose — from the spawn pose.
    rig.runner.tick(0.001); rig.runner.lateTick(0.001);
    expect(dist(worldPos(node!), spawn), 'first tween pose').toBeLessThanOrEqual(0.002);
    // Arrival at the sink after (L − s)/v, s = along + bug (entry at z = −L/2).
    const along = -0.3 - -BELT_LENGTH / 2;
    const remaining = ((BELT_LENGTH - (along + BUG)) * 1000) / SPEED_MM_S;
    rig.stepUntil(() => rig.trace.some((e) => e.endsWith(`:${mu.id}>Sink_1`)), 400);
    const arr = rig.trace.find((e) => e.endsWith(`:${mu.id}>Sink_1`));
    expect(arr, `sink arrival\n${rig.trace.join('\n')}`).toBeDefined();
    expect(Number(arr!.split(':')[0])).toBeCloseTo(remaining, 6);
    // One output per MU the belt took from the source, no fallback reported.
    expect(src.totalProcessed).toBe(rig.trace.filter((e) => e.endsWith('>Conveyor_1')).length);
    expect(sourceProblems()).toHaveLength(0);
    rig.dispose();
  });

  it('without the pose path (source beside the belt) the MU rides the full belt — the jump this plan removes', () => {
    const b = buildScene({ sourceAt: [0, BELT_TOP, -1.25] });
    const rig = startRig(b);
    expect(containedTargetOf(rig.adapter('PalletSource')), 'no contained link').toBeNull();
    const mu = held(rig.adapter('Conveyor_1'))[0];
    expect(mu).toBeDefined();
    rig.stepUntil(() => rig.trace.some((e) => e.endsWith(`:${mu.id}>Sink_1`)), 400);
    const arr = rig.trace.find((e) => e.endsWith(`:${mu.id}>Sink_1`));
    expect(arr).toBeDefined();
    expect(Number(arr!.split(':')[0])).toBeCloseTo((BELT_LENGTH * 1000) / SPEED_MM_S, 6);
    rig.dispose();
  });
});

// ─── 9.2 ────────────────────────────────────────────────────────────────────

describe('9.2 belt occupied at the spawn pose', () => {
  it('no spawn and no pending while blocked; the wake spawns exactly one', () => {
    const b = buildScene();
    const rig = startRig(b);
    const conv = rig.adapter('Conveyor_1');
    const srcSelf = rig.self('PalletSource');
    const first = held(conv)[0];
    expect(first).toBeDefined();
    const createdAfterFirst = b.engine!.Created;
    // Heartbeats (3 s) while the belt is full: nothing spawned, nothing pending.
    expect(srcSelf.poseReadiness()).toEqual({ state: 'blocked', reason: 'target-refused' });
    rig.stepUntil(() => !held(conv).includes(first), 200);
    expect(held(conv).includes(first), 'first left the belt').toBe(false);
    // The belt freed → the source was woken (onDownstreamReady) in the SAME event.
    expect(rig.spawnCalls()).toBe(2);
    expect(b.engine!.Created).toBe(createdAfterFirst + 1);
    expect(srcSelf.local.pending).toBeNull();
    const exit = rig.trace.find((e) => e.endsWith(`:${first.id}>Sink_1`))!;
    const second = rig.trace.filter((e) => e.endsWith('>Conveyor_1'))[1];
    expect(second, rig.trace.join('\n')).toBeDefined();
    expect(second.split(':')[0]).toBe(exit.split(':')[0]);
    rig.dispose();
  });
});

// ─── 9.3 + R1 #7 ────────────────────────────────────────────────────────────

/** Make the belt's accept fail `n` times AFTER the pre-check (a roll-back). */
function failAccepts(conv: MaterialFlowAdapter, n: number): { left: () => number } {
  let left = n;
  const orig = conv.acceptMU.bind(conv);
  conv.acceptMU = ((mu: DESMU) => (left-- > 0 ? false : orig(mu))) as typeof conv.acceptMU;
  return { left: () => left };
}

describe('9.3 roll-back — the MU stays with the source, retried, one production', () => {
  it('three roll-backs then success (heartbeat): one spawn, one output, MU on the belt', () => {
    const b = buildScene();
    const rig = startRig(b);
    // The first emission (t = 0) succeeds; the failures are armed for the second.
    const conv = rig.adapter('Conveyor_1');
    const src = rig.adapter('PalletSource');
    const srcSelf = rig.self('PalletSource');
    const first = held(conv)[0];
    const fail = failAccepts(conv, 3);
    rig.stepUntil(() => !held(conv).includes(first), 200);
    // Wake at the release: roll-back #1, MU pending + back on the source.
    const pending = srcSelf.local.pending as DESMU | null;
    expect(pending, 'pending after the roll-back').not.toBeNull();
    expect(src.heldMUs.includes(pending!), 'owner kept').toBe(true);
    expect(rig.spawnCalls()).toBe(2);
    const outputsBefore = src.totalProcessed;
    expect(outputsBefore).toBe(1); // only the first MU
    // Heartbeats retry the SAME MU until the belt accepts it.
    rig.stepUntil(() => srcSelf.local.pending === null, 400);
    expect(fail.left()).toBeLessThanOrEqual(0);
    expect(srcSelf.local.pending).toBeNull();
    expect(rig.spawnCalls(), 'no second spawn').toBe(2);
    expect(held(conv)).toContain(pending);
    expect(src.totalProcessed, 'exactly one more output').toBe(2);
    expect(src.currentLoad).toBe(0);
    expect(acceptsOf(pending, 'Conveyor_1')).toBe(1);
    rig.dispose();
  });

  it('a nested successful standard transfer during a rolled-back pose transfer counts once (per-MU suppression)', () => {
    const b = buildScene();
    const rig = startRig(b);
    const conv = rig.adapter('Conveyor_1');
    const src = rig.adapter('PalletSource');
    const srcSelf = rig.self('PalletSource');
    const first = held(conv)[0];
    rig.stepUntil(() => !held(conv).includes(first), 200);
    // Second MU is on the belt now; let it leave too so the belt is free, but stop
    // the source from refilling it: disable spawning.
    b.engine!.Enabled = false;
    const second = held(conv)[0];
    rig.stepUntil(() => !held(conv).includes(second), 200);
    expect(held(conv)).toHaveLength(0);
    b.engine!.Enabled = true;
    // mu2: a plain MU parked on the source (capacity 2), handed over WITHOUT a pose
    // from inside the release of the pose MU → the belt fills → roll-back.
    src.reconfigureCapacity(2);
    const mu2 = rig.runner.createMU();
    expect(src.acceptMU(mu2)).toBe(true);
    let nested = false;
    src.onMUExit = (m) => {
      if (nested || m === mu2) return;
      nested = true;
      src.transferMU(mu2); // standard: tryTransferMU → releaseMU(mu2) → belt accepts
    };
    const before = src.totalProcessed;
    const r = srcSelf.poseReadiness() as { state: string };
    expect(r.state).toBe('ready');
    const mu1 = (srcSelf as unknown as { spawn(): MU }).spawn();
    const res = (srcSelf as unknown as { transferAtPose(m: MU): unknown }).transferAtPose(mu1);
    expect(nested).toBe(true);
    expect(res).toEqual({ ok: false, reason: 'rolled-back' });
    expect(held(conv)).toEqual([mu2]);
    expect(src.heldMUs.includes(mu1 as unknown as DESMU)).toBe(true);
    // mu2's release counted, mu1's tentative release did not.
    expect(src.totalProcessed - before).toBe(1);
    src.onMUExit = undefined;
    rig.dispose();
  });
});

// ─── 9.4 fallbacks ──────────────────────────────────────────────────────────

describe('9.4 fallback — standard transfer + exactly one Problems info', () => {
  const fallbackCase = (
    name: string, opts: SceneOpts, reason: string, prep?: (rig: Rig) => void,
  ) => it(`${name} → fallback '${reason}'`, () => {
    const b = buildScene(opts);
    const rig = startRig(b, 'animated', prep);
    const srcSelf = rig.self('PalletSource');
    expect(srcSelf.poseReadiness()).toEqual({ state: 'fallback', reason });
    // Several emissions over 20 s — the standard path keeps flowing, one entry only.
    rig.stepUntil(() => false, 400);
    const sinkArrivals = rig.trace.filter((e) => e.endsWith('>Sink_1'));
    expect(sinkArrivals.length, rig.trace.join('\n')).toBeGreaterThanOrEqual(2);
    const probs = sourceProblems();
    expect(probs, JSON.stringify(probs)).toHaveLength(1);
    expect(probs[0].id).toContain(reason);
    expect(probs[0].severity).toBe('info');
    // Standard path: the MU rides the full belt (from the entry).
    const firstEntry = rig.trace.find((e) => e.endsWith('>Conveyor_1'));
    expect(firstEntry).toBeDefined();
    const firstMu = Number(firstEntry!.split('>')[0].split(':')[1]);
    const enter = Number(rig.trace.find((e) => e.endsWith(`:${firstMu}>Conveyor_1`))!.split(':')[0]);
    const leave = Number(rig.trace.find((e) => e.endsWith(`:${firstMu}>Sink_1`))!.split(':')[0]);
    expect(leave - enter).toBeGreaterThanOrEqual((BELT_LENGTH * 1000) / SPEED_MM_S - 1e-6);
    rig.dispose();
  });

  fallbackCase('target type without des.acceptsPose', { beltType: 'PlainConveyor' }, 'pose-unsupported');
  fallbackCase('target with an async accept (Processing at accept)', { beltType: 'AsyncConveyor' }, 'async-accept', (rig) => {
    rig.adapter('Conveyor_1').configureProcessingAttachment(0.5, 'Processing@Conveyor_1');
  });
  fallbackCase('source with a Processing attachment at its transfer', {}, 'source-processing', (rig) => {
    rig.adapter('PalletSource').configureProcessingAttachment(0.5, 'Processing@PalletSource');
  });
  fallbackCase('no MU template (no engine source)', { engine: false }, 'no-template-size');
});

// ─── pose refused vs capacity (orchestrator decision on deviation 1) ────────

const offBeltProblems = () => getProblems().filter((p) => p.code === 'transfer-pose-off-belt');

describe('pose refused: off the belt → standard path, capacity → blocked', () => {
  // Origin inside the conveyor box (guides reach 0.9 m) but 0.1 m beside AND above the rollers.
  const OFF: V3 = [0.1, BELT_TOP + 0.1, -0.3];

  it('(a)+(b) pose off the belt, standard accepts → fallback pose-refused, MUs reach the sink within 20 s sim time, transfer-pose-off-belt reported', () => {
    const b = buildScene({ sourceAt: OFF });
    const rig = startRig(b);
    const src = rig.adapter('PalletSource');
    const conv = rig.adapter('Conveyor_1');
    expect(containedTargetOf(src), 'still contained (origin inside the box)').toBe(conv);
    // Hard sim-time bound: 400 steps × 0.05 s = 20 s.
    rig.stepUntil(() => rig.trace.filter((e) => e.endsWith('>Sink_1')).length >= 2, 400);
    expect(rig.runner.getManager().currentTime).toBeLessThanOrEqual(20 + 1e-9);
    expect(rig.trace.filter((e) => e.endsWith('>Sink_1')).length, `no deadlock\n${rig.trace.join('\n')}`).toBeGreaterThanOrEqual(2);
    expect(offBeltProblems().map((p) => p.id)).toContain('transfer-pose-off-belt:Conveyor_1');
    const info = sourceProblems();
    expect(info, JSON.stringify(info)).toHaveLength(1);
    expect(info[0].id).toContain('pose-refused');
    // Standard path: the MUs ride the full belt.
    const first = rig.trace.find((e) => e.endsWith('>Conveyor_1'))!;
    const id = first.split('>')[0].split(':')[1];
    const leave = rig.trace.find((e) => e.endsWith(`:${id}>Sink_1`))!;
    expect(Number(leave.split(':')[0]) - Number(first.split(':')[0])).toBeCloseTo((BELT_LENGTH * 1000) / SPEED_MM_S, 6);
    rig.dispose();
  });

  it('(c) pose off the belt AND target occupied → blocked target-refused (as before)', () => {
    const b = buildScene({ sourceAt: OFF });
    const rig = startRig(b);
    const conv = rig.adapter('Conveyor_1');
    expect(conv.heldMUs.length, 'first MU on the belt (standard path)').toBe(1);
    expect(rig.self('PalletSource').poseReadiness()).toEqual({ state: 'blocked', reason: 'target-refused' });
    rig.dispose();
  });

  it('valid pose, target occupied → blocked; freed → ready', () => {
    const b = buildScene();
    const rig = startRig(b);
    const conv = rig.adapter('Conveyor_1');
    const srcSelf = rig.self('PalletSource') as unknown as { prop: Record<string, unknown>; poseReadiness(): unknown };
    const first = conv.heldMUs[0];
    expect(first).toBeDefined();
    expect(srcSelf.poseReadiness()).toEqual({ state: 'blocked', reason: 'target-refused' });
    srcSelf.prop['AutomaticGeneration'] = false; // the release wake must not refill the belt
    rig.stepUntil(() => !conv.heldMUs.includes(first), 200);
    expect(conv.heldMUs).toHaveLength(0);
    expect((srcSelf.poseReadiness() as { state: string }).state).toBe('ready');
    rig.dispose();
  });

  it('counter-test: the normal pose path (valid pose, free target) reports nothing', () => {
    const b = buildScene();
    const rig = startRig(b);
    rig.stepUntil(() => false, 400);
    expect(rig.trace.filter((e) => e.endsWith('>Sink_1')).length).toBeGreaterThanOrEqual(5);
    expect(offBeltProblems()).toHaveLength(0);
    expect(sourceProblems()).toHaveLength(0);
    rig.dispose();
  });
});

// ─── 9.5 regression ─────────────────────────────────────────────────────────

describe('9.5 regression — no effective pose path, no pose call', () => {
  it('a source without a contained link never touches the pose API and reports nothing', () => {
    const b = buildScene({ sourceAt: [0, BELT_TOP, -1.25] });
    const canPose = vi.spyOn(DESRunner.prototype, 'canAcceptWithPose');
    const doPose = vi.spyOn(DESRunner.prototype, 'transferMUWithPose');
    const tent = vi.spyOn(MaterialFlowAdapter.prototype, 'releaseTentatively');
    const rig = startRig(b);
    rig.stepUntil(() => false, 600);
    expect(rig.trace.filter((e) => e.endsWith('>Sink_1')).length).toBeGreaterThanOrEqual(3);
    expect(canPose).not.toHaveBeenCalled();
    expect(doPose).not.toHaveBeenCalled();
    expect(tent).not.toHaveBeenCalled();
    expect(rig.self('PalletSource').poseReadiness()).toEqual({ state: 'fallback', reason: 'not-contained' });
    expect(sourceProblems()).toHaveLength(0);
    canPose.mockRestore(); doPose.mockRestore(); tent.mockRestore();
    rig.dispose();
  });

  it('continuous self (no private backend): fallback no-backend, no pose, no Problems', () => {
    const root = new Object3D(); root.name = 'ContSource';
    const events = new EventEmitter<Record<string, unknown>>();
    const host = {
      signalStore: new SignalStore(), on: (e: string, cb: never) => events.on(e, cb),
      contextMenu: new ContextMenuStore(), drives: [], registry: null, getPlugin: () => undefined,
    } as unknown as BindContextHost;
    const accum: KinematicsSpec = {};
    const self = createSelf(createBindContext(root, host, accum).ctx, SourceDef, {
      local: (SourceDef.state ?? SourceDef.local)?.() as never,
    });
    expect(self.poseReadiness()).toEqual({ state: 'fallback', reason: 'no-backend' });
    expect(self.transferAtPose({ id: 1 })).toEqual({ ok: false, reason: 'no-pose' });
    // The DES hook on a backend-less self takes the standard path (transfer is a no-op).
    SourceDef.des!.onDownstreamReady!(self as never, null);
    expect((self.local as { pending: unknown }).pending).toBeNull();
    expect(sourceProblems()).toHaveLength(0);
  });
});

// ─── 9.6 ────────────────────────────────────────────────────────────────────

describe('9.6 Animated ≡ FastForward; reset and rebind', () => {
  it('same hand-over trace and counters in both modes', () => {
    const run = (mode: 'animated' | 'fastforward') => {
      resetWorld();
      const b = buildScene();
      const rig = startRig(b, mode);
      if (mode === 'fastforward') {
        rig.runner.getManager().processUpTo(30, 4000);
      } else {
        rig.stepUntil(() => rig.runner.getManager().currentTime >= 30, 1000, 0.05);
      }
      // Compare events strictly before t = 30 (the animated loop may overrun).
      // MU ids are left out: the animated runner recycles the ids of disposed
      // visuals, FastForward does not (pre-existing, unrelated to the pose path).
      const trace = rig.trace
        .filter((e) => Number(e.split(':')[0]) < 30)
        .map((e) => `${e.split(':')[0]}>${e.split('>')[1]}`);
      const out = {
        trace: trace.join('\n'),
        src: rig.adapter('PalletSource').totalProcessed,
        sink: trace.filter((e) => e.endsWith('>Sink_1')).length,
        bug: (held(rig.adapter('Conveyor_1'))[0] as unknown as { _bugSize?: number[] } | undefined)?._bugSize ?? null,
      };
      rig.dispose();
      return out;
    };
    const anim = run('animated');
    const ff = run('fastforward');
    expect(anim.sink).toBeGreaterThanOrEqual(5);
    expect(ff.trace).toBe(anim.trace);
    expect(ff.sink).toBe(anim.sink);
    expect(ff.bug).toEqual(anim.bug);
  });

  it('reset during pending: the held MU is dropped, the pose path works again', () => {
    const b = buildScene();
    const rig = startRig(b);
    const conv = rig.adapter('Conveyor_1');
    const srcSelf = rig.self('PalletSource');
    failAccepts(conv, 1);
    const first = held(conv)[0];
    rig.stepUntil(() => !held(conv).includes(first), 200);
    expect(srcSelf.local.pending).not.toBeNull();
    rig.runner.reset();
    const self2 = rig.self('PalletSource');
    expect(self2.local.pending).toBeNull();
    expect(self2.local.emitting).toBe(false);
    const mu = held(rig.adapter('Conveyor_1'))[0];
    expect(mu, 'restart spawned onto the belt at the pose').toBeDefined();
    expect(dist(worldPos(visualNode(mu)!), worldPos(b.source))).toBeLessThanOrEqual(0.002);
    rig.dispose();
  });

  it('rebindScene: unchanged target → pose path; moved off the belt → standard; target removed → no contained link', () => {
    const b = buildScene();
    const rig = startRig(b);
    const quiet = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      rig.runner.rebindScene();
      const src = rig.adapter('PalletSource');
      expect(containedTargetOf(src)).toBe(rig.adapter('Conveyor_1'));
      expect((rig.self('PalletSource').poseReadiness() as { state: string }).state).toBe('blocked'); // belt holds the restart MU
      const mu = held(rig.adapter('Conveyor_1'))[0];
      expect(dist(worldPos(visualNode(mu)!), worldPos(b.source))).toBeLessThanOrEqual(0.002);

      // Changed target: the source moves beside the belt → not contained after the rebind.
      b.source.position.set(0, BELT_TOP, -1.25);
      b.scene.updateMatrixWorld(true);
      rig.runner.rebindScene();
      expect(containedTargetOf(rig.adapter('PalletSource'))).toBeNull();
      expect(rig.self('PalletSource').poseReadiness()).toEqual({ state: 'fallback', reason: 'not-contained' });

      // Removed target: back on the belt position, but the belt is gone.
      b.source.position.set(0, BELT_TOP, -0.3);
      b.belt.removeFromParent();
      b.scene.updateMatrixWorld(true);
      rig.runner.rebindScene();
      expect(rig.runner.liveInstances.some((i) => i.self.root.name === 'Conveyor_1')).toBe(false);
      expect(containedTargetOf(rig.adapter('PalletSource'))).toBeNull();
      expect(rig.self('PalletSource').poseReadiness()).toEqual({ state: 'fallback', reason: 'not-contained' });
    } finally {
      quiet.mockRestore();
    }
    rig.dispose();
  });

  it('a parent transform (rotated + offset line): spawn and first tween pose agree in world space', () => {
    // Quarter turn: bounds-based belts (no snaps) are axis-aligned only at 90°.
    const b = buildScene({ lineYaw: Math.PI / 2, lineOffset: [3, 0.5, -2] });
    const rig = startRig(b);
    const conv = rig.adapter('Conveyor_1');
    expect(containedTargetOf(rig.adapter('PalletSource'))).toBe(conv);
    const mu = held(conv)[0];
    expect(mu, rig.trace.join('\n')).toBeDefined();
    const node = visualNode(mu)!;
    rig.runner.tick(0.001); rig.runner.lateTick(0.001);
    expect(dist(worldPos(node), worldPos(b.source))).toBeLessThanOrEqual(0.002);
    rig.dispose();
  });
});

// ─── R1 #2 / R2-2 / R2-3 — pending state machine ────────────────────────────

describe('pending state machine, path switch and re-entrancy', () => {
  it('path switch with pending: pose-pending → Processing fallback → done; heartbeats never re-transfer it', () => {
    const b = buildScene();
    const rig = startRig(b);
    const conv = rig.adapter('Conveyor_1');
    const src = rig.adapter('PalletSource');
    const srcSelf = rig.self('PalletSource');
    const first = held(conv)[0];
    failAccepts(conv, 1);
    rig.stepUntil(() => !held(conv).includes(first), 200);
    const pending = srcSelf.local.pending as DESMU;
    expect(pending).not.toBeNull();
    // The source gets a Processing attachment → the next wake takes the standard path.
    src.configureProcessingAttachment(0.5, 'Processing@PalletSource');
    expect(srcSelf.poseReadiness()).toEqual({ state: 'fallback', reason: 'source-processing' });
    rig.stepUntil(() => held(conv).includes(pending), 200);
    expect(held(conv)).toContain(pending);
    expect(srcSelf.local.pending).toBeNull();
    // More heartbeats: that MU is never handed over again.
    rig.stepUntil(() => false, 200);
    expect(acceptsOf(pending, 'Conveyor_1')).toBe(1);
    rig.dispose();
  });

  it('a wake inside the pose attempt returns at once (no spawn, pending untouched)', () => {
    const b = buildScene();
    const rig = startRig(b);
    const conv = rig.adapter('Conveyor_1');
    const src = rig.adapter('PalletSource');
    const srcSelf = rig.self('PalletSource');
    const first = held(conv)[0];
    let nestedSpawns = -1;
    let nestedPending: unknown = 'unset';
    src.onMUExit = () => {
      const before = rig.spawnCalls();
      SourceDef.des!.onDownstreamReady!(srcSelf as never, null);
      SourceDef.des!.onGenerate!(srcSelf as never);
      nestedSpawns = rig.spawnCalls() - before;
      nestedPending = srcSelf.local.pending;
    };
    rig.stepUntil(() => !held(conv).includes(first), 200);
    expect(nestedSpawns, 'nested wake ran').toBe(0);
    expect(nestedPending, 'pending held during the attempt').not.toBeNull();
    expect(srcSelf.local.emitting).toBe(false);
    expect(srcSelf.local.pending).toBeNull();
    src.onMUExit = undefined;
    rig.dispose();
  });

  it('an exception inside the pose attempt releases the lock; the next wake hands the same MU over', () => {
    const b = buildScene();
    const rig = startRig(b);
    const conv = rig.adapter('Conveyor_1');
    const srcSelf = rig.self('PalletSource');
    const first = held(conv)[0];
    b.engine!.Enabled = false; // the release wake must not emit — drive it by hand
    rig.stepUntil(() => !held(conv).includes(first), 200);
    b.engine!.Enabled = true;
    const orig = conv.acceptMU.bind(conv);
    let thrown = false;
    conv.acceptMU = ((mu: DESMU) => {
      if (!thrown) { thrown = true; throw new Error('boom'); }
      return orig(mu);
    }) as typeof conv.acceptMU;
    expect(() => SourceDef.des!.onDownstreamReady!(srcSelf as never, null)).toThrow('boom');
    expect(srcSelf.local.emitting).toBe(false);
    const kept = srcSelf.local.pending as DESMU;
    expect(kept).not.toBeNull();
    const spawns = rig.spawnCalls();
    SourceDef.des!.onDownstreamReady!(srcSelf as never, null);
    expect(rig.spawnCalls()).toBe(spawns);
    expect(srcSelf.local.pending).toBeNull();
    expect(held(conv)).toContain(kept);
    rig.dispose();
  });
});

// ─── R1 #4 / R3-1 — blocked ────────────────────────────────────────────────

describe('blocked: disabled source, quantity limit, loop saturation', () => {
  it('disabled source → blocked source-disabled, nothing spawned', () => {
    const b = buildScene();
    b.engine!.Enabled = false;
    const rig = startRig(b);
    expect(rig.self('PalletSource').poseReadiness()).toEqual({ state: 'blocked', reason: 'source-disabled' });
    rig.stepUntil(() => false, 200);
    expect(rig.spawnCalls()).toBe(0);
    expect(held(rig.adapter('Conveyor_1'))).toHaveLength(0);
    rig.dispose();
  });

  it('quantity limit reached → blocked quantity-limit, nothing spawned', () => {
    const b = buildScene();
    b.source.userData.realvirtual.Source.LimitNumber = true;
    b.source.userData.realvirtual.Source.MaxNumberMUs = 2;
    b.engine!.LimitNumber = true;
    b.engine!.MaxNumberMUs = 2;
    const rig = startRig(b);
    rig.stepUntil(() => false, 600); // 30 s
    expect(b.engine!.Created).toBe(2);
    expect(rig.spawnCalls()).toBe(2);
    expect(rig.self('PalletSource').poseReadiness()).toEqual({ state: 'blocked', reason: 'quantity-limit' });
    rig.dispose();
  });

  it('loop saturation (the source release guard) → blocked loop-saturated with a free target', () => {
    const b = buildScene({ extraBelts: 2 }); // 3 conveyor zones → cap 2
    b.engine!.Enabled = false;
    const rig = startRig(b, 'animated', (r) => {
      // Wire before start rebuilds the SCCs: a sinkless cycle reachable from the source.
      const src = r.adapter('PalletSource');
      const conv = r.adapter('Conveyor_1');
      const x0 = r.adapter('Conveyor_X0');
      const x1 = r.adapter('Conveyor_X1');
      src.nextComponents = [conv];
      conv.previousComponents = [src, x1];
      conv.nextComponents = [x0];
      x0.previousComponents = [conv];
      x0.nextComponents = [x1];
      x1.previousComponents = [x0];
      x1.nextComponents = [conv];
      r.adapter('Sink_1').previousComponents = [];
    });
    expect(rig.spawnCalls()).toBe(0);
    for (const name of ['Conveyor_X0', 'Conveyor_X1']) {
      const mu = rig.runner.createMU();
      expect(rig.adapter(name).acceptMU(mu)).toBe(true);
    }
    b.engine!.Enabled = true;
    const srcSelf = rig.self('PalletSource');
    expect(srcSelf.poseReadiness()).toEqual({ state: 'blocked', reason: 'loop-saturated' });
    const before = rig.spawnCalls();
    SourceDef.des!.onDownstreamReady!(srcSelf as never, null);
    expect(rig.spawnCalls()).toBe(before);
    expect(held(rig.adapter('Conveyor_1'))).toHaveLength(0);
    rig.dispose();
  });
});

// ─── R3-1 / R3-2 — standard headless-first unchanged, templateSize side-effect free ──

interface EngineCounters { Created: number; spawnCount: number; lastSpawnedMU: unknown }
const countersOf = (s: RVSource): EngineCounters => {
  const x = s as unknown as EngineCounters;
  return { Created: x.Created, spawnCount: x.spawnCount, lastSpawnedMU: x.lastSpawnedMU };
};

describe('R3-1 / R3-2 — the standard path keeps its measurement; templateSize() has no side effect', () => {
  it('standard source headless-first: no throw-away spawn, the MU carries the canonical templateSize()', () => {
    // Since 048b5361 (canonical MU size, A1) the scene binding captures ONE size per
    // source at bind from the template (templateSize(), local matrices) and presets it
    // on every MU — pose, standard, visual and headless. The headless-first throw-away
    // spawn (templateBugSizeFor → spawnMU → measure → dispose) is gone, so the engine
    // counters stay untouched on the standard path too.
    const b = buildScene({ sourceAt: [0, BELT_TOP, -1.25] }); // not contained
    const before = countersOf(b.engine!);
    const rig = startRig(b, 'fastforward');
    const after = countersOf(b.engine!);
    expect(before).toEqual({ Created: 0, spawnCount: 0, lastSpawnedMU: null });
    expect(after).toEqual({ Created: 0, spawnCount: 0, lastSpawnedMU: null });
    const mu = held(rig.adapter('Conveyor_1'))[0] as unknown as { _bugSize?: number[]; visual: unknown };
    expect(mu, 'standard MU on the belt').toBeDefined();
    expect(mu.visual).toBeNull();
    expect(mu._bugSize).toEqual(b.engine!.templateSize());
    const expected = templateSizeOf(b.source, b.scene)!;
    for (let i = 0; i < 3; i++) expect(mu._bugSize![i]).toBeCloseTo(expected[i], 9);
    rig.dispose();
  });

  it('pose source headless-first: no throw-away spawn, the MU carries templateSize()', () => {
    const b = buildScene();
    const rig = startRig(b, 'fastforward');
    expect(countersOf(b.engine!)).toEqual({ Created: 0, spawnCount: 0, lastSpawnedMU: null });
    const mu = held(rig.adapter('Conveyor_1'))[0] as unknown as { _bugSize?: number[] };
    expect(mu, 'pose MU on the belt').toBeDefined();
    expect(mu._bugSize).toEqual(b.engine!.templateSize());
    rig.dispose();
  });
});

// ─── Spike cases as regression: templateSizeOf vs the clone measurement ──────

const TOL = 1e-6;

function pallet(name = 'Pallet'): Object3D {
  const n = new Object3D(); n.name = name;
  const deck = new Mesh(new BoxGeometry(1.2, 0.14, 0.8), new MeshStandardMaterial()); deck.name = 'Deck';
  const box = new Mesh(new BoxGeometry(0.6, 0.6, 0.6), new MeshStandardMaterial()); box.name = 'Box';
  box.position.set(0.1, 0.37, 0);
  n.add(deck, box);
  return n;
}

function selfSource(template: Object3D, spawnParent: Object3D): RVSource {
  const src = new RVSource(template);
  src.ThisObjectAsMU = template.name;
  (src as unknown as { sourceIsTemplate: boolean }).sourceIsTemplate = true;
  src.spawnParent = spawnParent;
  src.setTemplate(template);
  return src;
}

function separateSource(sourceNode: Object3D, template: Object3D, spawnParent: Object3D): RVSource {
  const src = new RVSource(sourceNode);
  src.spawnParent = spawnParent;
  src.setTemplate(template);
  return src;
}

/** templateSize() first (counters compared before/after), then the real clone. */
function expectSpikeEqual(name: string, src: RVSource): void {
  const before = countersOf(src);
  const size = src.templateSize();
  expect(countersOf(src), `${name}: templateSize() must not spawn`).toEqual(before);
  const s = src as unknown as { muTemplate: Object3D; spawnParent: Object3D };
  expect(templateSizeOf(s.muTemplate, s.spawnParent)).toEqual(size);
  const mu = src.spawnMU();
  expect(mu, `${name}: spawnMU`).toBeTruthy();
  const actual = measureMuVisualBugSize(mu!.node);
  mu!.dispose();
  expect(size, `${name}: size`).not.toBeNull();
  expect(actual, `${name}: actual`).not.toBeNull();
  for (let i = 0; i < 3; i++) expect(Math.abs(size![i] - actual![i]), `${name} axis ${i}`).toBeLessThan(TOL);
}

describe('spike regression — templateSizeOf == _bugSize of the spawned clone', () => {
  it('C2 non-uniform template scale + rotated template', () => {
    const scene = new Scene(); const t = pallet(); t.scale.set(2, 1, 0.5); t.rotation.set(0, 0.6, 0.2); scene.add(t);
    expectSpikeEqual('C2', selfSource(t, scene));
  });

  it('C3 rotated + scaled spawn parent (Z-up root, mm scale)', () => {
    const scene = new Scene(); const root = new Object3D(); root.rotation.set(-Math.PI / 2, 0, 0.3); root.scale.set(0.001, 0.002, 0.001);
    scene.add(root); const t = pallet(); t.scale.set(1000, 1000, 1000); root.add(t);
    expectSpikeEqual('C3', selfSource(t, root));
  });

  it('C4 separate template under rotated ancestors, spawn parent elsewhere', () => {
    const scene = new Scene();
    const lib = new Object3D(); lib.rotation.set(0, 0.5, 0.4); lib.scale.set(1, 3, 1); scene.add(lib);
    const t = pallet('Tmpl'); t.scale.set(1.5, 1, 1); lib.add(t);
    const parent = new Object3D(); parent.rotation.set(0.2, 0, 0); parent.scale.set(2, 1, 1); scene.add(parent);
    const srcNode = new Object3D(); srcNode.name = 'Src'; srcNode.rotation.set(0, 1.1, 0); scene.add(srcNode);
    expectSpikeEqual('C4', separateSource(srcNode, t, parent));
  });

  it('C5 self-template with overlay shells AND an active preview', () => {
    const scene = new Scene(); const t = pallet(); t.scale.set(1, 2, 1); scene.add(t);
    const src = selfSource(t, scene);
    src.showPreview();
    expectSpikeEqual('C5', src);
  });

  it('C7b real EuropalletLoaded.glb through loadGLB, root rotated + scaled', async () => {
    const url = '/library/PalletHandling/EuropalletLoaded.glb';
    const head = await fetch(url, { method: 'HEAD' });
    expect(head.ok && /gltf-binary|octet-stream/i.test(head.headers.get('content-type') ?? ''), 'GLB not served').toBe(true);
    const scene = new Scene();
    const res = await loadGLB(url, scene);
    const sources = res.transportManager.sources;
    expect(sources.length).toBeGreaterThan(0);
    const root = scene.children.find((c) => c.type !== 'Light') ?? scene.children[0];
    root.rotation.set(0, 0.8, 0); root.scale.set(1.25, 1.25, 1.25); root.updateMatrixWorld(true);
    for (const src of sources) expectSpikeEqual(`C7b ${src.node.name}`, src);
  });
});
