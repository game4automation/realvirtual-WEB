// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Shared measurement definition of `npm run perf:first-frame` (plan-598 Phase 0).
 *
 * ONE definition, used by the cold run (`measure.cjs`) and the repeat visit
 * (`repeat.cjs`) alike — plan-598 SOL #5:
 *
 *   - ENDPOINT "Bild sichtbar": the moment the loading overlay STARTS to go
 *     away — its class list gains `fade-out` OR `hidden`, whichever comes first.
 *     Taken by a MutationObserver on the overlay, so it is exact, not a 20 ms poll.
 *   - CONTENT CHECK at the endpoint: `viewer.renderer.info.render.calls > 0`
 *     (the viewer resets `info` once per frame, so this is the last frame's
 *     total) AND `viewer.currentModel` set. Otherwise the run is INVALID — an
 *     overlay that hid on an error card is not a first plant frame.
 *   - LONG-TASK WINDOW: navigation start → endpoint (a task that starts before
 *     the endpoint counts).
 *   - Per run: GPU string (`WEBGL_debug_renderer_info`) and build hash (the
 *     content hash of the entry chunk; `dev` for an unbundled dev server).
 *
 * The perf phase tables are switched on through `localStorage rv-debug=perf`,
 * NEVER through `?debug=…`: the URL switch also loads eruda from jsdelivr, which
 * is exactly the kind of extra work this instrument must not measure.
 */

const path = require('path');
const fs = require('fs');

/** Repo root (…/realvirtual-WebViewer~), derived from this file — no checkout path anywhere. */
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
/** Result folder (git-ignored). Override with OUT_DIR. */
const OUT_DIR = process.env.OUT_DIR || path.join(__dirname, 'runs');

const CHROMIUM_ARGS = ['--use-angle=d3d11', '--enable-gpu', '--ignore-gpu-blocklist'];
const VIEWPORT = { width: 1600, height: 900 };

/** Acceptance defaults of plan-598 §1 NF. */
const DEFAULT_TARGET_MS = 3000;
const DEFAULT_REPEAT_TARGET_MS = 2000;
const DEFAULT_MAX_LONGTASK_MS = 500;

function playwright() {
  // Resolved from the repo's own node_modules — the scripts live inside the repo.
  return require(require.resolve('playwright', { paths: [REPO_ROOT] }));
}

function ensureOutDir() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  return OUT_DIR;
}

/**
 * The init script, injected before any page script runs. Records long tasks,
 * the `model-loaded` time and the endpoint with its content check.
 */
function endpointInitScript() {
  window.__lt = [];
  // The default resource-timing buffer holds 250 entries; a boot with many
  // chunks overflows it and the GLB entry is silently dropped.
  try { performance.setResourceTimingBufferSize(10000); } catch { /* old engine */ }
  try { localStorage.setItem('rv-debug', 'perf'); } catch { /* storage blocked */ }
  try {
    new PerformanceObserver((l) => {
      for (const e of l.getEntries()) window.__lt.push([Math.round(e.startTime), Math.round(e.duration)]);
    }).observe({ type: 'longtask', buffered: true });
  } catch { /* no longtask support */ }

  const takeEndpoint = (ov, kind) => {
    if (window.__endpoint) return;
    const v = window.viewer;
    let calls = null;
    try { calls = v && v.renderer && v.renderer.info && v.renderer.info.render ? v.renderer.info.render.calls : null; } catch { calls = null; }
    window.__endpoint = {
      at: performance.now(),
      kind,
      renderCalls: calls,
      hasModel: !!(v && v.currentModel),
    };
  };
  const watchOverlay = (ov) => {
    const check = () => {
      if (ov.classList.contains('fade-out')) takeEndpoint(ov, 'fade-out');
      else if (ov.classList.contains('hidden')) takeEndpoint(ov, 'hidden');
    };
    check();
    new MutationObserver(check).observe(ov, { attributes: true, attributeFilter: ['class'] });
  };
  const t = setInterval(() => {
    const v = window.viewer;
    if (v && !window.__hooked) {
      window.__hooked = true;
      window.__viewerAt = performance.now();
      try { v.on('model-loaded', () => { if (!window.__modelLoadedAt) window.__modelLoadedAt = performance.now(); }); } catch { /* old build */ }
    }
    const ov = document.getElementById('loading-overlay');
    if (ov && !window.__overlayWatched) { window.__overlayWatched = true; watchOverlay(ov); }
    if (window.__endpoint && window.__hooked) clearInterval(t);
  }, 10);
}

/** Wait for the endpoint. Resolves false on timeout (an ABORTED run). */
async function waitForEndpoint(page, timeoutMs) {
  try {
    await page.waitForFunction(() => !!window.__endpoint, null, { timeout: timeoutMs });
    return true;
  } catch {
    return false;
  }
}

