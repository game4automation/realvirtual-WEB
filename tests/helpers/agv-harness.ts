// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared headless AGV harness (plan-558): signal host, Agv roots (optionally
 * with a body mesh and an off-centre root), continuous + DES binding of the
 * real material-flow definition, shared-state reset, an oriented-footprint
 * SAT overlap oracle with INDIVIDUAL body transforms (each vehicle's own
 * front / rear / width relative to its root — R2-6), and a DES run loop that
 * samples the oracle every render frame.
 *
 * The helper itself never imports the PRIVATE runner (the community edition
 * typechecks it): DES suites import `DESRunner` from `@rv-private/...`
 * themselves, which also lists them in tests/private-dependent-tests.json.
 */

import { BoxGeometry, Mesh, MeshBasicMaterial, Object3D, Vector3 } from 'three';
import { EventEmitter } from '../../src/core/rv-events';
import { ContextMenuStore } from '../../src/core/hmi/context-menu-store';
import {
  createBindContext, applyKinematicsSpec,
  type BindContextHost, type BindContextHandle, type KinematicsSpec, type RVBindContext,
} from '../../src/core/behavior-runtime';
import { createSelf, type MaterialFlowSelf } from '../../src/core/material-flow/material-flow-self';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import { getDefaultPathNetwork } from '../../src/core/engine/rv-path-network';
import { getDefaultSpacingController } from '../../src/core/engine/rv-spacing-controller';
import { getDefaultZoneRegistry } from '../../src/core/engine/rv-zone-registry';
import { getDefaultAgvFleet } from '../../src/core/engine/rv-agv-fleet';
import { getDefaultPathDockRegistry } from '../../src/core/engine/rv-path-dock';
import { clearLiveControl } from '../../src/core/engine/rv-live-control';
import { getDefaultMovementAuthority } from '../../src/core/engine/rv-movement-authority';
import AgvBehavior, { AgvFlow } from '../../src/behaviors/Agv';

/** The real Agv material-flow definition (DES binding). */
export const AGV_DEF = AgvFlow as unknown as MaterialFlowDefinition;

/** Fixed render / sim tick (s). */
export const TICK = 1 / 60;

export interface AgvTestHost extends BindContextHost { values: Map<string, boolean | number> }

/** In-memory signal store + event host for headless binding. */
export function makeHost(): AgvTestHost {
  const subs = new Map<string, Set<(v: boolean | number) => void>>();
  const values = new Map<string, boolean | number>();
  const events = new EventEmitter<Record<string, unknown>>();
  return {
    values,
    signalStore: {
      get: (n: string) => values.get(n),
      set: (n: string, v: boolean | number) => { values.set(n, v); subs.get(n)?.forEach((cb) => cb(v)); },
      subscribe: (n: string, cb: (v: boolean | number) => void) => {
        let s = subs.get(n); if (!s) { s = new Set(); subs.set(n, s); }
        s.add(cb); return () => { s!.delete(cb); };
      },
    },
    on: (e, cb) => events.on(e, cb as never),
    contextMenu: new ContextMenuStore(),
    drives: [],
    registry: null,
  };
}

/** Body of a test vehicle (m): length along travel, width, and the root's offset behind the body centre. */
export interface TestBody { length: number; width: number; rootOffset?: number }

/**
 * An Agv root configured via rv_extras (LayoutObject → instance-scoped
 * signals). With `body` a box mesh is added so `VehicleLength/Width = 0`
 * derive the body from the mesh; `rootOffset` > 0 moves the root BEHIND the
 * body centre (e.g. length/2 = root at the rear).
 */
export function makeAgvRoot(name: string, cfg: Record<string, unknown>, body?: TestBody): Object3D {
  const root = new Object3D();
  root.name = name;
  root.userData.realvirtual = { LayoutObject: { Name: name }, Agv: cfg };
  if (body) {
    const mesh = new Mesh(new BoxGeometry(body.width, 0.3, body.length), new MeshBasicMaterial());
    mesh.position.set(0, 0.15, body.rootOffset ?? 0);
    root.add(mesh);
  }
  return root;
}

/** Signal value of `<agv>.Agv.<key>`. */
export function sig(host: AgvTestHost, agv: string, key: string): boolean | number | undefined {
  return host.values.get(`${agv}.Agv.${key}`);
}

