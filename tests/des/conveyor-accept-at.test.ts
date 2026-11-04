// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * conveyor-accept-at.test.ts — plan-631 Phase 1: the DES Conveyor takes an MU
 * over AT THE POSE it was set down (`acceptPose`), instead of pulling it back to
 * its entry point.
 *
 *  9.1 real runner/adapter integration (`transferMUWithPose`): take-over at
 *      along = −bug, L/2 and L − bug → remaining time (L − s)/v, tween starts AT
 *      the pose (≤ 1 mm). Variants: snap vs bounds entry, baked belt (merged
 *      rollers), rotated belt, two MU sizes.
 *  9.2 plausibility: 30 mm beside, 30 mm too high, 1 m behind → canAccept false,
 *      Problems `transfer-pose-off-belt`, the owner keeps the MU.
 *  9.3 one-shot: the pose is dropped after success AND rejection; a second
 *      transfer without a pose takes the legacy path. Includes the R2-1
 *      re-entrancy case (nested transfer inside the owner's release, rejection
 *      after the pre-check → hand-back to the owner).
 *  9.4 bit-identity without a pose: Source → Conveyor → Conveyor → Station →
 *      Sink with visual (animated), headless (FastForward) and back-pressure —
 *      trace + pose fingerprint pinned to the values measured on the base commit
 *      (main 6c78d7e3) BEFORE the change.
 *  R2-3 pre-validation of a spawn pose without an MU (`canAcceptWithPose`).
 *
 * Imports `@rv/plugins/des/*` — DES is core code since plan-680.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Object3D, Mesh, BoxGeometry, Vector3 } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { resetDESMUCounter, type DESMU } from '@rv/plugins/des/rv-des-mu';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import { DESComponent } from '@rv/plugins/des/rv-des-component';
import { getProblems, resetProblemsForTests } from '../../src/core/hmi/problems-store';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
import { presetMuBugSize } from '../../src/behaviors/_shared/mu-reference';
import {
  createSelf,
  type MaterialFlowSelf,
  type MU,
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

const ConveyorDef = ConveyorFlow as unknown as MaterialFlowDefinition;

// ─── Fixtures ───────────────────────────────────────────────────────────────

interface FakeVisual {
  node: Object3D;
  isInstanced: boolean;
  markedForRemoval: boolean;
  setPosition(v: Vector3): void;
  dispose(): void;
}

/** RVMovingUnit-shaped fake with real box geometry (the bug measurement works). */
function makeVisual(size: readonly [number, number, number]): FakeVisual {
  const node = new Object3D();
  node.add(new Mesh(new BoxGeometry(size[0], size[1], size[2])));
  node.updateMatrixWorld(true);
  return {
    node,
    isInstanced: false,
    markedForRemoval: false,
    setPosition(v: Vector3): void {
      this.node.position.copy(v);
      this.node.updateMatrixWorld(true);
    },
    dispose(): void { /* nothing */ },
  };
}

function makeHost(drives: unknown[]): BindContextHost {
  const events = new EventEmitter<Record<string, unknown>>();
  const values = new Map<string, boolean | number>();
  return {
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => values.set(n, v),
      subscribe: () => () => {},
    } as never,
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: drives as never,
    registry: null,
    getPlugin: () => undefined,
  };
}

function bareContext(root: Object3D): RVBindContext {
  const accum: KinematicsSpec = {};
  return createBindContext(root, makeHost([]), accum).ctx;
}

interface BeltOpts {
  /** Belt length along the flow (m). */
  lengthM: number;
  speedMmS: number;
  /** World position of the conveyor root. */
  at?: [number, number, number];
  /** Yaw of the conveyor root (rad, about +Y). The belt flows along its local +Z. */
  yaw?: number;
  /** Build the transport as N separate rollers (a baked/merged belt, #200). */
  rollers?: number;
}

/**
 * A conveyor root with a `Transport-Z` belt (top at y = 0.1 m local, flowing
 * along local +Z) and a `Sensor`. Rollers > 0 builds the belt from separate
 * roller meshes — the bounds still span the full length (like a baked belt).
 */
function makeConveyorRoot(name: string, o: BeltOpts): { root: Object3D; belt: Object3D; ctx: RVBindContext } {
  const root = new Object3D(); root.name = name;
  if (o.at) root.position.set(o.at[0], o.at[1], o.at[2]);
  if (o.yaw) root.rotation.y = o.yaw;
  const belt = new Object3D(); belt.name = 'Transport-Z';
  if (o.rollers && o.rollers > 1) {
    const n = o.rollers;
    const pitch = o.lengthM / n;
    for (let i = 0; i < n; i++) {
      const r = new Mesh(new BoxGeometry(0.6, 0.05, pitch * 0.6));
      r.position.set(0, 0.075, -o.lengthM / 2 + pitch * (i + 0.5));
      belt.add(r);
    }
    // Pad the end rollers out to the full length so the bounds span L exactly.
    const pad = new Mesh(new BoxGeometry(0.6, 0.01, o.lengthM));
    pad.position.set(0, 0.055, 0);
    belt.add(pad);
  } else {
    const m = new Mesh(new BoxGeometry(0.6, 0.1, o.lengthM));
    m.position.set(0, 0.05, 0);
    belt.add(m);
  }
  root.add(belt);
  const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);
  root.updateMatrixWorld(true);
  const accum: KinematicsSpec = {};
  const ctx = createBindContext(root, makeHost([{ name: 'Transport-Z', node: belt, TargetSpeed: o.speedMmS }]), accum).ctx;
  return { root, belt, ctx };
}

