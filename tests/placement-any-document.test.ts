// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-716 §9.5 — every document is placeable, and both cycle guards hold.
 *
 * ## What changed, and what therefore has to be re-proven
 *
 * Before this plan the catalog fed only `library/`, so the only compositions
 * anybody could build were "layout references a library part". Phase 5 feeds it
 * `listDocuments()` — every section — which makes three new shapes reachable:
 * a `scenes/` document inside another `scenes/` document (layout in layout), a
 * `models/` document inside a layout, and, by the same token, a document
 * referencing ITSELF.
 *
 * The guards for all three already exist; what did not exist is any test that
 * they cover the new combinations. That is the whole content of this file.
 *
 * ## Two guards, two jobs — and the seam between them
 *
 * `compose()` refuses on LOAD (`ReferenceCycleError` / `ReferenceDepthError`):
 * it has the referenced bytes, so it sees the whole transitive graph.
 * `bakeIntoGlb()` refuses on SAVE (`SaveReferenceCycleError`), and only for
 * what is decidable WITHOUT fetching — a reference back to this file, and a
 * nested reference to the same asset inside this one file.
 *
 * The last block below pins the seam itself: a cross-file chain a → b → a is
 * NOT refused at save. That is not a gap to be fixed by adding a fetch to the
 * writer; it is the documented division of labour, and a test that asserted the
 * opposite would be asking the save path to become the load path.
 *
 * ## The section is never consulted
 *
 * No assertion here reads `section`. That is the point of F7: `scenes/`,
 * `models/` and `library/` are folders, the guard keys on identity
 * (`assetId`, else the resolved path), and a rule that treated one folder as
 * unplaceable would be the storage split coming back through the front door.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { Group, Mesh, BoxGeometry, MeshStandardMaterial, Object3D } from 'three';
import { objectToGlb } from '../src/core/import/rv-import-object';
import {
  compose,
  ReferenceCycleError,
  ReferenceDepthError,
  type ReferenceResolver,
} from '../src/core/engine/rv-glb-compose';
import { MAX_REFERENCE_DEPTH, setAssetReference } from '../src/core/engine/rv-asset-reference';
import {
  bakeIntoGlb,
  makeRegistryBakeResolver,
  SaveReferenceCycleError,
  type BakeResolver,
} from '../src/core/hmi/scene/rv-scene-glb-bake';
import { materialise, type MaterialisedEdits } from '../src/core/hmi/scene/rv-scene-edits';
import { loadGLB } from '../src/core/engine/rv-scene-loader';
import { Scene } from 'three';
import type { RvOp } from '../src/core/ops/rv-unified-ops';
import type { PlacedComponent } from '../src/plugins/layout-planner/rv-layout-store';

// ─── Fixtures ───────────────────────────────────────────────────────────

const material = new MeshStandardMaterial({ color: 0x556677 });

function meshNamed(name: string): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.name = name;
  return mesh;
}

/** A reference node — no content of its own, just the pointer. */
function referenceNode(name: string, ref: Parameters<typeof setAssetReference>[1]): Object3D {
  const node = new Object3D();
  node.name = name;
  setAssetReference(node, ref);
  return node;
}

/**
 * A document tree: one mesh plus a reference per entry in `refs`.
 *
 * Deliberately section-agnostic — `documentTree('Layout', ['doc_part'])` is the
 * same call whether the result is meant to live in `scenes/` or in `library/`.
 */
function documentTree(name: string, refs: string[] = []): Group {
  const root = new Group();
  root.name = name;
  root.add(meshNamed(`${name}_Body`));
  refs.forEach((assetId, i) => root.add(referenceNode(`${name}_Ref_${i}`, { assetId })));
  return root;
}

interface Doc {
  bytes: ArrayBuffer;
  /** The project-relative path — where the bytes live. Never a placeability input. */
  path: string;
  sha256: string;
}

