// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, type CommandRegistry, type CommandDescriptor, type CommandImpl } from './rv-command-registry';
import { ensureWallCommandsRegistered } from './wall-command-descriptors';

/** Domain queries retain the original routines and their JSON/error value contract. */
export function createQueryCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return [
    {
      id: 'sensor.list', label: 'sensor.list', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: {},
      impl: async () => {
        const { McpRuntimeTools } = await import('../../plugins/mcp-bridge/rv-mcp-runtime-tools');
        const impl: CommandImpl<{}, unknown> = {
          enabled: () => true,
          run: async (ctx) => JSON.parse(await new McpRuntimeTools(() => ctx.viewer).querySensorList()),
        };
        return impl;
      },
    },
    {
      id: 'sensor.read', label: 'sensor.read', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { path: 'string' },
      impl: async () => {
        const { SensorDataQueries } = await import('../../plugins/mcp-bridge/rv-mcp-sensor-data-tools');
        const impl: CommandImpl<{ path?: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new SensorDataQueries(() => ctx.viewer).querySensorRead(a?.path!)),
        };
        return impl;
      },
    },
    {
      id: 'transport.status', label: 'transport.status', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: {},
      impl: async () => {
        const { McpRuntimeTools } = await import('../../plugins/mcp-bridge/rv-mcp-runtime-tools');
        const impl: CommandImpl<{}, unknown> = {
          enabled: () => true,
          run: async (ctx) => JSON.parse(await new McpRuntimeTools(() => ctx.viewer).queryTransportStatus()),
        };
        return impl;
      },
    },
    {
      id: 'logic.flow', label: 'logic.flow', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: {},
      impl: async () => {
        const { McpRuntimeTools } = await import('../../plugins/mcp-bridge/rv-mcp-runtime-tools');
        const impl: CommandImpl<{}, unknown> = {
          enabled: () => true,
          run: async (ctx) => JSON.parse(await new McpRuntimeTools(() => ctx.viewer).queryLogicFlow()),
        };
        return impl;
      },
    },
    {
      id: 'link.compose', label: 'link.compose', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      timeoutMs: 30_000,
      argsSchema: { model: 'string', glb: 'string', doc: 'string', scene: 'string', mode: 'string', option: 'string', base: 'string' },
      impl: async () => {
        const { LinkQueries } = await import('../../plugins/mcp-bridge/rv-mcp-link-tools');
        const impl: CommandImpl<{ model?: string; glb?: string; doc?: string; scene?: string; mode?: string; option?: string; base?: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new LinkQueries(() => ctx.viewer).queryLinkCompose(a?.model!, a?.glb!, a?.doc!, a?.scene!, a?.mode!, a?.option!, a?.base!)),
        };
        return impl;
      },
    },
    {
      id: 'part.lookup', label: 'part.lookup', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { name: 'string' },
      impl: async () => {
        const { McpCheckTools } = await import('../../plugins/mcp-bridge/rv-mcp-check-tools');
        const impl: CommandImpl<{ name?: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new McpCheckTools(() => ctx.viewer).queryPartLookup(a?.name!)),
        };
        return impl;
      },
    },
    {
      id: 'prompt.list', label: 'prompt.list', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { includeClaimed: 'boolean' },
      impl: async () => {
        const { McpPromptTools } = await import('../../plugins/mcp-bridge/rv-mcp-prompt-tools');
        const impl: CommandImpl<{ includeClaimed?: boolean }, unknown> = {
          enabled: () => true,
          run: async (_ctx, a) => JSON.parse(await new McpPromptTools().queryPromptList(a?.includeClaimed)),
        };
        return impl;
      },
    },
    {
      id: 'editor.listKinematics', label: 'editor.listKinematics', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: {},
      impl: async () => {
        const { McpEditorTools } = await import('../../plugins/mcp-bridge/rv-mcp-editor-tools');
        const impl: CommandImpl<{}, unknown> = {
          enabled: () => true,
          run: async (ctx) => JSON.parse(await new McpEditorTools(() => ctx.viewer).queryListKinematics()),
        };
        return impl;
      },
    },
    {
      id: 'editor.materialPresets', label: 'editor.materialPresets', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: {},
      impl: async () => {
        const { McpEditorTools } = await import('../../plugins/mcp-bridge/rv-mcp-editor-tools');
        const impl: CommandImpl<{}, unknown> = {
          enabled: () => true,
          run: async (ctx) => JSON.parse(await new McpEditorTools(() => ctx.viewer).queryMaterialPresets()),
        };
        return impl;
      },
    },
    {
      id: 'editor.materialStats', label: 'editor.materialStats', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: {},
      impl: async () => {
        const { McpEditorTools } = await import('../../plugins/mcp-bridge/rv-mcp-editor-tools');
        const impl: CommandImpl<{}, unknown> = {
          enabled: () => true,
          run: async (ctx) => JSON.parse(await new McpEditorTools(() => ctx.viewer).queryMaterialStats()),
        };
        return impl;
      },
    },
    {
      id: 'editor.projectFiles', label: 'editor.projectFiles', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      timeoutMs: 60_000,
      argsSchema: { dir: 'string', glob: 'string' },
      impl: async () => {
        const { McpEditorTools } = await import('../../plugins/mcp-bridge/rv-mcp-editor-tools');
        const impl: CommandImpl<{ dir?: string; glob?: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new McpEditorTools(() => ctx.viewer).queryProjectFiles(a?.dir, a?.glob)),
        };
        return impl;
      },
    },
    {
      id: 'editor.projectInfo', label: 'editor.projectInfo', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: {},
      impl: async () => {
        const { McpEditorTools } = await import('../../plugins/mcp-bridge/rv-mcp-editor-tools');
        const impl: CommandImpl<{}, unknown> = {
          enabled: () => true,
          run: async (ctx) => JSON.parse(await new McpEditorTools(() => ctx.viewer).queryProjectInfo()),
        };
        return impl;
      },
    },
    // plan-2007 Phase 4B: the library reads (moved here out of library-commands.ts, see there).
    {
      id: 'library.list', label: 'library.list', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: {},
      impl: async () => {
        const { McpSceneTools } = await import('../../plugins/mcp-bridge/rv-mcp-scene-tools');
        const impl: CommandImpl<{}, unknown> = {
          enabled: () => true,
          run: async (ctx) => JSON.parse(await new McpSceneTools(() => ctx.viewer).queryLibraryList()),
        };
        return impl;
      },
    },
    {
      id: 'library.catalogList', label: 'library.catalogList', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { source: 'string', query: 'string', limit: 'number' },
      impl: async () => {
        const { McpSceneTools } = await import('../../plugins/mcp-bridge/rv-mcp-scene-tools');
        const impl: CommandImpl<{ source?: string; query?: string; limit?: number }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new McpSceneTools(() => ctx.viewer).queryCatalogList(a?.source, a?.query, a?.limit)),
        };
        return impl;
      },
    },
    {
      id: 'library.catalogDescribe', label: 'library.catalogDescribe', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { catalogId: 'string' },
      impl: async () => {
        const { McpSceneTools } = await import('../../plugins/mcp-bridge/rv-mcp-scene-tools');
        const impl: CommandImpl<{ catalogId: string }, unknown> = {
          enabled: () => true,
          run: async (ctx, a) => JSON.parse(await new McpSceneTools(() => ctx.viewer).queryCatalogDescribe(a.catalogId)),
        };
        return impl;
      },
    },
    // plan-2227 Phase 2: every SignalConnector with address, Mode, active slots, values, problem codes.
    {
      id: 'signalConnector.list', label: 'signalConnector.list', readOnly: true, scope: 'none',
      available: true, unavailableReason: 'Not available',
      argsSchema: { path: 'string' },
      impl: async () => (await import('./signal-connector-commands')).signalConnectorListImpl as CommandImpl<unknown, unknown>,
    },
  ] as CommandDescriptor<never, unknown>[];
}
const registered = new WeakSet<CommandRegistry>();
export function ensureQueryCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  ensureWallCommandsRegistered(registry);
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const descriptor of createQueryCommandDescriptors()) registry.register(descriptor);
}
