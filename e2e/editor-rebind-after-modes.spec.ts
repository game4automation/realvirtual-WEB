// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-616 §9.1 / §9.7 — the editor binds the SAME document on every entry
 * after a tour through the other modes (LOP #196).
 *
 * The defect, measured in plan-601 (spike `spike-dirty-probe.spec.ts`): on the
 * demo scene (`builtinModel`) the first editor entry bound the scene's living
 * `RvDocument`; once the document was dirty, the second entry found the first
 * entry's draft, skipped the bind and built a SECOND document from that draft
 * — not bound, dirty, and "Unsaved changes" on the way out.
 *
 * What is asserted is the FORK (the thing), not only the dialog (the symptom):
 * the inner document of the first entry is marked (`__rv616`), and every later
 * entry must find that very mark on the document it got. Preconditions are
 * asserted, never assumed — a run with zero editor visits must fail, not pass.
 *
 *   9.1  modes viewer, hmi, des, planner, commissioning → editor → leave →
 *        editor → leave → editor; with and without a real edit in the editor;
 *        and a fast enter/leave/enter without waiting for the draft flush
 *   9.7  the scene is SAVED between visits (its identity may switch from
 *        `builtinModel` to `document`), and later visits still bind it
 *
 * **Warm-up before measuring (the `mode-matrix.spec.ts` pattern).** The first
 * tour through the modes allocates the modes' lazy listeners ONCE (measured on
 * `DemoRealvirtualWeb.glb`: the I3 listener sum goes 1 -> 2 per signal on the
 * first visit and stays flat on every later cycle, 101/100 in the probe). Every
 * test therefore runs two full warm-up passes — all other modes AND the editor —
 * before it measures, logs what the warm-up reported, and only then resets the
 * journey. The BINDING is asserted during the warm-up as well (the first entry
 * binds and is marked, the second finds the mark): the warm-up only exempts the
 * one-time invariant findings, never the thing this spec is about, and a
 * critical console error during the warm-up still fails the test.
 *
 * **The edit is a gizmo move** (`transformNode` through the editor facade, the
 * edit `editor-continuity.spec.ts` uses), not a `setField` on a component the
 * node may not have — the inspector cannot author that, so it is no "real user
 * edit" in the sense of plan-616 F1.
 */

import { test, expect, type Page } from 'playwright/test';
import { waitForViewerReady, criticalErrors } from './_viewer-ready';
import { watchJourney, INVARIANT_PREFIX, type JourneyWatcher } from './_journey';

const DEMO_URL = '/?model=DemoRealvirtualWeb.glb';
const OTHER_MODES = ['viewer', 'hmi', 'des', 'planner', 'commissioning'] as const;
/** Warm-up passes; TWO for the reason `mode-matrix.spec.ts` records (I2/I3 count at mode ENTRY). */
const WARM_UP_PASSES = 2;

/** What the editor holds right now, read off the real plugin. */
interface EditorReading {
  active: string;
  hasDoc: boolean;
  isBound: boolean;
  dirty: boolean;
  opCount: number;
  mark: string | null;
  sameAsScene: boolean;
}

/** A real edit and where to read it back. */
interface EditResult {
  opCount: number;
  nodeName: string;
  y: number;
}

/** Thrown text when the test reaches no living scene store — never a silent `false`. */
const SCENE_STORE_UNREACHABLE = 'scene store not reachable from the test, module instance mismatch?';

/**
 * Install `window.__rv616SceneStore()` — the ONE way this spec reaches the
 * scene store.
 *
 * There is no handle on `viewer` or `window`: the store lives only in the
 * module-level `_instance` of `scene-store-singleton.ts`, set once by
 * `initSceneStore` in `main.ts` (the editor plugin reads it the same way). The
 * test can therefore only reach it through the module URL — and a SECOND module
 * instance (Vite serving an edited file as `?t=<ts>` under a running server)
 * has an empty `_instance`. Such an instance must not turn into
 * `sameAsScene=false` (a wrong red) or into a skipped save (a wrong green), so
 * the probe throws instead: null store, or a store that belongs to another
 * viewer than `window.viewer` (`SceneStore._viewer`, set in its constructor).
 */
