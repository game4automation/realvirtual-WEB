// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { FleetPlugin } from '@rv/plugins/fleet-plugin';
import type { PlantPluginDefinition } from '@rv/core/fleet/define-plant-plugin';
import { YardPlanning } from './yard-planning';
import { createYardBinder } from './yard-binder';
import { ChargerLabels } from './charger-label';

/** Compatibility constructor for existing consumers/tests. All lifecycle work is FleetPlugin's. */
export function palletYardPluginClass(definition: PlantPluginDefinition) {
  return class PalletYardPlugin extends FleetPlugin {
    readonly yardPlanning: YardPlanning;
    readonly chargerLabels: ChargerLabels;
    constructor() {
      const planning = new YardPlanning();
      const labels = new ChargerLabels();
      super({ ...definition, parameters: planning }, createYardBinder(planning, labels));
      this.yardPlanning = planning;
      this.chargerLabels = labels;
    }
    get yard() { return this.yardPlanning.yard; }
    get docSize() { return this.yardPlanning.docSize; }
    get docVehicles() { return this.yardPlanning.docVehicles; }
    get lastMaterialize() { return this.yardPlanning.lastMaterialize; }
  };
}
