// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { parseDiagnoseResult } from '../src/plugins/diagnose/diagnose-provider';

describe('parseDiagnoseResult toolTrace', () => {
  it('preserves valid backend tool names', () => {
    const result = parseDiagnoseResult({
      cause: 'Found live state',
      remedy: '',
      sources: [],
      toolTrace: ['signal_read', 'sensor_list'],
    });

    expect(result.toolTrace).toEqual(['signal_read', 'sensor_list']);
  });

  it('ignores a non-array trace and filters mixed entries without throwing', () => {
    expect(() => parseDiagnoseResult({ toolTrace: 'kaputt' })).not.toThrow();
    expect(parseDiagnoseResult({ toolTrace: 'kaputt' }).toolTrace).toBeUndefined();
    expect(parseDiagnoseResult({ toolTrace: ['signal_read', 42, null, 'sensor_list'] }).toolTrace)
      .toEqual(['signal_read', 'sensor_list']);
  });

  it('keeps toolTrace undefined when the backend omits it', () => {
    expect(parseDiagnoseResult({ cause: '', remedy: '', sources: [] }).toolTrace).toBeUndefined();
  });

  it('parses provider metrics and one defensive comparison level', () => {
    const result = parseDiagnoseResult({
      cause: 'Primary', remedy: 'A', sources: [], provider: 'cloud', durationMs: 1234,
      comparison: {
        cause: 'Secondary', remedy: 'B', sources: [], provider: 'claude-cli', durationMs: 4321,
        comparison: { cause: 'must not recurse' },
      },
      comparisonError: 'timeout',
    });
    expect(result.provider).toBe('cloud');
    expect(result.durationMs).toBe(1234);
    expect(result.comparison).toMatchObject({ provider: 'claude-cli', durationMs: 4321 });
    expect(result.comparison?.comparison).toBeUndefined();
    expect(result.comparisonError).toBe('timeout');
  });

  it('tolerates missing or malformed comparison fields', () => {
    const result = parseDiagnoseResult({
      cause: 'Legacy', remedy: '', sources: [], provider: 7, durationMs: 'slow',
      comparison: 'none', comparisonError: false,
    });
    expect(result.provider).toBeUndefined();
    expect(result.durationMs).toBeUndefined();
    expect(result.comparison).toBeUndefined();
    expect(result.comparisonError).toBeUndefined();
  });
});