async function documentFixture(tree: Object3D, path: string, sha256: string): Promise<Doc> {
  return { bytes: await objectToGlb(tree), path, sha256 };
}

/** A resolver over a table keyed by documentId. */
function docResolver(table: Record<string, Doc>): ReferenceResolver {
  return async (ref, context) => {
    const hit = table[ref.assetId] ?? table[context.resolvedPath];
    if (!hit) return null;
    return {
      bytes: hit.bytes,
      url: hit.path,
      sha256: hit.sha256,
      signatureState: 'none',
      signaturePresent: false,
    };
  };
}

// ─── Insert: layout in layout, across every section ─────────────────────

describe('any document is placeable in any other (F7, insert path)', () => {
  it('composes a LAYOUT inside a LAYOUT — two scenes/ documents, one tree', async () => {
    // The shape the old catalog could not produce at all: the inner document
    // is a saved layout, not a library part.
    const inner = await documentFixture(
      documentTree('InnerLine'), 'scenes/InnerLine.glb', 'sha-inner');
    const outer = documentTree('OuterPlant', ['doc_inner']);

    const result = await compose(outer, {
      baseUrl: 'scenes/OuterPlant.glb',
      assetId: 'doc_outer',
      resolve: docResolver({ doc_inner: inner }),
    });

    expect(result.missing).toEqual([]);
    expect(result.frames.map(f => f.assetId)).toEqual(['doc_inner']);
    expect(result.frames[0]!.depth).toBe(1);
    result.dispose();
  });

  it('mixes all three sections in one composition — the folder decides nothing', async () => {
    const part = await documentFixture(
      documentTree('Part'), 'library/Part.glb', 'sha-part');
    const base = await documentFixture(
      documentTree('BaseModel'), 'models/BaseModel.glb', 'sha-base');
    const line = await documentFixture(
      documentTree('Line', ['doc_part']), 'scenes/Line.glb', 'sha-line');

    const plant = documentTree('Plant', ['doc_line', 'doc_base']);
    const result = await compose(plant, {
      baseUrl: 'scenes/Plant.glb',
      assetId: 'doc_plant',
      resolve: docResolver({ doc_part: part, doc_base: base, doc_line: line }),
    });

    expect(result.missing).toEqual([]);
    // scenes/ → scenes/ → library/, plus models/ beside it. Four documents,
    // three folders, one tree.
    expect(result.frames.map(f => f.assetId).sort())
      .toEqual(['doc_base', 'doc_line', 'doc_part']);
    expect(result.frames.find(f => f.assetId === 'doc_part')!.depth).toBe(2);
    result.dispose();
  });
});

// ─── Insert: the cycle guard ────────────────────────────────────────────

