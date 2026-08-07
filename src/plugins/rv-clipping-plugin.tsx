// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-clipping-plugin.tsx — Section / clipping-plane tool for the realvirtual WebViewer.
 *
 * Lets the user slice the loaded model along the X, Y or Z axis to expose
 * inner geometry (drives, cabling, mounted components). Implemented via
 * Three.js **per-material** clipping planes (`renderer.localClippingEnabled`
 * + `material.clippingPlanes`) so that overlays / gizmos / HMI (which live
 * outside `result.root` or on the overlay layer) are NOT cut.
 *
 * Key design points (see plan-251):
 * - Fixed 3-element `planes` array (length always 3) → no shader recompile on
 *   axis toggle; a disabled axis pushes `plane.constant` to LARGE so nothing
 *   is clipped. Slider drag mutates only `plane.constant` / `plane.normal`
 *   (GC-free, no recompile).
 * - Per-material assignment collected once at model load via `traverseMeshes`,
 *   overlay meshes (`_tankFillViz` marker or HIGHLIGHT_OVERLAY_LAYER) excluded.
 * - `localClippingEnabled` is only reset on destroy when no TankFillManager is
 *   active (both set it to true; idempotent).
 */

import {
  Plane,
  Vector3,
  Box3,
  PlaneGeometry,
  MeshBasicMaterial,
  Mesh,
  DoubleSide,
} from 'three';
import type { Material, Object3D } from 'three';
import { RVBehavior } from '../core/rv-behavior';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import { traverseMeshes } from '../core/engine/rv-traverse-utils';
import { HIGHLIGHT_OVERLAY_LAYER, markAsOverlay } from '../core/engine/rv-group-registry';
import { createStore } from '../core/hmi/create-store';

// ── Data model ─────────────────────────────────────────────────────────

export type ClipAxis = 'x' | 'y' | 'z';

export interface ClippingAxisState {
  enabled: boolean;
  /** normalized position -1..+1 (0 = bounding-box center) */
  position: number;
  /** inverts which half stays visible */
  flip: boolean;
}

export interface ClippingState {
  x: ClippingAxisState;
  y: ClippingAxisState;
  z: ClippingAxisState;
}

export const DEFAULT_CLIPPING_STATE: ClippingState = {
  x: { enabled: false, position: 0, flip: false },
  y: { enabled: false, position: 0, flip: false },
  z: { enabled: false, position: 0, flip: false },
};

export function serializeClippingState(s: ClippingState): string {
  return JSON.stringify(s);
}

export function deserializeClippingState(raw: string): ClippingState {
  try {
    const p = JSON.parse(raw);
    // defensive against partial objects / old schemas:
    return {
      x: { ...DEFAULT_CLIPPING_STATE.x, ...p?.x },
      y: { ...DEFAULT_CLIPPING_STATE.y, ...p?.y },
      z: { ...DEFAULT_CLIPPING_STATE.z, ...p?.z },
    };
  } catch {
    return structuredClone(DEFAULT_CLIPPING_STATE);
  }
}

// ── Constants ──────────────────────────────────────────────────────────

const LS_PREFIX = 'rv-clipping-';
const LARGE = 1e9; // constant that keeps the whole model on the visible side
const ACTIVE_COLOR = '#4fc3f7';

const AXES: ClipAxis[] = ['x', 'y', 'z'];
/** Immutable unit normals — only ever `.copy()`ed from, never mutated. */
const AXIS_NORMAL: Record<ClipAxis, Vector3> = {
  x: new Vector3(1, 0, 0),
  y: new Vector3(0, 1, 0),
  z: new Vector3(0, 0, 1),
};
/** Plane-visualization colors (X=red, Y=green, Z=blue) — match measurement axes. */
const AXIS_VIZ_COLOR = [0xef5350, 0x66bb6a, 0x42a5f5];

// ── Pure helpers ───────────────────────────────────────────────────────

/**
 * Map a normalized position (-1..+1) onto a world coordinate along `axis`
 * within `bbox`. -1 = bbox min, 0 = center, +1 = bbox max. Pure & testable.
 */
export function computeClipPlanePosition(bbox: Box3, axis: ClipAxis, normalizedPos: number): number {
  const min = bbox.min[axis];
  const max = bbox.max[axis];
  const center = (min + max) / 2;
  const half = (max - min) / 2;
  return center + normalizedPos * half;
}

