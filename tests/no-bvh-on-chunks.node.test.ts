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
 * stays in the bundle on purpose — collision, the machining volume, the editor
 * instance pick index and `computeBVHAsync` all keep using it.
 *
 * Pattern: glob + comment-strip + regex with a non-empty-glob sanity check, the
 * same shape as the source guards in `placement-instancer.test.ts`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'engine');

/** `rv-bake-*.ts` + `rv-pick-*.ts` of the engine folder, read as text. */
function guardedSources(): Array<{ file: string; code: string }> {
  return readdirSync(engineDir)
    .filter((name) => /^rv-(bake|pick)-.*\.ts$/.test(name))
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
  });

  it('no bake/pick module imports three-mesh-bvh', () => {
    const offenders = guardedSources()
      .filter((s) => /from\s*['"]three-mesh-bvh['"]|require\(\s*['"]three-mesh-bvh['"]/.test(s.code))
      .map((s) => s.file);
    expect(offenders, 'the bake builds its OWN pick structure (plan-756 F8)').toEqual([]);
  });

  it('no bake/pick module writes a boundsTree', () => {
    // Reading one to DISPOSE it is the one legitimate use (a collision body may
    // have put an indirect tree on a chunk geometry, §2.4a.10), so only writes
    // are rejected.
    const offenders = guardedSources()
      // `=(?!\s*undefined\b)` and not `=\s*(?!undefined)`: the latter lets the
      // regex backtrack `\s*` to zero and match the dispose line anyway.
      .filter((s) => /\bboundsTree\s*=(?!\s*undefined\b)/.test(s.code))
      .map((s) => s.file);
    expect(offenders, 'only the collision manager may put a tree on a chunk, and only indirect').toEqual([]);
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
