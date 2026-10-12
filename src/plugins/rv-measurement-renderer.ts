// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-measurement-renderer.ts — Three.js rendering for 3D measurements.
 *
 * Creates sphere markers at endpoints, a Line2 connecting line with
 * configurable width, and a CanvasTexture sprite label showing distance.
 * All objects live on layer 7 (MEASUREMENT) to avoid conflicts with
 * drive/sensor/annotation raycasting.
 *
 * Resources are individually tracked for proper disposal on removal or model-clear.
 */

import {
  Group,
  Mesh,
  MeshBasicMaterial,
  SphereGeometry,
  RingGeometry,
  DoubleSide,
  Sprite,
  SpriteMaterial,
  CanvasTexture,
  LinearFilter,
  Vector3,
  Color,
  BufferGeometry,
  LineBasicMaterial,
  Line,
} from 'three';
import type { Camera, Scene } from 'three';
import { Line2 } from 'three/addons/lines/Line2.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { Measurement } from '../core/types/plugin-types';
// Re-export shim — the canonical definition now lives in core/engine/rv-constants
// to avoid the previous core → plugin layer violation. External plugins
// importing `MEASUREMENT_LAYER` from this module continue to work.
import { MEASUREMENT_LAYER } from '../core/engine/rv-constants';
import { LABEL_SUPERSAMPLE, applyLabelSpriteContract, createLabelMaterial, createLabelTexture } from '../core/engine/rv-label-sprite';
export { MEASUREMENT_LAYER } from '../core/engine/rv-constants';

// ── Constants ──────────────────────────────────────────────────────────

/** Distance beyond which label text is hidden. */
const LABEL_HIDE_DISTANCE = 40;

/** Marker sphere radius in scene units (1 unit = 1 meter). */
const MARKER_RADIUS = 0.005;

/** Ring outer radius for surface indicators. */
const RING_OUTER_RADIUS = 0.018;
const RING_INNER_RADIUS = RING_OUTER_RADIUS * 0.5;

/** Line width in pixels (Line2 cross-platform). */
const LINE_WIDTH_PX = 3;

/** Render order for measurement objects (above geometry, below UI). */
const RENDER_ORDER = 11;

// ── Shared geometry (reused across all measurements) ──────────────────

let _sharedSphereGeom: SphereGeometry | null = null;
let _sharedRingGeom: RingGeometry | null = null;

export function getSharedSphereGeometry(): SphereGeometry {
  if (!_sharedSphereGeom) _sharedSphereGeom = new SphereGeometry(MARKER_RADIUS, 12, 8);
  return _sharedSphereGeom;
}

function getSharedRingGeometry(): RingGeometry {
  if (!_sharedRingGeom) _sharedRingGeom = new RingGeometry(RING_INNER_RADIUS, RING_OUTER_RADIUS, 32);
  return _sharedRingGeom;
}

/** Measurement display unit. */
export type MeasurementUnit = 'auto' | 'mm' | 'm';

// ── Per-measurement resource tracking ────────────────────────────────

export interface MeasurementResources {
  markerA: Mesh;
  markerB: Mesh;
  ringA: Mesh;
  ringB: Mesh;
  line: Line2 | Line;
  label: Sprite;
  labelTexture: CanvasTexture;
  labelMaterial: SpriteMaterial;
  markerMaterialA: MeshBasicMaterial;
  markerMaterialB: MeshBasicMaterial;
  ringMaterialA: MeshBasicMaterial;
  ringMaterialB: MeshBasicMaterial;
  lineMaterial: LineMaterial | LineBasicMaterial;
  lineGeometry: LineGeometry | BufferGeometry;
  isLine2: boolean;
  labelAspect: number;
}

// ── Preview line resources ──────────────────────────────────────────────

interface PreviewResources {
  line: Line2 | Line;
  lineMaterial: LineMaterial | LineBasicMaterial;
  lineGeometry: LineGeometry | BufferGeometry;
  isLine2: boolean;
}

// ── MeasurementRenderer ──────────────────────────────────────────────

export class MeasurementRenderer {
  readonly group = new Group();
  private _resources = new Map<string, MeasurementResources>();
  private _camera: Camera | null = null;
  private _renderer: { domElement: HTMLCanvasElement } | null = null;
  private _preview: PreviewResources | null = null;
  private _useLine2 = true;
  unit: MeasurementUnit = 'auto';
  /** Display scale factor for all measurement visuals (0.5 = half, 2.0 = double). */
  displayScale = 1.0;

