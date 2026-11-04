// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { definePlantPlugin, plantPluginExports } from '@rv/core/fleet/define-plant-plugin';
import { RETRIEVAL_RULES } from '@rv/core/fleet/core/strategies';
import { intervalOf } from '@rv/core/fleet/core/order-sources';
import { DEFAULT_LAMP_MAP } from '@rv/core/fleet/exec/lamp-map';
import { DEFAULT_YARD } from './yard-compose';
import { YardPlanning } from './yard-planning';
import { createYardBinder } from './yard-binder';
import { palletYardPluginClass } from './yard-plugin';

const cfg = DEFAULT_YARD.config;
const yardPlanning = new YardPlanning();
const definition = definePlantPlugin({
  apiVersion: 1,
  id: 'pallet-yard',
  config: {
    takts: cfg.stations.filter(s => s.kind === 'pick').map((s, i) => ({
      station: s.id, intervalSec: intervalOf(cfg.production, i), startSec: cfg.production.phaseSec[i],
    })),
    pauses: cfg.shippingPauses,
    // Keep the proven lamp-name aliases and both Lamp_EyeL/Lamp_EyeR defaults.
    lamps: {},
  },
  retrieval: RETRIEVAL_RULES[cfg.retrieval ?? 'legacy-fifo'],
  lampMap: DEFAULT_LAMP_MAP,
  parameters: yardPlanning,
});
export default definition;
export const { registerModelPlugins, unregisterModelPlugins } = plantPluginExports(definition, createYardBinder(yardPlanning));
export const runInAuthoringModes = ['des'];

// Still consumed through the canonical Private project's shim; local tests use direct sources.
export { ContinuousHandover, SPAWN_PROBLEM_CODE, SEAT_GLIDE_STEP_M, DROP_RETRY_SEC } from '@rv/core/fleet/continuous/handover';
export { bindContinuousYard } from './continuous-bind';
export { STICH_EXIT_LIMIT_SEC, yardChargingView, palletYardBakeClaims, yardConfigOf, bindDesYard, startDesRuntime, startContinuousRuntime, type YardRun, type YardRunOptions } from './yard-runtime';
export const PalletYardPlugin = palletYardPluginClass(definition);
export type PalletYardPlugin = InstanceType<typeof PalletYardPlugin>;
