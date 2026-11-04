// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * RVMUPusher — position-based pushing of one MU by another (plan-2016 S6b).
 *
 * A grip (`Pusher`) carries an MU into a station; the MU already standing there
 * (the one `Sensor` reports) is pushed out in front of it. No contact detection
 * and no physics: the push is decided from the axis position, so it is
 * reproducible at any simulation speed.
 *
 * Cycle, evaluated once per transport tick after the drives and the grips:
 *  1. Arm — `Drive` starts a move to `ReleasePosition` while the grip holds an MU
 *     and `Sensor` reports a free MU lying in the path of the held MU (their boxes
 *     overlap across the push direction). The couple position is COMPUTED from
 *     the geometry at that moment: the world travel of the grip per drive mm
 *     (the drive itself plus every `Drive_Gear` slave of it on the grip's parent
 *     chain) and the gap between the front of the held MU and the back of the
 *     standing MU along the push direction. Logged once per pusher.
 *  2. Couple — when the drive passes the couple position, the standing MU is put
 *     exactly at the contact pose (the overshoot of the tick is added) and
 *     attached to the grip node, owner tag `pusher`.
 *  3. Release — at `ReleasePosition` (or when the drive is sent elsewhere) the MU
 *     is released at its world pose under the scene root; the transport surface
 *     below takes it over. `ReleaseSurface` (optional) is checked and a release
 *     beside it is warned about.
 *
 * An empty station (no sensor MU) never arms. Several pushers may share one
 * drive and grip (one per station): only the one whose MU lies in the path arms.
 */

import { Quaternion, Vector3 } from 'three';
import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec, getComponentInstances } from './rv-component-registry';
import { RVDrive } from './rv-drive';
import { RVDriveGear } from './rv-drive-gear';
import { RVGrip } from './rv-grip';
import { RVSensor } from './rv-sensor';
import { RVTransportSurface } from './rv-transport-surface';
import { muDetectOverlaps, type RVMovingUnit, type InstancedMovingUnit } from './rv-mu';
import type { AABB } from './rv-aabb';
import type { RVTransportManager, TransportTickHook } from './rv-transport-manager';
import { holdMU, detachMU, sceneRootOf } from './rv-mu-hold';
import { NodeRegistry } from './rv-node-registry';
import { debug } from './rv-debug';

/** Drive target counts as "to ReleasePosition" within this window (mm). */
const POSITION_EPS = 0.5;
/** An overlap deeper than this at arm time is reported (m). */
const OVERLAP_WARN_M = 0.002;
/** Vertical reach of a transport surface (m) — the same 0.1 m the surface pick uses. */
const SURFACE_REACH_M = 0.1;

const _a = new Vector3();
const _b = new Vector3();
const _k = new Vector3();
const _shift = new Vector3();
const _pos = new Vector3();
const _q = new Quaternion();

/** Support of a box along `u`: the largest `p·u` over the box (`sign=+1`) or the smallest (`-1`). */
function support(box: AABB, u: Vector3, sign: 1 | -1): number {
  const pick = (lo: number, hi: number, c: number): number => ((c * sign) >= 0 ? hi : lo) * c;
  return pick(box.min.x, box.max.x, u.x) + pick(box.min.y, box.max.y, u.y) + pick(box.min.z, box.max.z, u.z);
}

/** Result of one couple computation — exported for tests and the live state. */
export interface PushPlan {
  /** Drive position (mm) at which the standing MU is coupled. */
  couplePosition: number;
  /** Gap (mm, along the push) between the pushing and the standing MU at arm time. */
  gapMm: number;
  /** World travel of the pushing MU per drive mm (m/mm). */
  metresPerMm: number;
  /** +1 when the drive moves to a larger position, -1 otherwise. */
  sign: 1 | -1;
}

export class RVMUPusher implements RVComponent, TransportTickHook {
  static readonly schema: ComponentSchema = loadSchemaFromSpec('MUPusher');

  readonly node: Object3D;
  isOwner = true;

  // Properties — schema names (resolved component references after the loader).
  /** The axis whose position decides coupling and release. */
  Drive: RVDrive | null = null;
  /** The grip that carries the pushing MU. */
  Pusher: RVGrip | null = null;
  /** The sensor that reports the MU to be pushed. */
  Sensor: RVSensor | null = null;
  /** Drive position (mm) at which the pushed MU is released. */
  ReleasePosition = 0;
  /** Optional surface that should take the released MU over. */
  ReleaseSurface: RVTransportSurface | null = null;

  /** Last computed push (null before the first one). */
  lastPlan: PushPlan | null = null;
  /** Number of MUs released so far. */
  pushedCount = 0;

