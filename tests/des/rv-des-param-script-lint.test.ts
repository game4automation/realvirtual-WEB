// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * test-des-param-script-setter-lint (plan-265 §9.7) — F4: the NEW setter-only
 * linter flags runtime primitives (self.in / self.at / …) and passes
 * self.setField(...). (The existing continuous/event lint does NOT check this.)
 */

import { describe, it, expect } from 'vitest';
import { lintParamScript, isValidParamScript } from '../../src/plugins/sim-controller/des-param-script-lint';

describe('DES param-script setter-only lint', () => {
  it('passes a pure setter script', () => {
    const src = [
      "self.setField('Src', 'DESSource', 'InterArrivalTime', 3.0);",
      "self.setField('Buf', 'DESStation', 'MaxCapacity', 40);",
    ].join('\n');
    expect(lintParamScript(src)).toEqual([]);
    expect(isValidParamScript(src)).toBe(true);
  });

  it('flags self.in(...) and self.at(...) as errors', () => {
    const src = [
      "self.setField('Src', 'DESSource', 'InterArrivalTime', 3.0);",
      "self.in(5, 'Arrival');",
      "self.at(10, 'Done');",
    ].join('\n');
    const errs = lintParamScript(src);
    expect(errs.map((e) => e.token).sort()).toEqual(['self.at', 'self.in']);
    expect(errs.find((e) => e.token === 'self.in')?.line).toBe(2);
    expect(errs.find((e) => e.token === 'self.at')?.line).toBe(3);
    expect(isValidParamScript(src)).toBe(false);
  });

  it('flags self.now, self.cancel, self.spawn, self.transfer', () => {
    expect(lintParamScript('const t = self.now;')).toHaveLength(1);
    expect(lintParamScript('self.cancel(1);')).toHaveLength(1);
    expect(lintParamScript('self.spawn();')).toHaveLength(1);
    expect(lintParamScript('self.transfer(mu);')).toHaveLength(1);
  });

  it('does not false-positive on comments or strings', () => {
    const src = [
      "// self.in(5, 'x') is not allowed",
      "self.setField('n', 'C', 'label', 'call self.at(1) later');",
      "/* self.now */",
    ].join('\n');
    expect(lintParamScript(src)).toEqual([]);
  });

  it('does not trip on similarly-named members (self.info, self.input)', () => {
    const src = "self.setField('n', 'C', 'input', self_info);";
    expect(lintParamScript(src)).toEqual([]);
  });
});
