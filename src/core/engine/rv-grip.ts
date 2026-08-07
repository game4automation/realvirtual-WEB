// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D, Vector3, Quaternion } from 'three';
import type { RVMovingUnit } from './rv-mu';
import type { RVSensor } from './rv-sensor';
import type { RVGripTarget } from './rv-grip-target';
import type { SignalStore } from './rv-signal-store';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { wireBoolSignal } from './rv-signal-wiring';
import { debug } from './rv-debug';
import { MM_TO_METERS } from './rv-constants';

// Pre-allocated temps (no GC in hot path)
const _gripWorldPos = new Vector3();
const _tmpVec = new Vector3();
const _tmpQuat = new Quaternion();
const _tmpParentQuat = new Quaternion();

/**
 * RVGrip — TypeScript port of Grip.cs
 *
 * Picks MUs by sensor detection or sphere range check, attaches them
 * to the grip node via Three.js attach() (preserves world transform).
 * Places MUs on nearest free GripTarget or at current world position.
 *
 * Control modes:
 * - Signal-based: SignalPick/SignalPlace with flank detection
 * - Sensor-based: PartToGrip sensor triggers pick when occupied
 */
export class RVGrip implements RVComponent {
  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('Grip');

  readonly node: Object3D;
  isOwner = true;

  // Properties — exact C# Inspector field names
  GripRange = 50;
  OneBitControl = true;
  PlaceMode: 'Auto' | 'Static' | 'Physics' = 'Auto';
  GripTargetSearchRadius = 500;
  SignalPick: string | null = null;
  SignalPlace: string | null = null;
  PartToGrip: RVSensor | null = null;

  // Signal addresses (resolved during GLB loading)
  signalPickAddr: string | null = null;
  signalPlaceAddr: string | null = null;

  // Sensor reference (resolved during GLB loading)
  partToGripSensor: RVSensor | null = null;

  // External references (set during GLB loading)
  signalStore: SignalStore | null = null;

  /** Collision registry (plan-394). Pick/place re-parent the MU across body
   *  boundaries; without an invalidate the F16 ancestor relation goes stale
   *  and the design-inherent Tool↔Workpiece contact of a gripped part raises
   *  a false alarm until the next unrelated rebuild. */
  private collisionRegistrar: { invalidate(): void } | null = null;

  /** All MUs tracked by the transport manager (set by transport manager) */
  allMUs: (() => (RVMovingUnit | { isInstanced: boolean })[]) | null = null;
  /** All grip targets (set by transport manager) */
  allGripTargets: (() => RVGripTarget[]) | null = null;

  // Pick/Place control (set by signal subscriptions or sensor callbacks)
  pickObjects = false;
  placeObjects = false;
  private _pickObjectsBefore = false;
  private _placeObjectsBefore = false;

  // Currently gripped MUs
  readonly grippedMUs: RVMovingUnit[] = [];

  constructor(node: Object3D) {
    this.node = node;
  }

  /**
   * Wire signal subscriptions, sensor reference, and external references.
   * Called after applySchema + resolveComponentRefs.
   *
   * After resolveComponentRefs:
   * - SignalPick: resolved signal address (string) or null
   * - SignalPlace: resolved signal address (string) or null
   * - PartToGrip: resolved RVSensor instance or null
   */
  init(context: ComponentContext): void {
    this.signalStore = context.signalStore;
    this.allMUs = () => context.transportManager.mus;
    this.allGripTargets = () => context.transportManager.gripTargets;
    this.collisionRegistrar = context.collisionManager ?? null;

    // Wire signal subscriptions
    this.signalPickAddr = wireBoolSignal(context.signalStore, this.SignalPick,
      (v) => { this.pickObjects = v; }, `Grip "${this.node.name}": SignalPick`).addr;
    this.signalPlaceAddr = wireBoolSignal(context.signalStore, this.SignalPlace,
      (v) => { this.placeObjects = v; }, `Grip "${this.node.name}": SignalPlace`).addr;

    // Wire PartToGrip sensor reference (already resolved by resolveComponentRefs)
    if (this.PartToGrip) {
      this.partToGripSensor = this.PartToGrip;
      debug('loader', `  Grip "${this.node.name}": PartToGrip sensor="${this.PartToGrip.node.name}"`);
    }

    // Register in transport manager
    context.transportManager.grips.push(this);

    debug('loader',
      `  Grip: ${this.node.name} range=${this.GripRange}mm oneBit=${this.OneBitControl}` +
      ` placeMode=${this.PlaceMode} targetRadius=${this.GripTargetSearchRadius}mm` +
      (this.signalPickAddr ? ` pick="${this.signalPickAddr}"` : '') +
      (this.signalPlaceAddr ? ` place="${this.signalPlaceAddr}"` : '') +
      (this.partToGripSensor ? ` sensor="${this.partToGripSensor.node.name}"` : '')
    );
  }

  // ── Pick ──

  pick(): void {
    const mu = this.findNearestMU();
    if (!mu) {
      debug('grip', `Grip "${this.node.name}" PICK FAILED: no MU within range ${this.GripRange}mm`);
      return;
    }
    this.fix(mu);
  }