/** Bind context for a root (kinematics applied). */
export function makeCtx(root: Object3D, host: AgvTestHost): { ctx: RVBindContext; handle: BindContextHandle } {
  const accum: KinematicsSpec = {};
  const { ctx, handle } = createBindContext(root, host, accum);
  applyKinematicsSpec(root, accum);
  return { ctx, handle };
}

/** Continuous binding of the real library component. */
export function bindContinuous(root: Object3D, host: AgvTestHost): BindContextHandle {
  const accum: KinematicsSpec = {};
  const { ctx, handle } = createBindContext(root, host, accum);
  AgvBehavior.bind(ctx);
  applyKinematicsSpec(root, accum);
  return handle;
}

/** The part of the private DESRunner the binding needs (structural — no private import here). */
export interface DesRunnerLike {
  makeScheduler(def: MaterialFlowDefinition, getEntityId: () => number): unknown;
  addInstance(def: MaterialFlowDefinition, self: MaterialFlowSelf, root: Object3D): unknown;
}

/**
 * DES instance of `def` (default: the Agv). The entityId is read LIVE off the
 * adapter — assigned inside `runner.start()` before the start kick.
 */
export function bindDes(
  runner: DesRunnerLike, root: Object3D, host: AgvTestHost, def: MaterialFlowDefinition = AGV_DEF,
): MaterialFlowSelf {
  const { ctx } = makeCtx(root, host);
  let adapter: { entityId: number; setState(n: string): void; recordOutput(n: number): void } | null = null;
  const self = createSelf(ctx, def, {
    mode: 'des',
    scheduler: runner.makeScheduler(def, () => adapter?.entityId ?? -1) as NonNullable<Parameters<typeof createSelf>[2]>['scheduler'],
    local: (def.state ?? def.local)?.(),
    // Statistics forwarding exactly as the scene binding wires it.
    onStatState: (name) => adapter?.setState(name),
    onStatOutput: (n) => adapter?.recordOutput(n),
  });
  adapter = runner.addInstance(def, self, root) as unknown as typeof adapter;
  return self;
}

/** Reset every shared engine singleton the AGV stack uses (test isolation). */
export function clearShared(): void {
  getDefaultPathNetwork().clear();
  getDefaultSpacingController().clear();
  getDefaultZoneRegistry().clear();
  getDefaultAgvFleet().clear();
  getDefaultPathDockRegistry().clear();
  getDefaultMovementAuthority('des').clear();
  getDefaultMovementAuthority('continuous').clear();
  clearLiveControl();
}

// ── Oriented footprint SAT (XZ plane) ─────────────────────────────────────

/** Oriented rectangle: centre, half-axis vectors along travel (f) and across (r). */
export interface Footprint { cx: number; cz: number; fx: number; fz: number; rx: number; rz: number; radius: number }

/** Body extents relative to the root (m). */
export interface BodyExtents { front: number; rear: number; width: number }

const _fwd = new Vector3();
const _right = new Vector3();

/** Footprint of a root with its OWN body extents (the root may be off-centre). */
export function footprint(root: Object3D, body: BodyExtents): Footprint {
  _fwd.set(0, 0, 1).applyQuaternion(root.quaternion);
  _right.set(1, 0, 0).applyQuaternion(root.quaternion);
  const fl = Math.hypot(_fwd.x, _fwd.z) || 1;
  const rl = Math.hypot(_right.x, _right.z) || 1;
  const fx = _fwd.x / fl, fz = _fwd.z / fl;
  const half = (body.front + body.rear) / 2;
  const centreOff = (body.front - body.rear) / 2;
  return {
    cx: root.position.x + fx * centreOff, cz: root.position.z + fz * centreOff,
    fx: fx * half, fz: fz * half,
    rx: (_right.x / rl) * body.width / 2, rz: (_right.z / rl) * body.width / 2,
    radius: Math.hypot(half, body.width / 2),
  };
}

