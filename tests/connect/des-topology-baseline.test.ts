// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * des-topology-baseline.test.ts — plan-633 Phase 0 (Gate R1 #4, R2-3).
 *
 * Freezes TODAY's DES topology BEFORE the unified connection resolver touches
 * the wiring, so Phases 2–3 can prove topology parity instead of asserting it:
 *
 *   1. Material-flow scenes through the REAL `bindSceneToRunner` → `wireTopology`
 *      (snap pass → 2-cycle breaker → typed distance fallback). Per scene:
 *        - the ORDERED successor list per instance (`nextComponents` in wiring
 *          order — routing is first-fit over that order, so sorting would hide a
 *          change) plus the predecessors;
 *        - the pass counters `wireTopology` logs (`broke N` / `auto-connected N`);
 *        - a short DES run bounded by EVENTS and SIM TIME (never wall clock) whose
 *          trace is every accepted hand-over `t:mu→instance` — the first-fit /
 *          router decision made visible.
 *      Edge count, an FNV-1a hash of the ordered topology text and a trace hash
 *      are pinned as REFERENCE constants.
 * plan-2006 C1: the retired native-component resolver section was removed.
 * Its behaviour-side coverage is in logical-connections.test.ts and
 * rv-connection-resolver.node.test.ts. The runner REFERENCE below is unchanged.
 * Each scene also asserts the binding's stage counters; the breakTwoCycles
 * guard count must be 0.
 *
 * The counter-examples the old classification produces (a conveyor↔turntable
 * double output that the 2-cycle breaker repairs; a distance fallback that wires
 * a conveyor BACKWARDS in the headless case) are DELIBERATELY part of the
 * baseline (plan-633 Gate R2-3): they must not vanish by re-recording.
 *
 * Re-recording: set `RECORD = true`, run, copy the printed table into REFERENCE.
 * Only the plan owner decides when a reference may change.
 *
 * Imports `@rv/plugins/des/*` — DES is core code since plan-680.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Object3D, Mesh, BoxGeometry, Vector3, Scene } from 'three';
import { DESRunner } from '@rv/plugins/des/des-runner';
import {
  bindSceneToRunner,
  containedTargetOf,
  getLastWireTopologyStats,
  type WireTopologyStats,
} from '@rv/plugins/des/des-scene-binding';
import { _resetDesHookCache } from '@rv/plugins/des/des-hook-adapter';
import { resetDESMUCounter } from '@rv/plugins/des/rv-des-mu';
import { DESManager } from '@rv/plugins/des/rv-des-manager';
import { DESComponent } from '@rv/plugins/des/rv-des-component';
import type { MaterialFlowAdapter } from '@rv/plugins/des/material-flow-adapter';
import Source from '../../src/behaviors/Source';
import Sink from '../../src/behaviors/Sink';
import { ConveyorFlow } from '../../src/behaviors/Conveyor';
import { TurntableFlow } from '../../src/behaviors/Turntable';
import { AgvFlow } from '../../src/behaviors/Agv';
import {
  _resetMaterialFlowRegistry,
  getMaterialFlow,
  registerMaterialFlow,
} from '../../src/core/material-flow/registry';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { BindContextHost } from '../../src/core/behavior-runtime';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import { SnapPointRegistry, type PlacedComponentId } from '../../src/core/engine/rv-snap-point-registry';
import { scanAndRegisterSnaps } from '../../src/plugins/snap-point/snap-scanner';
import { computeProximityPairings, type RebuildSnapInput } from '../../src/plugins/snap-point/snap-pairing-rebuild';
import { NodeRegistry } from '../../src/core/engine/rv-node-registry';
import { SignalStore } from '../../src/core/engine/rv-signal-store';
import {
  resolveConnectionsDetailed,
  surfacesFromComponentRegistry,
  type Connectable,
  type SurfaceComponentRegistry,
} from '../../src/core/connect/rv-connection-resolver';
import { getConnectionRegistry } from '../../src/core/connect/rv-connection-registry';
import {
  autoConnectByDistance,
  type ConnectableInstance,
} from '@rv/plugins/des/logical-connections';

void Source; void Sink;

/** Flip to true to print a fresh REFERENCE table (never commit it as true). */
const RECORD = false;

/** Same value as `SNAP_PAIR_REBUILD_EPS_M` (snap-point plugin) — not imported so
 *  the baseline does not pull the whole planner plugin into this test. */
const SNAP_PAIR_EPS_M = 0.03;

/** Sim-time horizon and event budget of the trace run (sim seconds / events). */
const TRACE_SIM_TIME_S = 60;
const TRACE_MAX_EVENTS = 4000;

// ─── Hashing ────────────────────────────────────────────────────────────────

/** FNV-1a 32-bit, hex. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ─── Deterministic identity ─────────────────────────────────────────────────

/**
 * Three.js generates random uuids, and BOTH the distance fallback and the
 * 2-cycle breaker tie-break by uuid. A baseline must therefore pin them:
 * every node gets a uuid from its traversal index under the scene.
 */
function pinUuids(scene: Object3D): void {
  let i = 0;
  scene.traverse((n) => {
    n.uuid = `00000000-0000-4000-8000-${String(i++).padStart(12, '0')}`;
  });
}

// ─── Scene building blocks (metres, +X = belt travel in local frame) ────────

