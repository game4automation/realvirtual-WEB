// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { termsGateMode } from '../scripts/lib/rv-agpl-attribution.mjs';

describe('terms gate build matrix', () => {
  for (const command of ['build', 'serve', 'other']) {
    for (let bits = 0; bits < 32; bits++) {
      const [hasPrivate, demoFlag, privateBuild, customerWorkspace, isTest] =
        Array.from({ length: 5 }, (_, index) => Boolean(bits & (1 << index)));
      it(`${command}: ${JSON.stringify({ hasPrivate, demoFlag, privateBuild, customerWorkspace, isTest })}`, () => {
        const expected = isTest ? 'off'
          : command === 'build' && hasPrivate && demoFlag && !privateBuild ? 'demo'
          : command === 'serve' && hasPrivate && customerWorkspace ? 'developer' : 'off';
        expect(termsGateMode({ command, hasPrivate, demoFlag, privateBuild, customerWorkspace, isTest })).toBe(expected);
      });
    }
  }

  it('wires the helper and all build inputs into Vite', () => {
    const config = readFileSync(resolve(__dirname, '../vite.config.ts'), 'utf8');
    expect(config).toMatch(/import\s*\{[^}]*termsGateMode[^}]*\}\s*from '\.\/scripts\/lib\/rv-agpl-attribution.mjs'/);
    expect(config).toContain('__RV_TERMS_GATE__: JSON.stringify(termsGateMode({');
    for (const input of [
      'command,', 'hasPrivate: HAS_PRIVATE', "demoFlag: process.env.RV_DEMO_NOTICE === '1'",
      'privateBuild: !!process.env.VITE_PRIVATE_BUILD',
      "customerWorkspace: existsSync(resolve(__dirname, '..', 'delivery-manifest.json'))",
      'isTest: !!process.env.VITEST',
    ]) expect(config).toContain(input);
    expect(readFileSync(resolve(__dirname, '../vitest.node.config.ts'), 'utf8'))
      .toContain("__RV_TERMS_GATE__: JSON.stringify('off')");
  });
});
