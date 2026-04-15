// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * CtrlXInterface — Bosch Rexroth ctrlX CORE interface.
 *
 * Extends WebSocketRealtimeInterface with ctrlX-specific URL and authentication:
 *   - SSL mode: wss://address:443/ctrlx-rv-bridge/ws (via reverse proxy, needs auth token)
 *   - Direct mode: ws://address:8080/ (direct to bridge snap, no auth)
 *
 * The wire protocol is identical to WebSocket Realtime v2.
 */

import { WebSocketRealtimeInterface } from './websocket-realtime-interface';
import type { InterfaceSettings } from './interface-settings-store';

export class CtrlXInterface extends WebSocketRealtimeInterface {
  override readonly id: string = 'ctrlx';
  override readonly protocolName: string = 'ctrlX (Bosch Rexroth)';

  /**
   * Override URL building to apply ctrlX-specific defaults.
   * SSL on:  wss://address:443/ctrlx-rv-bridge/ws?access_token=TOKEN
   * SSL off: ws://address:8080/
   */
  protected override buildUrl(
    scheme: string,
    address: string,
    _port: number,
    _path: string,
    settings: InterfaceSettings,
  ): string {
    if (settings.wsUseSSL) {
      const base = `wss://${address}:443/ctrlx-rv-bridge/ws`;
      if (settings.wsAuthToken) {
        return `${base}?access_token=${encodeURIComponent(settings.wsAuthToken)}`;
      }
      return base;
    }
    // Direct bridge connection — no auth, port 8080
    return `ws://${address}:8080/`;
  }
}
