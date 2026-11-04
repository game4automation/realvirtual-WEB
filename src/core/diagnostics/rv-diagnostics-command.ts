// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import {
  commandRegistry, type CommandImpl, type CommandRegistry,
} from '../hmi/rv-command-registry';
interface DiagnosticsExportArgs { minutes?: number }

const impl: CommandImpl<DiagnosticsExportArgs> = {
  enabled: () => true,
  run: async (_ctx, args) => {
    const { exportDiagnostics } = await import('./rv-diagnostics-export');
    return exportDiagnostics({ minutes: args.minutes ?? 15 });
  },
};

const registered = new WeakSet<CommandRegistry>();

export function ensureDiagnosticsExportCommandRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.register({
    id: 'diagnostics.export', label: 'Save diagnostics', scope: 'none', readOnly: false,
    toolClass: 'file', available: true, unavailableReason: 'Diagnostics unavailable',
    argsSchema: { minutes: 'number' }, eagerImpl: impl, impl: async () => impl,
  });
}
