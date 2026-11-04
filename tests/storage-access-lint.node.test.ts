// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it } from 'vitest';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

const ROOT = resolve(__dirname, '..');
const eslint = new ESLint({ cwd: ROOT });
const DIRECT_ACCESS = [
  "localStorage.getItem('x');",
  "sessionStorage.getItem('x');",
  "window.sessionStorage.setItem('x', 'y');",
  'globalThis.localStorage;',
  'self.sessionStorage;',
  "window['localStorage'];",
  'globalThis["sessionStorage"];',
];

async function lint(code: string, filePath = 'src/storage-lint-fixture.ts') {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages;
}

describe('storage access lint (plan-2213)', () => {
  it.each(DIRECT_ACCESS)('rejects %s', async (code) => {
    const messages = await lint(code);
    expect(messages).toHaveLength(1);
    expect(messages[0].severity).toBe(2);
    expect(messages[0].message).toContain('src/core/rv-safe-storage.ts');
    expect(['no-restricted-globals', 'no-restricted-properties']).toContain(messages[0].ruleId);
  });

  it('allows direct access only in the safe storage module', async () => {
    expect(await lint(DIRECT_ACCESS.join('\n'), 'src/core/rv-safe-storage.ts')).toEqual([]);
  });

  it('allows wrapper imports and calls', async () => {
    expect(await lint("import { readLocalStorage } from './core/rv-safe-storage'; readLocalStorage('x');")).toEqual([]);
  });

  it('keeps storage and HMI design restrictions active together', async () => {
    const messages = await lint("localStorage.getItem('x'); const color = '#ff0000';", 'src/core/hmi/rv-property-inspector.tsx');
    expect(messages.map(message => message.ruleId).sort()).toEqual(['no-restricted-globals', 'no-restricted-syntax']);
  });
});
