// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-binary-resources — non-geometry binary payloads that travel INSIDE a GLB
 * (plan-498): today the `.fmu` packages of `Fmu` components.
 *
 * ## Why a store and not `userData`
 *
 * An FMU package is megabytes of opaque bytes. Parking it on a node's
 * `userData` would copy it on every `Object3D.clone()` (userData is JSON
 * round-tripped), once per placement and once per bake template — the
 * opposite of "one copy per SHA". So the bytes live HERE, keyed by their
 * SHA-256, and a node only carries the SHA (`Fmu.FmuEmbed.sha256`).
 *
 * ## How bytes get in
 *
 *  - **Loading:** every GLB parse of the viewer goes through ONE wrapper,
 *    {@link parseGlbCollectingResources}. It looks for `Fmu.FmuEmbed` records in
 *    the JSON chunk, slices the referenced `bufferViews` out of the BIN chunk
 *    and puts them into {@link binaryResources} BEFORE the GLTFLoader parses the
 *    file (the parser is dropped right after the parse, so there is no later
 *    chance). `tests/rv-binary-resources.test.ts` pins that no other
 *    `parseAsync` exists in `src/` (the lint half of the plan's risk 5.1).
 *  - **Authoring:** the editor attach op puts the bytes of the chosen file
 *    directly (`rv-fmu-ops.ts`).
 *
 * ## How bytes get out
 *
 * The asset writer (`rv-asset-glb-export.ts`) asks the store for every SHA the
 * document references and appends one bufferView per SHA with
 * {@link rebuildGlbAppendingBufferViews} — a standard glTF bufferView in the BIN
 * chunk, the `KHR_audio` pattern for non-geometry bytes.
 *
 * ## Lifetime
 *
 * Every entry records which DOCUMENTS hold it (`documentIds`). A document id is
 * whatever the parse entry names its source (`glb:<url>` for the main model,
 * `model-cache:<key>` for a placement master, the editor document id for an
 * attach). {@link BinaryResourceStore.releaseDocument} drops the document from
 * every entry and frees an entry no document holds any more.
 */

// ─── GLB constants ──────────────────────────────────────────────────────

const GLB_MAGIC = 0x46546c67; // 'glTF'
const GLB_VERSION = 2;
const GLB_HEADER_BYTES = 12;
const CHUNK_PREFIX_BYTES = 8;
const CHUNK_TYPE_JSON = 0x4e4f534a; // 'JSON'
const CHUNK_TYPE_BIN = 0x004e4942; // 'BIN\0'

/** The ASCII spelling of the key {@link collectFmuEmbeds} looks for — a cheap
 *  byte pre-check so a model without FMUs never pays a second JSON.parse. */
const FMU_EMBED_NEEDLE = new TextEncoder().encode('"FmuEmbed"');

// ─── Types ──────────────────────────────────────────────────────────────

/** One binary payload in the store. */
export interface BinaryResource {
  sha256: string;
  bytes: Uint8Array;
  byteLength: number;
  /** Documents that hold this payload — see {@link BinaryResourceStore.releaseDocument}. */
  documentIds: Set<string>;
}

/** A bufferView a caller wants sliced out of a GLB. */
export interface WantedBufferView {
  bufferView: number;
  byteLength: number;
  sha256: string;
}

/** Loader shape the wrapper needs — `GLTFLoader` and the model-cache test fakes. */
export interface GlbParseLoader<T> {
  parseAsync(data: ArrayBuffer, path: string): Promise<T>;
}

/** The decoded chunks of a GLB — JSON parsed, BIN only located. */
interface GlbParts {
  json: Record<string, unknown>;
  /** BIN chunk DATA (without its 8-byte prefix), or null when the file has none. */
  bin: Uint8Array | null;
}

// ─── GLB reading ────────────────────────────────────────────────────────

/** Byte offset + length of the JSON chunk and the optional BIN chunk. */
interface GlbLayout {
  json: Uint8Array;
  bin: Uint8Array | null;
}

/**
 * Locate the JSON and BIN chunks of a binary glTF. Returns a reason string
 * instead of throwing — every caller here is best-effort and must never take a
 * model load down.
 */
function locateChunks(glb: Uint8Array): GlbLayout | string {
  if (glb.byteLength < GLB_HEADER_BYTES + CHUNK_PREFIX_BYTES) return 'too short to be a GLB';
  const view = new DataView(glb.buffer, glb.byteOffset, glb.byteLength);
  if (view.getUint32(0, true) !== GLB_MAGIC) return 'bad magic (not a binary glTF)';
  if (view.getUint32(4, true) !== GLB_VERSION) return 'unsupported GLB version';
  const total = Math.min(view.getUint32(8, true), glb.byteLength);

  let json: Uint8Array | null = null;
  let bin: Uint8Array | null = null;
  let offset = GLB_HEADER_BYTES;
  while (offset + CHUNK_PREFIX_BYTES <= total) {
    const length = view.getUint32(offset, true);
    const type = view.getUint32(offset + 4, true);
    const start = offset + CHUNK_PREFIX_BYTES;
    if (start + length > total) return 'chunk exceeds the file';
    if (type === CHUNK_TYPE_JSON && !json) json = glb.subarray(start, start + length);
    else if (type === CHUNK_TYPE_BIN && !bin) bin = glb.subarray(start, start + length);
    offset = start + length;
  }
  if (!json) return 'no JSON chunk';
  return { json, bin };
}

function decodeJson(chunk: Uint8Array): Record<string, unknown> | string {
  try {
    // Spaces (spec) or NULs (some exporters) pad the chunk; both are whitespace
    // for JSON.parse once NULs are trimmed.
    let end = chunk.byteLength;
    while (end > 0 && chunk[end - 1] <= 0x20) end--;
    const parsed = JSON.parse(new TextDecoder().decode(chunk.subarray(0, end))) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return 'JSON chunk is not an object';
    return parsed as Record<string, unknown>;
  } catch (e) {
    return `JSON chunk does not parse (${(e as Error).message})`;
  }
}

function readGlb(glb: Uint8Array): GlbParts | string {
  const layout = locateChunks(glb);
  if (typeof layout === 'string') return layout;
  const json = decodeJson(layout.json);
  if (typeof json === 'string') return json;
  return { json, bin: layout.bin };
}

/** True when `needle` occurs in `haystack` (native `indexOf` on the first byte). */
function bytesContain(haystack: Uint8Array, needle: Uint8Array): boolean {
  const first = needle[0];
  const last = haystack.byteLength - needle.byteLength;
  let i = haystack.indexOf(first);
  while (i !== -1 && i <= last) {
    let j = 1;
    while (j < needle.byteLength && haystack[i + j] === needle[j]) j++;
    if (j === needle.byteLength) return true;
    i = haystack.indexOf(first, i + 1);
  }
  return false;
}

function sliceBufferViews(parts: GlbParts, wanted: readonly WantedBufferView[]): BinaryResource[] {
  const views = Array.isArray(parts.json.bufferViews)
    ? parts.json.bufferViews as Array<Record<string, unknown>>
    : [];
  const out: BinaryResource[] = [];
  for (const w of wanted) {
    const def = views[w.bufferView];
    if (!Number.isInteger(w.bufferView) || w.bufferView < 0 || !def) {
      console.warn(`[binary-resources] bufferView ${w.bufferView} (sha ${short(w.sha256)}) is out of range — skipped`);
      continue;
    }
    if ((def.buffer ?? 0) !== 0 || !parts.bin) {
      console.warn(`[binary-resources] bufferView ${w.bufferView} is not in the GLB BIN chunk — skipped`);
      continue;
    }
    const byteOffset = (def.byteOffset as number | undefined) ?? 0;
    const viewLength = (def.byteLength as number | undefined) ?? 0;
    // The view may be PADDED beyond the payload; the payload's own length is
    // authoritative, but it must fit inside the view.
    const byteLength = w.byteLength > 0 ? w.byteLength : viewLength;
    if (byteLength > viewLength || byteOffset + byteLength > parts.bin.byteLength) {
      console.warn(`[binary-resources] bufferView ${w.bufferView} is shorter than the declared ${byteLength} bytes — skipped`);
      continue;
    }
    // A COPY, so the whole GLB buffer is not kept alive by one package.
    const bytes = parts.bin.slice(byteOffset, byteOffset + byteLength);
    out.push({ sha256: w.sha256, bytes, byteLength, documentIds: new Set() });
  }
  return out;
}

function short(sha: string): string {
  return sha ? `${sha.slice(0, 8)}…` : '(none)';
}

/**
 * Slice bufferViews out of a binary GLB: `bufferViews[i]` → exactly
 * `wanted.byteLength` bytes from its `byteOffset` in the BIN chunk (the view
 * itself may be padded). A malformed file or an out-of-range view yields `[]` /
 * a skipped entry with a console warning — never a throw.
 */
export function extractGlbBufferViews(
  glb: ArrayBuffer | Uint8Array,
  wanted: readonly WantedBufferView[],
): BinaryResource[] {
  const bytes = glb instanceof Uint8Array ? glb : new Uint8Array(glb);
  const parts = readGlb(bytes);
  if (typeof parts === 'string') {
    console.warn(`[binary-resources] cannot read GLB: ${parts}`);
    return [];
  }
  return sliceBufferViews(parts, wanted);
}

// ─── FmuEmbed discovery ─────────────────────────────────────────────────

/** Component keys that carry an FMU — `Fmu` and its dedup forms `Fmu_1`, … */
export function isFmuComponentKey(key: string): boolean {
  return key === 'Fmu' || /^Fmu_\d+$/.test(key);
}

/**
 * Visit every `Fmu*` record of a glTF JSON: `nodes[i].extras.realvirtual` and
 * `scenes[i].extras.realvirtual` (the asset writer lifts the ROOT node's
 * extras onto the scene, so an FMU on the asset root lives there).
 */
export function forEachFmuRecord(
  json: Record<string, unknown>,
  visit: (record: Record<string, unknown>) => void,
): void {
  const holders = [
    ...(Array.isArray(json.nodes) ? json.nodes as Array<Record<string, unknown>> : []),
    ...(Array.isArray(json.scenes) ? json.scenes as Array<Record<string, unknown>> : []),
  ];
  for (const holder of holders) {
    const rv = (holder?.extras as Record<string, unknown> | undefined)?.realvirtual as Record<string, unknown> | undefined;
    if (!rv || typeof rv !== 'object') continue;
    for (const [key, value] of Object.entries(rv)) {
      if (!isFmuComponentKey(key) || !value || typeof value !== 'object' || Array.isArray(value)) continue;
      visit(value as Record<string, unknown>);
    }
  }
}

/**
 * Every `Fmu.FmuEmbed` in a glTF JSON with a stored bufferView, deduplicated by
 * SHA (one bufferView per SHA is the writer's rule, but a reader must not rely
 * on it). `bufferView: -1` means "never saved with bytes" and is skipped.
 */
export function collectFmuEmbeds(json: Record<string, unknown>): WantedBufferView[] {
  const bySha = new Map<string, WantedBufferView>();
  forEachFmuRecord(json, (record) => {
    const embed = record.FmuEmbed as Record<string, unknown> | undefined;
    const sha = typeof embed?.sha256 === 'string' ? embed.sha256 : '';
    const view = typeof embed?.bufferView === 'number' ? embed.bufferView : -1;
    const length = typeof embed?.byteLength === 'number' ? embed.byteLength : 0;
    if (!sha || view < 0 || bySha.has(sha)) return;
    bySha.set(sha, { bufferView: view, byteLength: length, sha256: sha });
  });
  return [...bySha.values()];
}

// ─── Store ──────────────────────────────────────────────────────────────

/** `sha256 → bytes`, shared by every document of the session. */
export class BinaryResourceStore {
  private readonly _entries = new Map<string, BinaryResource>();

  /**
   * Put a payload. An existing entry keeps its bytes (same SHA = same bytes)
   * and only gains the document. Returns the stored entry.
   */
  put(sha256: string, bytes: Uint8Array, documentId?: string): BinaryResource {
    let entry = this._entries.get(sha256);
    if (!entry) {
      entry = { sha256, bytes, byteLength: bytes.byteLength, documentIds: new Set() };
      this._entries.set(sha256, entry);
    }
    if (documentId) entry.documentIds.add(documentId);
    return entry;
  }

  get(sha256: string): BinaryResource | undefined {
    return this._entries.get(sha256);
  }

  has(sha256: string): boolean {
    return this._entries.has(sha256);
  }

  /** Let one more document hold an existing payload. False when the SHA is unknown. */
  retain(sha256: string, documentId: string): boolean {
    const entry = this._entries.get(sha256);
    if (!entry) return false;
    entry.documentIds.add(documentId);
    return true;
  }

  /**
   * Drop `documentId` from every entry; entries no document holds any more are
   * freed. Returns the number of freed entries.
   */
  releaseDocument(documentId: string): number {
    let freed = 0;
    for (const [sha, entry] of [...this._entries]) {
      if (!entry.documentIds.delete(documentId)) continue;
      if (entry.documentIds.size === 0) {
        this._entries.delete(sha);
        freed++;
      }
    }
    return freed;
  }

  /** SHAs currently held. */
  keys(): string[] {
    return [...this._entries.keys()];
  }

  get size(): number {
    return this._entries.size;
  }

  /** Test-only: forget everything. */
  _resetForTesting(): void {
    this._entries.clear();
  }
}

/** The session's one store. */
export const binaryResources = new BinaryResourceStore();

// ─── The ONE parse wrapper ──────────────────────────────────────────────

/**
 * Collect every embedded FMU package of `glb` into {@link binaryResources}
 * under `documentId`. Returns the number of payloads put. Best-effort: a
 * malformed file is left to the parser to reject.
 */
export function collectGlbResources(glb: ArrayBuffer | Uint8Array, documentId: string): number {
  const bytes = glb instanceof Uint8Array ? glb : new Uint8Array(glb);
  const layout = locateChunks(bytes);
  if (typeof layout === 'string') return 0;
  // Byte pre-check — a model without FMUs never pays the second JSON.parse.
  if (!bytesContain(layout.json, FMU_EMBED_NEEDLE)) return 0;
  const json = decodeJson(layout.json);
  if (typeof json === 'string') return 0;
  const wanted = collectFmuEmbeds(json);
  if (wanted.length === 0) return 0;
  const found = sliceBufferViews({ json, bin: layout.bin }, wanted);
  for (const res of found) binaryResources.put(res.sha256, res.bytes, documentId);
  return found.length;
}

/**
 * THE GLB parse of the viewer (plan-498 F3): collect the file's binary
 * resources, then hand the bytes to the loader. Every entry point — the main
 * model load (`rv-scene-loader.ts`), the placement cache (`rv-model-cache.ts`)
 * and the subtree parse (`rv-glb-parse.ts`) — calls this and nothing else.
 */
export async function parseGlbCollectingResources<T>(
  bytes: ArrayBuffer,
  documentId: string,
  loader: GlbParseLoader<T>,
): Promise<T> {
  try {
    collectGlbResources(bytes, documentId);
  } catch (e) {
    console.warn('[binary-resources] resource collection failed — parsing without:', e);
  }
  // Self-contained GLB (textures + buffers embedded) → empty resource path.
  return loader.parseAsync(bytes, '');
}

// ─── GLB writing ────────────────────────────────────────────────────────

/**
 * Re-emit a GLB with extra bufferViews appended to its BIN chunk (buffer 0).
 *
 * The existing BIN data is copied verbatim, every payload starts 4-byte
 * aligned, `buffers[0].byteLength` grows, and `patchJson` receives the new
 * bufferView indices (in `payloads` order) so the caller can point its records
 * at them before the JSON chunk is written. A GLB without a BIN chunk gets one.
 */
export function rebuildGlbAppendingBufferViews(
  glb: ArrayBuffer | Uint8Array,
  payloads: readonly Uint8Array[],
  patchJson: (json: Record<string, unknown>, viewIndices: number[]) => void,
): Uint8Array {
  const src = glb instanceof Uint8Array ? glb : new Uint8Array(glb);
  const parts = readGlb(src);
  if (typeof parts === 'string') throw new Error(`[binary-resources] cannot rewrite GLB: ${parts}`);
  const json = parts.json;

  let buffers = json.buffers as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(buffers)) {
    buffers = [];
    json.buffers = buffers;
  }
  if (buffers.length === 0) buffers.push({ byteLength: 0 });
  if (typeof buffers[0].uri === 'string') {
    throw new Error('[binary-resources] buffers[0] has a uri — not a GLB BIN buffer');
  }
  let views = json.bufferViews as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(views)) {
    views = [];
    json.bufferViews = views;
  }

  const oldBin = parts.bin ?? new Uint8Array(0);
  const align4 = (n: number): number => (n + 3) & ~3;
  let cursor = align4(oldBin.byteLength);
  const offsets: number[] = [];
  for (const p of payloads) {
    offsets.push(cursor);
    cursor = align4(cursor + p.byteLength);
  }
  const binLength = cursor;
  const bin = new Uint8Array(binLength); // zero-padded
  bin.set(oldBin, 0);
  const indices: number[] = [];
  payloads.forEach((p, i) => {
    bin.set(p, offsets[i]);
    indices.push(views!.length);
    views!.push({ buffer: 0, byteOffset: offsets[i], byteLength: p.byteLength });
  });
  const lastEnd = payloads.length > 0
    ? offsets[offsets.length - 1] + payloads[payloads.length - 1].byteLength
    : oldBin.byteLength;
  buffers[0].byteLength = Math.max((buffers[0].byteLength as number | undefined) ?? 0, lastEnd);

  patchJson(json, indices);

  const jsonBytes = new TextEncoder().encode(JSON.stringify(json));
  const jsonLength = align4(jsonBytes.byteLength);
  const total = GLB_HEADER_BYTES + CHUNK_PREFIX_BYTES + jsonLength + CHUNK_PREFIX_BYTES + binLength;
  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  view.setUint32(0, GLB_MAGIC, true);
  view.setUint32(4, GLB_VERSION, true);
  view.setUint32(8, total, true);
  view.setUint32(12, jsonLength, true);
  view.setUint32(16, CHUNK_TYPE_JSON, true);
  const jsonStart = GLB_HEADER_BYTES + CHUNK_PREFIX_BYTES;
  out.fill(0x20, jsonStart, jsonStart + jsonLength);
  out.set(jsonBytes, jsonStart);
  const binPrefix = jsonStart + jsonLength;
  view.setUint32(binPrefix, binLength, true);
  view.setUint32(binPrefix + 4, CHUNK_TYPE_BIN, true);
  out.set(bin, binPrefix + CHUNK_PREFIX_BYTES);
  return out;
}

