// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-doc-render — the tool reference, rendered from the decorators (plan-707 part b).
 *
 * The guides and the server instruction are worth their length because a human
 * wrote the ORDER and the pitfalls into them, and no generator can do that.
 * What a generator can do — and a human reliably fails at — is keep the
 * INVENTORY true: which tools exist, in which family, taking which parameters.
 *
 * So only the inventory is generated, into fenced blocks:
 *
 *     <!-- BEGIN GENERATED: tool-reference editor — … -->
 *     …table…
 *     <!-- END GENERATED: tool-reference editor -->
 *
 * Everything outside a marker pair is untouchable, and a missing marker is an
 * ERROR rather than a silent append — a generator that quietly appends is how a
 * document ends up with two contradictory tables.
 *
 * ── Two renderings, because the two audiences pay differently ──────────────
 *
 * `webviewer.mcp.md` is the server INSTRUCTION: every agent loads it on
 * connect, whether or not it will ever author an asset. It therefore gets the
 * compact domain roster — names and counts, no parameters. The five `help/*.md`
 * guides are served on demand through `web_help(topic)`, so an agent pays for
 * that detail only when it has already decided to do the work; they get the
 * full per-tool table.
 *
 * This module is a PURE function of the schemas: no viewer, no DOM, no fs, no
 * clock, no randomness, and a fixed sort everywhere. That is not tidiness, it
 * is what makes the drift gate trustworthy — a generator whose output varies
 * between runs produces a flapping test, and a flapping gate gets switched off.
 */

import type { ToolSchema } from '../../core/engine/rv-mcp-tools';

/** One generated block: the marker id and the body that belongs between the fences. */
export interface DocBlock {
  marker: string;
  body: string;
}

type Renderer = (schemas: readonly ToolSchema[]) => string;

interface FamilySpec {
  /** Marker id — must match the fences in the target file. */
  marker: string;
  /** The file that carries this block (used by the writer and the drift gate). */
  file: string;
  /** Membership test over the tool name. */
  match: (name: string) => boolean;
  render: Renderer;
}

const startsWithAny = (name: string, prefixes: string[]): boolean =>
  prefixes.some((p) => name.startsWith(p));

/** Tools with no domain segment — the same set the convention lint allows. */
const ROOT = '(root)';

/** `web_editor_open` → `editor`; `web_status` → `(root)`. */
export function domainOf(name: string): string {
  const m = /^web_([a-z0-9]+)(?:_[a-z0-9_]+)?$/.exec(name);
  if (!m) return ROOT;
  // A bare `web_<domain>` IS that domain's primary action (web_select,
  // web_screenshot); a bare root tool (web_status) has no second segment and
  // no family, and the lint's ROOT_TOOLS list is the arbiter of which is which.
  const ROOT_NAMES = new Set([
    'web_status', 'web_logs', 'web_errors', 'web_help',
    'web_measure', 'web_render', 'web_describe',
    // plan-716 Phase 5: `McpProjectTools` joined the shared instance list and
    // brought its throttle probe with it. Root-level like `web_status` — "is
    // the tab alive" belongs to no family, and a one-tool `ping` domain in the
    // roster would advertise a family that does not exist.
    'web_ping',
  ]);
  return ROOT_NAMES.has(name) ? ROOT : m[1];
}

// ─── Renderers ──────────────────────────────────────────────────────────

/** `web_editor_import_glb` → ``` `relPath` string **req**, `replace` boolean ```. */
function renderParams(schema: ToolSchema): string {
  const props = schema.inputSchema?.properties ?? {};
  const required = new Set(schema.inputSchema?.required ?? []);
  const names = Object.keys(props);
  if (names.length === 0) return '—';
  return names
    .map((n) => `\`${n}\` ${props[n].type}${required.has(n) ? ' **req**' : ''}`)
    .join(', ');
}

/**
 * The one-line summary: the first sentence of the description.
 *
 * The full description already travels with the tool in `tools/list` — a
 * reference that reprints all of it doubles the maintenance surface and reads
 * worse than the list it duplicates.
 */
const SUMMARY_MIN = 45;
const SUMMARY_MAX = 170;

