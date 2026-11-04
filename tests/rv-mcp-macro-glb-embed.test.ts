// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-641 §9.3 + M5 — macros ride in the GLB at
 * `scenes[0].extras.realvirtual.Macros`, written by BOTH save paths: the asset
 * export (`exportAssetGlb({ macros })`) and the scene writer of bound scene
 * documents (`writeMacros`, the sister of `writeDocumentInfo`).
 *
 * Three states each (like DocumentInfo): `undefined` = no opinion (an untouched
 * block in the bytes survives a save byte-for-byte), `null` = remove, array =
 * replace. A document without macros stays without the key, and the macro book
 * of a freshly loaded document is seeded from the block (load path).
 */

import { describe, it, expect } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { objectToGlb } from '../src/core/import/rv-import-object';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { writeDocumentInfo, writeMacros } from '../src/core/hmi/scene/rv-scene-glb-bake';
import { defaultSceneExtras, parseGlbChunks, rebuildGlbWithJson } from '../src/core/persistence/rv-glb-chunks';
import {
  macroBookOf,
  macrosForEmbed,
  parseMacros,
  RV_MACROS_KEY,
  type RvMacro,
} from '../src/plugins/mcp-bridge/rv-mcp-macro';

const MACRO: RvMacro = {
  $schema: 'rv-macro/1',
  name: 'festo-round-2',
  document: { id: 'doc_1', name: 'Festo' },
  steps: [
    {
      kind: 'command', command: 'editor.setField',
      args: { path: 'Cell/Slide', componentType: 'Drive', fieldName: 'UpperLimit', valueJson: '5' },
      note: { author: 'agent', reason: 'DFM-6-5 has 5 mm stroke', source: 'parts:DFM-6-5', confidence: 'observed' },
      result: { status: 'ok' }, at: '2026-10-20T10:00:00.000Z',
    },
    {
      kind: 'assert', check: 'gap', args: { a: 'Cell/Rod', b: 'Cell/Plate' }, expect: { gapMm: { min: 0.5 } },
      note: { author: 'agent', reason: 'rod must not touch the plate' }, at: '2026-10-20T10:01:00.000Z',
    },
  ],
};

async function reloadScene(buffer: ArrayBuffer | Uint8Array): Promise<Object3D> {
  const ab = buffer instanceof Uint8Array
    ? buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength) as ArrayBuffer
    : buffer;
  const parsed = await new GLTFLoader().parseAsync(ab, '');
  new Scene().add(parsed.scene);
  return parsed.scene;
}

function rawMacros(glb: ArrayBuffer | Uint8Array): unknown {
  const bytes = glb instanceof Uint8Array ? glb : new Uint8Array(glb);
  const extras = defaultSceneExtras(parseGlbChunks(bytes).json);
  return (extras?.realvirtual as Record<string, unknown> | undefined)?.[RV_MACROS_KEY];
}

function cell(transformed = false): Group {
  const root = new Group();
  root.name = 'Cell';
  if (transformed) root.position.set(0, 100, 0);
  const axis = new Object3D();
  axis.name = 'Slide';
  root.add(axis);
  return root;
}

describe('plan-641 §9.3 — asset export path', () => {
  for (const transformed of [false, true]) {
    it(`embeds the macros and reads them back identically (${transformed ? 'transformed' : 'identity'} root)`, async () => {
      const saved = await exportAssetGlb(cell(transformed), 'Cell', undefined, undefined, { macros: [MACRO] });
      expect(rawMacros(saved)).toEqual([MACRO]);
      const loaded = await reloadScene(saved);
      expect(parseMacros((loaded.userData as Record<string, unknown>)['realvirtual'])).toEqual([MACRO]);
    });
  }

  it('a document without macros carries no Macros key', async () => {
    const saved = await exportAssetGlb(cell(), 'Cell');
    expect(rawMacros(saved)).toBeUndefined();
  });

  it('undefined keeps an untouched block through a save; null removes it', async () => {
    const first = await reloadScene(await exportAssetGlb(cell(), 'Cell', undefined, undefined, { macros: [MACRO] }));
    const kept = await exportAssetGlb(first, 'Cell', undefined, undefined, { macros: undefined });
    expect(rawMacros(kept)).toEqual([MACRO]);
    const removed = await exportAssetGlb(await reloadScene(kept), 'Cell', undefined, undefined, { macros: null });
    expect(rawMacros(removed)).toBeUndefined();
  });

  it('the macro book of a loaded document is seeded from the block; an untouched book has no opinion', async () => {
    const loaded = await reloadScene(await exportAssetGlb(cell(), 'Cell', undefined, undefined, { macros: [MACRO] }));
    const doc = {};
    const book = macroBookOf(doc, () => (loaded.userData as Record<string, unknown>)['realvirtual']);
    expect([...book.macros.keys()]).toEqual(['festo-round-2']);
    expect(macrosForEmbed(doc)).toBeUndefined();
    book.touched = true;
    expect(macrosForEmbed(doc)).toEqual([MACRO]);
    book.macros.clear();
    expect(macrosForEmbed(doc)).toBeNull();
  });
});

describe('plan-641 M5 — scene writer path (writeMacros)', () => {
  it('writes, keeps (undefined) and removes (null) the block beside DocumentInfo', async () => {
    const chunks = parseGlbChunks(new Uint8Array(await objectToGlb(cell())));
    writeDocumentInfo(chunks.json, { v: 1, summary: 'Cell', description: '', updatedAt: '2026-10-20T00:00:00.000Z' });
    expect(writeMacros(chunks.json, [MACRO])).toBe(true);
    const withMacros = rebuildGlbWithJson(chunks);
    expect(rawMacros(withMacros)).toEqual([MACRO]);

    const again = parseGlbChunks(withMacros);
    expect(writeMacros(again.json, undefined)).toBe(false);
    expect(rawMacros(rebuildGlbWithJson(again))).toEqual([MACRO]);

    writeMacros(again.json, null);
    const cleared = rebuildGlbWithJson(again);
    expect(rawMacros(cleared)).toBeUndefined();
    // The neighbour block is untouched.
    const rv = defaultSceneExtras(parseGlbChunks(cleared).json)?.realvirtual as Record<string, unknown>;
    expect(rv['DocumentInfo']).toMatchObject({ summary: 'Cell' });
  });

  it('parseMacros is tolerant: malformed entries and unknown schemas are dropped, never thrown', () => {
    expect(parseMacros({ [RV_MACROS_KEY]: [MACRO, { name: '' }, { $schema: 'rv-macro/9', name: 'x' }, 42] })).toEqual([MACRO]);
    expect(parseMacros({ [RV_MACROS_KEY]: 'nope' })).toEqual([]);
    expect(parseMacros(undefined)).toEqual([]);
  });
});
