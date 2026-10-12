// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-aasx-package.ts — read an AASX package without loading it (plan-596 Phase 1).
 *
 * An AASX is an OPC package (a ZIP) that carries one or more Asset
 * Administration Shells as an XML or JSON "spec" part, plus supplementary files
 * (PDFs, images, CAD). The viewer needs three things from it:
 *
 *  1. a SUMMARY per shell — id, idShort, globalAssetId, product name and
 *     manufacturer — for the project index and the inspector picker;
 *  2. the full shell/submodel model for the tooltip and detail panel;
 *  3. single entries (a PDF) on demand.
 *
 * None of that needs the whole file. zip.js reads the end-of-central-directory
 * record and the central directory, then exactly the parts asked for — over a
 * lazy `Blob` (a `File` from the File System Access API, `fs.openAsBlob` in
 * Node) or an HTTP range reader. A 127 MB AASX costs its directory plus a few
 * XML parts instead of 127 MB (acceptance criterion 4 of plan-596).
 *
 * ## OPC walk
 *
 * `/_rels/.rels` → relationship `…/aasx-origin` (with or without `www.`) →
 * `<origin>.rels` → every `…/aas-spec` (and `…/aas-spec-split`) target. Part
 * names are compared case-insensitively after normalisation (`\` → `/`,
 * percent-decoding, `./` and `../`, leading `/`). A package with no usable
 * relationships falls back to the first `*.aas.xml` / `*.aas.json` part, or any
 * XML/JSON part under `aasx/` whose root is an AAS environment, and records a
 * warning instead of failing.
 *
 * ## V2 / V3
 *
 * XML is read namespace-agnostically by `localName`, so AAS V1/V2
 * (`identification`, `submodelElement` wrappers, `mimeType`) and V3 (`id`,
 * unwrapped elements, `contentType`) land in ONE normalised model
 * ({@link AasNormEnvironment}). JSON (V3 serialisation, `modelType` tagged) is
 * mapped onto the same model. Nameplate values are found by `semanticId`
 * (IRDIs below), with the `idShort` as fallback for packages that carry none —
 * the Bosch Rexroth sample in `public/aasx/` is one of those.
 *
 * zip.js is loaded through a DYNAMIC import (bundle-splitting contract,
 * `tests/bundle-splitting.test.ts`); this module itself only imports types.
 */

import type { Entry, FileEntry, ZipReader } from '@zip.js/zip.js';

// ─── Public types ───────────────────────────────────────────────────────

/** A qualifier attached to a shell (validity / origin annotations). */
export interface AasNormQualifier {
  type: string;
  value: string;
}

/** One language variant of a multi-language property. */
export interface AasLangString {
  lang: string;
  text: string;
}

/** A submodel element, normalised across V2 / V3 and XML / JSON. */
export interface AasNormElement {
  kind: 'property' | 'mlp' | 'file' | 'collection' | 'other';
  idShort: string;
  semanticId?: string;
  /** Property value, or the file path of a `file` element. */
  value?: string;
  /** Language variants of a multi-language property. */
  langValues?: AasLangString[];
  /** `mimeType` (V2) / `contentType` (V3) of a `file` element. */
  contentType?: string;
  children?: AasNormElement[];
}

/** A submodel, normalised. */
export interface AasNormSubmodel {
  id: string;
  idShort: string;
  semanticId?: string;
  elements: AasNormElement[];
}

/** A shell, normalised. `submodelIds` are the ids its references name. */
export interface AasNormShell {
  id: string;
  idShort: string;
  globalAssetId?: string;
  submodelIds: string[];
  qualifiers: AasNormQualifier[];
}

/** Every shell and submodel of a package (all spec parts merged). */
export interface AasNormEnvironment {
  shells: AasNormShell[];
  submodels: AasNormSubmodel[];
}

/** What the project index and the picker need to know about one shell. */
export interface AasxShellSummary {
  id: string;
  idShort: string;
  globalAssetId?: string;
  /** Nameplate ManufacturerProductDesignation (en > de > first). */
  productName?: string;
  /** Nameplate ManufacturerName. */
  manufacturer?: string;
}

/** A spec part found by the OPC walk (or the fallback). */
export interface AasxSpecPart {
  path: string;
  format: 'xml' | 'json';
}

/** An opened package. Call {@link AasxPackage.close} when done. */
export interface AasxPackage {
  readonly specParts: readonly AasxSpecPart[];
  readonly warnings: readonly string[];
  /** Parse every spec part into one environment (cached after the first call). */
  readEnvironment(): Promise<AasNormEnvironment>;
  /** True when the package holds an entry at that (normalised) path. */
  hasEntry(path: string): boolean;
  /**
   * Read one entry as a Blob. Paths are normalised; a path without an `aasx/`
   * prefix also matches `aasx/<path>` (older packages reference files that way).
   * Returns null when there is no such entry.
   */
  readEntry(path: string, contentType?: string): Promise<Blob | null>;
  /** Release the reader. Safe to call twice. */
  close(): Promise<void>;
}

/** Where a package is read from: a (lazy) Blob, or a URL. */
export type AasxInput = Blob | { url: string; rangeReads?: boolean; fetchBytes?: (url: string) => Promise<ArrayBuffer> };

/** The outcome of {@link readAasxSummary} — an error OBJECT, never a throw. */
export type AasxSummaryResult =
  | { ok: true; shells: AasxShellSummary[]; warnings: string[] }
  | { ok: false; error: string };

/** Raised for a package that cannot be read at all. */
export class AasxPackageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AasxPackageError';
  }
}

// ─── Constants ──────────────────────────────────────────────────────────

/** Relationship type suffixes (matched after the host, so `www.` is optional). */
const REL_ORIGIN = 'admin-shell.io/aasx/relationships/aasx-origin';
const REL_SPEC = 'admin-shell.io/aasx/relationships/aas-spec';
const REL_SPEC_SPLIT = 'admin-shell.io/aasx/relationships/aas-spec-split';

/** Nameplate IRDIs — verified against the four packages in `public/aasx/`. */
export const IRDI_MANUFACTURER_NAME = '0173-1#02-AAO677';
export const IRDI_PRODUCT_DESIGNATION = '0173-1#02-AAW338';

// ─── zip.js loader (dynamic, once) ──────────────────────────────────────

type ZipModule = typeof import('@zip.js/zip.js');
let _zip: Promise<ZipModule> | null = null;

/** Load zip.js once, off the entry chunk, without web workers. */
export function loadZipJs(): Promise<ZipModule> {
  if (!_zip) {
    _zip = import('@zip.js/zip.js').then((mod) => {
      // Workers would need a worker script URL resolved through the bundler;
      // decompression runs through the native DecompressionStream instead.
      mod.configure({ useWebWorkers: false });
      return mod;
    });
    _zip.catch(() => { _zip = null; });
  }
  return _zip;
}

// ─── Path normalisation ─────────────────────────────────────────────────

/**
 * Normalise an OPC part name or a file reference to a ZIP entry path:
 * `\` → `/`, percent-decoding, `./` and `../` resolved, no leading `/`.
 * Case is preserved; lookups lowercase it themselves.
 */
export function normalizePartPath(raw: string): string {
  let p = raw.trim().replace(/\\/g, '/');
  // Strip a URI scheme an odd writer may put in front of a part name.
  p = p.replace(/^file:\/\//i, '');
  try { p = decodeURIComponent(p); } catch { /* keep as-is */ }
  const out: string[] = [];
  for (const seg of p.split('/')) {
    if (!seg || seg === '.') continue;
    if (seg === '..') { out.pop(); continue; }
    out.push(seg);
  }
  return out.join('/');
}

/** Resolve a relationship target against the directory of its source part. */
function resolveTarget(sourcePart: string, target: string): string {
  const t = target.trim().replace(/\\/g, '/');
  if (t.startsWith('/')) return normalizePartPath(t);
  const dir = sourcePart.includes('/') ? sourcePart.slice(0, sourcePart.lastIndexOf('/') + 1) : '';
  return normalizePartPath(dir + t);
}

/** `a/b/c.xml` → `a/b/_rels/c.xml.rels`; the package root → `_rels/.rels`. */
function relsPathFor(part: string): string {
  if (!part) return '_rels/.rels';
  const slash = part.lastIndexOf('/');
  const dir = slash >= 0 ? part.slice(0, slash + 1) : '';
  return `${dir}_rels/${part.slice(slash + 1)}.rels`;
}

// ─── XML helpers (DOM, namespace-agnostic, xmldom-compatible) ───────────

function parseXml(text: string): Document {
  const Parser = (globalThis as { DOMParser?: typeof DOMParser }).DOMParser;
  if (!Parser) throw new AasxPackageError('No DOMParser available');
  const doc = new Parser().parseFromString(stripBom(text), 'text/xml');
  if (doc.getElementsByTagName('parsererror').length > 0) {
    const msg = doc.getElementsByTagName('parsererror')[0]?.textContent ?? '';
    throw new AasxPackageError(`XML parse error: ${msg.substring(0, 200)}`);
  }
  return doc;
}

function stripBom(text: string): string {
  return text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
}

/** Element children (works on browser DOM and xmldom alike). */
function childElements(el: Element | Document): Element[] {
  const out: Element[] = [];
  const nodes = el.childNodes;
  for (let i = 0; i < nodes.length; i++) {
    const n = nodes[i];
    if (n.nodeType === 1) out.push(n as Element);
  }
  return out;
}

function localNameOf(el: Element): string {
  return el.localName || (el.nodeName.includes(':') ? el.nodeName.split(':').pop()! : el.nodeName);
}

function child(el: Element, name: string): Element | null {
  for (const c of childElements(el)) if (localNameOf(c) === name) return c;
  return null;
}

function children(el: Element, name: string): Element[] {
  return childElements(el).filter((c) => localNameOf(c) === name);
}

function childText(el: Element, name: string): string {
  return child(el, name)?.textContent?.trim() ?? '';
}

function descendants(el: Element | Document, name: string): Element[] {
  const out: Element[] = [];
  const all = el.getElementsByTagName('*');
  for (let i = 0; i < all.length; i++) if (localNameOf(all[i]) === name) out.push(all[i]);
  return out;
}

// ─── XML → normalised model ─────────────────────────────────────────────

/** First key value of a reference element (`semanticId`, `assetRef`, `reference`). */
function referenceValue(ref: Element | null): string {
  if (!ref) return '';
  const keys = child(ref, 'keys');
  if (keys) {
    const key = child(keys, 'key');
    if (key) {
      // V3: <key><type/><value/></key>; V2: <key ...>text</key>
      const v = child(key, 'value');
      return (v ? v.textContent : key.textContent)?.trim() ?? '';
    }
  }
  // V3.0 globalAssetId / plain text reference
  return childElements(ref).length === 0 ? ref.textContent?.trim() ?? '' : '';
}

/** All key values of a reference — the LAST one names the submodel in V2 chains. */
function referenceKeys(ref: Element): string[] {
  const keys = child(ref, 'keys');
  if (!keys) return [];
  return children(keys, 'key').map((key) => {
    const v = child(key, 'value');
    return (v ? v.textContent : key.textContent)?.trim() ?? '';
  }).filter(Boolean);
}

function xmlIdOf(el: Element): string {
  return childText(el, 'identification') || childText(el, 'id');
}

function xmlQualifiers(shell: Element): AasNormQualifier[] {
  const out: AasNormQualifier[] = [];
  for (const c of childElements(shell)) {
    const ln = localNameOf(c);
    if (ln !== 'qualifier' && ln !== 'qualifiers') continue;
    const qs = ln === 'qualifiers' ? children(c, 'qualifier') : [c];
    for (const q of qs) {
      const type = descendantText(q, 'type');
      const value = descendantText(q, 'value');
      if (type) out.push({ type, value });
    }
  }
  return out;
}

function descendantText(el: Element, name: string): string {
  return descendants(el, name)[0]?.textContent?.trim() ?? '';
}

function xmlShell(shell: Element): AasNormShell {
  const submodelIds: string[] = [];
  // V2: <submodelRefs><submodelRef><keys>…  V3: <submodels><reference><keys>…
  const v2 = child(shell, 'submodelRefs');
  if (v2) for (const r of children(v2, 'submodelRef')) {
    const keys = referenceKeys(r);
    if (keys.length) submodelIds.push(keys[keys.length - 1]);
  }
  const v3 = child(shell, 'submodels');
  if (v3) for (const r of children(v3, 'reference')) {
    const keys = referenceKeys(r);
    if (keys.length) submodelIds.push(keys[keys.length - 1]);
  }
  let globalAssetId = '';
  const info = child(shell, 'assetInformation');
  if (info) globalAssetId = referenceValue(child(info, 'globalAssetId'));
  if (!globalAssetId) globalAssetId = referenceValue(child(shell, 'assetRef'));
  return {
    id: xmlIdOf(shell),
    idShort: childText(shell, 'idShort'),
    ...(globalAssetId ? { globalAssetId } : {}),
    submodelIds,
    qualifiers: xmlQualifiers(shell),
  };
}

/** Unwrap V2 `<submodelElement>` wrappers; V3 lists elements directly. */
function xmlElementList(container: Element | null): Element[] {
  if (!container) return [];
  const out: Element[] = [];
  for (const c of childElements(container)) {
    if (localNameOf(c) === 'submodelElement') {
      const inner = childElements(c)[0];
      if (inner) out.push(inner);
    } else {
      out.push(c);
    }
  }
  return out;
}

function xmlLangStrings(valueEl: Element): AasLangString[] {
  const out: AasLangString[] = [];
  for (const c of childElements(valueEl)) {
    const ln = localNameOf(c);
    if (ln === 'langString') {
      out.push({ lang: c.getAttribute('lang') ?? '', text: c.textContent?.trim() ?? '' });
    } else if (ln.startsWith('langString')) {
      // V3: <langStringTextType><language/><text/></…>
      out.push({ lang: childText(c, 'language'), text: childText(c, 'text') });
    }
  }
  return out;
}

function xmlElement(el: Element): AasNormElement {
  const ln = localNameOf(el);
  const idShort = childText(el, 'idShort');
  const semanticId = referenceValue(child(el, 'semanticId')) || undefined;
  const base = { idShort, ...(semanticId ? { semanticId } : {}) };
  if (ln === 'property') {
    return { kind: 'property', ...base, value: childText(el, 'value') };
  }
  if (ln === 'multiLanguageProperty') {
    const v = child(el, 'value');
    return { kind: 'mlp', ...base, langValues: v ? xmlLangStrings(v) : [] };
  }
  if (ln === 'file') {
    return {
      kind: 'file',
      ...base,
      value: childText(el, 'value'),
      contentType: childText(el, 'mimeType') || childText(el, 'contentType'),
    };
  }
  if (ln === 'submodelElementCollection' || ln === 'submodelElementList' || ln === 'entity') {
    const container = child(el, 'value') ?? child(el, 'statements');
    return { kind: 'collection', ...base, children: xmlElementList(container).map(xmlElement) };
  }
  return { kind: 'other', ...base };
}

function xmlSubmodel(sm: Element): AasNormSubmodel {
  const semanticId = referenceValue(child(sm, 'semanticId')) || undefined;
  return {
    id: xmlIdOf(sm),
    idShort: childText(sm, 'idShort'),
    ...(semanticId ? { semanticId } : {}),
    elements: xmlElementList(child(sm, 'submodelElements')).map(xmlElement),
  };
}

/** Parse an AAS XML document (V1/V2/V3) into the normalised model. */
export function parseAasEnvironmentXml(xml: string | Document): AasNormEnvironment {
  const doc = typeof xml === 'string' ? parseXml(xml) : xml;
  return {
    shells: descendants(doc, 'assetAdministrationShell').map(xmlShell),
    submodels: descendants(doc, 'submodel').map(xmlSubmodel),
  };
}

// ─── JSON → normalised model ────────────────────────────────────────────

type Json = Record<string, unknown>;

function asObj(v: unknown): Json | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : null;
}

function asArr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function jsonRefKeys(ref: unknown): string[] {
  const o = asObj(ref);
  if (!o) return typeof ref === 'string' ? [ref] : [];
  return asArr(o.keys).map((k) => str(asObj(k)?.value)).filter(Boolean);
}

function jsonRefFirst(ref: unknown): string {
  return jsonRefKeys(ref)[0] ?? '';
}

function jsonLang(v: unknown): AasLangString[] {
  return asArr(v).map((x) => {
    const o = asObj(x) ?? {};
    return { lang: str(o.language ?? o.lang), text: str(o.text) };
  });
}

function jsonElement(raw: unknown): AasNormElement {
  const o = asObj(raw) ?? {};
  const type = str(o.modelType ?? asObj(o.modelType)?.name);
  const idShort = str(o.idShort);
  const semanticId = jsonRefFirst(o.semanticId) || undefined;
  const base = { idShort, ...(semanticId ? { semanticId } : {}) };
  switch (type) {
    case 'Property':
      return { kind: 'property', ...base, value: str(o.value) || (o.value != null ? String(o.value) : '') };
    case 'MultiLanguageProperty':
      return { kind: 'mlp', ...base, langValues: jsonLang(o.value) };
    case 'File':
      return { kind: 'file', ...base, value: str(o.value), contentType: str(o.contentType ?? o.mimeType) };
    case 'SubmodelElementCollection':
    case 'SubmodelElementList':
      return { kind: 'collection', ...base, children: asArr(o.value).map(jsonElement) };
    case 'Entity':
      return { kind: 'collection', ...base, children: asArr(o.statements).map(jsonElement) };
    default:
      return { kind: 'other', ...base };
  }
}

/** Parse an AAS JSON environment (V3 serialisation) into the normalised model. */
export function parseAasEnvironmentJson(text: string | unknown): AasNormEnvironment {
  let root: unknown = text;
  if (typeof text === 'string') {
    try { root = JSON.parse(stripBom(text)); } catch (e) {
      throw new AasxPackageError(`JSON parse error: ${e instanceof Error ? e.message : String(e)}`);
    }
  }
  const env = asObj(root);
  if (!env) throw new AasxPackageError('AAS JSON is not an object');
  const shells: AasNormShell[] = asArr(env.assetAdministrationShells).map((s) => {
    const o = asObj(s) ?? {};
    const info = asObj(o.assetInformation);
    const globalAssetId = str(info?.globalAssetId) || jsonRefFirst(info?.globalAssetId) || jsonRefFirst(o.asset);
    return {
      id: str(o.id) || str(asObj(o.identification)?.id),
      idShort: str(o.idShort),
      ...(globalAssetId ? { globalAssetId } : {}),
      submodelIds: asArr(o.submodels).map((r) => {
        const keys = jsonRefKeys(r);
        return keys[keys.length - 1] ?? '';
      }).filter(Boolean),
      qualifiers: asArr(o.qualifiers).map((q) => ({ type: str(asObj(q)?.type), value: str(asObj(q)?.value) }))
        .filter((q) => q.type),
    };
  });
  const submodels: AasNormSubmodel[] = asArr(env.submodels).map((s) => {
    const o = asObj(s) ?? {};
    const semanticId = jsonRefFirst(o.semanticId) || undefined;
    return {
      id: str(o.id) || str(asObj(o.identification)?.id),
      idShort: str(o.idShort),
      ...(semanticId ? { semanticId } : {}),
      elements: asArr(o.submodelElements).map(jsonElement),
    };
  });
  return { shells, submodels };
}

// ─── Model queries ──────────────────────────────────────────────────────

/** The submodels a shell references; ALL submodels when it references none. */
export function submodelsOfShell(env: AasNormEnvironment, shell: AasNormShell): AasNormSubmodel[] {
  if (shell.submodelIds.length === 0) {
    // A shell without references (hand-made / minimal packages): the whole
    // environment belongs to it when it is the only shell, nothing otherwise.
    return env.shells.length <= 1 ? env.submodels : [];
  }
  const wanted = new Set(shell.submodelIds);
  const found = env.submodels.filter((sm) => wanted.has(sm.id));
  // References that resolve to nothing (ids written differently) — fall back
  // to the whole environment for a single-shell package rather than to nothing.
  return found.length === 0 && env.shells.length <= 1 ? env.submodels : found;
}

/** Pick a language variant: en > de > first non-empty. */
export function pickLang(values: readonly AasLangString[] | undefined): string {
  if (!values || values.length === 0) return '';
  const by = (re: RegExp) => values.find((v) => re.test(v.lang) && v.text)?.text;
  return by(/^en/i) ?? by(/^de/i) ?? values.find((v) => v.text)?.text ?? '';
}

/** Value text of a property or multi-language property. */
export function elementText(el: AasNormElement): string {
  if (el.kind === 'property') return el.value ?? '';
  if (el.kind === 'mlp') return pickLang(el.langValues);
  return '';
}

/** Depth-first walk over every element of a submodel. */
export function walkElements(elements: readonly AasNormElement[], visit: (el: AasNormElement, parents: AasNormElement[]) => void, parents: AasNormElement[] = []): void {
  for (const el of elements) {
    visit(el, parents);
    if (el.children) walkElements(el.children, visit, [...parents, el]);
  }
}

function isNameplate(sm: AasNormSubmodel): boolean {
  return /nameplate/i.test(sm.idShort) || /nameplate/i.test(sm.semanticId ?? '');
}

function findNameplateValue(sms: readonly AasNormSubmodel[], irdi: string, idShort: string): string {
  let bySemantic = '';
  let byName = '';
  for (const sm of sms) {
    if (!isNameplate(sm)) continue;
    walkElements(sm.elements, (el) => {
      const text = elementText(el);
      if (!text) return;
      if (!bySemantic && el.semanticId && el.semanticId.startsWith(irdi)) bySemantic = text;
      if (!byName && el.idShort === idShort) byName = text;
    });
  }
  return bySemantic || byName;
}

/** Summaries of every shell in an environment. */
export function summarizeEnvironment(env: AasNormEnvironment): AasxShellSummary[] {
  return env.shells.filter((s) => s.id).map((shell) => {
    const sms = submodelsOfShell(env, shell);
    const productName = findNameplateValue(sms, IRDI_PRODUCT_DESIGNATION, 'ManufacturerProductDesignation');
    const manufacturer = findNameplateValue(sms, IRDI_MANUFACTURER_NAME, 'ManufacturerName');
    return {
      id: shell.id,
      idShort: shell.idShort,
      ...(shell.globalAssetId ? { globalAssetId: shell.globalAssetId } : {}),
      ...(productName ? { productName } : {}),
      ...(manufacturer ? { manufacturer } : {}),
    };
  });
}

function mergeEnvironments(list: AasNormEnvironment[]): AasNormEnvironment {
  const out: AasNormEnvironment = { shells: [], submodels: [] };
  for (const env of list) {
    out.shells.push(...env.shells);
    out.submodels.push(...env.submodels);
  }
  return out;
}

// ─── Package reader ─────────────────────────────────────────────────────

interface Relationship { type: string; target: string }

function parseRels(xml: string): Relationship[] {
  const doc = parseXml(xml);
  return descendants(doc, 'Relationship').map((r) => ({
    type: r.getAttribute('Type') ?? '',
    target: r.getAttribute('Target') ?? '',
  }));
}

function relMatches(type: string, suffix: string): boolean {
  // `http://admin-shell.io/…` and `http://www.admin-shell.io/…` (and https).
  return type.replace(/^https?:\/\/(www\.)?/i, '').toLowerCase() === suffix.toLowerCase();
}

