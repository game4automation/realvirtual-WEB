// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { unzipSync, strFromU8 } from 'three/examples/jsm/libs/fflate.module.js';
import { exportRuntimeStage } from '../src/core/usd/runtime-stage-export';
import { SyncTracker } from '../src/plugins/usd-live-link/sync-tracker';
import { byteStageRig, trackerBytes } from './helpers/usd-phase1-byte-rig';
const baseline = JSON.parse(readFileSync(new URL('./fixtures/usd-live-link-phase1-baseline.json', import.meta.url), 'utf8'));
// Plan 2239 Phase 1 intentionally changes mount names and adds registry customData.
// Keep the original wire fixture untouched. The new mount fixture was derived
// from its model.usda with ONLY Axis_1 -> Axis_2, Geometry -> Geometry_1 and
// xis -> Aexis (sibling allocation, reserved names, German transliteration).
// This historical rig has no registry; address metadata is covered separately.
// core.autocrlf may check out the fixture as CRLF; exporter text always uses LF.
const mountBaseline = readFileSync(new URL('./fixtures/usd-live-link-plan2239-mount.usda', import.meta.url), 'utf8').replace(/\r\n/g, '\n');

describe('Live-Link wire bytes from e34b52f9; mount baseline from plan 2239', () => {
  it('only model.usda names change; geometry bytes, ordering and preplaced indices stay identical', async () => {
    vi.useFakeTimers();
    // fflate writes local ZIP timestamps: pin the same local clock on every host.
    vi.setSystemTime(new Date(2026, 0, 1, 1, 0, 0));
    try {
      const stage = await exportRuntimeStage(byteStageRig());
      const files = unzipSync(stage.usdz), original = unzipSync(Buffer.from(baseline.usdzHex, 'hex'));
      expect(Object.keys(files)).toEqual(Object.keys(original));
      expect(strFromU8(files['model.usda'])).toBe(mountBaseline);
      for (const name of Object.keys(original).filter((name) => name !== 'model.usda')) expect(files[name]).toEqual(original[name]);
      expect(stage.primPaths).toEqual([
        '/Root/Scenes/Scene/Cell', '/Root/Scenes/Scene/Cell/Axis',
        '/Root/Scenes/Scene/Cell/Axis_2', '/Root/Scenes/Scene/Cell/Geometry_1', '/Root/Scenes/Scene/Cell/Aexis',
      ]);
      expect(stage.templates).toEqual(['/Root/Scenes/Scene/Cell/Geometry_1']);
      expect(stage.preplaced).toEqual(baseline.preplaced);
    } finally { vi.useRealTimers(); }
  });
  it('spawn, full-state, deltas, world poses, deletion and reconnect messages match original bytes', () => {
    expect(trackerBytes(SyncTracker)).toEqual(baseline.wireHex);
  });
});
