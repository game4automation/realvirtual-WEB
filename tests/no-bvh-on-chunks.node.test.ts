// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-756 §9.5 — the hard cut stays cut (R6, F8).
 *
 * The bake and pick modules must not import three-mesh-bvh and must not write a
 * `boundsTree`. This is a SOURCE guard, not a behaviour test, because the
 * failure mode it protects against is silent: a `new MeshBVH(geometry)` without
 * `{ indirect: true }` REORDERS the index in place and would quietly invalidate
 * every segment of the chunk it was built on (§2.4a.10). three-mesh-bvh itself
 * stays in the bundle on purpose — the machining volume, the editor instance
 * pick index, the MCP gap queries, ray tracing and `computeBVHAsync` keep using it.
 *
 * plan-781 tightened the guard: the collision modules (`rv-collision-*.ts`) are
 * covered too. Collision READS the pick structure and builds no tree of its own
 * (contract bake-picking rules 10/15), so the former "only the collision manager
 * may put an indirect tree on a chunk" exception is gone.
 *
 * Pattern: glob + comment-strip + regex with a non-empty-glob sanity check, the
 * same shape as the source guards in `placement-instancer.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'engine');

/** `rv-bake-*.ts` + `rv-pick-*.ts` + `rv-collision-*.ts` of the engine folder, read as text. */
function guardedSources(): Array<{ file: string; code: string }> {
  return readdirSync(engineDir)
    .filter((name) => /^rv-(bake|pick|collision)-.*\.ts$/.test(name))
    .map((name) => {
      const text = readFileSync(join(engineDir, name), 'utf8');
      // Strip comments: a comment may NAME the deleted machinery (and several
      // deliberately do, to explain why it is gone); the code must not use it.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      return { file: name, code };
    });
}

describe('no three-mesh-bvh on baked chunks (plan-756 §9.5)', () => {
  it('the glob matches the bake and pick modules at all', () => {
    const files = guardedSources().map((s) => s.file);
    // Sanity: a renamed folder or a broken pattern must fail loudly, not pass.
    expect(files.length).toBeGreaterThan(5);
    expect(files).toContain('rv-bake-pipeline.ts');
    expect(files).toContain('rv-bake-chunk.ts');
    expect(files).toContain('rv-bake-registry.ts');
    expect(files).toContain('rv-pick-backend.ts');
    expect(files).toContain('rv-pick-structure.ts');
    expect(files).toContain('rv-pick-build.ts');
    expect(files).toContain('rv-collision-manager.ts');
    expect(files).toContain('rv-collision-bodies.ts');
    expect(files).toContain('rv-collision-narrowphase.ts');
    expect(files).toContain('rv-collision-tri-tri.ts');
  });

  it('no bake/pick/collision module imports three-mesh-bvh', () => {
    const offenders = guardedSources()
      .filter((s) => /from\s*['"]three-mesh-bvh['"]|require\(\s*['"]three-mesh-bvh['"]/.test(s.code))
      .map((s) => s.file);
    expect(offenders, 'the bake builds its OWN pick structure (plan-756 F8); collision reads it (plan-781)').toEqual([]);
  });

  it('no bake/pick/collision module writes a boundsTree', () => {
    // Reading one to DISPOSE it is the one legitimate use (a tree some caller
    // outside these modules may have put on a geometry), so only writes are
    // rejected.
    const offenders = guardedSources()
      // `=(?!\s*undefined\b)` and not `=\s*(?!undefined)`: the latter lets the
      // regex backtrack `\s*` to zero and match the dispose line anyway.
      .filter((s) => /\bboundsTree\s*=(?!\s*undefined\b)/.test(s.code))
      .map((s) => s.file);
    expect(offenders, 'nothing may put a tree on a chunk — collision reads the pick structure (plan-781)').toEqual([]);
  });

  it('the deleted identifiers of the old backend are gone from the whole engine', () => {
    const gone = ['ChunkPickBackend', 'bsearchNode', '_windowIndexOf', 'ChunkNodeRange', 'ChunkSourceRange'];
    const offenders: string[] = [];
    for (const name of readdirSync(engineDir)) {
      if (!name.endsWith('.ts')) continue;
      const text = readFileSync(join(engineDir, name), 'utf8');
      const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
      for (const id of gone) if (code.includes(id)) offenders.push(`${name}: ${id}`);
    }
    expect(offenders).toEqual([]);
  });
});
