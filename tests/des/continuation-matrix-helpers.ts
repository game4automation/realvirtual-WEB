// SPDX-License-Identifier: AGPL-3.0-only
import { clearProblemsOfCode, getProblems } from '../../src/core/hmi/problems-store';

import { describe, expect, it, type TestContext } from 'vitest';
import { assertContinuation } from '../helpers/des-continuation-harness';
import type { DESSnapshotV4 } from '../../src/plugins/des/rv-des-snapshot-v4';
import type { LiftState } from '../../src/plugins/des/fleet/des-lift';
import { sceneWorld, type Scene, type SceneOptions, type SceneWorld } from './continuation-scene-world';

const MODES = ['A', 'B', 'B-immediate'] as const;
type Cut = { T: number; TPrime: number; T2: number };
const DEFAULT_CUTS: readonly Cut[] = [
  { T: 3, TPrime: 6, T2: 30 }, { T: 60, TPrime: 70, T2: 120 }, { T: 200, TPrime: 210, T2: 260 },
];
// Explicit per-scene table for tuning without changing the driver.
const CUTS: Record<Scene, readonly Cut[]> = {
  PalletYard: [30, 150, 400].map(T => ({ T, TPrime: T + 10, T2: T + 60 })),
  DemoRealvirtualWeb: DEFAULT_CUTS,
  LaserWeldingAssemblyStation: DEFAULT_CUTS,
  AGVDemo: DEFAULT_CUTS,
  AGVFactory: DEFAULT_CUTS,
  Course: DEFAULT_CUTS,
  'Test-DES-Turntable-Loop': DEFAULT_CUTS,
  DemoPlanner: DEFAULT_CUTS,
};
const counts = (s: DESSnapshotV4) => ({ parts: s.parts.length, queue: s.eventQueue.length, mus: s.muIds.length });

async function requireScene(scene: Scene, ctx: TestContext): Promise<void> {
  const w = await sceneWorld(scene);
  try {
    if (!w.runner.liveInstances.length) {
      console.info(`MATRIX_SCENE ${JSON.stringify({ scene, skipped: 'No DES components in the loaded scene' })}`);
      ctx.skip();
    }
  } finally { w.dispose(); }
}

export async function runCase(scene: Scene, mode: typeof MODES[number], cut: Cut, opts: SceneOptions = {}) {
  let last: DESSnapshotV4 | undefined;
  try {
    await assertContinuation({ ...cut, mode, buildWorld: async () => {
      const w = await sceneWorld(scene, opts);
      return { ...w, runner: {
        fullSnapshot() { last = w.runner.fullSnapshot(); return last; },
        restoreFull: (raw: unknown) => w.runner.restoreFull(raw),
      } };
    } });
  } catch (error) {
    const m = error as { expected?: unknown; actual?: unknown };
    const detail = 'expected' in (m ?? {}) ? ` expected=${JSON.stringify(m.expected)?.slice(0, 600)} actual=${JSON.stringify(m.actual)?.slice(0, 600)}` : '';
    throw new Error(`${scene}, ${mode}, T=${cut.T}: ${error instanceof Error ? error.message : String(error)}${detail}`, { cause: error });
  }
  expect(last).toBeDefined();
  console.info(`MATRIX_CASE ${JSON.stringify({ scene, mode, T: cut.T, T2: cut.T2, ...counts(last!) })}`);
}

function ownerIds(w: SceneWorld, s: DESSnapshotV4): string[] {
  const addresses = new Set<string>();
  w.v.registry!.forEachNode((_path, node) => {
    const address = w.v.registry!.getAddressForNode(node);
    if (address) addresses.add(address);
  });
  const ids = s.parts.map(p => p.key).filter(id => /@(CarrierOwner|FloorSlot|EndProbe)$/.test(id)).sort();
  for (const id of ids) {
    const address = id.slice(0, id.lastIndexOf('@'));
    expect(addresses.has(address), `${id}: existing plan-769 node address`).toBe(true);
    expect(address).not.toMatch(/:\d+(?=\/|$)/);
  }
  if (w.yard) {
    for (const role of ['CarrierOwner', 'FloorSlot', 'EndProbe']) {
      expect(ids.some(id => id.endsWith(`@${role}`)), role).toBe(true);
    }
  }
  return ids;
}

/**
 * Cases that are known red and parked as `it.todo` instead of failing the suite (plan-2059 Phase 8,
 * round 16, nightmode). The key is the full test title; the value is the open point of the plan log.
 * Empty since round 17: O2/O3/O4/O5 are fixed and their cases run again.
 * Remove an entry when its open point is fixed.
 */
