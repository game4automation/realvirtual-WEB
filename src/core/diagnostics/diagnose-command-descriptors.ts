// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry, type CommandDescriptor, type CommandImpl, type CommandRegistry } from '../hmi/rv-command-registry';

const descriptors: readonly CommandDescriptor<never, unknown>[] = [
  {
    id: 'fleet.status', label: 'Fleet status', scope: 'none', readOnly: true,
    available: true, unavailableReason: 'Fleet unavailable', argsSchema: { vehicle: 'string', state: 'string' },
    impl: () => import('./diagnose-commands').then(m => m.fleetStatus as CommandImpl<never, unknown>),
  },
  {
    id: 'diagnose', label: 'Diagnose', scope: 'none', readOnly: true,
    available: true, unavailableReason: 'Diagnostics unavailable', argsSchema: {},
    impl: () => import('./diagnose-commands').then(m => m.diagnose as CommandImpl<never, unknown>),
  },
  {
    id: 'des.status', label: 'DES run status', scope: 'none', readOnly: true,
    available: true, unavailableReason: 'not in DES mode', argsSchema: {},
    impl: () => import('./diagnose-commands').then(m => m.desStatus as CommandImpl<never, unknown>),
  },
  {
    id: 'des.events', label: 'DES next events', scope: 'none', readOnly: true,
    available: true, unavailableReason: 'not in DES mode',
    argsSchema: { limit: 'number', component: 'string', action: 'string' },
    impl: () => import('./diagnose-commands').then(m => m.desEvents as CommandImpl<never, unknown>),
  },
  {
    id: 'problems.list', label: 'List problems', scope: 'none', readOnly: true,
    available: true, unavailableReason: 'Problems unavailable',
    argsSchema: { severity: 'string', code: 'string', node: 'string', limit: 'number' },
    impl: () => import('./diagnose-commands').then(m => m.problemsList as CommandImpl<never, unknown>),
  },
  {
    id: 'diag.blockage', label: 'blockage', scope: 'none', readOnly: true,
    available: true, unavailableReason: 'Diagnostics unavailable', argsSchema: {},
    impl: () => import('./blockage-commands').then(m => m.blockage as CommandImpl<never, unknown>),
  },
  {
    id: 'diag.waitGraph', label: 'waitGraph', scope: 'none', readOnly: true,
    available: true, unavailableReason: 'Diagnostics unavailable', argsSchema: {},
    impl: () => import('./blockage-commands').then(m => m.waitGraph as CommandImpl<never, unknown>),
  },
  {
    id: 'diag.blockageWatchStatus', label: 'blockageWatchStatus', scope: 'none', readOnly: true,
    available: true, unavailableReason: 'Diagnostics unavailable', argsSchema: {},
    impl: () => import('./blockage-commands').then(m => m.blockageWatchStatus as CommandImpl<never, unknown>),
  },
  {
    id: 'diag.blockageWatch', label: 'blockageWatch', scope: 'none', readOnly: false,
    available: true, unavailableReason: 'Diagnostics unavailable', argsSchema: { on: 'boolean' },
    impl: () => import('./blockage-commands').then(m => m.blockageWatch as CommandImpl<never, unknown>),
  },
];

export const DIAGNOSE_COMMAND_IDS: readonly string[] = descriptors.map(d => d.id);
const registered = new WeakSet<CommandRegistry>();

export function ensureDiagnoseCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const descriptor of descriptors) registry.register(descriptor);
}
