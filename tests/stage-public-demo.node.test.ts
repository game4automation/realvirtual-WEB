// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  assertPublicDemoOutput,
  preparePublicDemoSource,
} from '../../realvirtual-Connect~/tools/stage-public.mjs';

let fixture = '';
afterEach(() => {
  if (fixture) rmSync(fixture, { recursive: true, force: true });
  delete process.env.RV_WEB_SOURCE_URL;
});

describe('CONNECT public-demo staging guard', () => {
  it('reduces models before build and injects an authoritative gate config', () => {
    fixture = mkdtempSync(join(tmpdir(), 'rv-public-demo-test-'));
    const publicRoot = join(fixture, 'public');
    const modelsRoot = join(publicRoot, 'models');
    mkdirSync(join(modelsRoot, 'library'), { recursive: true });
    for (const name of [
      'DemoRealvirtualWeb.glb',
      'DemoRealvirtualWeb.settings.json',
      'DemoRobotIK.glb',
      'tests.glb',
    ]) writeFileSync(join(modelsRoot, name), name);
    writeFileSync(join(modelsRoot, 'library', 'asset.glb'), 'library');
    writeFileSync(join(publicRoot, 'settings.json'), JSON.stringify({ defaultModel: 'models/tests.glb' }));
    writeFileSync(join(publicRoot, 'index.html'), '<!doctype html>');
    process.env.RV_WEB_SOURCE_URL = 'https://example.invalid/source/tag';

    const sourceRoot = resolve(__dirname, '..');
    preparePublicDemoSource(fixture, sourceRoot);
    assertPublicDemoOutput(publicRoot);

    const settings = JSON.parse(readFileSync(join(publicRoot, 'settings.json'), 'utf8'));
    expect(settings.defaultModel).toBe('');
    expect(settings.ui.initialContexts).toEqual(['connect-embed']);
    expect(JSON.parse(readFileSync(join(publicRoot, 'models.json'), 'utf8'))).toEqual(['DemoRealvirtualWeb.glb']);
  });
});
