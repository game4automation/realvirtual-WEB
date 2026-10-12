// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * mu-load-seat.test.ts — plan-577 §9.1: seated loads (`MU.LoadSeatDepth`).
 *
 * A carrier may let a load sit up to its seat depth BELOW its collider top
 * (a part in a jig, a cap over a valve end). The depth is the carrier's,
 * limited to 80 % of its collider height; the load's bottom never lies below
 * the carrier's bottom; centre/footprint rules stay. Defaults keep plan-516.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { createElement } from 'react';
import { render, screen, cleanup, fireEvent } from '@testing-library/react';
import { BoxGeometry, Mesh, MeshBasicMaterial, MeshStandardMaterial, Object3D, Scene } from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { RVMovingUnit } from '../src/core/engine/rv-mu';
import { RVSource } from '../src/core/engine/rv-source';
import '../src/core/engine/rv-grip-target';
import {
  effectiveSeatDepth, readLoadSeatDepth, resolveLoads, restsOn, SEAT_DEPTH_MAX_RATIO,
} from '../src/core/engine/rv-mu-load';
import { loadSchemaFromSpec } from '../src/core/engine/rv-component-registry';
import {
  getConsumedFields, printParitySummary, resetParityValidator, validateExtras,
} from '../src/core/engine/rv-extras-validator';
import { ComponentSection } from '../src/core/hmi/rv-component-section';
import { createTestViewer, type TestViewerHandle } from './helpers/create-test-viewer';
import {
  PART, WT, classifiedScene, jigCell, muNode, muOf, palletRow, preplacedMU, withSeatDepth,
} from './_mu-preplaced-fixture';

const MM = 0.001;

let handle: TestViewerHandle | null = null;
afterEach(() => {
  cleanup();
  handle?.dispose(); handle = null;
});

/** A part of `PART` size whose bottom is `sinkMm` below the top of a WT at the origin. */
function wtWithPart(seatMm: number | null, sinkMm: number, partPos: [number, number] = [0, 0]) {
  const root = new Object3D();
  const wt = muNode('WT', WT, [0, 0, 0]);
  if (seatMm !== null) withSeatDepth(wt, seatMm);
  const part = muNode('Part', PART, [partPos[0], WT[1] - sinkMm * MM, partPos[1]]);
  root.add(wt, part);
  const { tm } = classifiedScene(root);
  tm.activatePreplaced();
  return { tm, wt: muOf(tm, wt), part: muOf(tm, part) };
}

