// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProjectSections — the contents of one project, one tab at a time
 * (plan-372 §3.2/§3.5).
 *
 * Models, Scenes and Assets are three answers to three different questions
 * ("what can I build on", "what have I built", "what can I place"), and a user
 * arrives already knowing which one they are asking. Tabs put the chosen answer
 * at the top of the screen instead of somewhere down a shared scroll, and the
 * tab strip itself keeps the other two named and one click away.
 *
 * ## The counts live on the tabs
 *
 * A tab that reads "Scenes 0" answers "does this project have any?" without
 * being opened — which is the question an inactive tab would otherwise have to
 * be clicked to answer. It also means an empty panel is never a surprise.
 *
 * ## Empty is explained, not blank
 *
 * An empty panel says why it is empty, and says something different when a
 * search is active: "nothing matches" and "nothing exists" send the user to
 * opposite next actions, and a blank panel would leave them guessing which.
 */

import type { ReactNode } from 'react';
import { Box, Typography } from '@mui/material';
import { AssetCard } from '../../library/AssetCard';
import { CARD_MIN_WIDTH_PX } from '../../../plugins/layout-planner/CatalogBrowser';
import type { LibraryCatalogEntry } from '../../library/library-types';
import { useViewer } from '../../../hooks/use-viewer';
import {
  useAssetThumbnail,
  type ResolvedThumbnailSource,
} from '../../thumbnails/use-asset-thumbnail';
import type { ThumbnailKeyParts } from '../../thumbnails/thumbnail-key';
import { RV_SCROLL_CLASS } from '../shared-sx';
import type { ProjectTab } from './projects-dashboard-store';

export interface ProjectSectionCard {
  key: string;
  entry: LibraryCatalogEntry;
  tier: 'bundled' | 'user';
  selected: boolean;
  onSelect: () => void;
  /**
   * Preview identity + how to load the model, for a card whose entry has no
   * picture of its own (§2.7). Omit for a card that can never have one — a
   * scene's thumbnail is a saved snapshot of a composed scene, not a render of
   * a single GLB, so there is nothing here to generate.
   */
  thumbnailKey?: ThumbnailKeyParts;
  resolveThumbnail?: () => Promise<ResolvedThumbnailSource | null>;
}

export interface ProjectSection {
  /** Matches a {@link ProjectTab}, which is how the active panel is chosen. */
  key: ProjectTab;
  label: string;
  cards: ProjectSectionCard[];
  /** One line shown in place of the grid when `cards` is empty. */
  emptyHint: string;
}

export interface ProjectSectionsProps {
  sections: ProjectSection[];
  /** Which panel to show — the tab strip lives in the dashboard header. */
  activeTab: ProjectTab;
  /** True when a search term is active — changes what "empty" means. */
  filtered: boolean;
  /**
   * Per-library sections for the Assets tab (plan-702 F1).
   *
   * Optional on purpose: Models and Scenes have exactly one source each and
   * keep the flat-grid path untouched. Supplying this replaces the grid for
   * the Assets panel only, and the caller owns the collapse state.
   */
  assetGroups?: ReactNode;
}

/** DOM id of a tab button, so its panel can point back at it. */
export function projectTabId(tab: ProjectTab): string {
  return `rv-project-tab-${tab}`;
}

export function ProjectSections({ sections, activeTab, filtered, assetGroups }: ProjectSectionsProps) {
  const section = sections.find(s => s.key === activeTab) ?? sections[0];
  if (!section) return null;

  // The Assets panel renders per-library sections when the host supplies them.
  // `null` means "no library produced anything", which is what the shared empty
  // hint below already explains — so the grouped path only overrides a grid it
  // actually has content for.
  const grouped = section.key === 'assets' ? assetGroups ?? null : null;

  return (
    <Box
      className={RV_SCROLL_CLASS}
      role="tabpanel"
      id={`rv-project-panel-${section.key}`}
      aria-labelledby={projectTabId(section.key)}
      sx={{ flex: 1, overflowY: 'auto', minWidth: 0, p: 1.5 }}
    >
      {grouped !== null ? (
        grouped
      ) : section.cards.length === 0 ? (
        <Typography sx={{ fontSize: 12, color: 'text.disabled' }}>
          {filtered ? 'Nothing matches the search.' : section.emptyHint}
        </Typography>
      ) : (
        <Box
          sx={{
            display: 'grid',
            gridTemplateColumns: `repeat(auto-fill, minmax(${CARD_MIN_WIDTH_PX.comfortable}px, 1fr))`,
            gap: 1.25,
          }}
        >
          {section.cards.map(c => (
            <ProjectCard key={c.key} card={c} />
          ))}
        </Box>
      )}
    </Box>
  );
}

/**
 * One card, plus the preview request that belongs to it.
 *
 * A component rather than a branch inside the grid map: the pull is a hook, and
 * hooks cannot be called from a loop body. It also keeps the per-card
 * observer/effect scoped to the card, so a card leaving the grid takes its
 * pending request with it.
 */
export function ProjectCard({ card }: { card: ProjectSectionCard }) {
  const viewer = useViewer();
  const { ref, url } = useAssetThumbnail<HTMLDivElement>({
    service: viewer?.thumbnails ?? null,
    keyParts: card.thumbnailKey ?? null,
    resolve: card.resolveThumbnail ?? null,
    enabled: !card.entry.thumbnailUrl,
  });

  // The generated picture is merged in rather than assigned to the entry: the
  // entry is store state, and a card must not mutate it.
  const entry = url ? { ...card.entry, thumbnailUrl: url } : card.entry;

  return (
    <AssetCard
      ref={ref}
      entry={entry}
      variant="comfortable"
      tier={card.tier}
      selected={card.selected}
      onClick={card.onSelect}
    />
  );
}