/** Result of {@link embedFmuBufferViews}. */
export interface FmuBufferViewEmbedding {
  /** The written GLB (the input, untouched, when the file has no FMU record). */
  glb: ArrayBuffer;
  /** SHAs embedded, one bufferView each. */
  embedded: string[];
  /** SHAs `lookup` had no bytes for — written with `bufferView: -1`. */
  missing: string[];
}

/**
 * THE FMU bufferView writer (plan-498 F2), shared by both writers of a GLB:
 * the asset writer (bytes from the store) and the scene bake's structural path
 * (bytes from the SOURCE file it re-exports). One bufferView per SHA however
 * many records share it; every `FmuEmbed.bufferView` / `byteLength` is
 * rewritten to the NEW index (an exporter pass renumbers every view, so an
 * index read from the input is always stale) and the views are listed in
 * `asset.extras.realvirtual.fmuBufferViews`. A SHA `lookup` cannot serve is
 * written with `bufferView: -1` — the caller decides how loud that is.
 */
export function embedFmuBufferViews(
  glb: ArrayBuffer,
  lookup: (sha256: string) => Uint8Array | null | undefined,
): FmuBufferViewEmbedding {
  const json = readGlbJson(glb);
  if (!json) return { glb, embedded: [], missing: [] };
  const shas: string[] = [];
  forEachFmuRecord(json, (record) => {
    const sha = (record.FmuEmbed as Record<string, unknown> | undefined)?.sha256;
    if (typeof sha === 'string' && sha && !shas.includes(sha)) shas.push(sha);
  });
  if (shas.length === 0) return { glb, embedded: [], missing: [] };

  const embedded: string[] = [];
  const missing: string[] = [];
  const payloads: Uint8Array[] = [];
  for (const sha of shas) {
    const bytes = lookup(sha);
    if (bytes) { embedded.push(sha); payloads.push(bytes); } else missing.push(sha);
  }
  const out = rebuildGlbAppendingBufferViews(glb, payloads, (outJson, indices) => {
    const viewOf = new Map(embedded.map((sha, i) => [sha, indices[i]]));
    const lengthOf = new Map(embedded.map((sha, i) => [sha, payloads[i].byteLength]));
    forEachFmuRecord(outJson, (record) => {
      const embed = record.FmuEmbed as Record<string, unknown> | undefined;
      if (!embed || typeof embed.sha256 !== 'string') return;
      const view = viewOf.get(embed.sha256);
      embed.bufferView = view ?? -1;
      if (view !== undefined) embed.byteLength = lengthOf.get(embed.sha256);
    });
    const asset = (outJson.asset && typeof outJson.asset === 'object' ? outJson.asset : (outJson.asset = { version: '2.0' })) as Record<string, unknown>;
    const extras = (asset.extras && typeof asset.extras === 'object' ? asset.extras : (asset.extras = {})) as Record<string, unknown>;
    const rv = (extras.realvirtual && typeof extras.realvirtual === 'object' ? extras.realvirtual : (extras.realvirtual = {})) as Record<string, unknown>;
    rv.fmuBufferViews = indices;
  });
  const buffer = out.buffer.byteLength === out.byteLength
    ? out.buffer as ArrayBuffer
    : out.slice().buffer as ArrayBuffer;
  return { glb: buffer, embedded, missing };
}

/** Read a GLB's JSON chunk (best-effort; null when unreadable). Test + writer helper. */
export function readGlbJson(glb: ArrayBuffer | Uint8Array): Record<string, unknown> | null {
  const parts = readGlb(glb instanceof Uint8Array ? glb : new Uint8Array(glb));
  return typeof parts === 'string' ? null : parts.json;
}
