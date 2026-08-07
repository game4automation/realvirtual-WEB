// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-custom-runtime-instruction-field-renderer.tsx — Custom inspector renderer
 * for CustomRuntimeInstruction.steps.
 *
 * The raw `steps` field is a nested list ({ instruction, targetObjects, url }).
 * The default inspector would flatten it into an unreadable "steps.0.targetObjects.0"
 * dump. This renderer shows each step as a numbered instruction with clickable
 * target chips (camera focus + highlight) and an optional document button.
 * Targets that no longer resolve in the model are flagged.
 *
 * Self-registers with the fieldRendererRegistry on import.
 */

import { useMemo } from 'react';
import type { Object3D } from 'three';
import { Box, Typography, Chip, Tooltip, IconButton } from '@mui/material';
import { Description, Visibility } from '@mui/icons-material';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { useViewer } from '../../hooks/use-viewer';
import { parseSteps } from '../engine/rv-custom-runtime-instruction';
import { openPdfViewer } from './pdf-viewer-store';

function InstructionStepsRenderer({ value }: FieldRendererProps) {
  const viewer = useViewer();
  const steps = useMemo(() => parseSteps(value), [value]);

  if (steps.length === 0) {
    return (
      <Typography sx={{ fontSize: 11, color: 'text.disabled', px: 1, py: 0.5 }}>
        (no steps)
      </Typography>
    );
  }

  const nodeName = (p: string) => p.split('/').pop() || p;
  const exists = (p: string) => !!viewer?.registry?.getNode(p);

  // Frame the camera on the given targets and outline them.
  const focus = (paths: string[]) => {
    if (!viewer) return;
    const nodes = paths
      .map((p) => viewer.registry?.getNode(p))
      .filter((n): n is Object3D => !!n);
    if (nodes.length === 0) return;
    viewer.fitToNodes(nodes);
    for (const p of paths) viewer.highlightByPath?.(p, true);
  };

  return (
    <Box sx={{ px: 1, py: 0.5, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {steps.map((step, i) => (
        <Box
          key={i}
          sx={{
            display: 'flex',
            flexDirection: 'column',
            gap: 0.35,
            pb: 0.5,
            borderBottom: i < steps.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
          }}
        >
          <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
            <Typography sx={{ fontSize: 11, fontWeight: 700, color: 'text.secondary', flexShrink: 0 }}>
              {i + 1}.
            </Typography>
            <Typography sx={{ fontSize: 11, color: 'text.primary', lineHeight: 1.4, whiteSpace: 'pre-wrap', flex: 1, minWidth: 0 }}>
              {step.instruction || '(empty)'}
            </Typography>
            {step.url && (
              <Tooltip title={`Open document: ${step.url}`}>
                <IconButton
                  size="small"
                  sx={{ p: 0.25 }}
                  onClick={() => openPdfViewer(step.instruction || 'Document', { type: 'url', url: step.url! })}
                >
                  <Description sx={{ fontSize: 14 }} />
                </IconButton>
              </Tooltip>
            )}
          </Box>

          {step.targetPaths.length > 0 && (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', gap: 0.35, pl: 1.5 }}>
              {step.targetPaths.map((p) => {
                const ok = exists(p);
                return (
                  <Tooltip key={p} title={ok ? p : `${p} — not found in model`}>
                    <Chip
                      size="small"
                      variant="outlined"
                      icon={<Visibility sx={{ fontSize: 12 }} />}
                      label={nodeName(p)}
                      onClick={ok ? () => focus([p]) : undefined}
                      sx={{
                        height: 20,
                        fontSize: 10,
                        cursor: ok ? 'pointer' : 'default',
                        opacity: ok ? 1 : 0.55,
                        color: ok ? '#64b5f6' : '#ef5350',
                        borderColor: ok ? 'rgba(100,181,246,0.4)' : 'rgba(239,83,80,0.4)',
                        '& .MuiChip-icon': { color: 'inherit' },
                      }}
                    />
                  </Tooltip>
                );
              })}
              {step.targetPaths.filter(exists).length > 1 && (
                <Chip
                  size="small"
                  variant="outlined"
                  label="Focus all"
                  onClick={() => focus(step.targetPaths)}
                  sx={{ height: 20, fontSize: 10, cursor: 'pointer', color: 'text.secondary' }}
                />
              )}
            </Box>
          )}
        </Box>
      ))}
    </Box>
  );
}

// ── Self-registration ──
fieldRendererRegistry.register({
  componentType: 'CustomRuntimeInstruction',
  fieldName: 'steps',
  component: InstructionStepsRenderer,
});