  constructor() {
    this.group.name = '__rv_measurements';
  }

  /** Attach to a scene. */
  attach(scene: Scene): void {
    scene.add(this.group);
  }

  /** Set camera for LOD calculations. */
  setCamera(camera: Camera): void {
    this._camera = camera;
  }

  /** Set renderer for LineMaterial resolution updates. */
  setRenderer(renderer: { domElement: HTMLCanvasElement }): void {
    this._renderer = renderer;
  }

  /** Set display unit for all labels. */
  setUnit(u: MeasurementUnit): void {
    this.unit = u;
  }

  /** Set display scale for all measurement visuals. */
  setDisplayScale(s: number): void {
    this.displayScale = s;
  }

  /** Create visual objects for a measurement. */
  addMeasurement(m: Measurement): void {
    if (this._resources.has(m.id)) return;

    const color = new Color(m.color);
    const pA = m.pointA;
    const pB = m.pointB;

    // Marker A — larger sphere + ring for start-point identification
    const markerMaterialA = new MeshBasicMaterial({ color, depthTest: false });
    const markerA = new Mesh(getSharedSphereGeometry(), markerMaterialA);
    markerA.position.set(pA[0], pA[1], pA[2]);
    markerA.layers.set(MEASUREMENT_LAYER);
    markerA.renderOrder = RENDER_ORDER;
    this.group.add(markerA);

    // Ring around start point (oriented to surface normal)
    const ringMaterialA = new MeshBasicMaterial({ color, depthTest: false, side: DoubleSide, transparent: true, opacity: 0.6 });
    const ringA = new Mesh(getSharedRingGeometry(), ringMaterialA);
    ringA.position.set(pA[0], pA[1], pA[2]);
    ringA.layers.set(MEASUREMENT_LAYER);
    ringA.renderOrder = RENDER_ORDER;
    // Orient to normalA if available
    if (m.normalA) {
      const target = new Vector3(pA[0] + m.normalA[0], pA[1] + m.normalA[1], pA[2] + m.normalA[2]);
      ringA.lookAt(target);
    }
    this.group.add(ringA);

    // Marker B — same dot + ring style as A
    const markerMaterialB = new MeshBasicMaterial({ color, depthTest: false });
    const markerB = new Mesh(getSharedSphereGeometry(), markerMaterialB);
    markerB.position.set(pB[0], pB[1], pB[2]);
    markerB.layers.set(MEASUREMENT_LAYER);
    markerB.renderOrder = RENDER_ORDER;
    this.group.add(markerB);

    // Ring around end point (oriented to normal if available)
    const ringMaterialB = new MeshBasicMaterial({ color, depthTest: false, side: DoubleSide, transparent: true, opacity: 0.6 });
    const ringB = new Mesh(getSharedRingGeometry(), ringMaterialB);
    ringB.position.set(pB[0], pB[1], pB[2]);
    ringB.layers.set(MEASUREMENT_LAYER);
    ringB.renderOrder = RENDER_ORDER;
    // Orient to normalB if available
    if (m.normalB) {
      const target = new Vector3(pB[0] + m.normalB[0], pB[1] + m.normalB[1], pB[2] + m.normalB[2]);
      ringB.lookAt(target);
    }
    this.group.add(ringB);

    // Connecting line
    const { line, lineMaterial, lineGeometry, isLine2 } = this._createLine(pA, pB, color);
    this.group.add(line);

    // Distance label sprite at midpoint
    const { texture, material: labelMaterial, aspect } = this._createLabelSprite(m.distance, m.color);
    const label = new Sprite(labelMaterial);
    const mid = [(pA[0] + pB[0]) / 2, (pA[1] + pB[1]) / 2, (pA[2] + pB[2]) / 2];
    label.position.set(mid[0], mid[1], mid[2]);
    const labelH = 0.08;
    label.scale.set(labelH * aspect, labelH, 1);
    applyLabelSpriteContract(label, { layer: MEASUREMENT_LAYER, renderOrder: RENDER_ORDER });
    this.group.add(label);

    this._resources.set(m.id, {
      markerA, markerB, ringA, ringB, line, label,
      labelTexture: texture, labelMaterial,
      markerMaterialA, markerMaterialB, ringMaterialA, ringMaterialB,
      lineMaterial, lineGeometry, isLine2, labelAspect: aspect,
    });
  }

