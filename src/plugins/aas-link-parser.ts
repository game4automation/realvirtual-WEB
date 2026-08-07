// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * aas-link-parser.ts — Loads and parses AASX (ZIP) files in the browser.
 *
 * Extracts Nameplate and TechnicalData submodel properties from the
 * embedded AAS XML. Uses JSZip for ZIP extraction and DOMParser for
 * namespace-agnostic XML parsing.
 *
 * Caching: Each AASX file is fetched and parsed once; the resulting
 * Promise is cached by filename. On rejection the cache entry is
 * deleted to allow retry.
 *
 * JSZip is pulled in through a DYNAMIC import at its single point of use
 * (`doLoad`), not statically here. Statically it added ~96 kB to the entry
 * chunk — the bundle every visitor downloads before the first frame — for a
 * library that only runs when someone actually opens an AASX file. `import
 * type` keeps the type available at zero runtime cost. Guarded by
 * `tests/bundle-splitting.test.ts`.
 */

import type JSZip from 'jszip';

// ─── Types ──────────────────────────────────────────────────────────────

/** A single property extracted from an AAS submodel. */
export interface AasProperty {
  label: string;
  value: string;
}

/** A document entry from the AAS Documentation submodel. */
export interface AasDocument {
  title: string;     // VDI2770_Title (first found) or filename fallback
  mimeType: string;  // from <file><mimeType> element
  zipPath: string;   // path inside ZIP, leading "/" stripped
}

/** A qualifier attached to the AssetAdministrationShell (semantically: validity/origin annotations). */
export interface AasQualifier {
  type: string;
  value: string;
}

/** Parsed data from an AASX file. */
export interface AasParsedData {
  aasId: string;
  idShort: string;
  nameplate: AasProperty[];
  technicalData: AasProperty[];
  documents: AasDocument[];
  /** Qualifiers attached directly to the AssetAdministrationShell. May be omitted by mocks/tests. */
  qualifiers?: AasQualifier[];
}

/** Index entry mapping AAS ID to filename. */
export interface AasIndexEntry {
  file: string;
  idShort: string;
  /** Marks the AASX as a community/demo asset that has not been validated by the supplier. */
  demoOnly?: boolean;
  /** Optional override for the warning banner text. Defaults to a generic message when demoOnly is true. */
  demoNote?: string;
}

/**
 * Discriminated outcome of loading `aasx/index.json`.
 *
 * `loadIndex()` collapses every failure to `{}`, which cannot tell "the AASX
 * feature was never shipped" (CONNECT embed: the whole `aasx/` folder is
 * filtered out of the bundle) from "the index is there but broken" (network,
 * 5xx, invalid JSON). The viewer must hide AAS surfaces in the first case and
 * keep the visible error in the second — so the two are kept apart here.
 */
export type AasIndexResult =
  | { kind: 'available'; index: Record<string, AasIndexEntry> }
  /** 404, or an SPA history-fallback HTML page served with HTTP 200. */
  | { kind: 'missing' }
  /** Network failure, 5xx, or unparsable JSON — a broken deployment, not an absent feature. */
  | { kind: 'error'; reason: string };

// ─── Index ──────────────────────────────────────────────────────────────

/** Per-basePath index cache. Empty string key = default (public/aasx). */
const indexCache = new Map<string, Promise<AasIndexResult>>();

/**
 * Maps AAS IDs to their basePath so that tooltip components can load
 * project-specific AASX without knowing the basePath themselves.
 * Populated when loadAasxById() is called with a basePath.
 */
const aasIdBasePathMap = new Map<string, string>();

/**
 * Fetch and cache the aasx/index.json, keeping "not shipped" apart from "broken".
 * This is the canonical API; `loadIndex()` is a thin wrapper on the SAME cached
 * promise, so there is never a second network round-trip.
 *
 * @param basePath Optional base path for project-specific AASX (e.g. '/private-assets/myproject/').
 *                 Must end with '/'. When omitted, loads from the default public/aasx/ folder.
 */
