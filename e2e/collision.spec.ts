// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-394 §9.9 — end-to-end: the collision manager is wired into the running
 * viewer, reports as cards in the right-side messages panel (card form
 * replaced the modal, user decision 2026-08-07), keeps the highlight across a
 * workspace mode change and clears itself when the overlap ends.
 *
 * The roles are set through the manager API rather than by clicking the
 * inspector dropdown: the round-trip of the dropdown value itself is covered
 * exactly (and much faster) by the schema test `tests/rv-collision-extras.test.ts`.
 *
 * READINESS, the thing this spec got wrong once (measured on a cold dev
 * server): `viewer.collisionManager` is assigned in the RVViewer CONSTRUCTOR,
 * so waiting for it proves only that the viewer object exists — at that moment
 * `currentModel` was still false and the scene held 2 meshes. The model landed
 * ~12 s later, and the per-mesh `boundsTree`s another ~8 s after that, because
 * the BVH pass is fire-and-forget after load (`_startAsyncBvhBuild` →
 * `'raycast-ready'`, plan-240). Never gate on a timeout here — gate on the
 * precondition this test actually needs: a mesh that carries a real BVH.
 */

import { test, expect } from 'playwright/test';
import type { Page } from 'playwright/test';

/**
 * Dismiss the boot-time notices that render as full-screen overlays.
 *
 * Headless Chromium reports a software/integrated GPU, so the auto-quality seed
 * fires the "Performance mode enabled" modal — a `position: fixed; inset: 0`
 * backdrop that swallows every click aimed at the page. Best-effort and
 * non-fatal: on a machine where the notice does not appear this is a no-op.
 */
async function dismissStartupNotices(page: Page): Promise<void> {
  for (const testId of ['auto-quality-ok', 'welcome-start-demo']) {
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
  // The demo welcome/about overlay ("Accept & continue" on a fresh profile,
  // "Got it" afterwards) — its backdrop spans the viewport and swallows clicks
  // aimed at the messages panel.
  try {
    const welcomeDismiss = page.getByTestId('welcome-dismiss');
    if (await welcomeDismiss.isVisible({ timeout: 1_000 })) {
      await welcomeDismiss.click({ timeout: 5_000 });
      await welcomeDismiss.waitFor({ state: 'detached', timeout: 5_000 });
    }
  } catch {
    /* not shown — nothing to dismiss */
  }
}

/**
 * Poll until the model is loaded AND the async BVH pass produced a tree on a
 * PLAIN model mesh. The merged `__raycastBVH_*` helpers get their (indirect)
 * trees first — gating on "any boundsTree" once passed while the per-mesh
 * trees were still pending, and the sample search below (which rightly skips
 * pipeline helpers) came up empty.
 */
async function waitForBvhReadyModel(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const v = (window as unknown as { viewer?: Record<string, never> }).viewer as
        | { collisionManager?: unknown; currentModel?: unknown; scene?: { traverse(cb: (n: unknown) => void): void } }
        | undefined;
      if (!v?.collisionManager || !v.currentModel || !v.scene) return false;
      let found = false;
      v.scene.traverse((n: unknown) => {
        const m = n as {
          isMesh?: boolean;
          geometry?: { boundsTree?: unknown };
          userData?: { _rvRaycastBVH?: boolean; _highlightOverlay?: boolean };
        };
        if (!found && m.isMesh && m.geometry?.boundsTree
          && !m.userData?._rvRaycastBVH && !m.userData?._highlightOverlay) found = true;
      });
      return found;
    },
    undefined,
    { timeout: 180_000 },
  );
}

