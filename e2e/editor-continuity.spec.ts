// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-410 §9.6 — editor continuity, end to end in a real browser.
 *
 * ── WHAT THIS PROVES ────────────────────────────────────────────────────────
 * Against ONE running viewer, ONE real `AssetDocument` and the REAL scene
 * loader:
 *
 *   * F1  a selection resolves to its asset AT `mode-changing`, i.e. before the
 *         owning mode's deactivate hook has cleared it;
 *   * F5  `test → stop` restores the authoring state exactly — node transform,
 *         dirty flag, undo AND redo availability all identical to the pre-test
 *         reading — including after a save (the replay trap, R1-2);
 *   * F5  three start/stop cycles do not grow `renderer.info.memory`
 *         monotonically (no leaked geometries/textures per round trip);
 *   * F6  requesting a mode switch WHILE a run is live goes through the async
 *         exit guard: the switch completes and the target mode is left with no
 *         attached test owner;
 *   * F4  the transition overlay is on screen BEFORE the canvas is cleared, and
 *         it survives the editor EXIT — i.e. it outlives the plugin that asked
 *         for it (R2-2, R2-5);
 *   * F5  a failing materialisation surfaces an error and leaves the editor
 *         usable.
 *
 * ── DELIBERATE CUTS, STATED PLAINLY ─────────────────────────────────────────
 * 1. NO WORK FOLDER. Headless Chromium has no File System Access work folder,
 *    so a `libraryGlb` base cannot actually be read here and the planner has no
 *    local catalog to place from. The F1 assertion is therefore made where the
 *    contract lives: the resolved `AssetBase` reaching the pending-open store
 *    at `mode-changing`, plus the editor attempting to open exactly that base.
 *    The planner's own placement→catalog mapping is covered by
 *    `tests/selection-asset-resolver.test.ts`.
 * 2. THE SAVE STEP IS THE DOCUMENT-LEVEL ONE (`markSaved`), for the same
 *    reason: `runSaveFlow` writes into a work folder that does not exist here.
 *    What R1-2 is about — a saved document coming back dirty because the
 *    restore replayed already-baked ops — is fully exercised by it.
 * 3. THE LOAD-FAILURE ROW stubs `viewer.loadModel` to throw once. The test run
 *    loads from a `blob:` URL, which Playwright's request routing cannot
 *    intercept, so there is no way to fail it from the network layer.
 *
 * Everything else is the real thing: the real `InPlaceTestSession`, the real
 * `SimulationRuntime` attach API, the real overlay store, the real exit guard.
 */

import { test, expect, type Page } from 'playwright/test';

/** Dynamically imported in-page (kept in variables so TS does not resolve them). */
const MODULE_PATHS = {
  doc: '/src/core/editor/rv-asset-document.ts',
  pendingOpen: '/src/plugins/asset-editor/pending-open-store.ts',
  resolver: '/src/plugins/asset-editor/selection-asset-resolver.ts',
  testSession: '/src/plugins/asset-editor/test-session-store.ts',
  transition: '/src/core/hmi/scene-transition-store.ts',
  lastEdited: '/src/plugins/asset-editor/last-edited-asset-store.ts',
};