interface ConvLocalView {
  timer: { transitTime: number; speed: number; length: number } | null;
  blockedMUs: MU[];
  transitMUs: Map<number, number>;
}

interface BuiltConveyor {
  self: MaterialFlowSelf<ConvLocalView>;
  adapter: MaterialFlowAdapter;
  root: Object3D;
  belt: Object3D;
}

function buildConveyor(runner: DESRunner, name: string, o: BeltOpts): BuiltConveyor {
  const { root, belt, ctx } = makeConveyorRoot(name, o);
  let adapter!: MaterialFlowAdapter;
  const self = createSelf(ctx, ConveyorDef, {
    mode: 'des',
    scheduler: runner.makeScheduler(ConveyorDef, () => adapter.entityId),
    onTransfer: (mu) => runner.makeTransfer(adapter)(mu),
    canAcceptDownstream: (mu) =>
      adapter.nextComponents.length > 0 && adapter.nextComponents.some(c => c.canAccept(mu as never)),
    local: (ConveyorDef.state ?? ConveyorDef.local)?.(),
  });
  adapter = runner.addInstance(ConveyorDef, self, root, undefined, { desId: root.name + '@' + ConveyorDef.type });
  return { self: self as unknown as MaterialFlowSelf<ConvLocalView>, adapter, root, belt };
}

function resetWorld(): void {
  _resetMaterialFlowRegistry();
  _resetDesHookCache();
  resetDESMUCounter();
}

beforeEach(resetWorld);

/** FNV-1a 32-bit over a string — a compact, stable fingerprint. */
function fnv1a(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ─── 9.4 bit-identity without a pose ────────────────────────────────────────

const LINE_MU_SIZE = [0.4, 0.3, 0.6] as const; // bug = 0.3 m

interface LineResult { trace: string[]; poses: string[] }

/**
 * Source (3 s) → ConvA (1 m @ 200 mm/s) → ConvB (1 m) → Station (7 s, cap 1:
 * back-pressure) → Sink. Every hook is logged with its sim time; in animated
 * mode the visual positions of all live MUs are sampled after every frame.
 */
async function runLine(mode: 'animated' | 'fastforward'): Promise<LineResult> {
  resetWorld();
  const DURATION = 60;
  const runner = new DESRunner({ subMode: mode, durationSeconds: DURATION, masterSeed: 11 });
  const trace: string[] = [];
  const poses: string[] = [];
  const t = (): string => runner.simTime.toFixed(6);
  const headless = mode === 'fastforward';
  const live = new Set<DESMU>();

  const srcRoot = new Object3D(); srcRoot.name = 'LineSource';
  const stRoot = new Object3D(); stRoot.name = 'LineStation';
  const sinkRoot = new Object3D(); sinkRoot.name = 'LineSink';

  let src!: MaterialFlowAdapter;
  let st!: MaterialFlowAdapter;
  let sink!: MaterialFlowAdapter;

  const sourceDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'LineSource', kind: 'source', schema: {}, continuous: {},
    des: {
      onGenerate(self) {
        const mu = self.spawn();
        trace.push(`gen#${mu.id}@${t()}`);
        self.transfer(mu);
        self.in(3, 'Generate', null);
      },
    },
  }) as MaterialFlowDefinition;
  const stationDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'LineStation', kind: 'station', schema: {}, continuous: {},
    des: {
      onAccept(self, mu) { trace.push(`st.acc#${mu.id}@${t()}`); self.in(7, 'ProcessComplete', mu); return true; },
      onProcessComplete(self, mu) { trace.push(`st.done#${mu.id}@${t()}`); self.transfer(mu); },
    },
  }) as MaterialFlowDefinition;
  const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'LineSink', kind: 'sink', schema: {}, continuous: {},
    des: {
      onAccept(_s, mu) {
        trace.push(`sink#${mu.id}@${t()}`);
        live.delete(mu as unknown as DESMU);
        const v = (mu as { visual?: { markedForRemoval?: boolean } | null }).visual;
        if (v) v.markedForRemoval = true;
        return true;
      },
    },
  }) as MaterialFlowDefinition;

  const srcSelf = createSelf(bareContext(srcRoot), sourceDef, {
    mode: 'des',
    scheduler: runner.makeScheduler(sourceDef, () => src.entityId),
    onTransfer: (mu: MU) => runner.makeTransfer(src)(mu),
    canAcceptDownstream: (mu: MU) => src.nextComponents.some(c => c.canAccept(mu as never)),
    spawnMU: () => {
      const mu = runner.createMU();
      if (!headless) (mu as unknown as { visual: unknown }).visual = makeVisual(LINE_MU_SIZE);
      presetMuBugSize(mu as unknown as MU, LINE_MU_SIZE);
      live.add(mu);
      return mu;
    },
  });
  src = runner.addInstance(sourceDef, srcSelf, srcRoot);
  const a = buildConveyor(runner, 'ConvA', { lengthM: 1, speedMmS: 200 });
  const b = buildConveyor(runner, 'ConvB', { lengthM: 1, speedMmS: 200, at: [0, 0, 1] });
  const stSelf = createSelf(bareContext(stRoot), stationDef, {
    mode: 'des',
    scheduler: runner.makeScheduler(stationDef, () => st.entityId),
    onTransfer: (mu: MU) => runner.makeTransfer(st)(mu),
    canAcceptDownstream: (mu: MU) => st.nextComponents.some(c => c.canAccept(mu as never)),
  });
  st = runner.addInstance(stationDef, stSelf, stRoot);
  const sinkSelf = createSelf(bareContext(sinkRoot), sinkDef, {
    mode: 'des',
    scheduler: runner.makeScheduler(sinkDef, () => sink.entityId),
  });
  sink = runner.addInstance(sinkDef, sinkSelf, sinkRoot);

  const chain = [src, a.adapter, b.adapter, st, sink];
  for (let i = 0; i < chain.length - 1; i++) {
    chain[i].nextComponents = [chain[i + 1]];
    chain[i + 1].previousComponents = [chain[i]];
  }

  runner.start([sourceDef, ConveyorDef, stationDef, sinkDef], { root: new Object3D() });
  a.self.signals.set('Flow.Run', true);
  b.self.signals.set('Flow.Run', true);

  if (mode === 'fastforward') {
    await runner.runFastForward();
  } else {
    const dt = 0.25;
    for (let i = 0; i < DURATION / dt; i++) {
      runner.tick(dt);
      runner.lateTick(dt);
      const row: string[] = [];
      for (const mu of live) {
        const node = (mu.visual as { node?: Object3D } | null)?.node;
        if (!node) continue;
        const p = node.position;
        row.push(`${mu.id}:${p.x.toFixed(5)},${p.y.toFixed(5)},${p.z.toFixed(5)},${node.rotation.y.toFixed(5)}`);
      }
      poses.push(row.join('|'));
    }
  }
  trace.push(`end:${runner.getManager().totalEventsProcessed}@${t()}`);
  runner.dispose();
  return { trace, poses };
}