  private fix(mu: RVMovingUnit): void {
    if (this.grippedMUs.includes(mu)) return;
    if (mu.isInstanced) return;
    // Defense in depth (plan-276 F15): findNearestMU already filters
    // physics-owned MUs; never attach one even if a caller bypasses it.
    if (mu.physicsOwned) return;

    // Free the GripTarget this MU was sitting on (if any). The C# Grip clears the
    // source Fixer/GripTarget when it picks a part; without this the target stays
    // occupied forever, which (a) blocks follow-up parts from ever being parented
    // onto it (so they no longer co-move with a moving target / machine axis), and
    // (b) leaves parentBeforeGrip pointing at the target node — so a later fallback
    // release would drop the part right back onto the (moving) target.
    const sourceTargets = this.allGripTargets?.();
    if (sourceTargets) {
      for (const t of sourceTargets) {
        if (t.occupiedBy === mu) t.clearOccupied();
      }
    }

    // Save parent before gripping
    mu.parentBeforeGrip = mu.node.parent;

    // Three.js attach() preserves world transform while reparenting
    this.node.attach(mu.node);

    mu.heldBy = 'grip';
    mu.currentSurface = null;
    mu.lastSurfaceTickId = undefined;
    this.grippedMUs.push(mu);
    // The MU now lives in the gripper's subtree — refresh the F16 relation.
    this.collisionRegistrar?.invalidate();

    debug('grip', `Grip "${this.node.name}" picked MU "${mu.getName()}"`);
  }

  // ── Place ──

  place(): void {
    const toPlace = [...this.grippedMUs];
    for (const mu of toPlace) {
      this.autoPlace(mu);
    }
  }

  private autoPlace(mu: RVMovingUnit): void {
    // physicsOwned gate (plan-276 F15): a gripped MU is structurally never
    // physics-owned; ignore the impossible combination defensively instead of
    // re-parenting a body the provider is actively posing.
    if (mu.physicsOwned) return;
    if (this.PlaceMode === 'Auto') {
      // Priority 0: Find nearest free GripTarget
      const target = this.findNearestGripTarget();
      if (target) {
        this.unfix(mu);
        if (target.AlignPosition) {
          target.node.getWorldPosition(_tmpVec);
          mu.node.position.copy(_tmpVec);
          mu.node.parent?.worldToLocal(mu.node.position);
        }
        if (target.AlignRotation) {
          // Want the MU's WORLD rotation to equal the GripTarget's after attach()
          // (which preserves world transform). So set the MU's LOCAL quaternion to
          // parentWorld⁻¹ ⊗ targetWorld. Copying the target's world quaternion
          // straight into the (local) quaternion double-rotated the part whenever
          // the MU's current parent was itself rotated.
          target.node.getWorldQuaternion(_tmpQuat);
          mu.node.quaternion.copy(_tmpQuat);
          if (mu.node.parent) {
            mu.node.parent.getWorldQuaternion(_tmpParentQuat);
            mu.node.quaternion.premultiply(_tmpParentQuat.invert());
          }
        }
        // Reparent MU to GripTarget (matches C# Grip.AutoPlace behavior).
        // If the GripTarget is on a moving object, the MU follows it.
        target.node.attach(mu.node);
        target.setOccupied(mu);
        debug('grip', `Grip "${this.node.name}" placed MU "${mu.getName()}" on GripTarget "${target.node.name}"`);
        return;
      }
    }
    // Fallback: nothing recognized → release at the current world position under a
    // stable StandardParent (matches C# AutoPlace → ReparentToStandardParent), so a
    // part picked out of a moving Fixer does not snap back into the machine; the
    // transport surface then claims it onto the belt.
    this.unfix(mu, true);
  }

  // Releases the MU. `toStandardParent` mirrors C# AutoPlace: a Place() that did
  // NOT land on a GripTarget reparents to the StandardParent (here the scene root)
  // at the current world position — NOT to parentBeforeGrip, which for a part
  // picked out of a Fixer on a moving machine axis would drop it straight back into
  // the (moving) machine. The transport surface then claims it onto the belt. A
  // plain release (no auto-place) restores the pre-grip parent.
  private unfix(mu: RVMovingUnit, toStandardParent = false): void {
    // Owner tag (plan-259 O1b): the grip only releases what IT holds — an MU
    // held by a connection (StopOnExit) is never freed from here.
    if (mu.heldBy === 'grip') mu.heldBy = null;

    // Reparent preserving world transform.
    const restoreParent = toStandardParent
      ? this.sceneRoot()
      : (mu.parentBeforeGrip ?? this.node.parent);
    if (restoreParent) {
      restoreParent.attach(mu.node);
    }
    mu.parentBeforeGrip = null;

    // Remove from gripped list
    const idx = this.grippedMUs.indexOf(mu);
    if (idx >= 0) this.grippedMUs.splice(idx, 1);

    // The MU left the gripper's subtree — refresh the F16 relation. autoPlace
    // may re-parent once more (onto the GripTarget) in the same synchronous
    // call; the dirty flag is read only at the next tick head, so one
    // invalidate covers the final hierarchy.
    this.collisionRegistrar?.invalidate();

    debug('grip', `Grip "${this.node.name}" released MU "${mu.getName()}"`);
  }

