// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Legacy `?scene=` links, in a real browser. TWO link spaces, two claims:
 *
 *   1. plan-716 §9.6 — an old `?scene=scn_…` link opens the MIGRATED document
 *      (this describe block; the alias is a stored record of a conversion);
 *   2. plan-731 §9.6 / F3 — an old `?scene=published:<name>` link opens the
 *      canonical document in a browser with NO stored state (second describe
 *      block at the bottom; that alias is derived from the manifest, never
 *      stored). The two are deliberately not merged: one needs a warm profile
 *      it plants itself, the other must prove it needs none.
 *
 * ── 1. plan-716 §9.6 — an OLD `?scene=scn_…` link opens the migrated document.
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
 * Headless Chromium has no work folder, so the project the migration writes
 * into is the implicit browser project "My Workspace" (Phase 1) rather than a
 * folder project. That is the case the migration exists for: a folder
 * project's scenes were already documents, and its localStorage rows are CACHE
 * rows the migration deliberately skips (§2.3 step 0).
 *
 * ── WHAT plan-726 CHANGED HERE ──────────────────────────────────────────────
 * The deploy now publishes its own `public/project.json`, so a bare boot
 * resolves to the READ-ONLY bundled demo project instead of falling through to
 * "My Workspace". Two consequences, and they pull in opposite directions:
 *
 *   - The migration had to be UNHOOKED from the workspace branch, or it would
 *     have been skipped on every boot from now on — not just here, but in any
 *     developer profile still holding `scn_…` rows. That is plan-726 F14, and
 *     step 2 below is what proves it still runs.
 *   - Its RESULT lands in "My Workspace", which is no longer the project a
 *     bare boot leaves active. So step 2 reads the workspace manifest directly
 *     rather than the active project, and step 4 asserts that the alias points
 *     at a real document there — instead of asserting that the viewer opened
 *     it, which now depends on the user selecting that project first.
 *
 * The link promise itself is untouched and still fully asserted: the old id
 * still redirects to `?doc=<documentId>`, and that id still names a live
 * document.
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
  workspaceDefault: '/src/core/project/rv-workspace-default.ts',
};

