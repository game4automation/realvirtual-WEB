// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * AnnotationEditModal — Modal overlay for editing annotation text, color, and category.
 *
 * Opens immediately when an annotation is placed via context menu "Annotate".
 * Supports multi-line text input. Color picker with preset colors.
 */

import { useState, useCallback, useEffect, useSyncExternalStore } from 'react';
import {
  Paper,
  Button,
  Box,
  Typography,
  IconButton,
  TextField,
} from '@mui/material';
import { Close, Delete } from '@mui/icons-material';
import { useViewer } from '../../hooks/use-viewer';
import type { AnnotationPluginAPI } from '../types/plugin-types';
import {
  subscribeAnnotations,
  getAnnotationSnapshot,
} from '../../plugins/annotation-plugin';
import type { AnnotationPlugin } from '../../plugins/annotation-plugin';

// ── Constants ──────────────────────────────────────────────────────────

const COLORS = ['#FF5722', '#2196F3', '#4CAF50', '#FFC107', '#9C27B0', '#00BCD4', '#FF9800', '#E91E63', '#607D8B'];

// ── Component ──────────────────────────────────────────────────────────

export function AnnotationEditModal() {
  const viewer = useViewer();
  const snap = useSyncExternalStore(subscribeAnnotations, getAnnotationSnapshot);
  const plugin = viewer.getPlugin('annotations') as (AnnotationPluginAPI & AnnotationPlugin) | undefined;

  const editingId = snap.editingAnnotationId;
  const annotation = editingId ? snap.annotations.find(a => a.id === editingId) : null;

  const [text, setText] = useState('');
  const [color, setColor] = useState('#FF5722');

  // Sync local state when editing annotation changes
  useEffect(() => {
    if (annotation) {
      setText(annotation.text);
      setColor(annotation.color);
    }
  }, [annotation?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSave = useCallback(() => {
    if (!plugin || !editingId) return;
    plugin.updateAnnotation(editingId, { text, color });
    plugin.closeEditModal();
  }, [plugin, editingId, text, color]);

  const handleDelete = useCallback(() => {
    if (!plugin || !editingId) return;
    plugin.removeAnnotation(editingId);
    plugin.closeEditModal();
  }, [plugin, editingId]);

  const handleClose = useCallback(() => {
    if (!plugin) return;
    // If text is empty, delete the annotation (was just placed but user cancelled)
    if (editingId && !text.trim()) {
      plugin.removeAnnotation(editingId);
    } else if (editingId && text.trim()) {
      plugin.updateAnnotation(editingId, { text, color });
    }
    plugin.closeEditModal();
  }, [plugin, editingId, text, color]);

  if (!editingId || !annotation) return null;

  return (
    <Box
      data-ui-panel
      sx={{
        position: 'fixed',
        inset: 0,
        zIndex: 9600,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        bgcolor: 'rgba(0,0,0,0.4)',
        pointerEvents: 'auto',
      }}
      onClick={(e) => {
        // Close on backdrop click
        if (e.target === e.currentTarget) handleClose();
      }}
    >
      <Paper
        elevation={8}
        sx={{
          width: 380,
          maxWidth: '90vw',
          bgcolor: 'rgba(18,22,30,0.98)',
          border: '1px solid rgba(255,255,255,0.1)',
          borderRadius: 2,
          overflow: 'hidden',
        }}
      >
        {/* Header */}
        <Box sx={{ display: 'flex', alignItems: 'center', p: 1.5, pb: 1 }}>
          <Typography sx={{ fontSize: 14, fontWeight: 600, color: 'rgba(255,255,255,0.9)', flexGrow: 1 }}>
            {annotation.text ? 'Edit Annotation' : 'New Annotation'}
          </Typography>
          <IconButton size="small" onClick={handleClose} sx={{ color: 'rgba(255,255,255,0.4)', p: 0.25 }}>
            <Close sx={{ fontSize: 16 }} />
          </IconButton>
        </Box>

        {/* Text input (multi-line) */}
        <Box sx={{ px: 1.5, pb: 1.5 }}>
          <TextField
            fullWidth
            multiline
            minRows={3}
            maxRows={8}
            placeholder="Enter annotation text..."
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
            onKeyDown={(e) => {
              if (e.key === 'Escape') handleClose();
              // Ctrl+Enter to save
              if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) handleSave();
            }}
            sx={{
              '& .MuiInputBase-input': {
                fontSize: 13,
                color: 'rgba(255,255,255,0.85)',
                lineHeight: 1.5,
              },
              '& .MuiOutlinedInput-notchedOutline': {
                borderColor: 'rgba(255,255,255,0.15)',
              },
              '& .MuiOutlinedInput-root:hover .MuiOutlinedInput-notchedOutline': {
                borderColor: 'rgba(255,255,255,0.3)',
              },
              '& .MuiOutlinedInput-root.Mui-focused .MuiOutlinedInput-notchedOutline': {
                borderColor: '#FF5722',
              },
            }}
          />
        </Box>

        {/* Color picker */}
        <Box sx={{ px: 1.5, pb: 1.5 }}>
          <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.5)', mb: 0.5 }}>Color</Typography>
          <Box sx={{ display: 'flex', gap: 0.5, flexWrap: 'wrap' }}>
            {COLORS.map((c) => (
              <Box
                key={c}
                onClick={() => setColor(c)}
                sx={{
                  width: 24,
                  height: 24,
                  borderRadius: '50%',
                  bgcolor: c,
                  cursor: 'pointer',
                  border: color === c ? '2px solid #fff' : '2px solid transparent',
                  transition: 'border-color 0.15s',
                  '&:hover': { border: '2px solid rgba(255,255,255,0.5)' },
                }}
              />
            ))}
          </Box>
        </Box>

        {/* Author + timestamp info */}
        <Box sx={{ px: 1.5, pb: 1 }}>
          <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.3)' }}>
            by {annotation.author} — {new Date(annotation.timestamp).toLocaleString()}
            {annotation.nodePath && ` — attached to ${annotation.nodePath.split('/').pop()}`}
          </Typography>
        </Box>

        {/* Actions */}
        <Box sx={{ display: 'flex', justifyContent: 'space-between', px: 1.5, pb: 1.5 }}>
          <IconButton
            size="small"
            onClick={handleDelete}
            sx={{ color: 'rgba(255,255,255,0.4)', '&:hover': { color: '#ef5350' } }}
            title="Delete annotation"
          >
            <Delete sx={{ fontSize: 18 }} />
          </IconButton>
          <Box sx={{ display: 'flex', gap: 1 }}>
            <Button
              size="small"
              onClick={handleClose}
              sx={{ fontSize: 11, textTransform: 'none', color: 'rgba(255,255,255,0.5)' }}
            >
              Cancel
            </Button>
            <Button
              size="small"
              variant="contained"
              onClick={handleSave}
              sx={{
                fontSize: 11,
                textTransform: 'none',
                bgcolor: color,
                '&:hover': { bgcolor: color, filter: 'brightness(1.2)' },
              }}
            >
              Save
            </Button>
          </Box>
        </Box>
      </Paper>
    </Box>
  );
}
