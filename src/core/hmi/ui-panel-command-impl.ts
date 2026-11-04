// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { CommandError, type CommandImpl } from './rv-command-registry';
import { boolArg, rect4, stringArg } from './command-arg-validation';
import { setPanelCollapsed, setPanelGeometry } from './floating-panel-store';
import type { UiPanelArgs } from './ui-panel-commands';

export const uiPanel: CommandImpl<UiPanelArgs> = {
  enabled: () => true,
  run: (_ctx, args) => {
    stringArg('panelId', args?.panelId);
    if (args.rect === undefined && args.collapsed === undefined) {
      throw new CommandError('At least one of rect or collapsed is required');
    }
    // Validate the whole request before writing either field.
    if (args.rect !== undefined) rect4('rect', args.rect);
    if (args.collapsed !== undefined) boolArg('collapsed', args.collapsed);
    if (args.rect !== undefined) setPanelGeometry(args.panelId, args.rect);
    if (args.collapsed !== undefined) setPanelCollapsed(args.panelId, args.collapsed);
    return { panelId: args.panelId, rect: args.rect, collapsed: args.collapsed };
  },
};
