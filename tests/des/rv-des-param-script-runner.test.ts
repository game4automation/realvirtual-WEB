// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-265 F4 — the parametrisation-script runner executes a setter-only script
 * on the real QuickJS host (plan-210), collecting its self.setField(...) calls
 * and surfacing errors as { ok:false } (never a throw / hang). Scheduling
 * primitives are simply not exposed, so even an unlinted script cannot schedule.
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { RVScriptHost } from '../../src/core/engine/rv-script-host';
import { runParamScript } from '@rv-private/plugins/des/des-param-script-runner';

let host: RVScriptHost;
beforeAll(async () => { host = await RVScriptHost.create(); });
afterAll(() => host?.dispose());

describe('DES param-script runner', () => {
  it('collects self.setField calls in order (scalars only)', () => {
    const res = runParamScript(host,
      "self.setField('Src', 'DESSource', 'InterArrivalTime', 3.5);\n" +
      "self.setField('MC02', 'Drive', 'Enabled', false);\n" +
      "self.setField('Buf', 'DESStation', 'Mode', 'fifo');");
    expect(res.ok).toBe(true);
    expect(res.fields).toEqual([
      { path: 'Src', component: 'DESSource', field: 'InterArrivalTime', value: 3.5 },
      { path: 'MC02', component: 'Drive', field: 'Enabled', value: false },
      { path: 'Buf', component: 'DESStation', field: 'Mode', value: 'fifo' },
    ]);
  });

  it('supports plain JS (loops/vars) around the setters', () => {
    const res = runParamScript(host,
      "for (let i = 0; i < 3; i++) self.setField('S'+i, 'DESSource', 'InterArrivalTime', i);");
    expect(res.ok).toBe(true);
    expect(res.fields.map((f) => f.path)).toEqual(['S0', 'S1', 'S2']);
    expect(res.fields.map((f) => f.value)).toEqual([0, 1, 2]);
  });

  it('drops non-scalar values (setField only sets scalars)', () => {
    const res = runParamScript(host, "self.setField('N', 'C', 'F', { a: 1 });");
    expect(res.ok).toBe(true);
    expect(res.fields).toHaveLength(0);
  });

  it('returns { ok:false } with an error on a syntax error (no throw)', () => {
    const res = runParamScript(host, 'self.setField(');
    expect(res.ok).toBe(false);
    expect(res.fields).toHaveLength(0);
    expect(res.error).toBeDefined();
  });

  it('returns { ok:false } on a runtime error', () => {
    const res = runParamScript(host, 'undefinedFn();');
    expect(res.ok).toBe(false);
    expect(res.error).toBeDefined();
  });
});
