// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-430 §9.7 — end-to-end against the real 2-station demo export
 * (`projects/Development/models/DemoCSGMachining.glb` in the PRIVATE sibling
 * since plan-395: the model is internal, not shipped, and was removed from
 * `public/project.json`'s documents[] — which is what made the old
 * `?scene=builtin:` form stop resolving). Loaded by URL through `?model=`,
 * and skipped outright without the private sibling.
 * The machining pipeline is wired into
 * the running viewer, the MillingSequence produces visible material removal,
 * the spindle signal gates the cut, reset restores the stock, a model switch
 * under backlog does not crash (epoch guard), and the 2-station memory cost
 * stays under the 100 MB acceptance budget (NFR, final tier of the
 * three-stage criterion — the kernel tier was measured in the Phase-1
 * benchmark, the chunk-geometry tier here against the live scene).
 *
 * Everything runs in ONE test: the cold dev server pays ~2 min for the first
 * frame and the worker boot (wasm fetch + grid voxelize) costs another chunk —
 * paying that once and asserting in sequence keeps the suite affordable. The
 * steps only ever RELAX state they changed (spindle back on, reset released),
 * so later assertions never depend on a previous step's leftovers.
 */

import { test, expect } from 'playwright/test';
import type { Page } from 'playwright/test';
import { DEV_GLB } from '../tests/fixtures/glb-paths.mjs';
import { DEV_ASSETS_SKIP_REASON, HAS_DEV_ASSETS } from './dev-assets';

/** Best-effort dismissal of the boot-time overlay notices (same rationale as
 *  collision.spec.ts — the auto-quality modal swallows every click). */
async function dismissStartupNotices(page: Page): Promise<void> {
  for (const testId of ['auto-quality-ok', 'welcome-start-demo', 'welcome-dismiss']) {
    const btn = page.getByTestId(testId);
    try {
      if (await btn.isVisible({ timeout: 1_000 })) {
        await btn.click({ timeout: 5_000 });
        await btn.waitFor({ state: 'detached', timeout: 5_000 });
      }
    } catch {
      /* not shown on this machine — nothing to dismiss */
    }
  }
}

/** Snapshot of both stations, taken inside the page. */
interface VolumeProbe {
  name: string;
  initialized: boolean;
  chunkMeshCount: number;
  materialRemainingPercent: number;
  voxelsModified: number;
  pendingJobs: number;
  pendingChunks: number;
  spindleSignal: string | null;
  resetSignal: string | null;
  spindleOn: boolean;
  gridResolution: [number, number, number];
}

function probeVolumes(page: Page): Promise<VolumeProbe[]> {
  return page.evaluate(() => {
    const viewer = (window as unknown as { viewer: any }).viewer;
    const out: VolumeProbe[] = [];
    for (const volume of viewer.machiningManager._entries.keys()) {
      out.push({
        name: volume.node?.name ?? '?',
        initialized: volume.IsInitialized,
        chunkMeshCount: volume.chunkMeshCount,
        materialRemainingPercent: volume.MaterialRemainingPercent,
        voxelsModified: volume.VoxelsModified,
        pendingJobs: volume.PendingJobCount,
        pendingChunks: volume.PendingChunkCount,
        spindleSignal: volume.SignalSpindleOn,
        resetSignal: volume.SignalReset,
        spindleOn: volume.SignalSpindleOn
          ? viewer.signalStore.getBoolByPath(volume.SignalSpindleOn)
          : true,
        gridResolution: [volume.gridResolution.x, volume.gridResolution.y, volume.gridResolution.z],
      });
    }
    return out;
  });
}

test.skip(!HAS_DEV_ASSETS, DEV_ASSETS_SKIP_REASON);

