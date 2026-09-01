// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useEffect, useCallback, useRef } from 'react';
import { Typography, Box, Button, CircularProgress, Switch, TextField } from '@mui/material';
import { PlayArrow, CleaningServices } from '@mui/icons-material';
import { useViewer } from '../../../hooks/use-viewer';
import { StatRow, BudgetRow, budgetPct, SettingsSection, FieldRow } from './settings-helpers';
import { isMetadataLoadingEnabled, DISABLE_METADATA_LS_KEY } from '../../engine/rv-dev-load-flags';
import type { RenderBackendId, RenderBackendStatus } from '../../render-backend/rv-render-backend';
import { ModelCache } from '../../../plugins/layout-planner/model-cache';
import { clearCache as clearLibrarySnapCache } from '../../../plugins/snap-point/library-snap-index';

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
  // GPU (active adapter + best-effort other adapters; see rv-gpu-info.ts)
  gpuActive: string;
  gpuArchitecture?: string;
  gpuHighPerf?: string;
  gpuLowPower?: string;
  // Diagnosis: tier + severity drive the colored badge and the
  // optional warning message below the GPU rows.
  gpuTier: 'software' | 'integrated' | 'discrete' | 'apple-silicon' | 'unknown';
  gpuSeverity: 'ok' | 'warning' | 'critical';
  gpuMessage?: string;
  gpuAction?: string;
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
  texBatchIn: number;
  texBatchOut: number;
  batchUniqueGeometries: number;
  batchArenaVertices: number;
  kinMergeGroups: number;
  kinMergeIn: number;
  kinMergeOut: number;
  // Picking & Highlight (pick-path metrics, EMA + last sample, pre-formatted ms)
  pickRaycastMs: string;
  pickRaycastLast: string;
  pickStaticMs: string;
  pickKinematicMs: string;
  pickOtherMs: string;
  pickResolveMs: string;
  pickHighlightMs: string;
  pickHighlightLast: string;
  pickStrategy: string;
  pickCount: number;
  pickHits: number;
  pickBvhPending: number;
  pickOverlayObjects: number;
  // Metadata load stats (from LoadResult.metadataStats)
  metadataNodes: number;
  metadataAabbCount: number;
  metadataAabbMs: string;
  hoverableRanges: number;
  // Node/signal path aliases for Three.js-deduped nodes (LoadResult.aliasStats).
  aliasNodes: number;
  aliasSignals: number;
  /** Alias registrations discarded because the path was already claimed. */
  aliasDropped: number;
  /** "<leaf> ×<count>" — the most-claimed alias leaf, i.e. the worst suffix scan. */
  aliasLargestBucket: string;
  aliasMs: string;
}

/** Display label per pick-path highlight strategy id. */
const PICK_STRATEGY_LABEL: Record<string, string> = {
  'outline': 'OutlinePass',
  'fill-proxy': 'Fill Proxy',
  'overlay-legacy': 'Overlay (legacy)',
  'bbox': 'BBox fallback',
  'mu-overlay': 'MU overlay',
  'none': '—',
};

const PERF_BUDGETS = {
  triangles: 2_000_000,
  drawCalls: 500,
  frameTime: 33.33, // 30fps floor — 60fps (16.7ms) shows ~50% green
  textures: 200,
  geometries: 500,
  heapMB: 512,
};

/** Color + label for the GPU tier pill next to the section header. */
function GPUTierBadge({
  tier, severity,
}: {
  tier: DevStats['gpuTier'];
  severity: DevStats['gpuSeverity'];
}) {
  // Severity drives colour (green/yellow/red); tier drives the label.
  // Tier 'unknown' or no analysis → no badge at all (avoids noise).
  if (tier === 'unknown') return null;
  const COLORS: Record<DevStats['gpuSeverity'], { fg: string; bg: string }> = {
    ok:       { fg: '#66bb6a', bg: 'rgba(102,187,106,0.15)' },
    warning:  { fg: '#ffa726', bg: 'rgba(255,167,38,0.15)'  },
    critical: { fg: '#ef5350', bg: 'rgba(239,83,80,0.18)'   },
  };
  const LABELS: Record<DevStats['gpuTier'], string> = {
    discrete:        'Discrete',
    'apple-silicon': 'Apple Silicon',
    integrated:      'Integrated',
    software:        'Software (CPU)',
    unknown:         '',
  };
  const c = COLORS[severity];
  return (
    <Box sx={{
      px: 0.75, py: 0.1,
      borderRadius: 1,
      fontSize: 10,
      fontWeight: 600,
      letterSpacing: 0.3,
      color: c.fg,
      bgcolor: c.bg,
      border: `1px solid ${c.fg}40`, // 25% alpha
    }}>
      {LABELS[tier]}
    </Box>
  );
}

