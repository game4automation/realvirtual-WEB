// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-717 §9.5 — a file that arrived from outside becomes a real document.
 *
 * ── WHAT THIS PROVES ────────────────────────────────────────────────────────
 * The promise of plan-717 is one registration model: every file a writable
 * project owns has an authored row with an id that a rename does not change.
 * Each half has its own unit net — the adopt verb, the delta commit, the tree
 * move, the name-follows rule. What no unit net can show is the four of them in
 * the order a real session puts them in, in a real browser, against real OPFS
 * and a real live `ProjectStore`:
 *
 *   1. bytes exist under `library/` with NO manifest row — the pre-717 state,
 *      and the state an externally-placed file starts in;
 *   2. a rescan adopts them: one authored row, at the id the path derives, so
 *      an `assetId` written before the upgrade still resolves (§2.5, F8);
 *   3. a rename moves the row's name AND the file, in one route;
 *   4. and the id is the SAME id afterwards — which is the entire point, since
 *      a miss in the reference resolver is a silent `null`, not an error.
 *
 * Step 4 is the one that used to fail. Rename was copy + delete, the row was
 * re-derived from the new path, and every saved placement pointing at the old
 * id quietly stopped resolving.
 *
 * ── DELIBERATE CUTS ─────────────────────────────────────────────────────────
 * **OPFS, not a folder project** (R1-T8). `showDirectoryPicker()` opens a native
 * OS dialog that Playwright cannot drive, so an FSA folder project is not
 * scriptable at all. The browser project *My Workspace* is: `page.evaluate` can
 * put bytes into it without a row, which is exactly the shape the adopt verb
 * has to handle. The folder backend's own contract is covered by the
 * `describe.each` fixtures in `adopt-discovered-documents.test.ts`.
 *
 * **The rename runs the dashboard's modules, not its React callback.** A
 * `useCallback` closure is not reachable from `page.evaluate`, so the four calls
 * `renameLibraryAsset` composes — `buildDashboardTree` → `buildProjectTree` →
 * `canRenameInTree` → `planTreeMove` → `applyTreeMove` → `rescanDocuments` — are
 * composed here in the same order against the same live store. That the
 * callback composes exactly these is pinned in `projects-dashboard-tree.test.tsx`
 * and `registration-characterization.test.ts`; what is proven HERE is that the
 * composition works end to end on real storage.
 */

import { test, expect, type Page } from 'playwright/test';

/** The "externally placed" file this spec plants, relative to the project. */
const REL_PATH = 'library/E2E Adopted Roller.glb';
const RENAMED_PATH = 'library/E2E Renamed Roller.glb';