/** Penetration depth (m) of two oriented rectangles; <= 0 means separated. */
export function satOverlap(a: Footprint, b: Footprint): number {
  const dx = b.cx - a.cx, dz = b.cz - a.cz;
  // Bounding-circle prefilter (exact per pair — no fixed exclusion radius).
  if (Math.hypot(dx, dz) > a.radius + b.radius) return -1;
  const axes = [[a.fx, a.fz], [a.rx, a.rz], [b.fx, b.fz], [b.rx, b.rz]];
  let minPen = Infinity;
  for (const [axx, axz] of axes) {
    const l = Math.hypot(axx, axz);
    if (l < 1e-12) continue;
    const ux = axx / l, uz = axz / l;
    const ra = Math.abs(a.fx * ux + a.fz * uz) + Math.abs(a.rx * ux + a.rz * uz);
    const rb = Math.abs(b.fx * ux + b.fz * uz) + Math.abs(b.rx * ux + b.rz * uz);
    const d = Math.abs(dx * ux + dz * uz);
    const pen = ra + rb - d;
    if (pen <= 0) return pen;
    if (pen < minPen) minPen = pen;
  }
  return minPen;
}

// ── DES run loop ─────────────────────────────────────────────────────────

export interface RunMetrics {
  simSec: number;
  wallMs: number;
  events: number;
  overlapFrames: number;
  overlapPairs: Set<string>;
  maxPenetration: number;
  minCentreDist: number;
  maxStoppedSec: number;
  maxStoppedAgv: string;
  finalPoses: string;
}

/** Vehicles under observation: roots, names and their body extents. */
export interface Measured { roots: Object3D[]; names: string[]; bodies: BodyExtents[] }

/** The part of the private DESRunner the run loop needs (structural). */
export interface DesTicker {
  tick(dt: number): void;
  lateTick(dt: number): void;
  getManager(): { totalEventsProcessed: number };
}

/** Tick an animated / hybrid runner for `simSec`, sampling SAT overlap + standstill every frame. */
export function runAnimated(
  runner: DesTicker, m: Measured, simSec: number, perFrame?: (frame: number) => void,
): RunMetrics {
  const n = m.roots.length;
  const lastPos = m.roots.map((r) => r.position.clone());
  const stoppedSince = new Array<number>(n).fill(0);
  let maxStopped = 0, maxStoppedAgv = '';
  let overlapFrames = 0, maxPen = 0, minCentre = Infinity;
  const overlapPairs = new Set<string>();
  const frames = Math.round(simSec / TICK);
  const w0 = performance.now();
  for (let f = 1; f <= frames; f++) {
    runner.tick(TICK);
    runner.lateTick(TICK);
    perFrame?.(f);
    const boxes = m.roots.map((r, i) => footprint(r, m.bodies[i]));
    let overlapThisFrame = false;
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        const d = Math.hypot(m.roots[i].position.x - m.roots[j].position.x, m.roots[i].position.z - m.roots[j].position.z);
        if (d < minCentre) minCentre = d;
        const pen = satOverlap(boxes[i], boxes[j]);
        if (pen > 1e-6) {
          overlapThisFrame = true;
          overlapPairs.add(`${m.names[i]}|${m.names[j]}`);
          if (pen > maxPen) maxPen = pen;
        }
      }
    }
    if (overlapThisFrame) overlapFrames++;
    const t = f * TICK;
    for (let i = 0; i < n; i++) {
      const moved = m.roots[i].position.distanceToSquared(lastPos[i]) > 1e-12;
      if (moved) { stoppedSince[i] = t; lastPos[i].copy(m.roots[i].position); }
      const st = t - stoppedSince[i];
      if (st > maxStopped) { maxStopped = st; maxStoppedAgv = m.names[i]; }
    }
  }
  const sorted = m.roots.map((r) => r).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return {
    simSec, wallMs: performance.now() - w0,
    events: runner.getManager().totalEventsProcessed,
    overlapFrames, overlapPairs, maxPenetration: maxPen, minCentreDist: minCentre,
    maxStoppedSec: maxStopped, maxStoppedAgv,
    finalPoses: sorted.map((r) => `${r.name}:${r.position.x.toFixed(6)},${r.position.z.toFixed(6)}`).join(' '),
  };
}

/** A centred body of `length` × `width` (m). */
export function centredBody(length: number, width: number): BodyExtents {
  return { front: length / 2, rear: length / 2, width };
}

export { Object3D };
