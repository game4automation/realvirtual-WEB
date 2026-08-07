// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import {
  attachConnectEmbedModeManager,
  beginConnectEmbedDemoLoad,
  completeConnectEmbedDemoLoad,
  failConnectEmbedDemoLoad,
  getConnectEmbedSnapshot,
  initializeConnectEmbedStore,
  resetConnectEmbedDemo,
} from '../src/plugins/connect-embed/connect-embed-store';

const config = { ui: { initialContexts: ['connect-embed'] } };

describe('CONNECT embedded gate lifecycle', () => {
  it('guards re-entry, unlocks after success, and relocks after close', () => {
    const lock = vi.fn();
    const unlock = vi.fn();
    initializeConnectEmbedStore(config);
    attachConnectEmbedModeManager({ lock, unlock });
    expect(beginConnectEmbedDemoLoad()).toBe(true);
    expect(beginConnectEmbedDemoLoad()).toBe(false);
    completeConnectEmbedDemoLoad();
    expect(getConnectEmbedSnapshot().state).toBe('demo-running');
    expect(unlock).toHaveBeenCalledOnce();

    // Model reloads do not reinitialize this independent store.
    expect(getConnectEmbedSnapshot().state).toBe('demo-running');
    resetConnectEmbedDemo();
    expect(getConnectEmbedSnapshot().state).toBe('gated-empty');
    expect(lock).toHaveBeenLastCalledWith('hmi');
  });

  it('surfaces typed load errors and a fresh boot is always empty', () => {
    initializeConnectEmbedStore(config);
    beginConnectEmbedDemoLoad();
    failConnectEmbedDemoLoad('404 Not Found');
    expect(getConnectEmbedSnapshot()).toMatchObject({ state: 'load-error', error: '404 Not Found' });
    expect(beginConnectEmbedDemoLoad()).toBe(true);
    initializeConnectEmbedStore(config);
    expect(getConnectEmbedSnapshot()).toEqual({ enabled: true, state: 'gated-empty', error: null });
  });
});
