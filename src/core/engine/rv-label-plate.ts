// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-label-plate.ts — a text label as a fixed sign in world space (plan-529).
 *
 * THE SANCTIONED EXCEPTION TO THE LABEL-SPRITE CONTRACT. `rv-label-sprite.ts` is
 * the one way to put canvas text into the scene, and its contract says: overlay
 * layer, `depthTest:false`, `depthWrite:false`. A `WebLabel` in `Plate` mode is
 * the opposite on purpose — a sign screwed onto the machine, which geometry in
 * front of it must hide. So the plate is:
 *
 *   - a `Mesh` (never a `Sprite` — `labelContractViolations()` only inspects
 *     canvas-textured SPRITES, which is exactly what keeps this exemption
 *     narrow; `tests/label-sprite-contract.test.ts` pins that a plate is not
 *     reported and a billboard still passes),
 *   - on layer 0, depth-tested and depth-writing, so it goes through the normal
 *     composer like any part,
 *   - flagged `userData._rvLabelPlate` (and `_rvWebLabel`, which the GLB
 *     exporter prunes — the plate is rebuilt from the `WebLabel` extras on every
 *     load and must never be saved as geometry).
 *
 * The texture still comes from `createLabelTexture()` (sRGB, anisotropy,
 * mipmaps — the sampling half of the contract applies to plates too).
 *
 * Post-processing: `toneMapped:false` is a no-op through the composer, and a
 * white glyph would cross the default bloom threshold (0.85). The material
 * colour therefore scales the texture to {@link LABEL_PLATE_BRIGHTNESS}, which
 * keeps even pure white text below the threshold. GTAO darkening at the
 * contact edge is avoided by the {@link LABEL_PLATE_STANDOFF_M} gap.
 *
 * Geometry: a `PlaneGeometry` in the node-local XY plane, facing local +Z.
 * 1 world unit = 1 m.
 */

import {
  FrontSide,
  Mesh,
  MeshBasicMaterial,
  PlaneGeometry,
  type CanvasTexture,
} from 'three';
import { createLabelTexture } from './rv-label-sprite';

/** Gap between the plate and the node plane along local +Z, in metres (2 mm). */
export const LABEL_PLATE_STANDOFF_M = 0.002;

/** Material colour multiplier — keeps white text below the default bloom threshold. */
export const LABEL_PLATE_BRIGHTNESS = 0.82;

/** Everything a plate owns; the caller disposes through {@link disposeLabelPlate}. */
export interface LabelPlateHandles {
  mesh: Mesh;
  geometry: PlaneGeometry;
  material: MeshBasicMaterial;
  texture: CanvasTexture;
  /** Plate width in metres. */
  widthM: number;
  /** Plate height in metres. */
  heightM: number;
}

/**
 * Build a plate mesh of `widthM × heightM` metres showing `canvas`. The mesh is
 * NOT positioned — the caller places it (offset + standoff) and parents it.
 */
export function buildLabelPlate(canvas: HTMLCanvasElement, widthM: number, heightM: number): LabelPlateHandles {
  const texture = createLabelTexture(canvas, 'mipmap');
  const material = new MeshBasicMaterial({
    map: texture,
    transparent: true,
    alphaTest: 0.01,
    depthTest: true,
    depthWrite: true,
    toneMapped: false,
    side: FrontSide,
  });
  material.color.setScalar(LABEL_PLATE_BRIGHTNESS);
  const w = Math.max(1e-4, widthM);
  const h = Math.max(1e-4, heightM);
  const geometry = new PlaneGeometry(w, h);
  const mesh = new Mesh(geometry, material);
  mesh.name = '__rvWebLabelPlate';
  // Layer 0 is the default — stated explicitly because it is the point.
  mesh.layers.set(0);
  mesh.castShadow = false;
  mesh.receiveShadow = false;
  mesh.userData._rvLabelPlate = true;
  mesh.userData._rvWebLabel = true;
  return { mesh, geometry, material, texture, widthM: w, heightM: h };
}

/** Replace the plate geometry when the size changed (no-op otherwise). */
export function setLabelPlateSize(h: LabelPlateHandles, widthM: number, heightM: number): boolean {
  const w = Math.max(1e-4, widthM);
  const ht = Math.max(1e-4, heightM);
  if (Math.abs(w - h.widthM) < 1e-9 && Math.abs(ht - h.heightM) < 1e-9) return false;
  const old = h.geometry;
  h.geometry = new PlaneGeometry(w, ht);
  h.mesh.geometry = h.geometry;
  old.dispose();
  h.widthM = w;
  h.heightM = ht;
  return true;
}

/** Swap the plate's texture after a canvas redraw; disposes the old one. */
export function replaceLabelPlateTexture(h: LabelPlateHandles, canvas: HTMLCanvasElement): void {
  const old = h.texture;
  h.texture = createLabelTexture(canvas, 'mipmap');
  h.material.map = h.texture;
  h.material.needsUpdate = true;
  if (old !== h.texture) old.dispose();
}

/** Detach and free geometry, material and texture. Idempotent per handle set. */
export function disposeLabelPlate(h: LabelPlateHandles): void {
  h.mesh.removeFromParent();
  h.geometry.dispose();
  h.material.dispose();
  h.texture.dispose();
}
