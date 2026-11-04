// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * align-overlay.ts — on-top markers of the planner Align tool (plan-779):
 * a hover dot (candidate corner), one dot per picked corner and a dashed
 * line from corner A to its target. Exists only while the tool is open;
 * `dispose()` removes and frees everything.
 *
 * Every object is on the overlay layer (`markAsOverlay`), never depth-tested,
 * never raycastable, and tagged `userData._isAlignOverlay` so `pickDetailed`
 * skips it as a second belt.
 */

import {
  CanvasTexture,
  Group,
  LinearFilter,
  Sprite,
  SpriteMaterial,
  type Object3D,
  type Vector3,
} from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { markAsOverlay } from '../../../core/engine/rv-group-registry';
import type { RVViewer } from '../../../core/rv-viewer';

const COLOR_HOVER = '#ffffff';
const COLOR_A = '#ffa726';
const COLOR_B = '#42a5f5';
const COLOR_LINE = 0xffffff;
/** Ring diameters and stroke in CSS pixels — constant on screen. */
const DOT_PX = 14;
const HOVER_PX = 16;
const STROKE_PX = 2;
const MARKER_OPACITY = 0.8;
const TEX_PX = 64;

export interface AlignOverlay {
  setHover(p: Vector3 | null): void;
  setPreview(cornerA: Vector3 | null, cornerB: Vector3 | null, target: Vector3 | null): void;
  dispose(): void;
}

function noRaycast(o: Object3D): void {
  o.raycast = () => {};
  o.userData._isAlignOverlay = true;
}

/** A ring whose stroke is STROKE_PX wide when the sprite is drawn `diameterPx` wide. */
function makeRingTexture(color: string, diameterPx: number): CanvasTexture {
  const c = document.createElement('canvas');
  c.width = c.height = TEX_PX;
  const g = c.getContext('2d');
  if (g) {
    const stroke = (STROKE_PX * TEX_PX) / diameterPx;
    g.beginPath();
    g.arc(TEX_PX / 2, TEX_PX / 2, TEX_PX / 2 - stroke / 2 - 0.5, 0, Math.PI * 2);
    g.lineWidth = stroke;
    g.strokeStyle = color;
    g.stroke();
  }
  const tex = new CanvasTexture(c);
  tex.minFilter = LinearFilter;
  return tex;
}

/**
 * Ring sprite with a constant on-screen size. With `sizeAttenuation: false`
 * the sprite's NDC height is `scale * P[1][1]` for both camera kinds, so the
 * scale for `px` CSS pixels is `2 * px / (P11 * canvasHeight)`. Set right
 * before drawing (WebGLRenderer computes modelViewMatrix after onBeforeRender),
 * so zoom and resize need no listener.
 */
function makeRing(color: string, diameterPx: number, canvas: HTMLCanvasElement): Sprite {
  const mat = new SpriteMaterial({
    map: makeRingTexture(color, diameterPx),
    depthTest: false,
    depthWrite: false,
    transparent: true,
    opacity: MARKER_OPACITY,
    sizeAttenuation: false,
  });
  const s = new Sprite(mat);
  s.renderOrder = 12;
  s.frustumCulled = false;
  s.visible = false;
  s.onBeforeRender = (_r, _scene, camera) => {
    const p11 = camera.projectionMatrix.elements[5];
    const h = canvas.clientHeight || 1;
    const k = p11 > 0 ? (2 * diameterPx) / (p11 * h) : 0.02;
    s.scale.set(k, k, 1);
    s.updateMatrix();
    if (s.parent) s.matrixWorld.multiplyMatrices(s.parent.matrixWorld, s.matrix);
    else s.matrixWorld.copy(s.matrix);
  };
  noRaycast(s);
  return s;
}

function makeLine(): LineSegments2 {
  const geom = new LineSegmentsGeometry();
  geom.setPositions([0, 0, 0, 0, 0, 1e-3]);
  const mat = new LineMaterial({
    color: COLOR_LINE,
    linewidth: 2,
    dashed: true,
    dashSize: 0.05,
    gapSize: 0.03,
    transparent: true,
    opacity: 0.95,
    depthTest: false,
    depthWrite: false,
  });
  mat.resolution.set(window.innerWidth, window.innerHeight);
  const line = new LineSegments2(geom, mat);
  line.renderOrder = 11;
  line.frustumCulled = false;
  line.visible = false;
  noRaycast(line);
  return line;
}

export function createAlignOverlay(viewer: RVViewer): AlignOverlay {
  const root = new Group();
  root.name = '_alignOverlay';
  noRaycast(root);
  const canvas = viewer.renderer.domElement;
  const hover = makeRing(COLOR_HOVER, HOVER_PX, canvas);
  const dotA = makeRing(COLOR_A, DOT_PX, canvas);
  const dotB = makeRing(COLOR_B, DOT_PX, canvas);
  const line = makeLine();
  root.add(hover, dotA, dotB, line);
  markAsOverlay(root);
  viewer.scene.add(root);
  // Survives a model clear like the planner's own guides; removed in dispose().
  const fixtures = (viewer as unknown as { sceneFixtures?: Set<Object3D> }).sceneFixtures;
  fixtures?.add(root);
  const positions = new Float32Array(6);

  const dirty = (): void => viewer.markRenderDirty();

  return {
    setHover(p) {
      if (p) hover.position.copy(p);
      hover.visible = !!p;
      dirty();
    },
    setPreview(cornerA, cornerB, target) {
      dotA.visible = !!cornerA;
      if (cornerA) dotA.position.copy(cornerA);
      dotB.visible = !!cornerB;
      if (cornerB) dotB.position.copy(cornerB);
      if (cornerA && target && cornerA.distanceToSquared(target) > 1e-12) {
        positions[0] = cornerA.x; positions[1] = cornerA.y; positions[2] = cornerA.z;
        positions[3] = target.x; positions[4] = target.y; positions[5] = target.z;
        line.geometry.setPositions(positions);
        line.computeLineDistances();
        (line.material as LineMaterial).resolution.set(window.innerWidth, window.innerHeight);
        line.visible = true;
      } else {
        line.visible = false;
      }
      dirty();
    },
    dispose() {
      root.removeFromParent();
      fixtures?.delete(root);
      for (const s of [hover, dotA, dotB]) {
        const m = s.material as SpriteMaterial;
        m.map?.dispose();
        m.dispose();
      }
      line.geometry.dispose();
      (line.material as LineMaterial).dispose();
      dirty();
    },
  };
}
