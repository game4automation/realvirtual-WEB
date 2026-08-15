// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-716 §9.6 — an OLD `?scene=scn_…` link opens the migrated document.
 *
 * ── WHAT THIS PROVES ────────────────────────────────────────────────────────
 * The decision the user was asked for was "convert them all", and the promise
 * attached to it was that the links keep working. Every part of that promise is
 * a different subsystem — the eager migration, the permanent alias map, the
 * boot router, the one open verb — and each has its own unit net. What no unit
 * net can show is the four of them in the order a real reload puts them in, in
 * a real browser, against real localStorage and real OPFS:
 *
 *   1. a pre-migration catalogue row and its GLB body exist before boot;
 *   2. the FIRST boot converts them — awaited inside `resolveActiveProject()`,
 *      so the alias map exists by the time the router reads it (§2.3);
 *   3. a link carrying the OLD id is redirected to `?doc=<documentId>` with
 *      `replaceState`, so a bookmark or a re-share carries the new identity;
 *   4. and the document that opens is the converted one, by name.
 *
 * Step 2 is the one that cannot be faked here. The ordering it depends on is a
 * boot anchor, not a call — writing the alias by hand would assert steps 3 and 4
 * against a premise the product never established.
 *
 * ── DELIBERATE CUT ──────────────────────────────────────────────────────────
 * Headless Chromium has no work folder, so the project underneath is the
 * implicit browser project "My Workspace" (Phase 1) rather than a folder
 * project. That is the case the migration exists for: a folder project's scenes
 * were already documents, and its localStorage rows are CACHE rows the
 * migration deliberately skips (§2.3 step 0).
 */

import { test, expect, type Page } from 'playwright/test';

/** The pre-migration scene this spec plants. */
const LEGACY_ID = 'scn_e2e716_link';
const LEGACY_NAME = 'Legacy Link Cell';

const MODULE_PATHS = {
  storage: '/src/core/hmi/scene/rv-scene-storage.ts',
  glbStore: '/src/core/storage/rv-scene-glb-store.ts',
  emptyGlb: '/src/core/hmi/scene/empty-glb.ts',
  migration: '/src/core/project/rv-workspace-migration.ts',
  alias: '/src/core/project/rv-doc-alias.ts',
  documents: '/src/core/project/rv-project-documents.ts',
  projectStore: '/src/core/project/project-store.ts',
};

async function bootBare(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 30_000 });
  await page.waitForFunction(
    () => !!(window as unknown as Record<string, unknown>).viewer,
    null,
    { timeout: 30_000 },
  );
  await page.waitForTimeout(2_000);
}

/**
 * Plant a pre-migration scene and rewind the migration so the next boot sees it.
 *
 * Returns `{ planted: false }` rather than throwing when the build cannot reach
 * OPFS — a body that was never written would make the migration classify the
 * row as legacy junk, and the spec would then assert against a case it did not
 * mean to construct.
 */
async function plantLegacyScene(page: Page): Promise<{ planted: boolean; why?: string }> {
  return page.evaluate(async (paths) => {
    const [storage, glbStore, emptyGlb, migration, alias] = await Promise.all([
      import(/* @vite-ignore */ paths.storage),
      import(/* @vite-ignore */ paths.glbStore),
      import(/* @vite-ignore */ paths.emptyGlb),
      import(/* @vite-ignore */ paths.migration),
      import(/* @vite-ignore */ paths.alias),
    ]);

    // Rewind: forget the marker and empty the graveyard, so the next boot does
    // the conversion for real instead of recognising it as already done.
    migration.__resetWorkspaceMigrationForTests();
    alias.clearAllDocumentAliases();

    const now = new Date().toISOString();
    storage.writeScene({
      id: 'scn_e2e716_link',
      name: 'Legacy Link Cell',
      createdAt: now,
      modifiedAt: now,
      schemaVersion: 3,
      base: { kind: 'empty' },
      edits: { ops: [], settings: { catalogUrls: [], gridSizeMm: 500 } },
    });

    try {
      const bytes = new Uint8Array(await emptyGlb.buildEmptyGlbBlob().arrayBuffer());
      await glbStore.writeSceneGlb('scn_e2e716_link', bytes);
    } catch (e) {
      return { planted: false, why: `the GLB body could not be written: ${String(e)}` };
    }
    if (!glbStore.readSceneGlbPointer('scn_e2e716_link')) {
      return { planted: false, why: 'the GLB body did not land in OPFS' };
    }
    return { planted: true };
  }, MODULE_PATHS);
}

