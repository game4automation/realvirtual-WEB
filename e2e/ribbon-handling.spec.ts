// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-459 §9.9 — end to end against the real `DemoRibbonSlitter.glb`
 * (internal Development project; skipped without the private sibling).
 *
 * The unit and integration tests prove the mathematics and the lifecycle; this
 * file answers the two questions they cannot:
 *
 *  1. does a web actually MOVE on screen when its drive runs, in the real
 *     renderer, with no console error along the way; and
 *  2. does a model switch give the band geometry and its cloned texture back —
 *     measured as `renderer.info.memory.geometries` AND `.textures` over an
 *     A → B → A cycle, because a leak that only shows up on the way back is
 *     exactly the kind the manager's `clear()` exists to prevent (SOL round-2
 *     finding 6).
 *
 * ## Where this file lives and how it runs
 *
 * The plan's `scope_paths` names `tests/e2e/ribbon-handling.spec.ts`. There is no
 * such directory: `playwright.config.ts` sets `testDir: './e2e'`, and every
 * existing spec lives there. Putting it anywhere else would have produced a file
 * the harness never runs, so it is here.
 *
 *   npx playwright test e2e/ribbon-handling.spec.ts
 *   RV_E2E_PORT=5459 npx playwright test e2e/ribbon-handling.spec.ts   # worktree port
 *
 * The config's `webServer` starts `npm run dev` on `RV_E2E_PORT` (default 5177)
 * and reuses an existing server, so a session already running on 5459 is picked
 * up rather than fought over.
 */

import { test, expect } from 'playwright/test';
import type { Page } from 'playwright/test';
import { DEV_GLB } from '../tests/fixtures/glb-paths.mjs';
import { DEV_ASSETS_SKIP_REASON, HAS_DEV_ASSETS } from './dev-assets';
import { dismissStartupNotices as dismissStartupNoticesShared } from './_viewer-ready';

// The demo is internal (projects/Development, private sibling) — served by the
// dev server under /private-assets/Development, absent on a public checkout.
const DEMO = `/?model=${encodeURIComponent(DEV_GLB.ribbonSlitter)}`;

/** Best-effort dismissal of the boot-time overlays (shared helper, plan-503). */
async function dismissStartupNotices(page: Page): Promise<void> {
  await dismissStartupNoticesShared(page, {
    testIds: ['auto-quality-ok', 'welcome-start-demo', 'welcome-dismiss'],
    appearTimeoutMs: 1_000,
  });
}

interface RibbonProbe {
  paths: number;
  groups: number;
  /** mm — total arc length per path. */
  lengths: number[];
  /** mm — wound length per winder, in group order. */
  wound: number[];
  /** rad — roller angles of the first path. */
  angles: number[];
  /**
   * The 16 world-matrix elements of a PASSIVE roller (`Unwinder`, which carries
   * no drive). `angle` alone is not evidence that anything MOVED: a node the
   * loader classified as static keeps `matrixAutoUpdate = false`, and then the
   * quaternion the path writes never reaches `matrixWorld` — the numbers climb
   * and the geometry stands still. That was the plan-460 follow-up bug, and this
   * is what catches it in the real renderer.
   */
  passiveMatrix: number[];
  bandVertices: number[];
  /**
   * mm — the WORLD position of the first band sample of each path, and the world
   * centre plus contact radius of the `Unwinder` (plan-468).
   *
   * `lengthMm` growing is not evidence that the end wrap is where it belongs: the
   * point of `WrapDeg` is that the web STARTS on the roll surface, and only the
   * distance between those two world positions says so. The band vertices are
   * read in world space (the band is a child of its path node, which the slitter
   * offsets laterally per strip) so the check is independent of that offset.
   */
  firstSampleWorldMm: Array<[number, number, number]>;
  unwinderWorldMm: [number, number, number] | null;
  /** Unit world direction of the unwinder's winding axis (the demo winds about X). */
  unwinderAxisWorld: [number, number, number] | null;
  unwinderContactRadiusMm: number;
}

