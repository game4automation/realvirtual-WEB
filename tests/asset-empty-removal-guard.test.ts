// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-719 F3/F6 — the homeless asset is gone, and the save dialogs are public.
 *
 * Two claims about the whole tree, which is why neither can be checked by
 * testing behaviour: "no code path produces `kind: 'empty'` in the ASSET
 * lineage" and "the public save dialogs import nothing private" are both
 * statements a future module could violate while passing all of its own tests.
 * So this scans the inlined source text, the `scene-removal-guard` pattern.
 *
 * ## The one thing that makes this test hard, stated up front
 *
 * The SCENE lineage has its own, unrelated `kind: 'empty'` (`SceneBase`,
 * `scene-store.ts`) — the empty viewer state behind `?scene=empty`. It is not
 * being removed and must not be. So the scan cannot look for the string: it
 * looks at the ASSET-side type surface instead, and the type-level pin below
 * does the rest. A guard that matched both would either fail forever or have
 * to allow-list half the scene store, and an allow-list that big is not a guard.
 */

import { describe, it, expect } from 'vitest';
import type { AssetBase } from '../src/core/editor/rv-asset-document';
import type { RvDraftBase } from '../src/core/ops/rv-document-drafts';

const rawSources = import.meta.glob('../src/**/*.{ts,tsx}', {
  query: '?raw', import: 'default', eager: true,
}) as Record<string, string>;

/**
 * The same sources with comments removed.
 *
 * Deleting something in this codebase means leaving a tombstone comment where
 * it was — the house style, and the reason a scan over raw text would report
 * every removal as a survivor.
 */
const sources: Record<string, string> = Object.fromEntries(
  Object.entries(rawSources).map(([path, text]) => [
    path,
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''),
  ]),
);

function basename(path: string): string {
  return path.split('/').pop()!;
}

function filesMatching(re: RegExp): string[] {
  return Object.entries(sources)
    .filter(([, text]) => re.test(text))
    .map(([path]) => basename(path))
    .sort();
}

describe('plan-719 F3 — the scan itself is real', () => {
  it('sees a plausible number of source files', () => {
    expect(Object.keys(sources).length).toBeGreaterThan(200);
  });
});

// ─── Nothing produces a homeless asset ──────────────────────────────────

describe('plan-719 F3 — no asset document is created without a home', () => {
  it('`newUntitled` exists nowhere under src/', () => {
    // The one factory that ever minted an asset with no file and no row. Tests
    // that need a throwaway document use `tests/helpers/scratch-asset-document`,
    // which builds one over a real path and says why.
    expect(filesMatching(/\bnewUntitled\b/)).toEqual([]);
  });

  it('nothing loads an asset base by that kind any more', () => {
    // The editor's `_loadBase({kind:'empty'})` call sites, and any successor.
    // Matched on the CALL rather than on the literal, so the scene lineage's
    // own `empty` — a different union in a different file — is untouched.
    expect(filesMatching(/_loadBase\([^)]*kind:\s*'empty'/)).toEqual([]);
  });

  it('no pending editor open is set to that kind', () => {
    expect(filesMatching(/setPendingAssetOpen\(\s*\{\s*kind:\s*'empty'/)).toEqual([]);
  });
});

// ─── The type surface, pinned ───────────────────────────────────────────

describe('plan-719 F3 — the unions no longer carry it', () => {
  it('`AssetBase` rejects the kind at compile time', () => {
    // @ts-expect-error — `'empty'` is not a member of AssetBase any more. If
    // this line ever stops erroring, the kind is back and every branch that
    // used to special-case it has to come back with it.
    const base: AssetBase = { kind: 'empty' };
    expect(base).toBeTruthy();
  });

  it('the storage twin `RvDraftBase` rejects it too', () => {
    // Both unions or neither: they are deliberately field-identical, and one
    // of them keeping the kind would let a draft round-trip re-introduce it.
    // @ts-expect-error — see above.
    const base: RvDraftBase = { kind: 'empty' };
    expect(base).toBeTruthy();
  });

  it('a document base still type-checks — the guard is not just "nothing works"', () => {
    const base: AssetBase = {
      kind: 'document', documentId: 'doc_x', path: 'models/Cell.glb', name: 'Cell',
    };
    expect(base.kind).toBe('document');
  });
});

// ─── The tier boundary of the new public files ──────────────────────────

describe('plan-719 F6 — the save dialogs are public and stay public', () => {
  const PUBLIC_SAVE_FILES = ['save-dialog-store.ts', 'SaveDialogs.tsx'];

  it('both files exist under src/core', () => {
    const found = Object.keys(sources)
      .map(basename)
      .filter((n) => PUBLIC_SAVE_FILES.includes(n))
      .sort();
    expect(found).toEqual([...PUBLIC_SAVE_FILES].sort());
  });

  /**
   * A Community build has no private sibling at all, so an import of one from
   * here would not be a layering smell — it would be a build that does not
   * compile. The double typecheck catches that too, but only as an absence;
   * this says it as a rule, which is what a reader of these two files needs.
   */
  it('neither imports anything private', () => {
    for (const [path, text] of Object.entries(sources)) {
      if (!PUBLIC_SAVE_FILES.includes(basename(path))) continue;
      expect(text, `${basename(path)} must not import @rv-private`)
        .not.toMatch(/@rv-private/);
      expect(text, `${basename(path)} must not reach into the private sibling`)
        .not.toMatch(/WebViewer-Private/);
    }
  });

  /**
   * plan-434 privatised the asset editor's AUTHORING tools three days before
   * this plan made these two files public, so the next 434-style sweep will
   * come past them. The note in each header is what tells that sweep to leave
   * them alone, and a note nobody checks is a note that gets deleted.
   */
  it('each states WHY it is public, for the next privatisation sweep', () => {
    for (const [path, text] of Object.entries(rawSources)) {
      if (!PUBLIC_SAVE_FILES.includes(basename(path))) continue;
      expect(text, `${basename(path)} must say it is document infrastructure`)
        .toMatch(/document INFRASTRUCTURE/);
    }
  });
});
