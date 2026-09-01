// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-node-knowledge-field-renderer.tsx — the Property Inspector view of a
 * `NodeKnowledge` note (plan-431).
 *
 * plan-394 stored the note and deliberately built no UI for it. Once real notes
 * existed — 2400 characters of GFM tables on a delta robot — the generic string
 * field that got them was a single-line text input: unreadable, and editable by
 * anyone who clicked it, for a field nobody is supposed to hand-maintain.
 *
 * This renderer replaces that row with a compact provenance header (relative
 * date · author · confidence) over the formatted note in a fixed, self-scrolling
 * box. The four provenance fields are taken out of the generic field list by
 * `HIDDEN_FIELDS_PER_TYPE` (`rv-inspector-helpers.ts`) — they are shown HERE, so
 * they must not appear a second time as rows.
 *
 * ## Read-only WITHOUT `readonly: true` in the schema — the load-bearing detail
 *
 * The obvious way to freeze these five fields would be `readonly: true` on the
 * schema in `rv-node-knowledge.ts`. It would also **switch `web_knowledge_set`
 * off entirely**: `updateOverlayField` uses the same `isFieldDisplayReadonly`
 * predicate as a WRITE guard, and the MCP tool writes all five fields through
 * exactly that function. Measured, not assumed — one `readonly: true` on `Note`
 * alone turned 20 of the 31 `mcp-knowledge-tools` tests red with
 * "[rvExtrasEditor] Refusing to edit readonly field NodeKnowledge.Note".
 *
 * So read-only lives here, in the renderer: what is never rendered as an editor
 * can never be edited, and the write path stays open. Tests 9.5a/b in
 * `rv-node-knowledge-field-renderer.test.tsx` and `mcp-knowledge-tools.test.ts`
 * hold both halves of that in place.
 *
 * Self-registers with the fieldRendererRegistry on import — and is
 * side-effect-imported by `App.tsx`, which is the only thing that makes it exist
 * in production.
 */

import { Component, Suspense, lazy, memo, useMemo, type ReactNode } from 'react';
import { Box, Chip, Tooltip, Typography } from '@mui/material';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import {
  NODE_KNOWLEDGE_TYPE,
  NODE_KNOWLEDGE_FIELD,
  isEmptyNote,
  readNodeKnowledge,
  type NodeKnowledgeExtras,
} from '../engine/rv-node-knowledge';
import { loadMarkdown } from './rv-markdown-lazy';

// ── Local ink / metric constants (same convention as rv-component-section) ──

const INK_HIGH = 'rgba(255,255,255,0.92)';
const INK_MID = 'rgba(255,255,255,0.70)';
const INK_LOW = 'rgba(255,255,255,0.45)';
const RULE = 'rgba(255,255,255,0.14)';
/** Warning tone for a note that is a guess rather than a measurement. */
const INK_WARN = '#ffa726';
const LINK = '#64b5f6';
const MONO = 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';

/** Ceiling of the note box, scroll inside. Originally a fixed 320px (grill
 *  decision plan-431); revised 2026-08-22 on user feedback: a long note left
 *  most of the inspector column empty while scrolling in a small box, so the
 *  ceiling now grows with the viewport. 340px approximates the chrome above
 *  the note (top bar, transform + connections sections, provenance header);
 *  the 320px floor keeps short viewports at the old behaviour. */
const NOTE_MAX_HEIGHT = 'max(320px, calc(100vh - 340px))';

// ── Provenance formatting ─────────────────────────────────────────────────

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * `UpdatedAt` as "2 hours ago". plan-394 calls it "the only staleness signal a
 * reader gets", and a raw ISO stamp makes the reader do that arithmetic. The
 * exact value is not lost — it goes in the tooltip.
 *
 * Returns `null` for a missing or unparseable stamp: an entry written before the
 * field existed should show no date, not "Invalid Date".
 */