const PARKED: Readonly<Record<string, string>> = {
};
function matrixIt(title: string, fn: (ctx: TestContext) => Promise<void>, timeout: number): void {
  const open = PARKED[title];
  if (open) it.todo(`plan-2059 P8 ${open}: ${title}`);
  else it(title, fn, timeout);
}

export function registerMatrix(scenes: readonly Scene[]) {
 describe('P8-8: real GLB continuation matrix', () => {
  for (const scene of scenes) {
    for (const mode of MODES) {
      matrixIt(`${scene}: ${mode}, early / mid / after warm-up`, async ctx => {
        await requireScene(scene, ctx);
        for (const cut of CUTS[scene]) await runCase(scene, mode, cut);
      }, 300_000);
    }
  }

  const FREEZES = [
    { scene: 'Test-DES-Turntable-Loop', type: 'Turntable', at: 10, until: 18, cuts: [12, 18.25] },
    { scene: 'AGVDemo', type: 'Agv', at: 20, until: 26, cuts: [22, 26.25] },
    { scene: 'PalletYard', type: 'Agv', at: 140, until: 150, cuts: [145, 150.25] },
  ] as const;
  for (const f of FREEZES.filter(f => scenes.includes(f.scene))) for (const mode of MODES) {
    matrixIt(`${f.scene}: ${mode}, during failure and after repair`, async ctx => {
      await requireScene(f.scene, ctx);
      const probe = await sceneWorld(f.scene);
      let at: number | undefined;
      let desId: string | undefined;
      try {
        for (let t = f.scene === 'PalletYard' ? 100 : 8; t <= 600; t += 0.25) {
          probe.step(t);
          const queue = probe.runner.getManager().queuedEventsWithData();
          const instance = probe.runner.liveInstances.find(i => i.def.type === f.type && queue.some(e => e.entityId === i.adapter.entityId));
          if (instance) { at = t; desId = instance.desId!; break; }
        }
      } finally { probe.dispose(); }
      expect(at, `${f.scene}: moving ${f.type}`).toBeDefined();
      console.info(`MATRIX_FAILURE_PROBE ${JSON.stringify({ scene: f.scene, at, desId })}`);
      const until = at! + (f.until - f.at);
      for (const T of [at! + 2, until + 0.25]) {
        await runCase(f.scene, mode, { T, TPrime: T + 10, T2: T + 60 }, {
          failures: [{ desIdMatch: desId!, at: at!, until }],
        });
      }
    }, 300_000);
  }

  for (const scene of (['AGVDemo', 'PalletYard'] as const).filter(scene => scenes.includes(scene))) {
    matrixIt(`${scene}: fleet registration and stable owner addresses across loads`, async ctx => {
      await requireScene(scene, ctx);
      let first: string[] | undefined;
      for (let load = 0; load < 2; load++) {
        const w = await sceneWorld(scene);
        try {
          w.step(60);
          if (w.yard) {
            for (let t = 60.25; !w.yard.runtime && t <= 120; t += 0.25) w.step(t);
            expect(w.yard.runtime, 'FleetPlugin bound by 120 s').toBeTruthy();
            console.info(`MATRIX_BOUND ${JSON.stringify({ scene, at: w.runner.renderClock })}`);
          }
          const s = w.runner.fullSnapshot();
          const keys = s.parts.map(p => p.key).sort();
          console.info(`MATRIX_PARTS ${JSON.stringify({ scene, keys })}`);
          expect(keys).toContain('fleet.authority');
          const agvs = w.runner.liveInstances.filter(i => i.def.type === 'Agv');
          expect(agvs.length).toBeGreaterThan(0);
          for (const i of agvs) expect(keys).toContain(`fleet.agv:${i.desId}`);
          if (scene === 'PalletYard') for (const key of ['orders', 'zones', 'clock', 'runner', 'dispatcher',
            'takt', 'pause', 'wait', 'lift', 'handover', 'kpis']) expect(keys).toContain(`fleet.${key}`);
          const ids = ownerIds(w, s);
          if (first) expect(ids).toEqual(first); else first = ids;
        } finally { w.dispose(); }
      }
    }, 300_000);
  }

  for (const scene of scenes) {
    const times = scene === 'PalletYard' ? [CUTS[scene][1].T, 1800] : [CUTS[scene][1].T];
    for (const T of times) matrixIt(`${scene}: capture / fingerprint / restore measurements at ${T}`, async ctx => {
      await requireScene(scene, ctx);
      let w: SceneWorld | undefined = await sceneWorld(scene);
      try {
        w.step(T);
        let start = performance.now();
        const s = w.runner.fullSnapshot();
        const captureMs = performance.now() - start;
        start = performance.now();
        const fingerprint = w.runner.fingerprintNow();
        const fingerprintMs = performance.now() - start;
        expect(fingerprint.ok).toBe(true);
        const text = JSON.stringify(s);
        w.dispose();
        w = undefined;
        w = await sceneWorld(scene);
        start = performance.now();
        w.runner.restoreFull(JSON.parse(text));
        const restoreMs = performance.now() - start;
        for (const value of [captureMs, fingerprintMs, restoreMs, text.length]) expect(Number.isFinite(value)).toBe(true);
        console.info(`MATRIX_TIMING ${JSON.stringify({ scene, T, captureMs, fingerprintMs, restoreMs,
          bytes: text.length, ...counts(s) })}`);
      } finally { w?.dispose(); }
    }, 300_000);
  }

  if (scenes.includes('PalletYard')) it('PalletYard: lift drive continuation from a real mid-stroke cut in all modes', async ctx => {
    await requireScene('PalletYard', ctx);
    const probe = await sceneWorld('PalletYard');
    let T: number | undefined;
    try {
      for (let t = 30; t <= 600; t += 0.25) {
        probe.step(t);
        const s = probe.runner.fullSnapshot();
        const lift = s.parts.find(p => p.key === 'fleet.lift')?.state as unknown as LiftState | undefined;
        if (lift?.strokes.some(([, stroke]) => stroke.startAt < t && t < stroke.startAt + stroke.dt && stroke.from !== stroke.toMm)) {
          T = t;
          const positions = probe.kpis()['lift.drives'];
          expect(positions).toBeDefined();
          expect(Object.keys(positions as Record<string, number>).length).toBeGreaterThan(0);
          break;
        }
      }
    } finally { probe.dispose(); }
    if (T === undefined) throw new Error('No PalletYard lift stroke on the quarter-second grid by 600 s');
    console.info(`MATRIX_LIFT_CUT ${JSON.stringify({ T })}`);
    for (const mode of MODES) await runCase('PalletYard', mode, { T, TPrime: T + 0.5, T2: T + 30 });
    // Also observe the next frame: a final snap at stroke end must not hide a broken tween rebuild.
    for (const mode of ['A', 'B'] as const) {
      await runCase('PalletYard', mode, { T, TPrime: T + 0.5, T2: T + 0.25 });
    }
  }, 300_000);
});

}

