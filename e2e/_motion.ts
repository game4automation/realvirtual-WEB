// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * "Does the machine move on screen?" — shared by the live HMI journey
 * (e2e/prod-demo/hmi-journey.spec.ts) and its LOCAL calibration
 * (e2e/prod-demo-calibration/motion-threshold.spec.ts), so both measure with the
 * same clip, the same frames and the same threshold (plan-503 §2.5).
 *
 * Method: a pixel diff of a MACHINE clip — the projected bounding box of the
 * drives that move on their own (read-only `viewer.drives[].currentPosition`),
 * cut to the canvas and kept clear of the bottom bar. Three frames
 * t0 / t0+1.5 s / t0+3 s; motion = at least one pair above the threshold.
 * `page.screenshot({ clip })` captures the page (CDP), so it is independent of
 * `preserveDrawingBuffer` — which is why panels must not cover the clip.
 */

import type { Page, TestInfo } from 'playwright/test';
import pixelmatch from 'pixelmatch';
import { PNG } from 'pngjs';

/**
 * Share of changed pixels (pixelmatch threshold 0.1) in the machine clip above
 * which a frame pair counts as motion.
 *
 * Calibrated 2026-09-26 by e2e/prod-demo-calibration/motion-threshold.spec.ts
 * (headless Chromium/SwiftShader, 1280×720, DemoRealvirtualWeb on the dev server,
 * clip 337×241 px): moving 0.0051 / 0.0063 / 0.0074, paused simulation 0 / 0 / 0,
 * empty clip while running 0 / 0 / 0. Live /dev/ (spike, two runs): moving
 * 0.0036–0.0075. 0.001 sits far above the measured noise floor (0) and 3.6× below
 * the smallest moving ratio ever measured.
 */
export const MOTION_THRESHOLD = 0.001;

export interface Clip { x: number; y: number; width: number; height: number }

/** Drives that move on their own (sampled 1 s apart, read-only) → projected union box → clip. */
export async function machineClip(page: Page): Promise<{ clip: Clip; drives: string[]; overlaps: string[] }> {
  return page.evaluate(async () => {
    /* eslint-disable @typescript-eslint/no-explicit-any */
    const v = (window as any).viewer;
    const s1 = v.drives.map((d: any) => d.currentPosition);
    await new Promise((r) => setTimeout(r, 1_000));
    const moving = v.drives.filter((d: any, i: number) => Math.abs(d.currentPosition - s1[i]) > 1e-6);
    const V = v.scene.position.constructor;
    const rect = v.renderer.domElement.getBoundingClientRect();
    let x0 = Infinity; let y0 = Infinity; let x1 = -Infinity; let y1 = -Infinity;
    for (const d of moving) {
      d.node.updateWorldMatrix(true, true);
      d.node.traverse((o: any) => {
        if (!o.isMesh || !o.visible) return;
        const g = o.geometry;
        if (!g.boundingBox) g.computeBoundingBox();
        const b = g.boundingBox;
        for (let i = 0; i < 8; i++) {
          const p = new V(i & 1 ? b.max.x : b.min.x, i & 2 ? b.max.y : b.min.y, i & 4 ? b.max.z : b.min.z)
            .applyMatrix4(o.matrixWorld);
          const s = v.projectPoint(p); // shared Vector2 — read at once
          if (!s) continue;
          x0 = Math.min(x0, s.x); y0 = Math.min(y0, s.y); x1 = Math.max(x1, s.x); y1 = Math.max(y1, s.y);
        }
      });
    }
    // Intersect with the canvas and keep clear of the bottom bar (bottom 64 px).
    const cx0 = Math.max(rect.left, rect.left + x0);
    const cy0 = Math.max(rect.top, rect.top + y0);
    const cx1 = Math.min(rect.right, rect.left + x1);
    const cy1 = Math.min(rect.bottom - 64, rect.top + y1);
    const clip = { x: Math.floor(cx0), y: Math.floor(cy0), width: Math.max(1, Math.floor(cx1 - cx0)), height: Math.max(1, Math.floor(cy1 - cy0)) };
    // Which visible overlay panels intersect the clip (they may carry live numbers).
    const overlaps: string[] = [];
    for (const el of Array.from(document.querySelectorAll('.MuiPaper-root, .MuiCard-root'))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0 || getComputedStyle(el).visibility === 'hidden') continue;
      if (r.right > clip.x && r.left < clip.x + clip.width && r.bottom > clip.y && r.top < clip.y + clip.height) {
        overlaps.push(`${(el.textContent ?? '').slice(0, 40)} @${Math.round(r.left)},${Math.round(r.top)} ${Math.round(r.width)}x${Math.round(r.height)}`);
      }
    }
    return { clip, drives: moving.map((d: any) => d.node.name), overlaps };
    /* eslint-enable @typescript-eslint/no-explicit-any */
  });
}

/** Share of pixels that differ between two PNG screenshots of the same size. */
export function diffRatio(a: Buffer, b: Buffer): number {
  const pa = PNG.sync.read(a);
  const pb = PNG.sync.read(b);
  const changed = pixelmatch(pa.data, pb.data, undefined, pa.width, pa.height, { threshold: 0.1 });
  return changed / (pa.width * pa.height);
}

/**
 * Three clip screenshots at t0 / t0+1.5 s / t0+3 s, written as FILES under the
 * test's output dir (a body attachment would sit base64 in the JSON report) and
 * attached by path. Returns the three pairwise ratios [0→1, 1→2, 0→2].
 */
export async function captureMotion(page: Page, testInfo: TestInfo, clip: Clip, label: string): Promise<number[]> {
  const frames: Buffer[] = [];
  const t0 = Date.now();
  for (const [i, at] of [0, 1_500, 3_000].entries()) {
    const wait = t0 + at - Date.now();
    if (wait > 0) await page.waitForTimeout(wait);
    const path = testInfo.outputPath(`${label}-frame-${i}.png`);
    frames.push(await page.screenshot({ clip, path }));
    await testInfo.attach(`${label}-frame-${i}`, { path, contentType: 'image/png' });
  }
  return [diffRatio(frames[0], frames[1]), diffRatio(frames[1], frames[2]), diffRatio(frames[0], frames[2])];
}
