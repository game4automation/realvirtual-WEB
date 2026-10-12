// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * plan-512 F12 — acceptance of the unit-aware bind on the FMU demo, WITHOUT
 * touching the shipped `fmu-demo.glb`: the demo recipe builds an UNBOUND
 * fixture (`bindPosition: false`), the real viewer loads it, and `Ball.h` [m]
 * is bound to `Drive_FollowPosition.Position` through the INSPECTOR (bracket →
 * picker → option). Expected: `Scale` reads 1000, the badge says auto, the
 * Drive follows h in millimetres; after an unbind `Scale` stays 1000 and the
 * badge is gone.
 *
 * Live part (only with `RV_CONNECT_URL`, like `fmu-demo-model.e2e`): the
 * BouncingBall runs in CONNECT and the ball visibly bounces — over several
 * moments Y falls below 0.5 m and afterwards rises above 0.7 m again.
 * Screenshot: `.docs/planfeature/assets/plan-512/inspector-scale-badge.png`.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { commands, page } from '@vitest/browser/context';
import { render, cleanup, fireEvent, waitFor as rtlWaitFor } from '@testing-library/react';
import { ThemeProvider } from '@mui/material/styles';
import { Box } from '@mui/material';
import bouncingBallUrl from './fixtures/BouncingBall.fmu?url';
import { buildFmuDemoGlb, BALL_RADIUS } from './helpers/fmu-demo-scene';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import { binaryResources } from '../src/core/engine/rv-binary-resources';
import { getFmuInstances, type RVFmu } from '../src/core/engine/rv-fmu';
import type { RVDrive } from '../src/core/engine/rv-drive';
import { RvDocument } from '../src/core/ops/rv-document';
import type { RvSceneOp } from '../src/core/ops/rv-unified-ops';
import { freshOpId } from '../src/core/ops/rv-op-utils';
import { applyForward, applyInverse } from '../src/core/hmi/scene/rv-scene-executors';
import { setActiveEditTarget, type EditTarget } from '../src/core/hmi/rv-edit-target';
import { ComponentSection } from '../src/core/hmi/rv-component-section';
import { rvDarkTheme } from '../src/core/hmi/theme';
import { RVViewerProvider } from '../src/hooks/use-viewer';
import { InterfaceManager } from '../src/interfaces/interface-manager';
import { WebSocketRealtimeInterface } from '../src/interfaces/websocket-realtime-interface';
import { INTERFACE_DEFAULTS } from '../src/interfaces/interface-settings-store';
import { FmuProvisioningPlugin } from '../src/plugins/fmu-provisioning-plugin';
import { getPackage, releaseLease, revokeTrust } from '../src/core/hmi/connect-fmu';
import type { RVViewer } from '../src/core/rv-viewer';

const SHOT_DIR = 'E:/realvirtual6/game4automation/realvirtual/.docs/planfeature/assets/plan-512';
const FP = 'Drive_FollowPosition';
const smokeUrl = await (commands as unknown as { connectSmokeUrl(): Promise<string | null> }).connectSmokeUrl();

