// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-582 Phase 1 step 2 — `BakeClassification.chunkOwners` is gone and stays gone.
 *
 * ## Why this field had to go FIRST
 *
 * Both gate blockers against the Phase-1 handoff (§2.4) argued over this one
 * field: it was derived from the chunks `addItems` produced, so a missing
 * material or an invalid material group changed it. That is factually true —
 * and it would indeed make a role-only pass BEFORE the material phase answer
 * differently than today's pass after it, which is exactly what §2.4 proposes.
 *
 * The spike (§6c M2) then found the field has **no consumer at all** outside
 * `rv-bake-pipeline.ts`, in neither repo. `computeSurvival` reads exactly three
 * fields — `keep` (`rv-bake-survival.ts:408`), `staged` (`:409`) and
 * `instancedTriangles` (`:519`) — of which `keep` is invariant under
 * `dedup → uber` (§6c M4: `applyUberMaterial` rejects every material with a
 * `map`, so `hasScrollableMap` answers the same before and after) and
 * `instancedTriangles` is recomputable from the group arithmetic (§6c M5).
 * So the field was DELETED rather than carried through the split, and with it
 * the factual basis of both blockers.
 *
 * ## What this guard protects
 *
 * It is cheap to "helpfully" re-introduce an owners list while cutting
 * `classifyRoles` out of `classifyTree` in step 3 — it is one `Set` over
 * `plan.chunks` and it looks harmless. It is not: an owners list can only be
 * known AFTER material bucketing, which is precisely what the role pass must
 * not depend on. A returning `chunkOwners` therefore puts the whole §2.4
 * design back under the objection it was cleared of, silently.
 *
 * Node-mode source guard with an fs walk, the same shape as
 * `no-bvh-on-chunks.node.test.ts` (which guards the same module): the browser
 * alternative — an eager `import.meta.glob('../src/**', {query:'?raw'})` —
 * costs ~113 s of import for all 1277 source files, measured, for one string
 * search.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src');

let cached: Array<{ file: string; text: string }> | null = null;

/**
 * Every `.ts` / `.tsx` under `src/`, as `{ file, text }` — read ONCE and
 * memoized. Reading all 1277 files takes seconds on a loaded machine, and
 * three tests each doing their own walk overran the 5 s default timeout.
 */
function allSources(): Array<{ file: string; text: string }> {
  if (cached) return cached;
  const out: Array<{ file: string; text: string }> = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.tsx?$/.test(entry.name)) {
        out.push({ file: relative(srcDir, full).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') });
      }
    }
  };
  walk(srcDir);
  cached = out;
  return out;
}

describe('plan-582 — chunkOwners has no consumer (§6c M2)', () => {
  // Pay for the walk in the hook, not in whichever test happens to run first:
  // on a saturated machine it takes seconds and would trip the 5 s default.
  beforeAll(() => { allSources(); }, 120000);

  it('the walk sees the source tree at all', () => {
    const files = allSources().map((s) => s.file);
    // Sanity: a moved folder or a broken walk must fail loudly, not pass empty.
    expect(files.length).toBeGreaterThan(500);
    expect(files).toContain('core/engine/rv-bake-pipeline.ts');
    expect(files).toContain('core/engine/rv-bake-survival.ts');
  });

  it('Test_ChunkOwners_HasNoConsumer: `chunkOwners` appears nowhere in src/', () => {
    const offenders = allSources()
      .filter((s) => s.text.includes('chunkOwners'))
      .map((s) => s.file);
    expect(
      offenders,
      'chunkOwners was removed in plan-582 Phase 1 step 2. It had no consumer, and an '
      + 'owners list is only knowable AFTER material bucketing — the one thing the role '
      + 'pass of §2.4 must not depend on. Do not re-add it while splitting classifyTree.',
    ).toEqual([]);
  });

  it('`computeSurvival` still reads only keep / staged / instancedTriangles', () => {
    // The positive half of M3: if survival starts reading a FOURTH field of the
    // classification, the §2.4 invariance argument has to be re-made for it.
    const survival = readFileSync(join(srcDir, 'core', 'engine', 'rv-bake-survival.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/(^|[^:])\/\/.*$/gm, '$1');
    const fields = new Set(
      [...survival.matchAll(/\bclassification\s*(?:\?\.|\.)\s*([A-Za-z_$][\w$]*)/g)].map((m) => m[1]),
    );
    expect([...fields].sort()).toEqual(['instancedTriangles', 'keep', 'staged']);
  });
});
