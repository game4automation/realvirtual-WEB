// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

import { SFC32Legacy, SFC32v2, type RngStream, type RngStreamState, type SFC32v2State } from './rv-rng-distribution';

export const RNG_VERSION_LEGACY = 1;
export const RNG_VERSION_V2 = 2;
export type RngVersion = 1 | 2;

/** plan-2060 §2.3: framed NFC UTF-8 tuple, FNV-1a64, SplitMix64 finalizer. */
export function seedKey64(masterSeed: number, id: string, purpose: string): bigint {
  if (!Number.isFinite(masterSeed)) throw new Error('seedKey64: masterSeed must be finite');
  const mask = 0xffffffffffffffffn;
  let hash = 0xcbf29ce484222325n;
  const byte = (b: number): void => { hash = ((hash ^ BigInt(b)) * 0x100000001b3n) & mask; };
  const encoder = new TextEncoder();
  for (const b of encoder.encode('rv-rng-v2\0')) byte(b);
  let seed = BigInt.asUintN(64, BigInt(Math.trunc(masterSeed)));
  for (let i = 0; i < 8; i++) { byte(Number(seed & 255n)); seed >>= 8n; }
  for (const field of [id, purpose]) {
    const bytes = encoder.encode(field.normalize('NFC'));
    if (bytes.length > 0xffffffff) throw new Error('seedKey64: field exceeds u32 byte length');
    for (let i = 0; i < 4; i++) byte((bytes.length >>> (8 * i)) & 255);
    for (const b of bytes) byte(b);
  }
  let z = ((hash ^ (hash >> 30n)) * 0xbf58476d1ce4e5b9n) & mask;
  z = ((z ^ (z >> 27n)) * 0x94d049bb133111ebn) & mask;
  return z ^ (z >> 31n);
}

/** Stable binding handle; reseeding replaces only its generator state. */
export class RngStreamHandle implements RngStream {
  private rng: SFC32v2;

  constructor(masterSeed: number, readonly id: string, readonly purpose: string) {
    this.rng = SFC32v2.fromSeed64(seedKey64(masterSeed, id, purpose));
  }

  next(): number { return this.rng.nextFloat(); }
  getState(): SFC32v2State { return this.rng.getState(); }
  setState(s: RngStreamState): void {
    if (Array.isArray(s)) throw new Error('rng-v2-state-invalid');
    this.rng.setState(s);
  }
  reseed(masterSeed: number): void {
    this.rng = SFC32v2.fromSeed64(seedKey64(masterSeed, this.id, this.purpose));
  }
}

export function scriptSeed32(masterSeed: number, id: string): number {
  return Number(seedKey64(masterSeed, id, 'script') & 0xffffffffn) || 1;
}

export function createStream(version: RngVersion, masterSeed: number, id: string, purpose: string,
  legacyIndex?: number): RngStream {
  if (version === 1) {
    if (legacyIndex === undefined) throw new Error('rng-v1-legacy-index-required');
    return new SFC32Legacy(masterSeed + legacyIndex);
  }
  if (version === 2) return new RngStreamHandle(masterSeed, id, purpose);
  throw new Error(`rng-version-unknown: ${version}`);
}
