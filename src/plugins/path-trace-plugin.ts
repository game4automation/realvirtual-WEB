// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-trace-plugin.ts — the congestion trace as two colour bands along the
 * path network (plan-629 Phase 2).
 *
 * Two views, each ONE `LineSegments2` with per-segment vertex colours: a
 * continuous yellow → red gradient normalised to the CURRENT run — the lowest
 * loaded bucket is yellow, the highest is red, no fixed thresholds; a bucket
 * without load (0) or without data stays neutral grey. The range is recomputed
 * on every re-colour and published as the legend (`trace-settings-store`):
 *
 * - `__pathTrace:utilization` — share of the time a bucket is occupied by at
 *   least one vehicle body; drawn 0.2 m to the LEFT of the travel direction.
 * - `__pathTrace:blocked` — share of the time a vehicle stands there although it
 *   wants to move; drawn 0.2 m to the RIGHT.
 *
 * Measurement lives in `PathTrace` / `PathTraceDriver` (pure, Phase 1); this
 * plugin owns their lifecycle and the drawing:
 *
 * - **Clocks:** continuous kernel → `attachContinuous` (the authority clock's
 *   `onBeforeAdvance`) plus `tickFixed(dt)` in `onFixedUpdatePost` for the
 *   legacy / live dt base; DES → `attachDes(desControl)` plus
 *   `renderDes(desControl)` in `onRender` (horizon `min(renderClock,
 *   nextEventTime)`). A kernel or mode switch detaches, resets and re-attaches.
 * - **Resets:** `simulation-start` (after every `resetSimulation`) →
 *   `driver.reset(now)` — the continuous clock does NOT run backwards on a sim
 *   reset, so the driver cannot detect it on its own. A path signature change
 *   (ids + lengths, 2 Hz poll, plus `onPathChanged`) rebuilds the bucket table
 *   and starts measuring NOW (D7, gate R1-5). `onModelCleared` drops it all.
 * - **Colours:** written IN PLACE into the interleaved `instanceColorStart/End`
 *   buffer (no `setColors` at runtime), throttled to 500 ms wall clock, only for
 *   a visible view and only when the trace version changed. A change of the
 *   time range or the window (trace-settings-store) re-colours immediately,
 *   independent of any counter change (gate R1-9).
 * - **Overlay categories** `trace-blocked` / `trace-utilization` (default OFF)
 *   get a producer while at least one vehicle and one path exist; sampling runs
 *   in that case even with both bands hidden, so switching one on shows the
 *   full history at once.
 *
 * No hover, no tooltip, no click target on the band (F10). Geometry and
 * material are disposed on rebuild / clear / dispose; exactly two band objects
 * exist at any time.
 */

import { createElement, lazy, Suspense } from 'react';
import { Typography } from '@mui/material';
import type { StatsSectionBodyProps } from '../core/stats/rv-stats-registry';
import { Color, Group, Vector3 } from 'three';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';
import { LineSegmentsGeometry } from 'three/addons/lines/LineSegmentsGeometry.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import type { InterleavedBufferAttribute } from 'three';
import type { RVViewerPlugin } from '../core/rv-plugin';
import type { RVViewer } from '../core/rv-viewer';
import { PLUGIN_ORDER } from '../core/rv-plugin-order';
import { getDefaultPathNetwork } from '../core/engine/rv-path-network';
import type { RVPath } from '../core/engine/rv-path';
import { getDefaultAgvFleet } from '../core/engine/rv-agv-fleet';
import { getDefaultMovementAuthority } from '../core/engine/rv-movement-authority';
import { markNoAO } from '../core/engine/rv-group-registry';
import { PathTrace, type TraceView } from '../core/engine/rv-path-trace';
import { PathTraceDriver, type TraceDesClock } from '../core/engine/rv-path-trace-sources';
import {
  isOverlayVisible, setOverlayVisible, subscribeOverlayVisibility, registerOverlayProducer, unregisterOverlayProducer,
  type OverlayCategory,
} from '../core/overlay-visibility-store';
import { getTraceSettings, setTraceLegend, subscribeTraceSettings } from '../core/trace-settings-store';

