// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * ScenarioBar — the scenario line at the top of the planning window (plan-630 §3.1 / §2.8).
 *
 *   Scenario [Basis ▾]  [Save]  [Save as…]
 *   ● unsaved · 3 deviations            (or: saved · 3 deviations)
 *
 * - The select switches to another stored scenario: its values take the registry's normal
 *   paths (live at the next sim instant, reset pending). With unsaved changes the window
 *   asks first, in the window itself (§3.3 — no browser dialog).
 * - Save writes the active scenario into the document's GLB; Save as stores the session's
 *   values under a new name and makes it the active one. Nothing is ever saved on its own.
 * - A document that cannot be written (hosted delivery, read-only project, bundled file)
 *   shows "Not saveable" with the reason; both save buttons are disabled and the values
 *   last for the session.
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Button, TextField, Typography } from '@mui/material';
import type { PlanningRegistry, PlanningSnapshot } from '../../core/planning/rv-planning-registry';
import {
  checkScenarioName, collectScenarioValues, hasScenario,
} from '../../core/planning/rv-planning-scenario';
import type { PlanningParametersPlugin } from './index';
import { resolveScenarioTarget, subscribeScenarioTarget, type ScenarioTarget } from './scenario-persistence';

const LINK_SX = { minHeight: 26, fontSize: 11, textTransform: 'none', px: 1 } as const;

/** The resolved save target, value-stable between changes (a string snapshot, parsed once). */
function useScenarioTarget(): ScenarioTarget {
  const key = useSyncExternalStore(subscribeScenarioTarget, () => JSON.stringify(resolveScenarioTarget()));
  return useMemo(() => JSON.parse(key) as ScenarioTarget, [key]);
}

