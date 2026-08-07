// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useSyncExternalStore, useEffect } from 'react';
import { Box } from '@mui/material';
import { StatRow, SettingsSection } from './settings-helpers';
import {
  subscribeConnectStore,
  getConnectSnapshot,
  fetchDiagnoseStatus,
} from '../connect-store';
import { hasReadyChatProvider, ragState } from './rag-status';

/** Relative "Xs/m/h/d ago" for an ISO-8601 UTC timestamp. */
function fmtIsoAgo(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.round(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.round(h / 24)}d ago`;
}

/**
 * CONNECT RAG / LLM status, shown in the AI settings tab next to the MCP bridge (plan-284). Reads
 * the shared connect-store snapshot and polls `GET /diagnose/status` on the same 2 s cadence as the
 * connect status dots while this section is mounted and the gateway is connected.
 */
export function RagStatusSection() {
  const snap = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot);

  useEffect(() => {
    if (snap.state !== 'connected') return;
    void fetchDiagnoseStatus();
    const id = window.setInterval(() => void fetchDiagnoseStatus(), 2000);
    return () => window.clearInterval(id);
  }, [snap.state]);

  const st = ragState(snap);
  const rag = snap.rag;
  const detailed = rag !== undefined && rag.supported && rag.enabled;
  const chatReady = hasReadyChatProvider(snap);

  return (
    <SettingsSection id="connect-rag" title="CONNECT RAG / LLM">
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <StatRow label="Status" value={st.label} color={st.color} />
        {detailed && (
          <>
            {rag.model && <StatRow label="Chat model" value={rag.model} />}
            {rag.embeddingModel && <StatRow label="Embedding" value={rag.embeddingModel} />}
            <StatRow label="Reranker" value={rag.rerankState} />
            {rag.providers && (
              <StatRow
                label="Providers"
                value={`emb ${rag.providers.embedding} · rerank ${rag.providers.rerank} · chat ${rag.providers.chat}`}
              />
            )}
            {rag.chatProviders?.map((provider) => {
              const ready = provider.status.toLowerCase() === 'ready';
              const failed = ['faulted', 'unauthenticated', 'missingbinary', 'unsupportedversion']
                .includes(provider.status.toLowerCase());
              return (
                <StatRow
                  key={provider.name}
                  label={`Chat · ${provider.name}`}
                  value={provider.detail ? `${provider.status} · ${provider.detail}` : provider.status}
                  color={ready ? '#66bb6a' : failed ? '#ef5350' : undefined}
                />
              );
            })}
            {rag.chatTimeoutSeconds !== undefined && (
              <StatRow label="Chat timeout" value={`${rag.chatTimeoutSeconds} s`} />
            )}
            {rag.docs !== undefined && <StatRow label="Indexed docs" value={String(rag.docs)} />}
            {rag.chunks !== undefined && <StatRow label="Indexed chunks" value={String(rag.chunks)} />}
            <StatRow
              label="Requesty key"
              value={rag.apiKeyConfigured ? 'configured' : chatReady ? 'not required' : 'missing'}
              color={rag.apiKeyConfigured || chatReady ? undefined : '#ef5350'}
            />
            <StatRow label="LLM backend" value="not checked" />
            {rag.lastSuccessfulSyncUtc && (
              <StatRow label="Last indexed" value={fmtIsoAgo(rag.lastSuccessfulSyncUtc)} />
            )}
            {rag.lastSyncError && (
              <StatRow label="Last sync error" value={rag.lastSyncError} color="#ffa726" />
            )}
          </>
        )}
      </Box>
    </SettingsSection>
  );
}
