// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SimControllerToolbar — the Play/Pause toggle + Reset action group. Registered
 * in the `toolbar-button-leading` slot, which the HMI renders as a floating
 * action group next to the workspace mode switcher (top-left of the viewport).
 *
 * Subscribes to `'simulation-pause-changed'` via `useSyncExternalStore`, so
 * UI updates fire only on idle↔paused transitions (or pause-reason add/
 * remove), not every render frame.
 */

import { useSyncExternalStore, useCallback, useMemo, useState, useEffect, type MouseEvent } from 'react';
import { PlayArrow, Pause, Replay, Speed, Schedule } from '@mui/icons-material';
import { Menu, MenuItem, Box } from '@mui/material';
import type { UISlotProps } from '../../core/rv-ui-plugin';
import { ActionSegment, ActionDivider } from '../../core/hmi/action-group';
import { SIM_CONTROLLER_PAUSE_REASON } from './index';
import { getDriveSpeedOverride, setDriveSpeedOverride, subscribeDriveSpeedOverride } from '../../core/engine/rv-speed-override';
import { formatSimClock } from './format-sim-time';

/** Snapshot shape returned by `getPauseSnapshot`. Compared by reference so
 *  `useSyncExternalStore` re-renders only when the underlying state changes. */
interface PauseSnapshot {
  paused: boolean;
  reasons: readonly string[];
  /** Stable signature used as the version key for `getSnapshot`. */
  version: number;
}

/**
 * Play/Pause toggle segment — toggles the user pause reason and reflects the
 * ACTUAL sim state (paused by ANY reason). Exported so other toolbars (e.g. the
 * DES controller toolbar) reuse the exact same control + behaviour. Works for
 * both the continuous and the DES execution mode: pausing holds the whole fixed
 * loop, so `kernel.tick()` (continuous OR DES) is skipped uniformly.
 */
export function PlayPauseSegment({ viewer }: UISlotProps) {
  const { subscribe, getSnapshot } = useMemo(() => makeStore(viewer), [viewer]);
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const userPaused = snap.reasons.includes(SIM_CONTROLLER_PAUSE_REASON);

  const handleTogglePlayPause = useCallback(() => {
    viewer.setSimulationPaused(SIM_CONTROLLER_PAUSE_REASON, !userPaused);
  }, [viewer, userPaused]);

  // Icon reflects the ACTUAL sim state (paused by ANY reason — user, planner
  // 'layout-edit', AR, …) so the toolbar shows "paused" whenever the sim is
  // held, e.g. on entering the Layout-Planner. (Size is normalized by ActionSegment.)
  const playPauseIcon = snap.paused ? <PlayArrow /> : <Pause />;
  // Detailed tooltip surfaces *all* active pause reasons — replaces the inline
  // chip that used to render in the toolbar. Keeps the info discoverable on
  // hover without cluttering the main menu.
  const reasonsList = snap.paused && snap.reasons.length > 0
    ? ` — paused by: ${snap.reasons.join(', ')}`
    : '';
  const playPauseTitle = (snap.paused ? 'Play (Space)' : 'Pause (Space)') + reasonsList;

  // Subtle visual hint when paused by *something else* (not the user button):
  // the play/pause button picks up the warning colour so the user notices the
  // sim is being held by another plugin (Planner, AR, …) even when they did
  // not press Pause themselves.
  const pausedByOther = snap.paused && !userPaused;
  const playPauseColor = userPaused ? 'primary.main' : pausedByOther ? 'warning.main' : 'inherit';

  return (
    <ActionSegment
      title={playPauseTitle}
      onClick={handleTogglePlayPause}
      color={playPauseColor}
      icon={playPauseIcon}
      buttonProps={{ 'data-testid': 'sim-controller-playpause' }}
    />
  );
}

/**
 * Reset segment — clears MUs + LogicSteps via `resetSimulation()` (which also
 * resets the active kernel executor, so it works in DES mode too). Exported for
 * reuse by the DES controller toolbar.
 */
export function ResetSegment({ viewer }: UISlotProps) {
  const handleReset = useCallback(() => {
    viewer.resetSimulation();
  }, [viewer]);

  return (
    <ActionSegment
      title="Reset MUs and LogicSteps (Shift+R)"
      onClick={handleReset}
      icon={<Replay />}
      buttonProps={{ 'data-testid': 'sim-controller-reset' }}
    />
  );
}

