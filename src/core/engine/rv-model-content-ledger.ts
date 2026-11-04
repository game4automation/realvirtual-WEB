// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/** Exact decoded document hashes for strict DES fingerprints. No document size limit. */
import { Sha256, sha256HexUtf8 } from './rv-sha256';
import { DES_MANAGER_COMPONENT, isDesRunConfigField } from '../material-flow/des-manager-settings';

export type DocumentHashState =
  | { readonly state: 'ready'; readonly sha256: string }
  | { readonly state: 'pending' }
  | { readonly state: 'unavailable'; readonly reason: string };

interface Entry {
  generation: number;
  value: DocumentHashState;
  done: Promise<void>;
}

export interface DocumentHashOptions {
  /** Decode epoch guard, checked before recording and again before publishing. */
  isCurrent?: () => boolean;
}

export type DocumentByteChunk = ArrayBuffer | ArrayBufferView;
export type DocumentByteStream = AsyncIterable<DocumentByteChunk> | Iterable<DocumentByteChunk>;

// Small slices keep each main-thread step short for huge documents.
const CHUNK_BYTES = 4 * 1024 * 1024;
const _entries = new Map<string, Entry>();
let _generation = 0;

function view(bytes: DocumentByteChunk): Uint8Array {
  return ArrayBuffer.isView(bytes)
    ? new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    : new Uint8Array(bytes);
}

// A macrotask lets rendering and input run between hashing chunks.
function yieldToHost(): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, 0));
}

// --- Run-configuration normalization (plan-2059, Thomas 2026-11-01) ---------
//
// The document hash is a byte hash EXCEPT for one case: a GLB whose JSON chunk
// carries a DESManager component. There the three run fields (EndTime,
// StatisticsResetTime, MasterSeed - `isDesRunConfigField`) are not model, so a
// GLB saved and reloaded after changing only them must hash the same. Only the
// (small) JSON chunk is parsed; the binary part is never touched:
//
//   hash = SHA-256( TAG \n version \n sha256(canonicalJson) \n sha256(bytes after the JSON chunk) )
//
// canonicalJson = JSON.stringify of the parsed JSON chunk with the run fields
// removed. The rule applies to every file that has a DESManager node, so two
// such files differing only in those fields (or in JSON whitespace/padding)
// agree. Files without one get the plain byte hash, native fast path unchanged.
const NORM_TAG = 'rv-glb-norm-v1';
const GLB_MAGIC = 0x46546c67;
const GLB_JSON = 0x4e4f534a;
const GLB_HEADER = 20; // 12-byte header + 8-byte JSON chunk header

interface GlbHead { readonly version: number; readonly total: number; readonly jsonLength: number }

/** null = not a GLB (plain hash), 'short' = not enough bytes yet to tell. */
function glbHead(b: Uint8Array): GlbHead | null | 'short' {
  const dv = new DataView(b.buffer, b.byteOffset, b.byteLength);
  if (b.byteLength >= 4 && dv.getUint32(0, true) !== GLB_MAGIC) return null;
  if (b.byteLength < GLB_HEADER) return 'short';
  if (dv.getUint32(16, true) !== GLB_JSON) return null;
  return { version: dv.getUint32(4, true), total: dv.getUint32(8, true), jsonLength: dv.getUint32(12, true) };
}

/**
 * Canonical JSON text when the parsed JSON chunk has a node with a DESManager
 * component, else null (plain byte hash). The substring test is only a cheap
 * prefilter (an escaped key has a backslash, so those parse too); the verdict
 * comes from the parsed document.
 */
function canonicalJsonOf(json: Uint8Array): string | null {
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(json); } catch { return null; }
  if (!text.includes(DES_MANAGER_COMPONENT) && !text.includes('\\')) return null;
  try {
    const doc = JSON.parse(text) as { nodes?: Array<{ extras?: { realvirtual?: Record<string, unknown> } }> };
    let found = false;
    for (const node of doc.nodes ?? []) {
      const manager = node?.extras?.realvirtual?.[DES_MANAGER_COMPONENT];
      if (manager === null || typeof manager !== 'object') continue;
      found = true;
      for (const field of Object.keys(manager)) {
        if (isDesRunConfigField(DES_MANAGER_COMPONENT, field)) delete (manager as Record<string, unknown>)[field];
      }
    }
    return found ? JSON.stringify(doc) : null;
  } catch { return null; }
}

