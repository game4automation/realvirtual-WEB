// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-413 §9.1 + §9.9 — the classification travels in the bytes.
 *
 * The whole plan rests on one claim: *what a document is* lives inside the GLB,
 * so it survives a share, an export, a copy between libraries and a re-import
 * with nothing else attached (§2.3). A manifest that remembers "assembly" is a
 * cache; the file is the answer. That is only true if the round trip is real,
 * so these tests go through the actual bake (JSON-chunk patch) and the actual
 * loader — never through a hand-built userData object.
 *
 * Three properties are load-bearing and each has its own group:
 *
 *  - **round trip** — write, reload, read back the same thing;
 *  - **the BIN tail is untouched** — a classification must be stampable onto a
 *    100 MB model without re-encoding a vertex, which is what makes it cheap
 *    enough to write on every save (§5.2);
 *  - **nothing ever throws** — the entire Unity export corpus is unclassified
 *    and must keep loading unchanged (F5).
 *
 * §9.9 adds the canonical-scene rule (SOL R1-8): classification and `rv_share`
 * both address `json.scene ?? 0`, including when that is not 0.
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { BoxGeometry, Group, Mesh, MeshStandardMaterial, Object3D, Scene } from 'three';

import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';

import { objectToGlb } from '../src/core/import/rv-import-object';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { readClassificationFromScene } from '../src/core/hmi/scene/rv-scene-glb-read';
import { writeClassification } from '../src/core/hmi/scene/rv-scene-glb-bake';
import {
  DOCUMENT_LEVELS,
  LEGACY_LEVEL_MAP,
  RV_CLASSIFICATION_KEY,
  classificationEquals,
  classificationPayload,
  documentLevelLabel,
  isEmptyClassification,
  normaliseDocumentLevel,
  normaliseTags,
  parseClassification,
  type DocumentClassification,
} from '../src/core/project/rv-document-classification';
import {
  RV_SHARE_KEY,
  RV_SHARE_VERSION,
  parseShareMeta,
} from '../src/core/share/rv-share-meta';
import {
  defaultSceneExtras,
  ensureDefaultSceneExtras,
  parseGlbChunks,
  rebuildGlbWithJson,
} from '../src/core/persistence/rv-glb-chunks';

const material = new MeshStandardMaterial({ color: 0x334455 });

function buildTree(): Group {
  const root = new Group();
  root.name = 'Cell';
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = 'Ram';
  mesh.userData.realvirtual = { Drive: { Direction: 'LinearY', TargetSpeed: 250 } };
  root.add(mesh);
  return root;
}

let sourceBytes: ArrayBuffer;

beforeEach(async () => {
  sourceBytes = await objectToGlb(buildTree());
});

/** Patch a classification into raw GLB bytes, the way the bake does. */
function stamp(
  bytes: ArrayBuffer | Uint8Array,
  classification: DocumentClassification | null | undefined,
): { glb: Uint8Array; written: boolean } {
  const chunks = parseGlbChunks(bytes);
  const written = writeClassification(chunks.json, classification);
  return { glb: rebuildGlbWithJson(chunks), written };
}

async function load(bytes: ArrayBuffer | Uint8Array): Promise<Object3D> {
  const source = bytes instanceof Uint8Array
    ? bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer
    : bytes.slice(0);
  const result = await loadGLB('cell.glb', new Scene(), {
    data: source,
    preserveHierarchy: true,
    loadKinematicsSidecar: false,
  });
  return result.root;
}

/** Reload through the plain GLTFLoader — the exporter's own round trip. */
async function reloadScene(buffer: ArrayBuffer): Promise<Object3D> {
  const parsed = await new GLTFLoader().parseAsync(buffer, '');
  new Scene().add(parsed.scene);
  return parsed.scene;
}

