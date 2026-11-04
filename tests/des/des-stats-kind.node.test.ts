// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-2030 F5 — vehicles get their own stats kind ("vehicle") WITHOUT touching the
 * load-bearing `def.kind` ('conveyor': connection resolution, loop saturation).
 */
import { describe, it, expect } from 'vitest';
import { AGV_DEF } from '../helpers/agv-harness';
import { kindOf } from '../../src/plugins/des/des-flow-order';
import type { DESComponent } from '../../src/plugins/des/rv-des-component';

const asComp = (c: unknown) => c as DESComponent;

describe('kindOf / statsKind', () => {
  it('reports "vehicle" for an Agv instance while def.kind stays "conveyor"', () => {
    expect(AGV_DEF.kind).toBe('conveyor');
    expect(AGV_DEF.statsKind).toBe('vehicle');
    expect(kindOf(asComp({ def: AGV_DEF }))).toBe('vehicle');
  });

  it('falls back to def.kind when no statsKind is set', () => {
    expect(kindOf(asComp({ def: { kind: 'conveyor' } }))).toBe('conveyor');
    expect(kindOf(asComp({ def: { kind: 'source' } }))).toBe('source');
  });

  it('falls back to the DES class type without a definition', () => {
    class DESStation { static type = 'DESStation'; }
    expect(kindOf(asComp(new DESStation()))).toBe('station');
  });
});
