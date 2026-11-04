// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-675 Phase 3 — a small curve conveyor with an animated roller mantle.
 *
 *   Curve
 *   ├─ Frame                              (grey, uber)
 *   ├─ Transport {TransportSurface Radial, Drive RotationY}
 *   │   └─ Slide                          (grey)
 *   └─ Rollers
 *       └─ Roller_0..n  cylinder along the radius, UVs from editor.generateUVs
 *                       (cylindrical), map material with the spin marker
 *
 * Options flip some rollers end-for-end (their U then turns the other way),
 * give half of them another radius (another ratio), add an unmarked twin on
 * the same map, put the rollers UNDER the surface node, or make it straight.
 */
import {
  BoxGeometry, CylinderGeometry, DataTexture, Group, Mesh, MeshStandardMaterial, Quaternion, RGBAFormat, Vector3,
  type Material,
} from 'three';
import { generateUVs } from '../../src/core/editor/rv-uv-generate';

export interface CurveOpts {
  marker?: boolean;
  rollers?: number;
  /** Turn every second roller end-for-end. */
  flipHalf?: boolean;
  /** Every second roller gets this mantle radius (m) instead of 0.025. */
  otherRadius?: number;
  unmarkedTwin?: boolean;
  rollersUnderSurface?: boolean;
  linear?: boolean;
  /** No surface at all / two surfaces. */
  surfaces?: 0 | 1 | 2;
  /** Repeat along U (tiles per revolution). */
  repeatU?: number;
}

export const R_MID = 0.45;

export function mantleTexture(): DataTexture {
  const data = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 255, 0, 0, 255, 255, 255, 255, 255, 255]);
  const t = new DataTexture(data, 2, 2, RGBAFormat);
  t.needsUpdate = true;
  return t;
}

export function spinMaterial(marker = true, repeatU = 1): MeshStandardMaterial {
  const map = mantleTexture();
  map.repeat.set(repeatU, 4);
  const m = new MeshStandardMaterial({ color: 0xffffff, map, roughness: 0.5, name: 'Mantle' });
  if (marker) {
    m.userData.rvMaterialPreset = { presetId: 'tex-roller-mantle-spin', textureScaleU: repeatU, textureScaleV: 0.25, spin: 'roller' };
  }
  return m;
}

function roller(material: Material, radius: number, flip: boolean): Mesh {
  const g = new CylinderGeometry(radius, radius, 0.3, 24, 1, true);
  g.deleteAttribute('uv');
  const withUV = generateUVs(g, 'cylindrical').geometry;
  const mesh = new Mesh(withUV, material);
  if (flip) mesh.rotateZ(Math.PI); // end-for-end: the U sense flips in the asset frame
  return mesh;
}

export function makeCurve(o: CurveOpts = {}): () => Group {
  return () => {
    const root = new Group(); root.name = 'Curve';
    const grey = new MeshStandardMaterial({ color: 0x888888, roughness: 0.6, metalness: 0.2 });
    const frame = new Mesh(new BoxGeometry(1, 0.05, 1), grey); frame.name = 'Frame'; root.add(frame);
    const transport = new Group(); transport.name = 'Transport';
    const nSurf = o.surfaces ?? 1;
    if (nSurf > 0) {
      transport.userData.realvirtual = {
        TransportSurface: o.linear
          ? { Radial: false, TransportDirection: { x: -1, y: 0, z: 0 } } // Unity coords → local +X
          : { Radial: true, TransportDirection: { x: 0, y: 1, z: 0 } },
        Drive: { Direction: o.linear ? 'LinearX' : 'RotationY', TargetSpeed: 10 },
      };
    }
    const slide = new Mesh(new BoxGeometry(0.9, 0.01, 0.9), grey.clone()); slide.name = 'Slide';
    slide.position.y = 0.1; transport.add(slide);
    root.add(transport);
    if (nSurf === 2) {
      const t2 = new Group(); t2.name = 'Transport2';
      t2.userData.realvirtual = { TransportSurface: { Radial: true, TransportDirection: { x: 0, y: 1, z: 0 } } };
      t2.add(new Mesh(new BoxGeometry(0.2, 0.01, 0.2), grey.clone()));
      root.add(t2);
    }
    const rollers = new Group(); rollers.name = 'Rollers';
    (o.rollersUnderSurface ? transport : root).add(rollers);
    const mantle = spinMaterial(o.marker !== false, o.repeatU ?? 1);
    const n = o.rollers ?? 4;
    for (let i = 0; i < n; i++) {
      const radius = o.otherRadius !== undefined && i % 2 === 1 ? o.otherRadius : 0.025;
      const r = roller(mantle, radius, !!o.flipHalf && i % 2 === 1);
      r.name = `Roller_${i}`;
      if (o.linear) {
        // Straight conveyor along +X: rollers across it (axis Z), spaced along X.
        r.quaternion.premultiply(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), new Vector3(0, 0, 1)));
        r.position.set(-0.3 + i * 0.2, 0.05, 0);
      } else {
        const a = (i + 0.5) / n * (Math.PI / 2);
        const dir = new Vector3(Math.cos(a), 0, Math.sin(a));
        r.quaternion.premultiply(new Quaternion().setFromUnitVectors(new Vector3(0, 1, 0), dir));
        r.position.copy(dir).multiplyScalar(R_MID).setY(0.05);
      }
      rollers.add(r);
    }
    if (o.unmarkedTwin) {
      const twin = mantle.clone();
      delete twin.userData.rvMaterialPreset;
      twin.map = mantle.map; // same map object → same image
      const idler = new Mesh(roller(mantle, 0.025, false).geometry, twin);
      idler.name = 'Idler'; idler.position.set(0.9, 0.05, 0.9);
      rollers.add(idler);
    }
    return root;
  };
}
