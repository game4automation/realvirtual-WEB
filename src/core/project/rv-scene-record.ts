// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-scene-record — what a `ProjectBackend` hands over for one scene, once a
 * scene **is** a GLB (plan-397 §2.7, phase 5).
 *
 * ## Why the backend contract had to change rather than grow
 *
 * `ProjectBackend.readScene()` returned `RvScene | null` and `writeScene()`
 * took an `RvScene`. That is not a container that a GLB body fits into with
 * an extra field: `RvScene` is the *op-log* record (`base` + `edits.ops`),
 * and plan-397's whole point is that the op-log stops being the persisted
 * form. A backend that keeps handing back `RvScene` can only ever serve the
 * old world.
 *
 * So the scene surface now speaks {@link SceneRecord}: **bytes plus manifest
 * metadata plus a revision**. Nothing about it knows what an op is.
 *
 * ## The `legacy` fallback is gone (plan-413 phase 6)
 *
 * Through plan-397 a record could answer with either GLB bytes or the pre-397
 * `RvScene` JSON, because the installed base was still JSON. It is not: phase 3
 * converted the shipped examples, plan-397 phase 7 converted the field, and the
 * reader for what did not make it went with this phase. A record is bytes now,
 * and a stored JSON body gets `LegacyFormatError` from whichever reader meets
 * it first — which is a sentence naming the release that can still convert,
 * rather than a `null` that reads as "no such scene".
 *
 * ## Revisions: a content hash, not a counter
 *
 * §2.8 asks for an optimistic compare-and-swap. A counter would have to be
 * stored somewhere that both a browser tab and a `git pull` respect, and
 * nothing like that exists here. The SHA-256 of the stored bytes does the job
 * without any bookkeeping at all: it is identical iff the content is
 * identical, it survives a checkout, and an external editor writing the file
 * changes it by construction. That last property is what turns "someone
 * edited the project folder behind our back" from an undetectable event into
 * an ordinary precondition failure.
 *
 * Three write intents, distinguished by `expectedRevision`:
 *
 * | value | means | fails when |
 * |---|---|---|
 * | a revision | "I read this and am replacing it" | stored revision differs |
 * | `null` | "this is new" | anything is stored |
 * | `undefined` | "unconditional" — migration and import only | never |
 *
 * `undefined` is deliberately the awkward one to reach for: it is the escape
 * hatch a migrator needs and the exact mistake an editor must not make.
 */

import type { RvProjectSceneEntry } from './rv-project-types';

// ─── Revision ───────────────────────────────────────────────────────────

/** Content revision of a stored scene body: lowercase hex SHA-256. */
export type SceneRevision = string;

const SHA256_RE = /^[0-9a-f]{64}$/;

/** True for a well-formed revision token. */
export function isSceneRevision(value: unknown): value is SceneRevision {
  return typeof value === 'string' && SHA256_RE.test(value.toLowerCase());
}

/**
 * Revision of a byte body.
 *
 * Kept here rather than imported from `rv-opfs-blobs` on purpose: a revision
 * is a property of the *contract*, and every backend needs it including the
 * ones that never touch OPFS. `sha256OfBlob` computes the same digest for the
 * blob store's own key — same algorithm, two independent reasons to exist.
 */
/**
 * The `ArrayBuffer` behind a `Uint8Array`, without copying where possible.
 *
 * `DocumentRecord.bytes` is a `Uint8Array` (plan-736) while several older
 * consumers — the GLB chunk reader, `ProjectAssetSource`, the MCP file tools —
 * are typed on `ArrayBuffer`. A whole-buffer view hands its buffer over
 * directly; a partial view is copied, because handing over a buffer that is
 * larger than the view would silently change what the consumer reads.
 */
export function arrayBufferOf(bytes: Uint8Array): ArrayBuffer {
  return bytes.byteOffset === 0 && bytes.byteLength === bytes.buffer.byteLength
    ? (bytes.buffer as ArrayBuffer)
    : (bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer);
}

export async function revisionOfBytes(bytes: Uint8Array | ArrayBuffer): Promise<SceneRevision> {
  const digest = await crypto.subtle.digest('SHA-256', bytes as BufferSource);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, '0')).join('');
}

// ─── Record ─────────────────────────────────────────────────────────────

/** One scene as a backend sees it: bytes, metadata, revision. */
export interface SceneRecord {
  /** The scene body as GLB bytes. */
  glb: Uint8Array;
  /** Manifest metadata for this scene (id, name, path, timestamps, …). */
  meta: RvProjectSceneEntry;
  /** Revision of what was read. Hand it back as {@link SceneWrite.expectedRevision}. */
  revision: SceneRevision;
}

/** A scene body on its way into a backend. GLB only, by design. */
export interface SceneWrite {
  /** The GLB body. */
  glb: Uint8Array;
  /** Metadata the manifest should carry for this scene. */
  meta: RvProjectSceneEntry;
  /** See the table in the file header. */
  expectedRevision?: SceneRevision | null;
}

// ─── Conflict ───────────────────────────────────────────────────────────

/**
 * A write whose precondition did not hold — someone else wrote first.
 *
 * Deliberately **not** a subclass of `BackendNotWritableError`: that one says
 * "you may not write here at all", this one says "your write is based on a
 * state that no longer exists". The caller's answer differs (re-read and
 * merge vs. give up), so conflating them would produce the wrong recovery.
 */
export class SceneRevisionConflictError extends Error {
  constructor(
    readonly relPath: string,
    readonly expected: SceneRevision | null,
    readonly actual: SceneRevision | null,
  ) {
    super(
      expected === null
        ? `"${relPath}" already exists (revision ${short(actual)}) — expected it to be new.`
        : actual === null
          ? `"${relPath}" no longer exists — expected revision ${short(expected)}.`
          : `"${relPath}" changed since it was read (expected ${short(expected)}, found ${short(actual)}).`,
    );
    this.name = 'SceneRevisionConflictError';
  }
}

function short(rev: SceneRevision | null): string {
  return rev ? rev.slice(0, 12) : '(none)';
}

/**
 * The one precondition gate every backend write calls.
 *
 * `undefined` passes unconditionally; everything else is compared exactly.
 * Centralised so the three backends cannot drift on what "conflict" means —
 * and so a fourth one gets it right for free.
 */
export function assertRevisionPrecondition(
  relPath: string,
  expected: SceneRevision | null | undefined,
  actual: SceneRevision | null,
): void {
  if (expected === undefined) return;
  const want = expected === null ? null : expected.toLowerCase();
  const have = actual === null ? null : actual.toLowerCase();
  if (want === have) return;
  throw new SceneRevisionConflictError(relPath, want, have);
}

// ─── Construction helpers ───────────────────────────────────────────────

/**
 * Wrap GLB bytes as a record.
 *
 * `id` and `name` fall back to `''` rather than being invented from the
 * filename. An empty id means "the manifest does not describe this path" —
 * a real state (a GLB dropped into `scenes/` by hand), and one a caller must
 * be able to tell from a scene that genuinely is called nothing.
 */
export async function glbSceneRecord(
  glb: Uint8Array,
  meta: Partial<RvProjectSceneEntry> & { path: string },
  revision?: SceneRevision,
): Promise<SceneRecord> {
  return {
    glb,
    meta: { id: '', name: '', ...meta },
    revision: revision ?? (await revisionOfBytes(glb)),
  };
}
