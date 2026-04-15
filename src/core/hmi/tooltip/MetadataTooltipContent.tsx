// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MetadataTooltipContent — Renders RuntimeMetadata content (name, values,
 * signals, links) inside the generic TooltipLayer.
 *
 * Parses the XML-like content string exported from Unity's RuntimeMetadata
 * component and renders each tag as appropriate UI elements.
 *
 * Supported tags (matching Unity's RuntimeMetadata.cs):
 *   <name>display name</name>       — primary display name (bold header)
 *   <bold>section header</bold>     — bold section header
 *   <text>paragraph</text>          — plain text
 *   <value label="Label">text</value> — labeled value row (static)
 *   <link url="url">click text</link> — button (relative URL = doc link, absolute = web link)
 *   <signal>signalName</signal>     — labeled value row bound to live signal value
 */

import { useMemo } from 'react';
import { Box, Typography, Button } from '@mui/material';
import OpenInNewIcon from '@mui/icons-material/OpenInNew';
import { SignalRow, useSignalValues } from '../rv-signal-badge';
import type { TooltipContentProps } from './tooltip-registry';
import { tooltipRegistry } from './tooltip-registry';
import type { TooltipData } from './tooltip-store';
const DOC_BASE_URL = 'https://doc.realvirtual.io/';

/** Data shape for metadata tooltips. */
export interface MetadataTooltipData extends TooltipData {
  type: 'metadata';
  nodePath: string;
  content: string;
}

// ── Content parsing ──

export interface ParsedTag {
  tag: string;
  attributes: string;
  text: string;
}

const TAG_RE = /<(\w+)(?:\s+([^>]+))?>([^]*?)<\/\1>/g;
const ATTR_RE = /(\w+)=["']([^"']*)["']/g;

export function parseTags(content: string): ParsedTag[] {
  const tags: ParsedTag[] = [];
  let lastIndex = 0;
  let match: RegExpExecArray | null;
  TAG_RE.lastIndex = 0;
  while ((match = TAG_RE.exec(content)) !== null) {
    // Capture plain text before this tag
    if (match.index > lastIndex) {
      const plain = content.slice(lastIndex, match.index).trim();
      if (plain) {
        tags.push({ tag: 'text', attributes: '', text: plain });
      }
    }
    tags.push({ tag: match[1].toLowerCase(), attributes: match[2] ?? '', text: match[3].trim() });
    lastIndex = match.index + match[0].length;
  }
  // Capture trailing plain text after the last tag
  if (lastIndex < content.length) {
    const plain = content.slice(lastIndex).trim();
    if (plain) {
      tags.push({ tag: 'text', attributes: '', text: plain });
    }
  }
  return tags;
}

export function extractAttr(attributes: string, name: string): string | null {
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(attributes)) !== null) {
    if (match[1] === name) return match[2];
  }
  return null;
}

/**
 * Resolve a link URL. Relative URLs are prefixed with the documentation base URL
 * (matching Unity's RuntimeMetadata behavior where relative = doc link).
 */
function resolveUrl(url: string): string {
  if (url.startsWith('http://') || url.startsWith('https://')) {
    return url;
  }
  return `${DOC_BASE_URL}${url}`;
}

// ── Row helper ──

function Row({ label, value }: { label: string; value: string }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', gap: 2, minHeight: 18 }}>
      <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.5)', fontSize: 11, whiteSpace: 'nowrap' }}>
        {label}
      </Typography>
      <Typography variant="caption" sx={{ color: '#fff', fontSize: 11, textAlign: 'right' }}>
        {value}
      </Typography>
    </Box>
  );
}

// ── Link button ──

function LinkButton({ url, text }: { url: string; text: string }) {
  const resolved = resolveUrl(url);
  const isDoc = !url.startsWith('http://') && !url.startsWith('https://');

  return (
    <Button
      size="small"
      variant="text"
      href={resolved}
      target="_blank"
      rel="noopener noreferrer"
      endIcon={<OpenInNewIcon sx={{ fontSize: '12px !important' }} />}
      sx={{
        pointerEvents: 'auto',
        color: isDoc ? '#64b5f6' : '#81c784',
        fontSize: 11,
        textTransform: 'none',
        px: 1,
        py: 0.25,
        minHeight: 24,
        justifyContent: 'flex-start',
        width: '100%',
        border: '1px solid',
        borderColor: isDoc ? 'rgba(100,181,246,0.3)' : 'rgba(129,199,132,0.3)',
        borderRadius: 0.5,
        '&:hover': {
          bgcolor: isDoc ? 'rgba(100,181,246,0.1)' : 'rgba(129,199,132,0.1)',
        },
      }}
    >
      {text}
    </Button>
  );
}

