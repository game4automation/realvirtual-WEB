// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import type { DisplayWallPluginAPI } from '../types/plugin-types';
import {
  commandRegistry, CommandError, type CommandDescriptor, type CommandImpl, type CommandRegistry,
} from './rv-command-registry';

/** Optional strategy owner; no private implementation enters the core. */
export function ensureWallCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  for (const action of ['status', 'viewports', 'start', 'stop'] as const) {
    const id = `wall.${action}`;
    if (registry.get(id))
      continue;
    const impl: CommandImpl<{ preview?: boolean; path?: string }, unknown> = {
      enabled: ctx => !ctx.viewer.getPlugin('display-wall') ? { reason: 'Display wall unavailable' }
        : action === 'start' && ctx.viewer.isPluginDisabled('display-wall')
          ? { reason: 'plugin-disabled' } : true,
      run: async (ctx, args) => {
        const plugin = ctx.viewer.getPlugin<DisplayWallPluginAPI>('display-wall')!;
        if (action === 'start') {
          await plugin.start(args?.preview ?? false, args?.path);
          const status = plugin.status;
          if (status.refusedReason || !['requested', 'active'].includes(status.state))
            throw new CommandError(status.refusedReason ?? 'wall-not-started');
        }
        if (action === 'stop')
          plugin.deactivate('user', 'off');
        return action === 'viewports' ? plugin.status.viewports : plugin.status;
      },
    };
    const descriptor: CommandDescriptor<{ preview?: boolean; path?: string }, unknown> = {
      id, label: id, readOnly: action === 'status' || action === 'viewports', scope: 'none',
      available: true, unavailableReason: 'Display wall unavailable',
      argsSchema: action === 'start' ? { preview: 'boolean', path: 'string' } : {},
      eagerImpl: impl, impl: async () => impl,
    };
    registry.register(descriptor);
  }
}
