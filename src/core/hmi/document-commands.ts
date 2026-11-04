// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, type CommandDescriptor, type CommandEnabled, type CommandImpl, type CommandRegistry } from './rv-command-registry';
import { getProjectStore } from '../project/project-store';
import { getSceneStore } from './scene/scene-store-singleton';
import { McpExportTools } from '../../plugins/mcp-bridge/rv-mcp-export-tools';

function projectEnabled(bindings = false): CommandEnabled {
  const backend = getProjectStore().getBackend();
  if (!backend) return { reason: 'No project is open — open one with web_project_open.' };
  if (!backend.writable) return { reason: bindings
    ? 'This project is read-only — its bindings cannot be changed.'
    : 'This project is read-only — its documents cannot be changed.' };
  return true;
}

const create: CommandImpl<{ name?: string; folder?: string }> = {
  enabled: () => getSceneStore() ? true : { reason: 'Scene store not available' },
  run: async ({ viewer }, { name, folder }) => {
    const { McpSceneTools } = await import('../../plugins/mcp-bridge/rv-mcp-scene-tools');
    return JSON.parse(await new McpSceneTools(() => viewer).createDocument(name, folder));
  },
};

interface UpdateArgs { relPath: string; newName?: string; toFolder?: string }
function update(action: 'delete' | 'rename' | 'move'): CommandImpl<UpdateArgs> {
  return {
    enabled: () => projectEnabled(),
    run: async ({ viewer }, { relPath, newName, toFolder }) => {
      const { McpSceneTools } = await import('../../plugins/mcp-bridge/rv-mcp-scene-tools');
      return JSON.parse(await new McpSceneTools(() => viewer).updateDocument(action, relPath, newName, toFolder));
    },
  };
}

const bind: CommandImpl<{ document: string; field: string; ref?: string }> = {
  enabled: () => projectEnabled(true),
  run: async ({ viewer }, { document, field, ref }) => {
    const { McpProjectTools } = await import('../../plugins/mcp-bridge/rv-mcp-project-tools');
    return JSON.parse(await new McpProjectTools(() => viewer).bindDocument(document, field, ref));
  },
};

const usdExtrasCommit: CommandImpl<{ previewToken: string; acceptExtrasLoss?: boolean; confirmExtrasLost?: boolean }> = {
  enabled: ({ viewer }) => {
    const bound = new McpExportTools(() => viewer).usdApply();
    if (!('error' in bound)) return true;
    const { error, ...details } = JSON.parse(bound.error);
    return { reason: error, details };
  },
  run: async ({ viewer }, { previewToken, acceptExtrasLoss, confirmExtrasLost }) =>
    JSON.parse(await new McpExportTools(() => viewer).commitUsdExtras(previewToken, acceptExtrasLoss, confirmExtrasLost)),
};

// These operations change project files, not the editor document's op log: no macro flag.
export function createDocumentCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  const specs: Array<{ id: string; label: string; argsSchema: CommandDescriptor['argsSchema']; impl: CommandImpl<never, unknown>; timeoutMs: number; destructive?: boolean }> = [
    { id: 'document.create', label: 'Create document', argsSchema: { name: 'string', folder: 'string' }, impl: create as CommandImpl<never, unknown>, timeoutMs: 60_000 },
    { id: 'document.delete', label: 'Delete document', argsSchema: { relPath: 'string' }, impl: update('delete') as CommandImpl<never, unknown>, timeoutMs: 120_000, destructive: true },
    { id: 'document.rename', label: 'Rename document', argsSchema: { relPath: 'string', newName: 'string' }, impl: update('rename') as CommandImpl<never, unknown>, timeoutMs: 120_000 },
    { id: 'document.move', label: 'Move document', argsSchema: { relPath: 'string', toFolder: 'string' }, impl: update('move') as CommandImpl<never, unknown>, timeoutMs: 120_000 },
    { id: 'document.bind', label: 'Bind document reference', argsSchema: { document: 'string', field: 'string', ref: 'string' }, impl: bind as CommandImpl<never, unknown>, timeoutMs: 60_000 },
    { id: 'document.usdExtrasCommit', label: 'Commit USD extras', argsSchema: { previewToken: 'string', acceptExtrasLoss: 'boolean', confirmExtrasLost: 'boolean' }, impl: usdExtrasCommit as CommandImpl<never, unknown>, timeoutMs: 180_000 },
  ];
  return [
    {
      id: 'document.usdExtrasPreview', label: 'document.usdExtrasPreview', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      timeoutMs: 120_000,
      argsSchema: { path: 'string' },
      impl: async () => {
        const { McpExportTools } = await import('../../plugins/mcp-bridge/rv-mcp-export-tools');
        const impl: CommandImpl<{ path?: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new McpExportTools(() => ctx.viewer).queryImportUsdExtras(a?.path!)),
        };
        return impl;
      },
    },
    ...specs.map(({ impl, ...spec }) => ({
    ...spec, readOnly: false, scope: 'none', available: true, unavailableReason: 'Not available',
    eagerImpl: impl, impl: () => Promise.resolve(impl),
  }))] as CommandDescriptor<never, unknown>[];
}

const registered = new WeakSet<CommandRegistry>();
export function ensureDocumentCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createDocumentCommandDescriptors()) registry.register(d);
}
