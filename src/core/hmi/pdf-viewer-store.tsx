// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * pdf-viewer-store.ts — Generic PDF viewer state management.
 *
 * Provides a module-level reactive store for opening/closing the fullscreen
 * PDF viewer overlay. Supports two source types:
 *   - 'url': direct URL (standalone PDFs)
 *   - 'blob': lazy extraction from an AASX ZIP file
 *
 * Any tooltip or panel can call openPdfViewer() to display a PDF.
 * PdfViewerBridge renders the DocViewerOverlay and is auto-registered
 * as a tooltip controller (rendered by App.tsx).
 */

import { useSyncExternalStore } from 'react';
import { Box, Typography, CircularProgress } from '@mui/material';
import { extractFileBlob } from '../../plugins/aas-link-parser';
import { tooltipRegistry } from './tooltip/tooltip-registry';
import { DocViewerOverlay } from './DocViewerOverlay';

// ─── Types ─────────────────────────────────────────────────────────────

/** Source descriptor for a PDF document. */
export type PdfSource =
  | { type: 'url'; url: string }
  | { type: 'blob'; aasId: string; zipPath: string; basePath?: string };

/** A single PDF link attached to a node. */
export interface PdfLink {
  title: string;
  source: PdfSource;
}

// ─── Store ─────────────────────────────────────────────────────────────

interface PdfViewerState {
  open: boolean;
  url: string;
  title: string;
  loading: boolean;
  error: string;
}

/** Track all blob URLs for cleanup. */
const _activeBlobUrls = new Set<string>();

let _pdfState: PdfViewerState = { open: false, url: '', title: '', loading: false, error: '' };
const _pdfListeners = new Set<() => void>();
let _pdfSnapshot = _pdfState;

function notifyPdf(): void {
  _pdfSnapshot = { ..._pdfState };
  for (const l of _pdfListeners) l();
}

/**
 * Open the PDF viewer overlay.
 * source.type === 'url': direct URL (standalone PDFs)
 * source.type === 'blob': lazy extraction from AASX ZIP
 */
export function openPdfViewer(
  title: string,
  source: PdfSource,
): void {
  // Revoke previous blob URL if switching PDFs
  if (_pdfState.url && _activeBlobUrls.has(_pdfState.url)) {
    URL.revokeObjectURL(_pdfState.url);
    _activeBlobUrls.delete(_pdfState.url);
  }

  if (source.type === 'url') {
    _pdfState = { open: true, url: source.url, title, loading: false, error: '' };
    notifyPdf();
  } else {
    _pdfState = { open: true, url: '', title, loading: true, error: '' };
    notifyPdf();

    extractFileBlob(source.aasId, source.zipPath, source.basePath)
      .then((blobUrl) => {
        _activeBlobUrls.add(blobUrl);
        _pdfState = { ..._pdfState, url: blobUrl, loading: false, error: '' };
        notifyPdf();
      })
      .catch((err) => {
        _pdfState = { ..._pdfState, loading: false, error: err instanceof Error ? err.message : String(err) };
        notifyPdf();
      });
  }
}

/** Close the PDF viewer overlay and revoke the current blob URL. */
export function closePdfViewer(): void {
  if (_pdfState.url && _activeBlobUrls.has(_pdfState.url)) {
    URL.revokeObjectURL(_pdfState.url);
    _activeBlobUrls.delete(_pdfState.url);
  }
  _pdfState = { open: false, url: '', title: '', loading: false, error: '' };
  notifyPdf();
}

/** Dispose: revoke ALL tracked blob URLs (called on plugin dispose / model unload). */
export function disposePdfViewer(): void {
  for (const url of _activeBlobUrls) {
    URL.revokeObjectURL(url);
  }
  _activeBlobUrls.clear();
  _pdfState = { open: false, url: '', title: '', loading: false, error: '' };
  notifyPdf();
}

function usePdfViewerState(): PdfViewerState {
  return useSyncExternalStore(
    (cb) => { _pdfListeners.add(cb); return () => { _pdfListeners.delete(cb); }; },
    () => _pdfSnapshot,
  );
}

// ─── PDF Viewer Bridge (headless controller, rendered by App.tsx) ──────

function PdfViewerBridge() {
  const state = usePdfViewerState();
  if (!state.open) return null;

  if (state.loading) {
    return (
      <Box sx={{
        position: 'fixed', inset: 0, zIndex: 9000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        bgcolor: 'rgba(0,0,0,0.75)', pointerEvents: 'auto',
      }}>
        <CircularProgress />
      </Box>
    );
  }

  if (state.error) {
    return (
      <Box
        onClick={closePdfViewer}
        sx={{
          position: 'fixed', inset: 0, zIndex: 9000,
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          flexDirection: 'column', gap: 2,
          bgcolor: 'rgba(0,0,0,0.75)', pointerEvents: 'auto',
        }}
      >
        <Typography sx={{ color: '#f44336', fontSize: 14 }}>
          Failed to load PDF: {state.error}
        </Typography>
        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)' }}>
          Click to close
        </Typography>
      </Box>
    );
  }

  return <DocViewerOverlay url={state.url} title={state.title} onClose={closePdfViewer} />;
}

// Register the PdfViewerBridge as a controller (rendered by App.tsx getControllers() loop)
tooltipRegistry.registerController({ types: [], component: PdfViewerBridge });