export function formatRelativeAge(iso: string, now: number = Date.now()): string | null {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return null;
  const delta = now - t;
  // A clock skew (note stamped in the future) reads as "just now" rather than
  // "in -3 minutes" — the note is current either way.
  if (delta < MINUTE) return 'just now';
  // Pinned to 'en' rather than the browser locale: the inspector is English
  // throughout ("No component data", "N more fields", every chip label), so a
  // browser-localized date would be the single translated string on the panel.
  const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });
  if (delta < HOUR) return rtf.format(-Math.round(delta / MINUTE), 'minute');
  if (delta < DAY) return rtf.format(-Math.round(delta / HOUR), 'hour');
  if (delta < 30 * DAY) return rtf.format(-Math.round(delta / DAY), 'day');
  return rtf.format(-Math.round(delta / (30 * DAY)), 'month');
}

/** Plain-language reading of a confidence value — a chip label alone does not
 *  tell a reader that "inferred" means nobody measured it. */
const CONFIDENCE_TOOLTIP: Record<string, string> = {
  observed: 'observed — read off the model or the running scene',
  inferred: 'inferred — derived from other facts, not directly seen',
  unverified: "unverified — a previous agent's guess, not a measurement",
};

/** `observed` is neutral; a guess is not allowed to look like a measurement (F3). */
function confidenceColor(confidence: string): string {
  return confidence === 'observed' ? INK_MID : INK_WARN;
}

// ── Markdown element styling for a 320-px-wide panel (§2.6) ───────────────
//
// Every wide element gets its OWN horizontal scroll container. The inspector
// itself must never scroll horizontally — a table that widens the panel pushes
// every other section's layout around.

const CELL = {
  border: `1px solid ${RULE}`,
  padding: '2px 6px',
  fontSize: 11,
  whiteSpace: 'nowrap' as const,
  textAlign: 'left' as const,
};