const CONVEYOR_LENGTH = 1.0;
const CONVEYOR_WIDTH = 0.4;
const BELT_HEIGHT = 0.1;
const BELT_SPEED_MM_S = 500;

interface Built {
  scene: Scene;
  /** Placement roots in creation order (owner roots for the snap scan). */
  placements: Object3D[];
  /** Belt drives for the bind host (conveyor transport surfaces). */
  drives: BindContextHost['drives'];
  /** World travel direction per `Transport-*` node (for classifyConnections). */
  surfaces: Map<Object3D, Vector3>;
}

function newBuilt(): Built {
  return { scene: new Scene(), placements: [], drives: [], surfaces: new Map() };
}

function placement(b: Built, name: string, payload: Record<string, unknown>): Object3D {
  const root = new Object3D();
  root.name = name;
  root.userData.realvirtual = { LayoutObject: { Name: name }, ...payload };
  b.scene.add(root);
  b.placements.push(root);
  return root;
}

function snap(parent: Object3D, name: string, x: number, y = 0, z = 0): Object3D {
  const s = new Object3D();
  s.name = name;
  s.position.set(x, y, z);
  parent.add(s);
  return s;
}

/**
 * A straight conveyor along its local +X: belt mesh `Transport-X` (carries the
 * drive), a `Sensor`, input snap at −X, output snap at +X (typeId `convroll`).
 * `yawDeg` rotates the whole placement around +Y.
 */
function conveyor(b: Built, name: string, x: number, z: number, yawDeg = 0, snaps = true): Object3D {
  const root = placement(b, name, { Conveyor: {} });
  root.position.set(x, 0, z);
  root.rotation.y = (yawDeg * Math.PI) / 180;
  const belt = new Mesh(new BoxGeometry(CONVEYOR_LENGTH, BELT_HEIGHT, CONVEYOR_WIDTH));
  belt.name = 'Transport-X';
  root.add(belt);
  const sensor = new Object3D(); sensor.name = 'Sensor'; root.add(sensor);
  if (snaps) {
    snap(root, 'Snap-XN-convroll', -CONVEYOR_LENGTH / 2);
    snap(root, 'Snap-XP-convroll', +CONVEYOR_LENGTH / 2);
  }
  b.drives.push({ name: 'Transport-X', node: belt, TargetSpeed: BELT_SPEED_MM_S });
  const dir = new Vector3(1, 0, 0).applyAxisAngle(new Vector3(0, 1, 0), root.rotation.y);
  b.surfaces.set(belt, dir);
  return root;
}

/** A Source placement (box geometry), optional output snap at +X. */
function source(b: Built, name: string, x: number, y: number, z: number, snapAt?: number): Object3D {
  const root = placement(b, name, { Source: { Interval: 2, AutomaticGeneration: true } });
  root.position.set(x, y, z);
  const box = new Mesh(new BoxGeometry(0.3, 0.05, 0.3));
  box.name = 'SourceBody';
  root.add(box);
  if (snapAt !== undefined) snap(root, 'Snap-XP-convroll', snapAt);
  return root;
}

/** A Sink placement (box geometry), optional input snap at local x. */
function sink(b: Built, name: string, x: number, z: number, snapAt?: number, yawDeg = 0): Object3D {
  const root = placement(b, name, { Sink: {} });
  root.position.set(x, 0, z);
  root.rotation.y = (yawDeg * Math.PI) / 180;
  const box = new Mesh(new BoxGeometry(0.4, 0.4, 0.4));
  box.name = 'SinkBody';
  root.add(box);
  if (snapAt !== undefined) snap(root, 'Snap-XN-convroll', snapAt);
  return root;
}

/**
 * A turntable at (x, z): rotary `Drive-Rot-Y`, `Sensor`, its own belt
 * `Transport-X` (travel = `beltDir`), four bidi ports (forced bidi by the asset
 * name) at ±0.5 m on X and Z.
 */
function turntable(b: Built, name: string, x: number, z: number, beltDir: Vector3): Object3D {
  const root = placement(b, name, { Turntable: {} });
  root.position.set(x, 0, z);
  const rot = new Object3D(); rot.name = 'Drive-Rot-Y'; root.add(rot);
  const belt = new Mesh(new BoxGeometry(0.9, BELT_HEIGHT, 0.9));
  belt.name = 'Transport-X';
  rot.add(belt);
  const sensor = new Object3D(); sensor.name = 'Sensor'; rot.add(sensor);
  snap(rot, 'Snap-XN-convroll', -0.5);
  snap(rot, 'Snap-XP-convroll', +0.5);
  snap(rot, 'Snap-ZN-convroll', 0, 0, -0.5);
  snap(rot, 'Snap-ZP-convroll', 0, 0, +0.5);
  // The DES drive tween writes `currentPosition` + `applyToNode()` (RVDrive
  // surface); the angle is irrelevant for the topology, so the write is inert.
  b.drives.push({ name: 'Drive-Rot-Y', node: rot, currentPosition: 0, applyToNode() {} } as never);
  b.drives.push({ name: 'Transport-X', node: belt, TargetSpeed: BELT_SPEED_MM_S });
  b.surfaces.set(belt, beltDir.clone().normalize());
  return root;
}

// ─── Hosts ──────────────────────────────────────────────────────────────────

/**
 * Snap registry exactly as the planner builds it: one scan PER PLACEMENT (owner
 * = placement root), then the proximity pairing of `rebuildPairings`.
 */