/** `declaredRest`: what the GLB header promises after the JSON chunk; `restLength`: what was hashed. Both are hashed. */
function normalizedDigest(version: number, canonical: string, declaredRest: number, restLength: number, restHex: string): string {
  return sha256HexUtf8(`${NORM_TAG}\n${version}\n${sha256HexUtf8(canonical)}\n${declaredRest}:${restLength}\n${restHex}`);
}

function record(
  key: string,
  hash: () => Promise<string>,
  opts?: DocumentHashOptions,
): Promise<void> {
  const isCurrent = opts?.isCurrent ?? (() => true);
  if (!key || !isCurrent()) return Promise.resolve();
  const generation = ++_generation;
  const entry: Entry = { generation, value: { state: 'pending' }, done: Promise.resolve() };
  _entries.set(key, entry);
  const publish = (value: DocumentHashState): void => {
    if (_entries.get(key)?.generation !== generation) return;
    if (!isCurrent()) { _entries.delete(key); return; }
    entry.value = value;
  };
  entry.done = hash().then(
    sha256 => publish({ state: 'ready', sha256 }),
    (error: unknown) => publish({ state: 'unavailable', reason: `digest failed: ${String(error)}` }),
  );
  return entry.done;
}

/** Documents up to this size are hashed natively (WebCrypto digest on a copy). */
export const NATIVE_DIGEST_MAX_BYTES = 256 * 1024 * 1024;

function subtle(): SubtleCrypto | null {
  const c = (globalThis as { crypto?: Crypto }).crypto;
  return c && c.subtle && typeof c.subtle.digest === 'function' ? c.subtle : null;
}

function toHex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = '';
  for (let i = 0; i < bytes.length; i++) out += bytes[i].toString(16).padStart(2, '0');
  return out;
}

/**
 * Record the exact bytes handed to the parser. Never delays the load: the
 * returned promise only settles the ledger entry (callers do not await it).
 *
 * - up to {@link NATIVE_DIGEST_MAX_BYTES}: WebCrypto digest, which copies its
 *   input synchronously — the caller may drop or transfer `bytes` at once;
 * - larger (plan-2059 Q3, Thomas 2026-11-02: no size limit in V1): the bytes are
 *   NOT copied. An incremental SHA-256 walks zero-copy views of the buffer in
 *   the background, yielding to the host between slices. The caller must hand
 *   bytes that are not transferred or mutated afterwards — both capture points
 *   pass the buffer the parser reads (after signature verification, which is
 *   the only step that transfers a buffer). The reference is held until the
 *   hash is done; no second copy of the document exists.
 */
export function recordDocumentBytes(
  key: string,
  bytes: DocumentByteChunk,
  opts?: DocumentHashOptions,
): Promise<void> {
  const s = subtle();
  const input = view(bytes);
  // Run-configuration normalization: only the JSON chunk is parsed (see above).
  let norm: { version: number; canonical: string; declaredRest: number; restStart: number } | null = null;
  const head = glbHead(input);
  if (head && head !== 'short' && GLB_HEADER + head.jsonLength <= input.byteLength) {
    const canonical = canonicalJsonOf(input.subarray(GLB_HEADER, GLB_HEADER + head.jsonLength));
    if (canonical !== null) {
      norm = { version: head.version, canonical, declaredRest: head.total - GLB_HEADER - head.jsonLength, restStart: GLB_HEADER + head.jsonLength };
    }
  }
  const target = norm ? input.subarray(norm.restStart) : input;
  const restLength = target.byteLength; // captured now: the caller may transfer the buffer afterwards
  const finish = (hex: string): string => norm ? normalizedDigest(norm.version, norm.canonical, norm.declaredRest, restLength, hex) : hex;
  if (s && target.byteLength <= NATIVE_DIGEST_MAX_BYTES) {
    let digest: Promise<ArrayBuffer>;
    try {
      // The copy happens HERE, synchronously (WebIDL BufferSource semantics).
      digest = s.digest('SHA-256', target as BufferSource);
    } catch (e) {
      digest = Promise.reject(e);
    }
    return record(key, () => digest.then(toHex).then(finish), opts);
  }
  return record(key, async () => {
    const hash = new Sha256();
    for (let off = 0; off < target.byteLength; off += CHUNK_BYTES) {
      hash.update(target.subarray(off, off + CHUNK_BYTES));
      await yieldToHost();
    }
    return finish(hash.digestHex());
  }, opts);
}