async function installSceneProbe(page: Page): Promise<void> {
  await page.evaluate((unreachable: string) => {
    const w = window as unknown as Record<string, any>;
    w.__rv616SceneStore = async () => {
      // new Function: Playwright would rewrite a literal import() in this callback.
      const dyn = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
      const mod = await dyn('/src/core/hmi/scene/scene-store-singleton.ts');
      const store = mod.getSceneStore?.() ?? null;
      if (!store) throw new Error(`${unreachable} (getSceneStore() returned null)`);
      if (store._viewer !== w.viewer) throw new Error(`${unreachable} (the store belongs to another viewer)`);
      return store;
    };
  }, SCENE_STORE_UNREACHABLE);
}

async function readEditor(page: Page): Promise<EditorReading> {
  return page.evaluate(async () => {
    const w = window as unknown as Record<string, any>;
    const store = await w.__rv616SceneStore();
    const facade = w.viewer.getPlugin('asset-editor')?.document ?? null;
    const inner = facade?.document ?? null;
    return {
      active: w.viewer.modes.activeMode,
      hasDoc: !!facade,
      isBound: facade?.isBound ?? false,
      dirty: facade?.dirty ?? false,
      opCount: inner?.opCount ?? -1,
      mark: inner?.__rv616 ?? null,
      sameAsScene: !!inner && inner === store.document,
    };
  });
}

/** Mark the INNER document of the current editor entry. */
async function markInner(page: Page, mark: string): Promise<void> {
  const ok = await page.evaluate((m: string) => {
    const inner = (window as any).viewer.getPlugin('asset-editor')?.document?.document;
    if (!inner) return false;
    inner.__rv616 = m;
    return true;
  }, mark);
  expect(ok, 'the first editor entry has an inner document to mark').toBe(true);
}

async function requestMode(page: Page, mode: string): Promise<void> {
  const accepted = await page.evaluate((m: string) => (window as any).viewer.modes.requestMode(m), mode);
  expect(accepted, `requestMode('${mode}') accepted`).toBe(true);
  expect(await page.evaluate(() => (window as any).viewer.modes.activeMode)).toBe(mode);
}

async function tourOtherModes(page: Page, journey: JourneyWatcher): Promise<void> {
  for (const mode of OTHER_MODES) {
    await requestMode(page, mode);
    await journey.settle();
    if (mode === 'des') {
      expect(await page.evaluate(() => (window as any).viewer.modes.activeMode)).toBe('des');
    }
  }
}

/**
 * Enter the editor and wait until it holds a document.
 *
 * Fails FAST and with a reason when the activation gives up instead: an open
 * that throws hands the mode back (`_abandonActivation`), and waiting the full
 * timeout for a document that cannot come any more only hides why.
 */
async function enterEditor(page: Page, journey: JourneyWatcher): Promise<EditorReading> {
  await requestMode(page, 'editor');
  const outcome = await page.waitForFunction(
    () => {
      const v = (window as any).viewer;
      if (v.getPlugin('asset-editor')?.document) return 'document';
      if (v.modes.activeMode !== 'editor') return `mode handed back to '${v.modes.activeMode}'`;
      return false;
    },
    null,
    { timeout: 60_000 },
  ).then((h) => h.jsonValue() as Promise<string>, () => 'no document within 60 s');
  if (outcome !== 'document') {
    const dialogs = await page.locator('[role="dialog"]').allInnerTexts().catch(() => [] as string[]);
    const recent = criticalErrors(journey.errors.filter((e) => !e.includes(INVARIANT_PREFIX))).slice(-8);
    expect(outcome, `the editor opened no document; dialogs=${JSON.stringify(dialogs)}; console errors=${JSON.stringify(recent)}`)
      .toBe('document');
  }
  await journey.settle();
  expect(await page.locator('[role="dialog"]').count(), 'no dialog on entering the editor').toBe(0);
  return readEditor(page);
}

/**
 * Leave the editor WITHOUT awaiting the request — with a forked, dirty document
 * the exit guard parks on "Unsaved changes", and an awaited request would hang
 * instead of failing. Fails when a dialog appears.
 */
async function leaveEditor(
  page: Page,
  journey: JourneyWatcher,
  target: string,
  opts: { settle?: boolean } = {},
): Promise<void> {
  await page.evaluate((m: string) => { (window as any).__rv616Leave = (window as any).viewer.modes.requestMode(m); }, target);
  await page.waitForFunction(
    (m: string) => (window as any).viewer.modes.activeMode === m
      || document.querySelectorAll('[role="dialog"]').length > 0,
    target,
    { timeout: 60_000 },
  );
  expect(await page.locator('[role="dialog"]').count(), 'no "Unsaved changes" dialog on leaving').toBe(0);
  expect(await page.evaluate(() => (window as any).__rv616Leave)).toBe(true);
  // The return leg re-projects the scene behind the "Leaving editor…" overlay;
  // `settle()` waits for that overlay to be gone (the real mode barrier).
  if (opts.settle !== false) await journey.settle();
}

