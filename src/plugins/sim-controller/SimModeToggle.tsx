// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SimModeToggle — Sim mode-toggle UI for the unified SimulationKernel
 * (Plan 194 §4.1 / F15, P6).
 *
 * Renders a segmented `[ Realtime | DES ]` toggle in the TopBar's leading
 * slot (right after the SimController Play/Pause/Reset). When DES is active a
 * SECOND row exposes the sub-modes: Animated 1× · Hybrid [N×▾] · FastForward ·
 * Step. FastForward shows a progress bar + cancel when the kernel exposes
 * progress.
 *
 * Repo boundary (Plan 194 V7): this component imports ONLY the PUBLIC kernel
 * facade (`SimulationKernel` types + `viewer.simulationKernel`). It NEVER
 * imports `DESRunner` or anything private — it drives the DES sub-mode/KPI
 * surface through the STRUCTURAL `SimDesControl` interface the kernel returns
 * from `desControl()`. The `tests/sim-mode-toggle.node.test.ts` import-boundary
 * test asserts this.
 *
 * Availability:
 *   - `viewer.simulationKernel === null` (flag OFF / no model) → renders nothing.
 *   - `kernel.hasDesRunner() === false` (public build, no DES) → the DES segment
 *     is DISABLED (the toggle still shows so the mode is discoverable).
 */

import { useSyncExternalStore, useMemo, useCallback, useState } from 'react';
import {
  ToggleButton, ToggleButtonGroup, Box, Tooltip, Menu, MenuItem,
  IconButton, LinearProgress, Divider,
} from '@mui/material';
import {
  PlayArrow, FastForward, SkipNext, Speed, Close, ArrowDropDown,
} from '@mui/icons-material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import type {
  SimulationMode, SimSubMode, SimDesControl,
} from '../../core/material-flow/simulation-kernel';

import { runLeaseBlocker, subscribeRunLease } from '../../core/hmi/rv-run-lease';
import { parseBatchProgress } from '../../core/material-flow/rv-batch-progress';

/** Hybrid multiplier presets offered in the dropdown (Plan 194 §4.1). */
const HYBRID_MULTIPLIERS = [1, 5, 10, 50] as const;

/**
 * Snapshot of the kernel state the toggle renders. Compared by `version` so
 * `useSyncExternalStore` re-renders only when something actually changes.
 */
interface KernelSnapshot {
  /** Null when the unified kernel is not active (flag OFF / no model). */
  readonly available: boolean;
  readonly mode: SimulationMode;
  readonly hasDes: boolean;
  readonly switching: boolean;
  readonly experimentRunning: boolean;
  readonly subMode: SimSubMode | null;
  readonly multiplier: number;
  readonly ffProgress: number | null;
  readonly version: number;
}

