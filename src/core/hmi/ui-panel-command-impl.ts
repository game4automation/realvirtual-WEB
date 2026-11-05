// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { CommandError, type CommandContext, type CommandImpl } from './rv-command-registry';
import { boolArg, rect4, stringArg } from './command-arg-validation';
import { setPanelCollapsed, setPanelGeometry } from './floating-panel-store';
import { mountedPanels, panelOpeners, type PanelOpener } from './panel-registry';
import { getProblems } from './problems-store';
import { setProblemsPanelOpen, showProblems } from './ProblemsPanel';
import { closeStatsHub, openStatsHub } from '../stats/stats-hub-store';
import { setEventQueueWindowOpen } from '../../plugins/sim-controller/event-queue-window-store';
import type { UiPanelArgs, UiPanelOpenArgs } from './ui-panel-commands';

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


/** Core windows whose open state lives in a store; other modules register theirs (panel-registry). */
const CORE_OPENERS: Readonly<Record<string, PanelOpener>> = {
  'problems': {
    title: 'Problems',
    setOpen: (open) => {
      if (!open) return setProblemsPanelOpen(false);
      if (getProblems().length === 0) return 'No problems to show';
      showProblems();
    },
  },
  'stats-hub': { title: 'Statistics', setOpen: (open) => (open ? openStatsHub() : closeStatsHub()) },
  'des-event-queue': { title: 'Event Queue', setOpen: (open) => setEventQueueWindowOpen(open) },
};
/** Windows of the commercial experiment manager: `commercial-feature` while it is not installed. */
const COMMERCIAL_PANEL_IDS = ['des-experiment-matrix', 'des-matrix-runs'];

const openerOf = (id: string): PanelOpener | undefined => panelOpeners.get(id) ?? CORE_OPENERS[id];

export function listPanels() {
  const ids = new Set([...Object.keys(CORE_OPENERS), ...panelOpeners.keys(), ...mountedPanels.keys()]);
  return [...ids].sort().map((panelId) => {
    const m = mountedPanels.get(panelId);
    return { panelId, title: m?.title ?? openerOf(panelId)!.title, open: m?.open ?? false, openable: !!openerOf(panelId) };
  });
}

export const uiPanelList: CommandImpl<never> = {
  enabled: () => true,
  run: () => ({ panels: listPanels() }),
};

function refuseUnknown(panelId: string, mounted: boolean): never {
  if (COMMERCIAL_PANEL_IDS.includes(panelId)) {
    throw new CommandError('experiment manager is a commercial module (realvirtual Commercial)',
      { module: 'des-experiments', panelId }, 'commercial-feature');
  }
  throw new CommandError(mounted ? `Panel '${panelId}' has no opener: open it from its own button` : `Unknown panel '${panelId}'`,
    { panels: listPanels().map(p => p.panelId) });
}

async function setOpen(ctx: CommandContext, args: UiPanelOpenArgs | undefined, open: boolean): Promise<{ panelId: string; open: boolean }> {
  const panelId = stringArg('panelId', args?.panelId);
  const target = args?.target === undefined ? undefined : stringArg('target', args.target);
  const opener = openerOf(panelId);
  const m = mountedPanels.get(panelId);
  if (opener) {
    const refusal = await opener.setOpen(open, target, ctx);
    if (typeof refusal === 'string') throw new CommandError(refusal, { panelId });
  } else if (open || !m) {
    refuseUnknown(panelId, !!m);
  } else if (m.open) {
    // A mounted window without an opener closes through its own close button's callback.
    if (!m.close) throw new CommandError(`Panel '${panelId}' cannot be closed`, { panelId });
    m.close();
  }
  return { panelId, open };
}

export const uiPanelOpen: CommandImpl<UiPanelOpenArgs> = { enabled: () => true, run: (ctx, args) => setOpen(ctx, args, true) };
export const uiPanelClose: CommandImpl<UiPanelOpenArgs> = { enabled: () => true, run: (ctx, args) => setOpen(ctx, args, false) };
