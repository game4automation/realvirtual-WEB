// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { WaitRegistry, zoneWaitSource } from './rv-wait-registry';
import { surfaceWaitSource, gripWaitSource } from './rv-transport-wait-sources';
import type { MovementAuthority } from '../engine/rv-movement-authority';
import { Vector3 } from 'three';
import type { AgvHandle } from '../engine/rv-agv-fleet';
import type { RVSink } from '../engine/rv-sink';
import type { RVTransportSurface } from '../engine/rv-transport-surface';
import type { RVMovingUnit, InstancedMovingUnit } from '../engine/rv-mu';
import { createCorePopulationSources, progressNodeId, type CoreProgressModel } from './rv-population-sources';
import { ProgressLedger } from './rv-progress-ledger';

export interface ProgressWiringOptions extends CoreProgressModel {
  clock: { now(): number };
  authority?: () => MovementAuthority;
  running: () => boolean;
  sampleEveryTicks?: number;
  idleSec?: number;
  onSample?: () => void;
  /** Tests can disable instrumentation without removing the model population. */
  adapters?: { vehicle?: boolean; surface?: boolean; sink?: boolean };
}

export interface ProgressSamplerState {
  ticks: number;
  vehicles: [string, number, number, number, boolean][];
  // Both sample-time and final centres are detached from disposable visuals.
  mus: [id: number, gen: number, x: number, y: number, z: number, surface: string | null,
    finalX: number, finalY: number, finalZ: number][];
}

/** Sample-time adapters. No transport/fleet hooks or allocations on ordinary fixed steps. */
export class ProgressWiring {
  readonly ledger: ProgressLedger;
  readonly waitRegistry = new WaitRegistry();
  private readonly every: number;
  private ticks = 0;
  private readonly populationUnsubs: (() => void)[];
  private readonly vehicles = new Map<AgvHandle, { position: Vector3; active: boolean }>();
  private readonly mus = new Map<RVMovingUnit | InstancedMovingUnit, { position: Vector3; surface: RVTransportSurface | null }>();
  private detached: ProgressSamplerState['mus'] = [];
  private resolveMU: (id: number, gen: number) => RVMovingUnit | InstancedMovingUnit | null = () => null;
  private readonly sinks = new Map<RVSink, () => void>();
  private readonly position = new Vector3();

  constructor(private readonly opts: ProgressWiringOptions) {
    if (opts.authority) this.waitRegistry.addSource(zoneWaitSource(opts.authority));
    this.waitRegistry.addSource(surfaceWaitSource(opts.transport));
    this.waitRegistry.addSource(gripWaitSource(opts.transport));
    this.every = Math.max(1, Math.floor(opts.sampleEveryTicks ?? 60));
    this.ledger = new ProgressLedger({ clock: opts.clock });
    this.populationUnsubs = createCorePopulationSources(opts).map(s => this.ledger.addPopulation(s));
    this.sample();
  }

  fixedStep(): void {
    if (++this.ticks < this.every) return;
    this.ticks = 0;
    this.sample();
  }

