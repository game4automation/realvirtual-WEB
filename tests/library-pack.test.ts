// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-778 9.14 — "Pack with libraries" in the browser.
 *
 * Same fixture as the Node trim (9.13): A uses 2 of 5 documents of B, one of
 * those uses 1 of 3 of C. The pack must arrive at the SAME rows and the SAME
 * file hashes (`expectedTrimDigest`) — one algorithm, `rv-library-trim-core.mjs`.
 * And the packed folder must work: opened as a project, the loader finds B and
 * (transitively) C through their rewritten relative hints.
 */
import { describe, expect, it } from 'vitest';
import { FakeDir, FakeFile, asDirHandle } from './helpers/fake-fs-handles';
import {
  FIXTURE_IDS,
  buildLibraryTrimFixture,
  expectedTrimDigest,
  trimDigest,
  type FixtureFiles,
} from './fixtures/library-trim/library-trim-fixture';
import {
  directoryFileSource,
  urlFileSource,
  packProjectWithLibraries,
  type PackLibrary,
} from '../src/core/project/rv-library-pack';
import { FolderBackend } from '../src/core/project/backends/folder-backend';
import { BundledBackend } from '../src/core/project/backends/bundled-backend';
import { LibraryProjectLoader, relativeHintDir } from '../src/core/library/library-project-loader';
import { createLibraryBackendFactory, openRelativeToBackend } from '../src/core/library/library-project-backends';

