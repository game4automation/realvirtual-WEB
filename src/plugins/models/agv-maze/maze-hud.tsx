// Copyright (C) 2026 realvirtual GmbH. All rights reserved.
import { Box, Button, Typography } from '@mui/material';
import { useEffect, useSyncExternalStore } from 'react';
import { useSignal } from '@rv/hooks/use-signal';
import { useViewportInsets } from '@rv/hooks/use-viewport-insets';
import { KpiCard } from '@rv/core/hmi/KpiCard';
import { FLOATING_TOP_MARGIN } from '@rv/core/hmi/layout-constants';
import type { Dir } from './maze-map';

export interface MazeHudControl {
  onHudMounted(): () => void;
  setDesired(dir: Dir): void; restart(): void;
  toggleMute(): void;
  subscribe(listener: () => void): () => void;
  getStatus(): string;
}
const STATE_LABELS = ['Press an arrow key to start', 'Collect the orders', 'Resetting the vehicle', 'Game Over', 'All orders done'];
const PANEL = { p: 1, borderRadius: '4px', bgcolor: 'rgba(18,18,18,0.8)', backdropFilter: 'blur(calc(16px * var(--rv-ui-blur-scale, 1)))', color: 'rgba(255,255,255,0.92)' };
export function MazeScoreBar() {
  const score = useSignal('Maze.Score'), lives = useSignal('Maze.Lives'), left = useSignal('Maze.PelletsLeft');
  const insets = useViewportInsets();
  return <Box sx={{
    position: 'fixed', top: insets.top + FLOATING_TOP_MARGIN,
    left: insets.left, right: insets.right, zIndex: 1200,
    display: 'flex', alignItems: 'flex-start', justifyContent: 'center',
    gap: { xs: 0.75, sm: 1.5 }, px: { xs: 0.5, sm: 0 },
    flexWrap: 'nowrap', pointerEvents: 'none',
    scrollbarWidth: 'none', '&::-webkit-scrollbar': { display: 'none' },
  }} aria-label="AGV Maze score">
    <Box data-ui-panel><KpiCard label="Orders" value={String(Number(score ?? 0))} unit="" color="#48dfd0" animate={false} /></Box>
    <Box data-ui-panel><KpiCard label="Lives" value={String(Number(lives ?? 3))} unit="" color="#ffb85c" animate={false} /></Box>
    <Box data-ui-panel><KpiCard label="Open" value={String(Number(left ?? 0))} unit="" color="#a4b7bb" animate={false} /></Box>
  </Box>;
}
function MazeStateMessage() {
  const state = Number(useSignal('Maze.State') ?? 0), frightened = useSignal('Maze.Frightened');
  return <Box sx={PANEL}>
    <Typography variant="body2" role="status">{STATE_LABELS[state]}{frightened ? ' · Open Source active' : ''}</Typography>
  </Box>;
}
export function MazeControls({ control }: { control: MazeHudControl }) {
  const status = useSyncExternalStore(control.subscribe, control.getStatus);
  const muted = useSignal('Maze.Muted');
  const disabled = status !== 'ready';
  const arrow = (dir: Dir, label: string, glyph: string, row: number, column: number) =>
    <Button aria-label={label} disabled={disabled} sx={{ minWidth: 44, minHeight: 44, gridRow: row, gridColumn: column, touchAction: 'none' }}
      onPointerDown={event => { event.preventDefault(); control.setDesired(dir); }}
      onClick={event => { if (event.detail === 0) control.setDesired(dir); }}>{glyph}</Button>;
  return <Box sx={{ ...PANEL, width: 'fit-content', maxWidth: 184 }}>
    <Button disabled={disabled} onClick={() => control.restart()}>Restart</Button>
    <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(3, 44px)', gridTemplateRows: 'repeat(3, 44px)' }} aria-label="Direction">
      {arrow('N', 'Go north', '▲', 1, 2)}{arrow('W', 'Go west', '◀', 2, 1)}
      {arrow('E', 'Go east', '▶', 2, 3)}{arrow('S', 'Go south', '▼', 3, 2)}
    </Box>
    <Typography variant="caption">Arrow keys / WASD</Typography>
    <Button sx={{ display: 'block' }} onClick={() => control.toggleMute()} aria-pressed={Boolean(muted)}>{muted ? 'Unmute' : 'Mute'}</Button>
    <Typography variant="caption" sx={{ display: 'block', maxWidth: 168 }}>Simans · Rockwall · Schnitter · Kuckuck</Typography>
  </Box>;
}
export function MazeMessages({ control }: { control: MazeHudControl }) {
  const status = useSyncExternalStore(control.subscribe, control.getStatus);
  return status === 'ready' || status === 'inactive' ? null : <Box sx={PANEL} role="status">
    <Typography variant="body2">{status === 'loading' ? 'Loading the vehicle …' : status}</Typography>
  </Box>;
}

/** Uses the shell overlay slot, which remains mounted in viewer mode. */
export function MazeOverlay({ control }: { control: MazeHudControl }) {
  useEffect(() => control.onHudMounted(), [control]);
  return <Box sx={{ position: 'absolute', inset: 0, pointerEvents: 'none !important' }}>
    <MazeScoreBar />
    <Box sx={{ position: 'absolute', top: 64, left: { xs: 8, sm: 64 }, right: 8, width: 'fit-content', maxWidth: 'calc(100% - 24px)', pointerEvents: 'auto' }}>
      <MazeStateMessage /><MazeMessages control={control} />
    </Box>
    <Box sx={{ position: 'absolute', bottom: 48, right: 12, pointerEvents: 'auto' }}>
      <MazeControls control={control} />
    </Box>
  </Box>;
}
