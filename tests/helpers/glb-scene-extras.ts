// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * A structurally valid GLB whose default scene carries arbitrary
 * `extras.realvirtual` — the plan-506 generalisation of
 * `glbWithClassification` in `folder-backend-lazy-classification.test.ts`
 * (which stays as it is: it is a regression guard with its own history).
 *
 * `binBytes` pads a BIN chunk onto the tail so "read the header" and "read the
 * file" are different amounts of work even in a fake. `lastModified` makes the
 * result a `File`, so the fake folder handle reports an mtime and the
 * `(size, mtime)` pre-filter can actually clear.
 */

import type { FakeDir } from './fake-fs-handles';

export function glbWithSceneExtras(
  realvirtual: Record<string, unknown>,
  binBytes = 4096,
  lastModified?: number,
): Blob {
  const json = { asset: { version: '2.0' }, scene: 0, scenes: [{ extras: { realvirtual } }] };
  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const pad = (4 - (jsonBytes.length % 4)) % 4;
  const jsonLen = jsonBytes.length + pad;
  const binChunk = binBytes > 0 ? 8 + binBytes : 0;
  const total = 12 + 8 + jsonLen + binChunk;

  const buf = new ArrayBuffer(total);
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  view.setUint32(0, 0x46546c67, true);        // 'glTF'
  view.setUint32(4, 2, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLen, true);
  view.setUint32(16, 0x4e4f534a, true);       // 'JSON'
  bytes.set(jsonBytes, 20);
  bytes.fill(0x20, 20 + jsonBytes.length, 20 + jsonLen);
  if (binBytes > 0) {
    const at = 20 + jsonLen;
    view.setUint32(at, binBytes, true);
    view.setUint32(at + 4, 0x004e4942, true); // 'BIN\0'
  }
  return lastModified === undefined
    ? new Blob([buf])
    : new File([buf], 'model.glb', { lastModified });
}

/** Seed a binary file through the writable stream — `seedText` is text-only. */
export async function seedBlob(dir: FakeDir, name: string, blob: Blob): Promise<void> {
  const handle = await dir.getFileHandle(name, { create: true });
  const writable = await handle.createWritable();
  await writable.write(blob);
  await writable.close();
}