  sample(idleSec = this.opts.idleSec ?? 120): ReturnType<ProgressLedger['sample']> {
    const { ledger, opts } = this;
    if (opts.adapters?.vehicle !== false) {
      const handles = opts.fleet.all();
      const live = new Set(handles);
      for (const handle of this.vehicles.keys()) if (!live.has(handle)) this.vehicles.delete(handle);
      for (const handle of handles) {
        ledger.register(handle.id, 'vehicle', 'vehicle');
        const previous = this.vehicles.get(handle);
        // Fast-forward may process a whole run between rendered frames. Read
        // the current plan location when available, not the last drawn pose.
        const location = opts.authority?.().locate(handle.id, opts.clock.now());
        if (location) location.path.getAbsPosition(location.s, this.position);
        else if (handle.node) handle.node.getWorldPosition(this.position);
        const active = handle.task !== null && handle.phase !== 'idle';
        if (active) ledger.arm(handle.id);
        else if (previous?.active && handle.phase === 'idle') ledger.complete(handle.id);
        else ledger.inactive(handle.id);
        if ((location || handle.node) && previous && (previous.active || active)) {
          ledger.bump(handle.id, 'vehicle', previous.position.distanceTo(this.position) * 1000);
        }
        if (previous) {
          previous.position.copy(this.position);
          previous.active = active;
        } else {
          this.vehicles.set(handle, { position: this.position.clone(), active });
        }
      }
    }
    if (opts.adapters?.surface !== false) {
      const surfaces = this.detached.length
        ? new Map(opts.transport.surfaces.map(s => [progressNodeId(s.node, 'surface'), s])) : null;
      for (const [id, gen, x, y, z, surface, fx, fy, fz] of this.detached) {
        const mu = this.resolveMU(id, gen);
        if (mu) this.mus.set(mu, { position: new Vector3(x, y, z), surface: surface === null ? null : surfaces!.get(surface)! });
        else if (surface !== null) ledger.bump(surface, 'surface', new Vector3(x, y, z).distanceTo(this.position.set(fx, fy, fz)) * 1000);
      }
      this.detached = [];
      const occupied = new Set<RVTransportSurface>();
      const live = new Set<object>();
      // Credit the last observed surface even after transfer. Retired MUs above
      // use detached final positions so recycled slots cannot change their travel.
      for (const [mu, previous] of this.mus) {
        if (previous.surface) ledger.bump(progressNodeId(previous.surface.node, 'surface'),
          'surface', previous.position.distanceTo(mu.aabb.center) * 1000);
      }
      // One MU pass, independent of the number of surfaces.
      for (const mu of opts.transport.mus) {
        live.add(mu);
        const surface = mu.currentSurface;
        if (surface) occupied.add(surface);
        this.position.copy(mu.aabb.center);
        const previous = this.mus.get(mu);
        if (previous) { previous.position.copy(this.position); previous.surface = surface; }
        else this.mus.set(mu, { position: this.position.clone(), surface });
      }
      for (const mu of this.mus.keys()) if (!live.has(mu)) this.mus.delete(mu);
      for (const surface of opts.transport.surfaces) {
        const id = progressNodeId(surface.node, 'surface');
        ledger.register(id, 'surface', 'surface');
        if (occupied.has(surface)) ledger.arm(id);
        else ledger.inactive(id);
      }
    }
    const expectedSinks = new Set(opts.transport.sinks.filter(s =>
      s.DeleteMus === true && (opts.expectFlow?.(s) ?? false)));
    for (const [sink, unsubscribe] of this.sinks) {
      if (!expectedSinks.has(sink)) { unsubscribe(); this.sinks.delete(sink); }
    }
    if (opts.adapters?.sink !== false) {
      for (const sink of expectedSinks) {
        const id = progressNodeId(sink.node, 'sink');
        ledger.register(id, 'sink', 'sink');
        if (!this.sinks.has(sink)) this.sinks.set(sink, sink.subscribeConsumed(() => {
          if (opts.running() && sink.DeleteMus === true && (opts.expectFlow?.(sink) ?? false)) ledger.bump(id, 'sink');
        }));
        if (opts.running()) ledger.arm(id);
        else ledger.inactive(id);
      }
    }
    const sampled = ledger.sample(idleSec);
    opts.onSample?.();
    return sampled;
  }

  /** Retain final travel before disposal or reuse of an instancing slot. */
  retireMU(mu: RVMovingUnit | InstancedMovingUnit, ref: { id: number; gen: number }): void {
    const previous = this.mus.get(mu);
    if (!previous && !this.detached.some(entry => entry[0] === ref.id && entry[1] === ref.gen)) return;
    const final = mu.aabb.center;
    if (previous) {
      this.detached.push([ref.id, ref.gen, previous.position.x, previous.position.y, previous.position.z,
        previous.surface ? progressNodeId(previous.surface.node, 'surface') : null, final.x, final.y, final.z]);
      this.mus.delete(mu);
    }
    for (const entry of this.detached) if (entry[0] === ref.id && entry[1] === ref.gen)
      { entry[6] = final.x; entry[7] = final.y; entry[8] = final.z; }
  }