export async function assertLogicRefusal(scene: Scene) {
  const w = await sceneWorld(scene);
  try {
    w.step(60);
    const code = 'des-snapshot-unsupported-component';
    clearProblemsOfCode(code);
    expect(() => w.runner.fullSnapshot()).toThrow(new RegExp(`${code}.*(LogicStep|PLC)`));
    expect(getProblems().some(p => p.code === code)).toBe(true);
    // The unsupported-component guard runs before envelope decoding on restore.
    clearProblemsOfCode(code);
    expect(() => w.runner.restoreFull({})).toThrow(code);
    expect(getProblems().some(p => p.code === code)).toBe(true);
    console.info(`MATRIX_REFUSED ${JSON.stringify({ scene, reason: 'active LogicStep/PLC' })}`);
  } finally { w.dispose(); }
}

/** plan-2207 Phase 3: LogicStep scenes without DES components continue bit-exactly (no requireScene skip). */
export function registerLogicMatrix(scenes: readonly Scene[], batchReady: readonly Scene[]) {
  describe('plan-2207 P3: event-driven LogicStep continuation', () => {
    for (const scene of scenes) for (const mode of MODES) {
      it(`${scene}: ${mode}, early / mid / after warm-up`, async () => {
        for (const cut of CUTS[scene]) await runCase(scene, mode, cut);
      }, 300_000);
    }
    for (const scene of scenes) it(`${scene}: LogicStep batch guard follows the DES check`, async () => {
      const w = await sceneWorld(scene);
      try {
        w.step(3);
        const hazards = (w.runner as unknown as { _logicHazards(): readonly { system: string; nodes: readonly string[] }[] })._logicHazards();
        console.info(`MATRIX_LOGIC_HAZARDS ${JSON.stringify({ scene, hazards })}`);
        if (batchReady.includes(scene)) expect(hazards.filter(h => h.system === 'LogicStep')).toEqual([]);
        const s = w.runner.fullSnapshot();
        expect(s.parts.map(p => p.key)).toContain('core.logic');
      } finally { w.dispose(); }
    }, 300_000);
  });
}
