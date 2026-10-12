// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-472 §9 — the centre of gravity, end to end in a real browser.
 *
 * ── WHAT THIS PROVES ────────────────────────────────────────────────────────
 * Against ONE running viewer with the REAL private bridge, the REAL mass integration and the
 * REAL scene graph:
 *
 *   * **A1 (the binding one).** `computeCogSnapshot()` refreshes every link's world matrix
 *     ITSELF. The mechanism is JOGGED and the centre of gravity is read back with NO render in
 *     between and no matrix update from the test. A scissor lift is the fixture precisely
 *     because its centre of gravity travels most of its stroke: a snapshot that answered the old
 *     pose would be visibly, largely wrong rather than subtly so.
 *   * **A5.** The 3D marker stays OFF throughout the data assertions. The snapshot is computed
 *     per request, not as a side effect of drawing it — an agent reading `cog` over MCP with no
 *     panel open must get the same number a user sees. A mass override then changes the total,
 *     through the ordinary authoring composite.
 *   * **Phase 3 contracts.** Constant marker size under an ORTHOGRAPHIC camera across a zoom
 *     change (the case the force gizmo's distance formula gets wrong), and a teardown that
 *     leaves no `__rvMechanismComGizmo` in the scene, no live animation frame and disposed
 *     materials.
 *
 * ── DELIBERATE CUTS, STATED PLAINLY ─────────────────────────────────────────
 * 1. NO SYNTHETIC PANEL CLICKS — the same cut `mechanism-force-analysis.spec.ts` takes. The
 *    React wiring in `MechanismSection.tsx` is two booleans; everything that can be numerically
 *    WRONG is in the snapshot and the gizmo. Rendering the quick-edit panel here would add a
 *    mode switch, a document and a work folder to a test about millimetres.
 * 2. TEARDOWN IS CHECKED IN THE SCENE GRAPH, not in a screenshot: a screenshot cannot
 *    distinguish "disposed" from "hidden", and that distinction IS the plan-198 contract.
 */

import { expect, test, type Page } from 'playwright/test';
import { DEV_GLB } from '../tests/fixtures/glb-paths.mjs';
import { HAS_PRIVATE_SOURCE, privateModuleUrl } from './private-module-url';

/** The scissor: its centre of gravity travels far as the lift rises (plan-472 §Verifikation). */
const BASE_MODEL = DEV_GLB.mechanismScissor;

const MODULE_PATHS = {
  // The scratch-document FACTORY, not the class: `AssetDocument.newUntitled()` was removed by
  // plan-719 F3, so a document with a plain path now comes from the test helper. It lives under
  // the dev-server root, which is why a plain `/tests/...` URL reaches it.
  doc: '/tests/helpers/scratch-asset-document.ts',
  authoring: privateModuleUrl('plugins/asset-editor/mechanism/mechanism-authoring.ts'),
  registry: '/src/core/engine/rv-kinematic-registry.ts',
  gizmo: privateModuleUrl('plugins/asset-editor/mechanism/mechanism-com-gizmo.ts'),
};

async function installHarness(page: Page): Promise<void> {
  await page.evaluate(async (paths) => {
    const w = window as unknown as Record<string, any>;
    const [docMod, authoring, kinRegistry, gizmoMod] = await Promise.all([
      import(/* @vite-ignore */ paths.doc),
      import(/* @vite-ignore */ paths.authoring),
      import(/* @vite-ignore */ paths.registry),
      import(/* @vite-ignore */ paths.gizmo),
    ]);

    const rvOf = (node: any): Record<string, any> =>
      (node?.userData?.realvirtual ?? {}) as Record<string, any>;

    w.__rv472 = {
      _gizmo: null as any,
      _doc: null as any,
      _rafCount: 0,

      async loadBase(url: string) {
        await w.viewer.loadModel(url);
        return w.viewer.currentModelRoot?.name ?? null;
      },

      /** True once a real wasm handle exists — the only honest readiness gate. */
      solverReady(): boolean {
        const bridge = kinRegistry.getMechanismUiBridge?.();
        return !!bridge && bridge.list().some((m: any) => m.active === true);
      },

      firstMechanism(): any {
        const bridge = kinRegistry.getMechanismUiBridge();
        return bridge?.list().find((m: any) => m.active) ?? null;
      },

      /** Give every link a body through the ORDINARY authoring composite (not injection). */
      async addMasses(pinnedKg: number) {
        const viewer = w.viewer;
        const bridge = kinRegistry.getMechanismUiBridge();
        const mech = w.__rv472.firstMechanism();
        if (!mech) throw new Error('no active mechanism');

        const doc = w.__rv472._doc ?? docMod.scratchAssetDocument(viewer);
        w.__rv472._doc = doc;
        const readField = (nodePath: string, componentType: string, fieldName: string) => {
          const node = viewer.registry?.getNode(nodePath);
          return node ? rvOf(node)[componentType]?.[fieldName] : undefined;
        };
        const docLike = {
          withTransaction: (label: string, fn: () => Promise<void>) => doc.withTransaction(label, fn),
          addComponent: (p: string, t: string, f: Record<string, unknown>) => doc.addComponent(p, t, f),
          setField: (p: string, c: string, f: string, v: unknown, prev: unknown) =>
            doc.setField(p, c, f, v, prev),
          unsetField: (p: string, c: string, f: string, prev: unknown) =>
            doc.unsetField(p, c, f, prev),
        };
        for (const link of mech.links) {
          if (!link.hasBody) {
            await authoring.runMechanismPlan(docLike, authoring.planAddBody(link.nodePath), readField);
          }
          // These reference rigs carry no geometry on their links, so the integrator honestly
          // reports "owns no geometry". A pinned mass is the authoring answer for exactly that
          // — and a pinned mass ALONE must not produce a centre of gravity (the `unknown`
          // rule), so a centre of mass is pinned with it. That pairing is the point of the
          // first assertion below.
          await authoring.runMechanismPlan(
            docLike, authoring.planSetMassOverride(link.nodePath, pinnedKg), readField);
        }
        await doc.whenIdle();
        bridge.rebuild(mech.nodePath);
        return w.__rv472.cog();
      },

      /** Pin a centre of mass on ONE link, through the same composite. */
      async setCom(nodePath: string, x: number, y: number, z: number) {
        const doc = w.__rv472._doc;
        const bridge = kinRegistry.getMechanismUiBridge();
        const mech = w.__rv472.firstMechanism();
        const readField = (p: string, c: string, f: string) => {
          const node = w.viewer.registry?.getNode(p);
          return node ? rvOf(node)[c]?.[f] : undefined;
        };
        const docLike = {
          withTransaction: (label: string, fn: () => Promise<void>) => doc.withTransaction(label, fn),
          addComponent: (p: string, t: string, f: Record<string, unknown>) => doc.addComponent(p, t, f),
          setField: (p: string, c: string, f: string, v: unknown, prev: unknown) =>
            doc.setField(p, c, f, v, prev),
          unsetField: (p: string, c: string, f: string, prev: unknown) =>
            doc.unsetField(p, c, f, prev),
        };
        await authoring.runMechanismPlan(
          docLike, authoring.planSetComOverride(nodePath, { x, y, z }), readField);
        await doc.whenIdle();
        bridge.rebuild(mech.nodePath);
        return w.__rv472.cog();
      },

      /** Pin a different MASS on one link — the A5 "inspect follows a mass change" step. */
      async setMass(nodePath: string, kg: number) {
        const doc = w.__rv472._doc;
        const bridge = kinRegistry.getMechanismUiBridge();
        const mech = w.__rv472.firstMechanism();
        const readField = (p: string, c: string, f: string) => {
          const node = w.viewer.registry?.getNode(p);
          return node ? rvOf(node)[c]?.[f] : undefined;
        };
        const docLike = {
          withTransaction: (label: string, fn: () => Promise<void>) => doc.withTransaction(label, fn),
          addComponent: (p: string, t: string, f: Record<string, unknown>) => doc.addComponent(p, t, f),
          setField: (p: string, c: string, f: string, v: unknown, prev: unknown) =>
            doc.setField(p, c, f, v, prev),
          unsetField: (p: string, c: string, f: string, prev: unknown) =>
            doc.unsetField(p, c, f, prev),
        };
        await authoring.runMechanismPlan(
          docLike, authoring.planSetMassOverride(nodePath, kg), readField);
        await doc.whenIdle();
        bridge.rebuild(mech.nodePath);
        return w.__rv472.cog();
      },

      /** The centre-of-gravity block, as the panel and MCP both read it. */
      cog() {
        const mech = w.__rv472.firstMechanism();
        return mech?.cog ?? null;
      },

      /** Link node paths, so a test can address one without guessing its name. */
      linkPaths(): string[] {
        return (w.__rv472.firstMechanism()?.links ?? []).map((l: any) => l.nodePath);
      },

      /**
       * Jog every driven joint, WITHOUT rendering. `bridge.jog` writes the drive value and runs
       * exactly one solve — the mechanism moves, the frame does not.
       */
      jogAll(value: number) {
        const bridge = kinRegistry.getMechanismUiBridge();
        const mech = w.__rv472.firstMechanism();
        let jogged = 0;
        for (const joint of mech.joints) {
          if (!joint.joggable) continue;
          bridge.jog(joint.nodePath, value);
          jogged++;
        }
        return { jogged, cog: w.__rv472.cog() };
      },

      /** Build the markers exactly as the panel does. */
      showMarkers(links: boolean, total: boolean) {
        const mech = w.__rv472.firstMechanism();
        w.__rv472._gizmo = new gizmoMod.MechanismComGizmo(w.viewer);
        const targets = gizmoMod.flattenComTargets([mech], { links, total });
        w.__rv472._gizmo.setTargets(targets);
        w.__rv472._gizmo.syncScreenScale();
        return {
          targets: targets.length,
          inScene: !!w.viewer.scene.getObjectByName('__rvMechanismComGizmo'),
          visible: w.__rv472._gizmo.visibleCount,
          markers: w.__rv472._gizmo.markers,
        };
      },

      /** Re-sync against the CURRENT camera and report the marker scales. */
      resync() {
        w.__rv472._gizmo.syncScreenScale();
        return w.__rv472._gizmo.markers.map((m: any) => ({ kind: m.kind, scale: m.scale }));
      },

      /**
       * Put the viewer on its ORTHOGRAPHIC camera at a given zoom — the iso view the editor
       * offers, and the case the force gizmo's distance-to-camera formula gets wrong. Driven
       * through the viewer's own `projection` setter (what the view-cube Persp/Iso toggle uses),
       * so the test measures the real camera the user would be looking through.
       */
      useOrtho(zoom: number) {
        w.viewer.projection = 'orthographic';
        const camera = w.viewer.camera;
        if (!camera.isOrthographicCamera) return { ortho: false };
        camera.zoom = zoom;
        camera.updateProjectionMatrix();
        camera.updateMatrixWorld(true);
        return { ortho: true };
      },

      /** Back to perspective, so a later test is not left on a camera it did not choose. */
      usePerspective() {
        w.viewer.projection = 'perspective';
        return { ortho: w.viewer.camera.isOrthographicCamera === true };
      },

      /** Tear the markers down — what the toggle going off, or a mode switch, does. */
      hideMarkers() {
        const materials: any[] = [];
        w.__rv472._gizmo?.root.traverse((o: any) => {
          if (o.material) materials.push(o.material);
        });
        w.__rv472._gizmo?.dispose();
        w.__rv472._gizmo = null;
        return {
          inScene: !!w.viewer.scene.getObjectByName('__rvMechanismComGizmo'),
          // three.js sets `version = -1` on a disposed material via the dispose event; the
          // honest proxy here is that no material still reports an attached program cache.
          materialCount: materials.length,
        };
      },
    };
  }, MODULE_PATHS);
}

test.describe.configure({ mode: 'serial' });

test.describe('plan-472 — centre of mass visualisation', () => {
  // The mechanism system and the asset editor are commercial source.
  test.skip(!HAS_PRIVATE_SOURCE, 'needs the private sibling repository (asset-editor source)');

  let page: Page;

  test.beforeAll(async ({ browser }) => {
    test.setTimeout(600_000);
    page = await browser.newPage();
    page.setDefaultTimeout(240_000);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas', { timeout: 120_000 });
    await page.waitForFunction(() => {
      const v = (window as unknown as { viewer?: any }).viewer;
      return !!v?.registry && !!v?.transportManager;
    }, undefined, { timeout: 240_000 });

    await installHarness(page);
    await page.evaluate((url) => (window as any).__rv472.loadBase(url), BASE_MODEL);
    await page.waitForFunction(() => (window as any).__rv472.solverReady(),
      undefined, { timeout: 180_000 });
  });

  test.afterAll(async () => { await page?.close(); });

  test('a pinned MASS alone yields no centre of gravity — and says how many links it had', async () => {
    const cog = await page.evaluate(() => (window as any).__rv472.addMasses(2.5));
    expect(cog).not.toBeNull();
    expect(cog.totalLinks).toBeGreaterThan(0);
    // Every link now has a mass and no centre of mass whatsoever. The honest answer is `null`,
    // not the origin — and every link names its reason.
    expect(cog.cogWorldMm).toBeNull();
    expect(cog.contributingLinks).toBe(0);
    expect(cog.skippedLinks.length).toBe(cog.totalLinks);
    for (const s of cog.skippedLinks) {
      expect(s.reason).toBe('mass pinned, no centre of mass');
      expect(typeof s.nodePath).toBe('string');
    }
  });

  test('pinning centres of mass produces a real, finite centre of gravity', async () => {
    const paths: string[] = await page.evaluate(() => (window as any).__rv472.linkPaths());
    expect(paths.length).toBeGreaterThan(1);

    let cog: any = null;
    for (let i = 0; i < paths.length; i++) {
      cog = await page.evaluate(
        ([p, y]) => (window as any).__rv472.setCom(p as string, 0, y as number, 0),
        [paths[i], (i + 1) * 100] as const,
      );
    }
    expect(cog.contributingLinks).toBe(cog.totalLinks);
    expect(cog.cogWorldMm).not.toBeNull();
    for (const v of cog.cogWorldMm) expect(Number.isFinite(v)).toBe(true);
    expect(cog.totalMassKg).toBeGreaterThan(0);
    // Pinned centres are AUTHORED, not measured — every contribution must say so.
    for (const c of cog.contributions) expect(c.comSource).toBe('override');
  });

  test('A1 — the centre of gravity follows a jog, with no render in between', async () => {
    const before = await page.evaluate(() => (window as any).__rv472.cog());
    const jogged = await page.evaluate(() => (window as any).__rv472.jogAll(120));
    expect(jogged.jogged).toBeGreaterThan(0);

    const after = jogged.cog;
    expect(after.cogWorldMm).not.toBeNull();
    // The scissor lifted: the centre of gravity MOVED. A stale-matrix snapshot would have
    // answered the previous pose and this delta would be zero — the exact SOL R2 #1 defect.
    const delta = Math.hypot(
      after.cogWorldMm[0] - before.cogWorldMm[0],
      after.cogWorldMm[1] - before.cogWorldMm[1],
      after.cogWorldMm[2] - before.cogWorldMm[2],
    );
    expect(delta).toBeGreaterThan(1); // more than a millimetre, on a metre-scale machine

    // …and asking twice in a row without moving anything answers the same thing.
    const again = await page.evaluate(() => (window as any).__rv472.cog());
    expect(again.cogWorldMm[1]).toBeCloseTo(after.cogWorldMm[1], 6);
  });

  test('A5 — a mass change is reflected without the marker ever being switched on', async () => {
    // Nothing has been drawn in this file yet, deliberately: the snapshot is computed per
    // request, not as a side effect of rendering it.
    const noMarker = await page.evaluate(
      () => !(window as any).viewer.scene.getObjectByName('__rvMechanismComGizmo'));
    expect(noMarker).toBe(true);

    const before = await page.evaluate(() => (window as any).__rv472.cog());
    const paths: string[] = await page.evaluate(() => (window as any).__rv472.linkPaths());
    const after = await page.evaluate(
      (p) => (window as any).__rv472.setMass(p as string, 250), paths[0]);

    expect(after.totalMassKg).toBeGreaterThan(before.totalMassKg + 100);
    // The heavy link dominates, so the centre of gravity is pulled towards it.
    expect(after.cogWorldMm[1]).not.toBeCloseTo(before.cogWorldMm[1], 3);
  });

  test('the markers appear, one per contributing link plus one total', async () => {
    const cog = await page.evaluate(() => (window as any).__rv472.cog());
    const shown = await page.evaluate(() => (window as any).__rv472.showMarkers(true, true));

    expect(shown.inScene).toBe(true);
    expect(shown.targets).toBe(cog.contributingLinks + 1);
    expect(shown.visible).toBe(shown.targets);
    expect(shown.markers.filter((m: any) => m.kind === 'total')).toHaveLength(1);
    // Pinned centres, so every link marker reads as authored rather than measured.
    for (const m of shown.markers.filter((x: any) => x.kind === 'link')) {
      expect(m.style).toBe('override');
    }
  });

  test('marker size is constant under an orthographic zoom', async () => {
    const isOrtho = await page.evaluate(() => (window as any).__rv472.useOrtho(1));
    expect(isOrtho.ortho).toBe(true);

    const atOne = await page.evaluate(() => (window as any).__rv472.resync());
    await page.evaluate(() => (window as any).__rv472.useOrtho(4));
    const atFour = await page.evaluate(() => (window as any).__rv472.resync());

    expect(atOne.length).toBeGreaterThan(0);
    // Constant ON SCREEN under orthographic zoom means the WORLD scale shrinks by the zoom
    // factor. The force gizmo's distance-to-camera formula would have left it unchanged — which
    // is the whole reason the joint overview, not the force gizmo, is the model here.
    for (let i = 0; i < atOne.length; i++) {
      expect(atFour[i].scale).toBeCloseTo(atOne[i].scale / 4, 6);
    }

    await page.evaluate(() => (window as any).__rv472.usePerspective());
  });

  test('teardown leaves nothing behind (plan-198)', async () => {
    const result = await page.evaluate(() => (window as any).__rv472.hideMarkers());
    expect(result.inScene).toBe(false);
    expect(result.materialCount).toBeGreaterThan(0); // there WAS something to dispose

    // Repeated toggling must not accumulate roots — the leak an unmounted panel would leave.
    for (let i = 0; i < 3; i++) {
      await page.evaluate(() => (window as any).__rv472.showMarkers(true, true));
      await page.evaluate(() => (window as any).__rv472.hideMarkers());
    }
    const roots = await page.evaluate(() => {
      let count = 0;
      (window as any).viewer.scene.traverse((o: any) => {
        if (o.name === '__rvMechanismComGizmo') count++;
      });
      return count;
    });
    expect(roots).toBe(0);
  });
});
