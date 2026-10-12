// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * ribbon-tension-overlay.test.ts — the readout overlay (plan-471 E7).
 *
 * The overlay is driven through a STUB gizmo host rather than a real
 * `GizmoOverlayManager`: what has to be true of it is a lifecycle and a string —
 * that nothing is created until it is asked for, that a label says the four
 * things the plan names (N/m, PLI, strain, trend), that an unchanged label is
 * not re-rasterised, and that `dispose()` leaves nothing behind. A real gizmo
 * manager would add a renderer to all of that and test none of it.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { Vector3 } from 'three';
import { ribbonHarness, type RibbonHarness, type RollerSpec } from './ribbon-fixture';

const DT = 1 / 60;

const TENSION = {
  TensileStiffnessNPerMmWidth: 10,
  RibbonWidthMm: 500,
  TargetTensionNPerM: 100,
  MinStrainPercent: 0,
  MaxStrainPercent: 2,
  ToleranceBandPercent: 10,
  BreakForceNPer50mm: 35,
} as const;

const BASE_SPEED = 800;

const LAYOUT: RollerSpec[] = [
  { name: 'R0', xMm: 0, yMm: 0, radiusMm: 60, driven: true },
  { name: 'N1', xMm: 800, yMm: 0, radiusMm: 60, driven: true },
  { name: 'N2', xMm: 1600, yMm: 0, radiusMm: 60, driven: true },
  { name: 'D', xMm: 2400, yMm: 0, radiusMm: 60, dancer: true },
  { name: 'N3', xMm: 3200, yMm: 0, radiusMm: 60, driven: true },
  { name: 'R4', xMm: 4000, yMm: 0, radiusMm: 60 },
];

/** The smallest thing that satisfies every call the overlay makes. */
interface StubGizmo {
  id: string;
  /** A real position: the overlay MOVES a text gizmo onto its anchor per tick. */
  root: { position: Vector3 };
  opts: Record<string, unknown>;
  updates: number;
  disposed: boolean;
  visible: boolean;
  update(next: Record<string, unknown>): void;
  setVisible(visible: boolean): void;
  dispose(): void;
}

function stubGizmos(): {
  manager: unknown;
  live: StubGizmo[];
  created: StubGizmo[];
  linkLineUpdates: number;
} {
  const created: StubGizmo[] = [];
  let linkLineUpdates = 0;
  const manager = {
    create(_node: unknown, opts: Record<string, unknown>): StubGizmo {
      const gizmo = {
        id: `g${created.length}`,
        root: { position: new Vector3() },
        opts: { ...opts },
        updates: 0,
        disposed: false as boolean,
        visible: true as boolean,
        update(next: Record<string, unknown>) {
          gizmo.updates++;
          Object.assign(gizmo.opts, next);
        },
        // The overlay HIDES the half of the dancer gizmo that is switched off
        // and disposes only when nothing wants it any more — so visibility is
        // part of what a test has to be able to see.
        setVisible(visible: boolean) { gizmo.visible = visible; },
        dispose() { gizmo.disposed = true; },
      } satisfies StubGizmo;
      created.push(gizmo);
      return gizmo;
    },
    updateLinkLine(): void { linkLineUpdates++; },
  };
  return {
    manager,
    created,
    get live() { return created.filter((g) => !g.disposed); },
    get linkLineUpdates() { return linkLineUpdates; },
  } as ReturnType<typeof stubGizmos>;
}

type Path = ReturnType<RibbonHarness['buildPath']>;

function machine(overrides: Record<string, unknown> = {}): {
  h: RibbonHarness; path: Path; gizmos: ReturnType<typeof stubGizmos>;
} {
  const h = ribbonHarness(LAYOUT.map((r) => ({ ...r })));
  const gizmos = stubGizmos();
  h.useGizmoManager(gizmos.manager);
  const path = h.buildPath({ ...TENSION, ...overrides });
  h.drive.jog(BASE_SPEED);
  for (const name of ['R0', 'N1', 'N2', 'N3']) h.drive.jogRoller(name, BASE_SPEED);
  h.step(DT);
  return { h, path, gizmos };
}

function run(h: RibbonHarness, seconds: number): void {
  const ticks = Math.round(seconds / DT);
  for (let i = 0; i < ticks; i++) h.step(DT);
}

