// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SearchAiDialog — AI documentation answer for the global search bar's
 * "Ask AI" button (plan-283), modeled on the robot-alarm AskAiDialog.
 *
 * Consumes the search-ai-store: loading (descriptive text + live elapsed
 * seconds — a RAG/LLM answer takes 25–35 s and a static spinner reads as
 * "hung"), done (typewriter-revealed "Answer" / "Recommendation" sections +
 * cited PDF sources with page deep-links), empty and error. Section headings
 * are deliberately neutral ("Answer", not "Cause") — the same backend answers
 * free-text questions, not only fault diagnoses.
 *
 * Accessibility: the content region is `role="status"` + `aria-live="polite"`
 * and `aria-busy` while loading; the typewriter respects
 * `prefers-reduced-motion` (reveals everything instantly).
 *
 * Closing the dialog aborts an in-flight request (abortAiSearch), so no
 * background call keeps burning the CONNECT rate limit.
 */

import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Dialog, DialogTitle, DialogContent, DialogActions,
  Box, Typography, Button, IconButton, CircularProgress, Link, Chip, Collapse,
  Paper, Tabs, Tab, Menu, MenuItem, type PaperProps,
} from '@mui/material';
import { Close, AutoAwesome, Description, Replay, History } from '@mui/icons-material';
import { openPdfViewer } from './pdf-viewer-store';
import {
  abortAiSearch, runAiSearch, getSearchAiSnapshot, subscribeSearchAi, isEmptyAnswer,
  restoreFromHistory,
} from './search-ai-store';
import type { DiagnoseResult, DiagnoseSource } from '../../plugins/diagnose/diagnose-provider';
import type { SearchAiContext } from './search-ai-context';
import { useViewer } from '../../hooks/use-viewer';
import { nodesForSources } from '../engine/rv-doc-node-map';
import { isInteractive } from './FloatingPanel';
import { PartLink } from './PartLink';
import { linkifyAnswer, type AnswerLinkResolvers } from './linkify-answer';
import {
  getSearchAiHistorySnapshot,
  subscribeSearchAiHistory,
  type SearchAiHistoryEntry,
} from './search-ai-history-store';

/** Marks the title bar as the drag handle for {@link DraggablePaper}. */
const DRAG_HANDLE_ATTR = 'data-dialog-drag-handle';

/**
 * MUI Dialog `PaperComponent` that lets the operator drag the whole dialog by
 * its title bar. The dialog keeps its default centered position; drag applies a
 * delta `translate()` on top (so re-opening re-centers — Paper unmounts on close).
 *
 * Only the element carrying `[data-dialog-drag-handle]` starts a drag, and
 * `isInteractive` (shared with FloatingPanel) excludes buttons/links so the
 * close button and any header controls still click normally. The dialog portals
 * to document.body — outside the CSS-zoomed HMIShell — so raw client coords need
 * no zoom conversion here.
 */
function DraggablePaper(props: PaperProps) {
  const paperRef = useRef<HTMLDivElement | null>(null);
  const pos = useRef({ x: 0, y: 0 });
  const start = useRef({ x: 0, y: 0 });
  const dragging = useRef(false);

  useEffect(() => {
    const el = paperRef.current;
    if (!el) return;
    const handle = el.querySelector<HTMLElement>(`[${DRAG_HANDLE_ATTR}]`);
    if (!handle) return;

    const onDown = (e: PointerEvent) => {
      if (isInteractive(e.target as HTMLElement)) return;
      dragging.current = true;
      start.current = { x: e.clientX - pos.current.x, y: e.clientY - pos.current.y };
      handle.setPointerCapture(e.pointerId);
      e.preventDefault();
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging.current) return;
      pos.current = { x: e.clientX - start.current.x, y: e.clientY - start.current.y };
      el.style.transform = `translate(${pos.current.x}px, ${pos.current.y}px)`;
    };
    const onUp = () => { dragging.current = false; };

    handle.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    return () => {
      handle.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
  }, []);

  return <Paper {...props} ref={paperRef} />;
}

export interface SearchAiDialogProps {
  open: boolean;
  onClose: () => void;
}