  /** Remove a measurement's visual objects and dispose resources. */
  removeMeasurement(id: string): void {
    const res = this._resources.get(id);
    if (!res) return;

    this.group.remove(res.markerA);
    this.group.remove(res.markerB);
    this.group.remove(res.ringA);
    this.group.remove(res.ringB);
    this.group.remove(res.line);
    this.group.remove(res.label);

    // Dispose per-measurement resources (NOT shared geometry)
    res.labelTexture.dispose();
    res.labelMaterial.dispose();
    res.markerMaterialA.dispose();
    res.markerMaterialB.dispose();
    res.ringMaterialA.dispose();
    res.ringMaterialB.dispose();
    res.lineMaterial.dispose();
    res.lineGeometry.dispose();

    this._resources.delete(id);
  }

  /** Update visual properties of a measurement. */
  updateMeasurement(m: Measurement): void {
    const res = this._resources.get(m.id);
    if (!res) return;

    const color = new Color(m.color);
    res.markerMaterialA.color.copy(color);
    res.markerMaterialB.color.copy(color);
    res.ringMaterialA.color.copy(color);
    res.ringMaterialB.color.copy(color);
    if (res.lineMaterial instanceof LineMaterial) {
      res.lineMaterial.color.copy(color);
    } else {
      (res.lineMaterial as LineBasicMaterial).color.copy(color);
    }

    // Update visibility
    res.markerA.visible = m.visible;
    res.markerB.visible = m.visible;
    res.ringA.visible = m.visible;
    res.ringB.visible = m.visible;
    res.line.visible = m.visible;
    res.label.visible = m.visible;

    // Recreate label texture
    res.labelTexture.dispose();
    res.labelMaterial.dispose();
    const { texture, material, aspect } = this._createLabelSprite(m.distance, m.color);
    res.label.material = material;
    res.labelTexture = texture;
    res.labelMaterial = material;
    res.labelAspect = aspect;
  }

  // ── Start marker preview (shown while picking second point) ──────────

  private _startPreviewMarker: Mesh | null = null;
  private _startPreviewRing: Mesh | null = null;
  private _startPreviewMarkerMat: MeshBasicMaterial | null = null;
  private _startPreviewRingMat: MeshBasicMaterial | null = null;

  /** Show a temporary start-point marker during picking. */
  showStartMarker(pos: [number, number, number], hexColor: string, normal?: [number, number, number] | null): void {
    this.clearStartMarker();
    const color = new Color(hexColor);

    this._startPreviewMarkerMat = new MeshBasicMaterial({ color, depthTest: false });
    this._startPreviewMarker = new Mesh(getSharedSphereGeometry(), this._startPreviewMarkerMat);
    this._startPreviewMarker.position.set(pos[0], pos[1], pos[2]);
    this._startPreviewMarker.layers.set(MEASUREMENT_LAYER);
    this._startPreviewMarker.renderOrder = RENDER_ORDER;
    this.group.add(this._startPreviewMarker);

    this._startPreviewRingMat = new MeshBasicMaterial({ color, depthTest: false, side: DoubleSide, transparent: true, opacity: 0.85 });
    this._startPreviewRing = new Mesh(getSharedRingGeometry(), this._startPreviewRingMat);
    this._startPreviewRing.position.set(pos[0], pos[1], pos[2]);
    this._startPreviewRing.layers.set(MEASUREMENT_LAYER);
    this._startPreviewRing.renderOrder = RENDER_ORDER;
    if (normal) {
      const target = new Vector3(pos[0] + normal[0], pos[1] + normal[1], pos[2] + normal[2]);
      this._startPreviewRing.lookAt(target);
    }
    this.group.add(this._startPreviewRing);
  }

  /** Remove the temporary start-point marker. */
  clearStartMarker(): void {
    if (this._startPreviewMarker) {
      this.group.remove(this._startPreviewMarker);
      this._startPreviewMarkerMat?.dispose();
      this._startPreviewMarker = null;
      this._startPreviewMarkerMat = null;
    }
    if (this._startPreviewRing) {
      this.group.remove(this._startPreviewRing);
      this._startPreviewRingMat?.dispose();
      this._startPreviewRing = null;
      this._startPreviewRingMat = null;
    }
  }

  // ── Cursor indicator (ring + dot on surface) ──────────────────────────

  private _cursorDot: Mesh | null = null;
  private _cursorRing: Mesh | null = null;
  private _cursorDotMat: MeshBasicMaterial | null = null;
  private _cursorRingMat: MeshBasicMaterial | null = null;
  private _cursorNormal = new Vector3(0, 1, 0);
  private _cursorTarget = new Vector3();

