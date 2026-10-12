// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 Phase 4 — acceptance of the shipped FMU demo model
 * `public/demo-realvirtual/fmu-demo.glb` (built by `tests/fmu-demo-model.build.test.ts`).
 *
 * 1. Standalone (always): the document is found through the demo project's
 *    manifest, loaded by the real viewer from its served URL, the one FMU
 *    (BouncingBall on `Ball`) comes up with its signal children, and `Ball/Signals/h` drives the Ball's `Drive`
 *    through `Drive_FollowPosition` (scale 1000: metres → millimetres).
 * 2. Live (only with `RV_CONNECT_URL`, see `connectSmokeUrl` in vite.config.ts):
 *    consent → BouncingBall runs in CONNECT, `h` changes, the Drive follows.
 *    Writes the two acceptance screenshots. The viewer → FMU input path is not
 *    part of the demo (the Feedthrough `Panel` left it, 2026-09-26); it is
 *    proven with the Feedthrough fixture in `fmu-live-smoke.e2e.test.tsx`.
 */

import { describe, it, expect } from 'vitest';
import { commands, page } from '@vitest/browser/context';
import { render, cleanup } from '@testing-library/react';
import { Box, Typography } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import type { Object3D } from 'three';
import demoManifest from '../public/demo-realvirtual/project.json';
import { bootRealLoaderViewer } from './helpers/nested-placement-fixture';
import { BALL_DRIVE_SCALE, DEMO_CAMERA } from './helpers/fmu-demo-scene';
import { getFmuInstances, type RVFmu } from '../src/core/engine/rv-fmu';
import type { RVDrive } from '../src/core/engine/rv-drive';
import { InterfaceManager } from '../src/interfaces/interface-manager';
import { WebSocketRealtimeInterface } from '../src/interfaces/websocket-realtime-interface';
import { INTERFACE_DEFAULTS } from '../src/interfaces/interface-settings-store';
import { FmuProvisioningPlugin } from '../src/plugins/fmu-provisioning-plugin';
import { fetchWorkerStatuses, getPackage, releaseLease, revokeTrust } from '../src/core/hmi/connect-fmu';
import type { FmuTrustRequest } from '../src/core/hmi/fmu-trust-store';
import '../src/core/hmi/FmuAttachAction';
import { FmuInspectorRenderer } from '../src/core/hmi/FmuAttachAction';
import { NodeBadges } from '../src/core/hmi/hierarchy-badge-components';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

const SHOT_DIR = 'E:/realvirtual6/game4automation/realvirtual/.docs/planfeature/assets/plan-498';

const smokeUrl = await (commands as unknown as { connectSmokeUrl(): Promise<string | null> }).connectSmokeUrl();

/** The demo project's row for the FMU demo — the "document selection" of the acceptance. */
function demoDocumentUrl(): { id: string; url: string } {
  const row = (demoManifest.documents as Array<{ id: string; path: string }>).find((d) => d.path === 'fmu-demo.glb');
  if (!row) throw new Error('public/demo-realvirtual/project.json has no fmu-demo.glb document');
  return { id: row.id, url: `/demo-realvirtual/${row.path}` };
}

