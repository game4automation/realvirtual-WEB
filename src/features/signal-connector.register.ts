// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

// plan-2227: the SignalConnector loads on demand (pattern of des.register.ts). Every viewer
// declares it; the load path awaits `component:SignalConnector` before the bake. Type-only imports.
import type { FeatureLoader } from '../core/rv-feature-loader';

export const SIGNAL_CONNECTOR_FEATURE = 'signal-connector';

export function defineSignalConnectorFeature(features: FeatureLoader): void {
  features.define({
    id: SIGNAL_CONNECTOR_FEATURE,
    label: 'Signal connectors',
    activation: ['component:SignalConnector', 'command:signalConnector.setMode', 'command:signalConnector.createBits'],
    origin: 'core',
    load: () => import('./signal-connector.body'),
  });
}
