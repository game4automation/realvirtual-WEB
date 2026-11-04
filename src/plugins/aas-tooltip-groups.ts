// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * aas-tooltip-groups.ts — pure grouping of AAS documents for the pinned AAS
 * tooltip and the AAS detail panel (plan-682 Phase 3).
 *
 * A component's HandoverDocumentation can list 20–30 documents, every one of
 * them twice (DE and EN are separate documents in IDTA 02004). Shown flat that
 * is unreadable. The rules here:
 *
 *  - **Group by document kind** — the `KeyWords` of the version, else the
 *    VDI 2770 `ClassName` (`AasDocument.kind`). Kinds are matched through a
 *    small DE/EN synonym table, case- and umlaut-insensitive; an unknown kind
 *    keeps its own text as a group of its own; no kind → "Other documents".
 *  - **Important kinds first**: operating instructions, full documentation,
 *    declaration of conformity, datasheet, catalogue, application description,
 *    application note, software — then the rest alphabetically, "Other" last.
 *  - **One row per document, not per language**: translations of the same
 *    document collapse into one entry. Its primary document is the one in the
 *    preferred (UI) language, the other languages ride along as alternates.
 *    Translations are recognised by their address (same URL with only the
 *    language segment different — `…/de/652885` ↔ `…/en/652885`), else by
 *    their position: the k-th German document of a kind pairs with the k-th
 *    English one (IDTA files list them pairwise).
 *  - **Titles**: `baseTitle – subtitle`, falling back to the document idShort
 *    (without its `DocumentNN_` prefix) and then the file name; a trailing
 *    `-DE`-style language suffix is dropped (the language is a chip). The
 *    version is a separate tag, never part of the title.
 *
 * No DOM, no React — tested in `tests/aas-tooltip-groups.test.ts`.
 */

import type { AasDocument } from './aas-link-parser';

// ─── Types ──────────────────────────────────────────────────────────────

/** One row of the document list: a document and its translations. */
export interface AasDocEntry {
  /** The document in the preferred language (else the first one listed). */
  primary: AasDocument;
  /** The same document in other languages, sorted by language. */
  alternates: AasDocument[];
  /**
   * Title shown for the row: the primary's {@link displayTitle}; when that title
   * repeats inside the group (vendors often title every translation
   * "Identification") and a translation carries a distinct one, that one.
   */
  title: string;
}

/** One kind of document with its rows. */
export interface AasDocGroup {
  /** Stable key: a canonical kind id (`operating-instructions`, …), the normalised authored kind, or `other`. */
  key: string;
  /** Label as shown: the authored kind text of the primary documents, else the canonical label. */
  label: string;
  /** Rows, preferred language first, then by title. */
  entries: AasDocEntry[];
  /** Number of documents in the group (all languages). */
  docCount: number;
}

/**
 * The UI languages, most preferred first: the document language, then the
 * browser language, then de / en (same order the parser reads titles in).
 */
export function uiLanguages(): string[] {
  const ui = (typeof document !== 'undefined' && document.documentElement?.lang)
    || (typeof navigator !== 'undefined' ? navigator.language : '') || '';
  const primary = ui.toLowerCase().split('-')[0];
  return [...new Set([primary, 'de', 'en'].filter(Boolean))];
}

// ─── Kind table ─────────────────────────────────────────────────────────

interface KindDef { key: string; label: string; synonyms: string[] }

/** Canonical kinds in display order. Synonyms are matched after {@link normKind}. */
const KINDS: readonly KindDef[] = [
  { key: 'operating-instructions', label: 'Operating instructions', synonyms: ['operatinginstructions', 'operatingmanual', 'operatinginstruction', 'instructionmanual', 'usermanual', 'betriebsanleitung', 'bedienungsanleitung', 'gebrauchsanleitung', 'bedienanleitung', 'manual', 'handbuch', 'operation', 'bedienung'] },
  { key: 'full-documentation', label: 'Full documentation', synonyms: ['fulldocumentation', 'volldokumentation', 'completedocumentation', 'gesamtdokumentation'] },
  { key: 'declaration-of-conformity', label: 'Declaration of conformity', synonyms: ['declarationofconformity', 'konformitaetserklaerung', 'konformitatserklarung', 'eudeclarationofconformity', 'eukonformitaetserklaerung', 'certificate', 'certificates', 'zertifikat'] },
  { key: 'datasheet', label: 'Datasheet', synonyms: ['datasheet', 'datenblatt', 'technicaldatasheet', 'technischesdatenblatt', 'productdatasheet', 'produktdatenblatt'] },
  { key: 'catalogue', label: 'Catalogue', synonyms: ['catalogue', 'catalog', 'katalog'] },
  { key: 'application-description', label: 'Application description', synonyms: ['applicationdescription', 'anwendungsbeschreibung', 'applicationexample', 'anwendungsbeispiel'] },
  { key: 'application-note', label: 'Application note', synonyms: ['applicationnote', 'applikationshinweis', 'anwendungshinweis', 'applicationnotes'] },
  { key: 'software', label: 'Software', synonyms: ['software', 'firmware'] },
];

