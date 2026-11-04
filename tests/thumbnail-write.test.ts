// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-776 §9.1 — the image a save writes.
 *
 * Real WebGL in headless Chromium (SwiftShader), so pixel checks carry a
 * tolerance. Pinned: 512×512, WebP in Chromium, a transparent background, a
 * semi-transparent contact shadow, the right orientation (no y-flip, camera
 * from the front-right), the Safari PNG fallback and the hash in the name.
 */

import { describe, it, expect } from 'vitest';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshBasicMaterial,
  Scene,
  WebGLRenderer,
} from 'three';
import {
  renderThumbnailImage,
  THUMBNAIL_SIZE,
  type ThumbnailViewer,
} from '../src/core/thumbnails/rv-thumbnail-write';
import { encodeThumbnail } from '../src/core/thumbnails/rv-thumbnail-encode';
import { revisionOfBytes } from '../src/core/project/rv-scene-record';

function makeViewer(): { renderer: WebGLRenderer; scene: Scene } {
  const canvas = document.createElement('canvas');
  canvas.width = 64;
  canvas.height = 64;
  const renderer = new WebGLRenderer({ canvas, alpha: true });
  renderer.setSize(64, 64, false);
  return { renderer, scene: new Scene() };
}

/** The viewer with `root` loaded as its open document — the ONE thumbnail source. */
function withDocument(viewer: { renderer: WebGLRenderer; scene: Scene }, root: Group): ThumbnailViewer {
  viewer.scene.add(root);
  return { ...viewer, currentModelRoot: root };
}

/**
 * Asymmetric fixture: a grey slab on the floor and a RED cube at +X. Seen from
 * the fixed front-right camera (+X, +Y, +Z) the +X side is on the RIGHT half
 * of the image; a y-flip would put the slab above the cube.
 */
function makeAsset(): Group {
  const root = new Group();
  const slab = new Mesh(new BoxGeometry(2, 0.2, 2), new MeshBasicMaterial({ color: 0x808080 }));
  slab.position.set(0, 0.1, 0);
  const red = new Mesh(new BoxGeometry(0.6, 0.6, 0.6), new MeshBasicMaterial({ color: 0xff0000 }));
  red.position.set(0.8, 0.5, -0.8);
  root.add(slab, red);
  root.updateMatrixWorld(true);
  return root;
}

async function decode(bytes: Uint8Array, type: string): Promise<{ w: number; h: number; data: Uint8ClampedArray }> {
  const bitmap = await createImageBitmap(new Blob([bytes as BlobPart], { type }));
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  const ctx = canvas.getContext('2d')!;
  ctx.drawImage(bitmap, 0, 0);
  return { w: bitmap.width, h: bitmap.height, data: ctx.getImageData(0, 0, bitmap.width, bitmap.height).data };
}

describe('renderThumbnailImage — the document picture (plan-776 F2)', () => {
  it('is a 512 px WebP with a transparent background, a soft shadow and the red cube on the right', async () => {
    const viewer = makeViewer();
    try {
      const image = await renderThumbnailImage(withDocument(viewer, makeAsset()));
      expect(image).not.toBeNull();
      expect(image!.ext).toBe('webp');
      const { w, h, data } = await decode(image!.bytes, 'image/webp');
      expect([w, h]).toEqual([THUMBNAIL_SIZE, THUMBNAIL_SIZE]);

      // Corner: fully transparent.
      expect(data[3]).toBeLessThan(8);

      let redLeft = 0;
      let redRight = 0;
      let soft = 0;
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const [r, g, b, a] = [data[i], data[i + 1], data[i + 2], data[i + 3]];
          if (a > 200 && r > 150 && g < 90 && b < 90) {
            if (x < w / 2) redLeft++; else redRight++;
          }
          if (a > 10 && a < 230) soft++;
        }
      }
      // Orientation: the +X cube appears on the right half.
      expect(redRight).toBeGreaterThan(redLeft);
      expect(redRight).toBeGreaterThan(50);
      // Semi-transparent pixels exist: the contact shadow and anti-aliased edges.
      expect(soft).toBeGreaterThan(0);
    } finally {
      viewer.renderer.dispose();
    }
  });

  it('answers null for a document with nothing renderable (#10)', async () => {
    const viewer = makeViewer();
    try {
      expect(await renderThumbnailImage(withDocument(viewer, new Group()))).toBeNull();
    } finally {
      viewer.renderer.dispose();
    }
  });

  it('hash8 is the first 8 hex chars of the bytes\' SHA-256, stable for the same image', async () => {
    const viewer = makeViewer();
    try {
      const a = await renderThumbnailImage(withDocument(viewer, makeAsset()));
      expect(a!.hash8).toMatch(/^[0-9a-f]{8}$/);
      expect(a!.hash8).toBe((await revisionOfBytes(a!.bytes)).slice(0, 8));
      // The same picture encodes to the same name. (Two RENDERS of one scene
      // are not bit-exact on a software rasteriser — GTAO in a fresh composer —
      // which costs a new file name on a re-save, never a wrong picture.)
      const bitmap = await createImageBitmap(new Blob([a!.bytes as BlobPart], { type: 'image/webp' }));
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0);
      const once = await encodeThumbnail(canvas);
      const twice = await encodeThumbnail(canvas);
      expect(twice.hash8).toBe(once.hash8);
    } finally {
      viewer.renderer.dispose();
    }
  });
});

describe('encodeThumbnail — the Safari fallback (P4)', () => {
  it('writes PNG under .png when the encoder hands back PNG for a WebP request', async () => {
    const png = await new Promise<Blob>((resolve) => {
      const c = document.createElement('canvas');
      c.width = 4;
      c.height = 4;
      c.getContext('2d')!.fillRect(0, 0, 4, 4);
      c.toBlob((blob) => resolve(blob!), 'image/png');
    });
    const requested: string[] = [];
    const safariLike = {
      async convertToBlob(options?: { type?: string }) {
        requested.push(options?.type ?? '');
        return png;                           // what Safari silently does
      },
    };
    const image = await encodeThumbnail(safariLike);
    expect(requested).toEqual(['image/webp']);
    expect(image.ext).toBe('png');
    expect(image.hash8).toBe((await revisionOfBytes(image.bytes)).slice(0, 8));
  });
});
