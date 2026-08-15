// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-glb-chunks — read a GLB's JSON chunk and write it back, leaving everything
 * after it byte-identical.
 *
 * A GLB is header (12 B) + JSON chunk + BIN chunk. Component data — every
 * `rv_extras` field the viewer reads — lives entirely in `nodes[i].extras`, i.e.
 * in the JSON chunk. So a scene's property overrides can be baked into a model
 * WITHOUT re-encoding a single vertex: parse the JSON, patch it, re-emit, and
 * copy the tail verbatim.
 *
 * That matters because the alternative — round-tripping through `GLTFExporter`
 * (`rv-import-object.ts`) — re-encodes the whole file. For a 35 MB model that is
 * slow, needs ~3x its size in memory, silently drops meshes whose accessors are
 * empty (see `rv-glb-inspect.ts`), and does not round-trip skinned rigs. None of
 * those risks exist here: the geometry bytes are never decoded at all.
 *
 * The tail is treated as ONE opaque byte range, BIN chunk header included, so
 * its declared length never needs touching. Padding the JSON chunk to 4 bytes
 * keeps the tail 4-byte aligned however much the JSON grew or shrank.
 *
 * The Node-side twin of this module is `scripts/rv-sign-glb.mjs` (`parseGlb` /
 * `rebuildJsonChunk`). The two are deliberately separate — that one is a plain
 * `.mjs` build script working on `Buffer` — and `tests/rv-glb-chunks.node.test.ts`
 * pins them to the same padding and length rules.
 */

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_VERSION = 2;
const GLB_HEADER_BYTES = 12;
const GLB_CHUNK_PREFIX_BYTES = 8;
const GLB_CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const JSON_CHUNK_START = GLB_HEADER_BYTES + GLB_CHUNK_PREFIX_BYTES;

/**
 * Drop a chunk's trailing padding. The spec pads with spaces (0x20) but some
 * exporters pad with NULs, and those DO make `JSON.parse` throw. Trimming every
 * code point at or below 0x20 covers both without a literal control character
 * in this source file.
 */
function stripChunkPadding(text: string): string {
  let end = text.length;
  while (end > 0 && text.charCodeAt(end - 1) <= 0x20) end--;
  return text.slice(0, end);
}

/** A parsed GLB: the decoded JSON chunk plus the untouched tail behind it. */
export interface GlbChunks {
  /** The decoded glTF JSON. Mutate this, then hand it to {@link rebuildGlbWithJson}. */
  json: Record<string, unknown>;
  /** Byte offset of the first chunk after the JSON chunk (the BIN chunk header). */
  restOffset: number;
  /** The original bytes — the source of the verbatim tail. */
  bytes: Uint8Array;
}

/**
 * Parse a binary GLB's JSON chunk. The BIN chunk is never decoded, only located.
 *
 * Throws on anything that is not a well-formed GLB 2.0 with a leading JSON
 * chunk — a patcher that guessed here would write a corrupt file.
 */
export function parseGlbChunks(glb: ArrayBuffer | Uint8Array): GlbChunks {
  const bytes = glb instanceof Uint8Array ? glb : new Uint8Array(glb);
  if (bytes.byteLength < JSON_CHUNK_START) throw new Error('[glb] Too short to be a GLB');

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) throw new Error('[glb] Bad magic — not a binary GLB');
  if (view.getUint32(4, true) !== GLB_VERSION) throw new Error('[glb] Unsupported GLB version');
  if (view.getUint32(8, true) !== bytes.byteLength) throw new Error('[glb] Header length does not match the file');

  const jsonLength = view.getUint32(GLB_HEADER_BYTES, true);
  if (view.getUint32(GLB_HEADER_BYTES + 4, true) !== GLB_CHUNK_TYPE_JSON) {
    throw new Error('[glb] First chunk is not JSON');
  }
  if (jsonLength === 0 || JSON_CHUNK_START + jsonLength > bytes.byteLength) {
    throw new Error('[glb] Malformed GLB JSON chunk');
  }
  // Spec: every chunk length is a multiple of 4. An unaligned one means the
  // tail we are about to copy verbatim is misaligned too — better to refuse
  // than to hand back a file whose BIN chunk starts on a bad boundary.
  if (jsonLength % 4 !== 0) throw new Error('[glb] JSON chunk length is not 4-byte aligned');

  const text = stripChunkPadding(
    new TextDecoder().decode(bytes.subarray(JSON_CHUNK_START, JSON_CHUNK_START + jsonLength)),
  );

  const json = JSON.parse(text) as unknown;
  if (!json || typeof json !== 'object' || Array.isArray(json)) {
    throw new Error('[glb] JSON chunk is not a glTF object');
  }

  return { json: json as Record<string, unknown>, restOffset: JSON_CHUNK_START + jsonLength, bytes };
}

