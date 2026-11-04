// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-aas-document-mirror.ts — external AAS documents served from the project.
 *
 * A type AAS often links its manuals on the manufacturer's site (an AAS File
 * value `https://…pdf`). Such a site sends no CORS headers, so the in-viewer
 * PDF reader cannot fetch it and the link opens in a new browser tab.
 *
 * `scripts/mirror-aas-documents.mjs --project <dir>` copies those PDFs into
 * `<project>/docs/aas/` and writes `docs/aas/mirror.json` (url → path). That
 * file's PRESENCE is the opt-in: when the open project has one, an external
 * address it maps opens inline in the overlay, read same-origin through the
 * project backend (hosted deploy, folder, bundled — decrypted where needed).
 * Without a mapping, or for an address it does not list, nothing changes.
 *
 * The mapping is loaded once per project backend ({@link prefetchAasDocumentMirror})
 * — but only on demand: when an AAS that links an external document is read
 * ({@link prefetchAasDocumentMirrorFor}) or such a link is clicked. Model load
 * never probes it, so a project without a mirror (the public demo) never sees
 * a 404 for `docs/aas/mirror.json`. The mapping is looked up SYNCHRONOUSLY at click time ({@link lookupMirroredDocument}):
 * the new-tab fallback is a `window.open`, which only survives inside the
 * click's user gesture.
 */

import { getProjectStore } from '../project/project-store';
import type { ProjectBackend } from '../project/backends/project-backend';

/** The mapping file, relative to the project root. */
export const AAS_MIRROR_FILE = 'docs/aas/mirror.json';

/** The parts of a backend the mirror reads. */
export type AasMirrorBackend = Pick<ProjectBackend, 'readDocumentUrl'> & Partial<Pick<ProjectBackend, 'readDocumentBlob'>>;

/** The address without its fragment — the mirror key. */
export function mirrorKeyOf(url: string): string {
  return url.trim().replace(/#.*$/, '');
}

/** `#page=N` of an address (N ≥ 1), else undefined. */
export function pageOfUrl(url: string): number | undefined {
  const m = /#(?:.*&)?page=(\d+)/i.exec(url);
  const n = m ? Number(m[1]) : NaN;
  return n >= 1 ? Math.floor(n) : undefined;
}

/**
 * url → project-relative path from a mirror.json text. Entries whose path is
 * not a plain relative path under `docs/` (absolute, a scheme, `..`) are
 * dropped: the file is project data, but it decides what the viewer reads.
 */
export function parseAasMirror(text: string): Map<string, string> {
  const map = new Map<string, string>();
  let raw: unknown;
  try { raw = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch { return map; }
  const docs = (raw as { documents?: unknown } | null)?.documents;
  if (!docs || typeof docs !== 'object') return map;
  for (const [url, entry] of Object.entries(docs as Record<string, unknown>)) {
    if (!/^https?:\/\//i.test(url)) continue;
    const path = typeof entry === 'string' ? entry : (entry as { path?: unknown } | null)?.path;
    if (typeof path !== 'string') continue;
    const rel = path.replace(/\\/g, '/');
    if (!/^docs\//.test(rel) || rel.split('/').some((s) => s === '..' || s === '') || /^[a-z][a-z0-9+.-]*:/i.test(rel)) continue;
    map.set(mirrorKeyOf(url), rel);
  }
  return map;
}

// ─── Per-backend cache ──────────────────────────────────────────────────

interface MirrorState {
  backend: AasMirrorBackend;
  map: Map<string, string> | null;
  pending: Promise<void> | null;
}

let _state: MirrorState | null = null;
/** Test seam: the backend `currentBackend()` answers instead of the project store's. */
let _backendOverride: AasMirrorBackend | null | undefined;

async function readText(backend: AasMirrorBackend, path: string): Promise<string | null> {
  if (backend.readDocumentBlob) {
    const blob = await backend.readDocumentBlob(path).catch(() => null);
    if (blob) return blob.text();
  }
  const got = await backend.readDocumentUrl(path).catch(() => null);
  if (!got) return null;
  try {
    const r = await fetch(got.url);
    if (!r.ok) return null;
    // A dev server / SPA fallback answers a missing file with index.html.
    if (/text\/html/i.test(r.headers?.get?.('content-type') ?? '')) return null;
    return await r.text();
  } catch {
    return null;
  } finally {
    got.release();
  }
}

function currentBackend(): AasMirrorBackend | null {
  if (_backendOverride !== undefined) return _backendOverride;
  try { return getProjectStore().getBackend(); } catch { return null; }
}

/**
 * Load the open project's mapping (once per backend). Safe to call often; a
 * project without `docs/aas/mirror.json` ends with an empty map.
 */
export function prefetchAasDocumentMirror(backend: AasMirrorBackend | null = currentBackend()): Promise<void> {
  if (!backend) { _state = null; return Promise.resolve(); }
  if (_state?.backend === backend) return _state.pending ?? Promise.resolve();
  const state: MirrorState = { backend, map: null, pending: null };
  _state = state;
  state.pending = readText(backend, AAS_MIRROR_FILE)
    .then((text) => { state.map = text ? parseAasMirror(text) : new Map(); })
    .catch(() => { state.map = new Map(); })
    .finally(() => { state.pending = null; });
  return state.pending;
}

/** True when `url` is an external http(s) address — the only kind a mirror maps. */
export function isMirrorableUrl(url: string | null | undefined): boolean {
  return typeof url === 'string' && /^https?:\/\//i.test(url.trim());
}

/**
 * Load the mapping only when one of `urls` is an external address the mirror
 * could map; otherwise do nothing (no request). Call it where an AAS's
 * documents become known, so the mapping is ready before the first click.
 */
export function prefetchAasDocumentMirrorFor(urls: Iterable<string | null | undefined>): Promise<void> {
  for (const u of urls) if (isMirrorableUrl(u)) return prefetchAasDocumentMirror();
  return Promise.resolve();
}

/**
 * The mirrored project path of an external address, or null (no project, no
 * mapping yet, not listed). Synchronous; starts the load when it is missing.
 */
export function lookupMirroredDocument(url: string): string | null {
  const backend = currentBackend();
  if (!backend) return null;
  if (_state?.backend !== backend) { void prefetchAasDocumentMirror(backend); return null; }
  return _state.map?.get(mirrorKeyOf(url)) ?? null;
}

/**
 * A loadable URL for a mirrored path: an object URL the caller owns (`owned`)
 * or a plain same-origin deploy URL.
 */
export async function openMirroredDocument(path: string, backend: AasMirrorBackend | null = _state?.backend ?? currentBackend()): Promise<{ url: string; owned: boolean }> {
  if (!backend) throw new Error('No project open');
  if (backend.readDocumentBlob) {
    const blob = await backend.readDocumentBlob(path).catch(() => null);
    if (blob) return { url: URL.createObjectURL(blob), owned: true };
  }
  const got = await backend.readDocumentUrl(path);
  if (!got) throw new Error(`Mirrored document not found: ${path}`);
  // An object URL (encrypted deploy, OPFS) is handed over; the viewer revokes it.
  if (got.url.startsWith('blob:')) return { url: got.url, owned: true };
  got.release();
  return { url: got.url, owned: false };
}

/**
 * Test seam: make `backend` the open project's backend with `map` loaded
 * (`map === null`: not loaded yet), or reset to the project store (no arguments).
 */
export function _setAasMirrorForTest(backend?: AasMirrorBackend | null, map?: Map<string, string> | null): void {
  _backendOverride = backend === undefined ? undefined : backend;
  _state = backend && map !== null ? { backend, map: map ?? new Map(), pending: null } : null;
}
