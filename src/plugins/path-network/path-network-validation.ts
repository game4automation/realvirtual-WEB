// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * path-network-validation — live validation of the path network (plan-628
 * Phase 4, §2.8): the publisher between the pure checks
 * (`rv-path-network-validate.ts`) and the Problems panel / the markers.
 *
 *  - Trigger: `network-changed` (commit, undo, redo), model load / clear and
 *    the visualizer's own change detection — all only MARK dirty; the run
 *    happens on the next render tick (debounced to one frame), only while an
 *    authoring mode is active.
 *  - Problems: one entry per issue; ids are stable (`path-network:<code>:<key>`,
 *    the 618 merge codes keep the ids `Agv.ts` uses, so a load-time entry is
 *    replaced, never doubled). Entries this publisher reported and no longer
 *    finds are cleared; foreign entries of the same code are left alone.
 *  - Markers: one ring per located issue under `__pathMarkers` (the layer of
 *    the `Path Network` group — hidden with it).
 *  - plan-628 8.11g: errors and warnings carry a short label next to their
 *    ring (`Kink 5.0°`, `Gap 12 mm`, `R 0.40 m < 0.60 m`); info rings (open
 *    ends) show theirs on hover (path-network UI). Only ERRORS are news for
 *    the Problems panel — info / warning entries are reported `quiet`, so the
 *    panel no longer opens by itself while a network is being built.
 *
 * Envelope (P11): fleet bodies > Fleet design vehicle > explicit > none.
 */

import { CanvasTexture, DoubleSide, Group, Mesh, MeshBasicMaterial, RingGeometry, Sprite, SpriteMaterial, type Object3D } from 'three';
import { clearProblem, reportProblem } from '../../core/hmi/problems-store';
import { markAsOverlay } from '../../core/engine/rv-group-registry';
import type { BodyEnvelope } from '../../core/engine/rv-movement-authority';
import {
  isUsableEnvelope,
  validatePathNetwork,
  type EnvelopeSource,
  type PathNetworkIssue,
  type PathNetworkValidation,
} from '../../core/engine/rv-path-network-validate';
import { getFleetBodyEnvelope } from '../../behaviors/Agv';
import { FleetAuthoringSource, designEnvelopeOf } from '../../core/fleet/scene/fleet-authoring-source';
export { designEnvelopeOf } from '../../core/fleet/scene/fleet-authoring-source';
import { onPathNetworkChanged } from './path-network-signal';
import { snapshotNetwork, type SnapshotViewer } from './path-network-scene';
import { collectStationDockChecks } from './path-network-dock';
import { validateStationDocks } from '../../core/engine/rv-path-stub-dock';

/** P11: fleet bodies > Fleet design vehicle > explicit > none. */
export function resolvePathEnvelope(viewer: SnapshotViewer | null, explicit?: BodyEnvelope | null): { env: BodyEnvelope | null; source: EnvelopeSource } {
  const fleet = getFleetBodyEnvelope();
  if (isUsableEnvelope(fleet)) return { env: fleet, source: 'fleet' };
  const design = viewer ? FleetAuthoringSource.of(viewer).model().fleet?.designVehicle : null;
  if (design) return { env: designEnvelopeOf(design), source: 'design' };
  if (isUsableEnvelope(explicit)) return { env: explicit, source: 'explicit' };
  return { env: null, source: 'none' };
}

/** Validate the scene's network now (snapshot from the nodes, envelope per P11). */
export function validateSceneNetwork(viewer: SnapshotViewer, explicit?: BodyEnvelope | null): PathNetworkValidation {
  const { env, source } = resolvePathEnvelope(viewer, explicit);
  const { input } = snapshotNetwork(viewer);
  // A start a vehicle starts on is reachable ("only a vehicle starting on it reaches it").
  const stationPaths = new Set((input.vehicles ?? []).map((v) => v.pathId));
  const result = validatePathNetwork(input, { env, envelopeSource: source, stationPaths });
  return { ...result, issues: [...result.issues, ...validateStationDocks(collectStationDockChecks(viewer), input.paths)] };
}