const MODULE_PATHS = {
  projectStore: '/src/core/project/project-store.ts',
  identity: '/src/core/project/rv-asset-identity.ts',
  documents: '/src/core/project/rv-project-documents.ts',
  emptyGlb: '/src/core/hmi/scene/empty-glb.ts',
  tree: '/src/core/project/rv-project-tree.ts',
  treeSources: '/src/core/project/rv-project-tree-sources.ts',
  treeMove: '/src/core/project/rv-project-tree-move.ts',
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

interface PlantResult {
  planted: boolean;
  why?: string;
  /** The id `stableDocumentId` derives for the planted path. */
  expectedId?: string;
  /** Rows present BEFORE the rescan — must not include the planted path. */
  rowsBefore?: string[];
}

/**
 * Put bytes under `library/` with no manifest row, the way something outside
 * the app would.
 *
 * Returns `{ planted: false }` rather than throwing when the running build has
 * no writable project — asserting adoption against a read-only project would be
 * asserting the opposite rule (§2.3: read-only never adopts).
 */
async function plantUnregisteredFile(page: Page): Promise<PlantResult> {
  return page.evaluate(async ({ paths, relPath }) => {
    const [projectStore, identity, documents, emptyGlb] = await Promise.all([
      import(/* @vite-ignore */ paths.projectStore),
      import(/* @vite-ignore */ paths.identity),
      import(/* @vite-ignore */ paths.documents),
      import(/* @vite-ignore */ paths.emptyGlb),
    ]);

    const store = projectStore.getProjectStore();
    const backend = store.getBackend();
    if (!backend?.writable) {
      return { planted: false, why: 'this build opened no writable project' };
    }

    // Bytes only. Deliberately NOT `createDocument` — the whole case is a file
    // that exists before anything has registered it.
    try {
      await backend.writeBlob(relPath, emptyGlb.buildEmptyGlbBlob());
    } catch (e) {
      return { planted: false, why: `the GLB could not be written: ${String(e)}` };
    }
    if (!(await backend.readBlobUrl(relPath))) {
      return { planted: false, why: 'the GLB did not land in OPFS' };
    }

    return {
      planted: true,
      expectedId: identity.previewAssetId(relPath),
      rowsBefore: documents
        .documentsOf(store.getProject())
        .map((d: { path: string }) => d.path),
    };
  }, { paths: MODULE_PATHS, relPath: REL_PATH });
}

/** Run the adopt sweep the way a rescan does, and report the rows it left. */
async function rescanAndRead(page: Page): Promise<{
  rows: { id: string; name: string; path: string; section: string }[];
}> {
  return page.evaluate(async (paths) => {
    const [projectStore, documents] = await Promise.all([
      import(/* @vite-ignore */ paths.projectStore),
      import(/* @vite-ignore */ paths.documents),
    ]);
    const store = projectStore.getProjectStore();
    await store.rescanDocuments();
    return {
      rows: documents
        .documentsOf(store.getProject())
        .map((d: { id: string; name: string; path: string; section: string }) => ({
          id: d.id, name: d.name, path: d.path, section: d.section,
        })),
    };
  }, MODULE_PATHS);
}

/** Rename through the route the dashboard's "Rename…" composes. */
async function renameThroughTheDashboardRoute(page: Page, newFileName: string): Promise<{
  ok: boolean;
  why?: string;
  manifestRows?: number;
  rows?: { id: string; name: string; path: string }[];
  bytesAtOld?: boolean;
  bytesAtNew?: boolean;
}> {
  return page.evaluate(async ({ paths, relPath, fileName }) => {
    const [projectStore, documents, tree, treeSources, treeMove] = await Promise.all([
      import(/* @vite-ignore */ paths.projectStore),
      import(/* @vite-ignore */ paths.documents),
      import(/* @vite-ignore */ paths.tree),
      import(/* @vite-ignore */ paths.treeSources),
      import(/* @vite-ignore */ paths.treeMove),
    ]);

    const store = projectStore.getProjectStore();
    const backend = store.getBackend();
    const project = store.getProject();
    if (!backend?.writable || !project) return { ok: false, why: 'no writable project' };

    // 1. the tree the dashboard renders, from the rows the store holds
    const built = treeSources.buildDashboardTree({
      project: {
        id: project.id,
        name: project.name,
        writable: true,
        documents: documents.documentsOf(project),
        attachments: [],
      },
      catalogs: [],
    });
    const roots = tree.buildProjectTree(built.roots);
    const nodePath = `${project.id}/${relPath}`;
    if (!tree.findTreeNode(roots, nodePath)) {
      return { ok: false, why: `no tree node at "${nodePath}"` };
    }

    // 2. the same verdict the inline editor runs, and the plan it produces
    const verdict = tree.canRenameInTree(roots, nodePath, fileName);
    if (!verdict.ok) return { ok: false, why: `rename refused: ${verdict.reason}` };
    const plan = tree.planTreeMove(roots, nodePath, verdict);

    // 3. the IO the host builds per call, over the live backend and store
    const readBytes = async (p: string): Promise<Blob | null> => {
      const resolved = await backend.readBlobUrl(p);
      if (!resolved) return null;
      try { return await (await fetch(resolved.url)).blob(); } finally { resolved.release(); }
    };
    const outcome = await treeMove.applyTreeMove({
      readBytes,
      writeBytes: (p: string, b: Blob) => backend.writeBlob(p, b),
      deleteBytes: (p: string) => backend.deleteBlob(p),
      readManifest: async () => store.getProject(),
      writeManifest: (next: unknown) => store.replaceManifest(next),
    }, plan);

    // 4. what the host does after every tree edit, or the card keeps the old name
    await store.rescanDocuments();

    return {
      ok: true,
      manifestRows: outcome.manifestRows,
      rows: documents
        .documentsOf(store.getProject())
        .map((d: { id: string; name: string; path: string }) => ({
          id: d.id, name: d.name, path: d.path,
        })),
      bytesAtOld: (await readBytes(relPath)) !== null,
      bytesAtNew: (await readBytes(plan.to)) !== null,
    };
  }, { paths: MODULE_PATHS, relPath: REL_PATH, fileName: 'E2E Renamed Roller.glb' });
}

test.describe('an unregistered library file, adopted and then renamed (plan-717)', () => {
  test.describe.configure({ mode: 'default' });

  test('the rescan gives it a row, and the rename keeps the id', async ({ page }) => {
    test.setTimeout(240_000);

    // ── 1. bytes under library/, no row ───────────────────────────────────
    await bootBare(page);
    const planted = await plantUnregisteredFile(page);
    if (!planted.planted) test.skip(true, planted.why ?? 'the file could not be planted');

    expect(planted.rowsBefore, 'the planted file starts with no row')
      .not.toContain(REL_PATH);
    const expectedId = planted.expectedId!;

    // ── 2. the rescan adopts it ───────────────────────────────────────────
    const adopted = await rescanAndRead(page);
    const row = adopted.rows.find(r => r.path === REL_PATH);
    expect(row, 'the rescan adopted the planted file into a row').toBeTruthy();
    // The path derivation, not a random id — which is what makes an `assetId`
    // written into a saved GLB before the upgrade still resolve (§2.5, F8).
    expect(row!.id).toBe(expectedId);
    expect(row!.name).toBe('E2E Adopted Roller');
    expect(row!.section).toBe('library');

    // Idempotent: a second rescan finds nothing to do and changes nothing.
    const again = await rescanAndRead(page);
    expect(again.rows.filter(r => r.path === REL_PATH)).toHaveLength(1);
    expect(again.rows.find(r => r.path === REL_PATH)!.id).toBe(expectedId);

    // ── 3. + 4. the rename: name and file follow, the id does not ─────────
    const renamed = await renameThroughTheDashboardRoute(page, 'E2E Renamed Roller.glb');
    expect(renamed.ok, renamed.why ?? 'the rename route ran').toBe(true);
    expect(renamed.manifestRows).toBe(1);

    const after = renamed.rows!.find(r => r.id === expectedId);
    expect(after, 'the row is still there under the SAME id').toBeTruthy();
    expect(after!.path).toBe(RENAMED_PATH);
    expect(after!.name).toBe('E2E Renamed Roller');
    // Exactly one row for this document — a rename that left a second row
    // behind would be the copy+delete model wearing the new route's name.
    expect(renamed.rows!.filter(r => r.path === RENAMED_PATH)).toHaveLength(1);
    expect(renamed.rows!.some(r => r.path === REL_PATH)).toBe(false);

    // And the bytes went with it.
    expect(renamed.bytesAtNew).toBe(true);
    expect(renamed.bytesAtOld).toBe(false);
  });
});
