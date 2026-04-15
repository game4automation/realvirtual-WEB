// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Industrial interface plugins for the WebViewer.
 *
 * Re-exports all interface classes, the manager, and settings store.
 */

// Base class & types
export {
  BaseIndustrialInterface,
  parseSignalType,
  defaultValueForType,
  type SignalDescriptor,
  type SignalDirection,
  type SignalType,
  type InterfaceConnectionState,
  type InterfaceStateChange,
} from './base-industrial-interface';

// Manager (mutex + registry)
export { InterfaceManager } from './interface-manager';

// Settings persistence
export {
  loadInterfaceSettings,
  saveInterfaceSettings,
  INTERFACE_DEFAULTS,
  type InterfaceSettings,
  type InterfaceType,
} from './interface-settings-store';

// Concrete implementations
export { WebSocketRealtimeInterface } from './websocket-realtime-interface';
export { CtrlXInterface } from './ctrlx-interface';