/** Every text a label gizmo currently carries. */
function labels(gizmos: ReturnType<typeof stubGizmos>): string[] {
  return gizmos.live
    .filter((g) => g.opts.shape === 'text' && g.visible)
    .map((g) => String(g.opts.text ?? ''));
}

let warn: ReturnType<typeof vi.spyOn>;
beforeEach(() => { warn = vi.spyOn(console, 'warn').mockImplementation(() => {}); });
afterEach(() => { warn.mockRestore(); });

describe('the tension overlay', () => {
  it('creates NOTHING while ShowTensionLabels is off', () => {
    const { h, path, gizmos } = machine({ ShowTensionLabels: false });
    run(h, 1);
    expect(path.tensionOverlay).toBeNull();
    expect(gizmos.created).toHaveLength(0);
  });

  it('creates nothing when tension itself is off, labels or not', () => {
    const { h, path, gizmos } = machine({
      ShowTensionLabels: true, TensileStiffnessNPerMmWidth: 0,
    });
    run(h, 1);
    expect(path.tensionOverlay).toBeNull();
    expect(gizmos.created).toHaveLength(0);
  });

  it('draws one label per zone', () => {
    const { h, path, gizmos } = machine({ ShowTensionLabels: true });
    run(h, 1);
    expect(path.tensionOverlay).not.toBeNull();
    expect(path.tensionOverlay!.isShown).toBe(true);
    expect(path.tensionOverlay!.labelCount).toBe(path.zones.length);
    expect(labels(gizmos)).toHaveLength(path.zones.length);
  });

  it('says N/m, PLI, strain and a trend arrow', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: true });
    run(h, 2);
    const text = labels(gizmos)[0];
    // `100 N/m | 0.57 PLI | eps 1.00 % -`
    expect(text).toMatch(/^\d+ N\/m \| \d+\.\d\d PLI \| eps -?\d+\.\d\d % [\^v-]/);
    expect(text).toContain('100 N/m');
    expect(text).toContain((100 / 175.1).toFixed(2));
  });

  it('shows a falling arrow while the strain is falling', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: true });
    run(h, 1);
    h.drive.jogRoller('N2', 700);
    run(h, 1);
    // Zone 1 (N1 -> N2) is the one being pulled down.
    const text = labels(gizmos)[1];
    expect(text).toContain(' v');
  });

  it('does NOT re-rasterise a label whose text did not change', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: true });
    run(h, 2);
    const label = gizmos.live.filter((g) => g.opts.shape === 'text')[0];
    const before = label.updates;
    run(h, 1);
    // At a steady tension the string is the same every tick — the expensive
    // part of a text gizmo is its texture, and it must not be redrawn 60 times
    // a second for a number that did not move.
    expect(label.updates - before).toBeLessThanOrEqual(2);
  });

  it('marks a torn zone and an estimated sag', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: true });
    h.drive.jogRoller('N2', 2000);
    run(h, 6);
    expect(labels(gizmos).some((t) => t.includes('TORN'))).toBe(true);
  });

  it('draws no dancer gizmo of its own — the dancer owns those', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: true });
    h.dancer('D').LoadN = 200;
    run(h, 1);
    // Zone labels and nothing else: the track and the carriage readout moved
    // into RVRibbonDancer, where an unloaded or tension-less dancer can have
    // them too.
    expect(gizmos.live.some((g) => g.opts.shape === 'link-line')).toBe(false);
    expect(gizmos.live.every((g) => g.opts.shape === 'text')).toBe(true);
  });

  it('takes everything down when the labels are switched off again', () => {
    const { h, path, gizmos } = machine({ ShowTensionLabels: true });
    h.dancer('D').LoadN = 100;
    run(h, 1);
    expect(gizmos.live.length).toBeGreaterThan(0);

    path.ShowTensionLabels = false;
    run(h, 0.1);
    expect(path.tensionOverlay!.isShown).toBe(false);
    expect(path.tensionOverlay!.labelCount).toBe(0);
    expect(gizmos.live).toHaveLength(0);
  });

  it('leaves nothing behind after dispose', () => {
    const { h, path, gizmos } = machine({ ShowTensionLabels: true });
    h.dancer('D').LoadN = 100;
    run(h, 1);
    expect(gizmos.live.length).toBeGreaterThan(0);
    path.dispose();
    expect(gizmos.live).toHaveLength(0);
    expect(gizmos.created.every((g) => g.disposed)).toBe(true);
    expect(path.tensionOverlay).toBeNull();
  });
});

