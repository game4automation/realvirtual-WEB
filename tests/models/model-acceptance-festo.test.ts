// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// A1 (plan-2219): 600 s at 60 Hz; every follow-up scan has 3 logos and no forbidden logo loss.
// The smooth-motion provider is registered like in the app (E14), so drives run the viewer's
// S-curve and A1 shares its throughput floor with the viewer soak (A2): rv-logo-cell-acceptance.mjs.
// STRICT_A1 = false would shorten the run to 60 s and check only the baseline.
const STRICT_A1 = true;
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Box3, Vector3 } from 'three';
import { registerPlcProgramComponent } from '@rv-private/plc/rv-plc-program';
import { PlcPlugin } from '@rv-private/plugins/plc/plc-plugin';
import { devAssetAvailable } from '../fixtures/dev-asset-available';
import { cellMinimumFollowUps, cellMinimumVolume } from '../../scripts/lib/rv-logo-cell-acceptance.mjs';
import { installPhysics, installSmoothMotion } from './_model-acceptance-private';
import { createAcceptanceViewer, loadAcceptanceModel, stepModel } from './_model-acceptance';
const URL = '/private-assets/festo/Festo.glb';
const OK = await devAssetAvailable(URL);
let h: Awaited<ReturnType<typeof createAcceptanceViewer>>;
let parityLines: string[] = [];
let resetSmoothMotion: (() => void) | undefined;
afterAll(() => {
  h?.dispose();
  resetSmoothMotion?.();
});
describe.skipIf(!OK)('Festo model acceptance', () => {
  beforeAll(async () => {
    h = await createAcceptanceViewer();
    registerPlcProgramComponent();
    const plc = new PlcPlugin();
    h.viewer.use(plc, 'internal');
    const physics = await installPhysics(h.viewer);
    resetSmoothMotion = await installSmoothMotion();
    const warn = vi.spyOn(console, 'warn');
    const log = vi.spyOn(console, 'log');
    try {
      await loadAcceptanceModel(h.viewer, URL);
      await physics.buildPromise;
      await plc.whenProgramsReady();
      parityLines = [...warn.mock.calls, ...log.mock.calls]
        .map(call => call.join(' ')).filter(line => line.includes('[Parity]'));
    } finally {
      warn.mockRestore();
      log.mockRestore();
    }
  }, 240_000);
  it('loads the delivered Festo GLB without parity warnings or logs', () => {
    expect(parityLines).toEqual([]);
  });
  it('meets A1 throughput, follow-up loads and logo retention over 600 s', async () => {
    const v = h.viewer, tm = v.transportManager!;
    const seconds = STRICT_A1 ? 600 : 60;
    const minimumVolume = cellMinimumVolume(seconds);
    const gate = tm.sensors.find(s => s.node.name === 'LightGate_Scanning');
    expect(!!gate, 'Festo: scanning gate absent (expected LightGate_Scanning)').toBe(true);
    const unload = tm.sinks.find(s => s.node.name === 'LogoUnload');
    expect(!!unload, 'Festo: logo sink absent (expected LogoUnload)').toBe(true);
    type MU = (typeof tm.mus)[number];
    const isLogo = (mu: MU) => !/^Box-/.test(mu.node.name) && /logo/i.test(mu.node.name);
    // Box-Front/Box-Rear spawn fresh MUs. Instance pool slots may be reused,
    // but rv-mu's engine-wide numeric id is stable and never reused (also on
    // promotion from an instance to a clone). A shared pool node UUID is not.
    const boxes = new Set<number>();
    const firstScans: { boxId: number; logos: number }[] = [];
    const followUpScans: { boxId: number; logos: number }[] = [];
    const lastPositions = new Map<number, Vector3>();
    const forbiddenLosses = new Map<number, Vector3>();
    const consumed = new Set<number>();
    // Both RVSink.markOverlapping (XZ overlap) and the physics sensor/frozen
    // load paths notifyConsumed. RemoveBelowY only marks removal, without
    // notifying a sink. Exact attribution avoids exempting nearby floor losses.
    const unsubscribe = unload!.subscribeConsumed(mu => { consumed.add(mu.id); });
    const remember = (mu: MU) => {
      if (isLogo(mu)) lastPositions.set(mu.id, mu.getWorldPosition(new Vector3()));
    };
    // Capture the final pose before disposal as well: a logo can cross 0.78
    // and be removed within one tick, after the previous observer sample.
    const removeHook = tm.addPhysicsMUHook({ onMUDisposed(accessor) {
      const mu = tm.mus.find(mu => mu === accessor);
      if (mu) remember(mu);
    } });
    const checkLoss = (id: number, position: Vector3) => {
      if (!consumed.has(id) && position.y < 0.78) forbiddenLosses.set(id, position.clone());
    };
    let previous = false;
    for (const mu of tm.mus) remember(mu);
    try {
      await stepModel(v, 'Festo', seconds, () => {
        const liveLogos = new Set<number>();
        for (const mu of tm.mus) {
          if (!isLogo(mu)) continue;
          liveLogos.add(mu.id);
          remember(mu);
          // RemoveBelowY marks this tick; transport may dispose next tick.
          if (mu.markedForRemoval) checkLoss(mu.id, lastPositions.get(mu.id)!);
        }
        for (const [id, position] of lastPositions) {
          if (liveLogos.has(id)) continue;
          checkLoss(id, position);
          lastPositions.delete(id);
          consumed.delete(id);
        }
        const ok = v.signalStore?.get('Barcode_Ok') === true;
        if (ok && !previous) {
          const box = gate!.occupiedMU;
          expect(!!box && /^Box-/.test(box.node.name),
            `Festo: Barcode_Ok box ${box?.node.name ?? 'absent'} (expected Box-* in LightGate_Scanning)`).toBe(true);
          box!.aabb.update();
          const bounds = new Box3(box!.aabb.min, box!.aabb.max);
          const loads = new Set<number>();
          if ('loadedMus' in box!) {
            for (const mu of box!.loadedMus) if (isLogo(mu)) loads.add(mu.id);
          }
          for (const mu of tm.mus) {
            if (isLogo(mu) && bounds.containsPoint(mu.getWorldPosition(new Vector3()))) loads.add(mu.id);
          }
          const scans = boxes.has(box!.id) ? followUpScans : firstScans;
          scans.push({ boxId: box!.id, logos: loads.size });
          boxes.add(box!.id);
        }
        previous = ok;
      }, 400_000);
    } finally {
      unsubscribe();
      removeHook();
    }
    const total = firstScans.length + followUpScans.length;
    const minimumFollowUps = cellMinimumFollowUps(minimumVolume, boxes.size);
    const withThree = followUpScans.filter(scan => scan.logos === 3).length;
    console.log(`Festo: first scans ${firstScans.length}, per-scan logos ${JSON.stringify(firstScans)}`);
    console.log(`Festo: follow-up scans ${followUpScans.length}, per-scan logos ${JSON.stringify(followUpScans)}`);
    console.log(`Festo: A1 scans total ${total}, distinct boxes ${boxes.size}, first scans ${firstScans.length}, follow-ups ${followUpScans.length}, follow-ups with 3 logos ${withThree}, forbidden losses ${forbiddenLosses.size}, sim seconds ${seconds}`);
    if (!STRICT_A1) {
      const loaded = [...firstScans, ...followUpScans].filter(scan => scan.logos >= 1).length;
      expect(total, `Festo: ${total} scans in ${seconds} s sim (expected >= 1, strict A1 off)`).toBeGreaterThanOrEqual(1);
      expect(loaded, `Festo: ${loaded} scanned boxes with >= 1 logo (expected >= 1, strict A1 off)`).toBeGreaterThanOrEqual(1);
      expect(forbiddenLosses.size, `Festo: ${forbiddenLosses.size} forbidden logo losses in ${seconds} s (expected 0)`).toBe(0);
      return;
    }
    expect.soft(total, `Festo: ${total} scans in ${seconds} s sim (expected >= ${minimumVolume})`).toBeGreaterThanOrEqual(minimumVolume);
    expect.soft(followUpScans.length,
      `Festo: ${followUpScans.length} follow-ups, ${boxes.size} distinct boxes (expected >= ${minimumFollowUps})`).toBeGreaterThanOrEqual(minimumFollowUps);
    expect.soft(withThree,
      `Festo: ${withThree}/${followUpScans.length} follow-ups with 3 logos, scans ${JSON.stringify(followUpScans)} (expected exactly 3 logos on every follow-up)`).toBe(followUpScans.length);
    const losses = [...forbiddenLosses].map(([id, p]) => `${id}: (${p.x.toFixed(4)}, ${p.y.toFixed(4)}, ${p.z.toFixed(4)})`);
    expect.soft(forbiddenLosses.size,
      `Festo: ${forbiddenLosses.size} forbidden logo losses at world positions [${losses.join('; ')}] (expected 0 removals below y 0.78 m except LogoUnload)`).toBe(0);
  }, 600_000);
});