/**
 * A real edit in the editor: move the model root's first child along Y through
 * the facade — what the gizmo does. Returns the new op count and where the edit
 * can be read back after a round trip (by NAME: the root of the exported tree
 * may be renamed after the document, which changes every path below it).
 */
async function editInEditor(page: Page, dy: number): Promise<EditResult> {
  const out = await page.evaluate(async (delta: number) => {
    const w = window as unknown as Record<string, any>;
    const facade = w.viewer.getPlugin('asset-editor')?.document;
    const node = w.viewer.currentModelRoot?.children?.[0];
    const path = node ? w.viewer.registry?.getPathForNode(node) : null;
    if (!facade || !node || !path) return null;
    const before = facade.document.opCount;
    const prev = {
      position: [node.position.x, node.position.y, node.position.z],
      quaternion: [node.quaternion.x, node.quaternion.y, node.quaternion.z, node.quaternion.w],
      scale: [node.scale.x, node.scale.y, node.scale.z],
    };
    const y = prev.position[1] + delta;
    facade.transformNode(path, { ...prev, position: [prev.position[0], y, prev.position[2]] }, prev);
    await facade.whenIdle();
    const after = facade.document.opCount;
    return { opCount: after > before ? after : -1, nodeName: String(node.name), y };
  }, dy);
  expect(out, 'the editor has a non-root node to edit').not.toBeNull();
  expect(out!.opCount, 'the editor edit was recorded').toBeGreaterThan(0);
  expect(await readNodeY(page, out!.nodeName), 'the edit is applied to the tree').toBeCloseTo(out!.y, 4);
  return out!;
}

/** Y of the first node called `name` under the current model root, or null. */
async function readNodeY(page: Page, name: string): Promise<number | null> {
  return page.evaluate((n: string) => {
    let found: any = null;
    (window as any).viewer.currentModelRoot?.traverse((o: any) => {
      if (!found && o.name === n) found = o;
    });
    return found ? found.position.y : null;
  }, name);
}

function expectSameBoundDocument(reading: EditorReading, mark: string): void {
  expect(reading.hasDoc).toBe(true);
  expect(reading.isBound, 'the editor is bound to the scene document').toBe(true);
  expect(reading.sameAsScene, 'the editor document IS the scene document').toBe(true);
  expect(reading.mark, 'the same inner instance as on the first entry').toBe(mark);
}

