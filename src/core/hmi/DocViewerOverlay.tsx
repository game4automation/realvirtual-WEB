// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocViewerOverlay — Fullscreen PDF viewer overlay.
 *
 * Uses react-pdf (pdf.js) for consistent rendering across all browsers
 * including mobile. The react-pdf library is loaded lazily via dynamic
 * import() on first use — it is NOT part of the main bundle.
 */

import { useEffect, useState, useCallback, useRef } from 'react';
import { Box, Paper, IconButton, Typography, CircularProgress } from '@mui/material';
import { Close, NavigateBefore, NavigateNext, ZoomIn, ZoomOut, OpenInNew } from '@mui/icons-material';

export interface DocViewerOverlayProps {
  url: string;
  title?: string;
  onClose: () => void;
}

// ─── Lazy react-pdf loading ─────────────────────────────────────────────
// react-pdf + pdf.js worker are loaded only when the overlay first opens.

type ReactPdfModule = typeof import('react-pdf');
let _pdfModulePromise: Promise<ReactPdfModule> | null = null;

function loadReactPdf(): Promise<ReactPdfModule> {
  if (!_pdfModulePromise) {
    _pdfModulePromise = import('react-pdf').then((mod) => {
      // Worker served from public/ as .js — CDNs/servers universally serve .js with correct MIME type
      // (.mjs gets served as application/octet-stream on many CDNs including Bunny CDN)
      mod.pdfjs.GlobalWorkerOptions.workerSrc = `${import.meta.env.BASE_URL}pdf.worker.min.js`;
      return mod;
    });
  }
  return _pdfModulePromise;
}

// ─── Component ──────────────────────────────────────────────────────────

export function DocViewerOverlay({ url, title, onClose }: DocViewerOverlayProps) {
  const [pdfMod, setPdfMod] = useState<ReactPdfModule | null>(null);
  const [modError, setModError] = useState('');
  const [pdfError, setPdfError] = useState('');
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(1);
  const [scale, setScale] = useState(1.2);
  const containerRef = useRef<HTMLDivElement>(null);

  // Load react-pdf lazily on mount
  useEffect(() => {
    let cancelled = false;
    loadReactPdf()
      .then((mod) => { if (!cancelled) setPdfMod(mod); })
      .catch((err) => { if (!cancelled) setModError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  // Reset page when URL changes
  useEffect(() => { setPage(1); setNumPages(0); setPdfError(''); }, [url]);

  // Escape key
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const onDocumentLoadSuccess = useCallback(({ numPages: n }: { numPages: number }) => {
    setNumPages(n);
  }, []);

  const prevPage = useCallback(() => setPage((p) => Math.max(1, p - 1)), []);
  const nextPage = useCallback(() => setPage((p) => Math.min(numPages, p + 1)), [numPages]);
  const zoomIn = useCallback(() => setScale((s) => Math.min(3, s + 0.2)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(0.4, s - 0.2)), []);

  return (
    <Box
      onClick={onClose}
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 9000,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'rgba(0,0,0,0.75)',
        pointerEvents: 'auto',
      }}
    >
      <Paper
        elevation={12}
        onClick={(e) => e.stopPropagation()}
        sx={{
          width: '90vw',
          height: '90vh',
          borderRadius: 2,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        {/* Title bar */}
        <Box sx={{ display: 'flex', alignItems: 'center', px: 2, py: 0.75, borderBottom: '1px solid rgba(255,255,255,0.08)', gap: 1 }}>
          {title && (
            <Typography variant="body2" sx={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title}
            </Typography>
          )}

          {/* Page navigation + zoom */}
          {numPages > 0 && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
              <IconButton size="small" onClick={zoomOut} disabled={scale <= 0.4}><ZoomOut sx={{ fontSize: 18 }} /></IconButton>
              <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.6)', minWidth: 36, textAlign: 'center', fontSize: 11 }}>
                {Math.round(scale * 100)}%
              </Typography>
              <IconButton size="small" onClick={zoomIn} disabled={scale >= 3}><ZoomIn sx={{ fontSize: 18 }} /></IconButton>
              <Box sx={{ width: 8 }} />
              <IconButton size="small" onClick={prevPage} disabled={page <= 1}><NavigateBefore sx={{ fontSize: 18 }} /></IconButton>
              <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.6)', minWidth: 52, textAlign: 'center', fontSize: 11 }}>
                {page} / {numPages}
              </Typography>
              <IconButton size="small" onClick={nextPage} disabled={page >= numPages}><NavigateNext sx={{ fontSize: 18 }} /></IconButton>
            </Box>
          )}

          {/* Open in browser's native PDF viewer */}
          <IconButton
            size="small"
            onClick={() => window.open(url, '_blank')}
            title="Open in new tab"
            sx={{ ml: title ? 0 : 'auto' }}
          >
            <OpenInNew sx={{ fontSize: 18 }} />
          </IconButton>
          <IconButton size="small" onClick={onClose}>
            <Close />
          </IconButton>
        </Box>

        {/* PDF content */}
        <Box
          ref={containerRef}
          sx={{
            flex: 1,
            overflow: 'auto',
            display: 'flex',
            justifyContent: 'center',
            bgcolor: '#525659',
            py: 2,
          }}
        >
          {/* Loading react-pdf module */}
          {!pdfMod && !modError && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1 }}>
              <CircularProgress size={32} sx={{ color: 'rgba(255,255,255,0.5)' }} />
            </Box>
          )}

          {/* Module load error */}
          {modError && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, flexDirection: 'column', gap: 1 }}>
              <Typography sx={{ color: '#f44336', fontSize: 13 }}>Failed to load PDF viewer</Typography>
              <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.4)' }}>{modError}</Typography>
            </Box>
          )}

          {/* react-pdf Document + Page */}
          {pdfMod && !pdfError && (
            <pdfMod.Document
              file={url}
              onLoadSuccess={onDocumentLoadSuccess}
              onLoadError={(err) => {
                console.error('[DocViewerOverlay] PDF load error:', err);
                setPdfError(err?.message || String(err));
              }}
              loading={
                <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, minHeight: 200 }}>
                  <CircularProgress size={32} sx={{ color: 'rgba(255,255,255,0.5)' }} />
                </Box>
              }
            >
              <pdfMod.Page
                pageNumber={page}
                scale={scale}
                renderTextLayer={false}
                renderAnnotationLayer={false}
              />
            </pdfMod.Document>
          )}

          {/* PDF render error */}
          {pdfError && (
            <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'center', flex: 1, flexDirection: 'column', gap: 1, minHeight: 200 }}>
              <Typography sx={{ color: '#f44336', fontSize: 13 }}>Failed to render PDF</Typography>
              <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.4)', maxWidth: 400, textAlign: 'center' }}>{pdfError}</Typography>
            </Box>
          )}
        </Box>
      </Paper>
    </Box>
  );
}
