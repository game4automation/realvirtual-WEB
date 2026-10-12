// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-498 §9.8 — LIVE smoke against a real realvirtual CONNECT.
 *
 * Runs only when `RV_CONNECT_URL` names a running gateway (handed to the
 * browser by the `connectSmokeUrl` command in vite.config.ts); otherwise it is
 * skipped. The path under test is the production one end to end:
 *
 *   Feedthrough fixture GLB (Reference-FMUs v0.0.40, bytes as a glTF
 *   bufferView, extras written by the Phase-1 builder) → real viewer load →
 *   InterfaceManager + WebSocketRealtimeInterface to `<gateway>/ws` →
 *   FmuProvisioningPlugin: GET → upload → consent (answered yes) → POST trust
 *   from the browser (its Origin is a loopback origin CONNECT trusts) →
 *   POST /fmu/instances → /status → `running` →
 *   write `Hyd.Float64_continuous_input` (PLCInput) → CONNECT → rv_fmi.dll →
 *   `Hyd.Float64_continuous_output` at the child node `…/Signals/…` ≤ 2 s.
 *
 * Screenshots (hierarchy excerpt + inspector while running, consent dialog)
 * are written to the plan's asset folder — only in this manual live run.
 */

import { describe, it, expect } from 'vitest';
import { commands, page } from '@vitest/browser/context';
import { render, cleanup, act } from '@testing-library/react';
import { Box, Typography } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import type { Object3D } from 'three';
import feedthroughUrl from './fixtures/Feedthrough.fmu?url';
import { buildFmuGlb, sha256HexOf } from './helpers/glb-fixture';
import { bootRealLoaderViewer } from './helpers/nested-placement-fixture';
import { buildFmuExtras } from '../src/core/ops/rv-fmu-ops';
import { getFmuInstances, type RVFmu } from '../src/core/engine/rv-fmu';
import { InterfaceManager } from '../src/interfaces/interface-manager';
import { WebSocketRealtimeInterface } from '../src/interfaces/websocket-realtime-interface';
import { INTERFACE_DEFAULTS } from '../src/interfaces/interface-settings-store';
import { FmuProvisioningPlugin } from '../src/plugins/fmu-provisioning-plugin';
import { fetchWorkerStatuses, getPackage, releaseLease, revokeTrust } from '../src/core/hmi/connect-fmu';
import { requestFmuTrust, decideFmuTrust, type FmuTrustRequest } from '../src/core/hmi/fmu-trust-store';
import { FmuTrustDialog } from '../src/core/hmi/FmuTrustDialog';
import '../src/core/hmi/FmuAttachAction';
import { FmuInspectorRenderer } from '../src/core/hmi/FmuAttachAction';
import { NodeBadges } from '../src/core/hmi/hierarchy-badge-components';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import type { RVViewer } from '../src/core/rv-viewer';

const SHOT_DIR = 'E:/realvirtual6/game4automation/realvirtual/.docs/planfeature/assets/plan-498';

const smokeUrl = await (commands as unknown as { connectSmokeUrl(): Promise<string | null> }).connectSmokeUrl();

