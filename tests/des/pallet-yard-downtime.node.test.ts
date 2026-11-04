// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * PalletYard AGV breakdowns as a parameter (`PalletYard.AgvMtbf` / `AgvMttr` /
 * `AgvDowntimeStochastic`): the compose rule, the component rules, the
 * admission the Experiments panel needs, and the demo document that ships the
 * experiment (Base = 3 AGVs with breakdowns; 2 AGVs / 4 AGVs / No downtime).
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  DOWNTIME_OWNER, NO_AGV_DOWNTIME, composeAgvDowntimes, composeYard, composeYardWithVehicles, compositionHash,
  downtimeComponents, maxVehiclesFor,
} from '../../src/plugins/models/PalletYard/yard-compose';
import {
  AGV_DOWNTIME_STOCHASTIC_FIELD, AGV_MTBF_FIELD, AGV_MTTR_FIELD, readAgvDowntime, registerPalletYardSchema,
  validateYardComponent,
} from '../../src/plugins/models/PalletYard/yard-schema';
import { checkFieldValue } from '../../src/core/params/rv-param-field';
import { viewerParamFieldEnv } from '../../src/core/params/rv-param-apply';
import { parseVariantsBlock } from '../../src/core/variants/rv-variant-model';
import {
  DEFAULT_GLB, DEMO_AGV_DOWNTIME, DEMO_VARIANTS, ROOT_NAME, ROOT_NODE_ID, SCENE_NAME, readGlb,
} from '../../tools/des-examples/pallet-yard.mjs';

registerPalletYardSchema();

const DOWN = { mtbf: 3600, mttr: 600, stochastic: true };
const YARD_DES_PATH = `${SCENE_NAME}/${ROOT_NAME}`;

describe('compose: one Downtime per generated vehicle', () => {
  it('n vehicles + AgvMtbf > 0 → n Downtime nodes, each aimed at its own vehicle', () => {
    for (let n = 1; n <= maxVehiclesFor(2); n++) {
      const yard = composeYardWithVehicles(2, n, DOWN);
      expect(yard.downtimes, `n=${n}`).toHaveLength(n);
      expect(yard.downtimes!.map((d) => d.vehicle)).toEqual(yard.vehicles.map((v) => v.id));
      expect(yard.downtimes!.map((d) => d.id)).toEqual(yard.vehicles.map((v) => `Downtime_${v.id}`));
      for (const d of yard.downtimes!) expect(d.extras).toEqual({ MTBF: 3600, MTTR: 600, Stochastic: true, Enabled: true });
      // The scene payload aims every breakdown at a vehicle the yard HAS — never at a missing one.
      const targets = downtimeComponents(yard, YARD_DES_PATH).map((c) => c.Downtime.TargetComponentPath);
      expect(targets).toEqual(yard.vehicles.map((v) => `${YARD_DES_PATH}/${v.id}`));
    }
  });

  it('AgvMtbf 0 → no Downtime node, and the yard composes (and hashes) exactly as without the fields', () => {
    for (const n of [1, 2, 3, 4]) {
      const yard = composeYardWithVehicles(2, n, { ...DOWN, mtbf: 0 });
      expect(yard.downtimes).toBeUndefined();
      expect(downtimeComponents(yard, YARD_DES_PATH)).toEqual([]);
      expect(compositionHash(yard)).toBe(compositionHash(composeYardWithVehicles(2, n)));
    }
    expect(composeYardWithVehicles(2, 3, NO_AGV_DOWNTIME)).toEqual(composeYard(2));
  });

  it('parameters the Downtime component would refuse are refused at composition', () => {
    expect(() => composeAgvDowntimes([{ id: 'Stapler_1' }], { ...DOWN, mtbf: -1 })).toThrow(/AgvMtbf/);
    expect(() => composeAgvDowntimes([{ id: 'Stapler_1' }], { ...DOWN, mttr: 0 })).toThrow(/AgvMttr/);
  });
});