describe('9.4 Conveyor without a pose — bit-identical to the base commit', () => {
  it('animated with visuals: trace + pose fingerprint unchanged', async () => {
    const r = await runLine('animated');
    // Back-pressure really happened: a part waited on ConvB for the station.
    expect(r.trace.some(e => e.startsWith('st.done'))).toBe(true);
    const fp = { trace: fnv1a(r.trace.join('\n')), poses: fnv1a(r.poses.join('\n')), n: r.trace.length };
    console.log('[9.4 animated]', JSON.stringify(fp));
    expect(fp).toEqual(GOLDEN_ANIMATED);
  });

  it('headless FastForward: trace fingerprint unchanged', async () => {
    const r = await runLine('fastforward');
    const fp = { trace: fnv1a(r.trace.join('\n')), n: r.trace.length };
    console.log('[9.4 fastforward]', JSON.stringify(fp));
    expect(fp).toEqual(GOLDEN_FF);
  });
});

/** Measured on main 6c78d7e3 (before plan-631) — see the plan's progress section. */
// plan-2006 Phase 2 (#25, accept first / release as commit): at an equal sim time the
// Sink now consumes MU n BEFORE the Station pulls MU n+1 (old: st.acc#n+1 before sink#n).
// Same 44 entries, same times, same poses — only the same-instant order. Old goldens:
// animated trace '0aee95ea', FastForward trace 'cef6f729'.
// plan-2212 (deterministic MU ids): a sink-consumed MU retires at the end of its
// consuming event instead of at the runner's post-batch / post-frame sweep, so its
// slot id is reused at the same point in every slicing. Same 44 entries; the MU ids
// in the trace (and the pose rows keyed by them) change, and animated and
// FastForward now produce the SAME trace. Old goldens: animated trace '057f156c',
// poses 'fa08f2e5'; FastForward trace 'e1675521'.
const GOLDEN_ANIMATED = { trace: '8cf49d54', poses: '4c7e63b9', n: 44 };
const GOLDEN_FF = { trace: '8cf49d54', n: 44 };

// ─── Pose hand-over rig (9.1 – 9.3, R2-3) ───────────────────────────────────

/** A plain owner (a fork, a source slot): capacity 1, no successor. */
class Holder extends DESComponent {
  get held(): DESMU | null { return this.mus[0] ?? null; }
}

