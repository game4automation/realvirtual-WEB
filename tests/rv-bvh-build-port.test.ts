// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { BufferAttribute, BufferGeometry } from 'three';
import { MeshBVH } from 'three-mesh-bvh';
import { createBVHPort, isTransferSafeGeometry, type BVHBuildPort } from '../src/core/engine/rv-bvh-build-port';

// Exercise the REAL library runTask and (in the negative control) WorkerBase.
// Only the transport is fake: transfer detaches real ArrayBuffers synchronously.
class Transport {
  static instances: Transport[] = [];
  static onCreate: (() => void) | undefined;
  onmessage: ((e: { data: unknown }) => void) | null = null;
  onerror: ((e: { message: string }) => void) | null = null;
  onmessageerror: ((e: { data: unknown }) => void) | null = null;
  terminated = false;
  posts = 0;
  data: any;
  constructor() { Transport.instances.push(this); Transport.onCreate?.(); }
  postMessage(data: unknown, transfer: Transferable[]) {
    this.posts++;
    this.data = structuredClone(data, { transfer });
  }
  terminate() { this.terminated = true; }
  finish() {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new BufferAttribute(this.data.position, 3));
    if (this.data.index) geometry.setIndex(new BufferAttribute(this.data.index, 1));
    const bvh = new MeshBVH(geometry, this.data.options);
    this.onmessage?.({ data: { serialized: MeshBVH.serialize(bvh), position: this.data.position } });
  }
}
function geometry() {
  const g = new BufferGeometry();
  g.setAttribute('position', new BufferAttribute(new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]), 3));
  g.setIndex([0, 1, 2]);
  return g;
}
async function until(predicate: () => boolean) {
  for (let n = 0; n < 200; n++) {
    if (predicate()) return;
    await new Promise(r => setTimeout(r, 5));
  }
  throw new Error('transport did not reach expected state');
}
const ports: BVHBuildPort[] = [];
function port() { const p = createBVHPort(); ports.push(p); return p; }
let unhandled: unknown[];
const onUnhandled = (e: PromiseRejectionEvent) => { unhandled.push(e.reason); };
beforeEach(() => {
  Transport.instances = [];
  Transport.onCreate = undefined;
  vi.stubGlobal('Worker', Transport);
  unhandled = [];
  window.addEventListener('unhandledrejection', onUnhandled);
});
afterEach(async () => {
  for (const p of ports.splice(0)) p.dispose();
  // Let the browser dispatch unhandledrejection, without suppressing it.
  await new Promise(r => setTimeout(r, 30));
  window.removeEventListener('unhandledrejection', onUnhandled);
  vi.unstubAllGlobals();
  expect(unhandled).toEqual([]);
});