async function until<T>(what: string, probe: () => T | null | undefined | false, timeoutMs: number): Promise<T> {
  const t0 = performance.now();
  for (;;) {
    const v = probe();
    if (v) return v as T;
    if (performance.now() - t0 > timeoutMs) throw new Error(`timeout (${timeoutMs} ms) waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 10));
  }
}

/** A document-backed edit target over the real scene executors (what the SceneStore adapter is). */
function documentEditTarget(viewer: RVViewer): { et: EditTarget; doc: RvDocument } {
  const doc = new RvDocument({
    id: 'plan-512-e2e', name: 'plan-512 e2e', mode: 'scene',
    executor: {
      applyForward: (op) => applyForward(op as RvSceneOp, { viewer }),
      applyInverse: (op) => applyInverse(op as RvSceneOp, { viewer }),
    },
  });
  const mk = (p: string, c: string, f: string, v: unknown, prev: unknown) => ({
    id: freshOpId(), ts: Date.now(), schemaV: 1 as const, kind: 'setField' as const,
    nodePath: p, componentType: c, fieldName: f, value: v, prev,
  });
  const et: EditTarget = {
    available: true,
    documentKey: doc,
    setField: (p, c, f, v, prev) => doc.applyOpDetached(mk(p, c, f, v, prev)),
    setFieldAsync: (p, c, f, v, prev) => doc.applyOp(mk(p, c, f, v, prev)),
    unsetField: () => { throw new Error('unused'); },
    withTransaction: (label, fn) => doc.withTransaction(label, fn),
  };
  return { et, doc };
}

interface Loaded {
  h: TestViewerHandle;
  viewer: RVViewer;
  ball: RVFmu;
  drive: RVDrive;
  ballPath: string;
  doc: RvDocument;
}

async function loadUnbound(plugin?: FmuProvisioningPlugin): Promise<Loaded> {
  binaryResources._resetForTesting();
  const bytes = new Uint8Array(await (await fetch(bouncingBallUrl)).arrayBuffer());
  const { glb } = await buildFmuDemoGlb(bytes, { bindPosition: false });
  const h = await createTestViewer('webgl', { plannerSignalLinking: true, width: 640, height: 480 });
  const viewer = h.viewer;
  if (plugin) viewer.use(plugin, 'core');
  await viewer.loadModel('fmu-units.glb', { data: glb });
  await viewer.whenSceneReady();
  const ball = getFmuInstances().find((i) => i.node.name === 'Ball' && viewer.scene.getObjectById(i.node.id))!;
  const ballPath = viewer.registry!.getPathForNode(ball.node)!;
  const drive = viewer.registry!.getByPath<RVDrive>('Drive', ballPath)!;
  const { et, doc } = documentEditTarget(viewer);
  setActiveEditTarget(et);
  return { h, viewer, ball, drive, ballPath, doc };
}

function inspector(l: Loaded) {
  const rv = l.ball.node.userData.realvirtual as Record<string, Record<string, unknown>>;
  return (
    <ThemeProvider theme={rvDarkTheme}>
      <RVViewerProvider value={l.viewer}>
        <Box data-testid="inspector-shot" sx={{ width: 420, bgcolor: '#1d2126', p: 1 }}>
          <ComponentSection
            nodePath={l.ballPath}
            componentType={FP}
            data={{ ...rv[FP] }}
            overriddenFields={new Set()}
            consumedOnly={false}
            onFieldEdit={() => {}}
            onFieldReset={() => {}}
            onResetComponent={() => {}}
            viewer={l.viewer}
            signalStore={l.viewer.signalStore}
          />
        </Box>
      </RVViewerProvider>
    </ThemeProvider>
  );
}

/** Bind `Ball.h` to Position the way a user does: bracket → picker → option. */
async function bindThroughInspector(l: Loaded): Promise<ReturnType<typeof render>> {
  const view = render(inspector(l));
  const bracket = await rtlWaitFor(() => {
    const b = view.container.querySelector<HTMLElement>('button[aria-label="signal for Position"]');
    if (!b) throw new Error('no Position bracket yet');
    return b;
  });
  fireEvent.click(bracket);
  const option = await rtlWaitFor(() => {
    const o = document.querySelector<HTMLElement>('[role="option"][aria-label="Ball.h"]');
    if (!o) throw new Error('no Ball.h option yet');
    return o;
  });
  // The picker shows the unit next to the name (F9).
  expect(option.querySelector('[data-testid="signal-unit-chip"]')?.textContent).toBe('m');
  fireEvent.click(option);
  await until('Scale written', () => (l.ball.node.userData.realvirtual as Record<string, Record<string, unknown>>)[FP].Scale === 1000, 5_000);
  await l.doc.whenIdle();
  view.rerender(inspector(l));
  return view;
}

function badge(container: HTMLElement): HTMLElement | null {
  return container.querySelector<HTMLElement>('[data-testid="unit-scale-badge"]');
}

afterEach(() => { cleanup(); setActiveEditTarget(null); });

describe('FMU units demo — unbound fixture, standalone (plan-512 F12)', () => {
  it('binding Ball.h through the inspector writes Scale 1000 (auto), the Drive follows in mm; unbind keeps 1000', async () => {
    const l = await loadUnbound();
    try {
      expect(l.ball.signalNames).toContain('Ball.h');
      expect(l.viewer.signalStore!.getSignalMeta('Ball.h')?.unit).toBe('m');
      const scale0 = (l.ball.node.userData.realvirtual as Record<string, Record<string, unknown>>)[FP].Scale;
      expect(scale0).toBe(1);

      const view = await bindThroughInspector(l);
      const comp = l.viewer.registry!.getByPath<{ Scale: number }>(FP, l.ballPath)!;
      expect(comp.Scale).toBe(1000);
      const b = badge(view.container)!;
      expect(b.getAttribute('data-unit-status')).toBe('auto');
      expect(b.getAttribute('title')).toContain('m → mm');
      // The viewer canvas sits on top of the rendered section — out of the way for the shot.
      l.h.container.style.display = 'none';
      await page.viewport(900, 900);
      await new Promise((r) => setTimeout(r, 200));
      await page.screenshot({ path: `${SHOT_DIR}/inspector-scale-badge.png`, element: view.container.querySelector('[data-testid="inspector-shot"]') as HTMLElement });
      l.h.container.style.display = '';

      // Standalone: h moves the Drive at the written factor.
      const store = l.viewer.signalStore!;
      store.set('Ball.h', 0.25);
      await until(`drive follows h=0.25 (pos=${l.drive.currentPosition})`, () => Math.abs(l.drive.currentPosition - 250) < 1e-6, 3_000);
      store.set('Ball.h', 0.8);
      await until(`drive follows h=0.8 (pos=${l.drive.currentPosition})`, () => Math.abs(l.drive.currentPosition - 800) < 1e-6, 3_000);

      // Unbind: the number stays, the badge goes.
      const unbind = view.container.querySelector<HTMLElement>('button[aria-label="unbind Position"]')!;
      fireEvent.click(unbind);
      await l.doc.whenIdle();
      view.rerender(inspector(l));
      expect((l.ball.node.userData.realvirtual as Record<string, Record<string, unknown>>)[FP].Scale).toBe(1000);
      expect(badge(view.container)).toBeNull();
    } finally {
      l.h.dispose();
    }
  }, 60_000);
});

describe.skipIf(!smokeUrl)('FMU units demo — live against a real CONNECT (RV_CONNECT_URL)', () => {
  it('the bound ball really bounces: Y below 0.5 m, then above 0.7 m again', async () => {
    const base = smokeUrl!.replace(/\/+$/, '');
    const gw = new URL(base);
    const plugin = new FmuProvisioningPlugin({
      gatewayUrl: () => base,
      subscribeGateway: () => () => {},
      confirmTrust: async () => true,
      statusIntervalMs: 200,
    });
    const manager = new InterfaceManager();
    manager.register(new WebSocketRealtimeInterface());
    const l = await loadUnbound(plugin);
    const sha = l.ball.embed!.sha256;
    if (await getPackage(sha, { baseUrl: base })) await revokeTrust(sha, { baseUrl: base });
    try {
      l.viewer.use(manager, 'core');
      await manager.activate('websocket-realtime', {
        ...INTERFACE_DEFAULTS,
        activeType: 'websocket-realtime',
        wsAddress: gw.hostname,
        wsPort: Number(gw.port || (gw.protocol === 'https:' ? 443 : 80)),
        wsUseSSL: gw.protocol === 'https:',
        wsPath: '/ws',
      });
      await until(`BouncingBall running (${l.ball.state} ${l.ball.lastError ?? ''})`, () => {
        if (l.ball.state === 'error') throw new Error(l.ball.lastError ?? 'fmu error');
        return l.ball.state === 'running';
      }, 20_000);
      await bindThroughInspector(l);
      // Ball centre y = r + h (Drive LinearY, mm → m by the node transform).
      const yOf = () => l.ball.node.position.y - BALL_RADIUS;
      const samples: number[] = [];
      let low = false;
      let highAfterLow = false;
      const t0 = performance.now();
      while (performance.now() - t0 < 8_000 && !highAfterLow) {
        const y = yOf();
        samples.push(+y.toFixed(3));
        if (y < 0.5) low = true;
        else if (low && y > 0.7) highAfterLow = true;
        await new Promise((r) => requestAnimationFrame(() => r(null)));
      }
      console.log(`[fmu-units] live ${JSON.stringify({ samples: samples.length, min: Math.min(...samples), max: Math.max(...samples), low, highAfterLow })}`);
      expect(low).toBe(true);
      expect(highAfterLow).toBe(true);
    } finally {
      try { plugin.dispose(); } catch { /* already */ }
      for (const i of getFmuInstances()) if (i.leaseId) await releaseLease(i.leaseId, { baseUrl: base }).catch(() => undefined);
      manager.deactivate();
      l.h.dispose();
    }
  }, 90_000);
});
