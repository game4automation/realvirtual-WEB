// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The shared plan-778 trim fixture (9.13 / 9.14 / 9.15 / 9.16): three projects,
 * built in memory so the Node tests (written to a temp folder) and the browser
 * pack test (seeded into fake directory handles) read the very same bytes.
 *
 *   A  prj_a_plant   plant.glb places B:conv-1m and B:motor-big (qualified),
 *                    one realvirtual document (qualified) and one legacy
 *                    unqualified realvirtual id; lists B and the realvirtual library.
 *   B  prj_lib_b     5 documents; motor-big.glb places C:bolt-m8; lists C.
 *   C  prj_lib_c     3 documents.
 *
 * Expected trim: B → conv-1m + motor-big (2 of 5), C → bolt-m8 (1 of 3). Folder
 * names deliberately differ from the ids: libraries are found by identity.
 */

export const FIXTURE_IDS = { a: 'prj_a_plant', b: 'prj_lib_b', c: 'prj_lib_c' } as const;
export const FIXTURE_FOLDERS = { a: 'PlantA', b: 'SharedConveyors', c: 'Fasteners' } as const;

export const EXPECTED_TRIM = {
  [FIXTURE_IDS.b]: ['conv-1m', 'motor-big'],
  [FIXTURE_IDS.c]: ['bolt-m8'],
} as const;

/** A project folder as relative path → bytes. */
export type FixtureFiles = Map<string, Uint8Array>;

const enc = new TextEncoder();

/** A minimal valid GLB whose nodes carry the given `extras.realvirtual` objects; `bin` pads a BIN chunk. */
export function glbWithNodeExtras(nodes: Array<Record<string, unknown>>, bin = 64): Uint8Array {
  const json = {
    asset: { version: '2.0' },
    scene: 0,
    scenes: [{ nodes: nodes.map((_, i) => i) }],
    nodes: nodes.map((realvirtual, i) => ({ name: `n${i}`, extras: { realvirtual } })),
  };
  const jsonBytes = enc.encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonLen = jsonBytes.length + pad;
  const binLen = (bin + 3) & ~3;
  const total = 12 + 8 + jsonLen + (binLen > 0 ? 8 + binLen : 0);
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, 0x46546c67, true);
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLen, true);
  view.setUint32(16, 0x4e4f534a, true);
  out.set(jsonBytes, 20);
  out.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
  if (binLen > 0) {
    const at = 20 + jsonLen;
    view.setUint32(at, binLen, true);
    view.setUint32(at + 4, 0x004e4942, true);
    // Content-distinct payload so byte identity is a real assertion.
    for (let i = 0; i < binLen; i++) out[at + 8 + i] = (i * 31 + total) & 0xff;
  }
  return out;
}

const libRef = (sourceId: string, assetId: string) => ({
  AssetReference: { assetId, providerId: 'library-projects', sourceId },
  PlacementMeta: {},
});

const json = (value: unknown) => enc.encode(`${JSON.stringify(value, null, 2)}\n`);

function libraryProject(id: string, name: string, docs: Array<{ id: string; extras?: Array<Record<string, unknown>> }>, libraries: unknown[] = []): FixtureFiles {
  const files: FixtureFiles = new Map();
  const documents = docs.map((d, i) => {
    const path = `${d.id}.glb`;
    const thumbnail = `.thumbnails/${d.id}.${(0xa1b2c3d0 + i).toString(16)}.webp`;
    files.set(path, glbWithNodeExtras(d.extras ?? [{}], 64 + i * 8));
    files.set(thumbnail, enc.encode(`webp:${id}:${d.id}`));
    return { id: d.id, name: d.id, path, thumbnail, sizeBytes: files.get(path)!.length };
  });
  files.set('project.json', json({
    schemaVersion: 2, id, name, kind: 'internal', canonicalName: name,
    documents,
    ...(libraries.length ? { libraries } : {}),
    // Author-private fields: the allowlisted trim must NOT ship any of them (D1).
    customKey: { keep: true },
    code: 'secret-source.ts', provenance: { signer: 'x' }, settings: { a: 1 }, settingsRef: 's.json',
    lastPublished: '2026-01-01', activeSceneId: 'conv-1m', folders: ['A'], demos: ['d'],
  }));
  return files;
}