// This plugin is boot code; load the table/legend UI only for an active hub tab.
const LazyPathTrafficSection = lazy(() => import('./path-trace/PathTrafficSection'));
function PathTrafficBody(props: StatsSectionBodyProps) {
  return props.active
    ? createElement(Suspense, { fallback: createElement(Typography, { role: 'status', variant: 'caption', sx: { color: 'text.secondary', px: 1 } }, 'Loading…') }, createElement(LazyPathTrafficSection, props))
    : null;
}

/** Height (m) above the path (the path line sits at +0.02). */
const BAND_Y = 0.03;
/** Lateral offset (m) from the path centre line. */
const BAND_OFFSET_M = 0.2;
/** Polyline points per metre along a bucket. */
const POINTS_PER_METER = 4;
/** Band width (px). */
const BAND_WIDTH_PX = 5;
const BAND_RENDER_ORDER = 510;
/** Colour upload / signature poll throttle (ms wall clock). */
const UPDATE_INTERVAL_MS = 500;

function linear(hex: number): [number, number, number] {
  const c = new Color().setHex(hex);
  return [c.r, c.g, c.b];
}
/** Colour anchors (linear working space, as written into the vertex colour buffer). */
export const TRACE_COLOR_YELLOW = linear(0xfbc02d);
export const TRACE_COLOR_RED = linear(0xd32f2f);
export const TRACE_COLOR_NO_DATA = linear(0x616161);

/**
 * Colour of a value `v` into `out` (r, g, b), normalised to the run's range
 * `[lo, hi]` of loaded buckets: `lo` = yellow, `hi` = red, linear in between.
 * NaN (no data) and `v <= 0` (no load) are neutral grey; `hi <= lo` (one load
 * level only) is red — every loaded bucket IS the maximum. Pure.
 */
export function traceColor(v: number, lo: number, hi: number, out: [number, number, number]): [number, number, number] {
  if (!(v > 0)) {
    out[0] = TRACE_COLOR_NO_DATA[0]; out[1] = TRACE_COLOR_NO_DATA[1]; out[2] = TRACE_COLOR_NO_DATA[2];
    return out;
  }
  const u = hi > lo ? Math.min(1, Math.max(0, (v - lo) / (hi - lo))) : 1;
  const a = TRACE_COLOR_YELLOW, b = TRACE_COLOR_RED;
  if (u >= 1) { out[0] = b[0]; out[1] = b[1]; out[2] = b[2]; return out; } // exact anchor
  out[0] = a[0] + (b[0] - a[0]) * u;
  out[1] = a[1] + (b[1] - a[1]) * u;
  out[2] = a[2] + (b[2] - a[2]) * u;
  return out;
}

const VIEWS: readonly TraceView[] = ['blocked', 'utilization'];
const CATEGORY: Readonly<Record<TraceView, OverlayCategory>> = {
  blocked: 'trace-blocked', utilization: 'trace-utilization',
};

interface Band {
  view: TraceView;
  line: LineSegments2;
  /** Bucket → first segment index; length B + 1 (CSR). */
  segStart: Int32Array;
  /** Trace version + settings version the colours were written for (−1 = stale). */
  traceVersion: number;
  settingsVersion: number;
}

const noRaycast = (): void => {};
const _p = new Vector3();
const _q = new Vector3();
const _d = new Vector3();
const _side = new Vector3();
const UP = new Vector3(0, 1, 0);