interface PoseRigOpts extends BeltOpts {
  /** World positions of the input / output port snaps (the snap entry, #200). */
  snaps?: [[number, number, number], [number, number, number]];
}

interface PoseRig {
  runner: DESRunner;
  conv: BuiltConveyor;
  holder: Holder;
  sinkAt: Map<number, number>;
  /** A fresh MU of `size` held by `owner` (default: the holder). */
  heldMU(size: readonly [number, number, number], owner?: DESComponent): DESMU;
  /** Advance in small steps until `muId` reached the sink (or `maxS` passed). */
  runUntilSink(muId: number, maxS?: number): number | undefined;
  /**
   * Run `fn` INSIDE a DES event `delay` s after the render clock and leave the
   * render clock exactly at that event time — the way the real hand-over
   * callers (PalletYard) act: from an event, never from outside the clock.
   */
  act<T>(fn: () => T, delay?: number): T;
  nodeOf(mu: DESMU): Object3D;
}

function poseRig(o: PoseRigOpts): PoseRig {
  resetWorld();
  resetProblemsForTests();
  const runner = new DESRunner({ subMode: 'animated' });
  const conv = buildConveyor(runner, 'PoseConv', o);
  if (o.snaps) {
    const inSnap = new Object3D(); inSnap.position.set(...o.snaps[0]); inSnap.updateMatrixWorld(true);
    const outSnap = new Object3D(); outSnap.position.set(...o.snaps[1]); outSnap.updateMatrixWorld(true);
    const s = conv.self as unknown as { inputs: () => unknown[]; outputs: () => unknown[] };
    s.inputs = () => [{ id: 'in', role: 'input', snapNode: inSnap }];
    s.outputs = () => [{ id: 'out', role: 'output', snapNode: outSnap }];
  }
  const sinkAt = new Map<number, number>();
  const sinkRoot = new Object3D(); sinkRoot.name = 'PoseSink';
  let sink!: MaterialFlowAdapter;
  let pendingAct: (() => void) | null = null;
  const sinkDef = defineMaterialFlow<MaterialFlowSelf>({
    type: 'PoseSink', kind: 'sink', schema: {}, continuous: {},
    des: {
      onAccept(_s, mu) { sinkAt.set(mu.id, runner.simTime); return true; },
      // The test clock: `act()` runs its callback from this event.
      onProcessComplete() { const f = pendingAct; pendingAct = null; f?.(); },
    },
  }) as MaterialFlowDefinition;
  const sinkSelf = createSelf(bareContext(sinkRoot), sinkDef, {
    mode: 'des',
    scheduler: runner.makeScheduler(sinkDef, () => sink.entityId),
  });
  sink = runner.addInstance(sinkDef, sinkSelf, sinkRoot);
  runner.start([ConveyorDef, sinkDef], { root: new Object3D() });
  conv.adapter.nextComponents = [sink];
  sink.previousComponents = [conv.adapter];
  conv.self.signals.set('Flow.Run', true);
  const holderNode = new Object3D(); holderNode.name = 'Fork';
  const holder = new Holder(holderNode);
  runner.getManager().registerComponent(holder);
  return {
    runner, conv, holder, sinkAt,
    heldMU(size, owner = holder) {
      const mu = runner.createMU();
      sinkAt.delete(mu.id); // ids of retired MUs are recycled
      mu.visual = makeVisual(size) as unknown as DESMU['visual'];
      presetMuBugSize(mu as unknown as MU, size);
      expect(owner.acceptMU(mu)).toBe(true);
      return mu;
    },
    runUntilSink(muId, maxS = 30) {
      for (let t = 0; t < maxS && !sinkAt.has(muId); t += 0.05) { runner.tick(0.05); runner.lateTick(0.05); }
      return sinkAt.get(muId);
    },
    act<T>(fn: () => T, delay = 1.0): T {
      // Default 1 s: start the hand-overs off t = 0 so "now + remaining" is not
      // trivially "remaining".
      const at = Math.max(runner.renderClock, runner.simTime) + delay;
      let out: { v: T } | null = null;
      pendingAct = () => { out = { v: fn() }; };
      sinkSelf.at(at, 'ProcessComplete', null);
      runner.tick(at - runner.renderClock);
      runner.lateTick(0);
      expect(out).not.toBeNull();
      expect(runner.simTime).toBeCloseTo(at, 9);
      return out!.v;
    },
    nodeOf(mu) { return (mu.visual as unknown as FakeVisual).node; },
  };
}

const BIG = [0.8, 0.15, 1.2] as const;   // bug 0.6 m
const SMALL = [0.4, 0.3, 0.6] as const;  // bug 0.3 m

/** World point at `along` (m) on a flow axis (entry `e`, unit dir `d`), shifted sideways / lifted. */
function axisPoint(
  e: [number, number, number], d: [number, number, number], along: number, side = 0, up = 0,
): [number, number, number] {
  // side = horizontal normal of d: (d.z, 0, −d.x)
  return [e[0] + d[0] * along + d[2] * side, e[1] + d[1] * along + up, e[2] + d[2] * along - d[0] * side];
}