function buildPlannerRegistry(b: Built): SnapPointRegistry {
  const reg = new SnapPointRegistry();
  b.scene.updateMatrixWorld(true);
  for (const root of b.placements) scanAndRegisterSnaps(root, reg, root);
  const wp = new Vector3();
  const inputs: RebuildSnapInput[] = [];
  for (const sp of reg.getAll()) {
    if (sp.occupied) continue;
    sp.object3D.getWorldPosition(wp);
    inputs.push({ id: sp.id, typeId: sp.typeId, flow: sp.flow, owner: sp.ownerRoot, x: wp.x, y: wp.y, z: wp.z });
  }
  for (const { aId, bId } of computeProximityPairings(inputs, SNAP_PAIR_EPS_M)) {
    const a = reg.getById(aId)!;
    const c = reg.getById(bId)!;
    reg.markOccupied(a.id, `snap:${c.id}` as PlacedComponentId);
    reg.markOccupied(c.id, `snap:${a.id}` as PlacedComponentId);
    reg.pair(a.id, c.id);
  }
  return reg;
}

interface HostOptions {
  /** Snap-point plugin present (planner) — else headless (no plugin). */
  snapRegistry: SnapPointRegistry | null;
  /** Component registry that resolves `TransportSurface` (classifyConnections). */
  surfaces: Map<Object3D, Vector3> | null;
}

function makeHost(b: Built, opts: HostOptions): BindContextHost {
  const events = new EventEmitter<Record<string, unknown>>();
  const surfaces = opts.surfaces;
  // A real NodeRegistry + SignalStore: with a registry present the bind path
  // materialises signal nodes, which needs the full write surface of both.
  // Only `findInChildren` is redirected — it resolves the `TransportSurface`
  // travel direction classifyConnections reads.
  let registry: NodeRegistry | null = null;
  if (surfaces) {
    registry = new NodeRegistry();
    (registry as unknown as { findInChildren: unknown }).findInChildren = <T,>(node: Object3D, type: string): T | null => {
      if (type !== 'TransportSurface') return null;
      let found: { getWorldDirection(out?: Vector3): Vector3 } | null = null;
      node.traverse((n) => {
        if (found) return;
        const d = surfaces.get(n);
        if (d) found = { getWorldDirection: (out = new Vector3()) => out.copy(d) };
      });
      return found as unknown as T | null;
    };
  }
  const reg = opts.snapRegistry;
  return {
    signalStore: new SignalStore(),
    on: (e: string, cb: (...args: unknown[]) => void) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: b.drives,
    registry: registry as never,
    getPlugin: (id: string) => (id === 'snap-point' && reg ? { getRegistry: () => reg } : undefined),
  } as unknown as BindContextHost;
}

// ─── Material-flow defs (captured once, re-registered per scene) ────────────

const DEFS: MaterialFlowDefinition[] = [
  getMaterialFlow('Source')!,
  getMaterialFlow('Sink')!,
  ConveyorFlow as unknown as MaterialFlowDefinition,
  TurntableFlow as unknown as MaterialFlowDefinition,
  AgvFlow as unknown as MaterialFlowDefinition,
];

function resetWorld(): void {
  _resetMaterialFlowRegistry();
  for (const d of DEFS) registerMaterialFlow(d);
  _resetDesHookCache();
  resetDESMUCounter();
}

// ─── Capture ────────────────────────────────────────────────────────────────

interface Capture {
  /** Ordered topology text (one line per instance + the pass counters). */
  topology: string;
  edges: number;
  /** Accepted hand-overs `t:mu→instance`, in event order. */
  trace: string;
  traceEvents: number;
  /** The binding's stage counters (plan-633 Phase 2), read right after the bind. */
  stats: WireTopologyStats | null;
  /** The connection registry the host answered with right after the bind. */
  registryAfterBind: unknown;
  /** ...and after the runner was disposed (binding lifetime). */
  registryAfterDispose: unknown;
}

function nameOf(adapter: MaterialFlowAdapter | DESComponent): string {
  return (adapter as { node?: Object3D }).node?.name ?? '?';
}

/**
 * Bind `b` through the production binding, record the ordered topology and the
 * `wireTopology` pass counters, then run the DES (events + sim time bounded)
 * and record every accepted hand-over.
 */
function capture(b: Built, host: BindContextHost, run: boolean): Capture {
  resetWorld();
  pinUuids(b.scene);
  b.scene.updateMatrixWorld(true);

  const info: string[] = [];
  const spy = vi.spyOn(console, 'info').mockImplementation((...args: unknown[]) => {
    const msg = String(args[0] ?? '');
    if (msg.startsWith('[des-binding]')) info.push(msg);
  });
  const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: TRACE_SIM_TIME_S, masterSeed: 7 });
  let count: number;
  try {
    count = bindSceneToRunner(runner, b.scene, host);
  } finally {
    spy.mockRestore();
  }
  const stats = getLastWireTopologyStats();
  const registryAfterBind = getConnectionRegistry(host as never);

  const lines: string[] = [`instances=${count}`];
  let edges = 0;
  for (const inst of runner.liveInstances) {
    const a = inst.adapter as MaterialFlowAdapter;
    edges += a.nextComponents.length;
    lines.push(
      `${inst.self.root.name}<${inst.def.type}> next=[${a.nextComponents.map(nameOf).join(',')}]`
      + ` prev=[${a.previousComponents.map(nameOf).join(',')}]`,
    );
  }
  lines.push(...info);
  const topology = lines.join('\n');

  const trace: string[] = [];
  if (run) {
    const manager = (runner as unknown as { manager: DESManager }).manager;
    for (const inst of runner.liveInstances) {
      const a = inst.adapter as MaterialFlowAdapter;
      const orig = a.acceptMU.bind(a);
      a.acceptMU = ((mu: { id: number }) => {
        const ok = orig(mu as never);
        if (ok) trace.push(`${manager.currentTime.toFixed(4)}:${mu.id}>${inst.self.root.name}`);
        return ok;
      }) as typeof a.acceptMU;
    }
    host.signalStore!.set('Flow.Run', true);
    runner.start([...DEFS], { root: b.scene });
    manager.processUpTo(TRACE_SIM_TIME_S, TRACE_MAX_EVENTS);
  }
  runner.dispose?.();
  const registryAfterDispose = getConnectionRegistry(host as never);
  return {
    topology, edges, trace: trace.join('\n'), traceEvents: trace.length,
    stats, registryAfterBind, registryAfterDispose,
  };
}

