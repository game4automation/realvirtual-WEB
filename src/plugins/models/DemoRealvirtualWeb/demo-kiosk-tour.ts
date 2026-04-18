// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Kiosk Mode tour for the DemoRealvirtualWeb demo scene.
 *
 * Code-first async function — no JSON schema. Uses TourApi primitives from
 * `KioskPlugin`. Loops forever (`while (!signal.aborted)`) and includes
 * conditionals / shared state via closures.
 *
 * Camera positions + highlight node paths use best-effort defaults. Operators
 * running this on a modified demo model should adjust coordinates to match
 * their scene layout.
 */

import type { TourFn } from '../../kiosk-tour-types';

export const demoKioskTour: TourFn = async (t, signal) => {
  let cycle = 0;

  while (!signal.aborted) {
    // ───── Step 1: Overview ─────
    t.instruction('Welcome to the realvirtual Demo', { style: 'banner' });
    await t.camera({ position: [0, 5, 12], target: [0, 0, 0], duration: 2.5 });
    await t.dwell(3);
    if (signal.aborted) return;

    // ───── Step 2: Transport close-up ─────
    t.instruction('Transport surfaces move parts between stations', { style: 'banner' });
    await t.camera({ position: [2, 2, 5], target: [1, 0, 0], duration: 2 });
    await t.dwell(3);
    if (signal.aborted) return;

    // ───── Step 3: Failure demo (callout on node + side-panel message) ─────
    t.instruction(
      '⚠ Motor overload on Axis 3',
      { anchor: { kind: 'canvas-center' }, style: 'warning' },
    );
    t.message({
      title: 'Drive Overload',
      subtitle: 'Axis3 current: 142%',
      severity: 'error',
      componentPath: 'A3',
      autoClearAfterMs: 8000,
    });
    await t.camera({ position: [2.5, 1.5, 3.5], target: [1, 0.5, 0], duration: 2 });
    await t.dwell(5);
    if (signal.aborted) return;

    // ───── Step 4: PDF maintenance manual ─────
    t.instruction('Linked service documents open inline', { style: 'banner' });
    try {
      t.pdf('Maintenance Manual', {
        type: 'url',
        url: `${import.meta.env.BASE_URL ?? '/'}pdf/demo-manual.pdf`,
      });
    } catch { /* ignore — PDF asset may not exist in all deployments */ }
    await t.dwell(6);
    t.closePdf();
    if (signal.aborted) return;

    // ───── Step 5: Hierarchy filter ─────
    t.instruction('Filter the hierarchy by component type', { style: 'banner' });
    t.filter({ typeFilter: 'drives' });
    await t.dwell(4);
    t.closeFilter();
    if (signal.aborted) return;

    // ───── Step 6: Inspector reveal ─────
    t.instruction('Inspect any component live — properties and signals', { style: 'banner' });
    t.focus('Robot/A1');
    await t.dwell(4);
    t.clearFocus();
    if (signal.aborted) return;

    // ───── Step 7: OEE chart ─────
    t.instruction('KPI dashboards update in real time', { style: 'banner' });
    t.chart('oee');
    await t.dwell(6);
    if (signal.aborted) return;

    // ───── Step 8: Parts chart ─────
    t.chart('parts');
    await t.dwell(4);
    t.closeChart();
    if (signal.aborted) return;

    // ───── Step 9: Robot pick & place ─────
    t.instruction('Robot pick & place sequence', { style: 'banner' });
    await t.camera({ position: [1.5, 2, 4], target: [1, 0.5, 0], duration: 2 });
    t.highlight(['Robot']);
    await t.dwell(5);
    t.clearHighlights();
    if (signal.aborted) return;

    // ───── Step 10: Full plant overview ─────
    t.instruction('Full plant overview', { style: 'banner' });
    await t.camera({ position: [0, 8, 15], target: [0, 0, 0], duration: 3 });
    await t.dwell(4);
    if (signal.aborted) return;

    // ───── Step 11: Touch-to-interact hint at edge (loops forever) ─────
    t.instruction(
      'Touch anywhere to explore on your own',
      {
        style: 'toast',
        anchor: { kind: 'edge', edge: 'bottom' },
        autoClearAfterMs: 3000,
      },
    );
    await t.dwell(2);

    // ───── Cycle end ─────
    cycle++;
    t.cycleEnd();

    // After first cycle, reduce per-step dwell slightly to keep things fresh
    // (demonstrates closure-based shared state between iterations)
    if (cycle > 1) {
      // noop — kept here as an example anchor point for per-cycle variation
    }
  }
};
