// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Safe React renderer for agent Markdown subsets and validated ECharts specs. */

import { Fragment, useEffect } from 'react';
import {
  Alert,
  Box,
  Link,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useEChart } from '../../hooks/use-echart';
import type { AgentRunResult } from './agent-provider';
import {
  agentChartToRenderModel,
  isSafeHttpUrl,
  parseAgentMarkdown,
  type AgentChartRenderModel,
  type SafeInlineNode,
} from './agent-report';

export interface AgentReportViewProps {
  result: AgentRunResult;
}

export function AgentReportView({ result }: AgentReportViewProps) {
  const blocks = parseAgentMarkdown(result.markdown, result.sources);
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pb: 1 }}>
      <Box sx={{ maxWidth: '72ch' }}>
        {blocks.map((block, index) => {
          if (block.kind === 'heading') {
            const fontSize = block.level === 1 ? 17 : block.level === 2 ? 15 : 13;
            return (
              <Typography key={index} component={`h${block.level}`} sx={{ fontSize, fontWeight: 600, mt: index ? 1.5 : 0, mb: 0.5 }}>
                <InlineNodes nodes={block.children} />
              </Typography>
            );
          }
          if (block.kind === 'list') {
            return (
              <Box key={index} component="ul" sx={{ my: 0.75, pl: 2.5 }}>
                {block.items.map((item, itemIndex) => (
                  <Typography key={itemIndex} component="li" sx={{ fontSize: 13, lineHeight: 1.55, mb: 0.25 }}>
                    <InlineNodes nodes={item} />
                  </Typography>
                ))}
              </Box>
            );
          }
          return (
            <Typography key={index} component="p" sx={{ fontSize: 13, lineHeight: 1.55, my: 0.75, color: 'text.primary' }}>
              <InlineNodes nodes={block.children} />
            </Typography>
          );
        })}
      </Box>
      {result.charts.map((chart, index) => (
        <AgentReportChart key={index} model={agentChartToRenderModel(chart)} />
      ))}
      {result.sources.length > 0 && (
        <Box component="section" aria-label="Report sources" sx={{ pt: 0.5 }}>
          <Typography sx={{ fontSize: 11, fontWeight: 600, color: 'text.secondary', mb: 0.5 }}>Sources</Typography>
          {result.sources.map((source) => (
            <Typography key={source.id} sx={{ fontSize: 11, fontFamily: 'monospace', color: 'text.secondary' }}>
              {source.url && isSafeHttpUrl(source.url) ? (
                <Link href={source.url} target="_blank" rel="noopener noreferrer" color="primary.main">
                  {source.title || source.id}
                </Link>
              ) : source.title || source.id}
            </Typography>
          ))}
        </Box>
      )}
    </Box>
  );
}

function InlineNodes({ nodes }: { nodes: SafeInlineNode[] }) {
  return nodes.map((node, index) => {
    if (node.kind === 'strong') return <Box key={index} component="strong" sx={{ fontWeight: 600 }}>{node.text}</Box>;
    if (node.kind === 'link' || (node.kind === 'source' && node.href)) {
      return (
        <Link key={index} href={node.href} target="_blank" rel="noopener noreferrer" color="primary.main">
          {node.text}
        </Link>
      );
    }
    return <Fragment key={index}>{node.text}</Fragment>;
  });
}

function AgentReportChart({ model }: { model: AgentChartRenderModel }) {
  const { containerRef, chartInstance, isReady } = useEChart({ open: model.kind === 'echarts' });
  useEffect(() => {
    if (!isReady || !model.option) return;
    chartInstance.current?.setOption(model.option, { notMerge: true });
  }, [chartInstance, isReady, model.option]);

  return (
    <Box sx={{ border: '1px solid rgba(255,255,255,0.08)', borderRadius: '4px', p: 1, minWidth: 0 }}>
      {model.kind === 'echarts' ? (
        <Box ref={containerRef} sx={{ height: 240, minWidth: 0 }} aria-label={model.title || 'Agent report chart'} />
      ) : (
        <AgentReportTable model={model} />
      )}
      {model.warnings.length > 0 && (
        <Alert severity="warning" variant="outlined" sx={{ mt: 1, py: 0, '& .MuiAlert-message': { fontSize: 11 } }}>
          {model.warnings.join(' ')}
        </Alert>
      )}
    </Box>
  );
}

function AgentReportTable({ model }: { model: AgentChartRenderModel }) {
  const table = model.table ?? { columns: [], rows: [] };
  return (
    <TableContainer sx={{ maxHeight: 260 }}>
      {model.title && <Typography sx={{ fontSize: 12, fontWeight: 600, mb: 0.5 }}>{model.title}</Typography>}
      <Table size="small" stickyHeader aria-label={model.title || 'Agent report table'}>
        <TableHead>
          <TableRow>
            {table.columns.map((column, index) => <TableCell key={index} sx={{ fontSize: 11 }}>{column}</TableCell>)}
          </TableRow>
        </TableHead>
        <TableBody>
          {table.rows.map((row, rowIndex) => (
            <TableRow key={rowIndex}>
              {row.map((cell, cellIndex) => (
                <TableCell key={cellIndex} sx={{ fontSize: 11, fontFamily: typeof cell === 'number' ? 'monospace' : undefined }}>
                  {cell ?? '—'}
                </TableCell>
              ))}
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </TableContainer>
  );
}
