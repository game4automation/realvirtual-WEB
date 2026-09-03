// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectsDetailPane — what the current selection is, and what can be done to
 * it (plan-372 §3.6, Phase 7).
 *
 * ## Why the actions live here and not only on the card
 *
 * Every primary action must exist as an explicit button in this pane (§3.4).
 * Double-click is the fast path, but touch has no real double-click and there
 * is no keyboard equivalent — a UI where activation is *only* a double-click is
 * unusable with a finger or a keyboard. The pane is the accessible route, not a
 * convenience.
 *
 * **Rename is the worked example** (plan-450). It was a button, plan-717 made it
 * a click on the title, and a click on a word with no affordance but a text
 * cursor is exactly the "only route is a gesture" §3.4 forbids. It is a button
 * again — synthesised here from {@link ProjectsDetailPaneProps.onRename} rather
 * than passed in by every caller, so the verb cannot drift away from the
 * permission — and the title still edits on click. Both open the SAME editor;
 * there is no second commit path.
 *
 * ## Read-only selections still show their actions
 *
 * A bundled scene offers "Duplicate to this project" rather than a disabled
 * "Rename". Telling a user *what they can do instead* beats greying out five
 * buttons with no explanation — the same reason the bundled tier carries a
 * badge on the card.
 */

import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Box, Button, Divider, Stack, TextField, Typography } from '@mui/material';
import { RV_SCROLL_CLASS } from '../shared-sx';
import { SectionHeader } from '../shared-components';
import { loadMarkdown } from '../rv-markdown-lazy';

// ─── Markdown preview + editor (plan-445 F7) ────────────────────────────

/**
 * The renderer, behind the ONE lazy entry point the product already has.
 *
 * Built per mount (`useMemo` with no deps), the same shape
 * `rv-node-knowledge-field-renderer` uses: each mounted section asks
 * {@link loadMarkdown} once, which is what lets a test swap the loader and
 * still observe the pending state. The fallback is the raw text — a knowledge
 * file whose renderer chunk failed to load is still readable, and that is
 * worth more than an error box.
 */
function MarkdownPreview({ text }: { text: string }) {
  const Lazy = useMemo(
    () => lazy(async () => {
      const { ReactMarkdown, remarkGfm } = await loadMarkdown();
      return {
        default: ({ source }: { source: string }) => (
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{source}</ReactMarkdown>
        ),
      };
    }),
    [],
  );
  const raw = (
    <Typography
      component="pre"
      sx={{ fontSize: 11, whiteSpace: 'pre-wrap', wordBreak: 'break-word', m: 0 }}
    >
      {text}
    </Typography>
  );
  return (
    <Box
      data-testid="projects-detail-markdown-preview"
      sx={{
        fontSize: 11,
        lineHeight: 1.5,
        '& h1, & h2, & h3': { fontSize: 12, fontWeight: 600, m: '8px 0 4px' },
        '& p': { m: '0 0 6px' },
        '& code': { fontFamily: 'monospace', fontSize: 10 },
        '& table': { borderCollapse: 'collapse', fontSize: 10 },
        '& td, & th': { border: '1px solid rgba(255,255,255,0.12)', padding: '2px 4px' },
        '& img': { maxWidth: '100%' },
      }}
    >
      <Suspense fallback={raw}>
        <Lazy source={text} />
      </Suspense>
    </Box>
  );
}

/**
 * "Preview | Edit" over one Markdown file.
 *
 * A textarea, deliberately: an editor for a knowledge note is a place to fix a
 * sentence, and pulling in a code-editor dependency for that would cost more
 * bundle than the whole markdown renderer it sits beside (plan-445 NFA).
 *
 * The draft is local until Save, and it is reset whenever the SELECTION
 * changes (`identity`) — carrying half-typed text from one file onto the next
 * is the same data hazard the title's inline rename guards against.
 */
