// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import vectors from './fixtures/diagnostics-redact-vectors.json';
import { redactDiagnosticsText, redactUrl } from '../src/core/diagnostics/rv-diagnostics-redact';

describe('diagnostics redaction', () => {
  for (const vector of vectors) {
    it(`redacts ${vector.input.split(/[=:]/, 1)[0]}`, () => {
      expect(redactDiagnosticsText(vector.input)).toBe(vector.expected);
    });
  }

  it('removes fragments and redacts secret query parameters', () => {
    expect(redactUrl('https://example.test/view?apiKey=secret&mode=hmi#k=fragment'))
      .toBe('https://example.test/view?apiKey=%5Bredacted%5D&mode=hmi');
  });
});
