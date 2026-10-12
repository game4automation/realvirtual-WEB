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
import {
  Box,
  Button,
  Dialog,
  DialogContent,
  DialogTitle,
  LinearProgress,
  List,
  ListItemButton,
  ListItemText,
  Typography,
} from '@mui/material';
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
  getPluginBindingState,
  subscribePluginBindingState,
} from '../../rv-plugin-binding-state';
import { scanPluginExports } from '../../rv-model-plugin-manager';
import {
  isConnectConfigPath,
  isKnowledgeFilePath,
  isProjectScriptPath,
  PROJECT_SCRIPT_FOLDER,
  readDocumentRef,
  type DocumentRefField,
  stripConnectConfigSuffix,
  stripKnowledgeFileSuffix,
} from '../../project/rv-project-refs';
import {
  getProjectsDashboardSnapshot,
  setProjectsSelection,
  subscribeProjectsDashboard,
} from './projects-dashboard-store';
import {
  CONNECT_CONFIG_DRAG_TYPE,
  KNOWLEDGE_FILE_DRAG_TYPE,
  SCRIPT_FILE_DRAG_TYPE,
} from './connect-config-dnd';
import {
  DocumentCard,
  type DocumentCardBindAction,
  type DocumentCardRefSlot,
} from '../scene/DocumentCard';

/**
 * The three fields as the keyboard route names them (plan-479 F7, Phase 5).
 *
 * One table rather than three call sites: the menu label, the picker's title
 * and the word for "nothing bound" all have to agree per field, and the
 * candidate list is looked up by the same key. A fourth reference field is a
 * row here plus a listing — which is the whole point of `DocumentRefField`
 * having replaced the hand-counted union in Phase 0.
 */
const BIND_FIELDS: ReadonlyArray<{
  field: DocumentRefField;
  /** Menu entry — the verb, because a menu is a list of things one can do. */
  menuLabel: string;
  /** Picker heading — the noun, because a dialog names what it is showing. */
  title: string;
  /** How a candidate is shown; the classifying ending is noise in a list. */
  display: (path: string) => string;
}> = [
  {
    field: 'connectRef',
    menuLabel: 'Bind CONNECT configuration…',
    title: 'Bind a CONNECT configuration',
    display: stripConnectConfigSuffix,
  },
  {
    field: 'scriptRef',
    menuLabel: 'Bind plugin…',
    title: 'Bind a project plugin',
    display: ref => ref.replace(new RegExp(`^${PROJECT_SCRIPT_FOLDER}/`, 'i'), ''),
  },
  {
    field: 'knowledgeRef',
    menuLabel: 'Bind knowledge file…',
    title: 'Bind a knowledge file',
    display: stripKnowledgeFileSuffix,
  },
];

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
  /**
   * Narrow, single-column layout (plan-458 F9).
   *
   * The hero band becomes a 44px row: the open document still has to be the
   * first thing on the screen, but on 844px of height it may not spend a
   * quarter of it on a preview. The drop zone goes with it — there is no drag
   * on a phone, so an outline promising one would be a lie.
   *
   * Passed in rather than measured here: the host already asks the width once,
   * and a second media query in a child is a second answer that can disagree.
   */
  compactLayout?: boolean;
}

