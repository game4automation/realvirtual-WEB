// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useCallback } from 'react';
import { Paper, Box, Typography, IconButton } from '@mui/material';
import { Warning, Build, Speed, Sensors, OpenInNew } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';

const iconMap: Record<string, React.ReactElement> = {
  warning: <Warning />,
  build: <Build />,
  speed: <Speed />,
  sensors: <Sensors />,
};

const severityColors: Record<string, string> = {
  error: '#ef5350',
  warning: '#ffa726',
  info: '#4fc3f7',
  success: '#66bb6a',
};

export interface TileCardProps {
  title: string;
  subtitle: React.ReactNode;
  severity: 'error' | 'warning' | 'info' | 'success';
  icon: string;
  timestamp: string;
  /** Hierarchy path of the related scene component (enables hover highlight + click focus) */
  componentPath?: string;
  /** Called on card body click — overrides default componentPath focus when provided. */
  onAction?: () => void;
}

export function TileCard({ title, subtitle, severity, icon, timestamp, componentPath, onAction }: TileCardProps) {
  const color = severityColors[severity];
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
      viewer.focusByPath(componentPath);
      viewer.highlightByPath(componentPath, true);
      const driveName = componentPath.split('/').pop() ?? componentPath;
      viewer.filterDrives(driveName);
    }
  }, [viewer, componentPath, onAction]);

  return (
    <Paper
      elevation={4}
      onMouseEnter={handleMouseEnter}
      onMouseLeave={handleMouseLeave}
      onClick={handleClick}
      sx={{
        p: 1.5,
        borderLeft: `3px solid ${color}`,
        cursor: (componentPath || onAction) ? 'pointer' : 'default',
        pointerEvents: 'auto',
        '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
        transition: 'background-color 0.15s',
      }}
    >
      <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 1 }}>
        <Box sx={{ color, mt: 0.25 }}>
          {iconMap[icon] || <Speed />}
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Typography variant="body2" sx={{ fontWeight: 600, lineHeight: 1.3 }}>
            {title}
          </Typography>
          <Typography variant="caption" component="div" sx={{ color: 'text.secondary', mt: 0.25 }}>
            {subtitle}
          </Typography>
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 0.5 }}>
          <Typography variant="caption" sx={{ color: 'text.secondary', whiteSpace: 'nowrap' }}>
            {timestamp}
          </Typography>
          <Box sx={{ display: 'flex', gap: 0.25 }}>
            <IconButton size="small" sx={{ p: 0.25 }} onClick={(e) => { e.stopPropagation(); if (componentPath) { viewer.focusByPath(componentPath); viewer.highlightByPath(componentPath, true); } }}>
              <OpenInNew sx={{ fontSize: 14 }} />
            </IconButton>
          </Box>
        </Box>
      </Box>
    </Paper>
  );
}