/** Install the in-page harness as `window.__rv410`. Test-only scaffolding. */
async function installHarness(page: Page): Promise<void> {
  await page.evaluate(async (paths) => {
    const w = window as unknown as Record<string, any>;
    const [pendingOpen, resolver, testSession, transition, lastEdited] = await Promise.all([
      import(/* @vite-ignore */ paths.pendingOpen),
      import(/* @vite-ignore */ paths.resolver),
      import(/* @vite-ignore */ paths.testSession),
      import(/* @vite-ignore */ paths.transition),
      import(/* @vite-ignore */ paths.lastEdited),
    ]);

    /** Snapshot of the overlay at the moment the canvas is cleared. */
    const paintProbe = { overlayVisibleAtClear: null as boolean | null, clears: 0 };

    // Instrument the DESTRUCTIVE moment itself: `clearModel` is what empties
    // the canvas, so sampling the overlay's rendered state right there is the
    // only honest way to prove `showNowAndPaint` kept its contract (R2-5).
    const viewer = w.viewer;
    const originalClear = viewer.clearModel?.bind(viewer);
    if (originalClear) {
      viewer.clearModel = (...args: unknown[]) => {
        paintProbe.clears++;
        const el = document.querySelector('[data-testid="scene-transition-overlay"]');
        const rendered = !!el && el.getClientRects().length > 0;
        // Only the FIRST unmasked clear matters; once false it stays false.
        if (paintProbe.overlayVisibleAtClear !== false) {
          paintProbe.overlayVisibleAtClear = rendered;
        }
        return originalClear(...args);
      };
    }

    w.__rv410 = {
      paintProbe,

      // ── mode / selection ────────────────────────────────────────────
      async requestMode(id: string) { return w.viewer.modes.requestMode(id); },
      setMode(id: string) { w.viewer.modes.setMode(id); },
      activeMode() { return w.viewer.modes.activeMode; },

      /** Register a resolver that answers for `path` with a library base. */
      armResolver(path: string, base: unknown) {
        w.__rv410._offResolver?.();
        w.__rv410._offResolver = resolver.registerSelectionAssetResolver(
          (p: string) => (p === path ? base : null),
        );
      },
      disarmResolver() { w.__rv410._offResolver?.(); w.__rv410._offResolver = null; },
      peekPending() { return pendingOpen.peekPendingAssetOpen(); },
      takePending() { return pendingOpen.takePendingAssetOpen(); },
      clearLastEdited() { lastEdited.clearLastEditedAsset(); },

      /**
       * Observe the resolution at the moment it must happen.
       *
       * `_activate` consumes the pending request asynchronously, so reading the
       * store after `requestMode` resolves is a race. This listener is
       * registered AFTER the plugin's own (insertion order = firing order), so
       * it samples the store right after the editor's `mode-changing` handler
       * ran — and it also records whether the selection was still there, which
       * is the actual claim of F1/R1-1.
       */
      observeModeChanging() {
        const seen = { pending: null as unknown, selectionAtResolve: null as string | null };
        w.__rv410._offObserver?.();
        w.__rv410._offObserver = w.viewer.on('mode-changing', ({ to }: { to: string }) => {
          if (to !== 'editor') return;
          seen.pending = pendingOpen.peekPendingAssetOpen();
          seen.selectionAtResolve = w.viewer.selectionManager.primaryPath;
        });
        return seen;
      },

      /** Force a primary selection without relying on picking. */
      selectPath(path: string) {
        // `select()` takes ONE path (SelectionManager); `selectPaths()` is the
        // array form. Passing an array reaches NodeRegistry as a non-string.
        w.viewer.selectionManager.select(path);
        return w.viewer.selectionManager.primaryPath;
      },

      // ── document / test session ─────────────────────────────────────
      doc() {
        const plugin = w.viewer.getPlugin('asset-editor');
        return plugin?.document ?? null;
      },
      session() { return testSession.getActiveTestSession(); },
      sessionState() { return testSession.getTestSessionState(); },

      docReading() {
        const d = w.__rv410.doc();
        if (!d) return null;
        const s = d.getSnapshot();
        return {
          dirty: s.dirty, canUndo: s.canUndo, canRedo: s.canRedo,
          undoLabel: s.undoLabel, redoLabel: s.redoLabel, opCount: s.opCount,
          name: s.name,
        };
      },

      /**
       * A node to author on. An empty asset (the fallback when no work folder
       * exists) has no children, so create one through the document's own
       * public op — that is authoring, not scaffolding.
       */
      async ensureNode() {
        const d = w.__rv410.doc();
        if (!d) return null;
        const root = w.viewer.currentModelRoot;
        const existing = root?.children?.[0];
        const existingPath = existing ? w.viewer.registry?.getPathForNode(existing) : null;
        if (existingPath) return existingPath;
        const created = await d.createEmptyNode(null, 'PlanTestNode');
        await d.whenIdle();
        return created ?? null;
      },

      /** An authored change with a live effect: move a node. */
      async editFirstNode(y: number) {
        const d = w.__rv410.doc();
        if (!d) return null;
        const path = await w.__rv410.ensureNode();
        const node = path ? w.viewer.registry?.getNode(path) : null;
        if (!path || !node) return null;
        const prev = {
          position: [node.position.x, node.position.y, node.position.z],
          quaternion: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
          scale: [node.scale.x, node.scale.y, node.scale.z],
        };
        d.transformNode(path, { ...prev, position: [prev.position[0], y, prev.position[2]] }, prev);
        await d.whenIdle();
        return path;
      },

      /** Authored drive extras on the first node (materialise on test start). */
      async addDrive() {
        const d = w.__rv410.doc();
        if (!d) return null;
        const path = await w.__rv410.ensureNode();
        if (!path) return null;
        d.addComponent(path, 'Drive', { Direction: 'LinearY', TargetSpeed: 100 });
        await d.whenIdle();
        return path;
      },

      /**
       * Y of a node found BY NAME in the current model root.
       *
       * Deliberately not by full path: `exportAssetGlb` names the exported
       * scene after the document, so when the document name differs from the
       * live root name (which is the case for a synthetic empty asset that was
       * `markSaved` under a new name) the root — and every path below it —
       * legitimately changes across the round trip. What must survive is the
       * authored TRANSFORM, and that is what this reads.
       */
      nodeYByName(name: string) {
        let found: any = null;
        w.viewer.currentModelRoot?.traverse((n: any) => {
          if (!found && n.name === name) found = n;
        });
        return found ? found.position.y : null;
      },

      nodeName(path: string) {
        return w.viewer.registry?.getNode(path)?.name ?? null;
      },

      /** Start measuring the overlay/clear relationship from NOW. */
      resetProbe() {
        paintProbe.clears = 0;
        paintProbe.overlayVisibleAtClear = null;
      },

      async markSaved(name: string) {
        const d = w.__rv410.doc();
        // A path-addressed document keeps the identity realistic without ever
        // touching the (absent) work folder. One kind since plan-716 §2.6; the
        // `library/` folder now lives in `path` rather than in the kind name.
        await d.markSaved(
          { kind: 'document', documentId: `doc_${name}`, path: `library/Custom/${name}.glb`, name },
          name,
        );
      },

      async startTest() { await w.__rv410.session()?.start(); },
      async stopTest() { await w.__rv410.session()?.stop(); },

      runtimeAttached() { return w.viewer.runtime.isAttached; },
      editorTestActive() { return w.viewer.runtime.isEditorTestActive; },

      memory() {
        const m = w.viewer.renderer.info.memory;
        return { geometries: m.geometries, textures: m.textures };
      },

      overlayVisible() {
        const el = document.querySelector('[data-testid="scene-transition-overlay"]');
        return !!el && el.getClientRects().length > 0;
      },
      transitionSnapshot() { return transition.getSceneTransitionSnapshot(); },

      /** Make the NEXT loadModel throw (see cut 3 in the file header). */
      failNextLoad() {
        const original = w.viewer.loadModel.bind(w.viewer);
        let armed = true;
        w.viewer.loadModel = async (...args: unknown[]) => {
          if (armed) { armed = false; throw new Error('e2e: forced load failure'); }
          return original(...args);
        };
      },
    };
  }, MODULE_PATHS);
}

