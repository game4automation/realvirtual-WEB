// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { ProgressLedger } from '../../src/core/diagnostics/rv-progress-ledger';

it('exposes an entirely absent vehicle adapter independently of reported progress', () => {
  const ledger = new ProgressLedger({ clock: { now: () => 0 } });
  ledger.addPopulation({ id: 'fleet', kind: 'vehicle', expected: () => ['B', 'A'] });
  ledger.addPopulation({ id: 'timers', kind: 'other', expected: () => ['T1', 'T0'] });
  ledger.register('T0', 'other', 'timer'); ledger.register('T1', 'other', 'timer');
  const before = ledger.sample(120).coverage;
  expect(before.missing).toEqual(['A', 'B']);
  expect(before.coverageComplete).toBe(false);
  expect(before.bySource).toEqual({ fleet: 2, timers: 2 });
  ledger.register('A', 'vehicle', 'vehicle'); ledger.register('B', 'vehicle', 'vehicle');
  expect(ledger.sample(120).coverage).toMatchObject({ missing: [], coverageComplete: true });
  ledger.bump('Z', 'other'); ledger.bump('X', 'other');
  expect(ledger.sample(120).coverage.unknown).toEqual(['X', 'Z']);
  expect(before.missing).toEqual(['A', 'B']);
});
