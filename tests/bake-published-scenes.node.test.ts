// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * bake-published-scenes — the tool step that moved the two Examples out of the
 * JSON world, and the guard that keeps them there (plan-413 §2.6 point 1).
 *
 * ## Why a test file and not a script
 *
 * The bake is `materialise()` + `bakeIntoGlb()` — the exact pair the SceneStore
 * uses when a user presses Save. A separate `scripts/bake-*.mjs` would have had
 * to re-import the same TypeScript through a second toolchain and would then
 * have been a second implementation of "how a scene becomes bytes", free to
 * drift from the first. Running it here means the conversion went through the
 * production path, byte for byte.
 *
 * ## Two modes
 *
 * - `RV_BAKE_PUBLISHED=1 npm run test:node -- bake-published-scenes` **writes**
 *   `public/scenes/<name>.glb` from `public/scenes/<name>.scene.json`. This is
 *   the one-shot; the results are committed.
 * - Without the variable it **verifies** the committed GLBs: they exist, they
 *   are valid GLB, and they carry one `AssetReference` node per placement of
 *   the source scene plus the scene-level settings and classification. That is
 *   the part worth keeping after the JSONs are gone in phase 6 — at which point
 *   the source-comparison half drops out and the structural half stands alone.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import { bakeIntoGlb } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { buildEmptyGlbBlob } from '../src/core/hmi/scene/empty-glb';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import type { DocumentClassification } from '../src/core/project/rv-document-classification';

const SCENES_DIR = resolve(__dirname, '../public/scenes');
const WRITE = process.env.RV_BAKE_PUBLISHED === '1';

/**
 * `GLTFExporter` reads its assembled binary chunk through a `FileReader`, which
 * Node does not have. The shim is the smallest thing that satisfies that one
 * call — `Blob.arrayBuffer()` is native here — and it is installed only when the
 * global is genuinely missing, so it can never shadow a real browser API.
 *
 * This lives in the harness rather than in `rv-import-object` on purpose: the
 * product runs in a browser, and a polyfill shipped for the benefit of a bake
 * step would be dead weight in every bundle.
 */
if (typeof (globalThis as { FileReader?: unknown }).FileReader === 'undefined') {
  class NodeFileReader {
    result: ArrayBuffer | string | null = null;
    onload: (() => void) | null = null;
    onloadend: (() => void) | null = null;
    onerror: ((e: unknown) => void) | null = null;
    private _finish(value: ArrayBuffer | string): void {
      this.result = value;
      this.onload?.();
      this.onloadend?.();
    }
    readAsArrayBuffer(blob: Blob): void {
      void blob.arrayBuffer().then(b => this._finish(b)).catch(e => this.onerror?.(e));
    }
    readAsDataURL(blob: Blob): void {
      void blob.arrayBuffer()
        .then(b => this._finish(`data:${blob.type};base64,${Buffer.from(b).toString('base64')}`))
        .catch(e => this.onerror?.(e));
    }
  }
  (globalThis as { FileReader?: unknown }).FileReader = NodeFileReader;
}

/** Every example is a scene — that is what the level says, and it travels. */
const EXAMPLE_CLASSIFICATION: DocumentClassification = { v: 1, level: 'scene' };

interface IndexEntry { file: string; name?: string; mode?: string }

function readIndex(): IndexEntry[] {
  return JSON.parse(readFileSync(resolve(SCENES_DIR, 'index.json'), 'utf8')) as IndexEntry[];
}

/** The source JSON of one example, while it still exists (dropped in phase 6). */
function readSourceScene(glbFile: string): RvScene | null {
  const json = resolve(SCENES_DIR, glbFile.replace(/\.glb$/i, '.scene.json'));
  if (!existsSync(json)) return null;
  return JSON.parse(readFileSync(json, 'utf8')) as RvScene;
}

/** Bake one op-log scene onto the empty base — the SceneStore's own call. */
async function bake(scene: RvScene): Promise<Uint8Array> {
  const source = await buildEmptyGlbBlob().arrayBuffer();
  const result = await bakeIntoGlb(
    source,
    materialise(scene.edits.ops),
    // The overlay is empty for both examples (placements only), so nothing ever
    // asks where a node lives. A stub keeps the harness free of a loaded scene.
    { locate: () => null },
    {
      settings: { ...scene.edits.settings },
      clearCameraWhenUnset: true,
      classification: EXAMPLE_CLASSIFICATION,
    },
  );
  return result.glb;
}

/** The JSON chunk of a GLB, parsed. */
function glbJson(bytes: Uint8Array): Record<string, unknown> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x46546c67);   // 'glTF'
  const chunkLen = view.getUint32(12, true);
  expect(view.getUint32(16, true)).toBe(0x4e4f534a);  // 'JSON'
  const json = new TextDecoder().decode(bytes.subarray(20, 20 + chunkLen));
  return JSON.parse(json) as Record<string, unknown>;
}

describe('published examples are GLBs (plan-413 phase 3)', () => {
  const index = readIndex();

  it('the catalogue lists .glb files only', () => {
    expect(index.length).toBeGreaterThan(0);
    for (const entry of index) expect(entry.file).toMatch(/\.glb$/i);
  });

  for (const entry of index) {
    it(`${entry.file} is a valid GLB carrying its placements`, async () => {
      const target = resolve(SCENES_DIR, entry.file);
      const source = readSourceScene(entry.file);

      if (WRITE) {
        if (!source) throw new Error(`No source scene for ${entry.file} — nothing to bake.`);
        writeFileSync(target, await bake(source));
      }

      expect(existsSync(target)).toBe(true);
      const bytes = new Uint8Array(readFileSync(target));
      const json = glbJson(bytes);

      const nodes = (json.nodes ?? []) as Array<{ extras?: Record<string, unknown> }>;
      const references = nodes.filter(
        n => !!(n.extras?.realvirtual as Record<string, unknown> | undefined)?.AssetReference,
      );
      expect(references.length).toBeGreaterThan(0);

      const scenes = (json.scenes ?? []) as Array<{ extras?: Record<string, unknown> }>;
      const sceneIndex = typeof json.scene === 'number' ? json.scene : 0;
      const rv = (scenes[sceneIndex]?.extras?.realvirtual ?? {}) as Record<string, unknown>;
      expect(rv.Classification).toMatchObject({ level: 'scene' });
      expect(rv.SceneSettings).toBeTruthy();

      // While the source JSON is still around (until phase 6), the count is
      // pinned to it: a re-bake that lost a placement would be visible here.
      if (source) {
        const placements = new Set(
          materialise(source.edits.ops).placements.map(p => p.id),
        );
        expect(references.length).toBe(placements.size);
      }
    }, 60_000);
  }
});