async function waitFor<T>(what: string, probe: () => T | null | undefined | false, timeoutMs: number): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = probe();
    if (v) return v as T;
    if (performance.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

function rowsOf(fmu: RVFmu, registry: RVViewer['registry']): Array<{ depth: number; name: string; path: string; types: string[] }> {
  const rows: Array<{ depth: number; name: string; path: string; types: string[] }> = [];
  const pathOf = (n: Object3D) => registry?.getPathForNode(n) ?? n.name;
  const root = fmu.node.parent!;
  rows.push({ depth: 0, name: root.name, path: pathOf(root), types: [] });
  rows.push({ depth: 1, name: fmu.node.name, path: fmu.nodePath, types: ['Fmu'] });
  const signals = fmu.node.children.find((c) => c.name === 'Signals');
  if (signals) {
    rows.push({ depth: 2, name: 'Signals', path: pathOf(signals), types: [] });
    for (const s of fmu.signals) rows.push({ depth: 3, name: s.variable, path: s.path, types: [s.plcType] });
  }
  return rows;
}

describe.skipIf(!smokeUrl)('FMU live smoke (real CONNECT, RV_CONNECT_URL)', () => {
  it('Feedthrough: input written in the viewer arrives at the output child node within 2 s', async () => {
    const base = smokeUrl!.replace(/\/+$/, '');
    const gw = new URL(base);
    const bytes = new Uint8Array(await (await fetch(feedthroughUrl)).arrayBuffer());
    const sha = await sha256HexOf(bytes);
    const { readModelDescription } = await import('../src/core/engine/rv-fmu-model-description');
    const extras = buildFmuExtras({ fileName: 'Feedthrough.fmu', sha256: sha, bytes, description: await readModelDescription(bytes) });
    const glb = buildFmuGlb([{ name: 'Hyd', payload: bytes, fmu: extras }], 'SmokeCell');

    // Consent path on every run: a package the gateway already holds (an
    // earlier run) loses its trust first, so the dialog must ask again. A fresh
    // gateway data dir additionally exercises GET 404 → upload. (No DELETE of
    // the package: CONNECT keeps a loaded FMU's DLL until restart.)
    const existedBefore = !!(await getPackage(sha, { baseUrl: base }));
    if (existedBefore) await revokeTrust(sha, { baseUrl: base });

    const booted = await bootRealLoaderViewer();
    const viewer = booted.h.viewer;
    const manager = new InterfaceManager();
    manager.register(new WebSocketRealtimeInterface());
    const asked: FmuTrustRequest[] = [];
    const plugin = new FmuProvisioningPlugin({
      gatewayUrl: () => base,
      subscribeGateway: () => () => {},
      // The consent dialog, answered "Trust & start" — the plugin then
      // POSTs /fmu/{sha}/trust from THIS browser (Origin set by the browser).
      confirmTrust: async (req) => { asked.push(req); return true; },
      statusIntervalMs: 200,
    });
    const timings: Record<string, number> = {};
    const t0 = performance.now();
    try {
      // Registered before the load, as in main.ts: its document-id provider
      // names the instance keys (`fmu-smoke.glb#SmokeCell/Hyd`).
      viewer.use(plugin, 'core');
      await viewer.loadModel('fmu-smoke.glb', { data: glb.slice(0) });
      await viewer.whenSceneReady();
      viewer.setSimulationPaused('nested-fixture', false);
      const inScene = new Set<Object3D>();
      viewer.scene.traverse((n) => inScene.add(n));
      const fmu = getFmuInstances().find((i) => inScene.has(i.node))!;
      expect(fmu).toBeTruthy();
      expect(fmu.state).toBe('standalone');
      expect(fmu.signalNames).toContain('Hyd.Float64_continuous_input');

      expect(fmu.instanceKey).toBe('fmu-smoke.glb#SmokeCell/Hyd');
      viewer.use(manager, 'core');
      await manager.activate('websocket-realtime', {
        ...INTERFACE_DEFAULTS,
        activeType: 'websocket-realtime',
        wsAddress: gw.hostname,
        wsPort: Number(gw.port || (gw.protocol === 'https:' ? 443 : 80)),
        wsUseSSL: gw.protocol === 'https:',
        wsPath: '/ws',
      });
      timings.wsConnectedMs = performance.now() - t0;

      await waitFor(`FMU running (state=${fmu.state})`, () => fmu.state === 'running' || (fmu.state === 'error' ? (() => { throw new Error(`FMU error: ${fmu.lastError}`); })() : false), 20_000);
      timings.runningMs = performance.now() - t0;
      expect(plugin.transport()).toMatchObject({ kind: 'connect' });
      expect(fmu.leaseId).toBeTruthy();
      // GET 404 → upload → consent (once) → trust from the browser → instance.
      expect(asked).toHaveLength(1);
      const remote = await getPackage(sha, { baseUrl: base });
      expect(remote?.trusted).toBe(true);
      expect(remote?.refCount).toBe(1);

      const store = viewer.signalStore!;
      const outPath = fmu.signals.find((s) => s.variable === 'Float64_continuous_output')!.path;
      const intOutPath = fmu.signals.find((s) => s.variable === 'Int32_output')!.path;
      // Let the first values arrive (start values flow back).
      await waitFor('first output value', () => store.getByPath(outPath) !== undefined, 5_000);

      const results: number[] = [];
      for (const value of [3.25, -7.5, 42.125]) {
        const tw = performance.now();
        store.set('Hyd.Float64_continuous_input', value);
        await waitFor(`output = ${value}`, () => store.getByPath(outPath) === value, 2_000);
        results.push(performance.now() - tw);
      }
      const tInt = performance.now();
      store.set('Hyd.Int32_input', 17);
      await waitFor('Int32_output = 17', () => store.getByPath(intOutPath) === 17, 2_000);
      results.push(performance.now() - tInt);
      timings.latencyFloatMs = Math.max(...results.slice(0, 3));
      timings.latencyIntMs = results[3];
      console.log(`[fmu-live-smoke] ${JSON.stringify({ gateway: base, sha: sha.slice(0, 12), uploaded: !existedBefore, asked: asked.length, timings, latenciesMs: results.map((r) => Math.round(r)) })}`);
      for (const r of results) expect(r).toBeLessThanOrEqual(2_000);

      // ── Screenshots (hierarchy excerpt, inspector, consent dialog) ──
      // The viewer canvas is a fixed overlay at the top-left — out of the way.
      booted.h.container.style.display = 'none';
      await page.viewport(1000, 760);
      const rows = rowsOf(fmu, viewer.registry);
      const { container } = render(
        <ThemeProvider theme={rvDarkTheme}>
          <RVViewerProvider value={viewer}>
            <Box data-testid="smoke-shot" sx={{ display: 'flex', gap: 2, p: 2, bgcolor: '#15181c', width: 940, boxSizing: 'border-box', alignItems: 'flex-start' }}>
              <Box data-testid="shot-hierarchy" sx={{ width: 470, flexShrink: 0, bgcolor: '#1d2126', borderRadius: 1, p: 1 }}>
                <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.55)', mb: 0.5 }}>
                  Hierarchy · sim {viewer.simTime.toFixed(2)} s
                </Typography>
                {rows.map((r) => (
                  <Box key={r.path} sx={{ display: 'flex', alignItems: 'center', pl: r.depth * 2, height: 22 }}>
                    <Typography noWrap sx={{ fontSize: 12, color: 'rgba(255,255,255,0.9)', flex: 1, minWidth: 0 }}>{r.name}</Typography>
                    <NodeBadges types={r.types} signalStore={store} path={r.path} stepInfo={null} viewer={viewer} />
                  </Box>
                ))}
              </Box>
              <Box data-testid="shot-inspector" sx={{ width: 400, flexShrink: 0, bgcolor: '#1d2126', borderRadius: 1, p: 1 }}>
                <Typography sx={{ fontSize: 12, fontWeight: 600, color: 'rgba(255,255,255,0.9)', mb: 0.5 }}>Inspector · {fmu.node.name} · Fmu</Typography>
                <FmuInspectorRenderer
                  value={(fmu.node.userData.realvirtual as Record<string, Record<string, unknown>>).Fmu.FmuEmbed}
                  fieldName="FmuEmbed" componentType="Fmu" nodePath={fmu.nodePath} viewer={viewer} signalStore={store}
                />
              </Box>
            </Box>
          </RVViewerProvider>
        </ThemeProvider>,
      );
      await new Promise((r) => setTimeout(r, 400)); // SignalBadge throttle
      const shot = container.querySelector('[data-testid="smoke-shot"]') as HTMLElement;
      await page.screenshot({ path: `${SHOT_DIR}/plan-498-hierarchy-inspector-running.png`, element: shot });
      cleanup();

      render(<ThemeProvider theme={rvDarkTheme}><FmuTrustDialog /></ThemeProvider>);
      let decided: Promise<boolean> | null = null;
      act(() => {
        decided = requestFmuTrust({
          sha256: sha, modelName: fmu.modelName, guid: fmu.embed?.guid ?? '', generationTool: fmu.embed?.generationTool ?? '',
          fileName: fmu.embed?.fileName ?? '', byteLength: fmu.embed?.byteLength ?? 0,
          sources: [{ nodePath: fmu.nodePath, instanceKey: fmu.instanceKey }],
        });
      });
      await new Promise((r) => setTimeout(r, 300));
      const dialog = document.querySelector('[role="dialog"]') as HTMLElement;
      await page.screenshot({ path: `${SHOT_DIR}/plan-498-trust-dialog.png`, element: dialog });
      act(() => decideFmuTrust(new Set()));
      expect(await decided!).toBe(false);
      cleanup();

      // ── Release: the lease goes, CONNECT removes the interface (last lease) ──
      const iface = fmu.interfaceId!;
      viewer.setSimulationPaused('nested-fixture', true);
      plugin.dispose();
      let gone = false;
      for (let i = 0; i < 50 && !gone; i++) {
        const st = await fetchWorkerStatuses({ baseUrl: base });
        gone = !(iface in st);
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
      booted.h.dispose();
      console.log(`[fmu-live-smoke] total ${Math.round(performance.now() - t0)} ms`);
    }
  }, 60_000);
});
