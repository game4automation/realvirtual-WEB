// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
// plan-612 CP1d-a a2 — "⚡ 63 %" above a charger while a stacker charges there.
// Real DESRunner world (pallet-yard-harness), both DES sub-modes:
//   - the label set equals the set of charging vehicles in EVERY frame (appears with
//     the charge start, gone with chargeDone), each label over its own charger, near
//     the vehicle standing there (Animated — FastForward moves no visuals between events)
//     and to the stich's handling pose;
//   - the value rises monotonically (Animated: always the rounded projected SOC);
//   - render load (#206): a redraw only every 500 ms wall clock AND only on a new whole
//     percent — counted, not timed;
//   - a reset / new runtime epoch / clear / detach leaves no sprite.
// Every looked-up value is asserted to exist first (#211).
import { afterEach, describe, expect, it } from 'vitest';
import { Object3D, Vector3 } from 'three';
import { PALLET_YARD_CONFIG, STATION_GEOMETRY, handlingPose, type PalletYardConfig } from '../../src/plugins/models/PalletYard/layout';
import {
  CHARGER_LABEL_REFRESH_MS, ChargerLabels, chargerLabelText, chargerLabelYardPosition, type ChargingView,
} from '../../src/plugins/models/PalletYard/charger-label';
import { yardChargingView } from '@rv/plugins/models/PalletYard/yard-runtime';
import { buildYard, type YardMode, type YardWorld } from './pallet-yard-harness';

const worlds: YardWorld[] = [];
afterEach(() => { for (const w of worlds.splice(0)) w.dispose(); });

/** Every vehicle starts low → each goes charging soon (both chargers in use, a queue). */
const lowSoc = (): PalletYardConfig => ({ ...PALLET_YARD_CONFIG, battery: { ...PALLET_YARD_CONFIG.battery, startSoc: [20, 22, 24] } });
const CHARGERS = PALLET_YARD_CONFIG.stations.filter((s) => s.kind === 'charger').map((s) => s.id);

const horiz = (a: Vector3, b: Vector3): number => Math.hypot(a.x - b.x, a.z - b.z);

interface Lifetime { charger: string; vehicle: string; shown: number[]; soc: number[]; startT: number; endT: number | null }