/** Cheap numeric signature of the path set (ids + lengths + closed), no string building. */
function pathSignature(paths: readonly RVPath[]): number {
  let h = 2166136261 >>> 0;
  const mix = (x: number): void => { h = Math.imul(h ^ x, 16777619) >>> 0; };
  mix(paths.length);
  for (const p of paths) {
    const id = p.id;
    for (let i = 0; i < id.length; i++) mix(id.charCodeAt(i));
    mix(Math.round(p.length * 10000) | 0);
    mix(p.closed ? 1 : 0);
  }
  return h;
}

export class PathTracePlugin implements RVViewerPlugin {
  readonly id = 'path-trace';
  readonly order = PLUGIN_ORDER.UI_OVERLAY;

  /** The accumulator (read by `web_trace_top`). */
  readonly trace = new PathTrace();
  /** Clock driver of {@link trace}. */
  readonly driver = new PathTraceDriver(this.trace);

  private viewer: RVViewer | null = null;
  private root: Group | null = null;
  private readonly bands: Partial<Record<TraceView, Band>> = {};
  private readonly visible: Record<TraceView, boolean> = {
    blocked: isOverlayVisible('trace-blocked'), utilization: isOverlayVisible('trace-utilization'),
  };
  private readonly unsubs: (() => void)[] = [];
  private producing = false;
  private statsAvailable = false;
  private readonly statsListeners = new Set<() => void>();
  /** Kernel the driver is attached to: null = detached. */
  private attachedKind: 'continuous' | 'des' | null = null;
  private attachedDes: TraceDesClock | null = null;
  private signature = -1;
  private signatureStale = true;
  private lastPoll = Number.NEGATIVE_INFINITY;
  private lastColor = Number.NEGATIVE_INFINITY;
  private appliedWindowSec = -1;
  private readonly rgb: [number, number, number] = [0, 0, 0];

  init(viewer: RVViewer): void {
    this.viewer = viewer;
    this.statsAvailable = this.trace.paths.length > 0;
    this.unsubs.push(viewer.stats.register({
      id: 'path.traffic', title: 'Path traffic', order: 20,
      isAvailable: () => this.trace.paths.length > 0,
      subscribe: listener => {
        this.statsListeners.add(listener);
        return () => { this.statsListeners.delete(listener); };
      },
      Body: PathTrafficBody,
      settings: VIEWS.map(view => ({
        id: `path.trace.${view}`,
        label: view === 'blocked' ? 'Blocked share' : 'Utilization',
        get: () => isOverlayVisible(CATEGORY[view]),
        set: value => setOverlayVisible(CATEGORY[view], value),
        subscribe: subscribeOverlayVisibility,
        persist: false,
      })),
    }));
    const root = new Group();
    root.name = '__pathTrace';
    root.renderOrder = BAND_RENDER_ORDER;
    root.frustumCulled = false;
    root.userData._rvSynthetic = true;
    viewer.scene.add(root);
    this.root = root;
    this.applyWindow();
    this.unsubs.push(subscribeOverlayVisibility(() => this.onOverlayChanged()));
    this.unsubs.push(subscribeTraceSettings(() => this.onSettingsChanged()));
    this.unsubs.push(getDefaultPathNetwork().onPathChanged(() => { this.signatureStale = true; }));
    // A sim reset does not run the continuous clock backwards — restart explicitly.
    const off = viewer.on?.('simulation-start', () => this.onSimulationStart());
    if (typeof off === 'function') this.unsubs.push(off);
  }

  onModelCleared(): void {
    this.detachDriver();
    this.trace.rebuild([]);
    this.notifyStatsAvailability();
    this.trace.reset();
    this.disposeBands();
    this.signature = -1;
    this.signatureStale = true;
    this.lastPoll = Number.NEGATIVE_INFINITY;
    this.setProducing(false);
  }

  dispose(): void {
    this.onModelCleared();
    for (const off of this.unsubs) off();
    this.unsubs.length = 0;
    this.root?.removeFromParent();
    this.root = null;
    this.viewer = null;
  }

  /** Number of band objects in the scene (diagnostics / tests). */
  get bandCount(): number {
    return (this.bands.blocked ? 1 : 0) + (this.bands.utilization ? 1 : 0);
  }

