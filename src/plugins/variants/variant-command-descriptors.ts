// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, type CommandArgType, type CommandDescriptor, type CommandImpl, type CommandRegistry } from '../../core/hmi/rv-command-registry';

const d = (name: string, readOnly: boolean, args: Record<string, CommandArgType>, extra = {}): CommandDescriptor => ({
  id: `variant.${name}`, label: `variant.${name}`, readOnly, argsSchema: args, scope: 'none', available: true,
  unavailableReason: 'variants are unavailable', impl: () => import('./variant-commands').then((m) => m[`variant${name[0].toUpperCase()}${name.slice(1)}` as keyof typeof m] as CommandImpl), ...extra,
});

const descriptors = [
  d('list', true, {}), d('diff', true, { variants: 'string[]' }), d('create', false, { name: 'string' }),
  d('activate', false, { id: 'string' }, { toolClass: 'sim' }),
  d('set', false, { id: 'string', address: 'string', path: 'string', component: 'string', field: 'string', value: 'string' }),
  d('rename', false, { id: 'string', name: 'string' }), d('duplicate', false, { id: 'string', name: 'string' }),
  d('delete', false, { id: 'string' }, { destructive: true }), d('save', false, {}, { toolClass: 'save' }),
];
export const VARIANT_COMMAND_IDS = descriptors.map((x) => x.id);
const registered = new WeakSet<CommandRegistry>();

export function ensureVariantCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const descriptor of descriptors) registry.register(descriptor);
}
