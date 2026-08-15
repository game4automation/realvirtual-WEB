// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * scene-write — build a `SceneWrite` for a backend test (plan-397 phase 5).
 *
 * The bytes are a stand-in, deliberately. Nothing in the storage layer parses
 * a scene body — that is the whole point of §2.7 — so pinning a real GLB here
 * would test the exporter instead of the contract, and would make every
 * backend test depend on `bakeIntoGlb`. What the bytes must be is **distinct
 * per (id, name)**, so a revision comparison has something to tell apart.
 */

import type { SceneWrite } from '../../src/core/project/rv-scene-record';
import type { RvScene } from '../../src/core/hmi/scene/rv-scene-types';

export function glbBytes(id: string, name = id): Uint8Array {
  return new TextEncoder().encode(`glTF-stand-in:${id}:${name}`);
}

export function glbWrite(
  id: string,
  name = id,
  expectedRevision?: string | null,
): SceneWrite {
  return {
    glb: glbBytes(id, name),
    meta: { id, name, path: id },
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  };
}

/** The same, for a test that already holds an `RvScene` fixture. */
export function glbWriteFor(scene: RvScene, expectedRevision?: string | null): SceneWrite {
  return {
    glb: glbBytes(scene.id, scene.name),
    meta: { id: scene.id, name: scene.name, path: scene.id },
    ...(expectedRevision !== undefined ? { expectedRevision } : {}),
  };
}
