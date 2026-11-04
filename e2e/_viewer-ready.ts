// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Viewer-ready helper for specs that must also work against a PRODUCTION build
 * (plan-503). `window.viewer` is THE viewer handle and is set in every build, so
 * everything here reads `window.viewer` — read-only. (`window.__rvViewer` used
 * to exist only under `import.meta.env.DEV`, which is why this helper was
 * written; since 2026-10-25 it is a plain alias of `window.viewer` published in
 * every build, and `window.viewer` stays the name to use.)
 *
 * Order matters on a deployed site (F13): when `settings.json` names a Google
 * Analytics id, `requireAnalyticsConsent()` (src/core/hmi/consent-gate.tsx)
 * blocks boot BEFORE the viewer exists — "Decline" keeps it blocked. So the
 * consent gate is answered first, then the model-loaded condition is awaited,
 * then the startup notices are dismissed. Analytics requests are aborted by
 * {@link blockAnalytics} so a smoke run never counts as a visitor.
 *
 * No env access here: `tests/playwright-config-prod-demo.node.test.ts` imports
 * the pure helpers ({@link disallowedNotFound}) directly.
 */

import type { Page } from 'playwright/test';

const ANALYTICS_HOSTS = /googletagmanager\.com|google-analytics\.com|analytics\.google\.com/;

/** Boot-time overlays, in the order a fresh profile usually shows them. */
export const DEFAULT_STARTUP_NOTICES: readonly string[] = Object.freeze(['welcome-dismiss', 'auto-quality-ok', 'welcome-start-demo', 'welcome-dismiss']);

/** Aborts every request to the analytics hosts. Call before `page.goto`. */
export async function blockAnalytics(page: Page): Promise<void> {
  await page.route(ANALYTICS_HOSTS, (route) => route.abort());
}

/**
 * Accepts the analytics consent gate if it is shown (deployed builds with a GA id).
 * Returns as soon as the gate was accepted or the viewer exists without one
 * (dev server, builds without a GA id).
 */
export async function answerConsentGate(page: Page, timeoutMs = 15_000): Promise<boolean> {
  const accept = page.getByRole('button', { name: 'Accept', exact: true });
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await accept.isVisible().catch(() => false)) {
      await accept.click();
      return true;
    }
    const booted = await page.evaluate(() => !!(window as unknown as { viewer?: unknown }).viewer).catch(() => false);
    if (booted) return false;
    await page.waitForTimeout(250);
  }
  return false;
}

/**
 * Best-effort dismissal of the boot-time overlays, in whichever order they
 * arrive. Each test id gets `appearTimeoutMs` to become visible; a notice that
 * never shows is fine.
 */
export async function dismissStartupNotices(
  page: Page,
  { testIds = DEFAULT_STARTUP_NOTICES, appearTimeoutMs = 3_000 }: { testIds?: readonly string[]; appearTimeoutMs?: number } = {},
): Promise<string[]> {
  const dismissed: string[] = [];
  for (const testId of testIds) {
    const btn = page.getByTestId(testId).first();
    try {
      await btn.waitFor({ state: 'visible', timeout: appearTimeoutMs });
    } catch {
      continue; // not shown on this run — fine
    }
    await btn.click({ timeout: 5_000 }).catch(() => {});
    await btn.waitFor({ state: 'hidden', timeout: 10_000 }).catch(() => {});
    dismissed.push(testId);
  }
  return dismissed;
}

export interface ViewerReadyOptions {
  /** Limit for the model-loaded condition. */
  timeoutMs?: number;
  /** Notices to dismiss afterwards (default {@link DEFAULT_STARTUP_NOTICES}). */
  notices?: readonly string[];
  /** Per-notice appear limit. */
  noticeTimeoutMs?: number;
}

/**
 * Waits until the model is loaded (`window.viewer.currentModelUrl` set AND
 * `#loading-overlay.hidden`), answering the consent gate first and dismissing
 * the startup notices afterwards.
 */
export async function waitForViewerReady(
  page: Page,
  { timeoutMs = 120_000, notices = DEFAULT_STARTUP_NOTICES, noticeTimeoutMs = 3_000 }: ViewerReadyOptions = {},
): Promise<{ modelUrl: string; dismissed: string[] }> {
  await answerConsentGate(page);
  await page.waitForFunction(() => {
    const viewer = (window as unknown as { viewer?: { currentModelUrl?: string | null } }).viewer;
    const overlay = document.getElementById('loading-overlay');
    return !!viewer?.currentModelUrl && !!overlay?.classList.contains('hidden');
  }, undefined, { timeout: timeoutMs });
  const dismissed = await dismissStartupNotices(page, { testIds: notices, appearTimeoutMs: noticeTimeoutMs });
  const modelUrl = await page.evaluate(() => (window as unknown as { viewer: { currentModelUrl: string } }).viewer.currentModelUrl);
  return { modelUrl, dismissed };
}

