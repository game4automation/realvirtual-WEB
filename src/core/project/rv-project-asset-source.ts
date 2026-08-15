// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-project-asset-source.ts — how a project asset becomes loadable bytes
 * (plan-709 §2.5, phase 4).
 *
 * ## The leak this replaces
 *
 * `ProjectStore.resolveAssetUrl()` handed out an object URL and dropped the
 * backend's `release()` on purpose: the viewer keeps the model loaded for as
 * long as the user looks at it, and there was no owner able to say when that
 * ended. Blob data lives until its URL is revoked — the GC does not collect it
 * — so every opened project model left its bytes resident for the tab's life.
 *
 * ## Two stages, simplest first
 *
 * 1. **No URL at all.** A self-contained binary GLB (one BIN chunk, no `uri`
 *    entries) can be handed to the loader as an `ArrayBuffer`. Nothing to own,
 *    nothing to leak. This is the normal shape of everything this system
 *    exports, so it is the normal path.
 * 2. **A URL with an owner.** Anything else — external `.bin`, external
 *    textures, a plain `.gltf` — still needs a URL the loader can resolve
 *    siblings against. Then `release` comes with it and the SceneStore holds
 *    it in one slot, revoked when the next base loads and in `dispose()`.
 *
 * A `FinalizationRegistry` was considered and rejected: MDN is explicit that
 * GC callbacks must not carry essential program logic (plan-709 §7/§8).
 *
 * ## The sentinel base URL
 *
 * A `SceneBase` names its bytes with a URL string, and "the bytes of project
 * asset `models/Belt.glb`" is not a URL. {@link projectAssetUrl} mints
 * `rvproject:<relPath>` for it: a stable, re-resolvable reference that survives
 * a discard, a draft restore and a reload, where the object URL it replaces was
 * a fresh random UUID on every open. It is a source of bytes, never an
 * identity for the outside world — {@link isBytesSourceUrl} groups it with
 * `blob:` and `data:` wherever that distinction is already made.
 */

/** Prefix of the sentinel URL that names a project-relative asset. */
export const PROJECT_ASSET_URL_PREFIX = 'rvproject:';

/** The sentinel base URL for a project-relative asset path. */
export function projectAssetUrl(relPath: string): string {
  return `${PROJECT_ASSET_URL_PREFIX}${relPath.replace(/^\/+/, '')}`;
}

/** The project-relative path behind a sentinel URL, or null for anything else. */
export function projectAssetRelPath(url: string): string | null {
  return url.startsWith(PROJECT_ASSET_URL_PREFIX)
    ? url.slice(PROJECT_ASSET_URL_PREFIX.length)
    : null;
}

/**
 * True for a URL that carries BYTES rather than the identity of a model.
 *
 * The three forms differ in origin and agree in consequence: none of them is
 * something a later session, a share link or the `?scene=` parameter can be
 * pointed at.
 */
export function isBytesSourceUrl(url: string): boolean {
  return url.startsWith('blob:')
    || url.startsWith('data:')
    || url.startsWith(PROJECT_ASSET_URL_PREFIX);
}

/** Loadable form of a project asset — see the module docs for the two stages. */
export type ProjectAssetSource =
  | { kind: 'bytes'; bytes: ArrayBuffer }
  | { kind: 'url'; url: string; release: () => void };

const GLB_MAGIC = 0x46546c67;       // 'glTF' little-endian
const CHUNK_JSON = 0x4e4f534a;      // 'JSON'
const CHUNK_BIN = 0x004e4942;       // 'BIN\0'

/**
 * Can these bytes be parsed without a base URL to resolve siblings against?
 *
 * Deliberately a sniff of the container rather than a guess about where the
 * file came from: the answer is IN the bytes, and getting it wrong in the
 * optimistic direction means a model that loads without its textures. So the
 * test is narrow and everything it does not recognise falls back to stage 2:
 *
 *  - binary GLB, version 2, well-formed chunk table
 *  - exactly one BIN chunk (zero is legal for a geometry-free file and equally
 *    self-contained; two is not a shape glTF defines)
 *  - no `uri` on any entry of `buffers[]` or `images[]`
 *
 * A `.gltf` JSON file fails the magic test and takes stage 2, which is correct:
 * its buffers and images are separate files by construction.
 */
export function isSelfContainedGlb(bytes: ArrayBuffer): boolean {
  try {
    if (bytes.byteLength < 20) return false;
    const view = new DataView(bytes);
    if (view.getUint32(0, true) !== GLB_MAGIC) return false;
    if (view.getUint32(4, true) !== 2) return false;
    const total = Math.min(view.getUint32(8, true), bytes.byteLength);

    let offset = 12;
    let json: string | null = null;
    let binChunks = 0;
    while (offset + 8 <= total) {
      const length = view.getUint32(offset, true);
      const type = view.getUint32(offset + 4, true);
      const start = offset + 8;
      if (start + length > total) return false;   // truncated table — not our business
      if (type === CHUNK_JSON) {
        if (json !== null) return false;          // two JSON chunks is not a glTF
        json = new TextDecoder().decode(new Uint8Array(bytes, start, length));
      } else if (type === CHUNK_BIN) {
        binChunks++;
      }
      offset = start + length + ((4 - (length % 4)) % 4);
    }
    if (json === null || binChunks > 1) return false;

    const doc = JSON.parse(json) as {
      buffers?: { uri?: string }[];
      images?: { uri?: string }[];
    };
    const referencesFile = (list?: { uri?: string }[]): boolean =>
      (list ?? []).some(e => typeof e.uri === 'string' && e.uri.length > 0
        && !e.uri.startsWith('data:'));
    return !referencesFile(doc.buffers) && !referencesFile(doc.images);
  } catch {
    // Unparseable JSON, a bad decode, anything at all: stage 2 handles it, and
    // the loader gets to be the one that judges the bytes.
    return false;
  }
}
