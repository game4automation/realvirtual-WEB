// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Model plugins for the DemoRealvirtualWeb demo scene.
 *
 * Registers all demo-specific HMI plugins (KPIs, messages, controls)
 * and optional feature plugins (WebXR, Multiuser, FPV, Annotations).
 * These are only active when DemoRealvirtualWeb.glb or RealvirtualWebTest.glb is loaded.
 */

import type { RVViewer } from '../../../core/rv-viewer';
import type { ModelPluginModule } from '../../../core/rv-model-plugin-manager';

// Demo HMI plugins
import { KpiDemoPlugin } from '../../demo/kpi-demo-plugin';
import { DemoHMIPlugin } from '../../demo/demo-hmi-plugin';
import { TestAxesPlugin } from '../../demo/test-axes-plugin';
import { MachineControlPlugin } from '../../demo/machine-control-plugin';
import { MaintenancePlugin } from '../../demo/maintenance-plugin';

// Optional feature plugins
import { WebXRPlugin } from '../../webxr-plugin';
import { MultiuserPlugin } from '../../multiuser-plugin';
import { FpvPlugin } from '../../fpv-plugin';
import { AnnotationPlugin } from '../../annotation-plugin';
import { AasLinkPlugin } from '../../aas-link-plugin';
import { OrderManagerPlugin } from '../../order-manager-plugin';

// Side-effect import: triggers tooltipRegistry self-registration for 'aas' content type
import '../../aas-link-plugin';

/** Model filenames (without .glb) that this module handles. */
export const models = ['DemoRealvirtualWeb', 'RealvirtualWebTest'];

/** Track registered plugin IDs for clean unregister. */
const registeredIds: string[] = [];

export function registerModelPlugins(viewer: RVViewer): void {
  const instances = [
    // Demo HMI
    new KpiDemoPlugin(),
    new DemoHMIPlugin(),
    new TestAxesPlugin(),
    new MachineControlPlugin(),
    new MaintenancePlugin(),
    // Optional features
    new WebXRPlugin(),
    new MultiuserPlugin(),
    new FpvPlugin(),
    new AnnotationPlugin(),
    new AasLinkPlugin(),
    new OrderManagerPlugin(),
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