export function DocumentHeroSection({ onReveal, compactLayout = false }: DocumentHeroSectionProps) {
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
      scriptRef: readDocumentRef(doc, 'scriptRef'),
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
  const [scripts, setScripts] = useState<string[]>([]);
  useEffect(() => {
    const backend = store.getBackend();
    if (!dashboard.open || !backend) {
      setConfigs([]); setKnowledgeFiles([]); setScripts([]);
      return;
    }
    let alive = true;
    void (backend.listConnectConfigs?.() ?? Promise.resolve([]))
      .then(paths => { if (alive) setConfigs(paths); })
      .catch(() => { if (alive) setConfigs([]); });
    void (backend.listKnowledgeFiles?.() ?? Promise.resolve([]))
      .then(paths => { if (alive) setKnowledgeFiles(paths); })
      .catch(() => { if (alive) setKnowledgeFiles([]); });
    void (backend.listProjectScripts?.() ?? Promise.resolve([]))
      .then(paths => { if (alive) setScripts(paths); })
      .catch(() => { if (alive) setScripts([]); });
    return () => { alive = false; };
  }, [dashboard.open, store, project.project?.id, project.documents]);

  const writable = project.writable && binding !== null && !binding.bundled;

  /** The one write per field. In-memory first, so the chip flips at once. */
  const assign = useCallback((field: DocumentRefField, ref: string | null) => {
    if (!binding) return;
    const write = field === 'connectRef'
      ? store.setDocumentConnectRef(binding.documentId, ref)
      : field === 'scriptRef'
        ? store.setDocumentScriptRef(binding.documentId, ref)
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
    field: DocumentRefField,
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
  // No strip for the plugin: `.ts` is part of the file's own name, not a
  // classifying ending the user never chose. `plugins/` is dropped though —
  // every candidate is under it, so repeating it says nothing.
  const pluginBase = slotFor(
    'scriptRef',
    binding?.scriptRef ?? null,
    scripts,
    ref => ref.replace(new RegExp(`^${PROJECT_SCRIPT_FOLDER}/`, 'i'), ''),
  );

  /**
   * What the last load had to say about this binding (plan-479 F6) — the one
   * thing the CONNECT and knowledge slots have no equivalent of.
   *
   * Published by the plugin manager in `core/`, consumed here through a hook:
   * `core` states, `hmi` renders, and no cycle is created.
   */
  const runtime = useSyncExternalStore(subscribePluginBindingState, getPluginBindingState);

  /**
   * The source-scan verdict (F4) — "this file exports no plugin pair", found by
   * reading the text, never by importing it.
   *
   * Only asked for a binding whose file IS in the project: a missing file has
   * nothing to scan, and a scan of an absent file would answer "no exports" and
   * bury the more useful "it is not there".
   */
  const scriptRef = binding?.scriptRef ?? null;
  const scriptPresent = scriptRef !== null && scripts.includes(scriptRef);
  const [noExports, setNoExports] = useState(false);
  useEffect(() => {
    if (scriptRef === null || !scriptPresent) { setNoExports(false); return; }
    let alive = true;
    void scanPluginExports(scriptRef, project.project?.canonicalName ?? null)
      // `unreadable` is NOT a verdict: a project whose code is not in this
      // build resolves at runtime, and warning about it would be a lie.
      .then(scan => { if (alive) setNoExports(!scan.unreadable && !scan.isPluginModule); })
      .catch(() => { if (alive) setNoExports(false); });
    return () => { alive = false; };
  }, [scriptRef, scriptPresent, project.project?.canonicalName]);

  /**
   * The chip, with the runtime verdict folded in.
   *
   * The runtime answer outranks the source scan — it is the same question
   * answered by actually running the thing (R5) — and both are ignored when
   * they speak about a DIFFERENT reference than the one now bound, which is the
   * state between a re-binding and the next model load.
   */
  const plugin = useMemo((): DocumentCardRefSlot | null => {
    if (!pluginBase || pluginBase.kind !== 'bound' || scriptRef === null) return pluginBase;
    const current = runtime.kind !== 'none' && runtime.scriptRef === scriptRef ? runtime : null;
    if (current?.kind === 'failed') {
      return current.reason === 'no-exports'
        ? { ...pluginBase, status: 'no-exports', statusDetail: current.detail }
        : { ...pluginBase, status: 'failed', statusDetail: current.detail };
    }
    if (current?.kind === 'loaded') {
      return {
        ...pluginBase,
        status: 'loaded',
        statusDetail: current.from === 'runtime'
          ? 'Loaded from the project at run time'
          : 'Loaded from this build',
      };
    }
    if (noExports) {
      return {
        ...pluginBase,
        status: 'no-exports',
        statusDetail: 'This file exports no registerModelPlugins/unregisterModelPlugins '
          + 'pair — binding it loads nothing.',
      };
    }
    return pluginBase;
  }, [pluginBase, runtime, scriptRef, noExports]);

  /**
   * The hero as a drop target (Unity-style reference assignment): a config or
   * knowledge card dragged from the grid binds on drop. Gated on the payload
   * TYPE, so the tree's move drag and random text drops sail past untouched.
   */
  const [dragOver, setDragOver] = useState<'connect' | 'knowledge' | 'plugin' | null>(null);
  /**
   * Why the last drop did nothing (plan-479 F8).
   *
   * There is no application-wide snackbar this could dock onto — the only
   * message surface in this section is the gateway `noticeBox` below, which is
   * fed by `connect-store` and speaks for CONNECT. So the hero states the
   * refusal ITSELF, in the same box, rather than inventing a second global
   * channel for one sentence. A refusal the user cannot see is the bug being
   * fixed here; where the sentence is rendered is the smaller question.
   */
  const [rejection, setRejection] = useState<string | null>(null);
  const dragKindOf = (e: React.DragEvent): 'connect' | 'knowledge' | 'plugin' | null =>
    e.dataTransfer.types.includes(CONNECT_CONFIG_DRAG_TYPE) ? 'connect'
      : e.dataTransfer.types.includes(KNOWLEDGE_FILE_DRAG_TYPE) ? 'knowledge'
        : e.dataTransfer.types.includes(SCRIPT_FILE_DRAG_TYPE) ? 'plugin'
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
    setRejection(null);
    const configRef = e.dataTransfer.getData(CONNECT_CONFIG_DRAG_TYPE);
    if (isConnectConfigPath(configRef)) { assign('connectRef', configRef); return; }
    const knowledgeRef = e.dataTransfer.getData(KNOWLEDGE_FILE_DRAG_TYPE);
    if (isKnowledgeFilePath(knowledgeRef)) { assign('knowledgeRef', knowledgeRef); return; }
    const scriptRef = e.dataTransfer.getData(SCRIPT_FILE_DRAG_TYPE);
    if (scriptRef === '') return;
    if (isProjectScriptPath(scriptRef)) { assign('scriptRef', scriptRef); return; }
    // F8: the drag carried a script payload the rule refuses. Saying WHY is the
    // point — a drop that silently does nothing is indistinguishable from a
    // broken screen, and that ambiguity is what sends people back to the JSON.
    setRejection(
      `"${scriptRef}" cannot be bound as a plugin — only .ts and .tsx files `
      + `under ${PROJECT_SCRIPT_FOLDER}/ are loaded for a document.`,
    );
  };
  // The ring announces WHICH slot the drop will fill — the slot's own color.
  const ringRgb = dragOver === 'knowledge' ? '233, 64, 120'
    : dragOver === 'plugin' ? '79, 195, 247'
      : '102, 187, 106';

  /**
   * The keyboard route (plan-479 F7): which field's picker is open, if any.
   *
   * A menu entry per field opens this; the picker writes through the very same
   * `assign` the drop uses. There is deliberately no second store call here —
   * two write paths is how a read-only project or a containment rule ends up
   * being enforced on one route and not the other.
   */
  const [picking, setPicking] = useState<DocumentRefField | null>(null);

  /**
   * The candidates per field.
   *
   * The script list is filtered by `isProjectScriptPath` even though the
   * backend already walks `plugins/` — the picker is the F8 counterpart on the
   * keyboard route, and the honest way to refuse a file the rule would reject
   * is to never offer it. A refusal one cannot trigger needs no sentence.
   */
  const candidates = useMemo((): Record<DocumentRefField, readonly string[]> => ({
    connectRef: configs,
    scriptRef: scripts.filter(isProjectScriptPath),
    knowledgeRef: knowledgeFiles,
  }), [configs, scripts, knowledgeFiles]);

  const bindActions = useMemo((): DocumentCardBindAction[] => (
    writable
      ? BIND_FIELDS.map(({ field, menuLabel }) => ({
        id: field,
        label: menuLabel,
        onSelect: () => { setRejection(null); setPicking(field); },
      }))
      : []
  ), [writable]);

  const pickingSpec = picking === null
    ? null
    : BIND_FIELDS.find(f => f.field === picking) ?? null;
  const pickerBound = picking === null || !binding
    ? null
    : picking === 'connectRef' ? binding.ref
      : picking === 'scriptRef' ? binding.scriptRef
        : binding.knowledgeRef;

  /**
   * The candidate picker — the whole of F7's second half.
   *
   * A plain list of buttons in a dialog, because that is what is operable
   * without a pointer: MUI moves focus into the dialog on open, Tab and the
   * arrow keys walk the buttons, Enter activates one and Escape leaves without
   * writing. Nothing here is reachable by mouse only.
   */
  const picker = pickingSpec && (
    <Dialog
      open
      onClose={() => setPicking(null)}
      maxWidth="xs"
      fullWidth
      data-testid="document-hero-bind-dialog"
    >
      <DialogTitle sx={{ fontSize: 14, fontWeight: 600 }}>{pickingSpec.title}</DialogTitle>
      <DialogContent sx={{ px: 1, pb: 1 }}>
        <List dense disablePadding>
          {/* Clearing is a binding decision too, and the × on the chip is a
              mouse target — without this row the keyboard could bind but
              never unbind. */}
          <ListItemButton
            autoFocus
            data-testid="document-hero-bind-none"
            onClick={() => {
              // Enabled even when nothing is bound — it is the first stop of
              // the focus trap, and a disabled first stop would send the
              // keyboard somewhere different depending on the state it found.
              // It simply writes nothing in that case.
              if (pickerBound !== null) assign(pickingSpec.field, null);
              setPicking(null);
            }}
          >
            <ListItemText
              primary="None"
              secondary={pickerBound === null ? 'Nothing is bound' : 'Clear this binding'}
              primaryTypographyProps={{ fontSize: 13 }}
              secondaryTypographyProps={{ fontSize: 10 }}
            />
          </ListItemButton>
          {candidates[pickingSpec.field].map((path) => (
            <ListItemButton
              key={path}
              data-testid={`document-hero-bind-option-${path}`}
              selected={path === pickerBound}
              onClick={() => { assign(pickingSpec.field, path); setPicking(null); }}
            >
              <ListItemText
                primary={pickingSpec.display(path)}
                secondary={path}
                primaryTypographyProps={{ fontSize: 13 }}
                secondaryTypographyProps={{ fontSize: 10 }}
              />
            </ListItemButton>
          ))}
          {candidates[pickingSpec.field].length === 0 && (
            <Typography
              data-testid="document-hero-bind-empty"
              sx={{ fontSize: 11, color: 'text.disabled', px: 2, py: 1 }}
            >
              {/* Saying WHERE the candidates would come from is the difference
                  between an empty list and a broken screen. */}
              {pickingSpec.field === 'scriptRef'
                ? `This project has no .ts or .tsx file under ${PROJECT_SCRIPT_FOLDER}/ to bind.`
                : 'This project has no file of that kind to bind.'}
            </Typography>
          )}
        </List>
      </DialogContent>
    </Dialog>
  );


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
  const notice = rejection
    // The user's own last gesture outranks a standing gateway remark: the
    // refusal is an answer to what they just did, one tick ago.
    ? { tone: '255, 167, 38', text: rejection }
    : gateway.pending
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

  /**
   * The gateway's answer to the last binding change — one node, rendered
   * under the card in BOTH layouts. A notice the compact band dropped
   * would be a refusal the user never sees.
   */
  const noticeBox = notice && (
    <Box
      data-testid="document-hero-connect-notice"
      sx={{
        mt: 0.75,
        px: 1,
        py: 0.5,
        display: 'flex',
        alignItems: 'center',
        flexWrap: 'wrap',
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
        onClick={() => { setRejection(null); clearActiveDocumentState(); }}
        sx={{ fontSize: 11, minWidth: 0, px: 1, py: 0, color: 'text.disabled' }}
      >
        Dismiss
      </Button>
    </Box>
  );

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
        py: compactLayout ? 0.5 : 1.25,
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
        ? compactLayout ? (
          // One row, no drop zone and no outline: the whole band is the card.
          <Box
            data-testid="document-card-compact"
            sx={{ width: '100%', display: 'flex', flexDirection: 'column' }}
          >
            <Box sx={{ minHeight: 44, display: 'flex', alignItems: 'center', width: '100%' }}>
              <DocumentCard
                variant="compact"
                onReveal={onReveal}
                previewVisible={dashboard.open}
                connect={connect}
                plugin={plugin}
                knowledge={knowledge}
                bindActions={bindActions}
              />
            </Box>
            {noticeBox}
          </Box>
        ) : (
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
              plugin={plugin}
              knowledge={knowledge}
              bindActions={bindActions}
            />
            {noticeBox}
          </Box>
        )
        : (
          <Typography data-testid="document-hero-empty" sx={{ fontSize: 12, color: 'text.disabled' }}>
            {/* The instruction has to name the gesture the device HAS: there is
                no double-click on a phone, and the sheet's Open is the route. */}
            {compactLayout
              ? 'Nothing open — tap a document, then Open.'
              : 'Nothing open — double-click an asset to start.'}
          </Typography>
        )}
      </Box>
      {dashboard.opening !== null && <OpeningHero label={dashboard.opening} />}
      {picker}
    </Box>
  );
}
