// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Why CONNECT is not streaming live signal values, or null when it is (or would be).
 *
 * The live stream is MODEL-SCOPED: {@link ConnectPlugin.onModelLoaded} is what creates the
 * WebSocket, and a shared/untrusted GLB is deliberately excluded from it (plan-386 F17). The REST
 * connection is independent, so an interface can sit at "Connected" — gateway reading the PLC,
 * values in its store — while the browser has no stream at all and every signal chip stays blank.
 *
 * Exported and used by BOTH the attach path and the CONNECT panel's explanation, so the panel can
 * never describe a rule the plugin no longer follows.
 */
export type ConnectStreamBlock = 'no-model' | 'untrusted' | null;

export function connectStreamBlock(hasModel: boolean, trusted: boolean): ConnectStreamBlock {
  if (!hasModel) return 'no-model';
  if (!trusted) return 'untrusted';
  return null;
}