function MarkdownSection({
  model,
  identity,
}: { model: MarkdownPaneModel; identity: string | null }) {
  const [tab, setTab] = useState<'preview' | 'edit'>('preview');
  const [draft, setDraft] = useState<string | null>(null);
  useEffect(() => { setDraft(null); setTab('preview'); }, [identity]);

  const text = model.text;
  const editing = tab === 'edit' && model.editable;
  const body = draft ?? text ?? '';

  return (
    <>
      <Divider sx={{ my: 1.25, borderColor: 'rgba(255,255,255,0.06)' }} />
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, mb: 0.75 }}>
        <SectionHeader>Content</SectionHeader>
        <Box sx={{ flex: 1 }} />
        {(['preview', 'edit'] as const)
          // The Edit tab is ABSENT on a read-only file rather than disabled:
          // there is nothing the user could do to earn it here.
          .filter(t => t === 'preview' || model.editable)
          .map(t => (
            <Button
              key={t}
              size="small"
              data-testid={`projects-detail-md-tab-${t}`}
              onClick={() => setTab(t)}
              sx={{
                minWidth: 0, px: 0.75, py: 0, fontSize: 10, textTransform: 'none',
                color: tab === t ? '#4fc3f7' : 'text.secondary',
                fontWeight: tab === t ? 600 : 400,
              }}
            >
              {t === 'preview' ? 'Preview' : 'Edit'}
            </Button>
          ))}
      </Box>
      {text === null ? (
        <Typography sx={{ fontSize: 11, color: 'text.disabled' }}>Reading…</Typography>
      ) : editing ? (
        <>
          <TextField
            multiline
            fullWidth
            minRows={8}
            maxRows={24}
            value={body}
            onChange={(e) => setDraft(e.target.value)}
            inputProps={{ 'aria-label': 'Markdown source', 'data-testid': 'projects-detail-md-editor' }}
            slotProps={{ input: { sx: { fontSize: 11, fontFamily: 'monospace', p: 0.75 } } }}
          />
          <Stack direction="row" spacing={0.5} sx={{ mt: 0.75 }}>
            <Button
              size="small"
              variant="contained"
              disabled={draft === null || draft === text}
              onClick={() => { model.onSave(body); setDraft(null); setTab('preview'); }}
              sx={{ fontSize: 10, textTransform: 'none' }}
            >
              Save
            </Button>
            <Button
              size="small"
              variant="outlined"
              onClick={() => { setDraft(null); setTab('preview'); }}
              sx={{ fontSize: 10, textTransform: 'none' }}
            >
              Cancel
            </Button>
          </Stack>
        </>
      ) : (
        <MarkdownPreview text={body} />
      )}
    </>
  );
}

/** One row of the metadata table. */
export interface DetailField {
  label: string;
  value: string;
}

/** A button in the action stack. `primary` renders as the filled default. */
export interface DetailAction {
  key: string;
  label: string;
  onClick: () => void;
  primary?: boolean;
  disabled?: boolean;
  /** Shown as a tooltip-ish caption when the action is disabled. */
  disabledReason?: string;
  /** Renders in the error colour (delete and friends). */
  destructive?: boolean;
}

export interface ProjectsDetailPaneProps {
  /** Headline — usually the asset / scene / project name. */
  title: string | null;
  /** Small line under the title (category, backend kind, …). */
  subtitle?: string | null;
  /** Optional preview image URL. */
  thumbnailUrl?: string | null;
  /** Badge text, e.g. "Sample" for bundled entries. */
  badge?: string | null;
  /**
   * Further badges, rendered after {@link badge} in the order given.
   *
   * The role badge of plan-716 F8 (`Scenes` / `Models` / `Library` — the PLACE
   * a document's bytes live) is the first inhabitant, and it has to coexist
   * with "Sample" rather than replace it: read-only-ness and location are two
   * independent facts about the same row, and a single slot would have made
   * one of them invisible whenever the other applied.
   *
   * Empty strings are dropped, so a caller may pass a derived value straight
   * through without guarding it.
   */
  badges?: readonly string[];
  fields?: DetailField[];
  actions?: DetailAction[];
  /** Free-form description (a component's behaviour text, for instance). */
  description?: string | null;
  /**
   * Extra controls between the metadata and the verbs — the classification
   * editor, as it stands (plan-413 phase 4).
   *
   * A slot rather than a `classification` prop: this pane describes projects,
   * scenes, documents and library assets alike, and only some of those have a
   * classification. Teaching it about one selection's field would put the
   * union of every selection's fields in here eventually.
   */
  extra?: ReactNode;
  /**
   * Commit a new name for the selection, making the title editable in place.
   *
   * Supplied only for selections that CAN be renamed — a bundled sample or a
   * read-only catalog asset simply shows no pencil. The pane owns the editing
   * chrome; what a rename means (file, scene row, tree node) stays with the
   * caller, which is also where refusals surface.
   *
   * Its presence is ALSO the whole condition for the "Rename" action (plan-450
   * F1/F6): `onRename` already answers "may this be renamed", so a read-only
   * selection shows no button rather than a disabled one, and no caller has to
   * restate the permission a second time in an `actions` entry that could drift
   * away from it.
   */
  onRename?: (next: string) => void;
  /**
   * Markdown body of the selected file — preview, and an editor where the
   * project allows one (plan-445 F7).
   *
   * A slot with a shape rather than a `ReactNode` for the same reason
   * {@link extra} is a slot: the pane owns the tab chrome and the dirty
   * bookkeeping (which is presentation), the caller owns reading and writing
   * the bytes (which is storage). Only `.md` selections supply it.
   */
  markdown?: MarkdownPaneModel;
}

