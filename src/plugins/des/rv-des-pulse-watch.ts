// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import type { Object3D } from 'three';
import type { RVGrip } from '../../core/engine/rv-grip';
import type { RVSource } from '../../core/engine/rv-source';
import type { SignalStore } from '../../core/engine/rv-signal-store';
import type { SignalValue } from '../../core/sim-event-facade';
import { clearProblem, reportProblem } from '../../core/hmi/problems-store';
import type { DESManager } from './rv-des-manager';

/** Diagnose polling consumers without latching their inputs or scheduling work. */
export function watchDesZeroTimePulses(options: {
  runnerId: number;
  manager: Pick<DESManager, 'currentTime'>;
  store: SignalStore;
  grips: readonly RVGrip[];
  sources: readonly RVSource[];
  addressOf(node: Object3D): string | null | undefined;
  writer?: () => string | null;
}): () => void {
  const { runnerId, manager, store } = options;
  type Consumer = { address: string; field: 'SignalPick' | 'SignalPlace' | 'SourceGenerate' };
  type Watch = { consumers: Consumer[]; last: SignalValue | undefined;
    start: SignalValue | undefined; time: number | undefined; deviated: boolean; writer: string | null };
  const watches = new Map<string, Watch>();
  const reported = new Set<string>();
  const add = (node: Object3D, addr: string | null, field: Consumer['field']): void => {
    if (!addr) return;
    const address = options.addressOf(node);
    if (!address) return;
    const name = store.nameForPath(addr) ?? addr;
    let watch = watches.get(name);
    if (!watch) {
      watch = { consumers: [], last: store.get(name), start: undefined, time: undefined, deviated: false, writer: null };
      watches.set(name, watch);
    }
    watch.consumers.push({ address, field });
  };
  for (const grip of options.grips) {
    add(grip.node, grip.signalPickAddr, 'SignalPick');
    add(grip.node, grip.signalPlaceAddr, 'SignalPlace');
  }
  for (const source of options.sources) add(source.node, source.SourceGenerate, 'SourceGenerate');

  const offWrites = store.observeWrites(batch => {
    for (const [name, value] of batch) {
      const watch = watches.get(name);
      if (!watch) continue;
      // Observers run after the write, so retain the preceding value ourselves.
      if (watch.time !== manager.currentTime) {
        watch.time = manager.currentTime;
        watch.start = watch.last;
        watch.deviated = false;
        watch.writer = null;
      }
      if (!watch.deviated && value !== watch.start) {
        watch.deviated = true;
        watch.writer = options.writer?.() ?? null;
      }
      watch.last = value;
      if (!watch.deviated || value !== watch.start) continue;
      for (const { address, field } of watch.consumers) {
        const id = `des-zero-time-pulse:${runnerId}:${name}:${address}:${field}`;
        if (reported.has(id)) continue;
        reported.add(id);
        const writer = watch.writer === 'plc:#live' ? 'the live PLC program'
          : watch.writer?.startsWith('plc:') ? `PLC program ${watch.writer.slice(4)}` : watch.writer;
        reportProblem({ id, code: 'des-zero-time-pulse', severity: 'warning',
          title: 'Zero-time pulse not evaluated',
          detail: `${field} on ${address} pulses within one DES time step; grippers and classic sources do not run in DES mode until DES MU activation (plan-519)${writer === null ? '' : ` (written by ${writer})`}`,
          nodePath: address, at: manager.currentTime * 1000 });
      }
    }
  });
  const offRestore = store.onValuesRestored(() => {
    for (const [name, watch] of watches) {
      watch.last = store.get(name);
      watch.time = undefined;
      watch.deviated = false;
      watch.writer = null;
    }
  });
  return () => {
    offWrites(); offRestore();
    for (const id of reported) clearProblem(id);
    reported.clear();
  };
}
