// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, expect, it, vi } from 'vitest';
import {
  attachConnectEmbedModeManager,
  beginConnectEmbedDemoLoad,
  completeConnectEmbedDemoLoad,
  getConnectEmbedSnapshot,
  initializeConnectEmbedStore,
  isConnectEmbedMinimalShell,
  resetConnectEmbedDemo,
} from '../src/plugins/connect-embed/connect-embed-store';

describe('CONNECT embedded disabled guard', () => {
  it('is a complete no-op without the connect-embed initial context', () => {
    const lock = vi.fn();
    const unlock = vi.fn();
    expect(initializeConnectEmbedStore({ ui: { initialContexts: ['planner', 'fpv', 'xr'] } })).toBe(false);
    attachConnectEmbedModeManager({ lock, unlock });
    expect(beginConnectEmbedDemoLoad()).toBe(false);
    completeConnectEmbedDemoLoad();
    resetConnectEmbedDemo();
    expect(getConnectEmbedSnapshot()).toEqual({ enabled: false, state: 'gated-empty', error: null });
    expect(isConnectEmbedMinimalShell()).toBe(false);
    expect(lock).not.toHaveBeenCalled();
    expect(unlock).not.toHaveBeenCalled();
  });
});