test('collision cards latch in the messages panel, survive a mode change and clear on ignore-type', async ({ page }) => {
  // A cold Vite dev server needs ~2 min just to serve the first frame.
  test.setTimeout(360_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 60_000 });
  await waitForBvhReadyModel(page);
  await dismissStartupNotices(page);

  // Build two overlapping bodies of different roles directly in the live scene.
  const built = await page.evaluate(() => {
    const viewer = (window as unknown as { viewer?: any }).viewer;
    if (!viewer) return { ok: false, why: 'no viewer' };

    // Clone an existing BVH-carrying mesh — that keeps us on the viewer's own
    // three instance and gives both test bodies a real boundsTree, so the
    // triangle narrowphase (not just the box test) is exercised. NOT a
    // pipeline helper (`_rvRaycastBVH` / `_highlightOverlay`): the clone would
    // inherit the marker and the manager rightly refuses such meshes.
    let sample: any = null;
    viewer.scene.traverse((n: any) => {
      if (!sample && n.isMesh && n.geometry?.boundsTree
        && !n.userData?._rvRaycastBVH && !n.userData?._highlightOverlay) sample = n;
    });
    if (!sample) return { ok: false, why: 'no plain mesh with boundsTree' };

    // The batched render pipeline leaves its SOURCE meshes in the scene with
    // `layers.mask = 0`. A clone would inherit that and F6 would correctly
    // treat it as invisible — empty body box, no collision. Normalise the
    // clones so they are effectively visible. `freezeStaticMatrices` turns OFF
    // `matrixAutoUpdate` on static model meshes, and a clone inherits that:
    // writing `.position` then does nothing at all, because
    // `updateMatrixWorld()` reuses the baked local matrix. Re-enable it or
    // these bodies can never be moved.
    const prepare = (m: any, name: string) => {
      m.name = name;
      m.visible = true;
      m.layers.set(0);
      m.traverse((c: any) => {
        c.visible = true;
        c.layers.set(0);
        c.matrixAutoUpdate = true;
        // Defensive: never let a cloned helper marker exclude the body.
        if (c.userData) {
          delete c.userData._rvRaycastBVH;
          delete c.userData._highlightOverlay;
        }
      });
      m.matrixAutoUpdate = true;
      m.position.set(0, 50, 0);   // identical transform => guaranteed overlap
      m.rotation.set(0, 0, 0);
      m.scale.set(1, 1, 1);
      m.updateMatrixWorld(true);
      return m;
    };

    const a = prepare(sample.clone(), 'RVTestBodyA');
    const b = prepare(sample.clone(), 'RVTestBodyB');
    viewer.scene.add(a, b);
    viewer.scene.updateMatrixWorld(true);

    // The demo model ships AUTHORED CollisionRoles since 2026-08-07 (robot,
    // gripper, CNC door, Workpiece MUs) and its cycle produces real contacts.
    // Drop those roles — and detach the MU spawn hook so freshly spawned
    // Workpiece MUs cannot re-register — so this spec asserts against ITS two
    // bodies only.
    if (viewer.transportManager) viewer.transportManager.muLifecycleHook = null;
    viewer.collisionManager.clear();
    viewer.collisionManager.register(a, 'Robot');
    viewer.collisionManager.register(b, 'Machine');
    return { ok: true, why: '' };
  });
  expect(built.why).toBe('');
  expect(built.ok).toBe(true);

  // One tick must be enough — the report happens in the same tick. The
  // persistent emphasis is the OutlinePass STATUS channel (the pulsing
  // error-message silhouette) — the only app style with a pulse period > 0,
  // so `hasPulsingOutlines` is a precise probe for it.
  const reported = await page.evaluate(() => {
    const viewer = (window as unknown as { viewer: any }).viewer;
    viewer.collisionManager.update(1 / 60);
    return {
      pairs: viewer.collisionManager.activePairs.length,
      pulsing: viewer.outlineManager?.hasPulsingOutlines ?? null,
    };
  });
  expect(reported.pairs).toBeGreaterThan(0);
  expect(reported.pulsing).toBe(true);

  // The card appears in the right-side messages panel — no modal, nothing to
  // acknowledge, the rest of the UI stays interactive.
  const panel = page.getByTestId('collision-alert-panel');
  await expect(panel).toBeVisible({ timeout: 10_000 });
  const cards = page.getByTestId('collision-card');
  expect(await cards.count()).toBeGreaterThan(0);
  await expect(page.locator('[role="dialog"][data-testid="collision-alert-dialog"]')).toHaveCount(0);

  // A workspace-mode change must not lose the emphasis (F15). The CARD may
  // legitimately vanish in a mode that does not render the messages slot —
  // that is the slot's visibility rule, the same one the WebError cards
  // follow — so the card assertion is: it is back after switching back.
  // NOTE: the ModeManager API is `setMode` — an earlier revision called
  // `modes?.activate?.()`, which does not exist, so optional chaining silently
  // skipped the whole step and F15 was never exercised.
  const switched = await page.evaluate(() => {
    const modes = (window as unknown as { viewer: any }).viewer.modes;
    if (!modes) return null;
    const from = modes.activeMode;
    const target = modes.list().map((d: any) => d.id).find((id: string) => id !== from);
    if (!target) return null;
    modes.setMode(target);
    return { from, to: modes.activeMode };
  });
  expect(switched).not.toBeNull();
  expect(switched!.to).not.toBe(switched!.from);

  const pulsingAfterMode = await page.evaluate(
    () => (window as unknown as { viewer: any }).viewer.outlineManager.hasPulsingOutlines);
  expect(pulsingAfterMode).toBe(true);

  await page.evaluate((mode) => {
    (window as unknown as { viewer: any }).viewer.modes.setMode(mode);
  }, switched!.from);
  await expect(panel).toBeVisible({ timeout: 10_000 });

  // LATCHING: separate the bodies — the pair (and its card) must STAY.
  //
  // The distance MUST be derived from the body's own size, not hard-coded: the
  // static-merge/freeze passes bake world transforms into the geometry, so a
  // cloned model mesh can have a local bounding box spanning the whole machine.
  // A fixed offset (5 000 units was tried) then leaves the two boxes happily
  // overlapping and the pair never separates.
  const separated = await page.evaluate(() => {
    const viewer = (window as unknown as { viewer: any }).viewer;
    const mgr = viewer.collisionManager;
    const b = viewer.scene.getObjectByName('RVTestBodyB');
    const bodyB = mgr.bodies.find((x: any) => x.root.name === 'RVTestBodyB');
    const span = bodyB.worldBox.max.y - bodyB.worldBox.min.y;
    b.matrixAutoUpdate = true;   // see `prepare()` — frozen static matrices
    b.position.y += span * 10 + 100;
    b.updateMatrixWorld(true);
    viewer.scene.updateMatrixWorld(true);

    mgr.update(1 / 60);
    return { pairs: mgr.activePairs.length };
  });
  expect(separated.pairs).toBeGreaterThan(0);
  await expect(panel).toBeVisible();

  // IGNORE TYPE: the card's Ignore button suppresses this role pair for the
  // run — card, outline and future re-detections are gone, even if the bodies
  // were still overlapping. Re-check the boot notices first: overlays can be
  // queued behind the startup coordinator and their backdrop would swallow
  // this click.
  await dismissStartupNotices(page);
  await page.getByTestId('collision-ignore-type').first().click();
  await expect(panel).toHaveCount(0, { timeout: 10_000 });

  const afterIgnore = await page.evaluate(() => {
    const viewer = (window as unknown as { viewer: any }).viewer;
    const mgr = viewer.collisionManager;
    // Bring the bodies back into overlap and tick — the ignored type must NOT
    // re-report.
    const b = viewer.scene.getObjectByName('RVTestBodyB');
    b.position.set(0, 50, 0);
    b.updateMatrixWorld(true);
    viewer.scene.updateMatrixWorld(true);
    mgr.update(1 / 60);
    return {
      pairs: mgr.activePairs.length,
      pulsing: viewer.outlineManager.hasPulsingOutlines,
    };
  });
  expect(afterIgnore.pairs).toBe(0);
  expect(afterIgnore.pulsing).toBe(false);
  await expect(panel).toHaveCount(0);
});
