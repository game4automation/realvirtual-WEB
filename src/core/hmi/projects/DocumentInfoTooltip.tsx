// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * DocumentInfoTooltip — what a document is about, on hover over any document
 * list row or tile (plan-506 F6, F7, F10).
 *
 * ## Nothing to say → nothing added
 *
 * Without a block (every Unity export, every file nobody described) this
 * returns its child untouched: no wrapper, no listener, no empty popper. A list
 * of undescribed documents looks and behaves exactly as it did before.
 *
 * ## Lazy, because lists are long
 *
 * A MUI `Tooltip` per row mounts its title eagerly only if you hand it one; a
 * folder with hundreds of GLBs would then carry hundreds of rich subtrees
 * nobody looks at (mui/material-ui#27057). So the title stays empty
 * until the tooltip actually opens (controlled `open` state), and
 * `enterNextDelay` keeps a fast sweep across rows from opening any of them.
 *
 * Text only: the card beside it already shows the preview picture, so the
 * tooltip does not repeat it.
 *
 * ## Touch has no hover
 *
 * A long-press is not discoverable and is already the context menu, so on a
 * touch device the description becomes an inline, expandable line under the
 * name ({@link DocumentInfoExpandRow}) — shown only when there is something to
 * expand. The caller says whether the input is touch; this component stays
 * free of device sniffing.
 */

import { useState, type ReactElement } from 'react';
import { Box, IconButton, Tooltip, Typography } from '@mui/material';
import { ExpandMore } from '@mui/icons-material';
import { formatRelativeAge } from '../rv-node-knowledge-field-renderer';
import type { DocumentInfo } from '../../project/rv-document-info';
import { documentLevelLabel, type DocumentClassification } from '../../project/rv-document-classification';
import { documentInfoPreview, type DocumentInfoPreview } from './document-info-preview';

export interface DocumentInfoTooltipProps {
  info?: DocumentInfo | null;
  /**
   * The document's full name, shown as the tooltip's first line. A card label
   * is one clipped line, so a long name is only readable here (customer
   * feedback 2026-09-30). With a name the tooltip exists even without a
   * block; without either, the child is returned untouched as before.
   */
  name?: string | null;
  /** Level + tags for the footer line. */
  classification?: DocumentClassification | null;
  /** Touch input: render the expandable line instead of a hover tooltip. */
  touch: boolean;
  /** Keep a touch card full width; place its description toggle underneath. */
  cardLayout?: boolean;
  /** The tile or row. Must accept a ref and hover/focus handlers (MUI Tooltip contract). */
  children: ReactElement;
  placement?: 'right' | 'bottom' | 'top' | 'left';
}

const INK_HIGH = 'rgba(255,255,255,0.92)';
const INK_MID = 'rgba(255,255,255,0.72)';
const INK_LOW = 'rgba(255,255,255,0.45)';

function footerOf(classification: DocumentClassification | null | undefined, info: DocumentInfo | null | undefined): string | null {
  const parts: string[] = [];
  if (classification?.level) parts.push(documentLevelLabel(classification.level));
  for (const t of classification?.tags ?? []) parts.push(t);
  const age = info?.updatedAt ? formatRelativeAge(info.updatedAt) : null;
  if (age) parts.push(age);
  return parts.length > 0 ? parts.join(' · ') : null;
}

function PreviewText({ preview }: { preview: DocumentInfoPreview }) {
  return (
    <Box sx={{ minWidth: 0 }}>
      {preview.summary && (
        <Typography sx={{ fontSize: 12, fontWeight: 600, color: INK_HIGH, lineHeight: 1.35 }}>
          {preview.summary}
        </Typography>
      )}
      {preview.firstParagraph && (
        <Typography sx={{ fontSize: 11, color: INK_MID, lineHeight: 1.45, mt: preview.summary ? 0.5 : 0 }}>
          {preview.firstParagraph}
        </Typography>
      )}
    </Box>
  );
}

/** The tooltip body. Built only while open. */
function TooltipContent({ name, preview, footer }: {
  name: string | null;
  preview: DocumentInfoPreview | null;
  footer: string | null;
}) {
  return (
    <Box data-testid="document-info-tooltip" sx={{ p: 0.5, maxWidth: 340 }}>
      {name && (
        <Typography
          data-testid="document-info-tooltip-name"
          sx={{
            fontSize: 12, fontWeight: 600, color: INK_HIGH, lineHeight: 1.35,
            wordBreak: 'break-word', mb: preview ? 0.5 : 0,
          }}
        >
          {name}
        </Typography>
      )}
      {preview && <PreviewText preview={preview} />}
      {footer && (
        <Typography sx={{ fontSize: 10, color: INK_LOW, mt: 0.75 }}>{footer}</Typography>
      )}
    </Box>
  );
}

export function DocumentInfoTooltip({
  info, name = null, classification, touch, cardLayout = false, children, placement = 'right',
}: DocumentInfoTooltipProps) {
  const [open, setOpen] = useState(false);
  const preview = documentInfoPreview(info);
  const title = name?.trim() ? name.trim() : null;
  if (!preview && !title) return children;
  if (touch) {
    // The name needs no affordance on touch: the label is under the finger
    // already, and a chevron with only the name behind it would be noise.
    if (!preview) return children;
    return <DocumentInfoExpandRow preview={preview} cardLayout={cardLayout}>{children}</DocumentInfoExpandRow>;
  }
  return (
    <Tooltip
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      enterDelay={400}
      enterNextDelay={300}
      placement={placement}
      // Empty until open: the rich subtree does not exist for a row nobody
      // hovers. MUI renders no popper for an empty title but keeps the hover
      // listeners, so the closed state costs those and nothing else.
      title={open
        ? <TooltipContent name={title} preview={preview} footer={footerOf(classification, info)} />
        : ''}
      slotProps={{ tooltip: { sx: { bgcolor: 'rgba(24,28,34,0.97)', border: '1px solid rgba(255,255,255,0.1)' } } }}
    >
      {children}
    </Tooltip>
  );
}

/**
 * The touch variant: the row as it was, plus a chevron that expands the
 * summary and the first paragraph inline. Local, unpersisted state — a glance,
 * not a setting.
 */
export function DocumentInfoExpandRow({ preview, children, cardLayout = false }: {
  preview: DocumentInfoPreview;
  children: ReactElement;
  cardLayout?: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  return (
    <Box data-testid="document-info-expand-row" sx={{ minWidth: 0 }}>
      <Box sx={{ display: 'flex', flexDirection: cardLayout ? 'column' : 'row', alignItems: 'flex-start', minWidth: 0 }}>
        <Box sx={{ flex: 1, minWidth: 0, ...(cardLayout ? { width: '100%' } : {}) }}>{children}</Box>
        <IconButton
          size="small"
          aria-label={expanded ? 'Hide description' : 'Show description'}
          aria-expanded={expanded}
          onClick={(e) => { e.stopPropagation(); setExpanded(v => !v); }}
          sx={{ p: 0.25, color: INK_LOW, ...(cardLayout ? { alignSelf: 'flex-end' } : {}), transform: expanded ? 'rotate(180deg)' : 'none' }}
        >
          <ExpandMore sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>
      {expanded && (
        <Box sx={{ px: 0.5, pt: 0.25, pb: 0.5 }}>
          <PreviewText preview={preview} />
        </Box>
      )}
    </Box>
  );
}
