// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * Booting the page from `?glb=` (plan-386 §2.5b).
 *
 * ## The one rule this file exists to enforce
 *
 * **It calls `RVViewer.loadModel()` directly.** Not `main.ts`'s `loadModel()`
 * hull, and not `sceneStore.openBuiltin()`.
 *
 * That is not a stylistic preference. The verification of 2026-08-08 answered
 * R4 with "yes, and twice": the hull writes `LS_KEY_MODEL` *and*, since
 * plan-397, calls `sceneStore.markGlbActive()` — two separate ways for a
 * visitor's own last-model entry and active-scene pointer to be overwritten by
 * a link somebody mailed him. `openBuiltin()` persists a per-base draft on top
 * of that. F7 says a shared link leaves **nothing** behind, and the only way to
 * guarantee that is to enter below all three.
 *
 * The guard test `share_DoesNotWriteAnyKey` runs with `rv-scenes/*` and
 * `LS_KEY_MODEL` pre-filled and asserts both survive untouched, precisely
 * because "we did not call the writing function" is a property that a future
 * refactor can quietly remove.
 *
 * ## Trust
 *
 * The load is marked untrusted (F17). What that suppresses — interface
 * auto-connect, the CONNECT per-model stream, live signal binding — and what it
 * deliberately leaves running — the local simulation, because a shared link
 * exists to show a *running* machine — is documented on `LoadTrustContext`.
 *
 * Since plan-423 that default can be lifted by ONE explicit, persisted user
 * decision, and this file is where it is read — **before** `loadModel()`, which
 * is the only moment that matters: the manager, the auto-connect and the
 * per-model stream are all decided during the load, so a decision consulted
 * afterwards would arrive a whole model too late (review finding SOL-R1 F2).
 * This is also the only place that knows the share IDENTITY *and* holds the
 * BYTES, which is what makes the digest check possible at all. `rv-load-trust.ts`
 * is untouched by it.
 */

import type { Object3D } from 'three';
import { parseGlbParam, resolveShareTarget } from './rv-share-target';
import {
  digestOfBytes, isShareTrusted, shareTrustKeyForId, shareTrustKeyForUrl,
} from './rv-share-trust-store';
import type { ModelProvenance } from '../rv-model-provenance';
import {
  fetchSharedGlb,
  describeShareFetchError,
  ShareFetchError,
  SHARE_DECRYPT_MESSAGES,
  type FetchSharedGlbOptions,
  type SharedGlbPayload,
} from './rv-share-fetch';
import { getSharedGlbDecryptor, ShareDecryptError } from './rv-share-decrypt';
import { isEncryptedEnvelope } from '../persistence/rv-crypto-utils';
import { buildSharedGlbInfo, filenameFromUrl, originHostOf } from './rv-share-meta';
import { beginSharedGlbLoad, setSharedGlb, failSharedGlb } from './rv-share-store';
import type { EmbeddedOrigin } from '../engine/rv-glb-flatten';

/**
 * The narrow slice of `RVViewer` this boot touches.
 *
 * Structural rather than the concrete class so the test can drive it with a
 * fake — and so the file cannot accidentally grow a dependency on the scene
 * store, which is the whole point (see above).
 */
export interface ShareBootViewer {
  loadModel(url: string, options: {
    data: ArrayBuffer;
    modelName?: string;
    trust: { trusted: boolean; sourceOrigin?: string };
    provenance?: ModelProvenance;
    identityUrl?: string;
  }): Promise<{ root?: Object3D } | undefined | void>;
  currentModelUrl?: string | null;
}

export interface ShareBootOptions {
  /** Forwarded to the fetch (byte budget, abort signal, injected fetch). */
  fetch?: FetchSharedGlbOptions;
  /** Provenance of embedded reference subtrees, when the caller knows it. */
  embeddedOrigins?: readonly EmbeddedOrigin[];
}

