// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { attributeBytes } from '../scripts/analyze-demo-entry.mjs';

type Mapping = { generatedLine: number; generatedColumn: number; source: string | null };

class FakeSourceMapConsumer {
  constructor(private mappings: Mapping[]) {}

  eachMapping(callback: (mapping: Mapping) => void) {
    this.mappings.forEach(callback);
  }
}

describe('attributeBytes', () => {
  it('attributes each span to its mapping source, including the final span', () => {
    expect(attributeBytes('abc\ndefghi', [
      { generatedLine: 1, generatedColumn: 0, source: 'a.ts' },
      { generatedLine: 2, generatedColumn: 0, source: 'b.ts' },
      { generatedLine: 2, generatedColumn: 3, source: 'a.ts' },
    ], FakeSourceMapConsumer)).toEqual({ total: 10, bySource: { 'a.ts': 7, 'b.ts': 3 } });
  });

  it('attributes interior and trailing null-source spans to (unmapped)', () => {
    expect(attributeBytes('abcdefghij', [
      { generatedLine: 1, generatedColumn: 0, source: 'a.ts' },
      { generatedLine: 1, generatedColumn: 2, source: null },
      { generatedLine: 1, generatedColumn: 5, source: 'b.ts' },
      { generatedLine: 1, generatedColumn: 7, source: null },
    ], FakeSourceMapConsumer)).toEqual({
      total: 10, bySource: { 'a.ts': 2, '(unmapped)': 6, 'b.ts': 2 },
    });
  });

  it('attributes bytes before the first mapping to (unmapped)', () => {
    expect(attributeBytes('abcdefghij', [
      { generatedLine: 1, generatedColumn: 3, source: 'a.ts' },
    ], FakeSourceMapConsumer)).toEqual({ total: 10, bySource: { '(unmapped)': 3, 'a.ts': 7 } });
  });

  it('attributes all bytes to (unmapped) when there are no mappings', () => {
    expect(attributeBytes('abc', [], FakeSourceMapConsumer))
      .toEqual({ total: 3, bySource: { '(unmapped)': 3 } });
  });
});
