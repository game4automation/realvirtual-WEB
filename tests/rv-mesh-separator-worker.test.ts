// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Worker parity and abort behaviour for the mesh separator (plan-331, test 9.17).
 *
 * Two halves:
 * - a **real** `Worker`, to prove the off-thread path returns identical partitions and
 *   identical attribute contents, and that the live source geometry is never detached;
 * - an **injected fake port**, to drive the abort epoch deterministically instead of
 *   racing a real worker.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import {
  DEFAULT_WELD_THRESHOLD,
  computeGroupPartitions,
  computeMeshIslands,
  extractSubGeometry,
  type SeparateRequest,
  type SeparateResponse,
} from '../src/core/editor/rv-mesh-separator';
import {
  MeshSeparatorAbortError,
  RVMeshSeparatorClient,
  isMeshSeparatorAbort,
  type MeshSeparatorPort,
} from '../src/core/editor/rv-mesh-separator-client';

// ─── Fixtures (mirrors of the 9.1-9.5 set) ──────────────────────────────

function indexedGeometry(positions: number[], indices: number[]): BufferGeometry {
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  geom.setIndex(new BufferAttribute(new Uint32Array(indices), 1));
  return geom;
}

/** 9.1 — two disjoint triangles. */
function twoDisjointTriangles(): BufferGeometry {
  return indexedGeometry(
    [0, 0, 0, 1, 0, 0, 0, 1, 0, 10, 0, 0, 11, 0, 0, 10, 1, 0],
    [0, 1, 2, 3, 4, 5],
  );
}

/** 9.5 — the same, with uv and a normalized Uint8 colour attribute. */
function attributedGeometry(): BufferGeometry {
  const geom = twoDisjointTriangles();
  geom.setAttribute(
    'uv',
    new BufferAttribute(new Float32Array([0, 0, 1, 0, 0, 1, 0.25, 0.25, 0.75, 0.25, 0.25, 0.75]), 2),
  );
  geom.setAttribute(
    'color',
    new BufferAttribute(
      new Uint8Array([255, 0, 0, 0, 255, 0, 0, 0, 255, 10, 20, 30, 40, 50, 60, 70, 80, 90]),
      3,
      true,
    ),
  );
  return geom;
}

/** 9.4 — non-indexed, two cubes. */
function nonIndexedTwoCubes(): BufferGeometry {
  const positions: number[] = [];
  for (const dx of [0, 10]) {
    // A tetrahedron is enough to prove the non-indexed weld path; four faces, twelve verts.
    const c: [number, number, number][] = [
      [0 + dx, 0, 0], [1 + dx, 0, 0], [0 + dx, 1, 0], [0 + dx, 0, 1],
    ];
    for (const [a, b, d] of [[0, 1, 2], [0, 1, 3], [0, 2, 3], [1, 2, 3]] as const) {
      positions.push(...c[a], ...c[b], ...c[d]);
    }
  }
  const geom = new BufferGeometry();
  geom.setAttribute('position', new BufferAttribute(new Float32Array(positions), 3));
  return geom;
}

/** 9.8 — material groups. */
function groupedGeometry(): BufferGeometry {
  const geom = twoDisjointTriangles();
  geom.addGroup(0, 3, 0);
  geom.addGroup(3, 3, 1);
  return geom;
}

const FIXTURES: { name: string; make: () => BufferGeometry }[] = [
  { name: '9.1 two disjoint triangles', make: twoDisjointTriangles },
  { name: '9.4 non-indexed pair', make: nonIndexedTwoCubes },
  { name: '9.5 uv + normalized color', make: attributedGeometry },
];

// ─── Fake port ──────────────────────────────────────────────────────────

class FakePort implements MeshSeparatorPort {
  readonly sent: SeparateRequest[] = [];
  terminated = false;
  private callback: ((message: SeparateResponse) => void) | null = null;

  postMessage(message: SeparateRequest): void {
    this.sent.push(message);
  }

  terminate(): void {
    this.terminated = true;
  }

