// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Parsed `SimDesControl.batchProgressJson()`. */
export interface BatchProgress { exp: string; replIndex: number; total: number; phase: string; reason?: string; detail?: string }
export function parseBatchProgress(json: string | null | undefined): BatchProgress | null {
  if (!json) return null;
  try {
    const raw = JSON.parse(json) as Record<string, unknown>;
    if (typeof raw.exp !== 'string') return null;
    return {
      exp: raw.exp,
      replIndex: typeof raw.replIndex === 'number' ? raw.replIndex : 0,
      total: typeof raw.total === 'number' ? raw.total : 0,
      phase: typeof raw.phase === 'string' ? raw.phase : 'running',
      ...(typeof raw.reason === 'string' ? { reason: raw.reason } : {}),
      ...(typeof raw.detail === 'string' ? { detail: raw.detail } : {}),
    };
  } catch { return null; }
}