/**
 * The SAME scene resolved by the Phase-1 core resolver instead of
 * `wireTopology` — links applied in list order to fresh next/prev lists and
 * printed in the baseline format (stage counters in the binding's log
 * wording). Phase 1 changes no wiring; this proves the resolver alone already
 * reproduces the frozen topology, before Phase 2 switches the binding over.
 */
function resolverTopology(b: Built, host: BindContextHost): string {
  resetWorld();
  pinUuids(b.scene);
  b.scene.updateMatrixWorld(true);
  const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
  const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: TRACE_SIM_TIME_S, masterSeed: 7 });
  let count: number;
  try {
    count = bindSceneToRunner(runner, b.scene, host);
  } finally {
    spy.mockRestore();
  }
  const insts = runner.liveInstances;
  const conns: Connectable[] = insts.map((i) => ({
    root: i.self.root,
    kind: i.def.kind ?? '',
    connectionType: 'material-flow',
    autoConnect: (i.adapter as MaterialFlowAdapter).autoConnect,
  }));
  const compReg = host.registry as unknown as Partial<SurfaceComponentRegistry> | null;
  const result = resolveConnectionsDetailed(conns, {
    registry: getConnectionRegistry(host as never),
    surfacesOf: compReg && typeof compReg.findInChildren === 'function'
      ? surfacesFromComponentRegistry(compReg as SurfaceComponentRegistry)
      : undefined,
  });
  const indexOf = new Map<Object3D, number>();
  insts.forEach((i, k) => indexOf.set(i.self.root, k));
  const next: string[][] = insts.map(() => []);
  const prev: string[][] = insts.map(() => []);
  for (const l of result.links) {
    const f = indexOf.get(l.from)!;
    const t = indexOf.get(l.to)!;
    if (!next[f].includes(l.to.name)) next[f].push(l.to.name);
    if (!prev[t].includes(l.from.name)) prev[t].push(l.from.name);
  }
  const lines = [`instances=${count}`];
  insts.forEach((i, k) => {
    lines.push(`${i.self.root.name}<${i.def.type}> next=[${next[k].join(',')}] prev=[${prev[k].join(',')}]`);
  });
  if (result.conflictsResolved > 0) {
    lines.push(`[des-binding] broke ${result.conflictsResolved} bidirectional 2-cycle(s) from the snap graph.`);
  }
  if (result.distanceLinks > 0) {
    lines.push(`[des-binding] auto-connected ${result.distanceLinks} material-flow link(s) by distance.`);
  }
  runner.dispose?.();
  return lines.join('\n');
}

// ─── Scenes ─────────────────────────────────────────────────────────────────

interface SceneCase {
  readonly id: string;
  readonly note: string;
  readonly run: boolean;
  /** plan-633 F4: no snap-point plugin → the binding builds a headless registry. */
  readonly headless: boolean;
  build(): { b: Built; host: BindContextHost };
}

/** Source → Conveyor_1 → Conveyor_2 → Sink, every link a coincident snap pair. */
function snapLine(withPlugin: boolean): { b: Built; host: BindContextHost } {
  const b = newBuilt();
  source(b, 'Source_1', -0.75, 0, 0, 0.25);
  conveyor(b, 'Conveyor_1', 0, 0);
  conveyor(b, 'Conveyor_2', 1, 0);
  sink(b, 'Sink_1', 1.75, 0, -0.25);
  const reg = withPlugin ? buildPlannerRegistry(b) : null;
  return { b, host: makeHost(b, { snapRegistry: reg, surfaces: null }) };
}

/**
 * Infeed → Turntable → two outfeeds (+X and +Z), each into a sink. The
 * turntable's own belt travels `beltDir`; with +X every role is unambiguous,
 * with −X the outfeed on +X mis-reads the table as its OUTPUT (the conveyor↔
 * turntable double output the 2-cycle breaker repairs today — R2-3 counter-
 * example).
 */
function turntableCross(beltDir: Vector3): { b: Built; host: BindContextHost } {
  const b = newBuilt();
  source(b, 'Source_1', -1.75, 0, 0, 0.25);
  conveyor(b, 'Conveyor_In', -1, 0);
  turntable(b, 'Turntable_1', 0, 0, beltDir);
  conveyor(b, 'Conveyor_OutX', 1, 0);
  conveyor(b, 'Conveyor_OutZ', 0, 1, -90); // local +X → world +Z
  sink(b, 'Sink_X', 1.75, 0, -0.25);
  sink(b, 'Sink_Z', 0, 1.75, -0.25, -90);
  const reg = buildPlannerRegistry(b);
  return { b, host: makeHost(b, { snapRegistry: reg, surfaces: b.surfaces }) };
}

