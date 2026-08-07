// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * sanitizer-parity-vectors.test.ts — plan-381 §9.14, TypeScript half.
 *
 * Plan-381 requires the Unity exporter to compare node names AFTER Three.js
 * sanitization (F7), which means C# needs its own `sanitizeLikeThree`. The two
 * implementations must agree exactly, or the export-side collision warning
 * misses precisely the collisions the loader will later create.
 *
 * This file pins the TS side against a FROZEN vector table and checks it
 * against the real `THREE.PropertyBinding.sanitizeNodeName`. The table below is
 * the contract: the C# counterpart (Unity lane, Phase 2) must reproduce every
 * row verbatim in its own EditMode test.
 *
 * STATUS: the C# counter-check is NOT yet written — the Unity lane of plan-381
 * (Phases 0/1/2/5-Unity) had not run when this file was added. Until it does,
 * §9.14 is only half satisfied: this file proves the TS side is stable and
 * publishes the vectors, it cannot prove parity on its own.
 *
 * Rule (THREE r171, `src/animation/PropertyBinding.js`):
 *   name.replace(/\s/g, '_').replace(/[\[\]\.:\/]/g, '')
 * i.e. whitespace → '_', then the five reserved characters [ ] . : / removed.
 */

import { describe, it, expect } from 'vitest';
import { PropertyBinding } from 'three';
import { sanitizeLikeThree } from '../src/core/engine/rv-three-names';

/**
 * The shared contract. `input` → `expected`, with `why` naming the rule the row
 * exercises. Keep this table in sync with the C# EditMode test; add rows here
 * FIRST, then mirror them.
 */
export const SANITIZER_PARITY_VECTORS: ReadonlyArray<{
  input: string;
  expected: string;
  why: string;
}> = [
  { input: 'PlainName', expected: 'PlainName', why: 'nothing to do' },
  { input: 'already_clean_1', expected: 'already_clean_1', why: 'underscores are not reserved' },
  { input: '', expected: '', why: 'empty name' },

  // Whitespace → underscore
  { input: 'Foo Bar', expected: 'Foo_Bar', why: 'single space' },
  { input: 'A  B', expected: 'A__B', why: 'runs are NOT collapsed — one underscore per char' },
  { input: ' lead', expected: '_lead', why: 'leading space is kept as underscore' },
  { input: 'trail ', expected: 'trail_', why: 'trailing space is kept as underscore' },
  { input: 'tab\there', expected: 'tab_here', why: 'tab counts as whitespace' },
  { input: 'nl\nhere', expected: 'nl_here', why: 'newline counts as whitespace' },

  // Reserved characters are REMOVED, not replaced
  { input: 'MC04.01I00W', expected: 'MC0401I00W', why: 'Siemens dotted symbol — the motivating case' },
  { input: 'a/b', expected: 'ab', why: 'slash removed (NOT a path separator here)' },
  { input: 'arr[0]', expected: 'arr0', why: 'brackets removed' },
  { input: 'ns:name', expected: 'nsname', why: 'colon removed' },
  { input: 'A.B C[1]:x/y', expected: 'A.B_C1xy'.replace('.', ''), why: 'all five reserved + space' },

  // Order matters: whitespace is mapped BEFORE reserved chars are stripped,
  // so a space next to a dot yields an underscore, not nothing.
  { input: 'A .B', expected: 'A_B', why: 'space→underscore first, then dot removed' },

  // Characters that look risky but are NOT reserved
  { input: 'Grüße-Ω', expected: 'Grüße-Ω', why: 'non-ASCII and hyphen pass through untouched' },
  { input: 'a-b+c(d)', expected: 'a-b+c(d)', why: 'parentheses/operators are not reserved' },
  { input: 'back\\slash', expected: 'back\\slash', why: 'backslash is not reserved' },

  // Dedup suffixes are NOT this function's job — it only sanitizes.
  { input: 'Pusher', expected: 'Pusher', why: 'no _N suffix is ever appended here' },
];

describe('9.14 sanitizer parity vectors (TypeScript half)', () => {
  it('sanitizeLikeThree matches every frozen vector', () => {
    for (const { input, expected, why } of SANITIZER_PARITY_VECTORS) {
      expect(sanitizeLikeThree(input), `${why} — input ${JSON.stringify(input)}`).toBe(expected);
    }
  });

  it('every vector also matches the real THREE implementation', () => {
    // If a Three.js upgrade changes the rule, this fails before the vectors
    // silently drift away from what the loader actually does.
    for (const { input } of SANITIZER_PARITY_VECTORS) {
      expect(sanitizeLikeThree(input)).toBe(PropertyBinding.sanitizeNodeName(input));
    }
  });

  it('is idempotent — sanitizing a sanitized name changes nothing', () => {
    // The C# side compares already-sanitized names against freshly sanitized
    // ones; a non-idempotent rule would make that comparison unstable.
    for (const { input } of SANITIZER_PARITY_VECTORS) {
      const once = sanitizeLikeThree(input);
      expect(sanitizeLikeThree(once)).toBe(once);
    }
  });
});
