// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-502 §9.8 — LIVE acceptance of FMU parameters, start-value overrides and
 * restarts against a real realvirtual CONNECT (ABI v2, Phase-2 endpoints).
 *
 * Runs only when `RV_CONNECT_URL` names a running gateway (vite command
 * `connectSmokeUrl`); otherwise skipped. The document is the shipped demo
 * (`public/demo-realvirtual/fmu-demo.glb`, row `doc_fmu-demo_154b2h4`): the
 * BouncingBall on `Ball` (stored start value e = 0.95) plus the `Sequence`
 * (SetSignalBool Ball.Restart → Delay, looping; the base period is READ from the
 * model's `Wait.Duration` — 12 s since 2026-09-26). Checked, with numbers in the
 * log line `[fmu-params-live]`:
 *
 *   A. Sequence: after load + trust the instance runs; the Sequence restarts it
 *      twice more within 2 × base + 2 s, base ± 0.5 s apart (`startGeneration` + 1 each).
 *   B. `Wait.Duration` → 2 s through a setField op (scene executor) → the period follows.
 *   C. Reset (`viewer.resetSimulation()`, RestartOnReset) → `startGeneration` + 1,
 *      `simTime` back to ~0, `h` = 1, the Sequence runs again (then taken out for D–F).
 *   D. From the same initial state (restart, simTime 0, h = 1): the first rebound
 *      maximum after the first ground contact is higher with `e = 0.95` than with
 *      `e = 0.7` — both set EXPLICITLY by a live write (the demo's stored 0.95 is
 *      not relied upon).
 *   E. `g = -3` stored as a start value (op via `setFmuStartOverride`) →
 *      `startGeneration` + 1, `simTime` reset, first contact later than with -9.81.
 *   F. Write rate: a 3-s drag at `e` in the Inspector row → viewer → gateway
 *      writes stay under 60/s.
 *   G. Cold start of a document with a stored `e` override and
 *      `AllowViewerToFmu=false` → the first `Ball.e` CONNECT reports is the override.
 *
 * Screenshots (Inspector FMU parameters, status block, hierarchy with the
 * `Restart` child and the Sequence) go to the plan's asset folder.
 */

import { describe, it, expect } from 'vitest';
import { commands, page } from '@vitest/browser/context';
import { render, cleanup, act } from '@testing-library/react';
import { Box, Typography } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import type { Object3D } from 'three';
import demoManifest from '../public/demo-realvirtual/project.json';
import bouncingBallUrl from './fixtures/BouncingBall.fmu?url';
import { bootRealLoaderViewer } from './helpers/nested-placement-fixture';
import { buildFmuDemoScene } from './helpers/fmu-demo-scene';
import { getFmuInstances, type RVFmu } from '../src/core/engine/rv-fmu';
import { InterfaceManager } from '../src/interfaces/interface-manager';
import { WebSocketRealtimeInterface } from '../src/interfaces/websocket-realtime-interface';
import { INTERFACE_DEFAULTS } from '../src/interfaces/interface-settings-store';
import { FmuProvisioningPlugin } from '../src/plugins/fmu-provisioning-plugin';
import { fetchWorkerStatuses, getPackage, releaseLease, revokeTrust } from '../src/core/hmi/connect-fmu';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { applyForward } from '../src/core/hmi/scene/rv-scene-executors';
import { freshOpId } from '../src/core/ops/rv-op-utils';
import { setFmuStartOverride } from '../src/core/ops/rv-fmu-ops';
import { exportAssetGlb } from '../src/core/editor/rv-asset-glb-export';
import { binaryResources } from '../src/core/engine/rv-binary-resources';
import '../src/core/hmi/FmuAttachAction';
import { FmuInspectorRenderer } from '../src/core/hmi/FmuAttachAction';
import { FmuParametersRenderer } from '../src/core/hmi/rv-fmu-parameters-field-renderer';
import { NodeBadges } from '../src/core/hmi/hierarchy-badge-components';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';
import type { RVDelay } from '../src/core/engine/rv-logic-step';

const SHOT_DIR = 'E:/realvirtual6/game4automation/realvirtual/.docs/planfeature/assets/plan-502';

const smokeUrl = await (commands as unknown as { connectSmokeUrl(): Promise<string | null> }).connectSmokeUrl();

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitFor<T>(what: string, probe: () => T | null | undefined | false, timeoutMs: number): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = probe();
    if (v) return v as T;
    if (performance.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`);
    await sleep(10);
  }
}

function demoUrl(): string {
  const row = (demoManifest.documents as Array<{ id: string; path: string }>).find((d) => d.id === 'doc_fmu-demo_154b2h4');
  if (!row) throw new Error('demo manifest has no doc_fmu-demo_154b2h4');
  return `/demo-realvirtual/${row.path}`;
}

/** One CONNECT-side sample: status of the interface + its `h` / `e` values. */
interface Sample { t: number; gen: number | undefined; sim: number | undefined; h: number | undefined; v: number | undefined; e: number | undefined }

/**
 * Polls `GET /status` + `GET /signals` of the gateway as fast as they answer
 * (~20–40 ms on loopback) — sim-time-exact pairs (simTime, h) from CONNECT itself.
 */
class GatewayPoller {
  samples: Sample[] = [];
  private running = false;
  private loop: Promise<void> | null = null;
  constructor(private readonly base: string, private readonly iface: () => string | undefined) {}
  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = (async () => {
      while (this.running) {
        const id = this.iface();
        try {
          const [st, sig] = await Promise.all([
            fetchWorkerStatuses({ baseUrl: this.base }),
            fetch(`${this.base}/signals`).then((r) => r.json() as Promise<{ signals: Record<string, unknown> }>),
          ]);
          const s = id ? st[id] : undefined;
          const num = (v: unknown): number | undefined => (typeof v === 'number' ? v : undefined);
          this.samples.push({
            t: performance.now(), gen: s?.startGeneration, sim: s?.simTime,
            h: num(sig.signals['Ball.h']), v: num(sig.signals['Ball.v']), e: num(sig.signals['Ball.e']),
          });
        } catch { /* gateway busy — next round */ }
        await sleep(5);
      }
    })();
  }
  async stop(): Promise<void> { this.running = false; await this.loop; }
  latest(): Sample | undefined { return this.samples[this.samples.length - 1]; }
  /** Wall time at which generation `gen` was first seen (undefined = not yet). */
  firstSeen(gen: number, from = 0): Sample | undefined {
    return this.samples.find((s) => s.t >= from && s.gen !== undefined && s.gen >= gen);
  }
  since(t: number): Sample[] { return this.samples.filter((s) => s.t >= t); }
}

/**
 * First ground contact and the rebound maximum after it, for one generation.
 * The contact lies between the last sample falling (v < 0) and the first one
 * rising (v > 0) — the ~5 ms of h ≈ 0 are usually between two polls — so its
 * sim time is the midpoint of that bracket (resolution = one poll, ~20–40 ms).
 */
function bounceOf(samples: Sample[], gen: number): { firstSampleSim: number; firstSampleH: number; contactSim: number; contactBracketS: number; reboundMax: number; eAtContact?: number } {
  const run = samples.filter((s) => s.gen === gen && s.sim !== undefined && s.h !== undefined && s.v !== undefined)
    .sort((a, b) => a.sim! - b.sim!);
  if (run.length < 5) throw new Error(`generation ${gen}: only ${run.length} samples`);
  const iUp = run.findIndex((s, i) => i > 0 && run[i - 1].v! < 0 && s.v! > 0);
  if (iUp < 0) throw new Error(`generation ${gen}: no ground contact in ${run.length} samples`);
  let max = 0;
  for (let i = iUp; i < run.length; i++) {
    if (i > iUp && run[i - 1].v! < 0 && run[i].v! > 0) break; // the next contact
    max = Math.max(max, run[i].h!);
  }
  return {
    firstSampleSim: run[0].sim!, firstSampleH: run[0].h!,
    contactSim: (run[iUp - 1].sim! + run[iUp].sim!) / 2,
    contactBracketS: +(run[iUp].sim! - run[iUp - 1].sim!).toFixed(3),
    reboundMax: max, eAtContact: run[iUp].e,
  };
}

/** An EditTarget that runs ops through THE scene executor (what SceneStore.applyOp does). */
function executorTarget(viewer: RVViewer, log: string[]): EditTarget {
  return {
    available: true,
    persistsTo: 'none',
    setField(nodePath, componentType, fieldName, value, prev): void {
      log.push(`setField ${nodePath} ${componentType}.${fieldName}=${JSON.stringify(value)}`);
      void applyForward({ id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'setField', nodePath, componentType, fieldName, value, prev } as never, { viewer });
    },
    unsetField(nodePath, componentType, fieldName, prev): void {
      log.push(`unsetField ${nodePath} ${componentType}.${fieldName}`);
      void applyForward({ id: freshOpId(), ts: Date.now(), schemaV: 1, kind: 'unsetField', nodePath, componentType, fieldName, prev } as never, { viewer });
    },
    async withTransaction(_label, fn): Promise<void> { await fn(); },
  };
}

async function activateWs(manager: InterfaceManager, base: string): Promise<void> {
  const gw = new URL(base);
  await manager.activate('websocket-realtime', {
    ...INTERFACE_DEFAULTS,
    activeType: 'websocket-realtime',
    wsAddress: gw.hostname,
    wsPort: Number(gw.port || (gw.protocol === 'https:' ? 443 : 80)),
    wsUseSSL: gw.protocol === 'https:',
    wsPath: '/ws',
  });
}

function newPlugin(base: string, asked: string[]): FmuProvisioningPlugin {
  return new FmuProvisioningPlugin({
    gatewayUrl: () => base,
    subscribeGateway: () => () => {},
    confirmTrust: async (req) => { asked.push(req.sha256); return true; },
    statusIntervalMs: 100,
  });
}

function ballOf(viewer: RVViewer): RVFmu {
  const inScene = new Set<Object3D>();
  viewer.scene.traverse((n) => inScene.add(n));
  const ball = getFmuInstances().find((i) => inScene.has(i.node) && i.node.name === 'Ball');
  if (!ball) throw new Error('no Ball FMU in the scene');
  return ball;
}

function failOnError(f: RVFmu): void {
  if (f.state === 'error') throw new Error(`${f.node.name}: ${f.lastError}`);
}

const round = (n: number | undefined, d = 3): number | undefined => (n === undefined ? undefined : +n.toFixed(d));

describe.skipIf(!smokeUrl)('FMU parameters live (real CONNECT, RV_CONNECT_URL) — plan-502 §9.8', () => {
  it('sequence restarts, reset, e live, g start value, write rate, cold start with override', async () => {
    const base = smokeUrl!.replace(/\/+$/, '');
    const report: Record<string, unknown> = { gateway: base };
    const opLog: string[] = [];
    const asked: string[] = [];
    const plugin = newPlugin(base, asked);
    const manager = new InterfaceManager();
    const wsIface = new WebSocketRealtimeInterface();
    manager.register(wsIface);
    await page.viewport(1000, 900);

    const booted = await bootRealLoaderViewer();
    const viewer = booted.h.viewer;
    viewer.use(plugin, 'core');
    await viewer.loadModel('fmu-demo.glb', { data: await (await fetch(demoUrl())).arrayBuffer() });
    await viewer.whenSceneReady();
    const ball = ballOf(viewer);
    const store = viewer.signalStore!;
    const poller = new GatewayPoller(base, () => ball.interfaceId);
    // Consent on every run: a gateway that already holds the package loses its trust first.
    const sha = ball.embed!.sha256;
    if (await getPackage(sha, { baseUrl: base })) await revokeTrust(sha, { baseUrl: base });
    setActiveEditTarget(executorTarget(viewer, opLog));

    // Restart edges of the Sequence (viewer side: the LogicStep writes Ball.Restart = true).
    const edges: number[] = [];
    const offEdges = store.subscribe(ball.restartSignalName, (v) => { if (v === true) edges.push(performance.now()); });

    try {
      expect(ball.restartSignalName).toBe('Ball.Restart');
      const waitNode = viewer.registry!.getNode('FmuDemo/Sequence/Wait') ?? null;
      const waitPath = waitNode ? viewer.registry!.getPathForNode(waitNode)! : '';
      expect(waitPath).toBeTruthy();
      const delay = viewer.logicEngine!.stepByPath.get(waitPath) as RVDelay;
      // The base period comes from the model (Wait.Duration), not from a constant.
      const baseS = Number((waitNode!.userData.realvirtual as Record<string, Record<string, unknown>>).LogicStep_Delay.Duration);
      expect(baseS).toBeGreaterThan(2);
      expect(delay.duration).toBe(baseS);
      report.baseS = baseS;

      viewer.setSimulationPaused('nested-fixture', false);
      viewer.use(manager, 'core');
      await activateWs(manager, base);
      await waitFor(`Ball running (state=${ball.state})`, () => { failOnError(ball); return ball.state === 'running'; }, 20_000);
      expect(asked).toEqual([sha]);
      poller.start();
      await waitFor('first gateway sample with a generation', () => poller.latest()?.gen !== undefined, 5_000);

      // ── A. Sequence: two more restarts within 2 × base + 2 s, base ± 0.5 s apart ──
      const tA = performance.now();
      const genA = poller.latest()!.gen!;
      const aLimitS = 2 * baseS + 2;
      await waitFor('two sequence restarts', () => (poller.latest()?.gen ?? 0) >= genA + 2, aLimitS * 1000);
      const aAt1 = poller.firstSeen(genA + 1, tA)!;
      const aAt2 = poller.firstSeen(genA + 2, tA)!;
      const seqInterval = (aAt2.t - aAt1.t) / 1000;
      const aWithin = (aAt2.t - tA) / 1000;
      const edgeIntervalsA = edges.filter((t) => t >= tA - (baseS * 1000 + 500)).map((t, i, a) => (i ? (t - a[i - 1]) / 1000 : NaN)).filter(Number.isFinite);
      report.A = {
        genBefore: genA, restartsWithinS: +aWithin.toFixed(2),
        restartIntervalS: +seqInterval.toFixed(3),
        edgeIntervalsS: edgeIntervalsA.map((x) => +x.toFixed(3)),
        firstSampleAfterRestart: { sim: round(aAt1.sim), h: round(aAt1.h) },
      };
      expect(aWithin).toBeLessThanOrEqual(aLimitS);
      expect(Math.abs(seqInterval - baseS)).toBeLessThanOrEqual(0.5);

      // ── B. Duration → 2 s through a setField op → the period follows ──
      const tB = performance.now();
      const prevDuration = (waitNode!.userData.realvirtual as Record<string, Record<string, unknown>>).LogicStep_Delay.Duration;
      await act(async () => {
        const t = executorTarget(viewer, opLog);
        t.setField(waitPath, 'LogicStep_Delay', 'Duration', 2, prevDuration);
        await sleep(0);
      });
      expect(delay.duration).toBe(2);
      const genB = poller.latest()!.gen!;
      await waitFor('three restarts after the Duration change', () => (poller.latest()?.gen ?? 0) >= genB + 3, 12_000);
      const b1 = poller.firstSeen(genB + 2, tB)!;
      const b2 = poller.firstSeen(genB + 3, tB)!;
      const bInterval = (b2.t - b1.t) / 1000;
      const edgeIntervalsB = edges.filter((t) => t >= tB).map((t, i, a) => (i ? (t - a[i - 1]) / 1000 : NaN)).filter(Number.isFinite);
      report.B = { restartIntervalS: +bInterval.toFixed(3), edgeIntervalsS: edgeIntervalsB.map((x) => +x.toFixed(3)) };
      expect(Math.abs(bInterval - 2)).toBeLessThanOrEqual(0.5);

      // ── C. Reset → immediate restart from h = 1 (RestartOnReset); the sequence restarts too ──
      await waitFor('storm guard passed', () => ball.state === 'running' && ball.runningSince !== undefined && Date.now() - ball.runningSince > 1_200, 5_000);
      const genC = poller.latest()!.gen!;
      const simBefore = poller.latest()!.sim;
      const tC = performance.now();
      viewer.resetSimulation();
      const cAt = await waitFor('restart after Reset', () => poller.firstSeen(genC + 1, tC), 5_000);
      await waitFor('Ball running after Reset', () => ball.state === 'running', 5_000);
      await waitFor('Reset run: 0.6 s simulated', () => poller.latest()?.gen === genC + 1 && (poller.latest()?.sim ?? 0) > 0.6, 5_000);
      const cRun = bounceOf(poller.samples, genC + 1);
      const rootState = viewer.logicEngine!.roots[0]?.state;
      await sleep(baseS * 1000 * 0.6);
      report.C = {
        genBefore: genC, genAfter: cAt.gen, simBefore: round(simBefore), latencyMs: Math.round(cAt.t - tC),
        firstSample: { sim: round(cRun.firstSampleSim), h: round(cRun.firstSampleH) },
        sequenceStateAfterReset: rootState, genAfterWait: poller.latest()?.gen,
      };
      expect(cAt.gen).toBe(genC + 1);
      expect(cRun.firstSampleSim).toBeLessThan(0.3);
      expect(cRun.firstSampleH).toBeGreaterThan(0.9);
      expect(rootState).toBe('Active');
      // Since the Reset follow-up (2026-09-26) Reset restarts the LogicSteps; with B's 2 s period the
      // sequence would cut every single run of D–F short. Take it out, as the second viewer of G does.
      viewer.logicEngine!.reset();

      // ── D. e = 0.7 vs e = 0.95 (live write), each from a fresh restart ──
      const restartOnce = async (label: string): Promise<{ gen: number; t: number }> => {
        const g0 = poller.latest()!.gen!;
        await waitFor(`${label}: restart accepted`, () => plugin.requestRestart(ball), 8_000);
        const t = performance.now();
        const at = await waitFor(`${label}: generation ${g0 + 1}`, () => poller.firstSeen(g0 + 1, t - 50), 8_000);
        return { gen: at.gen!, t: at.t };
      };
      // The live write lands right after the restart, while CONNECT streams the fresh
      // start values back — the interface's echo guard may swallow a write made in
      // that instant (`pendingIncoming`). So: write, and re-write every 60 ms until
      // CONNECT shows the value; a run whose value arrives only after 0.35 s
      // simulated (the contact is at ~0.45 s) is discarded and restarted.
      const eRun = async (e: number): Promise<Record<string, unknown> & { reboundMax: number; contactSim: number }> => {
        for (let attempt = 1; attempt <= 4; attempt++) {
          const { gen } = await restartOnce(`e=${e}`);
          const tw = performance.now();
          let writes = 0;
          let seen: Sample | undefined;
          while (!seen && (poller.latest()?.sim ?? 0) < 0.35 && performance.now() - tw < 2_000) {
            // Alternate by 1e-12 so the store never suppresses the write as "unchanged".
            store.set('Ball.e', writes % 2 === 0 ? e : e + 1e-12);
            writes++;
            await sleep(60);
            seen = poller.since(tw).find((s) => s.gen === gen && s.e !== undefined && Math.abs(s.e - e) < 1e-6);
          }
          if (!seen || (seen.sim ?? 1) >= 0.35) continue;
          await waitFor(`e=${e}: rebound over`, () => (poller.latest()?.sim ?? 0) > 2.2 && poller.latest()?.gen === gen, 6_000);
          const b = bounceOf(poller.samples, gen);
          return { e, gen, attempt, writes, eAppliedAtSim: round(seen.sim), ...b, firstSampleSim: round(b.firstSampleSim)!, contactSim: +b.contactSim.toFixed(3), reboundMax: +b.reboundMax.toFixed(4) };
        }
        throw new Error(`e=${e}: the live write never reached CONNECT before the first contact (4 restarts)`);
      };
      const d07 = await eRun(0.7);
      const d095 = await eRun(0.95);
      report.D = { e07: d07, e095: d095 };
      expect(d07.eAppliedAtSim as number).toBeLessThan(d07.contactSim);
      expect(d095.eAppliedAtSim as number).toBeLessThan(d095.contactSim);
      expect(d095.reboundMax).toBeGreaterThan(d07.reboundMax);

      // ── F. Write rate: a 3-s drag at e in the Inspector row ──
      booted.h.container.style.display = 'none';
      const outgoing: Array<{ t: number; n: number }> = [];
      const port = (wsIface as unknown as { _port: { postMessage(m: unknown): void } | null })._port!;
      const origPost = port.postMessage.bind(port);
      port.postMessage = (m: unknown) => {
        const msg = m as { type?: string; signals?: Record<string, unknown> };
        if (msg?.type === 'outgoing' && msg.signals && 'Ball.e' in msg.signals) outgoing.push({ t: performance.now(), n: 1 });
        origPost(m);
      };
      const storeWrites: number[] = [];
      const offE = store.subscribe('Ball.e', () => storeWrites.push(performance.now()));
      const origCapture = Element.prototype.setPointerCapture;
      const origRelease = Element.prototype.releasePointerCapture;
      Element.prototype.setPointerCapture = function () { /* synthetic pointer — no capture */ };
      Element.prototype.releasePointerCapture = function () { /* see above */ };
      const shot = render(
        <ThemeProvider theme={rvDarkTheme}>
          <RVViewerProvider value={viewer}>
            <Box data-testid="params-shot" sx={{ width: 420, bgcolor: '#1d2126', p: 1, borderRadius: 1 }}>
              <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.9)', mb: 0.5 }}>Inspector · Ball · Fmu</Typography>
              <FmuParametersRenderer value={ball.FmuVariables} fieldName="FmuVariables" componentType="Fmu" nodePath={ball.nodePath} viewer={viewer} signalStore={store} />
            </Box>
          </RVViewerProvider>
        </ThemeProvider>,
      );
      let dragMoves = 0;
      let tDrag0 = 0;
      let tDrag1 = 0;
      try {
        const row = shot.container.querySelector('[data-testid="fmu-param-row-e"]') as HTMLElement;
        expect(row).toBeTruthy();
        const handle = row.querySelector('[aria-label$="drag handle"], [aria-label="drag to change value"]') as HTMLElement;
        expect(handle).toBeTruthy();
        const x0 = 200;
        const fire = (type: string, x: number): void => {
          handle.dispatchEvent(new PointerEvent(type, { bubbles: true, cancelable: true, pointerId: 1, pointerType: 'mouse', clientX: x, clientY: 10, buttons: type === 'pointerup' ? 0 : 1, shiftKey: true }));
        };
        outgoing.length = 0;
        storeWrites.length = 0;
        tDrag0 = performance.now();
        act(() => fire('pointerdown', x0));
        // Worst case: moves far faster than a mouse delivers them, and EVERY move changes
        // the value (Shift → 0.1 per px, jitter between two neighbouring pixels) —
        // no move is swallowed by the value-equality suppression of the store.
        while (performance.now() - tDrag0 < 3_000) {
          // Two value changes per ~4-ms turn: faster than any pointer stream.
          for (let k = 0; k < 2; k++) {
            const dx = dragMoves % 2 === 0 ? 1 : 0;
            act(() => fire('pointermove', x0 + dx));
            dragMoves++;
          }
          await sleep(4);
        }
        act(() => fire('pointerup', x0));
        tDrag1 = performance.now();
        await sleep(300);
      } finally {
        Element.prototype.setPointerCapture = origCapture;
        Element.prototype.releasePointerCapture = origRelease;
        offE();
        port.postMessage = origPost;
      }
      const dragS = (tDrag1 - tDrag0) / 1000;
      const inDrag = (a: number[]) => a.filter((t) => t >= tDrag0 && t <= tDrag1 + 300).length;
      const perSecond = (arr: number[]): number => {
        // Highest count in any 1-s window during the drag.
        let best = 0;
        for (const t0 of arr) best = Math.max(best, arr.filter((t) => t >= t0 && t < t0 + 1000).length);
        return best;
      };
      const outTimes = outgoing.map((o) => o.t);
      report.F = {
        dragS: +dragS.toFixed(2), pointerMoves: dragMoves,
        storeWrites: inDrag(storeWrites), gatewayWrites: inDrag(outTimes),
        gatewayWritesPerS: +(inDrag(outTimes) / dragS).toFixed(1), gatewayWritesPeak1s: perSecond(outTimes),
      };
      expect(inDrag(outTimes)).toBeGreaterThan(10);
      expect(inDrag(outTimes) / dragS).toBeLessThan(60);
      expect(perSecond(outTimes)).toBeLessThan(60);

      // ── E. g = -3 as a start value (op) → restart, simTime reset, later first contact ──
      await waitFor('storm guard passed (g)', () => ball.state === 'running' && ball.runningSince !== undefined && Date.now() - ball.runningSince > 1_200, 5_000);
      const genE = poller.latest()!.gen!;
      const tE = performance.now();
      await act(async () => {
        expect(setFmuStartOverride(executorTarget(viewer, opLog), ball.nodePath, 'g', -3, ball.FmuStartOverrides)).toBe(true);
        await sleep(0);
      });
      expect(ball.startOverrides).toEqual({ g: '-3' });
      const eAt = await waitFor('restart after the g override', () => poller.firstSeen(genE + 1, tE), 8_000);
      await waitFor('g run: rebound over', () => (poller.latest()?.sim ?? 0) > 3 && poller.latest()?.gen === genE + 1, 8_000);
      const gRun = bounceOf(poller.samples, genE + 1);
      report.E = {
        genBefore: genE, genAfter: eAt.gen, latencyMs: Math.round(eAt.t - tE),
        firstSample: { sim: round(gRun.firstSampleSim), h: round(gRun.firstSampleH) },
        contactSim: round(gRun.contactSim), contactSimG981: d07.contactSim,
        theory: { g981: +Math.sqrt(2 / 9.81).toFixed(3), g3: +Math.sqrt(2 / 3).toFixed(3) },
      };
      expect(eAt.gen).toBe(genE + 1);
      expect(gRun.firstSampleSim).toBeLessThan(0.3);
      expect(gRun.contactSim).toBeGreaterThan(d07.contactSim + 0.2);

      // ── Screenshots: Inspector params, status block, hierarchy with Restart + Sequence ──
      await sleep(300);
      await page.screenshot({ path: `${SHOT_DIR}/plan-502-inspector-parameters.png`, element: shot.container.querySelector('[data-testid="params-shot"]') as HTMLElement });
      cleanup();
      const reg = viewer.registry!;
      const pathOf = (n: Object3D): string => reg.getPathForNode(n) ?? n.name;
      const rows: Array<{ depth: number; name: string; path: string; types: string[] }> = [];
      const root = ball.node.parent!;
      rows.push({ depth: 0, name: root.name, path: pathOf(root), types: [] });
      for (const child of root.children) {
        const p = pathOf(child);
        rows.push({ depth: 1, name: child.name, path: p, types: reg.getComponentTypes(p).filter((t) => !t.startsWith('PLC')) });
        const walk = (n: Object3D, depth: number): void => {
          for (const c of n.children) {
            const cp = pathOf(c);
            const types = reg.getComponentTypes(cp);
            const rv = c.userData?.realvirtual as Record<string, unknown> | undefined;
            const stepTypes = rv ? Object.keys(rv).filter((k) => k.startsWith('LogicStep_')) : [];
            if (types.length === 0 && stepTypes.length === 0 && c.name !== 'Signals') continue;
            rows.push({ depth, name: c.name, path: cp, types: [...types, ...stepTypes] });
            walk(c, depth + 1);
          }
        };
        walk(child, 2);
      }
      const status = render(
        <ThemeProvider theme={rvDarkTheme}>
          <RVViewerProvider value={viewer}>
            <Box data-testid="status-shot" sx={{ display: 'flex', gap: 2, p: 2, bgcolor: '#15181c', width: 960, boxSizing: 'border-box', alignItems: 'flex-start' }}>
              <Box data-testid="hier-shot" sx={{ width: 520, flexShrink: 0, bgcolor: '#1d2126', borderRadius: 1, p: 1 }}>
                <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', mb: 0.5 }}>
                  Hierarchy · fmu-demo.glb · sim {viewer.simTime.toFixed(2)} s
                </Typography>
                {rows.map((r) => (
                  <Box key={`${r.path}#${r.depth}`} sx={{ display: 'flex', alignItems: 'center', pl: r.depth * 2, height: 22, gap: 1 }}>
                    <Typography noWrap sx={{ fontSize: 12, color: 'rgba(255,255,255,0.9)', flex: 1, minWidth: 0 }}>{r.name}</Typography>
                    <NodeBadges types={r.types} signalStore={store} path={r.path} stepInfo={viewer.logicEngine?.getStepInfo(r.path) ?? null} viewer={viewer} />
                  </Box>
                ))}
              </Box>
              <Box data-testid="inspector-status-shot" sx={{ width: 380, flexShrink: 0, bgcolor: '#1d2126', borderRadius: 1, p: 1 }}>
                <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.9)', mb: 0.5 }}>Inspector · Ball · Fmu</Typography>
                <FmuInspectorRenderer
                  value={(ball.node.userData.realvirtual as Record<string, Record<string, unknown>>).Fmu.FmuEmbed}
                  fieldName="FmuEmbed" componentType="Fmu" nodePath={ball.nodePath} viewer={viewer} signalStore={store}
                />
              </Box>
            </Box>
          </RVViewerProvider>
        </ThemeProvider>,
      );
      await sleep(500);
      const statusText = (status.container.querySelector('[data-testid="inspector-status-shot"]') as HTMLElement).textContent ?? '';
      expect(statusText).toMatch(/start #\d+ · t = /);
      await page.screenshot({ path: `${SHOT_DIR}/plan-502-status-block.png`, element: status.container.querySelector('[data-testid="inspector-status-shot"]') as HTMLElement });
      await page.screenshot({ path: `${SHOT_DIR}/plan-502-hierarchy-restart.png`, element: status.container.querySelector('[data-testid="hier-shot"]') as HTMLElement });
      report.hierarchy = rows.map((r) => `${'  '.repeat(r.depth)}${r.name}${r.types.length ? ` [${r.types.join(',')}]` : ''}`);
      cleanup();

      // ── Release the demo instance ──
      const iface = ball.interfaceId!;
      viewer.setSimulationPaused('nested-fixture', true);
      plugin.dispose();
      for (let i = 0; i < 50; i++) {
        const st = await fetchWorkerStatuses({ baseUrl: base });
        if (!(iface in st)) break;
        await sleep(100);
      }
    } catch (err) {
      console.log(`[fmu-params-live] PARTIAL ${JSON.stringify(report)}`);
      throw err;
    } finally {
      offEdges();
      await poller.stop();
      setActiveEditTarget(null);
      try { plugin.dispose(); } catch { /* already */ }
      for (const i of getFmuInstances()) if (i.leaseId) await releaseLease(i.leaseId, { baseUrl: base }).catch(() => undefined);
      manager.deactivate();
      booted.h.dispose();
    }

    // ── G. Cold start: stored e override + AllowViewerToFmu=false ──
    const E_OVERRIDE = 0.85;
    const bb = new Uint8Array(await (await fetch(bouncingBallUrl)).arrayBuffer());
    const { root } = await buildFmuDemoScene(bb);
    const ballNode = root.children.find((c) => c.name === 'Ball')!;
    const fmuExtras = (ballNode.userData.realvirtual as Record<string, Record<string, unknown>>).Fmu;
    fmuExtras.FmuStartOverrides = { e: String(E_OVERRIDE) };
    fmuExtras.AllowViewerToFmu = false;
    const glb = await exportAssetGlb(root, 'FmuDemo');
    expect(binaryResources.has((fmuExtras.FmuEmbed as { sha256: string }).sha256)).toBe(true);

    const asked2: string[] = [];
    const plugin2 = newPlugin(base, asked2);
    const manager2 = new InterfaceManager();
    manager2.register(new WebSocketRealtimeInterface());
    const booted2 = await bootRealLoaderViewer();
    const viewer2 = booted2.h.viewer;
    let ball2: RVFmu | null = null;
    const poller2 = new GatewayPoller(base, () => ball2?.interfaceId);
    try {
      viewer2.use(plugin2, 'core');
      await viewer2.loadModel('fmu-demo-e-override.glb', { data: glb.slice(0) });
      await viewer2.whenSceneReady();
      ball2 = ballOf(viewer2);
      expect(ball2.allowViewerToFmu).toBe(false);
      expect(ball2.startOverrides).toEqual({ e: String(E_OVERRIDE) });
      viewer2.logicEngine?.reset(); // the sequence stays out of this run
      viewer2.setSimulationPaused('nested-fixture', false);
      viewer2.use(manager2, 'core');
      poller2.start();
      await activateWs(manager2, base);
      await waitFor(`Ball (override doc) running (state=${ball2.state})`, () => { failOnError(ball2!); return ball2!.state === 'running'; }, 20_000);
      const firstE = await waitFor('first Ball.e from CONNECT', () => poller2.samples.find((s) => s.gen !== undefined && s.e !== undefined), 5_000);
      const gen2 = firstE.gen!;
      await waitFor('cold start: rebound over', () => (poller2.latest()?.sim ?? 0) > 2.2, 8_000);
      const coldRun = (() => { try { return bounceOf(poller2.samples, gen2); } catch (err) { return { error: String(err) }; } })();
      const viewerE = store2Value(viewer2);
      report.G = {
        override: E_OVERRIDE, firstConnectE: firstE.e, firstConnectSim: round(firstE.sim), viewerE,
        trustAskedAgain: asked2.length, coldRun,
        theoryReboundMax: +(E_OVERRIDE ** 2).toFixed(4),
      };
      expect(firstE.e).toBeCloseTo(E_OVERRIDE, 9);
    } finally {
      await poller2.stop();
      try { plugin2.dispose(); } catch { /* already */ }
      for (const i of getFmuInstances()) if (i.leaseId) await releaseLease(i.leaseId, { baseUrl: base }).catch(() => undefined);
      manager2.deactivate();
      booted2.h.dispose();
      report.ops = opLog;
      console.log(`[fmu-params-live] ${JSON.stringify(report)}`);
    }
  }, 300_000);
});

function store2Value(viewer: RVViewer): number | undefined {
  const v = viewer.signalStore?.get('Ball.e');
  return typeof v === 'number' ? v : undefined;
}
