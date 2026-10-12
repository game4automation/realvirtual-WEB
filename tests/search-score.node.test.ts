// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-507 §9.1 — the shared scorer's contract: AND over tokens, word-start
 * and field weighting, match ranges, and a stable order that IS recency.
 */

import { describe, it, expect } from 'vitest';
import {
  scoreFields, rankBySearch, tokenizeSearchTerm, splitByRanges, rangesOfField,
} from '../src/core/project/rv-search-score';

describe('tokenizeSearchTerm', () => {
  it('splits on whitespace, lowercases and drops empties', () => {
    expect(tokenizeSearchTerm('  Line   DEMO ')).toEqual(['line', 'demo']);
    expect(tokenizeSearchTerm('')).toEqual([]);
    expect(tokenizeSearchTerm('   ')).toEqual([]);
  });
});

describe('scoreFields', () => {
  it('requires every token in some field (AND)', () => {
    expect(scoreFields(['line3.glb', 'Demo', 'models/line3.glb'], ['line', 'demo'])).not.toBeNull();
    expect(scoreFields(['line3.glb', 'Demo', 'models/line3.glb'], ['line', 'mauser'])).toBeNull();
  });

  it('no tokens is no match', () => {
    expect(scoreFields(['line3.glb'], [])).toBeNull();
  });

  it('word-start beats mid-word, name beats path', () => {
    const start = scoreFields(['line3.glb', '', ''], ['line'])!.score;
    const mid = scoreFields(['pipeline3.glb', '', ''], ['line'])!.score;
    const path = scoreFields(['x', '', 'lines/line3.glb'], ['line'])!.score;
    expect(start).toBeGreaterThan(mid);
    expect(start).toBeGreaterThan(path);
  });

  it('name beats project for the same kind of hit', () => {
    const name = scoreFields(['line3', 'x', ''], ['line'])!.score;
    const project = scoreFields(['x', 'line3', ''], ['line'])!.score;
    expect(name).toBeGreaterThan(project);
  });

  it('counts every separator as a word start', () => {
    for (const sep of ['/', '_', '-', '.', ' ']) {
      const after = scoreFields([`a${sep}line`], ['line'])!.score;
      const mid = scoreFields(['aline'], ['line'])!.score;
      expect(after).toBeGreaterThan(mid);
    }
  });

  it('prefers the word-start occurrence for the range', () => {
    // "line" occurs mid-word in "pipeline" first and at a word start later.
    expect(scoreFields(['pipeline-line'], ['line'])!.matches[0].ranges).toEqual([{ start: 9, end: 13 }]);
  });

  it('returns match ranges per field', () => {
    expect(scoreFields(['Line3.glb', '', ''], ['line'])!.matches[0].ranges).toEqual([{ start: 0, end: 4 }]);
  });

  it('merges overlapping ranges and reports every field that matched', () => {
    const s = scoreFields(['demo-line', 'Demo', ''], ['demo', 'mo-li'])!;
    expect(s.matches.map(m => m.field)).toEqual([0, 1]);
    expect(s.matches[0].ranges).toEqual([{ start: 0, end: 7 }]);
    expect(rangesOfField(s, 1)).toEqual([{ start: 0, end: 4 }]);
    expect(rangesOfField(s, 2)).toEqual([]);
  });
});

describe('rankBySearch', () => {
  const items = ['pipeline', 'line-b', 'other', 'line-a'];
  const fields = (s: string) => [s];

  it('keeps input order on equal score (recency) and returns input unchanged for empty term', () => {
    const ranked = rankBySearch(items, fields, 'line');
    // line-b and line-a score equally: input order wins; pipeline (mid-word) after.
    expect(ranked.map(r => r.item)).toEqual(['line-b', 'line-a', 'pipeline', 'other']);
    expect(ranked[3].score).toBeNull();
    const empty = rankBySearch(items, fields, '   ');
    expect(empty.map(r => r.item)).toEqual(items);
    expect(empty.every(r => r.score === null)).toBe(true);
  });

  it('is independent of token order', () => {
    const ranked = rankBySearch(['demo-line.glb', 'demo.glb'], fields, 'line demo');
    expect(ranked[0].item).toBe('demo-line.glb');
    expect(ranked[1].score).toBeNull();
  });
});

describe('splitByRanges', () => {
  it('cuts a text into marked and unmarked parts', () => {
    expect(splitByRanges('line3.glb', [{ start: 0, end: 4 }])).toEqual([
      { text: 'line', match: true }, { text: '3.glb', match: false },
    ]);
    expect(splitByRanges('abc', [])).toEqual([{ text: 'abc', match: false }]);
    expect(splitByRanges('abcdef', [{ start: 1, end: 2 }, { start: 4, end: 9 }]).map(p => p.text))
      .toEqual(['a', 'b', 'cd', 'ef']);
  });
});
