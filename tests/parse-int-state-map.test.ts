// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, beforeEach } from 'vitest';
import { parseIntStateMap, resetWebSensorConfig } from '../src/core/engine/rv-web-sensor';

describe('parseIntStateMap', () => {
  beforeEach(() => resetWebSensorConfig());

  it('returns defaults for empty input', () => {
    const m = parseIntStateMap('');
    expect(m.get(0)).toBe('low');
    expect(m.get(3)).toBe('error');
  });

  it('parses valid mapping', () => {
    const m = parseIntStateMap('0:low,5:high,99:error');
    expect(m.get(5)).toBe('high');
    expect(m.get(99)).toBe('error');
    expect(m.get(1)).toBeUndefined();
  });

  it('falls back to defaults on fully invalid input', () => {
    const m = parseIntStateMap('garbage');
    expect(m.get(0)).toBe('low');
  });

  it('partial valid + invalid: keeps only valid', () => {
    const m = parseIntStateMap('0:low,badentry,2:warning');
    expect(m.get(0)).toBe('low');
    expect(m.get(2)).toBe('warning');
    expect(m.size).toBe(2);
  });

  it('is case-insensitive for state names', () => {
    const m = parseIntStateMap('0:LOW,1:High');
    expect(m.get(0)).toBe('low');
    expect(m.get(1)).toBe('high');
  });

  it('handles negative keys', () => {
    const m = parseIntStateMap('-1:error,0:low');
    expect(m.get(-1)).toBe('error');
  });
});
