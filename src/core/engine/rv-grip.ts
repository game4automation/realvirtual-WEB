// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { Object3D, Quaternion, Vector3 } from 'three';
import type { RVMovingUnit, InstancedMovingUnit } from './rv-mu';
import type { RVSensor } from './rv-sensor';
import type { RVGripTarget } from './rv-grip-target';
import type { WaitEdge } from '../diagnostics/rv-wait-registry';
import type { SignalStore } from './rv-signal-store';
import type { ComponentSchema, ComponentContext, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { wireBoolSignal } from './rv-signal-wiring';
import { debug } from './rv-debug';
import { MM_TO_METERS } from './rv-constants';
import { PHYSICS_FIXED_DT } from './rv-physics-constants';
import {
  decideCarrierPlacement, findCarrierByCollider, forEachInLoadTree, loadMu, type MULoadHost,
} from './rv-mu-load';
import {
  alignToGripTarget, detachMU, findNearestGripTarget, holdMU, placeOnGripTarget, sceneRootOf,
} from './rv-mu-hold';
import { isPhysicsOwned } from './rv-mu-owner';
import { refreshWorldMatrix } from './rv-world-matrix';
import { storedReferenceValue } from './rv-node-path-rewrite.mjs';
import {
  clearProblem, clearSeatOccupiedProblems, reportSeatOccupied, seatOccupiedProblemId,
} from '../hmi/problems-store';

// Pre-allocated temps (no GC in hot path)
const _gripWorldPos = new Vector3();
// Pose of a part in the grip before a LoadOnCarrier place check (plan-577).
const _heldPos = new Vector3();
const _heldQuat = new Quaternion();
// PickAlignWithObject world pose (plan-2016 S4).
const _alignPos = new Vector3();
const _alignQuat = new Quaternion();
const _alignParentQuat = new Quaternion();

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
 * - DirectlyGrip: every MU entering PartToGrip is gripped at once, taken over
 *   from another grip or a Source.Destination if needed (Unity `Grip.Fix`)
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
  /** If true an MU is gripped the moment it enters `PartToGrip` (no pick signal). */
  DirectlyGrip = false;
  /** Scene path of the node a picked MU is aligned to (Unity GameObject field). Display
   *  only: `init()` reads the RAW stored value, which may be an address after a web save. */
  PickAlignWithObject = '';
  /** If true a pick with `PickAlignWithObject` also takes over its world rotation. */
  AlignRotation = true;
  /** Resolved `PickAlignWithObject` node (null = keep the MU's world pose on pick). */
  pickAlignNode: Object3D | null = null;

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
  /** All grips of the scene: the takeover of an MU another grip holds (plan-2016 S4). */
  allGrips: (() => readonly RVGrip[]) | null = null;
  /** All grip targets (set by transport manager) */
  allGripTargets: (() => RVGripTarget[]) | null = null;
  /** Where loads leave / join the ticked MU set (plan-516) — the transport
   *  manager; null in standalone setups (the load links still update). */
  loadHost: MULoadHost | null = null;
  /** Physics handover seam (plan-525 §2.7) — the transport manager; null in
   *  standalone setups (PlaceMode Physics then behaves like Static + warning). */
  physicsHost: GripPhysicsHost | null = null;
  /** MU set seam (plan-2016 S4) — the transport manager: promotes an instanced MU a
   *  DirectlyGrip grip takes to a clone and re-indexes an MU the align moved.
   *  Null in standalone setups (instanced MUs are then not gripped). */
  muHost: GripMuHost | null = null;

  // Pick/Place control (set by signal subscriptions or sensor callbacks)
  pickObjects = false;
  placeObjects = false;
  private _pickObjectsBefore = false;
  private _placeObjectsBefore = false;

  // Currently gripped MUs
  readonly grippedMUs: RVMovingUnit[] = [];
  private waitingForPart = false;
  // Updated only on pick/place events, not during velocity sampling or signal polling.
  private readonly refusedTargets = new WeakMap<RVMovingUnit, RVGripTarget>();
  private readonly refusedOwners = new WeakMap<RVMovingUnit, RVMovingUnit | InstancedMovingUnit>();

  /** Only reads the last actual pick/place refusal; never searches or moves parts. */
  waitEdges(): WaitEdge[] {
    const out: WaitEdge[] = [];
    if (this.waitingForPart && this.grippedMUs.length === 0) {
      out.push({ waiterId: `grip:${this.node.uuid}`,
        resourceId: this.partToGripSensor ? `sensor:${this.partToGripSensor.node.uuid}` : `part-slot:${this.node.uuid}`,
        ownerIds: [], kind: 'grip', sinceSimSec: NaN, analysed: true });
    }
    for (const part of this.grippedMUs) {
      const target = this.refusedTargets.get(part), owner = this.refusedOwners.get(part);
      if (!target || !owner || owner.markedForRemoval) continue;
      out.push({ waiterId: `mu:${part.id}`, resourceId: `grip-target:${target.node.uuid}`,
        ownerIds: [`mu:${(target.occupiedBy ?? owner).id}`], kind: 'grip', sinceSimSec: NaN, analysed: true });
    }
    return out;
  }

  /** SignalPick/SignalPlace store subscriptions + re-apply slots (plan-427 F6). */
  private readonly signalUnsubs: (() => void)[] = [];
  /** DirectlyGrip: the PartToGrip MU-enter listener (removed in dispose). */
  private _directListener: ((mu: RVMovingUnit | InstancedMovingUnit) => void) | null = null;
  /** One warning per grip when an instanced MU could not be promoted to a clone. */
  private _instancedWarned = false;

  // Grip velocity for the PlaceMode 'Physics' handover (plan-525 §2.7): world
  // position difference of the grip node over the last two ticks, in m/s.
  // Pre-allocated — sampled every tick, no allocation.
  private readonly _velPrev = new Vector3();
  private readonly _velCur = new Vector3();
  /** World velocity of the grip node over the last tick (m/s). */
  readonly velocity = new Vector3();
  private _velSamples = 0;
  /** One warning per grip when a Physics place could not hand over. */
  private _physicsFallbackWarned = false;
  /** Ids of the "seat occupied" warnings THIS grip raised (plan-577 F8) — a
   *  successful place clears only these, never another grip's. */
  private readonly _seatProblemIds = new Set<string>();

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
    this.allGrips = () => context.transportManager.grips;
    this.loadHost = context.transportManager;
    this.physicsHost = context.transportManager;
    this.muHost = context.transportManager;
    this.collisionRegistrar = context.collisionManager ?? null;

    // Wire signal subscriptions. Both are LEVEL setters — the pick/place flank
    // detection lives in `update()` (`_pickObjectsBefore`), so a replayed held
    // `true` only re-confirms the state and never re-grips (plan-427).
    const pick = wireBoolSignal(context.signalStore, this.SignalPick,
      (v) => { this.pickObjects = v; }, `Grip "${this.node.name}": SignalPick`,
      context.reapply);
    const place = wireBoolSignal(context.signalStore, this.SignalPlace,
      (v) => { this.placeObjects = v; }, `Grip "${this.node.name}": SignalPlace`,
      context.reapply);
    this.signalPickAddr = pick.addr;
    this.signalPlaceAddr = place.addr;
    // Keep the handles: a Grip removed on its own (subtree removal calls only an
    // EXISTING optional dispose(), rv-scene-loader) previously left both store
    // subscriptions — and now a registry slot — alive on a dead instance (F6).
    this.signalUnsubs.push(pick.unsubscribe, place.unsubscribe);

    // Wire PartToGrip sensor reference (already resolved by resolveComponentRefs)
    if (this.PartToGrip) {
      this.partToGripSensor = this.PartToGrip;
      debug('loader', `  Grip "${this.node.name}": PartToGrip sensor="${this.PartToGrip.node.name}"`);
    }

    // DirectlyGrip (Unity Grip.cs: PartToGrip.EventEnter += Fix): grip on entry.
    if (this.DirectlyGrip && this.partToGripSensor) {
      this._directListener = (mu) => this.onPartEnter(mu);
      this.partToGripSensor.addMuEnterListener(this._directListener);
    }

    this.pickAlignNode = this.resolvePickAlign(context);

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

  /**
   * Resolve `PickAlignWithObject` (plan-2016 S4) through the registry's ONE stored-reference
   * read: a Unity path or a web address. `PATH_FIELDS` declares the field (migration, save
   * as address, bake survival, reference audit). A miss picks without alignment, warned.
   */
  private resolvePickAlign(context: ComponentContext): Object3D | null {
    const raw = (this.node.userData?.realvirtual as Record<string, unknown> | undefined)?.['Grip'] as
      Record<string, unknown> | undefined;
    const stored = storedReferenceValue(raw?.['PickAlignWithObject']);
    if (stored === null) return null;
    const registry = context.registry;
    const node = registry.storedNode(this.node, stored, {
      legacy: (path) => registry.resolveWithStage({ path }, null, this.node)?.node ?? null,
    });
    if (!node) {
      console.warn(`  Grip: ${this.node.name} - PickAlignWithObject "${typeof stored === 'string' ? stored : JSON.stringify(stored)}" not found, MUs are picked without alignment`);
    }
    return node;
  }

  /** DirectlyGrip: an MU entered `PartToGrip` (Unity `PickBasedOnSensorOnEventEnter`). */
  private onPartEnter(mu: RVMovingUnit | InstancedMovingUnit): void {
    if (mu.markedForRemoval) return;
    // Unity `MU.Fix` makes a falling Rigidbody kinematic (plan-2016 S7): a part
    // spawned inside a physics zone is a Rapier body in its spawn tick — the
    // grip takes it back before it moved. Only this DirectlyGrip path; a
    // signal pick still never grabs a tumbling part (plan-276 F15).
    if (isPhysicsOwned(mu) && !(this.physicsHost?.reclaimFromPhysics?.(mu) ?? false)) return;
    if (mu.isInstanced) {
      // A grip holds a node: the instance becomes a real clone right here, only
      // this one — every other MU of the scene stays instanced.
      const clone = this.muHost?.promoteInstancedMU(mu as InstancedMovingUnit) ?? null;
      if (!clone) {
        if (!this._instancedWarned) {
          this._instancedWarned = true;
          console.warn(`[Grip] "${this.node.name}": DirectlyGrip cannot grip the instanced MU "${mu.getName()}"`);
        }
        return;
      }
      mu = clone;
    }
    this.fix(mu as RVMovingUnit);
  }

  // ── Pick ──

  pick(): void {
    const mu = this.findNearestMU();
    this.waitingForPart = mu === null;
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
    if (isPhysicsOwned(mu)) return;

    // Takeover (Unity MU.Fix -> FixedBy.Unfix): an MU another GRIP holds leaves that
    // grip's list; its pre-grip parent survives the handover. Any other holder
    // (connection, zone, user) keeps its MU: nobody frees another subsystem's MU.
    let keepParent: Object3D | null = null;
    if (mu.heldBy !== null) {
      if (mu.heldBy !== 'grip') return;
      const grips = this.allGrips?.() ?? [];
      let owner: RVGrip | null = null;
      for (const g of grips) if (g !== this && g.grippedMUs.includes(mu)) { owner = g; break; }
      if (!owner) return;
      keepParent = mu.parentBeforeGrip;
      owner.releaseForTakeover(mu);
    }
    // A Source.Destination ride ends with the first grip (plan-2016 S1/S4).
    mu.destinationParent = null;

    // Attach + owner tag + transport/load/target state: the shared hold
    // kernel (plan-521) — the grip keeps only its own list.
    holdMU(mu, this.node, 'grip', {
      gripTargets: this.allGripTargets?.(),
      loadHost: this.loadHost,
      collision: this.collisionRegistrar,
    });
    if (keepParent) mu.parentBeforeGrip = keepParent;
    this.grippedMUs.push(mu);
    this.refusedTargets.delete(mu);
    this.refusedOwners.delete(mu);
    this.waitingForPart = false;
    if (this.pickAlignNode) this.alignOnPick(mu, this.pickAlignNode);

    debug('grip', `Grip "${this.node.name}" picked MU "${mu.getName()}"`);
  }

  /** Unity `Fix`: world position (and rotation with `AlignRotation`) := align object's. */
  private alignOnPick(mu: RVMovingUnit, align: Object3D): void {
    const node = mu.node;
    // The align node may sit below a mover with a frozen local matrix (rv-world-matrix.ts).
    refreshWorldMatrix(align);
    if (node.parent) refreshWorldMatrix(node.parent);
    align.getWorldPosition(_alignPos);
    node.position.copy(_alignPos);
    node.parent?.worldToLocal(node.position);
    if (this.AlignRotation) {
      align.getWorldQuaternion(_alignQuat);
      node.quaternion.copy(_alignQuat);
      if (node.parent) {
        node.parent.getWorldQuaternion(_alignParentQuat);
        node.quaternion.premultiply(_alignParentQuat.invert());
      }
    }
    // Also for a node the loader froze (matrixAutoUpdate false).
    node.updateMatrix();
    node.updateWorldMatrix(false, true);
    // AABB + grid cell now, so every later sensor of this tick sees the aligned
    // pose — on the brute-force and the grid path alike.
    if (this.muHost) this.muHost.reindexMU(mu);
    else mu.updateAABB();
  }

  /** Another grip takes `mu` over (plan-2016 S4): drop it from this grip's list and
   *  its owner tag. No re-parent: the new grip attaches it at once. */
  releaseForTakeover(mu: RVMovingUnit): void {
    const idx = this.grippedMUs.indexOf(mu);
    if (idx < 0) return;
    this.grippedMUs.splice(idx, 1);
    if (mu.heldBy === 'grip') mu.heldBy = null;
    debug('grip', `Grip "${this.node.name}" handed MU "${mu.getName()}" over`);
  }

  // ── Place ──

  place(): void {
    this.waitingForPart = false;
    const toPlace = [...this.grippedMUs];
    for (const mu of toPlace) {
      this.autoPlace(mu);
    }
  }

  private autoPlace(mu: RVMovingUnit): void {
    this.waitingForPart = false;
    this.refusedTargets.delete(mu);
    this.refusedOwners.delete(mu);
    // physicsOwned gate (plan-276 F15): a gripped MU is structurally never
    // physics-owned; ignore the impossible combination defensively instead of
    // re-parenting a body the provider is actively posing.
    if (isPhysicsOwned(mu)) return;
    const target = this.PlaceMode === 'Auto' ? this.findNearestGripTarget() : null;
    if (target?.LoadOnCarrier) {
      // plan-577: a refused place keeps the part (and this grip's warning).
      if (this.placeAtCarrierTarget(mu, target)) this.clearOwnSeatProblems();
      return;
    }
    // Every other place succeeds and retires this grip's "seat occupied" warnings (F8).
    if (this._seatProblemIds.size > 0) this.clearOwnSeatProblems();
    if (this.PlaceMode === 'Physics') {
      this.placePhysics(mu);
      return;
    }
    if (this.PlaceMode === 'Auto') {
      // Priority 0: the nearest free GripTarget
      if (target) {
        this.unfix(mu);
        placeOnGripTarget(mu, target);
        debug('grip', `Grip "${this.node.name}" placed MU "${mu.getName()}" on GripTarget "${target.node.name}"`);
        return;
      }
      // Priority 1 (plan-516): an MU right below the part, by collider (F2) —
      // the part becomes its passive load and rides along from now on.
      const mus = this.allMUs?.();
      const carrier = mus ? findCarrierByCollider(mu, mus) : null;
      if (carrier) {
        this.unfix(mu, true);
        loadMu(mu, carrier, this.loadHost);
        this.collisionRegistrar?.invalidate();
        debug('grip', `Grip "${this.node.name}" placed MU "${mu.getName()}" onto MU "${carrier.getName()}"`);
        return;
      }
    }
    // Fallback: nothing recognized → release at the current world position under a
    // stable StandardParent (matches C# AutoPlace → ReparentToStandardParent), so a
    // part picked out of a moving Fixer does not snap back into the machine; the
    // transport surface then claims it onto the belt.
    this.unfix(mu, true);
  }

  /**
   * The `LoadOnCarrier` place (plan-577 §2.4): align the part at `target`
   * while it is still in the grip, decide (`decideCarrierPlacement`), then
   *  - `free` → the part (and what it carries) becomes the carrier's load, the
   *    target stays free;
   *  - `noCarrier` → classic target placement;
   *  - `blocked` → nothing is committed: the moving tree is put back to its
   *    pose in the grip, the grip keeps it, a "seat occupied" warning is raised.
   * Returns true when the part was placed.
   */
  private placeAtCarrierTarget(mu: RVMovingUnit, target: RVGripTarget): boolean {
    const node = mu.node;
    _heldPos.copy(node.position);
    _heldQuat.copy(node.quaternion);
    node.parent?.updateWorldMatrix(true, false);
    alignToGripTarget(mu, target);
    node.updateWorldMatrix(true, true);
    const decision = decideCarrierPlacement(mu, this.allMUs?.() ?? []);

    if (decision.kind === 'blocked') {
      this.refusedTargets.set(mu, target);
      this.refusedOwners.set(mu, decision.obstacle);
      // Nothing committed: the whole moving tree goes back to its pose in the grip.
      node.position.copy(_heldPos);
      node.quaternion.copy(_heldQuat);
      node.updateMatrix(); // also for a frozen node (matrixAutoUpdate false)
      node.updateWorldMatrix(true, true);
      mu.updateAABB();
      forEachInLoadTree(mu, (m) => m.updateAABB());
      const id = seatOccupiedProblemId(this.node.uuid, target.node.uuid);
      this._seatProblemIds.add(id);
      reportSeatOccupied({
        id,
        grip: this.node.name,
        target: target.node.name,
        part: mu.getName(),
        carrier: decision.carrier?.getName() ?? null,
        obstacle: decision.obstacle.getName(),
        ambiguous: decision.ambiguous,
      });
      debug('grip', `Grip "${this.node.name}" refused to place MU "${mu.getName()}" at GripTarget "${target.node.name}": blocked by "${decision.obstacle.getName()}"`);
      return false;
    }
    if (decision.kind === 'free') {
      this.unfix(mu, true); // world pose (aligned) kept
      if (loadMu(mu, decision.carrier, this.loadHost)) {
        this.collisionRegistrar?.invalidate();
        debug('grip', `Grip "${this.node.name}" placed MU "${mu.getName()}" at GripTarget "${target.node.name}" onto MU "${decision.carrier.getName()}"`);
        return true;
      }
      placeOnGripTarget(mu, target); // load refused (cycle) → never left floating
      return true;
    }
    // No carrier and nothing in the way → classic target placement.
    this.unfix(mu);
    placeOnGripTarget(mu, target);
    debug('grip', `Grip "${this.node.name}" placed MU "${mu.getName()}" on GripTarget "${target.node.name}" (no carrier below)`);
    return true;
  }

  private clearOwnSeatProblems(): void {
    for (const id of this._seatProblemIds) clearProblem(id);
    this._seatProblemIds.clear();
  }

  /**
   * PlaceMode 'Physics' (plan-525 §2.7): release under the stable
   * StandardParent (world pose kept, rotation included), bring the MU's world
   * matrix and AABB up to THIS tick — the grip runs before the transport
   * manager's central AABB update, and a stale AABB would decide the zone test
   * on last tick's position — then hand it to the physics provider with the
   * grip's own velocity as start velocity. When physics cannot take it (off,
   * provider not ready, outside every zone) the part stays where it was
   * released, exactly like 'Static', with one warning per grip.
   */
  private placePhysics(mu: RVMovingUnit): void {
    this.unfix(mu, true);
    mu.node.updateWorldMatrix(true, true);
    mu.updateAABB();
    const handed = this.physicsHost?.tryHandoverToPhysics(mu, this.velocity) ?? false;
    if (handed) {
      debug('grip', `Grip "${this.node.name}" handed MU "${mu.getName()}" to physics`);
      return;
    }
    if (!this._physicsFallbackWarned) {
      this._physicsFallbackWarned = true;
      console.warn(
        `[Grip] "${this.node.name}": PlaceMode Physics could not hand "${mu.getName()}" to physics `
        + '(physics off, provider not ready or outside every physics zone) — placed like Static',
      );
    }
  }

  // Releases the MU. `toStandardParent` mirrors C# AutoPlace: a Place() that did
  // NOT land on a GripTarget reparents to the StandardParent (here the scene root)
  // at the current world position — NOT to parentBeforeGrip, which for a part
  // picked out of a Fixer on a moving machine axis would drop it straight back into
  // the (moving) machine. The transport surface then claims it onto the belt. A
  // plain release (no auto-place) restores the pre-grip parent.
  private unfix(mu: RVMovingUnit, toStandardParent = false): void {
    // Owner tag (plan-259 O1b): the grip only releases what IT holds — an MU
    // held by a connection (StopOnExit) or a zone is never freed from here.
    // Re-parenting and the collision invalidate live in the shared kernel.
    const restoreParent = toStandardParent
      ? this.sceneRoot()
      : (mu.parentBeforeGrip ?? this.node.parent);
    detachMU(mu, 'grip', restoreParent, this.collisionRegistrar);

    // Remove from gripped list
    const idx = this.grippedMUs.indexOf(mu);
    if (idx >= 0) this.grippedMUs.splice(idx, 1);

    debug('grip', `Grip "${this.node.name}" released MU "${mu.getName()}"`);
  }

  /** Top-level scene root above this grip — a stable, non-moving container to
   *  release parts into at their current world position (the StandardParent-null
   *  equivalent of C# ReparentToStandardParent). */
  private sceneRoot(): Object3D {
    return sceneRootOf(this.node);
  }

  // ── Detection ──

  /** Shortest distance (m) from the grip point `_gripWorldPos` to an MU's collider box. */
  private static distanceToGripPoint(mu: RVMovingUnit): number {
    const aabb = mu.aabb;
    const dx = Math.max(0, Math.max(aabb.min.x - _gripWorldPos.x, _gripWorldPos.x - aabb.max.x));
    const dy = Math.max(0, Math.max(aabb.min.y - _gripWorldPos.y, _gripWorldPos.y - aabb.max.y));
    const dz = Math.max(0, Math.max(aabb.min.z - _gripWorldPos.z, _gripWorldPos.z - aabb.max.z));
    return Math.sqrt(dx * dx + dy * dy + dz * dz);
  }

  /**
   * Candidate search. Active MUs AND, recursively, their passive loads
   * (plan-516 F5) are tested against their own collider box — a load counts
   * even when only IT (not its carrier) is inside the grip range or the
   * `PartToGrip` volume. The smallest collider↔grip-point distance wins.
   */
  private findNearestMU(): RVMovingUnit | null {
    this.node.getWorldPosition(_gripWorldPos);

    // PartToGrip: the sensor's own detection (active MUs) plus every load whose
    // collider lies in the sensor volume. The sensor's MU is considered first,
    // so it keeps the pick on a tie.
    if (this.partToGripSensor) {
      const sensor = this.partToGripSensor;
      let nearest: RVMovingUnit | null = null;
      let minDist = Infinity;
      const sensorMU = sensor.occupiedMU;
      // physicsOwned gate (plan-276 F15): never grab a falling/tumbling
      // physics-owned MU — same exclusion as gripped MUs.
      if (
        sensorMU && !sensorMU.isInstanced &&
        !(sensorMU as RVMovingUnit).isGripped && !isPhysicsOwned(sensorMU)
      ) {
        nearest = sensorMU as RVMovingUnit;
        nearest.updateAABB();
        minDist = RVGrip.distanceToGripPoint(nearest);
      }
      const roots = this.allMUs?.() ?? (sensorMU ? [sensorMU] : []);
      let hasLoads = false;
      for (const r of roots) {
        if (!r.isInstanced && (r as RVMovingUnit).loadedMus.length > 0) { hasLoads = true; break; }
      }
      if (hasLoads) {
        sensor.updateAABB();
        const consider = (load: RVMovingUnit): void => {
          if (load.isGripped || isPhysicsOwned(load) || !sensor.accepts(load)) return;
          load.updateAABB();
          if (!sensor.aabb.overlaps(load.aabb)) return;
          const dist = RVGrip.distanceToGripPoint(load);
          if (dist < minDist) { minDist = dist; nearest = load; }
        };
        for (const r of roots) {
          if (r.isInstanced) continue;
          const carrier = r as RVMovingUnit;
          if (carrier.markedForRemoval) continue;
          this.visitLoads(carrier, consider);
        }
      }
      return nearest;
    }

    // Sphere-AABB overlap (matches Unity Physics.OverlapSphere against BoxColliders).
    // GripRange is in mm, positions/AABBs are in meters.
    const mus = this.allMUs?.();
    if (!mus) return null;

    const rangeM = this.GripRange / MM_TO_METERS;

    let nearest: RVMovingUnit | null = null;
    let minDist = Infinity;
    const consider = (cloneMU: RVMovingUnit): void => {
      // physicsOwned gate (plan-276 F15) — falling/tumbling MUs are the
      // physics provider's; picking one would fight the pose sync.
      if (cloneMU.markedForRemoval || cloneMU.isGripped || isPhysicsOwned(cloneMU)) return;
      // Ensure AABB is fresh (grips run before MU AABB update in transport loop;
      // a passive load is never updated by the tick at all)
      cloneMU.updateAABB();
      const dist = RVGrip.distanceToGripPoint(cloneMU);
      if (dist <= rangeM && dist < minDist) {
        minDist = dist;
        nearest = cloneMU;
      }
    };

    for (const mu of mus) {
      if (mu.isInstanced) continue;
      const cloneMU = mu as RVMovingUnit;
      consider(cloneMU);
      if (!cloneMU.markedForRemoval && cloneMU.loadedMus.length > 0) this.visitLoads(cloneMU, consider);
    }
    return nearest;
  }

  /** Visit the passive load tree below `carrier` (not `carrier` itself). */
  private visitLoads(carrier: RVMovingUnit, fn: (mu: RVMovingUnit) => void): void {
    const loads = carrier.loadedMus;
    for (let i = 0; i < loads.length; i++) {
      fn(loads[i]);
      this.visitLoads(loads[i], fn);
    }
  }

  private findNearestGripTarget(): RVGripTarget | null {
    const targets = this.allGripTargets?.();
    if (!targets) return null;
    this.node.getWorldPosition(_gripWorldPos);
    return findNearestGripTarget(targets, _gripWorldPos, this.GripTargetSearchRadius);
  }

  // ── Update ──

  fixedUpdate(dt: number = PHYSICS_FIXED_DT): void {
    this.sampleVelocity(dt);
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

  /** Grip velocity = world position change over the last tick (plan-525 §2.7). */
  private sampleVelocity(dt: number): void {
    this.node.getWorldPosition(this._velCur);
    if (this._velSamples > 0 && dt > 0) {
      this.velocity.subVectors(this._velCur, this._velPrev).divideScalar(dt);
    } else {
      this.velocity.set(0, 0, 0);
    }
    this._velPrev.copy(this._velCur);
    if (this._velSamples < 2) this._velSamples++;
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
    this.waitingForPart = false;
    for (const mu of this.grippedMUs) {
      this.refusedTargets.delete(mu);
      this.refusedOwners.delete(mu);
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
    this._velSamples = 0;
    this.velocity.set(0, 0, 0);
    // plan-577 F8: a reset retires every "seat occupied" warning (by code — the
    // transport manager resets all grips together).
    this._seatProblemIds.clear();
    clearSeatOccupiedProblems();
  }

  /**
   * Release the signal wiring (plan-427 F6).
   *
   * Subtree removal and `removeRuntimeNode` call only an EXISTING optional
   * `dispose()`, so until this method existed a Grip removed on its own kept
   * both store subscriptions — and, since plan-427, a re-apply slot — alive on
   * a dead instance: `reapplyAll()` would drive `pickObjects` on a gripper that
   * is no longer part of the scene.
   */
  dispose(): void {
    this.waitingForPart = false;
    for (const mu of this.grippedMUs) {
      this.refusedTargets.delete(mu);
      this.refusedOwners.delete(mu);
    }
    if (this._directListener) {
      this.partToGripSensor?.removeMuEnterListener(this._directListener);
      this._directListener = null;
    }
    this.pickAlignNode = null;
    this.allGrips = null;
    this.muHost = null;
    for (const unsub of this.signalUnsubs) unsub();
    this.signalUnsubs.length = 0;
    this.signalPickAddr = null;
    this.signalPlaceAddr = null;
    this.signalStore = null;
    this.allMUs = null;
    this.allGripTargets = null;
    this.loadHost = null;
    this.physicsHost = null;
    this.collisionRegistrar = null;
  }
}

/** What a Grip needs for PlaceMode 'Physics' (RVTransportManager implements it). */
export interface GripPhysicsHost {
  tryHandoverToPhysics(mu: RVMovingUnit, initialVelocity?: { x: number; y: number; z: number }): boolean;
  /** Take a Rapier-owned MU back into the transport (DirectlyGrip, plan-2016 S7). */
  reclaimFromPhysics?(mu: RVMovingUnit | InstancedMovingUnit): boolean;
}

/** What a DirectlyGrip / PickAlignWithObject grip needs from the MU set (plan-2016 S4,
 *  RVTransportManager implements it). */
export interface GripMuHost {
  promoteInstancedMU(mu: InstancedMovingUnit): RVMovingUnit | null;
  reindexMU(mu: RVMovingUnit | InstancedMovingUnit): void;
}

// Self-register for auto-discovery by scene loader
registerComponent({
  type: 'Grip',
  schema: RVGrip.schema,
  capabilities: {
    authorable: true,   // addable in the asset editor (schema-complete)
    bake: 'chunk',      // carries picked MUs — a mover (plan-753 §2.3)
  },
  create: (node) => new RVGrip(node),
});
