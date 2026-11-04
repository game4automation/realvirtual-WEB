// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * solidcraft-command-descriptors — EAGER descriptors of the SolidCraft live-sync
 * commands (plan-621 F7).
 *
 * "Connect to SolidCraft" / "Resync" / "Disconnect" are ONE command
 * set: the editor's SolidCraft menu (activity bar), the "Resync" action of
 * the SolidCraft problems and the three `web_editor_solidcraft_*` tools are views
 * of these commands (plan-499). Open on purpose, exactly like
 * `mechanism-command-descriptors`: the MCP bridge needs label, args shape and
 * capability before any private code is loaded; the implementations come lazily
 * from `@rv-private/plugins/solidcraft-sync/solidcraft-commands` (community stub:
 * `impls = {}` → `ERR_EDITOR_UNAVAILABLE`).
 *
 * The sync itself runs in realvirtual CONNECT (it polls the SolidCraft desktop
 * app over its control channel) — the browser only steers it. "Connect" starts
 * SolidCraft on this machine if it is not running (plan-642: CONNECT starts it,
 * only for a tab on the CONNECT machine); where the user has to start it, the
 * texts name the command line ({@link solidCraftStartHint}).
 */

import {
  commandRegistry,
  type CommandArgType,
  type CommandDescriptor,
  type CommandImpl,
  type CommandMcpMirror,
  type CommandRegistry,
} from './rv-command-registry';
import { ERR_EDITOR_UNAVAILABLE } from '../editor/rv-editor-guard-core';

// ─── Shared texts (tooltip == tool result) ──────────────────────────────

/** Control port the sync uses unless one is given — shared with the SolidCraft MCP server (`mcp --connect 127.0.0.1:7879`). */
export const SOLIDCRAFT_DEFAULT_PORT = 7879;

/** How the user starts the app by hand (auto-start off, remote tab, app not found). */
export function solidCraftStartHint(port: number = SOLIDCRAFT_DEFAULT_PORT): string {
  return `Start SolidCraft with: solidcraft --control ${port}`;
}

export const SOLIDCRAFT_NOT_LOADED = 'The SolidCraft live sync is not loaded in this workspace';
export const SOLIDCRAFT_NEEDS_BRIDGE =
  'Needs the realvirtual CONNECT bridge — the SolidCraft sync runs in CONNECT; open the viewer through CONNECT';
export const SOLIDCRAFT_NOT_CONNECTED = 'Not connected to SolidCraft — connect first';
export const SOLIDCRAFT_BAD_PORT = 'Port must be an integer between 1 and 65535';

// ─── Args (== the @McpParam wire args) ──────────────────────────────────

/**
 * `port` omitted = the port CONNECT is configured with (`SolidCraftPort`, default {@link SOLIDCRAFT_DEFAULT_PORT})
 * or the port override the user typed into the SolidCraft menu; `design` (path, file or design name) guards against a
 * foreign instance — omitted, the document's linked design (its one sync root's `DesignPath`) is used,
 * and that file is what an auto-started SolidCraft opens.
 */
export interface SolidCraftConnectArgs { readonly port?: number | null; readonly design?: string | null }

/**
 * plan-654: the answer to an identity question of the sync — `name` (a body that appeared in SolidCraft) IS the
 * body `uuid` renamed; without `uuid` it is a new body. CONNECT never guesses; until the answer the vanished body's
 * node keeps its WEB overrides and the new name is not synced.
 */
export interface SolidCraftIdentityResolveArgs { readonly name: string; readonly uuid?: string | null }

// ─── Descriptor table ───────────────────────────────────────────────────

/** Shape of the (private or stub) implementation module. */
export interface SolidCraftCommandsModule {
  readonly impls: Readonly<Record<string, CommandImpl<never, unknown> | undefined>>;
}

export interface SolidCraftDescriptorOptions {
  /** Module loader — production: the `@rv-private` alias. Tests inject a double. */
  readonly load: () => Promise<SolidCraftCommandsModule>;
  /** Eager capability — production: `__RV_HAS_PRIVATE__`. */
  readonly available: boolean;
}

