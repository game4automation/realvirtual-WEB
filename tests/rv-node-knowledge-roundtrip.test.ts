// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-node-knowledge-roundtrip — the one test that checks the central claim of
 * plan-394 (F4): a note written on a node comes back out of the GLB.
 *
 * Everything else in this feature is downstream of this. If a factory-less
 * rv_extras type did NOT survive `exportAssetGlb` → `parseAsync`, the note would
 * have to live somewhere other than the GLB and the whole design would change.
 * The risk is real rather than theoretical — three.js #15728 has `node.extras`
 * OVERWRITING `mesh.userData` instead of merging, which is exactly how a note
 * would silently eat the `Drive` extras sitting next to it. Hence the sibling
 * test below.
 *
 * Follows the `export-roundtrip.test.ts` pattern: set `userData.realvirtual`
 * directly, export, re-parse. The edit-target write path is a separate concern
 * and is covered by `mcp-knowledge-tools.test.ts`.
 */

import { describe, expect, it } from 'vitest';
import { Group, Object3D } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import {
  NODE_KNOWLEDGE_TYPE,
  readNodeKnowledge,
} from '../src/core/engine/rv-node-knowledge';

/** A multi-line Markdown note — line breaks are the interesting part. */
const NOTE = [
  '## Axis 3',
  '- backlash measured at ~0.2deg',
  '- the upper limit is mechanical, not a soft limit',
].join('\n');

function assetWithNote(extra?: Record<string, unknown>) {
  const root = new Group();
  root.name = 'Asset';
  const axis = new Object3D();
  axis.name = 'Axis';
  axis.userData.realvirtual = {
    ...(extra ?? {}),
    [NODE_KNOWLEDGE_TYPE]: {
      Note: NOTE,
      UpdatedAt: '2026-08-12T09:30:00.000Z',
      Author: 'agent',
      Confidence: 'inferred',
      NodeIdAtWrite: 'a1b2c3d4e5f60718',
    },
  };
  root.add(axis);
  return { root, axis };
}

function find(root: Object3D, name: string): Object3D {
  let result: Object3D | null = null;
  root.traverse((node) => { if (!result && node.name === name) result = node; });
  if (!result) throw new Error(`Missing ${name}`);
  return result;
}

/** Export and re-parse WITHOUT running the scene loader — raw extras only. */
async function roundtrip(root: Object3D, name: string): Promise<Object3D> {
  const buffer = await exportAssetGlb(root);
  const parsed = await new GLTFLoader().parseAsync(buffer, '');
  return find(parsed.scene, name);
}

describe('NodeKnowledge GLB roundtrip', () => {
  it('survives exportAssetGlb -> parseAsync with note text and provenance intact', async () => {
    const { root } = assetWithNote();
    const reloaded = await roundtrip(root, 'Axis');

    const entry = readNodeKnowledge(reloaded);
    expect(entry).not.toBeNull();
    // Byte-equal, line breaks included: the note is Markdown and stays Markdown.
    expect(entry?.Note).toBe(NOTE);
    expect(entry?.Note.split('\n')).toHaveLength(3);
    expect(entry?.UpdatedAt).toBe('2026-08-12T09:30:00.000Z');
    expect(entry?.Author).toBe('agent');
    expect(entry?.Confidence).toBe('inferred');
    expect(entry?.NodeIdAtWrite).toBe('a1b2c3d4e5f60718');
  });

  it('does not clobber sibling rv_extras on the same node (three.js #15728)', async () => {
    const { root } = assetWithNote({ Drive: { Direction: 'LinearX', TargetSpeed: 250 } });
    const reloaded = await roundtrip(root, 'Axis');

    const rv = reloaded.userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(Object.keys(rv).sort()).toEqual(['Drive', NODE_KNOWLEDGE_TYPE].sort());
    expect(rv.Drive.Direction).toBe('LinearX');
    expect(rv.Drive.TargetSpeed).toBe(250);
    expect(readNodeKnowledge(reloaded)?.Note).toBe(NOTE);
  });

  it('does not mutate the live tree while exporting', async () => {
    const { root, axis } = assetWithNote({ Drive: { Direction: 'LinearX' } });
    const before = JSON.stringify(axis.userData);
    await exportAssetGlb(root);
    expect(JSON.stringify(axis.userData)).toBe(before);
  });

  it('leaves NO stub in the GLB once the entry is gone (F7)', async () => {
    // What "removed" has to mean on the wire. The scene-side delete unsets every
    // field one by one, and `deleteUserDataField` drops the type hull only when
    // the LAST field goes — so the failure this guards against is a surviving
    // `NodeKnowledge: { UpdatedAt, Author, Confidence }` husk with no note in it.
    const { root, axis } = assetWithNote({ Drive: { Direction: 'LinearX' } });
    delete (axis.userData.realvirtual as Record<string, unknown>)[NODE_KNOWLEDGE_TYPE];

    const reloaded = await roundtrip(root, 'Axis');
    const rv = reloaded.userData.realvirtual as Record<string, unknown>;
    expect(NODE_KNOWLEDGE_TYPE in rv).toBe(false);
    expect(readNodeKnowledge(reloaded)).toBeNull();
    // The sibling component must not have gone with it.
    expect((rv.Drive as Record<string, unknown>).Direction).toBe('LinearX');
  });

  it('carries a note at the 4000-code-unit limit through unchanged', async () => {
    const root = new Group();
    root.name = 'Asset';
    const axis = new Object3D();
    axis.name = 'Axis';
    const long = 'x'.repeat(4000);
    axis.userData.realvirtual = { [NODE_KNOWLEDGE_TYPE]: { Note: long } };
    root.add(axis);

    const reloaded = await roundtrip(root, 'Axis');
    expect(readNodeKnowledge(reloaded)?.Note).toHaveLength(4000);
  });

  it('preserves notes on several nodes independently', async () => {
    const root = new Group();
    root.name = 'Asset';
    for (const name of ['A', 'B', 'C']) {
      const child = new Object3D();
      child.name = name;
      child.userData.realvirtual = { [NODE_KNOWLEDGE_TYPE]: { Note: `note for ${name}` } };
      root.add(child);
    }

    const buffer = await exportAssetGlb(root);
    const parsed = await new GLTFLoader().parseAsync(buffer, '');
    for (const name of ['A', 'B', 'C']) {
      expect(readNodeKnowledge(find(parsed.scene, name))?.Note).toBe(`note for ${name}`);
    }
  });
});
