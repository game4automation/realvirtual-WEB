// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * PalletSource.ts -- DES-only pallet/blister/part hierarchy source.
 *
 * The wrapper stays on the unified defineMaterialFlow path. It creates one
 * logical pallet tree when a run starts; snapshot v3 owns reset/restore state.
 */

import type { Object3D } from 'three';
import {
  defineMaterialFlow,
  type MaterialFlowDefinition,
} from '../../../core/material-flow/define-material-flow';
import type {
  MaterialFlowSelf,
  MU,
  MuRef,
} from '../../../core/material-flow/material-flow-self';

interface PalletSourceLocal {
  palletTemplateId: string;
  blisterTemplateId: string;
  partTemplateId: string;
  blisterCount: number;
  partsPerBlister: number;
  carrierCapacity: number;
  gridRows: number;
  gridColumns: number;
  gridPitchM: number;
}

type PalletSourceSelf = MaterialFlowSelf<PalletSourceLocal>;
type HierarchyMU = MU & {
  generation: number;
  childMUs: MuRef[];
  parentMU: MuRef | null;
  isLoaded: boolean;
  prop: NonNullable<MU['prop']>;
};

function numberProp(self: PalletSourceSelf, key: string, fallback: number): number {
  const value = self.prop[key];
  return typeof value === 'number' ? value : fallback;
}

function stringProp(self: PalletSourceSelf, key: string): string {
  const value = self.prop[key];
  return typeof value === 'string' ? value : '';
}

function asHierarchyMU(mu: MU): HierarchyMU {
  const hierarchy = mu as HierarchyMU;
  hierarchy.childMUs ??= [];
  hierarchy.parentMU ??= null;
  hierarchy.prop ??= {};
  return hierarchy;
}

function gridPosition(index: number, local: PalletSourceLocal): [number, number, number] {
  const perLayer = local.gridRows * local.gridColumns;
  const layerIndex = index % perLayer;
  const layer = Math.floor(index / perLayer);
  const row = Math.floor(layerIndex / local.gridColumns);
  const column = layerIndex % local.gridColumns;
  return [column * local.gridPitchM, layer * local.gridPitchM, row * local.gridPitchM];
}

function link(parent: HierarchyMU, child: HierarchyMU, position: [number, number, number]): void {
  parent.childMUs.push({ id: child.id, gen: child.generation });
  child.parentMU = { id: parent.id, gen: parent.generation };
  child.isLoaded = true;
  child.prop.gridPosition = position;
  const parentVisual = parent.visual as { isInstanced?: boolean; node?: Object3D } | null | undefined;
  const childVisual = child.visual as { isInstanced?: boolean; node?: Object3D } | null | undefined;
  if (!parentVisual?.isInstanced && parentVisual?.node && !childVisual?.isInstanced && childVisual?.node) {
    parentVisual.node.attach(childVisual.node);
    childVisual.node.position.set(position[0], position[1], position[2]);
  }
}

export const PalletSource: MaterialFlowDefinition<PalletSourceSelf> = defineMaterialFlow<PalletSourceSelf>({
  type: 'PalletSource',
  kind: 'source',
  models: ['*PalletSource*'],
  muVisualTemplateProperties: ['PalletTemplateRef', 'BlisterTemplateRef', 'PartTemplateRef'],
  description: 'Generates pallets preloaded with blister and part hierarchies.',
  schema: {
    PalletTemplateRef: { type: 'string', default: '' },
    BlisterTemplateRef: { type: 'string', default: '' },
    PartTemplateRef: { type: 'string', default: '' },
    BlisterCount: { type: 'number', default: 1 },
    PartsPerBlister: { type: 'number', default: 1 },
    CarrierCapacity: { type: 'number', default: 1 },
    GridRows: { type: 'number', default: 1 },
    GridColumns: { type: 'number', default: 1 },
    GridPitch: { type: 'number', default: 100 },
    MaxCapacity: { type: 'number', default: 1 },
  },
  state: (): PalletSourceLocal => ({
    palletTemplateId: '', blisterTemplateId: '', partTemplateId: '',
    blisterCount: 1, partsPerBlister: 1, carrierCapacity: 1,
    gridRows: 1, gridColumns: 1, gridPitchM: 0.1,
  }),

  setup(self): void {
    const local = self.local;
    local.palletTemplateId = stringProp(self, 'PalletTemplateRef');
    local.blisterTemplateId = stringProp(self, 'BlisterTemplateRef');
    local.partTemplateId = stringProp(self, 'PartTemplateRef');
    local.blisterCount = numberProp(self, 'BlisterCount', 1);
    local.partsPerBlister = numberProp(self, 'PartsPerBlister', 1);
    local.carrierCapacity = numberProp(self, 'CarrierCapacity', local.partsPerBlister);
    local.gridRows = numberProp(self, 'GridRows', 1);
    local.gridColumns = numberProp(self, 'GridColumns', 1);
    local.gridPitchM = numberProp(self, 'GridPitch', 100) * 0.001;
    for (const [name, value] of [
      ['BlisterCount', local.blisterCount], ['PartsPerBlister', local.partsPerBlister],
      ['CarrierCapacity', local.carrierCapacity], ['GridRows', local.gridRows],
      ['GridColumns', local.gridColumns],
    ] as const) {
      if (!Number.isInteger(value) || value <= 0) {
        throw new Error(`PalletSource: ${name} must be a positive integer`);
      }
    }
    if (!Number.isFinite(local.gridPitchM) || local.gridPitchM <= 0) {
      throw new Error('PalletSource: GridPitch must be greater than zero');
    }
    if (local.partsPerBlister > local.carrierCapacity) {
      throw new Error('PalletSource: PartsPerBlister exceeds CarrierCapacity');
    }
    self.prop.generatedPallets ??= 0;
  },

  continuous: {},

  des: {
    onGenerate(self): void {
      const local = self.local;
      const pallet = asHierarchyMU(self.spawn(local.palletTemplateId));
      pallet.carrierType = 'pallet';
      pallet.carrierCapacity = local.blisterCount;
      pallet.visualTemplateId = local.palletTemplateId;

      for (let blisterIndex = 0; blisterIndex < local.blisterCount; blisterIndex++) {
        const blister = asHierarchyMU(self.spawn(local.blisterTemplateId));
        blister.carrierType = 'blister';
        blister.carrierCapacity = local.carrierCapacity;
        blister.visualTemplateId = local.blisterTemplateId;
        link(pallet, blister, gridPosition(blisterIndex, local));

        for (let partIndex = 0; partIndex < local.partsPerBlister; partIndex++) {
          const part = asHierarchyMU(self.spawn(local.partTemplateId));
          part.carrierType = 'part';
          part.visualTemplateId = local.partTemplateId;
          link(blister, part, gridPosition(partIndex, local));
        }
      }

      self.prop.generatedPallets = (numberProp(self, 'generatedPallets', 0) + 1);
      self.transfer(pallet);
    },
  },
});

export default PalletSource;
