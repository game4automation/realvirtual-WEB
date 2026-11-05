// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentInfoEditor — the description of one document, at the bottom of the
 * detail pane (plan-506 F5).
 *
 * ## One field
 *
 * The block keeps two strings (`summary`, `description`), the editor shows
 * ONE text field: its first line is the summary — the bold line of the card
 * tooltip — and everything below it is the Markdown body. A first line longer
 * than the summary limit is not cut: the whole text then goes to the body.
 *
 * ## Rendered by default, edited behind the pencil
 *
 * The pane always shows the description as rendered Markdown. The pencil opens
 * the text field with Save / Cancel (Ctrl/Cmd+Enter saves, Escape cancels).
 * Leaving the document with unsaved text still flushes it (below), so a
 * selection change never throws typing away; only Cancel does.
 *
 * ## Why not per keystroke
 *
 * The classification editor writes on every change because a change there is
 * one click. Text is hundreds of keystrokes, and each write is a compare-and-
 * swap patch of the GLB — writing per keystroke (or per debounce tick) would
 * turn typing into a stream of file rewrites that race each other. A Save
 * button alone would let a selection change drop half-entered text. So: Save commits, and leaving the document
 * (selection change, pane unmount) flushes.
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
import { Box, Button, IconButton, TextField, Tooltip, Typography } from '@mui/material';
import { EditOutlined } from '@mui/icons-material';
import { SectionHeader } from '../shared-components';
import { LazyMarkdown } from '../rv-markdown-lazy';
import {
  isEmptyDocumentInfo,
  MAX_DESCRIPTION_CHARS,
  MAX_SUMMARY_CHARS,
  type DocumentInfo,
} from '../../project/rv-document-info';
import {
  commitDocumentInfoDraft,
  discardDocumentInfoDraft,
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

/** The block's two strings as the one field shows them. */
export function documentInfoText(info: { summary?: string; description?: string } | null | undefined): string {
  return [info?.summary ?? '', info?.description ?? ''].filter(Boolean).join('\n');
}

/**
 * The one field split back into the block's two strings: first line = summary,
 * the rest = body. A first line over {@link MAX_SUMMARY_CHARS} makes the whole
 * text the body rather than losing anything.
 */
export function splitDocumentInfoText(text: string): { summary: string; description: string } {
  const i = text.indexOf('\n');
  const first = (i < 0 ? text : text.slice(0, i)).trim();
  if (first.length > MAX_SUMMARY_CHARS) return { summary: '', description: text.trim() };
  const rest = i < 0 ? '' : text.slice(i + 1).replace(/^(\s*\n)+/, '').trimEnd();
  return { summary: first, description: rest };
}

/** Summary (bold) and body (Markdown) — what the pane shows outside editing. */
function DocumentInfoView({ info }: { info?: { summary?: string; description?: string } | null }) {
  return (
    <>
      {info?.summary && (
        <Typography sx={{ fontSize: 12, fontWeight: 600, color: INK_HIGH, mt: 0.5 }}>{info.summary}</Typography>
      )}
      {info?.description && <DocumentInfoMarkdown text={info.description} />}
    </>
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
  // An unsaved draft (a failed save, or text left behind) reopens the field.
  const [editing, setEditing] = useState<boolean>(() => !!draft);
  // The raw field text while the user types (it keeps blank lines the split
  // drops); null = show what the draft or the file says.
  const [typed, setTyped] = useState<string | null>(null);
  const text = typed ?? documentInfoText(draft ?? info);

  // Leaving a document flushes its draft through the write stored WITH it — the
  // callback captured for that document, never the one of whatever is shown
  // next. StrictMode's mount/unmount/mount finds no draft on the first pass.
  useEffect(() => {
    if (!onCommit) return undefined;
    return () => { void flushDocumentInfoDraft(key); };
    // `onCommit` changes identity every render; the flush uses the stored write.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, !!onCommit]);

  // A new document starts from its own text, never from the last one's.
  useEffect(() => {
    setTyped(null);
    setEditing(!!getDocumentInfoDraft(key));
  }, [key]);

  const edit = useCallback((next: string) => {
    if (!onCommit) return;
    setTyped(next);
    setDocumentInfoDraft(key, splitDocumentInfoText(next), info ?? null, onCommit);
  }, [key, info, onCommit]);

  const save = useCallback(async () => {
    if (!onCommit) return;
    const result = await commitDocumentInfoDraft(key, onCommit);
    // A failure keeps the field open with its error and Retry.
    if (result.ok) { setTyped(null); setEditing(false); }
  }, [key, onCommit]);

  const cancel = useCallback(() => {
    discardDocumentInfoDraft(key);
    setTyped(null);
    setEditing(false);
  }, [key]);

  if (!onCommit) {
    if (isEmptyDocumentInfo(info)) return null;
    return (
      <Box sx={{ mt: 1.25 }} data-testid="document-info-readonly">
        <SectionHeader>Description</SectionHeader>
        <DocumentInfoView info={info} />
      </Box>
    );
  }

  const error = draft?.error ?? null;
  const saving = !!draft?.saving;
  return (
    <Box sx={{ mt: 1.25 }} data-testid="document-info-editor">
      <Box sx={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <SectionHeader>Description</SectionHeader>
        {!editing && (
          <Tooltip title="Edit description">
            <span>
              <IconButton
                size="small"
                aria-label="Edit description"
                disabled={busy}
                onClick={() => setEditing(true)}
                sx={{ p: 0.25, color: INK_LOW, '&:hover': { color: INK_HIGH } }}
              >
                <EditOutlined sx={{ fontSize: 14 }} />
              </IconButton>
            </span>
          </Tooltip>
        )}
      </Box>
      {editing ? (
        <>
          <TextField
            fullWidth
            multiline
            autoFocus
            minRows={3}
            maxRows={14}
            size="small"
            placeholder={'Short summary on the first line\nDetails below (Markdown)'}
            value={text}
            disabled={busy || saving}
            onChange={e => edit(e.target.value)}
            onKeyDown={e => {
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); void save(); }
              if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); }
            }}
            slotProps={{
              htmlInput: {
                'aria-label': 'Document description',
                maxLength: MAX_SUMMARY_CHARS + 1 + MAX_DESCRIPTION_CHARS,
              },
              input: { sx: { fontSize: 11.5, fontFamily: 'inherit' } },
            }}
            sx={{ mt: 0.5 }}
          />
          {error && (
            <Typography data-testid="document-info-error" role="alert" sx={{ fontSize: 10.5, color: ERROR, mt: 0.5 }}>
              Not saved: {error}
            </Typography>
          )}
          <Box sx={{ display: 'flex', justifyContent: 'flex-end', gap: 0.5, mt: 0.5 }}>
            <Button size="small" onClick={cancel} disabled={saving} sx={{ fontSize: 11, textTransform: 'none', minWidth: 0 }}>
              Cancel
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={() => { void save(); }}
              disabled={busy || saving}
              sx={{ fontSize: 11, textTransform: 'none', minWidth: 0 }}
            >
              {saving ? 'Saving…' : error ? 'Retry' : 'Save'}
            </Button>
          </Box>
        </>
      ) : (
        <>
          {isEmptyDocumentInfo(info)
            ? <Typography sx={{ fontSize: 11, color: INK_LOW, mt: 0.5 }}>No description yet.</Typography>
            : <DocumentInfoView info={info} />}
        </>
      )}
    </Box>
  );
}