interface BeltCase {
  name: string;
  opts: PoseRigOpts;
  /** Leading-edge entry (world) and unit flow direction the transit rides. */
  entry: [number, number, number];
  dir: [number, number, number];
  lengthM: number;
  size: readonly [number, number, number];
}

const SPEED = 500; // mm/s
const CASES: BeltCase[] = [
  {
    name: 'bounds entry, +Z belt, big MU',
    opts: { lengthM: 2, speedMmS: SPEED },
    entry: [0, 0.1, -1], dir: [0, 0, 1], lengthM: 2, size: BIG,
  },
  {
    name: 'bounds entry, +Z belt, small MU',
    opts: { lengthM: 2, speedMmS: SPEED },
    entry: [0, 0.1, -1], dir: [0, 0, 1], lengthM: 2, size: SMALL,
  },
  {
    // #200: snaps inside the bounds (rollers shorter than the frame) - the
    // transit rides the snaps, NOT the bounds; height still = roller top.
    name: 'snap entry (inside the bounds), big MU',
    opts: { lengthM: 2, speedMmS: SPEED, snaps: [[0, 0.03, -0.9], [0, 0.03, 0.9]] },
    entry: [0, 0.1, -0.9], dir: [0, 0, 1], lengthM: 1.8, size: BIG,
  },
  {
    name: 'baked belt (separate rollers, #200), small MU',
    opts: { lengthM: 2, speedMmS: SPEED, rollers: 8 },
    entry: [0, 0.1, -1], dir: [0, 0, 1], lengthM: 2, size: SMALL,
  },
  {
    name: 'rotated belt (yaw +90 deg, flows +X, off the origin), big MU',
    opts: { lengthM: 2, speedMmS: SPEED, at: [5, 0.5, 3], yaw: Math.PI / 2 },
    entry: [4, 0.6, 3], dir: [1, 0, 0], lengthM: 2, size: BIG,
  },
];

describe('9.1 pose take-over through the runner (transferMUWithPose)', () => {
  for (const c of CASES) {
    for (const where of ['entry', 'middle', 'end'] as const) {
      it(`${c.name}: take-over at the ${where}`, () => {
        const rig = poseRig(c.opts);
        const bug = c.size[2] / 2;
        const along = where === 'entry' ? -bug : where === 'middle' ? c.lengthM / 2 : c.lengthM - bug;
        const pos = axisPoint(c.entry, c.dir, along);
        const mu = rig.heldMU(c.size);
        const s = Math.min(c.lengthM, Math.max(0, along + bug));
        const remaining = ((c.lengthM - s) * 1000) / SPEED;

        let loadAfter = -1;
        const res = rig.act(() => {
          const r = rig.runner.transferMUWithPose(mu, rig.conv.adapter, { position: pos, yaw: 0 });
          loadAfter = rig.conv.adapter.currentLoad;
          // Ownership moved, the pose is gone again.
          expect(rig.holder.currentLoad).toBe(0);
          expect(mu.currentComponent).toBe(rig.conv.adapter);
          expect(rig.conv.adapter.pendingPoseCount).toBe(0);
          return r;
        });
        const t0 = rig.runner.simTime;
        expect(res).toEqual({ ok: true });
        expect(loadAfter).toBe(1);

        // Tween starts AT the pose (<= 1 mm) - no jump back to the entry. (At
        // the very end the remaining time is 0: the MU leaves in the same event.)
        if (remaining > 1e-9) {
          const p = rig.nodeOf(mu).position;
          expect(Math.hypot(p.x - pos[0], p.y - pos[1], p.z - pos[2])).toBeLessThanOrEqual(0.001);
        }

        // Arrival after the remaining time (L - s)/v, s = clamp(along + bug, 0, L).
        const at = rig.runUntilSink(mu.id);
        expect(at).toBeDefined();
        expect(at! - t0).toBeCloseTo(remaining, 6);
        rig.runner.dispose();
      });
    }
  }

  it('a take-over at the entry matches the legacy transit time and end point', () => {
    const c = CASES[2]; // snap entry
    const rig = poseRig(c.opts);
    const bug = c.size[2] / 2;
    const mu = rig.heldMU(c.size);
    const legacyTime = rig.conv.self.local.timer!.transitTime;
    rig.act(() => rig.runner.transferMUWithPose(mu, rig.conv.adapter, { position: axisPoint(c.entry, c.dir, -bug) }));
    const t0 = rig.runner.simTime;
    // Just before the arrival the MU is (almost) at exit - bug, as with tween().
    for (let t = 0; t < legacyTime - 0.05; t += 0.05) { rig.runner.tick(0.05); rig.runner.lateTick(0.05); }
    const p = rig.nodeOf(mu).position;
    const end = axisPoint(c.entry, c.dir, c.lengthM - bug);
    expect(Math.hypot(p.x - end[0], p.y - end[1], p.z - end[2])).toBeLessThan(0.05);
    expect(rig.runUntilSink(mu.id)! - t0).toBeCloseTo(legacyTime, 6);
    rig.runner.dispose();
  });
});

