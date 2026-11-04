// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { transferFixture } from './phase2-transfer-fixture';

it('9.5 starts an idle Station at t=0 through Storage with AutoRelease=false', () => {
  const f = transferFixture([
    { type: 'Source', props: { Interval: 100 } },
    { type: 'Storage', props: { AutoRelease: false, MaxCapacity: 1 } },
    { type: 'Station', props: { ProcessingTime: 20 } },
  ]);
  f.advance(0);
  const [, , station] = f.parts;
  expect(station.currentLoad).toBe(1);
  expect(station.self.mus).toHaveLength(1);
  expect(station.self.state).toBe('Working');
  expect(station.heldMUs[0].entryTime).toBe(0);
  expect(station.heldMUs[0].currentComponent).toBe(station);
});
