// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Safe, dependency-free report parsing and declarative chart validation. */

import { CHART_SERIES_PALETTE, createBaseChartOption } from '../../core/hmi/chart-theme';
import {
  isSafeHttpUrl,
  parseSafeMarkdown,
  type SafeMarkdownBlock as CoreSafeMarkdownBlock,
  type SafeMarkdownInlineNode,
} from '../../core/hmi/safe-markdown';
import type { AgentReportSource } from './agent-provider';

export { isSafeHttpUrl } from '../../core/hmi/safe-markdown';

export const MAX_CHART_BYTES = 64 * 1024;
export const MAX_CHART_SERIES = 8;
export const MAX_CHART_POINTS = 500;
export const MAX_CHART_STRING = 160;
export const ALLOWED_CHART_TYPES = ['line', 'bar', 'scatter', 'table'] as const;

export type AllowedChartType = typeof ALLOWED_CHART_TYPES[number];

export interface AgentChartSeries {
  name: string;
  data: number[];
}

export interface AgentChartTable {
  columns: string[];
  rows: Array<Array<string | number | null>>;
}

export interface ValidatedAgentChart {
  type: AllowedChartType;
  title: string;
  labels: string[];
  series: AgentChartSeries[];
  table: AgentChartTable;
  fallback: boolean;
  warnings: string[];
}

export interface AgentChartRenderModel {
  kind: 'echarts' | 'table';
  option?: Record<string, unknown>;
  table?: AgentChartTable;
  title: string;
  warnings: string[];
}

export type SafeInlineNode =
  | SafeMarkdownInlineNode
  | { kind: 'source'; text: string; id: string; href?: string };

export type SafeMarkdownBlock =
  | { kind: 'heading'; level: 1 | 2 | 3; children: SafeInlineNode[] }
  | { kind: 'paragraph'; children: SafeInlineNode[] }
  | { kind: 'list'; items: SafeInlineNode[][] };

/** Parses headings, unordered lists, paragraphs, bold, safe links, and source IDs only. */
export function parseAgentMarkdown(
  markdown: string,
  sources: AgentReportSource[] = [],
): SafeMarkdownBlock[] {
  const sourceMap = new Map(
    sources
      .filter((source) => isSafeSourceId(source.id))
      .map((source) => [source.id, source] as const),
  );
  return parseSafeMarkdown(markdown).map((block) => extendBlockWithSources(block, sourceMap));
}

export function isSafeSourceId(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

/** Validates/caps untrusted chart JSON and never returns non-finite numeric data. */
export function validateAgentChartSpec(raw: unknown): ValidatedAgentChart {
  const warnings: string[] = [];
  if (!isRecord(raw)) return fallbackTable('Invalid chart', raw, ['Chart spec must be an object.']);
  if (estimateBytes(raw) > MAX_CHART_BYTES) {
    return fallbackTable('Chart rejected', null, [`Chart exceeds ${MAX_CHART_BYTES} bytes.`]);
  }

  const requestedType = stringValue(raw.type, 32).toLowerCase();
  const title = stringValue(raw.title, MAX_CHART_STRING);
  if (!ALLOWED_CHART_TYPES.includes(requestedType as AllowedChartType)) {
    return fallbackTable(title || 'Unsupported chart', raw, [`Unsupported chart type: ${requestedType || '(missing)'}.`]);
  }
  if (requestedType === 'table') return validateTable(raw, title, warnings);

  const labels = arrayValue(raw.labels ?? raw.xAxis)
    .slice(0, MAX_CHART_POINTS)
    .map((value) => stringValue(value, MAX_CHART_STRING));
  if (arrayValue(raw.labels ?? raw.xAxis).length > MAX_CHART_POINTS) {
    warnings.push(`Labels capped at ${MAX_CHART_POINTS}.`);
  }

  const series: AgentChartSeries[] = [];
  const rawSeries = arrayValue(raw.series);
  if (rawSeries.length > MAX_CHART_SERIES) warnings.push(`Series capped at ${MAX_CHART_SERIES}.`);
  for (const [index, candidate] of rawSeries.slice(0, MAX_CHART_SERIES).entries()) {
    if (!isRecord(candidate)) {
      warnings.push(`Series ${index + 1} rejected.`);
      continue;
    }
    const values = arrayValue(candidate.data);
    if (values.length > MAX_CHART_POINTS) warnings.push(`Series ${index + 1} capped at ${MAX_CHART_POINTS} points.`);
    const finite = values.slice(0, MAX_CHART_POINTS).filter(
      (value): value is number => typeof value === 'number' && Number.isFinite(value),
    );
    if (finite.length !== Math.min(values.length, MAX_CHART_POINTS)) {
      warnings.push(`Series ${index + 1} contains rejected non-finite values.`);
    }
    series.push({
      name: stringValue(candidate.name, MAX_CHART_STRING) || `Series ${index + 1}`,
      data: finite,
    });
  }

  if (series.length === 0) return fallbackTable(title || 'Chart', raw, [...warnings, 'No valid series.']);
  return {
    type: requestedType as Exclude<AllowedChartType, 'table'>,
    title,
    labels,
    series,
    table: seriesTable(labels, series),
    fallback: false,
    warnings,
  };
}

export function agentChartToRenderModel(raw: unknown): AgentChartRenderModel {
  const chart = validateAgentChartSpec(raw);
  if (chart.type === 'table' || chart.fallback) {
    return { kind: 'table', table: chart.table, title: chart.title, warnings: chart.warnings };
  }
  const base = createBaseChartOption({
    title: chart.title || undefined,
    legendData: chart.series.map((series) => series.name),
    scrollLegend: chart.series.length > 4,
  });
  return {
    kind: 'echarts',
    title: chart.title,
    warnings: chart.warnings,
    option: {
      ...base,
      xAxis: { ...(base.xAxis as Record<string, unknown>), data: chart.labels },
      series: chart.series.map((series, index) => ({
        name: series.name,
        type: chart.type,
        data: series.data,
        symbolSize: chart.type === 'scatter' ? 7 : undefined,
        showSymbol: chart.type !== 'line' || series.data.length < 40,
        lineStyle: { width: 2 },
        itemStyle: { color: CHART_SERIES_PALETTE[index % CHART_SERIES_PALETTE.length] },
      })),
    },
  };
}

function extendBlockWithSources(
  block: CoreSafeMarkdownBlock,
  sourceMap: Map<string, AgentReportSource>,
): SafeMarkdownBlock {
  if (block.kind === 'list') {
    return {
      kind: 'list',
      items: block.items.map((item) => extendInlineWithSources(item, sourceMap)),
    };
  }
  return {
    ...block,
    children: extendInlineWithSources(block.children, sourceMap),
  };
}

function extendInlineWithSources(
  nodes: SafeMarkdownInlineNode[],
  sourceMap: Map<string, AgentReportSource>,
): SafeInlineNode[] {
  return nodes.flatMap((node) => {
    if (node.kind !== 'text') return [node];
    return parseSourceTokens(node.text, sourceMap);
  });
}

function parseSourceTokens(value: string, sourceMap: Map<string, AgentReportSource>): SafeInlineNode[] {
  const token = /\[\[source:[^\]]+\]\]/g;
  const nodes: SafeInlineNode[] = [];
  let cursor = 0;
  for (const match of value.matchAll(token)) {
    const index = match.index ?? 0;
    if (index > cursor) nodes.push({ kind: 'text', text: value.slice(cursor, index) });
    const raw = match[0];
    const id = raw.slice(9, -2).trim();
    const source = sourceMap.get(id);
    const href = source?.url && isSafeHttpUrl(source.url) ? source.url : undefined;
    nodes.push(href
      ? { kind: 'source', id, text: source?.title || id, href }
      : { kind: 'source', id, text: source?.title || id });
    cursor = index + raw.length;
  }
  if (cursor < value.length) nodes.push({ kind: 'text', text: value.slice(cursor) });
  return nodes;
}