describe('restsOn with a seat depth (plan-577 F3)', () => {
  it('a part 60 mm deep in a WT with seat 70 mm is its load; without a seat it stays free', () => {
    const seated = wtWithPart(70, 60);
    expect(seated.part.loadedOn).toBe(seated.wt);
    expect(seated.tm.mus).not.toContain(seated.part);

    const plain = wtWithPart(null, 60);
    expect(plain.part.loadedOn).toBeNull();
    expect(plain.tm.mus).toContain(plain.part);
  });

  it('the seat window is tolerance + depth: 74 mm inside, 76 mm outside (seat 70)', () => {
    expect(wtWithPart(70, 74).part.loadedOn).not.toBeNull();
    expect(wtWithPart(70, 76).part.loadedOn).toBeNull();
  });

  it('a load bottom below the carrier bottom is no load', () => {
    const root = new Object3D();
    const wt = withSeatDepth(muNode('WT', WT, [0, 0.05, 0]), 70);
    // A tall post standing through the WT: bottom 50 mm below the WT bottom.
    const post = muNode('Post', [0.02, 0.3, 0.02], [0, 0, 0]);
    root.add(wt, post);
    const { tm } = classifiedScene(root);
    tm.activatePreplaced();
    expect(muOf(tm, post).loadedOn).toBeNull();
    // Direct rule check: a box whose bottom lies below the carrier bottom never rests on it.
    const w = muOf(tm, wt);
    const p = muOf(tm, post);
    w.updateAABB(); p.updateAABB();
    expect(restsOn(p, w)).toBe(false);
  });

  it('a centre outside the carrier footprint is no load, even within the seat window', () => {
    // Part centre 10 mm outside the WT edge (x half = 85 mm).
    expect(wtWithPart(70, 30, [0.095, 0]).part.loadedOn).toBeNull();
    expect(wtWithPart(70, 30, [0.08, 0]).part.loadedOn).not.toBeNull();
  });

  it('cap −36 mm on valve (seat 40) in WT (seat 70): cap → valve, valve → WT (no stealing)', () => {
    const { root, wts, valves, caps } = jigCell(1);
    const { tm } = classifiedScene(root);
    tm.activatePreplaced();
    const wt = muOf(tm, wts[0]);
    const valve = muOf(tm, valves[0]);
    const cap = muOf(tm, caps[0]!);
    expect(valve.loadedOn).toBe(wt);
    expect(cap.loadedOn).toBe(valve);
    expect(tm.mus).toEqual([wt]);
    expect(cap.node.parent).toBe(valve.node);
    // The cap is NOT inside the WT's window (its bottom is 13 mm above the WT top).
    expect(restsOn(cap, wt)).toBe(false);
  });

  it('the seat depth is limited to 80 % of the carrier height; negative / NaN / garbage → 0', () => {
    // WT 93.8 mm high → max 75.04 mm; seat 200 → window 80.04 mm.
    expect(wtWithPart(200, 79).part.loadedOn).not.toBeNull();
    expect(wtWithPart(200, 82).part.loadedOn).toBeNull();
    const { wt } = wtWithPart(200, 0);
    wt.updateAABB();
    expect(effectiveSeatDepth(wt)).toBeCloseTo(SEAT_DEPTH_MAX_RATIO * WT[1], 9);

    const n = (v: unknown) => readLoadSeatDepth(withSeatDepth(muNode('X', PART), v));
    expect(n(40)).toBeCloseTo(0.04, 12);
    expect(n('40')).toBeCloseTo(0.04, 12);
    expect(n(-5)).toBe(0);
    expect(n(Number.NaN)).toBe(0);
    expect(n('abc')).toBe(0);
    expect(n(null)).toBe(0);
    expect(n(Infinity)).toBe(0);
    expect(readLoadSeatDepth(muNode('Y', PART))).toBe(0);
    expect(wtWithPart(-30, 60).part.loadedOn).toBeNull();
  });
});

describe('Source clones carry the template seat depth (plan-577 F2, SOL R2 #3)', () => {
  it('a clone spawned through the real Source path has loadSeatDepth of the template', () => {
    const sceneRoot = new Object3D();
    const sourceNode = new Object3D();
    sourceNode.name = 'JigSource';
    sceneRoot.add(sourceNode);
    // Two meshes / materials → clone path (instanced MUs never carry loads).
    const template = new Object3D();
    template.name = 'JigTemplate';
    template.add(new Mesh(new BoxGeometry(0.17, 0.09, 0.17), new MeshBasicMaterial()));
    template.add(new Mesh(new BoxGeometry(0.05, 0.05, 0.05), new MeshStandardMaterial()));
    template.userData.realvirtual = { MU: { LoadSeatDepth: 70 } };
    sceneRoot.add(template);
    const source = new RVSource(sourceNode);
    source.muName = template.name;
    source.sourceIsTemplate = false;
    source.spawnParent = sceneRoot;
    source.spawnMode = 'Interval';
    source.spawnInterval = 0.01;
    source.setTemplate(template);

    const mu = source.update(1, true) as RVMovingUnit;
    expect(mu).toBeInstanceOf(RVMovingUnit);
    expect(mu.node.userData.realvirtual).toBeUndefined(); // extras stripped from the clone …
    expect(mu.loadSeatDepth).toBeCloseTo(0.07, 12);     // … the seat depth handed over
  });
});

