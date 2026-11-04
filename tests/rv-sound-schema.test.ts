// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2019 §9.1 — the `Sound` $def loads, defaults Auto / Auto / 1, the legacy
 * fields stay invisible, and the component is a REAL factory (C1) with
 * `bake: 'merge'` (C6).
 */

import { describe, expect, it } from 'vitest';
import { Object3D } from 'three';
import {
  applySchema, getCapabilities, getConsumedFieldsFromSchema, getRegisteredFactories, getSchemaDefaults, loadSchemaFromSpec,
} from '../src/core/engine/rv-component-registry';
import '../src/core/engine/rv-scene-loader';
import { RVSound } from '../src/core/engine/rv-sound';

describe('Sound schema (plan-2019 9.1)', () => {
  it('loads from rv-odt.json with defaults Auto / Auto / 1', () => {
    const s = loadSchemaFromSpec('Sound');
    expect(s.Kind).toMatchObject({ type: 'enum', default: 'Auto' });
    expect(Object.keys(s.Kind.enumMap!)).toEqual(['Auto', 'Drive', 'Cylinder', 'Hydraulic']);
    expect(s.Variant).toMatchObject({ type: 'enum', default: 'Auto' });
    expect(Object.keys(s.Variant.enumMap!)).toEqual(['Auto', 'Large', 'Medium', 'Small', 'Hard', 'Cushioned']);
    expect(s.Volume).toEqual({ type: 'number', default: 1, min: 0, max: 1 });
  });

  it('declares the legacy Unity fields, hidden from the inspector (scope none)', () => {
    const s = loadSchemaFromSpec('Sound');
    expect(s.SoundType.scope).toBe('none');
    expect(s.Mode.scope).toBe('none');
    expect(s.SoundType.enumMap!['4']).toBe('AirPressure');
    // Authoring defaults stamp only the three real properties.
    expect(Object.keys(getSchemaDefaults('Sound')).sort()).toEqual(['Kind', 'Variant', 'Volume']);
    expect(getConsumedFieldsFromSchema('Sound')).not.toContain('SoundType');
  });

  it('is registered as a factory that creates an RVSound (C1) and is authorable with bake merge (C6)', () => {
    const f = getRegisteredFactories().get('Sound');
    expect(f).toBeDefined();
    const node = new Object3D();
    const inst = f!.create(node, null);
    expect(inst).toBeInstanceOf(RVSound);
    const caps = getCapabilities('Sound');
    expect(caps.authorable).toBe(true);
    expect(caps.bake).toBe('merge');
  });

  it('beforeSchema records whether Kind / Variant were present (legacy precedence)', () => {
    const f = getRegisteredFactories().get('Sound')!;
    const a = f.create(new Object3D(), null) as RVSound;
    f.beforeSchema!(a, { SoundType: 'AirPressure' });
    applySchema(a as unknown as Record<string, unknown>, f.schema, { SoundType: 'AirPressure' });
    expect(a.authoredKind).toBe(false);
    expect(a.authoredVariant).toBe(false);
    expect(a.SoundType).toBe('AirPressure');
    expect(a.Kind).toBe('Auto');

    const b = f.create(new Object3D(), null) as RVSound;
    f.beforeSchema!(b, { Kind: 'Cylinder', SoundType: '0' });
    applySchema(b as unknown as Record<string, unknown>, f.schema, { Kind: 'Cylinder', SoundType: '0' });
    expect(b.authoredKind).toBe(true);
    expect(b.SoundType).toBe('Robot1');
  });
});
