// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** CONNECT historian navigation plugin, gated by live historian health. */

import { useEffect, useSyncExternalStore } from 'react';
import { Timeline } from '@mui/icons-material';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { UISlotEntry, UISlotProps } from '../core/rv-ui-plugin';
import { NavButton } from '../core/hmi/NavButton';
import { HistorianTrendPanel } from '../core/hmi/HistorianTrendPanel';
import { historianStore, type HistorianStatus } from '../core/hmi/historian-store';
import { getConnectSnapshot, subscribeConnectStore } from '../core/hmi/connect-store';
import { onGatewayLicensed } from '../core/hmi/license-store';

const STATUS_POLL_MS = 10_000;

/** The button is available only when CONNECT confirms a usable historian. */
export function historianStatusAllowsPlugin(status: HistorianStatus | null): boolean {
  return status?.enabled === true && status.connected === true;
}

export class HistorianTrendPlugin implements RVViewerPlugin {
  readonly id = 'historian-trend';
  readonly order = 165;
  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: HistorianTrendButton, order: 55 },
  ];

  /** plan-2044: the one license-edge subscription of this plugin; null when none. */
  private _licenseUnsubscribe: (() => void) | null = null;

  init(): void { this._watchLicense(); }
  onActivate(): void { this._watchLicense(); }
  onDeactivate(): void { this._unwatchLicense(); }
  dispose(): void { this._unwatchLicense(); }

  /**
   * plan-2044: re-read `/history/status` once on every local `unlicensed -> licensed` edge.
   * An unlicensed CONNECT answers that route with 403 LICENSE_REQUIRED, which the store keeps
   * as `disabledReason` and the CONNECT panel shows as "Historian not recording". The 10 s
   * poll that would replace it lives in the toolbar button below, and the toolbar is not
   * mounted in a recording, in focused workspace modes (planner, editor, ...) or in the
   * viewer mode — the CONNECT panel is. So the edge is owned here, for the plugin's lifetime.
   */
  private _watchLicense(): void {
    this._unwatchLicense();
    this._licenseUnsubscribe = onGatewayLicensed(() => { void historianStore.refreshStatus(); });
  }

  private _unwatchLicense(): void {
    this._licenseUnsubscribe?.();
    this._licenseUnsubscribe = null;
  }
}

function HistorianTrendButton(_props: UISlotProps) {
  const connect = useSyncExternalStore(subscribeConnectStore, getConnectSnapshot, getConnectSnapshot);
  const historian = useSyncExternalStore(
    historianStore.subscribe,
    historianStore.getSnapshot,
    historianStore.getSnapshot,
  );
  // Panel-open lives in the store so other surfaces (ConnectPanel REC dot) can
  // deep-link into the panel with a signal preselected.
  const open = historian.panelOpen;

  useEffect(() => {
    if (connect.state !== 'connected' || connect.gatewayUnreachable) {
      historianStore.markConnectUnavailable();
      return;
    }
    void historianStore.refreshStatus();
    const interval = window.setInterval(() => void historianStore.refreshStatus(), STATUS_POLL_MS);
    return () => window.clearInterval(interval);
  }, [connect.gatewayUnreachable, connect.serverUrl, connect.state]);

  // The toolbar button is gated by historian health, but the panel always
  // renders: a ConnectPanel REC-dot deep-link must work even while the
  // historian is disabled — the panel then explains its own status.
  const allowed = historianStatusAllowsPlugin(historian.status);

  return (
    <>
      {allowed && (
        <NavButton
          icon={<Timeline />}
          label="Historian"
          active={open}
          onClick={() => historianStore.setPanelOpen(!open)}
        />
      )}
      <HistorianTrendPanel open={open} onClose={() => historianStore.setPanelOpen(false)} />
    </>
  );
}
