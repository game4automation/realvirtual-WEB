// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-search-score — the one scorer behind "find a model" (plan-507).
 *
 * The Quick-Open popover and the project search list rank with this module and
 * nothing else, so a term means the same thing in both places.
 *
 * ## Why token substring, not fuzzy
 *
 * Every whitespace-separated word of the term must occur as a substring of
 * SOME field (AND semantics). A subsequence fuzzy matcher (VS Code, fzf) finds
 * `l3` in `line3` but also in `layout-v3`, and on the two- and three-letter
 * terms people actually type into a model search it ranks noise above the
 * obvious hit. Substring keeps the familiar `matchesSearchTerm` behaviour and
 * only adds what that one lacked: word order no longer matters (`line demo`
 * finds `demo-line.glb`) and a hit at a word start outranks one mid-word.
 *
 * ## Why recency is the input index
 *
 * The recents ring is already ordered newest first (`pushRecent`), and the tree
 * index is ordered by walk. Ranking is a STABLE sort on the score alone, so an
 * equal score keeps the caller's order — the scorer never has to know what
 * `openedAt` is, and cannot disagree with the list it was handed.
 */

/** A half-open character range `[start, end)` inside one field. */
export interface MatchRange { start: number; end: number }

/** The ranges one field contributed; `field` indexes the `fields` array. */
export interface FieldMatch { field: number; ranges: MatchRange[] }

export interface SearchScore { score: number; matches: FieldMatch[] }

/** Field weight by position: name beats project beats path. */
const FIELD_WEIGHTS = [3, 2];
const FALLBACK_WEIGHT = 1;
/** Added when the token starts a word (string start or after a separator). */
const WORD_START_BONUS = 2;
/** Added on top when the token starts the whole field — the VS Code prefix rule. */
const PREFIX_BONUS = 1;

function isSeparator(ch: string): boolean {
  return ch === '/' || ch === '_' || ch === '-' || ch === '.' || ch === ' ' || ch === '\\';
}

/** Splits on whitespace, lowercases, drops empty tokens. */
export function tokenizeSearchTerm(term: string): string[] {
  const out: string[] = [];
  for (const raw of (term ?? '').toLowerCase().split(/\s+/)) {
    if (raw !== '') out.push(raw);
  }
  return out;
}

/**
 * The best occurrence of `token` in `lower`: the first one at a word start,
 * else the first one at all, else -1.
 */
function bestOccurrence(lower: string, token: string): { at: number; wordStart: boolean } {
  let first = -1;
  let from = 0;
  for (;;) {
    const at = lower.indexOf(token, from);
    if (at < 0) break;
    if (first < 0) first = at;
    if (at === 0 || isSeparator(lower[at - 1])) return { at, wordStart: true };
    from = at + 1;
  }
  return { at: first, wordStart: false };
}

function mergeRanges(ranges: MatchRange[]): MatchRange[] {
  if (ranges.length < 2) return ranges;
  ranges.sort((a, b) => a.start - b.start);
  const out: MatchRange[] = [ranges[0]];
  for (let i = 1; i < ranges.length; i++) {
    const last = out[out.length - 1];
    const r = ranges[i];
    if (r.start <= last.end) last.end = Math.max(last.end, r.end);
    else out.push(r);
  }
  return out;
}

/**
 * Score one candidate.
 *
 * null when any token is missing from ALL fields (AND semantics). Otherwise
 * score = Σ per token of the best field's weight (fields[0]=3, fields[1]=2,
 * fields[2..]=1) plus a word-start bonus, plus a prefix bonus when the token
 * starts the field. Ranges mark the chosen occurrence of every token in every
 * field it occurs in, merged — what a highlight needs, nothing more.
 */
export function scoreFields(fields: readonly string[], tokens: readonly string[]): SearchScore | null {
  if (tokens.length === 0) return null;
  const lower = fields.map(f => (f ?? '').toLowerCase());
  // Cheap rejection first: no ranges are allocated for a non-match.
  for (const token of tokens) {
    if (!lower.some(f => f.includes(token))) return null;
  }
  let score = 0;
  const perField: MatchRange[][] = lower.map(() => []);
  for (const token of tokens) {
    let best = 0;
    for (let i = 0; i < lower.length; i++) {
      const { at, wordStart } = bestOccurrence(lower[i], token);
      if (at < 0) continue;
      // Clamped: lowercasing a rare code point can change the string length.
      const len = fields[i]?.length ?? 0;
      perField[i].push({ start: Math.min(at, len), end: Math.min(at + token.length, len) });
      const value = (FIELD_WEIGHTS[i] ?? FALLBACK_WEIGHT)
        + (wordStart ? WORD_START_BONUS : 0)
        + (at === 0 ? PREFIX_BONUS : 0);
      if (value > best) best = value;
    }
    score += best;
  }
  const matches: FieldMatch[] = [];
  perField.forEach((ranges, field) => {
    if (ranges.length > 0) matches.push({ field, ranges: mergeRanges(ranges) });
  });
  return { score, matches };
}

/**
 * Rank items by the term.
 *
 * Matches come first, best score first, equal scores in input order (stable —
 * input order is recency for the recents ring). Non-matches follow in input
 * order with `score: null`, so the caller decides whether to show them. An
 * empty term returns every item unchanged, all with `score: null`.
 */
export function rankBySearch<T>(
  items: readonly T[],
  fieldsOf: (t: T) => readonly string[],
  term: string,
): { item: T; score: SearchScore | null }[] {
  const tokens = tokenizeSearchTerm(term);
  if (tokens.length === 0) return items.map(item => ({ item, score: null }));
  const hits: { item: T; score: SearchScore; i: number }[] = [];
  const misses: { item: T; score: null }[] = [];
  items.forEach((item, i) => {
    const score = scoreFields(fieldsOf(item), tokens);
    if (score) hits.push({ item, score, i });
    else misses.push({ item, score: null });
  });
  hits.sort((a, b) => (b.score.score - a.score.score) || (a.i - b.i));
  return [...hits.map(({ item, score }) => ({ item, score })), ...misses];
}

/** The ranges of one field, or none. */
export function rangesOfField(score: SearchScore | null | undefined, field: number): MatchRange[] {
  return score?.matches.find(m => m.field === field)?.ranges ?? [];
}

/** A text cut at the ranges — what a `<mark>` renderer maps over. */
export function splitByRanges(
  text: string,
  ranges: readonly MatchRange[] | undefined,
): { text: string; match: boolean }[] {
  if (!ranges || ranges.length === 0) return [{ text, match: false }];
  const out: { text: string; match: boolean }[] = [];
  let pos = 0;
  for (const r of ranges) {
    const start = Math.max(pos, Math.min(r.start, text.length));
    const end = Math.max(start, Math.min(r.end, text.length));
    if (start > pos) out.push({ text: text.slice(pos, start), match: false });
    if (end > start) out.push({ text: text.slice(start, end), match: true });
    pos = end;
  }
  if (pos < text.length) out.push({ text: text.slice(pos), match: false });
  return out;
}
