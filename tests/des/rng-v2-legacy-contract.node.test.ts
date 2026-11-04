// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { expect, it } from 'vitest';
import { SFC32, SFC32Legacy } from '../../src/core/rv-rng-distribution';
import fixture from './fixtures/rng-v2/legacy-sequences.json';
import { legacySequences } from './rng-v2-legacy-harness';

it('records the production fleet takt stream inputs', () => {
  expect(fixture.takt.plantId).toBe('PlantA');
  expect(fixture.takt.masterSeed).toBe(7);
});

it('preserves the constructor alias and all pre-change consumer sequences exactly', () => {
  expect(SFC32).toBe(SFC32Legacy);
  const { provenance: _provenance, ...expected } = fixture;
  expect(legacySequences()).toEqual(expected);
});