async function seed(files: FixtureFiles, name: string): Promise<FakeDir> {
  const root = new FakeDir(name);
  for (const [rel, bytes] of files) {
    const parts = rel.split('/');
    let dir = root;
    for (const part of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(part, { create: true });
    dir.seedBytes(parts[parts.length - 1], bytes);
  }
  return root;
}

async function readTree(dir: FakeDir, prefix = '', out = new Map<string, Uint8Array>()): Promise<Map<string, Uint8Array>> {
  for await (const [name, entry] of dir.entries()) {
    const rel = prefix ? `${prefix}/${name}` : name;
    if (entry instanceof FakeDir) await readTree(entry, rel, out);
    else out.set(rel, new Uint8Array(await (await (entry as FakeFile).getFile()).arrayBuffer()));
  }
  return out;
}

function subTree(tree: Map<string, Uint8Array>, prefix: string): Map<string, Uint8Array> {
  const out = new Map<string, Uint8Array>();
  for (const [rel, bytes] of tree) if (rel.startsWith(`${prefix}/`)) out.set(rel.slice(prefix.length + 1), bytes);
  return out;
}

async function setup() {
  const fx = buildLibraryTrimFixture();
  const a = await seed(fx.a, 'PlantA');
  const b = await seed(fx.b, 'SharedConveyors');
  const c = await seed(fx.c, 'Fasteners');
  const manifestOf = (files: FixtureFiles) => JSON.parse(new TextDecoder().decode(files.get('project.json')!));
  const libs = new Map<string, PackLibrary>([
    [FIXTURE_IDS.b, { manifest: manifestOf(fx.b), files: directoryFileSource(asDirHandle(b)) }],
    [FIXTURE_IDS.c, { manifest: manifestOf(fx.c), files: directoryFileSource(asDirHandle(c)) }],
  ]);
  return { fx, a, b, c, libs, openLibrary: async (id: string) => libs.get(id) ?? null };
}

describe('Pack with libraries (plan-778 9.14)', () => {
  it('produces the same rows and hashes as the Node trim (9.13)', async () => {
    const { a, openLibrary, fx } = await setup();
    const target = new FakeDir('packed');
    const result = await packProjectWithLibraries({ projectDir: asDirHandle(a), target: asDirHandle(target), openLibrary });
    expect(result.kind).toBe('packed');
    if (result.kind !== 'packed') return;
    expect(result.libraries).toEqual([
      { projectId: FIXTURE_IDS.b, documentIds: ['conv-1m', 'motor-big'] },
      { projectId: FIXTURE_IDS.c, documentIds: ['bolt-m8'] },
    ]);
    expect(result.realvirtualLibraryUsed).toBe(true);
    expect(result.legacyRefs.map((r) => r.assetId)).toEqual(['realvirtual-library-pallethandling-europallet-glb']);

    const tree = await readTree(target);
    const digest = await trimDigest([FIXTURE_IDS.b, FIXTURE_IDS.c].map((projectId) => ({
      projectId, files: subTree(tree, `libraries/${projectId}`),
    })));
    expect(digest).toEqual(await expectedTrimDigest());
    // A itself travels unchanged, except the hints of the shipped libraries.
    expect(tree.get('plant.glb')).toEqual(fx.a.get('plant.glb'));
    const packed = JSON.parse(new TextDecoder().decode(tree.get('project.json')!));
    expect(packed.libraries[0].hint).toBe(`libraries/${FIXTURE_IDS.b}/project.json`);
    expect(packed.libraries[0].note).toBe('unknown keys survive');
    expect(packed.libraries[1]).toEqual({ projectId: 'prj_realvirtual_library', label: 'realvirtual Library' });
    // The realvirtual library is app-level: never packed.
    expect([...tree.keys()].some((k) => k.startsWith('libraries/prj_realvirtual_library'))).toBe(false);
  });

  it('the packed folder opens: the loader finds B and C through their relative hints', async () => {
    const { a, openLibrary } = await setup();
    const target = new FakeDir('packed');
    await packProjectWithLibraries({ projectDir: asDirHandle(a), target: asDirHandle(target), openLibrary });

    const open = new FolderBackend(asDirHandle(target), { writable: false });
    const manifest = await open.readManifest();
    expect(manifest?.id).toBe(FIXTURE_IDS.a);
    const loader = new LibraryProjectLoader({
      factory: createLibraryBackendFactory(),
      openRelative: (relDir, projectId) => openRelativeToBackend(open, relDir, projectId),
    });
    loader.setProject(manifest);
    await loader.whenSettled();
    const b = loader.getNode(FIXTURE_IDS.b)!;
    const c = loader.getNode(FIXTURE_IDS.c)!;
    expect(b.state.kind).toBe('ready');
    expect(c.state.kind).toBe('ready');
    if (b.state.kind !== 'ready' || c.state.kind !== 'ready') return;
    expect(b.state.via).toBe('folder');
    expect(b.state.documents.map((d) => d.id).sort()).toEqual(['conv-1m', 'motor-big']);
    expect(c.state.documents.map((d) => d.id)).toEqual(['bolt-m8']);
    expect(c.neededBy).toEqual([FIXTURE_IDS.b]);
    loader.dispose();
  });

  it('a relative hint resolves against a hosted project base (p/libraries/<id>/)', async () => {
    const hosted = new BundledBackend({ baseUrl: 'https://web.example/abc123/p/', discover: true, fetchImpl: (async () => new Response(null, { status: 404 })) as typeof fetch });
    const located = await openRelativeToBackend(hosted, `libraries/${FIXTURE_IDS.b}`, FIXTURE_IDS.b);
    expect(located?.via).toBe('hosted');
    expect(located?.backend.id).toBe(`remote:https://web.example/abc123/p/libraries/${FIXTURE_IDS.b}/`);
    expect(relativeHintDir(`libraries/${FIXTURE_IDS.b}/project.json`)).toBe(`libraries/${FIXTURE_IDS.b}`);
    expect(relativeHintDir('SharedConveyors')).toBeNull();   // a folder NAME is a message, not a location
    expect(relativeHintDir('library/project.json')).toBeNull();
    expect(relativeHintDir('../x/project.json')).toBeNull();
    expect(relativeHintDir('https://x.example/p/project.json')).toBeNull();
    expect(await openRelativeToBackend(null, 'libraries/x', 'x')).toBeNull();
  });

  it('an unresolvable library writes nothing and names document and library', async () => {
    const { a, libs } = await setup();
    libs.delete(FIXTURE_IDS.c);
    const target = new FakeDir('packed');
    const result = await packProjectWithLibraries({
      projectDir: asDirHandle(a), target: asDirHandle(target), openLibrary: async (id) => libs.get(id) ?? null,
    });
    expect(result.kind).toBe('unresolved');
    if (result.kind !== 'unresolved') return;
    expect(result.message).toContain(`Library "${FIXTURE_IDS.c}" (needed by ${FIXTURE_IDS.b})`);
    expect(result.message).toContain(`${FIXTURE_IDS.b}:motor-big.glb places "bolt-m8" from library "${FIXTURE_IDS.c}"`);
    expect(target.childNames()).toEqual([]);
  });

  it('D12: refuses a target that is the project or lies inside it (incl. its libraries/ folder)', async () => {
    const { a, openLibrary } = await setup();
    const inside = await a.getDirectoryHandle('libraries', { create: true });
    // The fake has no resolve(); give the project folder the platform's containment answer.
    (a as unknown as { resolve: (h: unknown) => Promise<string[] | null> }).resolve = async (h) =>
      (h === inside ? ['libraries'] : h === a ? [] : null);
    for (const target of [a, inside]) {
      const result = await packProjectWithLibraries({ projectDir: asDirHandle(a), target: asDirHandle(target), openLibrary });
      expect(result.kind).toBe('error');
      if (result.kind === 'error') expect(result.message).toMatch(/itself or lies inside it/);
    }
    expect(inside.childNames()).toEqual([]);   // nothing written
  });

  it('D12: a hosted library served encrypted without an unlocked deploy fails clearly - ciphertext is never copied', async () => {
    const { a, fx } = await setup();
    // RVE1 header: magic, flags 0, kdf 0 (PBKDF2), iterations 1, salt[1], info[0], chunkSize 0, chunkCount 1.
    const envelope = new Uint8Array([0x52, 0x56, 0x45, 0x31, 0, 0, 1, 0, 0, 0, 1, 7, 0, 0, 0, 0, 0, 1, 0, 0, 0, 1, 2, 3]);
    const fetchImpl = (async () => new Response(envelope, { status: 200 })) as typeof fetch;
    const manifestOf = (files: FixtureFiles) => JSON.parse(new TextDecoder().decode(files.get('project.json')!));
    const hosted: PackLibrary = { manifest: manifestOf(fx.b), files: urlFileSource('https://web.example/x/p/libraries/b/', fetchImpl) };
    const target = new FakeDir('packed');
    const result = await packProjectWithLibraries({
      projectDir: asDirHandle(a), target: asDirHandle(target),
      openLibrary: async (id) => (id === FIXTURE_IDS.b ? hosted : null),
    });
    expect(result.kind).toBe('error');
    if (result.kind === 'error') expect(result.message).toMatch(/encrypted/);
    expect(target.childNames()).toEqual([]);
  });

  it('D15: a hosted library file is fetched once although plan and copy both read it', async () => {
    const { a, fx, openLibrary } = await setup();
    const base = 'https://web.example/x/p/libraries/b/';
    const fetched = new Map<string, number>();
    const fetchImpl = (async (input: RequestInfo | URL) => {
      const url = String(input);
      fetched.set(url, (fetched.get(url) ?? 0) + 1);
      const bytes = fx.b.get(decodeURIComponent(url.slice(base.length)));
      return bytes ? new Response(bytes as unknown as BodyInit, { status: 200 }) : new Response(null, { status: 404 });
    }) as typeof fetch;
    const manifestOf = (files: FixtureFiles) => JSON.parse(new TextDecoder().decode(files.get('project.json')!));
    const hosted: PackLibrary = { manifest: manifestOf(fx.b), files: urlFileSource(base, fetchImpl) };
    const result = await packProjectWithLibraries({
      projectDir: asDirHandle(a), target: asDirHandle(new FakeDir('packed')),
      openLibrary: async (id) => (id === FIXTURE_IDS.b ? hosted : openLibrary(id)),
    });
    expect(result.kind, JSON.stringify(result)).toBe('packed');
    expect(fetched.size).toBeGreaterThan(0);
    for (const [url, n] of fetched) expect(n, url).toBe(1);
  });

  it('never packs over an existing project', async () => {
    const { a, openLibrary } = await setup();
    const target = new FakeDir('packed');
    target.seedText('project.json', '{"id":"someone-else"}');
    const result = await packProjectWithLibraries({ projectDir: asDirHandle(a), target: asDirHandle(target), openLibrary });
    expect(result.kind).toBe('target-has-project');
    expect(await target.readText('project.json')).toBe('{"id":"someone-else"}');
  });
});
