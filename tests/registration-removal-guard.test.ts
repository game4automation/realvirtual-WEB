// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-717 §9.5 / F9 — one registration model, and it stays the only one.
 *
 * F1 is a claim about the whole tree, not about one module: "no in-app path
 * writes bytes without a row, and no code path writes document metadata into a
 * second home". A claim of that shape cannot be checked by testing behaviour —
 * a verb re-added next year would arrive with its own passing tests. So this
 * scans the inlined source text (`import.meta.glob('?raw')`), the pattern
 * `scene-removal-guard.test.ts` established for plan-716.
 *
 * Three things are guarded, and they are the three ways the old split could
 * grow back:
 *
 *  1. **The blob-only verbs are gone.** `createEmptyAsset`, `renameAsset`,
 *     `duplicateAsset`, `deleteAsset`, `moveSidecarEntry` — each wrote bytes
 *     past the manifest, which is what made a document's id a function of its
 *     current path and let a rename break an `assetId` reference silently.
 *  2. **Nothing writes a sidecar.** The write API is deleted and the file is
 *     touched in exactly two ways: parsed once by the ingestion, then deleted.
 *     Two homes for collections is the failure §2.4 removed; a build that keeps
 *     refreshing `library.json` is how the old values resurrect after a copy.
 *  3. **`stableDocumentId` is called only where an id is BORN.** Re-deriving an
 *     id from a path anywhere else is the pre-717 model wearing a new name: it
 *     answers differently the moment the file moves, which is the whole bug.
 *
 * ## What is deliberately still allowed
 *
 * Each allowance below is asserted BY NAME, so a sixth entry is a decision
 * somebody has to write down rather than a gap somebody can slip through.
 */

import { describe, it, expect } from 'vitest';

const rawSources = import.meta.glob('../src/**/*.{ts,tsx}', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/**
 * The same sources with comments removed.
 *
 * The scan has to be over CODE. Deleting a symbol in this codebase means
 * leaving a tombstone comment in its place — that is the house style, and it is
 * what makes the next reader stop looking for it — so a scan over raw text
 * would report every one of this phase's removals as a survivor. Crude on
 * purpose: a `//` inside a string literal is mis-stripped, which costs a false
 * NEGATIVE on one line and is worth the trade against being unable to document
 * anything.
 */
const sources: Record<string, string> = Object.fromEntries(
  Object.entries(rawSources).map(([path, text]) => [
    path,
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
  ]),
);

/** `../src/core/library/library-asset-ops.ts` → `library-asset-ops.ts`. */
function basename(path: string): string {
  return path.split('/').pop()!;
}

function filesMatching(re: RegExp): string[] {
  return Object.entries(sources)
    .filter(([, text]) => re.test(text))
    .map(([path]) => basename(path))
    .sort();
}

/** The names a module takes out of `from '…<module>'`, across all files. */
function importersOf(module: string, symbol: string): string[] {
  const from = new RegExp(`import\\s*(?:type\\s*)?\\{([^}]*)\\}\\s*from '[^']*${module}'`, 'gs');
  return Object.entries(sources)
    .filter(([, text]) => [...text.matchAll(from)]
      .some(m => new RegExp(`\\b${symbol}\\b`).test(m[1])))
    .map(([path]) => basename(path))
    .sort();
}

describe('plan-717 F9 — the scan itself is real', () => {
  it('sees a plausible number of source files', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(200);
  });
});

// ─── 1. The blob-only create/rename/duplicate/delete verbs ──────────────

describe('plan-717 F1/F6 — no code path writes bytes without a row', () => {
  /** Each with the row-based verb that replaced it. */
  const REPLACED: Record<string, string> = {
    createEmptyAsset: 'createDocument(store, name, { folder })',
    renameAsset: 'runTreeEdit / applyTreeMove',
    duplicateAsset: 'duplicateDocument',
    deleteAsset: 'deleteDocument',
    moveSidecarEntry: 'nothing — collections ride the row applyTreeMove repoints',
  };

  for (const [symbol, replacement] of Object.entries(REPLACED)) {
    it(`nothing calls ${symbol} — use ${replacement}`, () => {
      // Call-shaped rather than name-shaped, for one reason worth stating:
      // `'renameAsset'` also survives as a DIALOG KIND string literal in
      // `ProjectsDashboardHost` (`{ kind: 'renameAsset' | 'collections' | … }`),
      // which is a UI discriminant and not this verb. A bare name scan would
      // flag it and the only way to pass would be to rename an unrelated union.
      expect(filesMatching(new RegExp(`\\b${symbol}\\s*\\(`))).toEqual([]);
    });

    it(`nothing imports ${symbol} either`, () => {
      // The other half: a symbol can be imported and passed around as a value
      // without ever appearing call-shaped. Both doors, or neither is closed.
      expect(importersOf('library-asset-ops', symbol)).toEqual([]);
    });
  }

  it('library-asset-ops exports only the row-based verbs', () => {
    const text = Object.entries(sources)
      .find(([p]) => basename(p) === 'library-asset-ops.ts')![1];
    const exported = [...text.matchAll(/export\s+(?:async\s+)?function\s+(\w+)/g)]
      .map(m => m[1]).sort();
    // Cross-source transfer (row route since plan-413) and the collections
    // write (row route since §2.4). Nothing else creates or moves a document.
    expect(exported).toEqual([
      'copyDocumentAcrossSources',
      'moveDocumentAcrossSources',
      'setAssetCollections',
    ]);
  });
});