/** Problems id of an issue — the merge codes share the ids of `Agv.ts`. */
export function problemIdOf(i: PathNetworkIssue): string {
  switch (i.code) {
    case 'agv-merge-without-zone': return `agv-merge-without-zone:${i.key}`;
    case 'agv-merge-entry-too-short': return `agv-merge-entry-too-short:${i.key}`;
    case 'agv-merge-check-skipped': return 'agv-merge-check-skipped';
    default: return `path-network:${i.code}:${i.key}`;
  }
}

/** Problems / marker headline of an issue code (also the hover tip of the path-network UI). */
export function pathIssueTitle(code: PathNetworkIssue['code']): string {
  return TITLES[code];
}

const TITLES: Record<PathNetworkIssue['code'], string> = {
  'path-dock-misaligned': 'Station dock misaligned',
  'path-dock-stub-missing': 'Docked stub missing',
  'path-open-end': 'Path ends without a successor',
  'path-unreachable-start': 'Path start has no predecessor',
  'path-link-gap': 'Path link gap',
  'path-kink': 'Kink at path connection',
  'path-dangling-successor': 'Path successor missing',
  'path-radius-too-tight': 'Path curve too tight for the vehicles',
  'path-block-transform-not-identity': 'Path block has a node transform',
  'path-merge-zones-too-close': 'Merge zones too close',
  'agv-merge-without-zone': 'AGV merge without a zone',
  'agv-merge-entry-too-short': 'AGV merge entry too short',
  'agv-merge-check-skipped': 'AGV merge-entry check skipped',
};

const COLORS: Record<PathNetworkIssue['severity'], number> = { error: 0xe53935, warning: 0xffa000, info: 0x42a5f5 };
/** Marker lift above the path (m) so the ring is not z-fighting the line. */
const MARKER_LIFT_M = 0.02;
/** Height of a marker label (screen fraction, size-attenuation off). */
const LABEL_HEIGHT = 0.032;
/** Label text height in the label canvas (px). */
const LABEL_FONT_PX = 28;

/** The live publisher; owned by the path visualizer (it owns `__pathMarkers`). */
export class PathNetworkLiveValidation {
  private dirty = true;
  private active = false;
  private readonly reported = new Set<string>();
  private readonly unsub: () => void;
  private geometry: RingGeometry | null = null;
  private readonly materials = new Map<PathNetworkIssue['severity'], MeshBasicMaterial>();
  /** Last result (diagnostics / tests). */
  last: PathNetworkValidation | null = null;
  /** Completed runs (diagnostics / tests). */
  runs = 0;

  constructor(
    private readonly viewer: SnapshotViewer & { markRenderDirty?: () => void },
    private readonly markerRoot: Group,
  ) {
    this.unsub = onPathNetworkChanged(() => this.markDirty());
  }

  /** Something may have changed — validate on the next tick. */
  markDirty(): void { this.dirty = true; }

  /** Authoring mode on/off; off clears the published entries and markers. */
  setActive(on: boolean): void {
    if (on === this.active) return;
    this.active = on;
    if (on) this.dirty = true;
    else this.clear();
  }

  /** Render tick: run once when dirty and active (one-frame debounce). */
  tick(): void {
    if (!this.dirty || !this.active) return;
    this.dirty = false;
    this.run();
  }

  /** Validate and publish now. */
  run(): PathNetworkValidation {
    const res = validateSceneNetwork(this.viewer);
    this.publish(res.issues);
    this.last = res;
    this.runs++;
    return res;
  }

  /** Drop every entry and marker this publisher made. */
  clear(): void {
    for (const id of this.reported) clearProblem(id);
    this.reported.clear();
    this.clearMarkers();
    this.last = null;
  }

  dispose(): void {
    this.unsub();
    this.clear();
    this.geometry?.dispose();
    this.geometry = null;
    for (const m of this.materials.values()) m.dispose();
    this.materials.clear();
  }

