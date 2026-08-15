// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-716 §9.6 / F9 — the scene CATALOGUE is gone, and stays gone.
 *
 * F1 is a claim about the whole tree, not about one module: "no code path
 * writes a catalogue row or mints a `scn_` id". A claim of that shape cannot be
 * checked by testing behaviour — a second minter added next year would have its
 * own passing tests. So this scans the inlined source text
 * (`import.meta.glob('?raw')`, the `json-removal-guard` pattern), because a
 * symbol that has stopped being *imported* can still be sitting there being
 * called.
 *
 * ## What is deliberately still allowed
 *
 * The `rv-scenes/*` keyspace is not forbidden, only its use as a catalogue of
 * user content. Three readers survive on purpose and are asserted BY NAME
 * below, so that the allow-list is a decision someone has to edit rather than a
 * gap someone can slip through:
 *
 *  - `rv-workspace-migration.ts` — converts the rows and retires them.
 *  - `project-store.ts` — the folder-project scene cache that
 *    `rv-project-conflict.ts` compares against (§2.3 step 0, risk 12). It is
 *    the one thing in this plan that outlives Phase 6, and it does so because
 *    moving the comparison onto document revisions would make it WEAKER, not
 *    because it was forgotten.
 *  - `rv-scene-storage.ts` itself, which owns the keys.
 *
 * Everything the alias path needs is a READ and stays forever: `scn_` still
 * appears in strip regexes, in the retired namespace and in the permanent
 * alias map. Those are matched on, never minted.
 */

import { describe, it, expect } from 'vitest';

const rawSources = import.meta.glob('../src/**/*.{ts,tsx}', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/**
 * The same sources with comments removed.
 *
 * The scan has to be over CODE. Deleting a symbol in this codebase means
 * leaving a tombstone comment in its place — that is the house style and it is
 * what makes the next reader stop looking for it — so a scan over raw text
 * would report every removal as a survivor and force the deletions to be
 * silent. Crude on purpose: a `//` inside a string literal would be
 * mis-stripped, which costs a false NEGATIVE on one line and is worth the
 * trade against being unable to document anything.
 */
const sources: Record<string, string> = Object.fromEntries(
  Object.entries(rawSources).map(([path, text]) => [
    path,
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
  ]),
);

/** `../src/core/hmi/scene/scene-store.ts` → `scene-store.ts`. */
function basename(path: string): string {
  return path.split('/').pop()!;
}

function filesMatching(re: RegExp): string[] {
  return Object.entries(sources)
    .filter(([, text]) => re.test(text))
    .map(([path]) => basename(path))
    .sort();
}

describe('plan-716 F9 — the scan itself is real', () => {
  it('sees a plausible number of source files', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(200);
  });
});

// ─── Nothing mints a scene id ───────────────────────────────────────────