interface ContentTypes { defaults: Map<string, string>; overrides: Map<string, string> }

function parseContentTypes(xml: string): ContentTypes {
  const doc = parseXml(xml);
  const defaults = new Map<string, string>();
  const overrides = new Map<string, string>();
  for (const d of descendants(doc, 'Default')) {
    defaults.set((d.getAttribute('Extension') ?? '').toLowerCase(), d.getAttribute('ContentType') ?? '');
  }
  for (const o of descendants(doc, 'Override')) {
    overrides.set(normalizePartPath(o.getAttribute('PartName') ?? '').toLowerCase(), o.getAttribute('ContentType') ?? '');
  }
  return { defaults, overrides };
}

function formatOf(path: string, types: ContentTypes | null): 'xml' | 'json' {
  const key = path.toLowerCase();
  const ct = types?.overrides.get(key) ?? types?.defaults.get(key.split('.').pop() ?? '') ?? '';
  if (/json/i.test(ct)) return 'json';
  if (/xml/i.test(ct)) return 'xml';
  return key.endsWith('.json') ? 'json' : 'xml';
}

class OpenedAasxPackage implements AasxPackage {
  readonly specParts: AasxSpecPart[] = [];
  readonly warnings: string[] = [];
  private _env: Promise<AasNormEnvironment> | null = null;
  private _closed = false;