/** Everything the definition needs, read from the page after the endpoint. */
async function readRun(page, opts = {}) {
  const maxLongTaskMs = opts.maxLongTaskMs ?? DEFAULT_MAX_LONGTASK_MS;
  const r = await page.evaluate(() => {
    const ep = window.__endpoint || null;
    let gpu = null;
    try {
      const c = document.createElement('canvas');
      const gl = c.getContext('webgl2') || c.getContext('webgl');
      const ext = gl && gl.getExtension('WEBGL_debug_renderer_info');
      gpu = ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : (gl ? gl.getParameter(gl.RENDERER) : null);
    } catch { gpu = null; }
    const entry = [...document.querySelectorAll('script[type="module"][src]')]
      .map((s) => s.getAttribute('src') || '')
      .find((s) => /assets\/index-[^/]+\.js/.test(s));
    const m = entry && entry.match(/index-([^./]+)\.js/);
    const buildHash = m ? m[1] : 'dev';
    const rs = performance.getEntriesByType('resource');
    const glb = rs.find((x) => /\.glb(\?|$)/i.test(x.name));
    const manifests = rs.filter((x) => /project\.json(\?|$)/.test(x.name)).map((x) => x.name.replace(location.origin, ''));
    const nav = performance.getEntriesByType('navigation')[0];
    return {
      endpoint: ep,
      modelLoadedAt: window.__modelLoadedAt ? Math.round(window.__modelLoadedAt) : null,
      viewerAt: window.__viewerAt ? Math.round(window.__viewerAt) : null,
      longtasks: window.__lt || [],
      gpu,
      buildHash,
      glbStart: glb ? Math.round(glb.startTime) : null,
      glbEnd: glb ? Math.round(glb.responseEnd) : null,
      glbTransferKB: glb ? Math.round((glb.transferSize || 0) / 1024) : null,
      totalTransferKB: Math.round(rs.reduce((a, x) => a + (x.transferSize || 0), 0) / 1024),
      manifestRequests: manifests,
      dcl: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
      programs: window.viewer && window.viewer.renderer && window.viewer.renderer.info && window.viewer.renderer.info.programs
        ? window.viewer.renderer.info.programs.length : null,
    };
  });
  return judgeRun(r, maxLongTaskMs);
}

/**
 * Apply the definition to raw page data: validity (content check) and the
 * long tasks inside the window. Pure — unit-testable without a browser.
 */
function judgeRun(r, maxLongTaskMs = DEFAULT_MAX_LONGTASK_MS) {
  const ep = r.endpoint;
  let invalidReason = null;
  if (!ep) invalidReason = 'no endpoint (overlay never started to hide)';
  else if (!(typeof ep.renderCalls === 'number' && ep.renderCalls > 0)) invalidReason = `no draw calls at the endpoint (calls=${ep.renderCalls})`;
  else if (!ep.hasModel) invalidReason = 'viewer.currentModel not set at the endpoint';
  const endAt = ep ? ep.at : Infinity;
  const inWindow = (r.longtasks || []).filter(([start]) => start >= 0 && start < endAt);
  const maxLongTask = inWindow.reduce((a, [, d]) => Math.max(a, d), 0);
  const longTaskSum = inWindow.reduce((a, [, d]) => a + d, 0);
  return {
    ...r,
    endpointAt: ep ? Math.round(ep.at) : null,
    endpointKind: ep ? ep.kind : null,
    renderCalls: ep ? ep.renderCalls : null,
    hasModel: ep ? ep.hasModel : false,
    // Legacy name kept for categorize.cjs / aftercallers.cjs.
    overlayHiddenAt: ep ? Math.round(ep.at) : null,
    longtasksToEndpoint: inWindow,
    maxLongTask,
    longTaskSum,
    valid: invalidReason === null,
    invalidReason,
    longTaskOk: maxLongTask <= maxLongTaskMs,
  };
}

function median(values) {
  const v = values.filter((x) => typeof x === 'number' && Number.isFinite(x)).sort((a, b) => a - b);
  if (v.length === 0) return null;
  return v[Math.floor(v.length / 2)];
}

/**
 * The series verdict (plan-598 §4 Phase 0): an invalid or aborted run fails the
 * series (it is never filtered out); every valid run must stay under the
 * long-task limit; the median of the endpoint must meet the target.
 * Returns { ok, exitCode, reasons } — exitCode 2 for invalid runs, 1 for an
 * acceptance violation, 0 for a pass.
 */
function seriesVerdict(runs, { targetMs = DEFAULT_TARGET_MS, maxLongTaskMs = DEFAULT_MAX_LONGTASK_MS } = {}) {
  const reasons = [];
  const invalid = runs.filter((r) => !r.valid);
  for (const r of invalid) reasons.push(`run ${r.run}: INVALID — ${r.invalidReason}`);
  for (const r of runs.filter((x) => x.valid && x.maxLongTask > maxLongTaskMs)) {
    reasons.push(`run ${r.run}: long task ${r.maxLongTask} ms > ${maxLongTaskMs} ms before the endpoint`);
  }
  const med = median(runs.filter((r) => r.valid).map((r) => r.endpointAt));
  if (med === null) reasons.push('no valid run — no median');
  else if (med > targetMs) reasons.push(`median "Bild sichtbar" ${med} ms > target ${targetMs} ms`);
  const exitCode = invalid.length > 0 ? 2 : reasons.length > 0 ? 1 : 0;
  return { ok: exitCode === 0, exitCode, reasons, median: med };
}

module.exports = {
  REPO_ROOT, OUT_DIR, CHROMIUM_ARGS, VIEWPORT,
  DEFAULT_TARGET_MS, DEFAULT_REPEAT_TARGET_MS, DEFAULT_MAX_LONGTASK_MS,
  playwright, ensureOutDir, endpointInitScript, waitForEndpoint, readRun, judgeRun, median, seriesVerdict,
};
