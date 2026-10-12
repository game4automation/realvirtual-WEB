// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * aas-detail.ts — ONE shell of a normalised AAS environment mapped onto the
 * data the tooltip and the detail panel show (plan-596).
 *
 * Split off `aas-link-parser.ts` so that the detail builder and the package
 * reader it needs (`src/core/aas/rv-aasx-package.ts`) are loaded on the first
 * detail request instead of sitting on the entry chunk
 * (`tests/bundle-splitting.test.ts`). The parser imports this module only
 * dynamically.
 */

import {
  elementText,
  parseAasEnvironmentXml,
  submodelsOfShell,
  walkElements,
  type AasNormElement,
  type AasNormEnvironment,
  type AasNormSubmodel,
} from '../core/aas/rv-aasx-package';
import { cleanLabel, type AasDocument, type AasParsedData, type AasProperty } from './aas-link-parser';

// ─── Detail building (normalised model → tooltip/panel data) ────────────

/**
 * Build the tooltip/panel data of ONE shell. `aasId` selects the shell; with
 * several shells in a file only the selected one's referenced submodels count
 * (SOL #3). Without an id (legacy file-based load) the first shell is used.
 */
export function buildAasDetail(env: AasNormEnvironment, aasId: string | undefined): AasParsedData {
  let shell = aasId ? env.shells.find(s => s.id === aasId) : env.shells[0];
  if (!shell && aasId) {
    if (env.shells.length > 1) throw new Error(`AAS ${aasId} not found in package`);
    shell = env.shells[0];
  }
  const submodels = shell ? submodelsOfShell(env, shell) : env.submodels;

  let nameplate: AasProperty[] = [];
  let technicalData: AasProperty[] = [];
  for (const sm of submodels) {
    if (/nameplate/i.test(sm.idShort)) nameplate = collectProperties(sm.elements);
    else if (/technicaldata/i.test(sm.idShort)) technicalData = collectProperties(sm.elements);
  }

  return {
    aasId: shell?.id ?? '',
    idShort: shell?.idShort ?? '',
    nameplate,
    technicalData,
    documents: collectDocuments(submodels),
    qualifiers: shell?.qualifiers.map(q => ({ ...q })) ?? [],
  };
}

/** Every property / multi-language property, nested collections included. */
function collectProperties(elements: readonly AasNormElement[]): AasProperty[] {
  const out: AasProperty[] = [];
  walkElements(elements, (el) => {
    if (el.kind !== 'property' && el.kind !== 'mlp') return;
    const value = elementText(el);
    if (el.idShort && value) out.push({ label: cleanLabel(el.idShort), value });
  });
  return out;
}

/** Normalise a file reference to a ZIP path: '\' → '/', no leading '/'. */
function zipPathOf(raw: string): string {
  return raw.replace(/\\/g, '/').replace(/^\//, '');
}

/**
 * PDF documents of the Documentation submodels (idShort matching /document/i).
 *
 * Every File element at any depth counts — VDI 2770 wraps each File in a
 * per-document collection (Festo / Bosch), the metamodel also allows File
 * elements directly under the submodel (SEW). The type comes from `mimeType`
 * (V2) or `contentType` (V3). The title is a VDI2770 Title property of the
 * File's nearest enclosing collection, else the file name.
 */
function collectDocuments(submodels: readonly AasNormSubmodel[]): AasDocument[] {
  const results: AasDocument[] = [];
  const seen = new Set<string>();
  for (const sm of submodels) {
    if (!/document/i.test(sm.idShort)) continue;
    walkElements(sm.elements, (el, parents) => {
      if (el.kind !== 'file') return;
      const mimeType = el.contentType ?? '';
      if (!mimeType.toLowerCase().includes('pdf')) return;
      const rawPath = el.value ?? '';
      if (!rawPath) return;
      const zipPath = zipPathOf(rawPath);
      if (seen.has(zipPath)) return;
      seen.add(zipPath);
      let coll: AasNormElement | undefined;
      for (let i = parents.length - 1; i >= 0 && !coll; i--) if (parents[i].kind === 'collection') coll = parents[i];
      const title = (coll && findDocumentTitle(coll)) || filenameTitle(zipPath);
      results.push({ title, mimeType, zipPath });
    });
  }
  return results;
}

function findDocumentTitle(coll: AasNormElement): string {
  let title = '';
  walkElements(coll.children ?? [], (el) => {
    if (title || (el.kind !== 'property' && el.kind !== 'mlp')) return;
    if (/vdi2770.*title/i.test(el.idShort) || el.idShort === 'Title') title = elementText(el);
  });
  return title;
}

/** Derive a title from a zip path: the filename without its .pdf extension. */
function filenameTitle(zipPath: string): string {
  const filename = zipPath.split('/').pop() || '';
  return filename.replace(/\.pdf$/i, '') || 'Document';
}

// ─── XML entry points (kept for callers and tests) ──────────────────────

/**
 * Parse an AAS XML string (V1/V2/V3, namespace-agnostic) into the
 * tooltip/panel data of its first shell. Throws on malformed XML.
 */
export function parseAasXml(xml: string): AasParsedData {
  return buildAasDetail(parseAasEnvironmentXml(xml), undefined);
}

/** PDF documents of every Documentation submodel in a parsed XML document. */
export function parseDocuments(doc: Document): AasDocument[] {
  return collectDocuments(parseAasEnvironmentXml(doc).submodels);
}
