// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CustomRuntimeInstructionPlugin — instruction panel for the InstructionRuntimeStore.
 *
 * Registers a 'messages'-slot panel that lists every active CustomRuntimeInstruction
 * as a card (one per entry). Each card shows a type-colored header (title + icon),
 * an optional close button (when `dismissible`), and the ordered step list. Per
 * step: the instruction text plus optional buttons — a doc button that opens the
 * embedded PDF/URL viewer, and a View button that focuses + highlights the step's
 * target object in 3D.
 *
 * Mirrors WebErrorPlugin's structure (slot, useSyncExternalStore, onModelCleared
 * store cleanup). Ordered BEFORE WebError (order 4 vs 5).
 */

import { useSyncExternalStore, useEffect, useState, useMemo } from 'react';
import type { Object3D } from 'three';
import { Box, Paper, Typography, IconButton, Tooltip } from '@mui/material';
import { Info, Build, Warning, Error as ErrorIcon, CheckCircle, Close, Description, Visibility, NavigateBefore, NavigateNext, UnfoldMore, UnfoldLess } from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { ViewerEvents } from '../core/rv-viewer-events';
import type { InstructionEntry } from '../core/engine/rv-instruction-runtime-store';
import type { RVCustomRuntimeInstruction } from '../core/engine/rv-custom-runtime-instruction';
import { openPdfViewer } from '../core/hmi/pdf-viewer-store';
import { SEVERITY_COLORS } from '../core/hmi/severity-pulse';
import { collectNodeAiContext } from '../core/hmi/search-ai-context';
import { AskAiButton } from '../core/hmi/AskAiButton';
import { useSearchDiagnosisAvailable } from './diagnose/search-diagnose-registry';

// ─── Engine bridge helpers ──────────────────────────────────────────────────

/** Resolve the RVCustomRuntimeInstruction engine instance for a node path. */
function getInstance(viewer: RVViewer, path: string): RVCustomRuntimeInstruction | undefined {
  const node = viewer.registry?.getNode(path);
  if (!node) return undefined;
  return (node.userData as Record<string, unknown>)._rvComponentInstance as RVCustomRuntimeInstruction | undefined;
}

/** Format the activation wall-clock time as "HH:MM:SS · DD.MM.YYYY" (locale-aware). */
function formatStamp(ms: number): string {
  const d = new Date(ms);
  const time = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  const date = d.toLocaleDateString();
  return `${time} · ${date}`;
}

// ─── Per-type visuals (color + title + icon) ────────────────────────────────

type InstructionType = InstructionEntry['type'];

const TYPE_VISUALS: Record<InstructionType, { color: string; title: string; icon: React.ReactElement }> = {
  info: { color: SEVERITY_COLORS.info, title: 'Info', icon: <Info fontSize="small" /> },
  maintenance: { color: SEVERITY_COLORS.maintenance, title: 'Maintenance', icon: <Build fontSize="small" /> },
  warning: { color: SEVERITY_COLORS.warning, title: 'Warning', icon: <Warning fontSize="small" /> },
  error: { color: SEVERITY_COLORS.error, title: 'Error', icon: <ErrorIcon fontSize="small" /> },
  success: { color: SEVERITY_COLORS.success, title: 'Success', icon: <CheckCircle fontSize="small" /> },
};

// ─── Reactive subscription to the InstructionRuntimeStore ───────────────────

function useActiveInstructions(viewer: RVViewer): InstructionEntry[] {
  const store = viewer.instructionStore;
  return useSyncExternalStore(store.subscribe, store.getActive);
}

// ─── Card ───────────────────────────────────────────────────────────────────