// ─── 2. The sidecar is read once and then deleted ───────────────────────

describe('plan-717 F4/F9 — no code path writes a sidecar', () => {
  const WRITE_API = ['withAssetMeta', 'writeSidecarAt', 'withRenamedAsset', 'serialiseSidecar'];

  for (const symbol of WRITE_API) {
    it(`${symbol} exists nowhere under src/`, () => {
      expect(filesMatching(new RegExp(`\\b${symbol}\\b`))).toEqual([]);
    });
  }

  it('`resolveAssetMeta` is gone with them', () => {
    // Not a write, but the same deletion: it was the READ half of the sidecar
    // loop and had zero production callers from plan-413 until Phase 4. The
    // folder-derived fallback it applied is the catalog's folder chips now.
    expect(filesMatching(/\bresolveAssetMeta\b/)).toEqual([]);
  });

  it('exactly three modules name the sidecar file at all', () => {
    expect(filesMatching(/SIDECAR_FILENAME|SIDECAR_PATH/)).toEqual([
      'library-sidecar-ingest.ts',   // re-keys a parsed sidecar into the rows
      'library-sidecar.ts',          // owns the name and the parser
      'project-store.ts',            // reads it once, deletes it after the commit
    ]);
  });

  it('the one module that touches the file only reads and deletes it', () => {
    const store = Object.entries(sources)
      .find(([p]) => basename(p) === 'project-store.ts')![1];
    const calls = [...store.matchAll(/\.(\w+)\(\s*SIDECAR_PATH/g)].map(m => m[1]).sort();
    // R1-S3's ordering rule made visible as a shape: the only verbs are a read
    // and a delete, and the delete is unreachable unless the rows are durable.
    expect([...new Set(calls)]).toEqual(['deleteDocument', 'readDocument']);
  });

  it('the library ops layer has no sidecar knowledge left', () => {
    // It used to be the sidecar's principal author. Now it does not import the
    // module at all — the file layout of `library/` and the manifest's
    // coordinate system meet in `library-sidecar-ingest.ts` and nowhere else.
    expect(filesMatching(/from '[^']*library-sidecar'/)).toEqual([
      'library-sidecar-ingest.ts',
      'project-store.ts',
    ]);
  });
});

// ─── 3. Ids are minted, never re-derived for display ────────────────────

describe('plan-717 F9 — `stableDocumentId` is called only where an id is born', () => {
  it('has exactly the allowed call sites', () => {
    // A path-derived id answers differently once the file moves. That is fine
    // at BIRTH — it is what makes the id reproducible and keeps a pre-717
    // reference resolving (§2.5) — and wrong everywhere else, because a display
    // path that re-derives is the scan-world registration model growing back.
    expect(filesMatching(/\bstableDocumentId\s*\(/)).toEqual([
      // The mint itself: `previewAssetId()` is the intent-named wrapper the
      // adopt verb and the reference resolver share.
      'rv-asset-identity.ts',
      // `createDocument`: the id of a document being created, probed for
      // collisions against the ids already taken.
      'rv-document-ops.ts',
      // The manifest migration's `mintId` default — ids for rows lifted out of
      // the legacy `scenes[]`/`models[]`/`library[]` arrays.
      'rv-project-documents-migration.ts',
      // Owns the function, plus the `mintId` DEFAULT of `documentsFromLists` /
      // `documentOfAssetEntry` / `documentOfSceneEntry`. That default is the
      // transient display row §2.3 allows and needs: a read-only project
      // (bundled, HTTP) can never own rows, and a writable one shows a file in
      // the same pass that adopts it. Neither is ever persisted from here.
      'rv-project-documents.ts',
      // The fourth mint site, at boot, before any project is open (R1-A3).
      // Same function over the same path as the adopt verb would use, so the
      // two agree by construction and cannot collide.
      'rv-workspace-migration.ts',
    ]);
  });

  it('no display or catalog module derives an id from a path', () => {
    // Stated as the negative it protects, over the three layers a user's list
    // is actually built from. `toCatalogEntry` reads `doc.id` off the row.
    for (const file of ['project-library-provider.ts', 'library-store.ts', 'scene-store.ts']) {
      const text = Object.entries(sources).find(([p]) => basename(p) === file)![1];
      expect([file, /\bstableDocumentId\s*\(/.test(text)]).toEqual([file, false]);
      expect([file, /\bpreviewAssetId\s*\(/.test(text)]).toEqual([file, false]);
    }
  });
});
