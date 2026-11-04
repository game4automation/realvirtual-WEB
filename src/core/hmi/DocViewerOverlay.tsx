// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocViewerOverlay — Fullscreen PDF viewer overlay with in-document search.
 *
 * Uses react-pdf (pdf.js) for consistent rendering across all browsers
 * including mobile. The react-pdf library is loaded lazily via dynamic
 * import() on first use — it is NOT part of the main bundle.
 *
 * Search: the toolbar search box highlights all matches on the current page
 * (via the pdf.js text layer + a customTextRenderer) and lets the user jump
 * between matches across pages. The per-page text index is built lazily on
 * first search and cached for the open document.
 */

import { useEffect, useState, useCallback, useRef, useMemo } from 'react';
import { Box, Paper, IconButton, Typography, CircularProgress, InputBase, GlobalStyles } from '@mui/material';
import { Close, NavigateBefore, NavigateNext, ZoomIn, ZoomOut, OpenInNew, Search, KeyboardArrowUp, KeyboardArrowDown } from '@mui/icons-material';

import 'react-pdf/dist/Page/TextLayer.css';

export interface DocViewerOverlayProps {
  url: string;
  title?: string;
  /** Page to open first (1-based). Defaults to 1. */
  initialPage?: number;
  onClose: () => void;
}

/** Minimal structural view of the pdf.js document proxy used for the text index. */
interface PdfDocProxy {
  numPages: number;
  getPage(n: number): Promise<{ getTextContent(): Promise<{ items: ReadonlyArray<unknown> }> }>;
}

// ─── Lazy react-pdf loading ─────────────────────────────────────────────
// react-pdf + pdf.js worker are loaded only when the overlay first opens.

export type ReactPdfModule = typeof import('react-pdf');
let _pdfModulePromise: Promise<ReactPdfModule> | null = null;

/**
 * Load the react-pdf module (with the pdf.js worker configured) exactly once and
 * cache the promise. Exported so non-overlay callers (e.g. headless page-text
 * extraction in `pdf-text.ts`) reuse the same single worker setup instead of
 * spinning up a second loader.
 */
