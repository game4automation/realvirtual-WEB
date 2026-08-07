// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * import-job-store tests — the one background import job behind the Unified
 * Import Dialog and the floating progress tile.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import {
  startImportJob, abortImportJob, dismissImportOutcome,
  getImportJobSnapshot, _resetImportJobForTests,
} from '../src/plugins/unified-import/import-job-store';
import type { CadImportProvider, ImportProviderResult } from '../src/core/import/rv-import-provider';
import type { RVViewer } from '../src/core/rv-viewer';

const imported: unknown[][] = [];

function makeViewer(): RVViewer {
  return {
    getPlugin: (id: string) => id === 'asset-editor'
      ? { importItems: async (items: unknown[]) => { imported.push(items); return items.map((_, i) => `node-${i}`); } }
      : undefined,
  } as unknown as RVViewer;
}

function makeProvider(resolve: CadImportProvider['resolve']): CadImportProvider {
  return {
    id: 'fake', label: 'Fake', order: 1,
    availability: () => 'ready',
    onAvailabilityChange: () => () => undefined,
    renderConfigTab: () => null,
    resolve,
  };
}

const glbItem = (name: string): ImportProviderResult => ({
  ok: [{ kind: 'glb', bytes: new ArrayBuffer(8), suggestedName: name }],
  failed: [],
});

beforeEach(() => {
  _resetImportJobForTests();
  imported.length = 0;
});

describe('import-job-store', () => {
  it('runs a job to success and reports imported names', async () => {
    const p = makeProvider(async (_i, onProgress) => {
      onProgress?.({ percent: 0.5, label: 'Halfway' });
      return glbItem('Conveyor');
    });
    const started = startImportJob(makeViewer(), p, { kind: 'custom', data: null }, { isEditor: true, alignToFloor: true });
    expect(started).toBe(true);
    expect(getImportJobSnapshot().status).toBe('running');

    await vi.waitFor(() => expect(getImportJobSnapshot().outcome).not.toBeNull());
    const snap = getImportJobSnapshot();
    expect(snap.status).toBe('idle');
    expect(snap.outcome).toMatchObject({ kind: 'success', importedNames: ['Conveyor'] });
    expect(imported).toHaveLength(1);
  });

  it('normalizes a throwing provider into an error outcome (never a crash)', async () => {
    const p = makeProvider(async () => { throw new Error('memory access out of bounds'); });
    startImportJob(makeViewer(), p, { kind: 'custom', data: null }, { isEditor: true, alignToFloor: true });

    await vi.waitFor(() => expect(getImportJobSnapshot().outcome).not.toBeNull());
    const snap = getImportJobSnapshot();
    expect(snap.outcome?.kind).toBe('error');
    expect(snap.outcome?.errors[0]).toMatch(/memory access/);
    expect(imported).toHaveLength(0);
  });

  it('abort yields a cancelled outcome and never runs the sink', async () => {
    const p = makeProvider((_i, _p, signal) => new Promise((_, reject) => {
      signal?.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')));
    }));
    startImportJob(makeViewer(), p, { kind: 'custom', data: null }, { isEditor: true, alignToFloor: true });
    expect(getImportJobSnapshot().status).toBe('running');

    abortImportJob();
    await vi.waitFor(() => expect(getImportJobSnapshot().outcome).not.toBeNull());
    expect(getImportJobSnapshot().outcome?.kind).toBe('cancelled');
    expect(imported).toHaveLength(0);
  });

  it('refuses a second job while one is running (one at a time)', async () => {
    let release!: () => void;
    const gate = new Promise<void>(r => { release = r; });
    const p = makeProvider(async () => { await gate; return glbItem('A'); });

    expect(startImportJob(makeViewer(), p, { kind: 'custom', data: null }, { isEditor: true, alignToFloor: true })).toBe(true);
    expect(startImportJob(makeViewer(), p, { kind: 'custom', data: null }, { isEditor: true, alignToFloor: true })).toBe(false);

    release();
    await vi.waitFor(() => expect(getImportJobSnapshot().outcome).not.toBeNull());
    expect(getImportJobSnapshot().outcome?.kind).toBe('success');
  });

  it('dismissImportOutcome clears the outcome', async () => {
    const p = makeProvider(async () => glbItem('B'));
    startImportJob(makeViewer(), p, { kind: 'custom', data: null }, { isEditor: true, alignToFloor: true });
    await vi.waitFor(() => expect(getImportJobSnapshot().outcome).not.toBeNull());

    dismissImportOutcome();
    expect(getImportJobSnapshot().outcome).toBeNull();
  });
});
