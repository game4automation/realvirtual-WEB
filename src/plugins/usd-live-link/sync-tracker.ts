// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/** Live-Link wire adapter. The shared sampler owns pose/inventory diffs. */
import type { Object3D } from 'three';
import { MotionSampler, type MotionSamplerConfig, type MotionSink } from '../../core/usd/motion-sampler';
import { FrameWriter, encodeMuDelete, encodeMuSpawn } from './livesync-protocol';

export type { TrackedMu } from '../../core/usd/motion-sampler';
export interface SyncTrackerConfig extends Omit<MotionSamplerConfig, 'preplaced' | 'sink' | 'timeline' | 'rootWorld'> {
  preplaced: ReadonlyMap<number, number>;
  send(bytes: Uint8Array): void;
}

/** Sample-rate gate: 60 Hz fixed ticks → `rateHz` samples. */
export class RateGate {
  private acc = 0;
  constructor(public rateHz: number) {}

  /** Advance by `dt`; true when a sample is due. */
  advance(dt: number): boolean {
    const period = 1 / Math.max(1, this.rateHz);
    this.acc += dt;
    if (this.acc + 1e-6 < period) return false;
    this.acc -= period;
    if (this.acc > period) this.acc = 0; // never burst after a stall
    return true;
  }

  reset(): void { this.acc = 0; }
}

export class SyncTracker implements MotionSink {
  private readonly sampler: MotionSampler;
  private readonly writer: FrameWriter;
  private session = 0;
  private seq = 0;
  private sent = 0;

  constructor(private readonly cfg: SyncTrackerConfig) {
    this.writer = new FrameWriter(Math.max(16, cfg.trackedIndices.length + 16));
    const preplaced = new Map<number, Object3D>();
    for (const [id, index] of cfg.preplaced) preplaced.set(id, cfg.nodes[index]);
    this.sampler = new MotionSampler({ ...cfg, preplaced, sink: this });
  }

  get frameWriter(): FrameWriter { return this.writer; }
  requestFull(): void { this.sampler.requestFull(); }

  sample(session: number): number {
    this.session = session;
    this.sent = 0;
    this.writer.begin(session, this.seq);
    this.sampler.sample();
    if (this.writer.nodeCount > 0 || this.writer.muCount > 0) {
      this.cfg.send(this.writer.finish());
      this.seq++;
      this.sent++;
    }
    return this.sent;
  }

  onNodes(index: number, matrix: ArrayLike<number>): void { this.writer.writeNode(index, matrix); }
  onMuPoses(muId: number, matrix: ArrayLike<number>): void { this.writer.writeMu(muId, matrix); }
  onMuSpawn(muId: number, templateIndex: number, matrix: ArrayLike<number>): void {
    this.cfg.send(encodeMuSpawn(this.session, muId, templateIndex, matrix));
    this.sent++;
  }
  onMuDelete(muId: number): void {
    this.cfg.send(encodeMuDelete(this.session, muId));
    this.sent++;
  }
}

/**
 * Node indices to track: every drive node and its subtree that is in the
 * snapshot (index 0 = the root, whose matrix carries its world transform, is
 * never tracked).
 */
export function collectTrackedIndices(driveNodes: readonly Object3D[], indexOf: ReadonlyMap<Object3D, number>): number[] {
  const out = new Set<number>();
  for (const n of driveNodes) {
    n.traverse((c) => {
      const i = indexOf.get(c);
      if (i !== undefined && i !== 0) out.add(i);
    });
  }
  return [...out].sort((a, b) => a - b);
}
