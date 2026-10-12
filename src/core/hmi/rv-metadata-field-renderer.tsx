// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-metadata-field-renderer.tsx — Custom field renderer for RuntimeMetadata content.
 *
 * Parses the XML-like content string and renders each tag as formatted UI elements
 * using the shared SignalBadge for live signal display with Input/Output coloring.
 * Label → value tags (`<value>`, `<signal>`) are `InspectorRow`s on the one value
 * column (plan-514); headings and prose sit on the row padding.
 *
 * Self-registers with the fieldRendererRegistry on import.
 */

import { useMemo } from 'react';
import { Box, Typography } from '@mui/material';
import { parseTags, extractAttr } from './tooltip/MetadataTooltipContent';
import { useSignalValues, SignalBadge } from './rv-signal-badge';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { useViewer } from '../../hooks/use-viewer';
import { InspectorRow, INSPECTOR_ROW_PX } from './rv-inspector-row';
import { FS, INK_HIGH, INK_LOW, INK_MID, LINK, MONO, WARN } from './shared-sx';

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
      <Typography sx={{ fontSize: FS.label, fontFamily: MONO, color: 'text.disabled', px: INSPECTOR_ROW_PX, py: 0.5 }}>
        {content || '(empty)'}
      </Typography>
    );
  }

  return (
    <Box sx={{ py: 0.5, display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      {tags.map((t, i) => {
        switch (t.tag) {
          case 'name':
          case 'bold':
            return (
              <Typography key={i} sx={{ px: INSPECTOR_ROW_PX, fontSize: FS.body, fontWeight: 700, color: WARN, lineHeight: 1.4 }}>
                {t.text}
              </Typography>
            );
          case 'text':
            return (
              <Typography key={i} sx={{ px: INSPECTOR_ROW_PX, fontSize: FS.label, color: INK_MID, lineHeight: 1.4 }}>
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
                <InspectorRow key={i} label={label} labelTitle={label} labelColor={INK_LOW} alignField="end">
                  <SignalBadge direction={info?.direction ?? 'unknown'} plcType={info?.plcType} raw={info?.raw} viewer={viewer} signalName={sigName} />
                </InspectorRow>
              );
            }
            return (
              <InspectorRow key={i} label={label} labelTitle={label} labelColor={INK_LOW}>
                <Typography sx={{ fontSize: FS.label, color: INK_HIGH, fontFamily: MONO, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.text}</Typography>
              </InspectorRow>
            );
          }
          case 'signal': {
            const info = signalValues.get(t.text);
            return (
              <InspectorRow key={i} label={t.text} labelTitle={t.text} labelColor={INK_LOW} alignField="end">
                <SignalBadge direction={info?.direction ?? 'unknown'} plcType={info?.plcType} raw={info?.raw} viewer={viewer} signalName={t.text} />
              </InspectorRow>
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
                sx={{ px: INSPECTOR_ROW_PX, fontSize: FS.label, color: LINK, textDecoration: 'underline', cursor: 'pointer', pointerEvents: 'auto' }}
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