describe('9.2 plausibility - refused before the owner changes', () => {
  const c = CASES[0];
  const bug = c.size[2] / 2;
  const variants: Array<[string, [number, number, number]]> = [
    ['30 mm beside the axis', axisPoint(c.entry, c.dir, 1, 0.03)],
    ['30 mm too high', axisPoint(c.entry, c.dir, 1, 0, 0.03)],
    ['1 m behind the belt', axisPoint(c.entry, c.dir, -bug - 1)],
    ['beyond the belt end', axisPoint(c.entry, c.dir, c.lengthM - bug + 0.05)],
  ];
  for (const [name, pos] of variants) {
    it(`${name}: canAccept false, Problems entry, the owner keeps the MU`, () => {
      const rig = poseRig(c.opts);
      const mu = rig.heldMU(c.size);
      const res = rig.runner.transferMUWithPose(mu, rig.conv.adapter, { position: pos });
      expect(res).toEqual({ ok: false, reason: 'refused', ownerKept: true });
      expect(rig.holder.currentLoad).toBe(1);
      expect(rig.holder.held).toBe(mu);
      expect(mu.currentComponent).toBe(rig.holder);
      expect(rig.conv.adapter.currentLoad).toBe(0);
      expect(rig.conv.adapter.pendingPoseCount).toBe(0);
      const problems = getProblems().filter(p => p.code === 'transfer-pose-off-belt');
      expect(problems).toHaveLength(1);
      expect(problems[0].detail).toMatch(/actual: .*expected: /);
      rig.runner.dispose();
    });
  }

  it('19 mm off (inside the tolerance) is accepted', () => {
    const rig = poseRig(c.opts);
    const mu = rig.heldMU(c.size);
    const res = rig.runner.transferMUWithPose(mu, rig.conv.adapter, {
      position: axisPoint(c.entry, c.dir, 1, 0.019, -0.019),
    });
    expect(res.ok).toBe(true);
    expect(getProblems().filter(p => p.code === 'transfer-pose-off-belt')).toHaveLength(0);
    rig.runner.dispose();
  });

  it('a type without des.acceptsPose refuses the pose hand-over untouched', () => {
    const rig = poseRig(c.opts);
    const otherRoot = new Object3D(); otherRoot.name = 'NoPose';
    const def = defineMaterialFlow<MaterialFlowSelf>({
      type: 'NoPoseStation', kind: 'station', schema: {}, continuous: {},
      des: { onAccept() { return true; } },
    }) as MaterialFlowDefinition;
    let other!: MaterialFlowAdapter;
    const otherSelf = createSelf(bareContext(otherRoot), def, {
      mode: 'des', scheduler: rig.runner.makeScheduler(def, () => other.entityId),
    });
    other = rig.runner.addInstance(def, otherSelf, otherRoot);
    const mu = rig.heldMU(c.size);
    expect(rig.runner.transferMUWithPose(mu, other, { position: [0, 0, 0] }))
      .toEqual({ ok: false, reason: 'pose-unsupported', ownerKept: true });
    expect(rig.holder.held).toBe(mu);
    rig.runner.dispose();
  });
});

