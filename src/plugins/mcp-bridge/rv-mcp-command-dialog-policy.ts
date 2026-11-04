// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { commandRegistry } from '../../core/hmi/rv-command-registry';
import { movedToolOf } from './rv-mcp-moved-tools';
import { commandIdsOfCall } from './rv-mcp-tool-class';

export function commandsSkipDialogPolicy(ids: readonly string[]): boolean {
  return ids.every((id) => id.startsWith('prompt.') || commandRegistry.get(id)?.readOnly === true);
}

export function dialogPolicyApplies(tool: string, args?: unknown, dispatcher?: ReadonlyMap<string, unknown> | null): boolean {
  if (tool.startsWith('web_prompt_') || tool === 'web_query') return false;
  if (movedToolOf(tool) && !dispatcher?.has(tool)) return false;
  if (tool === 'web_execute' || tool === 'web_batch') {
    const ids = commandIdsOfCall(tool, args);
    if (ids && ids.length > 0 && commandsSkipDialogPolicy(ids)) return false;
  }
  return true;
}
