// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * connect-commands — the three CONNECT write-gate actions as COMMANDS (plan-562,
 * plan-499 pattern).
 *
 * "Allow writes", "Read only, don't ask again" and "Open CONNECT log" are each
 * offered from more than one place (the write-gate overlay, the no-data notice,
 * the interface card, the panel footer), so each of them is ONE command and every
 * surface is a view of it. None of the three has an MCP mirror: letting an agent
 * open a PLC write gate on its own is exactly the silent write this plan exists
 * to prevent, and a log window has nothing to mirror — hence no `mcp` entry and
 * no parity row.
 *
 * They are registered eagerly (`eagerImpl`): the implementations sit in this
 * module already, so a click dispatches in the caller's tick like the direct
 * call it replaced.
 */

import {
  commandRegistry,
  CommandRegistry,
  type CommandDescriptor,
  type CommandEnabled,
  type CommandImpl,
} from './rv-command-registry';
import {
  fetchStatus,
  getConnectSnapshot,
  requestConnectInterfaceEdit,
  setAllowWebToPlc,
  setConnectLogOpen,
  type SetAllowWebToPlcResult,
} from './connect-store';
import { markWriteGateReadOnly } from './connect-write-gate-store';
import { getStoredConnectPanelWidth } from './layout-constants';

/** Command ids — imported by the views instead of being spelled out twice. */
export const CONNECT_ALLOW_WRITES_COMMAND = 'connect.allowWrites';
export const CONNECT_READ_ONLY_COMMAND = 'connect.readOnly';
export const CONNECT_OPEN_LOG_COMMAND = 'connect.openLog';

export interface ConnectInterfaceArgs {
  interfaceId?: string;
}

/** Shared availability rule: an action on an interface needs that interface. */
function requireInterfaceId(args: ConnectInterfaceArgs): CommandEnabled {
  const id = typeof args?.interfaceId === 'string' ? args.interfaceId.trim() : '';
  return id ? true : { reason: 'No interface selected.' };
}

/**
 * Open the write gate of one interface.
 *
 * The revision comes from the status snapshot the user is LOOKING at, never from
 * a fresh read: the whole point of the comparison is that the gateway refuses the
 * flip when the interface moved since the sentence on screen was written. A
 * snapshot without a revision means a CONNECT too old for the endpoint, which is
 * reported as `unsupported` without sending a request that could only fail.
 */
const allowWrites: CommandImpl<ConnectInterfaceArgs, SetAllowWebToPlcResult> = {
  enabled: (_ctx, args) => requireInterfaceId(args),
  run: async (_ctx, args): Promise<SetAllowWebToPlcResult> => {
    const id = String(args.interfaceId);
    const revision = getConnectSnapshot().interfaceStatus[id]?.configRevision;
    if (!revision) return { kind: 'unsupported' };
    const result = await setAllowWebToPlc(id, revision, true);
    // A rejected flip and a vanished interface both leave the overlay showing a
    // stale truth — re-read the status so whatever it says next is current.
    if (result.kind === 'changed' || result.kind === 'gone') await fetchStatus();
    return result;
  },
};

/** Remember "this interface stays read-only" for this gateway and interface. */
const readOnly: CommandImpl<ConnectInterfaceArgs, { interfaceId: string }> = {
  enabled: (_ctx, args) => requireInterfaceId(args),
  run: (_ctx, args) => {
    const id = String(args.interfaceId);
    markWriteGateReadOnly(getConnectSnapshot().serverUrl, id);
    return { interfaceId: id };
  },
};

/**
 * Open the CONNECT log.
 *
 * Two steps, one command: the log dialog only renders inside an OPEN CONNECT
 * panel, so an "Open log" that merely set the flag would do nothing visible when
 * pressed from a notice over the 3D view — which is precisely where the no-data
 * notice offers it.
 */
const openLog: CommandImpl<Record<string, never>, { opened: true }> = {
  enabled: () => true,
  run: (ctx) => {
    ctx.viewer.leftPanelManager?.open('connect', getStoredConnectPanelWidth());
    setConnectLogOpen(true);
    return { opened: true };
  },
};

/** Open the Edit dialog of one interface (the way back from a "Read only"). */
export function openConnectInterfaceEdit(
  viewer: { leftPanelManager?: { open(id: string, width: number): void } },
  interfaceId: string,
): void {
  viewer.leftPanelManager?.open('connect', getStoredConnectPanelWidth());
  requestConnectInterfaceEdit(interfaceId);
}

interface Spec {
  id: string;
  label: string;
  argsSchema: Readonly<Record<string, 'string' | 'number' | 'boolean'>>;
  impl: CommandImpl<never, unknown>;
}

const SPECS: readonly Spec[] = [
  {
    id: CONNECT_ALLOW_WRITES_COMMAND,
    label: 'Allow writes',
    argsSchema: { interfaceId: 'string' },
    impl: allowWrites as unknown as CommandImpl<never, unknown>,
  },
  {
    id: CONNECT_READ_ONLY_COMMAND,
    label: "Read only, don't ask again",
    argsSchema: { interfaceId: 'string' },
    impl: readOnly as unknown as CommandImpl<never, unknown>,
  },
  {
    id: CONNECT_OPEN_LOG_COMMAND,
    label: 'Open CONNECT log',
    argsSchema: {},
    impl: openLog as unknown as CommandImpl<never, unknown>,
  },
];

/** Every CONNECT command id (preload, tests). */
export const CONNECT_COMMAND_IDS: readonly string[] = SPECS.map((s) => s.id);

/** Build the descriptors (testable seam: no registry side effect). */
export function createConnectCommandDescriptors(): CommandDescriptor<never, unknown>[] {
  return SPECS.map((s): CommandDescriptor<never, unknown> => ({
    id: s.id,
    label: s.label,
    readOnly: false,
    scope: 'none',
    available: true,
    unavailableReason: 'Not available',
    argsSchema: s.argsSchema,
    eagerImpl: s.impl,
    impl: () => Promise.resolve(s.impl),
  }));
}

const registered = new WeakSet<CommandRegistry>();

/** Idempotent eager registration of the CONNECT commands. */
export function ensureConnectCommandsRegistered(
  registry: CommandRegistry = commandRegistry,
): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createConnectCommandDescriptors()) registry.register(d);
}
