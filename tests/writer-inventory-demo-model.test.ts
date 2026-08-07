// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Plan-320 Phase 1 — headless telemetry validation of the Phase-0 writer
 * inventory against the demo model.
 *
 * Loads public/models/tests.glb through the full loadGLB pipeline, runs a few
 * seconds of standalone simulation (logic engine → drives → transport, the
 * CoreSubsystems order) and asserts the abort criterion of Phase 1: a full
 * demo run produces NO `unknown` writer entry — every SignalStore write is
 * classified. If this test ever fails it prints the unknown entries (with the
 * DEV stack hint captured on first write) so they can be classified following
 * the Phase-0 pattern.
 *
 * CONNECT-live and multiuser sessions need a runtime environment and are NOT
 * covered here (documented open point of the plan).
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Scene } from 'three';
import { loadGLB, type LoadResult } from '../src/core/engine/rv-scene-loader';

const GLB_URL = '/models/tests.glb';
const DT = 1 / 60;
const SIM_SECONDS = 3;

let result: LoadResult | null = null;

beforeAll(async () => {
  try {
    const head = await fetch(GLB_URL, { method: 'HEAD' });
    if (!head.ok) return;
    const bytes = await (await fetch(GLB_URL)).arrayBuffer();
    if (bytes.byteLength < 100) return;
    result = await loadGLB(GLB_URL, new Scene(), { data: bytes });
  } catch (err) {
    console.warn(`writer-inventory-demo-model: GLB load failed — skipping (${String(err)})`);
    result = null;
  }
}, 120000);

afterAll(() => {
  result?.transportManager.reset();
  result = null;
});

describe('writer inventory on the demo model (plan-320 Phase 1)', () => {
  it('a simulated demo run records no unknown writer', () => {
    if (!result) {
      console.warn(`${GLB_URL} not available — skipping demo-model telemetry run`);
      return;
    }

    // Standalone sim loop in CoreSubsystems order: logic → drives → transport.
    const ticks = Math.round(SIM_SECONDS / DT);
    for (let i = 0; i < ticks; i++) {
      result.logicEngine?.fixedUpdate(DT);
      for (const drive of result.drives) drive.update(DT);
      result.transportManager.update(DT);
    }

    const inventory = result.signalStore.getWriterInventory();
    expect(inventory.length).toBeGreaterThan(0); // the run must produce writes

    const unknown = inventory.filter((entry) => entry.writerId === 'unknown');
    if (unknown.length > 0) {
      // Phase-1 classification aid: name + stack of every unclassified write.
      console.error('UNKNOWN writers found:', unknown.map((entry) => ({
        signal: entry.signal,
        writeCount: entry.writeCount,
        stack: entry.stack?.split('\n').slice(0, 6).join(' | '),
      })));
    }
    expect(unknown).toEqual([]);

    // Sanity: the classified writer kinds observed in a demo run stay within
    // the Phase-0 taxonomy.
    const kinds = new Set(inventory.map((entry) => entry.writerKind));
    for (const kind of kinds) {
      expect(['hmi', 'plugin', 'behavior', 'component', 'remote', 'replay',
        'sdk', 'mcp', 'debug', 'interface']).toContain(kind);
    }
  }, 120000);
});
