// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-510 §9.6 — the Inspector gallery (`src/core/hmi/dev/`) is a DEV-ONLY
 * tool and must never reach a production bundle.
 *
 * Source check (this test): the gallery modules are referenced ONLY through a
 * dynamic `import()` inside an `import.meta.env.DEV` branch of `main.ts` — no
 * static import, no re-export anywhere else. Vite replaces the flag with a
 * literal `false` in a build, so Rollup drops the branch and the chunk.
 *
 * Build acceptance (plan step, not part of the suite): a fresh `npm run build`
 * followed by a search of `dist/` for the marker `rv-inspector-gallery-marker`
 * must find nothing.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

const ROOT = resolve(__dirname, '..');
const SRC = resolve(ROOT, 'src');
const DEV_DIR = 'src/core/hmi/dev/';
const MARKER = 'rv-inspector-gallery-marker';

function walk(dir: string, out: string[]): void {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name)) out.push(full);
  }
}

function sources(): Array<{ file: string; text: string }> {
  const files: string[] = [];
  walk(SRC, files);
  return files.map((full) => ({ file: full.slice(ROOT.length + 1).replace(/\\/g, '/'), text: readFileSync(full, 'utf8') }));
}

describe('Inspector gallery stays out of production (plan-510)', () => {
  it('the gallery carries the stable marker the build acceptance searches for', () => {
    const gallery = readFileSync(resolve(ROOT, 'src/core/hmi/dev/InspectorGallery.tsx'), 'utf8');
    expect(gallery).toContain(`'${MARKER}'`);
    expect(gallery).toContain('data-rv={INSPECTOR_GALLERY_MARKER}');
  });

  it('outside src/core/hmi/dev/ nothing references the gallery modules — except the one gated import in main.ts', () => {
    const refs = sources()
      .filter((s) => !s.file.startsWith(DEV_DIR))
      .filter((s) => /InspectorGallery|mount-inspector-gallery|core\/hmi\/dev\//.test(s.text))
      .map((s) => s.file);
    expect(refs).toEqual(['src/main.ts']);
  });

  it('main.ts: exactly one dynamic import, inside an import.meta.env.DEV branch; no static import', () => {
    const main = readFileSync(resolve(SRC, 'main.ts'), 'utf8');
    expect(main).not.toMatch(/^\s*import\s[^;]*dev\/(InspectorGallery|mount-inspector-gallery)/m);
    expect(main).not.toMatch(/^\s*export\s[^;]*dev\/(InspectorGallery|mount-inspector-gallery)/m);
    const dynamic = [...main.matchAll(/import\(\s*['"]\.\/core\/hmi\/dev\/([^'"]+)['"]\s*\)/g)].map((m) => m[1]);
    expect(dynamic).toEqual(['mount-inspector-gallery']);
    // The enclosing condition is the static DEV flag AND the URL switch.
    const at = main.indexOf("import('./core/hmi/dev/mount-inspector-gallery')");
    const branch = main.slice(main.lastIndexOf('if (', at), at);
    expect(branch).toMatch(/^if \(import\.meta\.env\.DEV && /);
    expect(branch).toContain("get('rvDev') === 'inspector-gallery'");
  });

  it('the dev modules do not register anything globally (pure gallery + mount)', () => {
    for (const s of sources().filter((x) => x.file.startsWith(DEV_DIR))) {
      expect(s.text, s.file).not.toMatch(/Registry\.register|\.register\(/);
    }
  });
});
