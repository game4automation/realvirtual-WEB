// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { DocumentFileExportDialog, DocumentApplyDialog } from '../src/core/hmi/scene/DocumentFileExportDialogs';
import type { ActiveDocumentFileExport } from '../src/core/editor/active-document-view';
import type { ApplyPreview, DocumentExportMode, DocumentExportResult, DocumentExportPreflight } from '../src/core/export/rv-export-provider';

afterEach(cleanup);

const MODES: DocumentExportMode[] = [
  {
    id: 'standalone', label: 'Complete scene (.usdz)', fileName: 'scene.usdz', mime: 'model/vnd.usdz+zip',
    description: 'Geometry and realvirtual data. References contain no geometry. Use Record USD animation for motion.',
  },
  {
    id: 'overlay', label: 'realvirtual data layer (.rv.usda)', fileName: 'scene.rv.usda', mime: 'model/vnd.usda',
    description: 'Only realvirtual data on the original USD prim paths.',
    disabledReason: 'Only for documents imported from USD.',
  },
];

function exportResult(n = 3): DocumentExportResult {
  return { bytes: new Uint8Array([1]), fileName: 'scene.usdz', mime: MODES[0].mime, stats: { referencesWithoutGeometry: n } };
}

function mountExport(
  run = vi.fn(async (_mode: string) => exportResult()),
  modes = MODES,
  preflight: ActiveDocumentFileExport['preflight'] | null = vi.fn(async () => ({ referencesWithoutGeometry: 3 })),
) {
  const exp: ActiveDocumentFileExport = { id: 'usd', label: 'Export USD…', modes: () => modes, run, ...(preflight ? { preflight } : {}) };
  const download = vi.fn();
  const onClose = vi.fn();
  render(<DocumentFileExportDialog exp={exp} modes={modes} download={download} onClose={onClose} onMessage={vi.fn()} />);
  return { run, download, onClose, preflight };
}

describe('plan-2251 — export dialog visible text', () => {
  it('shows the introduction, mode descriptions and the disabled data layer reason', async () => {
    const { run, preflight } = mountExport();
    expect(screen.getByText('Export this document for Isaac Sim, Omniverse, Blender or usdview.')).toBeVisible();
    for (const mode of MODES) {
      expect(screen.getByText(mode.label)).toBeVisible();
      expect(screen.getByText(mode.description!)).toBeVisible();
    }
    expect(screen.getByText(MODES[1].disabledReason!)).toBeVisible();
    expect(screen.getByTestId('document-card-export-mode-overlay')).toBeDisabled();
    fireEvent.click(screen.getByText(MODES[1].label));
    await waitFor(() => expect(preflight).toHaveBeenCalledWith('standalone'));
    expect(preflight).not.toHaveBeenCalledWith('overlay');
    expect(run).not.toHaveBeenCalled();
  });

  it('opening the dialog only preflights; the visible count comes from preflight and run starts on Export', async () => {
    const { run, download } = mountExport();
    expect(await screen.findByText('3 placements will be exported without geometry.')).toBeVisible();
    expect(run).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(download).toHaveBeenCalledWith(new Uint8Array([1]), MODES[0].mime, 'scene.usdz'));
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('cannot preflight or export when every mode is disabled', () => {
    const { run, download, preflight } = mountExport(vi.fn(async (_mode: string) => exportResult()), [MODES[1]]);
    expect(screen.getByRole('button', { name: 'Export' })).toBeDisabled();
    expect(run).not.toHaveBeenCalled();
    expect(preflight).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });

  it('an optional preflight failure does not start or block the export', async () => {
    const { run, download } = mountExport(undefined, MODES, vi.fn(async () => { throw new Error('Placement count is unavailable.'); }));
    expect(await screen.findByText('Placement count is unavailable.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
    expect(run).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
  });

  it('changing modes only preflights and ignores a late count for the previous mode', async () => {
    let finish!: (result: DocumentExportPreflight) => void;
    const preflight = vi.fn((mode: string) => mode === 'standalone'
      ? new Promise<DocumentExportPreflight>((resolve) => { finish = resolve; })
      : Promise.resolve({ referencesWithoutGeometry: 2 }));
    const modes = [MODES[0], { ...MODES[1], disabledReason: undefined }];
    const { run, download } = mountExport(undefined, modes, preflight);
    fireEvent.click(screen.getByTestId('document-card-export-mode-overlay'));
    expect(await screen.findByText('2 placements will be exported without geometry.')).toBeVisible();
    await act(async () => { finish({ referencesWithoutGeometry: 7 }); });
    expect(screen.queryByText('7 placements will be exported without geometry.')).toBeNull();
    expect(preflight).toHaveBeenCalledWith('standalone');
    expect(preflight).toHaveBeenCalledWith('overlay');
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    await waitFor(() => expect(download).toHaveBeenCalledTimes(1));
    expect(run).toHaveBeenCalledTimes(1);
    expect(run).toHaveBeenCalledWith('overlay');
  });

  it('providers without preflight remain usable and never run on open or Cancel', async () => {
    const { run, download, onClose } = mountExport(undefined, MODES, null);
    expect(screen.getByRole('button', { name: 'Export' })).toBeEnabled();
    expect(run).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(run).not.toHaveBeenCalled();
    expect(download).not.toHaveBeenCalled();
  });
});

describe('plan-2251 — apply preview visible text', () => {
  it.each([false, true])('uses the explicit confirmation label (data loss: %s)', async (loss) => {
    const commit = vi.fn(async () => ({ ok: false as const, code: 'stale-preview' as const }));
    const exp: ActiveDocumentFileExport = {
      id: 'usd', label: 'Export USD…', modes: () => [], run: async () => exportResult(),
      apply: { label: 'Apply USD extras…', preview: vi.fn(), commit },
    };
    const preview: ApplyPreview = {
      previewToken: 'preview-1', targetRevision: 'rev-1', matched: 2,
      unmatchedPrims: [], ambiguous: [], extrasLost: loss ? ['Part'] : [], warnings: [], blocked: null,
    };
    render(<DocumentApplyDialog exp={exp} preview={preview} onClose={vi.fn()} onMessage={vi.fn()} />);
    expect(screen.getByText('Review the realvirtual data matched to this document. Applying replaces its realvirtual data; geometry stays unchanged.')).toBeVisible();
    const button = screen.getByRole('button', { name: loss ? 'Apply and remove missing data' : 'Apply data' });
    expect(button).toBeVisible();
    expect(commit).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(commit).toHaveBeenCalledWith('preview-1', loss ? { confirmExtrasLost: true } : {}));
  });
});
