// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// Criterion: >=1 outfeed MU; sink events over 120 s allow startup and a complete transfer.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createAcceptanceViewer, loadAcceptanceModel, stepModel, nodePath } from './_model-acceptance';
const URL = '/demo-realvirtual/DemoRealvirtualWeb.glb';
let h: Awaited<ReturnType<typeof createAcceptanceViewer>>;
afterAll(() => h?.dispose());
describe('Demo model acceptance', () => {
  beforeAll(async () => { h = await createAcceptanceViewer(); await loadAcceptanceModel(h.viewer, URL); }, 240_000);
  it('delivers MUs to outfeed', async () => {
    const tm = h.viewer.transportManager!;
    const sinks = tm.sinks.filter(s => nodePath(s.node).endsWith('Sink'));
    expect(sinks.length, 'Demo: outfeed sinks found (expected exactly 1)').toBe(1);
    let consumed = 0, exits = 0;
    const unsub = sinks[0].subscribeConsumed(() => consumed++);
    const exit = tm.sensors.find(s => s.node.name === 'ExitSensor');
    exit?.addMuEnterListener(() => exits++);
    try { await stepModel(h.viewer, 'Demo', 120); } finally { unsub(); }
    const message = `Demo: ${consumed} MUs at outfeed, ${exits} ExitSensor entries after 120 s sim (expected >= 1 outfeed MU)`;
    console.log(message);
    expect(consumed, message).toBeGreaterThanOrEqual(1);
  }, 240_000);
});
