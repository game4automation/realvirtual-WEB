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
  /**
   * The revision of the document FILE this body was baked from (plan-546).
   *
   * Only a document's draft slot carries it. Absent on every pointer written
   * before plan-546 and on every write whose caller knew no file revision —
   * never carried over from the previous pointer, because a stamp that
   * survives a write it does not describe is worse than none.
   */
  baseSha?: string;
  /**
   * ISO timestamp of the move that put this pointer into a set-aside slot
   * (`draft/~stale/<documentId>/<sha12>`, plan-546). Absent everywhere else.
   */
  movedAt?: string;
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
      ...(typeof parsed.baseSha === 'string' && parsed.baseSha !== '' ? { baseSha: parsed.baseSha } : {}),
      ...(typeof parsed.movedAt === 'string' && parsed.movedAt !== '' ? { movedAt: parsed.movedAt } : {}),
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
export async function writeSceneGlb(
  sceneId: string,
  glb: Uint8Array,
  meta: { baseSha?: string } = {},
): Promise<string> {
  if (!sceneId) throw new Error('writeSceneGlb needs a scene id.');
  const blob = new Blob([glb as unknown as BlobPart], { type: 'model/gltf-binary' });
  const sha = await sha256OfBlob(blob);
  await putBlob(sha, blob);

  const previous = readSceneGlbPointer(sceneId);
  const pointer: SceneGlbPointer = {
    sha,
    size: blob.size,
    updatedAt: new Date().toISOString(),
    // Only what THIS write was told — never the previous pointer's stamp.
    ...(meta.baseSha ? { baseSha: meta.baseSha } : {}),
  };
  try {
    localStorage.setItem(pointerKey(sceneId), JSON.stringify(pointer));
  } catch (e) {
    // A pointer that cannot be written means the body is unreachable, which
    // is a failed save — unlike the ownership marker, this one must NOT be
    // swallowed: the caller would report "Saved" for a scene nobody can open.
    throw new Error(`Could not record the scene body for ${sceneId}: ${String(e)}`);
  }
  // Only once the pointer is safely moved is the old body garbage — and only
  // when no other pointer still names it (plan-546 AC 13).
  if (previous && previous.sha !== sha) await deleteBlobIfUnreferenced(previous.sha);
  return sha;
}

/** Drop the pointer and the body. Idempotent. */
export async function deleteSceneGlb(sceneId: string): Promise<void> {
  const pointer = readSceneGlbPointer(sceneId);
  try {
    localStorage.removeItem(pointerKey(sceneId));
  } catch { /* private mode — the blob cleanup below is still worth doing */ }
  if (pointer) await deleteBlobIfUnreferenced(pointer.sha);
}

/**
 * Is `sha` still named by any `rv-scene-glb/` pointer? (plan-546 AC 13)
 *
 * Bodies are content-addressed, so two pointers can name the same blob — a
 * draft and the set-aside copy of it, or two identical bakes. Deleting the blob
 * because ONE of them went away would empty the other. Called after the
 * caller's own pointer is already gone (or moved off `sha`), so any hit is
 * somebody else's.
 */
function isShaReferenced(sha: string): boolean {
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(LS_KEY_SCENE_GLB_PREFIX)) continue;
      if (readSceneGlbPointer(k.slice(LS_KEY_SCENE_GLB_PREFIX.length))?.sha === sha) return true;
    }
  } catch {
    // A storage we cannot scan cannot prove the blob unreferenced, and keeping
    // an orphan costs space while deleting a live body costs work.
    return true;
  }
  return false;
}

/** Delete a body blob unless another pointer still names it. Never throws. */
async function deleteBlobIfUnreferenced(sha: string): Promise<void> {
  if (isShaReferenced(sha)) return;
  await deleteBlob(sha).catch(() => {});
}

/** Outcome of {@link moveSceneGlbPointer}. */
export type SceneGlbMoveResult =
  /** `from` now lives at `to`; `from` is gone. */
  | 'moved'
  /** `to` already named the same body, so only `from` was dropped. */
  | 'same'
  /** `from` no longer held `expectedSha`, or `to` holds a different body. */
  | 'conflict';

/** Metadata changes a move applies to the moved pointer; `null` removes a field. */
export interface SceneGlbMoveStamp {
  baseSha?: string | null;
  movedAt?: string | null;
  updatedAt?: string;
}

/**
 * Move a pointer to another slot, compare-and-swap on its sha (plan-546).
 *
 * Moves only when `from` still names `expectedSha` and `to` is empty. When `to`
 * already names the same body the move is complete in substance, so `from` is
 * dropped and the result says `same`. NEVER deletes a blob: the body is the
 * same content-addressed bytes before and after, only the name changes.
 */
export function moveSceneGlbPointer(
  from: string,
  to: string,
  expectedSha: string,
  stamp: SceneGlbMoveStamp = {},
): SceneGlbMoveResult {
  if (!from || !to || from === to) return 'conflict';
  const source = readSceneGlbPointer(from);
  if (!source || source.sha !== expectedSha) return 'conflict';
  const target = readSceneGlbPointer(to);
  try {
    if (target) {
      if (target.sha !== source.sha) return 'conflict';
      localStorage.removeItem(pointerKey(from));
      return 'same';
    }
    const moved: SceneGlbPointer = { ...source };
    if (stamp.updatedAt) moved.updatedAt = stamp.updatedAt;
    if (stamp.baseSha === null) delete moved.baseSha;
    else if (typeof stamp.baseSha === 'string' && stamp.baseSha) moved.baseSha = stamp.baseSha;
    if (stamp.movedAt === null) delete moved.movedAt;
    else if (typeof stamp.movedAt === 'string' && stamp.movedAt) moved.movedAt = stamp.movedAt;
    // Write-new, then remove-old: interrupted in between, both keys name the
    // same blob, which duplicates a name and loses nothing.
    localStorage.setItem(pointerKey(to), JSON.stringify(moved));
    localStorage.removeItem(pointerKey(from));
    return 'moved';
  } catch {
    return 'conflict';
  }
}

/** Every slot id under `prefix` (e.g. `draft/~stale/<documentId>/`). */
export function listSceneGlbSlots(prefix: string): string[] {
  return listSceneGlbIds().filter(id => id.startsWith(prefix));
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