// ── Content provider ──

export function MetadataTooltipContent({ data, viewer }: TooltipContentProps<MetadataTooltipData>) {
  const tags = useMemo(() => parseTags(data.content), [data.content]);

  // Collect signal names for live binding — both top-level <signal> tags
  // and nested <signal> inside <value> tags
  const signalNames = useMemo(() => {
    const names: string[] = [];
    const nestedRe = /<signal>([^<]*)<\/signal>/g;
    for (const t of tags) {
      if (t.tag === 'signal') {
        names.push(t.text);
      } else if (t.tag === 'value') {
        // Check for nested <signal> inside value text
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

  if (tags.length === 0) return null;

  return (
    <>
      {tags.map((t, i) => {
        switch (t.tag) {
          case 'name':
            return (
              <Typography
                key={i}
                variant="subtitle2"
                sx={{ color: '#ffa040', fontWeight: 700, fontSize: 13, lineHeight: 1.3, mb: 0.25 }}
              >
                {t.text}
              </Typography>
            );

          case 'bold':
            return (
              <Typography
                key={i}
                variant="subtitle2"
                sx={{
                  color: 'rgba(255,255,255,0.85)',
                  fontWeight: 700,
                  fontSize: 12,
                  lineHeight: 1.3,
                  mt: i > 0 ? 0.5 : 0,
                }}
              >
                {t.text}
              </Typography>
            );

          case 'text':
            return (
              <Typography
                key={i}
                variant="caption"
                sx={{
                  color: 'rgba(255,255,255,0.7)',
                  display: 'block',
                  fontSize: 11,
                  lineHeight: 1.4,
                  whiteSpace: 'pre-wrap',
                }}
              >
                {t.text}
              </Typography>
            );

          case 'value': {
            const label = extractAttr(t.attributes, 'label') ?? '';
            // Check for nested <signal> inside the value text
            const nestedSignalMatch = /<signal>([^<]*)<\/signal>/.exec(t.text);
            if (nestedSignalMatch) {
              const sigName = nestedSignalMatch[1];
              const info = signalValues.get(sigName);
              return <SignalRow key={i} label={label} direction={info?.direction ?? 'unknown'} plcType={info?.plcType} raw={info?.raw} />;
            }
            return <Row key={i} label={label} value={t.text} />;
          }

          case 'signal': {
            const info = signalValues.get(t.text);
            return <SignalRow key={i} label={t.text} direction={info?.direction ?? 'unknown'} raw={info?.raw} />;
          }

          case 'link': {
            const url = extractAttr(t.attributes, 'url') ?? '';
            return (
              <Box key={i} sx={{ mt: 0.25, mb: 0.25 }}>
                <LinkButton url={url} text={t.text} />
              </Box>
            );
          }

          default:
            return null;
        }
      })}
    </>
  );
}

// ── Self-registration ──
tooltipRegistry.register({
  contentType: 'metadata',
  component: MetadataTooltipContent as any,
});

// ── Data resolver for GenericTooltipController ──
tooltipRegistry.registerDataResolver('metadata', (node, viewer) => {
  const meta = node.userData?._rvMetadata as { content: string } | undefined;
  if (!meta?.content) return null;
  const path = viewer.registry?.getPathForNode(node) ?? '';
  return { type: 'metadata', nodePath: path, content: meta.content };
});

// ── Search resolver: extract text content from metadata tags (values only) ──
tooltipRegistry.registerSearchResolver('RuntimeMetadata', (node) => {
  const meta = node.userData?._rvMetadata as { content: string } | undefined;
  if (!meta?.content) return [];
  // Extract text from parsed tags — labels and values, not XML markup
  return parseTags(meta.content)
    .filter(t => t.text)
    .map(t => t.text);
});