async function bootBare(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 30_000 });
  await page.waitForFunction(
    () => !!(window as unknown as Record<string, unknown>).viewer,
    null,
    { timeout: 30_000 },
  );
  // Wait for the boot ANCHOR, not a guessed duration: the eager migration
  // runs awaited inside resolveActiveProject() and sets its marker even on a
  // profile with nothing to convert — so the marker IS the "resolution is
  // done" signal. A fixed 2s raced the plan-726 boot (root-manifest read and
  // the demo document open sit in front of it now), and a goto that fires
  // mid-resolution aborts the very migration this spec observes.
  await page.waitForFunction(
    () => {
      try { return localStorage.getItem('rv-migration/scenes-v1') !== null; }
      catch { return true; }
    },
    null,
    { timeout: 60_000 },
  );
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
    const [storage, alias, documents, workspaceDefault] = await Promise.all([
      import(/* @vite-ignore */ paths.storage),
      import(/* @vite-ignore */ paths.alias),
      import(/* @vite-ignore */ paths.documents),
      import(/* @vite-ignore */ paths.workspaceDefault),
    ]);
    // The MIGRATION's target, not the active project (plan-726). Since the
    // deploy publishes its own project.json, a bare boot leaves the read-only
    // demo open; the converted document still lands in "My Workspace", and
    // that is the manifest this spec is making claims about.
    const workspace = workspaceDefault.openWorkspaceDefaultBackend();
    const manifest = await workspace.readManifest();
    return {
      aliasTarget: alias.resolveDocumentAlias('scn_e2e716_link'),
      rowStillInIndex: storage.listMetas()
        .some((m: { id: string }) => m.id === 'scn_e2e716_link'),
      documents: documents
        .documentsOf(manifest)
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

    // ── 2. the first boot converts it (plan-726 F14) ──────────────────────
    //
    // This is now ALSO the net for F14: the migration used to hang off the
    // "My Workspace" boot branch, which a deploy-published project.json now
    // skips. If it had stayed there, this step would find nothing converted.
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
    //
    // The FULL link promise again, not the weakened one: with the
    // cross-project hop (`openScene` → `openWorkspaceProject`) the router can
    // reach a document of "My Workspace" although the bare boot leaves the
    // demo project active — so the old link does not merely resolve, it OPENS.
    //
    // Poll INSIDE one evaluate rather than waitForFunction + a second read:
    // the address bar is normalised BEFORE the open (replaceState sits above
    // the open in the route), and the open now includes a project switch — so
    // the draft appears a beat after `?doc=` does. One context, one loop, no
    // cross-call race.
    const opened = await page.evaluate(async (paths) => {
      const singleton = await import(
        /* @vite-ignore */ '/src/core/hmi/scene/scene-store-singleton.ts'
      );
      void paths;
      for (let i = 0; i < 120; i++) {
        const snap = singleton.getSceneStore()?.getSnapshot();
        if (snap?.draft?.name != null) {
          return { name: snap.draft.name, transient: snap.transient ?? null };
        }
        await new Promise(r => setTimeout(r, 500));
      }
      const snap = singleton.getSceneStore()?.getSnapshot();
      return { name: snap?.draft?.name ?? null, transient: snap?.transient ?? null };
    }, MODULE_PATHS);

    expect(opened.name).toBe(LEGACY_NAME);
    // The user's own document, not a read-only source opened over a URL.
    expect(opened.transient).toBe(false);

    // And the redirect target stays a live, permanent row of "My Workspace":
    // the alias must survive the second boot without being re-minted.
    const afterRedirect = await readState(page);
    const target = afterRedirect.documents.find(d => d.id === documentId);
    expect(target, 'the redirect target is a live document of My Workspace').toBeTruthy();
    expect(target!.name).toBe(LEGACY_NAME);
    expect(afterRedirect.aliasTarget).toBe(documentId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// plan-731 §9.6 / F3 — the OTHER legacy link space
// ═══════════════════════════════════════════════════════════════════════════

/**
 * plan-731 §9.6 (F3) — an old `?scene=published:<urlName>` link opens the same
 * document as the canonical `?doc=<id>` link, in a browser that has never seen
 * this app before.
 *
 * ── WHY THIS IS A SEPARATE CLAIM FROM THE ONE ABOVE ─────────────────────────
 * The `scn_` alias above is a localStorage RECORD written by a migration that
 * ran on one machine; its spec therefore has to plant a pre-migration world
 * first. `published:<urlName>` is the opposite kind of alias: plan-731 melted
 * the second identity space down into a mapping that is DERIVED from the served
 * manifest and never stored (`rv-published-scenes.ts`), precisely because such
 * a link is the one a STRANGER clicks — in a fresh browser, with no profile, no
 * localStorage, no OPFS body and no migration behind it.
 *
 * That is the case a unit test cannot state. `tests/published-deeplink-glb.test.ts`
 * pins `resolvePublishedAlias()` against a hand-built document array; it can say
 * the function maps a token onto a row, but not that a cold boot has that array
 * in hand BY THE TIME the boot router reads it. The order this test depends on
 * is a boot anchor — `resolveActiveProject()` must have read `/project.json`
 * before `main.ts`'s `?scene=` branch resolves the token — and the only honest
 * way to observe it is a real browser doing a real cold start.
 *
 * ── HOW "FRESH" IS ENFORCED, NOT ASSUMED ────────────────────────────────────
 *   * each boot gets its OWN `browser.newContext()` — separate localStorage,
 *     separate OPFS, nothing carried over from the migration test above or from
 *     the canonical boot it is compared against;
 *   * the run asserts that the doc-alias store holds NO record at all, so a pass
 *     cannot come from a warm profile that happened to carry one. An alias that
 *     only resolves with warm storage is exactly the failure mode F3 exists to
 *     exclude.
 *
 * ── WHAT IS ASSERTED ────────────────────────────────────────────────────────
 * The two boots are compared, not merely inspected: the legacy link and the
 * canonical link must land on the SAME `documentIdentity()` — same id, same
 * path, same name — and the legacy one must additionally normalise its address
 * bar to `?doc=<id>` with `?scene=` gone, so a re-share carries the identity
 * this build actually mints.
 *
 * The token itself is read out of the SERVED manifest rather than hard-coded,
 * so the spec keeps testing the real deployed example row if its path ever moves
 * again — with one pinned assertion that the row still answers to the concrete
 * historical link `?scene=published:DemoPlanner`, which is the literal that sat
 * in the Welcome modal until plan-731 2c replaced it.
 */

const PUBLISHED_MODULE_PATHS = {
  singleton: '/src/core/hmi/scene/scene-store-singleton.ts',
  alias: '/src/core/project/rv-doc-alias.ts',
};

/** One boot's answer to "which document am I looking at, and how did I get here?" */
type OpenedDocument = {
  docParam: string | null;
  sceneParam: string | null;
  identity: unknown;
  name: string | null;
  transient: boolean | null;
  /** Every `scn_ -> doc_` record in this profile. Empty in a cold browser. */
  aliasIds: string[];
};

/**
 * Boot `url` in `page` and read back which document ended up open.
 *
 * Polls INSIDE one `evaluate` for the same reason the migration test does: the
 * address bar is normalised BEFORE the open, so `?doc=` appearing is not yet the
 * answer — `documentIdentity()` becoming non-null is.
 */
async function openAndRead(page: Page, url: string): Promise<OpenedDocument> {
  await page.goto(url, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('canvas', { timeout: 30_000 });
  await page.waitForFunction(
    () => !!(window as unknown as Record<string, unknown>).viewer,
    null,
    { timeout: 30_000 },
  );

  const read = await page.evaluate(async (paths) => {
    const [singleton, alias] = await Promise.all([
      import(/* @vite-ignore */ paths.singleton),
      import(/* @vite-ignore */ paths.alias),
    ]);
    const sample = () => {
      const store = singleton.getSceneStore();
      const snap = store?.getSnapshot();
      return {
        identity: (store?.documentIdentity() ?? null) as unknown,
        name: (snap?.draft?.name ?? null) as string | null,
        transient: (snap?.transient ?? null) as boolean | null,
        aliasIds: alias.listDocumentAliasIds() as string[],
      };
    };
    for (let i = 0; i < 180; i++) {
      const s = sample();
      if (s.identity) return s;
      await new Promise(r => setTimeout(r, 500));
    }
    return sample();
  }, PUBLISHED_MODULE_PATHS);

  const u = new URL(page.url());
  return {
    docParam: u.searchParams.get('doc'),
    sceneParam: u.searchParams.get('scene'),
    ...read,
  };
}

test.describe('a legacy ?scene=published: link (plan-731 F3)', () => {
  test.describe.configure({ mode: 'default' });

  test('opens the canonical document in a browser with no stored state', async ({ browser, request }) => {
    test.setTimeout(300_000);

    // ── 0. the token comes from the SERVED manifest ───────────────────────
    //
    // Not from the source tree and not from a constant here: what a legacy link
    // has to meet is the manifest the deploy actually publishes, and that is the
    // same document `/project.json` hands the boot.
    const res = await request.get('/project.json');
    expect(res.ok(), 'the deploy publishes its boot manifest').toBeTruthy();
    const manifest = await res.json() as {
      documents?: { id: string; name: string; path: string; section?: string; devOnly?: boolean }[];
    };
    const row = (manifest.documents ?? [])
      .find(d => d?.section === 'scenes' && d?.devOnly !== true);
    expect(row, 'the demo manifest carries a shipped example row').toBeTruthy();

    const urlName = (row!.path.split(/[\\/]/).pop() ?? '').replace(/\.glb$/i, '');
    // The concrete historical link, pinned: this is the literal the Welcome
    // modal shipped until plan-731 2c replaced it with the document id, and the
    // one that is out in the wild in bookmarks and shared URLs.
    expect(urlName, 'the example still answers to ?scene=published:DemoPlanner').toBe('DemoPlanner');

    // ── 1. the canonical link, in its own fresh browser ───────────────────
    const canonicalCtx = await browser.newContext();
    const canonicalErrors: string[] = [];
    const canonicalPage = await canonicalCtx.newPage();
    canonicalPage.on('pageerror', e => canonicalErrors.push(String(e)));
    const canonical = await openAndRead(canonicalPage, `/?doc=${encodeURIComponent(row!.id)}`);
    await canonicalCtx.close();

    expect(canonical.identity, 'the canonical ?doc= link opens a document').toBeTruthy();
    expect(canonical.name).toBe(row!.name);
    expect(canonicalErrors, 'the canonical boot is clean').toEqual([]);

    // ── 2. the legacy link, in a SECOND fresh browser ─────────────────────
    //
    // A new context, not a new page: the point is that nothing the boot above
    // wrote — no alias record, no active-document pointer, no cached body — is
    // available to this one.
    const legacyCtx = await browser.newContext();
    const legacyErrors: string[] = [];
    const legacyPage = await legacyCtx.newPage();
    legacyPage.on('pageerror', e => legacyErrors.push(String(e)));
    const legacy = await openAndRead(legacyPage, `/?scene=published:${encodeURIComponent(urlName)}`);
    await legacyCtx.close();

    // The alias is DERIVED. If a stored record had done the work here, this
    // would pass on this machine and fail for the stranger the link is for.
    expect(
      legacy.aliasIds,
      'the published: token resolved without any stored alias record',
    ).toEqual([]);

    // ── 3. …and it is the same document, by identity ──────────────────────
    expect(legacy.identity, 'the legacy link opens a document').toBeTruthy();
    expect(legacy.identity).toEqual(canonical.identity);
    expect(legacy.name).toBe(canonical.name);
    expect(legacy.transient).toBe(canonical.transient);

    // ── 4. …with the address bar normalised onto the surviving identity ───
    expect(legacy.docParam).toBe(row!.id);
    expect(legacy.sceneParam).toBeNull();

    expect(legacyErrors, 'the legacy boot is clean').toEqual([]);
  });
});
