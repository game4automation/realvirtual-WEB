// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * maintenance-document-link — the "Betriebsanleitung, S. 18" button of a
 * maintenance step (plan-522 Phase 6).
 *
 * A step names its document in one or both of two ways:
 *   - the `AASLink` of a component (`DocumentSource`) plus a keyword — the
 *     document is picked from that AAS's handover documentation, in the UI
 *     language (fallback de, en, any) — preferred, and
 *   - an explicit `DocumentUrl` (`{lang}` = UI language) — used without a
 *     source, or when the AAS lookup finds nothing (index missing, no match).
 * The page is always authored (page numbers are not in an AASX).
 *
 * An external address the open project mirrors (`docs/aas/mirror.json`,
 * rv-aas-document-mirror.ts) opens inline in the PDF overlay at the page.
 *
 * Resolution is async (the AASX may have to be read), so the panel resolves
 * when the step is SHOWN and the click itself is synchronous — a
 * `window.open` after an await would be blocked as a popup.
 *
 * plan-682 Phase 3b may later replace the lookup; the authored fields stay.
 */

import type { AasDocument } from '../../plugins/aas-link-parser';
import type { MaintenanceDocumentLink } from '../maintenance-parser';
import { prefetchAasDocumentMirrorFor } from '../aas/rv-aas-document-mirror';
import { getActiveAasSource } from '../aas/rv-aas-source';

/** Where a resolved document opens. */
export type ResolvedMaintenanceDocument =
  | { kind: 'external'; href: string }
  | { kind: 'aas-blob'; aasId: string; zipPath: string; page: number };

/** Primary UI language (lower case, no region), e.g. 'de'. */
export function uiLanguage(): string {
  const raw = (typeof document !== 'undefined' && document.documentElement?.lang)
    || (typeof navigator !== 'undefined' ? navigator.language : '') || 'en';
  return raw.toLowerCase().split('-')[0] || 'en';
}

/**
 * The address to open: `{lang}` replaced, any fragment replaced by
 * `#page=N` (N > 0), or kept without a page.
 */
export function buildDocumentHref(url: string, page: number, lang: string): string {
  const withLang = url.replace(/\{lang\}/g, lang);
  if (!(page > 0)) return withLang;
  return `${withLang.replace(/#.*$/, '')}#page=${Math.floor(page)}`;
}

/**
 * The document of `docs` a step means: title or kind contains one of
 * `keywords` (all documents without keywords), then the UI language, de, en,
 * else the first candidate. Null when nothing matches.
 */
export function pickAasDocument(docs: readonly AasDocument[], keywords: readonly string[], lang: string): AasDocument | null {
  const hay = (d: AasDocument): string => `${d.title} ${d.kind ?? ''}`.toLowerCase();
  const candidates = keywords.length === 0 ? [...docs] : docs.filter((d) => keywords.some((k) => hay(d).includes(k)));
  if (candidates.length === 0) return null;
  const langOf = (d: AasDocument): string => (d.language ?? '').toLowerCase().split('-')[0];
  for (const l of [lang, 'de', 'en']) {
    const hit = candidates.find((d) => langOf(d) === l);
    if (hit) return hit;
  }
  return candidates[0];
}

/** The parts of the viewer the lookup reads. */
export interface DocumentLookupHost {
  registry?: { getNode(path: string): { userData?: Record<string, unknown> } | null | undefined } | null;
}

/**
 * Resolve a step's document link: the AAS of the source node first, the
 * explicit URL as fallback. Null when nothing can be opened.
 */
export async function resolveMaintenanceDocument(
  link: MaintenanceDocumentLink,
  host: DocumentLookupHost,
  lang: string = uiLanguage(),
  loadAas: (aasId: string) => Promise<{ documents: readonly AasDocument[] }> = defaultLoadAas,
): Promise<ResolvedMaintenanceDocument | null> {
  const resolved = await resolveLink(link, host, lang, loadAas);
  // The click decides synchronously between the project's mirrored copy and a
  // new tab, so the mapping must be loaded by the time the button is enabled —
  // but only for an external address; an AAS blob never needs the mirror.
  if (resolved?.kind === 'external') await prefetchAasDocumentMirrorFor([resolved.href]).catch(() => {});
  return resolved;
}

async function resolveLink(
  link: MaintenanceDocumentLink,
  host: DocumentLookupHost,
  lang: string,
  loadAas: (aasId: string) => Promise<{ documents: readonly AasDocument[] }>,
): Promise<ResolvedMaintenanceDocument | null> {
  if (link.sourcePath) {
    try {
      const fromAas = await resolveFromAas(link, host, lang, loadAas);
      if (fromAas) return fromAas;
    } catch (e) {
      if (!link.url) throw e;
      console.warn('[maintenance] AAS document lookup failed, using DocumentUrl:', e);
    }
  }
  if (!link.url) return null;
  // http(s) or relative to the page; any other scheme (javascript:, data:) is refused.
  if (/^[a-z][a-z0-9+.-]*:/i.test(link.url) && !/^https?:/i.test(link.url)) return null;
  return { kind: 'external', href: buildDocumentHref(link.url, link.page, lang) };
}

async function resolveFromAas(
  link: MaintenanceDocumentLink,
  host: DocumentLookupHost,
  lang: string,
  loadAas: (aasId: string) => Promise<{ documents: readonly AasDocument[] }>,
): Promise<ResolvedMaintenanceDocument | null> {
  const node = host.registry?.getNode(link.sourcePath);
  const aas = node?.userData?.['_rvAasLink'] as { aasId?: string } | undefined;
  if (!aas?.aasId) return null;
  const data = await loadAas(aas.aasId);
  const doc = pickAasDocument(data.documents, link.keywords, lang);
  if (!doc) return null;
  if (doc.url) {
    if (!/^https?:\/\//i.test(doc.url)) return null; // AASX values are untrusted input
    return { kind: 'external', href: buildDocumentHref(doc.url, link.page, lang) };
  }
  if (!doc.zipPath) return null;
  return { kind: 'aas-blob', aasId: aas.aasId, zipPath: doc.zipPath, page: link.page };
}

/**
 * The step's AAS through THE active source (the open project's `aasx/` over the
 * deploy directory), like every other AAS surface. Without the source the
 * lookup read only the deploy-wide `aasx/index.json`, so a project AASX (the
 * tooltip, AAS mode and cart found it) left the document button grey.
 */
export async function defaultLoadAas(aasId: string): Promise<{ documents: readonly AasDocument[] }> {
  const { loadAasxById } = await import('../../plugins/aas-link-parser');
  const data = await loadAasxById(aasId, getActiveAasSource());
  return { documents: data.documents ?? [] };
}

/** The button label: "Betriebsanleitung, S. 18" / "Operating instructions, p. 18". */
export function documentButtonLabel(link: MaintenanceDocumentLink, lang: string = uiLanguage()): string {
  if (!(link.page > 0)) return link.title;
  return `${link.title}, ${lang === 'de' ? 'S.' : 'p.'} ${link.page}`;
}
