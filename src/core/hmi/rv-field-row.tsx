// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-field-row.tsx — Single field row for the Property Inspector.
 *
 * Renders a field name, override indicator, and either an editor widget,
 * a reference badge, or a read-only display value.
 */

import {
  Box,
  Typography,
  IconButton,
  Tooltip,
} from '@mui/material';
import { Circle } from '@mui/icons-material';
import type { RVViewer } from '../rv-viewer';
import type { SignalStore } from '../engine/rv-signal-store';
import {
  inferFieldType,
  isComponentRef,
  isScriptableObject,
  formatDisplayValue,
  type FieldStatus,
} from './rv-inspector-helpers';
import { FieldEditor } from './rv-field-editors';
import { ReferenceDisplay, ScriptableObjectDisplay } from './rv-reference-display';

// ── FieldRow ──────────────────────────────────────────────────────────────

export interface FieldRowProps {
  fieldName: string;
  value: unknown;
  status: FieldStatus;
  isOverridden: boolean;
  onEdit: (value: unknown) => void;
  onReset: () => void;
  viewer: RVViewer | null;
  signalStore: SignalStore | null;
}

export function FieldRow({ fieldName, value, status, isOverridden, onEdit, onReset, viewer, signalStore }: FieldRowProps) {
  const fieldType = inferFieldType(fieldName, value);
  const isReference = fieldType === 'reference' || fieldType === 'scriptableobject';
  // References are always read-only (structural links, not user-editable values)
  const isEditable = status === 'consumed' && !isReference;
  const isBoolField = fieldType === 'boolean';

  // Tooltip text
  let tooltipText = '';
  if (status === 'ignored') tooltipText = 'Not used by WebViewer';
  else if (status === 'unknown') tooltipText = 'Unknown field \u2014 not mapped in WebViewer';
  else if (isReference) {
    if (isComponentRef(value)) {
      const resolved = viewer?.registry?.getNode(value.path);
      tooltipText = resolved ? `Linked \u2192 ${value.path}` : `Unlinked: ${value.path} not found`;
    } else {
      tooltipText = 'ScriptableObject reference';
    }
  } else if (isOverridden) tooltipText = 'Overridden \u2014 click dot to reset';

  return (
    <Tooltip
      title={tooltipText}
      placement="left"
      disableHoverListener={!tooltipText}
    >
      <Box
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 0.5,
          px: 1,
          py: isBoolField ? 0.125 : 0.375,
          opacity: isEditable || isReference ? 1 : (status === 'consumed' ? 1 : 0.4),
          '&:hover': {
            bgcolor: 'rgba(255,255,255,0.02)',
          },
          minHeight: 26,
        }}
      >
        {/* Override indicator */}
        <Box sx={{ width: 10, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
          {isOverridden && (
            <IconButton
              size="small"
              onClick={(e) => { e.stopPropagation(); onReset(); }}
              sx={{ p: 0, color: '#4fc3f7' }}
              title="Reset to default"
            >
              <Circle sx={{ fontSize: 7 }} />
            </IconButton>
          )}
        </Box>

        {/* Field name */}
        <Typography
          sx={{
            fontSize: 11,
            color: isEditable || isReference ? 'text.primary' : 'text.disabled',
            minWidth: 80,
            maxWidth: 120,
            flexShrink: 0,
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            whiteSpace: 'nowrap',
          }}
          title={fieldName}
        >
          {fieldName}
        </Typography>

        {/* Editor, reference display, or read-only display */}
        <Box sx={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: (isBoolField || isReference) ? 'flex-end' : 'stretch' }}>
          {isComponentRef(value) ? (
            <ReferenceDisplay value={value} viewer={viewer} signalStore={signalStore} />
          ) : isScriptableObject(value) ? (
            <ScriptableObjectDisplay value={value as Record<string, unknown>} />
          ) : isEditable ? (
            <FieldEditor value={value} onChange={onEdit} fieldType={fieldType} fieldName={fieldName} editable />
          ) : (
            <Typography
              sx={{
                fontSize: 11,
                fontFamily: 'monospace',
                color: 'text.disabled',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {formatDisplayValue(value)}
            </Typography>
          )}
        </Box>
      </Box>
    </Tooltip>
  );
}
