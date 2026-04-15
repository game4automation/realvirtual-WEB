// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { createBaseChartOption, DARK_TOOLTIP_BASE } from '../src/core/hmi/chart-theme';

describe('createBaseChartOption', () => {
  it('returns transparent background', () => {
    const opt = createBaseChartOption();
    expect(opt.backgroundColor).toBe('transparent');
  });

  it('includes title when provided', () => {
    const opt = createBaseChartOption({ title: 'Test' });
    expect((opt.title as Record<string, unknown>).text).toBe('Test');
  });

  it('omits title when not provided', () => {
    const opt = createBaseChartOption();
    expect(opt.title).toBeUndefined();
  });

  it('enables scroll legend when requested', () => {
    const opt = createBaseChartOption({ scrollLegend: true });
    expect((opt.legend as Record<string, unknown>).type).toBe('scroll');
  });

  it('uses default grid values', () => {
    const opt = createBaseChartOption();
    expect(opt.grid).toEqual({ left: 50, right: 12, top: 24, bottom: 42 });
  });

  it('adds animation settings when animate is true', () => {
    const opt = createBaseChartOption({ animate: true });
    expect(opt.animationDuration).toBe(500);
    expect(opt.animationEasing).toBe('cubicOut');
  });

  it('omits animation settings when animate is false', () => {
    const opt = createBaseChartOption({ animate: false });
    expect(opt.animationDuration).toBeUndefined();
  });

  it('tooltip uses dark base by default', () => {
    const opt = createBaseChartOption();
    expect(opt.tooltip).toBe(DARK_TOOLTIP_BASE);
  });
});
