// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Generic Tooltip System — Barrel export.
 *
 * Re-exports the complete tooltip public API for convenient imports:
 *
 * ```ts
 * import { tooltipStore, tooltipRegistry, TooltipLayer } from './core/hmi/tooltip';
 * ```
 */

// Store
export {
  TooltipStore,
  tooltipStore,
  type TooltipMode,
  type TooltipContentType,
  type TooltipLifecycle,
  type TooltipData,
  type TooltipEntry,
  type VisibleTooltip,
  type TooltipState,
} from './tooltip-store';

// Registry
export {
  TooltipContentRegistry,
  tooltipRegistry,
  type TooltipContentProps,
  type TooltipProviderEntry,
  type TooltipDataResolver,
} from './tooltip-registry';

// Utilities
export {
  projectToScreen,
  clampToViewport,
  type ScreenProjection,
} from './tooltip-utils';

// React components
export { TooltipLayer } from './TooltipLayer';
export { GenericTooltipController } from './GenericTooltipController';
export { DriveTooltipContent, type DriveTooltipData } from './DriveTooltipContent';
export { PipeTooltipContent, type PipeTooltipData } from './PipeTooltipContent';
export { TankTooltipContent, type TankTooltipData } from './TankTooltipContent';
export { PumpTooltipContent, type PumpTooltipData } from './PumpTooltipContent';
export { ProcessingUnitTooltipContent, type ProcessingUnitTooltipData } from './ProcessingUnitTooltipContent';
export { MetadataTooltipContent, type MetadataTooltipData } from './MetadataTooltipContent';
export { PdfTooltipSection, type PdfTooltipData } from './PdfTooltipSection';
