// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-386 §9.6 — the sender's stamp.
 *
 * The claim under test is the one the whole feature rests on: *everything the
 * receiver needs to know travels inside the GLB* (§2.4). There is no sidecar to
 * fetch and no registry to ask — one URL, and whatever the bytes say about
 * themselves. So the round trip is exercised for real: export through
 * `GLTFExporter`, re-read through `GLTFLoader`, parse with the same defensive
 * reader the viewer uses.
 *
 * The second critical case is the one nobody sees when it breaks. Import
 * somebody's shared cell, edit it, publish it again — and without an explicit
 * replace the file still names them as the author under their licence. The
 * person that harms is never the one who can check (R7).
 */

import { describe, expect, it } from 'vitest';
import { Group, Object3D, Scene } from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import {
  RV_SHARE_KEY,
  buildSharedGlbInfo,
  filenameFromUrl,
  parseShareMeta,
  type RvShareMeta,
} from '../src/core/share/rv-share-meta';
import {
  buildOwnUrlShareLink,
  buildShareViewerLink,
  parseGlbParam,
} from '../src/core/share/rv-share-target';

// plan-413: writers emit v2 (shared level enum), so a round trip comes back
// as v2 regardless of what was handed in. v1 blocks are still READ — see
// `shareMeta_IgnoresMalformed` and `shareMeta_ReadsV1AndMapsTheLevel`.
const MINE: RvShareMeta = {
  v: 2,
  name: 'Pick & Place Cell',
  author: 'Thomas Strigl',
  license: 'CC-BY-4.0',
  level: 'assembly',
  expiresAt: '2026-09-04T00:00:00.000Z',
  allowDownload: false,
};

const THEIRS = {
  v: 1,
  name: 'Somebody else cell',
  author: 'Someone Else',
  license: 'All rights reserved',
  level: 'model',
};

/** An asset root with a transform, so the flattening keeps the content node. */
function assetWithTransform(rootExtras?: Record<string, unknown>): Group {
  const root = new Group();
  root.name = 'Asset';
  root.position.set(0, 100, 0);
  if (rootExtras) Object.assign(root.userData, rootExtras);
  const axis = new Object3D();
  axis.name = 'Axis';
  axis.userData.realvirtual = { Drive: { Direction: 'LinearX' } };
  root.add(axis);
  return root;
}

/** A flat asset root — the identity-transform branch of the exporter. */
function flatAsset(rootExtras?: Record<string, unknown>): Group {
  const root = new Group();
  root.name = 'Asset';
  if (rootExtras) Object.assign(root.userData, rootExtras);
  const axis = new Object3D();
  axis.name = 'Axis';
  root.add(axis);
  return root;
}

async function reload(buffer: ArrayBuffer) {
  const parsed = await new GLTFLoader().parseAsync(buffer, '');
  const holder = new Scene();
  holder.add(parsed.scene);
  return parsed.scene;
}

/** Every node's `rv_share`, root included — the R7 blast radius. */
function allShareBlocks(root: Object3D): unknown[] {
  const found: unknown[] = [];
  root.traverse((node) => {
    const block = (node.userData as Record<string, unknown>)[RV_SHARE_KEY];
    if (block !== undefined) found.push(block);
  });
  return found;
}

