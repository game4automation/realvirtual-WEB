// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * The live target of the `prod-demo` project (plan-503 §2.4). Throws at import
 * time — the specs FAIL, they never skip (A5): no base URL, no expected demo
 * ids or an unreachable host are findings, not reasons to go green.
 */

export const LIVE_BASE_URL = (() => {
  const url = process.env.RV_SMOKE_BASE_URL;
  if (!url) throw new Error('prod-demo: RV_SMOKE_BASE_URL is not set');
  return url.endsWith('/') ? url : `${url}/`;
})();

/** `{ hmi: docId, planner: docId }` — from the runner, i.e. from the LOCAL manifest of the uploaded build. */
export const EXPECTED_DEMOS: Record<string, string> = (() => {
  const raw = process.env.RV_SMOKE_EXPECTED_DEMOS;
  if (!raw) throw new Error('prod-demo: RV_SMOKE_EXPECTED_DEMOS is not set');
  const parsed = JSON.parse(raw) as Record<string, string>;
  for (const key of ['hmi', 'planner']) {
    if (typeof parsed[key] !== 'string' || !parsed[key]) {
      throw new Error(`prod-demo: RV_SMOKE_EXPECTED_DEMOS lacks "${key}"`);
    }
  }
  return parsed;
})();

// One reachability probe per worker, at import time (top-level await, ESM).
const probe = await fetch(`${LIVE_BASE_URL}demo-realvirtual/project.json`, {
  signal: AbortSignal.timeout(10_000),
  headers: { 'Cache-Control': 'no-cache' },
}).catch((e: unknown) => ({ ok: false, status: String(e) }) as const);
if (!probe.ok) throw new Error(`prod-demo: ${LIVE_BASE_URL} unreachable (${probe.status})`);
