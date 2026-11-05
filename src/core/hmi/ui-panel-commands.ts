// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, type CommandRegistry } from './rv-command-registry';

export interface UiPanelArgs { panelId: string; rect?: number[]; collapsed?: boolean }
export interface UiPanelOpenArgs { panelId: string; target?: string }

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
  registry.register<never, unknown>({
    id: 'ui.panel.list', label: 'List panels', readOnly: true,
    scope: 'none', available: true, unavailableReason: 'Panel unavailable', argsSchema: {},
    impl: () => import('./ui-panel-command-impl').then(m => m.uiPanelList),
  });
  for (const [id, label, open] of [['ui.panel.open', 'Open panel', true], ['ui.panel.close', 'Close panel', false]] as const) {
    registry.register<UiPanelOpenArgs, unknown>({
      id, label, readOnly: false, toolClass: 'edit',
      scope: 'none', available: true, unavailableReason: 'Panel unavailable',
      argsSchema: open ? { panelId: 'string', target: 'string' } : { panelId: 'string' },
      impl: () => import('./ui-panel-command-impl').then(m => (open ? m.uiPanelOpen : m.uiPanelClose)),
    });
  }
}
