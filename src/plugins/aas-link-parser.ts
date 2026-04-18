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
 */

import JSZip from 'jszip';

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

/** Parsed data from an AASX file. */
export interface AasParsedData {
  aasId: string;
  idShort: string;
  nameplate: AasProperty[];
  technicalData: AasProperty[];
  documents: AasDocument[];
}

/** Index entry mapping AAS ID to filename. */
export interface AasIndexEntry {
  file: string;
  idShort: string;
}

// ─── Index ──────────────────────────────────────────────────────────────

/** Per-basePath index cache. Empty string key = default (public/aasx). */
const indexCache = new Map<string, Promise<Record<string, AasIndexEntry>>>();

/**
 * Maps AAS IDs to their basePath so that tooltip components can load
 * project-specific AASX without knowing the basePath themselves.
 * Populated when loadAasxById() is called with a basePath.
 */
const aasIdBasePathMap = new Map<string, string>();

/**
 * Fetch and cache the aasx/index.json. Returns empty object on failure.
 * @param basePath Optional base path for project-specific AASX (e.g. '/private-assets/myproject/').
 *                 Must end with '/'. When omitted, loads from the default public/aasx/ folder.
 */
export function loadIndex(basePath?: string): Promise<Record<string, AasIndexEntry>> {
  const key = basePath ?? '';
  const existing = indexCache.get(key);
  if (existing) return existing;

  const base = basePath ?? `${import.meta.env.BASE_URL}`;
  const url = `${base}aasx/index.json`;
  const promise = fetch(url, { signal: AbortSignal.timeout(10_000) })
    .then(r => r.ok ? r.json() as Promise<Record<string, AasIndexEntry>> : {})
    .catch(() => ({}));
  indexCache.set(key, promise);
  return promise;
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
  const zipPromise = JSZip.loadAsync(await response.arrayBuffer());
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

  return { aasId, idShort, nameplate, technicalData, documents };
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
 * Looks for submodels with idShort matching /documentation/i,
 * finds <file> elements with mimeType containing 'pdf',
 * and extracts title + zipPath for each.
 */
export function parseDocuments(doc: Document): AasDocument[] {
  const results: AasDocument[] = [];
  const submodels = findAllByLocalName(doc, 'submodel');

  for (const sm of submodels) {
    const smIdShort = getFirstTextByLocalName(sm, 'idShort') || '';
    if (!/document/i.test(smIdShort)) continue;

    // Find all submodelElementCollection children (each represents a document entry)
    const collections = findAllByLocalName(sm, 'submodelElementCollection');

    for (const coll of collections) {
      const collIdShort = getFirstTextByLocalName(coll, 'idShort') || '';

      // Find <file> elements within this collection
      const fileElements = findAllByLocalName(coll, 'file');

      for (const fileEl of fileElements) {
        const mimeType = getFirstTextByLocalName(fileEl, 'mimeType') || '';
        if (!mimeType.toLowerCase().includes('pdf')) continue;

        const rawPath = getFirstTextByLocalName(fileEl, 'value') || '';
        if (!rawPath) continue;

        // Normalize zipPath: strip leading '/', replace '\' with '/'
        const zipPath = rawPath.replace(/\\/g, '/').replace(/^\//, '');

        // Determine title: look for VDI2770_Title sibling property
        let title = '';

        // Search for a sibling <property> with idShort containing 'VDI2770_Title' or 'Title'
        const siblingProperties = findAllByLocalName(coll, 'property');
        for (const prop of siblingProperties) {
          const propIdShort = getFirstTextByLocalName(prop, 'idShort') || '';
          if (/vdi2770.*title/i.test(propIdShort) || propIdShort === 'Title') {
            title = getFirstTextByLocalName(prop, 'value') || '';
            if (title) break;
          }
        }

        // Fallback: filename from path
        if (!title) {
          const filename = zipPath.split('/').pop() || '';
          title = filename.replace(/\.pdf$/i, '') || collIdShort || 'Document';
        }

        results.push({ title, mimeType, zipPath });
      }
    }
  }

  return results;
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
