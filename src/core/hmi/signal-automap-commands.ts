// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, type CommandImpl, type CommandRegistry } from './rv-command-registry';
import { getConnectSnapshot } from './connect-store';

function automap(mode: 'check' | 'apply'): CommandImpl<{ interfaceId?: string; mode?: string }> {
  return {
    enabled: ({ viewer }) => !viewer ? { reason: 'No viewer' }
      : getConnectSnapshot().state !== 'connected'
        ? { reason: 'Not connected to a CONNECT gateway — connect in the CONNECT panel first.' } : true,
    run: async ({ viewer }, args) => {
      // Keep the old parameter spelling, but never allow a read command to select a write.
      const wanted = (args.mode ?? mode).trim().toLowerCase() || mode;
      if (wanted !== 'check' && wanted !== 'apply') return { error: `Unknown mode "${args.mode}" — use check or apply` };
      if (wanted !== mode) return { error: `Unknown mode "${args.mode}" — use ${mode}` };
      const { automap: runAutomap } = await import('../../plugins/mcp-bridge/rv-mcp-signal-automap-tools');
      return JSON.parse(await runAutomap(viewer, args.interfaceId, mode));
    },
  };
}

const registered = new WeakSet<CommandRegistry>();
export function ensureSignalAutomapCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const mode of ['apply', 'check'] as const) {
    const impl = automap(mode);
    registry.register({
      id: mode === 'apply' ? 'signal.automapApply' : 'signal.automapCheck',
      label: mode === 'apply' ? 'Apply signal auto-map' : 'Check signal auto-map',
      readOnly: mode === 'check', scope: 'none', available: true, unavailableReason: 'Not available',
      argsSchema: { interfaceId: 'string', mode: 'string' },
      eagerImpl: impl, impl: () => Promise.resolve(impl),
    });
  }
}