/**
 * Re-emit a GLB with a replaced JSON chunk. Everything from `restOffset` on is
 * copied byte-for-byte, so the BIN chunk of the result is bit-identical to the
 * source's.
 *
 * Mirrors `rebuildJsonChunk` in `scripts/rv-sign-glb.mjs`: compact
 * serialisation, pad to 4 bytes with spaces, recompute only the total length
 * (offset 8) and the JSON chunk length (offset 12).
 */
export function rebuildGlbWithJson(chunks: GlbChunks, json: unknown = chunks.json): Uint8Array {
  const compact = new TextEncoder().encode(JSON.stringify(json));
  const paddedLength = (compact.byteLength + 3) & ~3;
  const rest = chunks.bytes.subarray(chunks.restOffset);

  const out = new Uint8Array(JSON_CHUNK_START + paddedLength + rest.byteLength);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, out.byteLength, true);
  view.setUint32(GLB_HEADER_BYTES, paddedLength, true);
  view.setUint32(GLB_HEADER_BYTES + 4, GLB_CHUNK_TYPE_JSON, true);

  out.fill(0x20, JSON_CHUNK_START, JSON_CHUNK_START + paddedLength); // pad with spaces
  out.set(compact, JSON_CHUNK_START);
  out.set(rest, JSON_CHUNK_START + paddedLength);
  return out;
}

/**
 * The file-global extras object, `scenes[scene ?? 0].extras`.
 *
 * Normative location shared with `scripts/rv-sign-glb.mjs` and the signature
 * verifier — anything that is about the FILE rather than about a node lives
 * here. Returns null when the GLB has no usable default scene.
 */
export function defaultSceneExtras(json: Record<string, unknown>): Record<string, unknown> | null {
  const sceneIndex = (json.scene as number | undefined) ?? 0;
  const scenes = json.scenes as { extras?: unknown }[] | undefined;
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0 || !Array.isArray(scenes) || !scenes[sceneIndex]) return null;
  const extras = scenes[sceneIndex].extras;
  if (!extras || typeof extras !== 'object' || Array.isArray(extras)) return null;
  return extras as Record<string, unknown>;
}

/**
 * The same file-global extras object, created when it does not exist yet.
 *
 * {@link defaultSceneExtras} deliberately answers null for a file that has no
 * usable default scene — a reader must not invent one. A WRITER has the opposite
 * need: `SceneCamera` and the `Connections` block are file-level data (plan-397
 * §2.6 categories 3, 6 and 7) and have to land somewhere even in a GLB whose
 * default scene carries no extras yet. Missing `scenes` / `scene` entries are
 * filled in with the glTF default (`scene: 0`), never guessed at.
 */
export function ensureDefaultSceneExtras(json: Record<string, unknown>): Record<string, unknown> {
  let sceneIndex = (json.scene as number | undefined) ?? 0;
  if (!Number.isInteger(sceneIndex) || sceneIndex < 0) sceneIndex = 0;

  let scenes = json.scenes as Record<string, unknown>[] | undefined;
  if (!Array.isArray(scenes)) {
    scenes = [];
    json.scenes = scenes;
  }
  while (scenes.length <= sceneIndex) scenes.push({});
  if (json.scene === undefined && sceneIndex === 0) json.scene = 0;

  const scene = scenes[sceneIndex];
  const extras = scene.extras;
  if (!extras || typeof extras !== 'object' || Array.isArray(extras)) {
    const fresh: Record<string, unknown> = {};
    scene.extras = fresh;
    return fresh;
  }
  return extras as Record<string, unknown>;
}
