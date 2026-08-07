// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * IKTargetQuickEdit — Content for the IK pathpoint context popover.
 *
 * Pure content (no positioning, no own header): the generic AnchoredPopover
 * supplies the standard COMPACT WINDOW chrome (drag titlebar with the target
 * name + close button — the plugin passes `title` on show). Reads/edits the
 * active IKTarget via ikEditStore (fed by IKTargetEditPlugin). The status row
 * shows reachability and the IK-configuration stepper (elbow/shoulder/wrist
 * branch selection — the choice is written back to the target's AxisPos).
 * Self-registers under id 'ik-target'.
 */

import { useSyncExternalStore } from 'react';
import { Box, Typography, IconButton, Tooltip, Divider } from '@mui/material';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import { ikEditStore, type IKEditValues } from './ik-edit-store';
import { EnumEditor, NumberEditor, BooleanEditor } from './rv-field-editors';
import { popoverContentRegistry } from './popover-store';

const INTERP = ['PointToPoint', 'PointToPointUnsynced', 'Linear'];

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
      <Typography sx={{ fontSize: 11, color: 'rgba(255,255,255,0.6)', minWidth: 78 }}>{label}</Typography>
      <Box sx={{ flex: 1 }}>{children}</Box>
    </Box>
  );
}

function ActionBtn({ label, color, onClick }: { label: string; color?: string; onClick: () => void }) {
  return (
    <Box
      onClick={onClick}
      sx={{
        fontSize: 11, px: 0.75, py: 0.5, borderRadius: 0.5, cursor: 'pointer', textAlign: 'center', flex: 1,
        bgcolor: 'rgba(255,255,255,0.06)', border: '1px solid rgba(255,255,255,0.08)',
        color: color ?? 'rgba(255,255,255,0.85)', whiteSpace: 'nowrap', userSelect: 'none',
        '&:hover': { bgcolor: 'rgba(255,255,255,0.14)' },
      }}
    >{label}</Box>
  );
}

/** Reachability dot + IK-configuration stepper (◀ 2/6 ▶). Hovering a chevron
 *  shows the neighbor configuration as a ghost; clicking applies it. */
function StatusRow({ reachable, count, index, onCycle, onPreview }: {
  reachable: boolean; count: number; index: number;
  onCycle: (dir: 1 | -1) => void; onPreview: (dir: 1 | -1 | null) => void;
}) {
  const col = reachable ? '#5dd55d' : '#ff5d5d';
  return (
    <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mb: 0.75 }}>
      <Box sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: col, boxShadow: `0 0 6px ${col}`, flexShrink: 0 }} />
      <Typography sx={{ fontSize: 10.5, color: 'rgba(255,255,255,0.55)', flex: 1 }}>
        {reachable ? 'reachable' : 'not reachable'}
      </Typography>
      {count > 0 && (
        <Tooltip title="IK configuration (shoulder/elbow/wrist)" placement="top">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.25 }}>
            <IconButton
              size="small" disabled={count < 2}
              onClick={() => onCycle(-1)}
              onPointerEnter={() => onPreview(-1)}
              onPointerLeave={() => onPreview(null)}
              sx={{ p: 0.1, color: 'rgba(255,255,255,0.7)' }}
            >
              <ChevronLeftIcon sx={{ fontSize: 15 }} />
            </IconButton>
            <Typography sx={{ fontSize: 10.5, fontFamily: 'ui-monospace, monospace', color: 'rgba(255,255,255,0.8)', minWidth: 28, textAlign: 'center' }}>
              {index >= 0 ? index + 1 : '–'}/{count}
            </Typography>
            <IconButton
              size="small" disabled={count < 2}
              onClick={() => onCycle(1)}
              onPointerEnter={() => onPreview(1)}
              onPointerLeave={() => onPreview(null)}
              sx={{ p: 0.1, color: 'rgba(255,255,255,0.7)' }}
            >
              <ChevronRightIcon sx={{ fontSize: 15 }} />
            </IconButton>
          </Box>
        </Tooltip>
      )}
    </Box>
  );
}

