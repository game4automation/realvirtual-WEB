// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * document-info-preview — what a list tooltip shows of a description
 * (plan-506 F6), as plain text and without a DOM.
 *
 * A tooltip is a glance, not a reader: the summary, then the first paragraph
 * of the description as plain text, cut to a length that fits beside a 96 px
 * thumbnail. Rendering Markdown there would pull the lazy markdown chunk into
 * every hover of every list — so the Markdown is stripped here instead, and the
 * full rendering stays in the detail pane.
 *
 * Truncation counts GRAPHEMES (`Intl.Segmenter`, with `Array.from` code points
 * as the fallback), cutting at a word boundary where one is near: slicing
 * UTF-16 units would split an emoji family or a combining accent into mojibake
 * right before the ellipsis.
 *
 * Pure on purpose: the tooltip component is only a frame around this, and this
 * is what a test can pin without mounting a popper.
 */

import type { DocumentInfo } from '../../project/rv-document-info';

export interface DocumentInfoPreview {
  summary?: string;
  firstParagraph?: string;
}

/** Default length of the first-paragraph excerpt, in graphemes. */
export const PREVIEW_PARAGRAPH_GRAPHEMES = 280;

/** Markdown → plain text, for one paragraph. Good enough for a glance, not a parser. */
export function stripMarkdown(text: string): string {
  return text
    // Images first (they contain the link syntax): keep the alt text.
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Links: keep the text.
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    // Reference-style links: keep the text.
    .replace(/\[([^\]]*)\]\[[^\]]*\]/g, '$1')
    // Autolinks <https://…>.
    .replace(/<(https?:[^>\s]+)>/g, '$1')
    // Headings, blockquotes, list bullets at line start.
    .replace(/^\s{0,3}#{1,6}\s+/gm, '')
    .replace(/^\s{0,3}>\s?/gm, '')
    .replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, '')
    // Emphasis / code markers.
    .replace(/(\*\*|__)(.+?)\1/g, '$2')
    .replace(/(\*|_)(.+?)\1/g, '$2')
    .replace(/~~(.+?)~~/g, '$1')
    .replace(/`+([^`]*)`+/g, '$1')
    // Whatever HTML-ish tags remain are shown as nothing.
    .replace(/<\/?[a-zA-Z][^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function graphemes(text: string): string[] {
  const Segmenter = (Intl as unknown as { Segmenter?: new (l?: string, o?: { granularity: string }) => { segment(t: string): Iterable<{ segment: string }> } }).Segmenter;
  if (typeof Segmenter === 'function') {
    return Array.from(new Segmenter(undefined, { granularity: 'grapheme' }).segment(text), s => s.segment);
  }
  return Array.from(text);
}

/**
 * Cut `text` to at most `limit` graphemes plus an ellipsis, preferring the
 * last word boundary in the final fifth of the budget.
 */
export function truncateGraphemes(text: string, limit: number): string {
  const parts = graphemes(text);
  if (parts.length <= limit) return text;
  let cut = limit;
  const floor = Math.floor(limit * 0.8);
  for (let i = limit; i >= floor; i--) {
    if (/\s/.test(parts[i] ?? '')) { cut = i; break; }
  }
  return parts.slice(0, cut).join('').trimEnd() + '…';
}

/**
 * The tooltip content of a block, or `null` when there is nothing to show —
 * the caller then renders the row exactly as it was (F6).
 */
export function documentInfoPreview(
  info: DocumentInfo | null | undefined,
  limits: { paragraph: number } = { paragraph: PREVIEW_PARAGRAPH_GRAPHEMES },
): DocumentInfoPreview | null {
  if (!info) return null;
  const summary = typeof info.summary === 'string' ? info.summary.trim() : '';
  const description = typeof info.description === 'string' ? info.description.replace(/\r\n?/g, '\n') : '';
  let firstParagraph = '';
  for (const block of description.split(/\n\s*\n/)) {
    // Heading lines are titles, not the paragraph a glance wants: a block that
    // is only a heading is skipped, a heading above text is dropped from it.
    const plain = stripMarkdown(block.replace(/^\s{0,3}#{1,6}\s.*$/gm, ''));
    if (plain) { firstParagraph = plain; break; }
  }
  if (firstParagraph) firstParagraph = truncateGraphemes(firstParagraph, limits.paragraph);
  if (!summary && !firstParagraph) return null;
  return {
    ...(summary ? { summary } : {}),
    ...(firstParagraph ? { firstParagraph } : {}),
  };
}
