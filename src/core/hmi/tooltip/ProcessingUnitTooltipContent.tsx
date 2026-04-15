// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ProcessingUnitTooltipContent — Renders processing unit info
 * inside the generic TooltipLayer.
 *
 * Self-registers in the TooltipContentRegistry at module load.
 */

import { Typography } from '@mui/material';
import type { TooltipContentProps } from './tooltip-registry';
import { tooltipRegistry } from './tooltip-registry';
import type { TooltipData } from './tooltip-store';

/** Data shape for processing unit tooltips. */
export interface ProcessingUnitTooltipData extends TooltipData {
  type: 'processing-unit';
  nodePath: string;
}

/** Processing unit tooltip content provider component. */
export function ProcessingUnitTooltipContent({ data }: TooltipContentProps<ProcessingUnitTooltipData>) {
  return (
    <>
      <Typography
        variant="subtitle2"
        sx={{ color: '#4fc3f7', fontWeight: 700, fontSize: 13, lineHeight: 1.2 }}
      >
        {data.nodePath.split('/').pop() ?? 'Processing Unit'}
      </Typography>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', display: 'block' }}>
        Processing Unit
      </Typography>
    </>
  );
}

// ── Self-registration ──
tooltipRegistry.register({
  contentType: 'processing-unit',
  component: ProcessingUnitTooltipContent as any,
});

// ── Data resolver for GenericTooltipController ──
tooltipRegistry.registerDataResolver('processing-unit', (node, viewer) => {
  const path = viewer.registry?.getPathForNode(node) ?? '';
  return path ? { type: 'processing-unit', nodePath: path } : null;
});
