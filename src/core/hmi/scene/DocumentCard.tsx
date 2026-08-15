// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentCard — one card for the open document, in two places (plan-709 §3.1).
 *
 * Grown out of `SceneActiveCard` (which was written for exactly this and never
 * mounted) and it replaces `AssetActiveCard` (which was the same card, editor
 * only). There is now ONE: the compact variant sits at the top of the hierarchy
 * browser, the hero variant above the search bar of the projects dashboard, and
 * both render the same state through the same verbs.
 *
 * ## It reads the seam and nothing else
 *
 * No `SceneStore`, no `RvDocumentStack`, no `AssetDocument` — those live on
 * either side of a boundary this card must not cross (§2.1.1). Everything it
 * shows and everything it can do arrives as an {@link ActiveDocumentView}
 * published by whichever writer owns the active mode. That is what lets the
 * same component hang in core UI while the editor plugin supplies half its
 * behaviour.
 *
 * ## The three promises that are easy to break later
 *
 *  - **The Save button is never disabled.** A disabled control drops out of the
 *    keyboard order and says nothing to a screen reader; state is shown instead
 *    (dirty dot, verb label, reason). The one exception is a stale frame, where
 *    the plan replaces Save with the conflict notice rather than offering a
 *    write that would lose somebody's work.
 *  - **The verb changes BEFORE the click.** A read-only source turns "Save"
 *    into "Save into project", so the copy is announced rather than discovered.
 *  - **The live region announces transitions only.** One permanent
 *    `role="status"`, written on Saving…/Saved/failure and never on an edit —
 *    a region that spoke on every keystroke is a region users turn off.
 *
 * Design: Glass Control Room. Existing card surface, Instrument Blue as the one
 * accent (the Save button), amber only through the shared `DirtyDot`, no new
 * shadows.
 */

