// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * signal-connector.body.ts — body of the on-demand SignalConnector feature
 * (plan-2227). Imported ONLY through `signal-connector.register.ts`. Importing it
 * registers the component (module side effect of `rv-signal-connector`) before
 * `activate` runs.
 *
 * The CONNECT mapping feed (R2) is installed on import: the network checks fan-in
 * and cycles against `bridge_list.mappings` from the bridge cache of
 * `connect-store` — no new request path (an unloaded cache is loaded by the same
 * `reloadConnectBridges` the usage index uses); not connected = nothing to check.
 */

import type { RVViewer } from '../core/rv-viewer';
import { setSignalConnectorGatewayFeed } from '../core/engine/rv-signal-connector';
import {
  getConnectBridges,
  getConnectSnapshot,
  reloadConnectBridges,
  subscribeConnectBridges,
  subscribeConnectStore,
} from '../core/hmi/connect-store';

// Installed on IMPORT (not in `activate`): the editor commands import this body too
// (`signal-connector-commands.ts`), outside the FeatureLoader.
installGatewayFeed();

//! Activates the SignalConnector. Idempotent — everything happened on import.
export function activate(_viewer: RVViewer): void {
  // nothing left to do
}

function installGatewayFeed(): void {
  setSignalConnectorGatewayFeed({
    get: () => {
      if (getConnectSnapshot().state !== 'connected') return null;
      const bridges = getConnectBridges();
      if (!bridges.loaded) { void reloadConnectBridges(); return null; }
      return bridges.mappings;
    },
    subscribe: (onChange) => {
      let state = getConnectSnapshot().state;
      const offStore = subscribeConnectStore(() => {
        const next = getConnectSnapshot().state;
        if (next === state) return; // status polls change the snapshot constantly — only the state matters
        state = next;
        onChange();
      });
      const offBridges = subscribeConnectBridges(onChange);
      return () => { offStore(); offBridges(); };
    },
  });
}
