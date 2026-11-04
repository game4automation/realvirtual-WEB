// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mirror-aas-documents.mjs — copy the external PDFs an AAS links into the project.
 *
 * Some type AAS (a manufacturer's AASX download) do not ship their manuals:
 * the Documentation File element holds an http(s) address on the
 * manufacturer's site instead. The viewer's PDF reader fetches the bytes, and
 * such sites send no CORS headers — so those documents could only open in a
 * new browser tab. This tool downloads every referenced external PDF once into
 * the project, where it is served same-origin and opens inline:
 *
 *   <project>/docs/aas/<hash>-<file>.pdf
 *   <project>/docs/aas/mirror.json   { version, documents: { url → { path, sha256, size, fetchedAt, … } } }
 *
 * The presence of `docs/aas/mirror.json` IS the opt-in: the viewer reads it and
 * opens a mapped address in its overlay. Without it nothing changes.
 *
 * Usage:
 *   node scripts/mirror-aas-documents.mjs --project <dir>
 *     [--max-total-mb 500] [--max-file-mb 100] [--exclude-manufacturer <regex>]
 *     [--refresh] [--dry-run] [--timeout-s 60]
 *
 * Re-running is cheap: a mirrored file whose bytes are still on disk is
 * revalidated with a conditional request (ETag / Last-Modified) when the
 * server gave one, otherwise kept. Failures are reported, never fatal; the
 * exit code is 1 when at least one document could not be mirrored.
 */

import { createHash } from 'node:crypto';
import { readFile, writeFile, mkdir, readdir, rename, stat, unlink } from 'node:fs/promises';
import { join, resolve, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';

export const MIRROR_DIR = 'docs/aas';
export const MIRROR_FILE = 'docs/aas/mirror.json';
export const MIRROR_VERSION = 1;

// ─── Pure helpers (unit-tested) ─────────────────────────────────────────

/** The address without its fragment — the mirror key (`#page=N` is a view, not a file). */
export function mirrorKeyOf(url) {
  return String(url).trim().replace(/#.*$/, '');
}

/**
 * Stable, file-system-safe name: 10 hex chars of the URL's sha256 plus the
 * original file name (sanitised, `.pdf` enforced). The hash keeps two
 * `documentation.pdf` from different paths apart; the name keeps it readable.
 */
export function mirrorFileName(url) {
  const key = mirrorKeyOf(url);
  const hash = createHash('sha256').update(key).digest('hex').slice(0, 10);
  let base = '';
  try { base = decodeURIComponent(new URL(key).pathname.split('/').pop() || ''); } catch { /* keep '' */ }
  base = base.replace(/\.pdf$/i, '').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^[._]+|[._]+$/g, '').slice(0, 80);
  return `${hash}-${base || 'document'}.pdf`;
}

function decodeXml(s) {
  return s
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&amp;/g, '&');
}

/**
 * External PDF addresses of the File elements in an AAS environment XML
 * (V2 `mimeType` / V3 `contentType`). The File's own `<value>` is read after
 * removing nested reference blocks (semanticId, qualifiers, …) whose keys also
 * carry `<value>` elements. Only http(s) values with a PDF type count.
 */
export function extractExternalPdfRefsFromXml(xml) {
  const out = [];
  const fileRe = /<(?:[\w-]+:)?file(?:\s[^>]*)?>([\s\S]*?)<\/(?:[\w-]+:)?file>/gi;
  let m;
  while ((m = fileRe.exec(xml)) !== null) {
    let body = m[1];
    body = body.replace(/<((?:[\w-]+:)?(?:semanticId|supplementalSemanticIds|qualifiers?|embeddedDataSpecifications|extensions|description|displayName|keys))(?:\s[^>]*)?>[\s\S]*?<\/\1>/gi, '');
    const type = body.match(/<(?:[\w-]+:)?(?:contentType|mimeType)>([^<]*)</i)?.[1] ?? '';
    const value = body.match(/<(?:[\w-]+:)?value>([^<]*)</i)?.[1] ?? '';
    const url = decodeXml(value).trim();
    if (/pdf/i.test(type) && /^https?:\/\//i.test(url)) out.push(url);
  }
  return out;
}

/** The same for an AAS environment JSON (V3 `modelType: "File"`, V2 `modelType.name`). */
export function extractExternalPdfRefsFromJson(json) {
  const out = [];
  const walk = (v) => {
    if (Array.isArray(v)) { for (const x of v) walk(x); return; }
    if (!v || typeof v !== 'object') return;
    const mt = typeof v.modelType === 'string' ? v.modelType : v.modelType?.name;
    if (mt === 'File' && typeof v.value === 'string') {
      const type = String(v.contentType ?? v.mimeType ?? '');
      const url = v.value.trim();
      if (/pdf/i.test(type) && /^https?:\/\//i.test(url)) out.push(url);
    }
    for (const k of Object.keys(v)) walk(v[k]);
  };
  walk(json);
  return out;
}

/** External PDF addresses of one AASX package (all XML / JSON environment entries). */
export async function extractExternalPdfRefsFromAasx(bytes) {
  const zip = await JSZip.loadAsync(bytes);
  const refs = [];
  for (const name of Object.keys(zip.files)) {
    const entry = zip.files[name];
    if (entry.dir || name.startsWith('[') || /(^|\/)_rels\//.test(name)) continue;
    if (/\.xml$/i.test(name)) refs.push(...extractExternalPdfRefsFromXml(await entry.async('text')));
    else if (/\.json$/i.test(name)) {
      try { refs.push(...extractExternalPdfRefsFromJson(JSON.parse(await entry.async('text')))); } catch { /* not an environment */ }
    }
  }
  return refs;
}

/** A mirror.json as written by this tool, tolerant of a missing / foreign file. */
export function readMirrorJson(text) {
  try {
    const raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text);
    const docs = raw && typeof raw === 'object' && raw.documents && typeof raw.documents === 'object' ? raw.documents : {};
    return { version: MIRROR_VERSION, documents: { ...docs } };
  } catch {
    return { version: MIRROR_VERSION, documents: {} };
  }
}

/** True when bytes look like a PDF (`%PDF-` within the first 1 KiB). */
export function looksLikePdf(bytes) {
  const head = Buffer.from(bytes.buffer ?? bytes, bytes.byteOffset ?? 0, Math.min(1024, bytes.byteLength ?? bytes.length)).toString('latin1');
  return head.includes('%PDF-');
}

// ─── Tool ───────────────────────────────────────────────────────────────

async function listAasxFiles(projectDir) {
  const aasxDir = join(projectDir, 'aasx');
  const out = [];
  async function walk(dir) {
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (/\.aasx$/i.test(e.name)) out.push(p);
    }
  }
  await walk(aasxDir);
  return out.sort();
}

/** `file` (relative to aasx/) → manufacturer, from the project's aasx/index.json. */
async function manufacturersByFile(projectDir) {
  const map = new Map();
  try {
    const idx = JSON.parse(await readFile(join(projectDir, 'aasx', 'index.json'), 'utf8'));
    for (const e of Object.values(idx.entries ?? idx)) {
      if (e && typeof e === 'object' && e.file) map.set(String(e.file).replace(/\\/g, '/'), e.manufacturer ?? '');
    }
  } catch { /* no index: no filter information */ }
  return map;
}

async function sha256File(path) {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

async function fileExists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

/**
 * Mirror the external PDFs of a project. Returns a summary; never throws for a
 * single document. `fetchImpl` is injectable for tests.
 */
export async function mirrorAasDocuments({
  projectDir,
  maxTotalBytes = 500 * 1024 * 1024,
  maxFileBytes = 100 * 1024 * 1024,
  excludeManufacturer = null,
  refresh = false,
  dryRun = false,
  timeoutMs = 60_000,
  fetchImpl = globalThis.fetch,
  now = () => new Date(),
  log = () => {},
}) {
  const root = resolve(projectDir);
  const mirrorDir = join(root, ...MIRROR_DIR.split('/'));
  const mirrorPath = join(root, ...MIRROR_FILE.split('/'));
  const manufacturers = await manufacturersByFile(root);

  // 1. Collect references.
  const refs = new Map(); // key → { url, sources: Set<file> }
  const failures = [];
  const skippedPackages = [];
  for (const file of await listAasxFiles(root)) {
    const rel = relative(join(root, 'aasx'), file).split(sep).join('/');
    const maker = manufacturers.get(rel) ?? '';
    if (excludeManufacturer && excludeManufacturer.test(maker)) { skippedPackages.push(rel); continue; }
    try {
      for (const url of await extractExternalPdfRefsFromAasx(await readFile(file))) {
        const key = mirrorKeyOf(url);
        if (!refs.has(key)) refs.set(key, { url: key, sources: new Set() });
        refs.get(key).sources.add(rel);
      }
    } catch (e) {
      failures.push({ url: null, source: rel, reason: `AASX not readable: ${e instanceof Error ? e.message : e}` });
    }
  }

  // 2. Download.
  let existingText = '';
  try { existingText = await readFile(mirrorPath, 'utf8'); } catch { /* first run */ }
  const mirror = readMirrorJson(existingText);
  const result = { referenced: refs.size, downloaded: 0, unchanged: 0, deduplicated: 0, failures, skippedPackages, totalBytes: 0, mirrorPath };

  // Bytes already on disk for every reference count against the limit first.
  let total = 0;
  for (const key of refs.keys()) {
    const prev = mirror.documents[key];
    if (prev?.path && await fileExists(join(root, ...prev.path.split('/')))) total += prev.size ?? 0;
  }

  if (!dryRun) await mkdir(mirrorDir, { recursive: true });
  for (const { url, sources } of [...refs.values()].sort((a, b) => a.url.localeCompare(b.url))) {
    const prev = mirror.documents[url];
    const path = prev?.path ?? `${MIRROR_DIR}/${mirrorFileName(url)}`;
    const abs = join(root, ...path.split('/'));
    const onDisk = await fileExists(abs);
    if (onDisk && prev?.sha256 && !refresh && !prev.etag && !prev.lastModified) {
      result.unchanged++;
      continue;
    }
    if (dryRun) { log(`would fetch ${url}`); continue; }
    const headers = { 'user-agent': 'realvirtual-aas-mirror/1' };
    if (onDisk && prev?.sha256 && !refresh) {
      if (prev.etag) headers['if-none-match'] = prev.etag;
      if (prev.lastModified) headers['if-modified-since'] = prev.lastModified;
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      let res;
      try { res = await fetchImpl(url, { headers, redirect: 'follow', signal: ctrl.signal }); } finally { clearTimeout(timer); }
      if (res.status === 304) { result.unchanged++; continue; }
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const declared = Number(res.headers.get('content-length') ?? 0);
      if (declared > maxFileBytes) throw new Error(`file too large (${declared} bytes > ${maxFileBytes})`);
      const bytes = Buffer.from(await res.arrayBuffer());
      if (bytes.length > maxFileBytes) throw new Error(`file too large (${bytes.length} bytes > ${maxFileBytes})`);
      if (!looksLikePdf(bytes)) throw new Error(`not a PDF (content-type ${res.headers.get('content-type') ?? '?'})`);
      const sha256 = createHash('sha256').update(bytes).digest('hex');
      if (onDisk && prev?.sha256 === sha256) {
        result.unchanged++;
        mirror.documents[url] = { ...prev, ...validators(res) };
        continue;
      }
      const twin = Object.entries(mirror.documents).find(([k, d]) => k !== url && refs.has(k) && d.sha256 === sha256 && d.path);
      if (twin && await fileExists(join(root, ...twin[1].path.split('/')))) {
        mirror.documents[url] = { path: twin[1].path, sha256, size: bytes.length, fetchedAt: now().toISOString(), ...validators(res), sources: [...sources].sort() };
        result.downloaded++;
        log(`fetched ${url} → ${twin[1].path} (same bytes as ${twin[0]})`);
        continue;
      }
      const delta = bytes.length - (onDisk ? prev?.size ?? 0 : 0);
      if (total + delta > maxTotalBytes) throw new Error(`total size limit reached (${maxTotalBytes} bytes)`);
      const tmp = `${abs}.part`;
      await writeFile(tmp, bytes);
      await rename(tmp, abs);
      total += delta;
      mirror.documents[url] = {
        path,
        sha256,
        size: bytes.length,
        fetchedAt: now().toISOString(),
        ...validators(res),
        sources: [...sources].sort(),
      };
      result.downloaded++;
      log(`fetched ${url} → ${path} (${bytes.length} bytes)`);
    } catch (e) {
      failures.push({ url, source: [...sources][0] ?? null, reason: e instanceof Error ? (e.name === 'AbortError' ? 'timeout' : e.message) : String(e) });
    }
  }

  // Identical bytes are stored once: manufacturers often link the same file
  // under several addresses (one per language). Every address keeps its entry,
  // all point at the first path; the redundant copies this tool wrote go.
  const removed = dedupeBySha(mirror.documents, refs);
  if (!dryRun) for (const path of removed) await unlink(join(root, ...path.split('/'))).catch(() => {});
  result.deduplicated = removed.length;

  // Bytes on disk for what the mirror now holds (each file once).
  const sizes = new Map();
  for (const [k, d] of Object.entries(mirror.documents)) if (refs.has(k)) sizes.set(d.path, d.size ?? 0);
  result.totalBytes = [...sizes.values()].reduce((s, n) => s + n, 0);

  if (!dryRun) {
    // Keep entries of documents no longer referenced? No — the mirror describes the
    // current references; their files stay on disk for the author to remove.
    const documents = {};
    for (const key of Object.keys(mirror.documents).sort()) {
      if (refs.has(key)) documents[key] = mirror.documents[key];
    }
    const text = `${JSON.stringify({ version: MIRROR_VERSION, generator: 'mirror-aas-documents', documents }, null, 2)}\n`;
    if (text !== existingText) await writeFile(mirrorPath, text);
  }
  return result;
}

/**
 * Point every entry with the same sha256 at one path (the lexically first).
 * Returns the paths no entry references any more — copies to delete.
 */
export function dedupeBySha(documents, refs = null) {
  const keys = Object.keys(documents).filter((k) => !refs || refs.has(k)).sort();
  const before = new Set(keys.map((k) => documents[k].path));
  const canonical = new Map();
  for (const k of keys) {
    const d = documents[k];
    if (!d.sha256) continue;
    const prev = canonical.get(d.sha256);
    if (!prev || d.path < prev) canonical.set(d.sha256, d.path);
  }
  for (const k of keys) {
    const d = documents[k];
    const path = d.sha256 ? canonical.get(d.sha256) : null;
    if (path && path !== d.path) documents[k] = { ...d, path };
  }
  const after = new Set(keys.map((k) => documents[k].path));
  return [...before].filter((p) => !after.has(p)).sort();
}

function validators(res) {
  const out = {};
  const etag = res.headers.get('etag');
  const lm = res.headers.get('last-modified');
  if (etag) out.etag = etag;
  if (lm) out.lastModified = lm;
  return out;
}

// ─── CLI ────────────────────────────────────────────────────────────────

function parseArgs(argv) {
  const opts = { projectDir: null, maxTotalMb: 500, maxFileMb: 100, exclude: null, refresh: false, dryRun: false, timeoutS: 60 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--project') opts.projectDir = next();
    else if (a === '--max-total-mb') opts.maxTotalMb = Number(next());
    else if (a === '--max-file-mb') opts.maxFileMb = Number(next());
    else if (a === '--exclude-manufacturer') opts.exclude = new RegExp(next(), 'i');
    else if (a === '--refresh') opts.refresh = true;
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--timeout-s') opts.timeoutS = Number(next());
    else if (a === '--help' || a === '-h') opts.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return opts;
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help || !opts.projectDir) {
    console.log('Usage: node scripts/mirror-aas-documents.mjs --project <dir> [--max-total-mb 500] [--max-file-mb 100] [--exclude-manufacturer <regex>] [--refresh] [--dry-run] [--timeout-s 60]');
    process.exit(opts.help ? 0 : 2);
  }
  const r = await mirrorAasDocuments({
    projectDir: opts.projectDir,
    maxTotalBytes: opts.maxTotalMb * 1024 * 1024,
    maxFileBytes: opts.maxFileMb * 1024 * 1024,
    excludeManufacturer: opts.exclude,
    refresh: opts.refresh,
    dryRun: opts.dryRun,
    timeoutMs: opts.timeoutS * 1000,
    log: (m) => console.log(`  ${m}`),
  });
  const mb = (b) => `${(b / 1024 / 1024).toFixed(1)} MB`;
  console.log(`\nAAS document mirror: ${r.referenced} referenced, ${r.downloaded} downloaded, ${r.unchanged} unchanged, ${r.failures.length} failed, ${r.deduplicated} duplicate copies removed — ${mb(r.totalBytes)} on disk`);
  if (r.skippedPackages.length) console.log(`  skipped packages (manufacturer filter): ${r.skippedPackages.join(', ')}`);
  for (const f of r.failures) console.log(`  FAILED ${f.url ?? f.source}: ${f.reason}`);
  if (!opts.dryRun) console.log(`  mapping: ${r.mirrorPath}`);
  process.exit(r.failures.length ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => { console.error(e); process.exit(2); });
}