  /** Show surface indicator at raycast hit position, oriented to normal. */
  showCursorDot(pos: [number, number, number], hexColor: string, normal?: [number, number, number] | null): void {
    const color = new Color(hexColor);

    // Small center dot
    if (!this._cursorDot) {
      this._cursorDotMat = new MeshBasicMaterial({ color, depthTest: false });
      this._cursorDot = new Mesh(getSharedSphereGeometry(), this._cursorDotMat);
      this._cursorDot.layers.set(MEASUREMENT_LAYER);
      this._cursorDot.renderOrder = RENDER_ORDER + 1;
      this.group.add(this._cursorDot);
    }
    this._cursorDot.position.set(pos[0], pos[1], pos[2]);
    this._cursorDot.visible = true;

    // Flat ring oriented to surface normal
    if (!this._cursorRing) {
      this._cursorRingMat = new MeshBasicMaterial({ color, depthTest: false, side: DoubleSide, transparent: true, opacity: 0.8 });
      this._cursorRing = new Mesh(getSharedRingGeometry(), this._cursorRingMat);
      this._cursorRing.layers.set(MEASUREMENT_LAYER);
      this._cursorRing.renderOrder = RENDER_ORDER + 1;
      this.group.add(this._cursorRing);
    }
    this._cursorRing.position.set(pos[0], pos[1], pos[2]);
    this._cursorRing.visible = true;

    // Orient ring to surface normal (flat on surface)
    if (normal) {
      this._cursorNormal.set(normal[0], normal[1], normal[2]);
      this._cursorTarget.set(pos[0] + normal[0], pos[1] + normal[1], pos[2] + normal[2]);
      this._cursorRing.lookAt(this._cursorTarget);
    }
  }

  /** Hide the cursor indicator. */
  hideCursorDot(): void {
    if (this._cursorDot) this._cursorDot.visible = false;
    if (this._cursorRing) this._cursorRing.visible = false;
  }

  /** Dispose cursor indicator resources. */
  private _disposeCursorDot(): void {
    if (this._cursorDot) {
      this.group.remove(this._cursorDot);
      this._cursorDotMat?.dispose();
      this._cursorDot = null;
      this._cursorDotMat = null;
    }
    if (this._cursorRing) {
      this.group.remove(this._cursorRing);
      this._cursorRingMat?.dispose();
      this._cursorRing = null;
      this._cursorRingMat = null;
    }
  }

  // ── Projected point (axis-lock destination indicator) ─────────────────

  private _projectedDot: Mesh | null = null;
  private _projectedDotMat: MeshBasicMaterial | null = null;

  /** Show projected destination point (during axis-lock measurement). */
  showProjectedPoint(pos: [number, number, number], hexColor: string): void {
    if (!this._projectedDot) {
      this._projectedDotMat = new MeshBasicMaterial({ color: new Color(hexColor), depthTest: false, transparent: true, opacity: 0.9 });
      this._projectedDot = new Mesh(getSharedSphereGeometry(), this._projectedDotMat);
      this._projectedDot.layers.set(MEASUREMENT_LAYER);
      this._projectedDot.renderOrder = RENDER_ORDER + 1;
      this._projectedDot.scale.setScalar(1.5); // slightly larger than cursor dot
      this.group.add(this._projectedDot);
    }
    this._projectedDot.position.set(pos[0], pos[1], pos[2]);
    this._projectedDot.visible = true;
  }

  /** Hide projected destination point. */
  hideProjectedPoint(): void {
    if (this._projectedDot) this._projectedDot.visible = false;
  }

  private _disposeProjectedPoint(): void {
    if (this._projectedDot) {
      this.group.remove(this._projectedDot);
      this._projectedDotMat?.dispose();
      this._projectedDot = null;
      this._projectedDotMat = null;
    }
  }

  /** Show/hide the preview line from pointA to the current cursor position. */
  updatePreview(pointA: [number, number, number], cursorPoint: [number, number, number], hexColor: string): void {
    if (!this._preview) {
      const color = new Color(hexColor);
      const { line, lineMaterial, lineGeometry, isLine2 } = this._createLine(pointA, cursorPoint, color, true);
      this.group.add(line);
      this._preview = { line, lineMaterial, lineGeometry, isLine2 };
    } else {
      // Update positions
      if (this._preview.isLine2) {
        const geom = this._preview.lineGeometry as LineGeometry;
        geom.setPositions([pointA[0], pointA[1], pointA[2], cursorPoint[0], cursorPoint[1], cursorPoint[2]]);
      } else {
        const geom = this._preview.lineGeometry as BufferGeometry;
        geom.setFromPoints([
          new Vector3(pointA[0], pointA[1], pointA[2]),
          new Vector3(cursorPoint[0], cursorPoint[1], cursorPoint[2]),
        ]);
      }
    }
  }

