// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PdfTooltipSection — Generic PDF document section for any tooltip.
 *
 * Reads `_rvPdfLinks: PdfLink[]` from node.userData and renders:
 * - **Hover mode**: compact one-line summary ("📄 2 documents")
 * - **Pinned mode**: full clickable list of PDF documents
 *
 * Any component/plugin can attach PDFs to a node by populating
 * `node.userData._rvPdfLinks`. The GenericTooltipController auto-detects
 * this and stacks PdfTooltipSection at the bottom of the tooltip bubble.
 *
 * Self-registers as tooltip content type 'pdf' at module load time.
 */

import { Box, Typography } from '@mui/material';
import { PictureAsPdf } from '@mui/icons-material';
import type { TooltipContentProps } from './tooltip-registry';
import { tooltipRegistry } from './tooltip-registry';
import type { TooltipData } from './tooltip-store';
import { openPdfViewer, type PdfLink } from '../pdf-viewer-store';
import { useViewer } from '../../../hooks/use-viewer';

// ─── Types ─────────────────────────────────────────────────────────────

/** Tooltip data shape for PDF tooltips. */
export interface PdfTooltipData extends TooltipData {
  type: 'pdf';
  nodePath: string;
}

// ─── Content Provider ──────────────────────────────────────────────────

export function PdfTooltipSection({ data, isPinned }: TooltipContentProps<PdfTooltipData>) {
  const viewer = useViewer();
  const node = viewer.registry?.getNode(data.nodePath);
  const pdfLinks = node?.userData?._rvPdfLinks as PdfLink[] | undefined;

  if (!pdfLinks || pdfLinks.length === 0) return null;

  // Hover mode: compact one-line summary
  if (!isPinned) {
    return (
      <Typography
        variant="caption"
        sx={{
          color: 'rgba(255,255,255,0.4)', fontSize: 10, mt: 0.25,
          display: 'flex', alignItems: 'center', gap: 0.5,
          cursor: 'pointer',
        }}
      >
        <PictureAsPdf sx={{ fontSize: 10, color: '#ef5350' }} />
        {pdfLinks.length} document{pdfLinks.length > 1 ? 's' : ''} available
      </Typography>
    );
  }

  // Pinned mode: full clickable list
  return (
    <>
      <Typography
        variant="caption"
        sx={{
          color: '#ef5350', fontSize: 10, fontWeight: 700,
          mt: 0.75, mb: 0.25, display: 'block',
          textTransform: 'uppercase', letterSpacing: 0.5,
        }}
      >
        Documents
      </Typography>
      {pdfLinks.map((link, i) => (
        <Box
          key={`pdf-${i}`}
          onClick={() => openPdfViewer(link.title, link.source)}
          sx={{
            display: 'flex', alignItems: 'center', gap: 0.5,
            cursor: 'pointer', py: 0.25, borderRadius: 0.5,
            '&:hover': { bgcolor: 'rgba(255,255,255,0.05)' },
          }}
        >
          <PictureAsPdf sx={{ fontSize: 12, color: '#ef5350' }} />
          <Typography variant="caption" sx={{ color: '#fff', fontSize: 10 }}>
            {link.title}
          </Typography>
        </Box>
      ))}
    </>
  );
}

// ─── Self-registration ─────────────────────────────────────────────────

tooltipRegistry.register({
  contentType: 'pdf',
  component: PdfTooltipSection as any,
  priority: 200, // low priority = rendered last (at the bottom of stacked sections)
});

// Data resolver: check for _rvPdfLinks on the node
tooltipRegistry.registerDataResolver('pdf', (node, viewer) => {
  const pdfLinks = node.userData?._rvPdfLinks as PdfLink[] | undefined;
  if (!pdfLinks || pdfLinks.length === 0) return null;
  const path = viewer.registry?.getPathForNode(node) ?? '';
  return { type: 'pdf', nodePath: path };
});