/** Own model hash (LoadResult has no modelHash) — pattern from measurement-plugin. */
export function computeModelHash(result: LoadResult): string {
  return (result.drives ?? []).map((d) => d.name).join('|');
}

/** True for meshes that must NOT be clipped (tank-fill overlays, gizmos, HMI). */
export function isOverlayMesh(mesh: Object3D): boolean {
  return (
    mesh.userData?._tankFillViz === true ||
    mesh.layers.isEnabled(HIGHLIGHT_OVERLAY_LAYER)
  );
}

function materialsOf(mesh: Mesh): Material[] {
  const m = mesh.material;
  return Array.isArray(m) ? m : m ? [m] : [];
}

// ── External store (React) ─────────────────────────────────────────────

export interface ClippingSnapshot {
  state: ClippingState;
  /** panel/tool active (button highlighted, left panel open) */
  active: boolean;
}

const _store = createStore<ClippingSnapshot>({
  state: structuredClone(DEFAULT_CLIPPING_STATE),
  active: false,
});

export function subscribeClipping(listener: () => void): () => void {
  return _store.subscribe(listener);
}

export function getClippingSnapshot(): ClippingSnapshot {
  return _store.getSnapshot();
}

// ── Toolbar button (button-group slot) ─────────────────────────────────

import { useSyncExternalStore, useCallback } from 'react';
import { IconButton, Tooltip } from '@mui/material';
import { ContentCut } from '@mui/icons-material';
import { useViewer } from '../hooks/use-viewer';

function ClipButton(_props: UISlotProps) {
  const viewer = useViewer();
  const snap = useSyncExternalStore(subscribeClipping, getClippingSnapshot);
  const plugin = viewer.getPlugin('clipping') as ClippingPlugin | undefined;

  const handleClick = useCallback(() => {
    plugin?.toggleActive();
  }, [plugin]);

  return (
    <Tooltip title="Section / Clip" placement="right">
      <IconButton
        size="small"
        onClick={handleClick}
        sx={{ color: snap.active ? ACTIVE_COLOR : 'text.secondary' }}
      >
        <ContentCut sx={{ fontSize: 18 }} />
      </IconButton>
    </Tooltip>
  );
}

// ── Plugin ─────────────────────────────────────────────────────────────

export class ClippingPlugin extends RVBehavior {
  readonly id = 'clipping';
  readonly slots: UISlotEntry[] = [
    // Empty visibilityRule => always visible. ButtonPanel hides button-group
    // entries WITHOUT a rule in non-hmi workspace modes (des/planner/editor);
    // an (empty) rule opts the section tool into every mode. fpv/xr hide the
    // whole toolbar and would need a separate UI surface (out of scope).
    { slot: 'button-group', component: ClipButton, order: 65, visibilityRule: {} },
  ];

  // Fixed 3-element array [x, y, z] — length is ALWAYS 3 (no shader recompile
  // on axis toggle). A disabled axis is "pushed away" via a LARGE constant.
  private readonly planes: Plane[] = [new Plane(), new Plane(), new Plane()];
  private bbox: Box3 | null = null;
  private clippedMaterials = new Set<Material>();
  private state: ClippingState = structuredClone(DEFAULT_CLIPPING_STATE);
  private _active = false;
  private _modelHash = '';

  // F9 plane visualization
  private planeViz: Mesh[] | null = null;
  private _center: Vector3 | null = null;

  // ── Lifecycle ──

  protected onStart(result: LoadResult): void {
    const viewer = this.viewer;
    if (!viewer) return;

    // Guard: empty / degenerate bbox → treat as "no bbox" (clipping stays off).
    this.bbox = result.boundingBox && !result.boundingBox.isEmpty()
      ? result.boundingBox.clone()
      : null;

    (viewer.renderer as unknown as { localClippingEnabled: boolean }).localClippingEnabled = true;
    // Optional for lightweight embedders/test hosts that implement only the
    // original RVBehavior viewer surface. The production RVViewer provides it.
    (viewer as { setSectionClippingPlanes?: (planes: Plane[] | null) => void })
      .setSectionClippingPlanes?.(this.planes);

    this._attachClippingPlanes(result.root);

    this._buildPlaneViz();
    this._restoreFromLocalStorage(computeModelHash(result));
    this.applyState();
    this._emitSnapshot();

    // Planner / DES place, duplicate or import geometry AFTER the initial model
    // load. Those subtrees never went through the traversal above, so bind them
    // on demand when the placement pipeline announces new content. Guarded so
    // the lightweight unit-test viewer mock (no event bus) stays happy.
    if (typeof (viewer as { on?: unknown }).on === 'function') {
      // Toon mode replaces MeshStandardMaterial instances. Re-attach after the
      // synchronous material swap; otherwise WebGL renders the uncut model and
      // only the translucent plane visual remains visible.
      this.addCleanup(viewer.on('render-mode-changed', () => {
        this._attachClippingPlanes(result.root);
      }));

      // A model can finish loading while Toon mode is already active. The
      // viewer converts it on `model-loaded`, after plugin onStart hooks ran.
      this.addCleanup(viewer.on('model-loaded', ({ result: loaded }) => {
        if (loaded.root === result.root) this._attachClippingPlanes(result.root);
      }));

      const off = viewer.on('layout-content-added', (data: unknown) => {
        const root = (data as { root?: Object3D } | undefined)?.root;
        if (root) this._attachSubtree(root);
      });
      this.addCleanup(off);
    }
  }