/* eslint-disable @typescript-eslint/no-explicit-any */
const MD_COMPONENTS: Record<string, any> = {
  // Notes are written with their own H1; inside the inspector it must not
  // outshout the section header above it.
  h1: (p: any) => <Typography {...p} component="div" sx={{ fontSize: 12, fontWeight: 700, color: INK_HIGH, mt: 0.75, mb: 0.25 }} />,
  h2: (p: any) => <Typography {...p} component="div" sx={{ fontSize: 11.5, fontWeight: 700, color: INK_HIGH, mt: 0.75, mb: 0.25 }} />,
  h3: (p: any) => <Typography {...p} component="div" sx={{ fontSize: 11, fontWeight: 700, color: INK_MID, mt: 0.5, mb: 0.25 }} />,
  h4: (p: any) => <Typography {...p} component="div" sx={{ fontSize: 11, fontWeight: 600, color: INK_MID, mt: 0.5, mb: 0.25 }} />,
  p: (p: any) => <Typography {...p} component="div" sx={{ fontSize: 11, color: INK_MID, lineHeight: 1.5, my: 0.4, overflowWrap: 'anywhere' }} />,
  ul: (p: any) => <Box {...p} component="ul" sx={{ fontSize: 11, color: INK_MID, pl: 2, my: 0.4 }} />,
  ol: (p: any) => <Box {...p} component="ol" sx={{ fontSize: 11, color: INK_MID, pl: 2, my: 0.4 }} />,
  li: (p: any) => <Box {...p} component="li" sx={{ fontSize: 11, lineHeight: 1.5, overflowWrap: 'anywhere' }} />,
  strong: (p: any) => <Box {...p} component="strong" sx={{ color: INK_HIGH, fontWeight: 700 }} />,
  blockquote: (p: any) => <Box {...p} component="blockquote" sx={{ borderLeft: `2px solid ${RULE}`, pl: 1, ml: 0, my: 0.4, color: INK_LOW }} />,
  hr: () => <Box sx={{ height: '1px', bgcolor: RULE, my: 0.75, border: 0 }} />,
  // A five-column table from a real note is wider than the panel: give it its
  // own scroller instead of letting it widen the inspector.
  table: (p: any) => (
    <Box sx={{ overflowX: 'auto', maxWidth: '100%', my: 0.5 }}>
      <Box {...p} component="table" sx={{ borderCollapse: 'collapse', fontSize: 11, color: INK_MID }} />
    </Box>
  ),
  th: (p: any) => <Box {...p} component="th" sx={{ ...CELL, fontWeight: 700, color: INK_HIGH, bgcolor: 'rgba(255,255,255,0.04)' }} />,
  td: (p: any) => <Box {...p} component="td" sx={{ ...CELL }} />,
  code: (p: any) => <Box {...p} component="code" sx={{ fontFamily: MONO, fontSize: 10.5, bgcolor: 'rgba(255,255,255,0.06)', px: 0.4, borderRadius: 0.5 }} />,
  pre: (p: any) => <Box {...p} component="pre" sx={{ fontFamily: MONO, fontSize: 10.5, overflowX: 'auto', maxWidth: '100%', bgcolor: 'rgba(255,255,255,0.05)', p: 0.75, borderRadius: 0.5, my: 0.5 }} />,
  // F9: a note is untrusted text. External targets never get a handle on this
  // window (`noopener`) and never leak the viewer URL (`noreferrer`).
  a: (p: any) => <Box {...p} component="a" target="_blank" rel="noopener noreferrer" sx={{ color: LINK, overflowWrap: 'anywhere' }} />,
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ── Fallbacks ─────────────────────────────────────────────────────────────

/**
 * The note as plain text, in the same box with the same ceiling.
 *
 * Shown while the markdown chunk is in flight AND when it never arrives. It is
 * deliberately NOT a spinner: unformatted engineering knowledge is still
 * knowledge, an empty box is not. Layout parity with the rendered version is
 * explicitly not promised — rendered markdown is almost never as tall as its
 * source (plan-431 §2.5).
 */
function RawNote({ text }: { text: string }) {
  return (
    <Typography
      component="div"
      data-testid="rv-knowledge-raw"
      sx={{ fontSize: 11, color: INK_MID, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', lineHeight: 1.5 }}
    >
      {text}
    </Typography>
  );
}

/**
 * Catches a REJECTED markdown chunk (offline, purged CDN, blocked asset).
 *
 * `Suspense` handles a pending promise and nothing else — a rejected dynamic
 * import throws, and without a boundary here that throw takes the surrounding
 * inspector subtree down with it. This is the single most common mistake in
 * code-split React, and it is the reason F7 names both mechanisms.
 */
class MarkdownErrorBoundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  componentDidCatch(error: unknown) {
    console.warn('[NodeKnowledge] markdown chunk failed to load, showing raw note', error);
  }

  render() {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

// ── Markdown body ─────────────────────────────────────────────────────────

/**
 * The lazy half. The `lazy()` component is built per mount (`useMemo`), so each
 * mounted renderer asks {@link loadMarkdown} exactly once — that is what lets a
 * test swap in a pending or rejecting loader and actually observe the state.
 *
 * `memo` is not decoration here. The inspector re-renders on its own live ticks,
 * and without it every one of those would re-parse the note — 2400 characters of
 * Markdown through micromark, several times a second, for a value that did not
 * change. `text` is a string, so the default shallow compare is exactly right.
 */
const MarkdownBody = memo(function MarkdownBody({ text }: { text: string }) {
  const Lazy = useMemo(
    () =>
      lazy(async () => {
        const { ReactMarkdown, remarkGfm } = await loadMarkdown();
        return {
          default: ({ source }: { source: string }) => (
            <ReactMarkdown remarkPlugins={[remarkGfm]} components={MD_COMPONENTS}>
              {source}
            </ReactMarkdown>
          ),
        };
      }),
    [],
  );

  const fallback = <RawNote text={text} />;
  return (
    <MarkdownErrorBoundary fallback={fallback}>
      <Suspense fallback={fallback}>
        <Lazy source={text} />
      </Suspense>
    </MarkdownErrorBoundary>
  );
});

// ── Provenance header ─────────────────────────────────────────────────────

function ProvenanceHeader({ entry }: { entry: NodeKnowledgeExtras }) {
  const age = formatRelativeAge(entry.UpdatedAt);
  /**
   * One hover target for "when and where this was written".
   *
   * The exact stamp and `NodeIdAtWrite` used to sit on two nested tooltips — the
   * date and a wrapper around the whole row — and hovering the row popped BOTH
   * at once. They answer the same question, so they share one tooltip on the one
   * element that is always present.
   */
  const stampHint = [
    entry.UpdatedAt ? `Written ${entry.UpdatedAt}` : 'Write date not recorded',
    entry.NodeIdAtWrite ? `Node id at write: ${entry.NodeIdAtWrite}` : 'Node id at write: not recorded',
  ].join(' · ');

  return (
    <Box
      data-testid="rv-knowledge-provenance"
      sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', mb: 0.5 }}
    >
      <Tooltip title={stampHint} placement="top">
        <Typography
          component="span"
          data-testid="rv-knowledge-stamp"
          sx={{ fontSize: 10, color: INK_LOW, cursor: 'help' }}
        >
          {age ?? 'date unknown'}
        </Typography>
      </Tooltip>
      <Chip
        label={entry.Author}
        size="small"
        sx={{ height: 16, fontSize: 9, color: INK_MID, bgcolor: 'rgba(255,255,255,0.07)', '& .MuiChip-label': { px: 0.6 } }}
      />
      <Tooltip title={CONFIDENCE_TOOLTIP[entry.Confidence] ?? entry.Confidence} placement="top">
        <Chip
          label={entry.Confidence}
          size="small"
          sx={{
            height: 16,
            fontSize: 9,
            cursor: 'help',
            color: confidenceColor(entry.Confidence),
            border: `1px solid ${confidenceColor(entry.Confidence)}55`,
            bgcolor: 'transparent',
            '& .MuiChip-label': { px: 0.6 },
          }}
        />
      </Tooltip>
    </Box>
  );
}

// ── The renderer ──────────────────────────────────────────────────────────

/**
 * Renders `NodeKnowledge.Note`. No editor, no save, no delete — writing a note
 * stays the job of `web_knowledge_set` (Grill decision: "read only").
 */
export function NodeKnowledgeNoteRenderer({ value, nodePath, viewer }: FieldRendererProps) {
  // The sibling provenance fields come from the ONE existing read path, which
  // also applies the defaults (`applySchema` never runs for this type — it has
  // no create-factory). A second reader here would be free to disagree with the
  // MCP tools about what the node says.
  //
  // Deliberately NOT memoised. Five property reads off an object cost nothing,
  // and any cache key would be wrong: a `web_knowledge_set` that raises the
  // confidence without touching the text changes neither `nodePath` nor `value`,
  // so a memo on those would keep showing yesterday's provenance (F10).
  const entry = readNodeKnowledge(viewer?.registry?.getNode(nodePath));

  // `value` is the authority for the text: it is the field value the inspector
  // just handed us, so an edit/undo/redo is visible without a re-selection (F10).
  // The entry is the fallback for the (rare) case where the node is not
  // resolvable through the registry.
  const text = typeof value === 'string' ? value : (entry?.Note ?? '');

  // F8: no entry, or nothing but whitespace → this field renders nothing at all.
  // Not an empty box, not a placeholder row.
  if (isEmptyNote(text)) return null;

  return (
    <Box data-testid="rv-knowledge-note" sx={{ px: 1, py: 0.5, maxWidth: '100%', overflowX: 'hidden' }}>
      {entry && <ProvenanceHeader entry={entry} />}
      <Box
        data-testid="rv-knowledge-scrollbox"
        sx={{
          maxHeight: NOTE_MAX_HEIGHT,
          overflowY: 'auto',
          overflowX: 'hidden',
          maxWidth: '100%',
          pr: 0.5,
          borderLeft: `2px solid ${RULE}`,
          pl: 1,
        }}
      >
        <MarkdownBody text={text} />
      </Box>
    </Box>
  );
}

// ── Self-registration ──
fieldRendererRegistry.register({
  componentType: NODE_KNOWLEDGE_TYPE,
  fieldName: NODE_KNOWLEDGE_FIELD,
  component: NodeKnowledgeNoteRenderer,
});
