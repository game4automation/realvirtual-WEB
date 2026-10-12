// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { Typography, Box, Button, CircularProgress, Switch, TextField } from '@mui/material';
import { PlayArrow, CleaningServices } from '@mui/icons-material';
import { useViewer } from '../../../hooks/use-viewer';
import { StatRow, BudgetRow, budgetPct, SettingsSection, FieldRow } from './settings-helpers';
import { isMetadataLoadingEnabled, DISABLE_METADATA_LS_KEY } from '../../engine/rv-dev-load-flags';
import type { RenderBackendId, RenderBackendStatus } from '../../render-backend/rv-render-backend';
import { ModelCache } from '../../engine/rv-model-cache';
import {
  CACHE_OUTCOMES,
  cacheOutcomeVersion,
  clearCacheOutcomes,
  getCacheOutcomes,
  getCacheStorageEstimate,
  type CacheOutcome,
} from '../../engine/rv-asset-cache-outcomes';
import { clearCache as clearLibrarySnapCache } from '../../../plugins/snap-point/library-snap-index';

interface DevStats {
  // Rendering — `drawCalls` / `renderTriangles` are the SCENE pass of the
  // last rendered frame; `frameBreakdown` is the dimmed per-pass line.
  fps: number;
  frameTime: number;
  drawCalls: number;
  renderTriangles: number;
  /** "total N · ao N · outline N · shadow N · post N · overlay N …" (only non-zero buckets after total). */
  frameBreakdown: string;
  frameTotalTriangles: number;
  geometries: number;
  textures: number;
  renderTargets: number;
  programs: number;
  heapMB: string;
  /** `performance.memory.jsHeapSizeLimit` in MB, or 0 when the browser hides it. */
  heapLimitMB: number;
  renderer: string;
  // Bake (plan-753 Phase 3: planner placements = BakeRegistry instances)
  bakeAssets: number;
  bakeChunks: number;
  /** From the planner's ModelCache — -1 when no planner is loaded. */
  bakeVertices: number;
  bakeTriangles: number;
  bakeInstances: number;
  /** Deferred placements of the open layout still materializing (0 = scene complete). */
  placementsPending: number;
  placementsTotal: number;
  /** `cacheOutcomeVersion()` — changes whenever the asset-cache ring does (plan-508). */
  cacheVersion: number;
  bakeChunkMeshes: number;
  bakeKeepMeshes: number;
  bakeDrawCalls: number;
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
  // Scene (from GLB) — load-time counts, independent of what the frame drew
  triangles: number;
  meshesInGlb: number;
  materialsOriginal: number;
  materialsDeduped: number;
  drives: number;
  glbSize: string;
  loadTime: string;
  // Optimization pipeline (loader bake of the loaded model, plan-753)
  uberBakedMeshCount: number;
  uberSharedGeometryReuses: number;
  uberClonedGeometryCount: number;
  uberDisposedSourceGeometries: number;
  loaderBakeChunks: number;
  loaderBakeKeep: number;
  loaderBakeSources: number;
  loaderBakeTriangles: number;
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
  /** plan-756 gate: p95 ms per ray, '--' until the ring has a sample. */
  pickP95Ms: string;
  /** plan-756 gate: pick structures + CSR node table of the live assets (main
   *  model + planner placements, deduped per asset), in MB. */
  pickStructureMB: string;
  /** plan-756 gate: the same sum as a percentage of chunk-geometry bytes (5 % budget). */
  pickStructurePercent: string;
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
  'chunk-overlay': 'Chunk overlay',
  'overlay': 'Overlay pairs',
  'bbox': 'BBox fallback',
  'mu-overlay': 'MU overlay',
  'none': '—',
};

const PERF_BUDGETS = {
  triangles: 2_000_000, // scene pass of one frame
  drawCalls: 500,       // scene pass of one frame
  frameTime: 33.33, // 30fps floor — 60fps (16.7ms) shows ~50% green
  textures: 200,    // incl. render-target textures
  geometries: 500,  // GPU-resident BufferGeometry objects
  heapMB: 512,      // fallback when the browser hides jsHeapSizeLimit
};

/** Format the per-pass draw-call split as one dimmed line; zero buckets
 *  after `total` are omitted so an outline-free frame reads "total 12". */