function InstructionCard({
  entry,
  viewer,
  aiAvailable,
}: {
  entry: InstructionEntry;
  viewer: RVViewer;
  aiAvailable: boolean;
}) {
  const visuals = TYPE_VISUALS[entry.type] ?? TYPE_VISUALS.info;

  const stepCount = entry.steps.length;
  // One step visible at a time; the user pages through with the nav buttons.
  const [stepIndex, setStepIndex] = useState(0);
  const clamped = Math.min(stepIndex, Math.max(0, stepCount - 1));
  const step = entry.steps[clamped];
  const isLast = clamped >= stepCount - 1;
  const isFirst = clamped <= 0;
  const targetPaths = step?.targetPaths ?? [];

  // Highlight the current step's targets in parallel (type color) whenever the
  // shown step changes. Cleared on unmount (dismiss / falling edge / model switch).
  useEffect(() => {
    const inst = getInstance(viewer, entry.path);
    inst?.highlightStep(clamped);
    return () => { inst?.clearStepHighlight(); };
  }, [viewer, entry.path, clamped]);

  // Exit any isolate this card started when it unmounts (dismiss / falling edge).
  useEffect(() => {
    if (!entry.isolate) return;
    return () => { if (viewer.isSelectionIsolateActive) viewer.exitIsolate(); };
  }, [viewer, entry.isolate]);

  // Clicking the message reveals the targets: fly the camera to them and
  // (optionally) isolate the rest of the scene for a clearer view. The targets
  // already carry the persistent step highlight (type-colored fill + edges,
  // via highlightStep above) — no extra alarm pulse is layered on top.
  const reveal = (paths: string[]) => {
    if (paths.length === 0) return;
    const nodes = paths
      .map((p) => viewer.registry?.getNode(p))
      .filter((n): n is Object3D => !!n);
    if (nodes.length === 0) return;
    // isolateNodes frames the nodes itself — avoid a double camera animation.
    if (entry.isolate) viewer.isolateNodes(nodes);
    else viewer.fitToNodes(nodes);
  };

  const onView = () => reveal(targetPaths);

  const goTo = (next: number) => {
    setStepIndex(next);
    reveal(getInstance(viewer, entry.path)?.stepTargetPaths(next) ?? []);
  };

  const onUrl = (url: string) => {
    // Open the embedded document viewer (NOT a new browser tab).
    openPdfViewer(step?.instruction || visuals.title, { type: 'url', url });
  };

  const askAi = () => {
    if (!step) return;
    const nodePath = entry.path.trim() || undefined;
    const context = nodePath ? collectNodeAiContext(viewer, nodePath) : null;
    const request = {
      ...(nodePath ? { nodePath } : {}),
      label: step.instruction,
      source: 'runtime-instruction',
      ...(context?.docHints?.length ? { docHints: context.docHints } : {}),
      ...(context?.machineContext ? { machineContext: context.machineContext } : {}),
    };
    // InstructionEntry.path is required today. Keep the payload pathless for a
    // defensive/legacy entry without an owning node, as required by F14.
    viewer.emit('diagnose-request', request as ViewerEvents['diagnose-request']);
  };

  return (
    <Paper
      elevation={4}
      data-ui-panel
      sx={{ borderLeft: `3px solid ${visuals.color}`, pointerEvents: 'auto', overflow: 'hidden' }}
    >
      {/* Header */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1 }}>
        <Box sx={{ color: visuals.color, display: 'flex' }}>{visuals.icon}</Box>
        <Typography variant="body2" sx={{ fontWeight: 600, flex: 1, minWidth: 0 }}>
          {visuals.title}
        </Typography>
        {stepCount > 1 && (
          <Typography variant="caption" sx={{ opacity: 0.6, flexShrink: 0 }}>
            {clamped + 1} / {stepCount}
          </Typography>
        )}
        {/* Dismiss is only offered on the LAST step (and only when dismissible). */}
        {entry.dismissible && isLast && (
          <Tooltip title="Dismiss">
            <IconButton
              size="small"
              sx={{ p: 0.25 }}
              onClick={(e) => { e.stopPropagation(); viewer.instructionStore.dismiss(entry.path); }}
            >
              <Close sx={{ fontSize: 16 }} />
            </IconButton>
          </Tooltip>
        )}
      </Box>

      {/* Activation time & date */}
      <Box sx={{ px: 1.5, pb: 0.5, mt: -0.75 }}>
        <Typography sx={{ fontSize: 10, color: 'text.disabled', letterSpacing: 0.2 }}>
          {formatStamp(entry.at)}
        </Typography>
      </Box>

      {/* Current step — clicking the row focuses the camera on its targets */}
      {step && (
        <Box
          onClick={targetPaths.length > 0 ? onView : undefined}
          sx={{
            display: 'flex',
            alignItems: 'flex-start',
            gap: 0.5,
            px: 1.5,
            py: 0.75,
            borderTop: '1px solid rgba(255,255,255,0.06)',
            cursor: targetPaths.length > 0 ? 'pointer' : 'default',
            '&:hover': targetPaths.length > 0 ? { backgroundColor: 'rgba(255,255,255,0.06)' } : undefined,
          }}
        >
          <Typography variant="caption" sx={{ flex: 1, minWidth: 0, lineHeight: 1.4, whiteSpace: 'pre-wrap' }}>
            {step.instruction}
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.25, flexShrink: 0 }}>
            {aiAvailable && <AskAiButton onClick={askAi} />}
            {step.url && (
              <Tooltip title="Open document">
                <IconButton size="small" sx={{ p: 0.25 }} onClick={(e) => { e.stopPropagation(); onUrl(step.url!); }}>
                  <Description sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
            )}
            {targetPaths.length > 0 && (
              <Tooltip title="View in 3D">
                <IconButton size="small" sx={{ p: 0.25 }} onClick={(e) => { e.stopPropagation(); onView(); }}>
                  <Visibility sx={{ fontSize: 15 }} />
                </IconButton>
              </Tooltip>
            )}
          </Box>
        </Box>
      )}

      {/* Step navigation — only for multi-step instructions */}
      {stepCount > 1 && (
        <Box
          sx={{
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            px: 1,
            py: 0.5,
            borderTop: '1px solid rgba(255,255,255,0.06)',
          }}
        >
          <Tooltip title="Previous step">
            <span>
              <IconButton size="small" disabled={isFirst} onClick={(e) => { e.stopPropagation(); goTo(clamped - 1); }}>
                <NavigateBefore sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
          <Tooltip title="Next step">
            <span>
              <IconButton size="small" disabled={isLast} onClick={(e) => { e.stopPropagation(); goTo(clamped + 1); }}>
                <NavigateNext sx={{ fontSize: 18 }} />
              </IconButton>
            </span>
          </Tooltip>
        </Box>
      )}
    </Paper>
  );
}