  private tm: RVTransportManager | null = null;
  private collision: { invalidate(): void } | null = null;
  private state: 'idle' | 'armed' | 'coupled' = 'idle';
  /** The current move to ReleasePosition was evaluated already (arm once per move). */
  private evaluated = false;
  private pushed: RVMovingUnit | null = null;
  private plan: PushPlan | null = null;
  private readonly pushDir = new Vector3();
  private logged = false;
  private warnedBeside = false;

  constructor(node: Object3D) {
    this.node = node;
  }

  init(context: ComponentContext): void {
    this.tm = context.transportManager;
    this.collision = context.collisionManager ?? null;
    // References may be stored for another component type on the same node.
    if (!(this.Drive instanceof RVDrive)) this.Drive = null;
    if (!(this.Pusher instanceof RVGrip)) this.Pusher = null;
    if (!(this.Sensor instanceof RVSensor)) this.Sensor = this.sensorOnNode();
    if (!(this.ReleaseSurface instanceof RVTransportSurface)) this.ReleaseSurface = null;
    const path = NodeRegistry.computeNodePath(this.node);
    if (!this.Drive || !this.Pusher || !this.Sensor) {
      console.warn(`[MUPusher] "${path}": Drive, Pusher and Sensor are required — pusher inactive`
        + ` (Drive=${!!this.Drive} Pusher=${!!this.Pusher} Sensor=${!!this.Sensor})`);
      return;
    }
    context.transportManager.tickHooks.add(this);
    debug('loader', `  MUPusher "${path}": drive="${this.Drive.name}" grip="${this.Pusher.node.name}"`
      + ` sensor="${this.Sensor.node.name}" release=${this.ReleasePosition}mm`
      + (this.ReleaseSurface ? ` surface="${this.ReleaseSurface.node.name}"` : ''));
  }

  getLiveState(): Record<string, unknown> {
    return {
      ReleasePosition: this.ReleasePosition,
      State: this.state,
      CouplePosition: this.lastPlan ? Math.round(this.lastPlan.couplePosition * 10) / 10 : null,
      PushedCount: this.pushedCount,
    };
  }

  /** The MU currently coupled to the grip (null when none). */
  get pushedMU(): RVMovingUnit | null {
    return this.state === 'coupled' ? this.pushed : null;
  }

  /**
   * World travel of `node` per mm of `drive` (m/mm, written to `out`): the drive
   * itself and every `Drive_Gear` slave of it on the node's parent chain. Linear
   * drives only — a rotary contribution yields the zero vector.
   */
  static travelPerMm(node: Object3D, drive: RVDrive, out: Vector3): Vector3 {
    out.set(0, 0, 0);
    for (let n: Object3D | null = node; n; n = n.parent) {
      for (const inst of getComponentInstances(n)) {
        if (!(inst instanceof RVDrive)) continue;
        let factor = 0;
        if (inst === drive) factor = 1;
        else {
          for (const b of inst.driveBehaviors) {
            if (b instanceof RVDriveGear && b.masterDrive === drive) factor += b.GearFactor;
          }
        }
        if (factor === 0) continue;
        if (inst.isRotary) return out.set(0, 0, 0);
        const parent = inst.node.parent;
        parent?.updateWorldMatrix(true, false);
        inst.computePoseTransform(inst.currentPosition, _a, _q);
        inst.computePoseTransform(inst.currentPosition + 1, _b, _q);
        if (parent) { _a.applyMatrix4(parent.matrixWorld); _b.applyMatrix4(parent.matrixWorld); }
        out.addScaledVector(_b.sub(_a), factor);
      }
    }
    return out;
  }

  /**
   * Couple computation for a pushing set `pushing` (the grip's MUs) and the
   * standing MU `standing`, the drive at `current` moving to `release`. Null when
   * the standing MU is not in the path or is not reached before `release`.
   * `dirOut` receives the world push direction. Exported for tests.
   */
  static computePlan(
    pushing: readonly RVMovingUnit[], standing: RVMovingUnit, travel: Vector3,
    current: number, release: number, dirOut: Vector3,
  ): PushPlan | null {
    const metresPerMm = travel.length();
    if (metresPerMm < 1e-9 || pushing.length === 0) return null;
    const sign: 1 | -1 = release >= current ? 1 : -1;
    dirOut.copy(travel).multiplyScalar(sign / metresPerMm);
    let front = -Infinity;
    for (const mu of pushing) front = Math.max(front, support(mu.aabb, dirOut, 1));
    const back = support(standing.aabb, dirOut, -1);
    // In the path: the boxes overlap on every axis that is not the push axis.
    const axes: ('x' | 'y' | 'z')[] = ['x', 'y', 'z'];
    for (const ax of axes) {
      if (Math.abs(dirOut[ax]) > 0.7) continue;
      let lo = Infinity, hi = -Infinity;
      for (const mu of pushing) { lo = Math.min(lo, mu.aabb.min[ax]); hi = Math.max(hi, mu.aabb.max[ax]); }
      if (standing.aabb.max[ax] <= lo || standing.aabb.min[ax] >= hi) return null;
    }
    const gap = back - front;
    const couplePosition = current + sign * Math.max(0, gap) / metresPerMm;
    if ((release - couplePosition) * sign < 0) return null; // not reached before the release
    return { couplePosition, gapMm: gap * 1000, metresPerMm, sign };
  }

