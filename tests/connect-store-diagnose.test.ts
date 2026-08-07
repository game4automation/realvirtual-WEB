// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  mapDiagnoseStatus,
  fetchDiagnoseStatus,
  getConnectSnapshot,
} from '../src/core/hmi/connect-store';

describe('mapDiagnoseStatus', () => {
  it('maps a full status object', () => {
    const rag = mapDiagnoseStatus(200, {
      supported: true, enabled: true, indexState: 'ready', rerankState: 'ready',
      model: 'gpt-4o-mini', embeddingModel: 'text-embedding-3-small',
      docs: 42, chunks: 3187, dim: 1536, apiKeyConfigured: true,
      providers: { embedding: 'cloud', rerank: 'local', chat: 'cloud' },
      chatProviders: [
        { name: 'cloud', status: 'Ready' },
        { name: 'claude-cli', status: 'Disabled', detail: 'no CLI corpus configured' },
      ],
      chatTimeoutSeconds: 120,
      lastSuccessfulSyncUtc: '2026-07-14T08:00:00Z', lastSyncError: null,
    });
    expect(rag).toMatchObject({
      supported: true, enabled: true, indexState: 'ready', model: 'gpt-4o-mini',
      docs: 42, chunks: 3187, apiKeyConfigured: true,
    });
    if (rag.supported) {
      expect(rag.providers).toEqual({ embedding: 'cloud', rerank: 'local', chat: 'cloud' });
      expect(rag.chatProviders).toEqual([
        { name: 'cloud', status: 'Ready' },
        { name: 'claude-cli', status: 'Disabled', detail: 'no CLI corpus configured' },
      ]);
      expect(rag.chatTimeoutSeconds).toBe(120);
    }
  });

  it('404 → unsupported (old gateway), distinct from disabled', () => {
    const rag = mapDiagnoseStatus(404, null);
    expect(rag.supported).toBe(false);
  });

  it('200 text/html (SPA fallback) → unsupported', () => {
    const rag = mapDiagnoseStatus(200, '<!doctype html><html></html>', 'text/html; charset=utf-8');
    expect(rag.supported).toBe(false);
  });

  it('disabled gateway stays supported:true, enabled:false (NOT unsupported)', () => {
    const rag = mapDiagnoseStatus(200, { supported: true, enabled: false, indexState: 'uninitialized', rerankState: 'disabled' });
    expect(rag.supported).toBe(true);
    if (rag.supported) expect(rag.enabled).toBe(false);
  });

  it('reflects a re-index between polls (chunks + lastSuccessfulSyncUtc change)', () => {
    const a = mapDiagnoseStatus(200, { supported: true, enabled: true, indexState: 'ready', rerankState: 'ready', docs: 1, chunks: 10, lastSuccessfulSyncUtc: '2026-07-14T08:00:00Z' });
    const b = mapDiagnoseStatus(200, { supported: true, enabled: true, indexState: 'ready', rerankState: 'ready', docs: 2, chunks: 25, lastSuccessfulSyncUtc: '2026-07-14T09:00:00Z' });
    if (a.supported && b.supported) {
      expect(a.chunks).toBe(10);
      expect(b.chunks).toBe(25);
      expect(a.lastSuccessfulSyncUtc).not.toBe(b.lastSuccessfulSyncUtc);
    }
  });

  it('tolerates missing optional fields', () => {
    const rag = mapDiagnoseStatus(200, { supported: true, enabled: true, indexState: 'ready', rerankState: 'ready' });
    expect(rag.supported).toBe(true);
    if (rag.supported) {
      expect(rag.chunks).toBeUndefined();
      expect(rag.providers).toBeUndefined();
      expect(rag.chatProviders).toBeUndefined();
      expect(rag.chatTimeoutSeconds).toBeUndefined();
    }
  });

  it('keeps the legacy providers.chat string contract without new status fields', () => {
    const rag = mapDiagnoseStatus(200, {
      supported: true,
      enabled: true,
      indexState: 'ready',
      rerankState: 'ready',
      providers: { embedding: 'cloud', rerank: 'local', chat: 'cloud' },
    });
    expect(rag.supported).toBe(true);
    if (rag.supported) {
      expect(rag.providers?.chat).toBe('cloud');
      expect(rag.chatProviders).toBeUndefined();
      expect(rag.chatTimeoutSeconds).toBeUndefined();
    }
  });
});

describe('fetchDiagnoseStatus guard', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('discards a response when the store is not connected (URL/state guard)', async () => {
    // Default store state is 'disconnected'. Even a valid response must NOT set snapshot.rag,
    // because the guard drops results that arrive while not connected (SOL RC9).
    vi.stubGlobal('fetch', vi.fn(async () => new Response(
      JSON.stringify({ supported: true, enabled: true, indexState: 'ready', rerankState: 'ready' }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    )));

    await fetchDiagnoseStatus();

    expect(getConnectSnapshot().state).not.toBe('connected');
    expect(getConnectSnapshot().rag).toBeUndefined();
  });
});
