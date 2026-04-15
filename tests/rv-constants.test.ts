// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { MM_TO_METERS, DRAG_THRESHOLD_PX, DEFAULT_DPR_CAP, lastPathSegment } from '../src/core/engine/rv-constants';

describe('rv-constants', () => {
  it('MM_TO_METERS equals 1000', () => {
    expect(MM_TO_METERS).toBe(1000);
  });
  it('DRAG_THRESHOLD_PX is positive integer', () => {
    expect(DRAG_THRESHOLD_PX).toBeGreaterThan(0);
    expect(Number.isInteger(DRAG_THRESHOLD_PX)).toBe(true);
  });
  it('DEFAULT_DPR_CAP is between 1 and 3', () => {
    expect(DEFAULT_DPR_CAP).toBeGreaterThanOrEqual(1);
    expect(DEFAULT_DPR_CAP).toBeLessThanOrEqual(3);
  });
});

describe('lastPathSegment', () => {
  it('returns last segment after slash', () => {
    expect(lastPathSegment('Root/Child/Leaf')).toBe('Leaf');
  });
  it('returns full string when no slash', () => {
    expect(lastPathSegment('OnlyName')).toBe('OnlyName');
  });
  it('handles trailing slash', () => {
    expect(lastPathSegment('Root/Child/')).toBe('');
  });
  it('handles single segment with leading slash', () => {
    expect(lastPathSegment('/Root')).toBe('Root');
  });
  it('handles empty string', () => {
    expect(lastPathSegment('')).toBe('');
  });
  it('handles deeply nested path', () => {
    expect(lastPathSegment('A/B/C/D/E/F')).toBe('F');
  });
});
