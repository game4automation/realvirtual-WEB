// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { expect, test, type Page } from 'playwright/test';

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

async function waitForViewer(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await waitForViewerReady(page);
}

async function firstDirectTarget(page: Page): Promise<string | null> {
  return page.evaluate(async () => {
    const viewer = (window as unknown as {
      __rvViewer: {
        scene: {
          add: (node: unknown) => void;
          clone: (recursive: boolean) => {
            name: string;
            userData: Record<string, unknown>;
          };
        };
        transportManager?: unknown;
        signalStore: {
          buildIndex: () => void;
        };
        registry: {
          getAll: (type: string) => Array<{ path: string; instance: { node?: unknown } }>;
          registerNode: (path: string, node: unknown) => void;
          register: (type: string, path: string, component: unknown) => void;
        };
        signalBindingManager: {
          getElementSlots: (id: string, node: unknown) => Array<{ kind: string; type: string }>;
        };
      };
    }).__rvViewer;
    for (const type of ['Drive_Simple', 'Drive_Cylinder', 'Drive_DestinationMotor']) {
      for (const entry of viewer.registry.getAll(type)) {
        const node = entry.instance.node;
        if (node && viewer.signalBindingManager.getElementSlots(entry.path, node)
          .some(slot => slot.kind === 'direct-property' && slot.type === 'bool')) return entry.path;
      }
    }

    const constructionPath = '/src/core/engine/rv-signal-construction.ts';
    const registryPath = '/src/core/engine/rv-component-registry.ts';
    const [{ constructDrive }, { resolveComponentRefs }] = await Promise.all([
      import(constructionPath),
      import(registryPath),
    ]);
    const path = '__e2e__/AutoDrive';
    const node = viewer.scene.clone(false);
    node.name = 'AutoDrive';
    const rv = {
      Drive: { Direction: 'LinearX' },
      Drive_Simple: {},
    };
    node.userData.realvirtual = rv;
    viewer.scene.add(node);
    viewer.registry.registerNode(path, node);
    const result = constructDrive(
      node,
      rv,
      rv.Drive,
      path,
      viewer.registry,
      viewer.signalStore,
    );
    viewer.signalStore.buildIndex();
    for (const entry of result?.pendingBehaviors ?? []) {
      resolveComponentRefs(entry.component, viewer.registry);
      viewer.registry.register(entry.type, entry.path, entry.component);
      entry.component.init({
        registry: viewer.registry,
        signalStore: viewer.signalStore,
        scene: viewer.scene,
        transportManager: viewer.transportManager,
        root: node,
      });
    }
    viewer.signalStore.buildIndex();
    return viewer.signalBindingManager.getElementSlots(path, node)
      .some(slot => slot.kind === 'direct-property' && slot.type === 'bool')
      ? path
      : null;
  });
}

async function badgeCount(page: Page): Promise<number> {
  return page.evaluate(() => {
    const viewer = (window as unknown as {
      __rvViewer: { gizmoManager: { _entries?: Map<string, { root: { userData: Record<string, unknown> } }> } };
    }).__rvViewer;
    let count = 0;
    for (const entry of viewer.gizmoManager._entries?.values() ?? []) {
      if (entry.root.userData.rvSignalBadge) count++;
    }
    return count;
  });
}

