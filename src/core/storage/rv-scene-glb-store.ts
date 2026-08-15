// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-glb-store — scene GLB bodies for the browser backend (plan-397
 * phase 5).
 *
 * ## Bytes in OPFS, one pointer in localStorage
 *
 * The body goes into the content-addressed blob store (`rv-opfs-blobs`),
 * keyed by its SHA-256. What localStorage holds is a **pointer**:
 *
 * ```
 * rv-scene-glb/<sceneId>  ->  { sha, size, updatedAt }
 * ```
 *
 * Two properties fall out of that split, and both are the reason for it:
 *
 *  1. **The write is atomic for free.** Putting the bytes under their digest
 *     cannot damage anything — a digest either is already there or is new,
 *     and either way no existing body is touched. The moment the scene
 *     changes is the single `setItem` that moves the pointer. There is no
 *     window in which the pointer names a half-written body, which is what
 *     §2.8 asks for and what a plain "overwrite the file" cannot give.
 *  2. **The revision is the pointer.** `sha` *is* the content revision, so
 *     the compare-and-swap of §2.8 is a string comparison against a value
 *     that costs nothing to read. No counter to keep, nothing to get out of
 *     step.
 *
 * ## Why not `rv-scenes/…`
 *
 * The prefix is deliberately its own. `rv-scenes/` is the keyspace phase 7
 * takes apart, and its enumerators (`clearAllScenes`, the draft walkers) walk
 * that namespace by prefix — a pointer living there would be swept up by a
 * routine written for op-log bodies, and would muddy the "34 text sites in 10
 * files" analysis that phase is supposed to be able to trust. Same reasoning,
 * same conclusion as `rv-scene-owner/`.
 *
 * ## Failure posture
 *
 * A missing pointer is "no GLB body for this scene", never an error — during
 * the migration window that is the state of every scene in the field. A
 * missing *blob* for an existing pointer is different: it means OPFS was
 * evicted underneath us, and it is reported as a null read so the caller
 * falls back to the legacy body rather than showing an empty scene.
 */

import {
  deleteBlob,
  getBlob,
  putBlob,
  sha256OfBlob,
} from './rv-opfs-blobs';

// ─── Keyspace ───────────────────────────────────────────────────────────

/** Prefix of every pointer key. Deliberately NOT under `rv-scenes/`. */
export const LS_KEY_SCENE_GLB_PREFIX = 'rv-scene-glb/';

function pointerKey(sceneId: string): string {
  return LS_KEY_SCENE_GLB_PREFIX + sceneId;
}

/** What localStorage holds for one scene. */
export interface SceneGlbPointer {
  /** SHA-256 of the body — the blob key **and** the content revision. */
  sha: string;
  /** Body size in bytes, for quota diagnostics without touching OPFS. */
  size: number;
  /** ISO timestamp of the write that installed this pointer. */
  updatedAt: string;
}

// ─── Pointer ────────────────────────────────────────────────────────────

/** The pointer for one scene, or null when it has no GLB body. */
export function readSceneGlbPointer(sceneId: string): SceneGlbPointer | null {
  if (!sceneId) return null;
  let raw: string | null;
  try {
    raw = localStorage.getItem(pointerKey(sceneId));
  } catch {
    return null;
  }
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw) as Partial<SceneGlbPointer> | null;
    if (!parsed || typeof parsed.sha !== 'string' || parsed.sha === '') return null;
    return {
      sha: parsed.sha,
      size: typeof parsed.size === 'number' ? parsed.size : 0,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : '',
    };
  } catch {
    return null;
  }
}

/**
 * The revision of the stored body, or null when there is none.
 *
 * The precondition read of §2.8, and cheap on purpose: a compare-and-swap
 * that had to fetch the body to learn its revision would make every save read
 * the whole scene back first.
 */
export function sceneGlbRevision(sceneId: string): string | null {
  return readSceneGlbPointer(sceneId)?.sha ?? null;
}

// ─── Body ───────────────────────────────────────────────────────────────

/**
 * The GLB body for one scene, or null when absent.
 *
 * Null covers both "no pointer" and "pointer but the blob is gone" — an
 * evicted OPFS looks to the caller exactly like a scene that was never
 * converted, which is the behaviour that keeps a legacy fallback usable.
 */
export async function readSceneGlb(sceneId: string): Promise<Uint8Array | null> {
  const pointer = readSceneGlbPointer(sceneId);
  if (!pointer) return null;
  const blob = await getBlob(pointer.sha);
  if (!blob) return null;
  return new Uint8Array(await blob.arrayBuffer());
}

/**
 * Store a GLB body and move the pointer to it.
 *
 * The order matters and is the atomicity argument: bytes first (harmless),
 * pointer second (the commit). An interrupted call leaves an unreferenced
 * blob — wasted space, never a corrupt scene.
 *
 * @returns the new revision (the body's SHA-256).
 */
export async function writeSceneGlb(sceneId: string, glb: Uint8Array): Promise<string> {
  if (!sceneId) throw new Error('writeSceneGlb needs a scene id.');
  const blob = new Blob([glb as unknown as BlobPart], { type: 'model/gltf-binary' });
  const sha = await sha256OfBlob(blob);
  await putBlob(sha, blob);

  const previous = readSceneGlbPointer(sceneId);
  const pointer: SceneGlbPointer = { sha, size: blob.size, updatedAt: new Date().toISOString() };
  try {
    localStorage.setItem(pointerKey(sceneId), JSON.stringify(pointer));
  } catch (e) {
    // A pointer that cannot be written means the body is unreachable, which
    // is a failed save — unlike the ownership marker, this one must NOT be
    // swallowed: the caller would report "Saved" for a scene nobody can open.
    throw new Error(`Could not record the scene body for ${sceneId}: ${String(e)}`);
  }
  // Only once the pointer is safely moved is the old body garbage.
  if (previous && previous.sha !== sha) await deleteBlob(previous.sha).catch(() => {});
  return sha;
}

/** Drop the pointer and the body. Idempotent. */
export async function deleteSceneGlb(sceneId: string): Promise<void> {
  const pointer = readSceneGlbPointer(sceneId);
  try {
    localStorage.removeItem(pointerKey(sceneId));
  } catch { /* private mode — the blob cleanup below is still worth doing */ }
  if (pointer) await deleteBlob(pointer.sha).catch(() => {});
}

/** Every scene id that currently has a GLB body. Test/cleanup utility. */
export function listSceneGlbIds(): string[] {
  const out: string[] = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && k.startsWith(LS_KEY_SCENE_GLB_PREFIX)) {
        out.push(k.slice(LS_KEY_SCENE_GLB_PREFIX.length));
      }
    }
  } catch { /* ignore */ }
  return out;
}
