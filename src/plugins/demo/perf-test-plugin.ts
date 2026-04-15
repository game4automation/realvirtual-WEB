// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * PerfTestPlugin — Automated performance test triggered via `?perf` URL param.
 *
 * After the model loads, it samples FPS for a configurable duration,
 * runs a GPU benchmark, then displays results in a minimal overlay
 * and writes them to `window.__PERF_RESULTS__` for Playwright/CI.
 */

import type { RVViewerPlugin } from '../../core/rv-plugin';
import type { RVViewer } from '../../core/rv-viewer';
import type { LoadResult } from '../../core/engine/rv-scene-loader';
import { debug, logInfo } from '../../core/engine/rv-debug';

const TEST_DURATION_S = 5;
const SAMPLE_INTERVAL_MS = 500;

export interface PerfResults {
  model: string;
  loadTime: string;
  glbSize: string;
  fps: { min: number; avg: number; max: number };
  frameTime: { min: number; avg: number; max: number };
  benchmark: { uncappedFps: number; avgFrameMs: number; headroom: number };
  renderer: { triangles: number; drawCalls: number; geometries: number; textures: number };
  timestamp: string;
  pass: boolean;
}

declare global {
  interface Window { __PERF_RESULTS__?: PerfResults }
}

export class PerfTestPlugin implements RVViewerPlugin {
  readonly id = 'perf-test';
  readonly order = 9999; // run last

  onModelLoaded(_result: LoadResult, viewer: RVViewer): void {
    // Small delay to let first frames settle (JIT, shader compile, etc.)
    setTimeout(() => this.run(viewer), 1000);
  }

  private async run(viewer: RVViewer): Promise<void> {
    const modelUrl = viewer.currentModelUrl ?? 'unknown';
    // Blob URLs (from streaming download) have no meaningful filename — derive from title or localStorage
    let modelName: string;
    if (modelUrl.startsWith('blob:')) {
      const titleMatch = document.title.match(/^(.+?) - realvirtual/i);
      modelName = titleMatch?.[1] ?? localStorage.getItem('rv-webviewer-last-model')?.split('/').pop()?.replace(/\.glb$/i, '') ?? 'demo';
    } else {
      modelName = (modelUrl.split('/').pop() ?? modelUrl).split('?')[0].replace(/\.glb$/i, '');
    }
    const loadInfo = viewer.lastLoadInfo ?? { glbSize: '--', loadTime: '--' };

    // Open drives chart so UI overhead is included in measurements
    viewer.toggleDriveChart(true);
    // Let React re-render and chart animate in before sampling
    await new Promise((r) => setTimeout(r, 500));

    debug('render', `[perf] Starting ${TEST_DURATION_S}s FPS sampling (drives chart open)...`);

    // --- Sample FPS ---
    const fpsSamples: number[] = [];
    const ftSamples: number[] = [];
    const totalSamples = Math.floor((TEST_DURATION_S * 1000) / SAMPLE_INTERVAL_MS);

    await new Promise<void>((resolve) => {
      let count = 0;
      const interval = setInterval(() => {
        fpsSamples.push(viewer.currentFps);
        ftSamples.push(viewer.currentFrameTime);
        count++;
        if (count >= totalSamples) {
          clearInterval(interval);
          resolve();
        }
      }, SAMPLE_INTERVAL_MS);
    });

    // Close chart before GPU benchmark (benchmark = raw render perf)
    viewer.toggleDriveChart(false);

    // --- GPU Benchmark ---
    debug('render', '[perf] Running GPU benchmark...');
    const benchmark = await viewer.runBenchmark(120);

    // --- Renderer info ---
    const rendererInfo = viewer.getRendererInfo();

    // --- Aggregate ---
    const stats = (arr: number[]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      return {
        min: Math.round(sorted[0] ?? 0),
        avg: Math.round(sorted.reduce((s, v) => s + v, 0) / sorted.length),
        max: Math.round(sorted[sorted.length - 1] ?? 0),
      };
    };

    const fps = stats(fpsSamples);
    const frameTime = stats(ftSamples);

    const results: PerfResults = {
      model: modelName,
      loadTime: loadInfo.loadTime,
      glbSize: loadInfo.glbSize,
      fps,
      frameTime,
      benchmark: {
        uncappedFps: benchmark.uncappedFps,
        avgFrameMs: Math.round(benchmark.avgFrameMs * 10) / 10,
        headroom: benchmark.headroom,
      },
      renderer: rendererInfo,
      timestamp: new Date().toISOString(),
      pass: fps.avg >= 30,
    };

    // --- Output ---
    window.__PERF_RESULTS__ = results;
    logInfo('[perf] Results: ' + JSON.stringify(results, null, 2));

    this.showOverlay(results);
  }

  private showOverlay(r: PerfResults): void {
    const el = document.createElement('div');
    const pass = r.pass;
    el.style.cssText = `
      position:fixed; top:16px; left:16px; z-index:99999;
      background:rgba(0,0,0,0.85); color:#e0e0e0; padding:16px 20px;
      border-radius:8px; font:13px/1.6 monospace; min-width:280px;
      border-left:4px solid ${pass ? '#4caf50' : '#f44336'};
    `;
    el.innerHTML = `
      <div style="font-size:15px;font-weight:bold;margin-bottom:8px">
        <span style="color:${pass ? '#4caf50' : '#f44336'}">${pass ? 'PASS' : 'FAIL'}</span>
        &nbsp; ${r.model}
      </div>
      <div>Load: ${r.loadTime} &middot; ${r.glbSize}</div>
      <div>FPS: <b>${r.fps.min}</b> / <b>${r.fps.avg}</b> / <b>${r.fps.max}</b> (min/avg/max)</div>
      <div>Frame: ${r.frameTime.min}ms / ${r.frameTime.avg}ms / ${r.frameTime.max}ms</div>
      <div>Benchmark: ${r.benchmark.uncappedFps} fps (${r.benchmark.headroom}% headroom)</div>
      <div style="color:#888;font-size:11px;margin-top:6px">
        ${r.renderer.triangles.toLocaleString()} tris &middot; ${r.renderer.drawCalls} draws &middot;
        ${r.renderer.geometries} geo &middot; ${r.renderer.textures} tex
      </div>
    `;
    document.body.appendChild(el);
  }
}
