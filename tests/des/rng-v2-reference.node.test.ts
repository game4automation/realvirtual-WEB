// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { describe, expect, it } from 'vitest';
import { SFC32v2 } from '../../src/core/rv-rng-distribution';
import fixture from './fixtures/rng-v2/sfc32-practrand-vectors.json';

describe('PractRand sfc32 reference', () => {
  for (const v of fixture.vectors) it(`seed ${v.seed}: warmup state, outputs and continuation`, () => {
    const rng = SFC32v2.fromSeed64(BigInt(v.seed));
    expect(rng.getState()).toEqual(v.state);
    expect(Array.from({ length: 32 }, () => rng.next())).toEqual(v.outputs);
    const state = rng.getState();
    const tail = Array.from({ length: 32 }, () => rng.next());
    const copy = SFC32v2.fromSeed64(999n);
    copy.setState(state);
    state.counter = 0; // setState must copy, not retain the caller's object.
    expect(Array.from({ length: 32 }, () => copy.next())).toEqual(tail);
  });
  it('wraps the counter independently and exposes u32 / 2^32 floats', () => {
    const rng = SFC32v2.fromSeed64(0n);
    rng.setState({ a: 1, b: 2, c: 3, counter: 0xffffffff });
    expect(rng.next()).toBe(2);
    expect(rng.getState()).toEqual({ a: 2, b: 27, c: 6291458, counter: 0 });
    const a = SFC32v2.fromSeed64(42n);
    const b = SFC32v2.fromSeed64(42n);
    for (let i = 0; i < 64; i++) expect(a.nextFloat()).toBe(b.next() / 4294967296);
  });
});
