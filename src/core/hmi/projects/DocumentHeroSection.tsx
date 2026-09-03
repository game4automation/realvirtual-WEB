// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentHeroSection — "what is open" at the top of the dashboard (§3.1, F3).
 *
 * A full-width band ABOVE the search bar with the document card centred in it —
 * centred because the open document belongs to the whole screen, not to the
 * tree column it would otherwise line up with.
 * The placement is the point and is pinned by
 * `tests/dashboard-hero-placement.test.tsx`: the first thing the user meets in
 * the dashboard should be the document they are working on, not the list of
 * everything they are not.
 *
 * The empty state stays a state rather than an absent band — a section that
 * vanished when nothing is open would make the whole screen jump by its height
 * the moment something is, and would leave a first-time user with no idea that
 * this is where their document appears.
 *
 * It asks the SAME seam the card does (`resolveActiveDocumentView`) rather than
 * keeping its own idea of whether something is open: two answers to that one
 * question is precisely what plan-709 exists to remove.
 */

import { useCallback, useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Button, LinearProgress, Typography } from '@mui/material';
import {
  getModelLoadProgressSnapshot,
  subscribeModelLoadProgress,
} from '../model-load-progress-store';
import {
  clearActiveDocumentState,
  confirmPendingActivation,
  getActiveDocumentState,
  subscribeActiveDocumentState,
} from '../connect-store';
import {
  getActiveDocumentViewVersion,
  resolveActiveDocumentView,
  subscribeActiveDocumentView,
} from '../../editor/active-document-view';
import { getOpenDocumentBase } from '../../editor/active-asset-store';
import { getProjectStore } from '../../project/project-store';
import {
  isConnectConfigPath,
  isKnowledgeFilePath,
  readDocumentRef,
  stripConnectConfigSuffix,
  stripKnowledgeFileSuffix,
} from '../../project/rv-project-refs';
import {
  getProjectsDashboardSnapshot,
  setProjectsSelection,
  subscribeProjectsDashboard,
} from './projects-dashboard-store';
import { CONNECT_CONFIG_DRAG_TYPE, KNOWLEDGE_FILE_DRAG_TYPE } from './connect-config-dnd';
import { DocumentCard, type DocumentCardRefSlot } from '../scene/DocumentCard';

/**
 * The hero while an open-in-place load runs (plan: cool + animated open).
 *
 * The card of the OLD document slides away and this takes its place: the
 * target's name at title weight, the load's progress underneath — determinate
 * while bytes stream (monospace MB, DESIGN.md's rule for measured values),
 * indeterminate for parse + scene construction. It reads the same
 * model-load-progress-store the splash writes, so the two can never disagree;
 * the dashboard itself closes (with its exit slide) only when the load is in.
 */
