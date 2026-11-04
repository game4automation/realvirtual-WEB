// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 9.20 — decode-path parity (node part, Phase 1a).
 *
 * The same GLB bytes through every decode site of Inventory D — the parse wrapper
 * itself (D5: the document replace D7 goes through it), the main model load
 * (D1, `loadGLB`), the subtree parse (D2, compose frames / editor import), the
 * ModelCache decode of a placement (D3) and the scene-save re-parse (D4, ids only)
 * — and through the Node twin (`rv-node-id-seed.mjs` + `rv-reference-migration.mjs`
 * over `scripts/lib/rv-glb-nodes.mjs`' loader replica): identical ids, identical
 * authored paths, identical migrated addresses. For shipped GLBs the migration
 * verdicts also reproduce the Phase-0 baseline snapshot (`via` counts per file).
 */
import { afterEach, describe, expect, it } from 'vitest';
import type { Object3D } from 'three';
import { parseGlbCollectingResources } from '../src/core/engine/rv-binary-resources';
import { gltfLoader, parseGlbSubtreeWithMeta } from '../src/core/engine/rv-glb-parse';
import { decodeIdentity, getDecodeIdentity, identityIdOf, type FileIdentity } from '../src/core/engine/rv-decode-identity';
import { seedNodeIdsForFile } from '../src/core/engine/rv-node-id-seed.mjs';
import { enumerateReferences, insideReferenceJson, listReferrers, migrateFileReferences } from '../src/core/engine/rv-reference-migration.mjs';
import { referenceLookup } from '../scripts/lib/rv-glb-nodes.mjs';
import { parseGlbChunks } from '../src/core/persistence/rv-glb-chunks';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { bootRealLoaderViewer, dataUrlOf, findByName, type Booted } from './helpers/nested-placement-fixture';
import { setAssetReference, setPlacementMeta } from '../src/core/engine/rv-asset-reference';
import { setNodeId } from '../src/core/engine/rv-node-id';
import { objectToGlb } from '../src/core/import/rv-import-object';
import { Group, Object3D as Obj } from 'three';
import { buildContentRootGlb, buildMauserCoreGlb } from './helpers/migrate-769-fixtures';
import baseline from './fixtures/reference-baseline.json';

type Json = Record<string, unknown> & { nodes?: Array<Record<string, unknown>> };

function jsonOf(bytes: ArrayBuffer): Json {
  return parseGlbChunks(bytes.slice(0)).json as Json;
}

/** The Node twin: seeds + the migration over the loader REPLICA (rv-glb-nodes.mjs). */
function nodeTwin(json: Json): { ids: Array<string | undefined>; rootId: string; addresses: Map<string, string | null>; vias: Record<string, number> } {
  const seed = seedNodeIdsForFile(json as never);
  const L = referenceLookup(json as never) as { rel: Array<string | undefined> & { names?: string[] }; parent: number[] };
  const { ctx, entries } = migrateFileReferences(json as never, { parent: L.parent, legacyPaths: L.rel });
  void ctx;
  const addresses = new Map<string, string | null>();
  const vias: Record<string, number> = {};
  for (const e of entries) {
    vias[e.mig.via] = (vias[e.mig.via] ?? 0) + 1;
    if (e.kind === 'name') continue;
    addresses.set(e.path, e.mig.idx === undefined ? null : `#${e.mig.idx === -1 ? seed.rootId : seed.ids[e.mig.idx]}`);
  }
  return { ids: seed.ids, rootId: seed.rootId, addresses, vias };
}

/** The identity record's answers for the same written paths. */
function addressesOf(identity: FileIdentity, paths: Iterable<string>): Map<string, string | null> {
  const out = new Map<string, string | null>();
  for (const p of paths) out.set(p, identity.migratePath(p).address ?? null);
  return out;
}

async function viaD5(bytes: ArrayBuffer): Promise<{ identity: FileIdentity; scene: Object3D; assoc: Map<Object3D, { nodes?: number }> }> {
  const gltf = await parseGlbCollectingResources(bytes.slice(0), 'parity-d5', gltfLoader);
  const scene = (gltf as unknown as { scene: Object3D }).scene;
  const assoc = (gltf as unknown as { parser: { associations: Map<Object3D, { nodes?: number }> } }).parser.associations;
  return { identity: getDecodeIdentity(scene)!, scene, assoc };
}

async function fixtures(): Promise<Array<[string, ArrayBuffer]>> {
  const out: Array<[string, ArrayBuffer]> = [
    ['mauser-core (renamed + re-parented)', await buildMauserCoreGlb()],
    ['content-root (wrapper scene)', await buildContentRootGlb()],
  ];
  for (const url of ['/library/PalletHandling/PalletScanner.glb', '/demo-realvirtual/fmu-demo.glb']) {
    const res = await fetch(url);
    if (res.ok) out.push([url, await res.arrayBuffer()]);
  }
  return out;
}

describe('plan-769 9.20 — decode-path parity', () => {
  let h: TestViewerHandle | null = null;
  let booted: Booted | null = null;
  afterEach(() => { h?.dispose(); h = null; booted?.h.dispose(); booted = null; });

  it('the parse wrapper stamps exactly the Node twin\'s ids on the decoded objects', async () => {
    for (const [label, bytes] of await fixtures()) {
      const json = jsonOf(bytes);
      const twin = nodeTwin(json);
      const { identity, scene, assoc } = await viaD5(bytes);
      expect(identity, label).not.toBeNull();
      expect([...identity.ids], label).toEqual(twin.ids);
      expect(identity.rootId, label).toBe(twin.rootId);
      expect(identityIdOf(scene), label).toBe(twin.rootId);
      for (const [obj, ref] of assoc) {
        if (!ref || ref.nodes === undefined || !(obj as { isObject3D?: boolean }).isObject3D) continue;
        expect(identityIdOf(obj), `${label} node ${ref.nodes}`).toBe(twin.ids[ref.nodes]);
      }
      // Migrated addresses: the browser (real loader names) equals the Node replica.
      expect(addressesOf(identity, twin.addresses.keys()), label).toEqual(twin.addresses);
    }
  });

  it('every decode site gives the same identity: D1 loadGLB, D2 subtree, D3 ModelCache, D4 writer re-parse, D5', async () => {
    const bytes = await buildMauserCoreGlb();
    const json = jsonOf(bytes);
    const twin = nodeTwin(json);
    const paths = [...twin.addresses.keys()];

    // D5
    const d5 = (await viaD5(bytes)).identity;
    // D2
    const sub = await parseGlbSubtreeWithMeta(bytes.slice(0));
    const d2 = sub.identity!;
    expect(getDecodeIdentity(sub.root)).toBe(d2);
    // D4 — the writer's re-parse: ids only (no migration)
    const g4 = await gltfLoader.parseAsync(bytes.slice(0), '');
    const d4 = decodeIdentity(g4 as never, { migrate: false })!;
    // D1
    h = await createTestViewer('webgl');
    await h.viewer.loadModel('mauser-core.glb', { data: bytes.slice(0) });
    const d1 = h.viewer.registry!.identityOfOccurrence('')!;

    for (const [site, id] of [['D1', d1], ['D2', d2], ['D4', d4], ['D5', d5]] as const) {
      expect([...id.ids], site).toEqual(twin.ids);
      expect(id.rootId, site).toBe(twin.rootId);
      for (const i of id.ids.keys()) if (id.ids[i]) expect(id.authoredPathOf(id.ids[i]!), `${site} ${i}`).toBe(d5.authoredPathOf(id.ids[i]!));
      if (site !== 'D4') expect(addressesOf(id, paths), site).toEqual(twin.addresses);
    }
    expect(d4.counts.references).toBe(0); // migrate:false
  });

  it('D3: a placement decoded by the ModelCache carries the same identity (real loader, data: url)', async () => {
    const assetBytes = await buildMauserCoreGlb();
    const twin = nodeTwin(jsonOf(assetBytes));
    const root = new Group();
    root.name = 'Layout';
    const ref = new Obj();
    ref.name = 'Cell_1';
    setNodeId(ref, 'nid-cell-1');
    setAssetReference(ref, { assetId: 'cat:mauser-core', path: dataUrlOf(assetBytes) });
    setPlacementMeta(ref, {});
    root.add(ref);
    booted = await bootRealLoaderViewer();
    await booted.h.viewer.loadModel('layout.glb', { data: await objectToGlb(root) });
    await booted.h.viewer.whenSceneReady();
    const reg = booted.h.viewer.registry!;
    const placed = findByName(booted.h.viewer.currentModelRoot!, 'Cell_1')!;
    const occ = reg.contentOccurrenceOf(placed)!;
    const d3 = reg.identityOfOccurrence(occ)!;
    expect(d3).not.toBeNull();
    expect([...d3.ids]).toEqual(twin.ids);
    expect(addressesOf(d3, twin.addresses.keys())).toEqual(twin.addresses);
    // A component of the PLACED asset resolves its legacy path by address in its own occurrence.
    const slave = findByName(placed, 'Slave')!;
    const r = reg.resolveRef(slave, { type: 'ComponentReference', path: 'CadB/Sep', componentType: 'realvirtual.Drive' });
    expect(r.status).toBe('resolved');
    expect(r.status === 'resolved' && r.address.startsWith(`${occ}#`)).toBe(true);
    // …and an authored path typed by a user reaches into the placement (9.16).
    expect(reg.findNodeForUser(`${reg.getPathForNode(placed)}/CadB/Sep`)?.node).toBe(r.status === 'resolved' ? r.node : null);
    expect(reg.auditIdIndex()).toEqual({ unindexed: [], stale: [], wrong: [] });
  });

  it('shipped GLBs: the decode reproduces the Phase-0 baseline snapshot (migration routes per file)', async () => {
    const snap = (baseline as unknown as { glbs: Record<string, { refs: { byVia: Record<string, number> } }> }).glbs;
    let checked = 0;
    for (const [label, bytes] of await fixtures()) {
      if (!label.startsWith('/')) continue;
      const want = snap[`public:public${label}`];
      expect(want, label).toBeDefined();
      const json = jsonOf(bytes);
      const { identity } = await viaD5(bytes);
      // Recompute the per-reference route through the identity record (browser, real loader names).
      const parent = (await import('../src/core/engine/rv-reference-migration.mjs')).sceneParents(json as never);
      const vias: Record<string, number> = {};
      for (const r of listReferrers(json as never, parent, (i) => i >= 0 && insideReferenceJson(json as never, parent, i))) {
        for (const e of enumerateReferences(r.extras)) {
          const ownerId = r.idx === -1 ? identity.rootId : identity.ids[r.idx]!;
          const m = e.kind === 'name' ? identity.migrateName(e.path, ownerId) : identity.migratePath(e.path);
          const via = m.address !== undefined ? m.via : 'unresolved';
          vias[via] = (vias[via] ?? 0) + 1;
        }
      }
      // The snapshot's `byVia` names the route of every reference (`unresolved` included).
      expect(vias, label).toEqual(want!.refs.byVia);
      checked++;
    }
    expect(checked, 'both shipped GLBs were served').toBe(2);
  });
});