/**
 * `RibbonDancer.ShowTravel` — the dancer's TRACK, switched separately from the
 * numbers.
 *
 * The split exists because the two answer different questions. The labels say
 * "at what tension", which an operator turns off once they have read it; the
 * track says "how much store is left", which is a property of the machine and
 * has to survive a screenshot with every readout hidden.
 */
describe('the dancer travel track', () => {
  /** Every gizmo of the track — the bar, the two end stops, the carriage. */
  function trackShapes(gizmos: ReturnType<typeof stubGizmos>): string[] {
    return gizmos.live
      .filter((g) => g.visible)
      .map((g) => String(g.opts.shape))
      .filter((s) => s === 'link-line' || s === 'sprite');
  }

  it('draws the track with the values off, and builds no overlay for it', () => {
    const { h, path, gizmos } = machine({ ShowTensionLabels: false });
    h.dancer('D').ShowTravel = true;
    run(h, 1);
    expect(trackShapes(gizmos)).toHaveLength(4);
    expect(labels(gizmos).filter((t) => t.length > 0)).toHaveLength(0);
    // The dancer needs no RibbonPath overlay to draw itself.
    expect(path.tensionOverlay).toBeNull();
  });

  it('draws it for an UNLOADED dancer, which imposes no tension at all', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: false });
    h.dancer('D').LoadN = 0;
    h.dancer('D').ShowTravel = true;
    run(h, 1);
    expect(trackShapes(gizmos)).toHaveLength(4);
  });

  it('draws it with tension switched off entirely', () => {
    const { h, gizmos } = machine({
      ShowTensionLabels: false, TensileStiffnessNPerMmWidth: 0,
    });
    h.dancer('D').ShowTravel = true;
    run(h, 1);
    expect(trackShapes(gizmos)).toHaveLength(4);
  });

  it('switching the values off keeps the track and drops only the numbers', () => {
    const { h, path, gizmos } = machine({ ShowTensionLabels: true });
    h.dancer('D').LoadN = 100;
    h.dancer('D').ShowTravel = true;
    h.dancer('D').ShowValues = true;
    run(h, 1);
    expect(labels(gizmos).some((t) => t.includes('N load'))).toBe(true);

    // One operator switch, two components — exactly what the demo panel does.
    path.ShowTensionLabels = false;
    h.dancer('D').ShowValues = false;
    run(h, 0.2);
    expect(trackShapes(gizmos)).toHaveLength(4);
    expect(labels(gizmos).filter((t) => t.length > 0)).toHaveLength(0);
  });

  it('names the dancer in its readout, so two carriages are tellable apart', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: false });
    h.dancer('D').LoadN = 100;
    h.dancer('D').ShowValues = true;
    run(h, 1);
    expect(labels(gizmos).some((t) => t.startsWith('D  ') && t.includes('100 N load'))).toBe(true);
  });

  it('says nothing while the carriage is unloaded', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: false });
    h.dancer('D').LoadN = 0;
    h.dancer('D').ShowValues = true;
    run(h, 1);
    expect(labels(gizmos).filter((t) => t.length > 0)).toHaveLength(0);
  });

  it('takes the track down again when ShowTravel goes false', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: false });
    h.dancer('D').ShowTravel = true;
    run(h, 1);
    expect(gizmos.live.length).toBeGreaterThan(0);
    h.dancer('D').ShowTravel = false;
    run(h, 0.2);
    expect(gizmos.live).toHaveLength(0);
  });

  it('colours the stop the carriage has REACHED, so "out of travel" is readable', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: false });
    h.dancer('D').ShowTravel = true;
    run(h, 0.5);
    const stops = () => gizmos.live.filter((g) => g.opts.kind === 'dancer-stop');
    const carriage = () => gizmos.live.find((g) => g.opts.kind === 'dancer-position')!;
    expect(stops().every((g) => g.opts.color === 0x8a8f98)).toBe(true);
    expect(carriage().opts.color).toBe(0x4fc3f7);

    // Empty the store: the carriage runs onto its lower stop.
    h.drive.jogRoller('N3', 1400);
    run(h, 3);
    expect(h.dancer('D').atMin).toBe(true);
    expect(stops().some((g) => g.opts.color === 0xff9100)).toBe(true);
    expect(carriage().opts.color).toBe(0xff9100);
  });
});