/** What the running app knows about the planted scene after a boot. */
async function readState(page: Page): Promise<{
  aliasTarget: string | null;
  rowStillInIndex: boolean;
  documents: { id: string; name: string; path: string }[];
}> {
  return page.evaluate(async (paths) => {
    const [storage, alias, documents, projectStore] = await Promise.all([
      import(/* @vite-ignore */ paths.storage),
      import(/* @vite-ignore */ paths.alias),
      import(/* @vite-ignore */ paths.documents),
      import(/* @vite-ignore */ paths.projectStore),
    ]);
    return {
      aliasTarget: alias.resolveDocumentAlias('scn_e2e716_link'),
      rowStillInIndex: storage.listMetas()
        .some((m: { id: string }) => m.id === 'scn_e2e716_link'),
      documents: documents
        .documentsOf(projectStore.getProjectStore().getProject())
        .map((d: { id: string; name: string; path: string }) => ({
          id: d.id, name: d.name, path: d.path,
        })),
    };
  }, MODULE_PATHS);
}

test.describe('an old ?scene= link after the migration (plan-716)', () => {
  test.describe.configure({ mode: 'default' });

  test('the eager migration converts the row, and the old link opens the document', async ({ page }) => {
    test.setTimeout(240_000);

    // ── 1. a pre-migration world ──────────────────────────────────────────
    await bootBare(page);
    const planted = await plantLegacyScene(page);
    if (!planted.planted) test.skip(true, planted.why ?? 'the legacy scene could not be planted');

    // ── 2. the first boot converts it ─────────────────────────────────────
    await bootBare(page);
    const converted = await readState(page);

    const documentId = converted.aliasTarget;
    expect(documentId, 'the migration wrote an alias for the old id').toBeTruthy();
    // Converted, not merely aliased: the row is out of the index and the
    // document is in the project under the name the scene carried.
    expect(converted.rowStillInIndex).toBe(false);
    const row = converted.documents.find(d => d.id === documentId);
    expect(row, 'the converted document is a row in the open project').toBeTruthy();
    expect(row!.name).toBe(LEGACY_NAME);
    // A FILE, not the id-keyed body slot it came from.
    expect(row!.path).toMatch(/^scenes\/.*\.glb$/);
    // And it is a document id, never a minted scene id (F1).
    expect(documentId!.startsWith('scn_')).toBe(false);

    // ── 3. the old link redirects ─────────────────────────────────────────
    await page.goto(`/?scene=${LEGACY_ID}`, { waitUntil: 'domcontentloaded' });
    await page.waitForSelector('canvas', { timeout: 30_000 });
    await page.waitForFunction(
      () => new URLSearchParams(window.location.search).has('doc'),
      null,
      { timeout: 90_000 },
    );

    const url = new URL(page.url());
    expect(url.searchParams.get('doc')).toBe(documentId);
    // `replaceState` normalises the address bar, so a re-share or a bookmark
    // taken from here carries the new identity and not the dead one.
    expect(url.searchParams.get('scene')).toBeNull();

    // ── 4. …onto the converted document ───────────────────────────────────
    const opened = await page.evaluate(async (paths) => {
      const singleton = await import(
        /* @vite-ignore */ '/src/core/hmi/scene/scene-store-singleton.ts'
      );
      void paths;
      const snap = singleton.getSceneStore()?.getSnapshot();
      return { name: snap?.draft?.name ?? null, transient: snap?.transient ?? null };
    }, MODULE_PATHS);

    expect(opened.name).toBe(LEGACY_NAME);
    // The user's own document, not a read-only source opened over a URL.
    expect(opened.transient).toBe(false);
  });
});