async function waitFor<T>(what: string, probe: () => T | null | undefined | false, timeoutMs: number): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = probe();
    if (v) return v as T;
    if (performance.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

interface Loaded {
  booted: Awaited<ReturnType<typeof bootRealLoaderViewer>>;
  viewer: RVViewer;
  ball: RVFmu;
  fmus: RVFmu[];
  drive: RVDrive;
  hPath: string;
}

async function loadDemo(plugin?: FmuProvisioningPlugin): Promise<Loaded> {
  const { url } = demoDocumentUrl();
  const booted = await bootRealLoaderViewer();
  const viewer = booted.h.viewer;
  if (plugin) viewer.use(plugin, 'core');
  const bytes = await (await fetch(url)).arrayBuffer();
  await viewer.loadModel('fmu-demo.glb', { data: bytes });
  await viewer.whenSceneReady();
  const inScene = new Set<Object3D>();
  viewer.scene.traverse((n) => inScene.add(n));
  const mine = getFmuInstances().filter((i) => inScene.has(i.node));
  const ball = mine.find((i) => i.node.name === 'Ball')!;
  const drive = viewer.registry!.getAll<RVDrive>('Drive').find((d) => d.instance.node === ball?.node)?.instance as RVDrive;
  const hPath = ball?.signals.find((s) => s.variable === 'h')?.path ?? '';
  return { booted, viewer, ball, fmus: mine, drive, hPath };
}

describe('FMU demo model — standalone (shipped file, no CONNECT)', () => {
  it('loads from the demo project, only the BouncingBall FMU with children, h drives the Ball', async () => {
    const { id } = demoDocumentUrl();
    expect(id).toBe('doc_fmu-demo_154b2h4');
    const l = await loadDemo();
    try {
      expect(l.ball).toBeTruthy();
      expect(l.fmus.map((f) => f.node.name)).toEqual(['Ball']);
      expect(l.ball.modelName).toBe('BouncingBall');
      expect(l.ball.state).toBe('standalone');
      // User request 2026-09-26: the demo stores e = 0.95 so the ball really bounces.
      expect(l.ball.startOverrides).toEqual({ e: '0.95' });
      expect(l.ball.signalNames).toEqual(expect.arrayContaining(['Ball.h', 'Ball.v', 'Ball.e']));
      expect(l.hPath).toMatch(/Ball\/Signals\/h$/);
      expect(l.drive).toBeTruthy();

      const store = l.viewer.signalStore!;
      // Start value of h (1 m) → the Drive stands at 1000 mm once the sim ticks.
      l.viewer.setSimulationPaused('nested-fixture', false);
      await waitFor(`drive at start value (pos=${l.drive.currentPosition})`, () => Math.abs(l.drive.currentPosition - 1 * BALL_DRIVE_SCALE) < 1e-6, 3_000);
      const y0 = l.ball.node.position.y;
      store.set('Ball.h', 0.25);
      await waitFor(`drive follows h=0.25 (pos=${l.drive.currentPosition})`, () => Math.abs(l.drive.currentPosition - 250) < 1e-6, 3_000);
      expect(l.ball.node.position.y).toBeLessThan(y0);
      console.log(`[fmu-demo] standalone ${JSON.stringify({ hPath: l.hPath, ballSignals: l.ball.signalNames, y0, y: l.ball.node.position.y })}`);
    } finally {
      l.viewer.setSimulationPaused('nested-fixture', true);
      l.booted.h.dispose();
    }
  }, 30_000);
});

describe.skipIf(!smokeUrl)('FMU demo model — live against a real CONNECT (RV_CONNECT_URL)', () => {
  it('consent → BouncingBall runs, h changes, the Drive follows', async () => {
    const base = smokeUrl!.replace(/\/+$/, '');
    const gw = new URL(base);
    const asked: FmuTrustRequest[] = [];
    const plugin = new FmuProvisioningPlugin({
      gatewayUrl: () => base,
      subscribeGateway: () => () => {},
      // The consent dialog, answered "Trust & start".
      confirmTrust: async (req) => { asked.push(req); return true; },
      statusIntervalMs: 200,
    });
    const manager = new InterfaceManager();
    manager.register(new WebSocketRealtimeInterface());
    const t0 = performance.now();
    const timings: Record<string, number> = {};
    // Wide enough for the 640×480 viewer canvas (screenshot 1).
    await page.viewport(1000, 760);
    const l = await loadDemo(plugin);
    // Consent on every run: a gateway that already holds a package loses its trust first.
    const shas = [l.ball.embed!.sha256];
    const uploadedBefore: boolean[] = [];
    for (const sha of shas) {
      const had = !!(await getPackage(sha, { baseUrl: base }));
      uploadedBefore.push(had);
      if (had) await revokeTrust(sha, { baseUrl: base });
    }
    try {
      l.viewer.setSimulationPaused('nested-fixture', false);
      l.viewer.use(manager, 'core');
      await manager.activate('websocket-realtime', {
        ...INTERFACE_DEFAULTS,
        activeType: 'websocket-realtime',
        wsAddress: gw.hostname,
        wsPort: Number(gw.port || (gw.protocol === 'https:' ? 443 : 80)),
        wsUseSSL: gw.protocol === 'https:',
        wsPath: '/ws',
      });
      timings.wsConnectedMs = performance.now() - t0;
      const running = (f: RVFmu): boolean => {
        if (f.state === 'error') throw new Error(`${f.node.name}: ${f.lastError}`);
        return f.state === 'running';
      };
      await waitFor(`BouncingBall running (ball=${l.ball.state})`, () => running(l.ball), 20_000);
      timings.runningMs = performance.now() - t0;
      expect(new Set(asked.map((a) => a.sha256))).toEqual(new Set(shas));

      // ── Screenshot 1: the 3D view while the ball is in flight, live values as caption ──
      const store = l.viewer.signalStore!;
      l.viewer.camera.position.set(DEMO_CAMERA.px, DEMO_CAMERA.py, DEMO_CAMERA.pz); // = the file's SceneCamera
      l.viewer.controls.target.set(DEMO_CAMERA.tx, DEMO_CAMERA.ty, DEMO_CAMERA.tz);
      l.viewer.controls.update();
      await waitFor('ball in flight (0.3 m < h < 0.8 m)', () => { const h = store.getFloatByPath(l.hPath); return h > 0.3 && h < 0.8; }, 5_000);
      const cap = document.createElement('div');
      cap.style.cssText = 'position:absolute;left:8px;top:8px;padding:4px 8px;background:rgba(0,0,0,.6);color:#fff;font:12px sans-serif;z-index:10';
      cap.textContent = `fmu-demo.glb · Ball.h = ${store.getFloatByPath(l.hPath).toFixed(3)} m · Drive Ball = ${l.drive.currentPosition.toFixed(1)} mm · sim ${l.viewer.simTime.toFixed(2)} s`;
      l.booted.h.container.appendChild(cap);
      await page.screenshot({ path: `${SHOT_DIR}/plan-498-fmu-demo-3d.png`, element: l.booted.h.container });
      cap.remove();

      // ── BouncingBall: h changes, the Drive follows (same fixed step) ──
      const samples: Array<{ t: number; h: number; pos: number }> = [];
      const tS = performance.now();
      while (performance.now() - tS < 2_500) {
        samples.push({ t: performance.now() - tS, h: store.getFloatByPath(l.hPath), pos: l.drive.currentPosition });
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      const hs = samples.map((s) => s.h);
      const distinctH = new Set(hs.map((h) => h.toFixed(4))).size;
      const hMin = Math.min(...hs);
      const hMax = Math.max(...hs);
      // The Drive reads h in its fixed step; a sample taken between a stream
      // update and the next step is off by one step at most.
      const within = samples.filter((s) => Math.abs(s.pos - s.h * BALL_DRIVE_SCALE) <= 1).length;
      const maxDev = Math.max(...samples.map((s) => Math.abs(s.pos - s.h * BALL_DRIVE_SCALE)));
      expect(distinctH).toBeGreaterThan(10);
      expect(hMax - hMin).toBeGreaterThan(0.2);
      expect(within / samples.length).toBeGreaterThan(0.8);

      console.log(`[fmu-demo] live ${JSON.stringify({
        gateway: base, uploadedBefore, asked: asked.length,
        timings: Object.fromEntries(Object.entries(timings).map(([k, v]) => [k, Math.round(v)])),
        samples: samples.length, distinctH, hMin: +hMin.toFixed(4), hMax: +hMax.toFixed(4),
        driveFollowsWithin1mm: `${within}/${samples.length}`, maxDevMm: +maxDev.toFixed(3),
      })}`);

      // ── Screenshot 2: hierarchy with the FMU, its children and the Drive value ──
      l.booted.h.container.style.display = 'none';
      await page.viewport(1000, 900);
      const reg = l.viewer.registry!;
      const pathOf = (n: Object3D): string => reg.getPathForNode(n) ?? n.name;
      const rows: Array<{ depth: number; name: string; path: string; types: string[]; note?: string }> = [];
      const root = l.ball.node.parent!;
      rows.push({ depth: 0, name: root.name, path: pathOf(root), types: [] });
      for (const child of root.children) {
        const path = pathOf(child);
        const types = reg.getComponentTypes(path).filter((t) => !t.startsWith('PLC'));
        const fmu = child === l.ball.node ? l.ball : null;
        rows.push({
          depth: 1, name: child.name, path, types,
          note: child === l.ball.node ? `Drive ${l.drive.currentPosition.toFixed(1)} mm` : undefined,
        });
        if (!fmu) continue;
        rows.push({ depth: 2, name: 'Signals', path: `${path}/Signals`, types: [] });
        for (const s of fmu.signals) rows.push({ depth: 3, name: s.variable, path: s.path, types: [s.plcType] });
      }
      const { container } = render(
        <ThemeProvider theme={rvDarkTheme}>
          <RVViewerProvider value={l.viewer}>
            <Box data-testid="demo-shot" sx={{ display: 'flex', gap: 2, p: 2, bgcolor: '#15181c', width: 960, boxSizing: 'border-box', alignItems: 'flex-start' }}>
              <Box sx={{ width: 520, flexShrink: 0, bgcolor: '#1d2126', borderRadius: 1, p: 1 }}>
                <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', mb: 0.5 }}>
                  Hierarchy · fmu-demo.glb · sim {l.viewer.simTime.toFixed(2)} s
                </Typography>
                {rows.map((r) => (
                  <Box key={`${r.path}#${r.depth}`} sx={{ display: 'flex', alignItems: 'center', pl: r.depth * 2, height: 22, gap: 1 }}>
                    <Typography noWrap sx={{ fontSize: 12, color: 'rgba(255,255,255,0.9)', flex: 1, minWidth: 0 }}>{r.name}</Typography>
                    {r.note && <Typography sx={{ fontSize: 11, color: '#7dd3fc' }}>{r.note}</Typography>}
                    <NodeBadges types={r.types} signalStore={store} path={r.path} stepInfo={null} viewer={l.viewer} />
                  </Box>
                ))}
              </Box>
              <Box sx={{ width: 380, flexShrink: 0, bgcolor: '#1d2126', borderRadius: 1, p: 1 }}>
                <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.9)', mb: 0.5 }}>Inspector · Ball · Fmu</Typography>
                <FmuInspectorRenderer
                  value={(l.ball.node.userData.realvirtual as Record<string, Record<string, unknown>>).Fmu.FmuEmbed}
                  fieldName="FmuEmbed" componentType="Fmu" nodePath={l.ball.nodePath} viewer={l.viewer} signalStore={store}
                />
              </Box>
            </Box>
          </RVViewerProvider>
        </ThemeProvider>,
      );
      await new Promise((r) => setTimeout(r, 400)); // SignalBadge throttle
      await page.screenshot({ path: `${SHOT_DIR}/plan-498-fmu-demo-hierarchy.png`, element: container.querySelector('[data-testid="demo-shot"]') as HTMLElement });
      cleanup();
      l.booted.h.container.style.display = '';

      // ── Release: the lease goes, CONNECT removes the interface ──
      const ifaces = [l.ball.interfaceId!];
      l.viewer.setSimulationPaused('nested-fixture', true);
      plugin.dispose();
      let gone = false;
      for (let i = 0; i < 50 && !gone; i++) {
        const st = await fetchWorkerStatuses({ baseUrl: base });
        gone = ifaces.every((id) => !(id in st));
        if (!gone) await new Promise((r) => setTimeout(r, 100));
      }
      expect(gone).toBe(true);
    } finally {
      try { plugin.dispose(); } catch { /* already */ }
      for (const i of getFmuInstances()) {
        const lease = i.leaseId;
        if (lease) await releaseLease(lease, { baseUrl: base }).catch(() => undefined);
      }
      manager.deactivate();
      l.booted.h.dispose();
      console.log(`[fmu-demo] total ${Math.round(performance.now() - t0)} ms`);
    }
  }, 90_000);
});
