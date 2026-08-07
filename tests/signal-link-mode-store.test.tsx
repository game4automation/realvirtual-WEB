// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import {
  armSignalDrag,
  cancelSignalDrag,
  updateSignalDrag,
} from '../src/core/hmi/signal-drag-store';
import { LayoutStore } from '../src/plugins/layout-planner/rv-layout-store';
import { SignalLinkModeButton } from '../src/plugins/signal-bind/SignalLinkModeButton';
import {
  _resetSignalLinkModeStoreForTests,
  getSignalLinkModeSnapshot,
  setSignalLinkModeExplicit,
  SIGNAL_LINK_MODE_STORAGE_KEY,
} from '../src/plugins/signal-bind/signal-link-mode-store';
import type { RVViewer } from '../src/core/rv-viewer';

const PAYLOAD = {
  name: 'Run',
  interfaceId: 'connect',
  direction: 'output' as const,
  origin: 'connect' as const,
  plcType: 'PLCOutputBool',
};

beforeEach(() => {
  cancelSignalDrag();
  localStorage.clear();
  _resetSignalLinkModeStoreForTests();
});

afterEach(() => {
  cancelSignalDrag();
  cleanup();
});

describe('signal-link-mode-store', () => {
  it('restores the legacy LayoutStore key and persists the explicit toggle', () => {
    localStorage.setItem(SIGNAL_LINK_MODE_STORAGE_KEY, 'true');
    _resetSignalLinkModeStoreForTests();
    expect(getSignalLinkModeSnapshot()).toEqual({ explicit: true, active: true });
    setSignalLinkModeExplicit(false);
    expect(localStorage.getItem(SIGNAL_LINK_MODE_STORAGE_KEY)).toBe('false');
  });

  it('activates only after armed becomes dragging and never mutates explicit', () => {
    expect(getSignalLinkModeSnapshot()).toEqual({ explicit: false, active: false });
    armSignalDrag(PAYLOAD, 10, 10);
    updateSignalDrag(12, 12);
    expect(getSignalLinkModeSnapshot()).toEqual({ explicit: false, active: false });
    updateSignalDrag(16, 10);
    expect(getSignalLinkModeSnapshot()).toEqual({ explicit: false, active: true });
    cancelSignalDrag();
    expect(getSignalLinkModeSnapshot()).toEqual({ explicit: false, active: false });
    expect(localStorage.getItem(SIGNAL_LINK_MODE_STORAGE_KEY)).toBeNull();
  });

  it('falls back to an explicit ON toggle when dragging ends', () => {
    setSignalLinkModeExplicit(true);
    armSignalDrag(PAYLOAD, 0, 0);
    updateSignalDrag(5, 0);
    cancelSignalDrag();
    expect(getSignalLinkModeSnapshot()).toEqual({ explicit: true, active: true });
  });

  it('bridges global button toggles to LayoutStore subscribers exactly once', () => {
    const store = new LayoutStore();
    const listener = vi.fn();
    store.subscribe(listener);
    const viewer = { signalBindingManager: {} } as RVViewer;
    render(<SignalLinkModeButton viewer={viewer} />);

    fireEvent.click(screen.getByTestId('signal-link-mode-toggle'));
    expect(store.signalLinkMode).toBe(true);
    expect(store.getSnapshot().signalLinkMode).toBe(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('bridges LayoutStore.setSignalLinkMode without double notification', () => {
    const store = new LayoutStore();
    const listener = vi.fn();
    store.subscribe(listener);
    store.setSignalLinkMode(true);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
