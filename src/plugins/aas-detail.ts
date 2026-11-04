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
 * (V2) or `contentType` (V3).
 *
 * Metadata follows IDTA 02004 (Handover Documentation) where present:
 * `Documents / DocumentNN / DocumentVersions / DocumentVersionNN` carries
 * `Title`, `Language`, `KeyWords` (multi-language), the File sits one list
 * further down in `DigitalFiles`; `DocumentClassifications` holds `ClassName`.
 * The title falls back from Title (UI language, else de / en) to the
 * document's idShort without its `DocumentNN_` prefix, then to the file name.
 * The shown title adds the language and the kind:
 * "Operation EHPS (EN) · Operating instructions".
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
      const rawPath = (el.value ?? '').trim();
      if (!rawPath) return;
      // A File value may be an absolute address instead of a package path:
      // Festo's type AAS link every manual on festo.com. Kept as `url`, never
      // looked up in the ZIP (where it can only fail with "File not found").
      const external = /^https?:\/\//i.test(rawPath);
      const zipPath = external ? '' : zipPathOf(rawPath);
      const key = external ? rawPath : zipPath;
      if (seen.has(key)) return;
      seen.add(key);
      const meta = documentMeta(parents);
      const base = meta.title || filenameTitle(external ? rawPath.replace(/[?#].*$/, '') : zipPath);
      const doc: AasDocument = { title: composeDocumentTitle(base, meta.language, meta.kind), mimeType, zipPath };
      if (external) doc.url = rawPath;
      if (meta.language) doc.language = meta.language;
      if (meta.kind) doc.kind = meta.kind;
      // plan-682 Phase 3: the parts of the title, kept apart for the grouped list
      // (aas-tooltip-groups.ts). `title` above stays the composed legacy title.
      // Only for documents inside a document container (IDTA 02004 / VDI 2770
      // `DocumentNN`); a loose File keeps the legacy shape and its `title`.
      if (meta.documentIdShort) {
        doc.baseTitle = meta.title;
        doc.documentIdShort = meta.documentIdShort;
        if (meta.subtitle) doc.subtitle = meta.subtitle;
        if (meta.version) doc.version = meta.version;
      }
      results.push(doc);
    });
  }
  return results;
}

/** The languages a multi-language value is read in: the UI language first, then de, en. */
function preferredLanguages(): string[] {
  const ui = (typeof document !== 'undefined' && document.documentElement?.lang)
    || (typeof navigator !== 'undefined' ? navigator.language : '') || '';
  const primary = ui.toLowerCase().split('-')[0];
  return [...new Set([primary, 'de', 'en'].filter(Boolean))];
}

/** Text of a property / multi-language property in the preferred language. */
function textIn(el: AasNormElement | undefined, langs: readonly string[]): string {
  if (!el) return '';
  if (el.kind === 'property') return (el.value ?? '').trim();
  if (el.kind !== 'mlp') return '';
  const values = el.langValues ?? [];
  for (const lang of langs) {
    const hit = values.find(v => v.lang.toLowerCase().split('-')[0] === lang && v.text?.trim());
    if (hit) return hit.text.trim();
  }
  return (values.find(v => v.text?.trim())?.text ?? '').trim();
}

/** A direct child by idShort pattern. */
function childNamed(coll: AasNormElement | undefined, re: RegExp): AasNormElement | undefined {
  return coll?.children?.find(c => re.test(c.idShort));
}

/** First property / multi-language property below `coll` (depth-first) by idShort pattern. */
function descendantNamed(coll: AasNormElement | undefined, re: RegExp): AasNormElement | undefined {
  let found: AasNormElement | undefined;
  walkElements(coll?.children ?? [], (el) => {
    if (!found && (el.kind === 'property' || el.kind === 'mlp') && re.test(el.idShort)) found = el;
  });
  return found;
}

const TITLE_ID = /^(Title|VDI2770_Title)$/i;
const LANGUAGE_ID = /^Language\d*$/i;
const SUBTITLE_ID = /^(Subtitle|SubTitle|VDI2770_Subtitle)$/i;
const VERSION_ID = /^(Version|DocumentVersionId|VDI2770_DocumentVersionId)$/i;
/** A document container: `DocumentNN…`, `Document_…` or plain `Document` (not the Documents / DocumentVersions lists). */
const DOCUMENT_ID = /^Document(\d|_|$)/i;

/** Title, language and kind of the document a File belongs to (see collectDocuments). */
function documentMeta(parents: readonly AasNormElement[]): {
  title: string; language: string; kind: string; subtitle: string; version: string; documentIdShort: string;
} {
  const langs = preferredLanguages();
  const colls = parents.filter(p => p.kind === 'collection');
  // The version: the innermost collection carrying a title or a language directly
  // (IDTA DocumentVersionNN; a VDI 2770 V2 document collection).
  let versionIdx = -1;
  for (let i = colls.length - 1; i >= 0 && versionIdx < 0; i--) {
    if (childNamed(colls[i], TITLE_ID) || childNamed(colls[i], LANGUAGE_ID)) versionIdx = i;
  }
  const version = versionIdx >= 0 ? colls[versionIdx] : undefined;
  // The document: the nearest collection above the version named DocumentNN…
  // (never the Documents / DocumentVersions lists).
  let doc: AasNormElement | undefined;
  for (let i = (versionIdx >= 0 ? versionIdx : colls.length) - 1; i >= 0 && !doc; i--) {
    if (DOCUMENT_ID.test(colls[i].idShort)) doc = colls[i];
  }

  let title = textIn(childNamed(version, TITLE_ID), langs);
  // Legacy shapes (VDI 2770 V2): a title anywhere inside the File's own collection,
  // or up to its DocumentNN - never above it, where a sibling document's title sits.
  const lowest = doc ? colls.indexOf(doc) : colls.length - 1;
  for (let i = colls.length - 1; i >= Math.max(lowest, 0) && !title; i--) title = findDocumentTitle(colls[i]);
  if (!title && doc) {
    const stripped = doc.idShort.replace(/^Document\d+_?/i, '');
    if (stripped) title = cleanLabel(stripped);
  }

  // Language may be a Property or a MultiLanguageProperty (IDTA 02004 allows both).
  const language = textIn(childNamed(version, LANGUAGE_ID), langs).toUpperCase();
  const kind = textIn(childNamed(version, /^KeyWords?$/i), langs)
    || textIn(descendantNamed(doc, /^ClassName$/i), langs);
  const subtitle = textIn(childNamed(version, SUBTITLE_ID), langs);
  const versionText = textIn(childNamed(version, VERSION_ID), langs);
  return { title, language, kind, subtitle, version: versionText, documentIdShort: doc?.idShort ?? '' };
}

/** "Title (LANG) · Kind"; a trailing "-DE"-style language suffix moves into the brackets. */
export function composeDocumentTitle(title: string, language: string, kind: string): string {
  let out = title;
  if (language && /^[A-Z]{2,3}$/.test(language)) {
    out = `${out.replace(new RegExp(`[\\s_-]+${language}$`, 'i'), '')} (${language})`;
  }
  if (kind && !out.toLowerCase().includes(kind.toLowerCase())) out = `${out} · ${kind}`;
  return out;
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
