// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-script-runtime-loader.ts — the RUNTIME resolver of a `scriptRef`
 * (plan-718 §2.6 mode 2, stage 2b.1).
 *
 * Stage 2 gave `scriptRef` one resolver: the build glob. That resolver can only
 * ever find code that was present when the bundle was built, which is exactly
 * wrong for the case the reference model exists for — a project folder that is
 * copied onto a machine whose viewer was built without it. Today that project
 * logs "resolves to no bundled module" and runs no code at all.
 *
 * This module is the second resolver. It reads the **compiled `.js` sibling**
 * next to the referenced `.ts` out of the project itself and imports it with
 * `import(/* @vite-ignore *\/ url)` — the same mechanism `rv-plugin-loader.ts`
 * has used for external plugins since plan-182, and the same reason for the
 * ignore comment: the specifier is data, so Vite must not try to resolve it at
 * build time.
 *
 * ## Three properties worth stating, because each one is a decision
 *
 *  - **Bytes, not paths.** The source seam hands over bytes
 *    ({@link RuntimeScriptSource.readBytes}), which every project backend can
 *    do — OPFS/IndexedDB in the browser, a `FileSystemFileHandle` in a folder,
 *    a `fetch` in a bundled deploy. The bytes become a Blob URL, so the import
 *    works identically on all three. The price is that the `.js` sibling must be
 *    **self-contained**: a Blob URL has no directory, so a relative
 *    `import './util.js'` inside it cannot resolve. That is what
 *    `scripts/compile-project-scripts.mjs` bundles for (stage 2b.2).
 *  - **Cache-busting is structural, not a convention.** Different bytes produce
 *    a different Blob URL, and a URL the browser has never seen cannot be
 *    served from its module map. The `version` returned here is the content
 *    hash, so a caller keying a cache on it (and `ModelPluginManager` does)
 *    cannot hand back the previous version of a script that was just saved
 *    (R13). For the optional {@link RuntimeScriptSource.resolveUrl} path — a
 *    real URL, where relative imports *do* work — the same token is appended as
 *    `?v=<hash>` instead.
 *  - **Consent is asked between reading and importing.** Reading bytes executes
 *    nothing, so the question can be asked with knowledge of whether there is
 *    anything to ask about: a project with no `.js` sibling never prompts.
 *    Without a consent callback nothing runs — this loader fails CLOSED (R8).
 */

import { debug, debugWarn } from './engine/rv-debug';

// ─── The source seam ────────────────────────────────────────────────────

/**
 * Where a project's own files come from.
 *
 * `ProjectBackend` satisfies this structurally through `readBlobBytes`, which
 * is deliberate — the loader must not import the project store (the same rule
 * `ModelPluginManager` follows), and a test must be able to state a project's
 * contents as an object literal.
 */
export interface RuntimeScriptSource {
  /** The bytes stored at a project-relative path, or null when nothing is. */
  readBytes(relPath: string): Promise<ArrayBuffer | null>;
  /**
   * An importable URL for a project-relative path, when the medium has one.
   *
   * Optional, and tried only when {@link readBytes} came back empty. A real URL
   * keeps relative imports and source maps working; a Blob URL cannot.
   */
  resolveUrl?(relPath: string): Promise<string | null>;
}

/** Asked once per project before any of its native code runs (2b.3). */
export type RuntimeScriptConsent = (
  ctx: { scriptRef: string; jsRef: string },
) => boolean | Promise<boolean>;

export interface LoadRuntimeScriptOptions {
  source: RuntimeScriptSource;
  /**
   * The consent gate. **Omitting it denies**: native project code is exactly
   * the thing that must not run because a wiring step was forgotten.
   */
  consent?: RuntimeScriptConsent;
  /** Import seam. Production passes nothing (a real dynamic `import()`). */
  importer?: (url: string) => Promise<unknown>;
}

export interface RuntimeScriptLoad {
  /** The module's default export, instantiated if it was a class. */
  value: unknown;
  /** The full module namespace, for callers that use named exports. */
  namespace: Record<string, unknown>;
  /** The `.js` path that was actually loaded. */
  jsRef: string;
  /** Content hash of the loaded bytes — the cache-busting token. */
  version: string;
}

/** Why {@link loadRuntimeScript} returned nothing. Diagnostics, not control flow. */
export type RuntimeScriptFailure =
  | 'not-a-script-ref'
  | 'no-sibling'
  | 'denied'
  | 'import-failed';

// ─── Paths ──────────────────────────────────────────────────────────────

/**
 * The compiled sibling of a reference: `scripts/a.ts` → `scripts/a.js`.
 *
 * A reference that already names a `.js` file IS its own sibling — a project
 * may ship compiled code and no source. Anything else (a `.json`, a folder)
 * returns null rather than a guess.
 */
