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

import { useSyncExternalStore } from 'react';
import { Box, Typography } from '@mui/material';
import {
  getActiveDocumentViewVersion,
  resolveActiveDocumentView,
  subscribeActiveDocumentView,
} from '../../editor/active-document-view';
import {
  getProjectsDashboardSnapshot,
  subscribeProjectsDashboard,
} from './projects-dashboard-store';
import { DocumentCard } from '../scene/DocumentCard';

export interface DocumentHeroSectionProps {
  /**
   * Click on the card. The dashboard supplies it because revealing a document
   * means selecting its row in the tree, which is the dashboard's knowledge and
   * not the document's.
   */
  onReveal?: () => void;
}

export function DocumentHeroSection({ onReveal }: DocumentHeroSectionProps) {
  useSyncExternalStore(subscribeActiveDocumentView, getActiveDocumentViewVersion);
  // `null` — the dashboard is a place, not a mode, so the band shows whatever
  // document is open rather than only the one belonging to the mode behind the
  // overlay.
  const open = resolveActiveDocumentView(null) !== null;
  // The dashboard host stays mounted while hidden (display:none), so the card
  // needs to know when it is actually on screen — rendering the hero preview
  // for a hidden dashboard is what made every project switch pay for a picture
  // nobody saw. This section is the one hero mount AND already lives next to
  // the store, so the visibility knowledge crosses to the card here.
  const dashboard = useSyncExternalStore(subscribeProjectsDashboard, getProjectsDashboardSnapshot);

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
      }}
    >
      {open
        ? <DocumentCard variant="hero" onReveal={onReveal} previewVisible={dashboard.open} />
        : (
          <Typography data-testid="document-hero-empty" sx={{ fontSize: 12, color: 'text.disabled' }}>
            Nothing open — double-click an asset to start.
          </Typography>
        )}
    </Box>
  );
}
