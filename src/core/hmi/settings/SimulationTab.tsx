// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * SimulationTab — Settings → Simulation.
 *
 * Home of user-facing simulation behavior toggles. First entry (plan-276
 * scope change, F10/F16): the opt-in physics switch. When enabled and the
 * loaded model contains no explicit physics zones, the physics plugin
 * synthesizes a WholeScene zone — the toggle alone makes the scene
 * physics-capable. Load-time-only: it takes effect on the next model load.
 *
 * Second entry (F17, Beta): "Full physics — all conveyors". Only effective
 * when the main physics switch is on (strict AND); disabled otherwise. With
 * it, EVERY non-radial conveyor is simulated physically (accumulation via
 * Rapier), regardless of authored per-surface PhysicsMode flags.
 */

import { useEffect, useState } from 'react';
import { Box, Chip, Switch, Typography } from '@mui/material';
import { SettingsSection, FieldRow } from './settings-helpers';
import {
  usePhysicsWholeScene, setPhysicsWholeScene,
  usePhysicsFull, setPhysicsFull,
} from '../visual-settings-store';
import { getAppConfig } from '../rv-app-config';
import { physicsDiagnostics } from '../../engine/rv-physics-registry';

/**
 * Read-only physics diagnostics line (plan-276 Phase 6): "N zones / M bodies /
 * X ms step". Rendered only while a physics world is actually built and
 * stepping (`physicsDiagnostics.active` — the private plugin mutates the
 * singleton in place per tick); polled at 2 Hz while the tab is open.
 */
function PhysicsDiagnosticsLine() {
  const [diag, setDiag] = useState(() => ({ ...physicsDiagnostics }));
  useEffect(() => {
    const id = window.setInterval(() => setDiag({ ...physicsDiagnostics }), 500);
    return () => window.clearInterval(id);
  }, []);
  if (!diag.active) return null;
  return (
    <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.4)', mt: 0.5, fontVariantNumeric: 'tabular-nums' }}>
      {`${diag.zones} ${diag.zones === 1 ? 'zone' : 'zones'} / ${diag.bodies} ${diag.bodies === 1 ? 'body' : 'bodies'} / ${diag.stepMs.toFixed(1)} ms step`}
    </Typography>
  );
}

/** Small inline "Beta" badge for experimental settings rows. */
function BetaChip() {
  return (
    <Chip
      label="Beta"
      size="small"
      sx={{
        ml: 0.5,
        height: 14,
        fontSize: 8,
        fontWeight: 700,
        letterSpacing: 0.5,
        textTransform: 'uppercase',
        bgcolor: 'rgba(255,167,38,0.15)',
        color: '#ffa726',
        '& .MuiChip-label': { px: 0.5 },
      }}
    />
  );
}

export function SimulationTab() {
  const physicsOn = usePhysicsWholeScene();
  const fullOn = usePhysicsFull();
  // Deployment kill-switch (settings.json simulation.physicsEnabled: false)
  // wins over the user toggle — surface that instead of a dead switch.
  const physicsAllowed = getAppConfig().simulation?.physicsEnabled !== false;
  const physicsActive = physicsOn && physicsAllowed;

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 1 }}>
      <SettingsSection id="simulation-physics" title="Physics">
        <FieldRow label="Physics (whole scene)" hint="takes effect on next model load">
          <Switch
            size="small"
            checked={physicsActive}
            disabled={!physicsAllowed}
            onChange={(_, v) => setPhysicsWholeScene(v)}
          />
        </FieldRow>
        <FieldRow
          label={
            <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center' }}>
              Full physics — all conveyors
              <BetaChip />
            </Box>
          }
          hint="Simulates ALL conveyors physically — experimental, takes effect on next model load"
        >
          <Switch
            size="small"
            checked={fullOn && physicsActive}
            disabled={!physicsActive}
            onChange={(_, v) => setPhysicsFull(v)}
          />
        </FieldRow>
        <Typography sx={{ fontSize: 10, color: 'rgba(255,255,255,0.25)', mt: 0.75 }}>
          {physicsAllowed
            ? 'MUs that run off a conveyor end become free rigid bodies — falling, sliding and stacking. ' +
              'Without explicit physics zones in the model the whole scene is treated as one zone. ' +
              'Full physics (Beta) additionally runs every non-radial conveyor as a physical belt.'
            : 'Physics is disabled deployment-wide (settings.json simulation.physicsEnabled).'}
        </Typography>
        <PhysicsDiagnosticsLine />
      </SettingsSection>
    </Box>
  );
}
