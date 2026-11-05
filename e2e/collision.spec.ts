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
 * READINESS: since plan-781 F21 collision is the on-demand feature `collision`
 * — `viewer.collisionManager` is null until a model with a role loads it or a
 * caller ensures it, so the gate ensures the feature (the `collision.watch`
 * trigger) once the model is loaded. Collision needs no BVH any more — its
 * bodies read the pick structure the bake builds before the scene is shown —
 * so the rest of the gate is "the model is loaded and baked" (a chunk mesh is
 * in the scene), never a timeout.
 *
 * plan-781 semantics: touching is not a collision (two coincident clones are
 * coplanar = touching), and a pair overlapping at its first evaluation is a
 * quiet start baseline — so the test bodies are armed apart for one tick and
 * then pushed INTO each other. A second case drives a probe into a STATIC role
 * node of the baked demo model: the verified bug of plan-781 (a static role had
 * no mesh after the bake and never collided).
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
  // The startup coordinator QUEUES its notices: the demo welcome/about overlay
  // ("Accept & continue" on a fresh profile, "Got it" afterwards) comes first,
  // and the auto-quality notice only opens once it is closed. A single pass in a
  // fixed order therefore left the auto-quality backdrop over the page and the
  // Ignore click below timed out — so loop until a round finds nothing.
  // `welcome-dismiss` only: "Start Demo" would start the kiosk tour, which
  // drives the scene the test is asserting on.
  // `isVisible()` does not wait, so the next queued notice is awaited explicitly.
  const notice = page.locator('[data-testid="welcome-dismiss"], [data-testid="auto-quality-ok"]').first();
  for (let round = 0; round < 4; round++) {
    try {
      await notice.waitFor({ state: 'visible', timeout: 2_000 });
    } catch {
      return;                                   // nothing (more) queued on this machine
    }
    try {
      const btn = notice;
      const id = await btn.getAttribute('data-testid');
      await btn.click({ timeout: 5_000 });
      if (id) await page.getByTestId(id).waitFor({ state: 'detached', timeout: 5_000 });
    } catch {
      /* closed by itself in between — look again */
    }
  }
}

/** Poll until the model is loaded and baked (a chunk mesh is in the scene). */
async function waitForBakedModel(page: Page): Promise<void> {
  await page.waitForFunction(
    () => {
      const v = (window as unknown as { viewer?: Record<string, never> }).viewer as
        | { currentModel?: unknown; scene?: { traverse(cb: (n: unknown) => void): void } }
        | undefined;
      if (!v?.currentModel || !v.scene) return false;
      let found = false;
      v.scene.traverse((n: unknown) => {
        const m = n as { isMesh?: boolean; userData?: { _rvBakeChunk?: boolean } };
        if (!found && m.isMesh && m.userData?._rvBakeChunk === true) found = true;
      });
      return found;
    },
    undefined,
    { timeout: 180_000 },
  );
  // plan-781 F21: the manager exists once the on-demand feature is active.
  await page.evaluate(async () => {
    const v = (window as unknown as { viewer: { features: { ensure(id: string, t: string): Promise<void> } } }).viewer;
    await v.features.ensure('collision', 'command:collision.watch');
  });
}

/**
 * Test cubes made with the viewer's OWN three classes (taken from a model mesh,
 * so no second three instance) — plain meshes in the scene, i.e. keep parts of
 * their bodies. Installed as `window.__rvMakeCube(name, size)`, plus
 * `window.__rvBox3()` for an empty Box3 of the same instance.
 */
async function installCubeFactory(page: Page): Promise<void> {
  await page.evaluate(() => {
    const viewer = (window as unknown as { viewer?: any }).viewer;
    // The sample's geometry class is instantiated below, so it MUST be a plain
    // BufferGeometry: the first mesh in the demo scene is a PlaneGeometry, whose
    // constructor builds its own 6-entry index — the "cube" then drew (and
    // collided as) one quad at z = -h, and the pair never overlapped. The index
    // is also dropped defensively, so a subclass can never shape the cube.
    let sample: any = null;
    let fallback: any = null;
    viewer.scene.traverse((n: any) => {
      if (!n.isMesh || !n.geometry?.getAttribute?.('position')) return;
      if (!fallback) fallback = n;
      if (!sample && n.geometry.type === 'BufferGeometry') sample = n;
    });
    sample = sample ?? fallback;
    const Geometry = sample.geometry.constructor;
    const Attribute = sample.geometry.getAttribute('position').constructor;
    const Mesh = sample.constructor;
    if (!sample.geometry.boundingBox) sample.geometry.computeBoundingBox();
    const Box3 = sample.geometry.boundingBox.constructor;
    (window as any).__rvBox3 = () => new Box3();
    (window as any).__rvMakeCube = (name: string, size: number) => {
      const h = size / 2;
      const c = [[-h, -h, -h], [h, -h, -h], [h, h, -h], [-h, h, -h], [-h, -h, h], [h, -h, h], [h, h, h], [-h, h, h]];
      const faces = [[0, 2, 1], [0, 3, 2], [4, 5, 6], [4, 6, 7], [0, 1, 5], [0, 5, 4], [3, 6, 2], [3, 7, 6], [0, 4, 7], [0, 7, 3], [1, 2, 6], [1, 6, 5]];
      const pos = new Float32Array(36 * 3);
      faces.forEach((f, i) => f.forEach((v, k) => pos.set(c[v], (i * 3 + k) * 3)));
      const geo = new Geometry();
      geo.setIndex(null);
      for (const attrName of Object.keys(geo.attributes)) geo.deleteAttribute(attrName);
      geo.clearGroups();
      geo.setDrawRange(0, Infinity);
      geo.setAttribute('position', new Attribute(pos, 3));
      if (geo.index !== null || geo.getAttribute('position').count !== 36) {
        throw new Error('test cube is not 12 non-indexed triangles');
      }
      const m = new Mesh(geo, sample.material);
      m.name = name;
      m.matrixAutoUpdate = true;
      return m;
    };
  });
}

