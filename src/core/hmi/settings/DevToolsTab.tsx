// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useEffect, useCallback, useRef } from 'react';
import { Typography, Box, Button, CircularProgress, Switch } from '@mui/material';
import { PlayArrow } from '@mui/icons-material';
import { useViewer } from '../../../hooks/use-viewer';
import { StatRow, BudgetRow, budgetPct } from './settings-helpers';

interface DevStats {
  // Rendering
  fps: number;
  frameTime: number;
  drawCalls: number;
  geometries: number;
  textures: number;
  programs: number;
  heapMB: string;
  renderer: string;
  // Scene (from GLB)
  triangles: number;
  meshesInGlb: number;
  materialsOriginal: number;
  materialsDeduped: number;
  drives: number;
  glbSize: string;
  loadTime: string;
  // Optimization pipeline
  uberBakedMeshCount: number;
  uberSharedGeometryReuses: number;
  uberClonedGeometryCount: number;
  uberDisposedSourceGeometries: number;
  staticMergeIn: number;
  staticMergeOut: number;
  kinMergeGroups: number;
  kinMergeIn: number;
  kinMergeOut: number;
}

const PERF_BUDGETS = {
  triangles: 2_000_000,
  drawCalls: 500,
  frameTime: 33.33, // 30fps floor — 60fps (16.7ms) shows ~50% green
  textures: 200,
  geometries: 500,
  heapMB: 512,
};

/** Section header. */
function SectionHeader({ children }: { children: string }) {
  return (
    <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
      {children}
    </Typography>
  );
}

/** A "before → after" stat row with dim before and bright after. */
function PipelineRow({ label, before, after }: { label: string; before: string; after: string }) {
  return (
    <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
      <Typography variant="caption" sx={{ color: 'text.secondary' }}>{label}</Typography>
      <Typography variant="caption" sx={{ fontFamily: 'monospace', fontWeight: 600 }}>
        <span style={{ color: 'rgba(255,255,255,0.35)' }}>{before}</span>
        <span style={{ color: 'rgba(255,255,255,0.25)', margin: '0 4px' }}>{'\u2192'}</span>
        <span style={{ color: '#66bb6a' }}>{after}</span>
      </Typography>
    </Box>
  );
}