/**
 * Waits for the Layout Planner's placements (a planner document is an empty
 * shell whose placements materialise after model-loaded). ALWAYS bounded: the
 * spike's one unexplained planner failure was an unbounded wait after reload.
 */
export async function waitForPlacementsMaterialized(page: Page, timeoutMs = 60_000): Promise<void> {
  await page.evaluate(async (limit) => {
    const lp = (window as unknown as { viewer: { getPlugin(id: string): { whenPlacementsMaterialized?(): Promise<unknown> } | undefined } })
      .viewer.getPlugin('layout-planner');
    await Promise.race([
      lp?.whenPlacementsMaterialized?.(),
      new Promise((_, reject) => setTimeout(() => reject(new Error(`whenPlacementsMaterialized did not settle within ${limit / 1000} s`)), limit)),
    ]);
  }, timeoutMs);
}

/**
 * The browser's own log line for a failed resource ("Failed to load resource:
 * the server responded with a status of 404 ()"). 404s are NOT judged through
 * the console but through the responses ({@link collectNotFound} +
 * {@link disallowedNotFound}), which know the URL — so exactly this line is
 * dropped here, never "anything containing 404" (plan-503 F2).
 */
const RESOURCE_404 = /Failed to load resource: the server responded with a status of 404/;

/** Console / page errors that are infrastructure noise, not a demo defect. */
export function criticalErrors(errors: string[]): string[] {
  return errors.filter(
    (e) => !e.includes('favicon.ico') && !e.includes('net::ERR_')
      && !e.includes('ResizeObserver') && !RESOURCE_404.test(e)
      && !e.includes('409 (Conflict)'),
  );
}

/** Collects `pageerror` and console errors from the moment it is called. */
export function collectErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', (err) => errors.push(`pageerror: ${err.message}`));
  page.on('console', (msg) => { if (msg.type() === 'error') errors.push(msg.text()); });
  return errors;
}

/** Collects the URL of every 404 response from the moment it is called. */
export function collectNotFound(page: Page): string[] {
  const urls: string[] = [];
  page.on('response', (res) => { if (res.status() === 404) urls.push(res.url()); });
  return urls;
}

/**
 * The 404s a demo boot may produce (plan-503 F2), relative to the deploy root:
 *
 * - `project.json` and `models.json` AT the deploy root — the boot probes both
 *   and falls back to the demo project; neither exists on a `demos` deploy;
 * - OPTIONAL `*.kin.json` sidecars anywhere — the loader tolerates them as
 *   "absent" (src/core/engine/rv-scene-loader.ts, kinematics sidecar fetch).
 * - `aasx/index.json` anywhere: the project's AASX index is optional (plan-596,
 *   src/core/aas/rv-aas-source.ts). A project without AASX files has none, and
 *   the merged source reads its 404 as "no project packages".
 * - `/health` at the ORIGIN root of the page (not the deploy root): the MCP
 *   bridge asks its own origin once per page load whether CONNECT serves the
 *   page (plan-541 SOL #10, page-load since plan-668 Phase 1 —
 *   src/plugins/mcp-bridge-plugin.ts `_probeSameOrigin`, pinned by
 *   tests/mcp-bridge-ai-gate.test.ts "one same-origin probe"). Same-origin, so
 *   no Local Network Access prompt; a CDN 404 is the designed "hosted" answer.
 *   A `/health` on ANY other origin (e.g. localhost:5100) stays a defect.
 *
 * Everything else — a GLB, a manifest, a chunk, a texture — is a defect.
 */
export function isAllowedNotFound(url: string, baseUrl: string): boolean {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const base = new URL(baseUrl);
  const basePath = base.pathname.replace(/\/?$/, '/');
  if (path === `${basePath}project.json` || path === `${basePath}models.json`) return true;
  if (parsed.origin === base.origin && path === '/health') return true;
  return /\.kin\.json$/i.test(path) || /\/aasx\/index\.json$/i.test(path);
}

/** The 404 URLs outside the allowlist of {@link isAllowedNotFound}. */
export function disallowedNotFound(urls: readonly string[], baseUrl: string): string[] {
  return urls.filter((url) => !isAllowedNotFound(url, baseUrl));
}