function formatFrameBreakdown(frame: {
  total: { calls: number }; ao: { calls: number }; outline: { calls: number }; shadow: { calls: number };
  reflection: { calls: number };
  post: { calls: number }; overlay: { calls: number }; plugins: { calls: number }; other: { calls: number };
}): string {
  const parts = [`total ${frame.total.calls}`];
  const push = (label: string, n: number) => { if (n > 0) parts.push(`${label} ${n}`); };
  push('ao', frame.ao.calls);
  push('outline', frame.outline.calls);
  push('shadow', frame.shadow.calls);
  push('reflection', frame.reflection.calls);
  push('post', frame.post.calls);
  push('overlay', frame.overlay.calls);
  push('plugins', frame.plugins.calls);
  push('other', frame.other.calls);
  return parts.join(' · ');
}

/** A dimmed, right-aligned secondary line under a StatRow. */
/** Row colour per asset-cache outcome: green = served from cache, blue = network, red = trouble. */
const CACHE_OUTCOME_COLOR: Record<CacheOutcome, string> = {
  'hit': '#66bb6a',
  'offline-hit': '#ffa726',
  'revalidated': '#66bb6a',
  'replaced': '#4fc3f7',
  'miss': '#4fc3f7',
  'evicted': '#ffa726',
  'rejected': '#ef5350',
  'hash-mismatch': '#ef5350',
};

