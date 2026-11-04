// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * AAS document mirror — the tool `scripts/mirror-aas-documents.mjs` (reference
 * extraction, stable names, mapping, re-run, failures, size limit) and the
 * runtime's URL → mirror resolution (`rv-aas-document-mirror.ts`).
 * Fixtures are SYNTHETIC (vendor.example) — no customer AASX.
 */
import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import JSZip from 'jszip';
// @ts-expect-error — plain .mjs script, no type declarations
import * as tool from '../scripts/mirror-aas-documents.mjs';
import { mirrorKeyOf, pageOfUrl, parseAasMirror } from '../src/core/aas/rv-aas-document-mirror';

const PDF = (tag: string) => Buffer.from(`%PDF-1.7\n% ${tag}\n%%EOF\n`, 'latin1');

function fileXml(value: string, type = 'application/pdf'): string {
  return `<file>
    <idShort>DigitalFile01</idShort>
    <semanticId><type>ExternalReference</type><keys><key><type>GlobalReference</type><value>https://admin-shell.io/vdi/2770/1/0/DigitalFile</value></key></keys></semanticId>
    <value>${value}</value>
    <contentType>${type}</contentType>
  </file>`;
}

async function aasx(fileElements: string[]): Promise<Buffer> {
  const zip = new JSZip();
  zip.file('[Content_Types].xml', '<Types/>');
  zip.file('aasx/Shell/Shell.aas.xml', `<environment><submodels><submodel><idShort>HandoverDocumentation</idShort><submodelElements>${fileElements.join('')}</submodelElements></submodel></submodels></environment>`);
  return Buffer.from(await zip.generateAsync({ type: 'uint8array' }));
}

type FakeResponse = { status: number; body?: Buffer; headers?: Record<string, string> };

function fakeFetch(routes: Record<string, FakeResponse | ((init: RequestInit) => FakeResponse)>) {
  const calls: { url: string; headers: Record<string, string> }[] = [];
  const impl = async (url: string, init: RequestInit) => {
    calls.push({ url, headers: (init.headers ?? {}) as Record<string, string> });
    const route = routes[url];
    const r = typeof route === 'function' ? route(init) : route ?? { status: 404 };
    const headers = new Headers(r.headers ?? {});
    return {
      status: r.status,
      ok: r.status >= 200 && r.status < 300,
      headers,
      arrayBuffer: async () => (r.body ?? Buffer.alloc(0)).buffer.slice((r.body ?? Buffer.alloc(0)).byteOffset, (r.body ?? Buffer.alloc(0)).byteOffset + (r.body ?? Buffer.alloc(0)).byteLength),
    };
  };
  return { impl, calls };
}

let dirs: string[] = [];
async function project(files: Record<string, Buffer>, index?: unknown): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'rv-aas-mirror-'));
  dirs.push(dir);
  await mkdir(join(dir, 'aasx'), { recursive: true });
  for (const [name, bytes] of Object.entries(files)) await writeFile(join(dir, 'aasx', name), bytes);
  if (index) await writeFile(join(dir, 'aasx', 'index.json'), JSON.stringify(index));
  return dir;
}

afterEach(async () => {
  for (const d of dirs) await rm(d, { recursive: true, force: true });
  dirs = [];
});