/** A pallet Source lying ON the first belt (distance 0, `contained`), the rest
 *  of the line without snaps and with gaps (distance fallback only, headless). */
function palletOnBelt(): { b: Built; host: BindContextHost } {
  const b = newBuilt();
  conveyor(b, 'Conveyor_1', 0, 0, 0, false);
  conveyor(b, 'Conveyor_2', 1.2, 0, 0, false);
  source(b, 'EuropalletLoaded', -0.3, 0, 0); // centre inside Conveyor_1's AABB
  sink(b, 'Sink_1', 2.1, 0);
  return { b, host: makeHost(b, { snapRegistry: null, surfaces: null }) };
}

/** Snap-wired conveyor pair plus an un-snapped Source on the belt and a sink
 *  beside the line end — snap pass and distance pass in ONE scene. */
function mixedSnapDistance(): { b: Built; host: BindContextHost } {
  const b = newBuilt();
  conveyor(b, 'Conveyor_1', 0, 0);
  conveyor(b, 'Conveyor_2', 1, 0);
  source(b, 'Source_1', -0.25, 0, 0); // on Conveyor_1, no snap
  sink(b, 'Sink_1', 1.9, 0); // 0.2 m beyond the line end, no snap
  const reg = buildPlannerRegistry(b);
  return { b, host: makeHost(b, { snapRegistry: reg, surfaces: b.surfaces }) };
}

/** Three AGV payload nodes (kind conveyor, no geometry, no LayoutObject) —
 *  the AGVDemo topology as plan-455 binds it; the distance pass chains them. */
function agvDemo(): { b: Built; host: BindContextHost } {
  const b = newBuilt();
  const starts = [0, 3000, 6000];
  for (let i = 0; i < 3; i++) {
    const n = new Object3D();
    n.name = `AGV_${i + 1}`;
    n.userData.realvirtual = { Agv: { PathId: 'PathSouth', StartPosition: starts[i], TargetSpeed: 1000 } };
    b.scene.add(n);
  }
  return { b, host: makeHost(b, { snapRegistry: null, surfaces: null }) };
}

const SCENES: readonly SceneCase[] = [
  { id: 'snap-line', note: 'planner registry, flow-only roles', run: true, headless: false, build: () => snapLine(true) },
  { id: 'snap-line-headless', note: 'same geometry, no snap plugin (F4 case)', run: true, headless: true, build: () => snapLine(false) },
  { id: 'turntable-cross', note: 'router, belt +X, surface-refined roles', run: true, headless: false, build: () => turntableCross(new Vector3(1, 0, 0)) },
  { id: 'turntable-cross-flipped', note: 'router, belt -X: double-output counter-example', run: true, headless: false, build: () => turntableCross(new Vector3(-1, 0, 0)) },
  { id: 'pallet-on-belt', note: 'headless, source inside belt AABB (contained)', run: true, headless: true, build: palletOnBelt },
  { id: 'mixed-snap-distance', note: 'snap pass + distance pass', run: true, headless: false, build: mixedSnapDistance },
  { id: 'agvdemo', note: 'AGV payload nodes, topology only', run: false, headless: true, build: agvDemo },
];

/**
 * REFERENCE — recorded on the UNCHANGED stand (WV ab4da781 / PRIV f77f931),
 * twice, identical. `edges` = Σ nextComponents; `topo` = FNV-1a of the ordered
 * topology text; `trace` = FNV-1a of the hand-over trace ('-' = no run).
 */
