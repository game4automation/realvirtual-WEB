// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-479 §9.9 — a document's `scriptRef` is what loads its plugin, and it can
 * point straight at the plugin file (F1/F2/F5).
 *
 * ── WHAT THIS PROVES ────────────────────────────────────────────────────────
 * The unit nets prove each half: the drop (`tests/hero-ref-drop.test.tsx`), the
 * keyboard route (`tests/hero-ref-bind-menu.test.tsx`), the write verb
 * (`tests/project-store-connect-notify.test.ts`), the resolver
 * (`tests/model-plugin-*.test.ts`). What none of them can show is the chain in
 * a real browser, against the real Development project and the real Vite glob:
 *
 *   1. `documents[].scriptRef` names the plugin file ITSELF —
 *      `plugins/ribbon-tension-controls-plugin.tsx`, not a collecting
 *      `plugins/index.ts` (F5). There is no `index.ts` in that project any more;
 *   2. loading the bound document brings the Ribbon Tension window up, and the
 *      runtime binding state says `loaded` for exactly that ref (F2/F6);
 *   3. CLEARING the binding through the store's write path and loading the same
 *      model again brings NO window — which is the whole claim: the binding
 *      loads the plugin, not the file name (F1's negative control);
 *   4. setting it again through the same write path brings the window back.
 *
 * Step 3 is the one that carries the plan: before plan-718 the model file name
 * decided, so a cleared binding would have changed nothing at all.
 *
 * ── DELIBERATE CUTS ─────────────────────────────────────────────────────────
 * **Module level, not the UI** (Finding T2, user decision). The original §9.9
 * dragged a file card onto the hero card. That is not executable: `file-card-*`
 * exists nowhere in the repo, and there is no working way to open the project
 * dashboard from Playwright — `e2e/projects-dashboard-mobile.spec.ts` is
 * entirely `describe.skip` for that reason (the `HMIShell` CSS `zoom` subtree
 * breaks synthesised and forced clicks alike). So this spec follows
 * `e2e/document-registration.spec.ts` and drives the modules with
 * `page.evaluate`. The drag GESTURE itself — hit test, refusal, reason — is
 * covered by `tests/hero-ref-drop.test.tsx`.
 *
 * **The write goes through `ProjectStore.setDocumentScriptRef`** — the one
 * write path the hero card, the keyboard dialog and `web_document_bind` all
 * share. A project served over HTTP has a read-only backend, so the manifest
 * cannot be persisted here; the spec then applies the SAME pure edit the store
 * applies (`setDocumentRefOn`) to the live manifest and reports which of the
 * two routes it took. Either way the ref the resolver reads is the one a
 * binding produced, never a hand-written string in a fixture.
 *
 * **The project route is `control-window.spec.ts`'s**, verbatim in spirit: the
 * project must be OPEN, because without it there is no manifest and hence no
 * binding to read.
 *
 *   npx playwright test e2e/document-plugin-binding.spec.ts
 *   RV_E2E_PORT=5479 npx playwright test e2e/document-plugin-binding.spec.ts   # worktree port
 */

import { test, expect } from 'playwright/test';
import type { Page } from 'playwright/test';
import { DEV_GLB } from '../tests/fixtures/glb-paths.mjs';
import { DEV_ASSETS_SKIP_REASON, HAS_DEV_ASSETS } from './dev-assets';

/** The deploy root of the Development project, as the dev server serves it. */
const PROJECT_ROOT = '/private-assets/Development/';
const WITH_PROJECT = `/?projectUrl=${encodeURIComponent(PROJECT_ROOT)}`;

/** The document under test, and the ref Phase 8 bound it to. */
const DOC_NAME = 'DemoRibbonSlitter';
const SCRIPT_REF = 'plugins/ribbon-tension-controls-plugin.tsx';

/** The window the plugin puts on screen — the selector `control-window.spec.ts` uses. */
const PANEL = '[data-ui-panel][role="region"][aria-label="Ribbon Tension"]';

const MODULE_PATHS = {
  projectStore: '/src/core/project/project-store.ts',
  refs: '/src/core/project/rv-project-refs.ts',
  bindingState: '/src/core/rv-plugin-binding-state.ts',
  autoQuality: '/src/core/hmi/auto-quality.ts',
};

/** The boot modals, by flag rather than by click (see `control-window.spec.ts`). */
async function suppressStartupNotices(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      localStorage.setItem('rv-welcome-dismissed', 'true');
      localStorage.setItem('rv-auto-quality-applied', 'true');
    } catch { /* private mode */ }
  });
}

