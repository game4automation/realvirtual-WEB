// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * agv-scanner-field-plugin.ts — draws the AGV safety scanner fields on the
 * floor in front of every vehicle (plan-558 Phase 5).
 *
 * Per vehicle with `ScannerFields` a small group is parented to the vehicle
 * root (it follows the pose for free — no world updates): a translucent
 * WARNING field (yellow) and the PROTECTIVE field inside it (red), each a flat
 * rectangle plus outline from the body front along the travel direction
 * (local +Z — the pose is `lookRotation(tangent, align)`, whose +Z is the
 * tangent). The group cancels the root's own signed scale, so a mirrored
 * (`S[-1,1,1]` from the Unity export) or scaled root still gets the field in
 * the unscaled travel frame, and it is flagged `AGV_NO_BODY_KEY` so the Agv's
 * mesh-bounds footprint never measures the field as vehicle body (that made
 * the field walk away from the vehicle on every re-configure).
 *
 * The field LENGTHS follow the vehicle's speed at RENDER time — read
 * through the fleet handle's `motion()` (the plan speed at the time the pose
 * tween last sampled the vehicle), so they are right between DES events too,
 * never from signals. An engaged field turns opaque. In curves the fields stay
 * straight (deliberate simplification).
 *
 * Visibility is the overlay category `safety-fields` (default OFF, toggled in
 * the Overlays menu). Geometry and materials are shared by all vehicles and
 * reference-counted: the last field group removed disposes them.
 * `markRenderDirty` only when something visibly changed.
 */

import {
  BufferGeometry, Float32BufferAttribute, Group, LineBasicMaterial, LineSegments, Mesh, MeshBasicMaterial,
  PlaneGeometry, DoubleSide, type Object3D,
} from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import { PLUGIN_ORDER } from '../core/rv-plugin-order';
import { getDefaultAgvFleet, AGV_NO_BODY_KEY, type AgvMotionInfo } from '../core/engine/rv-agv-fleet';
import { markNoAO } from '../core/engine/rv-group-registry';
import {
  isOverlayVisible, subscribeOverlayVisibility, registerOverlayProducer, unregisterOverlayProducer,
} from '../core/overlay-visibility-store';

/** Lateral clearance (m) added to the body width (plan-558 §3.2). */
const FIELD_EXTRA_WIDTH = 0.1;
/** Height (m) above the vehicle root plane. */
const FIELD_Y = 0.02;
/** Length change (m) below which no re-render is requested. */
const LENGTH_EPS = 0.001;

const COLOR_WARNING = 0xffc400;
const COLOR_PROTECTIVE = 0xff1744;

interface FieldEntry {
  id: string;
  node: Object3D;
  group: Group;
  warnFill: Mesh;
  warnLine: LineSegments;
  protFill: Mesh;
  protLine: LineSegments;
  warnLen: number;
  protLen: number;
  state: AgvMotionInfo['field'];
}

interface SharedResources {
  plane: PlaneGeometry;
  outline: BufferGeometry;
  warnFill: MeshBasicMaterial;
  warnFillActive: MeshBasicMaterial;
  protFill: MeshBasicMaterial;
  protFillActive: MeshBasicMaterial;
  warnLine: LineBasicMaterial;
  protLine: LineBasicMaterial;
}

/** Unit rectangle outline in XZ: x ∈ [−0.5, 0.5], z ∈ [0, 1]. */
function unitOutline(): BufferGeometry {
  const g = new BufferGeometry();
  g.setAttribute('position', new Float32BufferAttribute([
    -0.5, 0, 0, 0.5, 0, 0,
    0.5, 0, 0, 0.5, 0, 1,
    0.5, 0, 1, -0.5, 0, 1,
    -0.5, 0, 1, -0.5, 0, 0,
  ], 3));
  return g;
}

const noRaycast = (): void => {};

/**
 * Cancel the vehicle root's OWN (signed) scale on the field group, so the
 * group's frame is the root's translation + rotation only — the travel frame
 * the pose writes (`root.quaternion` = lookRotation, +Z = tangent). The root's
 * local scale is the authored one (e.g. the Unity export's mirror S[-1,1,1]);
 * its signed inverse undoes it exactly on any axis, which a decomposition of
 * the world matrix cannot (it folds a Z mirror into an X mirror + 180° turn).
 * Called once per group (a vehicle root's scale is static).
 */
function cancelRootScale(group: Group, root: Object3D): void {
  const inv = (v: number): number => (Math.abs(v) < 1e-9 ? 1 : 1 / v);
  const s = root.scale;
  group.scale.set(inv(s.x), inv(s.y), inv(s.z));
  group.position.set(0, FIELD_Y * inv(s.y), 0);
}

export class AgvScannerFieldPlugin implements RVViewerPlugin {
  readonly id = 'agv-scanner-fields';
  readonly order = PLUGIN_ORDER.UI_OVERLAY;