export function ScenarioBar({ plugin, registry, snapshot }: {
  plugin: PlanningParametersPlugin;
  registry: PlanningRegistry;
  snapshot: PlanningSnapshot;
}) {
  const state = useSyncExternalStore(
    (cb) => plugin.subscribeScenario(cb),
    () => plugin.getScenarioState(),
  );
  const target = useScenarioTarget();
  const [confirmSwitch, setConfirmSwitch] = useState<string | null>(null);
  const [saveAs, setSaveAs] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  // Re-derived with the registry snapshot: both the deviations and the dirty marker read it.
  const deviations = useMemo(() => Object.keys(collectScenarioValues(registry)).length, [registry, snapshot]);
  const dirty = useMemo(() => plugin.isScenarioDirty(), [plugin, snapshot, state]);
  const names = Object.keys(state.block.scenarios);
  const active = state.block.active;
  const canSave = target.persistable && !state.saving;

  const doSwitch = (name: string) => {
    setConfirmSwitch(null);
    const r = plugin.switchScenario(name);
    if (r.ok) { setMessage(null); return; }
    setMessage(`Could not switch: ${'error' in r ? r.error : firstError(r)}`);
  };

  const onSelect = (name: string) => {
    if (name === active) return;
    if (dirty) setConfirmSwitch(name);
    else doSwitch(name);
  };

  const save = (name?: string) => {
    setMessage(null);
    plugin.saveScenario(name)
      .then((r) => {
        setSaveAs(null);
        if (r.persistedTo === 'session') setMessage(`Kept for this session only — ${r.reason ?? 'not saveable'}`);
        else if (r.openInEditor) setMessage('Saved. The document is also open in the editor — its next save writes its own copy.');
      })
      .catch(() => { /* the plugin keeps the error in its state */ });
  };

  const saveAsCheck = saveAs === null ? null : checkScenarioName(saveAs);

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.5, pb: 0.5, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75 }}>
        <Typography component="label" htmlFor="planning-scenario-select" sx={{ fontSize: 11, color: 'rgba(255,255,255,0.6)' }}>
          Scenario
        </Typography>
        <Box
          component="select"
          id="planning-scenario-select"
          aria-label="Scenario"
          value={active}
          disabled={state.saving}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => onSelect(e.target.value)}
          sx={{
            flex: 1, minWidth: 0, height: 26, fontSize: 11, fontFamily: 'inherit',
            bgcolor: 'rgba(255,255,255,0.06)', color: 'inherit',
            border: '1px solid rgba(255,255,255,0.18)', borderRadius: 1, px: 0.5,
          }}
        >
          {names.map((n) => <option key={n} value={n}>{n}</option>)}
        </Box>
        <Button
          size="small"
          variant="outlined"
          disabled={!canSave || !dirty}
          onClick={() => save()}
          title={target.persistable ? `Save "${active}" into ${target.documentName ?? 'the document'}` : target.reason}
          sx={LINK_SX}
        >
          {state.saving ? 'Saving …' : 'Save'}
        </Button>
        <Button
          size="small"
          variant="text"
          disabled={!canSave}
          onClick={() => setSaveAs('')}
          title={target.persistable ? 'Save the current values as a new scenario' : target.reason}
          sx={LINK_SX}
        >
          Save as…
        </Button>
      </Box>

      <Typography role="status" aria-label="Scenario status" sx={{ fontSize: 10, color: dirty ? '#ffcc80' : 'rgba(255,255,255,0.55)' }}>
        {dirty ? '● unsaved' : 'saved'}
        {` · ${deviations} ${deviations === 1 ? 'deviation' : 'deviations'}`}
      </Typography>

      {!target.persistable && (
        <Typography role="note" aria-label="Not saveable" sx={{ fontSize: 10, color: 'rgba(255,255,255,0.55)' }}>
          {`Not saveable — ${target.reason ?? 'values last for this session only.'}`}
        </Typography>
      )}

      {confirmSwitch !== null && (
        <Box role="alertdialog" aria-label="Unsaved changes" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap' }}>
          <Typography sx={{ fontSize: 10, color: '#ffcc80' }}>
            {`Discard unsaved changes and switch to "${confirmSwitch}"?`}
          </Typography>
          <Button size="small" onClick={() => doSwitch(confirmSwitch)} sx={LINK_SX}>Switch</Button>
          <Button size="small" onClick={() => setConfirmSwitch(null)} sx={LINK_SX}>Cancel</Button>
        </Box>
      )}

      {saveAs !== null && (
        <Box sx={{ display: 'flex', alignItems: 'flex-start', gap: 0.5 }}>
          <TextField
            size="small"
            autoFocus
            value={saveAs}
            placeholder="Scenario name"
            onChange={(e) => setSaveAs(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && saveAsCheck?.ok) save(saveAsCheck.name);
              if (e.key === 'Escape') setSaveAs(null);
            }}
            error={saveAs !== '' && saveAsCheck !== null && !saveAsCheck.ok}
            helperText={saveAs !== '' && saveAsCheck && !saveAsCheck.ok
              ? saveAsCheck.error
              : saveAsCheck?.ok && hasScenario(state.block.scenarios, saveAsCheck.name) ? 'Replaces the stored scenario' : undefined}
            inputProps={{ 'aria-label': 'New scenario name', style: { fontSize: 11, padding: '4px 6px' } }}
            FormHelperTextProps={{ sx: { fontSize: 9, mx: 0 } }}
            sx={{ flex: 1 }}
          />
          <Button size="small" disabled={!saveAsCheck?.ok || state.saving} onClick={() => saveAsCheck?.ok && save(saveAsCheck.name)} sx={LINK_SX}>
            Save
          </Button>
          <Button size="small" onClick={() => setSaveAs(null)} sx={LINK_SX}>Cancel</Button>
        </Box>
      )}

      {(state.error || message) && (
        <Typography role="alert" sx={{ fontSize: 10, color: state.error ? '#ef9a9a' : 'rgba(255,255,255,0.7)' }}>
          {state.error ? `Save failed: ${state.error}` : message}
        </Typography>
      )}
    </Box>
  );
}

function firstError(r: { results?: Record<string, { error?: string }>; errors?: Record<string, string> }): string {
  const fromResults = Object.entries(r.results ?? {}).find(([, v]) => v.error && v.error !== 'not-applied');
  if (fromResults) return `${fromResults[0]}: ${fromResults[1].error}`;
  const extra = Object.entries(r.errors ?? {})[0];
  return extra ? `${extra[0]}: ${extra[1]}` : 'rejected';
}