function summarise(description: string): string {
  const flat = description.replace(/\s+/g, ' ').trim();

  // Cut at a sentence end, and only at a real one. A colon is NOT a boundary:
  // these descriptions routinely open with "Asset editor status: …", and
  // cutting there leaves a heading where a summary should be. A period inside
  // parentheses is not one either — "(one scan per 60 Hz tick: … write)" must
  // survive intact. And a first sentence too short to say anything ("Jog a
  // drive.") pulls in the next one rather than standing alone.
  let depth = 0;
  let cut = -1;
  for (let i = 0; i < flat.length; i++) {
    const c = flat[i];
    if (c === '(' || c === '[') depth++;
    else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
    else if (c === '.' && depth === 0 && (i + 1 >= flat.length || flat[i + 1] === ' ')) {
      if (i + 1 >= SUMMARY_MIN) { cut = i + 1; break; }
    }
  }
  const first = (cut === -1 ? flat : flat.slice(0, cut)).trim();
  const capped = first.length > SUMMARY_MAX ? `${first.slice(0, SUMMARY_MAX - 1).trimEnd()}…` : first;
  // A pipe would break out of the markdown table cell.
  return capped.replace(/\|/g, '\\|');
}

/** `readOnly` / `write`, straight from the announced annotation. */
function accessOf(schema: ToolSchema): string {
  if (schema.annotations?.readOnlyHint === true) return 'read';
  if (schema.annotations?.readOnlyHint === false) return 'write';
  return '?';
}

/** Full per-tool table — for the on-demand guides. */
const renderToolTable: Renderer = (schemas) => {
  const rows = schemas.map((s) =>
    `| \`${s.name}\` | ${accessOf(s)} | ${renderParams(s)} | ${summarise(s.description)} |`);
  return [
    `_${schemas.length} tool${schemas.length === 1 ? '' : 's'} in this family, generated from the`
    + ' @McpTool decorators — do not edit by hand._',
    '',
    '| Tool | Access | Parameters | Summary |',
    '|------|--------|------------|---------|',
    ...(rows.length > 0 ? rows : ['| _none_ | | | |']),
  ].join('\n');
};

