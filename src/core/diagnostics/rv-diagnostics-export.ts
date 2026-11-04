// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { downloadTextFile } from '../hmi/rv-download-text-file';
import { getDiagnosticsEntries, type DiagEntry } from './rv-diagnostics-collector';
import {
  createTabState, flushDiagnosticsStreamer, isDiagnosticsConnectOrigin, queueTabStateSnapshot,
} from './rv-diagnostics-streamer';

export interface DiagnosticsPreview {
  lines: number;
  errors: number;
  warnings: number;
  sources: { browser: true; connect: boolean };
  first: DiagEntry[];
  last: DiagEntry[];
}

export interface DiagnosticsExportResult {
  ok: true;
  file: string;
  source: 'connect' | 'browser';
}

function stamp(date = new Date()): string {
  return date.toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
}

function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}

function filenameFromDisposition(value: string | null): string | null {
  const match = /filename\*?=(?:UTF-8''|["']?)([^"';]+)/i.exec(value ?? '');
  return match ? decodeURIComponent(match[1].trim()) : null;
}

export async function previewDiagnostics(minutes = 15): Promise<DiagnosticsPreview> {
  const entries = getDiagnosticsEntries({ sinceMs: minutes * 60_000 });
  return {
    lines: entries.length,
    errors: entries.filter(e => e.lvl === 'error').length,
    warnings: entries.filter(e => e.lvl === 'warn').length,
    sources: { browser: true, connect: await isDiagnosticsConnectOrigin() },
    first: entries.slice(0, 3),
    last: entries.slice(-3),
  };
}

export async function exportDiagnostics({ minutes = 15 }: { minutes?: number } = {}): Promise<DiagnosticsExportResult> {
  const safeMinutes = [5, 15, 30, 60].includes(minutes) ? minutes : 15;
  queueTabStateSnapshot();
  if (await isDiagnosticsConnectOrigin()) {
    try {
      await flushDiagnosticsStreamer();
      const clientTime = new Date().toISOString();
      const response = await fetch(`/diag/bundle?minutes=${safeMinutes}&clientTime=${encodeURIComponent(clientTime)}`);
      if (!response.ok) throw new Error(`Diagnostics bundle failed (${response.status})`);
      const file = filenameFromDisposition(response.headers.get('Content-Disposition'))
        ?? `rv-diagnostics-${stamp()}.zip`;
      downloadBlob(await response.blob(), file);
      return { ok: true, file, source: 'connect' };
    } catch { /* a local browser export is always available */ }
  }

  const state = createTabState();
  const entries = getDiagnosticsEntries({ sinceMs: safeMinutes * 60_000 });
  const file = `rv-diagnostics-${stamp()}.json`;
  const environment = {
    createdAt: new Date().toISOString(), windowMinutes: safeMinutes,
    web: { tabs: [{ ...state, ageSeconds: 0, stale: false }] },
  };
  downloadTextFile(JSON.stringify({ environment, entries }, null, 2), file, 'application/json;charset=utf-8');
  return { ok: true, file, source: 'browser' };
}
