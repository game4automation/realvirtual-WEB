// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Model plugins for the DemoProcessIndustry demo scene.
 *
 * Activates the ProcessIndustryPlugin when DemoProcessIndustry.glb is loaded.
 */

import type { RVViewer } from '../../../core/rv-viewer';
import type { ModelPluginModule } from '../../../core/rv-model-plugin-manager';

import { ProcessIndustryPlugin } from '../../processindustry-plugin';
import { TankFillHistoryPlugin } from '../../tank-fill-history-plugin';
import { PipeColoringPlugin } from '../../pipe-coloring-plugin';

/** Model filenames (without .glb) that this module handles. */
export const models = [
  'DemoProcessIndustry',
  'demoprocessindustry',
  // Legacy / alternate casing kept for backward compatibility.
  'DemoProcessIndustryPlant',
  'demoprocessindustryplant',
];

const registeredIds: string[] = [];

export function registerModelPlugins(viewer: RVViewer): void {
  // Order matters: ProcessIndustryPlugin must be use()d first so the
  // TankFillHistoryPlugin can resolve it via viewer.getPlugin() during
  // its own onModelLoaded.
  const instances = [
    new ProcessIndustryPlugin(),
    new TankFillHistoryPlugin(),
    new PipeColoringPlugin(),
  ];
  for (const p of instances) {
    viewer.use(p);
    registeredIds.push(p.id);
  }
}

export function unregisterModelPlugins(viewer: RVViewer): void {
  for (const id of registeredIds) {
    viewer.removePlugin(id);
  }
  registeredIds.length = 0;
}

export default { models, registerModelPlugins, unregisterModelPlugins } satisfies ModelPluginModule;