/** Three compact number fields (world pose components). */
function TripleRow({ label, values, unit, onChange }: {
  label: string; values: [number, number, number]; unit?: string;
  onChange: (i: 0 | 1 | 2, v: number) => void;
}) {
  return (
    <Row label={label}>
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        {([0, 1, 2] as const).map((i) => (
          <Box key={i} sx={{ flex: 1, minWidth: 0 }}>
            <NumberEditor value={values[i]} unit={unit} onChange={(v) => onChange(i, v)} />
          </Box>
        ))}
      </Box>
    </Row>
  );
}

function IKTargetQuickEdit() {
  const active = useSyncExternalStore(ikEditStore.subscribe, ikEditStore.getSnapshot);
  if (!active) return null;
  const ctl = ikEditStore.getController();
  if (!ctl) return null;
  const set = <K extends keyof IKEditValues>(k: K, v: IKEditValues[K]) => ctl.setProp(k, v);
  const isLinear = active.interpolation === 'Linear';

  const poseField = (axis: 'x' | 'y' | 'z' | 'rx' | 'ry' | 'rz', v: number) => ctl.setPose(axis, v);

  return (
    <Box sx={{ width: 244 }}>
      <StatusRow
        reachable={active.reachable}
        count={active.solutionCount}
        index={active.solutionIndex}
        onCycle={(dir) => ctl.cycleSolution(dir)}
        onPreview={(dir) => ctl.previewSolution(dir)}
      />

      <TripleRow
        label="Pos (mm)" values={active.poseMm}
        onChange={(i, v) => poseField((['x', 'y', 'z'] as const)[i], v)}
      />
      <TripleRow
        label="Rot (°)" values={active.poseDeg}
        onChange={(i, v) => poseField((['rx', 'ry', 'rz'] as const)[i], v)}
      />
      <Row label="Align">
        <Box sx={{ display: 'flex', gap: 0.5 }}>
          <ActionBtn label="Down" onClick={() => ctl.align('down')} />
          <ActionBtn label="World" onClick={() => ctl.align('world')} />
        </Box>
      </Row>
      <Divider sx={{ borderColor: 'rgba(255,255,255,0.1)', my: 0.75 }} />

      <Row label="Interpolation"><EnumEditor value={active.interpolation} options={INTERP} onChange={(v) => set('interpolation', v)} /></Row>
      <Row label="Speed"><NumberEditor value={active.speedToTarget} onChange={(v) => set('speedToTarget', v)} /></Row>
      {isLinear && <Row label="Lin. Speed"><NumberEditor value={active.linearSpeed} onChange={(v) => set('linearSpeed', v)} /></Row>}
      {isLinear && <Row label="Lin. Accel"><NumberEditor value={active.linearAccel} onChange={(v) => set('linearAccel', v)} /></Row>}
      <Row label="Blending"><BooleanEditor value={active.enableBlending} onChange={(v) => set('enableBlending', v)} /></Row>
      {active.enableBlending && <Row label="Blend R."><NumberEditor value={active.blendRadius} onChange={(v) => set('blendRadius', v)} /></Row>}
      <Row label="Wait (s)"><NumberEditor value={active.waitForSeconds} onChange={(v) => set('waitForSeconds', v)} /></Row>
      <Row label="Pick&Place"><BooleanEditor value={active.pickAndPlace} onChange={(v) => set('pickAndPlace', v)} /></Row>

      <Divider sx={{ borderColor: 'rgba(255,255,255,0.1)', my: 0.75 }} />
      <Box sx={{ display: 'flex', gap: 0.5 }}>
        <ActionBtn label="+ before" onClick={() => ctl.addPoint('before')} />
        <ActionBtn label="+ after" onClick={() => ctl.addPoint('after')} />
        <ActionBtn label="Delete" color="#ff8080" onClick={() => ctl.deleteTarget()} />
      </Box>
    </Box>
  );
}

// Self-register as the 'ik-target' popover content.
popoverContentRegistry.register('ik-target', IKTargetQuickEdit);