  /** Remove the preview line. */
  clearPreview(): void {
    if (!this._preview) return;
    this.group.remove(this._preview.line);
    this._preview.lineMaterial.dispose();
    this._preview.lineGeometry.dispose();
    this._preview = null;
  }

  /** Per-frame update: keep labels at constant screen size. */
  updateLOD(): void {
    if (!this._camera) return;

    const camPos = this._camera.position;
    const SCREEN_SCALE = 0.12;

    const _tmpMid = new Vector3();
    for (const [, res] of this._resources) {
      _tmpMid.set(
        (res.markerA.position.x + res.markerB.position.x) / 2,
        (res.markerA.position.y + res.markerB.position.y) / 2,
        (res.markerA.position.z + res.markerB.position.z) / 2,
      );
      const dist = camPos.distanceTo(_tmpMid);

      if (dist > LABEL_HIDE_DISTANCE) {
        res.label.visible = false;
      } else if (res.markerA.visible) {
        res.label.visible = true;
        const labelH = dist * SCREEN_SCALE * 0.25 * this.displayScale;
        res.label.scale.set(labelH * res.labelAspect, labelH, 1);
      }

      // Rings are oriented to surface normal at creation time — no billboard needed
    }

    // Cursor dot stays at scale 1 — must stick to surface
    // (no distance-based scaling)

    // Start-preview ring is oriented to surface normal at creation time

    // Update LineMaterial resolution for all Line2 instances
    this._updateLineResolution();
  }

  /** Dispose ALL resources (model-clear). */
  disposeAll(): void {
    for (const [id] of this._resources) {
      this.removeMeasurement(id);
    }
    this.clearPreview();
    this.clearStartMarker();
    this._disposeCursorDot();
    this._disposeProjectedPoint();
  }

  // ── Internal helpers ─────────────────────────────────────────────────

  private _createLine(
    pA: [number, number, number],
    pB: [number, number, number],
    color: Color,
    isPreview = false,
  ): { line: Line2 | Line; lineMaterial: LineMaterial | LineBasicMaterial; lineGeometry: LineGeometry | BufferGeometry; isLine2: boolean } {
    if (this._useLine2) {
      try {
        const lineGeometry = new LineGeometry();
        lineGeometry.setPositions([pA[0], pA[1], pA[2], pB[0], pB[1], pB[2]]);

        const canvas = this._renderer?.domElement;
        const w = canvas?.clientWidth ?? window.innerWidth;
        const h = canvas?.clientHeight ?? window.innerHeight;

        const lineMaterial = new LineMaterial({
          color: color.getHex(),
          linewidth: LINE_WIDTH_PX,
          transparent: isPreview,
          opacity: isPreview ? 0.5 : 1.0,
          depthTest: false,
          resolution: { x: w, y: h } as any,
        });
        lineMaterial.resolution.set(w, h);

        const line = new Line2(lineGeometry, lineMaterial);
        line.computeLineDistances();
        line.layers.set(MEASUREMENT_LAYER);
        line.renderOrder = RENDER_ORDER;

        return { line, lineMaterial, lineGeometry, isLine2: true };
      } catch {
        // Fallback to basic line
        this._useLine2 = false;
      }
    }

    // Fallback: basic Line (linewidth=1 only)
    const lineGeometry = new BufferGeometry().setFromPoints([
      new Vector3(pA[0], pA[1], pA[2]),
      new Vector3(pB[0], pB[1], pB[2]),
    ]);
    const lineMaterial = new LineBasicMaterial({
      color,
      transparent: isPreview,
      opacity: isPreview ? 0.5 : 1.0,
      depthTest: false,
    });
    const line = new Line(lineGeometry, lineMaterial);
    line.layers.set(MEASUREMENT_LAYER);
    line.renderOrder = RENDER_ORDER;

    return { line, lineMaterial, lineGeometry, isLine2: false };
  }

  private _updateLineResolution(): void {
    if (!this._renderer) return;
    const canvas = this._renderer.domElement;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;

    for (const [, res] of this._resources) {
      if (res.isLine2 && res.lineMaterial instanceof LineMaterial) {
        res.lineMaterial.resolution.set(w, h);
      }
    }
    if (this._preview?.isLine2 && this._preview.lineMaterial instanceof LineMaterial) {
      this._preview.lineMaterial.resolution.set(w, h);
    }
  }

