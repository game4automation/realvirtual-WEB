// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * 9.10 canWriteSlot-ui (plan-320 Phase 5) — ONE flow, modeled on
 * e2e/signal-link-mode.spec.ts:
 *   bind a mapped slot → authority 'bound' (popover row label) →
 *   force → authority 'forced' → unforce → authority 'bound' again AND the
 *   held live source value is redispatched onto the slot →
 *   model switch clears every claim.
 *
 * NOTE (plan-325 coordination): the authority label currently lives on the
 * SignalBindPopover rows (`data-testid="slot-status-<slot>"`). After the
 * plan-325 inline inspector rows merge, the same state moves onto those rows.
 */

import { expect, test, type Page } from 'playwright/test';
import { DEV_GLB } from '../tests/fixtures/glb-paths.mjs';

const TOGGLE = '[data-testid="signal-link-mode-toggle"]';

async function waitForViewerReady(page: Page): Promise<void> {
  await page.waitForSelector('canvas', { timeout: 30_000 });
  await page.waitForFunction(() => {
    const viewer = (window as unknown as {
      __rvViewer?: {
        currentModelUrl?: string;
        signalBindingManager?: unknown;
      };
    }).__rvViewer;
    const overlay = document.getElementById('loading-overlay');
    return !!viewer?.signalBindingManager
      && !!viewer.currentModelUrl
      && !!overlay?.classList.contains('hidden');
  }, undefined, { timeout: 90_000 });
  const qualityNotice = page.locator('[data-testid="auto-quality-ok"]');
  if (await qualityNotice.isVisible()) await qualityNotice.click();
}

interface BoundSlotInfo {
  path: string;
  slot: string;
  componentPath: string;
  targetName: string;
}

/** Bind the first mapped bool slot of a Drive_* element to a fake live CONNECT source. */
async function bindFirstMappedSlot(page: Page): Promise<BoundSlotInfo | null> {
  return page.evaluate(() => {
    const viewer = (window as unknown as {
      __rvViewer: {
        registry: {
          getAll: (type: string) => Array<{ path: string; instance: { node?: unknown } }>;
        };
        signalStore: {
          register: (name: string, path: string, value: boolean, type: string) => void;
          registerSignalProvider: (source: { interfaceId: string; signal: string }, connected: boolean) => void;
        };
        signalBindingManager: {
          getElementSlots: (id: string, node: unknown) => Array<{
            kind: string; type: string; componentPath: string; slot: string; targetName?: string;
          }>;
          bind: (id: string, node: unknown, mapping: Record<string, unknown>) => void;
          tick: (dt: number) => void;
        };
      };
    }).__rvViewer;
    for (const type of ['Drive_Simple', 'Drive_Cylinder', 'Drive_DestinationMotor']) {
      for (const entry of viewer.registry.getAll(type)) {
        const node = entry.instance.node;
        if (!node) continue;
        const slot = viewer.signalBindingManager.getElementSlots(entry.path, node)
          .find(candidate => candidate.kind === 'mapped-signal' && candidate.type === 'bool' && !!candidate.targetName);
        if (!slot) continue;
        viewer.signalStore.register('E2E.Authority', '__e2e__/authority', true, 'PLCOutputBool');
        viewer.signalStore.registerSignalProvider({ interfaceId: 'e2e-connect', signal: 'E2E.Authority' }, true);
        viewer.signalBindingManager.bind(entry.path, node, {
          kind: 'mapped-signal',
          componentPath: slot.componentPath,
          slot: slot.slot,
          signal: 'E2E.Authority',
          interfaceId: 'e2e-connect',
          direction: 'plcOutput',
          enabled: true,
        });
        viewer.signalBindingManager.tick(1 / 60);
        return {
          path: entry.path,
          slot: slot.slot,
          componentPath: slot.componentPath,
          targetName: slot.targetName!,
        };
      }
    }
    return null;
  });
}

