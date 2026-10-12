// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import {
  BufferAttribute, BufferGeometry, Group, Line, LineBasicMaterial, LineDashedMaterial,
} from 'three';
import type { Material } from 'three';

const POINT_COUNT = 64;
const MIN_SPAN = 1e-4;
const TAU = Math.PI * 2;
const materialCache = new Map<string, LineBasicMaterial | LineDashedMaterial>();

export interface ArcGizmoOptions {
  startRad: number;
  endRad: number;
  radius?: number;
  color?: number;
  dashed?: boolean;
  /** Plane normal in the owner's local frame. */
  axis?: 'X' | 'Y' | 'Z';
  /** Descriptive overlay tag used by visibility tooling and tests. */
  kind?: string;
  /** Draw a tangent arrow at the running end of the arc. */
  directionTip?: boolean;
}

export interface ArcGizmo extends Group {
  updateArc(options: ArcGizmoOptions): void;
  disposeArc(): void;
}

export function arcSpan(options: Pick<ArcGizmoOptions, 'startRad' | 'endRad'>): number {
  const raw = Math.abs(options.endRad - options.startRad);
  return Math.max(MIN_SPAN, Math.min(TAU, raw));
}

export function arcPoints(options: ArcGizmoOptions): readonly { x: number; y: number }[] {
  const span = arcSpan(options);
  const direction = options.endRad < options.startRad ? -1 : 1;
  const radius = options.radius ?? 1;
  const points: { x: number; y: number }[] = [];
  for (let i = 0; i < POINT_COUNT; i++) {
    const angle = options.startRad + direction * span * i / (POINT_COUNT - 1);
    points.push({ x: Math.cos(angle) * radius, y: Math.sin(angle) * radius });
  }
  return points;
}

function materialFor(color: number, dashed: boolean): LineBasicMaterial | LineDashedMaterial {
  const key = `${color}:${dashed ? 1 : 0}`;
  let material = materialCache.get(key);
  if (!material) {
    material = dashed
      ? new LineDashedMaterial({ color, dashSize: 0.025, gapSize: 0.015, depthTest: false })
      : new LineBasicMaterial({ color, depthTest: false });
    materialCache.set(key, material);
  }
  return material;
}

function writePoint(array: Float32Array, offset: number, axis: 'X' | 'Y' | 'Z', x: number, y: number): void {
  if (axis === 'X') { array[offset] = 0; array[offset + 1] = x; array[offset + 2] = y; }
  else if (axis === 'Y') { array[offset] = x; array[offset + 1] = 0; array[offset + 2] = y; }
  else { array[offset] = x; array[offset + 1] = y; array[offset + 2] = 0; }
}

/** Creates a non-pickable arc whose fixed buffers are updated in place. */
export function createArcGizmo(initial: ArcGizmoOptions): ArcGizmo {
  const root = new Group() as ArcGizmo;
  const arcGeometry = new BufferGeometry();
  const arcPositions = new Float32Array(POINT_COUNT * 3);
  arcGeometry.setAttribute('position', new BufferAttribute(arcPositions, 3));
  const arc = new Line(arcGeometry, materialFor(initial.color ?? 0xffffff, initial.dashed === true));
  const tipGeometry = new BufferGeometry();
  const tipPositions = new Float32Array(9);
  tipGeometry.setAttribute('position', new BufferAttribute(tipPositions, 3));
  const tip = new Line(tipGeometry, materialFor(initial.color ?? 0xffffff, false));
  arc.raycast = tip.raycast = root.raycast = () => undefined;
  root.add(arc, tip);

  root.updateArc = (options): void => {
    const axis = options.axis ?? 'Z';
    const radius = options.radius ?? 1;
    const span = arcSpan(options);
    const direction = options.endRad < options.startRad ? -1 : 1;
    for (let i = 0; i < POINT_COUNT; i++) {
      const angle = options.startRad + direction * span * i / (POINT_COUNT - 1);
      writePoint(arcPositions, i * 3, axis, Math.cos(angle) * radius, Math.sin(angle) * radius);
    }
    (arcGeometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    arc.material = materialFor(options.color ?? 0xffffff, options.dashed === true);
    if (options.dashed) arc.computeLineDistances();

    const end = options.startRad + direction * span;
    const arrow = Math.max(radius * 0.16, 0.008);
    const back = end - direction * 0.28;
    writePoint(tipPositions, 0, axis, Math.cos(back) * (radius - arrow), Math.sin(back) * (radius - arrow));
    writePoint(tipPositions, 3, axis, Math.cos(end) * radius, Math.sin(end) * radius);
    writePoint(tipPositions, 6, axis, Math.cos(back) * (radius + arrow), Math.sin(back) * (radius + arrow));
    (tipGeometry.getAttribute('position') as BufferAttribute).needsUpdate = true;
    tip.material = materialFor(options.color ?? 0xffffff, false);
    tip.visible = options.directionTip === true;
    root.userData.ribbonPreviewKind = options.kind ?? '';
    root.userData.arcRadius = radius;
    root.userData.arcSpan = span;
    root.userData.arcDashed = options.dashed === true;
  };
  root.disposeArc = (): void => {
    root.removeFromParent();
    arcGeometry.dispose();
    tipGeometry.dispose();
  };
  root.updateArc(initial);
  return root;
}

/** Shared arc materials live for one preview-mode lifetime. */
export function disposeArcGizmoMaterials(): void {
  for (const material of materialCache.values()) (material as Material).dispose();
  materialCache.clear();
}
