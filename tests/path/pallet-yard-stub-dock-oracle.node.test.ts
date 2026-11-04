// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// Plan-636 9.2b deviation: PalletYard is public now; keep its imported oracle here.
import { expect, it } from 'vitest';
import { STICH, FORK_SEAT_OFFSET_M, handlingPose, junctionX, straightOf, STATION_GEOMETRY, COURSE } from '../../src/plugins/models/PalletYard/layout';
import { computeStubDock } from '../../src/core/engine/rv-path-stub-dock';
import { placedTemplate, poseAtArcLength, poseForPort } from '../../src/core/engine/rv-path-blocks';
import type { PathGraphEntry } from '../../src/core/engine/rv-path-network-ops';

it.each(STATION_GEOMETRY.filter(g => g.kind !== 'wait'))('reproduces the PalletYard stub of $id', g => {
  const { z, dir } = straightOf(g.straight);
  const extent = Math.max(20, COURSE.xEnd);
  const host: PathGraphEntry = { id: g.straight, nodeName: g.straight, block: '', successors: [], segments: [{ kind: 'line', from: [-extent * dir, 0, z], to: [extent * dir, 0, z] }] };
  const hp = handlingPose(g);
  expect(Math.hypot(hp.seat[0] - hp.root[0], hp.seat[1] + hp.forwardZ * FORK_SEAT_OFFSET_M - hp.root[1])).toBeLessThanOrEqual(0.001);
  const result = computeStubDock({ host, seat: hp.seat, portDir: [0, hp.forwardZ], loadOffsetM: FORK_SEAT_OFFSET_M, radiusM: STICH.arcR });
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  expect(Math.abs(result.stubStraightM - STICH.straightM)).toBeLessThanOrEqual(0.001);
  const at = poseAtArcLength(host.segments, result.s)!;
  expect(Math.abs(at.position[0] - junctionX(g))).toBeLessThanOrEqual(0.001);
  const stub = placedTemplate({ kind: 'stub', radiusM: STICH.arcR, stubStraightM: result.stubStraightM, side: result.side }, poseForPort(at), at.position[1]).find(p => p.role === 'stub')!.specs[0];
  if (stub.kind !== 'line') throw new Error('Expected stub line');
  expect(Math.hypot(stub.from[0] - hp.root[0], stub.from[2] - hp.root[1])).toBeLessThanOrEqual(0.001);
});
