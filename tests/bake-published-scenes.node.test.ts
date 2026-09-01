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
 * ## The structural half, standing alone (plan-731)
 *
 * This file used to have two modes: a one-shot `RV_BAKE_PUBLISHED=1` that wrote
 * `public/scenes/<name>.glb` from a committed `.scene.json` op log, and a
 * verification pass over the results. Its own note said what would happen "after
 * the JSONs are gone in phase 6 — at which point the source-comparison half
 * drops out and the structural half stands alone".
 *
 * That is now. plan-731 2g removed `public/scenes/` entirely: the op logs were
 * already gone, and the curated `index.json` that listed the results went with
 * the second catalogue. The bake has no input left, so the write mode is gone
 * with it and what remains is the guard — every scene document the demo SHIPS is
 * a valid GLB carrying its placements, its settings and its classification.
 *
 * The list comes from `public/project.json` now, like every other list. That is
 * not a smaller claim than before: the manifest is what the product boots from,
 * so a scene that is not in it is a scene nobody opens, and one that is in it is
 * one this guard now covers wherever in the deploy its file sits.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { materialise } from '../src/core/hmi/scene/rv-scene-edits';
import { bakeIntoGlb } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { buildEmptyGlbBlob } from '../src/core/hmi/scene/empty-glb';
import type { RvScene } from '../src/core/hmi/scene/rv-scene-types';
import type { DocumentClassification } from '../src/core/project/rv-document-classification';

const PUBLIC_DIR = resolve(__dirname, '../public');

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

/** The scene documents the demo ships, read from the ONE catalogue. */
function shippedSceneDocuments(): { path: string; name: string; devOnly?: boolean }[] {
  const manifest = JSON.parse(
    readFileSync(resolve(PUBLIC_DIR, 'project.json'), 'utf8'),
  ) as { documents?: { path?: string; name?: string; section?: string; devOnly?: boolean }[] };
  return (manifest.documents ?? [])
    .filter(d => typeof d.path === 'string' && /\.glb$/i.test(d.path)
      && (d.section === 'scenes' || d.path.toLowerCase().startsWith('scenes/')))
    .map(d => ({ path: d.path as string, name: d.name ?? (d.path as string), devOnly: d.devOnly }));
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

describe('shipped scene documents are baked GLBs (plan-413 phase 3, plan-731)', () => {
  const documents = shippedSceneDocuments();

  it('the manifest declares at least one scene document', () => {
    // A silent empty sweep is the failure mode: it would report green while
    // checking nothing at all.
    expect(documents.length).toBeGreaterThan(0);
  });

  for (const doc of documents) {
    it(`${doc.path} is a valid GLB carrying its placements`, async () => {
      const target = resolve(PUBLIC_DIR, ...doc.path.split('/'));

      expect(existsSync(target), `${doc.path} is committed`).toBe(true);
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

      // The source-comparison half is gone with its sources (plan-731 2g). It
      // pinned the placement COUNT against the op log a re-bake would have
      // consumed; there is no op log and no re-bake any more, so the honest
      // remaining claim is the structural one above — and asserting a count
      // against nothing would be worse than not asserting it.
    }, 60_000);
  }
});