type P = CommandMcpMirror['params'][number];
const opt = (name: string, type = 'string'): P => ({ name, type, required: false });

interface Spec {
  readonly id: string;
  readonly label: string;
  readonly argsSchema: Readonly<Record<string, CommandArgType>>;
  /** Absent: reachable through `web_execute` and the Problems panel only (plan-641: commands, not new tools). */
  readonly mcp?: CommandMcpMirror;
}

const SPECS: readonly Spec[] = [
  {
    id: 'solidcraft.connect', label: 'Connect to SolidCraft',
    argsSchema: { port: 'number', design: 'string' },
    mcp: { tool: 'web_editor_solidcraft_connect', params: [opt('port', 'integer'), opt('design')] },
  },
  {
    id: 'solidcraft.resync', label: 'Resync',
    argsSchema: {},
    mcp: { tool: 'web_editor_solidcraft_resync', params: [] },
  },
  {
    id: 'solidcraft.disconnect', label: 'Disconnect',
    argsSchema: {},
    mcp: { tool: 'web_editor_solidcraft_disconnect', params: [] },
  },
  {
    // plan-654: the Problems panel's answer to `solidcraft-identity-ambiguous` (no tool of its own).
    id: 'solidcraft.identity.resolve', label: 'Settle SolidCraft body identity',
    argsSchema: { name: 'string', uuid: 'string' },
  },
  {
    // plan-654: drops an unreadable `io.realvirtual` entry of the design (`solidcraft-identity-invalid`).
    id: 'solidcraft.identity.reset', label: 'Reset SolidCraft body identities',
    argsSchema: {},
  },
  {
    // plan-2220: the two answers of the "Design moved? Connect to <new path>" dialog (no tool of their own).
    id: 'solidcraft.confirmMove', label: 'Connect to the moved SolidCraft design',
    argsSchema: {},
  },
  {
    id: 'solidcraft.cancelMove', label: 'Do not connect the moved SolidCraft design',
    argsSchema: {},
  },
];

/** Every SolidCraft command id (the toolbar's proxy keys, `preload`). */
export const SOLIDCRAFT_COMMAND_IDS: readonly string[] = SPECS.map((sp) => sp.id);

/**
 * Build the SolidCraft descriptors against a module loader (testable seam).
 *
 * Scope `editor`: without a document open in the editor every one of them refuses with
 * the guard's own reason (the menu rows show it, the tools answer it). None of
 * them books an op — the sync steps CONNECT delivers afterwards are the undo
 * entries — so there is no `undoLabel`.
 */
export function createSolidCraftCommandDescriptors(opts: SolidCraftDescriptorOptions): CommandDescriptor<never, unknown>[] {
  const implOf = (id: string) => () =>
    opts.load().then((m) => (m.impls?.[id] ?? null) as CommandImpl<never, unknown> | null);
  return SPECS.map((sp): CommandDescriptor<never, unknown> => ({
    id: sp.id,
    label: sp.label,
    readOnly: false,
    scope: 'editor',
    available: opts.available,
    unavailableReason: ERR_EDITOR_UNAVAILABLE,
    ...(sp.mcp ? { mcp: sp.mcp } : {}),
    argsSchema: sp.argsSchema,
    impl: implOf(sp.id),
  }));
}

/** Production loader: the private implementation, or the community stub. */
const loadSolidCraftCommands = (): Promise<SolidCraftCommandsModule> =>
  import('@rv-private/plugins/solidcraft-sync/solidcraft-commands') as Promise<SolidCraftCommandsModule>;

const registered = new WeakSet<CommandRegistry>();

/**
 * Idempotent eager registration of the SolidCraft descriptors (three with an MCP tool, two identity commands, the
 * two answers of "Design moved?").
 */
export function ensureSolidCraftCommandsRegistered(registry: CommandRegistry = commandRegistry): void {
  if (registered.has(registry)) return;
  registered.add(registry);
  for (const d of createSolidCraftCommandDescriptors({ load: loadSolidCraftCommands, available: __RV_HAS_PRIVATE__ })) {
    registry.register(d);
  }
}
