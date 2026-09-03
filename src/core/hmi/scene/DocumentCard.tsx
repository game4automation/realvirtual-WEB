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
  Close,
  ContentCopy,
  Delete,
  DriveFileRenameOutline,
  FileDownload,
  MenuBookOutlined,
  MoreVert,
  Redo,
  SaveAlt,
  SettingsEthernet,
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
import {
  askSaveName,
  isPromptingSaveName,
  saveDocumentPromptKey,
  SAVE_PROMPT_BUSY,
} from './save-dialog-store';
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
   * @deprecated Accepted and ignored. The hero dropped its preview picture
   * (user decision 2026-09-02) — the model behind the translucent band IS the
   * picture. Kept so existing callers keep compiling.
   */
  previewVisible?: boolean;
  /**
   * The open document's CONNECT binding (`documents[].connectRef`), hero only —
   * rendered as a Unity-style reference chip.
   *
   * A prop rather than a seam field for the same reason `onReveal` is: the
   * binding lives in the project manifest, and only the dashboard — which sits
   * next to the project store — knows the row of the open document. The card
   * stays presentational: clicking the chip calls `onReveal` (the dashboard
   * pings the config in the tree), the × calls `onClear`, and the DROP that
   * assigns a config is handled by the mount around this card, not in here.
   * `null` renders nothing; `{ kind: 'empty' }` renders the ghost drop slot.
   */
  connect?: DocumentCardRefSlot | null;
  /**
   * The document's knowledge binding (`documents[].knowledgeRef`) — same slot
   * model, same drag-to-assign contract, book icon instead of the connector.
   */
  knowledge?: DocumentCardRefSlot | null;
}

/** One hero reference chip — bound (with name) or the empty slot. */
export type DocumentCardRefSlot =
  | {
      kind: 'bound';
      /** Display name — the classifying ending already stripped. */
      label: string;
      /** The file the binding names is not in the project. */
      missing?: boolean;
      /** Ping: reveal + select the referenced file in the dashboard. */
      onReveal?: () => void;
      /** Clear the binding. Absent = read-only. */
      onClear?: () => void;
    }
  /** No binding. `droppable` says whether a drag could change that. */
  | { kind: 'empty'; droppable?: boolean };

/** Former name of {@link DocumentCardRefSlot} — the CONNECT slot came first. */
export type DocumentCardConnect = DocumentCardRefSlot;

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

/** One-shot pulse when `label` changes to a NEW non-null value (mount is not
 *  an event — an existing binding pulses nothing). */
function usePulseOnChange(label: string | null): boolean {
  const [flash, setFlash] = useState(false);
  const prevRef = useRef<string | null | undefined>(undefined);
  useEffect(() => {
    const prev = prevRef.current;
    prevRef.current = label;
    if (prev === undefined || label === null || label === prev) return;
    setFlash(true);
    const timer = setTimeout(() => setFlash(false), 950);
    return () => clearTimeout(timer);
  }, [label]);
  return flash;
}

/**
 * One reference slot of the hero card, as a square DROP WELL (Unity
 * object-field parity, user sketch 2026-08-19): the field label sits above a
 * rounded square tile that pings on click, clears on the corner ×, states
 * "None" when unbound, and pulses in its own accent when a drop binds it.
 * `stopPropagation` throughout — the hero body's own click is "reveal the
 * DOCUMENT", and the slot must not trigger it.
 */
