// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-tool-class — the tool CLASS of every MCP tool (plan-626 F1).
 *
 * A class is a property of the tool, not a decision: CONNECT reads it from the generated
 * `McpToolClassAllowlist.cs` and hands it to the call policy of the session, which decides
 * allow / deny / ask (the chat policy of plan-625 asks for everything but `read` and `edit`).
 *
 * The class is DERIVED, so the ~210 decorators do not each restate it (plan-626 decision
 * 2026-10-22): an explicit `toolClass` option wins, then `readOnly: true` ⇒ `read`, then
 * `destructive: true` ⇒ `destructive`, then the bound command's id prefix (plan-641 aliases),
 * then the name's domain. `tests/mcp-tool-class-convention.node.test.ts` prints the whole table
 * into the allowlist and fails when a write tool resolves to nothing.
 *
 * The class is deliberately NOT announced in `discover`: the browser is not trusted to say
 * what a tool may do (the allowlist wins anyway), and the catalogue has a payload budget.
 */

import type { McpToolClassName, ToolCommandBinding } from '../../core/engine/rv-mcp-tools';
import { parseBatchSteps } from './rv-mcp-command-tools';

function bindingIds(binding: ToolCommandBinding | undefined): string[] {
  if (!binding) return [];
  return typeof binding === 'string' ? [binding] : binding.branches.map((b) => b.id);
}

/** The tool classes (plan-626 F1). `unclassified` is the answer for a name nobody classified. */
export const MCP_TOOL_CLASSES = ['read', 'edit', 'sim', 'signal', 'save', 'destructive', 'file'] as const;
export type McpToolClass = McpToolClassName;

export const CLASS_RANK: readonly McpToolClass[] = ['read', 'edit', 'sim', 'signal', 'file', 'save', 'destructive'];

export function strictestClass(classes: Iterable<McpToolClass>): McpToolClass {
  let rank = -1;
  for (const cls of classes) rank = Math.max(rank, CLASS_RANK.indexOf(cls));
  return rank < 0 ? 'edit' : CLASS_RANK[rank];
}

export function commandClassOf(desc: { id: string; readOnly: boolean; destructive?: boolean; toolClass?: McpToolClass }): McpToolClass {
  if (desc.toolClass) return desc.toolClass;
  if (desc.readOnly) return 'read';
  if (desc.destructive) return 'destructive';
  if (/^(sim|des|mu|drive)\./.test(desc.id)) return 'sim';
  if (/^(signal|plc)\./.test(desc.id)) return 'signal';
  if (desc.id.startsWith('document.') || desc.id.startsWith('editor.import')) return 'file';
  return 'edit';
}

/** Canonical wire arguments shared with CONNECT's UnwrapArguments and class policy. */
export function commandIdsOfCall(tool: string, rawArgs: unknown): string[] | null {
  if (!['web_execute', 'web_query', 'web_batch'].includes(tool)) return [];
  let args = rawArgs;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    const obj = args as Record<string, unknown>;
    if (Object.keys(obj).length === 1 && typeof obj['kwargs'] === 'string') {
      try { args = JSON.parse(obj['kwargs']); } catch { return null; }
    }
  }
  if (!args || typeof args !== 'object' || Array.isArray(args)) return null;
  const obj = args as Record<string, unknown>;
  if (tool === 'web_batch') {
    const steps = parseBatchSteps(obj['steps']);
    return 'error' in steps ? null : steps.map((s) => s.command);
  }
  const id = typeof obj['command'] === 'string' ? obj['command'].trim() : '';
  return id ? [id] : null;
}

export function callClassOf(
  tool: string, rawArgs: unknown,
  classOfCommand: (id: string) => McpToolClass | undefined,
  toolClassOf: (name: string) => McpToolClass | undefined,
  macroReplayClass: McpToolClass,
): McpToolClass | 'unclassified' {
  if (tool === 'web_query') return 'read';
  if (tool === 'web_execute' || tool === 'web_batch') {
    const ids = commandIdsOfCall(tool, rawArgs);
    return ids === null ? 'destructive' : strictestClass(ids.map((id) => classOfCommand(id) ?? 'edit'));
  }
  if (tool === 'web_macro_replay') return macroReplayClass;
  return toolClassOf(tool) ?? 'unclassified';
}

/** What the resolver needs from a tool — a decorator entry or a dispatcher entry. */
export interface ToolClassInput {
  name: string;
  readOnly?: boolean;
  destructive?: boolean;
  toolClass?: McpToolClass;
  command?: ToolCommandBinding;
}

/**
 * Per-name overrides where the domain default would be wrong. Kept short on purpose —
 * a long list here means the domain table is wrong.
 */
const NAME_CLASS: Readonly<Record<string, McpToolClass>> = {
  // Writing the document file is the one step that makes an edit durable.
  web_document_save: 'save',
  web_editor_save: 'save',
  web_macro_save: 'save',
  // Imports read files from disk / the project folder into the document.
  web_editor_import_glb: 'file',
  web_editor_import_cad: 'file',
  // Video and screenshot bursts write files next to the project.
  web_record_video: 'file',
  // The reduced command interface runs model changes (plan-641) — its per-command class is the
  // registry's `readOnly`, which only the chat policy (plan-625) can look at per call.
  web_execute: 'edit',
  web_batch: 'edit',
  // Replaying a macro changes the model like the batch it is.
  web_macro_replay: 'edit',
  // Carriers taken off / set elsewhere on the running line (commissioning), bound to `mu.*`.
  web_mu_delete: 'sim',
  web_mu_move: 'sim',
  // Writes the CONNECT signal binding, not the document.
  web_editor_signal_set_binding: 'signal',
};

