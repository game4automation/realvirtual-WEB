// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-physics-zone2d.ts — RVPhysicsZone2D, TypeScript counterpart of Unity
 * `WebPhysicsZone2D.cs` (plan-661 Phase 2).
 *
 * A 2D interaction zone is a BOX VOLUME on a conveyor line inside which MUs
 * are simulated in the plane (x / z, angle about Y) by Box2D — jam fronts,
 * buffer tables, diverters and merges. The volume comes from the node's
 * `BoxCollider` extras (the same rule as `WebPhysicsZone`, plan-525). The
 * component carries ONLY the authored description; the Box2D world, the
 * handover and the return live in the Private zone plugin (Phase 3/4).
 *
 * References (`Surface`, `Guides`, `KinematicDrives`) are node references
 * (Unity `GameObject` / `List<GameObject>`). They are read RAW from rv_extras
 * (pattern `RVWebVisibility.AdditionalTargets`): the generic ref resolver only
 * knows signal / drive types, and the plugin needs nodes, not instances.
 * The bake keeps the target nodes alive (`REFERENCE_BAKE_TARGETS`).
 *
 * plan-769: they are STORED references of the zone's file. The raw strings below
 * are paths for the path form and labels for a web-saved `{ address }` /
 * `{ unresolvedPath }` (`storedRefString`); a node is only ever obtained through
 * {@link RVPhysicsZone2D.resolveReference} (`registry.storedNode` with the zone as
 * referrer — the file's verdict), never through the runtime path index. Being
 * `ComponentReference` objects, migration on load and the save writer handle them
 * through the generic reference walk — no `PATH_FIELDS` entry.
 *
 * Not to be confused with `RVPhysicsZone` (3D Rapier zone, free bodies) —
 * a 2D zone never lets an MU fall or tip; that is the point of it.
 */

import type { Object3D } from 'three';
import type { ComponentContext, ComponentSchema, RVComponent } from './rv-component-registry';
import { registerComponent, loadSchemaFromSpec } from './rv-component-registry';
import { AABB } from './rv-aabb';
import { getColliderExtras, isValidBoxDef } from './rv-collider-extras';
import type { GizmoHandle, GizmoOverlayManager } from './rv-gizmo-manager';
import { syncColliderGizmo } from './rv-collider-gizmo-sync';
import type { PhysicsAABB } from './rv-physics-registry';
import { storedRefString } from './rv-stored-ref-label';

/** Extras key / Unity class name. */
export const PHYSICS_ZONE2D_TYPE = 'WebPhysicsZone2D';

/** What the zone does (plan-661 §2.3). */
export type PhysicsZone2DKind = 'Jam' | 'BufferTable' | 'Diverter' | 'Merge';
export const PHYSICS_ZONE2D_KINDS: readonly PhysicsZone2DKind[] = Object.freeze(['Jam', 'BufferTable', 'Diverter', 'Merge']);

const ZONE2D_GIZMO_COLOR = 0xffa726; // orange — distinct from the cyan 3D zone
const ZONE2D_GIZMO_OPACITY = 0.5;

/**
 * The stored-reference string of one raw entry (ComponentReference in any stored
 * form, or a plain path string): the path, or — for an address / a kept path — the
 * label `owner`'s `readStoredRef` reads back (plan-769, `storedRefString`).
 */
export function refPathOf(item: unknown, owner?: Object3D | null): string | null {
  return storedRefString(owner, item);
}

/** Stored-reference strings of a raw reference list; non-array / malformed entries are dropped. */
export function refPathsOf(raw: unknown, owner?: Object3D | null): string[] {
  if (!Array.isArray(raw)) return [];
  const out: string[] = [];
  for (const item of raw) {
    const p = refPathOf(item, owner);
    if (p) out.push(p);
  }
  return out;
}

function finiteOr(v: unknown, dflt: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : dflt;
}

export class RVPhysicsZone2D implements RVComponent {
  static readonly schema: ComponentSchema = loadSchemaFromSpec(PHYSICS_ZONE2D_TYPE);

  /** All registered 2D zones in registration order. */
  static readonly zones: RVPhysicsZone2D[] = [];

  /** Dispose every zone and empty the list (model switch, tests). */
  static clearAll(): void {
    for (const zone of [...RVPhysicsZone2D.zones]) zone.dispose();
    RVPhysicsZone2D.zones.length = 0;
  }

  readonly node: Object3D;
  isOwner = true;

  // ── Schema-populated (exact C# field names) ──
  Kind: PhysicsZone2DKind = 'Jam';
  Damping = 0;            // 1/s, buffer-table run-out
  SleepThreshold = 0.05;  // m/s
  ForceReturnAfter = 0;   // s, return ONLY for a detected faulty pose; 0 = never
  ShowGizmo = true;
  /** Schema-resolved forms (resolved instance / null); the plugin uses the raw paths below. */
  Surface: unknown = null;
  KinematicDrives: unknown[] = [];

  // ── Raw references (stored-reference strings — a node only via resolveReference) ──
  /** Destination / discharge surface (return target). */
  surfacePath: string | null = null;
  /** Guides — static Box2D shapes. */
  guidePaths: string[] = [];
  /** Diverter / merge drives whose pose the zone follows as kinematic bodies. */
  kinematicDrivePaths: string[] = [];

  private _boxAabb: AABB | null;
  private _registered = false;
  private _initialized = false;
  private _gizmo: GizmoHandle | null = null;
  private _gizmoManager: GizmoOverlayManager | null = null;

  constructor(node: Object3D, aabb: AABB | null) {
    this.node = node;
    this._boxAabb = aabb && aabb.halfSize.lengthSq() > 0 ? aabb : null;
  }

  /** Zone volume in world metres, or `null` without a box. */
  get worldAabb(): PhysicsAABB | null {
    return this._boxAabb;
  }

  /** True when the zone takes part in the simulation. */
  get active(): boolean {
    return this._registered && this._boxAabb !== null;
  }

  /** Read the raw references from rv_extras (also after a field edit). */
  readReferences(extras?: Record<string, unknown>): void {
    const raw = extras ?? (this.node.userData?.realvirtual as Record<string, Record<string, unknown>> | undefined)?.[PHYSICS_ZONE2D_TYPE];
    this.surfacePath = refPathOf(raw?.['Surface'], this.node);
    this.guidePaths = refPathsOf(raw?.['Guides'], this.node);
    this.kinematicDrivePaths = refPathsOf(raw?.['KinematicDrives'], this.node);
  }

  /**
   * The node one raw reference (`surfacePath`, `guidePaths[i]`,
   * `kinematicDrivePaths[i]`) names. plan-769: a STORED reference of this zone's
   * file — read by the file's verdict (`registry.storedNode` with the zone as
   * referrer), never by a guessing stage; a path the file does not carry (written
   * this session, a document without an identity record) still goes through
   * `registry.getNode`. `null` = not in the scene.
   */
  resolveReference(
    registry: { storedNode(referrer: Object3D | null, ref: string): Object3D | null },
    ref: string,
  ): Object3D | null {
    return registry.storedNode(this.node, ref);
  }

  init(ctx: ComponentContext): void {
    this.node.userData._rvType = PHYSICS_ZONE2D_TYPE;
    this._initialized = true;
    if (!PHYSICS_ZONE2D_KINDS.includes(this.Kind)) this.Kind = 'Jam';
    this.Damping = Math.max(0, finiteOr(this.Damping, 0));
    this.SleepThreshold = Math.max(0, finiteOr(this.SleepThreshold, 0.05));
    this.ForceReturnAfter = Math.max(0, finiteOr(this.ForceReturnAfter, 0));
    if (ctx.gizmoManager) this._gizmoManager = ctx.gizmoManager;
    if (!this._boxAabb) {
      console.warn(`[WebPhysicsZone2D] "${this.node.name}": no BoxCollider extras — zone is ignored`);
      return;
    }
    this._register();
    if (ctx.gizmoManager) this.attachGizmo(ctx.gizmoManager);
  }

  /**
   * Re-derive the volume from explicit BoxCollider values (handle preview,
   * field edit, undo) — same contract as `RVPhysicsZone.refreshBounds`.
   * `center` node-local glTF metres (X negated), `size` metres; `null` = box removed.
   */
  refreshBounds(
    center: { x: number; y: number; z: number } | null,
    size: { x: number; y: number; z: number } | null,
  ): void {
    if (!center || !size || !isValidBoxDef(center, size)) {
      if (this._boxAabb) console.warn(`[WebPhysicsZone2D] "${this.node.name}": BoxCollider removed or degenerate — zone inactive`);
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
    if (this._initialized) this._register();
    this._refreshGizmo();
  }

  attachGizmo(gizmoManager: GizmoOverlayManager): void {
    this._gizmoManager = gizmoManager;
    this._refreshGizmo();
    syncColliderGizmo(this.node);
  }

  /** Field edit on the live instance (inspector, `setField`, undo). */
  reapplyConfig(): void {
    this.readReferences();
    if (this.ShowGizmo) this._refreshGizmo();
    else this._disposeGizmo();
    syncColliderGizmo(this.node);
  }

  setGizmoVisible(visible: boolean): void {
    this._gizmo?.setVisible(visible);
  }

  private _register(): void {
    if (this._registered) return;
    this._registered = true;
    RVPhysicsZone2D.zones.push(this);
  }

  private _refreshGizmo(): void {
    if (!this._gizmoManager || !this.ShowGizmo) return;
    const volume = this._boxAabb;
    if (!volume) return;
    if (!this._gizmo) {
      this._gizmo = this._gizmoManager.create(this.node, {
        shape: 'box', color: ZONE2D_GIZMO_COLOR, opacity: ZONE2D_GIZMO_OPACITY, category: 'status',
      });
    }
    const root = this._gizmo.root;
    root.position.set((volume.min.x + volume.max.x) / 2, (volume.min.y + volume.max.y) / 2, (volume.min.z + volume.max.z) / 2);
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
      const idx = RVPhysicsZone2D.zones.indexOf(this);
      if (idx !== -1) RVPhysicsZone2D.zones.splice(idx, 1);
    }
  }
}

/** The node's own BoxCollider wins over the loader AABB (plan-525 rule). */
function zone2DVolumeOf(node: Object3D, loaderAabb: AABB | null): AABB | null {
  for (const col of getColliderExtras(node)) {
    if (col.kind !== 'box') continue;
    node.updateWorldMatrix(true, false);
    return AABB.fromBoxCollider(node, col.center, col.size);
  }
  return loaderAabb;
}

registerComponent({
  type: PHYSICS_ZONE2D_TYPE,
  displayName: 'PhysicsZone2D',
  schema: RVPhysicsZone2D.schema,
  needsAABB: true,
  capabilities: {
    pick: 'none',
    // Addable in the asset editor; the editor adds a missing BoxCollider.
    authorable: true,
    ui: { badge: '#ffa726' },
  },
  create: (node, aabb) => new RVPhysicsZone2D(node, zone2DVolumeOf(node, aabb)),
  beforeSchema: (inst, extras) => {
    (inst as RVPhysicsZone2D).readReferences(extras);
  },
});
