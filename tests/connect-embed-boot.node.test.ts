// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  attachConnectEmbedModeManager,
  getConnectEmbedSnapshot,
  initializeConnectEmbedStore,
} from '../src/plugins/connect-embed/connect-embed-store';

const mainSource = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');

describe('CONNECT embedded boot gate', () => {
  it.each(['scene', 'model', 'firebaseDemoName', 'savedModel', 'activeId', 'configModel', 'entries[0]'])(
    'keeps the %s boot path behind the central gate branch',
    (pathMarker) => {
      const gatedBranch = mainSource.indexOf('if (connectEmbedEnabled) {', mainSource.indexOf('const firebaseDemoName'));
      const normalBranch = mainSource.indexOf('} else if (firebaseDemoName)', gatedBranch);
      expect(gatedBranch).toBeGreaterThan(0);
      expect(normalBranch).toBeGreaterThan(gatedBranch);
      expect(mainSource.indexOf(pathMarker, normalBranch)).toBeGreaterThan(normalBranch);
    },
  );

  it('starts empty and locks hmi without writing model or scene resume keys', () => {
    const lock = vi.fn();
    const unlock = vi.fn();
    expect(initializeConnectEmbedStore({ ui: { initialContexts: ['connect-embed'] } })).toBe(true);
    attachConnectEmbedModeManager({ lock, unlock });
    expect(getConnectEmbedSnapshot()).toEqual({ enabled: true, state: 'gated-empty', error: null });
    expect(lock).toHaveBeenCalledWith('hmi');
    expect(unlock).not.toHaveBeenCalled();

    const loaderBody = mainSource.slice(mainSource.indexOf('async function loadModel'), mainSource.indexOf('// Expose loadModel'));
    expect(loaderBody).toContain('if (!connectEmbedEnabled)');
    expect(loaderBody).toContain('localStorage.setItem(LS_KEY_MODEL, url)');
    expect(loaderBody).toContain('sceneStore.markGlbActive(url, label)');
  });
});
