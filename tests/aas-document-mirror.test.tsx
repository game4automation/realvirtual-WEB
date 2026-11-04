// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * An external AAS document (`PdfSource.type === 'external'`) opens INLINE in
 * the PDF overlay when the open project mirrors it (`docs/aas/mirror.json`),
 * at the `#page=N` of the address; without a mapping it still opens a new tab.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import { closePdfViewer, getPdfViewerState, openPdfViewer } from '../src/core/hmi/pdf-viewer-store';
import { tooltipRegistry } from '../src/core/hmi/tooltip/tooltip-registry';
import { _setAasMirrorForTest, lookupMirroredDocument, prefetchAasDocumentMirrorFor, type AasMirrorBackend } from '../src/core/aas/rv-aas-document-mirror';
import { resolveMaintenanceDocument } from '../src/core/hmi/maintenance-document-link';

const PDF_BYTES = '%PDF-1.4\n1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj\n2 0 obj<</Type/Pages/Kids[]/Count 0>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF\n';

function backend(files: Record<string, string>): AasMirrorBackend & { reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readDocumentBlob: async (path: string) => {
      reads.push(path);
      return path in files ? new Blob([files[path]], { type: 'application/pdf' }) : null;
    },
    readDocumentUrl: async () => null,
  } as unknown as AasMirrorBackend & { reads: string[] };
}

function PdfBridge() {
  const entry = tooltipRegistry.getControllers().find((c) => c.component.name === 'PdfViewerBridge');
  if (!entry) throw new Error('PdfViewerBridge not registered');
  const C = entry.component as React.ComponentType;
  return <C />;
}

afterEach(() => {
  closePdfViewer();
  _setAasMirrorForTest();
  cleanup();
  vi.restoreAllMocks();
});

describe('AAS document mirror — external links', () => {
  it('Test_OpenExternal_WithMapping_OpensOverlayAtPage', async () => {
    const be = backend({ 'docs/aas/abc-manual.pdf': PDF_BYTES });
    _setAasMirrorForTest(be, new Map([['https://vendor.example/media/manual.pdf', 'docs/aas/abc-manual.pdf']]));
    const open = vi.spyOn(window, 'open').mockReturnValue(null);
    render(<PdfBridge />);

    openPdfViewer('Operating manual', { type: 'external', url: 'https://vendor.example/media/manual.pdf#page=18' });

    await waitFor(() => expect(getPdfViewerState().loading).toBe(false));
    const s = getPdfViewerState();
    expect(s).toMatchObject({ open: true, title: 'Operating manual', initialPage: 18, error: '' });
    expect(s.url.startsWith('blob:')).toBe(true);
    expect(be.reads).toEqual(['docs/aas/abc-manual.pdf']);
    expect(open).not.toHaveBeenCalled();
    // The overlay itself is mounted (title in its header).
    await waitFor(() => expect(screen.getAllByText('Operating manual').length).toBeGreaterThan(0));
  });

  it('Test_OpenExternal_UnmappedUrl_OpensNewTab', () => {
    _setAasMirrorForTest(backend({}), new Map([['https://vendor.example/media/other.pdf', 'docs/aas/x-other.pdf']]));
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    openPdfViewer('Datasheet', { type: 'external', url: 'https://vendor.example/media/datasheet.pdf' });

    expect(open).toHaveBeenCalledWith('https://vendor.example/media/datasheet.pdf', '_blank', 'noopener,noreferrer');
    expect(getPdfViewerState().open).toBe(false);
  });

  it('Test_OpenExternal_NoProject_OpensNewTab', () => {
    _setAasMirrorForTest(null);
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    openPdfViewer('Datasheet', { type: 'external', url: 'https://vendor.example/media/manual.pdf' });

    expect(open).toHaveBeenCalledTimes(1);
    expect(getPdfViewerState().open).toBe(false);
  });

  it('Test_OpenExternal_MirroredFileMissing_ShowsErrorNotTab', async () => {
    _setAasMirrorForTest(backend({}), new Map([['https://vendor.example/media/manual.pdf', 'docs/aas/gone.pdf']]));
    const open = vi.spyOn(window, 'open').mockReturnValue(null);

    openPdfViewer('Operating manual', { type: 'external', url: 'https://vendor.example/media/manual.pdf' });

    await waitFor(() => expect(getPdfViewerState().loading).toBe(false));
    expect(getPdfViewerState().error).toMatch(/not found/);
    expect(open).not.toHaveBeenCalled();
  });
});

// The public demo ships no mirror: probing docs/aas/mirror.json on every model
// load 404'd and failed the deploy smoke. The mapping is read only on demand.
describe('AAS document mirror — loaded only on demand', () => {
  const MIRROR = JSON.stringify({ documents: { 'https://vendor.example/media/manual.pdf': { path: 'docs/aas/abc-manual.pdf' } } });

  it('Test_PrefetchFor_NoExternalUrl_DoesNotRequestMirror', async () => {
    const be = backend({ 'docs/aas/mirror.json': MIRROR });
    _setAasMirrorForTest(be, null);
    await prefetchAasDocumentMirrorFor([undefined, null, 'aasx/files/manual.pdf', 'javascript:alert(1)']);
    expect(be.reads).toEqual([]);
  });

  it('Test_PrefetchFor_ExternalUrl_LoadsMappingOnce', async () => {
    const be = backend({ 'docs/aas/mirror.json': MIRROR });
    _setAasMirrorForTest(be, null);
    await prefetchAasDocumentMirrorFor(['https://vendor.example/media/manual.pdf#page=3']);
    await prefetchAasDocumentMirrorFor(['https://vendor.example/media/other.pdf']);
    expect(be.reads).toEqual(['docs/aas/mirror.json']);
    expect(lookupMirroredDocument('https://vendor.example/media/manual.pdf#page=3')).toBe('docs/aas/abc-manual.pdf');
  });

  it('Test_ResolveMaintenanceDocument_AasBlob_DoesNotRequestMirror', async () => {
    const be = backend({});
    _setAasMirrorForTest(be, null);
    const host = { registry: { getNode: () => ({ userData: { _rvAasLink: { aasId: 'urn:aas:1' } } }) } };
    const loadAas = async () => ({ documents: [{ title: 'Manual', mimeType: 'application/pdf', zipPath: 'aasx/files/manual.pdf', language: 'en' }] });
    const got = await resolveMaintenanceDocument({ title: 'Manual', page: 2, sourcePath: 'Cell/Unit', keywords: [], url: '' } as never, host, 'en', loadAas as never);
    expect(got).toEqual({ kind: 'aas-blob', aasId: 'urn:aas:1', zipPath: 'aasx/files/manual.pdf', page: 2 });
    expect(be.reads).toEqual([]);
  });

  it('Test_ResolveMaintenanceDocument_ExternalUrl_LoadsMapping', async () => {
    const be = backend({ 'docs/aas/mirror.json': MIRROR });
    _setAasMirrorForTest(be, null);
    const got = await resolveMaintenanceDocument({ title: 'Manual', page: 4, sourcePath: '', keywords: [], url: 'https://vendor.example/media/manual.pdf' } as never, {}, 'en');
    expect(got).toEqual({ kind: 'external', href: 'https://vendor.example/media/manual.pdf#page=4' });
    expect(be.reads).toEqual(['docs/aas/mirror.json']);
  });
});
