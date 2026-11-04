// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-615 §9.5 / F7 — the dev toolbar does not exist in a production bundle.
 *
 * A full product build is far too heavy for a test, so this builds a MINIMAL
 * entry through Vite's build API with the production `define`
 * (`__RV_SERVE_INFO__` = `null`, exactly what vite.config.ts substitutes for
 * every non-serve command). The probe entry reaches the dev toolbar through the
 * three real gate sites:
 *
 *  - the real `ActivityBar` module (where the button is mounted),
 *  - the App root's gate shape `RV_SERVE_INFO !== null && !recording && <DevSessionHost />`
 *    (the constant LEADS: Rollup folds `null !== null && X` but not
 *    `!recording && null !== null && X` — this test caught exactly that leak),
 *  - main.ts' gate shape `RV_SERVE_INFO !== null ? applyBootViewProfile(c) : c`.
 *
 * Both shapes are also asserted to be the ones App.tsx / main.ts actually use,
 * so a refactor that changes the gate breaks this test instead of silently
 * shipping the toolbar. Bare package imports are external (they are not what is
 * being proven and would only cost time); `minify: false` keeps component names
 * greppable, which makes the absence check stronger, not weaker.
 *
 * The sensitivity check: the bundle DOES contain the ActivityBar's own entries
 * (`activity-problems`), so "absent" means eliminated, not "never built".
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';

const ROOT = resolve(__dirname, '..');
const src = (p: string) => resolve(ROOT, 'src', p).replace(/\\/g, '/');
const PROBE_ID = 'virtual:rv-dev-toolbar-probe';
const PROBE_RESOLVED = '\0virtual:rv-dev-toolbar-probe';

const PROBE = `
import { jsx } from 'react/jsx-runtime';
import { RV_SERVE_INFO } from '${src('core/rv-serve-info.ts')}';
import { applyBootViewProfile } from '${src('core/rv-view-profile.ts')}';
import { DevSessionHost } from '${src('core/hmi/DevToolbarButton.tsx')}';
export { ActivityBar } from '${src('core/hmi/ActivityBar.tsx')}';
// main.ts
export const bootConfig = (c) => (RV_SERVE_INFO !== null ? applyBootViewProfile(c) : c);
// App.tsx root
export const appRoot = (recording) => RV_SERVE_INFO !== null && !recording && jsx(DevSessionHost, {});
`;

/** Strings that only the dev toolbar (or the removed banner) carries. */
const FORBIDDEN = [
  'dev-toolbar-button',
  'dev-handle',
  'dev-toolbar-popover',
  '/__api/dev/golden',
  'serve-session-badge',
  'ServeSessionBadge',
  'ENTWICKLUNGSSERVER',
  'DevToolbar',
  'DevSessionHost',
  'rv-view-profile',
  '[⚠ CANONICAL]',
  'CANONICAL_TITLE_PREFIX',
];

let outDir: string;
let bundle = '';

beforeAll(async () => {
  outDir = mkdtempSync(join(tmpdir(), 'rv-dev-toolbar-bundle-'));
  await build({
    root: ROOT,
    configFile: false,
    logLevel: 'silent',
    publicDir: false,
    resolve: {
      alias: {
        '@rv': resolve(ROOT, 'src'),
        '@rv-private': resolve(ROOT, 'src/private-stubs'),
        '@rv-projects': resolve(ROOT, 'src/private-stubs/projects'),
      },
    },
    define: {
      __RV_SERVE_INFO__: 'null',
      __RV_HAS_PRIVATE__: 'false',
      __RV_INTERNAL__: 'false',
    },
    plugins: [{
      name: 'rv-dev-toolbar-probe',
      resolveId: (id: string) => (id === PROBE_ID ? PROBE_RESOLVED : null),
      load: (id: string) => (id === PROBE_RESOLVED ? PROBE : null),
    }],
    worker: { format: 'es' },
    build: {
      outDir,
      emptyOutDir: true,
      minify: false,
      write: true,
      copyPublicDir: false,
      reportCompressedSize: false,
      rollupOptions: {
        input: { probe: PROBE_ID },
        // Keep the probe's exports (an app build would tree-shake an unused entry away).
        preserveEntrySignatures: 'strict',
        // Bare package imports stay external; only first-party code is bundled.
        // Private-sibling files (reached only through the lazy model-plugin
        // globs, whose `__RV_HAS_PRIVATE__` gate is applied after the glob
        // expands) stay external too — the probe is about the public core.
        external: (id: string) => /[\\/]realvirtual-WebViewer-Private~[\\/]|[\\/]realvirtual-web-pro[\\/]/.test(id)
          || (!id.startsWith('\0') && !id.startsWith('virtual:') && !id.startsWith('.') && !id.startsWith('/')
            && !/^[A-Za-z]:[\\/]/.test(id) && !id.startsWith('@rv')),
      },
    },
  });
  for (const file of readdirSync(outDir, { recursive: true }) as string[]) {
    if (file.endsWith('.js')) bundle += readFileSync(join(outDir, file), 'utf8');
  }
}, 300_000);

// RV_KEEP_DEV_TOOLBAR_PROBE=1 keeps the built probe for inspection (path printed).
afterAll(() => {
  if (!outDir) return;
  if (process.env.RV_KEEP_DEV_TOOLBAR_PROBE === '1') { console.log(`[dev-toolbar-probe] kept ${outDir}`); return; }
  rmSync(outDir, { recursive: true, force: true });
});

describe('9.5 dev toolbar absent from the production bundle', () => {
  it('Test_Bundle_ContainsActivityBar_SensitivityCheck', () => {
    expect(bundle.length).toBeGreaterThan(0);
    expect(bundle).toContain('activity-problems');
    expect(bundle).toContain('function ActivityBar');
  });

  it.each(FORBIDDEN)('Test_Bundle_DoesNotContain_%s', (marker) => {
    expect(bundle).not.toContain(marker);
  });

  it('Test_GateShapes_AreTheOnesAppAndMainUse', () => {
    const app = readFileSync(resolve(ROOT, 'src/core/hmi/App.tsx'), 'utf8');
    const main = readFileSync(resolve(ROOT, 'src/main.ts'), 'utf8');
    const activityBar = readFileSync(resolve(ROOT, 'src/core/hmi/ActivityBar.tsx'), 'utf8');
    expect(app).toContain('{RV_SERVE_INFO !== null && !recording && <DevSessionHost />}');
    expect(main).toContain('RV_SERVE_INFO !== null ? applyBootViewProfile(loadedConfig) : loadedConfig');
    // Every mount of the button in the ActivityBar sits behind the gate.
    const mounts = activityBar.match(/<DevToolbarButton\b/g) ?? [];
    const gated = activityBar.match(/RV_SERVE_INFO !== null && <DevToolbarButton\b/g) ?? [];
    expect(mounts.length).toBeGreaterThan(0);
    expect(gated.length).toBe(mounts.length);
  });
});