/** Whatever still got through. Best effort. */
async function clearModals(page: Page): Promise<void> {
  await page.evaluate(async (paths) => {
    const mod = await import(/* @vite-ignore */ paths.autoQuality);
    (mod as { clearAutoQualityNotice(): void }).clearAutoQualityNotice();
  }, MODULE_PATHS);
  await page.locator('[role="dialog"][aria-modal="true"]')
    .waitFor({ state: 'detached', timeout: 10_000 }).catch(() => {});
}

/** Open the Development project and wait for its own boot document to settle. */
async function openProject(page: Page): Promise<void> {
  await suppressStartupNotices(page);
  await page.goto(WITH_PROJECT, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 60_000 });
  // Loading over a load in flight aborts it as superseded, and the abort lands
  // in the middle of the plugin handover.
  await page.waitForFunction(
    () => !!(window as unknown as { viewer?: { currentModelUrl?: string } }).viewer?.currentModelUrl,
    undefined,
    { timeout: 60_000 },
  );
  await clearModals(page);
}

interface BindResult {
  ok: boolean;
  why?: string;
  /** Which route persisted the edit — the store's verb, or its pure edit. */
  route?: 'store' | 'manifest';
  /** The ref the live manifest carries afterwards. */
  refAfter?: string | null;
}

/**
 * Set or clear the document's `scriptRef` through the store's write path.
 *
 * `setDocumentScriptRef` first — the verb the hero card, the keyboard dialog
 * and `web_document_bind` all call. A project served over HTTP has a read-only
 * backend and the verb refuses (correctly: read-only never writes), so the
 * fallback applies the same pure edit the verb applies, `setDocumentRefOn`, to
 * the live manifest. The resolver downstream cannot tell the two apart — it
 * reads `documents[].scriptRef` — and neither route is a hand-written ref.
 */
async function bindScriptRef(page: Page, ref: string | null): Promise<BindResult> {
  return page.evaluate(async ({ paths, docName, value }) => {
    const [storeMod, refsMod] = await Promise.all([
      import(/* @vite-ignore */ paths.projectStore),
      import(/* @vite-ignore */ paths.refs),
    ]);
    const store = storeMod.getProjectStore();
    const project = store.getProject();
    if (!project) return { ok: false, why: 'no project is open' };
    const doc = (project.documents ?? []).find((d: { name?: string }) => d.name === docName);
    if (!doc) return { ok: false, why: `the project holds no document named "${docName}"` };

    let route: 'store' | 'manifest' = 'store';
    try {
      await store.setDocumentScriptRef(doc.id, value);
    } catch {
      route = 'manifest';
      await store.replaceManifest(
        refsMod.setDocumentRefOn(store.getProject(), doc.id, 'scriptRef', value),
      );
    }
    const after = (store.getProject().documents ?? [])
      .find((d: { id: string }) => d.id === doc.id) as { scriptRef?: string } | undefined;
    return { ok: true, route, refAfter: after?.scriptRef ?? null };
  }, { paths: MODULE_PATHS, docName: DOC_NAME, value: ref });
}

/** The `scriptRef` the live manifest carries for the document under test. */
async function readScriptRef(page: Page): Promise<string | null | undefined> {
  return page.evaluate(async ({ paths, docName }) => {
    const storeMod = await import(/* @vite-ignore */ paths.projectStore);
    const project = storeMod.getProjectStore().getProject();
    const doc = (project?.documents ?? [])
      .find((d: { name?: string }) => d.name === docName) as { scriptRef?: string } | undefined;
    return doc ? (doc.scriptRef ?? null) : undefined;
  }, { paths: MODULE_PATHS, docName: DOC_NAME });
}

