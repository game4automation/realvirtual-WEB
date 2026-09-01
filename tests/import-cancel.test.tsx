// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * import-cancel.test.tsx — plan-444 §9.4 (F2).
 *
 * "Cancel takes effect immediately" is a claim about a RACE, so it is pinned at
 * the only place the race is decidable: the store publishes `cancelled`
 * synchronously with the click, and everything the abandoned job says
 * afterwards is dropped.
 *
 * Signalling alone — the pre-444 behaviour — was not enough and the reason is
 * worth stating: the dialog's busy state is `job.status === 'running'`, and the
 * status only changed when the provider's promise finally settled. An in-flight
 * upload, a poll interval, or an occt tessellation that cannot be interrupted
 * at all could hold that for a minute, during which Cancel looked like it had
 * done nothing and the progress bar kept moving.
 *
 * The last case is the one that would otherwise bite hardest: a job that
 * resolves AFTER its cancel must not repaint the dialog with a stale result, or
 * worse, hand its bytes to the sink and place the model the user just refused.
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, act } from '@testing-library/react';
import {
  abortImportJob,
  getImportJobSnapshot,
  startImportJob,
  subscribeImportJob,
  _resetImportJobForTests,
} from '../src/plugins/unified-import/import-job-store';
import { UnifiedImportDialog } from '../src/plugins/unified-import/UnifiedImportDialog';
import { importProviderRegistry } from '../src/core/import/rv-import-provider';
import { resolveGlbFiles } from '../src/plugins/unified-import/glb-file-provider';
import type {
  CadImportProvider,
  ImportProgressListener,
  ImportProviderResult,
} from '../src/core/import/rv-import-provider';
import type { RVViewer } from '../src/core/rv-viewer';

/** Enough viewer for the dialog: it reads the mode and hands the rest on. */
const fakeViewer = { modes: { activeMode: 'planner' } } as unknown as RVViewer;

/** A provider whose resolve hangs until the test releases it. */
function hangingProvider(id = 'test-hang'): {
  provider: CadImportProvider;
  settle: (result: ImportProviderResult) => void;
  reportProgress: (label: string) => void;
  started: () => boolean;
} {
  let release: ((result: ImportProviderResult) => void) | null = null;
  let progress: ImportProgressListener | undefined;
  let began = false;

  const provider: CadImportProvider = {
    id,
    label: 'Hang',
    availability: () => 'ready',
    onAvailabilityChange: () => () => undefined,
    renderConfigTab: () => null,
    resolve: (_input, onProgress) => {
      began = true;
      progress = onProgress;
      return new Promise<ImportProviderResult>((resolve) => { release = resolve; });
    },
  };

  return {
    provider,
    settle: (result) => release?.(result),
    reportProgress: (label) => progress?.({ percent: null, label }),
    started: () => began,
  };
}

function start(provider: CadImportProvider): boolean {
  return startImportJob(fakeViewer, provider, { kind: 'custom', data: null }, {
    isEditor: false, alignToFloor: false,
  });
}

beforeEach(() => _resetImportJobForTests());
afterEach(() => {
  cleanup();
  _resetImportJobForTests();
  for (const p of importProviderRegistry.list()) importProviderRegistry.unregister(p.id);
});

// ─── The store: cancel is immediate ─────────────────────────────────────

describe('abortImportJob', () => {
  it('leaves the job idle and cancelled in the same tick as the click', () => {
    const { provider } = hangingProvider();
    expect(start(provider)).toBe(true);
    expect(getImportJobSnapshot().status).toBe('running');

    abortImportJob();

    // No await anywhere: the provider is still hanging, and the user is
    // already back in the selection state.
    expect(getImportJobSnapshot().status).toBe('idle');
    expect(getImportJobSnapshot().outcome?.kind).toBe('cancelled');
    expect(getImportJobSnapshot().progress).toBeNull();
  });

  it('notifies subscribers exactly once for the cancel', () => {
    const { provider } = hangingProvider();
    start(provider);
    const seen: string[] = [];
    const off = subscribeImportJob(() => seen.push(getImportJobSnapshot().status));

    abortImportJob();
    off();
    expect(seen).toEqual(['idle']);
  });

  it('reports no errors — a cancel is not a failure', () => {
    const { provider } = hangingProvider();
    start(provider);
    abortImportJob();
    expect(getImportJobSnapshot().outcome).toEqual({
      kind: 'cancelled', errors: [], warnings: [], importedNames: [],
    });
  });

  it('is a no-op when nothing is running', () => {
    abortImportJob();
    expect(getImportJobSnapshot()).toEqual({
      status: 'idle', providerLabel: null, progress: null, outcome: null,
    });
  });

  it('lets a new import start straight away', () => {
    const first = hangingProvider('a');
    const second = hangingProvider('b');
    start(first.provider);
    abortImportJob();

    expect(start(second.provider)).toBe(true);
    expect(getImportJobSnapshot().status).toBe('running');
    expect(second.started()).toBe(true);
  });
});

