// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-506 §9.5 — the pure tooltip preview: Markdown stripped, first
 * paragraph only, grapheme-safe truncation, nothing for an empty block.
 */

import { describe, it, expect } from 'vitest';
import { documentInfoPreview, stripMarkdown, truncateGraphemes } from '../src/core/hmi/projects/document-info-preview';

describe('plan-506 §9.5 — documentInfoPreview', () => {
  it('strips markdown and takes the first paragraph', () => {
    const p = documentInfoPreview({ v: 1, description: '# Titel\n\nErster **Absatz** [link](http://x)\n\nZweiter' });
    expect(p?.firstParagraph).toBe('Erster Absatz link');
  });

  it('drops a heading line that sits directly above the text', () => {
    const p = documentInfoPreview({ v: 1, description: '# Titel\nText directly under it' });
    expect(p?.firstParagraph).toBe('Text directly under it');
  });

  it('truncates on grapheme boundaries with an ellipsis', () => {
    const p = documentInfoPreview({ v: 1, description: '👨‍👩‍👧 '.repeat(200) }, { paragraph: 20 });
    expect([...new Intl.Segmenter().segment(p!.firstParagraph!)].length).toBeLessThanOrEqual(21);
    expect(p!.firstParagraph!.endsWith('…')).toBe(true);
    // No broken family: every emoji that is there is whole.
    expect(p!.firstParagraph!.replace(/👨‍👩‍👧|\s|…/gu, '')).toBe('');
  });

  it('returns null for an absent or empty block', () => {
    expect(documentInfoPreview(null)).toBeNull();
    expect(documentInfoPreview({ v: 1 })).toBeNull();
    expect(documentInfoPreview({ v: 1, description: '\n\n  \n' })).toBeNull();
  });

  it('carries the summary alone when there is no description', () => {
    expect(documentInfoPreview({ v: 1, summary: ' Press ' })).toEqual({ summary: 'Press' });
  });

  it('keeps image alt text and drops raw HTML', () => {
    expect(stripMarkdown('A ![photo](x.png) <b>bold</b> `code`')).toBe('A photo bold code');
  });

  it('prefers a word boundary near the limit', () => {
    expect(truncateGraphemes('alpha beta gamma delta', 13)).toBe('alpha beta…');
    expect(truncateGraphemes('short', 10)).toBe('short');
  });
});
