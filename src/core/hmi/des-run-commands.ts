// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, type CommandArgType, type CommandDescriptor, type CommandImpl, type CommandRegistry } from './rv-command-registry';

const SPECS = [
  { id: 'des.fastForward', label: 'Fast Forward', argsSchema: { on: 'boolean', untilSimTime: 'string' } },
  { id: 'des.setEnd', label: 'DES clock settings', argsSchema: { end: 'string', statReset: 'string' } },
  { id: 'des.stats.window', label: 'DES Statistics', argsSchema: { open: 'boolean', hiddenKinds: 'string[]' } },
  { id: 'des.badges', label: 'In-scene stats badges', argsSchema: { on: 'boolean' } },
  // plan-2208b B3: the "Random seed" setting of the clock window.
  { id: 'des.seed.get', label: 'DES random seed', argsSchema: {} },
  { id: 'des.seed.set', label: 'Set DES random seed', argsSchema: { seed: 'number', mode: 'string' } },
] as const;

export function createDesRunCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return SPECS.map(s => ({
    id: s.id, label: s.label, readOnly: s.id === 'des.seed.get',
    ...(['des.stats.window', 'des.badges'].includes(s.id) ? { toolClass: 'edit' as const } : {}),
    ...(s.id === 'des.seed.set' ? { toolClass: 'sim' as const } : {}),
    scope: 'none', available: true, unavailableReason: 'Not available',
    argsSchema: s.argsSchema as Readonly<Record<string, CommandArgType>>,
    impl: async () => (await import('./des-run-commands-impl')).desRunCommandImpls[s.id] as CommandImpl<never, unknown>,
  }));
}

const registered = new WeakSet<CommandRegistry>();
export function ensureDesRunCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const descriptor of createDesRunCommandDescriptors()) registry.register(descriptor);
}