export function loadIndexResult(basePath?: string): Promise<AasIndexResult> {
  const key = basePath ?? '';
  const existing = indexCache.get(key);
  if (existing) return existing;

  const base = basePath ?? `${import.meta.env.BASE_URL}`;
  const url = `${base}aasx/index.json`;
  const promise = fetch(url, { signal: AbortSignal.timeout(10_000) })
    .then(async (r): Promise<AasIndexResult> => {
      if (r.status === 404) return { kind: 'missing' };
      if (!r.ok) return { kind: 'error', reason: `HTTP ${r.status}` };
      // SPA history fallback: a missing file comes back as index.html with 200.
      // Content-Type is the only way to tell it apart — but a plain static host
      // may serve valid JSON without a JSON type, so ONLY html is rejected here.
      const contentType = r.headers?.get?.('content-type') ?? '';
      if (/text\/html/i.test(contentType)) return { kind: 'missing' };
      try {
        const index = await r.json() as Record<string, AasIndexEntry>;
        if (!index || typeof index !== 'object' || Array.isArray(index)) {
          return { kind: 'error', reason: 'aasx/index.json is not an object' };
        }
        return { kind: 'available', index };
      } catch (e) {
        return { kind: 'error', reason: e instanceof Error ? e.message : String(e) };
      }
    })
    .catch((e): AasIndexResult => ({
      kind: 'error',
      reason: e instanceof Error ? e.message : String(e),
    }));
  indexCache.set(key, promise);
  return promise;
}

/**
 * Fetch and cache the aasx/index.json. Returns empty object on failure.
 *
 * Legacy shape kept for every caller that only needs the entries: both `missing`
 * and `error` collapse to `{}` exactly as before. Callers that must distinguish
 * the two (the AAS resolution marking) use {@link loadIndexResult}.
 *
 * @param basePath Optional base path for project-specific AASX (e.g. '/private-assets/myproject/').
 *                 Must end with '/'. When omitted, loads from the default public/aasx/ folder.
 */
export function loadIndex(basePath?: string): Promise<Record<string, AasIndexEntry>> {
  return loadIndexResult(basePath).then(r => r.kind === 'available' ? r.index : {});
}

/** Reset the index cache (for testing). */
export function resetIndex(): void {
  indexCache.clear();
}

// ─── AASX Cache ─────────────────────────────────────────────────────────

const cache = new Map<string, Promise<AasParsedData>>();

/** ZIP instance cache — stores Promise<JSZip> for concurrency safety. */
const zipCache = new Map<string, Promise<JSZip>>();

/** Reset the AASX cache (for testing). */
export function resetCache(): void {
  cache.clear();
  zipCache.clear();
}

/**
 * Load and parse an AASX by AAS ID.
 * Resolves the ID to a filename via the index, then loads the AASX.
 * @param basePath Optional base path for project-specific AASX (e.g. '/private-assets/myproject/').
 */
export async function loadAasxById(aasId: string, basePath?: string): Promise<AasParsedData> {
  const index = await loadIndex(basePath);
  const entry = index[aasId];
  if (!entry) throw new Error(`AAS ID not found in index: ${aasId}`);
  return loadAasx(entry.file, basePath);
}

/**
 * Look up the index entry for an AAS ID. Returns undefined if the index has not
 * been loaded yet or the ID is unknown. Useful for UI to read flags such as demoOnly.
 */
export async function getIndexEntry(aasId: string, basePath?: string): Promise<AasIndexEntry | undefined> {
  const index = await loadIndex(basePath);
  return index[aasId];
}

/**
 * Load and parse an AASX by filename.
 * Caches the promise; on rejection the cache entry is removed to allow retry.
 * @param basePath Optional base path for project-specific AASX.
 */
export function loadAasx(filename: string, basePath?: string): Promise<AasParsedData> {
  const cacheKey = basePath ? `${basePath}::${filename}` : filename;
  const existing = cache.get(cacheKey);
  if (existing) return existing;

  const promise = doLoad(filename, basePath);
  cache.set(cacheKey, promise);

  // Delete cache entry on rejection so next call can retry
  promise.catch(() => {
    cache.delete(cacheKey);
  });

  return promise;
}

// ─── Internal: Load + Parse ─────────────────────────────────────────────

async function doLoad(filename: string, basePath?: string): Promise<AasParsedData> {
  const base = basePath ?? `${import.meta.env.BASE_URL}`;
  const response = await fetch(`${base}aasx/${filename}`, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`Failed to load ${filename}: ${response.status}`);

  const cacheKey = basePath ? `${basePath}::${filename}` : filename;
  // Kept off the entry chunk on purpose — see the module header.
  const { default: JSZipLib } = await import('jszip');
  const zipPromise = JSZipLib.loadAsync(await response.arrayBuffer());
  zipCache.set(cacheKey, zipPromise);
  const zip = await zipPromise;

  // Find the .aas.xml file (may be in a subfolder)
  const xmlEntry = Object.keys(zip.files).find(f => f.endsWith('.aas.xml'));
  if (!xmlEntry) throw new Error(`No .aas.xml found in ${filename}`);

  const xmlText = await zip.files[xmlEntry].async('text');
  return parseAasXml(xmlText);
}

// ─── XML Parsing ────────────────────────────────────────────────────────