export function jsSiblingOf(scriptRef: string): string | null {
  const ref = String(scriptRef ?? '').trim().replace(/\\/g, '/').replace(/^\.?\//, '');
  if (ref === '') return null;
  if (/\.[cm]?js$/i.test(ref)) return ref;
  const m = /^(.*)\.(tsx?|mts|cts)$/i.exec(ref);
  return m ? `${m[1]}.js` : null;
}

// ─── Hashing ────────────────────────────────────────────────────────────

/**
 * A short content hash of the bytes.
 *
 * SHA-256 where `crypto.subtle` exists (it is async and secure-context-only),
 * FNV-1a otherwise. The token is a cache key, not a security claim — the
 * fallback only has to distinguish two versions of a file the user just saved.
 */
export async function hashBytes(bytes: ArrayBuffer): Promise<string> {
  try {
    const subtle = globalThis.crypto?.subtle;
    if (subtle) {
      const digest = await subtle.digest('SHA-256', bytes);
      return Array.from(new Uint8Array(digest).slice(0, 8))
        .map(b => b.toString(16).padStart(2, '0'))
        .join('');
    }
  } catch { /* fall through to FNV */ }
  const view = new Uint8Array(bytes);
  let h = 0x811c9dc5;
  for (let i = 0; i < view.length; i++) {
    h ^= view[i];
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

// ─── Export shape ───────────────────────────────────────────────────────

/**
 * The thing a module meant to hand over: its default export, `new`-ed when it
 * is a class.
 *
 * Both spellings are supported for the same reason `rv-plugin-loader.ts`
 * supports them — `export default class X` and `export default new X()` are
 * both idiomatic, and which one a project author picked is not something the
 * loader should have an opinion about. A module with no default export hands
 * over its namespace, which is how a `registerModelPlugins`/
 * `unregisterModelPlugins` pair written as two named exports arrives.
 */
export function resolveModuleExport(namespace: Record<string, unknown>): unknown {
  const candidate = 'default' in namespace ? namespace.default : namespace;
  if (typeof candidate === 'function') {
    try {
      return new (candidate as new () => unknown)();
    } catch (e) {
      debugWarn('plugins', `Runtime script default export could not be constructed: ${e}`);
      return null;
    }
  }
  return candidate;
}

// ─── The load ───────────────────────────────────────────────────────────

let _lastFailure: RuntimeScriptFailure | null = null;

/** Why the most recent {@link loadRuntimeScript} returned null. */
export function lastRuntimeScriptFailure(): RuntimeScriptFailure | null {
  return _lastFailure;
}

/**
 * Load the compiled sibling of `scriptRef` out of the project, or null.
 *
 * Null is the ordinary answer in three of the four failure modes — no sibling,
 * consent refused, import threw — and every one of them is a state the caller
 * handles the same way: no project code. {@link lastRuntimeScriptFailure} tells
 * them apart for diagnostics without turning a normal state into an exception.
 */
export async function loadRuntimeScript(
  scriptRef: string,
  opts: LoadRuntimeScriptOptions,
): Promise<RuntimeScriptLoad | null> {
  _lastFailure = null;
  const jsRef = jsSiblingOf(scriptRef);
  if (!jsRef) {
    _lastFailure = 'not-a-script-ref';
    return null;
  }

  let bytes: ArrayBuffer | null = null;
  try {
    bytes = await opts.source.readBytes(jsRef);
  } catch (e) {
    debugWarn('plugins', `Could not read the runtime script "${jsRef}": ${e}`);
    bytes = null;
  }

  let plainUrl: string | null = null;
  if (!bytes || bytes.byteLength === 0) {
    try {
      plainUrl = (await opts.source.resolveUrl?.(jsRef)) ?? null;
    } catch { plainUrl = null; }
    if (!plainUrl) {
      _lastFailure = 'no-sibling';
      return null;
    }
  }

  // Only now — with something to run — is the question worth asking (2b.3).
  // The `try` covers a SYNCHRONOUS throw out of the gate too — `.catch()` alone
  // would not, and a consent callback that explodes must deny, not propagate.
  let granted = false;
  try {
    granted = opts.consent ? await opts.consent({ scriptRef, jsRef }) : false;
  } catch (e) {
    debugWarn('plugins', `Consent gate failed for "${jsRef}" — denying: ${e}`);
    granted = false;
  }
  if (!granted) {
    debugWarn(
      'plugins',
      `Native project code "${jsRef}" was NOT loaded: this project has no consent to run `
      + 'executable code. Open the project and confirm the prompt to allow it.',
    );
    _lastFailure = 'denied';
    return null;
  }

  const version = bytes ? await hashBytes(bytes) : '';
  let objectUrl: string | null = null;
  const url = bytes
    ? (objectUrl = URL.createObjectURL(new Blob([bytes], { type: 'text/javascript' })))
    : `${plainUrl}${plainUrl!.includes('?') ? '&' : '?'}v=${encodeURIComponent(version || String(Date.now()))}`;

  try {
    const importer = opts.importer ?? ((u: string) => import(/* @vite-ignore */ u));
    const namespace = (await importer(url)) as Record<string, unknown>;
    if (!namespace || typeof namespace !== 'object') {
      _lastFailure = 'import-failed';
      return null;
    }
    debug('plugins', `Runtime script "${jsRef}" loaded (v${version || 'n/a'})`);
    return { value: resolveModuleExport(namespace), namespace, jsRef, version };
  } catch (e) {
    debugWarn('plugins', `Runtime script "${jsRef}" failed to import: ${e}`);
    _lastFailure = 'import-failed';
    return null;
  } finally {
    // The module graph holds what it needs; the URL is only the fetch handle.
    if (objectUrl) URL.revokeObjectURL(objectUrl);
  }
}
