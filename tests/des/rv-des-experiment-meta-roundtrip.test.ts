// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * test-des-experiment-meta-roundtrip-migration (plan-265 §9.9) — the plan-265
 * fields (replicationCount / paramOverrides / paramScript / enabled) survive the
 * field-wise rebuild in BOTH parseExperimentMeta AND createExperimentMeta (they
 * would otherwise be silently dropped). An old manifest lacking them loads
 * without crashing and defaults replicationCount→1 / paramOverrides→[] /
 * enabled→true. `version` is the optimistic-lock counter, NOT a schema version —
 * there is no v-bump.
 */

import { describe, it, expect } from 'vitest';
import {
  createExperimentMeta,
  parseExperimentMeta,
  type ExperimentMeta,
  type ParamOverride,
} from '@rv-private/plugins/des/rv-des-experiment-model';

const OV: ParamOverride = { path: 'Src', component: 'DESSource', field: 'InterArrivalTime', value: 3.0 };

describe('ExperimentMeta roundtrip (plan-265 fields)', () => {
  it('createExperimentMeta seeds the new fields with defaults', () => {
    const m = createExperimentMeta({ model: 'M', experiment: 'E', baseSeed: 42 });
    expect(m.replicationCount).toBe(1);
    expect(m.paramOverrides).toEqual([]);
    expect(m.enabled).toBe(true);
    expect(m.paramScript).toBeUndefined();
  });

  it('createExperimentMeta carries explicit values', () => {
    const m = createExperimentMeta({
      model: 'M', experiment: 'E', baseSeed: 42,
      replicationCount: 10, paramOverrides: [OV], paramScript: "self.setField('a','b','c',1)", enabled: false,
    });
    expect(m.replicationCount).toBe(10);
    expect(m.paramOverrides).toEqual([OV]);
    expect(m.paramScript).toBe("self.setField('a','b','c',1)");
    expect(m.enabled).toBe(false);
  });

  it('parseExperimentMeta preserves the new fields across a JSON roundtrip', () => {
    const m = createExperimentMeta({
      model: 'M', experiment: 'E', baseSeed: 7,
      replicationCount: 5, paramOverrides: [OV], paramScript: 'x', enabled: false,
    });
    const back = parseExperimentMeta(JSON.stringify(m));
    expect(back).not.toBeNull();
    expect(back!.replicationCount).toBe(5);
    expect(back!.paramOverrides).toEqual([OV]);
    expect(back!.paramScript).toBe('x');
    expect(back!.enabled).toBe(false);
  });

  it('an old manifest without the fields defaults them (no crash)', () => {
    const legacy = {
      version: 3, model: 'M', experiment: 'Legacy', baseSeed: 42,
      endTime: 0, statResetTime: 0, createdAt: 123, replications: [],
    };
    const m = parseExperimentMeta(JSON.stringify(legacy)) as ExperimentMeta;
    expect(m).not.toBeNull();
    expect(m.replicationCount).toBe(1);
    expect(m.paramOverrides).toEqual([]);
    expect(m.enabled).toBe(true);
    expect(m.paramScript).toBeUndefined();
    expect(m.version).toBe(3); // optimistic-lock counter untouched (no v-bump)
  });

  it('drops malformed override entries defensively', () => {
    const raw = {
      version: 0, model: 'M', experiment: 'E', baseSeed: 42, endTime: 0, statResetTime: 0,
      createdAt: 0, replications: [],
      paramOverrides: [
        OV,
        { path: 'x', component: 'y' },                 // missing field → dropped
        { path: 'x', component: 'y', field: 'z', value: { bad: 1 } }, // non-scalar value → dropped
      ],
    };
    const m = parseExperimentMeta(JSON.stringify(raw))!;
    expect(m.paramOverrides).toEqual([OV]);
  });
});