  onMessage(callback: (message: SeparateResponse) => void): void {
    this.callback = callback;
  }

  /** Simulates the worker answering. */
  deliver(message: SeparateResponse): void {
    this.callback?.(message);
  }
}

const clients: RVMeshSeparatorClient[] = [];
function makeClient(options?: ConstructorParameters<typeof RVMeshSeparatorClient>[0]): RVMeshSeparatorClient {
  const client = new RVMeshSeparatorClient(options);
  clients.push(client);
  return client;
}

afterEach(() => {
  while (clients.length) clients.pop()!.dispose();
});

// ─── 9.17 parity ────────────────────────────────────────────────────────

describe('9.17 worker parity', () => {
  it('constructs a real worker in this environment', () => {
    expect(makeClient().usesWorker).toBe(true);
  });

  for (const fixture of FIXTURES) {
    it(`matches the synchronous path for ${fixture.name}`, async () => {
      const client = makeClient();
      const geom = fixture.make();

      const expectedPartitions = computeMeshIslands(geom, DEFAULT_WELD_THRESHOLD);
      const actualPartitions = await client.analyze(geom, 'islands', DEFAULT_WELD_THRESHOLD);
      expect(actualPartitions).toEqual(expectedPartitions);
      expect(actualPartitions.length).toBeGreaterThan(0);

      const expectedParts = expectedPartitions.map((p) => extractSubGeometry(geom, p));
      const actualParts = await client.extract(geom, actualPartitions);
      expect(actualParts.length).toBe(expectedParts.length);

      for (let i = 0; i < expectedParts.length; i++) {
        const expected = expectedParts[i];
        const actual = actualParts[i];

        expect(Object.keys(actual.attributes).sort()).toEqual(Object.keys(expected.attributes).sort());
        for (const name of Object.keys(expected.attributes)) {
          const e = expected.attributes[name] as BufferAttribute;
          const a = actual.attributes[name] as BufferAttribute;
          expect(a.itemSize).toBe(e.itemSize);
          expect(a.normalized).toBe(e.normalized);
          expect(a.array.constructor).toBe(e.array.constructor);
          expect(Array.from(a.array as ArrayLike<number>)).toEqual(Array.from(e.array as ArrayLike<number>));
        }

        expect(Array.from(actual.index!.array as ArrayLike<number>)).toEqual(
          Array.from(expected.index!.array as ArrayLike<number>),
        );
        expect(actual.boundingSphere).not.toBeNull();
        expect(actual.boundingBox).not.toBeNull();
      }
    });
  }

  it('matches the synchronous path in group mode', async () => {
    const client = makeClient();
    const geom = groupedGeometry();
    expect(await client.analyze(geom, 'groups', DEFAULT_WELD_THRESHOLD)).toEqual(
      computeGroupPartitions(geom),
    );
  });

  it('never detaches the live source geometry', async () => {
    const client = makeClient();
    const geom = attributedGeometry();

    const positionBytes = geom.getAttribute('position').array.byteLength;
    const indexBytes = geom.index!.array.byteLength;
    const colorBytes = geom.getAttribute('color').array.byteLength;
    expect(positionBytes).toBeGreaterThan(0);

    const partitions = await client.analyze(geom, 'islands', DEFAULT_WELD_THRESHOLD);
    await client.extract(geom, partitions);

    // A transferred request would leave these at 0 and take rendering and raycast with it.
    expect(geom.getAttribute('position').array.byteLength).toBe(positionBytes);
    expect(geom.index!.array.byteLength).toBe(indexBytes);
    expect(geom.getAttribute('color').array.byteLength).toBe(colorBytes);
  });
});

// ─── 9.17 abort ─────────────────────────────────────────────────────────