function RefSlotTile({ fieldLabel, what, Icon, slot, accent, flash, testId }: {
  fieldLabel: string;
  /** Human phrase for tooltips, e.g. "CONNECT configuration". */
  what: string;
  Icon: SvgIconComponent;
  slot: DocumentCardRefSlot;
  /** The slot's accent as `"r, g, b"` — green for CONNECT, pink for knowledge. */
  accent: string;
  flash: boolean;
  testId: string;
}) {
  const a = (alpha: number) => `rgba(${accent}, ${alpha})`;
  const bound = slot.kind === 'bound';
  const missing = bound && slot.missing === true;
  const ink = missing ? 'rgba(255,167,38,0.95)' : bound ? a(0.95) : 'rgba(255,255,255,0.45)';
  const clickable = bound && !!slot.onReveal;
  return (
    <Box
      onClick={(e) => e.stopPropagation()}
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5 }}
    >
      <Typography
        component="span"
        sx={{
          fontSize: 10, fontWeight: 500, letterSpacing: 1,
          textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)',
        }}
      >
        {fieldLabel}
      </Typography>
      <Box
        component={clickable ? 'button' : 'div'}
        data-testid={bound ? testId : `${testId}-empty`}
        onClick={clickable ? slot.onReveal : undefined}
        title={bound
          ? (missing
            ? `The ${what} this document references is missing from the project`
            : `Show this ${what} in the project`)
          : (slot.kind === 'empty' && slot.droppable
            ? `Drag a ${what} from the project onto this card to bind it`
            : `No ${what} referenced`)}
        sx={{
          appearance: 'none',
          font: 'inherit',
          position: 'relative',
          width: 104,
          height: 88,
          p: 0.5,
          borderRadius: '4px',
          display: 'flex',
          flexDirection: 'column',
          alignItems: 'center',
          justifyContent: 'center',
          gap: 0.5,
          cursor: clickable ? 'pointer' : 'default',
          bgcolor: missing ? 'rgba(255,167,38,0.08)' : bound ? a(0.1) : 'rgba(255,255,255,0.02)',
          border: missing
            ? '1px solid rgba(255,167,38,0.5)'
            : bound ? `1px solid ${a(0.55)}` : '1px dashed rgba(255,255,255,0.25)',
          '&:hover': clickable ? {
            bgcolor: missing ? 'rgba(255,167,38,0.15)' : a(0.18),
          } : {},
          '&:focus-visible': {
            outline: `1px solid ${a(1)}`,
            outlineOffset: 1,
          },
          // The drop's receipt: a ring in the slot's own accent that swells
          // out of the tile and fades — unmistakable, gone in under a second.
          ...(flash && {
            animation: 'rvRefSlotBound 900ms ease-out',
            '@keyframes rvRefSlotBound': {
              '0%': { boxShadow: `0 0 0 0 ${a(0.65)}` },
              '100%': { boxShadow: `0 0 0 14px ${a(0)}` },
            },
          }),
        }}
      >
        <Icon sx={{ fontSize: 26, color: bound || missing ? ink : 'rgba(255,255,255,0.3)' }} />
        <Typography
          component="span"
          sx={{
            fontSize: 11,
            fontWeight: bound ? 500 : 400,
            lineHeight: 1.2,
            maxWidth: 92,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
            color: ink,
          }}
        >
          {bound ? slot.label : 'None'}
        </Typography>
        {missing && (
          <Typography component="span" sx={{ fontSize: 9, lineHeight: 1, color: ink }}>
            missing
          </Typography>
        )}
        {bound && slot.onClear && (
          <Close
            role="button"
            aria-label={`Clear ${fieldLabel} binding`}
            titleAccess={`Clear ${fieldLabel} binding`}
            onClick={(e) => { e.stopPropagation(); slot.onClear!(); }}
            sx={{
              position: 'absolute',
              top: 3,
              right: 3,
              fontSize: 14,
              opacity: 0.5,
              cursor: 'pointer',
              '&:hover': { opacity: 1 },
            }}
          />
        )}
      </Box>
    </Box>
  );
}

