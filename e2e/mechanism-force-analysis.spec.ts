// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-412 §9.7 — the force analysis, end to end in a real browser.
 *
 * ── WHAT THIS PROVES ────────────────────────────────────────────────────────
 * Against ONE running viewer, the REAL private wasm solver and the REAL fixed
 * update loop:
 *
 *   * Phase 4 — an editor test run (`SimulationRuntime.beginEditorTest`, the
 *     exact API plan-410's in-place session attaches through) fills the
 *     recorder: series appear, samples accumulate, and their timestamps are
 *     simulation seconds;
 *   * Phase 5 — after the run STOPS the sizing figures stand: peak and RMS are
 *     finite, positive and the peak is at least the RMS, and the samples stay
 *     on screen rather than being cleared with the run;
 *   * F8 — the statics button answers WITHOUT a run: called on a freshly loaded
 *     mechanism it produces a holding figure where the dynamic recording has
 *     none;
 *   * §3.2 — the arrows appear only while there is something to draw and are
 *     GONE from the scene graph after teardown: no group, no leftover child,
 *     which is what a mode switch does to the panel that owns them.
 *
 * ── DELIBERATE CUTS, STATED PLAINLY ─────────────────────────────────────────
 * 1. NO SYNTHETIC PANEL CLICKS. The spec drives the recorder plugin and the
 *    runtime directly — the same cut `mechanism-authoring-matrix.spec.ts` takes
 *    for the same reason: the React wiring in `MechanismForceChart.tsx` is one
 *    state transition (`testState === 'running'` → `start()`/`stop()`), while
 *    everything that can be numerically WRONG is in the recorder and the
 *    solver. Rendering the quick-edit panel here would add a mode switch, a
 *    document and a work folder to a test about newtons.
 * 2. THE ARROWS ARE CHECKED IN THE SCENE GRAPH, not in a screenshot. Teardown
 *    is the assertion that matters (plan-198 contract), and a screenshot cannot
 *    distinguish "disposed" from "hidden".
 *
 * ── KNOWN ENVIRONMENT CAVEAT ────────────────────────────────────────────────
 * At the time of writing, the checked-out worktree's Playwright baseline is
 * already red for reasons unrelated to this plan (`e2e/smoke.spec.ts` fails on
 * the default start model). This spec therefore loads its OWN model explicitly
 * and never depends on whatever the app boots with.
 */

import { expect, test, type Page } from 'playwright/test';
 import { scratchAssetDocument } from '../tests/helpers/scratch-asset-document';
import { DEV_GLB } from '../tests/fixtures/glb-paths.mjs';
import { HAS_PRIVATE_SOURCE, privateModuleUrl } from './private-module-url';

/** A four-bar: a closed loop, so the loop-λ path is exercised, not just a tree. */
const BASE_MODEL = DEV_GLB.mechanismFourbar;

// The asset-editor modules live in the PRIVATE sibling repository, outside the
// dev-server root, and are addressed through `/@fs/<abs>` — see
// `e2e/private-module-url.ts`.
const MODULE_PATHS = {
  doc: '/src/core/editor/rv-asset-document.ts',
  authoring: privateModuleUrl('plugins/asset-editor/mechanism/mechanism-authoring.ts'),
  registry: '/src/core/engine/rv-kinematic-registry.ts',
  recorder: '/src/plugins/mechanism-force-recorder-plugin.ts',
  gizmo: privateModuleUrl('plugins/asset-editor/mechanism/mechanism-force-gizmo.ts'),
};

async function installHarness(page: Page): Promise<void> {
  await page.evaluate(async (paths) => {
    const w = window as unknown as Record<string, any>;
    const [docMod, authoring, kinRegistry, recorderMod, gizmoMod] = await Promise.all([
      import(/* @vite-ignore */ paths.doc),
      import(/* @vite-ignore */ paths.authoring),
      import(/* @vite-ignore */ paths.registry),
      import(/* @vite-ignore */ paths.recorder),
      import(/* @vite-ignore */ paths.gizmo),
    ]);

    const rvOf = (node: any): Record<string, any> =>
      (node?.userData?.realvirtual ?? {}) as Record<string, any>;

    w.__rv412 = {
      _gizmo: null as any,

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

      /**
       * Give every link a `MechanismBody` through the ordinary authoring
       * composite. Without mass the crate reports `MassMissing` by contract, so
       * this is the precondition for anything else here — and it is authored,
       * not injected, so the same path a user takes is the one under test.
       */
      async addMasses() {
        const viewer = w.viewer;
        const bridge = kinRegistry.getMechanismUiBridge();
        const mech = w.__rv412.firstMechanism();
        if (!mech) throw new Error('no active mechanism to add masses to');

        const doc = docMod.scratchAssetDocument(viewer);
        w.__rv412._doc = doc;
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
          // The Phase-0 reference GLBs are pure transform rigs — their links
          // carry NO geometry, so the mesh integrator honestly reports "this
          // link owns no geometry" and a mass of zero. Pinning a mass is the
          // authoring answer the panel offers for exactly that case (F3), and
          // it is what makes this fixture usable for a force test at all.
          await authoring.runMechanismPlan(
            docLike, authoring.planSetMassOverride(link.nodePath, 2.5), readField);
        }
        await doc.whenIdle();
        bridge.rebuild(mech.nodePath);

        const after = w.__rv412.firstMechanism();
        return {
          links: after.links.length,
          withBody: after.links.filter((l: any) => l.hasBody).length,
          masses: after.links.map((l: any) => l.massKg),
          detail: after.links.map((l: any) => ({
            name: l.name, mass: l.massKg, source: l.massSource, warning: l.massWarning,
          })),
          findings: after.findings.map((f: any) => `${f.severity}:${f.code}`),
        };
      },

      /** Install the recorder exactly as the panel does. */
      installRecorder() {
        let plugin = w.viewer.getPlugin(recorderMod.MECHANISM_FORCE_RECORDER_ID);
        if (!plugin) {
          plugin = new recorderMod.MechanismForceRecorderPlugin();
          w.viewer.use(plugin, 'core');
        }
        w.__rv412._recorder = plugin;
        return plugin.id;
      },

      /**
       * Start an EDITOR test run: attach time integration through the same
       * runtime API plan-410's session uses, jog every drive so the mechanism
       * actually moves (a still machine has no dynamics to record), and begin
       * the recording — the transition the panel performs on `running`.
       */
      startRun() {
        const drives = (w.viewer.drives ?? []) as any[];
        for (const d of drives) {
          d.jogForward = true;
          d.targetSpeed = Math.max(d.TargetSpeed ?? 0, 30);
        }
        w.viewer.runtime.beginEditorTest();
        w.__rv412._recorder.start();
        return { drives: drives.length, armed: w.__rv412._recorder.armedPaths.length };
      },

      stopRun() {
        w.__rv412._recorder.stop();
        w.viewer.runtime.endEditorTest();
        for (const d of (w.viewer.drives ?? []) as any[]) d.jogForward = false;
      },

      /** Everything the chart and the figures row would show. */
      readout() {
        const rec = w.__rv412._recorder.recorder;
        const mech = w.__rv412.firstMechanism();
        const series = rec.seriesFor(mech.nodePath);
        const drive = series.find((s: any) => s.kind === 'drive') ?? series[0];
        return {
          recording: rec.recording,
          sampleCount: rec.timeBuffer.count,
          times: rec.timeBuffer.toArray().slice(-3),
          seriesCount: series.length,
          driveSeriesCount: series.filter((s: any) => s.kind === 'drive').length,
          jointSeriesCount: series.filter((s: any) => s.kind !== 'drive').length,
          activeId: drive?.id ?? null,
          metrics: drive ? rec.metrics(drive.id) : null,
          status: kinRegistry.getMechanismUiBridge()?.forcesSnapshot(mech.nodePath)?.statusText ?? null,
        };
      },

      /** The statics button (F8) — no run, no history. */
      statics() {
        const mech = w.__rv412.firstMechanism();
        const snapshot = w.__rv412._recorder.captureStatics(mech.nodePath);
        const rec = w.__rv412._recorder.recorder;
        const holding = (snapshot?.channels ?? [])
          .filter((c: any) => c.kind === 'drive')
          .map((c: any) => rec.metrics(c.id).holding);
        return {
          statusText: snapshot?.statusText ?? null,
          valid: snapshot?.dynamicsValid ?? false,
          channels: snapshot?.channels.length ?? 0,
          holding,
          maxAbs: Math.max(0, ...(snapshot?.channels ?? []).map((c: any) => Math.abs(c.value))),
        };
      },

      /** Build the arrow overlay from the live snapshot. */
      showArrows() {
        const mech = w.__rv412.firstMechanism();
        const bridge = kinRegistry.getMechanismUiBridge();
        w.__rv412._gizmo = new gizmoMod.MechanismForceGizmo(w.viewer);
        const targets = gizmoMod.arrowTargetsFromSnapshot(bridge.forcesSnapshot(mech.nodePath));
        w.__rv412._gizmo.setTargets(targets);
        const group = w.viewer.scene.getObjectByName('__rvMechanismForceGizmo');
        return {
          targets: targets.length,
          inScene: !!group,
          visibleArrows: w.__rv412._gizmo.arrowCount,
          magnitudes: targets.map((t: any) => t.magnitude),
        };
      },

      /** Tear the overlay down — what the panel's unmount (a mode switch) does. */
      hideArrows() {
        w.__rv412._gizmo?.dispose();
        w.__rv412._gizmo = null;
        return { inScene: !!w.viewer.scene.getObjectByName('__rvMechanismForceGizmo') };
      },
    };
  }, MODULE_PATHS);
}