describe('the insert-time cycle guard covers the new combinations', () => {
  it('refuses a layout that places ITSELF', async () => {
    const self = await documentFixture(
      documentTree('Plant'), 'scenes/Plant.glb', 'sha-plant');
    const plant = documentTree('Plant', ['doc_plant']);

    await expect(compose(plant, {
      baseUrl: 'scenes/Plant.glb',
      assetId: 'doc_plant',
      resolve: docResolver({ doc_plant: self }),
    })).rejects.toBeInstanceOf(ReferenceCycleError);
  });

  it('refuses a CHAIN cycle a → b → a, across two sections', async () => {
    // The two documents even live in different folders — which changes nothing,
    // because the guard keys on identity.
    const a = await documentFixture(
      documentTree('A', ['doc_b']), 'scenes/A.glb', 'sha-a');
    const b = await documentFixture(
      documentTree('B', ['doc_a']), 'library/B.glb', 'sha-b');

    const root = documentTree('Root', ['doc_a']);
    await expect(compose(root, {
      baseUrl: 'scenes/Root.glb',
      assetId: 'doc_root',
      resolve: docResolver({ doc_a: a, doc_b: b }),
    })).rejects.toBeInstanceOf(ReferenceCycleError);
  });

  it('names the trail it refused, so the user can find the offending row', async () => {
    const a = await documentFixture(
      documentTree('A', ['doc_b']), 'scenes/A.glb', 'sha-a');
    const b = await documentFixture(
      documentTree('B', ['doc_a']), 'library/B.glb', 'sha-b');
    const root = documentTree('Root', ['doc_a']);

    const error: unknown = await compose(root, {
      baseUrl: 'scenes/Root.glb',
      assetId: 'doc_root',
      resolve: docResolver({ doc_a: a, doc_b: b }),
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReferenceCycleError);
    expect((error as ReferenceCycleError).trail)
      .toEqual(['doc_root', 'doc_a', 'doc_b', 'doc_a']);
  });

  it('allows the same document twice in one tree — a DAG is not a cycle', async () => {
    const part = await documentFixture(
      documentTree('Part'), 'library/Part.glb', 'sha-part');
    const plant = documentTree('Plant', ['doc_part', 'doc_part']);

    const result = await compose(plant, {
      baseUrl: 'scenes/Plant.glb',
      assetId: 'doc_plant',
      resolve: docResolver({ doc_part: part }),
    });
    expect(result.frames).toHaveLength(2);
    // One load for two occurrences: the cache keys on identity too.
    expect(result.loads).toBe(1);
    result.dispose();
  });

  it('stops at maxDepth on a corrupted manifest whose rows nest forever', async () => {
    // "Prepared manifest corruption": every row points at the next one and the
    // chain never closes, so the CYCLE guard never fires. Without the depth
    // ceiling this composition would run until the tab died.
    const chain: ReferenceResolver = async (ref) => {
      const n = Number(/^doc_(\d+)$/.exec(ref.assetId ?? '')?.[1] ?? NaN);
      if (Number.isNaN(n)) return null;
      const bytes = await objectToGlb(documentTree(`Link${n}`, [`doc_${n + 1}`]));
      return {
        bytes, url: `scenes/Link${n}.glb`, sha256: `sha-${n}`,
        signatureState: 'none', signaturePresent: false,
      };
    };

    const root = documentTree('Root', ['doc_0']);
    const error: unknown = await compose(root, {
      baseUrl: 'scenes/Root.glb',
      assetId: 'doc_root',
      resolve: chain,
    }).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ReferenceDepthError);
    expect((error as ReferenceDepthError).depth).toBe(MAX_REFERENCE_DEPTH + 1);
  });
});

// ─── Insert: a referenced document that was deleted ─────────────────────

describe('deleting a referenced document (the orphan case)', () => {
  it('reports it as a missing reference with a placeholder — never a crash', async () => {
    // The manifest row is gone, so the resolver answers null. The composition
    // must still produce a tree: a plant with one deleted part is a plant the
    // user has to be able to open in order to FIX it.
    const plant = documentTree('Plant', ['doc_deleted']);
    const result = await compose(plant, {
      baseUrl: 'scenes/Plant.glb',
      assetId: 'doc_plant',
      resolve: docResolver({}),
    });

    expect(result.frames).toEqual([]);
    expect(result.missing).toHaveLength(1);
    const orphan = result.missing[0]!;
    expect(orphan.assetId).toBe('doc_deleted');
    expect(orphan.reason).toBeTruthy();
    expect(orphan.label).toBeTruthy();
    // The stand-in is grafted, so the reference node is visible in the tree
    // rather than being an empty hole nobody can select.
    expect(orphan.placeholder.parent).toBe(orphan.referenceNode);
    result.dispose();
    // …and `dispose()` takes it back out, like every other graft.
    expect(orphan.placeholder.parent).toBeNull();
  });

  it('keeps composing the SIBLINGS of a deleted document', async () => {
    const alive = await documentFixture(
      documentTree('Alive'), 'models/Alive.glb', 'sha-alive');
    const plant = documentTree('Plant', ['doc_deleted', 'doc_alive']);

    const result = await compose(plant, {
      baseUrl: 'scenes/Plant.glb',
      assetId: 'doc_plant',
      resolve: docResolver({ doc_alive: alive }),
    });

    expect(result.missing.map(m => m.assetId)).toEqual(['doc_deleted']);
    expect(result.frames.map(f => f.assetId)).toEqual(['doc_alive']);
    result.dispose();
  });
});

