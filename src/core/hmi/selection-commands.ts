// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, type CommandRegistry } from './rv-command-registry';

export interface SelectionSelectArgs { path: string; frame?: boolean }

const registered = new WeakSet<CommandRegistry>();
export function ensureSelectionCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.register<SelectionSelectArgs, unknown>({
    id: 'selection.select', label: 'Select node', readOnly: false,
    scope: 'none', available: true, unavailableReason: 'Selection unavailable',
    argsSchema: { path: 'string', frame: 'boolean' },
    impl: () => import('./selection-command-impl').then(m => m.selectionSelect),
  });
}
