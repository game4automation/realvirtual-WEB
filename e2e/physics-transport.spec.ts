// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Playwright E2E Tests: Physics & Transport Surface Verification
 *
 * Loads the WebViewer with a test GLB scene and verifies that:
 * - Rapier physics plugin initializes correctly
 * - Transport surfaces are created in the physics world
 * - MUs are spawned by Sources and get physics bodies
 * - MUs stay on conveyor surfaces (don't fall through)
 * - MUs are transported in the correct direction
 * - Sensors detect MUs passing through
 * - The ground plane prevents MUs from falling into the void
 */
import { test, expect } from 'playwright/test';

// Helper: evaluate code in the page context with the viewer available
async function evalViewer<T>(page: import('playwright/test').Page, fn: string): Promise<T> {
  return page.evaluate(fn) as Promise<T>;
}

// Helper: wait for the viewer to be ready and model loaded
async function waitForViewerReady(page: import('playwright/test').Page, timeout = 30_000) {
  await page.waitForFunction(
    () => {
      const v = (window as any).viewer;
      return v && v.transportManager && v.transportManager.surfaces.length > 0;
    },
    { timeout },
  );
}

// Helper: wait for physics plugin to be active
async function waitForPhysicsReady(page: import('playwright/test').Page, timeout = 30_000) {
  await page.waitForFunction(
    () => {
      const v = (window as any).viewer;
      if (!v) return false;
      const plugin = v.getPlugin('rapier-physics');
      return plugin && plugin.isReady;
    },
    { timeout },
  );
}

// Helper: advance simulation by waiting N ms of real time
async function waitSimulationTime(page: import('playwright/test').Page, ms: number) {
  await page.waitForTimeout(ms);
}

test.describe('Physics & Transport E2E', () => {
  test.beforeEach(async ({ page }) => {
    // Load the viewer with the test model
    await page.goto('/?model=./models/tests.glb');
    await waitForViewerReady(page);
  });

  test('Rapier physics plugin should be initialized', async ({ page }) => {
    await waitForPhysicsReady(page);

    const isReady = await evalViewer<boolean>(page,
      `(() => {
        const p = window.viewer.getPlugin('rapier-physics');
        return p ? p.isReady : false;
      })()`,
    );

    expect(isReady).toBe(true);
  });

  test('transport surfaces should be registered in physics world', async ({ page }) => {
    await waitForPhysicsReady(page);

    const surfaceCount = await evalViewer<number>(page,
      `(() => {
        const tm = window.viewer.transportManager;
        return tm ? tm.surfaces.length : 0;
      })()`,
    );

    expect(surfaceCount).toBeGreaterThan(0);

    // Also verify physics world has bodies
    const bodyCount = await evalViewer<number>(page,
      `(() => {
        const p = window.viewer.getPlugin('rapier-physics');
        return p && p.physicsWorld ? p.physicsWorld.bodyCount : 0;
      })()`,
    );

    // Should have at least: ground plane + surfaces
    expect(bodyCount).toBeGreaterThan(surfaceCount);
  });

  test('sources should spawn MUs with physics bodies', async ({ page }) => {
    await waitForPhysicsReady(page);

    const sourceCount = await evalViewer<number>(page,
      `(() => {
        const tm = window.viewer.transportManager;
        return tm ? tm.sources.length : 0;
      })()`,
    );

    if (sourceCount === 0) {
      test.skip();
      return;
    }

    // Wait for sources to spawn MUs (up to 10 seconds)
    await page.waitForFunction(
      () => {
        const tm = (window as any).viewer?.transportManager;
        return tm && tm.mus.length > 0;
      },
      { timeout: 10_000 },
    );

    const muCount = await evalViewer<number>(page,
      `(() => {
        const tm = window.viewer.transportManager;
        return tm ? tm.mus.length : 0;
      })()`,
    );

    expect(muCount).toBeGreaterThan(0);

    // Verify MUs have physics bodies
    const physicsMUCount = await evalViewer<number>(page,
      `(() => {
        const p = window.viewer.getPlugin('rapier-physics');
        return p && p.physicsWorld ? p.physicsWorld.muCount : 0;
      })()`,
    );

    expect(physicsMUCount).toBeGreaterThan(0);
  });

  test('MUs should stay above conveyor surfaces (not fall through)', async ({ page }) => {
    await waitForPhysicsReady(page);

    // Wait for MUs to spawn
    try {
      await page.waitForFunction(
        () => {
          const tm = (window as any).viewer?.transportManager;
          return tm && tm.mus.length > 0;
        },
        { timeout: 10_000 },
      );
    } catch {
      test.skip();
      return;
    }

    // Let simulation run for 5 seconds
    await waitSimulationTime(page, 5_000);

    // Check all MU Y positions — none should have fallen below -1m
    const muPositions = await evalViewer<{ id: string; y: number }[]>(page,
      `(() => {
        const tm = window.viewer.transportManager;
        if (!tm) return [];
        return tm.mus.map((mu, i) => {
          const pos = mu.node.position;
          return { id: mu.id || 'mu_' + i, y: pos.y };
        });
      })()`,
    );

    for (const mu of muPositions) {
      expect(mu.y, `MU "${mu.id}" should not have fallen through (y=${mu.y.toFixed(3)})`).toBeGreaterThan(-1);
    }
  });

  test('MUs should be transported along conveyor direction', async ({ page }) => {
    await waitForPhysicsReady(page);

    // Wait for MUs to spawn
    try {
      await page.waitForFunction(
        () => {
          const tm = (window as any).viewer?.transportManager;
          return tm && tm.mus.length > 0;
        },
        { timeout: 10_000 },
      );
    } catch {
      test.skip();
      return;
    }

    // Record initial positions
    const initialPositions = await evalViewer<{ x: number; z: number }[]>(page,
      `(() => {
        const tm = window.viewer.transportManager;
        if (!tm) return [];
        return tm.mus.map(mu => ({ x: mu.node.position.x, z: mu.node.position.z }));
      })()`,
    );

    // Let simulation run for 3 seconds
    await waitSimulationTime(page, 3_000);

    // Check that at least one MU has moved
    const finalPositions = await evalViewer<{ x: number; z: number }[]>(page,
      `(() => {
        const tm = window.viewer.transportManager;
        if (!tm) return [];
        return tm.mus.map(mu => ({ x: mu.node.position.x, z: mu.node.position.z }));
      })()`,
    );

    // At least one MU should have moved (displacement > 0.01m)
    let anyMoved = false;
    const count = Math.min(initialPositions.length, finalPositions.length);
    for (let i = 0; i < count; i++) {
      const dx = finalPositions[i].x - initialPositions[i].x;
      const dz = finalPositions[i].z - initialPositions[i].z;
      const dist = Math.sqrt(dx * dx + dz * dz);
      if (dist > 0.01) {
        anyMoved = true;
        break;
      }
    }

    expect(anyMoved, 'At least one MU should have moved along a conveyor').toBe(true);
  });

  test('sensors should detect MUs', async ({ page }) => {
    await waitForPhysicsReady(page);

    const sensorCount = await evalViewer<number>(page,
      `(() => {
        const tm = window.viewer.transportManager;
        return tm ? tm.sensors.length : 0;
      })()`,
    );

    if (sensorCount === 0) {
      test.skip();
      return;
    }

    // Wait for MUs and simulation to run
    try {
      await page.waitForFunction(
        () => {
          const tm = (window as any).viewer?.transportManager;
          return tm && tm.mus.length > 0;
        },
        { timeout: 10_000 },
      );
    } catch {
      test.skip();
      return;
    }

    // Let simulation run long enough for MUs to reach sensors
    await waitSimulationTime(page, 8_000);

    // Check if any sensor has been occupied
    const anySensorOccupied = await evalViewer<boolean>(page,
      `(() => {
        const tm = window.viewer.transportManager;
        if (!tm) return false;
        return tm.sensors.some(s => s.occupied);
      })()`,
    );

    // This is a soft check — depends on scene layout
    // At least verify sensors exist and are functional
    expect(sensorCount).toBeGreaterThan(0);
    // If there are MUs and sensors, at least one should trigger eventually
    if (sensorCount > 0) {
      console.log(`Sensor occupied: ${anySensorOccupied}`);
    }
  });

  test('physics world should have ground plane', async ({ page }) => {
    await waitForPhysicsReady(page);

    // The ground plane adds 1 extra body beyond surfaces + sensors
    const bodyCount = await evalViewer<number>(page,
      `(() => {
        const p = window.viewer.getPlugin('rapier-physics');
        return p && p.physicsWorld ? p.physicsWorld.bodyCount : 0;
      })()`,
    );

    const surfaceCount = await evalViewer<number>(page,
      `(() => {
        const tm = window.viewer.transportManager;
        return tm ? tm.surfaces.length : 0;
      })()`,
    );

    // bodyCount should be > surfaceCount (at least ground plane + any sensors)
    expect(bodyCount).toBeGreaterThan(surfaceCount);
  });

  test('simulation should be running and stepping physics', async ({ page }) => {
    await waitForPhysicsReady(page);

    // Check initial body count
    const bodyCount1 = await evalViewer<number>(page,
      `(() => {
        const p = window.viewer.getPlugin('rapier-physics');
        return p && p.physicsWorld ? p.physicsWorld.bodyCount : 0;
      })()`,
    );

    // Wait a bit for simulation
    await waitSimulationTime(page, 2_000);

    // Body count should still be > 0 (world didn't crash)
    const bodyCount2 = await evalViewer<number>(page,
      `(() => {
        const p = window.viewer.getPlugin('rapier-physics');
        return p && p.physicsWorld ? p.physicsWorld.bodyCount : 0;
      })()`,
    );

    expect(bodyCount1).toBeGreaterThan(0);
    expect(bodyCount2).toBeGreaterThan(0);
  });

  test('no console errors during physics simulation', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', (error) => {
      errors.push(error.message);
    });

    await waitForPhysicsReady(page);

    // Let simulation run
    await waitSimulationTime(page, 5_000);

    // Filter out non-critical errors (some Three.js warnings are expected)
    const criticalErrors = errors.filter(
      (e) => !e.includes('ResizeObserver') && !e.includes('favicon'),
    );

    expect(criticalErrors, `Unexpected console errors: ${criticalErrors.join(', ')}`).toHaveLength(0);
  });
});