test('DemoCSGMachining: milling runs, spindle gates, reset restores, model switch survives backlog, memory < 100 MB', async ({ page }) => {
  test.setTimeout(600_000);

  const pageErrors: string[] = [];
  page.on('pageerror', (err) => pageErrors.push(String(err)));

  // `?model=<url>` rather than `?scene=builtin:<file>`: the builtin form
  // matches against the shipped catalogue, and this model is no longer in it.
  await page.goto(`/?model=${encodeURIComponent(DEV_GLB.csgMachining)}`, { waitUntil: 'domcontentloaded' });
  // A cold Vite dev server needs ~2 min of on-demand transforms before the
  // first frame (same measurement as collision.spec.ts) — 60 s flaked here.
  await page.waitForSelector('canvas', { timeout: 180_000 });

  // READINESS: gate on what the assertions need — both volumes registered,
  // grids attached AND the first chunk meshes arrived (worker booted, wasm
  // fetched, voxelize + first tessellation done). `machiningManager` exists
  // from the constructor, so its presence alone proves nothing (same lesson
  // as collision.spec.ts).
  await page.waitForFunction(
    () => {
      const v = (window as unknown as { viewer?: any }).viewer;
      if (!v?.machiningManager || v.machiningManager.size < 2 || !v.signalStore) return false;
      const volumes = [...v.machiningManager._entries.keys()];
      return volumes.every((vol: any) => vol.IsInitialized && vol.chunkMeshCount > 0);
    },
    undefined,
    { timeout: 240_000 },
  );
  await dismissStartupNotices(page);

  const boot = await probeVolumes(page);
  expect(boot).toHaveLength(2);
  for (const v of boot) expect(v.initialized).toBe(true);

  // ── Milling produces visible removal ──────────────────────────────────
  // The MillingSequence (authored LogicSteps) drives the axes on its own;
  // MaterialRemainingPercent falls monotonically once the cutter touches
  // stock. 120 s covers approach moves from a cold start.
  await page.waitForFunction(
    () => {
      const v = (window as unknown as { viewer: any }).viewer;
      return [...v.machiningManager._entries.keys()]
        .some((vol: any) => vol.VoxelsModified > 0 && vol.MaterialRemainingPercent < 100);
    },
    undefined,
    { timeout: 120_000 },
  );
  const milled = await probeVolumes(page);
  expect(milled.some((v) => v.voxelsModified > 0)).toBe(true);
  expect(milled.some((v) => v.materialRemainingPercent < 100)).toBe(true);
  for (const v of milled) expect(v.chunkMeshCount).toBeGreaterThan(0);

  // ── Spindle off stops the cut ─────────────────────────────────────────
  // The demo GLB authors NO SignalSpindleOn (the sample's spindle is always
  // on — `readBool(…, default true)`), so the slot is INJECTED here: the
  // manager resolves the signal by path on every tick, which makes a
  // runtime-assigned path exercise exactly the shipped gating code.
  // Hold the signal false across the observation window (a LogicStep writing
  // SpindleOn between our samples would otherwise race the assertion) and
  // verify it actually STAYED false — if something overrode it, the guard
  // fails loudly instead of the assertion failing mysteriously.
  const spindleObservation = await page.evaluate(async () => {
    const viewer = (window as unknown as { viewer: any }).viewer;
    const volumes = [...viewer.machiningManager._entries.keys()];
    volumes.forEach((v: any, i: number) => {
      if (typeof v.SignalSpindleOn !== 'string' || v.SignalSpindleOn.length === 0) {
        v.SignalSpindleOn = `E2E/SpindleOn${i}`;
        viewer.signalStore.setByPath(v.SignalSpindleOn, true);
      }
    });
    const withSignal = volumes.filter((v: any) => typeof v.SignalSpindleOn === 'string' && v.SignalSpindleOn.length > 0);
    const targets = withSignal.length ? withSignal : volumes;
    const hold = () => {
      for (const v of targets) {
        if (v.SignalSpindleOn) viewer.signalStore.setByPath(v.SignalSpindleOn, false);
      }
    };
    hold();
    // Let in-flight worker jobs (dispatched while the spindle was still on)
    // drain before taking the baseline — their acks bump VoxelsModified.
    await new Promise((r) => setTimeout(r, 1_500));
    const baseline = targets.map((v: any) => v.VoxelsModified);
    let signalHeldFalse = true;
    const interval = setInterval(() => {
      hold();
      for (const v of targets) {
        if (v.SignalSpindleOn && viewer.signalStore.getBoolByPath(v.SignalSpindleOn)) {
          signalHeldFalse = false;
        }
      }
    }, 50);
    await new Promise((r) => setTimeout(r, 3_000));
    clearInterval(interval);
    const delta = targets.map((v: any, i: number) => v.VoxelsModified - baseline[i]);
    // Relax: back on. The sequence resumes on its own.
    for (const v of targets) {
      if (v.SignalSpindleOn) viewer.signalStore.setByPath(v.SignalSpindleOn, true);
    }
    return { signalHeldFalse, delta, hadSignal: withSignal.length };
  });
  expect(spindleObservation.hadSignal).toBeGreaterThan(0);
  expect(spindleObservation.signalHeldFalse).toBe(true);
  for (const d of spindleObservation.delta) expect(d).toBe(0);

  // ── Reset restores the stock ──────────────────────────────────────────
  // Rising edge on SignalReset → grid re-init behind the reset barrier; the
  // manager republishes MaterialRemainingPercent = 100 / VoxelsModified = 0.
  // The spindle stays OFF during the check — with the mill cutting, the
  // "both volumes at exactly 100 / 0" condition would race fresh removal.
  await page.evaluate(() => {
    const viewer = (window as unknown as { viewer: any }).viewer;
    for (const v of viewer.machiningManager._entries.keys()) {
      if (v.SignalSpindleOn) viewer.signalStore.setByPath(v.SignalSpindleOn, false);
      if (v.SignalReset) viewer.signalStore.setByPath(v.SignalReset, true);
    }
  });
  await page.waitForFunction(
    () => {
      const v = (window as unknown as { viewer: any }).viewer;
      return [...v.machiningManager._entries.keys()]
        .every((vol: any) => vol.VoxelsModified === 0 && vol.MaterialRemainingPercent === 100);
    },
    undefined,
    { timeout: 30_000 },
  );
  await page.evaluate(() => {
    const viewer = (window as unknown as { viewer: any }).viewer;
    for (const v of viewer.machiningManager._entries.keys()) {
      if (v.SignalReset) viewer.signalStore.setByPath(v.SignalReset, false);
      if (v.SignalSpindleOn) viewer.signalStore.setByPath(v.SignalSpindleOn, true);
    }
  });

  // ── Memory acceptance (< 100 MB for the 2-station demo) ───────────────
  // The live-variable part — chunk BufferGeometries — is measured from the
  // scene and counted TWICE (CPU TypedArray + GPU buffer copy). The
  // worker-side kernel part cannot be probed from the page (separate JS
  // realm); it is the Phase-1-measured constant: 36 MiB tessellate scratch
  // (shared by both stations in one worker) + the f32 SDF grids + ~4 MiB
  // module/heap overhead — see "Benchmark Results" in the plan.
  const memory = await page.evaluate(() => {
    const viewer = (window as unknown as { viewer: any }).viewer;
    let chunkBytes = 0;
    let gridBytes = 0;
    for (const volume of viewer.machiningManager._entries.keys()) {
      const root = volume.chunkRoot;
      if (root) {
        root.traverse((n: any) => {
          if (!n.isMesh || !n.geometry) return;
          for (const attr of Object.values(n.geometry.attributes) as any[]) {
            chunkBytes += attr.array?.byteLength ?? 0;
          }
          chunkBytes += n.geometry.index?.array?.byteLength ?? 0;
        });
      }
      const r = volume.gridResolution;
      gridBytes += r.x * r.y * r.z * 4;
    }
    const workerScratchBytes = 36 * 1024 * 1024;
    const workerOverheadBytes = 4 * 1024 * 1024;
    const total = chunkBytes * 2 + gridBytes + workerScratchBytes + workerOverheadBytes;
    return { chunkBytes, gridBytes, total };
  });
  const memoryLine = `machining-memory: total=${(memory.total / 1048576).toFixed(1)} MiB `
    + `(chunks CPU+GPU=${((memory.chunkBytes * 2) / 1048576).toFixed(1)}, `
    + `grids=${(memory.gridBytes / 1048576).toFixed(1)}, worker=40.0)`;
  test.info().annotations.push({ type: 'machining-memory', description: memoryLine });
  console.log(memoryLine);
  expect(memory.total).toBeLessThan(100 * 1024 * 1024);

  // ── Model switch under backlog (epoch guard) ──────────────────────────
  // Load another builtin while worker traffic is (ideally) still in flight.
  // The epoch guard must drop stale acks silently — no pageerror, and the
  // viewer ends up owning the new model. The pre-switch cut is BEST-EFFORT:
  // after the reset, the authored MillingSequence may spend minutes on
  // approach moves before touching stock again, and the switch assertions
  // (clean teardown, no straggler crash) hold either way — the strict
  // stale-ack ordering is unit-tested in rv-machining-worker.test.ts.
  let preSwitchBacklog = true;
  await page.waitForFunction(
    () => {
      const v = (window as unknown as { viewer: any }).viewer;
      return [...v.machiningManager._entries.keys()]
        .some((vol: any) => vol.VoxelsModified > 0 || vol.PendingChunkCount + vol.PendingJobCount > 0);
    },
    undefined,
    { timeout: 60_000 },
  ).catch(() => { preSwitchBacklog = false; });
  console.log(`model switch with fresh worker traffic: ${preSwitchBacklog}`);
  await page.evaluate(async () => {
    const viewer = (window as unknown as { viewer: any }).viewer;
    await viewer.loadModel('./DemoRealvirtualWeb.glb');
  });
  await page.waitForFunction(
    () => (window as unknown as { viewer: any }).viewer.machiningManager.size === 0,
    undefined,
    { timeout: 60_000 },
  );
  // Give straggler acks a moment to arrive against the dead epoch.
  await page.waitForTimeout(2_000);

  expect(pageErrors).toEqual([]);
});