// ─── Panel ──────────────────────────────────────────────────────────────────

/** Severity order — most critical (and, within a type, newest) sits on top of the deck. */
const SEVERITY_RANK: Record<InstructionEntry['type'], number> = {
  error: 0, warning: 1, maintenance: 2, info: 3, success: 4,
};

/** Above this many active messages, collapse into a card deck instead of a
 *  full column that would overflow the viewport. */
const DECK_THRESHOLD = 3;

/** Bounded, scrollable column so a large stack never covers the whole screen. */
const scrollSx = {
  maxHeight: 'calc(100vh - 150px)',
  overflowY: 'auto',
  pr: 0.5,
  '&::-webkit-scrollbar': { width: 6 },
  '&::-webkit-scrollbar-thumb': { backgroundColor: 'rgba(255,255,255,0.2)', borderRadius: 3 },
} as const;

export function InstructionPanel({ viewer }: UISlotProps) {
  const instructions = useActiveInstructions(viewer);
  const aiAvailable = useSearchDiagnosisAvailable();
  const [expanded, setExpanded] = useState(false);

  // Most severe first, newest first within a severity.
  const sorted = useMemo(
    () => [...instructions].sort(
      (a, b) => (SEVERITY_RANK[a.type] - SEVERITY_RANK[b.type]) || (b.at - a.at),
    ),
    [instructions],
  );

  if (sorted.length === 0) return null;

  const renderCards = (list: InstructionEntry[]) => list.map((entry) => (
    // Include `since` so a fresh activation (new rising edge) remounts the
    // card and resets step navigation to the first step.
    <InstructionCard
      key={`${entry.path}:${entry.since}`}
      entry={entry}
      viewer={viewer}
      aiAvailable={aiAvailable}
    />
  ));

  // Expanded, or few enough not to need a deck → plain scrollable column.
  if (expanded || sorted.length <= DECK_THRESHOLD) {
    return (
      <Box data-ui-panel sx={{ display: 'flex', flexDirection: 'column', gap: 1, pointerEvents: 'auto', ...scrollSx }}>
        {sorted.length > DECK_THRESHOLD && (
          <Box
            onClick={() => setExpanded(false)}
            sx={{
              display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5,
              py: 0.4, borderRadius: 1, cursor: 'pointer', bgcolor: 'rgba(0,0,0,0.35)',
              color: 'text.secondary', '&:hover': { bgcolor: 'rgba(0,0,0,0.5)', color: 'text.primary' },
            }}
          >
            <UnfoldLess sx={{ fontSize: 16 }} />
            <Typography sx={{ fontSize: 11, fontWeight: 600 }}>{sorted.length} messages — stack</Typography>
          </Box>
        )}
        {renderCards(sorted)}
      </Box>
    );
  }

  // Collapsed deck: top (most critical) card fully shown, the rest peeking
  // behind it like a card deck, with a count + expand affordance.
  const top = sorted[0];
  const hidden = sorted.length - 1;
  const peekColor = (TYPE_VISUALS[top.type] ?? TYPE_VISUALS.info).color;

  return (
    <Box data-ui-panel sx={{ pointerEvents: 'auto' }}>
      {/* Deck: top card with two peeking card edges anchored to ITS bottom. */}
      <Box sx={{ position: 'relative', pb: 1.25 }}>
        <Box sx={{ position: 'absolute', left: 8, right: 8, bottom: 0, height: 16, bgcolor: 'background.paper', border: '1px solid rgba(255,255,255,0.08)', borderLeft: `3px solid ${peekColor}`, borderRadius: 1, opacity: 0.5, zIndex: 0 }} />
        <Box sx={{ position: 'absolute', left: 4, right: 4, bottom: 4, height: 16, bgcolor: 'background.paper', border: '1px solid rgba(255,255,255,0.10)', borderLeft: `3px solid ${peekColor}`, borderRadius: 1, opacity: 0.8, zIndex: 1 }} />
        <Box sx={{ position: 'relative', zIndex: 2 }}>
          <InstructionCard entry={top} viewer={viewer} aiAvailable={aiAvailable} />
        </Box>
      </Box>

      {/* Expand affordance — below the deck, not part of the stack. */}
      <Box
        onClick={() => setExpanded(true)}
        sx={{
          mt: 0.5,
          display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 0.5,
          py: 0.4, borderRadius: 1, cursor: 'pointer', bgcolor: 'rgba(0,0,0,0.4)',
          color: 'text.secondary', '&:hover': { bgcolor: 'rgba(0,0,0,0.6)', color: 'text.primary' },
        }}
      >
        <UnfoldMore sx={{ fontSize: 16 }} />
        <Typography sx={{ fontSize: 11, fontWeight: 600 }}>+{hidden} more — show all</Typography>
      </Box>
    </Box>
  );
}

// ─── Plugin ─────────────────────────────────────────────────────────────────

export class CustomRuntimeInstructionPlugin implements RVViewerPlugin {
  readonly id = 'custom-runtime-instruction';
  readonly slots: UISlotEntry[] = [
    { slot: 'messages', component: InstructionPanel, order: 4 },
  ];

  /** Clear the instruction registry on model switch — clearModel() runs no
   *  per-component dispose sweep, so this hook is the reliable store cleanup. */
  onModelCleared(viewer: RVViewer): void {
    viewer.instructionStore.clear();
  }
}