  /** The band object of a view (tests). */
  bandOf(view: TraceView): LineSegments2 | null {
    return this.bands[view]?.line ?? null;
  }

  /** Bucket → first segment index of a view's band (tests); length = buckets + 1. */
  segmentStarts(view: TraceView): Int32Array | null {
    return this.bands[view]?.segStart ?? null;
  }

  /** Kernel the trace is currently driven by (diagnostics / MCP). */
  get attachedTo(): 'continuous' | 'des' | null {
    return this.attachedKind;
  }

  onFixedUpdatePost(dt: number): void {
    if (this.attachedKind === 'continuous') this.driver.tickFixed(dt);
  }

  onRender(): void {
    const now = typeof performance !== 'undefined' ? performance.now() : Date.now();
    if (this.signatureStale || now - this.lastPoll >= UPDATE_INTERVAL_MS) {
      this.lastPoll = now;
      this.poll();
    }
    this.syncAttachment();
    if (this.attachedKind === 'des' && this.attachedDes) this.driver.renderDes(this.attachedDes);
    if (now - this.lastColor >= UPDATE_INTERVAL_MS) {
      this.lastColor = now;
      this.refreshColors(false);
    }
  }

  /**
   * Re-check the path set now (normally a 2 Hz poll): a changed signature
   * rebuilds the bucket table and both bands, measuring from the current time.
   */
  poll(): void {
    this.signatureStale = false;
    const paths = getDefaultPathNetwork().all();
    const sig = pathSignature(paths);
    if (sig !== this.signature) {
      this.signature = sig;
      // D7 / gate R1-5: new geometry, the measurement starts at the CURRENT clock time.
      // (Never behind the trace: the DES render horizon may already be past the last event time.)
      const clock = this.attachedKind ? this.clockNow(this.attachedKind) : 0;
      this.driver.rebuild(paths, Math.max(clock, this.trace.simTime));
      this.notifyStatsAvailability();
      this.buildBands();
    }
    this.syncLineResolution();
    this.syncProducing();
  }

  /**
   * Write the band colours. `force` ignores the version check (a range /
   * window switch, a band that just became visible); otherwise a band is only
   * re-coloured when visible and the trace or the settings changed.
   */
  refreshColors(force: boolean): void {
    const settings = getTraceSettings();
    let changed = false;
    for (const view of VIEWS) {
      const band = this.bands[view];
      if (!band || !this.visible[view]) continue;
      if (!force && band.traceVersion === this.trace.version && band.settingsVersion === settings.version) continue;
      this.writeColors(band, settings.range);
      band.traceVersion = this.trace.version;
      band.settingsVersion = settings.version;
      changed = true;
    }
    if (changed) this.viewer?.markRenderDirty?.();
  }

  // ── Internals ─────────────────────────────────────────────────────────

  private notifyStatsAvailability(): void {
    const available = this.trace.paths.length > 0;
    if (available === this.statsAvailable) return;
    this.statsAvailable = available;
    for (const listener of this.statsListeners) listener();
  }

  private onOverlayChanged(): void {
    let changed = false;
    for (const view of VIEWS) {
      const v = isOverlayVisible(CATEGORY[view]);
      if (v === this.visible[view]) continue;
      this.visible[view] = v;
      const band = this.bands[view];
      if (band) {
        band.line.visible = v && this.producing;
        if (v) band.traceVersion = -1; // hidden bands are not re-coloured — catch up now
      }
      changed = true;
    }
    if (!changed) return;
    this.refreshColors(false);
    this.viewer?.markRenderDirty?.();
  }

  private onSettingsChanged(): void {
    this.applyWindow();
    // Gate R1-9: a range / window switch is its own colour invalidation.
    this.refreshColors(true);
  }

