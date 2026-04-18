// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DriveGizmoPlugin — Tints drive meshes green while they are in motion.
 *
 * Two modes controlled by `alwaysOn`:
 *   - `false` (default): tints only while drive-chart mode is active
 *   - `true`: tints moving drives permanently, regardless of chart state
 *
 * Clones shared materials per-mesh so only the drive's own geometry is
 * affected. Restores originals when the drive stops or the model is cleared.
 * Transport surface drives (conveyors) are excluded.
 */

import { Color, Mesh, type Material, type Object3D } from 'three';
import type { MeshStandardMaterial } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import type { RVViewer } from '../core/rv-viewer';
import type { RVDrive } from '../core/engine/rv-drive';

const MOVING_EMISSIVE = new Color(0x22cc44);
const MOVING_INTENSITY = 0.6;

interface MeshEntry {
  mesh: Mesh;
  origMaterial: Material | Material[];
  clones: MeshStandardMaterial[];
}

interface DriveEntry {
  drive: RVDrive;
  meshes: MeshEntry[];
  wasMoving: boolean;
}

export interface DriveGizmoOptions {
  /** When true, moving drives are always tinted green regardless of drive chart state. */
  alwaysOn?: boolean;
}

function isStandardMat(m: Material): m is MeshStandardMaterial {
  return 'emissive' in m;
}

/** Collect meshes from a drive subtree and prepare per-mesh clone info. */
function collectMeshes(root: Object3D): MeshEntry[] {
  const result: MeshEntry[] = [];
  root.traverse((child) => {
    if (!(child instanceof Mesh)) return;
    result.push({ mesh: child, origMaterial: child.material, clones: [] });
  });
  return result;
}

/** Clone materials for a mesh and apply green emissive tint. */
function applyTint(entry: MeshEntry): void {
  const mats = Array.isArray(entry.origMaterial) ? entry.origMaterial : [entry.origMaterial];
  const clones: MeshStandardMaterial[] = [];
  const clonedMats: Material[] = [];

  for (const mat of mats) {
    if (isStandardMat(mat)) {
      const clone = mat.clone() as MeshStandardMaterial;
      clone.emissive.copy(MOVING_EMISSIVE);
      clone.emissiveIntensity = MOVING_INTENSITY;
      clones.push(clone);
      clonedMats.push(clone);
    } else {
      clonedMats.push(mat);
    }
  }

  entry.clones = clones;
  entry.mesh.material = Array.isArray(entry.origMaterial) ? clonedMats : clonedMats[0];
}

/** Restore original shared materials and dispose clones. */
function removeTint(entry: MeshEntry): void {
  entry.mesh.material = entry.origMaterial;
  for (const c of entry.clones) c.dispose();
  entry.clones = [];
}

export class DriveGizmoPlugin implements RVViewerPlugin {
  readonly id = 'drive-gizmo';
  readonly order = 250;

  private _entries: DriveEntry[] = [];
  private _viewer: RVViewer | null = null;
  private _chartActive = false;
  private _alwaysOn: boolean;
  private _unsub: (() => void) | null = null;

  constructor(opts?: DriveGizmoOptions) {
    this._alwaysOn = opts?.alwaysOn ?? false;
  }

  private get _shouldTint(): boolean {
    return this._alwaysOn || this._chartActive;
  }

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    this._viewer = viewer;
    this._clearEntries();

    for (const drive of viewer.drives) {
      if (drive.isTransportSurface) continue;
      const meshes = collectMeshes(drive.node);
      if (meshes.length > 0) {
        this._entries.push({ drive, meshes, wasMoving: false });
      }
    }

    // Listen for drive mode open/close
    this._unsub = viewer.on('drive-chart-toggle', (data: { open: boolean }) => {
      this._chartActive = data.open;
      if (!data.open && !this._alwaysOn) {
        this._removeAllTints();
      }
    });
  }

  onFixedUpdatePost(_dt: number): void {
    if (!this._shouldTint) return;
    let dirty = false;
    for (const entry of this._entries) {
      const d = entry.drive;
      const isMoving = d.isRunning || d.jogForward || d.jogBackward;
      if (isMoving === entry.wasMoving) continue;
      entry.wasMoving = isMoving;
      dirty = true;

      for (const me of entry.meshes) {
        if (isMoving) {
          applyTint(me);
        } else {
          removeTint(me);
        }
      }
    }
    if (dirty) this._viewer?.markRenderDirty();
  }

  onModelCleared(): void {
    this._removeAllTints();
    this._clearEntries();
  }

  dispose(): void {
    this._removeAllTints();
    this._clearEntries();
    this._unsub?.();
    this._unsub = null;
    this._viewer = null;
  }

  private _removeAllTints(): void {
    for (const entry of this._entries) {
      if (!entry.wasMoving) continue;
      entry.wasMoving = false;
      for (const me of entry.meshes) removeTint(me);
    }
    this._viewer?.markRenderDirty();
  }

  private _clearEntries(): void {
    for (const entry of this._entries) {
      for (const me of entry.meshes) removeTint(me);
    }
    this._entries = [];
  }
}