describe('BVH worker buffer ownership and settlement', () => {
  it('rejects detached buffers before posting (including a second port sharing a geometry)', async () => {
    const g = geometry();
    const first = port();
    const firstResult = first.generate(g).catch(e => e);
    await until(() => Transport.instances[0]?.posts === 1);
    expect(g.getAttribute('position').array.byteLength).toBe(0);
    expect(isTransferSafeGeometry(g)).toBe(false);
    await expect(port().generate(g)).rejects.toThrow('detached');
    expect(Transport.instances).toHaveLength(1);
    first.dispose();
    expect(await firstResult).toBeInstanceOf(Error);
    await first.whenIdle?.();
    expect(g.getAttribute('position').array.byteLength).toBe(36);
    expect(Array.from(g.index!.array)).toEqual([0, 1, 2]);
  });

  it('distinguishes empty buffers from detached position and index buffers', async () => {
    const empty = new BufferGeometry();
    empty.setAttribute('position', new BufferAttribute(new Float32Array(0), 3));
    expect(isTransferSafeGeometry(empty)).toBe(true);
    for (const which of ['position', 'index']) {
      const g = geometry();
      const buffer = which === 'position' ? g.getAttribute('position').array.buffer : g.index!.array.buffer;
      structuredClone(buffer, { transfer: [buffer as ArrayBuffer] });
      expect(isTransferSafeGeometry(g)).toBe(false);
      await expect(port().generate(g)).rejects.toThrow('detached');
    }
    expect(Transport.instances).toHaveLength(0);
  });

  it('settles active and queued jobs on teardown and restores transferred buffers', async () => {
    const p = port();
    const g = geometry();
    const active = p.generate(g).catch(e => e);
    const queued = p.generate(geometry()).catch(e => e);
    await until(() => Transport.instances[0]?.posts === 1);
    p.dispose();
    p.dispose();
    expect(await active).toBeInstanceOf(Error);
    expect(await queued).toBeInstanceOf(Error);
    await p.whenIdle?.();
    expect(Transport.instances[0].posts).toBe(1);
    expect(Transport.instances[0].terminated).toBe(true);
    expect(g.getAttribute('position').array.byteLength).toBe(36);
  });

  it('does not post when disposed while the lazy worker is being created', async () => {
    const p = port();
    Transport.onCreate = () => p.dispose();
    await expect(p.generate(geometry())).rejects.toThrow('disposed');
    expect(Transport.instances[0].posts).toBe(0);
    expect(Transport.instances[0].terminated).toBe(true);
  });

  it('rechecks the epoch after lazy initialization and before queued jobs', async () => {
    const p = port();
    let stale = false;
    Transport.onCreate = () => { stale = true; };
    await expect(p.generate(geometry(), { shouldAbort: () => stale })).rejects.toThrow('stale');
    expect(Transport.instances[0].posts).toBe(0);
    await expect(p.generate(geometry(), { shouldAbort: () => stale })).rejects.toThrow('stale');
  });

  it('retires a worker that fails before runTask after creation made the request stale', async () => {
    const p = port();
    let stale = false;
    Transport.onCreate = () => { stale = true; };
    await expect(p.generate(geometry(), { shouldAbort: () => stale })).rejects.toThrow('stale');
    const transport = Transport.instances[0];
    expect(transport.posts).toBe(0);
    const next = p.generate(geometry());
    expect(() => transport.onerror?.({ message: 'module failed to load' })).not.toThrow();
    expect(transport.terminated).toBe(true);
    expect(await next).toBeInstanceOf(MeshBVH);
    expect(await p.generate(geometry())).toBeInstanceOf(MeshBVH);
    await p.whenIdle?.();
    expect(Transport.instances).toHaveLength(1);
    expect(transport.posts).toBe(0);
  });

  it('settles an active messageerror and queued jobs inline, restoring transferred buffers', async () => {
    const p = port();
    const g = geometry();
    const active = p.generate(g);
    const queued = p.generate(geometry());
    const idle = p.whenIdle?.();
    await until(() => Transport.instances[0]?.posts === 1);
    const transport = Transport.instances[0];
    expect(g.getAttribute('position').array.byteLength).toBe(0);
    expect(() => transport.onmessageerror?.({ data: null })).not.toThrow();
    expect(transport.terminated).toBe(true);
    expect(await active).toBeInstanceOf(MeshBVH);
    expect(await queued).toBeInstanceOf(MeshBVH);
    expect(g.getAttribute('position').array.byteLength).toBe(36);
    expect(Array.from(g.index!.array)).toEqual([0, 1, 2]);
    await idle;
    expect(await p.generate(geometry())).toBeInstanceOf(MeshBVH);
    await p.whenIdle?.();
    expect(Transport.instances).toHaveLength(1);
    expect(transport.posts).toBe(1);
  });

  it('restores the idle error handler after a successful runTask', async () => {
    const p = port();
    const result = p.generate(geometry());
    await until(() => Transport.instances[0]?.posts === 1);
    const transport = Transport.instances[0];
    transport.finish();
    expect(await result).toBeInstanceOf(MeshBVH);
    expect(() => transport.onerror?.({ message: 'worker died while idle' })).not.toThrow();
    expect(transport.terminated).toBe(true);
    expect(await p.generate(geometry())).toBeInstanceOf(MeshBVH);
    await p.whenIdle?.();
    expect(Transport.instances).toHaveLength(1);
    expect(transport.posts).toBe(1);
  });

  it('handles a real runTask rejection without the library finally rejection, then falls back', async () => {
    const p = port();
    const g = geometry();
    const result = p.generate(g);
    await until(() => Transport.instances[0]?.posts === 1);
    Transport.instances[0].onerror?.({ message: 'deterministic worker failure after transfer' });
    expect(await result).toBeInstanceOf(MeshBVH);
    expect(g.getAttribute('position').array.byteLength).toBe(36);
    expect(Transport.instances[0].terminated).toBe(true);
    expect(await p.generate(geometry())).toBeInstanceOf(MeshBVH);
    expect(Transport.instances).toHaveLength(1);
  });

  it('retires a failing worker even when the request went stale meanwhile; the next load builds inline', async () => {
    const p = port();
    let stale = false;
    const g = geometry();
    const result = p.generate(g, { shouldAbort: () => stale }).catch(e => e);
    await until(() => Transport.instances[0]?.posts === 1);
    stale = true;
    Transport.instances[0].onerror?.({ message: 'worker died after the load changed' });
    expect(await result).toMatchObject({ message: expect.stringContaining('stale') });
    expect(Transport.instances[0].terminated).toBe(true);
    expect(g.getAttribute('position').array.byteLength).toBe(36);
    expect(await p.generate(geometry())).toBeInstanceOf(MeshBVH);
    await p.whenIdle?.();
    expect(Transport.instances).toHaveLength(1);
  });

  it('handles postMessage throwing DataCloneError without an orphaned finally promise', async () => {
    const post = vi.spyOn(Transport.prototype, 'postMessage').mockImplementation(() => {
      throw new DOMException('deterministic post failure', 'DataCloneError');
    });
    try {
      expect(await port().generate(geometry())).toBeInstanceOf(MeshBVH);
      expect(post).toHaveBeenCalledTimes(1);
    } finally {
      post.mockRestore();
    }
  });

  it.each([true, false])('restores a successful worker result (transferable=%s)', async transferable => {
    const p = port();
    const g = geometry();
    const result = p.generate(g, { transferable });
    await until(() => Transport.instances[0]?.posts === 1);
    expect(g.getAttribute('position').array.byteLength).toBe(transferable ? 0 : 36);
    Transport.instances[0].finish();
    const tree = await result as MeshBVH;
    expect(tree).toBeInstanceOf(MeshBVH);
    expect(tree.geometry).toBe(g);
    expect(tree.indirect).toBe(!transferable);
    expect(Array.from(g.index!.array)).toEqual([0, 1, 2]);
  });
});