  fixedUpdate(_dt: number): void {
    const drive = this.Drive;
    const grip = this.Pusher;
    if (!drive || !grip) return;
    const toRelease = drive.isRunning && Math.abs(drive.targetPosition - this.ReleasePosition) < POSITION_EPS;

    if (this.state === 'idle') {
      if (!toRelease) { this.evaluated = false; return; }
      if (this.evaluated) return;
      this.evaluated = true;
      this.tryArm(drive, grip);
      if (this.state === 'idle') return;
    }

    const mu = this.pushed;
    if (!mu || mu.markedForRemoval) { this.clear(); return; }
    const plan = this.plan!;
    const pos = drive.currentPosition;

    if (this.state === 'armed') {
      if (mu.heldBy !== null) { this.clear(); return; } // somebody else took it
      if ((pos - plan.couplePosition) * plan.sign >= 0) {
        this.couple(mu, grip, (pos - plan.couplePosition) * plan.sign * plan.metresPerMm);
      } else if (!toRelease) {
        this.clear(); // the move ended or was redirected before the contact
        return;
      }
    }
    if (this.state === 'coupled') {
      const atRelease = (pos - this.ReleasePosition) * plan.sign >= -POSITION_EPS;
      if (atRelease || !toRelease) this.release(mu, grip);
    }
  }

  /**
   * The MU standing in the station: the sensor's MU when it is free; else (the
   * sensor reports the carried MU itself, its box reaching into the station) the
   * first free MU inside a collision sensor's box. Null = empty station.
   */
  private standingMU(grip: RVGrip): RVMovingUnit | null {
    const sensor = this.Sensor;
    if (!sensor) return null;
    const free = (m: RVMovingUnit | InstancedMovingUnit | null): m is RVMovingUnit =>
      !!m && !m.isInstanced && !m.markedForRemoval && (m as RVMovingUnit).heldBy === null
      && !grip.grippedMUs.includes(m as RVMovingUnit);
    if (free(sensor.occupiedMU)) return sensor.occupiedMU;
    if (!sensor.occupied || sensor.UseRaycast || !this.tm) return null;
    for (const m of this.tm.mus) if (free(m) && muDetectOverlaps(m, sensor.aabb)) return m;
    return null;
  }

  private tryArm(drive: RVDrive, grip: RVGrip): void {
    if (grip.grippedMUs.length === 0) return;
    const mu = this.standingMU(grip);
    if (!mu) return; // empty station
    // Fresh boxes: the drives already moved this tick, the central box update follows later.
    for (const m of grip.grippedMUs) { m.node.updateWorldMatrix(true, true); m.updateAABB(); }
    mu.node.updateWorldMatrix(true, true);
    mu.updateAABB();
    RVMUPusher.travelPerMm(grip.node, drive, _k);
    const plan = RVMUPusher.computePlan(grip.grippedMUs, mu, _k, drive.currentPosition, this.ReleasePosition, this.pushDir);
    if (!plan) {
      debug('logic', `MUPusher "${this.node.name}": "${mu.getName()}" not in the push path`);
      return;
    }
    if (plan.gapMm < -OVERLAP_WARN_M * 1000) {
      console.warn(`[MUPusher] "${this.node.name}": pushing MU already overlaps "${mu.getName()}" by ${(-plan.gapMm).toFixed(1)} mm — coupled at once`);
    }
    this.plan = plan;
    this.lastPlan = plan;
    this.pushed = mu;
    this.state = 'armed';
    const msg = `MUPusher "${this.node.name}": couple at ${drive.name} = ${plan.couplePosition.toFixed(1)} mm`
      + ` (from ${drive.currentPosition.toFixed(1)} mm, gap ${plan.gapMm.toFixed(1)} mm,`
      + ` ${(plan.metresPerMm * 1000).toFixed(3)} mm travel per mm, release ${this.ReleasePosition} mm)`;
    if (!this.logged) { this.logged = true; console.info(`[${msg}]`); } else debug('logic', msg);
  }

