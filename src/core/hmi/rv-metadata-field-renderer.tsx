// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-metadata-field-renderer.tsx — Custom field renderer for RuntimeMetadata content.
 *
 * Parses the XML-like content string and renders each tag as formatted UI elements
 * using the shared SignalBadge for live signal display with Input/Output coloring.
 *
 * Self-registers with the fieldRendererRegistry on import.
 */

import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import { parseTags, extractAttr } from './tooltip/MetadataTooltipContent';
import { useSignalValues, SignalBadge } from './rv-signal-badge';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { useViewer } from '../../hooks/use-viewer';

function MetadataContentRenderer({ value }: FieldRendererProps) {
  const viewer = useViewer();
  const content = typeof value === 'string' ? value : '';
  const tags = useMemo(() => parseTags(content), [content]);

  // Collect signal names — top-level <signal> and nested inside <value>
  const signalNames = useMemo(() => {
    const names: string[] = [];
    const nestedRe = /<signal>([^<]*)<\/signal>/g;
    for (const t of tags) {
      if (t.tag === 'signal') {
        names.push(t.text);
      } else if (t.tag === 'value') {
        let m: RegExpExecArray | null;
        nestedRe.lastIndex = 0;
        while ((m = nestedRe.exec(t.text)) !== null) {
          names.push(m[1]);
        }
      }
    }
    return names;
  }, [tags]);

  const signalValues = useSignalValues(viewer, signalNames);

  if (tags.length === 0) {
    return (
      <Typography sx={{ fontSize: 11, fontFamily: 'monospace', color: 'text.disabled', px: 1, py: 0.5 }}>
        {content || '(empty)'}
      </Typography>
    );
  }

  return (
    <Box sx={{ px: 1, py: 0.5, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      {tags.map((t, i) => {
        switch (t.tag) {
          case 'name':
          case 'bold':
            return (
              <Typography key={i} sx={{ fontSize: 12, fontWeight: 700, color: '#ffa040', lineHeight: 1.4 }}>
                {t.text}
              </Typography>
            );
          case 'text':
            return (
              <Typography key={i} sx={{ fontSize: 11, color: 'rgba(255,255,255,0.7)', lineHeight: 1.4 }}>
                {t.text}
              </Typography>
            );
          case 'value': {
            const label = extractAttr(t.attributes, 'label') ?? '';
            const nestedSignalMatch = /<signal>([^<]*)<\/signal>/.exec(t.text);
            if (nestedSignalMatch) {
              const sigName = nestedSignalMatch[1];
              const info = signalValues.get(sigName);
              return (
                <Box key={i} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1 }}>
                  <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{label}</Typography>
                  <SignalBadge direction={info?.direction ?? 'unknown'} plcType={info?.plcType} raw={info?.raw} />
                </Box>
              );
            }
            return (
              <Box key={i} sx={{ display: 'flex', justifyContent: 'space-between', gap: 1 }}>
                <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{label}</Typography>
                <Typography sx={{ fontSize: 11, color: '#fff', fontFamily: 'monospace' }}>{t.text}</Typography>
              </Box>
            );
          }
          case 'signal': {
            const info = signalValues.get(t.text);
            return (
              <Box key={i} sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 1 }}>
                <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.5)' }}>{t.text}</Typography>
                <SignalBadge direction={info?.direction ?? 'unknown'} plcType={info?.plcType} raw={info?.raw} />
              </Box>
            );
          }
          case 'link': {
            const url = extractAttr(t.attributes, 'url');
            return (
              <Typography
                key={i}
                component="a"
                href={url ?? '#'}
                target="_blank"
                rel="noopener noreferrer"
                sx={{ fontSize: 11, color: '#64b5f6', textDecoration: 'underline', cursor: 'pointer', pointerEvents: 'auto' }}
              >
                {t.text}
              </Typography>
            );
          }
          default:
            return null;
        }
      })}
    </Box>
  );
}

// ── Self-registration ──
fieldRendererRegistry.register({
  componentType: 'RuntimeMetadata',
  fieldName: 'content',
  component: MetadataContentRenderer,
});