/** Current authority of the bound slot via the service (ground truth). */
async function slotAuthority(page: Page, info: BoundSlotInfo): Promise<string> {
  return page.evaluate(async (args) => {
    const authority = await import('/src/core/engine/rv-slot-authority.ts');
    const viewer = (window as unknown as {
      __rvViewer: {
        signalBindingManager: {
          getSlotId: (id: string, slot: string, componentPath?: string) => string | undefined;
          tick: (dt: number) => void;
        };
      };
    }).__rvViewer;
    viewer.signalBindingManager.tick(1 / 60);
    const slotId = viewer.signalBindingManager.getSlotId(args.path, args.slot, args.componentPath);
    return slotId ? authority.getSlotAuthority(slotId) : 'missing';
  }, info);
}

async function openPopover(page: Page, path: string): Promise<void> {
  await page.evaluate((targetPath) => {
    const viewer = (window as unknown as {
      __rvViewer: {
        registry: { getAll: (type: string) => Array<{ path: string; instance: { node?: unknown } }> };
        emit: (event: string, value: unknown) => void;
      };
    }).__rvViewer;
    for (const type of ['Drive_Simple', 'Drive_Cylinder', 'Drive_DestinationMotor']) {
      const hit = viewer.registry.getAll(type).find(entry => entry.path === targetPath);
      if (hit?.instance.node) {
        viewer.emit('object-clicked', { path: targetPath, node: hit.instance.node });
        return;
      }
    }
  }, path);
}

test.describe('slot authority e2e (9.10)', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('rv-welcome-dismissed', '1');
      localStorage.setItem('rv-auto-quality-applied', '1');
      localStorage.removeItem('rv-layout-signal-link-mode');
    });
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await waitForViewerReady(page);
  });

  test('bind → force → unforce with redispatch → authority states → model switch cleans up', async ({ page }) => {
    // 1) Bind a mapped slot to a live fake CONNECT source → 'bound'.
    const info = await bindFirstMappedSlot(page);
    expect(info).not.toBeNull();
    expect(await slotAuthority(page, info!)).toBe('bound');

    // The popover row shows the authority label.
    await page.locator(TOGGLE).click();
    await openPopover(page, info!.path);
    await expect(page.locator(`[data-testid="slot-status-${info!.slot}"]`)).toHaveText('bound');

    // 2) Operator force overlays → 'forced' (latent claim, bound kept).
    await page.evaluate((args) => {
      const viewer = (window as unknown as {
        __rvViewer: {
          signalStore: { forceSignal: (name: string, value: boolean) => void };
          signalBindingManager: { tick: (dt: number) => void };
        };
      }).__rvViewer;
      viewer.signalStore.forceSignal(args.targetName, false);
      viewer.signalBindingManager.tick(1 / 60);
    }, info!);
    expect(await slotAuthority(page, info!)).toBe('forced');
    // Re-open the popover so the connected wrapper recomputes the row state.
    await openPopover(page, info!.path);
    await expect(page.locator(`[data-testid="slot-status-${info!.slot}"]`)).toHaveText('forced');

    // 3) Unforce → 'bound' restored AND the held live source value (true) is
    //    redispatched onto the slot.
    const afterUnforce = await page.evaluate((args) => {
      const viewer = (window as unknown as {
        __rvViewer: {
          signalStore: {
            unforce: (name: string) => void;
            get: (name: string) => boolean | number | undefined;
          };
          signalBindingManager: { tick: (dt: number) => void };
        };
      }).__rvViewer;
      viewer.signalStore.unforce(args.targetName);
      viewer.signalBindingManager.tick(1 / 60);
      return viewer.signalStore.get(args.targetName);
    }, info!);
    expect(afterUnforce).toBe(true);
    expect(await slotAuthority(page, info!)).toBe('bound');

    // 4) Model switch clears every claim (unconditional reset in clearModel).
    const claimsAfterSwitch = await page.evaluate(async (modelUrl) => {
      const viewer = (window as unknown as {
        __rvViewer: { loadModel: (url: string) => Promise<unknown> };
      }).__rvViewer;
      await viewer.loadModel(modelUrl);
      const authority = await import('/src/core/engine/rv-slot-authority.ts');
      return authority.claimedSlotCount();
    }, DEV_GLB.physicsZone);
    expect(claimsAfterSwitch).toBe(0);
  });
});