  private _createLabelSprite(distance: number, hexColor: string): { texture: CanvasTexture; material: SpriteMaterial; aspect: number } {
    const text = formatDistance(distance, this.unit);

    // Fixed power-of-2 canvas to avoid mipmap artifacts
    const w = 256;
    const h = 64;
    const border = 3;
    const radius = 8;

    const canvas = document.createElement('canvas');
    canvas.width = w * LABEL_SUPERSAMPLE;
    canvas.height = h * LABEL_SUPERSAMPLE;
    const ctx = canvas.getContext('2d')!;
    // Draw in logical (w × h) coordinates on the supersampled canvas.
    ctx.scale(LABEL_SUPERSAMPLE, LABEL_SUPERSAMPLE);

    // Clear to fully transparent first
    ctx.clearRect(0, 0, w, h);

    // Measure text to draw tight box centered on canvas
    ctx.font = 'bold 32px sans-serif';
    const textWidth = ctx.measureText(text).width;
    const boxPad = 16;
    const boxW = Math.min(textWidth + boxPad * 2 + border * 2, w);
    const boxH = h - 4;
    const boxX = (w - boxW) / 2;
    const boxY = (h - boxH) / 2;

    // Colored border (rounded rect)
    ctx.fillStyle = hexColor;
    ctx.beginPath();
    ctx.moveTo(boxX + radius, boxY);
    ctx.lineTo(boxX + boxW - radius, boxY);
    ctx.quadraticCurveTo(boxX + boxW, boxY, boxX + boxW, boxY + radius);
    ctx.lineTo(boxX + boxW, boxY + boxH - radius);
    ctx.quadraticCurveTo(boxX + boxW, boxY + boxH, boxX + boxW - radius, boxY + boxH);
    ctx.lineTo(boxX + radius, boxY + boxH);
    ctx.quadraticCurveTo(boxX, boxY + boxH, boxX, boxY + boxH - radius);
    ctx.lineTo(boxX, boxY + radius);
    ctx.quadraticCurveTo(boxX, boxY, boxX + radius, boxY);
    ctx.closePath();
    ctx.fill();

    // Dark background inside
    ctx.fillStyle = 'rgba(0, 0, 0, 0.85)';
    ctx.beginPath();
    ctx.moveTo(boxX + radius, boxY + border);
    ctx.lineTo(boxX + boxW - radius, boxY + border);
    ctx.quadraticCurveTo(boxX + boxW - border, boxY + border, boxX + boxW - border, boxY + radius);
    ctx.lineTo(boxX + boxW - border, boxY + boxH - radius);
    ctx.quadraticCurveTo(boxX + boxW - border, boxY + boxH - border, boxX + boxW - radius, boxY + boxH - border);
    ctx.lineTo(boxX + radius, boxY + boxH - border);
    ctx.quadraticCurveTo(boxX + border, boxY + boxH - border, boxX + border, boxY + boxH - radius);
    ctx.lineTo(boxX + border, boxY + radius);
    ctx.quadraticCurveTo(boxX + border, boxY + border, boxX + radius, boxY + border);
    ctx.closePath();
    ctx.fill();

    // Distance text
    ctx.fillStyle = '#ffffff';
    ctx.font = 'bold 32px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, w / 2, h / 2);

    // Shared label contract (rv-label-sprite.ts): sRGB, anisotropy, no tone
    // mapping, no depth. 'linear' filtering — the LOD scaler keeps these at
    // screen size, so mipmaps would only blur.
    const texture = createLabelTexture(canvas, 'linear');
    texture.premultiplyAlpha = false;
    const material = createLabelMaterial(texture);

    // Use full canvas aspect (256/64 = 4) — the box is centered within
    return { texture, material, aspect: w / h };
  }
}

// ── Utility ─────────────────────────────────────────────────────────────

/** Format a distance in meters to a human-readable string. */
export function formatDistance(distance: number, unit: MeasurementUnit = 'auto'): string {
  if (unit === 'mm') {
    return `${Math.round(distance * 1000)} mm`;
  }
  if (unit === 'm') {
    return `${distance.toFixed(3)} m`;
  }
  // auto: mm when < 1m, m when >= 1m
  if (distance < 1) {
    return `${Math.round(distance * 1000)} mm`;
  }
  return `${distance.toFixed(2)} m`;
}
