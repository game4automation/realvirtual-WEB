// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Re-exports from the hooks layer.
 * Kept for backwards compatibility — prefer importing from hooks/ directly.
 */
export { RVViewerProvider, useViewer } from '../../hooks/use-viewer';
export { useSignal, useSignalWrite } from '../../hooks/use-signal';
export { useDrives, useHoveredDrive, type DriveHoverState } from '../../hooks/use-drives';
export { usePlugin } from '../../hooks/use-plugin';
export { useSimulationEvent } from '../../hooks/use-simulation-event';
export { useSlot } from '../../hooks/use-slot';
export { useSensorState } from '../../hooks/use-sensor-state';
export { useTransportStats } from '../../hooks/use-transport-stats';
export { useInterfaceStatus } from '../../hooks/use-interface-status';
