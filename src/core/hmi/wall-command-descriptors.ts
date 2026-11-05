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
  if (!registry.get(WALL_FILL_COMMAND)) {
    // plan-2233 F6: open descriptor, commercial implementation (tier-boundary 6); the
    // community stub has no impl, so the command answers `unavailable`.
    registry.register({
      id: WALL_FILL_COMMAND, label: 'Fill from body', undoLabel: 'Fill from body', readOnly: false,
      macro: true, scope: 'none', available: true, unavailableReason: WALL_FILL_UNAVAILABLE,
      argsSchema: {
        node: 'string', pose: 'string', frame: 'string', select: 'string', grab: 'string',
        nav: 'string', joyX: 'string', joyY: 'string', clearMissing: 'boolean',
      },
      impl: () => (import('@rv-private/display-wall/wall-fill-commands') as Promise<WallFillModule>)
        .then(m => m.impls?.[WALL_FILL_COMMAND] ?? null),
    } as CommandDescriptor<never, unknown>);
  }
}

/** `wall.fillFromBody` — binds the tracking slots of a WallViewport/WallFlystick in one undo step. */
export const WALL_FILL_COMMAND = 'wall.fillFromBody';
export const WALL_FILL_UNAVAILABLE = 'Display wall tracking is part of realvirtual Professional';

/** Shape of the (private or stub) implementation module. */
export interface WallFillModule {
  readonly impls: Readonly<Record<string, CommandImpl<never, unknown> | undefined>>;
}
