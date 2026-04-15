// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * TestAxesPlugin — Manual axis tester with slider window.
 *
 * Button in left sidebar opens a floating panel with sliders for A1-A6.
 * While the window is open, DrivesRecorder is deactivated (activeOnly='Never')
 * and drives are locked via positionOverwrite. Closing restores everything.
 */

import { useState, useSyncExternalStore, useCallback } from 'react';
import { Box, Paper, Typography, Slider, IconButton, Button } from '@mui/material';
import { Science, Close } from '@mui/icons-material';
import type { UISlotEntry, UISlotProps } from '../../core/rv-ui-plugin';
import type { RVDrive } from '../../core/engine/rv-drive';
import type { ActiveOnly } from '../../core/engine/rv-active-only';
import { RVBehavior } from '../../core/rv-behavior';
import { NavButton } from '../../core/hmi/NavButton';
import { debug } from '../../core/engine/rv-debug';

// ─── Slider Window ──────────────────────────────────────────────────────

function TestAxesWindow({ plugin, onClose }: { plugin: TestAxesPlugin; onClose: () => void }) {
  const [positions, setPositions] = useState<number[]>(() => plugin.axes.map(d => d.currentPosition));

  const handleSlider = useCallback((index: number, value: number) => {
    plugin.setAxisPosition(index, value);
    setPositions(prev => { const next = [...prev]; next[index] = value; return next; });
  }, [plugin]);

  return (
    <Paper
      elevation={6}
      sx={{
        position: 'fixed',
        left: 64,
        top: '50%',
        transform: 'translateY(-50%)',
        width: 280,
        p: 2,
        borderRadius: 2,
        zIndex: 1300,
        pointerEvents: 'auto',
      }}
    >
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', mb: 1 }}>
        <Typography variant="subtitle2">Test Axes</Typography>
        <IconButton size="small" onClick={onClose}><Close fontSize="small" /></IconButton>
      </Box>
      {plugin.axes.map((drive, i) => (
        <Box key={drive.name} sx={{ mb: 1 }}>
          <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Typography variant="caption" sx={{ fontWeight: 600 }}>{drive.name}</Typography>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5 }}>
              <Typography variant="caption" sx={{ color: 'text.secondary' }}>{positions[i]?.toFixed(1)}°</Typography>
              <Button size="small" variant="text" sx={{ minWidth: 24, px: 0.5, fontSize: 10 }}
                onClick={() => handleSlider(i, 0)}>0</Button>
            </Box>
          </Box>
          <Slider
            size="small"
            min={-180}
            max={180}
            step={0.5}
            value={positions[i] ?? 0}
            onChange={(_, v) => handleSlider(i, v as number)}
            sx={{ py: 0.5 }}
          />
        </Box>
      ))}
    </Paper>
  );
}

// ─── Button ─────────────────────────────────────────────────────────────

function TestAxesButton({ viewer }: UISlotProps) {
  const plugin = viewer.getPlugin<TestAxesPlugin>('test-axes');
  const open = useSyncExternalStore(
    plugin?.subscribe ?? (() => () => {}),
    plugin?.getSnapshot ?? (() => false),
  );

  const handleToggle = useCallback(() => {
    if (!plugin) return;
    if (open) plugin.close();
    else plugin.open();
  }, [plugin, open]);

  return (
    <>
      <NavButton icon={<Science />} label="Test Axes" active={open} onClick={handleToggle} />
      {open && plugin && <TestAxesWindow plugin={plugin} onClose={() => plugin.close()} />}
    </>
  );
}

// ─── Plugin ─────────────────────────────────────────────────────────────

export class TestAxesPlugin extends RVBehavior {
  readonly id = 'test-axes';
  readonly slots: UISlotEntry[] = [
    { slot: 'button-group', component: TestAxesButton, order: 60 },
  ];

  static readonly AXIS_NAMES = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];

  private _axes: RVDrive[] = [];
  private _isOpen = false;

  // Saved state
  private _savedPositions: number[] = [];
  private _savedOverwrites: boolean[] = [];
  private _savedActiveOnly: ActiveOnly = 'Always';

  // ── External store subscription (React) ──
  private _listeners = new Set<() => void>();
  private _snapshot = false;

  /** Subscribe for React useSyncExternalStore. */
  subscribe = (listener: () => void): (() => void) => {
    this._listeners.add(listener);
    return () => { this._listeners.delete(listener); };
  };

  /** Snapshot getter for React useSyncExternalStore. Returns stable primitive. */
  getSnapshot = (): boolean => this._snapshot;

  private _notify(): void {
    this._snapshot = this._isOpen;
    for (const listener of this._listeners) listener();
  }

  get axes(): RVDrive[] { return this._axes; }
  get isOpen(): boolean { return this._isOpen; }

  // ── Lifecycle ──

  protected onStart(): void {
    this._axes = TestAxesPlugin.AXIS_NAMES
      .map(name => this.drives.find(d => d.name === name))
      .filter((d): d is RVDrive => d !== undefined);
  }

  protected onDestroy(): void {
    if (this._isOpen) { this._restore(); this._isOpen = false; this._notify(); }
    this._axes = [];
  }

  // ── Public API ──

  open(): void {
    if (this._isOpen || !this.viewer || this._axes.length === 0) {
      console.warn(`[TestAxes] open() rejected: isOpen=${this._isOpen}, viewer=${!!this.viewer}, axes=${this._axes.length}`);
      return;
    }

    // Save state
    this._savedPositions = this.drives.map(d => d.currentPosition);
    this._savedOverwrites = this.drives.map(d => d.positionOverwrite);

    // Deactivate DrivesRecorder
    if (this.playback) {
      this._savedActiveOnly = this.playback.activeOnly;
      this.playback.activeOnly = 'Never';
    }

    // Lock all drives
    for (const d of this.drives) {
      d.positionOverwrite = true;
    }

    this._isOpen = true;
    this._notify();
    debug('drive', `[TestAxes] Window opened — ${this._axes.length} axes, recorder deactivated`);
  }

  close(): void {
    if (!this._isOpen) return;
    this._restore();
    this._isOpen = false;
    this._notify();
    debug('drive', '[TestAxes] Window closed — state restored');
  }

  /** Set a single axis position by index (called from slider). */
  setAxisPosition(index: number, degrees: number): void {
    if (index >= 0 && index < this._axes.length) {
      this._axes[index].currentPosition = degrees;
    }
  }

  // ── Internal ──

  private _restore(): void {
    if (!this.viewer) return;

    // Restore positions + overwrite flags
    const allDrives = this.drives;
    for (let i = 0; i < allDrives.length; i++) {
      if (i < this._savedPositions.length) allDrives[i].currentPosition = this._savedPositions[i];
      if (i < this._savedOverwrites.length) allDrives[i].positionOverwrite = this._savedOverwrites[i];
    }

    // Restore DrivesRecorder Active property
    if (this.playback) this.playback.activeOnly = this._savedActiveOnly;

    this._savedPositions = [];
    this._savedOverwrites = [];
  }
}