  private applyWindow(): void {
    const sec = getTraceSettings().windowSec;
    if (sec === this.appliedWindowSec) return;
    this.appliedWindowSec = sec;
    this.trace.setWindowSec(sec);
  }

  private onSimulationStart(): void {
    if (!this.attachedKind) return;
    this.driver.reset(this.clockNow(this.attachedKind));
    this.refreshColors(true);
  }

  private clockNow(kind: 'continuous' | 'des'): number {
    if (kind === 'des') return this.attachedDes?.simTime ?? 0;
    return getDefaultMovementAuthority('continuous').clock.now;
  }

  /** True while there is something to measure: a vehicle and a bucket. */
  private get active(): boolean {
    return getDefaultAgvFleet().handleList.length > 0 && this.trace.bucketCount > 0;
  }

  /** Attach the driver to the kernel that runs now; detach while nothing is measured. */
  private syncAttachment(): void {
    const viewer = this.viewer;
    if (!viewer || !this.active) {
      if (this.attachedKind) this.detachDriver();
      return;
    }
    const runtime = viewer.runtime;
    const des = runtime && runtime.mode === 'discrete' ? runtime.desControl : null;
    const kind: 'continuous' | 'des' = des ? 'des' : 'continuous';
    if (kind === this.attachedKind && des === this.attachedDes) return;
    // Kernel / mode switch (reset-on-switch in the kernel): a fresh measurement.
    const switched = this.attachedKind !== null;
    this.detachDriver();
    this.attachedKind = kind;
    this.attachedDes = des;
    if (des) {
      if (switched) this.driver.reset(des.simTime);
      this.driver.attachDes(des);
    } else {
      const mb = getDefaultMovementAuthority('continuous');
      if (switched) this.driver.reset(mb.clock.now);
      this.driver.attachContinuous(mb);
    }
  }

  private detachDriver(): void {
    this.driver.detach();
    this.attachedKind = null;
    this.attachedDes = null;
  }

  private syncProducing(): void {
    const on = this.active;
    this.setProducing(on);
    for (const view of VIEWS) {
      const band = this.bands[view];
      if (band) band.line.visible = on && this.visible[view];
    }
  }

  private setProducing(on: boolean): void {
    if (on === this.producing) return;
    this.producing = on;
    for (const view of VIEWS) {
      if (on) registerOverlayProducer(CATEGORY[view]);
      else unregisterOverlayProducer(CATEGORY[view]);
    }
  }

  /** (Re)build both bands from the trace's bucket table. */
  private buildBands(): void {
    this.disposeBands();
    if (!this.root || this.trace.bucketCount === 0) return;
    for (const view of VIEWS) {
      const side = view === 'utilization' ? BAND_OFFSET_M : -BAND_OFFSET_M;
      const { positions, segStart } = this.bandGeometry(side);
      const geom = new LineSegmentsGeometry();
      geom.setPositions(positions);
      geom.setColors(new Float32Array(positions.length)); // 6 floats per segment, like the positions
      const mat = new LineMaterial({
        color: 0xffffff,
        vertexColors: true,
        linewidth: BAND_WIDTH_PX,
        transparent: true,
        opacity: 0.95,
        depthTest: true,
        depthWrite: false,
      });
      mat.resolution.set(
        typeof window !== 'undefined' ? window.innerWidth : 1920,
        typeof window !== 'undefined' ? window.innerHeight : 1080,
      );
      const line = new LineSegments2(geom, mat);
      line.name = `__pathTrace:${view}`;
      line.renderOrder = BAND_RENDER_ORDER;
      line.frustumCulled = false;
      line.raycast = noRaycast; // F10: never a click / hover target
      line.userData._rvSynthetic = true;
      line.visible = this.producing && this.visible[view];
      markNoAO(line);
      this.root.add(line);
      this.bands[view] = { view, line, segStart, traceVersion: -1, settingsVersion: -1 };
    }
    this.refreshColors(true);
    this.viewer?.markRenderDirty?.();
  }

