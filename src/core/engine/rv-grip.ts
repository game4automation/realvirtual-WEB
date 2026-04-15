// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D, Vector3, Quaternion } from 'three';
import type { RVMovingUnit } from './rv-mu';
import type { RVSensor } from './rv-sensor';
import type { RVGripTarget } from './rv-grip-target';
import type { SignalStore } from './rv-signal-store';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent } from './rv-component-registry';
import { wireBoolSignal } from './rv-signal-wiring';
import { debug } from './rv-debug';

// Pre-allocated temps (no GC in hot path)
const _gripWorldPos = new Vector3();
const _tmpVec = new Vector3();
const _tmpQuat = new Quaternion();

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
  static readonly schema: ComponentSchema = {
    GripRange: { type: 'number', default: 50 },
    OneBitControl: { type: 'boolean', default: true },
    PlaceMode: { type: 'enum', enumMap: { 'Auto': 'Auto', 'Static': 'Static', 'Physics': 'Physics' }, default: 'Auto' },
    GripTargetSearchRadius: { type: 'number', default: 500 },
    SignalPick: { type: 'componentRef' },
    SignalPlace: { type: 'componentRef' },
    PartToGrip: { type: 'componentRef' },
  };

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

    // Save parent before gripping
    mu.parentBeforeGrip = mu.node.parent;

    // Three.js attach() preserves world transform while reparenting
    this.node.attach(mu.node);

    mu.isGripped = true;
    mu.currentSurface = null;
    this.grippedMUs.push(mu);

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
          target.node.getWorldQuaternion(_tmpQuat);
          mu.node.quaternion.copy(_tmpQuat);
        }
        // Reparent MU to GripTarget (matches C# Grip.AutoPlace behavior).
        // If the GripTarget is on a moving object, the MU follows it.
        target.node.attach(mu.node);
        target.setOccupied(mu);
        debug('grip', `Grip "${this.node.name}" placed MU "${mu.getName()}" on GripTarget "${target.node.name}"`);
        return;
      }
    }
    // Fallback: just release at current world position
    this.unfix(mu);
  }

  private unfix(mu: RVMovingUnit): void {
    mu.isGripped = false;

    // Reparent back to original parent (or scene root) preserving world transform
    const restoreParent = mu.parentBeforeGrip ?? this.node.parent;
    if (restoreParent) {
      restoreParent.attach(mu.node);
    }
    mu.parentBeforeGrip = null;

    // Remove from gripped list
    const idx = this.grippedMUs.indexOf(mu);
    if (idx >= 0) this.grippedMUs.splice(idx, 1);

    debug('grip', `Grip "${this.node.name}" released MU "${mu.getName()}"`);
  }

  // ── Detection ──

  private findNearestMU(): RVMovingUnit | null {
    // If PartToGrip sensor is set, use its occupiedMU
    if (this.partToGripSensor) {
      const sensorMU = this.partToGripSensor.occupiedMU;
      if (sensorMU && !sensorMU.isInstanced && !(sensorMU as RVMovingUnit).isGripped) {
        return sensorMU as RVMovingUnit;
      }
      return null;
    }

    // Sphere-AABB overlap (matches Unity Physics.OverlapSphere against BoxColliders).
    // GripRange is in mm, positions/AABBs are in meters.
    const mus = this.allMUs?.();
    if (!mus) return null;

    const rangeM = this.GripRange / 1000;
    this.node.getWorldPosition(_gripWorldPos);

    let nearest: RVMovingUnit | null = null;
    let minDist = Infinity;

    for (const mu of mus) {
      if (mu.isInstanced) continue;
      const cloneMU = mu as RVMovingUnit;
      if (cloneMU.markedForRemoval || cloneMU.isGripped) continue;

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

    const rangeM = this.GripTargetSearchRadius / 1000;
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
      mu.isGripped = false;
    }
  }

  /** Reset all grip state */
  reset(): void {
    for (const mu of this.grippedMUs) {
      mu.isGripped = false;
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
    simulationActive: true,
  },
  create: (node) => new RVGrip(node),
});
