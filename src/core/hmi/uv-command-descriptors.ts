// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * uv-command-descriptors — the `editor.generateUVs` command (plan-675 Phase 1).
 *
 * Kept in core and free of the MCP bridge so the asset editor's Materials window
 * can show a "Generate UVs" button as a view of the command without pulling the
 * bridge into its chunk. The body (`McpEditorTools.generateUVsForPaths`) is the
 * LAZY implementation; the MCP tool `web_editor_generate_uvs` is its alias.
 *
 * A multi-target op: meshes that keep their UVs (or cannot get any) are reported
 * in `skipped`, which the command interface classifies as `partial`.
 */

import {
  commandRegistry,
  type CommandDescriptor,
  type CommandImpl,
  type CommandRegistry,
} from './rv-command-registry';
import { parsePathsParam } from '../../plugins/mcp-bridge/rv-object-analyzer-math';
import { serializePathList } from './rv-path-list';

/** Command id of the UV generation (alias `web_editor_generate_uvs`). */
export const EDITOR_GENERATE_UVS_COMMAND = 'editor.generateUVs';

export interface GenerateUVsArgs {
  readonly paths?: string | null;
  readonly mode?: string | null;
  readonly overwrite?: boolean | null;
}

/**
 * The selection fallback and the defaults spelled out, so a macro replay
 * generates UVs for the same meshes whatever is selected then.
 */
export function resolveGenerateUVsArgs(
  ctx: { readonly selection: readonly string[] }, a: GenerateUVsArgs | undefined,
): Required<{ [K in keyof GenerateUVsArgs]: NonNullable<GenerateUVsArgs[K]> }> {
  const list = parsePathsParam(a?.paths ?? '');
  return {
    paths: serializePathList(list.length > 0 ? list : [...ctx.selection], '\n'),
    mode: (String(a?.mode ?? '').trim() || 'auto').toLowerCase(),
    overwrite: a?.overwrite === true,
  };
}

/** Build the descriptor (testable seam: no registry side effect). */
export function createGenerateUVsCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  const gen: CommandDescriptor<GenerateUVsArgs, Record<string, unknown>> = {
    id: EDITOR_GENERATE_UVS_COMMAND,
    label: 'Generate UVs',
    undoLabel: 'Generate UVs',
    readOnly: false,
    macro: true,
    scope: 'none',
    available: true,
    unavailableReason: 'Not available',
    mcp: {
      tool: 'web_editor_generate_uvs',
      params: [
        { name: 'paths', type: 'string', required: false },
        { name: 'mode', type: 'string', required: false },
        { name: 'overwrite', type: 'boolean', required: false },
      ],
    },
    argsSchema: { paths: 'string', mode: 'string', overwrite: 'boolean' },
    impl: async () => (await import('../../plugins/mcp-bridge/rv-mcp-editor-tools'))
      .editorGenerateUVsImpl as CommandImpl<GenerateUVsArgs, Record<string, unknown>>,
  };
  return [gen as unknown as CommandDescriptor<never, unknown>];
}

const registered = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the UV-generation command. */
export function ensureGenerateUVsCommandRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createGenerateUVsCommandDescriptors()) registry.register(d);
}

ensureGenerateUVsCommandRegistered();
