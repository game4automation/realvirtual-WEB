// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TankFillManager — 3D fill-level overlay + surface line for tanks.
 *
 * Per tank, two meshes sharing the same geometry (no cloning):
 * 1. Fill overlay — MeshBasicMaterial, one clip plane (above fillY), polygonOffset
 * 2. Surface line — MeshBasicMaterial, two clip planes (thin band at fillY), depthTest:false
 */

import {
  Object3D,
  Mesh,
  MeshBasicMaterial,
  Plane,
  Vector3,
  Box3,
  FrontSide,
  type Material,
} from 'three';

// ─── Config ─────────────────────────────────────────────────────────────

const LIQUID_COLORS: Record<string, { fill: number; line: number; opacity: number }> = {
  water:    { fill: 0x2266cc, line: 0x66ccff, opacity: 0.45 },
  oil:      { fill: 0x8B6914, line: 0xC09030, opacity: 0.5 },
  chemical: { fill: 0x228B22, line: 0x44DD44, opacity: 0.4 },
};
const DEFAULT_LIQUID = { fill: 0x2266cc, line: 0x66ccff, opacity: 0.45 };

/** Surface line band as fraction of vessel height. */
const LINE_FRACTION = 0.02;

// ─── Types ──────────────────────────────────────────────────────────────

interface TankFillEntry {
  node: Object3D;
  overlay: Mesh;
  line: Mesh;
  /** Clips above fillY (fill overlay). */
  clipAbove: Plane;
  /** Clips below fillY (surface line bottom). */
  clipBelow: Plane;
  /** Clips above fillY + band (surface line top). */
  clipTop: Plane;
  bboxMinY: number;
  bboxMaxY: number;
  bandSize: number;
  lastFraction: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────

function findVesselMesh(tankNode: Object3D): Mesh | null {
  let best: Mesh | null = null;
  let bestVolume = 0;
  const tmpBox = new Box3();
  const tmpSize = new Vector3();

  tankNode.traverse((child) => {
    if (!(child as Mesh).isMesh) return;
    if (child.userData._tankFillViz) return;
    const mesh = child as Mesh;
    if (!mesh.geometry?.attributes?.position) return;

    tmpBox.setFromObject(mesh);
    tmpBox.getSize(tmpSize);
    const vol = tmpSize.x * tmpSize.y * tmpSize.z;
    if (vol > bestVolume) {
      bestVolume = vol;
      best = mesh;
    }
  });

  return best;
}

function getLiquidPreset(resourceName: string) {
  const key = resourceName.toLowerCase().trim();
  return LIQUID_COLORS[key] ?? DEFAULT_LIQUID;
}

// ─── TankFillManager ────────────────────────────────────────────────────

export class TankFillManager {
  readonly entries: TankFillEntry[] = [];

  constructor(tankNodes: Object3D[], renderer: { localClippingEnabled?: boolean }) {
    if ('localClippingEnabled' in renderer) {
      renderer.localClippingEnabled = true;
    }

    for (const node of tankNodes) {
      this._createFill(node);
    }

    if (this.entries.length > 0) {
      console.log(`[TankFill] Created fill overlay for ${this.entries.length} tanks`);
    }
  }

  update(): boolean {
    let dirty = false;
    for (const entry of this.entries) {
      const rv = entry.node.userData._rvTank as
        { capacity: number; amount: number } | undefined;
      if (!rv) continue;

      const fraction = rv.capacity > 0
        ? Math.max(0, Math.min(1, rv.amount / rv.capacity))
        : 0;

      if (Math.abs(fraction - entry.lastFraction) < 0.0005) continue;
      entry.lastFraction = fraction;
      dirty = true;

      const fillY = entry.bboxMinY + fraction * (entry.bboxMaxY - entry.bboxMinY);
      const visible = fraction > 0.001;
      const full = fraction >= 0.99;

      // Fill overlay: when full, disable clipping entirely (no edge = no z-fight)
      const overlayMat = entry.overlay.material as MeshBasicMaterial;
      if (full) {
        overlayMat.clippingPlanes = [];
      } else {
        entry.clipAbove.constant = fillY;
        overlayMat.clippingPlanes = [entry.clipAbove];
      }
      entry.overlay.visible = visible;

      // Surface line: hide when full
      entry.clipBelow.constant = -fillY;
      entry.clipTop.constant = fillY + entry.bandSize;
      entry.line.visible = visible && !full;
    }
    return dirty;
  }

  dispose(): void {
    for (const entry of this.entries) {
      for (const m of [entry.overlay, entry.line]) {
        m.parent?.remove(m);
        (m.material as Material).dispose();
      }
    }
    this.entries.length = 0;
  }

  private _createFill(tankNode: Object3D): void {
    const vesselMesh = findVesselMesh(tankNode);
    if (!vesselMesh) return;

    const vesselBox = new Box3().setFromObject(vesselMesh);
    const vesselSize = new Vector3();
    vesselBox.getSize(vesselSize);
    if (vesselSize.y < 0.001) return;

    const rv = tankNode.userData._rvTank as { resourceName?: string } | undefined;
    const preset = getLiquidPreset(rv?.resourceName ?? '');
    const parent = vesselMesh.parent ?? tankNode;
    const geo = vesselMesh.geometry;
    const bandSize = vesselSize.y * LINE_FRACTION;

    // ── Clip planes ──
    const clipAbove = new Plane(new Vector3(0, -1, 0), vesselBox.min.y);
    const clipBelow = new Plane(new Vector3(0, 1, 0), -vesselBox.min.y);
    const clipTop = new Plane(new Vector3(0, -1, 0), vesselBox.min.y + bandSize);

    // ── Fill overlay ──
    const fillMat = new MeshBasicMaterial({
      color: preset.fill,
      transparent: true,
      opacity: preset.opacity,
      side: FrontSide,
      depthTest: true,
      depthWrite: false,
      clippingPlanes: [clipAbove],
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -4,
    });

    const overlay = new Mesh(geo, fillMat);
    overlay.name = `${vesselMesh.name}_fillOverlay`;
    overlay.userData._tankFillViz = true;
    overlay.renderOrder = 1;
    overlay.position.copy(vesselMesh.position);
    overlay.quaternion.copy(vesselMesh.quaternion);
    overlay.scale.copy(vesselMesh.scale);
    parent.add(overlay);

    // ── Surface line ──
    const lineMat = new MeshBasicMaterial({
      color: preset.line,
      transparent: true,
      opacity: 0.9,
      side: FrontSide,
      depthTest: true,
      depthWrite: false,
      clippingPlanes: [clipBelow, clipTop],
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -8,
    });

    const line = new Mesh(geo, lineMat);
    line.name = `${vesselMesh.name}_fillLine`;
    line.userData._tankFillViz = true;
    line.renderOrder = 2;
    line.position.copy(vesselMesh.position);
    line.quaternion.copy(vesselMesh.quaternion);
    line.scale.copy(vesselMesh.scale);
    parent.add(line);

    overlay.visible = false;
    line.visible = false;

    this.entries.push({
      node: tankNode,
      overlay,
      line,
      clipAbove,
      clipBelow,
      clipTop,
      bboxMinY: vesselBox.min.y,
      bboxMaxY: vesselBox.max.y,
      bandSize,
      lastFraction: -1,
    });
  }
}
