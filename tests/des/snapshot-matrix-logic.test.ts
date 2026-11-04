// SPDX-License-Identifier: AGPL-3.0-only
import { it } from 'vitest';
import { assertLogicRefusal } from './continuation-matrix-helpers';

for (const scene of ['DemoRealvirtualWeb', 'LaserWeldingAssemblyStation'] as const) {
  it(`${scene}: LogicStep refuses capture and restore visibly`, () => assertLogicRefusal(scene), 300_000);
}