test.describe.configure({ mode: 'serial' });

test.describe('plan-412 §9.7 — mechanism force analysis', () => {
  // Mechanism authoring is commercial source; without the private sibling repo
  // there is nothing to drive here.
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
    await page.evaluate((url) => (window as any).__rv412.loadBase(url), BASE_MODEL);
    await page.waitForFunction(() => (window as any).__rv412.solverReady(),
      undefined, { timeout: 180_000 });
  });

  test.afterAll(async () => {
    await page?.close();
  });

  test('masses can be authored on every link', async () => {
    const result = await page.evaluate(() => (window as any).__rv412.addMasses());
    expect(result.links).toBeGreaterThan(0);
    // Every link, not most of them: one sentinel disables the whole mechanism.
    expect(result.withBody).toBe(result.links);
    // Every link ends up with a usable mass — a single zero would be a
    // sentinel link and would take the whole mechanism's dynamics down.
    expect(Math.min(...result.masses)).toBeGreaterThan(0);
    expect(result.findings.filter((f: string) => f.startsWith('Error'))).toEqual([]);
  });

  test('statics answers before any run has happened (F8)', async () => {
    await page.evaluate(() => (window as any).__rv412.installRecorder());
    const statics = await page.evaluate(() => (window as any).__rv412.statics());
    expect(statics.statusText).toBe('ok');
    expect(statics.valid).toBe(true);
    expect(statics.channels).toBeGreaterThan(0);
    // Holding is gravity against the pose — it must exist and be a real number.
    expect(statics.holding.length).toBeGreaterThan(0);
    for (const h of statics.holding) expect(Number.isFinite(h)).toBe(true);
    // And it must be a LOAD. A machine hanging in gravity with every reported
    // channel at zero is the signature of an answer that was computed and then
    // thrown away, which is exactly the defect this assertion was added for.
    expect(statics.maxAbs).toBeGreaterThan(0);
  });

  test('an editor test run fills the recorder, and stopping leaves the figures', async () => {
    const started = await page.evaluate(() => (window as any).__rv412.startRun());
    expect(started.armed).toBeGreaterThan(0);

    // Wait for real samples rather than for a clock: the analysis needs five
    // history samples before it reports anything at all (`HistoryShort`).
    await page.waitForFunction(
      () => (window as any).__rv412.readout().sampleCount >= 12,
      undefined, { timeout: 60_000 });

    const during = await page.evaluate(() => (window as any).__rv412.readout());
    expect(during.recording).toBe(true);
    expect(during.status).toBe('ok');
    expect(during.driveSeriesCount).toBeGreaterThan(0);
    expect(during.jointSeriesCount).toBeGreaterThan(0);
    // Simulation seconds, ascending.
    expect(during.times[2]).toBeGreaterThan(during.times[0]);

    await page.evaluate(() => (window as any).__rv412.stopRun());
    const after = await page.evaluate(() => (window as any).__rv412.readout());

    expect(after.recording).toBe(false);
    // The last cycle stays on screen — that is the whole point of recording it.
    expect(after.sampleCount).toBeGreaterThanOrEqual(during.sampleCount);
    expect(after.metrics.sampleCount).toBeGreaterThan(0);
    expect(Number.isFinite(after.metrics.peak)).toBe(true);
    expect(after.metrics.peak).toBeGreaterThan(0);
    expect(after.metrics.rms).toBeGreaterThan(0);
    // Definitional, and the cheapest check that the weighting is not inverted.
    expect(after.metrics.peak).toBeGreaterThanOrEqual(after.metrics.rms - 1e-9);
  });

  test('force arrows appear and are fully torn down', async () => {
    // A statics evaluation gives the snapshot something to draw after the run.
    await page.evaluate(() => (window as any).__rv412.statics());
    const shown = await page.evaluate(() => (window as any).__rv412.showArrows());
    expect(shown.inScene).toBe(true);
    expect(shown.targets).toBeGreaterThan(0);
    expect(Math.max(...shown.magnitudes)).toBeGreaterThan(0);
    expect(shown.visibleArrows).toBeGreaterThan(0);

    const hidden = await page.evaluate(() => (window as any).__rv412.hideArrows());
    // Not hidden — GONE. A mode switch must not leave scene objects behind.
    expect(hidden.inScene).toBe(false);
  });
});