test('collision cards latch in the messages panel, survive a mode change and clear on ignore-type', async ({ page }) => {
  // A cold Vite dev server needs ~2 min just to serve the first frame.
  test.setTimeout(360_000);

  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 60_000 });
  await waitForBakedModel(page);
  await dismissStartupNotices(page);
  await installCubeFactory(page);

  // Build two bodies of different roles directly in the live scene.
  const built = await page.evaluate(() => {
    const viewer = (window as unknown as { viewer?: any }).viewer;
    if (!viewer) return { ok: false, why: 'no viewer' };

    const make = (window as any).__rvMakeCube;
    const a = make('RVTestBodyA', 1);
    const b = make('RVTestBodyB', 1);
    a.position.set(0, 50, 0);
    b.position.set(10, 50, 0);                  // apart: the pair is armed first
    viewer.scene.add(a, b);

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
    viewer.collisionManager.update(1 / 60);     // armed apart
    const b = viewer.scene.getObjectByName('RVTestBodyB');
    b.position.set(0.4, 50.2, 0.1);             // a real penetration (not a coplanar touch)
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
    b.position.y += 10;
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
    b.position.set(0.4, 50.2, 0.1);
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

test('a STATIC role node of the baked model collides (plan-781 verified bug)', async ({ page }) => {
  test.setTimeout(360_000);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 60_000 });
  await waitForBakedModel(page);
  await dismissStartupNotices(page);
  await installCubeFactory(page);

  const result = await page.evaluate(() => {
    const viewer = (window as unknown as { viewer?: any }).viewer;
    const reg = viewer.bakeRegistry;
    const newBox = (window as any).__rvBox3;
    // A node with chunk geometry but NO mesh under it: merged by the bake.
    let target: any = null;
    let bounds: any = null;
    viewer.scene.traverse((n: any) => {
      if (target || n.isMesh || n.userData?._rvBakeChunk || reg.instanceOf(n)) return;
      let hasMesh = false;
      n.traverse((c: any) => { if (c !== n && c.isMesh) hasMesh = true; });
      if (hasMesh) return;
      const box = newBox();
      if (!reg.chunkBoundsOf(n, box)) return;
      const sx = box.max.x - box.min.x, sy = box.max.y - box.min.y, sz = box.max.z - box.min.z;
      if (!(sx > 0.05 && sy > 0.05 && sz > 0.05 && sx < 20 && sy < 20 && sz < 20)) return;
      target = n;
      bounds = box;
    });
    if (!target) return { ok: false, why: 'no static merged node with chunk geometry', parts: 0, hit: false };
    const probe = (window as any).__rvMakeCube('RVTestProbe', 0.07);
    const cx = (bounds.min.x + bounds.max.x) / 2;
    const cz = (bounds.min.z + bounds.max.z) / 2;
    probe.position.set(cx, bounds.max.y + 5, cz);     // far above: armed apart
    viewer.scene.add(probe);
    if (viewer.transportManager) viewer.transportManager.muLifecycleHook = null;
    const mgr = viewer.collisionManager;
    mgr.clear();
    mgr.register(target, 'Environment');
    mgr.register(probe, 'Robot');
    mgr.update(1 / 60);
    const body = mgr.bodies.find((x: any) => x.root === target);
    const parts = body?.parts.length ?? 0;
    // Sweep the probe down through the node's geometry until it collides.
    let hit = false;
    for (let y = bounds.max.y + 0.05; y > bounds.min.y - 0.05 && !hit; y -= 0.01) {
      probe.position.y = y;
      mgr.update(1 / 60);
      hit = mgr.activePairs.length > 0;
    }
    return { ok: true, why: '', parts, hit, name: target.name };
  });
  expect(result.why).toBe('');
  expect(result.parts).toBeGreaterThan(0);
  expect(result.hit).toBe(true);
});