async function boot(page: Page): Promise<JourneyWatcher> {
  const journey = watchJourney(page);
  await page.goto(DEMO_URL, { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);
  await installSceneProbe(page);
  // Reachability is a precondition of every test: fail here, loudly, not later as a false.
  await page.evaluate(async () => { await (window as any).__rv616SceneStore(); });
  return journey;
}

/** Module URL of the project store; passed as a parameter, never a literal `import()`. */
const PROJECT_STORE_MODULE = '/src/core/project/project-store.ts';

/** What opening the writable browser project reported. */
interface WritableProjectResult {
  opened: boolean;
  why: string | null;
  projectBefore: string | null;
  projectAfter: string | null;
  backendKind: string | null;
  writable: boolean;
  identityBefore: string | null;
  identityAfter: string | null;
}

/**
 * Make a WRITABLE project the active one — what a user does by clicking the
 * "Browser project" row on the dashboard (`ProjectsDashboardHost.tsx` →
 * `store.openWorkspaceProject()`).
 *
 * The boot of `?model=DemoRealvirtualWeb.glb` lands in the READ-ONLY bundled
 * demo project, and every save path there ends in "There is no writable project
 * to save into" (`SceneStore._createDocument` asks
 * `getProjectStore().getBackend()?.writable`). `ProjectStore.openWorkspaceProject()`
 * is the product verb that opens the implicit browser project: a
 * `BrowserBackend` (`writable = true`, localStorage + OPFS, no folder handle,
 * no picker, no permission grant), so it works headless. The switch closes the
 * demo project but does not reload the scene — the demo model stays on screen
 * as `builtinModel`, and the first `save()` then places a NEW document in the
 * browser project (`SceneStore._resolveSaveTarget` case 3), which is the user's
 * "Save" on somebody else's content.
 *
 * Module-instance mismatch is loud here as well: the project store the test
 * reaches must be the one the living scene store is attached to
 * (`ProjectStore.attachToSceneStore`, main.ts), or the open would change a
 * store the app never reads.
 */
async function openWritableProject(page: Page): Promise<WritableProjectResult> {
  return page.evaluate(async ({ modulePath, unreachable }) => {
    const w = window as unknown as Record<string, any>;
    const sceneStore = await w.__rv616SceneStore();
    // Same loader as `installSceneProbe` (proven in this spec's runs): a
    // literal import() in this callback would be rewritten by Playwright.
    const dyn = new Function('p', 'return import(p)') as (p: string) => Promise<any>;
    const mod = await dyn(modulePath);
    const store = mod.getProjectStore?.() ?? null;
    if (!store) throw new Error(`project store not reachable from the test (getProjectStore() returned null)`);
    if (store._sceneStore !== sceneStore) {
      throw new Error(`${unreachable} (the project store is not attached to the living scene store)`);
    }
    const projectBefore: string | null = store.getProject()?.id ?? null;
    const identityBefore: string | null = sceneStore.documentIdentity()?.kind ?? null;
    let opened = false;
    let why: string | null = null;
    try {
      opened = (await store.openWorkspaceProject()) === true;
      if (!opened) why = 'openWorkspaceProject() returned false (dirty guard or no manifest)';
    } catch (e) {
      why = `openWorkspaceProject() threw: ${String(e)}`;
    }
    const backend = store.getBackend();
    const writable = backend?.writable === true;
    if (opened && !writable) why = `the opened backend is not writable (kind '${String(backend?.kind)}')`;
    return {
      opened: opened && writable,
      why,
      projectBefore,
      projectAfter: store.getProject()?.id ?? null,
      backendKind: backend?.kind ?? null,
      writable,
      identityBefore,
      identityAfter: sceneStore.documentIdentity()?.kind ?? null,
    };
  }, { modulePath: PROJECT_STORE_MODULE, unreachable: SCENE_STORE_UNREACHABLE });
}

/**
 * Two full passes — other modes, editor, leave — before anything is measured.
 *
 * Returns the mark set on the FIRST editor entry. The binding is asserted on
 * both entries; only the one-time invariant findings are logged and forgotten.
 */
async function warmUp(page: Page, journey: JourneyWatcher): Promise<string> {
  const mark = `rv616-${Math.random().toString(36).slice(2)}`;
  for (let pass = 0; pass < WARM_UP_PASSES; pass++) {
    await tourOtherModes(page, journey);
    const reading = await enterEditor(page, journey);
    if (pass === 0) {
      expect(reading.isBound, 'the first entry binds (precondition)').toBe(true);
      expect(reading.sameAsScene, 'the first entry holds the scene document (precondition)').toBe(true);
      await markInner(page, mark);
    } else {
      expectSameBoundDocument(reading, mark);
    }
    await leaveEditor(page, journey, 'viewer');
  }
  await journey.settle();
  const consoleErrors = criticalErrors(journey.errors.filter((e) => !e.includes(INVARIANT_PREFIX)));
  expect(consoleErrors, 'console errors during the warm-up (only invariant findings are exempt)').toEqual([]);
  console.log(`[rv616] warm-up findings (one-time lazy allocations): ${JSON.stringify(journey.invariantViolations())}`);
  journey.reset();
  return mark;
}

test.describe('plan-616 — the editor rebinds the same document after the other modes', () => {
  test.describe.configure({ mode: 'default' });

  test('9.1 — three entries after a mode tour, one document, no dialog', async ({ page }) => {
    test.setTimeout(420_000);
    const journey = await boot(page);
    const mark = await warmUp(page, journey);
    let measured = 0;

    for (let pass = 0; pass < 2; pass++) {
      await tourOtherModes(page, journey);
      const again = await enterEditor(page, journey);
      measured++;
      expectSameBoundDocument(again, mark);
      if (pass === 0) await leaveEditor(page, journey, 'viewer');
    }

    expect(measured, 'non-vacuity: at least two measured editor entries after the warm-up').toBeGreaterThanOrEqual(2);
    await journey.assertClean();
  });

  test('9.1 — with a real edit in the editor, the edit survives and the document is the same', async ({ page }) => {
    test.setTimeout(420_000);
    const journey = await boot(page);
    const mark = await warmUp(page, journey);

    const first = await enterEditor(page, journey);
    expectSameBoundDocument(first, mark);
    const edit = await editInEditor(page, 0.123);
    expect((await readEditor(page)).dirty, 'the edit makes the document dirty').toBe(true);
    await leaveEditor(page, journey, 'viewer');

    await tourOtherModes(page, journey);
    const second = await enterEditor(page, journey);
    expectSameBoundDocument(second, mark);
    expect(second.opCount, 'the edit is still in the one op log').toBe(edit.opCount);
    expect(second.dirty).toBe(true);
    expect(await readNodeY(page, edit.nodeName), 'the edit is still on the tree').toBeCloseTo(edit.y, 4);
    await leaveEditor(page, journey, 'viewer');

    const third = await enterEditor(page, journey);
    expectSameBoundDocument(third, mark);
    expect(third.opCount).toBe(edit.opCount);
    expect(await readNodeY(page, edit.nodeName)).toBeCloseTo(edit.y, 4);
    await journey.assertClean();
  });

  test('9.1 — fast enter / leave / enter without waiting for the draft flush', async ({ page }) => {
    test.setTimeout(360_000);
    const journey = await boot(page);
    const mark = await warmUp(page, journey);

    const first = await enterEditor(page, journey);
    expectSameBoundDocument(first, mark);
    const edit = await editInEditor(page, 0.055);

    let measured = 0;
    for (let i = 0; i < 3; i++) {
      await leaveEditor(page, journey, 'hmi', { settle: false });
      const again = await enterEditor(page, journey);
      measured++;
      expectSameBoundDocument(again, mark);
      expect(again.opCount, 'the edit is still in the one op log').toBe(edit.opCount);
    }
    expect(measured, 'non-vacuity: three fast re-entries').toBe(3);
    await journey.assertClean();
  });

  test('9.7 — a save between the visits keeps the binding', async ({ page }) => {
    test.setTimeout(420_000);
    // What this test secures, and what it does not:
    // - It secures that the identity switch `builtinModel` -> `document` on the
    //   save does not break the binding, and that `save()` takes effect on a
    //   WRITABLE project. The FORK itself is caught by the three 9.1 tests,
    //   which run on `builtinModel` (before any save); after the save the
    //   identity is `document`, a path the defect does not affect.
    // - The I3 comparison does NOT run across the tour in these tests: every
    //   exit from the editor re-sets the invariant baseline. The bound return
    //   leg reloads the scene (Private `src/plugins/asset-editor/index.ts:1861`
    //   `reload: () => store.reprojectFromBaseBytes()`, called from
    //   `_restorePreviousScene` at :1895 via `_returnBoundScene`;
    //   `src/core/hmi/scene/scene-store.ts:1365/1380` -> `viewer.loadScene`),
    //   then `model-loaded` and `placements-materialized` arm a NEW baseline in
    //   the TARGET mode (`src/core/engine/rv-invariants.ts:389-393`). A clean
    //   `assertClean()` here is therefore NO proof that the listeners are
    //   stable. That is why the exit before the save goes to 'viewer' like in
    //   the 9.1 tests: an exit to 'planner' put the baseline on
    //   `planner|-|layout-planner`, and re-entering the planner on the tour
    //   reported `I3 PLC_*: 0 -> 1` — a finding about the invariant layer, not
    //   about 9.7.
    // The binding assertions and the non-vacuity (>= 2 measured entries after
    // the save) are unchanged.
    const journey = await boot(page);

    // A WRITABLE project, opened BEFORE the mode tour and only in this test: the
    // boot lands in the read-only bundled demo, where every save ends in
    // "There is no writable project to save into". Each test gets a fresh
    // browser context (own localStorage / OPFS), so nothing leaks into the
    // other tests and no cleanup is needed.
    const project = await openWritableProject(page);
    console.log(`[rv616] writable project opened=${project.opened} ${project.projectBefore} -> ${project.projectAfter}`
      + ` backend=${project.backendKind} writable=${project.writable}`
      + ` identity ${project.identityBefore} -> ${project.identityAfter} why=${project.why ?? 'ok'}`);
    test.skip(!project.opened,
      `no writable project could be opened headless: ${project.why}`);
    await journey.settle();
    expect(await page.evaluate(() => !!(window as any).viewer.currentModelRoot),
      'the demo scene is still on screen after the project switch').toBe(true);

    const mark = await warmUp(page, journey);

    const first = await enterEditor(page, journey);
    expectSameBoundDocument(first, mark);
    await editInEditor(page, 0.033);
    await leaveEditor(page, journey, 'viewer');

    // Save in the SCENE lineage: first what the Save button does (`save()`) —
    // in a writable project that places a new document for the builtin scene
    // (`_resolveSaveTarget` case 3). Only if that leaves the scene dirty does
    // the test fall back to `saveAs()` under a fresh name. Only when BOTH fail
    // is the test skipped, with both reasons.
    const saveAsName = `rv616-save-${Date.now().toString(36)}`;
    const saved = await page.evaluate(async (name: string) => {
      const store = await (window as any).__rv616SceneStore();
      if (!store.getSnapshot().dirty) throw new Error('precondition: the editor edit left the scene clean, nothing to save');
      const docBefore = store.document;
      const before = store.documentIdentity()?.kind ?? null;
      let route: 'save' | 'saveAs' | 'none' = 'none';
      let saveWhy: string | null = null;
      let saveAsWhy: string | null = null;
      try {
        const verdict = await store.save();
        if (store.getSnapshot().dirty) saveWhy = `still dirty after save() (verdict '${String(verdict)}')`;
        else route = 'save';
      } catch (e) {
        saveWhy = `save() threw: ${String(e)}`;
      }
      if (route === 'none') {
        try {
          await store.saveAs(name);
          if (store.getSnapshot().dirty) saveAsWhy = 'still dirty after saveAs()';
          else route = 'saveAs';
        } catch (e) {
          saveAsWhy = `saveAs() threw: ${String(e)}`;
        }
      }
      const docAfter = store.document;
      return {
        route,
        saveWhy,
        saveAsWhy,
        before,
        after: store.documentIdentity()?.kind ?? null,
        // The fact the expectation below is chosen by — measured, not assumed.
        sameDocObject: docAfter === docBefore,
        markAfter: docAfter?.__rv616 ?? null,
      };
    }, saveAsName);
    console.log(`[rv616] save route=${saved.route} identity ${saved.before} -> ${saved.after}`
      + ` sameDocObject=${saved.sameDocObject} save=${saved.saveWhy ?? 'ok'} saveAs=${saved.saveAsWhy ?? (saved.route === 'save' ? 'not tried' : 'ok')}`);
    test.skip(saved.route === 'none',
      `the scene could not be saved headless here — save(): ${saved.saveWhy}; saveAs('${saveAsName}'): ${saved.saveAsWhy}`);

    // The expectation after the save. `SceneStore._doc` is constructed ONCE in
    // the store's constructor (scene-store.ts `this._doc = new RvDocument(...)`,
    // the only assignment), and both `_saveIntoDocument` and `_saveAs` only call
    // `this._doc.markSaved(...)` and re-point the WORKSPACE (base, documentId,
    // documentPath) — the identity may switch `builtinModel` -> `document`, the
    // RvDocument object stays. The editor's session draft set is anchored on that
    // OBJECT, not on the identity, so the expected outcome is: same object, the
    // first entry's mark still on it, every later entry bound to it.
    // Should a save ever hand the scene a NEW RvDocument, the correct outcome is a
    // fresh bind of THAT object instead — then the first post-save entry is marked
    // anew and the next one must find the new mark. Both branches assert binding.
    let expectedMark = mark;
    if (saved.sameDocObject) {
      expect(saved.markAfter, 'the saved scene document still carries the first entry\'s mark').toBe(mark);
    } else {
      expectedMark = `rv616-after-save-${Math.random().toString(36).slice(2)}`;
      console.log('[rv616] the save replaced the scene RvDocument — expecting a fresh bind with a new mark');
    }

    let measured = 0;
    for (let pass = 0; pass < 2; pass++) {
      await tourOtherModes(page, journey);
      const again = await enterEditor(page, journey);
      measured++;
      // Logged, not asserted: which identity the scene has at the measured entry.
      const identityKind = await page.evaluate(async () =>
        (await (window as any).__rv616SceneStore()).documentIdentity()?.kind ?? null);
      console.log(`[rv616] 9.7 identity at measured entry ${measured}: ${identityKind}`);
      if (!saved.sameDocObject && pass === 0) {
        expect(again.isBound, 'the first entry after the save binds the new scene document').toBe(true);
        expect(again.sameAsScene, 'the first entry after the save holds the new scene document').toBe(true);
        expect(again.mark, 'the new scene document is not the marked one').not.toBe(mark);
        await markInner(page, expectedMark);
      } else {
        expectSameBoundDocument(again, expectedMark);
      }
      await leaveEditor(page, journey, 'viewer');
    }
    expect(measured, 'non-vacuity: two editor entries after the save').toBe(2);
    await journey.assertClean();
  });
});
