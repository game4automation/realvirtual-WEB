// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentInfoEditor — the summary and the Markdown description of one
 * document, in the detail pane under the classification (plan-506 F5).
 *
 * ## Commit on blur, not per keystroke and not behind a Save button
 *
 * The classification editor writes on every change because a change there is
 * one click. Text is hundreds of keystrokes, and each write is a compare-and-
 * swap patch of the GLB — writing per keystroke (or per debounce tick) would
 * turn typing into a stream of file rewrites that race each other. A Save
 * button would make this the only field in the dashboard that can be left
 * half-entered. So: blur commits, Enter in the one-line summary commits, and
 * leaving the document (selection change, pane unmount) flushes.
 *
 * ## The draft is not this component's state
 *
 * It lives in `document-info-draft-store` together with the write that belongs
 * to it, keyed by project AND document. See that module for why: an unmount
 * fires no blur, and an effect cleanup runs after the host has already handed
 * this component the NEXT document's callback. A failed write keeps its draft
 * there and shows it again — with the error and a Retry — whenever the same
 * document is shown.
 *
 * ## Read-only shows text; nothing shows nothing
 *
 * Without `onCommit` (a bundled or delivered document) the description renders
 * as text. An empty block renders NOTHING in that case: the entire Unity export
 * corpus carries no description, and a "No description" line under every one
 * of them would be noise, not information.
 *
 * ## Untrusted Markdown
 *
 * A GLB can come from anyone. Rendering goes through `LazyMarkdown` (no
 * `rehype-raw`, so no raw HTML), links open in a new tab with
 * `noopener noreferrer`, and images render as their alt text only — a remote
 * image in a description is a tracking pixel the moment somebody opens the
 * dashboard.
 */

