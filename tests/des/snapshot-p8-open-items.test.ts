// SPDX-License-Identifier: AGPL-3.0-only
// plan-2059 phase 8 open items in real GLB scenes (Chromium).
import { expect, it } from 'vitest';
import { sceneWorld } from './continuation-scene-world';

// O3: Object3D.uuid is random per load; ties in the connection rules must not depend on it.
it('DemoPlanner wires the same topology in every load', async () => {
  const rows = new Set<string>();
  for (let i = 0; i < 6; i++) {
    const w = await sceneWorld('DemoPlanner');
    try {
      rows.add(w.runner.liveInstances.map(x => `${x.adapter.node.name}->${x.adapter.nextComponents.map(c => c.node.name).join(',')}`).sort().join('|'));
    } finally { w.dispose(); }
  }
  expect(rows.size).toBe(1);
}, 300_000);

// O2: an MU riding the turntable disc is parented under the rotary; the MU snapshot holds only its LOCAL pose.
const FREEZE = { failures: [{ desIdMatch: '#84929d61-70d6-42ad-997a-95c3244a8f40@Turntable', at: 11, until: 19 }] };
function riders(w: Awaited<ReturnType<typeof sceneWorld>>): string[] {
  const mgr = w.runner.getManager();
  const out: string[] = [];
  for (let id = 0; id < mgr.muCount; id++) {
    const mu = mgr.getMU(id) as unknown as { retired?: boolean; visual?: { node: { parent: { name: string } | null; position: { x: number; y: number; z: number } } } } | null;
    const node = mu && !mu.retired ? mu.visual?.node : undefined;
    if (node) out.push(`${id}:${node.parent?.name}:${node.position.x.toFixed(3)},${node.position.z.toFixed(3)}`);
  }
  return out;
}
for (const mode of ['A', 'B'] as const) {
  it(`Turntable frozen mid-rotation: ${mode} keeps the riding MU on the disc`, async () => {
    const ref = await sceneWorld('Test-DES-Turntable-Loop', FREEZE);
    let expected: string[];
    try { ref.step(13); expected = riders(ref); } finally { ref.dispose(); }
    expect(expected.some(r => r.includes(':Drive-Rot-Y:')), 'a MU rides the disc at T=13').toBe(true);
    let w = await sceneWorld('Test-DES-Turntable-Loop', FREEZE);
    try {
      w.step(13);
      const saved = w.runner.fullSnapshot();
      if (mode === 'A') { w.step(23); w.runner.restoreFull(saved); }
      else { const text = JSON.stringify(saved); w.dispose(); w = await sceneWorld('Test-DES-Turntable-Loop', FREEZE); w.runner.restoreFull(JSON.parse(text)); }
      // Headless MU visuals are materialized on the next frame.
      w.step(w.runner.renderClock + 0.25);
      const afterRestore = riders(w);
      expect(afterRestore.filter(r => r.includes(':Drive-Rot-Y:')).map(r => r.split(':')[0]))
        .toEqual(expected.filter(r => r.includes(':Drive-Rot-Y:')).map(r => r.split(':')[0]));
    } finally { w.dispose(); }
  }, 300_000);
}