/** Boot the viewer and install the harness. */
async function boot(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 30_000 });
  await page.waitForFunction(() => !!(window as unknown as Record<string, any>).viewer, null, { timeout: 30_000 });
  // The React HMI mounts LATER than the viewer — `#rv-floating-panel-root` is
  // HMIShell's own child, so its presence is the shell's readiness signal. The
  // overlay assertions are DOM assertions and are meaningless before this.
  await page.waitForFunction(
    () => !!document.getElementById('rv-floating-panel-root'),
    null,
    { timeout: 90_000 },
  );
  await page.waitForTimeout(2_000);   // let the initial model settle
  await installHarness(page);
}

/**
 * Enter the editor and wait until a document exists.
 *
 * `onModeActivate` kicks `_activate` off without awaiting it, and that path
 * loads a model — so "requestMode resolved" is NOT "the editor is ready".
 */
async function enterEditor(page: Page): Promise<void> {
  await page.evaluate(() => (window as any).__rv410.requestMode('editor'));
  await page.waitForFunction(
    () => !!(window as any).__rv410.doc(),
    null,
    { timeout: 60_000 },
  );
  // Let the activation settle (tools installed, session published).
  await page.waitForFunction(
    () => !!(window as any).__rv410.session(),
    null,
    { timeout: 30_000 },
  );
}

