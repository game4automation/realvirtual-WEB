// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PipeColoringPlugin — Toolbar toggle for fluid-based coloring of pipes AND
 * tanks.
 *
 * ProcessIndustryPlugin owns the material-swap logic (`setColoringEnabled`)
 * but keeps it disabled by default so the scene shows the authored GLB look.
 * This plugin exposes a button in the left sidebar that flips the toggle,
 * repaints every pipe + tank (or restores originals), and persists the
 * preference across reloads in localStorage.
 *
 * Scoped to the DemoProcessIndustry model — registered alongside
 * ProcessIndustryPlugin via src/plugins/models/DemoProcessIndustry/index.ts.
 */

import { useCallback, useEffect, useState } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import { ColorLens } from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import type { RVViewer } from '../core/rv-viewer';
import type { LoadResult } from '../core/engine/rv-scene-loader';
import { NavButton } from '../core/hmi/NavButton';
import { BOTTOM_BAR_HEIGHT } from '../core/hmi/layout-constants';
import { RESOURCE_COLORS } from './tank-fill-history-plugin';
import { ProcessIndustryPlugin } from './processindustry-plugin';

/** localStorage key for the toggle state (survives reload). Name kept from
 *  the original pipe-only version so existing user preferences don't reset. */
const LS_KEY = 'rv-pipe-coloring-enabled';

export function loadPipeColoringEnabled(): boolean {
  try {
    return localStorage.getItem(LS_KEY) === 'true';
  } catch {
    return false;
  }
}

export function savePipeColoringEnabled(enabled: boolean): void {
  try {
    localStorage.setItem(LS_KEY, enabled ? 'true' : 'false');
  } catch {
    /* ignore quota errors */
  }
}

function PipeColoringButton({ viewer }: UISlotProps) {
  const [enabled, setEnabled] = useState(false);

  // On mount: sync the toggle and the plugin with the persisted preference.
  useEffect(() => {
    const persisted = loadPipeColoringEnabled();
    setEnabled(persisted);
    viewer.getPlugin<ProcessIndustryPlugin>('processindustry')?.setColoringEnabled(persisted);
  }, [viewer]);

  const handleClick = useCallback(() => {
    const next = !enabled;
    setEnabled(next);
    savePipeColoringEnabled(next);
    viewer.getPlugin<ProcessIndustryPlugin>('processindustry')?.setColoringEnabled(next);
  }, [viewer, enabled]);

  return (
    <>
      <NavButton
        icon={<ColorLens />}
        label={enabled ? 'Coloring: ON' : 'Coloring: OFF'}
        active={enabled}
        onClick={handleClick}
      />
      {enabled && <MediaLegend />}
    </>
  );
}

/** Compact fluid-color legend — renders only while coloring is enabled, so
 *  users can map the medium names to the hues they see in the scene. Lives
 *  at bottom-left just above the BottomBar, offset past the left button
 *  column so it doesn't obscure the nav. */
function MediaLegend() {
  const entries = Object.entries(RESOURCE_COLORS);
  return (
    <Paper
      elevation={4}
      data-ui-panel
      sx={{
        position: 'fixed',
        left: 64,
        bottom: BOTTOM_BAR_HEIGHT + 12,
        px: 1.25,
        py: 0.75,
        borderRadius: 1.5,
        border: '1px solid rgba(255,255,255,0.08)',
        bgcolor: 'rgba(20,20,20,0.85)',
        backdropFilter: 'blur(8px)',
        pointerEvents: 'auto',
        zIndex: 1250,
      }}
    >
      <Typography sx={{
        fontSize: 9, fontWeight: 700, letterSpacing: 1.5, textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.45)', mb: 0.5,
      }}>
        Media
      </Typography>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.4 }}>
        {entries.map(([name, color]) => (
          <Box key={name} sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
            <Box sx={{
              width: 14, height: 3, borderRadius: 0.5, flexShrink: 0, bgcolor: color,
            }} />
            <Typography sx={{ fontSize: 11, color: '#fff', lineHeight: 1.2, whiteSpace: 'nowrap' }}>
              {name}
            </Typography>
          </Box>
        ))}
      </Box>
    </Paper>
  );
}

export class PipeColoringPlugin implements RVViewerPlugin {
  readonly id = 'pipe-coloring';
  readonly order = 170;

  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: PipeColoringButton, order: 55 },
  ];

  /** Re-apply the persisted preference when a new model loads — the
   *  ProcessIndustryPlugin instance is fresh (created in registerModelPlugins)
   *  so we need to push the user's last choice into it. */
  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    const persisted = loadPipeColoringEnabled();
    viewer.getPlugin<ProcessIndustryPlugin>('processindustry')?.setColoringEnabled(persisted);
  }
}
