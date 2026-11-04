// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Commercial delivery wiring for the private AI prompt panel (plan-2040). */

import { describe, expect, it } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  featureTier,
  generateCustomerPrivatePlugins,
  loadTierManifest,
} from '../scripts/_workspace-lib.mjs';

const ROOT = resolve(__dirname, '..');
const PRIVATE = resolve(ROOT, '../realvirtual-WebViewer-Private~');
const HAS_PRIVATE = existsSync(resolve(PRIVATE, 'src/private-plugins.ts'));
const readPrivate = (path: string): string => readFileSync(resolve(PRIVATE, path), 'utf8');

describe.skipIf(!HAS_PRIVATE)('AI prompt is a commercial feature', () => {
  const manifest = loadTierManifest(PRIVATE);

  it('declares the commercial adapter in the tier manifest', () => {
    expect(manifest.registrations['ai-prompt']?.adapter).toBe('./features/ai-prompt.register');
    expect(featureTier(manifest, 'ai-prompt')).toBe('commercial');
  });

  it('keeps the customer entry in manifest order and out of the internal entry', () => {
    const customer = readPrivate('src/private-plugins.ts').split(/if\s*\(\s*__RV_INTERNAL__\s*\)/)[0]!;
    const manifestOrder = Object.keys(manifest.registrations);
    const customerOrder = [...customer.matchAll(/useFeature\(viewer, '([^']+)'/g)].map((match) => match[1]!);

    expect(customer).toContain("useFeature(viewer, 'ai-prompt', () => import('./features/ai-prompt.register'))");
    expect(readPrivate('src/internal-plugins.ts')).not.toMatch(/ai-prompt/i);
    expect(manifestOrder[manifestOrder.indexOf('ai-prompt') - 1]).toBe('diagnostics');
    expect(customerOrder[customerOrder.indexOf('ai-prompt') - 1]).toBe('diagnostics');
    expect(manifestOrder[manifestOrder.indexOf('ai-prompt') + 1]).toBe('step-import');
    expect(customerOrder[customerOrder.indexOf('ai-prompt') + 1]).toBe('step-import');
  });

  it('is emitted by the real commercial customer-entry generator', () => {
    const generated = generateCustomerPrivatePlugins(manifest, {
      tier: 'commercial',
      restrictedFeatures: [],
    });
    expect(generated).toContain("import('./features/ai-prompt.register')");
    expect(generated).toContain("useFeature(viewer, 'ai-prompt'");
  });

  it('loads the plugin dynamically and registers it with commercial origin', () => {
    const adapter = readPrivate('src/features/ai-prompt.register.ts');
    const plugin = readPrivate('src/plugins/ai-prompt/ai-prompt-plugin.tsx');
    expect(adapter).toMatch(/await import\('\.\.\/plugins\/ai-prompt\/ai-prompt-plugin'\)/);
    expect(adapter).toMatch(/viewer\.use\(new AiPromptPlugin\(\), 'commercial'\)/);
    expect(plugin).toMatch(/lazy\(\(\) => import\('\.\/AiPromptPanel'\)/);
    expect(plugin).not.toMatch(/import\s+\{[^}]*AiPromptPanel[^}]*\}\s+from/);
  });
});

describe('the demo build includes the commercial private tier', () => {
  const source = readFileSync(resolve(ROOT, 'scripts/_workspace-lib.mjs'), 'utf8');
  const start = source.indexOf("else if (options.mode === 'demo')");
  const end = source.indexOf("else { delete env.VITE_PUBLIC_BUILD", start);
  const demoBranch = source.slice(start, end);

  it('uses private features while excluding the internal tier', () => {
    expect(start).toBeGreaterThan(-1);
    expect(demoBranch).toMatch(/delete env\.VITE_PUBLIC_BUILD;/);
    expect(demoBranch).toMatch(/delete env\.VITE_PRIVATE_BUILD;/);
    expect(demoBranch).toMatch(/delete env\.RV_INTERNAL;/);
    expect(demoBranch).not.toMatch(/env\.VITE_PUBLIC_BUILD\s*=/);
  });
});