describe('9.17 abort epoch', () => {
  it('drops a response carrying a stale id', async () => {
    const port = new FakePort();
    const client = makeClient({ createPort: () => port });
    const geom = twoDisjointTriangles();

    const first = client.analyze(geom, 'islands', DEFAULT_WELD_THRESHOLD);
    const firstOutcome = first.then(() => 'resolved').catch((err) => err);

    // A second request supersedes the first.
    const second = client.analyze(geom, 'islands', DEFAULT_WELD_THRESHOLD);
    expect(port.sent.length).toBe(2);
    const [firstRequest, secondRequest] = port.sent;
    expect(secondRequest.id).toBeGreaterThan(firstRequest.id);

    expect(isMeshSeparatorAbort(await firstOutcome)).toBe(true);

    // The stale answer arrives late and must be ignored entirely.
    port.deliver({ id: firstRequest.id, ok: true, phase: 'analyze', partitions: [[999]] });

    port.deliver({ id: secondRequest.id, ok: true, phase: 'analyze', partitions: [[0], [1]] });
    expect(await second).toEqual([[0], [1]]);
  });

  it('applies nothing after dispose and terminates the worker', async () => {
    const port = new FakePort();
    const client = new RVMeshSeparatorClient({ createPort: () => port });
    const geom = twoDisjointTriangles();

    const pending = client.analyze(geom, 'islands', DEFAULT_WELD_THRESHOLD);
    const outcome = pending.then(() => 'resolved').catch((err) => err);
    const [request] = port.sent;

    client.dispose();
    expect(port.terminated).toBe(true);
    expect(isMeshSeparatorAbort(await outcome)).toBe(true);

    // A response arriving after dispose must not be applied — and must not throw.
    expect(() =>
      port.deliver({ id: request.id, ok: true, phase: 'analyze', partitions: [[0], [1]] }),
    ).not.toThrow();

    await expect(client.analyze(geom, 'islands', DEFAULT_WELD_THRESHOLD)).rejects.toBeInstanceOf(
      MeshSeparatorAbortError,
    );
  });

  it('aborts the in-flight request on cancel()', async () => {
    const port = new FakePort();
    const client = makeClient({ createPort: () => port });
    const geom = twoDisjointTriangles();

    const pending = client.analyze(geom, 'islands', DEFAULT_WELD_THRESHOLD);
    const outcome = pending.then(() => 'resolved').catch((err) => err);
    const [request] = port.sent;

    client.cancel();
    expect(isMeshSeparatorAbort(await outcome)).toBe(true);

    port.deliver({ id: request.id, ok: true, phase: 'analyze', partitions: [[0], [1]] });
  });

  it('surfaces a worker-side error as a rejection', async () => {
    const port = new FakePort();
    const client = makeClient({ createPort: () => port });
    const geom = twoDisjointTriangles();

    const pending = client.analyze(geom, 'islands', DEFAULT_WELD_THRESHOLD);
    port.deliver({ id: port.sent[0].id, ok: false, error: 'boom' });
    await expect(pending).rejects.toThrow('boom');
  });
});

// ─── 9.17 fallback ──────────────────────────────────────────────────────

describe('9.17 synchronous fallback', () => {
  it('produces identical results without a worker', async () => {
    const client = makeClient({ createPort: () => null });
    expect(client.usesWorker).toBe(false);

    const geom = attributedGeometry();
    const expectedPartitions = computeMeshIslands(geom, DEFAULT_WELD_THRESHOLD);

    const partitions = await client.analyze(geom, 'islands', DEFAULT_WELD_THRESHOLD);
    expect(partitions).toEqual(expectedPartitions);

    const parts = await client.extract(geom, partitions);
    const expectedParts = expectedPartitions.map((p) => extractSubGeometry(geom, p));
    expect(parts.length).toBe(expectedParts.length);

    for (let i = 0; i < parts.length; i++) {
      const color = parts[i].getAttribute('color') as BufferAttribute;
      const expectedColor = expectedParts[i].getAttribute('color') as BufferAttribute;
      expect(color.normalized).toBe(true);
      expect(color.array.constructor).toBe(expectedColor.array.constructor);
      expect(Array.from(color.array as ArrayLike<number>)).toEqual(
        Array.from(expectedColor.array as ArrayLike<number>),
      );
    }
  });
});
