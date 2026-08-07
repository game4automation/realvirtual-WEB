// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AnnotationPanel — Left-panel section showing all annotations.
 *
 * Displays a scrollable list of annotations with click-to-focus,
 * inline text editing, color picker, and delete functionality.
 */

import { useSyncExternalStore, useCallback } from 'react';
import {
  Box,
  Typography,
  IconButton,
  Paper,
} from '@mui/material';
import {
  Close,
  Delete,
  EditNote,
  PushPin,
} from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import type { AnnotationPluginAPI, Annotation } from '../types/plugin-types';
import type { AnnotationPlugin } from '../../plugins/annotation-plugin';
import {
  subscribeAnnotations,
  getAnnotationSnapshot,
} from '../../plugins/annotation-plugin';
import {
  ANNOTATION_PANEL_WIDTH,
  LEFT_PANEL_TOP,
  LEFT_PANEL_LEFT,
  LEFT_PANEL_BOTTOM,
  LEFT_PANEL_ZINDEX,
} from './layout-constants';
import { WINDOW_DARK_BG } from './LeftPanel';
import { useViewportInsets } from '../../hooks/use-viewport-insets';
import { useDropOrphanedPanelSlot } from '../../hooks/use-drop-orphaned-panel-slot';
import { ISA_RED } from './isa-colors';

// ── Constants ──────────────────────────────────────────────────────────

const BORDER = 'rgba(255,255,255,0.07)';

// ── Panel Component ────────────────────────────────────────────────────

export function AnnotationPanel() {
  const viewer = useViewer();
  const snap = useSyncExternalStore(subscribeAnnotations, getAnnotationSnapshot);
  const plugin = viewer.getPlugin('annotations') as (AnnotationPluginAPI & AnnotationPlugin) | undefined;

  const lpm = viewer.leftPanelManager;
  const isOpen = useSyncExternalStore(lpm.subscribe, lpm.getSnapshot).activePanel === 'annotations';
  const topOffset = useViewportInsets().top;

  const handleClose = useCallback(() => {
    lpm.close('annotations');
  }, [lpm]);

  const handleStartEdit = useCallback((ann: Annotation) => {
    plugin?.openEditModal(ann.id);
  }, [plugin]);

  const handleDelete = useCallback((id: string) => {
    plugin?.removeAnnotation(id);
  }, [plugin]);

  const handleFocus = useCallback((id: string) => {
    plugin?.focusAnnotation(id);
  }, [plugin]);

  // The per-model annotation plugin backs this slot; drop it if the slot was
  // restored for a model that doesn't load the plugin (else its inset reserves
  // an empty strip — see useDropOrphanedPanelSlot).
  useDropOrphanedPanelSlot('annotations', isOpen, !!plugin);

  if (!isOpen || !plugin) return null;

  return (
    <Paper
      elevation={6}
      data-ui-panel
      sx={{
        position: 'fixed',
        left: LEFT_PANEL_LEFT,
        top: LEFT_PANEL_TOP + topOffset,
        bottom: LEFT_PANEL_BOTTOM,
        width: ANNOTATION_PANEL_WIDTH,
        backgroundColor: `${WINDOW_DARK_BG} !important`,
        borderRight: `1px solid ${BORDER}`,
        borderRadius: 0,
        zIndex: LEFT_PANEL_ZINDEX,
        display: 'flex',
        flexDirection: 'column',
        overflow: 'hidden',
        pointerEvents: 'auto',
      }}
    >
      {/* Unified header (matches LeftPanel) */}
      <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, py: 1.25, gap: 0.5, borderBottom: `1px solid ${BORDER}`, flexShrink: 0 }}>
        <PushPin sx={{ fontSize: 16, color: '#FF5722' }} />
        <Typography variant="subtitle2" sx={{ fontSize: '0.8rem', fontWeight: 600, color: 'text.primary', flexGrow: 1 }}>
          Annotations ({snap.annotations.length})
        </Typography>
        <IconButton size="small" onClick={handleClose} sx={{ color: 'text.secondary', p: 0.25 }}>
          <Close sx={{ fontSize: 16 }} />
        </IconButton>
      </Box>

      {/* Annotation list */}
      <Box sx={{ flex: 1, overflow: 'auto', py: 0.5 }}>
        {snap.annotations.length === 0 && (
          <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', textAlign: 'center', py: 2 }}>
            No annotations yet
          </Typography>
        )}
        {snap.annotations.map((ann) => (
          <Box
            key={ann.id}
            sx={{
              display: 'flex',
              alignItems: 'flex-start',
              gap: 0.5,
              px: 1,
              py: 0.5,
              cursor: 'pointer',
              bgcolor: snap.selectedAnnotation === ann.id ? 'rgba(255,87,34,0.12)' : 'transparent',
              '&:hover': { bgcolor: 'rgba(255,255,255,0.04)' },
            }}
            onClick={() => handleFocus(ann.id)}
          >
            {/* Color dot */}
            <Box
              sx={{
                width: 8,
                height: 8,
                borderRadius: '50%',
                bgcolor: ann.color,
                flexShrink: 0,
                mt: 0.5,
              }}
            />

            {/* Text */}
            <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Typography sx={{
                    fontSize: 11,
                    color: 'rgba(255,255,255,0.85)',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                    whiteSpace: 'nowrap',
                  }}>
                    {ann.text || '(empty)'}
                  </Typography>
                  <Typography sx={{ fontSize: 9, color: 'rgba(255,255,255,0.3)' }}>
                    {ann.author} — {new Date(ann.timestamp).toLocaleTimeString()}
                  </Typography>
            </Box>

            {/* Actions */}
            <Box sx={{ display: 'flex', gap: 0.25, flexShrink: 0 }}>
              <IconButton
                size="small"
                onClick={(e) => { e.stopPropagation(); handleStartEdit(ann); }}
                sx={{ color: 'rgba(255,255,255,0.3)', p: 0.2, '&:hover': { color: '#4fc3f7' } }}
              >
                <EditNote sx={{ fontSize: 12 }} />
              </IconButton>
              <IconButton
                size="small"
                onClick={(e) => { e.stopPropagation(); handleDelete(ann.id); }}
                sx={{ color: 'rgba(255,255,255,0.3)', p: 0.2, '&:hover': { color: ISA_RED } }}
              >
                <Delete sx={{ fontSize: 12 }} />
              </IconButton>
            </Box>
          </Box>
        ))}
      </Box>
    </Paper>
  );
}