describe('mirror-aas-documents — reference extraction', () => {
  it('Test_ExtractXml_ExternalPdfFileValues_ReturnsUrlsNotSemanticIds', () => {
    const xml = [
      fileXml('https://vendor.example/media/1_documentation.pdf'),
      fileXml('/aasx/docs/local.pdf'), // package path: not external
      fileXml('https://vendor.example/logo.png', 'image/png'), // not a PDF
      fileXml('https://vendor.example/assets/attachment/de/42?x=1&amp;y=2'),
    ].join('\n');
    expect(tool.extractExternalPdfRefsFromXml(xml)).toEqual([
      'https://vendor.example/media/1_documentation.pdf',
      'https://vendor.example/assets/attachment/de/42?x=1&y=2',
    ]);
  });

  it('Test_ExtractXml_V2MimeTypeAndPrefix_Accepted', () => {
    const xml = '<aas:file><aas:idShort>F</aas:idShort><aas:mimeType>application/pdf</aas:mimeType><aas:value>http://vendor.example/a.pdf</aas:value></aas:file>';
    expect(tool.extractExternalPdfRefsFromXml(xml)).toEqual(['http://vendor.example/a.pdf']);
  });

  it('Test_ExtractJson_FileModelType_ReturnsUrls', () => {
    const env = { submodels: [{ submodelElements: [
      { modelType: 'File', contentType: 'application/pdf', value: 'https://vendor.example/b.pdf' },
      { modelType: { name: 'File' }, mimeType: 'application/pdf', value: 'https://vendor.example/c.pdf' },
      { modelType: 'File', contentType: 'application/pdf', value: '/aasx/d.pdf' },
    ] }] };
    expect(tool.extractExternalPdfRefsFromJson(env)).toEqual(['https://vendor.example/b.pdf', 'https://vendor.example/c.pdf']);
  });

  it('Test_MirrorFileName_SameNameDifferentPath_StableAndDistinct', () => {
    const a = tool.mirrorFileName('https://vendor.example/x/documentation.pdf');
    const b = tool.mirrorFileName('https://vendor.example/y/documentation.pdf');
    expect(a).toMatch(/^[0-9a-f]{10}-documentation\.pdf$/);
    expect(a).not.toBe(b);
    expect(tool.mirrorFileName('https://vendor.example/x/documentation.pdf#page=3')).toBe(a);
    expect(tool.mirrorFileName('https://vendor.example/assets/attachment/de/652885')).toMatch(/^[0-9a-f]{10}-652885\.pdf$/);
  });
});