/**
 * The state WORD — over / under / torn said in letters, not only in a colour.
 *
 * Two reasons it is not just decoration: `over` and `broken` share the magenta
 * alarm tint, so nothing else on screen tells an overstretched web from a torn
 * one; and a colour cannot be read out of a screenshot by anyone who was not
 * told the palette first.
 */
describe('the zone state word', () => {
  it('says nothing at all while the web is in its band', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: true });
    run(h, 2);
    const text = labels(gizmos)[0];
    expect(text).toMatch(/eps -?\d+\.\d\d % [\^v-]\s*$/);
    expect(text).not.toMatch(/LOW|HIGH|SLACK|OVERSTRETCHED|TORN/);
  });

  it('names a zone that is over the band but still usable', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: true });
    run(h, 1);
    h.drive.jogRoller('N2', 804);
    run(h, 2);
    expect(labels(gizmos).some((t) => t.includes('HIGH'))).toBe(true);
  });

  it('names a slack zone and an overstretched one', () => {
    const slack = machine({ ShowTensionLabels: true });
    run(slack.h, 1);
    slack.h.drive.jogRoller('N2', 600);
    run(slack.h, 2);
    expect(labels(slack.gizmos).some((t) => t.includes('SLACK'))).toBe(true);

    const over = machine({ ShowTensionLabels: true });
    run(over.h, 1);
    over.h.drive.jogRoller('N2', 820);
    run(over.h, 3);
    const texts = labels(over.gizmos);
    expect(texts.some((t) => t.includes('OVERSTRETCHED') || t.includes('TORN'))).toBe(true);
  });

  it('tells TORN from OVERSTRETCHED, which the tint cannot', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: true });
    h.drive.jogRoller('N2', 2000);
    run(h, 6);
    expect(labels(gizmos).some((t) => t.includes('TORN'))).toBe(true);
    expect(labels(gizmos).some((t) => t.includes('OVERSTRETCHED') && t.includes('TORN'))).toBe(false);
  });

  it('hides diagnostic text on a torn web without clearing the fault', () => {
    const { h, path, gizmos } = machine({ ShowTensionLabels: true });
    h.drive.jogRoller('N2', 2000);
    run(h, 6);

    path.ShowTensionLabels = false;
    run(h, 0.2);
    const remaining = labels(gizmos).filter((t) => t.length > 0);
    expect(remaining).toHaveLength(0);
    expect(path.tensionOverlay!.isShown).toBe(false);
    expect(path.zones.some((zone) => zone.broken)).toBe(true);
  });

  it('does NOT keep a LOW / HIGH deviation up — that one is a readout', () => {
    const { h, path, gizmos } = machine({ ShowTensionLabels: true });
    run(h, 1);
    h.drive.jogRoller('N2', 804);
    run(h, 2);
    expect(labels(gizmos).some((t) => t.includes('HIGH'))).toBe(true);

    path.ShowTensionLabels = false;
    run(h, 0.2);
    expect(labels(gizmos).filter((t) => t.length > 0)).toHaveLength(0);
    expect(path.tensionOverlay!.isShown).toBe(false);
  });
});

/**
 * Label lanes — two strips must not print their readouts on the same pixels.
 *
 * The slitter's strips run a few hundred millimetres apart along the ROLLER
 * axis. Seen from anywhere near that axis they project onto each other, so two
 * labels reading the same numbers land on the same spot and the readout becomes
 * an unreadable pile. Spreading them along the WEB is what separates them.
 */