// plan-2006 Phase 2 (#25 accept first / release as commit, E6): the trace hashes changed
// because hand-overs at the SAME instant now log the target accept before the sender's
// follow-up; event counts, event times and the multiset of events are identical (checked
// old vs new per scenario). Old -> new: b248d927->b02a794f, 60ec33bd->6c4aaad3,
// 216e97f2->c7c76244, 6e5d8d10->06952964.
// plan-2212 (deterministic MU ids): a sink-consumed MU retires at the end of its
// consuming event, not at the runner's post-batch sweep, so the MU slot ids in the
// trace are reused at a fixed point in DES time. Same event counts and topologies
// (asserted); the hashes moved with the MU ids. Old -> new: b02a794f->ce943ca0,
// 6c4aaad3->663b0020, c7c76244->a0bf67a2.
const REFERENCE: Record<string, { edges: number; topo: string; trace: string; traceEvents: number; topology: string }> = {
  'snap-line': {
    edges: 3, topo: '9ead4981', trace: 'ce943ca0', traceEvents: 90,
    topology: [
      'instances=4',
      'Source_1<Source> next=[Conveyor_1] prev=[]',
      'Conveyor_1<Conveyor> next=[Conveyor_2] prev=[Source_1]',
      'Conveyor_2<Conveyor> next=[Sink_1] prev=[Conveyor_1]',
      'Sink_1<Sink> next=[] prev=[Conveyor_2]',
    ].join('\n'),
  },
  // plan-633 Lauf B (Phase 2), the ONE documented F4 change. Without a snap-point
  // plugin the binding now builds a headless snap registry per component owner,
  // so the authored snaps wire the line exactly like the planner registry does
  // (identical to 'snap-line': same topology hash, same trace).
  //   added:   Conveyor_2 → Sink_1 (snap)
  //   removed: Conveyor_2 → Conveyor_1 (distance; the backwards 2-cycle)
  //   kept, now via snap instead of distance: Source_1 → Conveyor_1, Conveyor_1 → Conveyor_2
  // OLD value (Phase 0, WV ab4da781 / PRIV f77f931), kept for the record:
  //   edges: 3, topo: 'a36d6c87', trace: '6e5d8d10', traceEvents: 3,
  //   'Source_1<Source> next=[Conveyor_1] prev=[]',
  //   'Conveyor_1<Conveyor> next=[Conveyor_2] prev=[Source_1,Conveyor_2]',
  //   'Conveyor_2<Conveyor> next=[Conveyor_1] prev=[Conveyor_1]',
  //   'Sink_1<Sink> next=[] prev=[]',
  //   '[des-binding] auto-connected 3 material-flow link(s) by distance.',
  // (the line stalled after 3 hand-overs; the sink was never reached).
  'snap-line-headless': {
    edges: 3, topo: '9ead4981', trace: 'ce943ca0', traceEvents: 90,
    topology: [
      'instances=4',
      'Source_1<Source> next=[Conveyor_1] prev=[]',
      'Conveyor_1<Conveyor> next=[Conveyor_2] prev=[Source_1]',
      'Conveyor_2<Conveyor> next=[Sink_1] prev=[Conveyor_1]',
      'Sink_1<Sink> next=[] prev=[Conveyor_2]',
    ].join('\n'),
  },
  'turntable-cross': {
    edges: 6, topo: '91525fe1', trace: '663b0020', traceEvents: 71,
    topology: [
      'instances=7',
      'Source_1<Source> next=[Conveyor_In] prev=[]',
      'Conveyor_In<Conveyor> next=[Turntable_1] prev=[Source_1]',
      'Turntable_1<Turntable> next=[Conveyor_OutX,Conveyor_OutZ] prev=[Conveyor_In]',
      'Conveyor_OutX<Conveyor> next=[Sink_X] prev=[Turntable_1]',
      'Conveyor_OutZ<Conveyor> next=[Sink_Z] prev=[Turntable_1]',
      'Sink_X<Sink> next=[] prev=[Conveyor_OutX]',
      'Sink_Z<Sink> next=[] prev=[Conveyor_OutZ]',
    ].join('\n'),
  },
  'turntable-cross-flipped': {
    edges: 6, topo: 'b76ecbf4', trace: 'a0bf67a2', traceEvents: 67,
    topology: [
      'instances=7',
      'Source_1<Source> next=[Conveyor_In] prev=[]',
      'Conveyor_In<Conveyor> next=[Turntable_1] prev=[Source_1]',
      'Turntable_1<Turntable> next=[Conveyor_OutX,Conveyor_OutZ] prev=[Conveyor_In]',
      'Conveyor_OutX<Conveyor> next=[Sink_X] prev=[Turntable_1]',
      'Conveyor_OutZ<Conveyor> next=[Sink_Z] prev=[Turntable_1]',
      'Sink_X<Sink> next=[] prev=[Conveyor_OutX]',
      'Sink_Z<Sink> next=[] prev=[Conveyor_OutZ]',
      '[des-binding] broke 1 bidirectional 2-cycle(s) from the snap graph.',
      '[des-binding] auto-connected 1 material-flow link(s) by distance.',
    ].join('\n'),
  },
  'pallet-on-belt': {
    edges: 3, topo: 'cc1aa0e1', trace: 'ce943ca0', traceEvents: 90,
    topology: [
      'instances=4',
      'Conveyor_1<Conveyor> next=[Conveyor_2] prev=[EuropalletLoaded]',
      'Conveyor_2<Conveyor> next=[Sink_1] prev=[Conveyor_1]',
      'EuropalletLoaded<Source> next=[Conveyor_1] prev=[]',
      'Sink_1<Sink> next=[] prev=[Conveyor_2]',
      '[des-binding] auto-connected 3 material-flow link(s) by distance.',
    ].join('\n'),
  },
  'mixed-snap-distance': {
    edges: 3, topo: '2538e486', trace: '06952964', traceEvents: 3,
    topology: [
      'instances=4',
      'Conveyor_1<Conveyor> next=[Conveyor_2] prev=[Conveyor_2,Source_1]',
      'Conveyor_2<Conveyor> next=[Conveyor_1] prev=[Conveyor_1]',
      'Source_1<Source> next=[Conveyor_1] prev=[]',
      'Sink_1<Sink> next=[] prev=[]',
      '[des-binding] auto-connected 2 material-flow link(s) by distance.',
    ].join('\n'),
  },
  'agvdemo': {
    edges: 3, topo: '7b52f0c2', trace: '-', traceEvents: 0,
    topology: [
      'instances=3',
      'AGV_1<Agv> next=[AGV_2] prev=[AGV_2,AGV_3]',
      'AGV_2<Agv> next=[AGV_1] prev=[AGV_1]',
      'AGV_3<Agv> next=[AGV_1] prev=[]',
      '[des-binding] auto-connected 3 material-flow link(s) by distance.',
    ].join('\n'),
  },
};

// ─── Tests ──────────────────────────────────────────────────────────────────

