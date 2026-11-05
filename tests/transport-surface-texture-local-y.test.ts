// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * A belt that runs along local Y only (CAD frames, e.g. the Festo cell) scrolls its texture
 * in U. Unity's formula takes the X / Z components only, so such a belt stood still.
 */

import { describe, expect, it } from 'vitest';
import { BoxGeometry, DataTexture, Mesh, MeshStandardMaterial, Vector3 } from 'three';
import { AABB } from '../src/core/engine/rv-aabb';
import { RVTransportSurface } from '../src/core/engine/rv-transport-surface';
import type { RVDrive } from '../src/core/engine/rv-drive';

function belt(dir: Vector3): { mesh: Mesh; surface: RVTransportSurface } {
  const mesh = new Mesh(new BoxGeometry(0.05, 0.8, 0.1), new MeshStandardMaterial({ map: new DataTexture(new Uint8Array(4), 1, 1) }));
  mesh.name = 'Belt';
  const surface = new RVTransportSurface(mesh, AABB.fromHalfSize(mesh, new Vector3(0.025, 0.4, 0.05)));
  surface.TransportDirection.copy(dir);
  // What the loader's beforeSchema stamps from the GLB extras (Unity coordinates).
  surface.rawLocalDir = { x: dir.x, y: dir.y, z: dir.z };
  surface.AnimateSurface = true;
  surface.TextureScale = 20;
  surface.reapplyConfig();
  surface.initTransport();
  surface.drive = { currentSpeed: 100, name: 'd' } as unknown as RVDrive;
  return { mesh, surface };
}

describe('TransportSurface texture scroll along local Y', () => {
  it('scrolls U by TextureScale x speed for a belt along local Y', () => {
    const { mesh, surface } = belt(new Vector3(0, 1, 0));
    surface.updateTextureAnimation(0.01);
    const map = (mesh.material as MeshStandardMaterial).map!;
    // 20 UV/m x 0.1 m/s x 0.01 s
    expect(map.offset.x).toBeCloseTo(0.02, 6);
    expect(map.offset.y).toBeCloseTo(0, 6);
  });

  it('a belt along local X still scrolls U as before (Unity formula)', () => {
    const { mesh, surface } = belt(new Vector3(1, 0, 0));
    surface.updateTextureAnimation(0.01);
    expect(Math.abs((mesh.material as MeshStandardMaterial).map!.offset.x)).toBeCloseTo(0.02, 6);
  });
});
