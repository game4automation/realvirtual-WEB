// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-769 test 9.1 — the deterministic NodeId seed (`rv-node-id-seed.mjs`).
 *
 * The SHA-1 inside the module is our own (synchronous, browser + Node), so it is
 * pinned against values we did NOT compute with it:
 *  - SHA-1: FIPS 180-2 Appendix A/B example messages ("abc", the 448-bit
 *    message), the empty string, and one million "a";
 *  - UUIDv5: RFC 9562 Appendix A.4 (namespace DNS, "www.example.com" →
 *    2ed6657d-e927-568b-95e1-2665a8aea6a2) and the Python `uuid` docs
 *    (`uuid.uuid5(uuid.NAMESPACE_DNS, 'python.org')` →
 *    886313e1-3b8a-5372-9b90-0c9aee199e5d);
 *  - a sweep against `node:crypto` SHA-1 over awkward inputs (multi-block,
 *    padding boundaries 55/56/63/64 bytes, non-ASCII, astral plane).
 */
import { describe, it, expect } from 'vitest';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import {
  RV_NODE_ID_NAMESPACE, UUID_NAMESPACE_URL, canonicalAuthoredPaths, escapeSegment, seedNodeId,
  seedNodeIdsForFile, sha1Hex, uuidV5,
} from '../src/core/engine/rv-node-id-seed.mjs';
import { sceneParents } from '../src/core/engine/rv-reference-migration.mjs';

const NAMESPACE_DNS = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';

/** Reference UUIDv5 over node:crypto — an implementation independent of the module's SHA-1. */
function referenceUuidV5(ns: string, name: string): string {
  const h = createHash('sha1').update(Buffer.concat([Buffer.from(ns.replace(/-/g, ''), 'hex'), Buffer.from(name, 'utf8')])).digest();
  h[6] = (h[6]! & 0x0f) | 0x50;
  h[8] = (h[8]! & 0x3f) | 0x80;
  const x = h.subarray(0, 16).toString('hex');
  return `${x.slice(0, 8)}-${x.slice(8, 12)}-${x.slice(12, 16)}-${x.slice(16, 20)}-${x.slice(20)}`;
}