async function emitTargetClick(page: Page, path: string): Promise<void> {
  await page.evaluate((targetPath) => {
    const viewer = (window as unknown as {
      __rvViewer: {
        registry: {
          getAll: (type: string) => Array<{ path: string; instance: { node?: unknown } }>;
        };
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

test.describe('signal link mode e2e', () => {
  test.setTimeout(120_000);

  test.beforeEach(async ({ page }) => {
    await page.addInitScript(() => {
      localStorage.setItem('rv-welcome-dismissed', '1');
      localStorage.setItem('rv-auto-quality-applied', '1');
      if (sessionStorage.getItem('rv-signal-link-e2e-initialized')) return;
      localStorage.removeItem('rv-layout-signal-link-mode');
      sessionStorage.setItem('rv-signal-link-e2e-initialized', '1');
    });
    await waitForViewer(page);
  });

  test('toggle is visible in hmi and planner mode, hidden in fpv', async ({ page }) => {
    await expect(page.locator(TOGGLE)).toBeVisible();
    await page.evaluate(() => {
      const viewer = (window as unknown as {
        __rvViewer: { modes: { setMode: (mode: string) => void } };
      }).__rvViewer;
      viewer.modes.setMode('planner');
    });
    await expect(page.locator(TOGGLE)).toBeVisible();
    await page.evaluate(() => {
      const viewer = (window as unknown as {
        __rvViewer: {
          modes: {
            register: (mode: { id: string; label: string; order: number }) => unknown;
            setMode: (mode: string) => void;
          };
        };
      }).__rvViewer;
      viewer.modes.register({ id: 'fpv', label: 'FPV', order: 90 });
      viewer.modes.setMode('fpv');
    });
    await expect(page.locator(TOGGLE)).toBeHidden();
  });

  test('toggle ON shows badges and reload restores the persisted state', async ({ page }) => {
    await page.locator(TOGGLE).click();
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => badgeCount(page)).toBeGreaterThan(0);
    const before = await badgeCount(page);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForViewerReady(page);
    await expect(page.locator(TOGGLE)).toHaveAttribute('aria-pressed', 'true');
    await expect.poll(() => badgeCount(page)).toBe(before);
  });

  test('badge click without Shift opens a direct bind popover on mouse and touch', async ({ page, browser }) => {
    const path = await firstDirectTarget(page);
    expect(path).not.toBeNull();
    await page.locator(TOGGLE).click();
    await emitTargetClick(page, path!);
    await expect(page.locator('[data-testid="signal-bind-popover"]')).toBeVisible();

    const context = await browser.newContext({
      hasTouch: true,
      isMobile: true,
      viewport: { width: 820, height: 1180 },
    });
    const touchPage = await context.newPage();
    await touchPage.addInitScript(() => {
      localStorage.setItem('rv-welcome-dismissed', '1');
      localStorage.setItem('rv-auto-quality-applied', '1');
      localStorage.removeItem('rv-layout-signal-link-mode');
    });
    await waitForViewer(touchPage);
    const touchPath = await firstDirectTarget(touchPage);
    expect(touchPath).not.toBeNull();
    await touchPage.locator(TOGGLE).tap();
    await emitTargetClick(touchPage, touchPath!);
    await expect(touchPage.locator('[data-testid="signal-bind-popover"]')).toBeVisible();
    await context.close();
  });

  test('an unwired drive exposes direct rows and missing CONNECT stays pending', async ({ page }) => {
    const path = await firstDirectTarget(page);
    expect(path).not.toBeNull();
    await page.locator(TOGGLE).click();
    await emitTargetClick(page, path!);
    await expect(page.locator('[data-rv-slot-kind="direct-property"]').first()).toBeVisible();

    await page.evaluate((targetPath) => {
      const viewer = (window as unknown as {
        __rvViewer: {
          registry: {
            getAll: (type: string) => Array<{ path: string; instance: { node?: unknown } }>;
          };
          signalStore: {
            register: (name: string, path: string, value: boolean, type: string) => void;
          };
          signalBindingManager: {
            getElementSlots: (id: string, node: unknown) => Array<{
              kind: string; type: string; componentPath: string; slot: string;
            }>;
            bind: (id: string, node: unknown, mapping: Record<string, unknown>) => void;
            tick: (dt: number) => void;
          };
        };
      }).__rvViewer;
      for (const type of ['Drive_Simple', 'Drive_Cylinder', 'Drive_DestinationMotor']) {
        const hit = viewer.registry.getAll(type).find(entry => entry.path === targetPath);
        if (!hit?.instance.node) continue;
        const slot = viewer.signalBindingManager.getElementSlots(targetPath, hit.instance.node)
          .find(candidate => candidate.kind === 'direct-property' && candidate.type === 'bool');
        if (!slot) return;
        viewer.signalStore.register('E2E.Pending', '__e2e__/pending', false, 'PLCOutputBool');
        viewer.signalBindingManager.bind(targetPath, hit.instance.node, {
          kind: 'direct-property',
          componentPath: slot.componentPath,
          slot: slot.slot,
          signal: 'E2E.Pending',
          direction: 'plcOutput',
          enabled: true,
        });
        viewer.signalBindingManager.tick(1 / 60);
        return;
      }
    }, path!);
    await emitTargetClick(page, path!);
    await expect(page.locator('[data-testid="signal-bind-state"]')).toContainText('Pending');
  });

  test('a CONNECT-backed direct binding becomes live', async ({ page }) => {
    const path = await firstDirectTarget(page);
    expect(path).not.toBeNull();
    const state = await page.evaluate((targetPath) => {
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
              kind: string; type: string; componentPath: string; slot: string;
            }>;
            bind: (id: string, node: unknown, mapping: Record<string, unknown>) => void;
            tick: (dt: number) => void;
            getElementState: (id: string) => string;
          };
        };
      }).__rvViewer;
      for (const type of ['Drive_Simple', 'Drive_Cylinder', 'Drive_DestinationMotor']) {
        const hit = viewer.registry.getAll(type).find(entry => entry.path === targetPath);
        if (!hit?.instance.node) continue;
        const slot = viewer.signalBindingManager.getElementSlots(targetPath, hit.instance.node)
          .find(candidate => candidate.kind === 'direct-property' && candidate.type === 'bool');
        if (!slot) continue;
        viewer.signalStore.register('E2E.Live', '__e2e__/live', true, 'PLCOutputBool');
        viewer.signalStore.registerSignalProvider({ interfaceId: 'e2e-connect', signal: 'E2E.Live' }, true);
        viewer.signalBindingManager.bind(targetPath, hit.instance.node, {
          kind: 'direct-property',
          componentPath: slot.componentPath,
          slot: slot.slot,
          signal: 'E2E.Live',
          interfaceId: 'e2e-connect',
          direction: 'plcOutput',
          enabled: true,
        });
        viewer.signalBindingManager.tick(1 / 60);
        return viewer.signalBindingManager.getElementState(targetPath);
      }
      return 'missing';
    }, path!);
    expect(state).toBe('live');
  });

  test('sub-threshold Shift gesture shows no badges and does not persist the toggle', async ({ page }) => {
    await page.evaluate(async () => {
      const drag = await import('/src/core/hmi/signal-drag-store.ts');
      drag.armSignalDrag({
        name: 'E2E',
        interfaceId: 'connect',
        direction: 'output',
        plcType: 'PLCOutputBool',
      }, 10, 10);
      drag.updateSignalDrag(12, 12);
    });
    expect(await badgeCount(page)).toBe(0);
    expect(await page.evaluate(() => localStorage.getItem('rv-layout-signal-link-mode'))).toBeNull();
  });

  test('model switch and reload leave no stale or duplicate badges', async ({ page }) => {
    await page.locator(TOGGLE).click();
    await expect.poll(() => badgeCount(page)).toBeGreaterThan(0);
    await page.evaluate(async () => {
      const viewer = (window as unknown as {
        __rvViewer: { loadModel: (url: string) => Promise<unknown> };
      }).__rvViewer;
      await viewer.loadModel('/models/physics-zone-test.glb');
    });
    expect(await badgeCount(page)).toBe(0);
    await page.reload({ waitUntil: 'domcontentloaded' });
    await waitForViewerReady(page);
    const count = await badgeCount(page);
    const uniqueTargets = await page.evaluate(() => {
      const viewer = (window as unknown as {
        __rvViewer: { gizmoManager: { _entries?: Map<string, { root: { userData: Record<string, unknown> } }> } };
      }).__rvViewer;
      const ids: string[] = [];
      for (const entry of viewer.gizmoManager._entries?.values() ?? []) {
        if (entry.root.userData.rvSignalBadge) ids.push(String(entry.root.uuid));
      }
      return new Set(ids).size;
    });
    expect(count).toBe(uniqueTargets);
  });
});
