// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-signal-usage-tools — `web_signal_usage` (plan-566 F8): the signal
 * cross-reference list as a tool. Same index the inspector's "Used by"
 * section, the signal tooltip and the hierarchy / CONNECT row popover read
 * (`viewer.signalUsage`, wired by `ensureSignalUsageWiring`), so an agent and a
 * user can never see two different answers.
 *
 * Read-only: it builds (or reuses) the lazy index and changes nothing an
 * operator can see. While connected it loads the CONNECT bridge cache first,
 * so bridge usages are not missing just because the CONNECT panel was never
 * opened.
 *
 * Implementation routines for registry commands (plan-2007).
 */

import type { RVViewer } from '../../core/rv-viewer';
import { groupSignalUsages, isAmbiguousSignalName } from '../../core/engine/rv-signal-usage-index';
import { ensureSignalUsageWiring, isSignalUsageNavigable } from '../../core/hmi/use-signal-usages';
import { getConnectBridges, getConnectSnapshot, reloadConnectBridges } from '../../core/hmi/connect-store';

/** Read-only command body (plan-2007). */
export async function querySignalUsage(
  viewer: RVViewer | undefined,
  name: string,
): Promise<string> {
  if (!viewer) return JSON.stringify({ error: 'No viewer' });
  const signal = (name ?? '').trim();
  if (!signal) return JSON.stringify({ error: 'name is required' });
  const service = ensureSignalUsageWiring(viewer);
  if (!service) return JSON.stringify({ error: 'Signal usage index unavailable' });
  if (getConnectSnapshot().state === 'connected' && !getConnectBridges().loaded) {
    await reloadConnectBridges();
  }
  const usages = service.usages(signal);
  const store = viewer.signalStore;
  return JSON.stringify({
    signal,
    known: store ? store.get(signal) !== undefined : null,
    ...(isAmbiguousSignalName(store, signal) ? { ambiguous: true } : {}),
    count: usages.length,
    groups: groupSignalUsages(usages).map((g) => ({
      kind: g.kind,
      usages: g.usages.map((u) => ({ ...u, navigable: isSignalUsageNavigable(u) })),
    })),
  });
}