  /** Sampled sub-segments of every bucket, offset by `side` metres (+ = left of travel). */
  private bandGeometry(side: number): { positions: Float32Array; segStart: Int32Array } {
    const t = this.trace;
    const B = t.bucketCount;
    const segStart = new Int32Array(B + 1);
    let total = 0;
    const segsPer = new Int32Array(B);
    for (let b = 0; b < B; b++) {
      const [from, to] = t.bucketRange(b);
      segsPer[b] = Math.max(1, Math.ceil((to - from) * POINTS_PER_METER));
      segStart[b] = total;
      total += segsPer[b];
    }
    segStart[B] = total;
    const positions = new Float32Array(total * 6);
    let o = 0;
    for (let b = 0; b < B; b++) {
      const path = t.paths[t.pathOfBucket(b)];
      const [from, to] = t.bucketRange(b);
      const n = segsPer[b];
      for (let i = 0; i < n; i++) {
        this.offsetPoint(path, from + ((to - from) * i) / n, side, _p);
        this.offsetPoint(path, from + ((to - from) * (i + 1)) / n, side, _q);
        positions[o++] = _p.x; positions[o++] = _p.y; positions[o++] = _p.z;
        positions[o++] = _q.x; positions[o++] = _q.y; positions[o++] = _q.z;
      }
    }
    return { positions, segStart };
  }

  private offsetPoint(path: RVPath, s: number, side: number, out: Vector3): void {
    path.getAbsPosition(s, out);
    path.getAbsDirection(s, _d);
    _side.crossVectors(UP, _d);
    if (_side.lengthSq() > 1e-12) out.addScaledVector(_side.normalize(), side);
    out.y += BAND_Y;
  }

  /** Write one band's colours in place (no allocation). */
  private writeColors(band: Band, range: 'window' | 'start'): void {
    const attr = band.line.geometry.getAttribute('instanceColorStart') as InterleavedBufferAttribute | undefined;
    if (!attr) return;
    const data = attr.data;
    const arr = data.array as Float32Array;
    const seg = band.segStart;
    const rgb = this.rgb;
    const B = seg.length - 1;
    // The run's range of LOADED buckets (v > 0): lowest = yellow, highest = red.
    let lo = Number.POSITIVE_INFINITY, hi = 0;
    for (let b = 0; b < B; b++) {
      const v = this.trace.value(band.view, range, b);
      if (!(v > 0)) continue;
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    if (hi > 0) setTraceLegend(band.view, lo, hi);
    else setTraceLegend(band.view, null, null);
    for (let b = 0; b < B; b++) {
      traceColor(this.trace.value(band.view, range, b), lo, hi, rgb);
      for (let s = seg[b]; s < seg[b + 1]; s++) {
        const k = s * 6;
        arr[k] = rgb[0]; arr[k + 1] = rgb[1]; arr[k + 2] = rgb[2];
        arr[k + 3] = rgb[0]; arr[k + 4] = rgb[1]; arr[k + 5] = rgb[2];
      }
    }
    data.needsUpdate = true;
  }

  private syncLineResolution(): void {
    const canvas = this.viewer?.renderer?.domElement as HTMLCanvasElement | undefined;
    const w = canvas?.clientWidth || (typeof window !== 'undefined' ? window.innerWidth : 1920);
    const h = canvas?.clientHeight || (typeof window !== 'undefined' ? window.innerHeight : 1080);
    for (const view of VIEWS) {
      const band = this.bands[view];
      if (band) (band.line.material as LineMaterial).resolution.set(w, h);
    }
  }

  private disposeBands(): void {
    for (const view of VIEWS) {
      setTraceLegend(view, null, null);
      const band = this.bands[view];
      if (!band) continue;
      band.line.removeFromParent();
      band.line.geometry.dispose();
      (band.line.material as LineMaterial).dispose();
      delete this.bands[view];
    }
  }
}
