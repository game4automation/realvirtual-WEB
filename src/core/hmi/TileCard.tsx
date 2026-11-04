// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useCallback } from 'react';
import { Paper, Box, Typography, IconButton } from '@mui/material';
import { Warning, Build, Speed, Sensors, OpenInNew, Info, CheckCircle } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import { SEVERITY_COLORS, pulseSeverityOutline, type MessageSeverity } from './severity-pulse';
import { DIVIDER, FIELD_BORDER, FIELD_BORDER_HOVER, FS, ICON_SIZE, INK_HIGH, INK_MID, PANEL_SURFACE } from './shared-sx';

const iconMap: Record<string, React.ReactElement> = {
  warning: <Warning />,
  build: <Build />,
  speed: <Speed />,
  sensors: <Sensors />,
  info: <Info />,
  success: <CheckCircle />,
};

export interface TileCardProps {
  title: string;
  subtitle: React.ReactNode;
  severity: MessageSeverity;
  icon: string;
  timestamp: string;
  /** Hierarchy path of the related scene component (enables hover highlight + click focus) */
  componentPath?: string;
  /** Called on card body click — overrides default componentPath focus when provided. */
  onAction?: () => void;
  /**
   * Optional footer button row rendered below the card body. Buttons here must call
   * `e.stopPropagation()` so they don't trigger the card-body click. Purely additive —
   * omitting it keeps the card identical to its previous layout.
   */
  actions?: React.ReactNode;
}

export function TileCard({ title, subtitle, severity, icon, timestamp, componentPath, onAction, actions }: TileCardProps) {
  const color = SEVERITY_COLORS[severity];
  const viewer = useViewer();

  const handleMouseEnter = useCallback(() => {
    if (componentPath) viewer.highlightByPath(componentPath, true);
  }, [viewer, componentPath]);

  const handleMouseLeave = useCallback(() => {
    if (componentPath) viewer.clearHighlight();
  }, [viewer, componentPath]);

  const handleClick = useCallback(() => {
    if (onAction) {
      onAction();
      return;
    }
    if (componentPath) {
      // Frame the related component and pulse its outline in the severity
      // color (shared alarm effect — see severity-pulse.ts).
      pulseSeverityOutline(viewer, componentPath, severity);
      const driveName = componentPath.split('/').pop() ?? componentPath;
      viewer.filterDrives(driveName);
    }
  }, [viewer, componentPath, onAction, severity]);

  return (
    <Paper
      elevation={0}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      sx={{
        p: 1.5,
        bgcolor: `${PANEL_SURFACE} !important`,
        border: `1px solid ${FIELD_BORDER}`,
        borderRadius: 1,
        boxShadow: 'none',
        cursor: (componentPath || onAction) ? 'pointer' : 'default',
        pointerEvents: 'auto',
        '&:hover': (componentPath || onAction) ? { borderColor: FIELD_BORDER_HOVER } : undefined,
        transition: 'border-color 120ms ease',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Box sx={{ color, mt: 0.25, display: 'flex', flexShrink: 0, '& .MuiSvgIcon-root': { fontSize: ICON_SIZE.lg } }}>
          {iconMap[icon] || <Speed />}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" sx={{ color: INK_HIGH, fontSize: FS.body, fontWeight: 600, lineHeight: 1.4 }}>
            {title}
          </Typography>
          <Typography variant="caption" component="div" sx={{ color: INK_MID, fontSize: FS.body, lineHeight: 1.5, mt: 0.5, overflowWrap: 'anywhere' }}>
            {subtitle}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5 }}>
          <Typography variant="caption" sx={{ color: INK_MID, fontSize: FS.label, fontVariantNumeric: 'tabular-nums', lineHeight: 1.5, whiteSpace: 'nowrap' }}>
            {timestamp}
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.25 }}>
            <IconButton aria-label="Focus related object" disabled={!componentPath} size="small" sx={{ p: 0.25 }} onClick={(e) => { e.stopPropagation(); if (componentPath) pulseSeverityOutline(viewer, componentPath, severity); }}>
              <OpenInNew sx={{ fontSize: 14 }} />
            </IconButton>
          </Box>
        </Box>
      </Box>
      {actions && (
        <Box sx={{
          display: 'flex', alignItems: 'center', gap: 0.75, mt: 1, pt: 1,
          borderTop: `1px solid ${DIVIDER}`,
          '& .MuiButton-root': { fontSize: FS.label, textTransform: 'none', fontWeight: 500, boxShadow: 'none' },
        }}>
          {actions}
        </Box>
      )}
    </Paper>
  );
}