/** How long the answer sections reveal, one at a time (ms per line). */
const TYPEWRITER_INTERVAL_MS = 220;

const ERROR_COLOR = '#ef5350';

function providerLabel(result: DiagnoseResult | undefined, fallback: string): string {
  if (result?.provider === 'cloud') return 'Cloud RAG';
  if (result?.provider === 'claude-cli') return 'Claude CLI';
  return result?.provider || fallback;
}

function resultTabLabel(result: DiagnoseResult | undefined, fallback: string): string {
  const duration = result?.durationMs;
  const suffix = duration === undefined
    ? ''
    : duration < 1000 ? ` · ${Math.round(duration)} ms` : ` · ${(duration / 1000).toFixed(1)} s`;
  return `${providerLabel(result, fallback)}${suffix}`;
}

function truncateQuery(query: string, max = 48): string {
  return query.length > max ? `${query.slice(0, max - 1)}…` : query;
}

/**
 * PDF text extraction sometimes returns space-stripped runs
 * ("OpzionimotoriPerinformazionisulleopzio-ni…") that are unreadable noise.
 * Suppress a snippet whose longest whitespace-delimited token is absurdly long
 * — a reliable tell for a broken extraction — so the operator sees the cited
 * PDF link + page instead of garbage. Genuine words (incl. long German/Italian
 * compounds) stay well under the threshold.
 */
function isReadableSnippet(snippet: string): boolean {
  const longestToken = snippet
    .split(/\s+/)
    .reduce((max, token) => Math.max(max, token.length), 0);
  return longestToken <= 28;
}

function prefersReducedMotion(): boolean {
  return typeof window !== 'undefined'
    && typeof window.matchMedia === 'function'
    && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function openSource(src: DiagnoseSource): void {
  if (!src.url) return;
  openPdfViewer(
    src.title || 'Document',
    { type: 'url', url: src.url },
    src.page !== undefined ? { initialPage: src.page } : undefined,
  );
}

/** Short leaf name of a scene path for the context chip ("A/B/GearMotor" → "GearMotor"). */
/** One-line summary of what plan-284 context was sent (F6: "node, 4 signals, 1 alarm"). */
function contextSummary(ctx: SearchAiContext): string {
  const parts = ['node'];
  const signals = (ctx.machineContext?.match(/^Signals: (.+)$/m)?.[1].split(',').length) ?? 0;
  const alarms = (ctx.machineContext?.match(/^Alarm: /gm)?.length) ?? 0;
  if (signals) parts.push(`${signals} signal${signals === 1 ? '' : 's'}`);
  if (alarms) parts.push(`${alarms} alarm${alarms === 1 ? '' : 's'}`);
  if (ctx.docHints?.length) parts.push(`${ctx.docHints.length} doc${ctx.docHints.length === 1 ? '' : 's'}`);
  return parts.join(', ');
}

/**
 * "Context sent" disclosure (plan-284 F6): shows exactly what selection context
 * travelled with the request — operator trust + debuggability. ink-low, collapsed.
 */
function ContextSent({ context }: { context: SearchAiContext }) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ mt: 1 }}>
      <Link
        component="button"
        type="button"
        underline="hover"
        onClick={() => setOpen((o) => !o)}
        sx={{ color: 'text.disabled', fontSize: 12 }}
      >
        {open ? '▾' : '▸'} Context sent ({contextSummary(context)})
      </Link>
      <Collapse in={open}>
        <Box
          component="pre"
          sx={{
            mt: 0.5, p: 1, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.04)',
            color: 'text.secondary', fontSize: 11, whiteSpace: 'pre-wrap', overflowX: 'auto',
            fontFamily: 'monospace',
          }}
        >
          {context.machineContext ?? context.nodePath}
        </Box>
      </Collapse>
    </Box>
  );
}

/**
 * Tool-call disclosure (plan-291 F8): names the read-only backend tools used
 * for this answer. Mirrors ContextSent so passive transparency stays ink-low.
 */