import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { Box, Button, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import { SectionHeader } from '../shared-components';
import { LazyMarkdown } from '../rv-markdown-lazy';
import { formatRelativeAge } from '../rv-node-knowledge-field-renderer';
import {
  isEmptyDocumentInfo,
  MAX_DESCRIPTION_CHARS,
  MAX_SUMMARY_CHARS,
  type DocumentInfo,
} from '../../project/rv-document-info';
import {
  commitDocumentInfoDraft,
  documentInfoDraftKey,
  flushDocumentInfoDraft,
  getDocumentInfoDraft,
  setDocumentInfoDraft,
  subscribeDocumentInfoDrafts,
} from './document-info-draft-store';

export interface DocumentInfoEditorProps {
  /** The project the document belongs to — half of the draft key (R2-5). */
  projectId: string;
  /** The document's identity; two documents with the same (or no) text stay distinct. */
  documentId: string;
  info?: DocumentInfo | null;
  /**
   * Absent for a read-only document; its presence is what makes this editable.
   * Rejects on failure. Called DIRECTLY — never through the dashboard's
   * `runVerb`, which drops a second call while one is running.
   */
  onCommit?: (next: DocumentInfo | null) => Promise<unknown>;
  /** True while an unrelated dashboard verb runs — the fields go inert. */
  busy?: boolean;
}

const INK_HIGH = 'rgba(255,255,255,0.92)';
const INK_MID = 'rgba(255,255,255,0.70)';
const INK_LOW = 'rgba(255,255,255,0.45)';
const LINK = '#64b5f6';
const ERROR = '#ef5350';

/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Markdown element overrides for a description. Module-level so `LazyMarkdown`
 * never rebuilds its lazy chunk. `img` is deliberately NOT an image.
 */
export const DOCUMENT_INFO_MD_COMPONENTS: Record<string, any> = {
  h1: (p: any) => <Typography {...p} component="div" sx={{ fontSize: 12, fontWeight: 700, color: INK_HIGH, mt: 0.75, mb: 0.25 }} />,
  h2: (p: any) => <Typography {...p} component="div" sx={{ fontSize: 11.5, fontWeight: 700, color: INK_HIGH, mt: 0.75, mb: 0.25 }} />,
  h3: (p: any) => <Typography {...p} component="div" sx={{ fontSize: 11, fontWeight: 700, color: INK_MID, mt: 0.5, mb: 0.25 }} />,
  p: (p: any) => <Typography {...p} component="div" sx={{ fontSize: 11, color: INK_MID, lineHeight: 1.5, my: 0.4, overflowWrap: 'anywhere' }} />,
  ul: (p: any) => <Box {...p} component="ul" sx={{ fontSize: 11, color: INK_MID, pl: 2, my: 0.4 }} />,
  ol: (p: any) => <Box {...p} component="ol" sx={{ fontSize: 11, color: INK_MID, pl: 2, my: 0.4 }} />,
  li: (p: any) => <Box {...p} component="li" sx={{ fontSize: 11, lineHeight: 1.5, overflowWrap: 'anywhere' }} />,
  // Untrusted text: a link never gets a handle on this window and never leaks
  // the viewer URL.
  a: ({ node: _node, ...p }: any) => (
    <Box {...p} component="a" target="_blank" rel="noopener noreferrer" sx={{ color: LINK, overflowWrap: 'anywhere' }} />
  ),
  // No remote fetch from a description — the alt text is all that renders.
  img: ({ alt }: any) => (
    <Box component="span" data-testid="document-info-img-alt" sx={{ color: INK_LOW, fontStyle: 'italic' }}>
      {alt ? `[${alt}]` : '[image]'}
    </Box>
  ),
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function RawText({ text }: { text: string }) {
  return (
    <Typography component="div" sx={{ fontSize: 11, color: INK_MID, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
      {text}
    </Typography>
  );
}

/** A description rendered as (safe) Markdown. */
export function DocumentInfoMarkdown({ text }: { text: string }) {
  return (
    <LazyMarkdown text={text} components={DOCUMENT_INFO_MD_COMPONENTS} fallback={<RawText text={text} />} errorBoundary />
  );
}

/** "updated 2 hours ago · Thomas", or null when the block carries no stamp. */
function StampLine({ info }: { info?: DocumentInfo | null }) {
  const age = info?.updatedAt ? formatRelativeAge(info.updatedAt) : null;
  if (!age && !info?.updatedBy) return null;
  return (
    <Typography
      data-testid="document-info-stamp"
      title={info?.updatedAt}
      sx={{ fontSize: 10, color: INK_LOW, mt: 0.5 }}
    >
      {['updated', age, info?.updatedBy ? `· ${info.updatedBy}` : null].filter(Boolean).join(' ')}
    </Typography>
  );
}

export function DocumentInfoEditor({
  projectId, documentId, info, onCommit, busy = false,
}: DocumentInfoEditorProps) {
  const key = documentInfoDraftKey(projectId, documentId);
  const draft = useSyncExternalStore(
    subscribeDocumentInfoDrafts,
    () => getDocumentInfoDraft(key),
  );
  const summary = draft?.summary ?? info?.summary ?? '';
  const description = draft?.description ?? info?.description ?? '';
  const [mode, setMode] = useState<'edit' | 'preview'>(description ? 'preview' : 'edit');

  // Leaving a document flushes its draft through the write stored WITH it — the
  // callback captured for that document, never the one of whatever is shown
  // next. StrictMode's mount/unmount/mount finds no draft on the first pass.
  useEffect(() => {
    if (!onCommit) return undefined;
    return () => { void flushDocumentInfoDraft(key); };
    // `onCommit` changes identity every render; the flush uses the stored write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, !!onCommit]);

  // A new document starts in Preview when it has something to preview.
  useEffect(() => {
    setMode((info?.description ?? '') ? 'preview' : 'edit');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  const edit = useCallback((next: { summary: string; description: string }) => {
    if (!onCommit) return;
    setDocumentInfoDraft(key, next, info ?? null, onCommit);
  }, [key, info, onCommit]);

  const commit = useCallback(() => {
    if (!onCommit) return;
    void commitDocumentInfoDraft(key, onCommit);
  }, [key, onCommit]);

  if (!onCommit) {
    if (isEmptyDocumentInfo(info)) return null;
    return (
      <Box sx={{ mt: 1.25 }} data-testid="document-info-readonly">
        <SectionHeader>Description</SectionHeader>
        {info?.summary && (
          <Typography sx={{ fontSize: 12, fontWeight: 600, color: INK_HIGH, mt: 0.5 }}>{info.summary}</Typography>
        )}
        {info?.description && <DocumentInfoMarkdown text={info.description} />}
        <StampLine info={info} />
      </Box>
    );
  }

  const error = draft?.error ?? null;
  return (
    <Box sx={{ mt: 1.25 }} data-testid="document-info-editor">
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <SectionHeader>Description</SectionHeader>
        <ToggleButtonGroup
          size="small"
          exclusive
          value={mode}
          onChange={(_e, v) => { if (v) setMode(v); }}
          aria-label="Description view"
          sx={{ '& .MuiToggleButton-root': { py: 0, px: 0.75, fontSize: 10, textTransform: 'none' } }}
        >
          <ToggleButton value="preview">Preview</ToggleButton>
          <ToggleButton value="edit">Edit</ToggleButton>
        </ToggleButtonGroup>
      </Box>
      <TextField
        fullWidth
        size="small"
        placeholder="One-line summary"
        value={summary}
        disabled={busy}
        onChange={e => edit({ summary: e.target.value, description })}
        onBlur={commit}
        onKeyDown={e => {
          if (e.key === 'Enter') { e.preventDefault(); commit(); }
        }}
        slotProps={{
          htmlInput: { 'aria-label': 'Document summary', maxLength: MAX_SUMMARY_CHARS },
          input: { sx: { fontSize: 12 } },
        }}
        sx={{ mt: 0.5 }}
      />
      {mode === 'edit' ? (
        <TextField
          fullWidth
          multiline
          minRows={3}
          maxRows={14}
          size="small"
          placeholder="Description (Markdown)"
          value={description}
          disabled={busy}
          onChange={e => edit({ summary, description: e.target.value })}
          onBlur={commit}
          slotProps={{
            htmlInput: { 'aria-label': 'Document description', maxLength: MAX_DESCRIPTION_CHARS },
            input: { sx: { fontSize: 11.5, fontFamily: 'inherit' } },
          }}
          sx={{ mt: 0.75 }}
        />
      ) : (
        <Box data-testid="document-info-preview" sx={{ mt: 0.5, minHeight: 20 }}>
          {description
            ? <DocumentInfoMarkdown text={description} />
            : <Typography sx={{ fontSize: 11, color: INK_LOW }}>No description yet.</Typography>}
        </Box>
      )}
      {error ? (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mt: 0.5 }} role="alert">
          <Typography data-testid="document-info-error" sx={{ fontSize: 10.5, color: ERROR, flex: 1 }}>
            Not saved: {error}
          </Typography>
          <Button size="small" onClick={commit} disabled={draft?.saving} sx={{ fontSize: 10, minWidth: 0, py: 0 }}>
            Retry
          </Button>
        </Box>
      ) : draft?.saving ? (
        <Typography sx={{ fontSize: 10, color: INK_LOW, mt: 0.5 }}>Saving…</Typography>
      ) : (
        <StampLine info={info} />
      )}
    </Box>
  );
}