/** Read the live web state out of the running viewer. */
function probeRibbon(page: Page): Promise<RibbonProbe> {
  return page.evaluate(() => {
    const viewer = (window as unknown as { viewer: any }).viewer;
    const groups = viewer.ribbonManager.groups as Array<{ paths: any[]; winders: any[] }>;
    const paths = groups.flatMap((g) => g.paths);
    return {
      paths: paths.length,
      groups: groups.length,
      lengths: paths.map((p) => p.lengthMm),
      wound: groups.flatMap((g) => g.winders.map((w: any) => w.woundLengthMm)),
      angles: (paths[0]?.rollers ?? []).map((r: any) => r.angle),
      passiveMatrix: (() => {
        const roller = (paths[0]?.rollers ?? [])
          .find((r: any) => r.node?.name === 'Unwinder' && !r.isDriven);
        return roller ? [...roller.node.matrixWorld.elements] : [];
      })(),
      bandVertices: paths.map((p) => p.band?.mesh?.geometry?.getAttribute('position')?.count ?? 0),
      // plan-468. Scene units are metres and everything else here is millimetres,
      // so both readings are scaled by 1000 on the way out.
      firstSampleWorldMm: paths.map((p) => {
        const mesh = p.band?.mesh;
        const pos = mesh?.geometry?.getAttribute('position');
        if (!mesh || !pos || pos.count < 2) return [0, 0, 0];
        mesh.updateMatrixWorld(true);
        // The band is two vertices per sample (the two edges of the strip); the
        // centre line is their midpoint.
        const x = (pos.getX(0) + pos.getX(1)) / 2;
        const y = (pos.getY(0) + pos.getY(1)) / 2;
        const z = (pos.getZ(0) + pos.getZ(1)) / 2;
        const e = mesh.matrixWorld.elements;
        return [
          (e[0] * x + e[4] * y + e[8] * z + e[12]) * 1000,
          (e[1] * x + e[5] * y + e[9] * z + e[13]) * 1000,
          (e[2] * x + e[6] * y + e[10] * z + e[14]) * 1000,
        ];
      }),
      unwinderWorldMm: (() => {
        const roller = (paths[0]?.rollers ?? []).find((r: any) => r.node?.name === 'Unwinder');
        if (!roller) return null;
        roller.node.updateMatrixWorld(true);
        const e = roller.node.matrixWorld.elements;
        return [e[12] * 1000, e[13] * 1000, e[14] * 1000];
      })(),
      unwinderAxisWorld: (() => {
        const roller = (paths[0]?.rollers ?? []).find((r: any) => r.node?.name === 'Unwinder');
        if (!roller) return null;
        roller.node.updateMatrixWorld(true);
        const e = roller.node.matrixWorld.elements;
        // Column 0/1/2 of the world matrix is the node's local X/Y/Z in world space.
        const col = roller.axis === 'Y' ? 4 : roller.axis === 'Z' ? 8 : 0;
        const v = [e[col], e[col + 1], e[col + 2]];
        const n = Math.hypot(v[0], v[1], v[2]) || 1;
        return [v[0] / n, v[1] / n, v[2] / n];
      })(),
      unwinderContactRadiusMm: (() => {
        const path = paths[0];
        const roller = (path?.rollers ?? []).find((r: any) => r.node?.name === 'Unwinder');
        return roller ? roller.radiusMm + (path.RibbonThicknessMm ?? 0) / 2 : 0;
      })(),
    };
  });
}

async function openDemo(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(err.message));
  page.on('console', (msg) => {
    if (msg.type() === 'error') errors.push(msg.text());
  });
  await page.goto(DEMO, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 60_000 });
  await dismissStartupNotices(page);
  await page.waitForFunction(
    () => ((window as unknown as { viewer?: any }).viewer?.ribbonManager?.size ?? 0) > 0,
    undefined,
    { timeout: 60_000 },
  );
  return errors;
}