  constructor(
    private readonly _zipjs: ZipModule,
    private readonly _reader: ZipReader<unknown>,
    private readonly _entries: Map<string, FileEntry>,
  ) {}

  hasEntry(path: string): boolean {
    return this._lookup(path) !== null;
  }

  async readText(path: string): Promise<string | null> {
    const e = this._lookup(path);
    if (!e) return null;
    return stripBom(await e.getData(new this._zipjs.TextWriter()));
  }

  async readEntry(path: string, contentType?: string): Promise<Blob | null> {
    const e = this._lookup(path);
    if (!e) return null;
    return e.getData(new this._zipjs.BlobWriter(contentType ?? guessContentType(e.filename)));
  }

  readEnvironment(): Promise<AasNormEnvironment> {
    if (!this._env) {
      this._env = (async () => {
        const envs: AasNormEnvironment[] = [];
        for (const part of this.specParts) {
          const text = await this.readText(part.path);
          if (text === null) {
            this.warnings.push(`Spec part missing: ${part.path}`);
            continue;
          }
          envs.push(part.format === 'json' ? parseAasEnvironmentJson(text) : parseAasEnvironmentXml(text));
        }
        return mergeEnvironments(envs);
      })();
      this._env.catch(() => { this._env = null; });
    }
    return this._env;
  }

