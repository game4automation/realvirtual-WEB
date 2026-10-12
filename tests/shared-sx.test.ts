// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import { compactToggleGroupSx, filterChipSx, INK_HIGH } from '../src/core/hmi/shared-sx';

describe('compactToggleGroupSx', () => {
  it('returns an array', () => {
    const result = compactToggleGroupSx('#66bb6a', '102,187,106');
    expect(Array.isArray(result)).toBe(true);
  });

  it('applies accent color to selected state', () => {
    const result = compactToggleGroupSx('#66bb6a', '102,187,106') as object[];
    const base = result[0] as Record<string, unknown>;
    const root = base['& .MuiToggleButton-root'] as Record<string, unknown>;
    const selected = root['&.Mui-selected'] as Record<string, unknown>;
    expect(selected.color).toBe('#66bb6a');
    expect(selected.bgcolor).toContain('102,187,106');
  });

  it('merges extra sx', () => {
    const result = compactToggleGroupSx('#4fc3f7', '79,195,247', { ml: 'auto' }) as unknown[];
    expect(result).toHaveLength(2);
  });

  it('merges array extra sx', () => {
    const result = compactToggleGroupSx('#4fc3f7', '79,195,247', [{ ml: 'auto' }, { mr: 1 }]) as unknown[];
    expect(result).toHaveLength(3);
  });

  it('handles no extra sx', () => {
    const result = compactToggleGroupSx('#4fc3f7', '79,195,247') as unknown[];
    expect(result).toHaveLength(1);
  });

  it('sets correct height', () => {
    const result = compactToggleGroupSx('#4fc3f7', '79,195,247') as object[];
    const base = result[0] as Record<string, unknown>;
    expect(base.height).toBe(22);
  });
});

describe('filterChipSx', () => {
  it('returns active styling when isActive=true', () => {
    const sx = filterChipSx(true) as Record<string, unknown>;
    // plan-597 Phase 6b: one weight in both states (no reflow), Ink High text
    // (accent text on its own tint misses 4.5:1), state carried by tint + border.
    expect(sx.fontWeight).toBe(500);
    expect(sx.color).toBe(INK_HIGH);
    expect(sx.border).toContain('79, 195, 247');
    expect(sx.bgcolor).toContain('79, 195, 247');
    expect(sx.cursor).toBe('pointer');
  });

  it('returns inactive styling when isActive=false', () => {
    const sx = filterChipSx(false) as Record<string, unknown>;
    expect(sx.fontWeight).toBe(500);
    expect(sx.bgcolor).toBe('transparent');
  });

  it('uses default height and fontSize', () => {
    const sx = filterChipSx(true) as Record<string, unknown>;
    expect(sx.height).toBe(20);
    expect(sx.fontSize).toBe(11);
  });

  it('accepts custom height and fontSize', () => {
    const sx = filterChipSx(true, 16, 8) as Record<string, unknown>;
    expect(sx.height).toBe(16);
    expect(sx.fontSize).toBe(8);
  });

  it('includes chip label padding', () => {
    const sx = filterChipSx(false) as Record<string, unknown>;
    const chipLabel = sx['& .MuiChip-label'] as Record<string, unknown>;
    expect(chipLabel.px).toBeDefined();
  });

  it('includes hover state', () => {
    const sx = filterChipSx(true) as Record<string, unknown>;
    const hover = sx['&:hover'] as Record<string, unknown>;
    expect(hover.bgcolor).toBeDefined();
  });
});
