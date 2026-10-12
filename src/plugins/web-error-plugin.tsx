// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * WebErrorPlugin — right-side error panel for the central ErrorStore.
 *
 * Registers a 'messages'-slot panel that lists every currently active error
 * (one TileCard per error, ISA-101 red). Clicking a card focuses + highlights
 * the faulting part in 3D. Every alarm has a separate visible row; the list
 * scrolls when there are too many cards to fit in the viewport.
 *
 * Store lifecycle: the plugin clears the ErrorStore on model switch via
 * onModelCleared (clearModel() does NOT run a per-component dispose sweep).
 */

import { useSyncExternalStore } from 'react';
import { Box } from '@mui/material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { ErrorEntry } from '../core/engine/rv-error-store';
import { TileCard } from '../core/hmi/TileCard';
import { pulseSeverityOutline } from '../core/hmi/severity-pulse';
import { collectNodeAiContext } from '../core/hmi/search-ai-context';
import { AskAiButton } from '../core/hmi/AskAiButton';
import { useSearchDiagnosisAvailable } from './diagnose/search-diagnose-registry';

// ─── Constants (inline, glanceable) ─────────────────────────────────────

/** Format a performance.now() timestamp to a wall-clock HH:MM:SS string. */
function formatSince(since: number): string {
  // `since` is a performance timestamp (ms since navigation start); convert to a
  // wall-clock time by anchoring against the current performance/Date offset.
  const epochMs = since + (Date.now() - performance.now());
  const d = new Date(epochMs);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// ─── Reactive subscription to the ErrorStore ────────────────────────────

function useActiveErrors(viewer: RVViewer): ErrorEntry[] {
  const store = viewer.errorStore;
  return useSyncExternalStore(
    (cb) => store.subscribe(cb),
    () => store.getActive(),
  );
}

function AskAiAction({ viewer, error }: { viewer: RVViewer; error: ErrorEntry }) {
  const handleClick = () => {
    const context = collectNodeAiContext(viewer, error.path);
    viewer.emit('diagnose-request', {
      nodePath: error.path,
      label: error.text || 'Error',
      source: 'web-error',
      ...(context?.docHints?.length ? { docHints: context.docHints } : {}),
      ...(context?.machineContext ? { machineContext: context.machineContext } : {}),
    });
  };

  return (
    <AskAiButton onClick={handleClick} />
  );
}

// ─── Panel ──────────────────────────────────────────────────────────────

export function WebErrorPanel({ viewer }: UISlotProps) {
  const errors = useActiveErrors(viewer);
  const aiAvailable = useSearchDiagnosisAvailable();

  if (errors.length === 0) return null;

  // Frame the faulting part and pulse its outline in the severity color
  // (same alarm effect as the Toray showcase, generalized in severity-pulse).
  const focusError = (path: string) => {
    pulseSeverityOutline(viewer, path, 'error');
  };

  return (
    <Box
      data-ui-panel
      role="region"
      aria-label="Active alarms"
      sx={{
        display: 'flex', flexDirection: 'column', gap: 1,
        width: '100%', maxHeight: 'min(480px, 60vh)', overflowY: 'auto',
        pointerEvents: 'auto',
        '& > .MuiPaper-root': { flexShrink: 0 },
      }}
    >
      {errors.map((e) => (
        <TileCard
          key={e.path}
          title={e.text || 'Error'}
          subtitle={e.path.split('/').pop() ?? e.path}
          severity="error"
          icon="warning"
          timestamp={formatSince(e.since)}
          componentPath={e.path}
          onAction={() => focusError(e.path)}
          actions={aiAvailable ? <AskAiAction viewer={viewer} error={e} /> : undefined}
        />
      ))}
    </Box>
  );
}

// ─── Plugin ─────────────────────────────────────────────────────────────

export class WebErrorPlugin implements RVViewerPlugin {
  readonly id = 'web-error';
  readonly slots: UISlotEntry[] = [
    { slot: 'messages', component: WebErrorPanel, order: 5 },
  ];

  /** Clear the error registry on model switch — clearModel() runs no per-component
   *  dispose sweep, so this hook is the reliable store cleanup (plan §2.7). */
  onModelCleared(viewer: RVViewer): void {
    viewer.errorStore.clear();
  }
}