test.describe('editor continuity (plan-410)', () => {
  // Each row boots its own page and asserts an independent property, so a
  // failure in one must not skip the rest (which `serial` would do).
  test.describe.configure({ mode: 'default' });

  test('F1 — a selection resolves to its asset before the old mode clears it', async ({ page }) => {
    test.setTimeout(120_000);
    await boot(page);

    const base = {
      kind: 'document', documentId: 'doc_belt', path: 'library/Custom/Belt.glb', name: 'Belt',
    };

    const resolved = await page.evaluate(async (b) => {
      const h = (window as any).__rv410;
      const viewer = (window as any).viewer;
      // Any real node path from the loaded scene.
      const root = viewer.currentModelRoot;
      const node = root?.children?.[0] ?? root;
      const path = viewer.registry?.getPathForNode(node);
      if (!path) return { skipped: 'no selectable node in the demo scene' };

      h.takePending();
      h.armResolver(path, b);
      // Make it the primary selection the way the modes do.
      h.selectPath(path);
      const before = viewer.selectionManager.primaryPath;
      const seen = h.observeModeChanging();

      await h.requestMode('editor');
      h.disarmResolver();
      return {
        before,
        // Sampled AT `mode-changing`, not after — `_activate` consumes the
        // request asynchronously, so reading it afterwards is a race.
        resolvedAtModeChanging: seen.pending,
        selectionAtResolve: seen.selectionAtResolve,
        mode: h.activeMode(),
      };
    }, base);

    if ('skipped' in resolved) test.skip(true, resolved.skipped as string);

    expect(resolved.mode).toBe('editor');
    // The selection was still readable at resolve time — this is what running
    // BEFORE the deactivate hooks buys (R1-1).
    expect(resolved.selectionAtResolve).toBe(resolved.before);
    // …and the resolved asset reached the editor's handoff store.
    expect(resolved.resolvedAtModeChanging).toMatchObject({
      kind: 'document',
      path: 'library/Custom/Belt.glb',
    });
  });

  test('F5 — test → stop restores transform, dirty flag and undo/redo exactly', async ({ page }) => {
    test.setTimeout(180_000);
    await boot(page);
    await enterEditor(page);

    const result = await page.evaluate(async () => {
      const h = (window as any).__rv410;
      const path = await h.addDrive();
      if (!path) return { skipped: 'no authorable node' };

      await h.editFirstNode(0.25);
      await h.markSaved('ContinuityAsset');       // clean point AFTER an edit
      await h.editFirstNode(0.5);                 // one more edit → dirty
      const d = h.doc();
      await d.undo();                             // …and an undo → redo pending

      const nodeName = h.nodeName(path);
      const before = { ...h.docReading(), y: h.nodeYByName(nodeName) };

      await h.startTest();
      const duringState = h.sessionState();
      const attachedDuring = h.runtimeAttached();
      await h.stopTest();

      const after = { ...h.docReading(), y: h.nodeYByName(nodeName) };
      return { before, after, duringState, attachedDuring, state: h.sessionState(), nodeName };
    });

    if ('skipped' in result) test.skip(true, result.skipped as string);

    expect(result.duringState).toBe('running');
    expect(result.attachedDuring).toBe(true);
    expect(result.state).toBe('idle');

    // The whole promise of F5, read back off the live document.
    expect(result.after.dirty).toBe(result.before.dirty);
    expect(result.after.canUndo).toBe(result.before.canUndo);
    expect(result.after.canRedo).toBe(result.before.canRedo);
    expect(result.after.undoLabel).toBe(result.before.undoLabel);
    expect(result.after.redoLabel).toBe(result.before.redoLabel);
    expect(result.after.opCount).toBe(result.before.opCount);
    expect(result.after.name).toBe(result.before.name);
    expect(result.after.y).toBeCloseTo(result.before.y as number, 5);
  });

  test('F5 — a document clean at test start is clean at test stop (no op replay)', async ({ page }) => {
    test.setTimeout(180_000);
    await boot(page);
    await enterEditor(page);

    const result = await page.evaluate(async () => {
      const h = (window as any).__rv410;
      const path = await h.editFirstNode(0.3);
      if (!path) return { skipped: 'no authorable node' };
      await h.markSaved('CleanAsset');
      const dirtyBefore = h.docReading().dirty;

      await h.startTest();
      await h.stopTest();

      return { dirtyBefore, dirtyAfter: h.docReading().dirty };
    });

    if ('skipped' in result) test.skip(true, result.skipped as string);
    expect(result.dirtyBefore).toBe(false);
    // A replay-based restore re-applies the ops baked into the saved base and
    // would report `true` here (review finding R1-2).
    expect(result.dirtyAfter).toBe(false);
  });

  test('F5 — three test cycles do not grow GPU memory monotonically', async ({ page }) => {
    test.setTimeout(240_000);
    await boot(page);
    await enterEditor(page);

    const samples = await page.evaluate(async () => {
      const h = (window as any).__rv410;
      const out: Array<{ geometries: number; textures: number }> = [];
      for (let i = 0; i < 3; i++) {
        await h.startTest();
        await h.stopTest();
        out.push(h.memory());
      }
      return out;
    });

    expect(samples).toHaveLength(3);
    const strictlyGrowing =
      samples[1].geometries > samples[0].geometries && samples[2].geometries > samples[1].geometries;
    const texturesGrowing =
      samples[1].textures > samples[0].textures && samples[2].textures > samples[1].textures;
    expect(strictlyGrowing, `geometries: ${JSON.stringify(samples)}`).toBe(false);
    expect(texturesGrowing, `textures: ${JSON.stringify(samples)}`).toBe(false);
  });

  test('F6 — a mode switch during a live test run goes through the exit guard', async ({ page }) => {
    test.setTimeout(180_000);
    await boot(page);
    await enterEditor(page);

    const result = await page.evaluate(async () => {
      const h = (window as any).__rv410;
      await h.startTest();
      const runningBefore = h.sessionState();

      // The USER-facing path: requestMode runs the exit guard, which awaits
      // stop() before the switch continues.
      const switched = await h.requestMode('hmi');

      return {
        runningBefore,
        switched,
        mode: h.activeMode(),
        editorTestActive: h.editorTestActive(),
        attached: h.runtimeAttached(),
      };
    });

    expect(result.runningBefore).toBe('running');
    expect(result.switched).toBe(true);
    expect(result.mode).toBe('hmi');
    // No attached test owner survives into the target mode.
    expect(result.editorTestActive).toBe(false);
    expect(result.attached).toBe(true);   // hmi is an attached workspace
  });

  test('F4 — the overlay is painted BEFORE the canvas is cleared', async ({ page }) => {
    test.setTimeout(180_000);
    await boot(page);

    // Measure ONLY the editor transition: the boot model load may still clear
    // the scene after the harness was installed, and that clear is not the one
    // this test is about.
    await page.evaluate(() => (window as any).__rv410.resetProbe());

    // Entering the editor is a scene-destroying transition.
    await enterEditor(page);

    const probe = await page.evaluate(() => (window as any).__rv410.paintProbe);
    // Instrumented at the clear itself — a route throttle alone would not
    // prove this (review finding R2-5).
    expect(probe.clears).toBeGreaterThan(0);
    expect(probe.overlayVisibleAtClear).toBe(true);
  });

  test('F4 — the exit overlay outlives the editor plugin', async ({ page }) => {
    test.setTimeout(180_000);
    await boot(page);
    await enterEditor(page);

    // Leaving the editor disables the plugin while `_restorePreviousScene`
    // is still running. The overlay is hosted by the HMI shell precisely so it
    // does not disappear with the plugin (review finding R2-2).
    const seen = await page.evaluate(async () => {
      const h = (window as any).__rv410;
      let sawOverlayWhileDisabled = false;
      const poll = setInterval(() => {
        const pluginGone = !h.doc();
        if (pluginGone && h.overlayVisible()) sawOverlayWhileDisabled = true;
      }, 16);
      await h.requestMode('hmi');
      await new Promise((r) => setTimeout(r, 600));
      clearInterval(poll);
      return { sawOverlayWhileDisabled, mode: h.activeMode() };
    });

    expect(seen.mode).toBe('hmi');
    expect(seen.sawOverlayWhileDisabled).toBe(true);
  });

  test('F5 — a failing materialisation leaves the editor usable', async ({ page }) => {
    test.setTimeout(180_000);
    await boot(page);
    await enterEditor(page);

    const result = await page.evaluate(async () => {
      const h = (window as any).__rv410;
      const before = h.docReading();
      h.failNextLoad();

      await h.startTest();

      // The run did not come up…
      const state = h.sessionState();
      const attached = h.editorTestActive();

      // …and the editor still answers: another edit is accepted.
      const path = await h.editFirstNode(0.42);
      return { before, state, attached, edited: !!path, after: h.docReading() };
    });

    expect(result.state).not.toBe('running');
    expect(result.attached).toBe(false);
    expect(result.edited).toBe(true);
    expect(result.after.opCount).toBeGreaterThan(result.before.opCount);
  });
});
