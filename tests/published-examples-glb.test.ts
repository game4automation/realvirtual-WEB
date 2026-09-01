// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * published-examples-glb — the shipped examples, against the bytes that are
 * actually shipped (plan-413 §9.3, retargeted by plan-731 Phase 2).
 *
 * The committed `public/` tree is served by the same dev server that hosts this
 * test, so a fetch here is the fetch the boot routine makes. That is the whole
 * point of the file — a manifest that names a file nobody committed fails here
 * and nowhere else.
 *
 * ## What moved (plan-731 F2)
 *
 * It used to read `/scenes/index.json`, the curated second catalogue. There is
 * no such file and no such folder any more: the examples are `documents[]` rows
 * of `/project.json`, the SAME list the models are in. So the fetch changed and
 * the assertions did not — which is exactly the claim the plan makes.
 *
 * What is pinned:
 *   1. the second catalogue is GONE, file and folder both (F2);
 *   2. every scene-section document names a file the deploy really serves,
 *      and that file is a GLB carrying its classification;
 *   3. the dev-only fixture is a row like any other, marked `devOnly`;
 *   4. `BundledBackend.readScene()` answers a GLB `SceneRecord` for one.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { classificationOfGlbBlob } from '../src/core/project/rv-project-documents';
import { BundledBackend } from '../src/core/project/backends/bundled-backend';
import { sceneDocumentsOf } from '../src/core/project/rv-project-documents';
import { documentsOf, stableDocumentId } from '../src/core/project/rv-project-documents';
import type { RvDocumentEntry, RvProject } from '../src/core/project/rv-project-types';

/** The manifest as the deploy publishes it — the ONE catalogue. */
async function shippedManifest(): Promise<RvProject> {
  const resp = await fetch('/project.json', { cache: 'no-store' });
  expect(resp.ok).toBe(true);
  return await resp.json() as RvProject;
}

describe('the shipped examples are documents (plan-731 F2)', () => {
  let manifest: RvProject;
  let documents: RvDocumentEntry[];
  let scenes: RvDocumentEntry[];

  beforeEach(async () => {
    manifest = await shippedManifest();
    documents = documentsOf(manifest);
    scenes = sceneDocumentsOf(manifest) as unknown as RvDocumentEntry[];
  });

  it('the second catalogue is gone — no scenes/index.json, no scenes/ folder', async () => {
    // F2, stated against the deploy rather than the source tree. This host has
    // an SPA history fallback, so a missing file answers 200 with index.html —
    // "is it JSON" is therefore the only question that can be asked, and it is
    // the one that matters: a leftover index.json would still be parsed by a
    // `discover` backend pointed at this root.
    const resp = await fetch('/scenes/index.json', { cache: 'no-store' });
    const body = await resp.text();
    expect(body.trimStart().startsWith('[')).toBe(false);
    expect(body.trimStart().startsWith('{')).toBe(false);
  });

  it('the manifest lists at least one scene document', () => {
    expect(scenes.length).toBeGreaterThan(0);
  });

  it('every document id is stableDocumentId(path) — one derivation, one space', () => {
    // F3 at the source: the ids a link carries are computable from the path, so
    // the WelcomeModal fallback and the manifest cannot drift apart.
    for (const doc of documents) {
      expect(doc.id, `${doc.path} carries its derived id`).toBe(stableDocumentId(doc.path));
    }
  });

  it('every scene document names a GLB the deploy really serves', async () => {
    for (const doc of scenes) {
      const resp = await fetch(`/${doc.path}`, { cache: 'no-store' });
      expect(resp.ok, `${doc.path} is served`).toBe(true);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      // 'glTF' — not a JSON body (or an index.html) wearing a .glb name.
      expect(
        new DataView(bytes.buffer, bytes.byteOffset, 4).getUint32(0, true),
        `${doc.path} is a GLB`,
      ).toBe(0x46546c67);

      // The classification travels in the bytes (plan-413 phase 1) and was
      // stamped by the bake (phase 3).
      const classification = await classificationOfGlbBlob(new Blob([bytes as BlobPart]));
      expect(classification, `${doc.path} carries a classification`).toBeTruthy();
      expect(classification?.level).toBe('scene');
    }
  });

  it('the dev-only fixture is an ordinary row, marked devOnly', () => {
    // plan-731 2a: it used to be reachable only through the second catalogue,
    // which is why no release gate could see it. It is a row now, and `devOnly`
    // is what every staging path prunes on (2k) and Phase 4 asserts against.
    const devOnly = documents.filter(d => d.devOnly === true);
    expect(devOnly.length).toBeGreaterThan(0);
    for (const d of devOnly) {
      expect(d.path).toMatch(/\.glb$/i);
      expect(typeof d.name).toBe('string');
    }
  });

  it('BundledBackend.readScene answers a GLB SceneRecord for a scene document', async () => {
    const backend = new BundledBackend({
      baseUrl: '/',
      // The deploy root of this test IS the dev server, so the real fetch is
      // the honest implementation here.
      fetchImpl: fetch.bind(globalThis),
    });

    const read = sceneDocumentsOf(await backend.readManifest());
    const meta = read.find(s => s.path === scenes[0]!.path);
    expect(meta, 'the example is a manifest scene entry').toBeTruthy();

    const record = await backend.readScene(meta!.path);
    expect(record).toBeTruthy();
    expect(record!.glb).toBeTruthy();
    expect(new DataView(record!.glb.buffer, record!.glb.byteOffset, 4).getUint32(0, true))
      .toBe(0x46546c67);
  });
});