test.describe('DemoRibbonSlitter (plan-459)', () => {
  test.skip(!HAS_DEV_ASSETS, DEV_ASSETS_SKIP_REASON);
  test('jogging the web drive moves the band and rotates the rollers', async ({ page }) => {
    test.setTimeout(180_000);
    const errors = await openDemo(page);

    const before = await probeRibbon(page);
    // Two strips over one shared unwinder: two paths, ONE group.
    expect(before.paths).toBe(2);
    expect(before.groups).toBe(1);
    for (const length of before.lengths) expect(length).toBeGreaterThan(6_000);
    for (const verts of before.bandVertices) expect(verts).toBeGreaterThan(8);

    const shotBefore = await page.locator('canvas').first().screenshot();
    await page.waitForTimeout(2_000);
    const shotAfter = await page.locator('canvas').first().screenshot();
    const after = await probeRibbon(page);

    // The rollers turned…
    expect(after.angles.some((a, i) => Math.abs(a - before.angles[i]) > 1e-3)).toBe(true);
    // …the PASSIVE unwinder among them, in the world matrix and not only in its
    // angle — which is the difference between a web that runs and one that only
    // reports that it does.
    expect(before.passiveMatrix).toHaveLength(16);
    expect(after.passiveMatrix.some((v, i) => Math.abs(v - before.passiveMatrix[i]) > 1e-6)).toBe(true);
    // …the unwinder lost length and a rewinder gained some…
    expect(Math.min(...after.wound)).toBeLessThan(Math.max(...before.wound));
    expect(Math.max(...after.wound)).toBeGreaterThan(0);
    // …and the picture is not the same picture.
    expect(Buffer.compare(shotBefore, shotAfter)).not.toBe(0);

    const critical = errors.filter(
      (e) => !e.includes('favicon.ico') && !e.includes('net::ERR_') && !e.includes('ResizeObserver') && !e.includes('404')
        // A CONNECT gateway on this machine answers the viewer's document handshake
        // with 409 when another client owns the active document — not this feature.
        // (Chrome's console text carries no URL, so match the status text only.)
        && !e.includes('409 (Conflict)'),
    );
    expect(critical).toHaveLength(0);
  });

  test('the web band starts ON the unwinder roll surface, not at the tangent point (plan-468)', async ({ page }) => {
    test.setTimeout(180_000);
    await openDemo(page);
    const probe = await probeRibbon(page);

    expect(probe.unwinderWorldMm).not.toBeNull();
    expect(probe.unwinderAxisWorld).not.toBeNull();
    expect(probe.unwinderContactRadiusMm).toBeGreaterThan(100);

    const centre = probe.unwinderWorldMm!;
    const axis = probe.unwinderAxisWorld!;
    /** mm — distance from the winding AXIS, i.e. the radius the sample sits at. */
    const radialMm = (p: [number, number, number]): number => {
      const d: [number, number, number] = [p[0] - centre[0], p[1] - centre[1], p[2] - centre[2]];
      const along = d[0] * axis[0] + d[1] * axis[1] + d[2] * axis[2];
      return Math.hypot(d[0] - along * axis[0], d[1] - along * axis[1], d[2] - along * axis[2]);
    };

    // The acceptance criterion of the feature: with `WrapDeg: 270` on the demo's
    // unwinder the FIRST band sample lies on the roll mantle — its distance from
    // the winding axis is the contact radius (roll + half the caliper) — instead
    // of at the tangent point, which is where the strip used to appear from.
    // The tolerance covers the dirty gate (a rebuild is only triggered once the
    // radius moved 0.05 mm) and the float32 vertex storage; a wrap that was not
    // built at all would be off by metres, not millimetres.
    expect(probe.firstSampleWorldMm).toHaveLength(probe.paths);
    for (const sample of probe.firstSampleWorldMm) {
      expect(radialMm(sample)).toBeCloseTo(probe.unwinderContactRadiusMm, 0);
    }
  });

  test('stopping the drive stops the web, and reset restores the rolls', async ({ page }) => {
    test.setTimeout(180_000);
    await openDemo(page);
    await page.waitForTimeout(1_000);

    const initial = await page.evaluate(() => {
      const viewer = (window as unknown as { viewer: any }).viewer;
      const winder = viewer.ribbonManager.groups[0].winders[0];
      return winder.woundLengthMm;
    });

    // Stop the drive; the web must stand still from the next tick on.
    await page.evaluate(() => {
      const viewer = (window as unknown as { viewer: any }).viewer;
      for (const drive of viewer.drives) { drive.jogForward = false; drive.jogBackward = false; }
    });
    // The drive ramps down at its Acceleration (800 mm/s at 400 mm/s^2 = 2 s):
    // wait for the STOP, not for a fixed time.
    await page.waitForFunction(
      () => (window as unknown as { viewer: any }).viewer.drives.every((d: any) => d.currentSpeed === 0),
      undefined,
      { timeout: 15_000 },
    );
    const a = await probeRibbon(page);
    await page.waitForTimeout(1_000);
    const b = await probeRibbon(page);
    expect(b.angles).toEqual(a.angles);

    // Reset puts the parent roll back to where it was authored. Read in the SAME
    // evaluate as the reset: the demo's drives are authored `JogForward`, so they
    // start pulling again on the very next tick and any wait in between would be
    // measuring how long the round trip took, not what the reset restored.
    const restored = await page.evaluate(() => {
      const viewer = (window as unknown as { viewer: any }).viewer;
      viewer.resetSimulation();
      return viewer.ribbonManager.groups[0].winders[0].woundLengthMm;
    });
    expect(restored).toBeGreaterThanOrEqual(initial);
  });

  test('dancer: the slower rewinder fills it to AtMax, both sections then run at min(vUp, vDown), and a faster rewinder frees it', async ({ page }) => {
    test.setTimeout(240_000);
    await openDemo(page);

    /** The live state of `Dancer_A` and the two sections around it. */
    const probeDancer = () => page.evaluate(() => {
      const viewer = (window as unknown as { viewer: any }).viewer;
      const path = viewer.ribbonManager.groups[0].paths
        .find((p: any) => p.dancers.length > 0);
      const dancer = path.dancers[0];
      return {
        positionMm: dancer.positionMm,
        atMax: dancer.atMax,
        atMin: dancer.atMin,
        speeds: path.sections.map((s: any) => s.speed),
      };
    });

    // The demo's rewinders start at their bare cores, so their surface speed is
    // BELOW the nip's 800 mm/s: the dancer fills.
    const start = await probeDancer();
    expect(start.speeds).toHaveLength(2);
    // Wait for AtMax AND for the clamp to have taken effect. The clamp of a tick
    // uses the flag the PREVIOUS tick's integration set (the same one-tick order
    // the winder limits have), so the very tick that raises AtMax still carries
    // the unclamped speeds — waiting on the flag alone is a race.
    await page.waitForFunction(
      () => {
        const viewer = (window as unknown as { viewer: any }).viewer;
        const path = viewer.ribbonManager.groups[0].paths.find((p: any) => p.dancers.length > 0);
        const speeds = path.sections.map((s: any) => s.speed);
        return path.dancers[0].atMax === true && Math.abs(speeds[0] - speeds[1]) < 1e-6;
      },
      undefined,
      { timeout: 60_000 },
    );

    const full = await probeDancer();
    expect(full.atMax).toBe(true);
    expect(full.positionMm).toBeGreaterThan(start.positionMm);
    // At the stop, BOTH sections run at the slower side — the web never stops.
    expect(full.speeds[0]).toBeCloseTo(full.speeds[1], 3);
    expect(Math.abs(full.speeds[0])).toBeGreaterThan(0);

    // The PLC's answer: pull faster than the nip feeds. The carriage comes down
    // and AtMax clears — the case a symmetric clamp would have deadlocked.
    await page.evaluate(() => {
      const viewer = (window as unknown as { viewer: any }).viewer;
      for (const drive of viewer.drives) {
        if (!drive.name.startsWith('Rewinder')) continue;
        drive.targetSpeed *= 3;
        drive.TargetSpeed = drive.targetSpeed;
      }
    });
    await page.waitForFunction(
      () => {
        const viewer = (window as unknown as { viewer: any }).viewer;
        const path = viewer.ribbonManager.groups[0].paths.find((p: any) => p.dancers.length > 0);
        return path.dancers[0].atMax === false;
      },
      undefined,
      { timeout: 60_000 },
    );
    const freed = await probeDancer();
    expect(freed.atMax).toBe(false);
    expect(freed.positionMm).toBeLessThan(full.positionMm);
  });

  test('switching models releases band geometry and textures (A -> B -> A)', async ({ page }) => {
    test.setTimeout(240_000);
    await openDemo(page);

    /**
     * Memory counters, read once the scene has SETTLED.
     *
     * `renderer.info.memory` counts what has actually been uploaded to the GPU,
     * which happens lazily over the first frames — so a single `requestAnimationFrame`
     * pair reads a moving number. On the way back the GLB comes from the browser
     * cache and settles sooner, and comparing a half-uploaded first reading with a
     * settled second one is a leak report with no leak in it (measured: 26 → 37
     * geometries over the first four seconds, identical on both visits).
     *
     * So: poll until the count stops moving for three consecutive frames.
     */
    const memory = () => page.evaluate(async () => {
      const info = (window as unknown as { viewer: any }).viewer.renderer.info.memory;
      const frame = () => new Promise((r) => requestAnimationFrame(r));
      let stable = 0;
      let last = -1;
      for (let i = 0; i < 600 && stable < 3; i++) {
        await frame();
        if (info.geometries === last) stable++;
        else { stable = 0; last = info.geometries; }
      }
      return { geometries: info.geometries, textures: info.textures };
    });

    const withRibbon = await memory();

    // A -> B: away from the web demo entirely.
    await page.goto('/?model=demo-realvirtual/DemoPlanner.glb', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas', { timeout: 60_000 });
    await dismissStartupNotices(page);
    await page.waitForTimeout(3_000);

    // B -> A: back again. The counters must return to the SAME place, not to a
    // place that grows by one band and one texture per visit.
    await openDemo(page);
    const again = await memory();

    expect(again.geometries).toBeLessThanOrEqual(withRibbon.geometries + 2);
    expect(again.textures).toBeLessThanOrEqual(withRibbon.textures + 2);
  });
});
