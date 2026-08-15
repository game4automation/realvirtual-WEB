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
import { ModelOptionPlugin, remapAasLink } from '../model-option-plugin';
import { OperatorHmiControlsPlugin } from './operator-hmi-controls';
import { RobotFollowPositionPlugin } from './robot-follow-position';
// Per-model override of the instruction-highlight palette (info/maintenance/
// warning/error/success) lives in rv-custom-runtime-instruction:
//   import { setInstructionTypeColors, resetInstructionTypeColors }
//     from '../../../core/engine/rv-custom-runtime-instruction';
// A customer loader can recolor any subset — see the commented example in
// registerModelPlugins / unregisterModelPlugins below.

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

// Kiosk Mode — disabled for now, re-enable when tour content is ready
// import type { KioskPlugin } from '../../kiosk-plugin';
// import { demoKioskTour } from './demo-kiosk-tour';

// Side-effect import: triggers tooltipRegistry self-registration for 'aas' content type
import '../../aas-link-plugin';

// Side-effect import: opt this demo into the live drive HUD tooltip. The
// core HMI no longer side-effect-imports DriveTooltipContent — it's
// optional, per-deployment. Model-plugin packs that want the floating
// "Position / Speed / Target" hover card import it here.
import '../../../core/hmi/tooltip/DriveTooltipContent';

/** The Festo EMME-AS-40 servo motor AAS that ships in the base GLB. */
const FESTO_MOTOR_AAS = 'http://smart.festo.com/aas/99920200617190044000012858';

/** Supplier variants of the servo motor. `aas` is the id; `desc` the AAS panel label. */
const MOTOR_SUPPLIERS: Record<string, { aas: string; desc: string }> = {
  bosch: {
    aas: 'https://aas.boschrexroth.com/ctrlxdrive/R911410072-MS2N-Demo-0001',
    desc: 'Bosch Rexroth ctrlX DRIVE - MS2N Servomotor',
  },
  sew: {
    aas: 'https://demo.realvirtual.io/aas/sew/KA47-DRN90M4-Demo-0001',
    desc: 'SEW KA47-DRN90M4 Gearmotor',
  },
};

/**
 * Every servo-motor supplier AAS an option may need to replace. The Festo motor AAS is
 * the GLB default, but some motor nodes ship hard-wired to a non-default supplier (e.g.
 * SEW) directly in the GLB. Remapping ALL of these makes the swap idempotent and catches
 * those motors too — otherwise selecting Bosch would leave the SEW-wired motors on SEW.
 */
const MOTOR_SUPPLIER_AAS = [
  FESTO_MOTOR_AAS,
  ...Object.values(MOTOR_SUPPLIERS).map((s) => s.aas),
];

/**
 * Apply the active supplier option (`?option=`) by issuing rv_extras commands.
 * Re-points every servo motor's AAS to the chosen supplier — the Festo pneumatic
 * cylinder (a separate AAS) is left untouched. Add more commands per option here
 * (e.g. setComponentField) to manipulate any rv_extras property.
 *
 * No option (or an unknown one) means the FESTO STANDARD: motors hard-wired to
 * another supplier in the exported GLB are normalized back to the Festo motor AAS,
 * so the base demo is single-supplier and SEW/Bosch appear only via `?option=`.
 */
function applyModelOption(viewer: RVViewer, option: string | null): void {
  // No option (or an unknown one) means the FESTO STANDARD: motors hard-wired to
  // another supplier in the exported GLB are normalized back to the Festo motor AAS,
  // so the base demo is single-supplier and SEW/Bosch appear only via `?option=`.
  const target = (option && MOTOR_SUPPLIERS[option])
    || { aas: FESTO_MOTOR_AAS, desc: 'Festo EMME-AS-40 Servo Motor' };
  // Map from any known motor-supplier AAS (Festo default, SEW, Bosch) to the target,
  // so motors hard-wired to another supplier in the GLB are switched over as well.
  for (const from of MOTOR_SUPPLIER_AAS) {
    if (from !== target.aas) remapAasLink(viewer, from, target.aas, target.desc);
  }
}

/** Model filenames (without .glb) that this module handles. */
export const models = ['DemoRealvirtualWeb', 'RealvirtualWebTest'];

/** Track registered plugin IDs for clean unregister. */
const registeredIds: string[] = [];

export function registerModelPlugins(viewer: RVViewer): void {
  // Optional: recolor the 3D instruction highlights for this model. Pass only
  // the types you want to change (0xRRGGBB); the rest keep the product defaults.
  // Must be paired with resetInstructionTypeColors() in unregisterModelPlugins.
  //   setInstructionTypeColors({ maintenance: 0x673ab7, info: 0x00bcd4 });
  const instances = [
    // Model options (AAS supplier swap) — MUST be first so the remap runs
    // before AasLinkPlugin pre-parses the AASX for the swapped ids.
    new ModelOptionPlugin(applyModelOption),
    // Hide engineering sim controls (Play/Pause/Reset + Realtime/DES) in HMI mode.
    new OperatorHmiControlsPlugin(),
    new RobotFollowPositionPlugin(),
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

  // Kiosk tours — disabled for now, re-enable when tour content is ready
  // const kiosk = viewer.getPlugin<KioskPlugin>('kiosk');
  // if (kiosk) {
  //   for (const modelName of models) {
  //     kiosk.registerTour(modelName, demoKioskTour);
  //   }
  // }
}

export function unregisterModelPlugins(viewer: RVViewer): void {
  // If you called setInstructionTypeColors() in registerModelPlugins, restore
  // the default palette here so the override does not leak into the next model:
  //   resetInstructionTypeColors();
  for (const id of registeredIds) {
    viewer.removePlugin(id);
  }
  registeredIds.length = 0;

  // const kiosk = viewer.getPlugin<KioskPlugin>('kiosk');
  // if (kiosk) {
  //   for (const modelName of models) {
  //     kiosk.unregisterTour(modelName);
  //   }
  // }
}

export default { models, registerModelPlugins, unregisterModelPlugins } satisfies ModelPluginModule;