export function SimModeToggle({ viewer }: UISlotProps) {
  const { subscribe, getSnapshot } = useMemo(() => makeStore(viewer), [viewer]);
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const [hybridAnchor, setHybridAnchor] = useState<HTMLElement | null>(null);

  // Resolve the live DES control surface on demand (structural — public-only).
  const desControl = useCallback(
    (): SimDesControl | null => viewer.simulationKernel?.desControl() ?? null,
    [viewer],
  );

  const handleModeChange = useCallback(
    (_: unknown, next: SimulationMode | null) => {
      if (!next) return; // ignore deselect (exclusive group keeps a value)
      viewer.simulationKernel?.setMode(next);
    },
    [viewer],
  );

  const handleSubMode = useCallback(
    (m: SimSubMode) => { if (!getSnapshot().experimentRunning) desControl()?.setSubMode(m); },
    [desControl, getSnapshot],
  );

  const handleHybridPick = useCallback(
    (n: number) => {
      if (getSnapshot().experimentRunning) return;
      const ctl = desControl();
      ctl?.setMultiplier(n);
      ctl?.setSubMode('hybrid');
      setHybridAnchor(null);
    },
    [desControl, getSnapshot],
  );

  const handleStep = useCallback(() => {
    if (getSnapshot().experimentRunning) return;
    const ctl = desControl();
    ctl?.setSubMode('step');
    ctl?.step();
  }, [desControl, getSnapshot]);

  const handleCancelFf = useCallback(() => {
    desControl()?.cancelFastForward?.();
  }, [desControl]);

  // Not available → the unified kernel path is off (default build) → render
  // nothing so the legacy toolbar is unchanged.
  if (!snap.available) return null;

  const desActive = snap.mode === 'des';

  return (
    <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
      {/* ── Realtime | DES segmented toggle ── */}
      <ToggleButtonGroup
        size="small"
        exclusive
        value={snap.mode}
        onChange={handleModeChange}
        aria-label="simulation mode"
        data-testid="sim-mode-toggle"
        sx={{
          height: 26,
          '& .MuiToggleButton-root': {
            fontSize: 11, px: 1, py: 0, textTransform: 'none', lineHeight: 1.2,
            color: 'text.secondary',
            '&.Mui-selected': { color: 'primary.main', bgcolor: 'rgba(79,195,247,0.12)' },
          },
        }}
      >
        <ToggleButton value="continuous" data-testid="sim-mode-realtime">Realtime</ToggleButton>
        <Tooltip
          title={snap.hasDes ? 'Discrete-event simulation' : 'DES not available in this build'}
          placement="bottom"
        >
          {/* span wrapper so the Tooltip works on a disabled button */}
          <span>
            <ToggleButton
              value="des"
              disabled={!snap.hasDes || snap.switching}
              data-testid="sim-mode-des"
            >
              DES
            </ToggleButton>
          </span>
        </Tooltip>
      </ToggleButtonGroup>

      {/* ── Sub-mode row (DES only) ── */}
      {desActive && (
        <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.25 }} data-testid="sim-submode-row">
          <Tooltip title={snap.experimentRunning ? 'An experiment is running' : 'Animated (1\u00d7)'} placement="bottom">
            <span><IconButton
              size="small"
              onClick={() => handleSubMode('animated')}
              color={snap.subMode === 'animated' ? 'primary' : 'inherit'}
              sx={{ p: 0.5 }}
              disabled={snap.experimentRunning}
              data-testid="sim-submode-animated"
            >
              <PlayArrow fontSize="small" />
            </IconButton></span>
          </Tooltip>

          <Tooltip title={snap.experimentRunning ? 'An experiment is running' : `Hybrid (${snap.multiplier}× time-lapse)`} placement="bottom">
            <Box sx={{ display: 'inline-flex', alignItems: 'center' }}>
              <IconButton
                size="small"
                onClick={() => handleSubMode('hybrid')}
                color={snap.subMode === 'hybrid' ? 'primary' : 'inherit'}
                sx={{ p: 0.5 }}
                disabled={snap.experimentRunning}
                data-testid="sim-submode-hybrid"
              >
                <Speed fontSize="small" />
              </IconButton>
              <IconButton
                size="small"
                onClick={(e) => setHybridAnchor(e.currentTarget)}
                sx={{ p: 0.25 }}
                disabled={snap.experimentRunning}
                data-testid="sim-submode-hybrid-multiplier"
              >
                <ArrowDropDown fontSize="small" />
              </IconButton>
            </Box>
          </Tooltip>

          <Tooltip title={snap.experimentRunning ? 'An experiment is running' : "Fast Forward (analysis)"} placement="bottom">
            <span><IconButton
              size="small"
              onClick={() => handleSubMode('fastforward')}
              color={snap.subMode === 'fastforward' ? 'primary' : 'inherit'}
              sx={{ p: 0.5 }}
              disabled={snap.experimentRunning}
              data-testid="sim-submode-fastforward"
            >
              <FastForward fontSize="small" />
            </IconButton></span>
          </Tooltip>

          <Tooltip title={snap.experimentRunning ? 'An experiment is running' : "Step (one event)"} placement="bottom">
            <span><IconButton
              size="small"
              onClick={handleStep}
              color={snap.subMode === 'step' ? 'primary' : 'inherit'}
              sx={{ p: 0.5 }}
              disabled={snap.experimentRunning}
              data-testid="sim-submode-step"
            >
              <SkipNext fontSize="small" />
            </IconButton></span>
          </Tooltip>

          {/* Hybrid multiplier dropdown */}
          <Menu
            anchorEl={hybridAnchor}
            open={hybridAnchor !== null}
            onClose={() => setHybridAnchor(null)}
          >
            {HYBRID_MULTIPLIERS.map((n) => (
              <MenuItem
                key={n}
                disabled={snap.experimentRunning}
                selected={snap.multiplier === n}
                onClick={() => handleHybridPick(n)}
                sx={{ fontSize: 12 }}
              >
                {n}×
              </MenuItem>
            ))}
          </Menu>

          {/* FastForward progress + cancel (only while a FF run is in flight) */}
          {snap.ffProgress !== null && (
            <Box sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, ml: 0.5, minWidth: 80 }} data-testid="sim-ff-progress">
              <LinearProgress
                variant="determinate"
                value={Math.round(snap.ffProgress * 100)}
                sx={{ flex: 1, height: 4, borderRadius: 2, minWidth: 48 }}
              />
              <Tooltip title="Cancel Fast Forward" placement="bottom">
                <IconButton size="small" onClick={handleCancelFf} sx={{ p: 0.25 }} data-testid="sim-ff-cancel">
                  <Close fontSize="small" />
                </IconButton>
              </Tooltip>
            </Box>
          )}
        </Box>
      )}

      {/* Vertical divider groups the mode-toggle and separates it from the
          next leading-slot toolbar widget. */}
      <Divider
        orientation="vertical"
        flexItem
        sx={{ mx: 0.5, my: 0.5, borderColor: 'divider' }}
      />
    </Box>
  );
}