describe('plan-386 §9.6 — sender metadata', () => {
  it('shareExport_RvShareSurvivesRoundTrip', async () => {
    const glb = await exportAssetGlb(flatAsset(), 'Pick & Place Cell', MINE);
    const root = await reload(glb);

    // On the ROOT, which is where the receiver's card looks: `GLTFLoader`
    // restores `scenes[0].extras` onto `gltf.scene.userData`.
    const parsed = parseShareMeta(root.userData);
    expect(parsed).toEqual(MINE);

    // And the whole card model builds from it, expiry and download switch
    // included — the two fields that only ever come from here.
    const info = buildSharedGlbInfo({ url: 'https://files.example.test/cell.glb', userData: root.userData });
    expect(info.name).toBe('Pick & Place Cell');
    expect(info.meta?.author).toBe('Thomas Strigl');
    expect(info.meta?.expiresAt).toBe(MINE.expiresAt);
    expect(info.downloadAllowed).toBe(false);
  });

  it('shareExport_RvShareSurvivesRoundTrip_WithTransformedRoot', async () => {
    // The other exporter branch: a transform on the content root keeps a node
    // level, and the block must still end up on the SCENE, not on that node.
    const glb = await exportAssetGlb(assetWithTransform(), 'Cell', MINE);
    const root = await reload(glb);

    expect(parseShareMeta(root.userData)?.author).toBe('Thomas Strigl');
    expect(allShareBlocks(root)).toHaveLength(1);
  });

  it('shareExport_ReExportReplacesMeta', async () => {
    // The file as it arrived: somebody else's claim, on the root.
    const imported = flatAsset({ [RV_SHARE_KEY]: THEIRS });

    const glb = await exportAssetGlb(imported, 'My version', MINE);
    const root = await reload(glb);

    const parsed = parseShareMeta(root.userData);
    expect(parsed?.author).toBe('Thomas Strigl');
    expect(parsed?.license).toBe('CC-BY-4.0');
    // Replaced, never merged: not one field of theirs survives.
    expect(parsed?.name).not.toBe(THEIRS.name);
    expect(parsed?.level).toBe('assembly');
    expect(JSON.stringify(parsed)).not.toContain('Someone Else');
    expect(allShareBlocks(root)).toHaveLength(1);
  });

  it('shareExport_ReExportWithoutMetaDropsForeignBlock', async () => {
    // The silent case R7 is really about: re-publish without saying anything,
    // and the file must stop claiming the previous author rather than keep him.
    const imported = flatAsset({ [RV_SHARE_KEY]: THEIRS });

    const root = await reload(await exportAssetGlb(imported, 'My version'));

    expect(parseShareMeta(root.userData)).toBeNull();
    expect(allShareBlocks(root)).toHaveLength(0);
  });

  it('shareExport_OmittedMetaStillValid', async () => {
    const root = await reload(await exportAssetGlb(flatAsset(), 'Plain asset'));

    // A perfectly ordinary export: no block, and everything else intact.
    expect(parseShareMeta(root.userData)).toBeNull();
    let axis: Object3D | null = null;
    root.traverse(n => { if (n.name === 'Axis') axis = n; });
    expect(axis).not.toBeNull();
  });

  it('shareMeta_FallsBackToFilename', async () => {
    const root = await reload(await exportAssetGlb(flatAsset(), 'Plain asset'));

    const info = buildSharedGlbInfo({
      url: 'https://files.example.test/pick%20and%20place.glb',
      userData: root.userData,
    });
    // No `rv_share` — the card shrinks to filename plus origin, and never
    // disappears: the origin line is the actual security measure.
    expect(info.meta).toBeNull();
    expect(info.name).toBe('pick and place');
    expect(info.originHost).toBe('files.example.test');
    expect(info.downloadAllowed).toBe(true);
    expect(filenameFromUrl('https://h.test/a/b/c.GLB?x=1#y')).toBe('c');
  });

  it('shareMeta_IgnoresMalformed', async () => {
    // A hand-edited or hostile block must not stop a link from opening.
    for (const block of [
      42, 'nonsense', [], null,
      { v: 3, author: 'from the future' },
      { v: 1, level: 'planet', category: 'unknown', footprintMm: ['a', 'b'], tags: 'not-an-array' },
      { v: 1, homepage: 'javascript:alert(1)', expiresAt: 'not-a-date' },
    ]) {
      expect(() => parseShareMeta({ [RV_SHARE_KEY]: block })).not.toThrow();
    }

    // plan-413 moved the horizon from 1 to 2: v2 is now a block we understand,
    // v3 is the one that might mean something else entirely and is refused.
    expect(parseShareMeta({ [RV_SHARE_KEY]: { v: 3, author: 'x' } })).toBeNull();
    expect(parseShareMeta({ [RV_SHARE_KEY]: { v: 2, author: 'x' } })?.author).toBe('x');

    const partial = parseShareMeta({
      [RV_SHARE_KEY]: {
        v: 1, name: 'Cell', level: 'planet', category: 'unknown',
        footprintMm: ['a', 'b'], tags: 'not-an-array',
        homepage: 'javascript:alert(1)', expiresAt: 'not-a-date',
      },
    });
    expect(partial?.name).toBe('Cell');
    // Every field that could not be proven is simply absent — including the
    // homepage, which ends up in an anchor href.
    expect(partial?.level).toBeUndefined();
    expect(partial?.category).toBeUndefined();
    expect(partial?.footprintMm).toBeUndefined();
    expect(partial?.tags).toBeUndefined();
    expect(partial?.homepage).toBeUndefined();
    expect(partial?.expiresAt).toBeUndefined();

    // And the malformed block survives an export round trip without breaking it.
    const root = await reload(
      await exportAssetGlb(flatAsset({ [RV_SHARE_KEY]: 'nonsense' }), 'Asset'),
    );
    expect(parseShareMeta(root.userData)).toBeNull();
  });

  it('shareMeta_ReadsV1AndMapsTheLevel', async () => {
    // plan-413 §5.1, the regression this consolidation could plausibly cause:
    // `rv_share` is part of the ACTIVE goal, and every link minted before the
    // enum merge carries a v1 block with the old spellings. Those links exist
    // in other people's mailboxes — they have to keep opening, unchanged.
    const v1 = (level: string) => parseShareMeta({
      [RV_SHARE_KEY]: { v: 1, name: 'Cell', author: 'T', level },
    });

    expect(v1('component')?.level).toBe('part');
    expect(v1('model')?.level).toBe('plant');
    expect(v1('assembly')?.level).toBe('assembly');

    // Everything else about a v1 block is read exactly as before…
    const full = parseShareMeta({
      [RV_SHARE_KEY]: {
        v: 1, name: 'Cell', author: 'T', license: 'CC-BY-4.0', level: 'model',
        category: 'machine', tags: ['a'], footprintMm: [100, 200],
        homepage: 'https://example.test/', allowDownload: false,
      },
    });
    expect(full).toEqual({
      v: 2, name: 'Cell', author: 'T', license: 'CC-BY-4.0', level: 'plant',
      category: 'machine', tags: ['a'], footprintMm: [100, 200],
      homepage: 'https://example.test/', allowDownload: false,
    });

    // …and a v1 file loaded through the real loader reports the mapped level.
    const root = await reload(await exportAssetGlb(
      flatAsset(), 'Cell', { v: 1, name: 'Cell', level: 'component' as never },
    ));
    // The export re-stamps at the current version; the level it was handed is
    // normalised on read either way.
    expect(parseShareMeta(root.userData)?.level).toBe('part');
  });

  it('shareLink_BuildsAndParsesRoundTrip', () => {
    const base = 'https://web.realvirtual.test/';

    const opaque = buildShareViewerLink('abc123', { base });
    expect(parseGlbParam(new URL(opaque).searchParams.get('glb')!))
      .toEqual({ kind: 'opaque', id: 'abc123' });

    // An id with characters that need encoding survives intact.
    const odd = buildShareViewerLink('a+b/c=d', { base });
    expect(parseGlbParam(new URL(odd).searchParams.get('glb')!))
      .toEqual({ kind: 'opaque', id: 'a+b/c=d' });

    const foreign = 'https://raw.githubusercontent.test/me/repo/main/my cell.glb?v=2';
    const own = buildOwnUrlShareLink(foreign, { base });
    const parsedOwn = parseGlbParam(new URL(own).searchParams.get('glb')!);
    expect(parsedOwn.kind).toBe('url');
    expect(new URL((parsedOwn as { url: string }).url).pathname).toContain('my%20cell.glb');

    // `&mode=` survives, because it is the sender's explicit override (F2).
    expect(buildShareViewerLink('x', { base, mode: 'planner' })).toContain('mode=planner');

    // The scheme whitelist is the same one the fetch uses — one rule, one place.
    expect(() => buildOwnUrlShareLink('javascript:alert(1)', { base })).toThrow();
    expect(() => parseGlbParam('')).toThrow();
  });
});