/**
 * Parse AAS XML string and extract structured data.
 *
 * Namespace-agnostic: uses local element names via getElementsByTagName('*')
 * filtering by localName. This works across AAS V1 (aas/1/0), V2 (aas/2/0),
 * and V3 (aas/3/0) since local element names are identical.
 */
export function parseAasXml(xml: string): AasParsedData {
  const doc = new DOMParser().parseFromString(xml, 'text/xml');

  // Check for parse error
  const parseError = doc.querySelector('parsererror');
  if (parseError) {
    throw new Error(`XML parse error: ${parseError.textContent?.substring(0, 200)}`);
  }

  // Extract AAS identification
  const aasId = getFirstTextByLocalName(doc, 'identification')
    || getFirstTextByLocalName(doc, 'id')
    || '';

  // Extract idShort from the first assetAdministrationShell
  const aasShell = findFirstByLocalName(doc, 'assetAdministrationShell');
  const idShort = aasShell
    ? getFirstTextByLocalName(aasShell, 'idShort') || ''
    : '';

  // Extract qualifiers attached directly to the AssetAdministrationShell.
  // Only top-level qualifiers (not nested inside submodels) are collected here.
  const qualifiers = aasShell ? extractShellQualifiers(aasShell) : [];

  // Find submodels
  const submodels = findAllByLocalName(doc, 'submodel');
  let nameplate: AasProperty[] = [];
  let technicalData: AasProperty[] = [];

  for (const sm of submodels) {
    const smIdShort = getFirstTextByLocalName(sm, 'idShort') || '';
    if (/nameplate/i.test(smIdShort)) {
      nameplate = extractProperties(sm);
    } else if (/technicaldata/i.test(smIdShort)) {
      technicalData = extractProperties(sm);
    }
  }

  const documents = parseDocuments(doc);

  return { aasId, idShort, nameplate, technicalData, documents, qualifiers };
}

/**
 * Extract qualifiers attached directly to the AssetAdministrationShell element
 * (not those nested inside submodels). Empty type/value entries are skipped.
 */
function extractShellQualifiers(shell: Element): AasQualifier[] {
  const results: AasQualifier[] = [];
  // Direct children only — avoid picking up qualifiers from nested submodels
  for (const child of Array.from(shell.children)) {
    if (child.localName !== 'qualifier' && child.localName !== 'qualifiers') continue;
    // V2 wraps multiple qualifiers under <qualifiers>; V3 lists <qualifier> directly.
    const qElements = child.localName === 'qualifiers'
      ? Array.from(child.children).filter(c => c.localName === 'qualifier')
      : [child];
    for (const q of qElements) {
      const type = getFirstTextByLocalName(q, 'type') || '';
      const value = getFirstTextByLocalName(q, 'value') || '';
      if (type) results.push({ type, value });
    }
  }
  return results;
}

/**
 * Extract properties from a submodel element.
 * Walks submodelElements and collects idShort + value pairs,
 * including nested SubmodelElementCollections.
 */
function extractProperties(submodel: Element): AasProperty[] {
  const results: AasProperty[] = [];
  const properties = findAllByLocalName(submodel, 'property');

  for (const prop of properties) {
    const idShort = getFirstTextByLocalName(prop, 'idShort') || '';
    const value = getFirstTextByLocalName(prop, 'value') || '';
    if (idShort && value) {
      results.push({ label: cleanLabel(idShort), value });
    }
  }

  return results;
}

/**
 * Clean AAS idShort labels for display.
 * - Replace underscores with spaces
 * - Insert space before camelCase capitals
 * - Trim and collapse whitespace
 */