describe('mirror-aas-documents — mirroring a project', () => {
  it('Test_Mirror_TwoPackages_DownloadsOnceWritesMapping', async () => {
    const dir = await project({
      'a.aasx': await aasx([fileXml('https://vendor.example/m/1.pdf'), fileXml('https://vendor.example/m/2.pdf')]),
      'b.aasx': await aasx([fileXml('https://vendor.example/m/1.pdf')]),
    });
    const { impl, calls } = fakeFetch({
      'https://vendor.example/m/1.pdf': { status: 200, body: PDF('one'), headers: { etag: '"e1"' } },
      'https://vendor.example/m/2.pdf': { status: 200, body: PDF('two') },
    });
    const r = await tool.mirrorAasDocuments({ projectDir: dir, fetchImpl: impl, now: () => new Date('2026-10-24T00:00:00Z') });
    expect(r).toMatchObject({ referenced: 2, downloaded: 2, unchanged: 0, failures: [] });
    expect(calls).toHaveLength(2);
    const mirror = JSON.parse(await readFile(join(dir, 'docs/aas/mirror.json'), 'utf8'));
    const e1 = mirror.documents['https://vendor.example/m/1.pdf'];
    expect(e1).toMatchObject({ size: PDF('one').length, fetchedAt: '2026-10-24T00:00:00.000Z', etag: '"e1"', sources: ['a.aasx', 'b.aasx'] });
    expect(e1.path).toMatch(/^docs\/aas\/[0-9a-f]{10}-1\.pdf$/);
    expect(e1.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(await readFile(join(dir, e1.path))).toEqual(PDF('one'));
    // The runtime reads the tool's output.
    const map = parseAasMirror(JSON.stringify(mirror));
    expect(map.get('https://vendor.example/m/2.pdf')).toBe(mirror.documents['https://vendor.example/m/2.pdf'].path);
  });

  it('Test_Mirror_Rerun_SkipsUnchangedAndRevalidatesWithEtag', async () => {
    const dir = await project({ 'a.aasx': await aasx([fileXml('https://vendor.example/m/1.pdf'), fileXml('https://vendor.example/m/2.pdf')]) });
    const first = fakeFetch({
      'https://vendor.example/m/1.pdf': { status: 200, body: PDF('one'), headers: { etag: '"e1"' } },
      'https://vendor.example/m/2.pdf': { status: 200, body: PDF('two') },
    });
    await tool.mirrorAasDocuments({ projectDir: dir, fetchImpl: first.impl });
    const before = await readFile(join(dir, 'docs/aas/mirror.json'), 'utf8');
    const second = fakeFetch({
      'https://vendor.example/m/1.pdf': (init) => ((init.headers as Record<string, string>)['if-none-match'] === '"e1"' ? { status: 304 } : { status: 500 }),
    });
    const r = await tool.mirrorAasDocuments({ projectDir: dir, fetchImpl: second.impl });
    expect(r).toMatchObject({ downloaded: 0, unchanged: 2, failures: [] });
    expect(second.calls.map((c) => c.url)).toEqual(['https://vendor.example/m/1.pdf']); // 2.pdf has no validator: kept
    expect(await readFile(join(dir, 'docs/aas/mirror.json'), 'utf8')).toBe(before);
  });

  it('Test_Mirror_Failures_ReportedWithoutAborting', async () => {
    const dir = await project({ 'a.aasx': await aasx([
      fileXml('https://vendor.example/m/missing.pdf'),
      fileXml('https://vendor.example/m/html.pdf'),
      fileXml('https://vendor.example/m/ok.pdf'),
    ]) });
    const { impl } = fakeFetch({
      'https://vendor.example/m/html.pdf': { status: 200, body: Buffer.from('<html>login</html>'), headers: { 'content-type': 'text/html' } },
      'https://vendor.example/m/ok.pdf': { status: 200, body: PDF('ok') },
    });
    const r = await tool.mirrorAasDocuments({ projectDir: dir, fetchImpl: impl });
    expect(r.downloaded).toBe(1);
    expect(r.failures.map((f: { url: string; reason: string }) => [f.url, f.reason.split(' ')[0]])).toEqual([
      ['https://vendor.example/m/html.pdf', 'not'],
      ['https://vendor.example/m/missing.pdf', 'HTTP'],
    ]);
    const mirror = JSON.parse(await readFile(join(dir, 'docs/aas/mirror.json'), 'utf8'));
    expect(Object.keys(mirror.documents)).toEqual(['https://vendor.example/m/ok.pdf']);
  });

  it('Test_Mirror_TotalSizeLimit_StopsWithClearFailure', async () => {
    const dir = await project({ 'a.aasx': await aasx([fileXml('https://vendor.example/m/a.pdf'), fileXml('https://vendor.example/m/b.pdf')]) });
    const big = (tag: string) => Buffer.concat([PDF(tag), Buffer.alloc(600)]);
    const { impl } = fakeFetch({
      'https://vendor.example/m/a.pdf': { status: 200, body: big('a') },
      'https://vendor.example/m/b.pdf': { status: 200, body: big('b') },
    });
    const r = await tool.mirrorAasDocuments({ projectDir: dir, fetchImpl: impl, maxTotalBytes: 1000 });
    expect(r.downloaded).toBe(1);
    expect(r.failures).toHaveLength(1);
    expect(r.failures[0].reason).toMatch(/total size limit/);
    const files = (await readdir(join(dir, 'docs/aas'))).filter((f) => f.endsWith('.pdf'));
    expect(files).toHaveLength(1);
  });

  it('Test_Mirror_SameBytesTwoUrls_StoredOnce', async () => {
    const dir = await project({ 'a.aasx': await aasx([fileXml('https://vendor.example/de/7'), fileXml('https://vendor.example/en/7')]) });
    const { impl } = fakeFetch({
      'https://vendor.example/de/7': { status: 200, body: PDF('same') },
      'https://vendor.example/en/7': { status: 200, body: PDF('same') },
    });
    const r = await tool.mirrorAasDocuments({ projectDir: dir, fetchImpl: impl });
    expect(r).toMatchObject({ downloaded: 2, failures: [], totalBytes: PDF('same').length });
    const mirror = JSON.parse(await readFile(join(dir, 'docs/aas/mirror.json'), 'utf8'));
    expect(mirror.documents['https://vendor.example/de/7'].path).toBe(mirror.documents['https://vendor.example/en/7'].path);
    expect((await readdir(join(dir, 'docs/aas'))).filter((f) => f.endsWith('.pdf'))).toHaveLength(1);
  });

  it('Test_DedupeBySha_PointsAtFirstPath_ReturnsOrphans', () => {
    const docs: Record<string, { path: string; sha256: string }> = {
      'https://v.example/1': { path: 'docs/aas/b.pdf', sha256: 'x' },
      'https://v.example/2': { path: 'docs/aas/a.pdf', sha256: 'x' },
      'https://v.example/3': { path: 'docs/aas/c.pdf', sha256: 'y' },
    };
    expect(tool.dedupeBySha(docs)).toEqual(['docs/aas/b.pdf']);
    expect(docs['https://v.example/1'].path).toBe('docs/aas/a.pdf');
    expect(docs['https://v.example/3'].path).toBe('docs/aas/c.pdf');
  });

  it('Test_Mirror_ExcludeManufacturer_SkipsThatPackage', async () => {
    const dir = await project(
      { 'a.aasx': await aasx([fileXml('https://vendor.example/m/a.pdf')]), 'other.aasx': await aasx([fileXml('https://other.example/m/b.pdf')]) },
      { entries: { 'urn:a': { file: 'a.aasx', manufacturer: 'Vendor' }, 'urn:o': { file: 'other.aasx', manufacturer: 'Other Corp' } } },
    );
    const { impl, calls } = fakeFetch({ 'https://vendor.example/m/a.pdf': { status: 200, body: PDF('a') } });
    const r = await tool.mirrorAasDocuments({ projectDir: dir, fetchImpl: impl, excludeManufacturer: /other/i });
    expect(r).toMatchObject({ referenced: 1, downloaded: 1, skippedPackages: ['other.aasx'] });
    expect(calls.map((c) => c.url)).toEqual(['https://vendor.example/m/a.pdf']);
  });
});

describe('rv-aas-document-mirror — URL → mirror resolution', () => {
  it('Test_ParseMirror_ValidEntries_MappedByUrlWithoutFragment', () => {
    const map = parseAasMirror(JSON.stringify({ version: 1, documents: {
      'https://vendor.example/a.pdf': { path: 'docs/aas/1-a.pdf' },
      'https://vendor.example/b.pdf#page=2': 'docs/aas/2-b.pdf',
    } }));
    expect(map.get('https://vendor.example/a.pdf')).toBe('docs/aas/1-a.pdf');
    expect(map.get('https://vendor.example/b.pdf')).toBe('docs/aas/2-b.pdf');
  });

  it('Test_ParseMirror_UnsafePaths_Dropped', () => {
    const map = parseAasMirror(JSON.stringify({ documents: {
      'https://vendor.example/1.pdf': { path: '../secret.pdf' },
      'https://vendor.example/2.pdf': { path: 'https://evil.example/x.pdf' },
      'https://vendor.example/3.pdf': { path: '/docs/aas/x.pdf' },
      'https://vendor.example/4.pdf': { path: 'docs/../aasx/x.aasx' },
      'javascript:alert(1)': { path: 'docs/aas/x.pdf' },
      'https://vendor.example/5.pdf': { path: 'docs/aas/ok.pdf' },
    } }));
    expect([...map.entries()]).toEqual([['https://vendor.example/5.pdf', 'docs/aas/ok.pdf']]);
  });

  it('Test_ParseMirror_Garbage_EmptyMap', () => {
    expect(parseAasMirror('not json').size).toBe(0);
    expect(parseAasMirror('null').size).toBe(0);
  });

  it('Test_PageOfUrl_And_MirrorKey', () => {
    expect(pageOfUrl('https://v.example/a.pdf#page=18')).toBe(18);
    expect(pageOfUrl('https://v.example/a.pdf#zoom=50&page=3')).toBe(3);
    expect(pageOfUrl('https://v.example/a.pdf#page=0')).toBeUndefined();
    expect(pageOfUrl('https://v.example/a.pdf')).toBeUndefined();
    expect(mirrorKeyOf(' https://v.example/a.pdf#page=18 ')).toBe('https://v.example/a.pdf');
  });
});
