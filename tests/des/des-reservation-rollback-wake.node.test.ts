// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { expect, it } from 'vitest';
import { IndexingConveyor } from '../../src/plugins/des/material-flow/IndexingConveyor';
import type { MaterialFlowDefinition } from '../../src/core/material-flow/define-material-flow';
import type { MU } from '../../src/core/material-flow/material-flow-self';
import { flow, transferFixture } from './phase2-transfer-fixture';

it('9.21 a refused reserved transfer wakes the indexing target without an unrelated event', () => {
  const f = transferFixture([{ type: flow() },
    { type: IndexingConveyor as unknown as MaterialFlowDefinition }, { type: flow() }]);
  const [sender, target, sink] = f.parts;
  const incoming = f.runner.createMU();
  expect(sender.acceptMU(incoming)).toBe(true);
  const reservation = sender.reserveDownstream(1);
  const resident = f.runner.createMU();
  // The resident occupies the first slot while the reservation prevents indexing.
  expect(target.acceptMU(resident)).toBe(true);
  expect(target.reservedLoad).toBe(1);
  expect(target.self.prop.phase).toBe('idle');
  expect(f.manager.queuedEventCount).toBe(0);
  // canAccept rejects the occupied entry slot, invoking the real rollback path.
  expect(reservation.commitMany([incoming as unknown as MU])).toBe(false);
  expect(target.reservedLoad).toBe(0);
  expect(sender.heldMUs).toContain(incoming);
  f.advance(10);
  expect.soft(target.currentLoad).toBe(0);
  expect(sink.heldMUs).toEqual([resident]);
});