  private viewer: RVViewer | null = null;
  private readonly entries = new Map<string, FieldEntry>();
  private shared: SharedResources | null = null;
  private refs = 0;
  private visible = isOverlayVisible('safety-fields');
  private offOverlay: (() => void) | null = null;
  private producing = false;
  /** Per-frame motion scratch (no allocation in onRender). */
  private readonly info: AgvMotionInfo = {
    speed: 0, field: 'clear', protectiveLength: 0, warningLength: 0, front: 0, width: 0, scanner: false,
  };

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.offOverlay = subscribeOverlayVisibility(() => {
      const v = isOverlayVisible('safety-fields');
      if (v === this.visible) return;
      this.visible = v;
      for (const e of this.entries.values()) e.group.visible = v;
      this.viewer?.markRenderDirty?.();
    });
  }

  onModelCleared(): void {
    this.clearEntries();
  }

  dispose(): void {
    this.clearEntries();
    this.offOverlay?.();
    this.offOverlay = null;
    this.viewer = null;
  }

  /** Number of live field groups (diagnostics / tests). */
  get fieldCount(): number {
    return this.entries.size;
  }

  /** True while the shared geometry / materials exist (refcount > 0). */
  get hasSharedResources(): boolean {
    return this.shared !== null;
  }

  onRender(): void {
    const fleet = getDefaultAgvFleet();
    let dirty = false;
    let seen = 0;
    const info = this.info;
    for (const handle of fleet.handleList) {
      const node = handle.node;
      if (!node || !handle.motion || !handle.motion(info) || !info.scanner) continue;
      seen++;
      let e = this.entries.get(handle.id);
      if (e && e.node !== node) { this.removeEntry(e); e = undefined; }
      if (!e) {
        e = this.createEntry(handle.id, node);
        dirty = true;
      }
      if (this.updateEntry(e, info)) dirty = true;
    }
    // Vehicles that left the fleet (despawn / model switch without clear).
    if (seen < this.entries.size) {
      for (const e of [...this.entries.values()]) {
        if (!fleet.get(e.id)) { this.removeEntry(e); dirty = true; }
      }
    }
    this.setProducing(this.entries.size > 0);
    if (dirty && this.visible) this.viewer?.markRenderDirty?.();
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private acquireShared(): SharedResources {
    if (!this.shared) {
      const fill = (color: number, opacity: number): MeshBasicMaterial => new MeshBasicMaterial({
        color, transparent: true, opacity, depthWrite: false, side: DoubleSide,
      });
      const plane = new PlaneGeometry(1, 1);
      plane.rotateX(-Math.PI / 2);
      plane.translate(0, 0, 0.5); // z ∈ [0, 1]
      this.shared = {
        plane,
        outline: unitOutline(),
        warnFill: fill(COLOR_WARNING, 0.15),
        warnFillActive: fill(COLOR_WARNING, 0.45),
        protFill: fill(COLOR_PROTECTIVE, 0.2),
        protFillActive: fill(COLOR_PROTECTIVE, 0.6),
        warnLine: new LineBasicMaterial({ color: COLOR_WARNING, transparent: true, opacity: 0.9, depthWrite: false }),
        protLine: new LineBasicMaterial({ color: COLOR_PROTECTIVE, transparent: true, opacity: 0.9, depthWrite: false }),
      };
    }
    this.refs++;
    return this.shared;
  }

  private releaseShared(): void {
    if (this.refs <= 0) return;
    this.refs--;
    if (this.refs > 0 || !this.shared) return;
    const s = this.shared;
    s.plane.dispose();
    s.outline.dispose();
    s.warnFill.dispose();
    s.warnFillActive.dispose();
    s.protFill.dispose();
    s.protFillActive.dispose();
    s.warnLine.dispose();
    s.protLine.dispose();
    this.shared = null;
  }

  private createEntry(id: string, node: Object3D): FieldEntry {
    const s = this.acquireShared();
    const group = new Group();
    group.name = '__agvScannerFields';
    group.userData._rvSynthetic = true;
    group.userData[AGV_NO_BODY_KEY] = true;
    const warnFill = new Mesh(s.plane, s.warnFill);
    const warnLine = new LineSegments(s.outline, s.warnLine);
    const protFill = new Mesh(s.plane, s.protFill);
    const protLine = new LineSegments(s.outline, s.protLine);
    for (const o of [warnFill, warnLine, protFill, protLine]) {
      o.raycast = noRaycast; // never pickable — the vehicle stays the click target
      o.renderOrder = 10;
      group.add(o);
    }
    protFill.position.y = protLine.position.y = 0.001; // inner field above the outer one
    cancelRootScale(group, node);
    group.visible = this.visible;
    markNoAO(group);
    node.add(group);
    const e: FieldEntry = {
      id, node, group, warnFill, warnLine, protFill, protLine, warnLen: -1, protLen: -1, state: 'clear',
    };
    this.entries.set(id, e);
    return e;
  }

  /** Apply the render-time motion to one field group; true = visibly changed. */
  private updateEntry(e: FieldEntry, info: AgvMotionInfo): boolean {
    const width = info.width + FIELD_EXTRA_WIDTH;
    let changed = false;
    if (Math.abs(info.warningLength - e.warnLen) > LENGTH_EPS || Math.abs(info.protectiveLength - e.protLen) > LENGTH_EPS) {
      e.warnLen = info.warningLength;
      e.protLen = info.protectiveLength;
      for (const o of [e.warnFill, e.warnLine]) { o.scale.set(width, 1, Math.max(1e-4, e.warnLen)); o.position.z = info.front; }
      for (const o of [e.protFill, e.protLine]) { o.scale.set(width, 1, Math.max(1e-4, e.protLen)); o.position.z = info.front; }
      changed = true;
    }
    if (info.field !== e.state) {
      e.state = info.field;
      const s = this.shared!;
      e.warnFill.material = info.field === 'clear' ? s.warnFill : s.warnFillActive;
      e.protFill.material = info.field === 'protective' ? s.protFillActive : s.protFill;
      changed = true;
    }
    return changed && this.visible;
  }

  private removeEntry(e: FieldEntry): void {
    e.group.removeFromParent();
    this.entries.delete(e.id);
    this.releaseShared();
  }

  private clearEntries(): void {
    for (const e of [...this.entries.values()]) this.removeEntry(e);
    this.setProducing(false);
  }

  private setProducing(on: boolean): void {
    if (on === this.producing) return;
    this.producing = on;
    if (on) registerOverlayProducer('safety-fields');
    else unregisterOverlayProducer('safety-fields');
  }
}