export interface ShareBootResult {
  ok: boolean;
  /** Sentence to show the visitor when `ok` is false. */
  error?: string;
}

/**
 * Load the GLB named by a `?glb=` value and publish its info card.
 *
 * Never throws: a shared link that cannot be opened is a message on the card,
 * not an unhandled rejection in the boot sequence. The caller uses the boolean
 * only to decide whether the default model resolution still has to run.
 */
export async function bootSharedGlb(
  viewer: ShareBootViewer,
  rawParam: string,
  options?: ShareBootOptions,
): Promise<ShareBootResult> {
  beginSharedGlbLoad();
  try {
    // Parsed for the trust IDENTITY before resolving: the opaque id is the
    // stable anchor, while the resolved URL is short-lived and rotates.
    const target = parseGlbParam(rawParam);
    const url = await resolveShareTarget(rawParam);
    const payload = await fetchSharedGlb(url, options?.fetch);

    const trustRecordKey = target.kind === 'opaque'
      ? shareTrustKeyForId(target.id)
      : shareTrustKeyForUrl(target.url);

    // plan-560: an RVE1 envelope takes its own branch. Everything below it is
    // the plaintext path, unchanged (F8).
    if (isEncryptedEnvelope(payload.bytes)) {
      return await bootEncryptedShare(viewer, url, payload, trustRecordKey, options);
    }

    const digest = await digestOfBytes(payload.bytes);
    // BOTH must match: a decision is about the bytes the user looked at, not
    // about an address somebody else can point elsewhere later.
    const trusted = isShareTrusted(trustRecordKey, digest);
    const sourceOrigin = originOf(payload.finalUrl).sourceOrigin;

    const result = await viewer.loadModel(payload.finalUrl, {
      data: payload.bytes,
      modelName: filenameFromUrl(payload.finalUrl),
      trust: { trusted, ...originOf(payload.finalUrl) },
      provenance: {
        trusted,
        source: target.kind === 'opaque' ? 'share' : 'own-url',
        trustRecordKey,
        ...(digest ? { digest } : {}),
        ...(sourceOrigin ? { sourceOrigin } : {}),
      },
    });

    // `root` is the GLB's `gltf.scene`, so `scenes[0].extras` — and therefore
    // `rv_share` — is sitting on its userData (§2.4).
    const userData = (result && typeof result === 'object' && 'root' in result)
      ? (result as { root?: Object3D }).root?.userData
      : undefined;

    // Identity for the model selector and any later reload. Set here rather
    // than by the hull, which is the thing we are bypassing.
    viewer.currentModelUrl = payload.finalUrl;

    setSharedGlb(
      buildSharedGlbInfo({
        url: payload.finalUrl,
        userData,
        embeddedOrigins: options?.embeddedOrigins ?? readEmbeddedOrigins(userData),
      }),
      payload,
    );
    return { ok: true };
  } catch (e) {
    const message = describeShareFetchError(e);
    failSharedGlb(message);
    return { ok: false, error: message };
  }
}

/**
 * The encrypted branch of the boot (plan-560 §2.4).
 *
 * The decryptor is a SEAM: the public edition installs none and answers with a
 * sentence instead of loading ciphertext. A commercial build installs the
 * password prompt. A load opened with the password runs **trusted** (user
 * decision: password = trusted) — but only for this session: no trust-store
 * lookup and no record, so a shared link still leaves nothing behind (F10).
 *
 * The card keeps the ENVELOPE as its payload, so the download button hands out
 * the encrypted file and the plaintext never leaves the page as a file.
 */