  async close(): Promise<void> {
    if (this._closed) return;
    this._closed = true;
    try { await this._reader.close(); } catch { /* already gone */ }
  }

  /** Case-insensitive, normalised lookup; `x` also matches `aasx/x`. */
  _lookup(path: string): FileEntry | null {
    const key = normalizePartPath(path).toLowerCase();
    return this._entries.get(key)
      ?? (!key.startsWith('aasx/') ? this._entries.get(`aasx/${key}`) ?? null : null);
  }

  _paths(): string[] {
    return [...this._entries.values()].map((e) => normalizePartPath(e.filename));
  }
}

function guessContentType(name: string): string {
  const ext = name.toLowerCase().split('.').pop() ?? '';
  switch (ext) {
    case 'pdf': return 'application/pdf';
    case 'png': return 'image/png';
    case 'jpg': case 'jpeg': return 'image/jpeg';
    case 'svg': return 'image/svg+xml';
    case 'xml': return 'text/xml';
    case 'json': return 'application/json';
    default: return 'application/octet-stream';
  }
}

/** A JSON document whose root looks like an AAS environment. */
function looksLikeAasJson(text: string): boolean {
  return /"assetAdministrationShells"\s*:/.test(text);
}

/** An XML document whose root element is an AAS environment. */
function looksLikeAasXml(text: string): boolean {
  return /<(?:[\w-]+:)?(?:aasenv|environment)[\s>]/.test(text) && /assetAdministrationShell/.test(text);
}