describe('PalletYard charger label (CP1d-a a2)', () => {
  it('there are two chargers with distinct label positions', () => {
    expect(CHARGERS).toEqual(['L1', 'L2']);
    const a = chargerLabelYardPosition('L1');
    const b = chargerLabelYardPosition('L2');
    expect(a, 'L1').not.toBeNull();
    expect(b, 'L2').not.toBeNull();
    expect(Math.hypot(a![0] - b![0], a![2] - b![2])).toBeGreaterThan(3);
    expect(chargerLabelYardPosition('V1'), 'not a charger').toBeNull();
    expect(chargerLabelText(63)).toBe('⚡ 63 %');
  });

  for (const mode of ['fastforward', 'animated'] as YardMode[]) {
    it(`[${mode}] appears at charge start over the right charger, rises, is gone at chargeDone; redraws throttled`, () => {
      const w = buildYard(mode, { cfg: lowSoc() });
      const view = yardChargingView(w.rt);
      worlds.push(w);
      const parent = new Object3D();
      const labels = new ChargerLabels();
      let wall = 0;
      labels.wallNow = () => wall;
      labels.attach(parent, w.root);
      // FastForward: big sim jumps, a 60 Hz wall frame. Animated: real time (sim s = wall s).
      const simStep = mode === 'fastforward' ? 5 : 0.25;
      const wallStep = mode === 'fastforward' ? 16 : simStep * 1000;
      const lives: Lifetime[] = [];
      const open = new Map<string, Lifetime>();
      let mismatches = 0;
      let wrongPlace = 0;
      let animatedLag = 0;
      while (w.now() < 1800) {
        w.runTo(w.now() + simStep);
        wall += wallStep;
        labels.update(view);
        // The label set equals the charging set — in this very frame.
        const charging = new Map<string, string>();
        for (const v of w.rt.vehicleIds) { const c = w.rt.chargingAt(v); if (c) charging.set(c, v); }
        if (labels.size !== charging.size || parent.children.length !== labels.size) mismatches++;
        for (const [c, v] of charging) {
          const info = labels.label(c);
          if (!info || info.vehicle !== v) { mismatches++; continue; }
          // Over ITS charger: near the vehicle standing there, far from the other charger.
          const vehicleAt = w.vehicle(v).root.getWorldPosition(new Vector3());
          const other = labels.label(c === 'L1' ? 'L2' : 'L1');
          const otherYard = chargerLabelYardPosition(c === 'L1' ? 'L2' : 'L1')!;
          // (FastForward moves no visuals between events — there the vehicle pose is not checked.)
          const g = STATION_GEOMETRY.find((x) => x.id === c)!;
          const dock = handlingPose(g).root;
          const nearVehicle = mode === 'fastforward' || horiz(info.position, vehicleAt) <= 1.6;
          if (!nearVehicle || horiz(info.position, new Vector3(dock[0], 0, dock[1])) > 1.2
            || horiz(info.position, new Vector3(otherYard[0], 0, otherYard[2])) < 3) {
            if (wrongPlace === 0) console.info(`[charger-label ${mode}] first wrong place: ${v}@${c} label ${info.position.toArray().map((x) => x.toFixed(2))} vehicle ${vehicleAt.toArray().map((x) => x.toFixed(2))} other ${otherYard}`);
            wrongPlace++;
          }
          if (other && other.sprite === info.sprite) wrongPlace++;
          const soc = w.rt.socAt(v);
          if (mode === 'animated' && info.percent !== Math.round(soc)) animatedLag++;
          let life = open.get(c);
          if (!life || life.vehicle !== v) {
            if (life) { life.endT = w.now(); open.delete(c); }
            life = { charger: c, vehicle: v, shown: [], soc: [], startT: w.now(), endT: null };
            lives.push(life);
            open.set(c, life);
          }
          life.shown.push(info.percent);
          life.soc.push(soc);
        }
        for (const [c, life] of open) if (!charging.has(c)) { life.endT = w.now(); open.delete(c); }
      }
      const done = lives.filter((l) => l.endT !== null);
      console.info(`[charger-label ${mode}] ${lives.map((l) => `${l.vehicle}@${l.charger} ${l.startT.toFixed(0)}..${l.endT?.toFixed(0) ?? '-'} ${l.shown[0]}→${l.shown[l.shown.length - 1]}`).join(', ')}; redraws ${labels.redraws}, wall ${wall} ms`);
      expect(mismatches, 'label set == charging set in every frame').toBe(0);
      expect(wrongPlace, 'every label over its own charger').toBe(0);
      expect(done.length, 'complete charges observed').toBeGreaterThanOrEqual(2);
      expect(new Set(done.map((l) => l.charger)), 'both chargers used').toEqual(new Set(CHARGERS));
      for (const l of done) {
        for (let i = 1; i < l.shown.length; i++) expect(l.shown[i], `${l.vehicle}@${l.charger} monotonic`).toBeGreaterThanOrEqual(l.shown[i - 1]);
        expect(l.shown[l.shown.length - 1], `${l.vehicle}@${l.charger} rises`).toBeGreaterThan(l.shown[0]);
        for (let i = 0; i < l.shown.length; i++) expect(l.shown[i], 'never ahead of the SOC').toBeLessThanOrEqual(Math.round(l.soc[i]));
      }
      expect(Math.max(...done.map((l) => l.shown[l.shown.length - 1] - l.shown[0])), 'a charge from a low SOC rises by tens of percent').toBeGreaterThanOrEqual(20);
      if (mode === 'animated') expect(animatedLag, 'Animated: the label is the rounded SOC in every frame').toBe(0);
      // Render load: a redraw = a creation, or a new whole percent at least 500 ms after the last draw.
      const created = lives.length;
      const percentSteps = lives.reduce((n, l) => n + (l.shown[l.shown.length - 1] - l.shown[0]), 0);
      expect(labels.redraws, 'redraws ≤ creations + whole-percent steps').toBeLessThanOrEqual(created + percentSteps);
      expect(labels.redraws, 'redraws ≤ creations + wall time / 500 ms per label').toBeLessThanOrEqual(created + Math.ceil(wall / CHARGER_LABEL_REFRESH_MS) * CHARGERS.length);
      if (mode === 'fastforward') {
        // 5 sim s per 16 ms frame: the percent changes on almost every frame, the throttle holds it back.
        const frames = lives.reduce((n, l) => n + l.shown.length, 0);
        expect(labels.redraws, 'FF: far fewer redraws than charging frames').toBeLessThan(frames / 4);
      } else {
        // Animated (5 %/min charge rate): at most ~5 redraws per label per sim minute (+ the creation).
        const chargeMin = done.reduce((n, l) => n + (l.endT! - l.startT) / 60, 0);
        expect(labels.redraws).toBeLessThanOrEqual(created + Math.ceil(chargeMin * PALLET_YARD_CONFIG.battery.chargePerMin) + done.length);
      }
    }, 240_000);
  }

  it('[fastforward] a reset during a charge leaves no sprite; clear / detach remove everything', () => {
    const w = buildYard('fastforward', { cfg: lowSoc() });
    const view = yardChargingView(w.rt);
    worlds.push(w);
    const parent = new Object3D();
    const labels = new ChargerLabels();
    labels.attach(parent, w.root);
    expect(w.runUntil(() => { labels.update(view); return labels.size > 0; }, 900, 5), 'a charge with a label').toBe(true);
    expect(parent.children.length).toBe(labels.size);
    const epoch = w.rt.epoch;
    w.reset();
    expect(w.rt.epoch).toBeGreaterThan(epoch);
    labels.update(view);
    expect(labels.size, 'after reset').toBe(0);
    expect(parent.children, 'no sprite after reset').toHaveLength(0);
    // The run goes on: labels come back with the next charge, clear / detach remove them.
    expect(w.runUntil(() => { labels.update(view); return labels.size > 0; }, 900, 5)).toBe(true);
    labels.clear();
    expect(parent.children).toHaveLength(0);
    labels.update(view);
    expect(parent.children.length, 'clear keeps the attachment').toBeGreaterThan(0);
    labels.detach();
    expect(parent.children).toHaveLength(0);
    labels.update(view);
    expect(parent.children, 'detached: nothing is created').toHaveLength(0);
  }, 240_000);

  it('a new runtime epoch drops a label even while the same vehicle still charges (fresh sprite)', () => {
    const parent = new Object3D();
    const frame = new Object3D();
    const labels = new ChargerLabels();
    labels.wallNow = () => 0;
    labels.attach(parent, frame);
    const view: { -readonly [K in keyof ChargingView]: ChargingView[K] } = {
      cfg: { vehicles: ['Stapler_1'] }, epoch: 1,
      chargingAt: (v) => (v === 'Stapler_1' ? 'L1' : null),
      socAt: () => 41.2,
    };
    labels.update(view);
    const first = labels.label('L1');
    expect(first, 'label').not.toBeNull();
    expect(first!.text).toBe('⚡ 41 %');
    view.epoch = 2;
    labels.update(view);
    const second = labels.label('L1');
    expect(second, 'label after the epoch change').not.toBeNull();
    expect(second!.sprite).not.toBe(first!.sprite);
    expect(parent.children).toEqual([second!.sprite]);
  });

  it('throttle: no redraw before 500 ms wall, none for the same whole percent, one after', () => {
    const parent = new Object3D();
    const labels = new ChargerLabels();
    let wall = 1000;
    labels.wallNow = () => wall;
    labels.attach(parent, new Object3D());
    let soc = 50.2;
    const view: ChargingView = { cfg: { vehicles: ['Stapler_1'] }, epoch: 1, chargingAt: () => 'L2', socAt: () => soc };
    labels.update(view);
    expect(labels.redraws).toBe(1);
    soc = 51.4; wall += 499;           // new percent, too early
    labels.update(view);
    expect(labels.redraws).toBe(1);
    expect(labels.label('L2')!.percent).toBe(50);
    wall += 1;                          // 500 ms → redraw
    labels.update(view);
    expect(labels.redraws).toBe(2);
    expect(labels.label('L2')!.percent).toBe(51);
    soc = 51.45; wall += 5000;          // same whole percent, long after → no redraw
    labels.update(view);
    expect(labels.redraws).toBe(2);
  });
});