describe('plan-633 Phase 0 — DES topology baseline (wireTopology)', () => {
  beforeEach(() => resetWorld());
  afterEach(() => { _resetMaterialFlowRegistry(); });

  const recorded: string[] = [];

  for (const sc of SCENES) {
    it(`${sc.id} — ${sc.note}`, () => {
      const { b, host } = sc.build();
      const first = capture(b, host, sc.run);
      // Determinism inside one run: a second build + bind yields the same text.
      const again = sc.build();
      const second = capture(again.b, again.host, sc.run);
      expect(second.topology).toBe(first.topology);
      expect(second.trace).toBe(first.trace);

      const got = {
        edges: first.edges,
        topo: fnv1a(first.topology),
        trace: sc.run ? fnv1a(first.trace) : '-',
        traceEvents: first.traceEvents,
      };
      if (RECORD) {
        recorded.push(`  '${sc.id}': ${JSON.stringify(got)},`);
        console.log(`[baseline ${sc.id}]\n${first.topology}\n--- trace (${first.traceEvents})\n${first.trace}`);
        console.log(recorded.join('\n'));
        return;
      }
      const ref = REFERENCE[sc.id];
      expect(ref, `REFERENCE for ${sc.id}`).toBeDefined();
      expect(first.topology, `${sc.id} ordered topology`).toBe(ref.topology);
      expect(got.edges, `${sc.id} edges\n${first.topology}`).toBe(ref.edges);
      expect(got.topo, `${sc.id} topology\n${first.topology}`).toBe(ref.topo);
      expect(got.traceEvents, `${sc.id} trace events\n${first.trace}`).toBe(ref.traceEvents);
      expect(got.trace, `${sc.id} trace\n${first.trace}`).toBe(ref.trace);
      if (sc.run) expect(first.traceEvents, `${sc.id} must actually flow`).toBeGreaterThan(0);

      // plan-633 Phase 2: the breakTwoCycles GUARD breaks nothing on any scene,
      // and the binding used the registry the scene calls for.
      expect(first.stats, `${sc.id} wire stats`).toBeDefined();
      expect(first.stats, `${sc.id} wire stats`).not.toBeNull();
      const st = first.stats!;
      expect(st.guardBroken, `${sc.id} guard`).toBe(0);
      expect(st.headlessRegistry, `${sc.id} headless registry`).toBe(sc.headless);
      expect(st.pluginPresent, `${sc.id} plugin`).toBe(!sc.headless);
      if (sc.headless) {
        // Lifetime = binding: attached while bound, gone after dispose.
        expect(first.registryAfterBind, `${sc.id} headless registry attached`).toBeTruthy();
        expect(first.registryAfterDispose, `${sc.id} headless registry released`).toBeNull();
      }
    });
  }
});

describe('plan-633 Phase 1 — the core resolver alone reproduces the baseline', () => {
  beforeEach(() => resetWorld());
  afterEach(() => { _resetMaterialFlowRegistry(); });

  for (const sc of SCENES) {
    it(`${sc.id}: resolveConnections == wireTopology (ordered, counters included)`, () => {
      const ref = REFERENCE[sc.id];
      expect(ref, `REFERENCE for ${sc.id}`).toBeDefined();
      const { b, host } = sc.build();
      expect(resolverTopology(b, host)).toBe(ref.topology);
    });
  }

  // Lauf A proved this against the ORIGINAL autoConnectByDistance. Since Phase 2
  // that function is a thin adapter over the same resolver stage, so the check
  // now guards the ADAPTER (mapping onto the facade + link application).
  it('distance stage == autoConnectByDistance on 60 seeded random layouts', () => {
    let seed = 0x633;
    const rnd = (): number => { seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0; return seed / 2 ** 32; };
    const KINDS = ['source', 'conveyor', 'conveyor', 'router', 'sink'];
    for (let round = 0; round < 60; round++) {
      const n = 3 + Math.floor(rnd() * 8);
      const olds: ConnectableInstance[] = [];
      const news: Connectable[] = [];
      for (let k = 0; k < n; k++) {
        const r = new Object3D();
        r.name = `N${k}`;
        r.uuid = `r${round}-${String(Math.floor(rnd() * 1e6)).padStart(6, '0')}-${k}`;
        r.position.set(rnd() * 3, 0, rnd() * 3);
        if (rnd() < 0.5) r.add(new Mesh(new BoxGeometry(0.2 + rnd(), 0.1, 0.2 + rnd())));
        r.updateMatrixWorld(true);
        const kind = KINDS[Math.floor(rnd() * KINDS.length)];
        const autoConnect = { enabled: rnd() > 0.1, maxDistance: rnd() < 0.3 ? 0 : 0.3 + rnd() * 1.5 };
        const subType = rnd() < 0.2 ? (rnd() < 0.5 ? 'a' : 'b') : undefined;
        const adapter = { node: r, nextComponents: [] as unknown[], previousComponents: [] as unknown[], autoConnect };
        olds.push({ root: r, adapter: adapter as never, kind, connectionType: 'material-flow', subType });
        news.push({ root: r, kind, connectionType: 'material-flow', subType, autoConnect });
      }
      autoConnectByDistance(olds);
      const oldEdges = olds.flatMap((o) =>
        (o.adapter.nextComponents as unknown as { node: Object3D }[]).map((t) => `${o.root.name}>${t.node.name}`));
      const newEdges = resolveConnectionsDetailed(news, { registry: null }).links.map((l) => `${l.from.name}>${l.to.name}`);
      expect(newEdges.sort(), `round ${round}`).toEqual(oldEdges.sort());
    }
  });
});

