// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Public rv-embed library entry and custom-element registration. */

import { setDracoDecoderPath } from '../core/engine/rv-glb-parse';
import { defineRVEmbedElement } from './rv-embed-element';

// Vite keeps the engine in `chunks/`; resolve back to the root-level decoder
// directory from that CDN module, never relative to the host document.
setDracoDecoderPath(new URL('../draco/', import.meta.url).href);
defineRVEmbedElement();

export { RVEmbedViewer } from './rv-embed-viewer';
export type {
  RehydrateResult,
  RVEmbedCameraApi,
  RVEmbedCameraFocusOptions,
  RVEmbedCameraPose,
  RVEmbedNodeTransformState,
  RVEmbedOptions,
  RVEmbedSignalsApi,
  RVEmbedSignalValue,
} from './rv-embed-viewer';
export {
  defineRVEmbedElement,
  RVEmbedElement,
  RV_EMBED_DWELL_MS,
  RV_EMBED_VISIBILITY_THRESHOLD,
} from './rv-embed-element';
export type {
  RVEmbedElementCameraApi,
  RVEmbedElementSignalsApi,
  RVEmbedElementViewerApi,
  RVEmbedErrorDetail,
  RVEmbedInteractiveMode,
  RVEmbedReadyDetail,
  RVEmbedRunMode,
} from './rv-embed-element';
export { RVEmbedDirector } from './rv-embed-director';
export type {
  RVEmbedDirectorActionDetail,
  RVEmbedDirectorApi,
  RVEmbedDirectorCameraAction,
  RVEmbedDirectorCameraPose,
  RVEmbedDirectorClickAction,
  RVEmbedDirectorContextMenuAction,
  RVEmbedDirectorErrorDetail,
  RVEmbedDirectorEvents,
  RVEmbedDirectorGhostCursorAction,
  RVEmbedDirectorOverlayAction,
  RVEmbedDirectorPoint,
  RVEmbedDirectorScript,
  RVEmbedDirectorSignalAction,
  RVEmbedDirectorStep,
  RVEmbedDirectorStepDetail,
  RVEmbedDirectorVector3,
  RVEmbedGhostCursorState,
} from './rv-embed-director';
export { RVEmbedUIFragments } from './rv-embed-ui-fragments';
export type { RVEmbedUIFragmentsHost } from './rv-embed-ui-fragments';
export { SimulationLoop } from '../core/engine/rv-simulation-loop';
export type { SignalStore } from '../core/engine/rv-signal-store';
