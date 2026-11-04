// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Dev-server test API — the capability is ASKED FOR, never inferred.
 *
 * `POST /__api/tests/run` exists only where something answers the `/__api/*`
 * prefix: the Vite dev server (`testRunnerPlugin` in `vite.config.ts`), or
 * realvirtual CONNECT's dev proxy, which forwards that whole prefix to a
 * supervised dev server once `Dev:ApiKey` + the *Allow remote access (dev)*
 * toggle are both armed (plan-383). A static deploy — the public demo, a
 * hosted customer project, a plain `dist/` on a CDN — has no such route: the
 * SPA fallback answers `index.html` with **HTTP 200**, so `resp.ok` is true,
 * `res.json()` throws, and the UI showed the visitor `Unexpected token '<'`.
 *
 * Why not `import.meta.env.DEV`: a build served from CONNECT's origin can
 * legitimately reach the route (that origin carries the dev proxy, `/webviewer`
 * and `/mcp` together), so a build-mode gate would hide a surface that is
 * genuinely usable there. The question is not "how was this bundled" but "does
 * this origin answer the route with JSON" — and only the origin can answer it.
 *
 * Contract:
 *  - ONE request per session. The promise is memoised at module scope, so N
 *    panel opens, N tab mounts and N consumers share one answer.
 *  - Never blocks a caller. Consumers read the synchronous snapshot (`null`
 *    until the answer is in) and subscribe; a tab appears when it resolves.
 *  - A negative answer is silent. An absent route is the normal state of every
 *    delivered build and must not put anything in a visitor's console.
 *  - Detection is by PAYLOAD, not by status or content-type alone — the same
 *    rule `connect-store.ts`'s `_readGatewayJson` applies to the gateway, and
 *    for the same reason: every web server that can end up on this origin
 *    answers 200 with HTML.
 */

/** Index route: answers `{ files: string[] }`. Used as the capability probe. */
const TESTS_INDEX = '/__api/tests';

/** Run route: answers a vitest JSON report. */
export const TESTS_RUN = '/__api/tests/run';

/** What the dev test API reported about itself, or `null` when there is none. */
export interface DevTestApi {
  /** Test files the server offers to run (may be empty on a checkout without `tests/`). */
  readonly files: readonly string[];
}

/** Thrown when a route answered, but with something that is not JSON. */
export class DevApiUnavailableError extends Error {
  constructor(route: string, contentType: string) {
    super(
      `${route} answered with ${contentType || 'a non-JSON body'} instead of JSON`,
    );
    this.name = 'DevApiUnavailableError';
  }
}

/**
 * Read a dev-API response as JSON, telling "no such route" apart from "broken JSON".
 *
 * A JSON content-type takes the direct path; anything else is read as text and
 * accepted only when it actually parses. An SPA fallback's `index.html` fails
 * both and raises {@link DevApiUnavailableError}, which the caller can turn
 * into a sentence instead of a parser message.
 */
export async function readDevApiJson<T>(resp: Response, route: string): Promise<T> {
  const contentType = resp.headers.get('content-type') ?? '';
  if (/\bjson\b/i.test(contentType)) return await resp.json() as T;
  const body = await resp.text();
  try {
    return JSON.parse(body) as T;
  } catch {
    throw new DevApiUnavailableError(route, contentType);
  }
}

let _probe: Promise<DevTestApi | null> | null = null;
let _snapshot: DevTestApi | null = null;
const _listeners = new Set<() => void>();

async function ask(): Promise<DevTestApi | null> {
  try {
    // `no-store`: a cached `index.html` from an earlier navigation must not be
    // mistaken for an answer, and the answer is one tiny JSON body anyway.
    const resp = await fetch(TESTS_INDEX, { cache: 'no-store' });
    if (!resp.ok) return null;
    const json = await readDevApiJson<{ files?: unknown }>(resp, TESTS_INDEX);
    // The shape IS the capability: a route that cannot name its test files is
    // not the test runner, whatever else it answered with.
    if (!Array.isArray(json.files)) return null;
    return { files: json.files.filter((f): f is string => typeof f === 'string') };
  } catch {
    // No route, offline, blocked, HTML — all the same thing to a caller, and
    // all the normal state of a delivered build. Deliberately silent.
    return null;
  }
}

/**
 * Probe the dev test API. Resolves to its description, or `null` when this
 * origin does not serve it. Safe to call from anywhere, any number of times —
 * the request happens once per session.
 */
export function probeDevTestApi(): Promise<DevTestApi | null> {
  _probe ??= ask().then((result) => {
    _snapshot = result;
    for (const listener of _listeners) listener();
    return result;
  });
  return _probe;
}

/** Synchronous snapshot: `null` while the probe is in flight AND when it failed. */
export function getDevTestApi(): DevTestApi | null {
  return _snapshot;
}

/** Subscribe to the one state change the probe can produce. */
export function subscribeDevTestApi(listener: () => void): () => void {
  _listeners.add(listener);
  return () => { _listeners.delete(listener); };
}

/** Test seam only — forget the memoised answer so a case can probe again. */
export function __resetDevTestApiProbe(): void {
  _probe = null;
  _snapshot = null;
  _listeners.clear();
}