  /** Top-level scene root above this grip — a stable, non-moving container to
   *  release parts into at their current world position (the StandardParent-null
   *  equivalent of C# ReparentToStandardParent). */
  private sceneRoot(): Object3D {
    let n: Object3D = this.node;
    while (n.parent) n = n.parent;
    return n;
  }

  // ── Detection ──

  private findNearestMU(): RVMovingUnit | null {
    // If PartToGrip sensor is set, use its occupiedMU
    if (this.partToGripSensor) {
      const sensorMU = this.partToGripSensor.occupiedMU;
      // physicsOwned gate (plan-276 F15): never grab a falling/tumbling
      // physics-owned MU — same exclusion as gripped MUs.
      if (
        sensorMU && !sensorMU.isInstanced &&
        !(sensorMU as RVMovingUnit).isGripped && !sensorMU.physicsOwned
      ) {
        return sensorMU as RVMovingUnit;
      }
      return null;
    }

    // Sphere-AABB overlap (matches Unity Physics.OverlapSphere against BoxColliders).
    // GripRange is in mm, positions/AABBs are in meters.
    const mus = this.allMUs?.();
    if (!mus) return null;

    const rangeM = this.GripRange / MM_TO_METERS;
    this.node.getWorldPosition(_gripWorldPos);

    let nearest: RVMovingUnit | null = null;
    let minDist = Infinity;

    for (const mu of mus) {
      if (mu.isInstanced) continue;
      const cloneMU = mu as RVMovingUnit;
      // physicsOwned gate (plan-276 F15) — falling/tumbling MUs are the
      // physics provider's; picking one would fight the pose sync.
      if (cloneMU.markedForRemoval || cloneMU.isGripped || cloneMU.physicsOwned) continue;

      // Ensure AABB is fresh (grips run before MU AABB update in transport loop)
      cloneMU.updateAABB();
      // Compute shortest distance from grip sphere center to MU AABB surface
      const aabb = cloneMU.aabb;
      const dx = Math.max(0, Math.max(aabb.min.x - _gripWorldPos.x, _gripWorldPos.x - aabb.max.x));
      const dy = Math.max(0, Math.max(aabb.min.y - _gripWorldPos.y, _gripWorldPos.y - aabb.max.y));
      const dz = Math.max(0, Math.max(aabb.min.z - _gripWorldPos.z, _gripWorldPos.z - aabb.max.z));
      const dist = Math.sqrt(dx * dx + dy * dy + dz * dz);

      if (dist <= rangeM && dist < minDist) {
        minDist = dist;
        nearest = cloneMU;
      }
    }
    return nearest;
  }

  private findNearestGripTarget(): RVGripTarget | null {
    const targets = this.allGripTargets?.();
    if (!targets) return null;

    const rangeM = this.GripTargetSearchRadius / MM_TO_METERS;
    this.node.getWorldPosition(_gripWorldPos);

    let nearest: RVGripTarget | null = null;
    let minDist = rangeM;

    for (const target of targets) {
      if (!target.isFree) continue;
      target.node.getWorldPosition(_tmpVec);
      const dist = _gripWorldPos.distanceTo(_tmpVec);
      if (dist < minDist) {
        minDist = dist;
        nearest = target;
      }
    }
    return nearest;
  }

  // ── Update ──

  fixedUpdate(): void {
    // OneBitControl: PlaceObjects = !PickObjects
    if (this.OneBitControl) {
      this.placeObjects = !this.pickObjects;
    }

    // Rising-edge detection on pickObjects
    if (!this._pickObjectsBefore && this.pickObjects) {
      this.pick();
    }

    // Rising-edge detection on placeObjects
    if (!this._placeObjectsBefore && this.placeObjects) {
      this.place();
    }

    this._pickObjectsBefore = this.pickObjects;
    this._placeObjectsBefore = this.placeObjects;
  }

  // ── Cleanup ──

  /** Called when an MU is disposed (by sink or reset) */
  onMUDisposed(mu: RVMovingUnit): void {
    const idx = this.grippedMUs.indexOf(mu);
    if (idx >= 0) {
      this.grippedMUs.splice(idx, 1);
      if (mu.heldBy === 'grip') mu.heldBy = null;
    }
  }

  /** Reset all grip state */
  reset(): void {
    for (const mu of this.grippedMUs) {
      // Only release grip-held MUs (owner tag, plan-259 O1b) — a reset of the
      // grip subsystem must not free connection-held MUs.
      if (mu.heldBy === 'grip') mu.heldBy = null;
      mu.parentBeforeGrip = null;
    }
    this.grippedMUs.length = 0;
    this.pickObjects = false;
    this.placeObjects = false;
    this._pickObjectsBefore = false;
    this._placeObjectsBefore = false;
  }
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'Grip',
  schema: RVGrip.schema,
  capabilities: {
    authorable: true,   // addable in the asset editor (schema-complete)
  },
  create: (node) => new RVGrip(node),
});