/** Inline callout shown under the GPU rows when severity != 'ok'.
 *  Yellow for 'warning' (suboptimal but functional), red for 'critical'
 *  (software fallback). Two-line layout: message above, action below. */
function GPUDiagnosisCallout({
  severity, message, action,
}: {
  severity: DevStats['gpuSeverity'];
  message: string;
  action?: string;
}) {
  const isCritical = severity === 'critical';
  const fg = isCritical ? '#ef5350' : '#ffa726';
  const bg = isCritical ? 'rgba(239,83,80,0.08)' : 'rgba(255,167,38,0.08)';
  return (
    <Box sx={{
      mt: 1.25,
      p: 1,
      borderRadius: 1,
      bgcolor: bg,
      border: `1px solid ${fg}40`,
    }}>
      <Typography variant="caption" sx={{ color: fg, fontWeight: 600, display: 'block' }}>
        {message}
      </Typography>
      {action && (
        <Typography variant="caption" sx={{ color: 'rgba(255,255,255,0.55)', display: 'block', mt: 0.5 }}>
          {action}
        </Typography>
      )}
    </Box>
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

/** Human-readable label for a render-backend status. */
const RENDER_BACKEND_STATUS_LABEL: Record<RenderBackendStatus, string> = {
  idle: 'Three.js active',
  connecting: 'Connecting…',
  streaming: 'Streaming',
  loading: 'Loading scene…',
  waiting: 'Waiting for Omniverse',
  error: 'Error',
};

/**
 * Render-backend toggle (plan-256) — INTERNAL/experimental. Switches the 3D
 * render layer between Three.js (default) and an Omniverse RTX WebRTC stream.
 * Only rendered behind `__RV_INTERNAL__` (see caller) so it never ships in
 * customer deploys. HMI panels are unaffected by the switch.
 */
function RenderBackendSection() {
  const viewer = useViewer();
  const [backend, setBackend] = useState<RenderBackendId>(viewer.renderBackend);
  const [status, setStatus] = useState<RenderBackendStatus>(viewer.renderBackendStatus);
  const [switching, setSwitching] = useState(false);
  // Connection + drive-bridge config (plan-256). Local string state so the input
  // stays editable; committed to the viewer on change.
  const [signalingPort, setSignalingPort] = useState<string>(
    String((viewer.omniverseBackendConfig.signalingPort as number | undefined) ?? ''),
  );
  const [signalName, setSignalName] = useState<string>(viewer.omniverseDriveBridge.signalName ?? '');

  useEffect(() => {
    const offBackend = viewer.onRenderBackendChange((b) => setBackend(b));
    const offStatus = viewer.onRenderBackendStatusChange((s) => setStatus(s));
    // Sync in case state changed before subscription.
    setBackend(viewer.renderBackend);
    setStatus(viewer.renderBackendStatus);
    return () => { offBackend(); offStatus(); };
  }, [viewer]);

  const omniverseAvailable = viewer.hasRenderBackend('omniverse');

  const onToggle = useCallback(async (useOmniverse: boolean) => {
    setSwitching(true);
    try {
      await viewer.setRenderBackend(useOmniverse ? 'omniverse' : 'three');
    } catch (e) {
      console.warn('[DevTools] Render backend switch failed:', e);
    } finally {
      setSwitching(false);
    }
  }, [viewer]);

  const onSignalingPortChange = useCallback((raw: string) => {
    setSignalingPort(raw);
    const port = Number.parseInt(raw, 10);
    if (Number.isFinite(port)) viewer.setOmniverseBackendConfig({ signalingPort: port });
  }, [viewer]);

  const onSignalNameChange = useCallback((raw: string) => {
    setSignalName(raw);
    // Empty → clear (fall back to the first drive's CurrentPosition).
    viewer.setOmniverseDriveBridge({ signalName: raw.trim() === '' ? undefined : raw.trim() });
  }, [viewer]);

  return (
    <SettingsSection id="devtools-render-backend" title="3D Backend (experimental)">
      <FieldRow label="Omniverse RTX Stream">
        <Switch
          size="small"
          checked={backend === 'omniverse'}
          disabled={switching || !omniverseAvailable}
          onChange={(_, v) => { void onToggle(v); }}
        />
      </FieldRow>
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, mt: 0.5 }}>
        <StatRow label="Backend" value={backend === 'omniverse' ? 'Omniverse' : 'Three.js'} />
        {backend === 'omniverse' && (
          <StatRow
            label="Status"
            value={RENDER_BACKEND_STATUS_LABEL[status]}
            color={status === 'streaming' ? '#66bb6a' : status === 'error' ? '#ef5350' : '#ffa726'}
          />
        )}
      </Box>
      {omniverseAvailable && (
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.75, mt: 0.75 }}>
          <FieldRow label="Signaling Port">
            <TextField
              size="small"
              type="number"
              value={signalingPort}
              placeholder="49100"
              onChange={(e) => onSignalingPortChange(e.target.value)}
              sx={{ width: 96 }}
              inputProps={{ style: { fontSize: 11, padding: '2px 6px' } }}
            />
          </FieldRow>
          <FieldRow label="Drive Signal">
            <TextField
              size="small"
              value={signalName}
              placeholder="first drive"
              onChange={(e) => onSignalNameChange(e.target.value)}
              sx={{ width: 140 }}
              inputProps={{ style: { fontSize: 11, padding: '2px 6px' } }}
            />
          </FieldRow>
        </Box>
      )}
      <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', mt: 0.75 }}>
        {omniverseAvailable
          ? 'Replaces the Three.js 3D view with an Omniverse RTX WebRTC stream. HMI, signals and charts are unchanged. The port applies on the next connect; leave the signal empty to push the first drive’s position.'
          : 'Omniverse backend not registered in this build (internal tier only).'}
      </Typography>
    </SettingsSection>
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

  // Wipe the persistent GLB byte cache (Cache API bucket `rv-planner-glbs`)
  // plus the per-GLB snap-index localStorage, then reload. Planner GLBs are
  // cached by URL, so swapping a library file on disk while keeping its
  // filename serves stale bytes until these caches are cleared. The reload is
  // required because the in-memory decoded ModelCache still holds the old
  // Three.js Groups for the rest of the session.
  const [clearingCache, setClearingCache] = useState(false);
  const clearLibraryCache = useCallback(async () => {
    setClearingCache(true);
    try {
      await ModelCache.clearPersistentCache();
      clearLibrarySnapCache();
    } catch (e) {
      console.warn('[DevTools] Clear library cache failed:', e);
    }
    location.reload();
  }, []);

  useEffect(() => {
    const interval = setInterval(() => {
      const info = viewer.getRendererInfo();
      const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number } }).memory;
      const heapMB = mem?.usedJSHeapSize ? (mem.usedJSHeapSize / (1024 * 1024)).toFixed(0) : '--';
      const gpu = viewer.getGPUInfo();
      const analysis = viewer.getGPUAnalysis();
      // Compose a single-line label per row. Vendor + device is what
      // engineers expect to see; architecture appears only when WebGPU
      // hands it to us.
      const gpuActive = gpu
        ? `${gpu.active.vendor} ${gpu.active.renderer}`.trim()
        : '--';
      const gpuHighPerf = gpu?.highPerf
        ? `${gpu.highPerf.vendor} ${gpu.highPerf.device}`.trim()
        : undefined;
      const gpuLowPower = gpu?.lowPower
        ? `${gpu.lowPower.vendor} ${gpu.lowPower.device}`.trim()
        : undefined;
      const pick = viewer.getPickMetrics();
      const metaStats = viewer.getMetadataLoadStats();
      // Read off the load result directly — alias registration has no dedicated
      // accessor and does not need one; the getter already exposes the record.
      const aliasStats = viewer.lastLoadResult?.aliasStats ?? null;
      // Pre-format ms to 0.01 precision — the formatted strings feed both the
      // change-hash (bounded churn) and the rendered rows.
      const pickFmt = {
        raycast: pick.raycastMs.toFixed(2),
        raycastLast: pick.lastRaycastMs.toFixed(2),
        static: pick.raycastStaticMs.toFixed(2),
        kinematic: pick.raycastKinematicMs.toFixed(2),
        other: pick.raycastOtherMs.toFixed(2),
        resolve: pick.resolveMs.toFixed(2),
        highlight: pick.highlightMs.toFixed(2),
        highlightLast: pick.lastHighlightMs.toFixed(2),
      };
      const hash = `${viewer.currentFps}|${info.triangles}|${info.drawCalls}|${info.programs}|${info.materialsUnique}|${heapMB}|${viewer.drives.length}|${gpuActive}|${gpuHighPerf ?? ''}|${gpuLowPower ?? ''}|${analysis?.severity ?? ''}|${analysis?.tier ?? ''}`
        + `|${pickFmt.raycast}|${pickFmt.raycastLast}|${pickFmt.highlight}|${pickFmt.highlightLast}|${pickFmt.resolve}|${pick.strategy}|${pick.raycastCount}|${pick.bvhPending}|${pick.overlayObjects}`
        // Alias stats change only on a model load, but they must be IN the hash:
        // without them a load whose other counters happen to match would leave
        // the previous model's alias numbers on screen.
        + `|${aliasStats?.nodeAliases ?? -1}|${aliasStats?.signalAliases ?? -1}|${aliasStats?.droppedAliases ?? -1}`;
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
        gpuActive,
        gpuArchitecture: gpu?.active.architecture,
        gpuHighPerf,
        gpuLowPower,
        gpuTier: analysis?.tier ?? 'unknown',
        gpuSeverity: analysis?.severity ?? 'ok',
        gpuMessage: analysis?.message,
        gpuAction: analysis?.action,
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
        texBatchIn: info.texMergeOriginal,
        texBatchOut: info.texMergeCreated,
        batchUniqueGeometries: info.batchUniqueGeometries,
        batchArenaVertices: info.batchArenaVertices,
        kinMergeGroups: info.kinGroupsMerged,
        kinMergeIn: info.kinSourceMeshes,
        kinMergeOut: info.kinChunksCreated,
        pickRaycastMs: pickFmt.raycast,
        pickRaycastLast: pickFmt.raycastLast,
        pickStaticMs: pickFmt.static,
        pickKinematicMs: pickFmt.kinematic,
        pickOtherMs: pickFmt.other,
        pickResolveMs: pickFmt.resolve,
        pickHighlightMs: pickFmt.highlight,
        pickHighlightLast: pickFmt.highlightLast,
        pickStrategy: PICK_STRATEGY_LABEL[pick.strategy] ?? pick.strategy,
        pickCount: pick.raycastCount,
        pickHits: pick.hitCount,
        pickBvhPending: pick.bvhPending,
        pickOverlayObjects: pick.overlayObjects,
        metadataNodes: metaStats?.metadataNodes ?? 0,
        metadataAabbCount: metaStats?.aabbCount ?? 0,
        metadataAabbMs: metaStats ? metaStats.aabbBuildMs.toFixed(1) : '--',
        hoverableRanges: metaStats?.hoverableFaceRanges ?? 0,
        aliasNodes: aliasStats?.nodeAliases ?? 0,
        aliasSignals: aliasStats?.signalAliases ?? 0,
        aliasDropped: aliasStats?.droppedAliases ?? 0,
        aliasLargestBucket: aliasStats && aliasStats.largestSuffixBucket.count > 0
          ? `${aliasStats.largestSuffixBucket.suffix} ×${aliasStats.largestSuffixBucket.count.toLocaleString()}`
          : '--',
        aliasMs: aliasStats ? aliasStats.ms.toFixed(1) : '--',
      });
    }, 200);
    return () => clearInterval(interval);
  }, [viewer]);

  const s = stats;
  const heapNum = s ? parseFloat(s.heapMB) || 0 : 0;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>

      {/* 3D render backend (plan-256) — internal/experimental only */}
      {__RV_INTERNAL__ && <RenderBackendSection />}

      {/* Profiler toggles */}
      <SettingsSection id="devtools-profiler" title="Profiler">
        <FieldRow label="FPS / GPU Overlay">
          <Switch size="small" checked={showStats} onChange={(_, v) => { viewer.showStats = v; setShowStats(v); }} />
        </FieldRow>
        <FieldRow label="Console Perf Log">
          <Switch size="small" checked={infoLogging} onChange={(_, v) => { viewer.setDebugLogging(v); setInfoLogging(v); }} />
        </FieldRow>
        {/* Perf-diagnosis kill-switch: load as if the GLB carried no
            Runtime* interaction components at all (rv-dev-load-flags.ts). */}
        <FieldRow label="Metadata Components" hint="Off = strip RuntimeMetadata / Interactable / UI-Window extras at load — no hover, no select, no tooltips (perf test). Reloads the viewer.">
          <Switch
            size="small"
            checked={isMetadataLoadingEnabled()}
            onChange={(_, v) => { localStorage.setItem(DISABLE_METADATA_LS_KEY, v ? '0' : '1'); window.location.reload(); }}
          />
        </FieldRow>
      </SettingsSection>

      {/* Scene (from GLB) */}
      <SettingsSection id="devtools-scene" title="Scene (from GLB)">
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <StatRow label="Triangles" value={s ? s.triangles.toLocaleString() : '--'} />
          <StatRow label="Meshes" value={s ? s.meshesInGlb.toLocaleString() : '--'} />
          <StatRow label="Drives" value={s ? String(s.drives) : '--'} />
          <StatRow label="GLB Size" value={s?.glbSize ?? '--'} />
          <StatRow label="Load Time" value={s?.loadTime ?? '--'} />
          <StatRow label="Metadata Nodes" value={s ? s.metadataNodes.toLocaleString() : '--'} />
          <StatRow label="AABB Build" value={s ? `${s.metadataAabbCount.toLocaleString()} in ${s.metadataAabbMs} ms` : '--'} />
          <StatRow label="Hoverable Ranges" value={s ? s.hoverableRanges.toLocaleString() : '--'} />
          <StatRow
            label="Path Aliases"
            value={s ? `${s.aliasNodes.toLocaleString()} node / ${s.aliasSignals.toLocaleString()} signal in ${s.aliasMs} ms` : '--'}
          />
          <StatRow
            label="Aliases Dropped"
            value={s ? s.aliasDropped.toLocaleString() : '--'}
          />
          <StatRow label="Largest Alias Bucket" value={s?.aliasLargestBucket ?? '--'} />
        </Box>
      </SettingsSection>

      {/* Optimization */}
      <SettingsSection id="devtools-optimization" title="Optimization">
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
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
            label="Static Batch"
            before={s ? s.staticMergeIn.toLocaleString() : '--'}
            after={s ? `${s.staticMergeOut} batch` : '--'}
          />
          <PipelineRow
            label="Textured Batch"
            before={s ? s.texBatchIn.toLocaleString() : '--'}
            after={s ? `${s.texBatchOut} batches` : '--'}
          />
          <StatRow
            label="Arena"
            value={s ? `${s.batchUniqueGeometries.toLocaleString()} geoms / ${s.batchArenaVertices.toLocaleString()} verts` : '--'}
          />
          <PipelineRow
            label="Kinematic Batch"
            before={s ? `${s.kinMergeIn.toLocaleString()} (${s.kinMergeGroups} drives)` : '--'}
            after={s ? `${s.kinMergeOut} batches` : '--'}
          />
        </Box>
      </SettingsSection>

      {/* Rendering */}
      <SettingsSection id="devtools-rendering" title="Rendering">
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <StatRow label="FPS" value={s ? String(s.fps) : '--'} />
          <StatRow label="Frame" value={s ? `${s.frameTime} ms` : '--'} />
          <StatRow label="Draw Calls" value={s ? String(s.drawCalls) : '--'} />
          <StatRow label="Geometries" value={s ? String(s.geometries) : '--'} />
          <StatRow label="Textures" value={s ? String(s.textures) : '--'} />
          <StatRow label="Programs" value={s ? String(s.programs) : '--'} />
          <StatRow label="JS Heap" value={s ? `${s.heapMB} MB` : '--'} />
          <StatRow label="Renderer" value={s?.renderer ?? '--'} />
        </Box>
      </SettingsSection>

      {/* Picking & Highlight — pick-path timings (EMA over ~10 picks, "last" = raw sample) */}
      <SettingsSection id="devtools-picking" title="Picking & Highlight">
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <StatRow label="Raycast" value={s ? `${s.pickRaycastMs} ms (last ${s.pickRaycastLast})` : '--'} />
          <StatRow label="· Static BVH" value={s ? `${s.pickStaticMs} ms` : '--'} />
          <StatRow label="· Drive BVHs" value={s ? `${s.pickKinematicMs} ms` : '--'} />
          <StatRow label="· MU / Aux" value={s ? `${s.pickOtherMs} ms` : '--'} />
          <StatRow label="Resolve" value={s ? `${s.pickResolveMs} ms` : '--'} />
          <StatRow label="Highlight Apply" value={s ? `${s.pickHighlightMs} ms (last ${s.pickHighlightLast})` : '--'} />
          <StatRow label="Strategy" value={s?.pickStrategy ?? '--'} />
          <StatRow
            label="BVH"
            value={s ? (s.pickBvhPending > 0 ? `${s.pickBvhPending} pending (native fallback)` : 'ready') : '--'}
            color={s ? (s.pickBvhPending > 0 ? '#ffa726' : '#66bb6a') : undefined}
          />
          <StatRow label="Picks / Hits" value={s ? `${s.pickCount.toLocaleString()} / ${s.pickHits.toLocaleString()}` : '--'} />
          <StatRow label="Overlay Objects" value={s ? String(s.pickOverlayObjects) : '--'} />
        </Box>
      </SettingsSection>

      {/* GPU */}
      <SettingsSection id="devtools-gpu" title="GPU">
        <Box sx={{ display: 'flex' }}>
          {s && <GPUTierBadge tier={s.gpuTier} severity={s.gpuSeverity} />}
        </Box>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <StatRow label="Backend" value={s?.renderer ?? '--'} />
          <StatRow label="Active" value={s?.gpuActive ?? '--'} />
          {s?.gpuArchitecture && <StatRow label="Architecture" value={s.gpuArchitecture} />}
          {s?.gpuHighPerf && <StatRow label="High-perf" value={s.gpuHighPerf} />}
          {s?.gpuLowPower && <StatRow label="Low-power" value={s.gpuLowPower} />}
        </Box>
        {s?.gpuMessage && (
          <GPUDiagnosisCallout severity={s.gpuSeverity} message={s.gpuMessage} action={s.gpuAction} />
        )}
      </SettingsSection>

      {/* Performance Budget */}
      <SettingsSection id="devtools-performance-budget" title="Performance Budget">
        <Box sx={{ fontSize: 12, color: 'text.secondary' }}>
          {s && <>
            <BudgetRow label="Triangles" {...budgetPct(s.triangles, PERF_BUDGETS.triangles)} />
            <BudgetRow label="Draw Calls" {...budgetPct(s.drawCalls, PERF_BUDGETS.drawCalls)} />
            <BudgetRow label="Frame Time" {...budgetPct(s.frameTime, PERF_BUDGETS.frameTime)} />
            <BudgetRow label="Textures" {...budgetPct(s.textures, PERF_BUDGETS.textures)} />
            <BudgetRow label="Geometries" {...budgetPct(s.geometries, PERF_BUDGETS.geometries)} />
            <BudgetRow label="JS Heap" {...budgetPct(heapNum, PERF_BUDGETS.heapMB)} />
          </>}
        </Box>
      </SettingsSection>

      {/* GPU Benchmark */}
      <SettingsSection id="devtools-gpu-benchmark" title="GPU Benchmark">
        <Box>
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
      </SettingsSection>

      {/* Library Cache */}
      <SettingsSection id="devtools-library-cache" title="Library Cache">
        <Box>
          <Button
            variant="outlined"
            size="small"
            onClick={clearLibraryCache}
            disabled={clearingCache}
            startIcon={clearingCache ? <CircularProgress size={12} /> : <CleaningServices sx={{ fontSize: 14 }} />}
            sx={{ fontSize: 11, textTransform: 'none', borderColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)' }}
          >
            {clearingCache ? 'Clearing...' : 'Clear Library Cache'}
          </Button>
          <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', mt: 0.75 }}>
            Wipes the cached library GLB bytes and snap index, then reloads. Use after swapping
            library .glb files on disk (same filename) so the new assets are re-fetched.
          </Typography>
        </Box>
      </SettingsSection>

    </Box>
  );
}