/** The BIN chunk, as an opaque tail — what must stay byte-identical. */
function binTail(bytes: Uint8Array | ArrayBuffer): Uint8Array {
  const chunks = parseGlbChunks(bytes);
  return chunks.bytes.subarray(chunks.restOffset);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

// ─── Round trip through the real loader ─────────────────────────────────

describe('plan-413 §9.1 — classification round trip', () => {
  it('classification_RoundTripsThroughBakeAndLoad', async () => {
    const { glb, written } = stamp(sourceBytes, {
      v: 1, level: 'assembly', tags: ['presse', 'kuka'],
    });
    expect(written).toBe(true);

    const root = await load(glb);
    const read = readClassificationFromScene(root);
    expect(read).toEqual({ v: 1, level: 'assembly', tags: ['presse', 'kuka'] });
  });

  it('classification_EveryLevelSurvivesTheRoundTrip', async () => {
    for (const level of DOCUMENT_LEVELS) {
      const { glb } = stamp(sourceBytes, { v: 1, level });
      const root = await load(glb);
      expect(readClassificationFromScene(root)?.level).toBe(level);
    }
  });

  it('classification_LevelOnlyAndTagsOnlyAreBothValid', async () => {
    const levelOnly = await load(stamp(sourceBytes, { v: 1, level: 'plant' }).glb);
    expect(readClassificationFromScene(levelOnly)).toEqual({ v: 1, level: 'plant' });

    const tagsOnly = await load(stamp(sourceBytes, { v: 1, tags: ['linie3'] }).glb);
    expect(readClassificationFromScene(tagsOnly)).toEqual({ v: 1, tags: ['linie3'] });
  });

  it('classification_SurvivesARepeatedStamp', async () => {
    // Saving twice must not accumulate or drop anything — the block is
    // replaced wholesale, never merged.
    const once = stamp(sourceBytes, { v: 1, level: 'part', tags: ['a'] }).glb;
    const twice = stamp(once, { v: 1, level: 'plant', tags: ['b'] }).glb;
    expect(readClassificationFromScene(await load(twice)))
      .toEqual({ v: 1, level: 'plant', tags: ['b'] });
  });
});

// ─── clearWhenUnset semantics ───────────────────────────────────────────

describe('plan-413 §9.1 — undefined vs. null vs. empty', () => {
  it('classification_UndefinedLeavesAnAuthoredBlockAlone', async () => {
    // The reason this matters: a bake that only folds one field change into a
    // model must not delete a classification it was never told about.
    const stamped = stamp(sourceBytes, { v: 1, level: 'assembly' }).glb;
    const untouched = stamp(stamped, undefined);
    expect(untouched.written).toBe(false);
    expect(readClassificationFromScene(await load(untouched.glb))?.level).toBe('assembly');
  });

  it('classification_NullClearsTheBlock', async () => {
    const stamped = stamp(sourceBytes, { v: 1, level: 'assembly', tags: ['x'] }).glb;
    const cleared = stamp(stamped, null);
    expect(cleared.written).toBe(false);
    expect(readClassificationFromScene(await load(cleared.glb))).toBeNull();
  });

  it('classification_EmptyIsTreatedAsCleared', async () => {
    // "classified as nothing" and "never classified" must be one state on disk,
    // otherwise the §2.5 cache comparison flaps between them forever.
    const stamped = stamp(sourceBytes, { v: 1, level: 'plant' }).glb;
    const emptied = stamp(stamped, { v: 1, tags: [] });
    expect(emptied.written).toBe(false);

    const chunks = parseGlbChunks(emptied.glb);
    const rv = defaultSceneExtras(chunks.json)?.realvirtual as Record<string, unknown>;
    expect(rv?.[RV_CLASSIFICATION_KEY]).toBeUndefined();
  });

  it('classification_ClearingOnAnUnclassifiedFileIsANoOp', async () => {
    const cleared = stamp(sourceBytes, null);
    expect(cleared.written).toBe(false);
    expect(readClassificationFromScene(await load(cleared.glb))).toBeNull();
  });
});

// ─── The BIN tail is never touched ──────────────────────────────────────

describe('plan-413 §9.1 — the JSON chunk only', () => {
  it('classification_BinChunkIsByteIdenticalAfterTheStamp', () => {
    const before = binTail(sourceBytes);
    const after = binTail(stamp(sourceBytes, { v: 1, level: 'plant', tags: ['t'] }).glb);
    expect(after.byteLength).toBeGreaterThan(0);
    expect(sameBytes(before, after)).toBe(true);
  });

  it('classification_NodeExtrasAreLeftAlone', async () => {
    const root = await load(stamp(sourceBytes, { v: 1, level: 'part' }).glb);
    let ram: Object3D | null = null;
    root.traverse((n) => { if (!ram && n.name === 'Ram') ram = n; });
    const rv = (ram as unknown as Object3D).userData.realvirtual as Record<string, Record<string, unknown>>;
    expect(rv.Drive.TargetSpeed).toBe(250);
    // File-level data has no business on a node.
    expect(rv[RV_CLASSIFICATION_KEY]).toBeUndefined();
  });
});

// ─── Defensive parsing (F5) ─────────────────────────────────────────────

describe('plan-413 §9.1 — an unclassified or malformed file never throws', () => {
  it('classification_UnstampedGlbReadsAsNull', async () => {
    // The entire Unity export corpus answers this. It is a display state
    // ("unclassified"), not an error.
    expect(readClassificationFromScene(await load(sourceBytes))).toBeNull();
  });

  it('classification_MalformedBlocksYieldNullOrPartial', () => {
    expect(parseClassification(undefined)).toBeNull();
    expect(parseClassification(null)).toBeNull();
    expect(parseClassification('nonsense')).toBeNull();
    expect(parseClassification([])).toBeNull();
    expect(parseClassification({})).toBeNull();
    expect(parseClassification({ [RV_CLASSIFICATION_KEY]: 'nope' })).toBeNull();
    expect(parseClassification({ [RV_CLASSIFICATION_KEY]: [] })).toBeNull();
    // Unknown version: refused rather than misreported.
    expect(parseClassification({ [RV_CLASSIFICATION_KEY]: { v: 99, level: 'part' } })).toBeNull();

    // Wrong field types are dropped one by one; what is provable survives.
    const partial = parseClassification({
      [RV_CLASSIFICATION_KEY]: { v: 1, level: 'planet', tags: 'not-an-array' },
    });
    expect(partial).toEqual({ v: 1 });

    const halfGood = parseClassification({
      [RV_CLASSIFICATION_KEY]: { v: 1, level: 'assembly', tags: ['ok', 42, '', '  ', 'ok'] },
    });
    expect(halfGood).toEqual({ v: 1, level: 'assembly', tags: ['ok'] });
  });

  it('classification_HostileBlockDoesNotBreakTheLoad', async () => {
    const chunks = parseGlbChunks(sourceBytes);
    const rv = (ensureDefaultSceneExtras(chunks.json).realvirtual ??= {}) as Record<string, unknown>;
    rv[RV_CLASSIFICATION_KEY] = { v: 1, level: { nested: true }, tags: [{ a: 1 }] };
    const root = await load(rebuildGlbWithJson(chunks));
    expect(readClassificationFromScene(root)).toEqual({ v: 1 });
  });
});

// ─── Level normalisation and the legacy map ─────────────────────────────

describe('plan-413 §9.1 — legacy level mapping', () => {
  it('level_MapsV1SpellingsAndRejectsTheRest', () => {
    expect(normaliseDocumentLevel('component')).toBe('part');
    expect(normaliseDocumentLevel('model')).toBe('plant');
    expect(LEGACY_LEVEL_MAP.component).toBe('part');
    expect(LEGACY_LEVEL_MAP.model).toBe('plant');

    for (const level of DOCUMENT_LEVELS) expect(normaliseDocumentLevel(level)).toBe(level);
    expect(normaliseDocumentLevel('  assembly  ')).toBe('assembly');

    expect(normaliseDocumentLevel('planet')).toBeUndefined();
    expect(normaliseDocumentLevel('')).toBeUndefined();
    expect(normaliseDocumentLevel(7)).toBeUndefined();
    expect(normaliseDocumentLevel(null)).toBeUndefined();
  });

  it('level_LabelsCoverEveryValueIncludingAbsence', () => {
    expect(documentLevelLabel('part')).toBe('Part');
    expect(documentLevelLabel('assembly')).toBe('Assembly');
    expect(documentLevelLabel('plant')).toBe('Plant');
    expect(documentLevelLabel('scene')).toBe('Scene');
    expect(documentLevelLabel(undefined)).toBe('Unclassified');
    expect(documentLevelLabel(null)).toBe('Unclassified');
  });

  it('level_LegacySpellingsAreNeverWrittenBack', () => {
    // The mapped value is what goes into the file; the v1 words are read-only.
    const payload = classificationPayload({ v: 1, level: 'component' as never });
    expect(payload.level).toBe('part');
    expect(classificationPayload({ v: 1, level: 'model' as never }).level).toBe('plant');
  });
});

// ─── Tags ───────────────────────────────────────────────────────────────

describe('plan-413 §9.1 — tag normalisation', () => {
  it('tags_TrimDedupeAndPreserveOrder', () => {
    expect(normaliseTags([' b ', 'a', 'b', '', '  ', 'a', 'c'])).toEqual(['b', 'a', 'c']);
    expect(normaliseTags([])).toBeUndefined();
    expect(normaliseTags(['   '])).toBeUndefined();
    expect(normaliseTags('nope')).toBeUndefined();
  });

  it('tags_CaseIsPreserved', () => {
    // Deciding which spelling survives would mean silently rewriting what the
    // user typed — worse than two chips he can merge himself.
    expect(normaliseTags(['Presse', 'presse'])).toEqual(['Presse', 'presse']);
  });
});

// ─── Cache comparison helpers (§2.5) ────────────────────────────────────

describe('plan-413 §2.5 — cache comparison', () => {
  it('classification_EqualityIgnoresWhitespaceButNotOrder', () => {
    expect(classificationEquals(
      { v: 1, level: 'plant', tags: ['a', 'b'] },
      { v: 1, level: 'plant', tags: [' a ', 'b'] },
    )).toBe(true);
    expect(classificationEquals(
      { v: 1, level: 'plant', tags: ['a', 'b'] },
      { v: 1, level: 'plant', tags: ['b', 'a'] },
    )).toBe(false);
    expect(classificationEquals({ v: 1, level: 'plant' }, { v: 1, level: 'part' })).toBe(false);
  });

  it('classification_AllTheEmptyShapesCompareEqual', () => {
    expect(classificationEquals(null, undefined)).toBe(true);
    expect(classificationEquals(null, { v: 1 })).toBe(true);
    expect(classificationEquals({ v: 1, tags: [] }, undefined)).toBe(true);
    expect(classificationEquals(null, { v: 1, level: 'part' })).toBe(false);

    expect(isEmptyClassification(undefined)).toBe(true);
    expect(isEmptyClassification({ v: 1 })).toBe(true);
    expect(isEmptyClassification({ v: 1, level: 'part' })).toBe(false);
    expect(isEmptyClassification({ v: 1, tags: ['x'] })).toBe(false);
  });
});

// ─── §9.9: the canonical default-scene rule (SOL R1-8) ──────────────────

describe('plan-413 §9.9 — classification and rv_share address json.scene ?? 0', () => {
  /** Prepend a decoy scene and point `json.scene` at the real one. */
  function withSceneIndexOne(bytes: ArrayBuffer | Uint8Array): Uint8Array {
    const chunks = parseGlbChunks(bytes);
    const scenes = chunks.json.scenes as Record<string, unknown>[];
    scenes.unshift({ nodes: [], extras: { realvirtual: { Decoy: true } } });
    chunks.json.scene = 1;
    return rebuildGlbWithJson(chunks);
  }

  it('classification_WritesAndReadsTheDeclaredDefaultScene', () => {
    const shifted = withSceneIndexOne(sourceBytes);
    const { glb } = stamp(shifted, { v: 1, level: 'assembly' });

    const chunks = parseGlbChunks(glb);
    expect(chunks.json.scene).toBe(1);
    const scenes = chunks.json.scenes as { extras?: Record<string, unknown> }[];

    // Scene 1 is the declared default and carries the block…
    const rv1 = scenes[1].extras?.realvirtual as Record<string, unknown>;
    expect((rv1[RV_CLASSIFICATION_KEY] as Record<string, unknown>).level).toBe('assembly');

    // …scene 0 is a bystander and must be left exactly as it was.
    const rv0 = scenes[0].extras?.realvirtual as Record<string, unknown>;
    expect(rv0.Decoy).toBe(true);
    expect(rv0[RV_CLASSIFICATION_KEY]).toBeUndefined();
  });

  it('classification_ClearingAlsoFollowsTheDeclaredDefaultScene', () => {
    const stamped = stamp(withSceneIndexOne(sourceBytes), { v: 1, level: 'plant' }).glb;
    const cleared = stamp(stamped, null).glb;
    const scenes = parseGlbChunks(cleared).json.scenes as { extras?: Record<string, unknown> }[];
    const rv1 = scenes[1].extras?.realvirtual as Record<string, unknown>;
    expect(rv1[RV_CLASSIFICATION_KEY]).toBeUndefined();
  });

  it('classification_MissingDefaultSceneIsCreatedRatherThanGuessed', () => {
    const chunks = parseGlbChunks(sourceBytes);
    delete chunks.json.scenes;
    delete chunks.json.scene;
    expect(writeClassification(chunks.json, { v: 1, level: 'part' })).toBe(true);
    expect(chunks.json.scene).toBe(0);
    const scenes = chunks.json.scenes as { extras?: Record<string, unknown> }[];
    const rv = scenes[0].extras?.realvirtual as Record<string, unknown>;
    expect((rv[RV_CLASSIFICATION_KEY] as Record<string, unknown>).level).toBe('part');
  });

  it('classification_SurvivesAnAssetEditorReExport', async () => {
    // plan-413 phase 1, last item: unlike `rv_share`, the classification is
    // PRESERVED rather than stripped on re-export. It describes the content,
    // not its publisher — re-saving somebody's assembly must not quietly turn
    // it back into an unclassified blob.
    const root = new Group();
    root.name = 'Asset';
    root.userData.realvirtual = {
      [RV_CLASSIFICATION_KEY]: { v: 1, level: 'assembly', tags: ['presse'] },
    };
    const axis = new Object3D();
    axis.name = 'Axis';
    root.add(axis);

    const kept = await reloadScene(await exportAssetGlb(root, 'Cell'));
    expect(readClassificationFromScene(kept))
      .toEqual({ v: 1, level: 'assembly', tags: ['presse'] });

    // An explicit value replaces it; `null` clears it.
    const replaced = await reloadScene(
      await exportAssetGlb(root, 'Cell', null, { v: 1, level: 'plant' }));
    expect(readClassificationFromScene(replaced)).toEqual({ v: 1, level: 'plant' });

    const cleared = await reloadScene(await exportAssetGlb(root, 'Cell', null, null));
    expect(readClassificationFromScene(cleared)).toBeNull();
  });

  it('classification_IsLiftedToTheSceneNotDuplicatedOntoTheContentNode', async () => {
    // The transformed-root branch keeps a content node below the scene. The
    // shallow userData copy would otherwise put the same file-level block in
    // both places, and §2.5 ("GLB wins") cannot resolve a file that answers
    // "what is this document" twice.
    const root = new Group();
    root.name = 'Asset';
    root.position.set(0, 100, 0);
    root.userData.realvirtual = { [RV_CLASSIFICATION_KEY]: { v: 1, level: 'plant' } };
    const axis = new Object3D();
    axis.name = 'Axis';
    root.add(axis);

    const scene = await reloadScene(await exportAssetGlb(root, 'Cell'));
    expect(readClassificationFromScene(scene)).toEqual({ v: 1, level: 'plant' });

    let blocks = 0;
    scene.traverse((n) => {
      const rv = (n.userData as Record<string, unknown>)['realvirtual'];
      if (rv && typeof rv === 'object' && RV_CLASSIFICATION_KEY in rv) blocks++;
    });
    expect(blocks).toBe(1);
  });

  it('shareMeta_IsNotMovedByTheClassificationWrite', async () => {
    // SOL R1-8: only the level ENUM is shared. `rv_share` keeps its own key in
    // its own place, and stamping a classification must not touch it.
    const chunks = parseGlbChunks(sourceBytes);
    const extras = ensureDefaultSceneExtras(chunks.json);
    extras[RV_SHARE_KEY] = { v: 1, name: 'Cell', level: 'model', author: 'T' };
    const withShare = rebuildGlbWithJson(chunks);

    const { glb } = stamp(withShare, { v: 1, level: 'part' });
    const root = await load(glb);

    // The share block is still there, still under its own key…
    const meta = parseShareMeta(root.userData);
    expect(meta?.name).toBe('Cell');
    // …and its v1 `model` came back as the shared `plant` spelling.
    expect(meta?.level).toBe('plant');
    expect(meta?.v).toBe(RV_SHARE_VERSION);

    // The classification is a separate, independent block.
    expect(readClassificationFromScene(root)).toEqual({ v: 1, level: 'part' });
  });
});
