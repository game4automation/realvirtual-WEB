// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * Tutorial recorder (plan-2004) — scene and GPU readiness as PURE decisions.
 *
 * The page delivers raw values only (`readSceneRaw` / `readGpuRaw` run inside `page.evaluate`);
 * the verdict is computed here, so it can be tested without a browser.
 *
 * Why these decisions are their own module: `whenSceneReady()` alone is not enough — it never
 * rejects and reports ready after a FAILED load (`rv-scene-ready.ts:69ff`). Readiness therefore
 * demands everything at once: the scene-ready report, a set `currentModelRoot`, and — if the
 * storyboard names one — the expected document.
 */

/**
 * The raw values the page must deliver for the scene decision.
 *
 * Collected in the page as:
 *   `{ ready, modelRoot: viewer.currentModelRoot?.name ?? null, doc, elapsedMs }`
 */
export function sceneVerdict(raw, { doc = undefined, timeoutMs = 60000 } = {}) {
  const elapsedMs = raw?.elapsedMs ?? 0;
  const exhausted = elapsedMs >= timeoutMs;

  if (!raw || raw.ready !== true) {
    return exhausted
      ? { verdict: 'error', diagnosis: 'step-error', reason: `scene not ready within ${timeoutMs} ms — awaitSceneReady did not report ready` }
      : { verdict: 'waiting', reason: 'scene-ready report not in yet' };
  }
  // Ready WITHOUT a model root is NOT terminal. Measured three times: `whenSceneReady()` resolves
  // after 0.10 ms on the ALREADY SETTLED promise of the empty start scene, while
  // `currentModelRoot` only appears 1093-1351 ms later. A terminal verdict here is what made the
  // setup path one-shot (it never consumed its 120 s budget). So this is a WAITING state while
  // the budget lasts and an error only once it is exhausted — the same shape as `!ready` above.
  // Exhausted still means what it always meant: a failed load or an empty viewer.
  if (!raw.modelRoot) {
    return exhausted
      ? { verdict: 'error', diagnosis: 'step-error', reason: `scene reports ready but viewer.currentModelRoot is still unset after ${timeoutMs} ms — failed load or empty viewer` }
      : { verdict: 'waiting', reason: 'scene ready, but viewer.currentModelRoot is not set yet' };
  }
  // Same reasoning for the document: while a load is in flight `currentModelUrl` still names the
  // previous document (or none). Only an exhausted budget turns the mismatch into a refusal —
  // otherwise a caller that names `doc` could never WAIT for the right model to arrive, which is
  // the whole point of naming it.
  if (doc !== undefined && raw.doc !== doc) {
    return exhausted
      ? { verdict: 'error', diagnosis: 'step-error', reason: `wrong document loaded: expected '${doc}', got '${String(raw.doc)}' after ${timeoutMs} ms` }
      : { verdict: 'waiting', reason: `waiting for document '${doc}', currently '${String(raw.doc)}'` };
  }
  return { verdict: 'ok', modelRoot: raw.modelRoot, doc: raw.doc ?? null };
}

/**
 * GPU readiness AND the coupled decision about `--motion-check off` (G2).
 *
 * `--gpu-check off` is for the canvas-less E2E fixture only. `--motion-check off` is accepted ONLY
 * when `gpuCheck === 'off'` AND the probe finds NO WebGL canvas — it is the same probe, not a new
 * feature of the runner. Anything else is Exit 2 `motion-check-off-with-viewer`: a gate that can
 * be switched off at will is not a gate.
 *
 * `--epoch-zero-diagnosis` is the mirror image: it MEASURES `simTime`/`fixedStepCount` and motion,
 * so without a canvas there is nothing to measure — Exit 2 `epoch-zero-diagnosis-needs-viewer`.
 * The two rules have an empty intersection, which is why the incompatibility needs no rule of its
 * own.
 */
export function gpuVerdict(raw, { gpuCheck = 'require', motionCheck = 'require', epochZeroDiagnosis = false } = {}) {
  const hasCanvas = raw?.hasWebglCanvas === true;
  const renderer = raw?.renderer ?? null;

  if (motionCheck === 'off' && (gpuCheck !== 'off' || hasCanvas)) {
    return {
      verdict: 'error', exitCode: 2, diagnosis: 'motion-check-off-with-viewer',
      reason: '--motion-check off is accepted only together with --gpu-check off AND a page without a WebGL canvas',
      hasCanvas, renderer,
    };
  }
  if (epochZeroDiagnosis && (gpuCheck === 'off' || !hasCanvas)) {
    return {
      verdict: 'error', exitCode: 2, diagnosis: 'epoch-zero-diagnosis-needs-viewer',
      reason: '--epoch-zero-diagnosis measures simTime/fixedStepCount and motion; without a viewer there is nothing to measure',
      hasCanvas, renderer,
    };
  }
  if (gpuCheck === 'off') {
    return { verdict: 'skipped', hasCanvas, renderer, motionCheck, reason: 'gpu check off (canvas-less fixture)' };
  }
  if (!hasCanvas || !renderer) {
    return { verdict: 'error', exitCode: 1, diagnosis: 'step-error', reason: 'no WebGL context on the page — the recording would show an empty viewer', hasCanvas, renderer };
  }
  if (/swiftshader|software|llvmpipe/i.test(renderer)) {
    return { verdict: 'error', exitCode: 1, diagnosis: 'step-error', reason: `software rasteriser detected (UNMASKED_RENDERER_WEBGL = ${renderer}) — roughly 17x slower, recording refused`, hasCanvas, renderer };
  }
  return { verdict: 'ok', hasCanvas, renderer, motionCheck };
}

// The null-epoch preflight lives in `epoch-preflight.mjs` since the B2 decision (2026-10-27).