function ToolsUsed({ tools }: { tools: string[] }) {
  const [open, setOpen] = useState(false);
  return (
    <Box sx={{ mt: 1 }}>
      <Link
        component="button"
        type="button"
        underline="hover"
        onClick={() => setOpen((o) => !o)}
        sx={{ color: 'text.disabled', fontSize: 12 }}
      >
        {open ? '▾' : '▸'} Tools used ({tools.length})
      </Link>
      <Collapse in={open}>
        <Box
          component="pre"
          sx={{
            mt: 0.5, p: 1, borderRadius: 1, bgcolor: 'rgba(255,255,255,0.04)',
            color: 'text.secondary', fontSize: 11, whiteSpace: 'pre-wrap', overflowX: 'auto',
            fontFamily: 'monospace',
          }}
        >
          {tools.join('\n')}
        </Box>
      </Collapse>
    </Box>
  );
}

/**
 * "Affected parts" chips (plan-284 F9): the scene nodes whose linked documentation
 * matches a cited source. Clicking a chip selects + focuses the part in 3D (the
 * dialog stays open). Collapses to the first few with a "+N more" reveal.
 */
function AffectedParts({ paths }: { paths: string[] }) {
  const [expanded, setExpanded] = useState(false);
  const MAX_VISIBLE = 6;
  const visible = expanded ? paths : paths.slice(0, MAX_VISIBLE);
  const hidden = paths.length - visible.length;
  return (
    <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.75 }}>
      {visible.map((p) => (
        <PartLink key={p} path={p} variant="chip" />
      ))}
      {hidden > 0 && (
        <Chip
          label={`+${hidden} more`}
          size="small"
          variant="outlined"
          clickable
          onClick={() => setExpanded(true)}
          sx={{ color: 'text.secondary' }}
        />
      )}
    </Box>
  );
}

/**
 * Renders inline `**bold**` emphasis — the only markdown the diagnosis providers
 * emit — as a semibold primary-text span; everything else stays literal.
 * Unpaired `**` markers are left untouched.
 */
export function renderEmphasis(text: string): React.ReactNode {
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  if (parts.length === 1) return text;
  return parts.map((part, i) =>
    i % 2 === 1 ? (
      <Box key={i} component="strong" sx={{ fontWeight: 600, color: 'text.primary' }}>
        {part}
      </Box>
    ) : (
      part
    ),
  );
}

function buildPartLeafLookup(viewer: ReturnType<typeof useViewer>): ReadonlyMap<string, string | null> {
  const registry = viewer.registry;
  const lookup = new Map<string, string | null>();
  if (!registry) return lookup;
  registry.forEachNode((path) => {
    const leaf = path.split('/').at(-1) ?? path;
    const previous = lookup.get(leaf);
    lookup.set(leaf, previous === undefined || previous === path ? path : null);
  });
  return lookup;
}

function exactPartPath(
  viewer: ReturnType<typeof useViewer>,
  leafLookup: ReadonlyMap<string, string | null>,
  token: string,
): string | null {
  const registry = viewer.registry;
  if (!registry || !token) return null;

  if (token.includes('/')) {
    const node = registry.getNode(token);
    const path = node ? registry.getPathForNode(node) : null;
    if (path && (path === token || path.endsWith(`/${token}`))) return path;
    return null;
  }

  return leafLookup.get(token) ?? null;
}

function exactDocumentSource(sources: readonly DiagnoseSource[], token: string): DiagnoseSource | null {
  const normalized = token.trim().toLocaleLowerCase();
  if (!normalized) return null;
  const isDocumentNumber = /^\d{6,8}$/.test(token);
  const matches = sources.filter((source) => {
    if (!source.url) return false;
    if (source.title.trim().toLocaleLowerCase() === normalized) return true;
    if (!isDocumentNumber) return false;
    const refs = `${source.title}\n${source.url}`;
    return refs.match(/\d{6,8}/g)?.includes(token) ?? false;
  });
  return matches.length === 1 ? matches[0] : null;
}

