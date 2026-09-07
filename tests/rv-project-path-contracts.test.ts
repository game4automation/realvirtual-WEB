// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-461 R5 — the four path-normalisation CONTRACTS, pinned side by side.
 *
 * Five places in the code "normalise a project-relative path", and the review
 * that produced plan-461 proposed folding them together. This file is the
 * measurement that decided against it: the four live normalisers serve four
 * different domains and **disagree on ordinary inputs**, so delegating one to
 * another would change behaviour for a caller — the one thing plan-461 forbids.
 *
 * The contracts, by domain:
 *
 *  - `folderPath` — {@link normaliseFolderPath}: a FOLDER path in `folders[]`.
 *    Splits on `/`, trims every segment and drops empty ones, so `a//b`
 *    collapses. A `.` segment is a segment like any other and SURVIVES.
 *  - `containedFileRef` — {@link normalizeRefPath}: a file reference inside the
 *    project. Strips a leading `./` or `/` and every TRAILING slash; interior
 *    empty segments are kept, because `a//b` is not the same string as `a/b`.
 *  - `scriptRef` — {@link normalizeScriptRef}: a module path. Same as
 *    `containedFileRef` except that trailing slashes are KEPT.
 *  - `treeRelPath` — {@link normaliseRelPath}: the project tree's spelling.
 *    Strips a leading `./` and leading/trailing `/`, keeps interior empty
 *    segments, and trims only the ENDS of the whole string, not each segment.
 *
 * The `browser-backend` "backend key" is deliberately absent: it is not a path
 * normaliser at all, it compares a stored row path against a canonical one.
 *
 * If a future change makes two of these agree on every row below, the merge this
 * plan refused becomes safe — and this file is what would prove it.
 */

import { describe, expect, it } from 'vitest';
import { normaliseFolderPath } from '../src/core/project/rv-project-types';
import { normalizeRefPath } from '../src/core/project/rv-project-refs';
import { normalizeScriptRef } from '../src/core/rv-model-plugin-manager';
import { normaliseRelPath } from '../src/plugins/mcp-bridge/rv-mcp-project-tree';

/** A single backslash, spelled without one so the literal survives every editor. */
const BS = String.fromCharCode(92);

/** Every input class the five call sites can see, including the ones they differ on. */
const INPUTS: string[] = [
  '',
  '/',
  '//',
  'a',
  'a/b',
  'a//b',
  'a///b',
  './x',
  '/x',
  '//x',
  'x/',
  'x//',
  '/x/',
  'a/./b',
  '..',
  '../out.json',
  'a/../b',
  'models/v..2/a.glb',
  `a${BS}b`,
  `a${BS}${BS}b`,
  `C:${BS}x${BS}y`,
  ' a / b ',
  '  spaced  ',
  'a b/c d',
  'q?x=1',
  'frag#1',
  'scripts/linie1/index.ts',
  'scripts/',
  'connect/versand.json',
];

describe('path contracts — each domain keeps its own rules (plan-461 R5)', () => {
  it('every normaliser is total — no input throws', () => {
    for (const value of INPUTS) {
      expect(typeof normaliseFolderPath(value)).toBe('string');
      expect(typeof normalizeRefPath(value)).toBe('string');
      expect(typeof normalizeScriptRef(value)).toBe('string');
      expect(typeof normaliseRelPath(value)).toBe('string');
    }
  });

  it('the two segment-based normalisers are idempotent, the two ref ones are not', () => {
    for (const value of INPUTS) {
      expect(normaliseFolderPath(normaliseFolderPath(value))).toBe(normaliseFolderPath(value));
      expect(normaliseRelPath(normaliseRelPath(value))).toBe(normaliseRelPath(value));
    }
    // Both ref normalisers strip exactly ONE leading separator per pass, so a
    // doubled one needs two passes to settle. Recorded, not fixed: changing it
    // would change what a manifest's reference resolves to.
    expect(normalizeRefPath('//x')).toBe('/x');
    expect(normalizeRefPath(normalizeRefPath('//x'))).toBe('x');
    expect(normalizeScriptRef('//')).toBe('/');
    expect(normalizeScriptRef(normalizeScriptRef('//'))).toBe('');
  });

  it('folderPath collapses interior empty segments and trims every segment', () => {
    expect(normaliseFolderPath('a//b')).toBe('a/b');
    expect(normaliseFolderPath('a///b')).toBe('a/b');
    expect(normaliseFolderPath(' a / b ')).toBe('a/b');
    expect(normaliseFolderPath(`a${BS}${BS}b`)).toBe('a/b');
    expect(normaliseFolderPath('/x/')).toBe('x');
    expect(normaliseFolderPath('')).toBe('');
    // A `.` is a segment like any other here — it is NOT stripped.
    expect(normaliseFolderPath('./x')).toBe('./x');
    expect(normaliseFolderPath('a/./b')).toBe('a/./b');
  });

  it('containedFileRef strips one leading ./ or / and all trailing slashes, keeps interior ones', () => {
    expect(normalizeRefPath('./x')).toBe('x');
    expect(normalizeRefPath('/x')).toBe('x');
    expect(normalizeRefPath('x//')).toBe('x');
    expect(normalizeRefPath('a//b')).toBe('a//b');
    expect(normalizeRefPath(' a / b ')).toBe('a / b');
    expect(normalizeRefPath(`a${BS}${BS}b`)).toBe('a//b');
  });

  it('scriptRef is containedFileRef WITHOUT the trailing-slash rule', () => {
    expect(normalizeScriptRef('scripts/')).toBe('scripts/');
    expect(normalizeRefPath('scripts/')).toBe('scripts');
    // …and agrees on everything that has no trailing slash, which is exactly why
    // the two look like copies and are not.
    for (const value of INPUTS.filter(v => !v.endsWith('/'))) {
      expect(normalizeScriptRef(value)).toBe(normalizeRefPath(value));
    }
  });

  it('treeRelPath strips leading ./ and leading/trailing / and keeps interior empties', () => {
    expect(normaliseRelPath('./x')).toBe('x');
    expect(normaliseRelPath('/x/')).toBe('x');
    expect(normaliseRelPath('a//b')).toBe('a//b');
    expect(normaliseRelPath('  spaced  ')).toBe('spaced');
  });

  it('folderPath and treeRelPath disagree — the R5 merge would NOT preserve behaviour', () => {
    expect(normaliseFolderPath('a//b')).not.toBe(normaliseRelPath('a//b'));
    expect(normaliseFolderPath('./x')).not.toBe(normaliseRelPath('./x'));
  });

  it('no normaliser resolves `..`; containment stays the caller gate', () => {
    expect(normalizeRefPath('../out.json')).toBe('../out.json');
    expect(normaliseFolderPath('../out.json')).toBe('../out.json');
    expect(normaliseRelPath('../out.json')).toBe('../out.json');
    expect(normalizeScriptRef('../out.json')).toBe('../out.json');
    expect(normalizeRefPath('models/v..2/a.glb')).toBe('models/v..2/a.glb');
  });
});
