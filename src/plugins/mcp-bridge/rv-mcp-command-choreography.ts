// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { ToolCommandBinding } from '../../core/engine/rv-mcp-tools';
import { MOVED_TOOLS } from './rv-mcp-moved-tools';

/** Only 1:1 bindings preserve the wire arguments used by the tool tables. */
export function choreographyToolOf(
  commandId: string,
  dispatcher: ReadonlyMap<string, { command?: ToolCommandBinding }>,
  moved = MOVED_TOOLS,
): string | undefined {
  const aliases = [...dispatcher].filter(([, entry]) => entry.command === commandId).map(([name]) => name);
  return aliases.sort()[0]
    ?? moved.find((entry) => entry.movedTo.length === 1 && entry.movedTo[0] === commandId)?.tool;
}