function formatMB(bytes: number): string {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${Math.max(0, Math.round(bytes / 1024))} KB`;
}

/**
 * DevTools › Render › Asset cache (plan-508 F7): what the asset blob cache did
 * — the newest outcomes, counters, storage usage/quota and the persist verdict.
 * Re-reads the ring only when `version` (polled in the tab's interval) changes.
 */
function AssetCacheSection({ version, onClearPersistent, clearing }: {
  version: number;
  onClearPersistent: () => void;
  clearing: boolean;
}) {
  const snapshot = useMemo(() => getCacheOutcomes({ last: 12 }), [version]);
  const [storage, setStorage] = useState<{ usage: number; quota: number } | null>(null);
  useEffect(() => {
    let alive = true;
    void getCacheStorageEstimate().then((e) => { if (alive) setStorage(e); });
    return () => { alive = false; };
  }, [version]);
  const counts = CACHE_OUTCOMES
    .filter((o) => snapshot.counts[o] > 0)
    .map((o) => `${o} ${snapshot.counts[o]}`)
    .join(' · ') || 'no requests yet';
  const persisted = snapshot.persisted === null ? 'not asked' : snapshot.persisted ? 'granted' : 'denied';
  const buttonSx = { fontSize: 11, textTransform: 'none', borderColor: 'rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)' } as const;
  return (
    <SettingsSection id="devtools-asset-cache" title="Asset cache">
      <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
        <SubRow text={counts} />
        <StatRow
          label="Storage"
          value={storage ? `${formatMB(storage.usage)} / ${formatMB(storage.quota)}` : 'n/a'}
        />
        <StatRow label="Persisted" value={persisted} />
        {snapshot.outcomes.slice().reverse().map((r, i) => (
          <Box key={`${r.at}-${i}`} sx={{ display: 'flex', gap: 1, fontFamily: 'monospace', fontSize: 10, alignItems: 'baseline' }} title={`${r.url}${r.detail ? `\n${r.detail}` : ''}`}>
            <span style={{ color: 'rgba(255,255,255,0.35)' }}>{new Date(r.at).toLocaleTimeString()}</span>
            <span style={{ color: CACHE_OUTCOME_COLOR[r.outcome], minWidth: 88 }}>{r.outcome}</span>
            <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: 'rgba(255,255,255,0.7)' }}>
              {r.url.split('/').pop()}
            </span>
            <span style={{ color: 'rgba(255,255,255,0.45)' }}>{r.bytes !== undefined ? formatMB(r.bytes) : ''}</span>
            <span style={{ color: 'rgba(255,255,255,0.35)', minWidth: 44, textAlign: 'right' }}>{r.ms !== undefined ? `${Math.round(r.ms)}ms` : ''}</span>
          </Box>
        ))}
        <Box sx={{ display: 'flex', gap: 1, mt: 0.5 }}>
          <Button variant="outlined" size="small" onClick={() => clearCacheOutcomes()} sx={buttonSx}>
            Clear outcomes
          </Button>
          <Button
            variant="outlined"
            size="small"
            onClick={onClearPersistent}
            disabled={clearing}
            startIcon={clearing ? <CircularProgress size={12} /> : <CleaningServices sx={{ fontSize: 14 }} />}
            sx={buttonSx}
          >
            Clear persistent cache
          </Button>
        </Box>
      </Box>
    </SettingsSection>
  );
}

function SubRow({ text }: { text: string }) {
  return (
    <Typography variant="caption" sx={{ display: 'block', textAlign: 'right', fontFamily: 'monospace', fontSize: 10, color: 'rgba(255,255,255,0.35)', mt: -0.5 }}>
      {text}
    </Typography>
  );
}

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

  // Wipe the persistent GLB byte cache (Cache API bucket `rv-assets-glb-v2`,
  // plus the legacy `rv-planner-glbs`) and the per-GLB snap-index localStorage,
  // then reload. Since plan-508 a catalog with `sha256` keys the bytes by hash,
  // so a changed library file is picked up on its own; this stays the manual
  // reset for catalogs without hashes. The reload is required because the
  // in-memory decoded ModelCache still holds the old Three.js Groups.
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
      const mem = (performance as unknown as { memory?: { usedJSHeapSize?: number; jsHeapSizeLimit?: number } }).memory;
      const heapMB = mem?.usedJSHeapSize ? (mem.usedJSHeapSize / (1024 * 1024)).toFixed(0) : '--';
      const heapLimitMB = mem?.jsHeapSizeLimit ? Math.round(mem.jsHeapSizeLimit / (1024 * 1024)) : 0;
      const frameBreakdown = formatFrameBreakdown(info.frame);
      // Bake stats: the planner's ModelCache knows vertices/triangles of the
      // baked assets; without a planner the viewer's BakeRegistry still
      // reports instances / shared chunks / per-instance meshes.
      const planner = viewer.getPlugin<{ id: string; getBakeStats?: () => { assets: number; chunks: number; vertices: number; triangles: number } }>('layout-planner');
      const plannerBake = planner?.getBakeStats?.() ?? null;
      const bake = info.bake;
      const placementsProgress = viewer.placements.progress;
      const sceneTriangles = viewer.lastLoadResult?.triangleCount ?? 0;
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
        p95: pick.raycastP95Samples > 0 ? pick.raycastP95Ms.toFixed(3) : '--',
      };
      // plan-756 memory gate: pick structures + CSR node table, summed per
      // DISTINCT baked asset over the VIEWER's registry — which is the main
      // model AND the planner placements (the planner shares this registry, so
      // adding its own stats would double-count). `pickPercent` is the same sum
      // against the chunk-geometry bytes it accelerates: the 5 % gate.
      const pickStructureMB = ((bake.pickBytes + bake.nodeTableBytes) / (1024 * 1024)).toFixed(2);
      const pickStructurePercent = bake.geometryBytes > 0 ? bake.pickPercent.toFixed(2) : '--';
      const hash = `${viewer.currentFps}|${info.triangles}|${info.drawCalls}|${frameBreakdown}|${info.geometries}|${info.textures}|${info.renderTargets}|${info.programs}|${info.materialsUnique}|${heapMB}|${viewer.drives.length}|${gpuActive}|${gpuHighPerf ?? ''}|${gpuLowPower ?? ''}|${analysis?.severity ?? ''}|${analysis?.tier ?? ''}`
        + `|${placementsProgress.pending}|${placementsProgress.total}`
        + `|${bake.instances}|${bake.chunkMeshes}|${bake.keepMeshes}|${plannerBake?.assets ?? -1}|${plannerBake?.triangles ?? -1}|${sceneTriangles}|${info.meshCount}`
        + `|${pickFmt.raycast}|${pickFmt.raycastLast}|${pickFmt.highlight}|${pickFmt.highlightLast}|${pickFmt.resolve}|${pick.strategy}|${pick.raycastCount}|${pick.bvhPending}|${pick.overlayObjects}`
        + `|${pickFmt.p95}|${pickStructureMB}|${pickStructurePercent}`
        // Alias stats change only on a model load, but they must be IN the hash:
        // without them a load whose other counters happen to match would leave
        // the previous model's alias numbers on screen.
        + `|${aliasStats?.nodeAliases ?? -1}|${aliasStats?.signalAliases ?? -1}|${aliasStats?.droppedAliases ?? -1}`
        + `|${cacheOutcomeVersion()}`;
      if (hash === prevStatsHashRef.current) return;
      prevStatsHashRef.current = hash;
      setStats({
        fps: viewer.currentFps,
        frameTime: viewer.currentFrameTime,
        drawCalls: info.drawCalls,
        renderTriangles: info.triangles,
        frameBreakdown,
        frameTotalTriangles: info.frame.total.triangles,
        geometries: info.geometries,
        textures: info.textures,
        renderTargets: info.renderTargets,
        programs: info.programs,
        heapMB,
        heapLimitMB,
        renderer: viewer.isWebGPU ? 'WebGPU' : 'WebGL',
        bakeAssets: plannerBake?.assets ?? bake.assets,
        bakeChunks: plannerBake?.chunks ?? bake.chunks,
        bakeVertices: plannerBake?.vertices ?? -1,
        bakeTriangles: plannerBake?.triangles ?? -1,
        bakeInstances: bake.instances,
        placementsPending: placementsProgress.pending,
        placementsTotal: placementsProgress.total,
        cacheVersion: cacheOutcomeVersion(),
        bakeChunkMeshes: bake.chunkMeshes,
        bakeKeepMeshes: bake.keepMeshes,
        bakeDrawCalls: bake.drawCalls,
        gpuActive,
        gpuArchitecture: gpu?.active.architecture,
        gpuHighPerf,
        gpuLowPower,
        gpuTier: analysis?.tier ?? 'unknown',
        gpuSeverity: analysis?.severity ?? 'ok',
        gpuMessage: analysis?.message,
        gpuAction: analysis?.action,
        triangles: sceneTriangles,
        meshesInGlb: info.meshCount,
        materialsOriginal: info.materialsOriginal,
        materialsDeduped: info.materialsUnique,
        drives: viewer.drives.length,
        glbSize: viewer.lastLoadInfo?.glbSize ?? '--',
        loadTime: viewer.lastLoadInfo?.loadTime ?? '--',
        uberBakedMeshCount: info.uberBakedMeshCount,
        uberSharedGeometryReuses: info.uberSharedGeometryReuses,
        uberClonedGeometryCount: info.uberClonedGeometryCount,
        uberDisposedSourceGeometries: info.uberDisposedSourceGeometries,
        loaderBakeChunks: info.loaderBake.chunks,
        loaderBakeKeep: info.loaderBake.keep,
        loaderBakeSources: info.loaderBake.sources,
        loaderBakeTriangles: info.loaderBake.triangles,
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
        pickP95Ms: pickFmt.p95,
        pickStructureMB,
        pickStructurePercent,
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
  // Dev mode keeps master copies of every library asset — 512 MB is not a
  // meaningful ceiling there; measure against the browser's real heap limit
  // whenever Chrome exposes it.
  const heapBudget = s && s.heapLimitMB > 0 ? s.heapLimitMB : PERF_BUDGETS.heapMB;

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

      {/* Rendering — last rendered frame; Draw Calls / Triangles are the SCENE pass */}
      <SettingsSection id="devtools-rendering" title="Rendering">
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <StatRow label="FPS" value={s ? String(s.fps) : '--'} />
          <StatRow label="Frame" value={s ? `${s.frameTime} ms` : '--'} />
          <StatRow label="Draw Calls" value={s ? String(s.drawCalls) : '--'} />
          {s && <SubRow text={s.frameBreakdown} />}
          <StatRow label="Triangles" value={s ? s.renderTriangles.toLocaleString() : '--'} />
          {s && s.frameTotalTriangles !== s.renderTriangles && <SubRow text={`total ${s.frameTotalTriangles.toLocaleString()}`} />}
          <StatRow label="GPU Geometries" value={s ? String(s.geometries) : '--'} />
          {s && s.bakeInstances > 0 && (
            <SubRow text={`${s.bakeChunks} chunk geometries shared by ${s.bakeInstances} placements`} />
          )}
          <StatRow
            label="GPU Textures"
            value={s ? (s.renderTargets > 0 ? `${Math.max(0, s.textures - s.renderTargets)} + ${s.renderTargets} render targets` : String(s.textures)) : '--'}
          />
          <StatRow label="Programs" value={s ? String(s.programs) : '--'} />
          <StatRow label="JS Heap" value={s ? (s.heapLimitMB > 0 ? `${s.heapMB} / ${s.heapLimitMB.toLocaleString()} MB` : `${s.heapMB} MB`) : '--'} />
          <StatRow label="Renderer" value={s?.renderer ?? '--'} />
        </Box>
      </SettingsSection>

      {/* Scene (from GLB) — load-time counts */}
      <SettingsSection id="devtools-scene" title="Scene (from GLB)">
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <StatRow label="Triangles" value={s ? s.triangles.toLocaleString() : '--'} />
          <StatRow label="Meshes" value={s ? (s.bakeDrawCalls > 0 ? `${s.meshesInGlb.toLocaleString()} + ${s.bakeDrawCalls} placement` : s.meshesInGlb.toLocaleString()) : '--'} />
          <StatRow label="Drives" value={s ? String(s.drives) : '--'} />
          <StatRow label="GLB Size" value={s?.glbSize ?? '--'} />
          <StatRow label="Load Time" value={s?.loadTime ?? '--'} />
        </Box>
      </SettingsSection>

      {/* Bake — planner placements as BakeRegistry instances (plan-753 §3.1) */}
      <SettingsSection id="devtools-bake" title="Bake">
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <StatRow label="Assets" value={s ? String(s.bakeAssets) : '--'} />
          <StatRow label="Chunks" value={s ? String(s.bakeChunks) : '--'} />
          <StatRow
            label="Vertices / Tris"
            value={s ? (s.bakeVertices >= 0 ? `${s.bakeVertices.toLocaleString()} / ${s.bakeTriangles.toLocaleString()}` : 'n/a (no planner)') : '--'}
          />
          <StatRow label="Instances" value={s ? String(s.bakeInstances) : '--'} />
          {s && s.placementsPending > 0 && (
            <StatRow label="Placements" value={`${s.placementsPending} pending of ${s.placementsTotal}`} />
          )}
          <StatRow label="Chunk Meshes" value={s ? String(s.bakeChunkMeshes) : '--'} />
          <StatRow label="Keep Meshes" value={s ? String(s.bakeKeepMeshes) : '--'} />
          <StatRow label="Draw Calls" value={s ? String(s.bakeDrawCalls) : '--'} />
        </Box>
      </SettingsSection>

      {/* Asset cache — blob-cache outcomes under the bake stats (plan-508 F7) */}
      <AssetCacheSection version={s?.cacheVersion ?? 0} onClearPersistent={clearLibraryCache} clearing={clearingCache} />

      {/* Load Diagnostics — loader-internal counters, read by other plans; collapsed by default */}
      <SettingsSection id="devtools-load-diagnostics" title="Load Diagnostics" defaultExpanded={false}>
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
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

      {/* Optimization — loader pipeline of the loaded model (plan-753 Phase 4: the bake) */}
      <SettingsSection id="devtools-optimization" title="Optimization (loader pipeline)">
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <PipelineRow
            label="Materials"
            before={s ? s.materialsOriginal.toLocaleString() : '--'}
            after={s ? `${s.materialsDeduped} · ${s.uberBakedMeshCount.toLocaleString()} uber-baked` : '--'}
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
            label="Bake"
            before={s ? `${s.loaderBakeSources.toLocaleString()} source meshes · ${s.loaderBakeTriangles.toLocaleString()} tris` : '--'}
            after={s ? (s.loaderBakeChunks > 0 ? `${s.loaderBakeChunks} chunks · ${s.loaderBakeKeep} keep` : 'not baked') : '--'}
          />
        </Box>
      </SettingsSection>

      {/* Picking & Highlight — pick-path timings (EMA over ~10 picks, "last" = raw sample) */}
      <SettingsSection id="devtools-picking" title="Picking & Highlight">
        <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <StatRow label="Raycast" value={s ? `${s.pickRaycastMs} ms (last ${s.pickRaycastLast})` : '--'} />
          <StatRow label="· Instance index" value={s ? `${s.pickStaticMs} ms` : '--'} />
          <StatRow label="· Chunk pick structure" value={s ? `${s.pickKinematicMs} ms` : '--'} />
          <StatRow label="· MU / Aux" value={s ? `${s.pickOtherMs} ms` : '--'} />
          <StatRow label="Resolve" value={s ? `${s.pickResolveMs} ms` : '--'} />
          <StatRow label="Highlight Apply" value={s ? `${s.pickHighlightMs} ms (last ${s.pickHighlightLast})` : '--'} />
          <StatRow label="Strategy" value={s?.pickStrategy ?? '--'} />
          {/* plan-756 gates: p95 ≤ 1 ms per ray, structures ≤ 5 % of chunk geometry. */}
          <StatRow label="Pick p95" value={s ? `${s.pickP95Ms} ms` : '--'} />
          <StatRow label="Pick structure" value={s ? `${s.pickStructureMB} MB (${s.pickStructurePercent}% of geometry)` : '--'} />
          <StatRow
            label="Editor BVH"
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
            <BudgetRow label="Triangles" {...budgetPct(s.renderTriangles, PERF_BUDGETS.triangles)} />
            <BudgetRow label="Draw Calls" {...budgetPct(s.drawCalls, PERF_BUDGETS.drawCalls)} />
            <BudgetRow label="Frame Time" {...budgetPct(s.frameTime, PERF_BUDGETS.frameTime)} />
            <BudgetRow label="Textures" {...budgetPct(s.textures, PERF_BUDGETS.textures)} />
            <BudgetRow label="Geometries" {...budgetPct(s.geometries, PERF_BUDGETS.geometries)} />
            <BudgetRow label="JS Heap" {...budgetPct(heapNum, heapBudget)} />
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
