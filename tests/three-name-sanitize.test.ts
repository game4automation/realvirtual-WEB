// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * three-name-sanitize.test.ts — pins our `sanitizeLikeThree` parity helper
 * against the REAL `THREE.PropertyBinding.sanitizeNodeName`, and verifies the
 * `isPureSanitization` decision used by the scene-loader to decide when it is
 * safe to restore a node's original (dotted) glTF name.
 *
 * If a Three.js upgrade ever changes the sanitization rule, the parity block
 * below fails loudly so the loader's name-restoration logic can be revisited.
 */

import { describe, it, expect } from 'vitest';
import { PropertyBinding } from 'three';
import { sanitizeLikeThree, isPureSanitization } from '../src/core/engine/rv-three-names';

describe('sanitizeLikeThree — parity with THREE.PropertyBinding.sanitizeNodeName', () => {
  const samples = [
    'MC04.01I00W',      // Siemens dotted symbol → dot removed
    'Tubes/MC01.04I00W', // slash + dot
    'Foo Bar',          // whitespace → underscore
    'A.B C[1]:x/y',     // every reserved char + space
    'PlainName_1',      // already clean
    'Motor.DriveRotate',
    '  leading  ',      // whitespace runs
    'no_change',
  ];

  it('matches the real THREE implementation for every sample', () => {
    for (const name of samples) {
      expect(sanitizeLikeThree(name)).toBe(PropertyBinding.sanitizeNodeName(name));
    }
  });

  it('removes dots specifically (the Siemens-symbol case)', () => {
    expect(sanitizeLikeThree('MC04.01I00W')).toBe('MC0401I00W');
  });

  it('maps whitespace to underscore', () => {
    expect(sanitizeLikeThree('Foo Bar')).toBe('Foo_Bar');
  });
});

describe('isPureSanitization', () => {
  it('is true when the current name is exactly the sanitized original', () => {
    expect(isPureSanitization('MC04.01I00W', 'MC0401I00W')).toBe(true);
    expect(isPureSanitization('Foo Bar', 'Foo_Bar')).toBe(true);
  });

  it('is false when names are identical (nothing was sanitized)', () => {
    expect(isPureSanitization('PlainName', 'PlainName')).toBe(false);
  });

  it('is false for a genuine dedup suffix (would collide if restored)', () => {
    // Two nodes named 'MC04.01I00W' → first sanitizes to 'MC0401I00W',
    // the second collides and Three appends '_1' → 'MC0401I00W_1'.
    expect(isPureSanitization('MC04.01I00W', 'MC0401I00W_1')).toBe(false);
  });

  it('is false for an empty original name', () => {
    expect(isPureSanitization('', 'whatever')).toBe(false);
  });
});
