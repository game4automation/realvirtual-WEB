// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-781 — collision READS the pick structure and builds none of its own
 * (contract bake-picking rule 15 as ruled by Vincent, the contract owner, on
 * 2026-11-05; rule 10: a chunk's index order is data).
 *
 * A SOURCE guard over `rv-collision-*.ts`, in the shape of
 * `no-bvh-on-chunks.node.test.ts`: no `MeshBVH`, no `computeBoundsTree`, no
 * `buildPickStructure` / `buildSegmentOnlyStructure` call, no import of the pick
 * builder. The one structure collision may cause to exist is the pick path's
 * own lazily built `KeepPick` of a keep mesh, reached through `keepStructure`
 * — the same structure and the same cache, never a second copy.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const engineDir = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'core', 'engine');

/** `rv-collision-*.ts` of the engine folder, comments stripped. */
function collisionSources(): Array<{ file: string; code: string }> {
  return readdirSync(engineDir)
    .filter((name) => /^rv-collision-.*\.ts$/.test(name))
    .map((name) => {
      const text = readFileSync(join(engineDir, name), 'utf8');
      // A comment may NAME the forbidden machinery (several explain why it is
      // not used); only code counts.
      const code = text
        .replace(/\/\*[\s\S]*?\*\//g, '')
        .replace(/(^|[^:])\/\/.*$/gm, '$1');
      return { file: name, code };
    });
}

describe('collision builds no acceleration structure (plan-781, rules 10/15)', () => {
  it('the glob matches the collision modules at all', () => {
    const files = collisionSources().map((s) => s.file);
    expect(files).toContain('rv-collision-manager.ts');
    expect(files).toContain('rv-collision-bodies.ts');
    expect(files).toContain('rv-collision-narrowphase.ts');
    expect(files).toContain('rv-collision-tri-tri.ts');
    expect(files).toContain('rv-collision-role.ts');
  });

  it('no collision module builds a MeshBVH, a bounds tree or a pick structure', () => {
    const forbidden: Array<[string, RegExp]> = [
      ['MeshBVH', /\bMeshBVH\b/],
      ['computeBoundsTree', /\bcomputeBoundsTree\b/],
      ['buildPickStructure', /\bbuildPickStructure(?:Async|Steps)?\s*\(/],
      ['buildSegmentOnlyStructure', /\bbuildSegmentOnlyStructure\s*\(/],
      ['three-mesh-bvh import', /from\s*['"]three-mesh-bvh(?:\/[^'"]*)?['"]/],
      ['pick builder import', /from\s*['"]\.\/rv-pick-build(?:-port|-worker)?['"]/],
      ['boundsTree write', /\bboundsTree\s*=(?!=)/],
    ];
    const offenders: string[] = [];
    for (const { file, code } of collisionSources()) {
      for (const [name, re] of forbidden) if (re.test(code)) offenders.push(`${file}: ${name}`);
    }
    expect(offenders, 'collision READS ChunkPickData / KeepPick — it builds nothing (rule 15 reading)').toEqual([]);
  });

  it('the one structure collision reaches is the pick path\'s own KeepPick (keepStructure)', () => {
    const bodies = collisionSources().find((s) => s.file === 'rv-collision-bodies.ts')!;
    expect(bodies.code).toMatch(/\bkeepStructure\s*\(/);
    expect(bodies.code).toMatch(/from\s*['"]\.\/rv-pick-backend['"]/);
  });
});
