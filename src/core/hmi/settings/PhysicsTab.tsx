// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { useState, useRef } from 'react';
import { Typography, Box, Switch, Slider } from '@mui/material';
import { useViewer } from '../../../hooks/use-viewer';
import { loadPhysicsSettings, savePhysicsSettings, type PhysicsSettings } from '../physics-settings-store';
import { StatRow } from './settings-helpers';

export function PhysicsTab() {
  const viewer = useViewer();
  const settingsRef = useRef(loadPhysicsSettings());
  const [enabled, setEnabled] = useState(settingsRef.current.enabled);
  const [gravity, setGravity] = useState(settingsRef.current.gravity);
  const [friction, setFriction] = useState(settingsRef.current.friction);
  const [debugVis, setDebugVis] = useState(settingsRef.current.debugWireframes);
  const [substeps, setSubsteps] = useState(settingsRef.current.substeps);
  const [reloading, setReloading] = useState(false);

  const persist = (patch: Partial<PhysicsSettings>) => {
    Object.assign(settingsRef.current, patch);
    savePhysicsSettings(settingsRef.current);
  };

  /** Save settings and reload model to apply physics changes. */
  const persistAndReload = (patch: Partial<PhysicsSettings>) => {
    persist(patch);
    if (!viewer.currentModelUrl) return;
    setReloading(true);
    viewer.reloadModel().then(() => setReloading(false)).catch(() => setReloading(false));
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2.5 }}>
      {/* Physics on/off */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
        <Box>
          <Typography variant="body2" sx={{ color: 'text.primary' }}>Rapier.js Physics</Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
            Replaces kinematic transport with rigid-body physics
          </Typography>
        </Box>
        <Switch size="small" checked={enabled} disabled={reloading} onChange={(_, v) => { setEnabled(v); persistAndReload({ enabled: v }); }} />
      </Box>

      {/* Gravity */}
      <Box sx={{ opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? 'auto' : 'none' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Gravity (m/s²)
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
          <Slider size="small" min={0} max={20} step={0.1} value={gravity} onChange={(_, v) => { const val = v as number; setGravity(val); persist({ gravity: val }); }} onChangeCommitted={(_, v) => { persistAndReload({ gravity: v as number }); }} sx={{ flex: 1 }} />
          <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 40, textAlign: 'right' }}>
            {gravity.toFixed(1)}
          </Typography>
        </Box>
      </Box>

      {/* Friction */}
      <Box sx={{ opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? 'auto' : 'none' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Surface Friction
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
          <Slider size="small" min={0} max={3} step={0.1} value={friction} onChange={(_, v) => { const val = v as number; setFriction(val); persist({ friction: val }); }} onChangeCommitted={(_, v) => { persistAndReload({ friction: v as number }); }} sx={{ flex: 1 }} />
          <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 32, textAlign: 'right' }}>
            {friction.toFixed(1)}
          </Typography>
        </Box>
      </Box>

      {/* Substeps */}
      <Box sx={{ opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? 'auto' : 'none' }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Substeps
        </Typography>
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 2, mt: 0.5 }}>
          <Slider size="small" min={1} max={4} step={1} marks value={substeps} onChange={(_, v) => { const val = v as number; setSubsteps(val); persist({ substeps: val }); }} onChangeCommitted={(_, v) => { persistAndReload({ substeps: v as number }); }} sx={{ flex: 1 }} />
          <Typography variant="caption" sx={{ color: 'text.secondary', fontFamily: 'monospace', minWidth: 16, textAlign: 'right' }}>
            {substeps}
          </Typography>
        </Box>
      </Box>

      {/* Debug visualization */}
      <Box sx={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', opacity: enabled ? 1 : 0.4, pointerEvents: enabled ? 'auto' : 'none' }}>
        <Box>
          <Typography variant="body2" sx={{ color: 'text.primary' }}>Debug Wireframes</Typography>
          <Typography variant="caption" sx={{ color: 'text.secondary', display: 'block' }}>
            Show collider shapes as wireframes
          </Typography>
        </Box>
        <Switch size="small" checked={debugVis} disabled={reloading} onChange={(_, v) => { setDebugVis(v); persistAndReload({ debugWireframes: v }); }} />
      </Box>

      {/* Status */}
      <Box sx={{ borderTop: '1px solid rgba(255,255,255,0.08)', pt: 1.5 }}>
        <Typography variant="caption" sx={{ color: 'text.secondary', textTransform: 'uppercase', letterSpacing: 1 }}>
          Status
        </Typography>
        <Box sx={{ mt: 1, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
          <StatRow label="Engine" value={enabled ? 'Rapier.js (WASM)' : 'Kinematic'} color={enabled ? '#66bb6a' : '#4fc3f7'} />
          <StatRow label="MU Bodies" value="—" />
          <StatRow label="Conveyors" value="—" />
        </Box>
      </Box>

      {reloading && (
        <Typography variant="caption" sx={{ color: '#ffa726', fontStyle: 'italic' }}>
          Reloading model to apply physics settings...
        </Typography>
      )}
    </Box>
  );
}
