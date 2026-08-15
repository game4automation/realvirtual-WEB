// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import {
  materialForValue,
  materialToValue,
} from '../src/core/editor/rv-asset-material';
import {
  BUILTIN_MATERIAL_PRESETS,
  PRESET_CATEGORIES,
  swatchBackground,
} from '@rv-private/plugins/asset-editor/materials/material-presets';

describe('Lamp / Signal material presets', () => {
  const lamps = BUILTIN_MATERIAL_PRESETS.filter((preset) => preset.category === 'Lamp / Signal');

  it('provides the five standard signal colors in display order', () => {
    expect(PRESET_CATEGORIES).toContain('Lamp / Signal');
    expect(lamps).toHaveLength(5);
    expect(lamps.every((preset) => Boolean(preset.emissive))).toBe(true);
  });

  it('round-trips emissive values through the real material conversion', () => {
    for (const preset of lamps) {
      const roundTrip = materialToValue(materialForValue(preset));
      expect(roundTrip?.emissive?.toLowerCase()).toBe(preset.emissive?.toLowerCase());
      expect(roundTrip?.emissiveIntensity).toBe(preset.emissiveIntensity);
    }
  });

  it('boosts blue above red and renders emissive swatches with a glow layer', () => {
    const red = lamps.find((preset) => preset.id === 'lamp-red')!;
    const blue = lamps.find((preset) => preset.id === 'lamp-blue')!;
    expect(blue.emissiveIntensity).toBeGreaterThan(red.emissiveIntensity!);
    const withoutEmission = { ...red, emissive: undefined, emissiveIntensity: undefined };
    expect(swatchBackground(red)).not.toBe(swatchBackground(withoutEmission));
    expect(swatchBackground(red)).toContain('transparent 74%');
  });
});