describe('plan-769 9.1 — SHA-1 / UUIDv5 against external vectors', () => {
  it('SHA-1 FIPS 180 vectors', () => {
    expect(sha1Hex('abc')).toBe('a9993e364706816aba3e25717850c26c9cd0d89d');
    expect(sha1Hex('')).toBe('da39a3ee5e6b4b0d3255bfef95601890afd80709');
    expect(sha1Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe('84983e441c3bd26ebaae4aa1f95129e5e54670f1');
    expect(sha1Hex('a'.repeat(1_000_000))).toBe('34aa973cd4c4daa4f61eeb2bdbad27316534016f');
  });

  it('SHA-1 equals node:crypto across padding boundaries and UTF-8', () => {
    const inputs: string[] = [];
    for (const n of [1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 128, 1000]) inputs.push('x'.repeat(n));
    inputs.push('Förderband/Achse ü 1', '日本語/ノード', '🚚/Pallet', 'A\\/B\\[1]', '\u0000', 'Pin\u00001');
    for (const s of inputs) expect(sha1Hex(s), JSON.stringify(s)).toBe(createHash('sha1').update(s, 'utf8').digest('hex'));
  });

  it('UUIDv5 RFC 9562 §A.4 and Python uuid5 vectors', () => {
    expect(uuidV5(NAMESPACE_DNS, 'www.example.com')).toBe('2ed6657d-e927-568b-95e1-2665a8aea6a2');
    expect(uuidV5(NAMESPACE_DNS, 'python.org')).toBe('886313e1-3b8a-5372-9b90-0c9aee199e5d');
  });

  it('the rv namespace is UUIDv5(NAMESPACE_URL, "https://realvirtual.io/rv-odt/node-id")', () => {
    expect(UUID_NAMESPACE_URL).toBe('6ba7b811-9dad-11d1-80b4-00c04fd430c8');
    expect(uuidV5(UUID_NAMESPACE_URL, 'https://realvirtual.io/rv-odt/node-id')).toBe(RV_NODE_ID_NAMESPACE);
    expect(RV_NODE_ID_NAMESPACE).toBe('7ca1fd38-357d-572c-ae1e-dc902c5ea089');
  });

  it('seedNodeId equals an independent UUIDv5 and carries version 5 / variant 10', () => {
    for (const p of ['', 'Cell', 'Cell/Axis', 'A\\/B', 'Pin[1]', '#0', 'Förderer/Ö']) {
      const id = seedNodeId(p);
      expect(id).toBe(referenceUuidV5(RV_NODE_ID_NAMESPACE, p));
      expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-5[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

/** Tiny glTF JSON builder: `tree` = [name, children[]] pairs. */
type T = [string | undefined, T[]?];
function gltf(roots: T[], extras?: Record<number, string>): { json: any; index: Map<string, number> } {
  const nodes: any[] = [];
  const index = new Map<string, number>();
  const build = (t: T, label: string): number => {
    const i = nodes.length;
    const n: any = t[0] === undefined ? {} : { name: t[0] };
    nodes.push(n);
    index.set(label, i);
    const kids = (t[1] ?? []).map((c, k) => build(c, `${label}/${k}`));
    if (kids.length) n.children = kids;
    return i;
  };
  const sceneNodes = roots.map((r, k) => build(r, String(k)));
  for (const [i, id] of Object.entries(extras ?? {})) nodes[Number(i)].extras = { realvirtual: { NodeId: id } };
  return { json: { scene: 0, scenes: [{ name: 'Model', nodes: sceneNodes }], nodes }, index };
}

describe('plan-769 9.1 — canonical authored paths', () => {
  it('escapes \\, / , [ and a leading #', () => {
    expect(escapeSegment('A/B')).toBe('A\\/B');
    expect(escapeSegment('Pin[1]')).toBe('Pin\\[1]');
    expect(escapeSegment('C:\\x')).toBe('C:\\\\x');
    expect(escapeSegment('#0')).toBe('\\#0');
    expect(escapeSegment('a#b')).toBe('a#b');
  });

  it('same-name siblings get [k] from the second one; literal names never collide', () => {
    const { json } = gltf([['Cell', [['Pin'], ['Pin'], ['Pin[1]'], ['A/B'], ['A', [['B']]], [undefined], ['#1'], ['Pin']]]]);
    const p = canonicalAuthoredPaths(json, 0);
    expect(p.filter(Boolean)).toEqual([
      'Cell', 'Cell/Pin', 'Cell/Pin[1]', 'Cell/Pin\\[1]', 'Cell/A\\/B', 'Cell/A', 'Cell/A/B', 'Cell/#5', 'Cell/\\#1', 'Cell/Pin[2]',
    ]);
    expect(new Set(p.filter(Boolean)).size).toBe(p.filter(Boolean).length);
  });

  it('walks only json.scene ?? 0; unreachable nodes have no path', () => {
    const { json } = gltf([['A'], ['B']]);
    json.nodes.push({ name: 'Orphan' });
    json.scenes.push({ nodes: [1] });
    expect(canonicalAuthoredPaths(json)).toEqual(['A', 'B', undefined]);
    json.scene = 1;
    expect(canonicalAuthoredPaths(json)).toEqual([undefined, 'B', undefined]);
    expect(canonicalAuthoredPaths(json, 0)).toEqual(['A', 'B', undefined]);
  });
});

describe('plan-769 9.1 — two-pass seed', () => {
  it('a file without ids: every reachable node seeded from its path, deterministic', () => {
    const { json } = gltf([['Cell', [['Axis'], ['Axis']]]]);
    const a = seedNodeIdsForFile(json);
    const b = seedNodeIdsForFile(JSON.parse(JSON.stringify(json)));
    expect(a.ids).toEqual(b.ids);
    expect(a.ids).toEqual([seedNodeId('Cell'), seedNodeId('Cell/Axis'), seedNodeId('Cell/Axis[1]')]);
    expect(a.rootId).toBe(seedNodeId(''));
    expect(a.collisions).toEqual([]);
    expect(a.existing).toBe(0);
  });

  it('existing ids are kept; a seed taken by an existing id retries with the smallest free n', () => {
    // Node 2 (path Cell/B) is unseeded; node 1 already carries seed(Cell/B) and
    // node 3 carries seed(Cell/B\0 1) — so B must land on n = 2.
    const { json } = gltf([['Cell', [['A'], ['B'], ['C']]]], {});
    json.nodes[1].extras = { realvirtual: { NodeId: seedNodeId('Cell/B') } };
    json.nodes[3].extras = { realvirtual: { NodeId: seedNodeId('Cell/B\u00001') } };
    const r = seedNodeIdsForFile(json);
    expect(r.ids[1]).toBe(seedNodeId('Cell/B'));
    expect(r.ids[2]).toBe(seedNodeId('Cell/B\u00002'));
    expect(r.ids[3]).toBe(seedNodeId('Cell/B\u00001'));
    expect(r.collisions).toEqual([{ index: 2, path: 'Cell/B', n: 2 }]);
    expect(r.existing).toBe(2);
  });

  it('the result does not depend on the order of the child lists of OTHER parents', () => {
    const one = gltf([['X', [['P'], ['Q']]], ['Y', [['P']]]]).json;
    const two = JSON.parse(JSON.stringify(one));
    two.scenes[0].nodes = [...two.scenes[0].nodes].reverse();
    const a = seedNodeIdsForFile(one);
    const b = seedNodeIdsForFile(two);
    for (let i = 0; i < one.nodes.length; i++) expect(a.ids[i]).toBe(b.ids[i]);
  });

  it('duplicate existing ids are reported, never re-minted here', () => {
    const { json } = gltf([['A'], ['B']], { 0: 'dup', 1: 'dup' });
    const r = seedNodeIdsForFile(json);
    expect(r.ids).toEqual(['dup', 'dup']);
    expect(r.duplicates).toEqual([{ index: 1, id: 'dup' }]);
  });
});

// ─── plan-769 9.15: the bulk seed is the reference algorithm, bit for bit ───

/**
 * The normative two-pass seed as the module doc states it — one `seedNodeId` per
 * canonical path, in ascending index order. `seedNodeIdsForFile` computes the same
 * bytes incrementally (resumed SHA-1, key-table "taken" check); this pins the two.
 */
function referenceSeed(json: any, sceneIndex?: number) {
  const nodes: any[] = Array.isArray(json?.nodes) ? json.nodes : [];
  const scene = (Array.isArray(json?.scenes) ? json.scenes : [])[sceneIndex ?? json?.scene ?? 0];
  const paths = canonicalAuthoredPaths(json, sceneIndex);
  const ids: Array<string | undefined> = new Array(nodes.length);
  const taken = new Set<string>();
  const duplicates: Array<{ index: number; id: string }> = [];
  const own = (h: any): string | null => { const id = h?.extras?.realvirtual?.NodeId; return typeof id === 'string' && id.length > 0 ? id : null; };
  let existing = 0;
  const reserve = (id: string, index: number) => { if (taken.has(id)) duplicates.push({ index, id }); taken.add(id); };
  const sceneId = own(scene);
  if (sceneId) { reserve(sceneId, -1); existing++; }
  nodes.forEach((n, i) => { const id = own(n); if (id) { ids[i] = id; reserve(id, i); existing++; } });
  const collisions: Array<{ index: number; path: string; n: number }> = [];
  let seeded = 0;
  const seed = (path: string, index: number): string => {
    let id = seedNodeId(path);
    if (!taken.has(id)) { taken.add(id); seeded++; return id; }
    let n = 1;
    for (;;) { id = seedNodeId(`${path}\u0000${n}`); if (!taken.has(id)) break; n++; }
    taken.add(id); seeded++; collisions.push({ index, path, n });
    return id;
  };
  const rootId = sceneId ?? seed('', -1);
  for (let i = 0; i < nodes.length; i++) if (ids[i] === undefined && paths[i] !== undefined) ids[i] = seed(paths[i]!, i);
  return { ids, rootId, paths, existing, seeded, collisions, duplicates };
}

function expectBulkEqualsReference(json: any, label: string, sceneIndex?: number) {
  const bulk = seedNodeIdsForFile(json, sceneIndex);
  const ref = referenceSeed(json, sceneIndex);
  expect(bulk.ids, `${label} ids`).toEqual(ref.ids);
  expect(bulk.rootId, `${label} rootId`).toBe(ref.rootId);
  expect([bulk.existing, bulk.seeded], `${label} counts`).toEqual([ref.existing, ref.seeded]);
  expect(bulk.collisions, `${label} collisions`).toEqual(ref.collisions);
  expect(bulk.duplicates, `${label} duplicates`).toEqual(ref.duplicates);
  expect(bulk.paths, `${label} paths`).toEqual(ref.paths);
  // The walk's by-product is the migration's parent table of the same scene.
  if (sceneIndex === undefined) expect(Array.from(bulk.parent), `${label} parent`).toEqual(Array.from(sceneParents(json)));
}

describe('plan-769 9.15 — bulk seed == reference two-pass algorithm', () => {
  it('shipped public GLBs (all scenes walked as written)', () => {
    const dir = 'public/demo-realvirtual';
    let files = 0;
    for (const f of readdirSync(dir).filter((x) => x.endsWith('.glb'))) {
      const b = readFileSync(`${dir}/${f}`);
      if (b.readUInt32LE(0) !== 0x46546c67) continue;
      const json = JSON.parse(b.subarray(20, 20 + b.readUInt32LE(12)).toString('utf8'));
      expectBulkEqualsReference(json, f);
      files++;
    }
    expect(files).toBeGreaterThan(3);
  });

  it('adversarial trees: escapes, duplicates, UTF-8 / lone surrogates, long names, DAG + junk indices, colliding ids', () => {
    let s = 769;
    const rnd = () => (s = (s * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff;
    const parts = ['a', 'B', '/', '\\', '[', ']', '#', ' ', 'ä', '€', '🚚', '\ud800', '\udc00', 'x'.repeat(70), '名', '', 'Pin'];
    let collisions = 0;
    for (let t = 0; t < 300; t++) {
      const N = 1 + Math.floor(rnd() * 60);
      const json: any = { scene: 0, scenes: [{ nodes: [0] }], nodes: [] };
      for (let i = 0; i < N; i++) {
        let name = '';
        for (let k = Math.floor(rnd() * 4); k > 0; k--) name += parts[Math.floor(rnd() * parts.length)];
        const node: any = rnd() < 0.1 ? {} : { name: rnd() < 0.3 ? 'Dup' : name };
        if (rnd() < 0.05) node.extras = { realvirtual: { NodeId: rnd() < 0.5 ? 'dup' : seedNodeId('Dup') } };
        json.nodes.push(node);
      }
      for (let i = 1; i < N; i++) {
        if (rnd() < 0.2) json.scenes[0].nodes.push(i);
        else (json.nodes[Math.floor(rnd() * i)].children ??= []).push(i);
      }
      if (rnd() < 0.2) (json.nodes[0].children ??= []).push(Math.floor(rnd() * N), 999, -1, 1.5);
      if (rnd() < 0.1) json.scenes[0].extras = { realvirtual: { NodeId: seedNodeId('') } };
      expectBulkEqualsReference(json, `tree ${t}`);
      collisions += seedNodeIdsForFile(json).collisions.length;
    }
    expect(collisions, 'the sweep exercises the retry path').toBeGreaterThan(10);
  });
});