/** Compact roster grouped by domain — for the always-loaded instruction. */
const renderDomainRoster: Renderer = (schemas) => {
  const byDomain = new Map<string, string[]>();
  for (const s of schemas) {
    const d = domainOf(s.name);
    if (!byDomain.has(d)) byDomain.set(d, []);
    byDomain.get(d)!.push(s.name);
  }
  // Fixed order: the root pseudo-domain first, then alphabetical. Map insertion
  // order would make the output depend on schema order, which is exactly the
  // kind of hidden input that turns a gate into a coin flip.
  const domains = [...byDomain.keys()].sort((a, b) => {
    if (a === ROOT) return -1;
    if (b === ROOT) return 1;
    return a.localeCompare(b);
  });
  const rows = domains.map((d) => {
    const names = [...byDomain.get(d)!].sort((a, b) => a.localeCompare(b));
    return `| \`${d}\` | ${names.length} | ${names.map((n) => `\`${n}\``).join(', ')} |`;
  });
  return [
    `_${schemas.length} tools across ${domains.length} domains, generated from the @McpTool`
    + ' decorators — do not edit by hand. Purpose and workflow live in the prose above and in'
    + ' `web_help(topic)`._',
    '',
    '| Domain | # | Tools |',
    '|--------|---|-------|',
    ...rows,
  ].join('\n');
};

// ─── The family map ─────────────────────────────────────────────────────

/**
 * Which block goes where.
 *
 * The families are NOT mutually exclusive, on purpose: `tool-domains` matches
 * everything, so the instruction's roster is the one place completeness can be
 * asserted, while each guide additionally carries its own family in detail. A
 * partition would put completeness in six places at once.
 */
export const DOC_FAMILIES: readonly FamilySpec[] = [
  {
    marker: 'tool-domains',
    file: 'webviewer.mcp.md',
    match: () => true,
    render: renderDomainRoster,
  },
  {
    marker: 'tool-reference editor',
    file: 'src/plugins/mcp-bridge/help/editor.md',
    match: (n) => n.startsWith('web_editor_'),
    render: renderToolTable,
  },
  {
    marker: 'tool-reference layout',
    file: 'src/plugins/mcp-bridge/help/layout.md',
    // web_scene_ still matches web_scene_query; the document and catalog
    // families replaced the old web_library_/web_model_/web_scene_* verbs.
    match: (n) => startsWithAny(n, ['web_layout_', 'web_catalog_', 'web_document_', 'web_scene_']),
    render: renderToolTable,
  },
  {
    marker: 'tool-reference simulation',
    file: 'src/plugins/mcp-bridge/help/simulation.md',
    match: (n) => startsWithAny(n, ['web_drive_', 'web_signal_', 'web_sensor_', 'web_sim_',
      'web_transport_', 'web_logic_']),
    render: renderToolTable,
  },
  {
    marker: 'tool-reference plc',
    file: 'src/plugins/mcp-bridge/help/plc.md',
    match: (n) => n.startsWith('web_plc_'),
    render: renderToolTable,
  },
  {
    marker: 'tool-reference des',
    file: 'src/plugins/mcp-bridge/help/des.md',
    match: (n) => n.startsWith('web_des_'),
    render: renderToolTable,
  },
];

/**
 * Render every generated block from the schemas.
 *
 * Deterministic by construction: the families are a fixed list, the tools
 * inside each are sorted by name, domains are sorted explicitly, and nothing
 * consults a clock or relies on Map iteration order for output. Two calls with
 * the same input produce identical output — asserted directly by the gate.
 */
export function renderDocBlocks(schemas: readonly ToolSchema[]): DocBlock[] {
  return DOC_FAMILIES.map((f) => {
    const list = schemas
      .filter((s) => f.match(s.name))
      .sort((a, b) => a.name.localeCompare(b.name));
    return { marker: f.marker, body: f.render(list) };
  });
}

// ─── Marker handling ────────────────────────────────────────────────────

const BEGIN_HINT = 'do not edit; run `npm run gen:mcp-docs`';

/** The opening fence for a marker, including the maintainer hint. */
export function beginMarker(marker: string): string {
  return `<!-- BEGIN GENERATED: ${marker} — ${BEGIN_HINT} -->`;
}

/** The closing fence for a marker. */
export function endMarker(marker: string): string {
  return `<!-- END GENERATED: ${marker} -->`;
}

/**
 * Locate a marker pair. Returns the slice indices of the BODY between them.
 *
 * The begin fence is matched by its `BEGIN GENERATED: <marker> ` prefix rather
 * than in full, so the hint text can be reworded without invalidating every
 * checked-in file at once.
 */
function locate(source: string, marker: string): { bodyStart: number; bodyEnd: number } | null {
  const beginPrefix = `<!-- BEGIN GENERATED: ${marker} `;
  const end = endMarker(marker);
  const beginAt = source.indexOf(beginPrefix);
  if (beginAt === -1) return null;
  const beginEnd = source.indexOf('-->', beginAt);
  if (beginEnd === -1) return null;
  const endAt = source.indexOf(end, beginEnd);
  if (endAt === -1) return null;
  return { bodyStart: beginEnd + 3, bodyEnd: endAt };
}

/**
 * The current content of a marker block, or `null` when the marker is absent.
 *
 * Line endings are NORMALISED to `\n`. On Windows any git operation — a
 * checkout, a `stash pop`, an `autocrlf` conversion — can rewrite a checked-in
 * file to CRLF without a single character of content changing. The renderer
 * emits `\n`, so without this the gate would go red for a reason that is not
 * documentation drift, and a gate that cries wolf gets switched off. It reports
 * on CONTENT; the file's line-ending convention is git's business.
 */
export function extractBlock(source: string, marker: string): string | null {
  const at = locate(source, marker);
  if (!at) return null;
  return source.slice(at.bodyStart, at.bodyEnd).replace(/\r\n/g, '\n').trim();
}

/**
 * Replace exactly one marker block, leaving every byte outside it alone.
 *
 * THROWS when the marker pair is missing. A generator that appends to a file it
 * does not recognise is worse than one that stops: the prose it was supposed to
 * protect then sits next to a second, contradictory table.
 */
export function replaceBlock(source: string, block: DocBlock): string {
  const at = locate(source, block.marker);
  if (!at) {
    throw new Error(
      `Marker pair for "${block.marker}" not found. Add\n`
      + `  ${beginMarker(block.marker)}\n  ${endMarker(block.marker)}\n`
      + 'to the file — the generator never appends to a file it does not recognise.',
    );
  }
  return `${source.slice(0, at.bodyStart)}\n${block.body}\n${source.slice(at.bodyEnd)}`;
}
