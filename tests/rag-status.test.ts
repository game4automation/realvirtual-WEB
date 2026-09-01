// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect } from 'vitest';
import type { ConnectSnapshot, RagStatus } from '../src/core/hmi/connect-store';
import { ragState } from '../src/core/hmi/settings/rag-status';

/** Full, type-safe ConnectSnapshot (no `as any`) — override only the fields under test. */
function snap(
  state: ConnectSnapshot['state'],
  rag?: RagStatus,
  gatewayUnreachable = false,
): ConnectSnapshot {
  return {
    serverUrl: 'http://localhost:5100',
    state,
    errorMessage: '',
    serverVersion: '',
    serverBuild: '',
    serverBuildDate: '',
    gatewayUnreachable,
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
    revealSupported: false,
    rag,
  };
}

describe('ragState', () => {
  it('offline when not connected', () => {
    expect(ragState(snap('disconnected')).level).toBe('offline');
  });

  it('offline when connected but gateway unreachable', () => {
    expect(ragState(snap('connected', undefined, true)).level).toBe('offline');
  });

  it('loading when connected but first poll pending (rag undefined)', () => {
    expect(ragState(snap('connected', undefined)).level).toBe('loading');
  });

  it('unsupported for an old gateway (supported:false), distinct from disabled', () => {
    expect(ragState(snap('connected', { supported: false })).level).toBe('unsupported');
  });

  it('disabled only when explicitly enabled:false', () => {
    const r = ragState(snap('connected', { supported: true, enabled: false, indexState: 'ready', rerankState: 'ready' }));
    expect(r.level).toBe('disabled');
  });

  it('error when reranker faulted (precedence over a ready index)', () => {
    const r = ragState(snap('connected', { supported: true, enabled: true, indexState: 'ready', rerankState: 'faulted' }));
    expect(r.level).toBe('error');
  });

  it('error when reranker missing', () => {
    const r = ragState(snap('connected', { supported: true, enabled: true, indexState: 'ready', rerankState: 'missing' }));
    expect(r.level).toBe('error');
  });

  it('error when API key missing even if index ready', () => {
    const r = ragState(snap('connected', {
      supported: true, enabled: true, indexState: 'ready', rerankState: 'ready', apiKeyConfigured: false,
    }));
    expect(r.level).toBe('error');
  });

  it('does not require a Requesty key when another chat provider is ready', () => {
    const r = ragState(snap('connected', {
      supported: true,
      enabled: true,
      indexState: 'ready',
      rerankState: 'ready',
      apiKeyConfigured: false,
      chatProviders: [{ name: 'claude-cli', status: 'Ready' }],
    }));
    expect(r.level).toBe('ready');
  });

  it('error when index faulted', () => {
    const r = ragState(snap('connected', {
      supported: true, enabled: true, indexState: 'faulted', rerankState: 'ready', apiKeyConfigured: true,
    }));
    expect(r.level).toBe('error');
  });

  it('busy while indexing', () => {
    const r = ragState(snap('connected', { supported: true, enabled: true, indexState: 'indexing', rerankState: 'ready' }));
    expect(r.level).toBe('busy');
  });

  it('idle when uninitialized (not empty)', () => {
    const r = ragState(snap('connected', { supported: true, enabled: true, indexState: 'uninitialized', rerankState: 'disabled' }));
    expect(r.level).toBe('idle');
  });

  it('empty when loaded but no documents', () => {
    const r = ragState(snap('connected', { supported: true, enabled: true, indexState: 'empty', rerankState: 'disabled' }));
    expect(r.level).toBe('empty');
  });

  it('ready only when index ready + key present + rerank ok', () => {
    const r = ragState(snap('connected', {
      supported: true, enabled: true, indexState: 'ready', rerankState: 'ready', apiKeyConfigured: true,
    }));
    expect(r.level).toBe('ready');
  });
});