/** Rank of the catch-all group. Unknown kinds sit between the table and it. */
const OTHER_KEY = 'other';
const OTHER_LABEL = 'Other documents';

/** Lower case, umlauts transliterated, everything but letters and digits removed. */
export function normKind(text: string): string {
  return text
    .toLowerCase()
    .replace(/ä/g, 'ae').replace(/ö/g, 'oe').replace(/ü/g, 'ue').replace(/ß/g, 'ss')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** The canonical kind a document belongs to, or its own normalised kind, or `other`. */
export function documentKind(doc: AasDocument): { key: string; rank: number; canonical: string | null } {
  const raw = (doc.kind ?? '').trim();
  if (!raw) return { key: OTHER_KEY, rank: Number.MAX_SAFE_INTEGER, canonical: null };
  const n = normKind(raw);
  for (let i = 0; i < KINDS.length; i++) {
    if (KINDS[i].synonyms.includes(n)) return { key: KINDS[i].key, rank: i, canonical: KINDS[i].label };
  }
  return { key: `kind:${n}`, rank: KINDS.length, canonical: null };
}

// ─── Titles ─────────────────────────────────────────────────────────────

/**
 * Decode character references that some vendors write into AAS texts a second
 * time (`M&#252;nzen` arrives as literal text after XML parsing).
 */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text
    .replace(/&#(\d+);/g, (_, d: string) => String.fromCodePoint(Number(d)))
    .replace(/&#x([0-9a-f]+);/gi, (_, h: string) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Trailing language suffix ("Bedienung EHPS-DE" → "Bedienung EHPS"). */
function stripLanguageSuffix(title: string, language: string | undefined): string {
  if (!language || !/^[a-z]{2,3}$/i.test(language)) return title;
  return title.replace(new RegExp(`[\\s_-]+${language}$`, 'i'), '').trim();
}

/** The file name of a document without extension (title of last resort). */
function fileNameOf(doc: AasDocument): string {
  const src = (doc.url ? doc.url.replace(/[?#].*$/, '') : doc.zipPath) || '';
  const name = src.split('/').pop() ?? '';
  return name.replace(/\.pdf$/i, '');
}

/** idShort of the document container without its `DocumentNN_` prefix, camel case split. */
function idShortTitle(doc: AasDocument): string {
  const id = (doc.documentIdShort ?? '').replace(/^Document\d*_?/i, '');
  return id.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').trim();
}

/**
 * Display title: `baseTitle – subtitle`, fallback the document idShort, then the
 * file name. The version is NOT part of it ({@link AasDocument.version} is a tag).
 * A document without the new fields (older callers) keeps its composed `title`.
 */
export function displayTitle(doc: AasDocument): string {
  const hasNewFields = doc.baseTitle !== undefined || doc.documentIdShort !== undefined || doc.subtitle !== undefined;
  if (!hasNewFields) return doc.title || fileNameOf(doc) || 'Document';
  const base = stripLanguageSuffix(decodeEntities((doc.baseTitle ?? '').trim()), doc.language)
    || stripLanguageSuffix(idShortTitle(doc), doc.language)
    || fileNameOf(doc)
    || doc.title
    || 'Document';
  const sub = stripLanguageSuffix(decodeEntities((doc.subtitle ?? '').trim()), doc.language);
  return sub && !base.toLowerCase().includes(sub.toLowerCase()) ? `${base} – ${sub}` : base;
}

// ─── Grouping ───────────────────────────────────────────────────────────

/** "FullDocumentation" → "Full Documentation" (authored kinds without spaces). */
function splitCamel(text: string): string {
  return /\s/.test(text) ? text : text.replace(/([a-z])([A-Z])/g, '$1 $2');
}

/** Two-letter language of a document, lower case ('' if unknown). */
function langOf(doc: AasDocument): string {
  return (doc.language ?? '').toLowerCase().split('-')[0];
}

/** Address with its language segment neutralised, or null (no language segment). */
function translationKey(doc: AasDocument): string | null {
  const lang = langOf(doc);
  const addr = doc.url || doc.zipPath;
  if (!lang || !addr) return null;
  const re = new RegExp(`([/_.-])${lang}([/_.-]|$)`, 'i');
  if (!re.test(addr)) return null;
  return addr.replace(re, '$1{lang}$2');
}

/** Index of the first preferred language a document is in (lower = better). */
function langRank(doc: AasDocument, langs: readonly string[]): number {
  const i = langs.indexOf(langOf(doc));
  return i < 0 ? langs.length : i;
}

/** Collapse translations of one kind into rows (see file header). */
function pairTranslations(docs: readonly AasDocument[]): AasDocument[][] {
  const rows: AasDocument[][] = [];
  const byKey = new Map<string, AasDocument[]>();
  const leftovers: AasDocument[] = [];
  for (const doc of docs) {
    const key = translationKey(doc);
    if (!key) { leftovers.push(doc); continue; }
    const row = byKey.get(key);
    if (row && !row.some(d => langOf(d) === langOf(doc))) row.push(doc);
    else if (row) leftovers.push(doc);
    else { const r = [doc]; byKey.set(key, r); rows.push(r); }
  }
  // Address keys that found no translation go back to the positional pass.
  for (let i = rows.length - 1; i >= 0; i--) {
    if (rows[i].length === 1) { leftovers.push(rows[i][0]); rows.splice(i, 1); }
  }
  leftovers.sort((a, b) => docs.indexOf(a) - docs.indexOf(b));

  // Positional pass: the k-th document of each language forms row k. A document
  // without a language never pairs.
  const perLang = new Map<string, AasDocument[]>();
  for (const doc of leftovers) {
    const lang = langOf(doc);
    if (!lang) { rows.push([doc]); continue; }
    if (!perLang.has(lang)) perLang.set(lang, []);
    perLang.get(lang)!.push(doc);
  }
  const lists = [...perLang.values()];
  const max = lists.reduce((m, l) => Math.max(m, l.length), 0);
  for (let k = 0; k < max; k++) {
    const row: AasDocument[] = [];
    for (const list of lists) if (list[k]) row.push(list[k]);
    rows.push(row);
  }
  return rows;
}

/** Replace titles that repeat within a group by a distinct title of a translation. */
function disambiguateTitles(entries: AasDocEntry[]): void {
  const count = new Map<string, number>();
  for (const e of entries) count.set(e.title, (count.get(e.title) ?? 0) + 1);
  for (const e of entries) {
    if ((count.get(e.title) ?? 0) < 2) continue;
    const alt = e.alternates.map(displayTitle).find(t => t && t !== e.title);
    if (alt) e.title = alt;
  }
}

/**
 * Group documents by kind, collapse translations, order groups and rows.
 *
 * @param docs  documents as the parser listed them
 * @param langs preferred languages, most preferred first (lower case, e.g. `['en', 'de']`)
 */
export function groupDocuments(docs: readonly AasDocument[], langs: readonly string[]): AasDocGroup[] {
  const prefs = langs.map(l => l.toLowerCase().split('-')[0]);
  const byKind = new Map<string, { rank: number; canonical: string | null; docs: AasDocument[] }>();
  for (const doc of docs) {
    const k = documentKind(doc);
    let g = byKind.get(k.key);
    if (!g) { g = { rank: k.rank, canonical: k.canonical, docs: [] }; byKind.set(k.key, g); }
    g.docs.push(doc);
  }

  const groups: (AasDocGroup & { rank: number })[] = [];
  for (const [key, g] of byKind) {
    const entries: AasDocEntry[] = pairTranslations(g.docs).map((row) => {
      const sorted = [...row].sort((a, b) => langRank(a, prefs) - langRank(b, prefs));
      return {
        primary: sorted[0],
        alternates: sorted.slice(1).sort((a, b) => langOf(a).localeCompare(langOf(b))),
        title: displayTitle(sorted[0]),
      };
    });
    disambiguateTitles(entries);
    entries.sort((a, b) =>
      (langRank(a.primary, prefs) - langRank(b.primary, prefs))
      || a.title.localeCompare(b.title));
    // The label speaks the preferred language: the authored kind of a primary
    // document in it, else the first authored kind, else the canonical label.
    const preferred = entries.find(e => langRank(e.primary, prefs) === 0)?.primary ?? entries[0]?.primary;
    const label = key === OTHER_KEY
      ? OTHER_LABEL
      : (splitCamel(preferred?.kind?.trim() ?? '') || g.canonical || key);
    groups.push({ key, label, entries, docCount: g.docs.length, rank: g.rank });
  }

  groups.sort((a, b) => (a.rank - b.rank) || a.label.localeCompare(b.label));
  return groups.map(({ rank: _rank, ...g }) => g);
}

/**
 * One-line summary for the hover tooltip: "24 documents · Operating instructions,
 * Full documentation +4". Empty string without documents.
 */
export function summarizeDocuments(groups: readonly AasDocGroup[]): string {
  const total = groups.reduce((n, g) => n + g.entries.length, 0);
  if (total === 0) return '';
  const head = `${total} document${total === 1 ? '' : 's'}`;
  const names = groups.slice(0, 2).map(g => g.label);
  const more = groups.length - names.length;
  return `${head} · ${names.join(', ')}${more > 0 ? ` +${more}` : ''}`;
}
