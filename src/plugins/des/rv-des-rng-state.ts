// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import type { RngStream, SFC32v2State } from '../../core/rv-rng-distribution';
import { RngStreamHandle, seedKey64 } from '../../core/rv-rng-streams';

// plan-2061 V5: the script stream is NOT a des.rng entry (its state is the script participant's rng int).
export interface RngStreamEntry {
  id: string;
  purpose: string;
  seedKey64: string;
  state: SFC32v2State;
}
export interface RngStreamsDoc { masterSeed: number; streams: RngStreamEntry[] }
const key = (seed: number, id: string, purpose: string) => seedKey64(seed, id, purpose).toString(16).padStart(16, '0');
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function captureStreamsDoc(masterSeed: number, handles: Iterable<RngStreamHandle>,
  inScope: (id: string) => boolean = () => true): RngStreamsDoc {
  return { masterSeed, streams: [...handles].filter(h => inScope(h.id)).map(h => ({
    id: h.id, purpose: h.purpose, seedKey64: key(masterSeed, h.id, h.purpose), state: h.getState(),
  })).sort((a, b) => compare(a.id, b.id) || compare(a.purpose, b.purpose)) };
}

export function validateStreamsDoc(raw: unknown, opts: { knownId(id: string): boolean }): RngStreamsDoc {
  if (!object(raw) || typeof raw.masterSeed !== 'number' || !Number.isFinite(raw.masterSeed)
    || !Array.isArray(raw.streams)) throw new Error('invalid RNG streams document');
  const masterSeed = raw.masterSeed;
  const seen = new Map<string, Set<string>>();
  const streams = raw.streams.map((entry: unknown): RngStreamEntry => {
    if (!object(entry) || typeof entry.id !== 'string' || !entry.id || !opts.knownId(entry.id)
      || typeof entry.purpose !== 'string') throw new Error('invalid or unknown RNG stream id/purpose');
    const { id, purpose } = entry;
    if (entry.seedKey64 !== key(masterSeed, id, purpose)) throw new Error('invalid RNG stream seedKey64');
    const state = entry.state;
    if (!object(state) || !['a', 'b', 'c', 'counter'].every(k => {
      const v = state[k];
      return typeof v === 'number' && Number.isInteger(v) && (v >>> 0) === v;
    })) throw new Error('invalid RNG stream state');
    const purposes = seen.get(id) ?? new Set<string>();
    if (purposes.has(purpose)) throw new Error('duplicate RNG stream tuple');
    purposes.add(purpose); seen.set(id, purposes);
    return { id, purpose, seedKey64: entry.seedKey64 as string,
      state: { a: state.a as number, b: state.b as number, c: state.c as number, counter: state.counter as number } };
  });
  return { masterSeed, streams };
}

export function applyStreamsDoc(doc: RngStreamsDoc, mgr: {
  stream(id: string, purpose: string): RngStream;
  streamEntries(): ReadonlyArray<RngStreamHandle>;
}, inScope: (id: string) => boolean): void {
  const present = new Map<string, Set<string>>();
  for (const entry of doc.streams) {
    mgr.stream(entry.id, entry.purpose).setState(entry.state);
    const purposes = present.get(entry.id) ?? new Set<string>();
    purposes.add(entry.purpose); present.set(entry.id, purposes);
  }
  for (const handle of mgr.streamEntries()) {
    if (inScope(handle.id) && !present.get(handle.id)?.has(handle.purpose)) handle.reseed(doc.masterSeed);
  }
}