  /** Attach `mu` at the exact contact pose: it was pushed by the overshoot `aheadM` (m) of this tick. */
  private couple(mu: RVMovingUnit, grip: RVGrip, aheadM: number): void {
    if (aheadM > 0) {
      const node = mu.node;
      node.getWorldPosition(_pos);
      _pos.add(_shift.copy(this.pushDir).multiplyScalar(aheadM));
      node.parent?.updateWorldMatrix(true, false);
      if (node.parent) node.parent.worldToLocal(_pos);
      node.position.copy(_pos);
      node.updateMatrix();
      node.updateWorldMatrix(false, true);
    }
    holdMU(mu, grip.node, 'pusher', { loadHost: this.tm, collision: this.collision });
    this.state = 'coupled';
    debug('logic', `MUPusher "${this.node.name}": coupled "${mu.getName()}" (overshoot ${(aheadM * 1000).toFixed(1)} mm)`);
  }

  private release(mu: RVMovingUnit, grip: RVGrip): void {
    detachMU(mu, 'pusher', sceneRootOf(grip.node), this.collision);
    mu.node.updateWorldMatrix(true, true);
    if (this.tm) this.tm.reindexMU(mu); else mu.updateAABB();
    this.pushedCount++;
    const surface = this.ReleaseSurface;
    if (surface) {
      surface.updateAABB();
      const s = surface.aabb;
      const b = mu.aabb;
      const centreInside = b.center.x >= s.min.x && b.center.x <= s.max.x && b.center.z >= s.min.z && b.center.z <= s.max.z;
      const reach = b.min.y - s.max.y;
      if ((!centreInside || reach > SURFACE_REACH_M || reach < -SURFACE_REACH_M) && !this.warnedBeside) {
        this.warnedBeside = true;
        console.warn(`[MUPusher] "${this.node.name}": "${mu.getName()}" released beside ReleaseSurface "${surface.node.name}"`
          + ` (centre ${b.center.x.toFixed(3)}/${b.center.z.toFixed(3)}, height above surface ${(reach * 1000).toFixed(0)} mm)`);
      }
    }
    debug('logic', `MUPusher "${this.node.name}": released "${mu.getName()}"`);
    this.pushed = null;
    this.plan = null;
    this.state = 'idle';
  }

  private clear(): void {
    if (this.state === 'coupled' && this.pushed && this.pushed.heldBy === 'pusher' && this.Pusher) {
      this.release(this.pushed, this.Pusher);
      return;
    }
    this.pushed = null;
    this.plan = null;
    this.state = 'idle';
  }

  private sensorOnNode(): RVSensor | null {
    for (const inst of getComponentInstances(this.node)) if (inst instanceof RVSensor) return inst;
    return null;
  }

  //! IMPLEMENTS TransportTickHook::onMUDisposed
  onMUDisposed(mu: RVMovingUnit): void {
    if (this.pushed === mu) { this.pushed = null; this.plan = null; this.state = 'idle'; }
  }

  /**
   * Let go of a coupled MU without the release bookkeeping (plan-2016 Codex
   * review): detach it from the grip at its current world pose onto its neutral
   * parent (the scene, or a pre-placed MU's spawn parent) so it does not keep
   * riding along under the grip. `reindex` refreshes the MU grid entry — only
   * outside a transport reset, whose grid is cleared and rebuilt anyway.
   */
  private letGo(reindex: boolean): void {
    const mu = this.pushed;
    if (!mu || mu.heldBy !== 'pusher') return;
    const target = this.tm?.neutralParentOf(mu) ?? sceneRootOf(this.Pusher?.node ?? mu.node);
    detachMU(mu, 'pusher', target === mu.node ? null : target, this.collision);
    mu.node.updateWorldMatrix(true, true);
    if (reindex && this.tm) this.tm.reindexMU(mu); else mu.updateAABB();
  }

  //! IMPLEMENTS TransportTickHook::reset
  reset(): void {
    this.letGo(false);
    this.pushed = null;
    this.plan = null;
    this.state = 'idle';
    this.evaluated = false;
    this.pushedCount = 0;
  }

  dispose(): void {
    this.tm?.tickHooks.delete(this);
    this.letGo(true);
    this.reset();
    this.tm = null;
    this.collision = null;
  }
}

registerComponent({
  type: 'MUPusher',
  schema: RVMUPusher.schema,
  capabilities: {
    authorable: true,   // addable in the asset editor (schema-complete)
    pick: 'none',
    ui: { badge: '#66bb6a', category: 'transport' },
  },
  create: (node) => new RVMUPusher(node),
});
