// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.8 model-switch-cleanup — a REAL model switch (not a test reset) clears
 * claims, slot↔channel indexes, the live-control gate and raised instance
 * flags.
 *
 * Uses the full RVViewer harness (tests/helpers/create-test-viewer.ts) so the
 * cleanup runs through the production `clearModel()` path:
 *  - Reload of the SAME model with an ACTIVE force starts clean (claims from
 *    the previous run do not leak into the reloaded model).
 *  - The reset also runs on the path where the SignalBindingManager dispose
 *    is conditionally gated (viewer WITHOUT plannerSignalLinking — the
 *    manager is null, yet resetSlotAuthority() must still run).
 *
 * Phase 3 addition (9.8 rest case): a model switch during ACTIVE remote
 * ownership does not inherit the foreign ownership into the new model — the
 * unconditional resetSlotAuthority() in clearModel() also clears the
 * upstream remote-ownership layer.
 */

import { afterEach, describe, expect, it } from 'vitest';
import {
  claimBound,
  claimForced,
  claimedSlotCount,
  isRemoteOwnershipActive,
  liveControlledCount,
  makeSignalChannelId,
  makeSlotId,
  registerSlotChannel,
  resetSlotAuthority,
  setInstanceLiveControlled,
  setRemoteOwnershipActive,
  setSignalLiveControlled,
  slotsForChannel,
} from '../src/core/engine/rv-slot-authority';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { DEV_GLB } from './fixtures/glb-paths.mjs';

const GLB_URL = DEV_GLB.tests;
const SMALL_GLB_URL = DEV_GLB.physicsZone;

let handle: TestViewerHandle | null = null;

afterEach(() => {
  handle?.dispose();
  handle = null;
  resetSlotAuthority();
});

async function glbAvailable(url: string): Promise<boolean> {
  try {
    const head = await fetch(url, { method: 'HEAD' });
    return head.ok;
  } catch {
    return false;
  }
}

describe('model switch cleanup (9.8)', () => {
  it('reloading the same model with an active force starts clean', async () => {
    if (!(await glbAvailable(GLB_URL))) {
      console.warn(`${GLB_URL} not available — skipping real model-switch test`);
      return;
    }
    handle = await createTestViewer('webgl', { plannerSignalLinking: true });
    const { viewer } = handle;
    await viewer.loadModel(GLB_URL);
    expect(viewer.signalBindingManager).not.toBeNull();
    const manager = viewer.signalBindingManager!;
    const store = viewer.signalStore!;

    // Bind a real slot of the loaded model: pick a Drive_Simple node.
    const entry = viewer.registry!.getAll('Drive_Simple')[0];
    expect(entry).toBeDefined();
    const node = viewer.registry!.getNode(entry.path)!;
    const slots = manager.getElementSlots('switch-test', node)
      .filter((slot) => slot.kind === 'mapped-signal' && slot.type === 'bool');
    expect(slots.length).toBeGreaterThan(0);
    const slot = slots[0] as { slot: string; componentPath: string; targetName: string };
    store.register('Test.Source', '__test__/Test.Source', true, 'PLCOutputBool');
    manager.bind('switch-test', node, {
      kind: 'mapped-signal',
      componentPath: slot.componentPath,
      slot: slot.slot,
      signal: 'Test.Source',
      direction: 'plcOutput',
      enabled: true,
    });
    manager.tick(1 / 60);
    const slotId = manager.getSlotId('switch-test', slot.slot, slot.componentPath);
    expect(slotId).toBeDefined();
    expect(manager.getBindingLiveness('switch-test', slot.slot, slot.componentPath)).toBe('live');
    expect(claimedSlotCount()).toBeGreaterThan(0);

    // Active force on the bound slot at switch time.
    store.forceSignal(slot.targetName, true);
    manager.tick(1 / 60);

    // REAL model switch: reload the same URL.
    await viewer.loadModel(GLB_URL);

    // Everything from the previous run is gone — the reloaded model starts clean.
    expect(claimedSlotCount()).toBe(0);
    expect(liveControlledCount()).toBe(0);
    // The new store starts unforced (per-model store).
    expect(viewer.signalStore!.forcedCount).toBe(0);
  }, 240000);

  it('cleanup runs even on the conditionally gated dispose path (no manager)', async () => {
    if (!(await glbAvailable(SMALL_GLB_URL))) {
      console.warn(`${SMALL_GLB_URL} not available — skipping gated-path test`);
      return;
    }
    // Viewer WITHOUT plannerSignalLinking: signalBindingManager stays null, so
    // the manager-dispose blocks in loadModel()/clearModel() are gated away —
    // the authority reset must run regardless.
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    await viewer.loadModel(SMALL_GLB_URL);
    expect(viewer.signalBindingManager).toBeNull();

    // Residual state as it could be left behind by any claimer.
    const slotId = makeSlotId('ghost', '.', 'Drive_Simple', 'Forward');
    claimBound(slotId);
    claimForced(slotId);
    registerSlotChannel(slotId, makeSignalChannelId('Ghost.Forward'));
    setSignalLiveControlled('Ghost.Forward', true);
    const instance: { liveControlled?: boolean } = {};
    setInstanceLiveControlled(instance, true);
    // 9.8 rest case (Phase 3): active remote ownership at switch time must
    // NOT be inherited by the new model.
    setRemoteOwnershipActive(true);

    // REAL switch through the production path.
    await viewer.loadModel(SMALL_GLB_URL);

    expect(claimedSlotCount()).toBe(0);
    expect(liveControlledCount()).toBe(0);
    expect(slotsForChannel(makeSignalChannelId('Ghost.Forward'))).toHaveLength(0);
    expect(instance.liveControlled).toBe(false);
    expect(isRemoteOwnershipActive()).toBe(false);
  }, 240000);
});