/**
 * Load the bound document the way the app's own model switch does.
 *
 * `pendingModelUrl` is the url the engine resolves IDENTITY against — without
 * it the plugin manager keeps resolving the boot document and the spec would
 * silently test nothing (the same trap `control-window.spec.ts` documents).
 */
async function loadModel(page: Page, url: string): Promise<void> {
  await page.evaluate((u) => {
    const viewer = (window as unknown as {
      viewer: { pendingModelUrl?: string; loadModel(u: string): Promise<unknown> };
    }).viewer;
    viewer.pendingModelUrl = u;
    return viewer.loadModel(u);
  }, url);
}

/**
 * Load the tension demo and wait until its web exists.
 *
 * Preceded by a DIFFERENT model every time, and that is not scene hygiene: the
 * plugin handover is keyed on the model NAME (`onModelLoading` returns early on
 * `modelName === activeModelName`), so re-loading the same document after a
 * binding change would keep the plugins that are already registered and the
 * spec would assert against the previous state. A real session changes the
 * binding in the dashboard and comes back to the document through another one,
 * which is exactly this sequence.
 */
async function loadTensionModel(page: Page): Promise<void> {
  await loadModel(page, DEV_GLB.europalletEmpty);
  await page.waitForFunction(
    () => ((window as unknown as { viewer?: { ribbonManager?: { size?: number } } })
      .viewer?.ribbonManager?.size ?? 0) === 0,
    undefined,
    { timeout: 60_000 },
  );
  await loadModel(page, DEV_GLB.ribbonSlitter);
  await page.waitForFunction(
    () => ((window as unknown as { viewer?: { ribbonManager?: { size?: number } } })
      .viewer?.ribbonManager?.size ?? 0) > 0,
    undefined,
    { timeout: 60_000 },
  );
  await clearModals(page);
}

/** The runtime verdict the chip renders (F6). */
async function bindingState(page: Page): Promise<{ kind: string; scriptRef?: string | null }> {
  return page.evaluate(async (paths) => {
    const mod = await import(/* @vite-ignore */ paths.bindingState);
    return mod.getPluginBindingState() as { kind: string; scriptRef?: string | null };
  }, MODULE_PATHS);
}

test.describe('a document loads the plugin its scriptRef names (plan-479)', () => {
  test.skip(!HAS_DEV_ASSETS, DEV_ASSETS_SKIP_REASON);
  test.describe.configure({ mode: 'default' });

  test('the ref points at the plugin file itself, and clearing it takes the window away', async ({ page }) => {
    test.setTimeout(300_000);

    await openProject(page);

    // ── 1. F5: the binding names the plugin FILE, not a collecting index.ts ──
    const authored = await readScriptRef(page);
    expect(authored, `the project holds a document named "${DOC_NAME}"`).not.toBeUndefined();
    expect(authored).toBe(SCRIPT_REF);

    // ── 2. F2: the bound document brings the window, and says so at runtime ──
    await loadTensionModel(page);
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 30_000 });
    const loaded = await bindingState(page);
    expect(loaded.kind).toBe('loaded');
    expect(loaded.scriptRef).toBe(SCRIPT_REF);

    // ── 3. F1's negative control: no binding, no window ─────────────────────
    const cleared = await bindScriptRef(page, null);
    expect(cleared.ok, cleared.why ?? 'the binding was cleared').toBe(true);
    expect(cleared.refAfter).toBeNull();
    await loadTensionModel(page);
    await expect(page.locator(PANEL)).toHaveCount(0);
    expect((await bindingState(page)).kind).toBe('none');

    // ── 4. and setting it again through the same write path brings it back ──
    const rebound = await bindScriptRef(page, SCRIPT_REF);
    expect(rebound.ok, rebound.why ?? 'the binding was set').toBe(true);
    expect(rebound.refAfter).toBe(SCRIPT_REF);
    expect(rebound.route, 'both edits took the same route').toBe(cleared.route);
    await loadTensionModel(page);
    await expect(page.locator(PANEL)).toBeVisible({ timeout: 30_000 });
    expect((await bindingState(page)).kind).toBe('loaded');
  });
});