import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import {
  Box,
  Button,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Divider,
  FormControlLabel,
  IconButton,
  ListItemIcon,
  ListItemText,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import {
  AutoAwesome,
  ContentCopy,
  Delete,
  DriveFileRenameOutline,
  FileDownload,
  MoreVert,
  Redo,
  SaveAlt,
  Share as ShareIcon,
  Undo,
} from '@mui/icons-material';
import type { SvgIconComponent } from '@mui/icons-material';
import { formatBytes } from '../../engine/rv-glb-flatten';
import {
  getActiveDocumentViewVersion,
  resolveActiveDocumentView,
  subscribeActiveDocumentView,
  type ActiveDocumentVerb,
  type ActiveDocumentView,
} from '../../editor/active-document-view';
import type { Object3D } from 'three';
import { useOptionalViewer } from '../../../hooks/use-viewer';
import { getAssetReference } from '../../engine/rv-asset-reference';
import { getLibrarySource } from '../../library/library-source-registry';
import { DirtyDot, DIRTY_INK } from '../rv-dirty-dot';
import { DocumentCrumbs } from './DocumentCrumbs';
import { ShareDialog } from '../../share/ShareDialog';
import type { RvShareMeta, RvShareLevel } from '../../share/rv-share-meta';

export type DocumentCardVariant = 'compact' | 'hero';

/** The id the card is gated under. */
export const DOCUMENT_CARD_UI_ID = 'document-card';

/**
 * Where the card may appear at all.
 *
 * A constant rather than a literal at the mount site so the test and the mount
 * cannot drift apart: `mode:viewer` is a deploy that shows a machine and no
 * document chrome, and "the card is hidden there" is a promise, not a detail.
 */
export const DOCUMENT_CARD_VISIBILITY = { hiddenIn: ['mode:viewer'] } as const;

export interface DocumentCardProps {
  /** `compact` = hierarchy header, `hero` = dashboard. Same state, two sizes. */
  variant?: DocumentCardVariant;
  /**
   * The mode the card is rendered in. A view published by a DIFFERENT mode is
   * discarded — the second half of the writer contract (§2.1.1, R2-S).
   *
   * `null`/absent means "do not filter": the dashboard hero is a place rather
   * than a mode, and filtering there would blank the card in the one screen the
   * user opened to look at it.
   */
  activeMode?: string | null;
  /**
   * Single click anywhere on the hero — preview or body.
   *
   * The hero describes the document that is ALREADY open, so "open it" was
   * never a useful verb here. What a user wants from it is the opposite
   * direction: show me where this thing lives. A prop rather than a seam field
   * because only the projects dashboard knows how to reveal and select a row.
   */
  onReveal?: () => void;
  /**
   * Whether the hero preview picture may be rendered right now (hero only).
   *
   * The dashboard host stays mounted while hidden (`display:none`), so without
   * this gate every model load/clear — i.e. every project switch — would
   * re-render the preview offscreen for a card nobody can see. The mount that
   * knows visibility (DocumentHeroSection via the projects-dashboard store)
   * passes it in; the card itself stays decoupled from that store.
   */
  previewVisible?: boolean;
}

/** Menu icons by verb id. Unknown ids simply render without one. */
const VERB_ICONS: Record<string, SvgIconComponent> = {
  'save-as': SaveAlt,
  rename: DriveFileRenameOutline,
  duplicate: ContentCopy,
  share: ShareIcon,
  download: FileDownload,
  'export-glb': FileDownload,
  discard: Delete,
  'save-into-model': AutoAwesome,
};

type NameDialogState = { verb: ActiveDocumentVerb; value: string } | null;

export function DocumentCard({
  variant = 'compact',
  activeMode = null,
  onReveal,
  previewVisible = true,
}: DocumentCardProps) {
  const viewer = useOptionalViewer();
  const version = useSyncExternalStore(
    subscribeActiveDocumentView,
    getActiveDocumentViewVersion,
  );
  // Resolution depends on the published view AND on the mode; memoised on both
  // so the handover placeholder keeps a stable identity between renders.
  const view = useMemo(
    () => resolveActiveDocumentView(activeMode),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [version, activeMode],
  );

  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const [nameDialog, setNameDialog] = useState<NameDialogState>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [shareOpen, setShareOpen] = useState(false);
  const [exportDialog, setExportDialog] = useState<
    { embed: boolean; estimate: Awaited<ReturnType<NonNullable<NonNullable<ActiveDocumentView['actions']['exportGlb']>['estimate']>>> | null } | null
  >(null);
  const [exporting, setExporting] = useState(false);
  /** The live region. Written on save transitions only — never on an edit. */
  const [announcement, setAnnouncement] = useState('');

  /**
   * Picture of the open document, as a PNG data URL.
   *
   * Rendered from what is IN the viewer rather than pulled through
   * `ThumbnailService.enqueue` like a library card: the hero's document is the
   * one already loaded, so there is nothing to resolve and no cache identity
   * worth writing — a saved snapshot would go stale the moment the user moves
   * something. `renderLiveNow` renders the live scene in place — never
   * `renderNow`, whose clone/dispose cycle is O(model) and destroys resources
   * shared with the live scene (that combination froze the dashboard for
   * ~20 s on large models). It is synchronous on the service's one renderer,
   * so it cannot interleave with a queued job.
   *
   * Null under a WebGPU viewer or before the model is in the scene; the slot
   * then falls back to the document name, which is what it always showed.
   */
  const [preview, setPreview] = useState<string | null>(null);
  const documentKey = view
    ? (view.thumbnailKey ? JSON.stringify(view.thumbnailKey) : view.name)
    : null;

  /**
   * One tick per model load/clear. The picture and the reference tally both
   * describe the LOADED model, which can arrive after the card renders — a
   * card keyed only on the document name would show the previous model's
   * facts until the next unrelated re-render.
   */
  const [modelTick, setModelTick] = useState(0);
  useEffect(() => {
    if (variant !== 'hero' || !viewer) return;
    const bump = () => setModelTick(t => t + 1);
    const offLoad = viewer.on('model-loaded', bump);
    const offClear = viewer.on('model-cleared', bump);
    return () => { offLoad(); offClear(); };
  }, [variant, viewer]);

  /** What the current preview picture shows — skip when unchanged (reopen = free). */
  const lastRenderedRef = useRef<{ key: string; tick: number } | null>(null);
  useEffect(() => {
    if (variant !== 'hero' || !viewer || !documentKey) {
      setPreview(null);
      lastRenderedRef.current = null;
      return;
    }
    const root = viewer.currentModelRoot;
    if (!root) {
      // model-cleared: a stale picture must not survive a clear.
      setPreview(null);
      lastRenderedRef.current = null;
      return;
    }
    const last = lastRenderedRef.current;
    const upToDate = last !== null && last.key === documentKey && last.tick === modelTick;
    if (!previewVisible) {
      // Hidden dashboard: never render for a card nobody can see. Drop a
      // picture of a DIFFERENT document/model so it cannot flash on reopen.
      if (!upToDate) { setPreview(null); lastRenderedRef.current = null; }
      return;
    }
    if (upToDate) return;
    // Double rAF: the first frame paints the dashboard overlay, the second
    // does the offscreen render — the user sees the screen before the work.
    let raf2 = 0;
    const raf1 = requestAnimationFrame(() => {
      raf2 = requestAnimationFrame(() => {
        lastRenderedRef.current = { key: documentKey, tick: modelTick };
        setPreview(viewer.thumbnails.renderLiveNow(root, 512));
      });
    });
    return () => { cancelAnimationFrame(raf1); cancelAnimationFrame(raf2); };
    // Deliberately NOT keyed on `version`: the view republishes on every edit,
    // and re-rendering the whole model for a dirty dot is not worth a frame.
  }, [variant, viewer, documentKey, modelTick, previewVisible]);

  /**
   * Distinct referenced assets of the loaded model, split local vs cloud.
   *
   * Read from the composition the loader already produced (frames + missing —
   * an unresolved reference is still a reference), not from any store: which
   * files this GLB pulls in is a fact about the loaded model, the same
   * altitude as its picture. The bucket is decided by the KIND of the library
   * source the reference resolves through; a path-resolved reference with no
   * provider identity is by definition local.
   */
  const [refCounts, setRefCounts] = useState<{ local: number; cloud: number } | null>(null);
  useEffect(() => {
    if (variant !== 'hero' || !viewer || !documentKey) { setRefCounts(null); return; }
    const result = viewer.lastLoadResult;
    if (!result) { setRefCounts(null); return; }
    const CLOUD_KINDS = new Set(['cloud', 'url', 'github']);
    const buckets = new Map<string, 'local' | 'cloud'>();
    const add = (node: Object3D, fallbackId: string) => {
      const ref = getAssetReference(node);
      const src = ref?.providerId && ref.sourceId
        ? getLibrarySource(ref.providerId, ref.sourceId)
        : null;
      buckets.set(ref?.assetId ?? fallbackId, src && CLOUD_KINDS.has(src.kind) ? 'cloud' : 'local');
    };
    for (const f of result.composition?.frames ?? []) add(f.referenceNode, f.assetId);
    for (const m of result.composition?.missing ?? []) add(m.referenceNode, m.assetId);
    let local = 0;
    let cloud = 0;
    for (const kind of buckets.values()) (kind === 'cloud' ? cloud++ : local++);
    setRefCounts({ local, cloud });
  }, [variant, viewer, documentKey, modelTick]);

  const closeMenu = useCallback(() => setMenuAnchor(null), []);

  /** Ask for a name through the card's own dialog (the seam owns no React). */
  const askName = useCallback((initial: string, title: string): Promise<string | null> => {
    return new Promise((resolve) => {
      setNameDialog({
        verb: { id: 'name', label: title, run: (name) => { resolve(name ?? null); } },
        value: initial,
      });
    });
  }, []);

  const onSave = useCallback(async () => {
    if (!view) return;
    if (view.saveVerb === 'blocked') {
      const reason = view.saveReason ?? 'This document cannot be saved.';
      setNotice(reason);
      setAnnouncement(reason);
      return;
    }
    setNotice(null);
    setAnnouncement('Saving…');
    const outcome = await view.actions.save(askName);
    switch (outcome.status) {
      case 'saved':
      case 'no-op':
        setAnnouncement('Saved');
        break;
      case 'cancelled':
        setAnnouncement('');
        break;
      case 'blocked':
        setNotice(outcome.reason);
        setAnnouncement(outcome.reason);
        break;
      case 'error':
        setNotice(outcome.message);
        setAnnouncement(`Save failed: ${outcome.message}`);
        break;
    }
  }, [view, askName]);

  const runVerb = useCallback(async (verb: ActiveDocumentVerb) => {
    closeMenu();
    if (verb.prompt) {
      setNameDialog({ verb, value: verb.prompt.initial });
      return;
    }
    const result = await verb.run();
    if (typeof result === 'string') setMessage(result);
  }, [closeMenu]);

  const submitNameDialog = useCallback(async () => {
    const pending = nameDialog;
    if (!pending) return;
    const name = pending.value.trim();
    if (!name) return;
    setNameDialog(null);
    const result = await pending.verb.run(name);
    if (typeof result === 'string') setMessage(result);
  }, [nameDialog]);

  const openExport = useCallback(async () => {
    closeMenu();
    const exp = view?.actions.exportGlb;
    if (!exp) return;
    const estimate = exp.estimate ? await exp.estimate().catch(() => null) : null;
    setExportDialog({ embed: false, estimate });
  }, [view, closeMenu]);

  const runExport = useCallback(async () => {
    const exp = view?.actions.exportGlb;
    if (!exportDialog || !exp) return;
    setExporting(true);
    try {
      const bytes = await exp.run({ embedReferences: exportDialog.embed });
      const url = URL.createObjectURL(
        new Blob([bytes as unknown as BlobPart], { type: 'model/gltf-binary' }),
      );
      const a = document.createElement('a');
      a.href = url;
      a.download = exp.fileName;
      a.click();
      // Revoked on the next tick: a synchronous revoke races the download in
      // Firefox, which reads the blob after the click handler returns.
      setTimeout(() => URL.revokeObjectURL(url), 0);
      setExportDialog(null);
    } catch (e) {
      setExportDialog(null);
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }, [exportDialog, view]);

  // Nothing open — the header renders no chrome, the hero renders its own
  // empty state (which is why that lives in the hero SECTION, not here).
  if (!view) return null;

  const hero = variant === 'hero';
  const saveLabel = view.saveVerb === 'save-into-project' ? 'Save into project' : 'Save';
  const menu = view.actions.menu ?? [];
  const hasMenu = menu.length > 0 || !!view.actions.share || !!view.actions.exportGlb;

  const saveButton = view.stale ? (
    <Typography
      data-testid="document-card-stale"
      sx={{ fontSize: 11, color: DIRTY_INK, lineHeight: 1.3 }}
    >
      The file changed below — reopen it before saving.
    </Typography>
  ) : (
    <Tooltip
      title={view.saveVerb === 'save-into-project'
        ? 'This source cannot be written to — Save puts a copy in the open project.'
        : (view.saveReason ?? 'Save changes')}
      placement="top"
    >
      <Button
        data-testid="document-card-save"
        variant="contained"
        size="small"
        // Never disabled (§3.1): busy and blocked are SHOWN, not enforced by
        // taking the control away from the keyboard.
        onClick={() => { void onSave(); }}
        sx={{
          fontSize: 11, textTransform: 'none', py: 0.4, lineHeight: 1.2,
          // The hero gives it breathing room beside the title; the compact
          // header stays as tight as its row.
          minWidth: 0, ...(hero && { px: 2.5, flexShrink: 0 }),
        }}
      >
        {view.busy ? 'Saving…' : saveLabel}
      </Button>
    </Tooltip>
  );

  const identity = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
      {view.dirty ? <DirtyDot /> : <Box sx={{ width: 7, minWidth: 7 }} />}
      <Typography
        data-testid="document-card-name"
        sx={{
          fontSize: hero ? 14 : 13, fontWeight: 600, flex: 1, minWidth: 0,
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        }}
        title={view.name}
      >
        {view.name}
      </Typography>
      {view.dirty && (
        <Typography
          sx={{ color: DIRTY_INK, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}
        >
          Unsaved
        </Typography>
      )}
    </Box>
  );

  /**
   * The compact identity: the trail IS the name.
   *
   * The hierarchy header used to print the model name and the card repeated it
   * one line below, with the location trail on a third. Since the trail already
   * ends in the current document — in high ink at weight 600 — the name line
   * was the redundant one, so compact drops it and keeps the full breadcrumb.
   * The hero keeps both: there the trail sits under a title that has room.
   */
  const compactIdentity = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0, flex: 1 }}>
      {view.dirty ? <DirtyDot /> : <Box sx={{ width: 7, minWidth: 7 }} />}
      <DocumentCrumbs
        crumbs={view.crumbs}
        location={view.location}
        onCrumbClick={view.actions.onCrumb}
        testIdPrefix="document-crumb"
        fontSize={12}
        ariaLabel="Document breadcrumb"
      />
      {view.dirty && (
        <Typography
          sx={{
            color: DIRTY_INK, fontSize: 10, textTransform: 'uppercase',
            letterSpacing: 0.5, flexShrink: 0,
          }}
        >
          Unsaved
        </Typography>
      )}
    </Box>
  );

  const historyButtons = (view.actions.undo || view.actions.redo) && (
    <>
      {view.actions.undo && (
        <Tooltip title={view.undoLabel ? `Undo: ${view.undoLabel}` : 'Undo'}>
          <span>
            <IconButton
              size="small"
              aria-label="Undo"
              data-testid="document-card-undo"
              disabled={view.canUndo === false}
              onClick={() => { void view.actions.undo?.(); }}
            >
              <Undo sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
      )}
      {view.actions.redo && (
        <Tooltip title={view.redoLabel ? `Redo: ${view.redoLabel}` : 'Redo'}>
          <span>
            <IconButton
              size="small"
              aria-label="Redo"
              data-testid="document-card-redo"
              disabled={view.canRedo === false}
              onClick={() => { void view.actions.redo?.(); }}
            >
              <Redo sx={{ fontSize: 16 }} />
            </IconButton>
          </span>
        </Tooltip>
      )}
    </>
  );

  const kebab = hasMenu && (
    <Tooltip title="More actions" placement="top">
      <IconButton
        size="small"
        sx={{ p: 0.25 }}
        aria-label="More actions"
        onClick={(e) => setMenuAnchor(e.currentTarget)}
      >
        <MoreVert sx={{ fontSize: 16 }} />
      </IconButton>
    </Tooltip>
  );

  return (
    <>
      <Box
        data-testid="document-card"
        data-variant={variant}
        // The whole hero is ONE navigation target: click anywhere → reveal the
        // asset in the library below. The verbs inside (Save, undo, kebab,
        // crumbs) opt out by stopping propagation — they are actions on the
        // document, not navigation, and must never double as both.
        onClick={hero && onReveal ? () => onReveal() : undefined}
        sx={hero
          ? {
              width: '100%', maxWidth: 620,
              p: 1.5, borderRadius: '4px',
              bgcolor: 'rgba(255,255,255,0.04)',
              border: '1px solid rgba(255,255,255,0.08)',
              ...(onReveal && {
                cursor: 'pointer',
                transition: 'background-color 150ms ease-out, border-color 150ms ease-out',
                '&:hover': {
                  bgcolor: 'rgba(255,255,255,0.06)',
                  borderColor: 'rgba(255,255,255,0.16)',
                },
              }),
            }
          : {
              // No chrome of its own: compact IS the hierarchy panel header
              // row, and that header already brings its padding and rule.
              minWidth: 0,
              flexShrink: 0,
            }}
      >
        {hero ? (
          /* A slim banner, not a poster: picture left, one line of content
             right, vertically centred. Undo/redo stay with the compact header
             where the editing happens — here they were dead weight between the
             title and the kebab. */
          <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 1.5 }}>
            {/* The picture. Fixed box (the render is square, so letting the
                image set the row height would balloon the card); keyboard
                users focus it as the card's one reveal control (mouse clicks
                bubble to the card itself). */}
            <Box
              data-testid="document-card-preview"
              key={documentKey ?? view.name}
              role={onReveal ? 'button' : undefined}
              tabIndex={onReveal ? 0 : undefined}
              aria-label={onReveal ? `Show ${view.name} in the library` : undefined}
              onKeyDown={(e) => {
                if (!onReveal) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onReveal(); }
              }}
              sx={{
                width: 148, height: 92, flexShrink: 0,
                borderRadius: '4px',
                border: '1px solid rgba(255,255,255,0.08)',
                bgcolor: 'rgba(255,255,255,0.02)',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                overflow: 'hidden',
                '&:focus-visible': {
                  outline: '1px solid rgba(79,195,247,0.8)',
                  outlineOffset: 1,
                },
              }}
            >
              {preview
                ? (
                  <Box
                    component="img"
                    src={preview}
                    alt=""
                    sx={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }}
                  />
                )
                : (
                  <Typography sx={{ fontSize: 11, color: 'text.disabled', px: 1 }}>
                    {view.name}
                  </Typography>
                )}
            </Box>

            {/* Title and verbs share ONE row, aligned to the picture's top
                edge; the trail (when it is a real trail) sits quietly
                beneath it. */}
            <Box
              sx={{
                flex: 1, minWidth: 0,
                display: 'flex', flexDirection: 'column',
                justifyContent: 'flex-start', gap: 0.75,
              }}
            >
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1 }}>
                <Box sx={{ flex: 1, minWidth: 0 }}>{identity}</Box>
                <Box
                  onClick={(e) => e.stopPropagation()}
                  sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexShrink: 0 }}
                >
                  {saveButton}
                  {kebab}
                </Box>
              </Box>
              {/* What this file pulls in. "Self-contained" is as much a fact
                  worth stating as a dependency count — a file with cloud
                  references needs its libraries wherever it travels. */}
              {refCounts && (
                <Typography
                  data-testid="document-card-refs"
                  sx={{ fontSize: 11, color: 'text.secondary', lineHeight: 1.3 }}
                >
                  {refCounts.local + refCounts.cloud === 0
                    ? 'Self-contained — no referenced assets'
                    : `${refCounts.local + refCounts.cloud} referenced asset`
                      + `${refCounts.local + refCounts.cloud === 1 ? '' : 's'} — `
                      + [
                        refCounts.local > 0 ? `${refCounts.local} local` : null,
                        refCounts.cloud > 0 ? `${refCounts.cloud} cloud` : null,
                      ].filter(Boolean).join(' · ')}
                </Typography>
              )}
              {/* Always the full trail — location segments in front of the
                  chain. A single chip repeating the title used to be hidden as
                  noise; with the location in front, the row is the one place
                  that says where the open document actually is. */}
              <Box
                onClick={(e) => e.stopPropagation()}
                sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}
              >
                <DocumentCrumbs
                  crumbs={view.crumbs}
                  location={view.location}
                  onCrumbClick={view.actions.onCrumb}
                  testIdPrefix="document-crumb"
                  fontSize={11}
                  ariaLabel="Document breadcrumb"
                />
              </Box>
            </Box>
          </Box>
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
            {compactIdentity}
            {historyButtons}
            <Box sx={{ flexShrink: 0 }}>{saveButton}</Box>
            {kebab}
          </Box>
        )}

        {notice && (
          <Typography
            data-testid="document-card-notice"
            sx={{ fontSize: 10, color: 'text.secondary', mt: 0.5 }}
          >
            {notice}
          </Typography>
        )}

        {/* One permanent live region. Present from the first render so the
            assistive technology has something to observe BEFORE the first
            transition — a region created together with its message is a
            message that is never announced. */}
        <Box
          role="status"
          aria-live="polite"
          data-testid="document-card-status"
          sx={{
            position: 'absolute', width: 1, height: 1, overflow: 'hidden',
            clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap',
          }}
        >
          {announcement}
        </Box>
      </Box>

      {hasMenu && (
        <Menu anchorEl={menuAnchor} open={Boolean(menuAnchor)} onClose={closeMenu}>
          {menu.map((verb) => {
            const Icon = VERB_ICONS[verb.id];
            return (
              <MenuItem
                key={verb.id}
                data-testid={`document-card-verb-${verb.id}`}
                disabled={verb.disabled}
                onClick={() => { void runVerb(verb); }}
                sx={verb.danger ? { color: '#ef5350' } : undefined}
              >
                {Icon && (
                  <ListItemIcon sx={{ minWidth: 28 }}>
                    <Icon sx={{ fontSize: 16, color: verb.danger ? '#ef5350' : undefined }} />
                  </ListItemIcon>
                )}
                <ListItemText
                  primary={verb.label}
                  secondary={verb.secondary}
                  primaryTypographyProps={{ fontSize: 13 }}
                  secondaryTypographyProps={{ fontSize: 10 }}
                />
              </MenuItem>
            );
          })}
          {view.actions.share && (
            <MenuItem
              data-testid="document-card-verb-share"
              onClick={() => { closeMenu(); setShareOpen(true); }}
            >
              <ListItemIcon sx={{ minWidth: 28 }}><ShareIcon sx={{ fontSize: 16 }} /></ListItemIcon>
              <ListItemText primaryTypographyProps={{ fontSize: 13 }}>Share…</ListItemText>
            </MenuItem>
          )}
          {view.actions.exportGlb && [
            <Divider key="export-divider" />,
            <MenuItem
              key="export"
              data-testid="document-card-verb-export-glb"
              onClick={() => { void openExport(); }}
            >
              <ListItemIcon sx={{ minWidth: 28 }}><FileDownload sx={{ fontSize: 16 }} /></ListItemIcon>
              <ListItemText primaryTypographyProps={{ fontSize: 13 }}>Export .glb…</ListItemText>
            </MenuItem>,
          ]}
        </Menu>
      )}

      {/* One name dialog for every verb that needs one. */}
      <Dialog open={Boolean(nameDialog)} onClose={() => setNameDialog(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>
          {nameDialog?.verb.prompt?.title ?? nameDialog?.verb.label ?? ''}
        </DialogTitle>
        <DialogContent>
          <TextField
            autoFocus
            fullWidth
            size="small"
            label="Name"
            value={nameDialog?.value ?? ''}
            onChange={(e) => nameDialog && setNameDialog({ ...nameDialog, value: e.target.value })}
            onKeyDown={(e) => { if (e.key === 'Enter') void submitNameDialog(); }}
            sx={{ mt: 1 }}
          />
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setNameDialog(null)} sx={{ textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={!nameDialog?.value.trim()}
            onClick={() => { void submitNameDialog(); }}
            sx={{ textTransform: 'none' }}
          >
            OK
          </Button>
        </DialogActions>
      </Dialog>

      {/* Export .glb — the one place the reference/flat trade-off is stated. */}
      <Dialog open={Boolean(exportDialog)} onClose={() => setExportDialog(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>Export as .glb</DialogTitle>
        <DialogContent>
          <FormControlLabel
            control={(
              <Checkbox
                size="small"
                checked={exportDialog?.embed ?? false}
                onChange={(e) => exportDialog && setExportDialog({ ...exportDialog, embed: e.target.checked })}
              />
            )}
            label={<Typography sx={{ fontSize: 13 }}>Embed references</Typography>}
          />
          <Typography sx={{ fontSize: 12, opacity: 0.75, mt: 0.5 }}>
            {exportDialog?.embed
              ? 'Referenced assets are written into the file. It runs anywhere on its own and still records what it was built from.'
              : 'References stay references. The file is smaller, and a corrected library asset still reaches it — but the recipient needs that library.'}
          </Typography>
          {exportDialog?.estimate && exportDialog.estimate.occurrences > 0 && (
            <Typography sx={{ fontSize: 12, mt: 1.25 }}>
              {exportDialog.embed
                ? `About ${formatBytes(exportDialog.estimate.totalBytes)} — `
                  + `${formatBytes(exportDialog.estimate.baseBytes)} scene plus `
                  + `${exportDialog.estimate.distinctAssets} referenced asset`
                  + `${exportDialog.estimate.distinctAssets === 1 ? '' : 's'} `
                  + `(${exportDialog.estimate.occurrences} occurrence`
                  + `${exportDialog.estimate.occurrences === 1 ? '' : 's'}).`
                : `About ${formatBytes(exportDialog.estimate.baseBytes)}.`}
            </Typography>
          )}
        </DialogContent>
        <DialogActions>
          <Button size="small" onClick={() => setExportDialog(null)} sx={{ textTransform: 'none' }}>
            Cancel
          </Button>
          <Button
            size="small"
            variant="contained"
            disabled={exporting}
            onClick={() => { void runExport(); }}
            sx={{ textTransform: 'none' }}
          >
            {exporting ? 'Exporting…' : 'Export'}
          </Button>
        </DialogActions>
      </Dialog>

      {view.actions.share && (
        <ShareDialog
          open={shareOpen}
          onClose={() => setShareOpen(false)}
          getBytes={(meta: RvShareMeta) => view.actions.share!.getBytes(meta)}
          suggestedName={view.actions.share.suggestedName}
          level={view.actions.share.level as RvShareLevel}
        />
      )}

      {/* Success and every refusal both land here, with a reason. */}
      <Dialog open={Boolean(message)} onClose={() => setMessage(null)} maxWidth="xs" fullWidth>
        <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>{view.name}</DialogTitle>
        <DialogContent>
          <Typography sx={{ fontSize: 13 }}>{message}</Typography>
        </DialogContent>
        <DialogActions>
          <Button
            size="small"
            variant="contained"
            onClick={() => setMessage(null)}
            sx={{ textTransform: 'none' }}
          >
            Close
          </Button>
        </DialogActions>
      </Dialog>
    </>
  );
}