describe('component rules and admission', () => {
  it('readAgvDowntime falls back to the defaults for absent or unusable values', () => {
    expect(readAgvDowntime({})).toEqual(NO_AGV_DOWNTIME);
    expect(readAgvDowntime({ AgvMtbf: 3600, AgvMttr: 600, AgvDowntimeStochastic: false })).toEqual({ mtbf: 3600, mttr: 600, stochastic: false });
    expect(readAgvDowntime({ AgvMtbf: -5, AgvMttr: 0 })).toEqual(NO_AGV_DOWNTIME);
  });

  it('validateYardComponent refuses a negative MTBF and an MTTR below one second', () => {
    expect(validateYardComponent({ AgvMtbf: 0, AgvMttr: 1 })).toEqual({});
    expect(Object.keys(validateYardComponent({ AgvMtbf: -1 }))).toEqual([AGV_MTBF_FIELD]);
    expect(Object.keys(validateYardComponent({ AgvMttr: 0.5 }))).toEqual([AGV_MTTR_FIELD]);
  });

  it('the three fields are admissible variant/experiment fields on the rebuild path, like VehicleCount', () => {
    for (const [field, value] of [[AGV_MTBF_FIELD, 1800], [AGV_MTTR_FIELD, 300], [AGV_DOWNTIME_STOCHASTIC_FIELD, false]] as const) {
      const v = checkFieldValue(viewerParamFieldEnv, 'PalletYard', field, value);
      expect(v.ok, field).toBe(true);
      if (v.ok) expect(v.mode).toBe('rebuild');
    }
  });
});

describe('the demo document ships the experiment', () => {
  type Node = { getName(): string; getExtras(): Record<string, unknown>; listChildren(): Node[] };
  let root: Node;
  let sceneExtras: Record<string, unknown>;
  beforeAll(async () => {
    const doc = await readGlb(DEFAULT_GLB);
    const scene = doc.getRoot().listScenes()[0];
    sceneExtras = (scene.getExtras() as { realvirtual?: Record<string, unknown> }).realvirtual ?? {};
    root = (scene.listChildren() as Node[]).find((n) => n.getName() === ROOT_NAME)!;
  }, 120_000);
  const rv = (n: Node) => (n.getExtras() as { realvirtual?: Record<string, unknown> }).realvirtual ?? {};

  it('Base: 3 AGVs with breakdowns, one Downtime per stacker aimed at its DES path', () => {
    const cfg = rv(root).PalletYard as Record<string, unknown>;
    expect(rv(root).NodeId).toBe(ROOT_NODE_ID);
    expect(cfg).not.toHaveProperty('VehicleCount'); // the size derives the fleet; the 2/4-AGV variants override it
    expect(cfg).toMatchObject({ AgvMtbf: DEMO_AGV_DOWNTIME.mtbf, AgvMttr: DEMO_AGV_DOWNTIME.mttr, AgvDowntimeStochastic: true });
    const downs = root.listChildren().filter((n) => rv(n).Downtime);
    expect(downs.map((n) => n.getName())).toEqual(['Downtime_Stapler_1', 'Downtime_Stapler_2', 'Downtime_Stapler_3']);
    for (const n of downs) {
      expect(rv(n).Generated).toEqual({ owner: DOWNTIME_OWNER });
      const target = (rv(n).Downtime as { TargetComponentPath: string }).TargetComponentPath;
      expect(target).toBe(`${YARD_DES_PATH}/${n.getName().replace('Downtime_', '')}`);
      expect(root.listChildren().some((c) => `${YARD_DES_PATH}/${c.getName()}` === target && rv(c).Agv)).toBe(true);
    }
  });

  it('carries the variants 2 AGVs / 4 AGVs / No downtime, each addressing PalletYardRoot', () => {
    const { block, issues } = parseVariantsBlock(sceneExtras);
    expect(issues).toEqual([]);
    expect(block?.variants.map((v) => v.name)).toEqual(['2 AGVs', '4 AGVs', 'No downtime']);
    expect(sceneExtras.Variants).toEqual(DEMO_VARIANTS);
    for (const v of block!.variants) {
      for (const o of v.overrides) {
        expect(o.address).toBe(`#${ROOT_NODE_ID}`);
        expect(checkFieldValue(viewerParamFieldEnv, o.component, o.field, o.value).ok, `${v.name}: ${o.field}`).toBe(true);
      }
    }
  });
});
