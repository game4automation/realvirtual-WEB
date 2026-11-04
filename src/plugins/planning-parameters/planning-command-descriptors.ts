// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, type CommandDescriptor, type CommandImpl, type CommandRegistry } from '../../core/hmi/rv-command-registry';

const definitions: readonly Omit<CommandDescriptor<never, unknown>, 'scope' | 'available' | 'unavailableReason'>[] = [
  { id: 'planning.param.list', label: 'List planning parameters', readOnly: true, argsSchema: { owner: 'string' },
    impl: () => import('./planning-commands').then(m => m.paramList as CommandImpl<never, unknown>) },
  { id: 'planning.param.set', label: 'Set planning parameters', readOnly: false, argsSchema: { values: 'string' },
    impl: () => import('./planning-commands').then(m => m.paramSet as CommandImpl<never, unknown>) },
  { id: 'planning.param.apply', label: 'Apply planning parameters', readOnly: false, argsSchema: {},
    impl: () => import('./planning-commands').then(m => m.paramApply as CommandImpl<never, unknown>) },
  { id: 'planning.reset', label: 'Reset planning parameters', readOnly: false, destructive: true, argsSchema: { owner: 'string' },
    impl: () => import('./planning-commands').then(m => m.planningReset as CommandImpl<never, unknown>) },
  { id: 'planning.scenario.save', label: 'Save planning scenario', readOnly: false, argsSchema: { name: 'string' },
    impl: () => import('./planning-commands').then(m => m.scenarioSave as CommandImpl<never, unknown>) },
  { id: 'planning.scenario.switch', label: 'Switch planning scenario', readOnly: false, argsSchema: { name: 'string' },
    impl: () => import('./planning-commands').then(m => m.scenarioSwitch as CommandImpl<never, unknown>) },

];
const descriptors: readonly CommandDescriptor<never, unknown>[] = definitions.map(d => ({
  ...d, scope: 'none', available: true, unavailableReason: 'no planning parameters declared',
}));

export const PLANNING_COMMAND_IDS: readonly string[] = descriptors.map(d => d.id);
const registered = new WeakSet<CommandRegistry>();

/** Register only metadata eagerly; persistence and command bodies load on demand. */
export function ensurePlanningCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const descriptor of descriptors) registry.register(descriptor);
}