function validateTable(raw: Record<string, unknown>, title: string, warnings: string[]): ValidatedAgentChart {
  const rawColumns = arrayValue(raw.columns);
  const columns = rawColumns.slice(0, MAX_CHART_SERIES).map((value) => stringValue(value, MAX_CHART_STRING));
  if (rawColumns.length > MAX_CHART_SERIES) warnings.push(`Columns capped at ${MAX_CHART_SERIES}.`);
  const rawRows = arrayValue(raw.rows);
  if (rawRows.length > MAX_CHART_POINTS) warnings.push(`Rows capped at ${MAX_CHART_POINTS}.`);
  const rows = rawRows.slice(0, MAX_CHART_POINTS).map((row) => arrayValue(row)
    .slice(0, Math.max(columns.length, 1))
    .map(safeCell));
  return {
    type: 'table', title, labels: [], series: [],
    table: { columns, rows }, fallback: false, warnings,
  };
}

function seriesTable(labels: string[], series: AgentChartSeries[]): AgentChartTable {
  const rowCount = Math.max(labels.length, ...series.map((entry) => entry.data.length));
  return {
    columns: ['Label', ...series.map((entry) => entry.name)],
    rows: Array.from({ length: Math.min(rowCount, MAX_CHART_POINTS) }, (_, index) => [
      labels[index] ?? String(index + 1),
      ...series.map((entry) => entry.data[index] ?? null),
    ]),
  };
}

function fallbackTable(
  title: string,
  raw: unknown,
  warnings: string[],
): ValidatedAgentChart {
  const rows: Array<Array<string | number | null>> = [];
  if (isRecord(raw)) {
    for (const [key, value] of Object.entries(raw).slice(0, MAX_CHART_POINTS)) {
      rows.push([stringValue(key, MAX_CHART_STRING), safeCell(value)]);
    }
  }
  if (rows.length === 0) rows.push(['Status', warnings[0] ?? 'No chart data']);
  return {
    type: 'table', title: stringValue(title, MAX_CHART_STRING), labels: [], series: [],
    table: { columns: ['Field', 'Value'], rows }, fallback: true, warnings,
  };
}

function estimateBytes(value: unknown): number {
  try {
    return new TextEncoder().encode(JSON.stringify(value)).byteLength;
  } catch {
    return Number.POSITIVE_INFINITY;
  }
}

function safeCell(value: unknown): string | number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') return stringValue(value, MAX_CHART_STRING);
  if (typeof value === 'boolean') return String(value);
  if (value == null) return null;
  try {
    return stringValue(JSON.stringify(value), MAX_CHART_STRING);
  } catch {
    return '[unavailable]';
  }
}

function stringValue(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