export function loadReactPdf(): Promise<ReactPdfModule> {
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

/** Escape a user string for safe use inside a RegExp. */
export function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Find which 1-based pages contain the query, one entry per occurrence
 * (so the list length is the total match count). Case-insensitive.
 */
export function findMatchPages(pageTexts: ReadonlyArray<string>, query: string): number[] {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  const out: number[] = [];
  for (let p = 0; p < pageTexts.length; p++) {
    const hay = pageTexts[p].toLowerCase();
    let idx = hay.indexOf(q);
    while (idx !== -1) { out.push(p + 1); idx = hay.indexOf(q, idx + q.length); }
  }
  return out;
}

/** Wrap each (case-insensitive) occurrence of query in a highlight <mark>. */
export function highlightHtml(str: string, query: string): string {
  const q = query.trim();
  if (!q) return str;
  return str.replace(new RegExp(`(${escapeRegExp(q)})`, 'gi'), '<mark class="rv-pdf-hl">$1</mark>');
}

// ─── Component ──────────────────────────────────────────────────────────

export function DocViewerOverlay({ url, title, initialPage, onClose }: DocViewerOverlayProps) {
  const [pdfMod, setPdfMod] = useState<ReactPdfModule | null>(null);
  const [modError, setModError] = useState('');
  const [pdfError, setPdfError] = useState('');
  const [numPages, setNumPages] = useState(0);
  const [page, setPage] = useState(initialPage ?? 1);
  const [scale, setScale] = useState(1.2);
  const containerRef = useRef<HTMLDivElement>(null);

  // Search state
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [debounced, setDebounced] = useState('');
  const [indexState, setIndexState] = useState<'idle' | 'building' | 'ready'>('idle');
  const [activeMatch, setActiveMatch] = useState(0);
  const pdfRef = useRef<PdfDocProxy | null>(null);
  const pageTextsRef = useRef<string[]>([]);

  // Load react-pdf lazily on mount
  useEffect(() => {
    let cancelled = false;
    loadReactPdf()
      .then((mod) => { if (!cancelled) setPdfMod(mod); })
      .catch((err) => { if (!cancelled) setModError(err instanceof Error ? err.message : String(err)); });
    return () => { cancelled = true; };
  }, []);

  // Reset everything (including the search index) when the document changes
  useEffect(() => {
    setPage(initialPage ?? 1); setNumPages(0); setPdfError('');
    setSearchOpen(false); setQuery(''); setDebounced(''); setActiveMatch(0);
    setIndexState('idle'); pdfRef.current = null; pageTextsRef.current = [];
  }, [url, initialPage]);

  // Debounce the search query
  useEffect(() => {
    const id = window.setTimeout(() => setDebounced(query.trim()), 200);
    return () => window.clearTimeout(id);
  }, [query]);

  // Escape: close the search box first if open, otherwise close the overlay
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (searchOpen) { setSearchOpen(false); setQuery(''); }
      else onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, searchOpen]);

  const onDocumentLoadSuccess = useCallback((pdf: PdfDocProxy) => {
    pdfRef.current = pdf;
    setNumPages(pdf.numPages);
  }, []);

  // Build the per-page text index lazily on first search (cached for the document)
  useEffect(() => {
    if (!debounced || indexState !== 'idle') return;
    const pdf = pdfRef.current;
    if (!pdf) return; // doc not loaded yet — re-runs when numPages changes
    let cancelled = false;
    setIndexState('building');
    (async () => {
      const texts: string[] = [];
      for (let p = 1; p <= pdf.numPages; p++) {
        if (cancelled) return;
        try {
          const content = await (await pdf.getPage(p)).getTextContent();
          texts.push(content.items.map((i) => {
            const s = (i as { str?: unknown }).str;
            return typeof s === 'string' ? s : '';
          }).join(' ').toLowerCase());
        } catch {
          texts.push('');
        }
      }
      if (cancelled) return;
      pageTextsRef.current = texts;
      setIndexState('ready');
    })();
    return () => { cancelled = true; };
  }, [debounced, indexState, numPages]);

  // Flat list of match pages (one entry per occurrence) for prev/next navigation
  const matches = useMemo(
    () => (indexState === 'ready' ? findMatchPages(pageTextsRef.current, debounced) : []),
    [debounced, indexState],
  );

  // On a new query, jump to the first match
  useEffect(() => {
    setActiveMatch(0);
    if (matches.length > 0) setPage(matches[0]);
  }, [matches]);

  const gotoMatch = useCallback((dir: 1 | -1) => {
    setActiveMatch((prev) => {
      if (matches.length === 0) return 0;
      const next = (prev + dir + matches.length) % matches.length;
      setPage(matches[next]);
      return next;
    });
  }, [matches]);

  // Highlight matches on the rendered page by wrapping them in <mark>
  const customTextRenderer = useCallback(
    (item: { str: string }) => highlightHtml(item.str, debounced),
    [debounced],
  );

  const prevPage = useCallback(() => setPage((p) => Math.max(1, p - 1)), []);
  const nextPage = useCallback(() => setPage((p) => Math.min(numPages, p + 1)), [numPages]);
  const zoomIn = useCallback(() => setScale((s) => Math.min(3, s + 0.2)), []);
  const zoomOut = useCallback(() => setScale((s) => Math.max(0.4, s - 0.2)), []);

  const matchLabel = indexState === 'building'
    ? '…'
    : debounced
      ? `${matches.length ? activeMatch + 1 : 0} / ${matches.length}`
      : '';

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
      {/* Search highlight styling (text layer marks) */}
      <GlobalStyles styles={{
        '.rv-pdf-hl': { backgroundColor: 'rgba(255, 213, 0, 0.5)', color: 'transparent', borderRadius: '2px' },
      }} />
      <Paper
        elevation={12}
        onClick={(e) => e.stopPropagation()}
        sx={{
          width: '90vw',
          height: '90vh',
          borderRadius: 1,
          overflow: 'hidden',
          display: 'flex',
          flexDirection: 'column',
          position: 'relative',
        }}
      >
        {/* Title bar */}
        <Box sx={{ display: 'flex', alignItems: 'center', px: 2, py: 0.75, borderBottom: '1px solid rgba(255,255,255,0.08)', gap: 1 }}>
          {title && !searchOpen && (
            <Typography variant="body2" sx={{ fontWeight: 600, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {title}
            </Typography>
          )}

          {/* Search box */}
          {searchOpen && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25, flex: 1 }}>
              <Search sx={{ fontSize: 18, color: 'rgba(255,255,255,0.5)' }} />
              <InputBase
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); gotoMatch(e.shiftKey ? -1 : 1); } }}
                placeholder="Search document…"
                autoFocus
                sx={{ fontSize: 13, color: '#fff', flex: 1, maxWidth: 240, '& input::placeholder': { color: 'rgba(255,255,255,0.4)' } }}
              />
              <Typography variant="caption" sx={{ minWidth: 56, textAlign: 'center', color: 'rgba(255,255,255,0.6)', fontSize: 11, fontVariantNumeric: 'tabular-nums' }}>
                {matchLabel}
              </Typography>
              <IconButton size="small" onClick={() => gotoMatch(-1)} disabled={matches.length === 0}><KeyboardArrowUp sx={{ fontSize: 18 }} /></IconButton>
              <IconButton size="small" onClick={() => gotoMatch(1)} disabled={matches.length === 0}><KeyboardArrowDown sx={{ fontSize: 18 }} /></IconButton>
              <IconButton size="small" onClick={() => { setSearchOpen(false); setQuery(''); }}><Close sx={{ fontSize: 16 }} /></IconButton>
            </Box>
          )}

          {/* Search toggle + page navigation + zoom */}
          {numPages > 0 && !searchOpen && (
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
              <IconButton size="small" onClick={() => setSearchOpen(true)} title="Search document"><Search sx={{ fontSize: 18 }} /></IconButton>
              <Box sx={{ width: 8 }} />
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
            sx={{ ml: (title && !searchOpen) ? 0 : 'auto' }}
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
                renderTextLayer={true}
                renderAnnotationLayer={false}
                customTextRenderer={customTextRenderer}
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
