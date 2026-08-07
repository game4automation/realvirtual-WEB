// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it } from 'vitest';
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  DEFAULT_NEWS_API_URL,
  generatePrivateSettings,
  injectNewsIntoSettings,
  loadConfig,
} from '../scripts/_bunny-lib.mjs';

const REQUIRED = { BUNNY_STORAGE_KEY: 'key', BUNNY_STORAGE_ZONE: 'zone' };
const temporary: string[] = [];

afterEach(() => {
  for (const path of temporary.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe('public-hosted news deployment configuration', () => {
  it('uses the canonical production endpoint by default', () => {
    expect(loadConfig(REQUIRED).newsApiUrl).toBe(
      'https://download.realvirtual.io/news/api/v1',
    );
    expect(loadConfig(REQUIRED).newsApiUrl).toBe(DEFAULT_NEWS_API_URL);
  });

  it('uses a non-empty NEWS_API_URL override', () => {
    expect(loadConfig({
      ...REQUIRED,
      NEWS_API_URL: ' https://portal.test/custom/v1 ',
    }).newsApiUrl).toBe('https://portal.test/custom/v1');
  });

  it('treats empty NEWS_API_URL as default and NEWS_DISABLE=1 as the opt-out', () => {
    expect(loadConfig({ ...REQUIRED, NEWS_API_URL: '  ' }).newsApiUrl)
      .toBe(DEFAULT_NEWS_API_URL);
    expect(loadConfig({
      ...REQUIRED,
      NEWS_API_URL: 'https://portal.test/custom/v1',
      NEWS_DISABLE: '1',
    }).newsApiUrl).toBe('');
  });

  it('injects the exact news block into a public dist/settings.json artifact', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-news-public-'));
    temporary.push(root);
    const settingsPath = join(root, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'demo.glb' }));

    expect(injectNewsIntoSettings(settingsPath, DEFAULT_NEWS_API_URL)).toBe(true);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8'))).toEqual({
      defaultModel: 'demo.glb',
      news: { enabled: true, apiUrl: DEFAULT_NEWS_API_URL },
    });
  });

  it('performs no injection when NEWS_DISABLE resolved an empty URL', () => {
    const root = mkdtempSync(join(tmpdir(), 'rv-news-disabled-'));
    temporary.push(root);
    const settingsPath = join(root, 'settings.json');
    writeFileSync(settingsPath, JSON.stringify({ defaultModel: 'demo.glb' }));

    expect(injectNewsIntoSettings(settingsPath, '')).toBe(false);
    expect(JSON.parse(readFileSync(settingsPath, 'utf8')).news).toBeUndefined();
  });

  it('keeps private customer settings news-free', () => {
    const settings = JSON.parse(generatePrivateSettings(
      { name: 'Customer', code: 'customer', settings: { defaultModel: 'machine.glb' } },
      'customer',
    ));
    expect(settings.news).toBeUndefined();
  });
});