/**
 * Elapsed-simulation-time display (DD:HH:MM:SS.s). Polls `viewer.simTime` (the
 * continuous fixed-step accumulator) so the planner shows the running sim clock
 * during Play — the continuous parallel to the DES toolbar clock. Holds while
 * paused, returns to 0 on Reset.
 */
function SimClockSegment({ viewer }: UISlotProps) {
  const [t, setT] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setT(viewer.simTime ?? 0), 200);
    return () => clearInterval(id);
  }, [viewer]);
  return (
    <Box
      sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, px: 0.75, height: '100%', whiteSpace: 'nowrap' }}
      data-testid="sim-clock"
      title="Elapsed simulation time"
    >
      <Schedule sx={{ fontSize: 18, color: 'text.secondary' }} />
      <Box component="span" sx={{ fontFamily: 'ui-monospace, monospace', fontSize: 11, fontWeight: 600, color: '#4fc3f7', letterSpacing: 0.3 }}>
        {formatSimClock(t)}
      </Box>
    </Box>
  );
}

export function SimControllerToolbar({ viewer }: UISlotProps) {
  // Segmented action group (shared design): full-height rectangular segments
  // split by a divider. The pill wrapper is provided by the host (TopBar).
  return (
    <>
      <PlayPauseSegment viewer={viewer} />
      <ActionDivider />
      <ResetSegment viewer={viewer} />
      <ActionDivider />
      <SpeedSelector />
      <ActionDivider />
      <SimClockSegment viewer={viewer} />
    </>
  );
}

// ── Drive-speed selector ────────────────────────────────────────────────────
// A central master speed override for continuous simulation: one factor that
// scales the effective speed of ALL drives (1 = normal). Sits next to Reset.

// Engine cap is 100× (see setDriveSpeedOverride). Above ~10–20× fast/small parts
// can tunnel past sensors in the fixed 60 Hz step — fine for large parts / big zones.
const SPEED_OPTIONS = [0.25, 0.5, 1, 2, 5, 10, 25, 50, 100];

function SpeedSelector() {
  const factor = useSyncExternalStore(subscribeDriveSpeedOverride, getDriveSpeedOverride, getDriveSpeedOverride);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  return (
    <>
      <ActionSegment
        title="Drive speed override — scales all drive speeds (1× = normal)"
        icon={<Speed />}
        label={`${factor}×`}
        buttonProps={{
          'data-testid': 'sim-speed-selector',
          onClick: (e: MouseEvent<HTMLElement>) => setAnchor(e.currentTarget),
        }}
      />
      <Menu
        anchorEl={anchor}
        open={!!anchor}
        onClose={() => setAnchor(null)}
        MenuListProps={{ dense: true }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
        transformOrigin={{ vertical: 'top', horizontal: 'center' }}
      >
        {SPEED_OPTIONS.map(o => (
          <MenuItem
            key={o}
            selected={o === factor}
            onClick={() => { setDriveSpeedOverride(o); setAnchor(null); }}
            sx={{ fontSize: 13, minHeight: 0, py: 0.5, justifyContent: 'center' }}
          >
            {o}×
          </MenuItem>
        ))}
      </Menu>
    </>
  );
}

// ── Per-viewer pause-state store ───────────────────────────────────────────
//
// We attach a single subscribe/getSnapshot pair per viewer instance so
// multiple toolbar consumers share the same memoised snapshot.

interface PauseStore {
  subscribe: (listener: () => void) => () => void;
  getSnapshot: () => PauseSnapshot;
}

const _storeCache = new WeakMap<object, PauseStore>();

function makeStore(viewer: UISlotProps['viewer']): PauseStore {
  const cached = _storeCache.get(viewer);
  if (cached) return cached;

  let version = 0;
  let snapshot: PauseSnapshot = {
    paused: viewer.isSimulationPaused,
    reasons: [...viewer.simulationPauseReasons],
    version,
  };
  const listeners = new Set<() => void>();

  const refresh = (): void => {
    version++;
    snapshot = {
      paused: viewer.isSimulationPaused,
      reasons: [...viewer.simulationPauseReasons],
      version,
    };
    for (const l of listeners) l();
  };

  const subscribe = (listener: () => void): (() => void) => {
    listeners.add(listener);
    const off = viewer.on('simulation-pause-changed', refresh as (data: unknown) => void);
    return () => {
      listeners.delete(listener);
      off();
    };
  };

  const getSnapshot = (): PauseSnapshot => snapshot;

  const store: PauseStore = { subscribe, getSnapshot };
  _storeCache.set(viewer, store);
  return store;
}