  protected onDestroy(): void {
    const viewer = this.viewer;
    (viewer as { setSectionClippingPlanes?: (planes: Plane[] | null) => void } | undefined)
      ?.setSectionClippingPlanes?.(null);
    for (const mat of this.clippedMaterials) mat.clippingPlanes = null;
    this.clippedMaterials.clear(); // avoid leak across model switches
    this._disposePlaneViz();
    // Only disable local clipping when no TankFillManager is relying on it.
    if (viewer && !viewer.tankFillManager) {
      (viewer.renderer as unknown as { localClippingEnabled: boolean }).localClippingEnabled = false;
    }
    this.bbox = null;
    this._center = null;
    this._active = false;
    this.state = structuredClone(DEFAULT_CLIPPING_STATE);
    this._emitSnapshot();
  }

  // ── Public API ──

  /** Read-only copy of the current clipping state. */
  getState(): ClippingState {
    return structuredClone(this.state);
  }

  get active(): boolean {
    return this._active;
  }

  setAxis(axis: ClipAxis, patch: Partial<ClippingAxisState>): void {
    Object.assign(this.state[axis], patch);
    this.applyState();
    this._persist();
    this._emitSnapshot();
  }

  resetAll(): void {
    this.state = structuredClone(DEFAULT_CLIPPING_STATE);
    this.applyState();
    this._persist();
    this._emitSnapshot();
  }

  /** Toggle the tool: open/close the floating panel + highlight the button. */
  toggleActive(): void {
    this._active = !this._active;
    this._emitSnapshot();
  }

  closePanel(): void {
    if (!this._active) return;
    this._active = false;
    this._emitSnapshot();
  }

  // ── Core geometry update (GC-free, no recompile) ──

  /** Slider drag calls only this → mutates plane.constant / .normal in place. */
  private applyState(): void {
    for (let i = 0; i < 3; i++) {
      const axis = AXES[i];
      const s = this.state[axis];
      const plane = this.planes[i];
      const sign = s.flip ? -1 : 1;
      plane.normal.copy(AXIS_NORMAL[axis]).multiplyScalar(sign);

      if (s.enabled && this.bbox) {
        const worldPos = computeClipPlanePosition(this.bbox, axis, s.position);
        // Visible side: normal·p + constant > 0
        plane.constant = -sign * worldPos;
        this._positionViz(i, axis, worldPos, true);
      } else {
        plane.constant = LARGE; // nothing is clipped (axis "off")
        this._positionViz(i, axis, 0, false);
      }
    }
    this.viewer?.markRenderDirty();
  }

  // ── Late-added geometry (Planner / DES / CAD import) ──

  /** Bind the stable clipping-plane array to every current model material. */
  private _attachClippingPlanes(root: Object3D): void {
    traverseMeshes(root, (mesh) => {
      if (isOverlayMesh(mesh)) return; // tank-fill / gizmos etc.
      for (const mat of materialsOf(mesh)) {
        if (this.clippedMaterials.has(mat)) continue;
        mat.clippingPlanes = this.planes;
        mat.clipShadows = true;
        this.clippedMaterials.add(mat);
      }
    });
    this.viewer?.markRenderDirty();
  }

