// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-506 §9.3 — an asset-editor Save keeps the `DocumentInfo` block (F4).
 *
 * There is deliberately NO code path for this: `liftRootExtrasToScene` spreads
 * the whole scene block (`{ ...(existing ?? {}) }`) and replaces only the
 * `Classification` key, so every other file-level key rides along untouched.
 * This test pins that property, because the day somebody narrows that spread to
 * "the keys we know", every description in every edited model would vanish on
 * the next Save — silently, since the editor never shows the block.
 */

import { describe, it, expect } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { objectToGlb } from '../src/core/import/rv-import-object';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { readClassificationFromScene, readDocumentInfoFromScene } from '../src/core/hmi/scene/rv-scene-glb-read';
import { writeClassification, writeDocumentInfo } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { defaultSceneExtras, parseGlbChunks, rebuildGlbWithJson } from '../src/core/persistence/rv-glb-chunks';
import { RV_DOCUMENT_INFO_KEY, type DocumentInfo } from '../src/core/project/rv-document-info';

const INFO: DocumentInfo = {
  v: 1,
  summary: 'Hydraulic press 400 t with infeed belt',
  description: '# Press P400\n\nThe cell consists of **press**, belt and unloader.\n\n- one\n- two',
  updatedAt: '2026-09-26T10:00:00.000Z',
  updatedBy: 'Thomas',
};

async function reloadScene(buffer: ArrayBuffer | Uint8Array): Promise<Object3D> {
  const ab = buffer instanceof Uint8Array
    ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    : buffer;
  const parsed = await new GLTFLoader().parseAsync(ab, '');
  new Scene().add(parsed.scene);
  return parsed.scene;
}

/** A GLB whose default scene carries a Classification AND a DocumentInfo block. */
async function describedGlb(transformed: boolean): Promise<Uint8Array> {
  const root = new Group();
  root.name = 'Cell';
  if (transformed) root.position.set(0, 100, 0);
  const axis = new Object3D();
  axis.name = 'Axis';
  root.add(axis);
  const chunks = parseGlbChunks(new Uint8Array(await objectToGlb(root)));
  writeClassification(chunks.json, { v: 1, level: 'assembly', tags: ['presse'] });
  writeDocumentInfo(chunks.json, INFO);
  return rebuildGlbWithJson(chunks);
}

function rawDocumentInfo(glb: ArrayBuffer): unknown {
  const extras = defaultSceneExtras(parseGlbChunks(new Uint8Array(glb)).json);
  return (extras?.realvirtual as Record<string, unknown> | undefined)?.[RV_DOCUMENT_INFO_KEY];
}

describe('plan-506 §9.3 — editor Save keeps DocumentInfo', () => {
  for (const transformed of [false, true]) {
    it(`survives a classification change (${transformed ? 'transformed root' : 'identity root'})`, async () => {
      const loaded = await reloadScene(await describedGlb(transformed));
      expect(readDocumentInfoFromScene(loaded)).toEqual(INFO);

      const saved = await exportAssetGlb(loaded, 'Cell', null, { v: 1, level: 'plant' });
      // The Save did change the classification…
      const reloaded = await reloadScene(saved);
      expect(readClassificationFromScene(reloaded)).toEqual({ v: 1, level: 'plant' });
      // …and carried the description through unchanged, byte for byte in JSON.
      expect(rawDocumentInfo(saved)).toEqual({ ...INFO });
      expect(readDocumentInfoFromScene(reloaded)).toEqual(INFO);

      // Exactly one block in the file — lifted to the scene, not duplicated onto
      // the content node of the transformed branch.
      let blocks = 0;
      reloaded.traverse((n) => {
        const rv = (n.userData as Record<string, unknown>)['realvirtual'];
        if (rv && typeof rv === 'object' && RV_DOCUMENT_INFO_KEY in rv) blocks++;
      });
      expect(blocks).toBe(1);
    });
  }

  it('also survives a Save that leaves the classification alone', async () => {
    const loaded = await reloadScene(await describedGlb(false));
    const saved = await exportAssetGlb(loaded, 'Cell');
    expect(rawDocumentInfo(saved)).toEqual({ ...INFO });
  });
});
