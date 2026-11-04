// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mujoco-region.ts — `RVMuJoCoRegion`, the component that declares a
 * detail-physics region (plan-673 Phase 2).
 *
 * The subtree below the node is simulated by MuJoCo instead of the standard
 * engine. The region volume — where an MU changes engine — is the node's own
 * `BoxCollider` extras, the same rule `WebPhysicsZone` and `WebPhysicsZone2D`
 * follow (plan-525), so there is no second place that states a volume.
 *
 * It REPLACES the free extras key `rv_mujoco` of the plan-659 spike. What the
 * component gains over the free key is the whole reason for the change:
 * authoring in the asset editor, validation against the schema, a bake claim
 * for the region node, problems entries instead of `console.warn`, and the
 * normal feature trigger `component:WebMuJoCoRegion` instead of a hand-written
 * depth-limited probe.
 *
 * Three fields of `rv_mujoco` deliberately did NOT come along:
 *   - `wasm{mujoco,ort}` — runtime resolution, never model content. A delivered
 *     GLB that points into `node_modules` is wrong after every bundler or
 *     deploy change.
 *   - `command{vx,vy,yaw}` — the initial value of a signal declaration, not a
 *     second home for an operating point.
 *   - `obstacles[]` — scene content. Each obstacle is a node with `FreeBody`,
 *     `CollisionShapeSet` and `ContactProfile`; a central list in a generator
 *     is neither clickable, nor addressable over MCP, nor movable by the user.
 *
 * The component carries the authored declaration only. The MuJoCo world, the
 * MJCF writer and the handover live in the private physics plugin (Phase 3+).
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { AABB } from './rv-aabb';
import { getColliderExtras, isValidBoxDef } from './rv-collider-extras';
import type { GizmoHandle, GizmoOverlayManager } from './rv-gizmo-manager';
import { syncColliderGizmo } from './rv-collider-gizmo-sync';

/** Extras key / Unity class name. */
export const MUJOCO_REGION_TYPE = 'WebMuJoCoRegion';

/** How a carrier and its load enter the region. */
export type LoadTreeMode = 'composite' | 'separate';
export const LOAD_TREE_MODES: readonly LoadTreeMode[] = Object.freeze(['composite', 'separate']);

const REGION_GIZMO_COLOR = 0x7e57c2; // violet — distinct from the cyan 3D and orange 2D zones
const REGION_GIZMO_OPACITY = 0.4;

/** Bounds of `TimestepS`, mirrored from the schema so a hand-edited GLB is clamped too. */
const TIMESTEP_MIN = 0.0001;
const TIMESTEP_MAX = 0.1;

function finiteOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export class RVMuJoCoRegion implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec(MUJOCO_REGION_TYPE);

  /** All regions of the loaded scene, in registration order. */
  static readonly regions: RVMuJoCoRegion[] = [];

  /** Dispose every region and empty the list (model switch, tests). */
  static clearAll(): void {
    for (const region of [...RVMuJoCoRegion.regions]) region.dispose();
    RVMuJoCoRegion.regions.length = 0;
  }

  readonly node: Object3D;
  isOwner = true;

  // ── Schema-populated ──
  RegionEnabled = true;
  TimestepS = 0.002;       //!< s
  ExitBandM = 0.5;         //!< m
  LoadTreeMode: LoadTreeMode = 'composite';
  MjcfSource = '';
  MeshBase = '';
  Contract = '';
  TrunkBody = '';
  TrunkFreeJoint = '';
  GyroSensor = '';
  ShowGizmo = true;

  private _boxAabb: AABB | null;
  private _registered = false;
  private _gizmo: GizmoHandle | null = null;
  private _gizmoManager: GizmoOverlayManager | null = null;

  constructor(node: Object3D, aabb: AABB | null) {
    this.node = node;
    this._boxAabb = aabb && aabb.halfSize.lengthSq() > 0 ? aabb : null;
  }

  /** Region volume in world metres, or `null` without a box. */
  get worldAabb(): AABB | null {
    return this._boxAabb;
  }

  /** True when the region takes part in the simulation. */
  get active(): boolean {
    return this._registered && this.RegionEnabled;
  }

  /**
   * Policy rate of a `Decimation` in this region, in Hz — `1 / (TimestepS *
   * Decimation)`. The one place that derives it, so a policy never has to carry
   * a rate field that can contradict the two numbers it comes from.
   */
  policyRateHz(decimation: number): number {
    const d = Math.max(1, Math.round(finiteOr(decimation, 1)));
    const dt = this.TimestepS > 0 ? this.TimestepS : TIMESTEP_MIN;
    return 1 / (dt * d);
  }

  init(ctx: ComponentContext): void {
    this.node.userData._rvType = MUJOCO_REGION_TYPE;
    if (!LOAD_TREE_MODES.includes(this.LoadTreeMode)) this.LoadTreeMode = 'composite';
    this.TimestepS = clamp(finiteOr(this.TimestepS, 0.002), TIMESTEP_MIN, TIMESTEP_MAX);
    this.ExitBandM = Math.max(0, finiteOr(this.ExitBandM, 0.5));
    if (ctx.gizmoManager) this._gizmoManager = ctx.gizmoManager;
    this._register();
    if (ctx.gizmoManager) this.attachGizmo(ctx.gizmoManager);
  }

  /**
   * Re-derive the volume from explicit `BoxCollider` values (handle preview,
   * field edit, undo). `center` node-local glTF metres (X negated), `size`
   * metres; `null` = box removed.
   */
  refreshBounds(
    center: { x: number; y: number; z: number } | null,
    size: { x: number; y: number; z: number } | null,
  ): void {
    if (!center || !size || !isValidBoxDef(center, size)) {
      this._boxAabb = null;
      this._disposeGizmo();
      return;
    }
    this.node.updateWorldMatrix(true, false);
    const box = this._boxAabb;
    if (box) {
      box.localCenter.set(center.x, center.y, center.z);
      box.halfSize.set(Math.abs(size.x) / 2, Math.abs(size.y) / 2, Math.abs(size.z) / 2);
      box.update();
    } else {
      this._boxAabb = AABB.fromBoxCollider(this.node, { x: -center.x, y: center.y, z: center.z }, size);
    }
    this._refreshGizmo();
  }

  /** Field edit on the live instance (inspector, `setField`, undo). */
  reapplyConfig(): void {
    this.TimestepS = clamp(finiteOr(this.TimestepS, 0.002), TIMESTEP_MIN, TIMESTEP_MAX);
    this.ExitBandM = Math.max(0, finiteOr(this.ExitBandM, 0.5));
    if (this.ShowGizmo) this._refreshGizmo();
    else this._disposeGizmo();
    syncColliderGizmo(this.node);
  }

  attachGizmo(gizmoManager: GizmoOverlayManager): void {
    this._gizmoManager = gizmoManager;
    this._refreshGizmo();
    syncColliderGizmo(this.node);
  }

  setGizmoVisible(visible: boolean): void {
    this._gizmo?.setVisible(visible);
  }

  private _register(): void {
    if (this._registered) return;
    this._registered = true;
    RVMuJoCoRegion.regions.push(this);
  }

  private _refreshGizmo(): void {
    if (!this._gizmoManager || !this.ShowGizmo) return;
    const volume = this._boxAabb;
    if (!volume) return;
    if (!this._gizmo) {
      this._gizmo = this._gizmoManager.create(this.node, {
        shape: 'box', color: REGION_GIZMO_COLOR, opacity: REGION_GIZMO_OPACITY, category: 'status',
      });
    }
    const root = this._gizmo.root;
    root.position.set(
      (volume.min.x + volume.max.x) / 2,
      (volume.min.y + volume.max.y) / 2,
      (volume.min.z + volume.max.z) / 2,
    );
    root.scale.set(
      Math.max(volume.max.x - volume.min.x, 0.001),
      Math.max(volume.max.y - volume.min.y, 0.001),
      Math.max(volume.max.z - volume.min.z, 0.001),
    );
  }

  private _disposeGizmo(): void {
    this._gizmo?.dispose();
    this._gizmo = null;
  }

  dispose(): void {
    this._disposeGizmo();
    this._gizmoManager = null;
    if (this._registered) {
      this._registered = false;
      const idx = RVMuJoCoRegion.regions.indexOf(this);
      if (idx !== -1) RVMuJoCoRegion.regions.splice(idx, 1);
    }
  }
}

/** The node's own BoxCollider wins over the loader AABB (plan-525 rule). */
function regionVolumeOf(node: Object3D, loaderAabb: AABB | null): AABB | null {
  for (const col of getColliderExtras(node)) {
    if (col.kind !== 'box') continue;
    node.updateWorldMatrix(true, false);
    return AABB.fromBoxCollider(node, col.center, col.size);
  }
  return loaderAabb;
}

/** The region of `node` or of its nearest ancestor that declares one. */
export function enclosingMuJoCoRegion(node: Object3D | null): RVMuJoCoRegion | null {
  for (let n: Object3D | null = node; n; n = n.parent) {
    const list = (n.userData?._rvComponentInstances as unknown[] | undefined) ?? [];
    for (const inst of list) {
      if (inst instanceof RVMuJoCoRegion) return inst;
    }
  }
  return null;
}

registerComponent({
  type: MUJOCO_REGION_TYPE,
  displayName: 'MuJoCoRegion',
  schema: RVMuJoCoRegion.schema,
  needsAABB: true,
  capabilities: {
    pick: 'none',
    authorable: true,
    ui: { badge: '#7e57c2' },
  },
  create: (node, aabb) => new RVMuJoCoRegion(node, regionVolumeOf(node, aabb)),
});
