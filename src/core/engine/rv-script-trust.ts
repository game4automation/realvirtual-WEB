// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-script-trust — the one exception to the `WebComponent` trust gate
 * (plan-210 §10): documents of the BUNDLED demo project run their scripts
 * without `?scripts`.
 *
 * Why this is safe: a file the deploy serves from its own `demo-realvirtual/`
 * folder, on the viewer's own origin, carries exactly the trust of the viewer
 * code next to it — whoever can change those bytes can change the viewer's
 * JavaScript too. The same reasoning leaves the bundled build-glob path of
 * `rv-project-code-consent.ts` ungated.
 *
 * What is NOT trusted (every condition below must hold, else the gate stays):
 *  - bytes that did not come from that URL (a resumed scene body, project bytes
 *    out of a linked/local folder, a file drop, a `blob:`/`data:` URL — e.g. an
 *    encrypted deploy's decrypted body);
 *  - any other origin, any path outside `<BASE_URL>demo-realvirtual/`;
 *  - a load carrying rv-extras overrides or placement edits (a user-modified
 *    copy — a stored draft body is already excluded as a `blob:` source), an
 *    authoring load (the asset editor), an untrusted share load (`?glb=`);
 *  - a load a `.kin.json` sidecar changed (it can add or overwrite extras —
 *    `WebComponent` included); a sidecar that applied nothing does not count;
 *  - placed content (references) inside a trusted document: the plugin only
 *    wires nodes that belong to the document itself; placements keep the gate.
 *
 * The decision is about the BYTES, so it reads the source URL, never the
 * identity (a project document's identity is its `rvproject:` sentinel). A
 * linked/local project folder, a customer workspace copy of the demo and a
 * file drop all hand in bytes without an HTTP source URL and stay gated.
 *
 * ## Provenance is a token, not a string (Codex review of e605438a)
 *
 * The source URL is never taken from a caller. It is recorded HERE, at the
 * fetch boundary, by {@link readTrackedBody}: keyed on the exact
 * `ArrayBuffer` the fetch produced, valued with the FINAL `Response.url` read
 * through the native `Response.prototype` getters (a subclass cannot override
 * them, a constructed `new Response(bytes)` has no URL). A redirected response
 * records nothing. Every fetch that can feed the parser goes through it:
 * main.ts' streamed download, the bundled backend, and the scene loader's own
 * fetch for a URL load without `data` (`reloadModel()` takes that route). The
 * loader asks {@link fetchedUrlOf} for EXACTLY the buffer it parses and hands
 * the answer to the viewer (`LoadResult.modelSourceUrl`): plain `data` loads
 * have no token and stay gated; a signature-recovery re-fetch is a replacement
 * buffer and carries only its own token, never the original's. An encrypted
 * deploy's decrypted body is a NEW buffer and therefore untrusted.
 *
 * ## Threat model
 *
 * The gate protects against untrusted model CONTENT — GLB, sidecar and scene
 * files a user opens, drops or is linked to. It does not try to protect
 * against JavaScript already executing in the page (mutating a tokened buffer,
 * patching `Response.prototype.arrayBuffer`/`body`, rewriting the viewer's
 * source facts): such code already holds the viewer's full authority and
 * needs no script gate to run. Findings of that class are out of scope by
 * design; cheap hardening (a frozen `currentModelSource`, native getters) is
 * kept where it costs nothing.
 */

const nativeUrl = (() => {
  try { return Object.getOwnPropertyDescriptor(Response.prototype, 'url')?.get ?? null; } catch { return null; }
})();
const nativeRedirected = (() => {
  try { return Object.getOwnPropertyDescriptor(Response.prototype, 'redirected')?.get ?? null; } catch { return null; }
})();
const fetchedBytes = new WeakMap<ArrayBuffer, string>();

/** Token the buffer with the response's final URL — genuine, non-redirected responses only. */
function recordFetchedBytes(buffer: ArrayBuffer, response: Response): void {
  try {
    if (!nativeUrl || !nativeRedirected || typeof Response === 'undefined' || !(response instanceof Response)) return;
    if (nativeRedirected.call(response) !== false) return;
    const url = nativeUrl.call(response) as unknown;
    if (typeof url !== 'string' || url === '') return;
    fetchedBytes.set(buffer, url);
  } catch { /* no token */ }
}

/**
 * Read a response body into ONE fresh `ArrayBuffer` and token it with the
 * response's final URL ({@link fetchedUrlOf}). The only way a buffer gets a
 * token: the bytes are always the body this function read itself, so a caller
 * cannot attach a real response's URL to bytes of its own.
 *
 * With a `content-length` and a readable stream the body is streamed into a
 * pre-sized buffer (`onProgress(loaded, total)`); a longer stream (compressed
 * transfer) falls back to a growable collector; a short one throws
 * `incomplete download`. Without length/stream (or `stream: false`: plain
 * `arrayBuffer()`), `onNoProgress()` fires once.
 */
export async function readTrackedBody(
  resp: Response,
  hooks: { onProgress?: (loaded: number, total: number) => void; onNoProgress?: () => void; stream?: boolean } = {},
): Promise<ArrayBuffer> {
  const len = hooks.stream === false ? 0 : parseInt(resp.headers?.get?.('content-length') || '0', 10);
  let out: ArrayBuffer;
  if (resp.body && len > 0) {
    const buf = new Uint8Array(len);
    const reader = resp.body.getReader();
    let offset = 0;
    let overflow: Uint8Array | null = null;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (offset + value.byteLength > len) {
        // More bytes than content-length (compressed transfer-encoding).
        const parts: Uint8Array[] = [buf.slice(0, offset), value];
        let total = offset + value.byteLength;
        for (;;) {
          const r = await reader.read();
          if (r.done) break;
          parts.push(r.value);
          total += r.value.byteLength;
        }
        overflow = new Uint8Array(total);
        let o = 0;
        for (const c of parts) { overflow.set(c, o); o += c.byteLength; }
        break;
      }
      buf.set(value, offset);
      offset += value.byteLength;
      hooks.onProgress?.(offset, len);
    }
    if (overflow) out = overflow.buffer as ArrayBuffer;
    else if (offset === len) out = buf.buffer as ArrayBuffer;
    else throw new Error(`incomplete download (${offset}/${len} bytes)`);
  } else {
    hooks.onNoProgress?.();
    out = await resp.arrayBuffer();
  }
  recordFetchedBytes(out, resp);
  return out;
}

/** The final URL a fetch recorded for exactly this buffer, or null. */
export function fetchedUrlOf(buffer: ArrayBuffer | null | undefined): string | null {
  return buffer ? fetchedBytes.get(buffer) ?? null : null;
}

/**
 * The provenance of the buffer the parser actually reads, after signature
 * verification. A recovery re-fetch (`recoveredByRefetch`) is a REPLACEMENT
 * buffer: it carries only its own token (or none) — never the original's.
 * Otherwise the parsed bytes are the original buffer (the signature worker
 * transfers that same memory back as a new `ArrayBuffer` object, which is why
 * the original token is read before verification).
 */
export function parsedBufferSourceUrl(
  initialSourceUrl: string | null,
  verified: { buffer: ArrayBuffer; recoveredByRefetch: boolean },
): string | null {
  return verified.recoveredByRefetch ? fetchedUrlOf(verified.buffer) : initialSourceUrl;
}

/**
 * Did an applied `.kin.json` sidecar write anything into the document's
 * extras (`applyKinematicsSpec` report)? A sidecar that changed the document
 * makes the load a MODIFIED document for the trust rule; one that applied
 * nothing (no matching targets, empty spec) does not.
 */
export function sidecarChangedDocument(report: { applied: Record<string, number> }): boolean {
  return Object.values(report.applied).some((n) => n > 0);
}

const BACKSLASH = String.fromCharCode(92);

/**
 * True for a path that hides structure: encoded separators or dots (`%2f`,
 * `%5c`, `%2e`, any `%25` double encoding), backslashes, or a `.`/`..`
 * segment after decoding.
 */
function hasHiddenStructure(path: string): boolean {
  if (/%(2f|5c|2e|25)/i.test(path) || path.includes(BACKSLASH)) return true;
  let decoded: string;
  try { decoded = decodeURIComponent(path); } catch { return true; }
  if (decoded.includes(BACKSLASH)) return true;
  return decoded.split('/').some(seg => seg === '.' || seg === '..');
}

/**
 * The bundled demo folder below the deploy base — `DEMO_BASE_PATH` of
 * `bundled-backend.ts`, spelled out so this core module does not pull the
 * project backend into every bundle (a test pins the two equal).
 */
export const SCRIPT_TRUST_DEMO_BASE_PATH = 'demo-realvirtual/';

/** What the viewer knows about where the current model's bytes came from. */
export interface ModelLoadSource {
  /** Final URL a fetch recorded for the loaded buffer ({@link fetchedUrlOf}), or null. */
  sourceUrl: string | null;
  /** The URL the document IS (`identityUrl ?? url`) — informational only. */
  identityUrl: string;
  /** rv-extras overrides were applied during the load. */
  hasOverlay: boolean;
  /** Scene edits of any kind (placements added/moved/removed, nodes, …) were applied. */
  hasPlacementEdits: boolean;
  /** Asset-editor load (`preserveHierarchy` / `preserveAuthoringHierarchy`). */
  authoring: boolean;
  /** The load ran under an untrusted context (`?glb=` share). */
  untrusted: boolean;
  /** A `.kin.json` sidecar changed the document's extras during the load. */
  hasSidecar: boolean;
}

export interface ScriptTrustDecision {
  trusted: boolean;
  /** Short reason for the log line. */
  reason: string;
}

function defaultBaseUrl(): string {
  try {
    return (import.meta as { env?: { BASE_URL?: string } }).env?.BASE_URL ?? '/';
  } catch {
    return '/';
  }
}

function defaultPageHref(): string | null {
  try {
    return typeof location !== 'undefined' ? location.href : null;
  } catch {
    return null;
  }
}

/**
 * Decides whether the scripts of the loaded document run without the explicit
 * gate. Pure — `pageHref` / `baseUrl` are injectable for tests.
 */
export function bundledDemoScriptTrust(
  src: ModelLoadSource | null,
  env: { pageHref?: string | null; baseUrl?: string } = {},
): ScriptTrustDecision {
  const no = (reason: string): ScriptTrustDecision => ({ trusted: false, reason });
  if (!src) return no('no load source');
  if (src.untrusted) return no('untrusted share load');
  if (src.authoring) return no('authoring load');
  if (src.hasOverlay || src.hasPlacementEdits || src.hasSidecar) return no('modified document');
  if (!src.sourceUrl) return no('bytes not read from a deploy URL');
  if (hasHiddenStructure(src.sourceUrl)) return no('encoded or relative path');
  const pageHref = env.pageHref === undefined ? defaultPageHref() : env.pageHref;
  if (!pageHref) return no('no page origin');
  let page: URL, source: URL, demoBase: URL;
  try {
    page = new URL(pageHref);
    source = new URL(src.sourceUrl, page);
    const base = env.baseUrl ?? defaultBaseUrl();
    demoBase = new URL(`${base.endsWith('/') ? base : `${base}/`}${SCRIPT_TRUST_DEMO_BASE_PATH}`, page);
  } catch {
    return no('unparsable URL');
  }
  if (source.protocol !== 'http:' && source.protocol !== 'https:') return no('not an http(s) source');
  if (source.origin !== page.origin) return no('other origin');
  if (hasHiddenStructure(source.pathname)) return no('encoded or relative path');
  if (demoBase.origin !== page.origin || !source.pathname.startsWith(demoBase.pathname)) return no('not in the bundled demo project');
  return { trusted: true, reason: 'bundled demo project' };
}
