// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, type CommandRegistry } from './rv-command-registry';

export interface UiPanelArgs { panelId: string; rect?: number[]; collapsed?: boolean }

const registered = new WeakSet<CommandRegistry>();
export function ensureUiPanelCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  registry.register<UiPanelArgs, unknown>({
    id: 'ui.panel', label: 'Arrange panel', readOnly: false,
    scope: 'none', available: true, unavailableReason: 'Panel unavailable',
    argsSchema: { panelId: 'string', rect: 'number[]', collapsed: 'boolean' },
    impl: () => import('./ui-panel-command-impl').then(m => m.uiPanel),
  });
}