// ─── Save: the second guard, on the same combinations ───────────────────

/** `addPlacement` of `catalogId`, the op a catalog insert produces. */
function placementOp(id: string, catalogId: string, glbUrl: string): RvOp {
  const placement: PlacedComponent = {
    id, catalogId, glbUrl, label: catalogId,
    position: [0, 0, 0], rotation: [0, 0, 0], scale: [1, 1, 1],
  } as PlacedComponent;
  return {
    id: `op_${id}`, ts: Date.now(), schemaV: 1, kind: 'addPlacement', placement,
  } as unknown as RvOp;
}

describe('the SAVE-path guard covers the same combinations (§9.5, F7)', () => {
  let plantBytes: ArrayBuffer;
  let resolver: BakeResolver;

  beforeAll(async () => {
    plantBytes = await objectToGlb(documentTree('Plant'));
    const loaded = await loadGLB('scenes/Plant.glb', new Scene(), {
      data: plantBytes.slice(0),
      preserveHierarchy: true,
      loadKinematicsSidecar: false,
      sourceSha256: 'sha-plant',
    });
    resolver = makeRegistryBakeResolver(loaded.registry, loaded.composition?.frames ?? []);
  });

  const bake = (edits: MaterialisedEdits, self: { assetId?: string; path?: string }) =>
    bakeIntoGlb(plantBytes, edits, resolver, { self });

  it('refuses to write a document that places ITSELF by id', async () => {
    await expect(bake(
      materialise([placementOp('plc_self', 'doc_plant', 'scenes/Plant.glb')]),
      { assetId: 'doc_plant' },
    )).rejects.toBeInstanceOf(SaveReferenceCycleError);
  });

  it('refuses it by PATH too — a document with no id is still itself', async () => {
    await expect(bake(
      materialise([placementOp('plc_self', '', 'scenes/Plant.glb')]),
      { path: 'scenes/Plant.glb' },
    )).rejects.toBeInstanceOf(SaveReferenceCycleError);
  });

  it('accepts a placement of a DIFFERENT document, in any section', async () => {
    for (const [catalogId, url] of [
      ['doc_part', 'library/Part.glb'],
      ['doc_base', 'models/Base.glb'],
      ['doc_line', 'scenes/Line.glb'],
    ] as const) {
      const result = await bake(
        materialise([placementOp(`plc_${catalogId}`, catalogId, url)]),
        { assetId: 'doc_plant', path: 'scenes/Plant.glb' },
      );
      expect(result.glb.byteLength).toBeGreaterThan(0);
      expect(result.writtenReferences.map(r => r.assetId)).toContain(catalogId);
    }
  });

  it('accepts the same document placed twice — the save DAG rule matches the load one', async () => {
    const result = await bake(
      materialise([
        placementOp('plc_a', 'doc_part', 'library/Part.glb'),
        placementOp('plc_b', 'doc_part', 'library/Part.glb'),
      ]),
      { assetId: 'doc_plant' },
    );
    expect(result.writtenReferences.filter(r => r.assetId === 'doc_part')).toHaveLength(2);
  });

  it('leaves a CROSS-FILE chain to the load guard — the documented seam', async () => {
    // a → b → a is a real cycle, and this writer cannot see it: deciding it
    // needs b's bytes. `compose()` refuses it on the next load (asserted
    // above); the save path must not pretend to and must not fetch.
    const result = await bake(
      materialise([placementOp('plc_b', 'doc_b', 'library/B.glb')]),
      { assetId: 'doc_a', path: 'scenes/A.glb' },
    );
    expect(result.writtenReferences.map(r => r.assetId)).toEqual(['doc_b']);
  });
});
