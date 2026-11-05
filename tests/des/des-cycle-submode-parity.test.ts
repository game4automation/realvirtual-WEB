// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { afterEach, expect, it } from 'vitest';
import { setDriveSpeedOverride } from '../../src/core/engine/rv-speed-override';
import { cycleBrowserWorld, END, MODES } from './cycle-browser-world';

afterEach(() => setDriveSpeedOverride(1));

it('projects identical due, drive, pulse and MU state at T=30 in every DES sub-mode', async () => {
  let reference: ReturnType<Awaited<ReturnType<typeof cycleBrowserWorld>>['projection']> | undefined;
  for (const mode of MODES) {
    const world = await cycleBrowserWorld({ seed: 2207 });
    try {
      setDriveSpeedOverride(mode === 'animated' ? 1 : 2);
      await world.advance(mode);
      const actual = world.projection();
      expect(actual.simTime, mode).toBe(END);
      expect(actual.participant.count, mode).toBe(40);
      expect(actual.participant.edges, mode).toEqual([{ t: 0, value: true }, { t: 0.35, value: false }]);
      expect(actual.participant.targets, mode).toHaveLength(41);
      expect(new Set(actual.participant.targets).size, mode).toBeGreaterThan(1);
      expect(actual.drives[0].position, mode).toBeGreaterThan(0);
      expect(actual.muPoses, mode).toHaveLength(1);
      expect(actual.muPoses[0].pose, mode).toEqual([END, 0, 0]);
      expect(actual.muPoses[0].quaternion, mode).toEqual([0, 0, 0, 1]);
      expect(actual.samples.length, mode).toBe(301);
      expect(world.runner.renderPhaseSignalWrites, mode).toBe(0);
      if (reference) expect(actual, mode).toEqual(reference);
      else reference = actual;
    } finally { world.dispose(); }
  }
}, 120_000);