export function cleanLabel(raw: string): string {
  return raw
    .replace(/_+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .replace(/\s+/g, ' ')
    .trim();
}

// ─── Document Parsing ──────────────────────────────────────────────────

/**
 * Parse PDF documents from the Documentation submodel.
 *
 * Generic + AAS-metamodel-conformant: looks for submodels with idShort matching
 * /document/i and collects EVERY File submodel element they contain, at any
 * nesting depth. VDI 2770 wraps each File in a per-document
 * SubmodelElementCollection (Festo / Bosch style), but the metamodel also allows
 * File elements directly under the submodel's submodelElements (SEW style) —
 * both layouts are handled. The document title comes from a VDI2770/Title
 * property in the File's nearest enclosing collection, falling back to the
 * filename when none is present.
 */
export function parseDocuments(doc: Document): AasDocument[] {
  const results: AasDocument[] = [];
  const seen = new Set<string>();
  const submodels = findAllByLocalName(doc, 'submodel');

  for (const sm of submodels) {
    const smIdShort = getFirstTextByLocalName(sm, 'idShort') || '';
    if (!/document/i.test(smIdShort)) continue;

    // All File elements anywhere in the submodel — nested in a VDI2770
    // collection or listed flat directly under submodelElements.
    const fileElements = findAllByLocalName(sm, 'file');

    for (const fileEl of fileElements) {
      const mimeType = getFirstTextByLocalName(fileEl, 'mimeType') || '';
      if (!mimeType.toLowerCase().includes('pdf')) continue;

      const rawPath = getFirstTextByLocalName(fileEl, 'value') || '';
      if (!rawPath) continue;

      // Normalize zipPath: strip leading '/', replace '\' with '/'
      const zipPath = rawPath.replace(/\\/g, '/').replace(/^\//, '');
      if (seen.has(zipPath)) continue;
      seen.add(zipPath);

      const title = findDocumentTitle(fileEl) || filenameTitle(zipPath);
      results.push({ title, mimeType, zipPath });
    }
  }

  return results;
}

/**
 * Resolve a human-readable title for a document File element: search the File's
 * nearest enclosing SubmodelElementCollection (the VDI 2770 per-document group)
 * for a VDI2770_Title / Title property. Returns '' when the File is not inside a
 * collection (flat layout) or no title property exists — the caller then falls
 * back to the filename.
 */
function findDocumentTitle(fileEl: Element): string {
  let coll: Element | null = fileEl.parentElement;
  while (coll && coll.localName !== 'submodelElementCollection') coll = coll.parentElement;
  if (!coll) return '';

  for (const prop of findAllByLocalName(coll, 'property')) {
    const idShort = getFirstTextByLocalName(prop, 'idShort') || '';
    if (/vdi2770.*title/i.test(idShort) || idShort === 'Title') {
      const value = getFirstTextByLocalName(prop, 'value') || '';
      if (value) return value;
    }
  }
  return '';
}

/** Derive a title from a zip path: the filename without its .pdf extension. */
function filenameTitle(zipPath: string): string {
  const filename = zipPath.split('/').pop() || '';
  return filename.replace(/\.pdf$/i, '') || 'Document';
}

// ─── Lazy PDF Extraction ───────────────────────────────────────────────

/**
 * Extract a file from a cached AASX ZIP and return a blob URL.
 *
 * Resolves aasId to filename via the index, ensures the AASX is loaded
 * (and cached), then extracts the specified file from the ZIP.
 * Normalizes the zipPath: tries as-is, then with 'aasx/' prefix.
 *
 * @param basePath Optional base path for project-specific AASX.
 * @returns blob URL string — caller is responsible for revoking it.
 */
export async function extractFileBlob(aasId: string, zipPath: string, basePath?: string): Promise<string> {
  const index = await loadIndex(basePath);
  const entry = index[aasId];
  if (!entry) throw new Error(`AAS ID not found in index: ${aasId}`);

  const filename = entry.file;

  // Ensure AASX is loaded (triggers doLoad if not cached)
  await loadAasx(filename, basePath);

  // Get the cached ZIP instance
  const cacheKey = basePath ? `${basePath}::${filename}` : filename;
  const zip = await zipCache.get(cacheKey);
  if (!zip) throw new Error(`ZIP not available for ${filename}`);

  // Normalize path: strip leading '/', replace '\' with '/'
  const normalized = zipPath.replace(/\\/g, '/').replace(/^\//, '');

  // Try path as-is, then with 'aasx/' prefix
  let zipEntry = zip.file(normalized);
  if (!zipEntry && !normalized.startsWith('aasx/')) {
    zipEntry = zip.file('aasx/' + normalized);
  }
  if (!zipEntry) throw new Error(`File not found in AASX: ${normalized}`);

  const raw = await zipEntry.async('arraybuffer');
  const blob = new Blob([raw], { type: 'application/pdf' });
  return URL.createObjectURL(blob);
}

// ─── DOM Helpers (namespace-agnostic) ───────────────────────────────────

/** Find the first element with given localName under a parent. */
function findFirstByLocalName(parent: Document | Element, localName: string): Element | null {
  const all = parent.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName) return all[i];
  }
  return null;
}

/** Find all elements with given localName under a parent. */
function findAllByLocalName(parent: Document | Element, localName: string): Element[] {
  const results: Element[] = [];
  const all = parent.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) {
    if (all[i].localName === localName) results.push(all[i]);
  }
  return results;
}

/** Get text content of the first child element with given localName. */
function getFirstTextByLocalName(parent: Document | Element, localName: string): string | null {
  const el = findFirstByLocalName(parent, localName);
  return el?.textContent?.trim() || null;
}
