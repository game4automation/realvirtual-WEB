// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * aas-link-parser.ts — AAS data for tooltip, detail panel, order manager and PDF viewer.
 *
 * Since plan-596 this module no longer fetches anything itself. WHERE an AASX
 * lives is an {@link AasSource} (`src/core/aas/rv-aas-source.ts`: deploy URL,
 * project folder, or both merged); HOW it is read is the AASX package reader
 * (`src/core/aas/rv-aasx-package.ts`, zip.js with ranged reads, OPC walk,
 * V2/V3 XML and JSON normalised into one model). What remains here is the
 * mapping of ONE shell onto the data the UI shows (nameplate, technical data,
 * PDF documents, shell qualifiers — `./aas-detail.ts`, lazily loaded) plus
 * the caches.
 *
 * Every loader takes an optional `sourceOrBase`: an {@link AasSource}, a legacy
 * assets-root string (`<root>aasx/…`), or nothing (the default deploy
 * directory). UI callers pass `getActiveAasSource()`.
 *
 * zip.js is pulled in through a dynamic import inside the package reader —
 * never statically (`tests/bundle-splitting.test.ts`).
 */

import {
  acquireAasPackage,
  asAasSource,
  lookupAas,
  releaseAasPackages,
  resetAasIndexCaches,
  trackAasPackageUrl,
  type AasIndexEntry,
  type AasIndexResult,
  type AasLookup,
  type AasSource,
} from '../core/aas/rv-aas-source';

/**
 * The detail builder and the package reader — loaded on the first detail
 * request, so neither (nor zip.js) sits on the entry chunk.
 */
function loadDetailBuilder(): Promise<typeof import('./aas-detail')> {
  return import('./aas-detail');
}

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

// Index types live with the sources (plan-596); re-exported here so every
// existing importer keeps its import path.
export type { AasIndexEntry, AasIndexResult } from '../core/aas/rv-aas-source';

// ─── Index ──────────────────────────────────────────────────────────────

/**
 * Index result of a source. With no argument: the default deploy directory
 * (`<BASE_URL>aasx/index.json`). A string is a legacy assets ROOT
 * (`<root>aasx/index.json`); an {@link AasSource} is read as it is — pass
 * `getActiveAasSource()` for "whatever the open project and deploy provide".
 *
 * Cached per source until `invalidateAasSource(key)`; `loadIndex()` shares the
 * same cached promise, so there is never a second round-trip.
 */
export function loadIndexResult(sourceOrBase?: AasSource | string): Promise<AasIndexResult> {
  return asAasSource(sourceOrBase).readIndex();
}

/**
 * The index entries; `missing` and `error` both collapse to `{}` (legacy shape
 * for callers that only need the entries).
 */
export function loadIndex(sourceOrBase?: AasSource | string): Promise<Record<string, AasIndexEntry>> {
  return loadIndexResult(sourceOrBase).then(r => r.kind === 'available' ? r.index : {});
}

/** Reset the index caches (for testing). */
export function resetIndex(): void {
  resetAasIndexCaches();
}

// ─── Detail cache ───────────────────────────────────────────────────────

const cache = new Map<string, Promise<AasParsedData>>();

/** Reset the AASX caches — parsed details and open packages (for testing). */
export function resetCache(): void {
  cache.clear();
  releaseAasPackages();
}

function cacheOnce(key: string, load: () => Promise<AasParsedData>): Promise<AasParsedData> {
  const existing = cache.get(key);
  if (existing) return existing;
  const promise = load();
  cache.set(key, promise);
  // Delete the cache entry on rejection so the next call can retry.
  promise.catch(() => { if (cache.get(key) === promise) cache.delete(key); });
  return promise;
}

/**
 * Load the detail of ONE shell — the one with `aasId` — from the archive of the
 * source that holds it (SOL #3/#4). Only that shell's referenced submodels feed
 * nameplate, technical data and documents.
 */
export function loadAasDetail(lookup: AasLookup, aasId: string): Promise<AasParsedData> {
  const { source, entry } = lookup;
  const key = `${source.key}#${source.revision}::${entry.file}::${aasId}`;
  return cacheOnce(key, async () => {
    const [pkg, { buildAasDetail }] = await Promise.all([acquireAasPackage(source, entry.file), loadDetailBuilder()]);
    const env = await pkg.readEnvironment();
    return buildAasDetail(env, aasId);
  });
}

/**
 * Load and parse an AASX by AAS ID: look the id up in the source's index, then
 * read that shell from the archive of the source that listed it.
 */
export async function loadAasxById(aasId: string, sourceOrBase?: AasSource | string): Promise<AasParsedData> {
  const lookup = await lookupAas(asAasSource(sourceOrBase), aasId);
  if (!lookup) throw new Error(`AAS ID not found in index: ${aasId}`);
  return loadAasDetail(lookup, aasId);
}

/**
 * Look up the index entry for an AAS ID. Returns undefined if the ID is unknown.
 * Useful for UI to read flags such as demoOnly.
 */
export async function getIndexEntry(aasId: string, sourceOrBase?: AasSource | string): Promise<AasIndexEntry | undefined> {
  return (await lookupAas(asAasSource(sourceOrBase), aasId))?.entry;
}

/**
 * Load and parse an AASX by filename (first shell of the file). Caches the
 * promise; on rejection the entry is removed to allow a retry.
 */
export function loadAasx(filename: string, sourceOrBase?: AasSource | string): Promise<AasParsedData> {
  const source = asAasSource(sourceOrBase);
  return cacheOnce(`${source.key}#${source.revision}::${filename}::`, async () => {
    const [pkg, { buildAasDetail }] = await Promise.all([acquireAasPackage(source, filename), loadDetailBuilder()]);
    return buildAasDetail(await pkg.readEnvironment(), undefined);
  });
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

// ─── Lazy entry extraction (PDFs) ───────────────────────────────────────

/**
 * Read one file of the archive that holds `aasId` as a Blob — from the source
 * that listed the id. A path without the `aasx/` prefix also matches
 * `aasx/<path>`.
 */
export async function extractAasEntryBlob(
  aasId: string,
  zipPath: string,
  sourceOrBase?: AasSource | string,
): Promise<{ blob: Blob; lookup: AasLookup }> {
  const lookup = await lookupAas(asAasSource(sourceOrBase), aasId);
  if (!lookup) throw new Error(`AAS ID not found in index: ${aasId}`);
  const pkg = await acquireAasPackage(lookup.source, lookup.entry.file);
  const type = /\.pdf$/i.test(zipPath) ? 'application/pdf' : undefined;
  const blob = await pkg.readEntry(zipPath, type);
  if (!blob) throw new Error(`File not found in AASX: ${zipPath.replace(/\\/g, '/').replace(/^\//, '')}`);
  return { blob, lookup };
}

/**
 * Extract a file from an AASX and return a blob URL. The URL is tracked with
 * the open package, so releasing the package (LRU, project switch) revokes it;
 * a caller may revoke it earlier.
 */
export async function extractFileBlob(aasId: string, zipPath: string, sourceOrBase?: AasSource | string): Promise<string> {
  const { blob, lookup } = await extractAasEntryBlob(aasId, zipPath, sourceOrBase);
  const url = URL.createObjectURL(blob);
  trackAasPackageUrl(lookup.source, lookup.entry.file, url);
  return url;
}