/** Command id prefix → class, for command-bound aliases (plan-641). */
const COMMAND_PREFIX_CLASS: Readonly<Record<string, McpToolClass>> = {
  sim: 'sim',
  signal: 'signal',
  document: 'file',
};

/** Domain (second name segment) → class. Every domain of the conventions lint must be here. */
const DOMAIN_CLASS: Readonly<Record<string, McpToolClass>> = {
  // Model and viewport authoring — the chat policy lets these run automatically.
  node: 'edit', component: 'edit', view: 'edit', camera: 'edit', select: 'edit', selection: 'edit',
  screenshot: 'edit', layout: 'edit', scene: 'edit', editor: 'edit', knowledge: 'edit', link: 'edit',
  prompt: 'edit', group: 'edit', collision: 'edit', macro: 'edit', check: 'edit', part: 'edit',
  logic: 'edit', mode: 'edit', catalog: 'edit', eye: 'edit',
  // plan-773: rigging a robot writes a RobotIK component — a model edit like any
  // other. The reading half of the family resolves to `read` through `readOnly`.
  robot: 'edit',
  // Running the plant.
  sim: 'sim', drive: 'sim', des: 'sim', transport: 'sim', sensor: 'sim', mu: 'sim', trace: 'sim',
  // Process image.
  signal: 'signal', plc: 'signal',
  // Files on disk / documents of the project.
  document: 'file', project: 'file', export: 'file', import: 'file', record: 'file',
};

/** Domain segment of `web_<domain>_<action>` (or of a root tool like `web_status`). */
function domainOf(name: string): string | undefined {
  return /^web_([a-z0-9]+)/.exec(name)?.[1];
}

/** Resolve the class of one tool; `undefined` = unclassified (the convention test forbids it for writes). */
export function resolveToolClass(input: ToolClassInput): McpToolClass | undefined {
  if (input.toolClass) return input.toolClass;
  if (input.readOnly === true) return 'read';
  if (input.destructive === true) return 'destructive';
  const named = NAME_CLASS[input.name];
  if (named) return named;
  const ids = bindingIds(input.command);
  if (ids.length > 0) {
    const classes = new Set(ids.map((id) => COMMAND_PREFIX_CLASS[id.split('.')[0]] ?? 'edit'));
    // A multiplexer whose branches disagree takes the strictest of them.
    for (const strict of ['destructive', 'file', 'signal', 'sim', 'save'] as const) if (classes.has(strict)) return strict;
    return 'edit';
  }
  const domain = domainOf(input.name);
  return domain ? DOMAIN_CLASS[domain] : undefined;
}

/**
 * The native CONNECT gateway tools (`GatewayTools.cs`) and CONNECT's own `web_*` tools — they
 * are classified here so ONE generated allowlist covers both dispatch branches (F2). The xUnit
 * drift test fails when `GatewayTools` gains a tool this list does not name.
 */
export const NATIVE_TOOL_CLASSES: Readonly<Record<string, McpToolClass>> = {
  signal_list: 'read',
  signal_read: 'read',
  interfaces_status: 'read',
  health: 'read',
  signal_set_bool: 'signal',
  signal_set_float: 'signal',
  signal_force: 'signal',
  signal_unforce: 'signal',
  // CONNECT-own (plan-626 F4/F6): answered by the gateway even without a browser.
  web_call_pending: 'read',
  web_status: 'read',
  // CONNECT config tools (interface / bridge lists and apply).
  interface_signal_list: 'read',
  interface_signals_apply: 'signal',
  bridge_list: 'read',
  bridges_apply: 'signal',
};

/** Render the C# allowlist (`McpToolClassAllowlist.cs`) for the given name → class table. */
export function renderToolClassAllowlist(table: ReadonlyMap<string, McpToolClass>): string {
  const rows = [...table.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const lines = rows.map(([name, cls]) => `        ["${name}"] = "${cls}",`);
  return [
    '// realvirtual CONNECT — Standalone Signal Gateway',
    '// Copyright(c) 2026 realvirtual GmbH',
    '//',
    '// GENERATED by realvirtual-WebViewer~/tests/mcp-tool-class-convention.node.test.ts',
    '// (npm run gen:mcp-docs). Do not edit by hand — change the class in',
    '// src/plugins/mcp-bridge/rv-mcp-tool-class.ts and regenerate.',
    '',
    'namespace realvirtual.Connect.Api.Mcp;',
    '',
    '/// <summary>',
    '/// Tool class of every known MCP tool (plan-626 F2) — web tools as the WebViewer source',
    '/// defines them and CONNECT\'s native tools. The class is what the call policy decides on;',
    '/// a browser cannot change it. A name missing here is <c>unclassified</c>.',
    '/// </summary>',
    'public static class McpToolClassAllowlist',
    '{',
    '    /// <summary>Class for names nobody classified.</summary>',
    '    public const string Unclassified = "unclassified";',
    '',
    '    /// <summary>Tool name → class.</summary>',
    '    public static readonly IReadOnlyDictionary<string, string> Classes = new Dictionary<string, string>(StringComparer.Ordinal)',
    '    {',
    ...lines,
    '    };',
    '',
    '    /// <summary>Returns the class of <paramref name="name"/>, or <see cref="Unclassified"/>.</summary>',
    '    public static string ClassOf(string name) => Classes.TryGetValue(name, out var cls) ? cls : Unclassified;',
    '',
    '    /// <summary>True when the WebViewer source defines <paramref name="name"/> (or CONNECT owns it).</summary>',
    '    public static bool IsKnown(string name) => Classes.ContainsKey(name);',
    '}',
    '',
  ].join('\r\n');
}