export function DocumentCard({
  variant = 'compact',
  activeMode = null,
  onReveal,
  connect = null,
  knowledge = null,
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

  /**
   * The drop's receipt (hero only): when a binding changes to a new value,
   * its chip pulses once. Keyed on the LABEL, so a re-render with the same
   * binding stays quiet; the initial mount is skipped — an existing binding
   * is a fact, not an event.
   */
  const connectFlash = usePulseOnChange(connect?.kind === 'bound' ? connect.label : null);
  const knowledgeFlash = usePulseOnChange(knowledge?.kind === 'bound' ? knowledge.label : null);

  const closeMenu = useCallback(() => setMenuAnchor(null), []);

  /**
   * Ask for a name — through the shared store, never a dialog of our own.
   *
   * The card used to hold this prompt itself, and that local copy carried the
   * defect this plan closes: Cancel called `setNameDialog(null)` and NEVER
   * settled the promise, so `await view.actions.save(askName)` hung forever and
   * the live region kept announcing "Saving…". Routing every save prompt
   * through `save-dialog-store` also makes the reentrancy guard total (§2.10) —
   * the "Save as…" menu and Ctrl+S ask through the same one pending slot.
   *
   * The busy sentinel is mapped to `null` here on purpose: `NamePrompt` has two
   * answers, and for the save that DID reach a second prompt "treat it as
   * declined" is the only outcome that writes nothing. The click that would
   * have raced is already stopped one level up, in `onSave`.
   */
  // The document's NAME, deliberately, and not `documentKey` (which folds in a
  // thumbnail identity the editor never publishes): this key has to agree with
  // the one `runSaveFlow` uses on the other side of the seam, or the two save
  // entry points would hold two different pending slots and §2.10 would guard
  // nothing. `saveDocumentPromptKey` is the one derivation, shared by both.
  const promptKey = saveDocumentPromptKey(view?.name);
  const askName = useCallback(
    async (initial: string, title: string): Promise<string | null> => {
      const answer = await askSaveName({ documentKey: promptKey, initial, title });
      return answer === SAVE_PROMPT_BUSY || answer === null ? null : answer;
    },
    [promptKey],
  );

  /**
   * The one status mechanism, for every save path (F7).
   *
   * `try/finally` rather than a switch that happens to cover the outcomes the
   * author thought of: a save can also THROW, and an announcement written
   * before the await and unwound only on enumerated results is an announcement
   * that survives the failure it was describing.
   */
  const onSave = useCallback(async () => {
    if (!view) return;
    if (view.saveVerb === 'blocked') {
      const reason = view.saveReason ?? 'This document cannot be saved.';
      setNotice(reason);
      setAnnouncement(reason);
      return;
    }
    // §2.10: a second click while this document's prompt is open is a busy
    // no-op. The button stays enabled by design (§3.1) — busy is SHOWN, never
    // enforced by taking the control out of the keyboard order.
    if (isPromptingSaveName(promptKey)) return;
    setNotice(null);
    setAnnouncement('Saving…');
    try {
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
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setNotice(detail);
      setAnnouncement(`Save failed: ${detail}`);
    }
  }, [view, askName, promptKey]);

  /**
   * A menu verb, reported through the SAME live region as the button (F7).
   *
   * "Save as…" saves, and a save the assistive technology never hears about is
   * half a save. Prompting verbs still hand off to the card's generic name
   * dialog — they are renames and duplicates, not the save path.
   */
  const runVerb = useCallback(async (verb: ActiveDocumentVerb) => {
    closeMenu();
    if (verb.prompt) {
      setNameDialog({ verb, value: verb.prompt.initial });
      return;
    }
    const saves = verb.id === 'save-as';
    if (saves) setAnnouncement('Saving…');
    try {
      const result = await verb.run();
      if (typeof result === 'string') setMessage(result);
      if (saves) setAnnouncement('Saved');
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setMessage(detail);
      if (saves) setAnnouncement(`Save failed: ${detail}`);
    }
  }, [closeMenu]);

  const submitNameDialog = useCallback(async () => {
    const pending = nameDialog;
    if (!pending) return;
    const name = pending.value.trim();
    if (!name) return;
    setNameDialog(null);
    // The scene lineage's "Save as…" is a PROMPTING verb, so it lands here
    // rather than in `runVerb` — and it is still a save, so it announces
    // through the one live region like every other save path (F7).
    const saves = pending.verb.id === 'save-as';
    if (saves) setAnnouncement('Saving…');
    try {
      const result = await pending.verb.run(name);
      if (typeof result === 'string') setMessage(result);
      if (saves) setAnnouncement('Saved');
    } catch (e) {
      const detail = e instanceof Error ? e.message : String(e);
      setMessage(detail);
      if (saves) setAnnouncement(`Save failed: ${detail}`);
    }
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

  // Instrument Blue only when the click would DO something: unsaved changes,
  // a save in flight, or the read-only copy (which materialises a document
  // even from a clean source). A clean in-place save is a true no-op and a
  // blocked one cannot land — both render muted, never blue.
  const saveActive = view.dirty || view.busy || view.saveVerb === 'save-into-project';

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
        : (view.saveReason ?? (saveActive ? 'Save changes' : 'No unsaved changes'))}
      placement="top"
    >
      <Button
        data-testid="document-card-save"
        variant={saveActive ? 'contained' : 'outlined'}
        color={saveActive ? 'primary' : 'inherit'}
        size="small"
        // Never disabled (§3.1): busy and blocked are SHOWN, not enforced by
        // taking the control away from the keyboard. "Nothing to save" is
        // shown the same way — muted, not removed.
        onClick={() => { void onSave(); }}
        sx={{
          fontSize: 11, textTransform: 'none', py: 0.4, lineHeight: 1.2,
          // The hero gives it breathing room beside the title; the compact
          // header stays as tight as its row.
          minWidth: 0, ...(hero && { px: 2.5, flexShrink: 0 }),
          ...(!saveActive && { opacity: 0.55, borderColor: 'divider' }),
        }}
      >
        {view.busy ? 'Saving…' : saveLabel}
      </Button>
    </Tooltip>
  );

  const identity = (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, minWidth: 0 }}>
      {/* The hero drops the leading dot column: every line under the title
          starts at the same left edge, and the dirty dot joins the "Unsaved"
          word at the right where it reads as one statement. The compact
          header keeps the dot in front — there the trail is the title. */}
      {!hero && (view.dirty ? <DirtyDot /> : <Box sx={{ width: 7, minWidth: 7 }} />)}
      {hero
        ? (
          /* The trail IS the title — the same rule the compact header follows.
             The crumbs end in the current document at title size and weight,
             so a name line above a subtitle trail printed the name twice.
             Crumb clicks are navigation of their own, never the card's
             reveal. */
          <Box
            onClick={(e) => e.stopPropagation()}
            sx={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'center' }}
          >
            <DocumentCrumbs
              crumbs={view.crumbs}
              location={view.location}
              onCrumbClick={view.actions.onCrumb}
              testIdPrefix="document-crumb"
              fontSize={16}
              ariaLabel="Document breadcrumb"
            />
          </Box>
        )
        : (
          <Typography
            data-testid="document-card-name"
            sx={{
              fontSize: 13, fontWeight: 600, flex: 1, minWidth: 0,
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}
            title={view.name}
          >
            {view.name}
          </Typography>
        )}
      {view.dirty && (
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flexShrink: 0 }}>
          {hero && <DirtyDot />}
          <Typography
            sx={{ color: DIRTY_INK, fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.5 }}
          >
            Unsaved
          </Typography>
        </Box>
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
              // Frameless on its translucent band: no plate, no border — the
              // hero IS the band, and its content sits directly on the blurred
              // scene. A faint wash appears only on hover, as the reveal
              // affordance.
              width: '100%',
              p: 2, borderRadius: '4px',
              ...(onReveal && {
                cursor: 'pointer',
                transition: 'background-color 150ms ease-out',
                '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
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
          /* A slim banner, not a poster — and pictureless (user decision
             2026-09-02): the model itself is on screen behind the translucent
             band, so a rendered thumbnail beside it repeated what the eye
             already sees. */
          <Box sx={{ display: 'flex', alignItems: 'stretch', gap: 2 }}>
            {/* One frame level, not four: the card is the frame, the identity
                cluster sits at the top, a hairline separates it from the slot
                wells pinned to the bottom. The old inner border box doubled
                the card's own frame and made the whole hero read as boxes in
                boxes. */}
            <Box
              sx={{
                flex: 1, minWidth: 0,
                display: 'flex', flexDirection: 'column', gap: 0.5,
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
              <Box sx={{ flex: 1, minHeight: 10 }} />
              {/* The reference slot wells (Unity object fields): drop to bind,
                  click to ping, × to clear. Green = CONNECT, pink = knowledge
                  (user decision 2026-08-19). A hairline, not a box, carries
                  the grouping. */}
              <Box
                sx={{
                  display: 'flex', alignItems: 'flex-start', gap: 1.5,
                  borderTop: '1px solid rgba(255,255,255,0.08)',
                  pt: 1.25,
                }}
              >
                {connect && (
                  <RefSlotTile
                    fieldLabel="Connect"
                    what="CONNECT configuration"
                    Icon={SettingsEthernet}
                    slot={connect}
                    accent="102, 187, 106"
                    flash={connectFlash}
                    testId="document-card-connect"
                  />
                )}
                {knowledge && (
                  <RefSlotTile
                    fieldLabel="Knowledge"
                    what="knowledge file"
                    Icon={MenuBookOutlined}
                    slot={knowledge}
                    accent="233, 64, 120"
                    flash={knowledgeFlash}
                    testId="document-card-knowledge"
                  />
                )}
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
