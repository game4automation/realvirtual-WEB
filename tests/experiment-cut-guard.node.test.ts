// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, describe, expect, it } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkCut } from '../scripts/experiment-cut-guard.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = resolve(root, '../realvirtual-WebViewer-Private~');
const fixtures: string[] = [];
afterEach(() => { for (const dir of fixtures.splice(0)) rmSync(dir, { recursive: true, force: true }); });
function fixture() {
  const dir = mkdtempSync(resolve(tmpdir(), 'experiment-cut-'));
  fixtures.push(dir);
  const publicRoot = resolve(dir, 'public');
  const privateRoot = resolve(dir, 'private');
  mkdirSync(publicRoot);
  const write = (path: string, text = '') => { const full = resolve(publicRoot, path); mkdirSync(dirname(full), { recursive: true }); writeFileSync(full, text); };
  const list = { paths: [{ path: 'src/forbidden.ts', action: 'move' }, { path: 'src/series/**', action: 'move' }, { path: 'tests/private-*.ts', action: 'move' }, { path: 'doc-private.md', action: 'move' }, { path: 'src/split.ts', action: 'split' }], forbiddenMarkers: ['ForbiddenMarker'] };
  return { write, check: () => checkCut({ publicRoot, privateRoot, list }) };
}
describe('commercial cut guard', () => {
  it('accepts a clean tree, split paths and a missing private directory', () => {
    const f = fixture(); f.write('src/split.ts', 'export const core = true;');
    expect(f.check()).toEqual([]);
  });
  it('a: detects exact paths and globs in source, tests and docs', () => {
    const f = fixture();
    for (const p of ['src/forbidden.ts', 'src/series/nested/item.ts', 'tests/private-one.ts', 'doc-private.md']) f.write(p);
    expect(f.check().filter(v => v.check === 'a')).toHaveLength(4);
  });
  it('b: catches static, type, re-export and dynamic imports, aliases and missing targets through helpers', () => {
    const f = fixture();
    f.write('src/main.ts', "import './helper'; // import './forbidden' is only a comment\nconst s = `import('./forbidden')`;");
    f.write('src/helper.ts', "import { x } from './forbidden';\nexport * from '@rv/forbidden';\nconst lazy = import('./forbidden.js');\nimport type { T } from './forbidden';");
    const edges = f.check().filter(v => v.check === 'b');
    expect(edges).toHaveLength(4);
    expect(edges.map(v => v.line)).toEqual([1, 2, 3, 4]);
    expect(edges.every(v => v.file === 'src/helper.ts')).toBe(true);
  });
  it('b: also catches tools/ scripts, including the sibling-layout imports they run with', () => {
    const f = fixture();
    // tools/des-rng-vectors ran from `<root>/vectors/` beside the repo, so its imports name the
    // repo folder: `../realvirtual-WebViewer~/src/...` (the plan-2211 rest in verify.ts).
    f.write('tools/vectors/verify.ts', "import { x } from '../realvirtual-WebViewer~/src/forbidden';\nimport { y } from '../../src/series/a';\nimport { z } from '../realvirtual-WebViewer~/src/split';");
    const edges = f.check().filter(v => v.check === 'b');
    expect(edges.map(v => [v.file, v.line, v.target])).toEqual([
      ['tools/vectors/verify.ts', 1, 'src/forbidden'],
      ['tools/vectors/verify.ts', 2, 'src/series/a'],
    ]);
  });
  it('c: detects markers in public source only', () => {
    const f = fixture(); f.write('src/file.ts', '// ForbiddenMarker'); f.write('tests/allowed.ts', 'ForbiddenMarker');
    expect(f.check().map(v => v.check)).toEqual(['c']);
  });
  it('d: detects AGPL headers only inside the private feature', () => {
    const f = fixture();
    f.write('../private/src/plugins/des-experiments/nested/module.ts', '// SPDX-License-Identifier: AGPL-3.0-only');
    f.write('../private/src/plugins/other/module.ts', '// AGPL-3.0');
    expect(f.check().map(v => v.check)).toEqual(['d']);
  });
  // Phase 2 creates this feature directory. Activate the real boundary assertion then.
  it('real tree respects the cut after Phase 2', () => {
    expect(checkCut({ publicRoot: root, privateRoot })).toEqual([]);
  }, 60_000); // walks the whole public + private tree (~3.7 s idle, > the 5 s default under load)
});
