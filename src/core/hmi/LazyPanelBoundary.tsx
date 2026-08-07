// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * LazyPanelBoundary — the wrapper every code-split HMI panel is rendered in
 * (plan-344 Phase 4).
 *
 * Two jobs, and both are required for lazy panels to be safe in an operator HMI:
 *
 *  1. **Suspense fallback.** A deliberately quiet one: a lazily loaded panel that
 *     flashes a spinner every time it opens reads as slowness. The panel is a
 *     glass surface over a live 3D scene, so the honest fallback is an empty box
 *     of the same footprint — the panel simply appears a moment later.
 *
 *  2. **Chunk-load error containment.** A dynamic `import()` can reject: an
 *     offline machine, a stale `index.html` pointing at a purged hash, a
 *     corrupted CDN edge. Without a boundary that rejection propagates to the
 *     React root and takes the WHOLE overlay down — a white screen over a running
 *     machine. So a failed chunk degrades to an inline notice and everything else
 *     in the HMI stays operable.
 *
 * Deliberately NOT a general-purpose error boundary: it catches render errors of
 * the lazy subtree only and never swallows anything silently (it logs).
 */

import { Component, Suspense, type ErrorInfo, type ReactNode } from 'react';
import { Box, Typography } from '@mui/material';
import { WarningAmber } from '@mui/icons-material';

/** System Warning Amber (DESIGN.md) — a failed chunk is a warning, not a machine fault. */
const WARNING_AMBER = '#ffa726';

interface ChunkErrorBoundaryProps {
  /** Panel name for the operator-facing notice and the console log. */
  label: string;
  children: ReactNode;
}

interface ChunkErrorBoundaryState {
  failed: boolean;
}

class ChunkErrorBoundary extends Component<ChunkErrorBoundaryProps, ChunkErrorBoundaryState> {
  state: ChunkErrorBoundaryState = { failed: false };

  static getDerivedStateFromError(): ChunkErrorBoundaryState {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error(`[LazyPanelBoundary] '${this.props.label}' failed to load:`, error, info.componentStack);
  }

  render(): ReactNode {
    if (!this.state.failed) return this.props.children;
    return (
      <Box
        data-testid="lazy-panel-error"
        sx={{ display: 'flex', alignItems: 'center', gap: 0.75, px: 1.5, py: 1 }}
      >
        <WarningAmber role="img" aria-label="Warning" sx={{ fontSize: 16, color: WARNING_AMBER, flexShrink: 0 }} />
        <Typography sx={{ fontSize: 12, color: 'text.secondary' }}>
          {this.props.label} could not be loaded. Reload the page to try again.
        </Typography>
      </Box>
    );
  }
}

/** Suspense + chunk-error containment for one lazily loaded panel. */
export function LazyPanelBoundary({ label, children }: { label: string; children: ReactNode }) {
  return (
    <ChunkErrorBoundary label={label}>
      <Suspense fallback={<Box data-testid="lazy-panel-loading" />}>{children}</Suspense>
    </ChunkErrorBoundary>
  );
}