async function bootEncryptedShare(
  viewer: ShareBootViewer,
  requestUrl: string,
  payload: SharedGlbPayload,
  trustRecordKey: string,
  options?: ShareBootOptions,
): Promise<ShareBootResult> {
  const decryptor = getSharedGlbDecryptor();
  if (!decryptor) {
    throw new ShareFetchError('encrypted-unsupported', SHARE_DECRYPT_MESSAGES['encrypted-unsupported']);
  }

  let plain: ArrayBuffer;
  try {
    plain = await decryptor(payload.bytes);
  } catch (e) {
    throw toShareDecryptFetchError(e);
  }

  const digest = await digestOfBytes(plain);
  const sourceOrigin = originOf(payload.finalUrl).sourceOrigin;
  // `finalUrl` is usually a short-lived signed storage URL (fileshare 302 →
  // GCS). It is neither a name nor a place to look for neighbours: the
  // hierarchy titles the model from `currentModelUrl`, and the loader probes a
  // `<name>.kin.json` next to any `.glb` url (→ 403 against a signature).
  // So the loader gets the URL that was ASKED for (a fileshare `/file` route
  // is not `.glb`, no probe), and the identity is the finalUrl without its
  // query and without the `.rve` marker.
  const identityUrl = encryptedIdentityUrl(payload.finalUrl);
  const result = await viewer.loadModel(requestUrl, {
    data: plain,
    identityUrl,
    modelName: filenameFromUrl(payload.finalUrl).replace(/\.rve$/i, ''),
    trust: { trusted: true, ...originOf(payload.finalUrl) },
    provenance: {
      trusted: true,
      source: 'share-encrypted',
      trustRecordKey,
      ...(digest ? { digest } : {}),
      ...(sourceOrigin ? { sourceOrigin } : {}),
    },
  });

  const userData = (result && typeof result === 'object' && 'root' in result)
    ? (result as { root?: Object3D }).root?.userData
    : undefined;
  viewer.currentModelUrl = identityUrl;

  setSharedGlb(
    buildSharedGlbInfo({
      url: payload.finalUrl,
      userData,
      embeddedOrigins: options?.embeddedOrigins ?? readEmbeddedOrigins(userData),
      encrypted: true,
    }),
    payload,
  );
  return { ok: true };
}

/** `https://h/p/name.rve.glb?sig…` → `https://h/p/name.glb` (plan-560 follow-up). */
function encryptedIdentityUrl(finalUrl: string): string {
  const bare = finalUrl.split(/[?#]/)[0] ?? finalUrl;
  return bare.replace(/\.rve(\.glb)$/i, '$1');
}

/** Map a decryptor rejection onto the card's error kinds (plan-560 F6/F7). */
function toShareDecryptFetchError(e: unknown): ShareFetchError {
  if (e instanceof ShareFetchError) return e;
  if (e instanceof ShareDecryptError) {
    if (e.code === 'link-incomplete') {
      return new ShareFetchError('link-incomplete', SHARE_DECRYPT_MESSAGES['link-incomplete'], { cause: e });
    }
    if (e.code === 'cancelled') {
      return new ShareFetchError('decrypt-cancelled', SHARE_DECRYPT_MESSAGES['decrypt-cancelled'], { cause: e });
    }
  }
  return new ShareFetchError('decrypt-failed', SHARE_DECRYPT_MESSAGES['decrypt-failed'], { cause: e });
}

function originOf(url: string): { sourceOrigin?: string } {
  const host = originHostOf(url);
  return host ? { sourceOrigin: host } : {};
}

/**
 * Best-effort read of flatten provenance off the loaded scene.
 *
 * A flat export records where each embedded subtree came from; showing that on
 * the card answers "what am I actually looking at" for an assembly whose parts
 * came from three different places. Absent on a normal export, which is why
 * every step here is optional and nothing here throws.
 */
function readEmbeddedOrigins(userData: unknown): readonly EmbeddedOrigin[] {
  if (!userData || typeof userData !== 'object') return [];
  const raw = (userData as Record<string, unknown>).rv_embedded_origins;
  if (!Array.isArray(raw)) return [];
  return raw.filter((o): o is EmbeddedOrigin =>
    !!o && typeof o === 'object'
    && typeof (o as EmbeddedOrigin).assetId === 'string'
    && typeof (o as EmbeddedOrigin).sha256 === 'string');
}