describe('9.3 one-shot pose + re-entrancy (R2-1)', () => {
  const c = CASES[0];
  const bug = c.size[2] / 2;

  it('after a refusal the pose is gone: a plain transfer takes the legacy path', () => {
    const rig = poseRig(c.opts);
    const mu = rig.heldMU(c.size);
    rig.act(() => rig.runner.transferMUWithPose(mu, rig.conv.adapter, { position: axisPoint(c.entry, c.dir, 1, 0.05) }));
    expect(rig.holder.held).toBe(mu);
    rig.act(() => {
      rig.holder.releaseMU(mu);
      expect(rig.conv.adapter.acceptMU(mu)).toBe(true);
    });
    const t0 = rig.runner.simTime;
    const p = rig.nodeOf(mu).position;
    const legacyFrom = axisPoint(c.entry, c.dir, -bug);
    expect(Math.hypot(p.x - legacyFrom[0], p.y - legacyFrom[1], p.z - legacyFrom[2])).toBeLessThanOrEqual(0.001);
    expect(rig.runUntilSink(mu.id)! - t0).toBeCloseTo(rig.conv.self.local.timer!.transitTime, 6);
    rig.runner.dispose();
  });

  it('after a success the pose is gone: the next MU takes the legacy path', () => {
    const rig = poseRig(c.opts);
    const a = rig.heldMU(c.size);
    rig.act(() => rig.runner.transferMUWithPose(a, rig.conv.adapter, { position: axisPoint(c.entry, c.dir, 1) }));
    rig.runUntilSink(a.id);
    const b = rig.heldMU(c.size);
    rig.act(() => {
      rig.holder.releaseMU(b);
      expect(rig.conv.adapter.acceptMU(b)).toBe(true);
    });
    const t0 = rig.runner.simTime;
    expect(rig.runUntilSink(b.id)! - t0).toBeCloseTo(rig.conv.self.local.timer!.transitTime, 6);
    rig.runner.dispose();
  });

  it('a nested plain hand-over inside the owner release fills the target -> rolled back to the owner', () => {
    const rig = poseRig(c.opts);
    const other = new Holder(new Object3D());
    rig.runner.getManager().registerComponent(other);
    const mu1 = rig.heldMU(c.size);
    const mu2 = rig.heldMU(c.size, other);
    let nestedSawPose: boolean | null = null;
    let fired = false;
    rig.holder.onMUExit = () => {
      if (fired) return;
      fired = true;
      // Re-entrant wake-up: another owner hands mu2 over WITHOUT a pose while
      // the pose of mu1 is pending - mu2 must not see it.
      nestedSawPose = rig.conv.adapter.pendingPoseCount > 0;
      other.releaseMU(mu2);
      expect(rig.conv.adapter.acceptMU(mu2)).toBe(true);
    };
    const res = rig.act(() =>
      rig.runner.transferMUWithPose(mu1, rig.conv.adapter, { position: axisPoint(c.entry, c.dir, 1) }));
    const t0 = rig.runner.simTime;
    expect(nestedSawPose).toBe(true); // the outer pose WAS pending during the nest
    expect(res).toEqual({ ok: false, reason: 'rolled-back', ownerKept: true });
    expect(rig.holder.held).toBe(mu1);            // mu1 is back on its owner
    expect(mu1.currentComponent).toBe(rig.holder);
    expect(rig.conv.adapter.currentLoad).toBe(1);  // only mu2 on the belt
    expect(rig.conv.adapter.pendingPoseCount).toBe(0);
    // mu2 took the LEGACY transit (full time, from the entry), not the pose of mu1.
    const p = rig.nodeOf(mu2).position;
    const legacyFrom = axisPoint(c.entry, c.dir, -bug);
    expect(Math.hypot(p.x - legacyFrom[0], p.y - legacyFrom[1], p.z - legacyFrom[2])).toBeLessThanOrEqual(0.001);
    expect(rig.runUntilSink(mu2.id)! - t0).toBeCloseTo(rig.conv.self.local.timer!.transitTime, 6);
    rig.runner.dispose();
  });

  it('a nested POSE hand-over sees only its own pose; the outer one is rolled back', () => {
    const rig = poseRig(c.opts);
    const other = new Holder(new Object3D());
    rig.runner.getManager().registerComponent(other);
    const mu1 = rig.heldMU(c.size);
    const mu2 = rig.heldMU(c.size, other);
    const pose2 = axisPoint(c.entry, c.dir, 0.4);
    let nested: unknown = null;
    let fired = false;
    rig.holder.onMUExit = () => {
      if (fired) return;
      fired = true;
      nested = rig.runner.transferMUWithPose(mu2, rig.conv.adapter, { position: pose2 });
    };
    const res = rig.act(() =>
      rig.runner.transferMUWithPose(mu1, rig.conv.adapter, { position: axisPoint(c.entry, c.dir, 1.2) }));
    const t0 = rig.runner.simTime;
    expect(nested).toEqual({ ok: true });
    expect(res).toEqual({ ok: false, reason: 'rolled-back', ownerKept: true });
    expect(rig.holder.held).toBe(mu1);
    expect(rig.conv.adapter.pendingPoseCount).toBe(0);
    const p = rig.nodeOf(mu2).position;
    expect(Math.hypot(p.x - pose2[0], p.y - pose2[1], p.z - pose2[2])).toBeLessThanOrEqual(0.001);
    const s2 = 0.4 + bug;
    expect(rig.runUntilSink(mu2.id)! - t0).toBeCloseTo(((c.lengthM - s2) * 1000) / SPEED, 6);
    rig.runner.dispose();
  });
});