describe('authoring: field visible, effective at the next reset / load (plan-577 F2, SOL #3 / R2 #4 / R2 #5)', () => {
  it('an inspector edit changes nothing until the reset; after the reset the load exists (no reload)', () => {
    const root = new Object3D();
    const wtNode = muNode('WT', WT, [0, 0, 0]); // MU: {} — no seat yet
    const partNode = muNode('Part', PART, [0, WT[1] - 0.06, 0]);
    root.add(wtNode, partNode);
    const { tm } = classifiedScene(root);
    tm.activatePreplaced();
    const wt = muOf(tm, wtNode);
    const part = muOf(tm, partNode);
    expect(part.loadedOn).toBeNull();

    // What the inspector edit writes (overlay → userData of the live node).
    (wtNode.userData.realvirtual as { MU: Record<string, unknown> }).MU.LoadSeatDepth = 70;
    tm.update(1 / 60);
    expect(part.loadedOn).toBeNull(); // no live re-hang during the simulation
    expect(wt.loadSeatDepth).toBe(0);

    tm.reset();
    tm.activatePreplaced();
    expect(wt.loadSeatDepth).toBeCloseTo(0.07, 12);
    expect(part.loadedOn).toBe(wt);
  });

  it('existing MU and GripTarget extras without the new keys show both fields with their default', () => {
    const edits: [string, unknown][] = [];
    const section = (componentType: string, data: Record<string, unknown>) => render(createElement(ComponentSection, {
      nodePath: `Cell/${componentType}`,
      componentType,
      data,
      overriddenFields: new Set<string>(),
      consumedOnly: false,
      onFieldEdit: (f: string, v: unknown) => { edits.push([f, v]); },
      onFieldReset: () => {},
      onResetComponent: () => {},
      viewer: null,
      signalStore: null,
    }));

    section('MU', {});
    expect(screen.getByText('LoadSeatDepth')).toBeTruthy();
    const input = document.querySelector('input') as HTMLInputElement | null;
    expect(input, 'LoadSeatDepth has an editor').not.toBeNull();
    expect(Number(input!.value)).toBe(0);
    fireEvent.change(input!, { target: { value: '70' } });
    fireEvent.blur(input!);
    fireEvent.keyDown(input!, { key: 'Enter' });
    expect(edits.some(([f, v]) => f === 'LoadSeatDepth' && Number(v) === 70)).toBe(true);
    cleanup();

    section('GripTarget', { AlignPosition: true, AlignRotation: true });
    expect(screen.getByText('LoadOnCarrier')).toBeTruthy();
  });

  it('round trip: empty MU extra → LoadSeatDepth set → saved → reloaded → the load exists', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    const build = async (seat: unknown | null): Promise<ArrayBuffer> => {
      const src = new Scene();
      const model = new Object3D();
      model.name = 'Cell';
      src.add(model);
      const wt = muNode('WT', WT, [0, 0, 0]);
      if (seat !== null) withSeatDepth(wt, seat);
      model.add(wt, muNode('Part', PART, [0, WT[1] - 0.06, 0]));
      return (await new GLTFExporter().parseAsync(src, { binary: true })) as ArrayBuffer;
    };
    handle = await createTestViewer('webgl');
    const { viewer } = handle;
    const byName = (name: string) => viewer.transportManager!.preplacedMUs.find((m) => m.node.name === name)!;

    await viewer.loadModel('seat-before.glb', { data: await build(null) });
    expect(byName('Part').loadedOn).toBeNull();
    // The value the inspector edit stores — a number from the field editor.
    await viewer.loadModel('seat-after.glb', { data: await build(70) });
    expect(byName('WT').loadSeatDepth).toBeCloseTo(0.07, 12);
    expect(byName('Part').loadedOn).toBe(byName('WT'));
  }, 120_000);
});