/**
 * Consume a byte stream without retaining previous chunks. Producers may reuse
 * their chunk storage after the iterator is advanced, but must keep the yielded
 * bytes intact until then. Large individual chunks are also hashed in slices.
 */
export function recordDocumentStream(
  key: string,
  chunks: DocumentByteStream,
  opts?: DocumentHashOptions,
): Promise<void> {
  return record(key, async () => {
    const hash = new Sha256();
    // Only the GLB head and JSON chunk are held (copied: producers reuse chunk
    // storage) to decide between plain and normalized hashing; everything after
    // streams through as views, exactly like the plain path.
    const st: { norm: { version: number; canonical: string; declaredRest: number } | null; restLength: number } = { norm: null, restLength: 0 };
    const parts: Uint8Array[] = [];
    let have = 0, need = GLB_HEADER, phase: 'head' | 'json' | 'done' = 'head', head: GlbHead | null = null;
    const feed = async (input: Uint8Array): Promise<void> => {
      st.restLength += input.byteLength;
      for (let off = 0; off < input.byteLength; off += CHUNK_BYTES) {
        hash.update(input.subarray(off, off + CHUNK_BYTES));
        await yieldToHost();
      }
    };
    const joined = (): Uint8Array => {
      const out = new Uint8Array(have);
      let o = 0;
      for (const part of parts) { out.set(part, o); o += part.byteLength; }
      parts.length = 0;
      return out;
    };
    for await (const chunk of chunks) {
      let input = view(chunk);
      while (phase !== 'done' && (input.byteLength > 0 || have >= need)) {
        const n = Math.min(need - have, input.byteLength);
        parts.push(input.slice(0, n)); have += n; input = input.subarray(n);
        if (have < need) continue;
        const buf = joined();
        if (phase === 'head') {
          const h = glbHead(buf);
          if (!h || h === 'short') { phase = 'done'; await feed(buf); }
          else { head = h; phase = 'json'; need = GLB_HEADER + h.jsonLength; parts.push(buf); }
        } else {
          phase = 'done';
          const canonical = canonicalJsonOf(buf.subarray(GLB_HEADER));
          if (canonical === null || !head) await feed(buf);
          else {
            st.norm = { version: head.version, canonical, declaredRest: head.total - GLB_HEADER - head.jsonLength };
            st.restLength = 0;
          }
        }
      }
      if (phase === 'done' && input.byteLength > 0) await feed(input);
    }
    if (phase !== 'done' && have > 0) await feed(joined()); // ended inside the head or JSON chunk: plain
    const hex = hash.digestHex();
    return st.norm ? normalizedDigest(st.norm.version, st.norm.canonical, st.norm.declaredRest, st.restLength, hex) : hex;
  }, opts);
}

/** The ledger's synchronous verdict for one document key. Unknown key → `unavailable`. */
export function documentHashOf(key: string): DocumentHashState {
  const e = _entries.get(key);
  return e ? e.value : { state: 'unavailable', reason: 'document was never recorded' };
}

/** Resolves once every digest started so far has settled (tests, Phase-3 capture readiness). */
export function whenDocumentHashesSettled(): Promise<void> {
  return Promise.all([..._entries.values()].map((e) => e.done)).then(() => undefined);
}

/** Forget every entry (tests). */
export function clearModelContentLedger(): void {
  _entries.clear();
}