export function DevToolsTab() {
  const viewer = useViewer();
  const [stats, setStats] = useState<DevStats | null>(null);
  const [benchRunning, setBenchRunning] = useState(false);
  const [benchResult, setBenchResult] = useState<{ uncappedFps: number; avgFrameMs: number; headroom: number } | null>(null);
  const [showStats, setShowStats] = useState(viewer.showStats);
  const [infoLogging, setInfoLogging] = useState(viewer.rendererInfoLogging);
  const prevStatsHashRef = useRef('');

  const runBenchmark = useCallback(async () => {
    setBenchRunning(true);
    setBenchResult(null);
    await new Promise((r) => setTimeout(r, 50));
    const result = await viewer.runBenchmark(120);
    setBenchResult(result);
    setBenchRunning(false);
  }, [viewer]);

  useEffect(() => {
    const interval = setInterval(() => {
      const info = viewer.getRendererInfo();
      const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
      const heapMB = mem?.usedJSHeapSize ? (mem.usedJSHeapSize / (1024 * 1024)).toFixed(0) : '--';
      const hash = `${viewer.currentFps}|${info.triangles}|${info.drawCalls}|${info.programs}|${info.materialsUnique}|${heapMB}|${viewer.drives.length}`;
      if (hash === prevStatsHashRef.current) return;
      prevStatsHashRef.current = hash;
      setStats({
        fps: viewer.currentFps,
        frameTime: viewer.currentFrameTime,
        drawCalls: info.drawCalls,
        geometries: info.geometries,
        textures: info.textures,
        programs: info.programs,
        heapMB,
        renderer: viewer.isWebGPU ? 'WebGPU' : 'WebGL',
        triangles: info.triangles,
        meshesInGlb: info.materialsOriginal, // materialsOriginal ≈ meshes in GLB (1 mat per mesh before dedup)
        materialsOriginal: info.materialsOriginal,
        materialsDeduped: info.materialsUnique,
        drives: viewer.drives.length,
        glbSize: viewer.lastLoadInfo?.glbSize ?? '--',
        loadTime: viewer.lastLoadInfo?.loadTime ?? '--',
        uberBakedMeshCount: info.uberBakedMeshCount,
        uberSharedGeometryReuses: info.uberSharedGeometryReuses,
        uberClonedGeometryCount: info.uberClonedGeometryCount,
        uberDisposedSourceGeometries: info.uberDisposedSourceGeometries,
        staticMergeIn: info.uberMergeOriginal,
        staticMergeOut: info.uberMergeCreated,
        kinMergeGroups: info.kinGroupsMerged,
        kinMergeIn: info.kinSourceMeshes,
        kinMergeOut: info.kinChunksCreated,
      });
    }, 200);
    return () => clearInterval(interval);
  }, [viewer]);

  const s = stats;
  const heapNum = s ? parseFloat(s.heapMB) || 0 : 0;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      {/* Profiler toggles */}
      <Box>
        <SectionHeader>Profiler</SectionHeader>
        <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="body2" sx={{ color: 'text.primary' }}>FPS / GPU Overlay</Typography>
            <Switch size="small" checked={showStats} onChange={(_, v) => { viewer.showStats = v; setShowStats(v); }} />
          </Box>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="body2" sx={{ color: 'text.primary' }}>Console Perf Log</Typography>
            <Switch size="small" checked={infoLogging} onChange={(_, v) => { viewer.rendererInfoLogging = v; setInfoLogging(v); }} />
          </Box>
        </Box>
      </Box>

      {/* ─── Scene (from GLB) ─── */}
      <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)', pt: 1.5 }}>
        <SectionHeader>Scene (from GLB)</SectionHeader>
        <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          <StatRow label="Triangles" value={s ? s.triangles.toLocaleString() : '--'} />
          <StatRow label="Meshes" value={s ? s.meshesInGlb.toLocaleString() : '--'} />
          <StatRow label="Drives" value={s ? String(s.drives) : '--'} />
          <StatRow label="GLB Size" value={s?.glbSize ?? '--'} />
          <StatRow label="Load Time" value={s?.loadTime ?? '--'} />
        </Box>
      </Box>

      {/* ─── Optimization Pipeline ─── */}
      <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)', pt: 1.5 }}>
        <SectionHeader>Optimization</SectionHeader>
        <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          <PipelineRow
            label="Materials"
            before={s ? s.materialsOriginal.toLocaleString() : '--'}
            after={s ? String(s.materialsDeduped) : '--'}
          />
          <StatRow
            label="Uber Baked"
            value={s ? `${s.uberBakedMeshCount.toLocaleString()} meshes` : '--'}
          />
          <PipelineRow
            label="Geometry Dedup"
            before={
              s
                ? `${(s.uberSharedGeometryReuses + s.uberClonedGeometryCount).toLocaleString()} candidates`
                : '--'
            }
            after={
              s
                ? `${s.uberSharedGeometryReuses.toLocaleString()} shared / ${s.uberClonedGeometryCount.toLocaleString()} cloned`
                : '--'
            }
          />
          <PipelineRow
            label="Static Merge"
            before={s ? s.staticMergeIn.toLocaleString() : '--'}
            after={s ? `${s.staticMergeOut} meshes` : '--'}
          />
          <PipelineRow
            label="Kinematic Merge"
            before={s ? `${s.kinMergeIn.toLocaleString()} (${s.kinMergeGroups} groups)` : '--'}
            after={s ? `${s.kinMergeOut} meshes` : '--'}
          />
        </Box>
      </Box>

      {/* ─── Rendering ─── */}
      <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)', pt: 1.5 }}>
        <SectionHeader>Rendering</SectionHeader>
        <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.75 }}>
          <StatRow label="FPS" value={s ? String(s.fps) : '--'} />
          <StatRow label="Frame" value={s ? `${s.frameTime} ms` : '--'} />
          <StatRow label="Draw Calls" value={s ? String(s.drawCalls) : '--'} />
          <StatRow label="Geometries" value={s ? String(s.geometries) : '--'} />
          <StatRow label="Textures" value={s ? String(s.textures) : '--'} />
          <StatRow label="Programs" value={s ? String(s.programs) : '--'} />
          <StatRow label="JS Heap" value={s ? `${s.heapMB} MB` : '--'} />
          <StatRow label="Renderer" value={s?.renderer ?? '--'} />
        </Box>
      </Box>

      {/* ─── Performance Budget ─── */}
      <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)', pt: 1.5 }}>
        <SectionHeader>Performance Budget</SectionHeader>
        <Box sx={{ mt: 1, fontSize: 12, color: 'text.secondary' }}>
          {s && <>
            <BudgetRow label="Triangles" {...budgetPct(s.triangles, PERF_BUDGETS.triangles)} />
            <BudgetRow label="Draw Calls" {...budgetPct(s.drawCalls, PERF_BUDGETS.drawCalls)} />
            <BudgetRow label="Frame Time" {...budgetPct(s.frameTime, PERF_BUDGETS.frameTime)} />
            <BudgetRow label="Textures" {...budgetPct(s.textures, PERF_BUDGETS.textures)} />
            <BudgetRow label="Geometries" {...budgetPct(s.geometries, PERF_BUDGETS.geometries)} />
            <BudgetRow label="JS Heap" {...budgetPct(heapNum, PERF_BUDGETS.heapMB)} />
          </>}
        </Box>
      </Box>

      {/* ─── GPU Benchmark ─── */}
      <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)', pt: 1.5 }}>
        <SectionHeader>GPU Benchmark</SectionHeader>
        <Box sx={{ mt: 1 }}>
          <Button
            variant="outlined"
            size="small"
            onClick={runBenchmark}
            disabled={benchRunning}
            startIcon={benchRunning ? <CircularProgress size={12} /> : <PlayArrow sx={{ fontSize: 14 }} />}
            sx={{ fontSize: 11, textTransform: 'none', borderColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)' }}
          >
            {benchRunning ? 'Running...' : 'Run Benchmark (120 frames)'}
          </Button>
          {benchResult && (
            <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
              <StatRow label="Uncapped FPS" value={String(benchResult.uncappedFps)} color="#4fc3f7" />
              <StatRow label="Avg Frame" value={`${benchResult.avgFrameMs} ms`} />
              <StatRow
                label="Headroom"
                value={`${benchResult.headroom}%`}
                color={benchResult.headroom > 200 ? '#66bb6a' : benchResult.headroom > 120 ? '#ffa726' : '#ef5350'}
              />
              <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', mt: 0.5 }}>
                {benchResult.headroom > 200 ? 'Plenty of GPU headroom' :
                 benchResult.headroom > 120 ? 'Moderate headroom — watch complexity' :
                 'Near GPU limit — optimize scene'}
              </Typography>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}