/** Walk the OPC relationships; fill `specParts` and `warnings`. */
async function discoverSpecParts(pkg: OpenedAasxPackage): Promise<void> {
  let types: ContentTypes | null = null;
  try {
    const ct = await pkg.readText('[Content_Types].xml');
    if (ct) types = parseContentTypes(ct);
    else pkg.warnings.push('[Content_Types].xml missing — content types guessed from extensions');
  } catch {
    pkg.warnings.push('[Content_Types].xml unreadable — content types guessed from extensions');
  }

  const seen = new Set<string>();
  const add = (path: string): void => {
    const key = path.toLowerCase();
    if (seen.has(key) || !pkg.hasEntry(path)) return;
    seen.add(key);
    pkg.specParts.push({ path, format: formatOf(path, types) });
  };

  try {
    const rootRels = await pkg.readText('_rels/.rels');
    if (rootRels) {
      for (const rel of parseRels(rootRels)) {
        if (!relMatches(rel.type, REL_ORIGIN)) continue;
        const origin = resolveTarget('', rel.target);
        const originRels = await pkg.readText(relsPathFor(origin));
        if (!originRels) continue;
        for (const r of parseRels(originRels)) {
          if (relMatches(r.type, REL_SPEC) || relMatches(r.type, REL_SPEC_SPLIT)) {
            add(resolveTarget(origin, r.target));
          }
        }
      }
    }
  } catch (e) {
    pkg.warnings.push(`Relationships unreadable: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (pkg.specParts.length > 0) return;

  // Fallback: no usable relationships. First the conventional names, then any
  // XML/JSON under aasx/ whose root is an AAS environment.
  const paths = pkg._paths();
  const named = paths.find((p) => /\.aas\.(xml|json)$/i.test(p));
  if (named) {
    add(named);
  } else {
    for (const p of paths) {
      if (!/^aasx\/.*\.(xml|json)$/i.test(p) || /(^|\/)_rels\//i.test(p)) continue;
      const text = await pkg.readText(p);
      if (text && (/\.json$/i.test(p) ? looksLikeAasJson(text) : looksLikeAasXml(text))) {
        add(p);
        break;
      }
    }
  }
  if (pkg.specParts.length > 0) {
    pkg.warnings.push(`No aas-spec relationship — using ${pkg.specParts[0].path}`);
  }
}

async function readerFor(zipjs: ZipModule, input: AasxInput): Promise<InstanceType<ZipModule['BlobReader']> | InstanceType<ZipModule['HttpRangeReader']>> {
  if (isBlobLike(input)) return new zipjs.BlobReader(input as Blob);
  if (input.rangeReads) return new zipjs.HttpRangeReader(input.url);
  const fetchBytes = input.fetchBytes ?? (async (url: string) => {
    const r = await fetch(url);
    if (!r.ok) throw new AasxPackageError(`Failed to load ${url}: ${r.status}`);
    return r.arrayBuffer();
  });
  return new zipjs.BlobReader(new Blob([await fetchBytes(input.url)]));
}

function isBlobLike(v: unknown): v is Blob {
  return !!v && typeof (v as Blob).slice === 'function' && typeof (v as Blob).size === 'number';
}

/**
 * Open an AASX package: read the ZIP directory and walk the OPC relationships.
 * Throws {@link AasxPackageError} for a file that is not a readable ZIP or has
 * no AAS spec part at all.
 */
export async function openAasxPackage(input: AasxInput): Promise<AasxPackage> {
  const zipjs = await loadZipJs();
  // Outside the try: a failed download is reported as such, not as a bad ZIP.
  const source = await readerFor(zipjs, input);
  let reader: ZipReader<unknown>;
  let entries: Entry[];
  try {
    reader = new zipjs.ZipReader(source as never);
    entries = await reader.getEntries();
  } catch (e) {
    if (e instanceof AasxPackageError) throw e;
    throw new AasxPackageError(`Not a readable AASX (ZIP): ${e instanceof Error ? e.message : String(e)}`);
  }
  const map = new Map<string, FileEntry>();
  for (const e of entries) {
    if (e.directory) continue;
    map.set(normalizePartPath(e.filename).toLowerCase(), e as FileEntry);
  }
  const pkg = new OpenedAasxPackage(zipjs, reader, map);
  await discoverSpecParts(pkg);
  if (pkg.specParts.length === 0) {
    await pkg.close();
    throw new AasxPackageError('No AAS spec part found in package');
  }
  return pkg;
}

/**
 * Read the shell summaries of a package and close it again. Never throws: a
 * broken file comes back as `{ ok: false, error }` so a scan can record it and
 * go on with the next file.
 */
export async function readAasxSummary(input: AasxInput): Promise<AasxSummaryResult> {
  let pkg: AasxPackage | null = null;
  try {
    pkg = await openAasxPackage(input);
    const env = await pkg.readEnvironment();
    const shells = summarizeEnvironment(env);
    if (shells.length === 0) return { ok: false, error: 'Package contains no Asset Administration Shell' };
    return { ok: true, shells, warnings: [...pkg.warnings] };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  } finally {
    await pkg?.close();
  }
}