describe('plan-716 F1 — no code path mints a `scn_` id', () => {
  it('`newSceneId` exists nowhere under src/', () => {
    // The one minter there ever was. Tests that need the pre-migration shape
    // use `tests/helpers/legacy-scene-id.ts`, which is a fixture and says so.
    expect(filesMatching(/\bnewSceneId\b/)).toEqual([]);
  });

  it('nothing builds a `scn_` id out of parts', () => {
    // The shape `newSceneId()` produced: a `scn_` literal being CONCATENATED
    // rather than compared. A re-implementation under another name would look
    // exactly like this and would otherwise pass the check above.
    expect(filesMatching(/['"`]scn_['"`]\s*\+/)).toEqual([]);
    expect(filesMatching(/`scn_\$\{/)).toEqual([]);
  });

  it('`scn_` survives only as something being READ', () => {
    // Not an emptiness assertion: the strip regexes, the migration's filter and
    // the MCP alias's own documentation all still name the prefix, and must
    // keep doing so — an old id has to keep resolving forever. This pins WHICH
    // files may mention it in code, so a sixth is a decision somebody makes.
    expect(filesMatching(/scn_/)).toEqual([
      'mcp-bridge-plugin.ts',        // "tolerates a pre-migration scn_ id" — a doc string
      'rv-project-folder-writer.ts', // strips the prefix off a file name
      'rv-project-types.ts',         // strips the prefix off a file name
      'rv-scene-types.ts',           // the id shape, in a field comment
      'rv-workspace-migration.ts',   // recognises a row it has still to convert
    ]);
  });
});

// ─── Nothing writes the catalogue ───────────────────────────────────────

describe('plan-716 F1 — no code path writes the catalogue', () => {
  it('exactly one module names the index key', () => {
    // Even the migration goes through `listMetas()` / `removeScenesFromIndex()`
    // rather than touching the key: one module owns the keyspace, so there is
    // one place to look when it finally goes.
    expect(filesMatching(/rv-scenes-index/)).toEqual(['rv-scene-storage.ts']);
  });

  it('`writeScene` from rv-scene-storage has exactly the allowed importers', () => {
    // Import-shaped rather than call-shaped on purpose: `writeScene` is also a
    // `ProjectBackend` METHOD (a file write, and a different thing entirely),
    // so a bare name scan would flag every backend. What must stay closed is
    // the door into the localStorage module.
    const importers = Object.entries(sources)
      .filter(([, text]) => /from '[^']*rv-scene-storage'/.test(text))
      .filter(([, text]) => /\bwriteScene\b/.test(
        text.match(/import\s*\{([^}]*)\}\s*from '[^']*rv-scene-storage'/s)?.[1] ?? '',
      ))
      .map(([path]) => basename(path))
      .sort();
    expect(importers).toEqual(['project-store.ts']);
  });

  it('SceneStore imports no writing half of the catalogue at all', () => {
    const sceneStore = Object.entries(sources)
      .find(([path]) => basename(path) === 'scene-store.ts')![1];
    const imported = sceneStore
      .match(/import\s*\{([^}]*)\}\s*from '\.\/rv-scene-storage'/s)?.[1] ?? '';
    // What it may still take: the alias-resolving active-id read, the row read
    // the folder cache fills, and the two dead-slot cleaners.
    const names = imported.split(',').map(s => s.trim()).filter(Boolean).sort();
    expect(names).toEqual(['clearDraft', 'clearSceneDraft', 'readActiveId', 'readScene']);
  });
});

// ─── The catalogue's own API is gone ────────────────────────────────────

describe('plan-716 Phase 6 — the deleted symbols', () => {
  const FORBIDDEN = [
    // The two-tier scene merge, replaced by `mergeDocumentTiers` (plan-413).
    'mergeSceneTiers',
    'forkSceneEntry',
    'TieredSceneEntry',
    // The snapshot mirror the dashboard was moved off in Phase 5.
    'getProjectScenes',
    'getProjectSceneIds',
    // The browser backend's derivation of a listing from the index.
    'isCatalogueSceneDocument',
    'adoptsUnowned',
    // The SceneStore catalogue accessors and their refresh.
    'listBuiltins',
    'refreshScenesFromStorage',
    '_refreshScenes',
  ];

  for (const symbol of FORBIDDEN) {
    it(`no source mentions ${symbol}`, () => {
      expect(filesMatching(new RegExp(`\\b${symbol}\\b`))).toEqual([]);
    });
  }

  it('no backend declares `listScenes` any more', () => {
    // `listDocuments()` is the one listing. A backend that grew a scene-shaped
    // half back would split the answer again, which is the split this plan
    // exists to remove.
    expect(filesMatching(/\blistScenes\b/)).toEqual([]);
  });
});

// ─── The webScene* MCP aliases are off the catalogue (risk 11) ──────────

describe('plan-716 risk 11 — the older MCP family is on document ops', () => {
  const mcpFiles = ['mcp-bridge-plugin.ts', 'rv-mcp-project-tools.ts'];

  for (const file of mcpFiles) {
    it(`${file} reads built-in SOURCES from the model catalogue, not the scene store`, () => {
      const text = Object.entries(sources).find(([p]) => basename(p) === file)![1];
      // The ordering rule of Phase 6: the rewiring had to land BEFORE the
      // deletion, and this is what says it did.
      expect(text).toMatch(/\bbuiltinSources\b/);
      expect(text).not.toMatch(/store\.listBuiltins\b/);
      expect(text).not.toMatch(/store\.listScenes\b/);
    });
  }
});
