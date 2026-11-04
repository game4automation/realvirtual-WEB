// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { RVViewer } from '../rv-viewer';
import { CommandError, type CommandImpl } from './rv-command-registry';
import { stringArg } from './command-arg-validation';
import type { SelectionSelectArgs } from './selection-commands';

/** User paths (including authored aliases) always resolve through the registry. */
export function resolveCommandNode(viewer: RVViewer, path: string) {
  stringArg('path', path);
  const hit = viewer.registry?.findNodeForUser(path);
  if (!hit) throw new CommandError(`Node '${path}' not found`);
  return hit.node;
}

export function selectCommandNode(viewer: RVViewer, path: string): string {
  const node = resolveCommandNode(viewer, path);
  const resolvedPath = viewer.registry!.getPathForNode(node);
  if (!resolvedPath) throw new CommandError(`Node '${path}' has no selectable path`);
  viewer.selectionManager.select(resolvedPath);
  return resolvedPath;
}

export const selectionSelect: CommandImpl<SelectionSelectArgs> = {
  enabled: ({ viewer }) => viewer?.registry ? true : { reason: 'No model loaded' },
  run: ({ viewer }, args) => {
    stringArg('path', args?.path);
    if (args.frame !== undefined && typeof args.frame !== 'boolean') throw new CommandError('frame must be a boolean');
    const path = selectCommandNode(viewer, args.path);
    if (args.frame) viewer.selectionManager.frameSelectionOrScene();
    return { path, selected: true };
  },
};
