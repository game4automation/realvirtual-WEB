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
import { Box, Typography, CircularProgress, Modal } from '@mui/material';
import { extractAasEntryBlob } from '../../plugins/aas-link-parser';
import { asAasSource, getAasSourceByKey, getActiveAasSource, type AasSource } from '../aas/rv-aas-source';
import { lookupMirroredDocument, openMirroredDocument, pageOfUrl } from '../aas/rv-aas-document-mirror';
import { tooltipRegistry } from './tooltip/tooltip-registry';
import { DocViewerOverlay } from './DocViewerOverlay';

// ─── Types ─────────────────────────────────────────────────────────────

/** Source descriptor for a PDF document. */
export type PdfSource =
  | { type: 'url'; url: string }
  /**
   * A document on another site (an AAS File element whose value is an http(s)
   * address, e.g. festo.com). Opened in a NEW BROWSER TAB: the overlay's reader
   * fetches the bytes, which a site without CORS headers refuses — and such
   * links often answer with a download, not a page. Exception: the open project
   * mirrors the address (`docs/aas/mirror.json`, rv-aas-document-mirror.ts) —
   * then the project copy opens inline, `#page=N` included.
   */
  | { type: 'external'; url: string }
  | {
    type: 'blob';
    aasId: string;
    zipPath: string;
    /** Legacy: an assets root whose `aasx/` holds the file. */
    basePath?: string;
    /**
     * Key of the AAS source that listed the id (plan-596) — the PDF is read
     * from exactly that source's archive. Falls back to the active source.
     */
    sourceKey?: string;
  };

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
  initialPage?: number;
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
 * source.type === 'external': the project's mirrored copy in the overlay when
 *   `docs/aas/mirror.json` lists the address, else a new browser tab (no overlay)
 */
export function openPdfViewer(
  title: string,
  source: PdfSource,
  options?: { initialPage?: number; /** `source.url` is an object URL the viewer now OWNS — revoked on close / switch. */ ownsUrl?: boolean },
): void {
  if (source.type === 'external') {
    if (!/^https?:\/\//i.test(source.url)) return; // an AASX value is untrusted input
    const mirrored = lookupMirroredDocument(source.url);
    if (mirrored) {
      openMirrored(title, mirrored, options?.initialPage ?? pageOfUrl(source.url));
      return;
    }
    // Called from the click handler, so the browser treats it as a user gesture
    // and does not block the tab.
    window.open(source.url, '_blank', 'noopener,noreferrer');
    return;
  }
  // Revoke previous blob URL if switching PDFs
  if (_pdfState.url && _activeBlobUrls.has(_pdfState.url)) {
    URL.revokeObjectURL(_pdfState.url);
    _activeBlobUrls.delete(_pdfState.url);
  }

  const initialPage = options?.initialPage;

  if (source.type === 'url') {
    if (options?.ownsUrl) _activeBlobUrls.add(source.url);
    _pdfState = { open: true, url: source.url, title, initialPage, loading: false, error: '' };
    notifyPdf();
  } else {
    _pdfState = { open: true, url: '', title, initialPage, loading: true, error: '' };
    notifyPdf();

    extractAasEntryBlob(source.aasId, source.zipPath, aasSourceOf(source))
      .then(({ blob }) => {
        // The viewer owns this URL (revoked on close / switch), independent of
        // the package cache, so an evicted archive never pulls a PDF away.
        const blobUrl = URL.createObjectURL(blob);
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

/** Open a project-mirrored external document in the overlay (async read, loading state meanwhile). */
function openMirrored(title: string, path: string, initialPage: number | undefined): void {
  if (_pdfState.url && _activeBlobUrls.has(_pdfState.url)) {
    URL.revokeObjectURL(_pdfState.url);
    _activeBlobUrls.delete(_pdfState.url);
  }
  _pdfState = { open: true, url: '', title, initialPage, loading: true, error: '' };
  notifyPdf();
  openMirroredDocument(path)
    .then(({ url, owned }) => {
      if (_pdfState.title !== title || !_pdfState.loading) { if (owned) URL.revokeObjectURL(url); return; }
      if (owned) _activeBlobUrls.add(url);
      _pdfState = { ..._pdfState, url, loading: false, error: '' };
      notifyPdf();
    })
    .catch((err) => {
      _pdfState = { ..._pdfState, loading: false, error: err instanceof Error ? err.message : String(err) };
      notifyPdf();
    });
}

/** The AAS source a blob link names: its source key, a legacy base path, or the active source. */
function aasSourceOf(source: { basePath?: string; sourceKey?: string }): AasSource {
  if (source.sourceKey) {
    const byKey = getAasSourceByKey(source.sourceKey);
    if (byKey) return byKey;
  }
  if (source.basePath) return asAasSource(source.basePath);
  return getActiveAasSource();
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

/** Current viewer state (read-only snapshot) — for tests and diagnostics. */
export function getPdfViewerState(): Readonly<PdfViewerState> {
  return _pdfSnapshot;
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

  let content: React.ReactNode;
  if (state.loading) {
    content = (
      <Box sx={{
        position: 'fixed', inset: 0, zIndex: 9000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        bgcolor: 'rgba(0,0,0,0.75)', pointerEvents: 'auto',
      }}>
        <CircularProgress />
      </Box>
    );
  } else if (state.error) {
    content = (
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
  } else {
    content = <DocViewerOverlay url={state.url} title={state.title} initialPage={state.initialPage} onClose={closePdfViewer} />;
  }

  // Render through a MUI Modal so the overlay is portaled to document.body.
  // The HMI lives inside #react-root, a fixed element with z-index:1000 that
  // forms its own stacking context — so the overlay's own z-index:9000 only
  // ranks WITHIN that context and stays below any open MUI Dialog, which
  // portals to body at z-index 1300 (theme.zIndex.modal). Portaling the PDF to
  // body lets its 9000 win against the 1300 dialog. Registering with MUI's
  // shared ModalManager also makes an underlying Dialog (e.g. the Ask-AI
  // dialog) non-top, releasing its focus trap so the PDF search box keeps focus.
  // disableEscapeKeyDown: DocViewerOverlay owns Escape (two-stage: close search
  // first, then the overlay) via its own window listener — don't double-handle.
  return (
    <Modal
      open
      onClose={closePdfViewer}
      hideBackdrop
      disableAutoFocus
      disableEnforceFocus
      disableEscapeKeyDown
      sx={{ zIndex: 9000 }}
    >
      <div>{content}</div>
    </Modal>
  );
}

// Register the PdfViewerBridge as a controller (rendered by App.tsx getControllers() loop)
tooltipRegistry.registerController({ types: [], component: PdfViewerBridge });