  private publish(issues: readonly PathNetworkIssue[]): void {
    const now = new Set<string>();
    const source = FleetAuthoringSource.of(this.viewer);
    const fleetIssues = [...source.model().issues, ...source.loadOffset().issues];
    for (const i of fleetIssues) {
      if (!['fleet-design-vehicle-incomplete', 'fleet-load-offset-missing', 'fleet-load-offset-ambiguous'].includes(i.code)) continue;
      const id = `path-network:${i.code}:${i.node}`;
      now.add(id);
      reportProblem({ id, code: i.code, severity: 'warning', quiet: true, nodePath: i.node,
        title: i.code === 'fleet-design-vehicle-incomplete' ? 'Incomplete design vehicle'
          : i.code === 'fleet-load-offset-missing' ? 'Load offset missing' : 'Load offsets disagree', detail: i.message });
    }
    for (const i of issues) {
      const id = problemIdOf(i);
      now.add(id);
      // 8.11g: only errors are news (the panel opens); info / warning stay quiet — their marker is at the path.
      reportProblem({ id, severity: i.severity, code: i.code, title: TITLES[i.code], detail: i.detail, ...(i.severity === 'error' ? {} : { quiet: true }) });
    }
    for (const id of this.reported) if (!now.has(id)) clearProblem(id);
    this.reported.clear();
    for (const id of now) this.reported.add(id);

    this.clearMarkers();
    for (const i of issues) {
      if (!i.position) continue;
      const m = new Mesh(this.ringGeometry(), this.material(i.severity));
      m.name = `__pathMarker:${i.code}:${i.key}`;
      m.rotation.x = -Math.PI / 2;
      m.position.set(i.position[0], i.position[1] + MARKER_LIFT_M, i.position[2]);
      m.renderOrder = 530;
      m.userData.pathIssue = { code: i.code, key: i.key, severity: i.severity };
      markAsOverlay(m);
      this.markerRoot.add(m);
      if (i.severity !== 'info') {
        const label = this.label(i.short ?? TITLES[i.code], i.severity);
        if (label) {
          label.name = `__pathMarkerLabel:${i.code}:${i.key}`;
          label.position.set(i.position[0], i.position[1] + MARKER_LIFT_M, i.position[2]);
          markAsOverlay(label);
          this.markerRoot.add(label);
        }
      }
    }
    this.viewer.markRenderDirty?.();
  }

  private clearMarkers(): void {
    for (const c of [...this.markerRoot.children] as Object3D[]) {
      this.markerRoot.remove(c);
      if (c instanceof Sprite) { c.material.map?.dispose(); c.material.dispose(); }
    }
  }

  /** 8.11g: a screen-sized text label anchored to the right of the ring (null without a DOM). */
  private label(text: string, severity: PathNetworkIssue['severity']): Sprite | null {
    if (typeof document === 'undefined') return null;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx) return null;
    const font = `600 ${LABEL_FONT_PX}px system-ui, sans-serif`;
    ctx.font = font;
    const pad = 10;
    canvas.width = Math.ceil(ctx.measureText(text).width) + pad * 2;
    canvas.height = LABEL_FONT_PX + pad * 2;
    ctx.font = font;
    ctx.fillStyle = 'rgba(20, 22, 26, 0.85)';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = `#${COLORS[severity].toString(16).padStart(6, '0')}`;
    ctx.fillRect(0, 0, 6, canvas.height);
    ctx.fillStyle = '#ffffff';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, pad, canvas.height / 2 + 1);
    const tex = new CanvasTexture(canvas);
    const sprite = new Sprite(new SpriteMaterial({ map: tex, depthTest: false, transparent: true, sizeAttenuation: false }));
    sprite.scale.set(LABEL_HEIGHT * canvas.width / canvas.height, LABEL_HEIGHT, 1);
    // Anchored left-middle a little right of the point: the label sits beside the ring, not on it.
    sprite.center.set(-0.12, 0.5);
    sprite.renderOrder = 531;
    sprite.userData.pathIssueLabel = text;
    return sprite;
  }

  private ringGeometry(): RingGeometry {
    if (!this.geometry) this.geometry = new RingGeometry(0.18, 0.26, 32);
    return this.geometry;
  }

  private material(s: PathNetworkIssue['severity']): MeshBasicMaterial {
    let m = this.materials.get(s);
    if (!m) {
      m = new MeshBasicMaterial({ color: COLORS[s], side: DoubleSide, depthTest: false, transparent: true, opacity: 0.9 });
      this.materials.set(s, m);
    }
    return m;
  }
}