export interface MarkdownPaneModel {
  /** File contents, or null while the read is in flight. */
  text: string | null;
  /**
   * Offer the Edit tab. False on a read-only project AND on a read-only
   * source — the preview is still shown, because reading somebody else's
   * knowledge file is exactly as useful as reading your own.
   */
  editable: boolean;
  /** Persist an edited body. Called only from the Edit tab's Save. */
  onSave: (next: string) => void;
}

export function ProjectsDetailPane({
  title,
  subtitle,
  thumbnailUrl,
  badge,
  badges = [],
  fields = [],
  actions = [],
  description,
  extra,
  onRename,
  markdown,
}: ProjectsDetailPaneProps) {
  const [editValue, setEditValue] = useState<string | null>(null);
  // A different selection means a different name — never carry a half-typed
  // rename from one asset onto the next.
  useEffect(() => { setEditValue(null); }, [title]);

  /**
   * Open the inline editor — the ONE entry point every rename route shares.
   *
   * Named rather than inlined into the title's `onClick` because it now has
   * three callers (the title, the Rename action, and whatever comes next), and
   * a second `setEditValue(title!)` somewhere else is how a second commit path
   * starts. `onRename` is checked here so a caller that cannot rename can wire
   * this up harmlessly.
   */
  const startRename = () => { if (onRename && title !== null) setEditValue(title); };

  const commitRename = () => {
    const next = editValue?.trim();
    setEditValue(null);
    if (next && next !== title) onRename?.(next);
  };

  /**
   * The caller's verbs, plus "Rename" where the selection allows one.
   *
   * Synthesised rather than passed in: `onRename` IS the permission (§2.2), so
   * deriving the button from it makes "the verb is offered" and "the commit is
   * accepted" one fact instead of two that can disagree. The prop is never
   * mutated — a fresh array, because `actions` belongs to the caller's memo and
   * splicing into it would grow one entry per render.
   *
   * The insertion point is STRUCTURAL: after the last `primary` entry, or at the
   * front when there is none. Not a label match on "Open"/"Edit" — labels are
   * copy, and this pane already carries two spellings of the same primary verb
   * ("Edit" / "Edit a copy").
   */
  const shownActions = useMemo(() => {
    if (!onRename) return actions;
    let at = 0;
    for (let i = 0; i < actions.length; i++) if (actions[i].primary) at = i + 1;
    const next = [...actions];
    next.splice(at, 0, { key: 'rename', label: 'Rename', onClick: startRename });
    return next;
    // `startRename` is re-made every render and closes over `title`/`onRename`,
    // which are the two deps that actually matter here.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions, onRename, title]);

  return (
    <Box
      sx={{
        width: 260,
        flexShrink: 0,
        minHeight: 0,
        display: 'flex',
        flexDirection: 'column',
        borderLeft: '1px solid rgba(255,255,255,0.06)',
      }}
    >
      {!title ? (
        // Says what the pane IS, not just that it is idle: "Nothing selected"
        // describes the state and leaves a first-time user to guess the
        // purpose of a permanently visible 260px column.
        <Box data-testid="projects-detail-empty" sx={{ p: 1.5 }}>
          <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>
            Nothing selected
          </Typography>
          <Typography sx={{ fontSize: 11, color: 'text.disabled', mt: 0.75, opacity: 0.75 }}>
            Pick a document to see its preview, properties and links here.
          </Typography>
        </Box>
      ) : (
        <>
          {/* The header BAND — same height and type as the other two column
              headers ("Project" / the folder trail): 32px tall, 12px semibold,
              hairline below. The name stays a single ellipsized line here;
              the pane body carries everything that wraps. */}
          <Box
            sx={{
              display: 'flex', alignItems: 'center', gap: 0.75,
              px: 1.5, minHeight: 32, flexShrink: 0,
              borderBottom: '1px solid rgba(255,255,255,0.06)',
            }}
          >
            {editValue !== null ? (
              <TextField
                autoFocus
                fullWidth
                size="small"
                value={editValue}
                onChange={(e) => setEditValue(e.target.value)}
                // SELECT, not merely focus (plan-450 F4). `autoFocus` puts the
                // caret in the field and leaves the name intact, so the first
                // keystroke appends to it — "Rename" that behaves like "append
                // to name". Selecting on focus rather than in `startRename`
                // covers every entry point at once, because they all arrive
                // here through the same mount.
                onFocus={(e) => e.target.select()}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename();
                  if (e.key === 'Escape') setEditValue(null);
                }}
                // Blur cancels rather than commits: a stray click elsewhere
                // must never rename a file as a side effect.
                onBlur={() => setEditValue(null)}
                slotProps={{ input: { sx: { fontSize: 12, fontWeight: 600, height: 24 } } }}
                inputProps={{ 'aria-label': 'Rename' }}
              />
            ) : (
              <Typography
                // A CLICK edits — the name IS the field, not a label with a
                // verb somewhere else. No pencil beside it: the text cursor
                // is the affordance, and an icon would restate the offer —
                // the "Rename" button in the Actions section below is where
                // the verb is spelled out (plan-450 §3.1). An icon here would
                // be a THIRD statement of the same offer, which is why
                // plan-450 struck it back out.
                onClick={onRename ? startRename : undefined}
                sx={{
                  fontSize: 12,
                  fontWeight: 600,
                  minWidth: 0,
                  overflow: 'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace: 'nowrap',
                  ...(onRename ? { cursor: 'text' } : {}),
                }}
                title={title}
              >
                {title}
              </Typography>
            )}
            {editValue === null && [badge, ...badges]
              .filter((b): b is string => typeof b === 'string' && b !== '')
              .map(text => (
                <Typography
                  key={text}
                  component="span"
                  data-testid={`projects-detail-badge-${text.toLowerCase().replace(/[^a-z0-9]+/g, '')}`}
                  sx={{
                    fontSize: 9,
                    px: 0.5,
                    py: 0.125,
                    borderRadius: 0.5,
                    bgcolor: 'rgba(0,0,0,0.55)',
                    color: 'text.secondary',
                    textTransform: 'uppercase',
                    letterSpacing: 0.5,
                    flexShrink: 0,
                  }}
                >
                  {text}
                </Typography>
              ))}
          </Box>

          {/* The pane BODY — scrolls under the fixed header band. */}
          <Box
            className={RV_SCROLL_CLASS}
            sx={{ flex: 1, minHeight: 0, overflowY: 'auto', p: 1.5 }}
          >
          {thumbnailUrl && (
            <Box
              component="img"
              src={thumbnailUrl}
              alt={title}
              sx={{
                width: '100%',
                aspectRatio: '1',
                objectFit: 'cover',
                borderRadius: 1,
                bgcolor: 'rgba(255,255,255,0.05)',
                mb: 1,
              }}
            />
          )}

          {subtitle && (
            <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 0.25 }}>
              {subtitle}
            </Typography>
          )}

          {description && (
            <Typography sx={{ fontSize: 11, color: 'text.secondary', mt: 1, lineHeight: 1.45 }}>
              {description}
            </Typography>
          )}

          {fields.length > 0 && (
            <>
              <Divider sx={{ my: 1.25, borderColor: 'rgba(255,255,255,0.06)' }} />
              <Stack spacing={0.5}>
                {fields.map(f => (
                  <Box key={f.label} sx={{ display: 'flex', gap: 1 }}>
                    <Typography sx={{ fontSize: 11, color: 'text.disabled', minWidth: 76 }}>
                      {f.label}
                    </Typography>
                    {/* Measurement-style values are monospace per DESIGN.md. */}
                    <Typography sx={{ fontSize: 11, fontFamily: 'monospace', wordBreak: 'break-all' }}>
                      {f.value}
                    </Typography>
                  </Box>
                ))}
              </Stack>
            </>
          )}

          {extra}

          {markdown && <MarkdownSection model={markdown} identity={title} />}

          {shownActions.length > 0 && (
            <>
              <Divider sx={{ my: 1.25, borderColor: 'rgba(255,255,255,0.06)' }} />
              <SectionHeader>Actions</SectionHeader>
              <Stack spacing={0.5} sx={{ mt: 0.5 }}>
                {shownActions.map(a => (
                  <Box key={a.key}>
                    <Button
                      fullWidth
                      size="small"
                      variant={a.primary ? 'contained' : 'outlined'}
                      color={a.destructive ? 'error' : 'primary'}
                      disabled={a.disabled}
                      onClick={a.onClick}
                      sx={{ fontSize: 11, textTransform: 'none', justifyContent: 'flex-start' }}
                    >
                      {a.label}
                    </Button>
                    {/* A disabled action always says why (§2.9 bundled case). */}
                    {a.disabled && a.disabledReason && (
                      <Typography sx={{ fontSize: 10, color: 'text.disabled', mt: 0.25 }}>
                        {a.disabledReason}
                      </Typography>
                    )}
                  </Box>
                ))}
              </Stack>
            </>
          )}
          </Box>
        </>
      )}
    </Box>
  );
}