  snapshotState(muRef: (mu: RVMovingUnit | InstancedMovingUnit) => { id: number; gen: number } | null): ProgressSamplerState {
    return {
      ticks: this.ticks,
      vehicles: [...this.vehicles].map(([h, v]): ProgressSamplerState['vehicles'][number] =>
        [h.id, v.position.x, v.position.y, v.position.z, v.active]).sort(([a], [b]) => a.localeCompare(b)),
      mus: [...this.detached.map(entry => {
        const copy = [...entry] as ProgressSamplerState['mus'][number];
        const mu = this.resolveMU(copy[0], copy[1]);
        if (mu) { copy[6] = mu.aabb.center.x; copy[7] = mu.aabb.center.y; copy[8] = mu.aabb.center.z; }
        return copy;
      }), ...[...this.mus].map(([mu, v]): ProgressSamplerState['mus'][number] => {
        const ref = muRef(mu);
        if (ref === null) throw new Error('diag.blockage: sampled MU has no stable DES id');
        return [ref.id, ref.gen, v.position.x, v.position.y, v.position.z,
          v.surface ? progressNodeId(v.surface.node, 'surface') : null, mu.aabb.center.x, mu.aabb.center.y, mu.aabb.center.z];
      })].sort((a, b) => a[0] - b[0] || a[1] - b[1]),
    };
  }

  validateSnapshot(s: ProgressSamplerState): void {
    if (!s || !Number.isSafeInteger(s.ticks) || s.ticks < 0 || s.ticks >= this.every
      || !Array.isArray(s.vehicles) || !Array.isArray(s.mus)) throw new Error('diag.blockage: invalid sampler');
    const handles = new Set(this.opts.fleet.all().map(h => h.id));
    const surfaces = this.opts.transport.surfaces.map(v => progressNodeId(v.node, 'surface'));
    if (s.vehicles.some(v => !Array.isArray(v) || v.length !== 5)
      || s.mus.some(v => !Array.isArray(v) || v.length !== 9)) throw new Error('diag.blockage: invalid sample');
    if (new Set(s.vehicles.map(v => v[0])).size !== s.vehicles.length
      || new Set(s.mus.map(v => `${v[0]}:${v[1]}`)).size !== s.mus.length) throw new Error('diag.blockage: duplicate sampler id');
    for (const [id, x, y, z, active] of s.vehicles) {
      if (!handles.has(id) || ![x, y, z].every(Number.isFinite) || typeof active !== 'boolean')
        throw new Error('diag.blockage: invalid vehicle sample');
    }
    for (const [id, gen, x, y, z, surface, fx, fy, fz] of s.mus) {
      if (!Number.isSafeInteger(id) || id < 0 || !Number.isSafeInteger(gen) || gen < 0
        || ![x, y, z, fx, fy, fz].every(Number.isFinite)
        || surface !== null && surfaces.filter(s => s === surface).length !== 1)
        throw new Error('diag.blockage: invalid MU sample');
    }
  }

  restoreSnapshot(s: ProgressSamplerState, resolveMU: (id: number, gen: number) => RVMovingUnit | InstancedMovingUnit | null): void {
    this.ticks = s.ticks;
    this.vehicles.clear(); this.mus.clear();
    this.detached = structuredClone(s.mus);
    this.resolveMU = resolveMU;
    const handles = new Map(this.opts.fleet.all().map(h => [h.id, h]));
    for (const [id, x, y, z, active] of s.vehicles)
      this.vehicles.set(handles.get(id)!, { position: new Vector3(x, y, z), active });
  }

  reset(): void {
    for (const unsubscribe of this.sinks.values()) unsubscribe();
    this.sinks.clear();
    this.vehicles.clear();
    this.mus.clear();
    this.detached = [];
    this.resolveMU = () => null;
    this.ticks = 0;
    this.ledger.reset();
  }

  dispose(): void {
    this.waitRegistry.clear();
    this.reset();
    for (const unsubscribe of this.populationUnsubs) unsubscribe();
  }
}