function OpeningHero({ label }: { label: string }) {
  const progress = useSyncExternalStore(subscribeModelLoadProgress, getModelLoadProgressSnapshot);
  const determinate = progress.active && !progress.preparing && progress.total > 0;
  const pct = determinate ? Math.min(100, (progress.loaded / progress.total) * 100) : 0;
  const mb = (n: number) => (n / (1024 * 1024)).toFixed(1);
  return (
    <Box
      data-testid="document-hero-opening"
      // Keyed mount per open: rises in once, then only the bar moves. An
      // OVERLAY on the hero band, so the band keeps the height of the (dimmed)
      // card underneath — the load must not make the layout jump.
      key={label}
      sx={{
        position: 'absolute',
        inset: 0,
        px: 4,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 1,
        '@keyframes rvHeroOpeningIn': {
          from: { opacity: 0, transform: 'translateY(6px)' },
          to: { opacity: 1, transform: 'none' },
        },
        animation: 'rvHeroOpeningIn 220ms cubic-bezier(0.22, 1, 0.36, 1)',
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
      }}
    >
      <Typography sx={{ fontSize: 16, fontWeight: 600, maxWidth: '100%', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </Typography>
      <LinearProgress
        variant={determinate ? 'determinate' : 'indeterminate'}
        value={pct}
        sx={{
          width: 'min(60%, 480px)',
          height: 3,
          borderRadius: '2px',
          bgcolor: 'rgba(255,255,255,0.08)',
          '& .MuiLinearProgress-bar': { bgcolor: '#4fc3f7' },
        }}
      />
      <Typography sx={{ fontSize: 11, color: 'text.secondary', fontFamily: determinate ? 'monospace' : 'inherit' }}>
        {progress.preparing
          ? 'Preparing scene…'
          : determinate
            ? `${mb(progress.loaded)} / ${mb(progress.total)} MB`
            : 'Loading…'}
      </Typography>
    </Box>
  );
}

export interface DocumentHeroSectionProps {
  /**
   * Click on the card. The dashboard supplies it because revealing a document
   * means selecting its row in the tree, which is the dashboard's knowledge and
   * not the document's.
   */
  onReveal?: () => void;
}

export function DocumentHeroSection({ onReveal }: DocumentHeroSectionProps) {
  const viewVersion = useSyncExternalStore(
    subscribeActiveDocumentView, getActiveDocumentViewVersion);
  // `null` — the dashboard is a place, not a mode, so the band shows whatever
  // document is open rather than only the one belonging to the mode behind the
  // overlay.
  const open = resolveActiveDocumentView(null) !== null;
  const store = getProjectStore();
  const project = useSyncExternalStore(store.subscribe, store.getSnapshot);
  // The dashboard host stays mounted while hidden (display:none), so the card
  // needs to know when it is actually on screen — rendering the hero preview
  // for a hidden dashboard is what made every project switch pay for a picture
  // nobody saw. This section is the one hero mount AND already lives next to
  // the store, so the visibility knowledge crosses to the card here.
  const dashboard = useSyncExternalStore(subscribeProjectsDashboard, getProjectsDashboardSnapshot);

  /**
   * The open document's manifest row and its CONNECT binding (plan-718 §3).
   *
   * Computed HERE because this section sits next to the project store and is
   * the one hero mount: the identity of what is open comes from the asset
   * store, its manifest row from the project — the card itself stays coupled
   * to neither. Matched by row id first (rename-proof), by path as fallback.
   */
  const binding = useMemo(() => {
    const base = getOpenDocumentBase();
    if (!base || base.kind !== 'document') return null;
    const doc = project.documents.find(d => d.id === base.documentId)
      ?? (base.path ? project.documents.find(d => d.path === base.path) : undefined);
    if (!doc || typeof doc.id !== 'string' || doc.id === '') return null;
    return {
      documentId: doc.id,
      bundled: doc.tier === 'bundled',
      ref: readDocumentRef(doc, 'connectRef'),
      knowledgeRef: readDocumentRef(doc, 'knowledgeRef'),
    };
    // `viewVersion` is the re-read trigger: the seam republishes whenever what
    // is open changes, and the base is not a subscribable store of its own.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewVersion, project.documents]);

  /**
   * The project's config + knowledge files — what decides whether a binding
   * is MISSING. Best-effort, refreshed per dashboard open, like the host's
   * own listings.
   */
  const [configs, setConfigs] = useState<string[]>([]);
  const [knowledgeFiles, setKnowledgeFiles] = useState<string[]>([]);
  useEffect(() => {
    const backend = store.getBackend();
    if (!dashboard.open || !backend) { setConfigs([]); setKnowledgeFiles([]); return; }
    let alive = true;
    void (backend.listConnectConfigs?.() ?? Promise.resolve([]))
      .then(paths => { if (alive) setConfigs(paths); })
      .catch(() => { if (alive) setConfigs([]); });
    void (backend.listKnowledgeFiles?.() ?? Promise.resolve([]))
      .then(paths => { if (alive) setKnowledgeFiles(paths); })
      .catch(() => { if (alive) setKnowledgeFiles([]); });
    return () => { alive = false; };
  }, [dashboard.open, store, project.project?.id, project.documents]);

  const writable = project.writable && binding !== null && !binding.bundled;

  /** The one write per field. In-memory first, so the chip flips at once. */
  const assign = useCallback((field: 'connectRef' | 'knowledgeRef', ref: string | null) => {
    if (!binding) return;
    const write = field === 'connectRef'
      ? store.setDocumentConnectRef(binding.documentId, ref)
      : store.setDocumentKnowledgeRef(binding.documentId, ref);
    void write.catch((e) => {
      console.warn(`[document-hero] ${field} not written:`, e);
    });
  }, [store, binding]);

  /** Ping — select the file's row, Unity-style. The tree and grid follow. */
  const reveal = useCallback((ref: string) => {
    const rootId = project.project?.id;
    if (!rootId) return;
    setProjectsSelection({ kind: 'file', rootId, relPath: ref });
  }, [project.project?.id]);

  /** One slot per reference field — same shape, different strip + listing. */
  const slotFor = (
    field: 'connectRef' | 'knowledgeRef',
    ref: string | null,
    existing: readonly string[],
    strip: (path: string) => string,
  ): DocumentCardRefSlot | null => {
    if (!binding) return null;
    if (!ref) {
      // "None" is a stated fact, shown read-only too — only the drop
      // affordance is gated on writability (user decision 2026-08-19).
      return { kind: 'empty', droppable: writable };
    }
    return {
      kind: 'bound',
      label: strip(ref),
      missing: !existing.includes(ref),
      // A missing file has no row to ping — the chip then states, not links.
      ...(existing.includes(ref) ? { onReveal: () => reveal(ref) } : {}),
      ...(writable ? { onClear: () => assign(field, null) } : {}),
    };
  };

  const connect = slotFor('connectRef', binding?.ref ?? null, configs, stripConnectConfigSuffix);
  const knowledge = slotFor(
    'knowledgeRef', binding?.knowledgeRef ?? null, knowledgeFiles, stripKnowledgeFileSuffix);

  /**
   * The hero as a drop target (Unity-style reference assignment): a config or
   * knowledge card dragged from the grid binds on drop. Gated on the payload
   * TYPE, so the tree's move drag and random text drops sail past untouched.
   */
  const [dragOver, setDragOver] = useState<'connect' | 'knowledge' | null>(null);
  const dragKindOf = (e: React.DragEvent): 'connect' | 'knowledge' | null =>
    e.dataTransfer.types.includes(CONNECT_CONFIG_DRAG_TYPE) ? 'connect'
      : e.dataTransfer.types.includes(KNOWLEDGE_FILE_DRAG_TYPE) ? 'knowledge'
        : null;
  const onDragOver = (e: React.DragEvent) => {
    const kind = writable ? dragKindOf(e) : null;
    if (!kind) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'link';
    setDragOver(kind);
  };
  const onDrop = (e: React.DragEvent) => {
    setDragOver(null);
    if (!writable || !dragKindOf(e)) return;
    e.preventDefault();
    const configRef = e.dataTransfer.getData(CONNECT_CONFIG_DRAG_TYPE);
    if (isConnectConfigPath(configRef)) { assign('connectRef', configRef); return; }
    const knowledgeRef = e.dataTransfer.getData(KNOWLEDGE_FILE_DRAG_TYPE);
    if (isKnowledgeFilePath(knowledgeRef)) assign('knowledgeRef', knowledgeRef);
  };
  // The ring announces WHICH slot the drop will fill — the slot's own color.
  const ringRgb = dragOver === 'knowledge' ? '233, 64, 120' : '102, 187, 106';

  /**
   * What the running gateway had to say about the last binding change
   * (plan-725 F13/F6/F4).
   *
   * The card is the right place for all three because the card is where the
   * binding was made: a held-back switch, a gateway serving another project and
   * a configuration whose binding could not be saved are all answers to the drop
   * the user just did, and none of them may be silence.
   */
  const gateway = useSyncExternalStore(subscribeActiveDocumentState, getActiveDocumentState);
  const notice = gateway.pending
    ? {
      tone: '255, 179, 0',
      text: `Activate "${gateway.pending.profile}"? `
        + `${gateway.pending.connectedInterfaces.length} interface(s) are connected — `
        + 'switching now cuts their connection.',
      confirm: 'Activate',
    }
    : gateway.mismatch
      ? { tone: '229, 115, 115', text: `The gateway serves a different project. ${gateway.mismatch}` }
      : gateway.writeBackError
        ? { tone: '229, 115, 115', text: gateway.writeBackError }
        : null;

  return (
    <Box
      data-testid="document-hero"
      sx={{
        width: '100%',
        display: 'flex',
        // Centred in the band. The open document is the one thing on this
        // screen that belongs to no column, so it is not aligned to one:
        // centring is what makes it read as the header of the whole dashboard
        // rather than as the first item of the tree beside it.
        justifyContent: 'center',
        alignItems: 'center',
        px: 1.5,
        py: 1.25,
        borderBottom: '1px solid rgba(255,255,255,0.06)',
        flexShrink: 0,
        // Anchor for the open-in-place overlay (OpeningHero).
        position: 'relative',
      }}
    >
      {/* While an open-in-place load runs, the current content stays MOUNTED
          and merely dims — the band keeps its exact height — while the
          opening panel floats over it. */}
      <Box
        sx={{
          width: '100%', display: 'flex', justifyContent: 'center',
          transition: 'opacity 200ms ease-out',
          ...(dashboard.opening !== null && { opacity: 0.15, pointerEvents: 'none' }),
        }}
      >
      {open
        ? (
          <Box
            data-testid="document-hero-dropzone"
            onDragOver={onDragOver}
            onDragLeave={() => setDragOver(null)}
            onDrop={onDrop}
            sx={{
              // Full band width — the hero shares its edges with the content
              // area below instead of floating as a narrow centred plate.
              width: '100%',
              borderRadius: '4px',
              // The ring appears only for a drag the drop would accept, in the
              // TARGET slot's color — green for a config, pink for knowledge —
              // so the affordance also says where the drop will land.
              outline: dragOver
                ? `1px dashed rgba(${ringRgb}, 0.8)` : '1px dashed transparent',
              outlineOffset: 3,
              bgcolor: dragOver ? `rgba(${ringRgb}, 0.05)` : 'transparent',
              transition: 'background-color 0.15s',
            }}
          >
            <DocumentCard
              variant="hero"
              onReveal={onReveal}
              previewVisible={dashboard.open}
              connect={connect}
              knowledge={knowledge}
            />
            {notice && (
              <Box
                data-testid="document-hero-connect-notice"
                sx={{
                  mt: 0.75,
                  px: 1,
                  py: 0.5,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 1,
                  borderRadius: '4px',
                  border: `1px solid rgba(${notice.tone}, 0.45)`,
                  bgcolor: `rgba(${notice.tone}, 0.08)`,
                }}
              >
                <Typography sx={{ fontSize: 11, flex: 1, color: `rgb(${notice.tone})` }}>
                  {notice.text}
                </Typography>
                {notice.confirm && (
                  <Button
                    size="small"
                    data-testid="document-hero-connect-confirm"
                    disabled={gateway.confirming}
                    onClick={() => { void confirmPendingActivation(); }}
                    sx={{ fontSize: 11, minWidth: 0, px: 1, py: 0, color: `rgb(${notice.tone})` }}
                  >
                    {notice.confirm}
                  </Button>
                )}
                <Button
                  size="small"
                  data-testid="document-hero-connect-dismiss"
                  onClick={clearActiveDocumentState}
                  sx={{ fontSize: 11, minWidth: 0, px: 1, py: 0, color: 'text.disabled' }}
                >
                  Dismiss
                </Button>
              </Box>
            )}
          </Box>
        )
        : (
          <Typography data-testid="document-hero-empty" sx={{ fontSize: 12, color: 'text.disabled' }}>
            Nothing open — double-click an asset to start.
          </Typography>
        )}
      </Box>
      {dashboard.opening !== null && <OpeningHero label={dashboard.opening} />}
    </Box>
  );
}
