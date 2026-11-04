// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVViewer } from '../../src/core/rv-viewer';
import { McpCommandTools } from '../../src/plugins/mcp-bridge/rv-mcp-command-tools';

/** Reuse a domain fixture's viewer while exercising the public command door. */
export async function executeDelegateValue(delegate: object, command: string, args: Record<string, unknown> = {}): Promise<string> {
  if (command.startsWith('signal.set') || command.startsWith('sim.') || command.startsWith('drive.')) {
    (await import('../../src/plugins/sim-controller/sim-commands')).ensureSimCommandsRegistered();
  }
  if (command.startsWith('mu.')) (await import('../../src/plugins/mu-interaction-plugin')).ensureMuCommandsRegistered();
  const viewer = (delegate as { viewer?: RVViewer }).viewer ?? {} as RVViewer;
  const answer = JSON.parse(await new McpCommandTools(() => viewer).webExecute(command, JSON.stringify(args)));
  // A command can return a refusal VALUE even when the envelope reports failure.
  if ('value' in answer) return JSON.stringify(answer.value);
  return JSON.stringify(answer.ok === false
    ? { ok: false, error: answer.error, ...(answer.details ?? {}) }
    : answer);
}

/** Exercise web_execute while retaining the editor aliases' success/error shape. */
export async function executeValue(viewer: RVViewer, command: string, args: Record<string, unknown> = {}): Promise<string> {
  const answer = JSON.parse(await new McpCommandTools(() => viewer).webExecute(command, JSON.stringify(args)));
  return JSON.stringify(answer.ok
    ? { ok: true, ...answer.value }
    : { error: answer.error, ...answer.details });
}

/** Run through a fixture's real bridge transport, keeping macro notes outside args. */
export async function bridgeExecuteValue(
  call: (tool: string, args: Record<string, unknown>) => Promise<Record<string, unknown>>,
  command: string,
  wire: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const { _reason, _source, _confidence, ...args } = wire;
  const answer = await call('web_execute', { command, args: JSON.stringify(args), _reason, _source, _confidence });
  return answer.ok
    ? { ok: true, ...(answer.value as Record<string, unknown>) }
    : { error: answer.error, ...(answer.details as Record<string, unknown>) };
}
