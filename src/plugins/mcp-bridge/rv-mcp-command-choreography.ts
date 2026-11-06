// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { ToolCommandBinding } from '../../core/engine/rv-mcp-tools';
import { commandRegistry } from '../../core/hmi/rv-command-registry';

/** Resolve a live 1:1 tool binding, or use the registered command id for command policies. */
export function choreographyKeyOf(
  commandId: string,
  dispatcher: ReadonlyMap<string, { command?: ToolCommandBinding }>,
): string | undefined {
  const aliases = [...dispatcher].filter(([, entry]) => entry.command === commandId).map(([name]) => name);
  return aliases.sort()[0]
    ?? (commandRegistry.get(commandId) ? commandId : undefined);
}
