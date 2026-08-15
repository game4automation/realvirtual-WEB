// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * The two shapes of `?glb=` and how each becomes a fetchable URL (plan-386 §2.1).
 *
 * | Form | Meaning |
 * |------|---------|
 * | `?glb=s:<id>` | a share **we** host — opaque, resolved at runtime to a short-lived signed URL |
 * | `?glb=<absolute url>` | someone else's host — GitHub, a CDN, their own server |
 *
 * The opaque form is the normal case and the reason a shared link is a *viewer*
 * link rather than a file URL: what gets forwarded in a mail carries no storage
 * address. It also buys revocation, a reason code on `410`, and access counts —
 * none of which a bare URL can offer. It is a hurdle and a product decision,
 * **not DRM**: the browser must load the bytes, so a determined visitor can
 * always read them out of the network tab (§2.1, "Ehrliche Grenze").
 *
 * ## Why the resolver is injected
 *
 * Resolving `s:<id>` is a backend call, and the backend lives in another repo
 * (§2.6). Phase 1 therefore ships the *seam*, not the call: nothing is
 * registered by default and the opaque form fails with a sentence that says so.
 * Phase 2 installs the real resolver here and no other file changes.
 */

import { ShareFetchError, validateShareUrl } from './rv-share-fetch';

/** Prefix marking the opaque, self-hosted form. */
export const OPAQUE_PREFIX = 's:';

export type ShareTarget =
  | { kind: 'opaque'; id: string }
  | { kind: 'url'; url: string };

/**
 * Split a raw `?glb=` value into its two forms.
 *
 * Throws `ShareFetchError('invalid-url')` for an empty value or an empty id —
 * the same error channel the fetch uses, so the boot has exactly one catch.
 */
export function parseGlbParam(raw: string): ShareTarget {
  const value = raw.trim();
  if (!value) throw new ShareFetchError('invalid-url', 'The shared link is empty.');

  if (value.startsWith(OPAQUE_PREFIX)) {
    const id = value.slice(OPAQUE_PREFIX.length).trim();
    if (!id) throw new ShareFetchError('invalid-url', 'The shared link has no id.');
    return { kind: 'opaque', id };
  }

  // Absolute http(s) only — validateShareUrl owns the scheme whitelist so the
  // rule exists in exactly one place.
  return { kind: 'url', url: validateShareUrl(value).href };
}

/**
 * Build the link the sender copies (§2.1, `share_OpaqueId_DoesNotLeakStorageUrl`).
 *
 * Lives next to `parseGlbParam` on purpose: writer and reader of the `s:` form
 * are one rule, and a rule split across two files drifts. What comes out is a
 * **viewer** link — the storage URL the upload returned never appears in it,
 * which is the difference between forwarding a realvirtual page and forwarding
 * a file.
 *
 * `base` defaults to the current page without its query, so a link made in a
 * worktree session points at that session and one made on the deploy points at
 * the deploy.
 */
export function buildShareViewerLink(id: string, opts?: { base?: string; mode?: string }): string {
  const base = opts?.base
    ?? (typeof location !== 'undefined' ? location.origin + location.pathname : '/');
  const params = new URLSearchParams();
  params.set('glb', `${OPAQUE_PREFIX}${id}`);
  if (opts?.mode) params.set('mode', opts.mode);
  return `${base}?${params.toString()}`;
}

/**
 * Build a link for a GLB the sender hosts himself.
 *
 * Same shape, no upload, no login and no expiry — where we host nothing there
 * is nothing to attribute and nothing to delete (Finding 14).
 */
export function buildOwnUrlShareLink(url: string, opts?: { base?: string; mode?: string }): string {
  const validated = validateShareUrl(url.trim()).href;
  const base = opts?.base
    ?? (typeof location !== 'undefined' ? location.origin + location.pathname : '/');
  const params = new URLSearchParams();
  params.set('glb', validated);
  if (opts?.mode) params.set('mode', opts.mode);
  return `${base}?${params.toString()}`;
}

/** Turns an opaque share id into a downloadable URL. Installed by Phase 2. */
export type ShareIdResolver = (id: string) => Promise<string>;

let resolver: ShareIdResolver | null = null;

/**
 * Register the backend resolver for `?glb=s:<id>`.
 *
 * Returns an un-register function so a test can install a fake and put the
 * module back exactly as it found it.
 */
export function setShareIdResolver(next: ShareIdResolver | null): () => void {
  const previous = resolver;
  resolver = next;
  return () => { resolver = previous; };
}

export function hasShareIdResolver(): boolean {
  return resolver !== null;
}

/**
 * Resolve a `?glb=` value to the URL the bytes will be fetched from.
 *
 * The resolved URL goes through the same scheme whitelist as a user-supplied
 * one: a compromised or simply buggy resolver must not be able to hand us a
 * `javascript:` target.
 */
export async function resolveShareTarget(raw: string): Promise<string> {
  const target = parseGlbParam(raw);
  if (target.kind === 'url') return target.url;

  if (!resolver) {
    throw new ShareFetchError(
      'invalid-url',
      'This shared link points at realvirtual-hosted content, which this build cannot resolve yet.',
    );
  }
  const url = await resolver(target.id);
  return validateShareUrl(url).href;
}
