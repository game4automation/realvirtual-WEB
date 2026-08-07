// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, afterEach, vi } from 'vitest';
import { render, screen, cleanup } from '@testing-library/react';
import type { ConnectSnapshot, RagStatus } from '../src/core/hmi/connect-store';

const h = vi.hoisted(() => ({ snap: null as unknown as ConnectSnapshot }));

// Mock the store so the section renders against a controlled snapshot (no live gateway / poll).
vi.mock('../src/core/hmi/connect-store', () => ({
  subscribeConnectStore: () => () => {},
  getConnectSnapshot: () => h.snap,
  fetchDiagnoseStatus: () => Promise.resolve(),
}));

// Imported AFTER the mock so it binds the mocked store.
import { RagStatusSection } from '../src/core/hmi/settings/RagStatusSection';

function snap(state: ConnectSnapshot['state'], rag?: RagStatus): ConnectSnapshot {
  return {
    serverUrl: 'http://localhost:5100',
    state,
    errorMessage: '',
    serverVersion: '',
    serverBuild: '',
    serverBuildDate: '',
    gatewayUnreachable: false,
    lastStatusUpdate: 0,
    interfaces: [],
    interfaceStatus: {},
    activeProfile: null,
    activeProfileModel: null,
    availableTypes: null,
    activeInterfaceId: null,
    discoveredSignals: [],
    discoveryLoading: false,
    updateSupported: false,
    updateReason: null,
    rag,
  };
}

describe('RagStatusSection', () => {
  afterEach(() => cleanup());

  it('shows the offline hint when CONNECT is not connected', () => {
    h.snap = snap('disconnected');
    render(<RagStatusSection />);
    expect(screen.getByText(/not connected/i)).toBeTruthy();
  });

  it('shows the unsupported hint for an old gateway', () => {
    h.snap = snap('connected', { supported: false });
    render(<RagStatusSection />);
    expect(screen.getByText(/unsupported/i)).toBeTruthy();
  });

  it('shows model + chunks when ready', () => {
    h.snap = snap('connected', {
      supported: true, enabled: true, indexState: 'ready', rerankState: 'ready',
      apiKeyConfigured: true, model: 'gpt-4o-mini', chunks: 3187,
    });
    render(<RagStatusSection />);
    expect(screen.getByText('Ready')).toBeTruthy();
    expect(screen.getByText('gpt-4o-mini')).toBeTruthy();
    expect(screen.getByText('3187')).toBeTruthy();
  });

  it('shows ready chat providers and treats a missing Requesty key as optional', () => {
    h.snap = snap('connected', {
      supported: true, enabled: true, indexState: 'ready', rerankState: 'ready',
      apiKeyConfigured: false,
      providers: { embedding: 'cloud', rerank: 'local', chat: 'claude-cli' },
      chatProviders: [{ name: 'claude-cli', status: 'Ready' }],
      chatTimeoutSeconds: 120,
    });
    render(<RagStatusSection />);
    expect(screen.getAllByText('Ready')).toHaveLength(2);
    expect(screen.getByText('not required')).toBeTruthy();
    expect(screen.getByText('120 s')).toBeTruthy();
  });
});
