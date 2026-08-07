// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Safe React renderer for the dependency-free HMI Markdown subset. */

import { Fragment } from 'react';
import { Box, Link, Typography } from '@mui/material';
import type { SafeMarkdownBlock, SafeMarkdownInlineNode } from './safe-markdown';

export interface SafeMarkdownProps {
  blocks: SafeMarkdownBlock[];
}

export function SafeMarkdown({ blocks }: SafeMarkdownProps) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75 }}>
      {blocks.map((block, index) => {
        if (block.kind === 'heading') {
          const fontSize = block.level === 1 ? 17 : block.level === 2 ? 15 : 13;
          return (
            <Typography
              key={index}
              component={`h${block.level}`}
              sx={{ fontSize, fontWeight: 600, lineHeight: 1.4, mt: index ? 1 : 0, mb: 0.25 }}
            >
              <SafeInlineNodes nodes={block.children} />
            </Typography>
          );
        }
        if (block.kind === 'list') {
          return (
            <Box key={index} component="ul" sx={{ my: 0.5, pl: 2.5 }}>
              {block.items.map((item, itemIndex) => (
                <Typography
                  key={itemIndex}
                  component="li"
                  sx={{ fontSize: 13, lineHeight: 1.55, mb: 0.25 }}
                >
                  <SafeInlineNodes nodes={item} />
                </Typography>
              ))}
            </Box>
          );
        }
        return (
          <Typography
            key={index}
            component="p"
            sx={{ fontSize: 13, lineHeight: 1.6, my: 0.5, color: 'text.primary' }}
          >
            <SafeInlineNodes nodes={block.children} />
          </Typography>
        );
      })}
    </Box>
  );
}

function SafeInlineNodes({ nodes }: { nodes: SafeMarkdownInlineNode[] }) {
  return nodes.map((node, index) => {
    if (node.kind === 'strong') {
      return <Box key={index} component="strong" sx={{ fontWeight: 600 }}>{node.text}</Box>;
    }
    if (node.kind === 'link') {
      return (
        <Link
          key={index}
          href={node.href}
          target="_blank"
          rel="noopener noreferrer"
          color="primary.main"
        >
          {node.text}
        </Link>
      );
    }
    return <Fragment key={index}>{node.text}</Fragment>;
  });
}