function renderLinkedText(
  text: string,
  resolvers: AnswerLinkResolvers,
  keyPrefix: string,
): React.ReactNode[] {
  return linkifyAnswer(text, resolvers).map((segment, index) => {
    const key = `${keyPrefix}-${index}`;
    if (segment.kind === 'part') {
      return <PartLink key={key} path={segment.path} label={segment.text} variant="inline" />;
    }
    if (segment.kind === 'doc') {
      return (
        <Link
          key={key}
          component="button"
          type="button"
          variant="inherit"
          underline="none"
          onClick={() => openSource(segment.source)}
          sx={{
            p: 0,
            border: 0,
            color: '#4fc3f7',
            font: 'inherit',
            lineHeight: 'inherit',
            verticalAlign: 'baseline',
            cursor: 'pointer',
            '&:hover': { textDecoration: 'underline' },
          }}
        >
          {segment.text}
        </Link>
      );
    }
    return segment.text;
  });
}

/** Bold split first, then conservative linkification inside every text span. */
function renderAnswerText(
  text: string,
  viewer: ReturnType<typeof useViewer>,
  partLeafLookup: ReadonlyMap<string, string | null>,
  sources: readonly DiagnoseSource[],
): React.ReactNode {
  const resolvers: AnswerLinkResolvers = {
    resolvePart: (token) => exactPartPath(viewer, partLeafLookup, token),
    resolveDoc: (token) => exactDocumentSource(sources, token),
  };
  const parts = text.split(/\*\*([^*]+)\*\*/g);
  return parts.map((part, index) => {
    const linked = renderLinkedText(part, resolvers, `answer-${index}`);
    return index % 2 === 1 ? (
      <Box key={index} component="strong" sx={{ fontWeight: 600, color: 'text.primary' }}>
        {linked}
      </Box>
    ) : (
      <Box key={index} component="span">{linked}</Box>
    );
  });
}

/** A labeled answer section (pattern: robot-alarm AskAiDialog). */
function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="subtitle2" sx={{ color: '#4fc3f7', fontWeight: 700, mb: 0.5 }}>
        {title}
      </Typography>
      {children}
    </Box>
  );
}

/** Live elapsed-seconds label while the request runs. */
function ElapsedSeconds({ startedAt }: { startedAt?: number }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setTick((t) => t + 1), 1000);
    return () => clearInterval(timer);
  }, []);
  if (startedAt === undefined) return null;
  const seconds = Math.max(0, Math.round((Date.now() - startedAt) / 1000));
  return (
    <Typography component="span" variant="body2" sx={{ color: 'text.disabled', whiteSpace: 'nowrap' }}>
      · {seconds} s
    </Typography>
  );
}