// ── Per-viewer kernel-state store ──────────────────────────────────────────
//
// A single subscribe/getSnapshot pair per viewer. Re-renders on
// 'simulation-mode-changed' (mode/sub-mode switch) and on a low-rate poll that
// tracks the FastForward progress (which has no event of its own).

interface KernelStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => KernelSnapshot;
}

const _storeCache = new WeakMap<object, KernelStore>();

/** Poll interval for FastForward progress (no dedicated event). */
const POLL_MS = 200;

function makeStore(viewer: UISlotProps['viewer']): KernelStore {
  const cached = _storeCache.get(viewer);
  if (cached) return cached;

  let version = 0;
  let snapshot = readSnapshot(viewer, version);
  const listeners = new Set<() => void>();
  let pollId: ReturnType<typeof setInterval> | null = null;

  const refresh = (): void => {
    const next = readSnapshot(viewer, version + 1);
    // Only bump + notify when something the UI cares about actually changed.
    if (!sameSnapshot(snapshot, next)) {
      version++;
      snapshot = next;
      for (const l of listeners) l();
    }
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    const offLease = subscribeRunLease(refresh);
    const off = viewer.on('simulation-mode-changed', refresh as (data: unknown) => void);
    if (pollId === null) pollId = setInterval(refresh, POLL_MS);
    return () => {
      listeners.delete(listener);
      off();
      offLease();
      if (listeners.size === 0 && pollId !== null) {
        clearInterval(pollId);
        pollId = null;
      }
    };
  };

  const getSnapshot = (): KernelSnapshot => snapshot;

  const store: KernelStore = { subscribe, getSnapshot };
  _storeCache.set(viewer, store);
  return store;
}

function readSnapshot(viewer: UISlotProps['viewer'], version: number): KernelSnapshot {
  const kernel = viewer.simulationKernel;
  if (!kernel) {
    return {
      available: false, mode: 'continuous', hasDes: false, switching: false,
      subMode: null, multiplier: 1, ffProgress: null, experimentRunning: !!runLeaseBlocker(), version,
    };
  }
  const ctl = kernel.desControl();
  const ff = ctl?.ffProgress;
  return {
    available: true,
    experimentRunning: !!runLeaseBlocker() || parseBatchProgress(ctl?.batchProgressJson?.())?.phase === 'running',
    mode: kernel.mode,
    hasDes: kernel.hasDesRunner(),
    switching: kernel.isSwitching,
    subMode: ctl?.subMode ?? null,
    multiplier: ctl?.multiplier ?? 1,
    ffProgress: typeof ff === 'number' ? ff : null,
    version,
  };
}

function sameSnapshot(a: KernelSnapshot, b: KernelSnapshot): boolean {
  return a.available === b.available
    && a.experimentRunning === b.experimentRunning
    && a.mode === b.mode
    && a.hasDes === b.hasDes
    && a.switching === b.switching
    && a.subMode === b.subMode
    && a.multiplier === b.multiplier
    && a.ffProgress === b.ffProgress;
}
