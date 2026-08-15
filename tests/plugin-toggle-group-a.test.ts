// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-435 T6 — Group A: plugins where the `onModelCleared` fallback would be
 * actively HARMFUL. The point of each test is the thing that must NOT happen.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LAYOUT_EDIT_PAUSE_REASON } from '../src/core/engine/rv-constants';
import { LayoutPlannerPlugin } from '../src/plugins/layout-planner/index';
import { MultiuserPlugin } from '../src/plugins/multiuser-plugin';
import { createCoreViewer, resetModeStorage } from './helpers/core-toggle-viewer';

beforeEach(() => {
  resetModeStorage();
});

describe('Group A — multiuser', () => {
  it('does not leave the room when the user switches the plugin off', () => {
    const plugin = new MultiuserPlugin();
    const internals = plugin as unknown as {
      _sendLeave: () => void;
      _disconnect: () => void;
      _avatarManager: { clear: () => void; getPlayers: () => unknown[]; addAvatar: (p: unknown) => void } | null;
      _suspendedAvatars: unknown;
      _stopFollowing: () => void;
      _emitChanged: () => void;
    };
    const sendLeave = vi.fn();
    const disconnect = vi.fn();
    const players = [{ id: 'p1', name: 'Ada', color: '#fff' }];
    const clear = vi.fn();
    const addAvatar = vi.fn();
    internals._sendLeave = sendLeave;
    internals._disconnect = disconnect;
    internals._stopFollowing = vi.fn();
    internals._emitChanged = vi.fn();
    internals._avatarManager = { clear, getPlayers: () => players, addAvatar };

    plugin.onDeactivate();

    // The session is untouched — this is a LOCAL diagnostic click.
    expect(sendLeave).not.toHaveBeenCalled();
    expect(disconnect).not.toHaveBeenCalled();
    // …but the remote avatars are gone from the local scene.
    expect(clear).toHaveBeenCalledOnce();
    expect(internals._avatarManager).toBeNull();

    plugin.onActivate();
    expect(internals._suspendedAvatars).toBeNull();
    expect(addAvatar).toHaveBeenCalledTimes(players.length);
  });

  it('is idempotent — a second onDeactivate does not clear twice', () => {
    const plugin = new MultiuserPlugin();
    const internals = plugin as unknown as Record<string, unknown>;
    const clear = vi.fn();
    internals._stopFollowing = vi.fn();
    internals._emitChanged = vi.fn();
    internals._avatarManager = { clear, getPlayers: () => [], addAvatar: vi.fn() };

    plugin.onDeactivate();
    plugin.onDeactivate();
    expect(clear).toHaveBeenCalledOnce();
  });
});

describe('Group A — layout-planner', () => {
  it('releases the edit pause reason it may be holding mid-gesture', () => {
    const plugin = new LayoutPlannerPlugin();
    const internals = plugin as unknown as { _editPauseDepth: number };
    // Simulate a toggle in the middle of a drag: the refcount is up and
    // nothing else would ever bring it back down.
    internals._editPauseDepth = 2;

    const setSimulationPaused = vi.fn();
    const viewer = {
      setSimulationPaused,
      leftPanelManager: { isOpen: () => false, close: vi.fn() },
    } as never;

    plugin.onDeactivate(viewer);

    expect(setSimulationPaused).toHaveBeenCalledWith(LAYOUT_EDIT_PAUSE_REASON, false);
    expect(internals._editPauseDepth).toBe(0);
  });
});

describe('Group A — connect', () => {
  it('detaches the live stream without touching the model bookkeeping', async () => {
    const { viewer, modes } = createCoreViewer();
    const detach = vi.fn();
    const attach = vi.fn();
    // A stand-in with the same hook shape — the real plugin pulls in the whole
    // CONNECT stack, which this contract test does not need.
    viewer.use({
      id: 'connect',
      onModelLoaded: attach,
      onModelCleared: detach,
      onDeactivate: detach,
      onActivate: attach,
    });
    modes.setMode('hmi');

    viewer.setPluginUserEnabled('connect', false);
    expect(detach).toHaveBeenCalledOnce();
    viewer.setPluginUserEnabled('connect', true);
    expect(attach).toHaveBeenCalledOnce();
  });
});