describe('schema (plan-577 F1)', () => {
  it('MU.LoadSeatDepth: spec default 0 mm, consumed, not reported as unknown', () => {
    expect(loadSchemaFromSpec('MU').LoadSeatDepth).toEqual({ type: 'number', default: 0, unit: 'mm' });
    expect(loadSchemaFromSpec('GripTarget').LoadOnCarrier).toEqual({ type: 'boolean', default: false });
    expect(getConsumedFields('MU')).toContain('LoadSeatDepth');
    expect(getConsumedFields('GripTarget')).toContain('LoadOnCarrier');

    resetParityValidator();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    validateExtras('MU', { LoadSeatDepth: 70 });
    validateExtras('GripTarget', { AlignPosition: true, AlignRotation: true, LoadOnCarrier: true });
    printParitySummary();
    const text = warn.mock.calls.map((c) => String(c[0])).join('\n');
    expect(text).not.toContain('LoadSeatDepth');
    expect(text).not.toContain('LoadOnCarrier');
    warn.mockRestore();
    resetParityValidator();
  });
});

describe('performance (plan-577 NFR)', () => {
  /** Fastest of `runs` resolveLoads passes over fresh MU sets (ms). */
  function measure(make: () => RVMovingUnit[], runs = 5): number {
    let best = Infinity;
    for (let r = 0; r < runs; r++) {
      const mus = make();
      const t0 = performance.now();
      resolveLoads(mus, null);
      best = Math.min(best, performance.now() - t0);
    }
    return best;
  }
  function rowMUs(seatMm: number | null): RVMovingUnit[] {
    const { root, pallets } = palletRow(250, 3);
    if (seatMm !== null) for (const p of pallets) withSeatDepth(p, seatMm);
    root.updateMatrixWorld(true);
    return root.children.map((c) => {
      const mu = preplacedMU(c);
      mu.loadSeatDepth = readLoadSeatDepth(c);
      return mu;
    });
  }
  /** 1000 equal MUs at ONE height, side by side (no loads, every top in every window). */
  function flatMUs(seatMm: number | null): RVMovingUnit[] {
    const root = new Object3D();
    for (let i = 0; i < 1000; i++) {
      const n = muNode(`F.${i}`, PART, [(i % 40) * 0.2, 0, Math.floor(i / 40) * 0.2]);
      if (seatMm !== null) withSeatDepth(n, seatMm);
      root.add(n);
    }
    root.updateMatrixWorld(true);
    return root.children.map((c) => {
      const mu = preplacedMU(c);
      mu.loadSeatDepth = readLoadSeatDepth(c);
      return mu;
    });
  }

  it('1000 MUs with a seat depth and 1000 at one height stay < 2000 ms and ≤ 2× the plain run', () => {
    // Sanity: the seat run still resolves the same 750 loads.
    const check = rowMUs(70);
    expect(resolveLoads(check, null).length).toBe(250);

    const refRow = measure(() => rowMUs(null));
    const seatRow = measure(() => rowMUs(70));
    const refFlat = measure(() => flatMUs(null));
    // 200 mm on an 80 mm part: limited to 64 mm, so the window never reaches the
    // neighbours' tops (window < height whenever 20 % of the height > 5 mm).
    const seatFlat = measure(() => flatMUs(200));
    console.log(`[plan-577] resolveLoads 1000 row: plain ${refRow.toFixed(2)} ms, seat ${seatRow.toFixed(2)} ms; `
      + `1000 flat: plain ${refFlat.toFixed(2)} ms, seat ${seatFlat.toFixed(2)} ms`);
    for (const ms of [seatRow, seatFlat]) expect(ms).toBeLessThan(2000);
    // ≤ 2× the reference; 2 ms absolute slack for timer granularity on sub-10 ms runs.
    expect(seatRow).toBeLessThanOrEqual(2 * refRow + 2);
    expect(seatFlat).toBeLessThanOrEqual(2 * refFlat + 2);
  });
});
