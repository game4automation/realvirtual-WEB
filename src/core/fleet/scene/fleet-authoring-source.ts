// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Lazy authoring snapshot. Event handlers invalidate only, never traverse a loading scene. */
import { Vector3, type Object3D } from 'three';
import type { RVViewer } from '../../rv-viewer';
import { instanceScopeNode } from '../../engine/rv-instance-scope';
import { NodeRegistry } from '../../engine/rv-node-registry';
import type { BodyEnvelope } from '../../engine/rv-movement-authority';
import { readFleetScene, type DesignVehicle, type FleetReferenceResolver, type FleetSceneIssue, type FleetSceneModel } from './fleet-scene-model';

export interface FleetAuthoringViewer {
  readonly scene: Object3D;
  readonly registry?: Partial<FleetReferenceResolver> | null;
}

export interface FleetLoadOffset {
  readonly mm: number;
  readonly source: 'vehicle' | 'design' | 'none';
  readonly issues: readonly FleetSceneIssue[];
}

/** The single design-envelope unit boundary: authored mm to path geometry in m. */
export function designEnvelopeOf(v: DesignVehicle): BodyEnvelope {
  return { front: v.lengthMm / 2000, rear: v.lengthMm / 2000, width: v.widthMm / 1000 };
}

export class FleetAuthoringSource {
  private static readonly sources = new WeakMap<FleetAuthoringViewer, FleetAuthoringSource>();
  private viewer: FleetAuthoringViewer | null = null;
  private unsub: (() => void)[] = [];
  private readonly listeners = new Set<() => void>();
  private cachedModel: FleetSceneModel | null = null;
  private cachedOffset: FleetLoadOffset | null = null;
  reads = 0;

  static of(viewer: FleetAuthoringViewer): FleetAuthoringSource {
    let source = this.sources.get(viewer);
    if (!source) {
      source = new FleetAuthoringSource();
      source.viewer = viewer;
      this.sources.set(viewer, source);
    }
    return source;
  }

  attach(viewer: FleetAuthoringViewer & Pick<RVViewer, 'on'>): void {
    this.dispose();
    const previous = FleetAuthoringSource.sources.get(viewer);
    if (previous && previous !== this) previous.dispose();
    this.viewer = viewer;
    FleetAuthoringSource.sources.set(viewer, this);
    for (const event of ['model-loaded', 'layout-content-added', 'layout-content-removed'] as const) {
      this.unsub.push(viewer.on(event, () => this.invalidate()));
    }
    this.unsub.push(viewer.on('component-field-changed', (e) => {
      if (/^(Fleet|TransferStation|ForkliftProfile)(?:_\d+)?$/.test(e.componentType)) this.invalidate();
    }));
  }

  dispose(): void {
    for (const off of this.unsub) off();
    this.unsub = [];
    this.cachedModel = null;
    this.cachedOffset = null;
    this.listeners.clear();
    if (this.viewer && FleetAuthoringSource.sources.get(this.viewer) === this) {
      FleetAuthoringSource.sources.delete(this.viewer);
    }
    // Existing callers can still read without caching; of() creates a fresh source.
  }

  onInvalidate(cb: () => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  invalidate(): void {
    this.cachedModel = null;
    this.cachedOffset = null;
    for (const cb of this.listeners) cb();
  }

  model(): FleetSceneModel {
    if (!this.viewer) throw new Error('FleetAuthoringSource needs a viewer (of or attach).');
    if (this.unsub.length && this.cachedModel) return this.cachedModel;
    const registry = this.viewer.registry;
    this.cachedModel = readFleetScene(this.viewer.scene, registry?.resolve ? registry as FleetReferenceResolver : null);
    this.cachedOffset = null;
    this.reads++;
    return this.cachedModel;
  }

  loadOffset(): FleetLoadOffset {
    const model = this.model();
    if (this.cachedOffset) return this.cachedOffset;
    const values: { id: string; mm: number }[] = [];
    for (const profile of model.forkliftProfiles) {
      if (!profile.forkAnchor) continue;
      const scope = instanceScopeNode(profile.node);
      const candidates: Object3D[] = [];
      const visit = (node: Object3D): void => {
        if (instanceScopeNode(node) !== scope) return;
        const rv = node.userData.realvirtual as Record<string, unknown> | undefined;
        if (rv && Object.keys(rv).some((key) => /^Agv(?:_\d+)?$/.test(key) && !!rv[key])) candidates.push(node);
        for (const child of node.children) visit(child);
      };
      visit(profile.node);
      candidates.sort((a, b) => {
        const x = NodeRegistry.computeNodePath(a), y = NodeRegistry.computeNodePath(b);
        return x < y ? -1 : x > y ? 1 : 0;
      });
      const agv = candidates.includes(profile.node) ? profile.node : candidates[0];
      if (!agv) continue;
      agv.updateWorldMatrix(true, false);
      profile.forkAnchor.updateWorldMatrix(true, false);
      const mm = -agv.worldToLocal(profile.forkAnchor.getWorldPosition(new Vector3())).z * 1000;
      if (Number.isFinite(mm)) values.push({ id: profile.id, mm });
    }
    const issues: FleetSceneIssue[] = [];
    const design = model.fleet?.designLoadOffsetMm ?? 0;
    const first = values[0]; // readFleetScene sorts profiles by id.
    let mm = 0;
    let source: FleetLoadOffset['source'] = 'none';
    if (first) {
      const ambiguous = Math.max(...values.map((v) => v.mm)) - Math.min(...values.map((v) => v.mm)) > 10;
      if (ambiguous) issues.push({ code: 'fleet-load-offset-ambiguous', node: first.id,
        message: `Forklift load offsets disagree: ${values.map((v) => `${v.id}: ${v.mm} mm`).join(', ')}.` });
      mm = ambiguous && design > 0 ? design : first.mm;
      source = ambiguous && design > 0 ? 'design' : 'vehicle';
    } else if (design !== 0) {
      mm = design;
      source = 'design';
    } else if (model.forkliftProfiles.length) {
      issues.push({ code: 'fleet-load-offset-missing', node: model.forkliftProfiles[0]!.id,
        message: 'Forklift profiles have no measurable load anchor and DesignLoadOffsetMm is unset.' });
    }
    return this.cachedOffset = { mm, source, issues };
  }
}
