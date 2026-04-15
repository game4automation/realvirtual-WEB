// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Tooltip Utils Tests
 *
 * Tests viewport clamping logic. projectToScreen requires a real Three.js
 * camera and renderer, so it is tested indirectly via integration.
 */
import { describe, it, expect } from 'vitest';
import { clampToViewport } from '../src/core/hmi/tooltip/tooltip-utils';

describe('clampToViewport', () => {
  // NOTE: y is the BOTTOM of the tooltip (CSS transform: translateY(-100%) renders upward).
  // The top edge is at y - tooltipHeight.

  it('should clamp tooltip that overflows right edge', () => {
    // Tooltip at x=1900, width=200, viewport=1920, margin=10
    const result = clampToViewport(1900, 100, 200, 150, 10, 1920, 1080);
    expect(result.x).toBeLessThanOrEqual(1920 - 200 - 10);
    // y=100, bottom edge 100 < 1080-10, top edge 100-150=-50 < 10 => push to margin+height=160
    expect(result.y).toBe(10 + 150);
  });

  it('should not modify position if within bounds', () => {
    // y=300 (bottom), top edge=300-150=150 > margin=10, bottom=300 < 1080-10 => no clamp
    const result = clampToViewport(400, 300, 200, 150, 10, 1920, 1080);
    expect(result.x).toBe(400);
    expect(result.y).toBe(300);
  });

  it('should clamp top edge', () => {
    // y=5 (bottom), top edge=5-150=-145 < margin=10 => push to margin+height=160
    const result = clampToViewport(400, 5, 200, 150, 10, 1920, 1080);
    expect(result.y).toBe(10 + 150);
  });

  it('should clamp bottom edge', () => {
    // y=1075 (bottom), bottom clamp: min(1075, 1080-10)=1070, top=1070-150=920 > 10 => ok
    const result = clampToViewport(400, 1075, 200, 150, 10, 1920, 1080);
    expect(result.y).toBe(1070);
  });

  it('should clamp left edge', () => {
    const result = clampToViewport(2, 300, 200, 150, 10, 1920, 1080);
    expect(result.x).toBe(10);
  });

  it('should clamp both x and y simultaneously', () => {
    // x=1900 => right clamp: min(1900, 1920-200-10)=1710
    // y=1075 => bottom clamp: min(1075, 1080-10)=1070, top=1070-150=920 > 10 => ok
    const result = clampToViewport(1900, 1075, 200, 150, 10, 1920, 1080);
    expect(result.x).toBeLessThanOrEqual(1920 - 200 - 10);
    expect(result.y).toBeLessThanOrEqual(1080 - 10);
  });

  it('should handle zero margin', () => {
    const result = clampToViewport(1800, 500, 200, 150, 0, 1920, 1080);
    expect(result.x).toBeLessThanOrEqual(1920 - 200);
  });

  it('should handle edge case where tooltip is larger than viewport', () => {
    // When tooltip is wider than viewport, clamp to margin
    const result = clampToViewport(500, 500, 2000, 1200, 10, 1920, 1080);
    // Right clamp: min(500, 1920-2000-10)=-90, left clamp: max(-90, 10)=10
    expect(result.x).toBe(10);
    // Bottom clamp: min(500, 1080-10)=500, top check: 500-1200=-700 < 10 => push to 10+1200=1210
    expect(result.y).toBe(10 + 1200);
  });
});
