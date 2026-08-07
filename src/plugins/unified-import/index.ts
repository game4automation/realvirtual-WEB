// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * unified-import — Unified CAD Import plugin (plan-238).
 *
 * Registers the mode-independent "Import" toolbar button (Unified Import
 * Dialog) and the core GLB-file provider. Commercial providers (STEP,
 * Unity Asset Manager, Onshape) register themselves into the same
 * `importProviderRegistry` from `@rv-private` — in a public build only the
 * GLB-file provider is present.
 */

import { BaseViewerPlugin } from '../../core/rv-base-plugin';
import type { RVViewer } from '../../core/rv-viewer';
import type { PluginContext } from '../../core/rv-plugin-context';
import type { UISlotEntry } from '../../core/rv-ui-plugin';
import { modeContext } from '../../core/rv-mode-manager';
import { importProviderRegistry } from '../../core/import/rv-import-provider';
import { createGlbFileProvider } from './glb-file-provider';
import { UnifiedImportButton } from './UnifiedImportButton';

export class UnifiedImportPlugin extends BaseViewerPlugin {
  readonly id = 'unified-import';

  // The unified import button is EDITOR-ONLY: a delivered digital twin (HMI
  // mode) is machine documentation — an end customer must not be invited to
  // mutate it, and Planner placement goes through the library instead. The
  // dialog itself still supports the planner sink, so widening this rule back
  // is a one-line change.
  readonly slots: UISlotEntry[] = [
    {
      slot: 'button-group',
      component: UnifiedImportButton,
      order: 5,
      visibilityRule: { shownOnlyIn: [modeContext('editor')] },
    },
  ];

  init(viewer: RVViewer, context?: PluginContext): void {
    super.init(viewer, context);
    // Core provider — always available (public + private builds).
    importProviderRegistry.register(createGlbFileProvider());
  }
}

export { createGlbFileProvider, resolveGlbFiles, glbBaseName } from './glb-file-provider';
export { UnifiedImportDialog } from './UnifiedImportDialog';