// ─── Nothing from the abandoned job may come back ───────────────────────

describe('Ein abgebrochener Job schweigt danach', () => {
  it('drops a result that arrives after the cancel', async () => {
    const { provider, settle } = hangingProvider();
    start(provider);
    abortImportJob();

    settle({ ok: [], failed: [{ id: 'x', error: 'too late' }] });
    await Promise.resolve();
    await Promise.resolve();

    // Still cancelled — not "error: too late", which would flash a failure the
    // user caused on purpose.
    expect(getImportJobSnapshot().outcome?.kind).toBe('cancelled');
    expect(getImportJobSnapshot().status).toBe('idle');
  });

  it('drops a progress report that arrives after the cancel', () => {
    const { provider, reportProgress } = hangingProvider();
    start(provider);
    abortImportJob();

    reportProgress('Converting on CONNECT');
    expect(getImportJobSnapshot().progress).toBeNull();
    expect(getImportJobSnapshot().status).toBe('idle');
  });

  it('does not overwrite the outcome of the NEXT job', async () => {
    const first = hangingProvider('a');
    const second = hangingProvider('b');
    start(first.provider);
    abortImportJob();
    start(second.provider);

    // The abandoned first job finishes now. It must not touch the second.
    first.settle({ ok: [], failed: [] });
    await Promise.resolve();
    await Promise.resolve();

    expect(getImportJobSnapshot().status).toBe('running');
    expect(getImportJobSnapshot().providerLabel).toBe('Hang');
  });

  it('never reaches the sink with the bytes of a cancelled job', async () => {
    const { provider, settle } = hangingProvider();
    const sink = vi.fn();
    // If the run continued past its cancel, the placement would happen here.
    start({ ...provider, resolve: provider.resolve });
    abortImportJob();

    settle({ ok: [{ kind: 'glb', bytes: new ArrayBuffer(8), suggestedName: 'part' }], failed: [] });
    await Promise.resolve();
    await Promise.resolve();

    expect(sink).not.toHaveBeenCalled();
    expect(getImportJobSnapshot().outcome?.importedNames ?? []).toEqual([]);
  });
});

// ─── Multi-file: abort takes effect between files ───────────────────────

describe('Abbruch zwischen Dateien', () => {
  function file(name: string): File {
    return new File(['glTF-data'], name, { type: 'model/gltf-binary' });
  }

  it('stops resolveGlbFiles before it reads the next file', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(resolveGlbFiles([file('a.glb'), file('b.glb')], controller.signal))
      .rejects.toMatchObject({ name: 'AbortError' });
  });

  it('aborts mid-list rather than finishing the remaining files', async () => {
    const controller = new AbortController();
    const files = [file('a.glb'), file('b.glb'), file('c.glb')];
    // Abort as soon as the first file's bytes have been read.
    const original = File.prototype.arrayBuffer;
    let reads = 0;
    File.prototype.arrayBuffer = async function patched(this: File) {
      reads++;
      if (reads === 1) controller.abort();
      return original.call(this);
    };
    try {
      await expect(resolveGlbFiles(files, controller.signal))
        .rejects.toMatchObject({ name: 'AbortError' });
      expect(reads).toBe(1);
    } finally {
      File.prototype.arrayBuffer = original;
    }
  });
});

// ─── The dialog is a view of that state ─────────────────────────────────

describe('UnifiedImportDialog nach Cancel', () => {
  it('kehrt sofort in den Auswahlzustand zurück', () => {
    const { provider } = hangingProvider();
    importProviderRegistry.register(provider);
    render(<UnifiedImportDialog viewer={fakeViewer} open onClose={() => undefined} />);

    act(() => { start(provider); });
    // Busy: the footer says "Cancel import" and the primary button is blocked.
    // ("Importing…" is also the progress label, so the button is addressed by
    // role rather than by text.)
    expect(screen.getByText('Cancel import')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Importing…' })).toHaveProperty('disabled', true);

    act(() => { abortImportJob(); });

    // Back to the selection state, with the note that the selection is kept.
    // ("Import" is also the dialog title — the button is the one that matters.)
    expect(screen.queryByText('Cancel import')).toBeNull();
    expect(screen.getByRole('button', { name: 'Import' })).toBeTruthy();
    expect(screen.getByText(/Import cancelled/)).toBeTruthy();
  });

  it('zeigt keinen Fortschrittsbalken mehr', () => {
    const { provider, reportProgress } = hangingProvider();
    importProviderRegistry.register(provider);
    const { container } = render(
      <UnifiedImportDialog viewer={fakeViewer} open onClose={() => undefined} />,
    );

    act(() => { start(provider); });
    act(() => { reportProgress('Converting on CONNECT'); });
    expect(container.ownerDocument.querySelector('.MuiLinearProgress-root')).toBeTruthy();

    act(() => { abortImportJob(); });
    expect(container.ownerDocument.querySelector('.MuiLinearProgress-root')).toBeNull();
  });
});