export function SearchAiDialog({ open, onClose }: SearchAiDialogProps) {
  const state = useSyncExternalStore(subscribeSearchAi, getSearchAiSnapshot);
  const historyEntries = useSyncExternalStore(
    subscribeSearchAiHistory,
    getSearchAiHistorySnapshot,
  );
  const [historyAnchor, setHistoryAnchor] = useState<HTMLElement | null>(null);
  const res = state.result;
  const viewer = useViewer();
  const comparison = res?.comparison;
  const hasComparisonTab = !!comparison || !!res?.comparisonError;
  const [selectedResult, setSelectedResult] = useState(0);
  // Preselect the comparison tab when the primary found nothing but the
  // comparison (Claude) has a substantive answer — that answer is the payload.
  useEffect(() => {
    const r = state.result;
    setSelectedResult(r?.comparison && isEmptyAnswer(r) && !isEmptyAnswer(r.comparison) ? 1 : 0);
  }, [state.result]);
  const activeResult = selectedResult === 1 ? comparison : res;
  const comparisonFallback = res?.provider === 'cloud' ? 'Claude CLI' : 'Comparison';
  const partLeafLookup = useMemo(
    () => activeResult ? buildPartLeafLookup(viewer) : new Map<string, string | null>(),
    [viewer, activeResult],
  );

  // plan-284 F9: nodes whose linked docs match the cited sources → "Affected parts".
  const affected = useMemo(
    () => (activeResult ? nodesForSources(viewer, activeResult.sources) : []),
    [viewer, activeResult],
  );

  // ── Typewriter reveal (reduced-motion aware) ──
  // Sections gate on `revealed`: 1 = Answer, 2 = Recommendation, 3 = Sources.
  const [revealed, setRevealed] = useState(0);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const TOTAL_LINES = 3;

  useEffect(() => {
    if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    if (state.status !== 'done') {
      setRevealed(0);
      return;
    }
    if (prefersReducedMotion()) {
      setRevealed(TOTAL_LINES);
      return;
    }
    setRevealed(0);
    timerRef.current = setInterval(() => {
      setRevealed((r) => {
        if (r + 1 >= TOTAL_LINES && timerRef.current) {
          clearInterval(timerRef.current);
          timerRef.current = null;
        }
        return r + 1;
      });
    }, TYPEWRITER_INTERVAL_MS);
    return () => {
      if (timerRef.current) { clearInterval(timerRef.current); timerRef.current = null; }
    };
  }, [state.status, activeResult]);

  const handleClose = () => {
    abortAiSearch();
    onClose();
  };

  // Retry exists ONLY for transient errors (rate limit / timeout / network).
  // The backend answers deterministically (temperature 0), so re-running a
  // SUCCESSFUL query returns the identical answer — no general "Ask again".
  const handleTryAgain = () => {
    if (state.query) runAiSearch(state.query, state.context);
  };

  const restoreHistoryEntry = (entry: SearchAiHistoryEntry) => {
    restoreFromHistory(entry);
    setHistoryAnchor(null);
  };

  return (
    <Dialog open={open} onClose={handleClose} maxWidth="sm" fullWidth PaperComponent={DraggablePaper}>
      <DialogTitle
        {...{ [DRAG_HANDLE_ATTR]: 'true' }}
        sx={{
          display: 'flex', alignItems: 'center', gap: 1, pr: 11,
          cursor: 'move', userSelect: 'none', touchAction: 'none',
          '&:active': { cursor: 'grabbing' },
        }}
      >
        {/* Neutral ink-medium icon — Instrument Blue is reserved for action. */}
        <AutoAwesome sx={{ color: 'text.secondary' }} />
        {historyEntries.length > 0 && (
          <IconButton
            onClick={(event) => setHistoryAnchor(event.currentTarget)}
            sx={{ position: 'absolute', right: 44, top: 8 }}
            aria-label="AI answer history"
          >
            <History />
          </IconButton>
        )}
        <span>AI Assistant{state.query ? ` · ${truncateQuery(state.query)}` : ''}</span>
        <IconButton onClick={handleClose} sx={{ position: 'absolute', right: 8, top: 8 }} aria-label="Close">
          <Close />
        </IconButton>
        <Menu
          anchorEl={historyAnchor}
          open={Boolean(historyAnchor)}
          onClose={() => setHistoryAnchor(null)}
        >
          {historyEntries.map((entry) => (
            <MenuItem
              key={`${entry.at}-${entry.query}`}
              title={entry.query}
              onClick={() => restoreHistoryEntry(entry)}
            >
              {truncateQuery(entry.query, 40)}
            </MenuItem>
          ))}
        </Menu>
      </DialogTitle>

      <DialogContent
        dividers
        sx={{ minHeight: 160 }}
        role="status"
        aria-live="polite"
        aria-busy={state.status === 'loading'}
      >
        {/* plan-284 F1: context chip — removing it re-runs the query without node context. */}
        {state.context?.nodePath && (
          <Box sx={{ mb: 1.5 }}>
            <PartLink
              path={state.context.nodePath}
              variant="chip"
              onDelete={() => runAiSearch(state.query)}
            />
          </Box>
        )}

        {state.status === 'loading' && (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5, py: 3 }}>
            <CircularProgress size={22} />
            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
              Searching the machine documentation…
            </Typography>
            <ElapsedSeconds startedAt={state.startedAt} />
          </Box>
        )}

        {state.status === 'error' && (
          <Typography variant="body2" sx={{ color: ERROR_COLOR, py: 2 }}>
            {state.error || 'AI search failed'}
          </Typography>
        )}

        {state.status === 'empty' && (
          <Typography variant="body2" sx={{ color: 'text.secondary', py: 2 }}>
            No matching answer found in the documentation.
          </Typography>
        )}

        {state.status === 'done' && res && (
          <Box>
            {hasComparisonTab && (
              <Tabs
                value={selectedResult}
                onChange={(_event, value: number) => setSelectedResult(value)}
                aria-label="AI answer provider comparison"
                sx={{ mb: 2 }}
              >
                <Tab label={resultTabLabel(res, 'Primary')} />
                <Tab
                  label={comparison
                    ? resultTabLabel(comparison, comparisonFallback)
                    : `Comparison · ${res.comparisonError}`}
                />
              </Tabs>
            )}

            {selectedResult === 1 && !comparison && res.comparisonError && (
              <Typography variant="body2" sx={{ color: 'text.secondary', py: 2 }}>
                Comparison provider unavailable: {res.comparisonError}.
              </Typography>
            )}

            {activeResult && (
              <Box>
                {revealed >= 1 && activeResult.cause && (
                  <Section title="Answer">
                    <Typography variant="body2" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap' }}>
                      {renderAnswerText(activeResult.cause, viewer, partLeafLookup, activeResult.sources)}
                    </Typography>
                  </Section>
                )}

                {revealed >= 2 && activeResult.remedy && (
                  <Section title="Recommendation">
                    <Typography variant="body2" sx={{ color: 'text.secondary', whiteSpace: 'pre-wrap' }}>
                      {renderAnswerText(activeResult.remedy, viewer, partLeafLookup, activeResult.sources)}
                    </Typography>
                  </Section>
                )}

                {revealed >= 3 && activeResult.sources.length > 0 && (
                  <Section title="Sources">
                    {activeResult.sources.map((src, i) => (
                      <Box key={`${src.title}-${src.page ?? ''}-${i}`} sx={{ mb: 0.75 }}>
                        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
                          <Description sx={{ fontSize: 16, color: 'text.secondary' }} />
                          {src.url ? (
                            <Link
                              component="button"
                              variant="body2"
                              onClick={() => openSource(src)}
                              sx={{ textAlign: 'left' }}
                            >
                              {src.title || src.url}{src.page !== undefined ? ` (p.${src.page})` : ''}
                            </Link>
                          ) : (
                            <Typography variant="body2" sx={{ color: 'text.secondary' }}>
                              {src.title}{src.page !== undefined ? ` (p.${src.page})` : ''}
                            </Typography>
                          )}
                        </Box>
                        {src.snippet && isReadableSnippet(src.snippet) && (
                          <Typography
                            variant="body2"
                            sx={{
                              fontStyle: 'italic', color: 'text.secondary', pl: 3,
                              overflowWrap: 'anywhere',
                            }}
                          >
                            “{src.snippet}”
                          </Typography>
                        )}
                      </Box>
                    ))}
                  </Section>
                )}

                {revealed >= 3 && affected.length > 0 && (
                  <Section title="Affected parts">
                    <AffectedParts paths={affected} />
                  </Section>
                )}

                {revealed >= 3 && activeResult.toolTrace && activeResult.toolTrace.length > 0 && (
                  <ToolsUsed tools={activeResult.toolTrace} />
                )}

                {revealed >= TOTAL_LINES && activeResult.model && (
                  <Typography variant="caption" sx={{ color: 'text.disabled' }}>
                    Model: {activeResult.model}
                  </Typography>
                )}
              </Box>
            )}
          </Box>
        )}

        {state.status === 'idle' && (
          <Typography variant="body2" sx={{ color: 'text.secondary', py: 2 }}>
            Type a question in the search field, then press “Ask AI”.
          </Typography>
        )}

        {/* plan-284 F6: what context travelled with the request. */}
        {state.context && state.status !== 'loading' && <ContextSent context={state.context} />}
      </DialogContent>

      <DialogActions>
        {state.status === 'error' && (
          <Button startIcon={<Replay />} onClick={handleTryAgain} disabled={!state.query}>
            Try again
          </Button>
        )}
        <Box sx={{ flex: 1 }} />
        <Button onClick={handleClose}>Close</Button>
      </DialogActions>
    </Dialog>
  );
}