  /**
   * Bind the clipping planes to a subtree added AFTER the initial model load.
   * Without this the Section tool has no visible effect on Planner/DES-placed
   * assets (their materials keep the default, unclipped `clippingPlanes`). Also
   * grows the bounding box so an initially empty Planner scene gains a valid
   * clip range once the first content is placed. Runs only on discrete
   * placement events, never per frame.
   */
  private _attachSubtree(root: Object3D): void {
    const viewer = this.viewer;
    if (!viewer) return;

    root.updateWorldMatrix(true, true);
    const box = this.bbox ? this.bbox.clone() : new Box3();
    let added = false;

    traverseMeshes(root, (mesh) => {
      if (isOverlayMesh(mesh)) return; // tank-fill / gizmos etc.
      for (const mat of materialsOf(mesh)) {
        if (this.clippedMaterials.has(mat)) continue;
        mat.clippingPlanes = this.planes; // stable reference, length 3
        mat.clipShadows = true;
        this.clippedMaterials.add(mat);
      }
      box.expandByObject(mesh);
      added = true;
    });

    if (!added) return;

    (viewer.renderer as unknown as { localClippingEnabled: boolean }).localClippingEnabled = true;

    // Rebuild the plane-viz + re-apply only when the extents actually grew (or
    // there was no bbox before) — the viz geometry is sized from the bbox.
    if (!this.bbox || !box.equals(this.bbox)) {
      this.bbox = box;
      this._disposePlaneViz();
      this._buildPlaneViz();
      this.applyState();
    } else {
      viewer.markRenderDirty();
    }
  }

  // ── Plane visualization (F9) ──

  private _buildPlaneViz(): void {
    const scene = this.scene;
    if (!scene || !this.bbox) return;

    const size = new Vector3();
    this.bbox.getSize(size);
    this._center = new Vector3();
    this.bbox.getCenter(this._center);

    const margin = 1.15;
    this.planeViz = [];
    for (let i = 0; i < 3; i++) {
      const axis = AXES[i];
      const geo = new PlaneGeometry(1, 1);
      const mat = new MeshBasicMaterial({
        color: AXIS_VIZ_COLOR[i],
        transparent: true,
        opacity: 0.14,
        side: DoubleSide,
        depthWrite: false,
      });
      const mesh = new Mesh(geo, mat);
      mesh.name = `__rvClipPlaneViz_${axis}`;
      mesh.renderOrder = 9000;

      // Orient the plane so its normal aligns with the axis + scale to bbox.
      if (axis === 'x') {
        mesh.rotation.y = Math.PI / 2;
        mesh.scale.set(size.z * margin, size.y * margin, 1);
      } else if (axis === 'y') {
        mesh.rotation.x = -Math.PI / 2;
        mesh.scale.set(size.x * margin, size.z * margin, 1);
      } else {
        mesh.scale.set(size.x * margin, size.y * margin, 1);
      }
      mesh.visible = false;
      markAsOverlay(mesh); // put on HIGHLIGHT_OVERLAY_LAYER → not clipped itself
      scene.add(mesh);
      this.planeViz.push(mesh);
    }
  }

  private _positionViz(index: number, axis: ClipAxis, worldPos: number, visible: boolean): void {
    if (!this.planeViz || !this._center) return;
    const viz = this.planeViz[index];
    if (!viz) return;
    viz.visible = visible;
    if (visible) {
      viz.position.set(this._center.x, this._center.y, this._center.z);
      viz.position[axis] = worldPos;
    }
  }

  private _disposePlaneViz(): void {
    if (!this.planeViz) return;
    for (const viz of this.planeViz) {
      viz.parent?.remove(viz);
      viz.geometry.dispose();
      (viz.material as Material).dispose();
    }
    this.planeViz = null;
  }

  // ── Persistence ──

  private _restoreFromLocalStorage(hash: string): void {
    this._modelHash = hash;
    try {
      const raw = localStorage.getItem(LS_PREFIX + hash);
      if (raw) this.state = deserializeClippingState(raw);
    } catch {
      // corrupt localStorage — keep defaults
    }
  }

  private _persist(): void {
    try {
      localStorage.setItem(LS_PREFIX + this._modelHash, serializeClippingState(this.state));
    } catch (e) {
      if (e instanceof DOMException && e.name === 'QuotaExceededError') {
        console.warn('[ClippingPlugin] localStorage quota exceeded, state not saved');
      }
    }
  }

  // ── Snapshot ──

  private _emitSnapshot(): void {
    _store.set({ state: structuredClone(this.state), active: this._active });
    this.viewer?.markRenderDirty();
  }
}
