// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-682 §2.6 guard — AasLinkPlugin and OrderManagerPlugin are CORE plugins,
 * registered exactly once in `src/main.ts`. A model pack that registers one of
 * them again is a bug: `viewer.use()` ignores the duplicate id, the pack still
 * records it for its unload, and a pack written before plan-682 would rely on
 * its own instance (constructor config, ordering) that never runs.
 *
 * Source scan (fs walk, node mode) over every model pack: the public
 * `src/plugins/models/**` and the private `projects/**\/plugins/**`.
 */
import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const privateRoot = resolve(root, '..', 'realvirtual-WebViewer-Private~');

const CORE_CLASSES = ['AasLinkPlugin', 'OrderManagerPlugin'];

function walk(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules' || name.startsWith('.')) continue;
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) walk(p, out);
    else if (/\.(ts|tsx)$/.test(name)) out.push(p);
  }
  return out;
}

/** Every model-pack source file (public packs + private project plugin folders). */
function packFiles(): string[] {
  const files = walk(join(root, 'src', 'plugins', 'models'));
  const projects = join(privateRoot, 'projects');
  if (existsSync(projects)) {
    for (const project of readdirSync(projects)) {
      walk(join(projects, project, 'plugins'), files);
    }
  }
  return files;
}

describe('plan-682 core plugin guard', () => {
  it('main.ts registers AasLinkPlugin and OrderManagerPlugin as core plugins', () => {
    const main = readFileSync(join(root, 'src', 'main.ts'), 'utf8');
    for (const cls of CORE_CLASSES) {
      expect(main, cls).toMatch(new RegExp(`\\.use\\(new ${cls}\\(\\), 'core'\\)`));
    }
  });

  it('should fail if a model pack registers an id that a core plugin already owns', () => {
    const offenders: string[] = [];
    for (const file of packFiles()) {
      const text = readFileSync(file, 'utf8');
      for (const cls of CORE_CLASSES) {
        if (new RegExp(`new ${cls}\\s*\\(`).test(text)) offenders.push(`${relative(root, file)}: new ${cls}(…)`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('both plugin classes declare core = true (selective mode keeps them)', () => {
    for (const file of ['src/plugins/aas-link-plugin.tsx', 'src/plugins/order-manager-plugin.tsx']) {
      expect(readFileSync(join(root, file), 'utf8'), file).toMatch(/readonly core = true;/);
    }
  });
});