describe('sibling strips', () => {
  /** The anchor positions of one path's zone labels. */
  function anchorsOf(path: { node: { children: { name: string; position: { x: number; y: number; z: number } }[] } }) {
    return path.node.children
      .filter((c) => c.name === '__rvTensionLabel')
      .map((c) => ({ x: c.position.x, y: c.position.y, z: c.position.z }));
  }

  it('hang their labels at different points along the web', () => {
    const h = ribbonHarness(LAYOUT.map((r) => ({ ...r })));
    h.useGizmoManager(stubGizmos().manager);
    const a = h.buildPath({ ...TENSION, ShowTensionLabels: true });
    const b = h.addPath('Strip_B', LAYOUT.map((r) => r.name), { ...TENSION, ShowTensionLabels: true });
    h.drive.jog(BASE_SPEED);
    for (const name of ['R0', 'N1', 'N2', 'N3']) h.drive.jogRoller(name, BASE_SPEED);
    run(h, 1);

    // Same group, so they were given lanes 0 and 1 of 2.
    expect([a.labelLane, b.labelLane].sort()).toEqual([0, 1]);
    expect(a.labelLaneCount).toBe(2);

    const pa = anchorsOf(a);
    const pb = anchorsOf(b);
    expect(pa.length).toBeGreaterThan(0);
    expect(pa).toHaveLength(pb.length);
    // Every zone's two labels sit a real distance apart along the path.
    for (let k = 0; k < pa.length; k++) {
      const gap = Math.hypot(pa[k].x - pb[k].x, pa[k].y - pb[k].y, pa[k].z - pb[k].z);
      expect(gap, `zone ${k} labels are ${gap.toFixed(4)} m apart`).toBeGreaterThan(0.05);
    }
  });

  it('a lone strip keeps the zone MIDPOINT it always used', () => {
    const { h, path } = machine({ ShowTensionLabels: true });
    run(h, 1);
    expect(path.labelLane).toBe(0);
    expect(path.labelLaneCount).toBe(1);
    // (lane + 1) / (lanes + 1) = 1/2 — the midpoint, bit for bit.
    const zone = path.zones[0];
    const middle = Math.round(
      zone.colorFromSample + (zone.colorToSample - zone.colorFromSample) * 0.5,
    );
    const buffer = path.sampleBuffer;
    const anchor = path.node.children.find((c) => c.name === '__rvTensionLabel')!;
    // Millimetres in the sample buffer, metres in the scene.
    expect(anchor.position.x).toBeCloseTo(buffer[middle * 9] / 1000, 6);
  });
});

/**
 * A label has to be WHERE the thing it describes is.
 *
 * `GizmoOverlayManager` places a `text` gizmo once, at creation, from the
 * attachment node's world bounds — it does not honour `attachToNode` for text.
 * For a static label on a machine part that is correct; for a readout on a span
 * that is re-solved every tick it meant every label sat at the path node's
 * origin for ever, which on a slitter piled both strips' readouts into one spot
 * a long way from any web.
 */
describe('label placement', () => {
  it('puts each zone label on its own span, not on the path origin', () => {
    const { h, path, gizmos } = machine({ ShowTensionLabels: true });
    run(h, 1);
    const texts = gizmos.live.filter((g) => g.opts.shape === 'text');
    expect(texts.length).toBeGreaterThan(1);

    // Not all at one point — which is exactly what the bug looked like.
    const xs = texts.map((g) => g.root.position.x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeGreaterThan(0.5);

    // And each one is at its own anchor, lifted clear of the web.
    const anchors = path.node.children.filter((c) => c.name === '__rvTensionLabel');
    expect(anchors).toHaveLength(texts.length);
    for (let k = 0; k < anchors.length; k++) {
      expect(texts[k].root.position.x).toBeCloseTo(anchors[k].position.x, 5);
      expect(texts[k].root.position.y).toBeGreaterThan(anchors[k].position.y);
    }
  });

  it('the dancer label travels with the carriage', () => {
    const { h, gizmos } = machine({ ShowTensionLabels: false });
    h.dancer('D').LoadN = 100;
    h.dancer('D').ShowValues = true;
    run(h, 0.5);
    const label = gizmos.live.find((g) => g.opts.shape === 'text' && String(g.opts.text).includes('N load'))!;
    const startY = label.root.position.y;

    // Fill the store: the carriage rises, and the readout has to come with it.
    h.drive.jogRoller('N3', 400);
    run(h, 2);
    expect(h.dancer('D').positionMm).toBeGreaterThan(1);
    expect(label.root.position.y).toBeGreaterThan(startY);
  });
});