/** The three projects of the fixture. */
export function buildLibraryTrimFixture(): { a: FixtureFiles; b: FixtureFiles; c: FixtureFiles } {
  const c = libraryProject(FIXTURE_IDS.c, 'Fasteners', [
    { id: 'bolt-m8' }, { id: 'bolt-m10' }, { id: 'nut' },
  ]);
  const b = libraryProject(FIXTURE_IDS.b, 'SharedConveyors', [
    { id: 'conv-1m' },
    { id: 'conv-2m' },
    { id: 'motor-big', extras: [libRef(FIXTURE_IDS.c, 'bolt-m8')] },
    { id: 'motor-small' },
    { id: 'sensor' },
  ], [{ projectId: FIXTURE_IDS.c, label: 'Fasteners', hint: 'Fasteners' }]);

  const a: FixtureFiles = new Map();
  a.set('plant.glb', glbWithNodeExtras([
    libRef(FIXTURE_IDS.b, 'conv-1m'),
    libRef(FIXTURE_IDS.b, 'motor-big'),
    libRef(FIXTURE_IDS.b, 'conv-1m'),
    libRef('prj_realvirtual_library', 'pallethandling-chainconveyor-1m'),
    { AssetReference: { assetId: 'realvirtual-library-pallethandling-europallet-glb' }, PlacementMeta: {} },
  ], 128));
  a.set('project.json', json({
    schemaVersion: 2, id: FIXTURE_IDS.a, name: 'PlantA', kind: 'customer', canonicalName: 'PlantA',
    documents: [{ id: 'plant', name: 'Plant', path: 'plant.glb' }],
    libraries: [
      { projectId: FIXTURE_IDS.b, label: 'SharedConveyors', hint: 'SharedConveyors', note: 'unknown keys survive' },
      { projectId: 'prj_realvirtual_library', label: 'realvirtual Library' },
    ],
  }));
  return { a, b, c };
}

/** Lowercase hex SHA-256 of bytes (Web Crypto — both runners have it). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new Uint8Array(bytes));
  return [...new Uint8Array(digest)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

/**
 * The digest a correct trim must produce, derived from the fixture's SOURCE
 * files (the used documents + their thumbnails, bytes unchanged).
 */
export async function expectedTrimDigest(): Promise<Record<string, { documents: string[]; files: Record<string, string> }>> {
  const fx = buildLibraryTrimFixture();
  const libs: Array<{ projectId: string; files: Map<string, Uint8Array> }> = [];
  for (const [projectId, source] of [[FIXTURE_IDS.b, fx.b], [FIXTURE_IDS.c, fx.c]] as const) {
    const manifest = JSON.parse(new TextDecoder().decode(source.get('project.json')!)) as {
      documents: Array<{ id: string; path: string; thumbnail: string }>;
    };
    const used = manifest.documents.filter((d) => (EXPECTED_TRIM[projectId] as readonly string[]).includes(d.id));
    const files = new Map<string, Uint8Array>();
    files.set('project.json', json({ documents: used.map((d) => ({ id: d.id })) }));
    for (const d of used) {
      files.set(d.path, source.get(d.path)!);
      files.set(d.thumbnail, source.get(d.thumbnail)!);
    }
    libs.push({ projectId, files });
  }
  return trimDigest(libs);
}

/**
 * The comparable result of a trim: per library its `documents[].id` and the
 * SHA-256 of every shipped file. 9.13 and 9.14 must produce the same value.
 */
export async function trimDigest(
  libraries: Array<{ projectId: string; files: Map<string, Uint8Array> }>,
): Promise<Record<string, { documents: string[]; files: Record<string, string> }>> {
  const out: Record<string, { documents: string[]; files: Record<string, string> }> = {};
  for (const lib of [...libraries].sort((x, y) => x.projectId.localeCompare(y.projectId))) {
    const manifest = JSON.parse(new TextDecoder().decode(lib.files.get('project.json')!)) as { documents: Array<{ id: string }> };
    const files: Record<string, string> = {};
    for (const rel of [...lib.files.keys()].sort()) {
      if (rel === 'project.json') continue;
      files[rel] = await sha256Hex(lib.files.get(rel)!);
    }
    out[lib.projectId] = { documents: manifest.documents.map((d) => d.id), files };
  }
  return out;
}
