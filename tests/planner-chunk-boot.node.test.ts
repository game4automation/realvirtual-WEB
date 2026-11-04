// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// init() owns the DOM boot sequence; source guards avoid importing the demo
// (and starting a real viewer) merely to check its chunk-loading contract.
const source = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
const init = code.slice(code.indexOf('async function init()'));

describe('plan-2037 planner chunk boot', () => {
  it('scrubs the secret first, then starts the import with an immediate rejection handler', () => {
    expect(init).toMatch(/^async function init\(\)\s*\{\s*initFragmentSecret\(\);\s*const plannerModule = import\('\.\/plugins\/layout-planner'\);\s*void plannerModule\.catch\(\(\) => \{\}\);/);
    // Type-only imports would be harmless; value and side-effect imports are not.
    expect(code).not.toMatch(/\bimport\s+(?!type\b)[^;]*\bfrom\s*['"]\.\/plugins\/layout-planner['"]/);
    expect(code).not.toMatch(/\bimport\s*['"]\.\/plugins\/layout-planner['"]/);
  });

  it('awaits the original promise after boot gates and before creating the viewer', () => {
    const anchors = [
      "const plannerModule = import('./plugins/layout-planner')",
      'await loadPublishedPresets(',
      'await requireAnalyticsConsent(',
      'await requireHostedPassword(',
      'loadedPlanner = await plannerModule;',
      'const { LayoutPlannerPlugin } = loadedPlanner;',
      'const viewer = await RVViewer.create(',
      ".use(new LayoutPlannerPlugin(), 'core')",
    ];
    let previous = -1;
    for (const anchor of anchors) {
      const position = init.indexOf(anchor);
      expect(position, `missing or reordered boot anchor: ${anchor}`).toBeGreaterThan(previous);
      previous = position;
    }
    // A stray early return between viewer creation and the plugin chain would abort the boot.
    const viewerToChain = init.slice(init.indexOf('const viewer = await RVViewer.create('), init.indexOf(".use(new LayoutPlannerPlugin(), 'core')"));
    expect(viewerToChain).not.toMatch(/return/);
    expect(init).toMatch(/\.use\(new OrientationGizmoPlugin\(\), 'core'\)\s*\.use\(new LayoutPlannerPlugin\(\), 'core'\)\s*\.use\(new SignalBindPlugin\(\), 'core'\)/);
  });

  it('shows the import failure, wires reload and returns before any viewer is created', () => {
    expect(init).toMatch(/try\s*\{\s*loadedPlanner = await plannerModule;\s*\}\s*catch \(error\)\s*\{\s*loadingRetryBtn\.onclick = \(\) => window\.location\.reload\(\);\s*loadingReloadBtn\.onclick = \(\) => window\.location\.reload\(\);\s*showLoadingError\(`Could not load the layout planner: \$\{error instanceof Error \? error\.message : String\(error\)\}`\);\s*return;\s*\}\s*const \{ LayoutPlannerPlugin \} = loadedPlanner;\s*const viewer = await RVViewer\.create\(/);
    const beforeInit = code.slice(0, code.indexOf('async function init()'));
    for (const element of ['loadingRetryBtn', 'loadingError', 'loadingErrorDetail']) {
      expect(beforeInit).toContain(`const ${element} = document.getElementById(`);
    }
  });
});