describe('R2-3 pre-validation of a spawn pose without an MU', () => {
  const c = CASES[0];
  const bug = c.size[2] / 2;

  it('refuses while blocked, then succeeds once: exactly one MU, right owner, one production count', () => {
    const rig = poseRig(c.opts);
    const srcNode = new Object3D(); srcNode.name = 'SourceSlot';
    const source = new Holder(srcNode);
    rig.runner.getManager().registerComponent(source);
    const spawnPose = { position: axisPoint(c.entry, c.dir, 0.2), yaw: 0 };
    const offPose = { position: axisPoint(c.entry, c.dir, 0.2, 0.1), yaw: 0 };
    const musBefore = rig.runner.getManager().muCount;

    // (1) pose off the belt -> refused, Problems entry, nothing spawned.
    expect(rig.runner.canAcceptWithPose(rig.conv.adapter, c.size, offPose)).toBe(false);
    expect(getProblems().filter(p => p.code === 'transfer-pose-off-belt')).toHaveLength(1);
    expect(rig.runner.getManager().muCount).toBe(musBefore);
    // (2) belt occupied (global capacity, F4) -> refused even with a good pose.
    const blocker = rig.heldMU(c.size);
    rig.act(() => {
      rig.holder.releaseMU(blocker);
      rig.conv.adapter.acceptMU(blocker);
    });
    expect(rig.runner.canAcceptWithPose(rig.conv.adapter, c.size, spawnPose)).toBe(false);
    expect(rig.conv.adapter.pendingPoseCount).toBe(0);

    // The production cycle waits (pending) and retries every 50 ms; the retry
    // succeeds once the belt is free - exactly one MU is spawned for it.
    let produced: DESMU | null = null;
    let spawned = 0;
    let refusals = 0;
    const tryProduce = (): boolean => {
      if (!rig.runner.canAcceptWithPose(rig.conv.adapter, c.size, spawnPose)) { refusals++; return false; }
      const mu = rig.runner.createMU();
      rig.sinkAt.delete(mu.id); // ids of retired MUs are recycled
      spawned++;
      presetMuBugSize(mu as unknown as MU, c.size);
      const r = rig.runner.transferMUWithPose(mu, rig.conv.adapter, spawnPose, source);
      expect(r).toEqual({ ok: true });
      produced = mu;
      return true;
    };
    for (let i = 0; i < 400 && !produced; i++) rig.act(tryProduce, 0.05);
    expect(produced).not.toBeNull();
    expect(refusals).toBeGreaterThan(0); // at least one refused retry while blocked
    expect(spawned).toBe(1);             // exactly one MU for the production cycle
    expect(produced!.currentComponent).toBe(rig.conv.adapter);
    expect(rig.conv.adapter.currentLoad).toBe(1);
    expect(source.totalProcessed).toBe(1); // the production counter counts once
    expect(getProblems().filter(p => p.code === 'transfer-pose-off-belt')).toHaveLength(0);
    const t0 = rig.runner.simTime;
    expect(rig.runUntilSink(produced!.id)! - t0).toBeCloseTo(((c.lengthM - (0.2 + bug)) * 1000) / SPEED, 6);
    rig.runner.dispose();
  });
});

describe('plan-645 Phase 3 - runner.handOver (one call: pre-check, detach, hand-over, re-seat)', () => {
  const c = CASES[0];

  it('accepted: detach runs once, reseat never, the conveyor holds the MU', () => {
    const rig = poseRig(c.opts);
    const mu = rig.heldMU(c.size);
    const calls: string[] = [];
    const res = rig.act(() => rig.runner.handOver(mu, rig.conv.adapter, {
      pose: { position: axisPoint(c.entry, c.dir, 1) },
      detach: () => calls.push('detach'), reseat: () => calls.push('reseat'),
    }));
    expect(res).toEqual({ ok: true });
    expect(calls).toEqual(['detach']);
    expect(mu.currentComponent).toBe(rig.conv.adapter);
    rig.runner.dispose();
  });

  it('refused by the pre-check: nothing moves - not even the visual (no detach, no reseat)', () => {
    const rig = poseRig(c.opts);
    const mu = rig.heldMU(c.size);
    const calls: string[] = [];
    const res = rig.runner.handOver(mu, rig.conv.adapter, {
      pose: { position: axisPoint(c.entry, c.dir, 1, 0.05) },
      detach: () => calls.push('detach'), reseat: () => calls.push('reseat'),
    });
    expect(res).toEqual({ ok: false, reason: 'refused', ownerKept: true });
    expect(calls).toEqual([]);
    expect(rig.holder.held).toBe(mu);
    rig.runner.dispose();
  });

  it('rolled back after the pre-check: detach, then reseat, the owner keeps the MU', () => {
    const rig = poseRig(c.opts);
    const mu = rig.heldMU(c.size);
    const calls: string[] = [];
    const adapter = rig.conv.adapter as unknown as { acceptMU: (m: unknown) => boolean };
    adapter.acceptMU = () => false;   // passes canAccept, fails the accept itself
    const res = rig.runner.handOver(mu, rig.conv.adapter, {
      pose: { position: axisPoint(c.entry, c.dir, 1) },
      detach: () => calls.push('detach'), reseat: () => calls.push('reseat'),
    });
    expect(res).toEqual({ ok: false, reason: 'rolled-back', ownerKept: true });
    expect(calls).toEqual(['detach', 'reseat']);
    expect(rig.holder.held).toBe(mu);
    rig.runner.dispose();
  });

  it('an MU without an owner needs `from`', () => {
    const rig = poseRig(c.opts);
    const mu = rig.runner.createMU();
    expect(() => rig.runner.handOver(mu as never, rig.conv.adapter, { pose: { position: [0, 0, 0] } })).toThrow(/no owner/);
    rig.runner.dispose();
  });
});