// ─── plan-633 Phase 2 — headless registry (F4, Gate R1 #3) ────────────────────

/** The turntable cross WITHOUT a snap-point plugin, transport surfaces present. */
function turntableCrossHeadless(): { b: Built; host: BindContextHost } {
  const b = newBuilt();
  source(b, 'Source_1', -1.75, 0, 0, 0.25);
  conveyor(b, 'Conveyor_In', -1, 0);
  turntable(b, 'Turntable_1', 0, 0, new Vector3(1, 0, 0));
  conveyor(b, 'Conveyor_OutX', 1, 0);
  conveyor(b, 'Conveyor_OutZ', 0, 1, -90);
  sink(b, 'Sink_X', 1.75, 0, -0.25);
  sink(b, 'Sink_Z', 0, 1.75, -0.25, -90);
  return { b, host: makeHost(b, { snapRegistry: null, surfaces: b.surfaces }) };
}

describe('plan-633 Phase 2 — headless connection registry (F4)', () => {
  beforeEach(() => resetWorld());
  afterEach(() => { _resetMaterialFlowRegistry(); });

  it('a headless router transfers for real: same topology AND same hand-over trace as with the planner registry', () => {
    const ref = REFERENCE['turntable-cross'];
    expect(ref, 'REFERENCE for turntable-cross').toBeDefined();
    const { b, host } = turntableCrossHeadless();
    const got = capture(b, host, true);
    expect(got.stats, 'wire stats').toBeDefined();
    expect(got.stats, 'wire stats').not.toBeNull();
    expect(got.stats!.headlessRegistry).toBe(true);
    expect(got.stats!.guardBroken).toBe(0);
    expect(got.topology).toBe(ref.topology);
    // The Turntable behaviour reads the SAME headless graph through the core
    // access point: its routing decisions reproduce the planner run exactly.
    expect(got.traceEvents, got.trace).toBe(ref.traceEvents);
    expect(fnv1a(got.trace), got.trace).toBe(ref.trace);
    expect(got.registryAfterBind, 'headless registry attached while bound').toBeTruthy();
    expect(got.registryAfterDispose, 'headless registry released on dispose').toBeNull();
  });

  it('a later binding keeps its own registry when an earlier runner is disposed', () => {
    const { b, host } = snapLine(false);
    resetWorld();
    pinUuids(b.scene);
    b.scene.updateMatrixWorld(true);
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    try {
      const r1 = new DESRunner({ subMode: 'fastforward', durationSeconds: 1, masterSeed: 1 });
      bindSceneToRunner(r1, b.scene, host);
      const reg1 = getConnectionRegistry(host as never);
      expect(reg1, 'first registry').toBeTruthy();
      const r2 = new DESRunner({ subMode: 'fastforward', durationSeconds: 1, masterSeed: 1 });
      bindSceneToRunner(r2, b.scene, host);
      const reg2 = getConnectionRegistry(host as never);
      expect(reg2, 'second registry').toBeTruthy();
      expect(reg2).not.toBe(reg1);
      r1.dispose();
      expect(getConnectionRegistry(host as never), 'r1 dispose must not drop r2').toBe(reg2);
      r2.dispose();
      expect(getConnectionRegistry(host as never)).toBeNull();
    } finally {
      spy.mockRestore();
    }
  });

  it('a source inside its belt is recorded as a contained link (F9 → plan-638: flag only)', () => {
    const { b, host } = palletOnBelt();
    resetWorld();
    pinUuids(b.scene);
    b.scene.updateMatrixWorld(true);
    const spy = vi.spyOn(console, 'info').mockImplementation(() => {});
    const runner = new DESRunner({ subMode: 'fastforward', durationSeconds: 1, masterSeed: 1 });
    try {
      bindSceneToRunner(runner, b.scene, host);
    } finally {
      spy.mockRestore();
    }
    const byName = new Map(runner.liveInstances.map((i) => [i.self.root.name, i.adapter as MaterialFlowAdapter]));
    const pallet = byName.get('EuropalletLoaded');
    const belt = byName.get('Conveyor_1');
    expect(pallet, 'pallet instance').toBeDefined();
    expect(belt, 'belt instance').toBeDefined();
    const target = containedTargetOf(pallet!);
    expect(target, 'contained target of the pallet source').not.toBeNull();
    expect(target).toBe(belt);
    // Gap links (Conveyor_1 → Conveyor_2) are NOT contained.
    expect(containedTargetOf(belt!)).toBeNull();
    runner.dispose();
  });

  it('with the planner plugin no headless registry is built (live registry used as is)', () => {
    const { b, host } = snapLine(true);
    const got = capture(b, host, false);
    expect(got.stats, 'wire stats').not.toBeNull();
    expect(got.stats!.headlessRegistry).toBe(false);
    expect(got.stats!.pluginPresent).toBe(true);
    const live = (host as unknown as { getPlugin(id: string): { getRegistry(): unknown } })
      .getPlugin('snap-point').getRegistry();
    expect(live, 'planner registry').toBeTruthy();
    expect(got.registryAfterBind).toBe(live);
    expect(got.registryAfterDispose).toBe(live);
  });
});
