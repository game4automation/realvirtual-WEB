// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import { readLocalStorage, removeLocalStorage, writeLocalStorage } from '../rv-safe-storage';

/**
 * DevToolbarPopover — the content behind the dev toolbar button (plan-615).
 *
 * Sections: the serving session (what the old banner said), the view switch
 * (dev view ↔ delivered view, F3), "Save snapshot" (F4), the status lines
 * (invariants, Problems errors — F5) and the dev load flags (F6).
 *
 * Dev server only: it is mounted solely by `DevToolbarButton` / `DevHandle`,
 * which render behind `RV_SERVE_INFO !== null`, so a build carries none of it —
 * including the endpoint path below.
 *
 * Built from the inspector building blocks and the `shared-sx.ts` design
 * values (plan-510); no local colours.
 */

import { useMemo, useState, useSyncExternalStore } from 'react';
import { Box, Button, Checkbox, Switch, TextField, ToggleButton, ToggleButtonGroup, Typography } from '@mui/material';
import type { RVServeInfo } from '../rv-serve-info';
import { formatServeRoot, formatSessionLabel, isCanonicalCheckout } from '../rv-serve-info';
import { getViewProfileHost, type ViewProfile } from '../rv-view-profile';
import type { RVAppConfig } from '../rv-app-config';
import { getProblems, subscribeProblems } from './problems-store';
import { getInvariantReportCount, subscribeInvariantReports } from '../engine/rv-invariant-report-count';
import {
  DISABLE_METADATA_LS_KEY, PICK_STRUCTURE_LS_KEY, JSON_EDITOR_LS_KEY,
} from '../engine/rv-dev-load-flags';
import { InspectorRow } from './rv-inspector-row';
import { InspectorActionRow, InspectorSubheader } from './rv-inspector-blocks';
import {
  ACCENT, ERROR, FS, INK_HIGH, INK_LOW, INK_MID, MONO, SUCCESS, WARN,
  compactToggleGroupSx, inspectorInputSx,
} from './shared-sx';
import { useViewer } from '../../hooks/use-viewer';

/** Route of the dev-server golden writer (`scripts/lib/rv-dev-golden.mjs`). */
export const DEV_GOLDEN_ENDPOINT = '/__api/dev/golden';

/** Spec folder a snapshot lands in when the field is left empty. */
export const DEFAULT_SNAPSHOT_SPEC = 'dev-snapshots';

/** Width of the popover body in px. */
const POPOVER_WIDTH = 340;

// ─── Pure helpers (exported for tests) ──────────────────────────────────

/** Tooltip / header lines naming the served checkout: label, port, machine, path, branch. */
export function serveSessionLines(info: RVServeInfo, fallbackPort: string = ''): string[] {
  const port = info.vitePort ?? (fallbackPort !== '' ? Number(fallbackPort) : null);
  return [
    isCanonicalCheckout(info) ? 'Dev server · CANONICAL checkout' : `Dev server · ${formatSessionLabel(info)}`,
    `Port: ${port ? `:${port}` : '—'}`,
    `Machine: ${info.host}`,
    `Path: ${formatServeRoot(info.root)}`,
    `Branch: ${info.branch || '—'}`,
  ];
}

/** One-line summary of what a config's view keys do, e.g. "mode hmi · settings locked". */
export function describeViewConfig(config: RVAppConfig): string {
  const parts: string[] = [];
  const lock = config.mode?.lock?.trim();
  if (lock) parts.push(`mode ${lock}`);
  if (config.lockSettings === true) parts.push('settings locked');
  else if (config.lockedTabs && config.lockedTabs.length > 0) parts.push(`${config.lockedTabs.length} tabs locked`);
  const overrides = config.ui?.visibilityOverrides ? Object.keys(config.ui.visibilityOverrides).length : 0;
  if (overrides > 0) parts.push(`${overrides} visibility overrides`);
  const contexts = config.ui?.initialContexts?.length ?? 0;
  if (contexts > 0) parts.push(`contexts ${config.ui!.initialContexts!.join(', ')}`);
  return parts.length > 0 ? parts.join(' · ') : 'no view keys';
}

/** Result of a snapshot save. */
export type SnapshotSaveResult = { ok: true; path: string } | { ok: false; error: string };

/** Posts a snapshot to the dev endpoint. `fetchImpl` is injectable for tests. */
export async function saveSnapshotGolden(
  name: string,
  snapshot: unknown,
  overwrite: boolean,
  fetchImpl: typeof fetch = fetch,
): Promise<SnapshotSaveResult> {
  try {
    const resp = await fetchImpl(DEV_GOLDEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, snapshot, overwrite }),
    });
    const data = await resp.json().catch(() => ({})) as { ok?: boolean; path?: string; error?: string };
    if (resp.ok && data.ok && typeof data.path === 'string') return { ok: true, path: data.path };
    return { ok: false, error: data.error ?? `HTTP ${resp.status}` };
  } catch (e) {
    return { ok: false, error: String((e as Error)?.message ?? e) };
  }
}

// ─── Dev load flags (F6) ────────────────────────────────────────────────

interface DevFlag {
  key: string;
  label: string;
  /** localStorage value that switches the feature OFF. */
  offValue: string;
}

/** The flags of `rv-dev-load-flags.ts`, each read at load time (reload required). */
export const DEV_FLAGS: readonly DevFlag[] = [
  { key: DISABLE_METADATA_LS_KEY, label: 'Load metadata', offValue: '1' },
  { key: PICK_STRUCTURE_LS_KEY, label: 'Pick structure', offValue: '0' },
  { key: JSON_EDITOR_LS_KEY, label: 'JSON field editor', offValue: '0' },
];

function readFlagOn(flag: DevFlag): boolean {
  return readLocalStorage(flag.key) !== flag.offValue;
}

function writeFlagOn(flag: DevFlag, on: boolean): void {
  try {
    if (on) removeLocalStorage(flag.key);
    else writeLocalStorage(flag.key, flag.offValue);
  } catch { /* storage blocked — the switch simply does not stick */ }
}

// ─── Component ──────────────────────────────────────────────────────────

const valueSx = { fontSize: FS.label, fontFamily: MONO, color: INK_HIGH, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0 } as const;
const textFieldSx = { width: '100%', '& .MuiInputBase-root': { fontSize: FS.label, fontFamily: MONO, height: 20, ...inspectorInputSx }, '& .MuiInputBase-input': { py: 0.25, px: 1 } } as const;

/**
 * Wrapping variant for values whose distinguishing part sits at the END (path,
 * branch): the full value, broken anywhere, at most three lines — never an
 * ellipsis that hides exactly the part that tells two sessions apart.
 */
const wrapValueSx = {
  fontSize: FS.label, fontFamily: MONO, color: INK_HIGH, minWidth: 0,
  whiteSpace: 'normal', overflowWrap: 'anywhere', wordBreak: 'break-all',
  display: '-webkit-box', WebkitLineClamp: 3, WebkitBoxOrient: 'vertical', overflow: 'hidden',
} as const;

function Value({ children, title, color, wrap = false }: { children: string; title?: string; color?: string; wrap?: boolean }) {
  return (
    <Typography component="span" title={title ?? children}
      sx={{ ...(wrap ? wrapValueSx : valueSx), color: color ?? INK_HIGH }}>
      {children}
    </Typography>
  );
}

export function DevToolbarPopover({ info }: { info: RVServeInfo }) {
  const viewer = useViewer();
  const canonical = isCanonicalCheckout(info);
  const host = getViewProfileHost();
  const view: ViewProfile = host?.current() ?? 'dev';
  const port = info.vitePort ?? (typeof window !== 'undefined' ? window.location.port : '');

  // Snapshot
  const [spec, setSpec] = useState(DEFAULT_SNAPSHOT_SPEC);
  const [step, setStep] = useState('');
  const [overwrite, setOverwrite] = useState(false);
  const [saving, setSaving] = useState(false);
  const [saveResult, setSaveResult] = useState<SnapshotSaveResult | null>(null);

  // Status (subscriptions — nothing is polled)
  const invariantReports = useSyncExternalStore(subscribeInvariantReports, getInvariantReportCount, getInvariantReportCount);
  const problems = useSyncExternalStore(subscribeProblems, getProblems, getProblems);
  const problemErrors = useMemo(() => problems.filter((p) => p.severity === 'error').length, [problems]);

  // Flags
  const [flags, setFlags] = useState(() => DEV_FLAGS.map(readFlagOn));
  const [flagsChanged, setFlagsChanged] = useState(false);

  const save = async () => {
    const name = `${spec.trim() || DEFAULT_SNAPSHOT_SPEC}/${step.trim()}`;
    setSaving(true);
    setSaveResult(null);
    let snapshot: unknown;
    try {
      snapshot = viewer.collectStateSnapshot();
    } catch (e) {
      setSaving(false);
      setSaveResult({ ok: false, error: `snapshot failed: ${String((e as Error)?.message ?? e)}` });
      return;
    }
    const result = await saveSnapshotGolden(name, snapshot, overwrite);
    setSaving(false);
    setSaveResult(result);
  };

  return (
    <Box data-testid="dev-toolbar-popover" sx={{ width: POPOVER_WIDTH, maxWidth: 'calc(100vw - 32px)', py: 0.5 }}>
      <InspectorSubheader accent={canonical ? ERROR : undefined} trailing={canonical ? <Value color={ERROR}>⚠ CANONICAL</Value> : undefined}>
        Dev server
      </InspectorSubheader>
      <InspectorRow label="Session" alignField="end"><Value>{`${formatSessionLabel(info)}${port ? ` · :${port}` : ''}`}</Value></InspectorRow>
      <InspectorRow label="Machine" alignField="end"><Value>{`@${info.host}`}</Value></InspectorRow>
      <InspectorRow label="Path" fullWidthField><Value wrap title={info.root}>{formatServeRoot(info.root)}</Value></InspectorRow>
      <InspectorRow label="Branch" fullWidthField><Value wrap>{info.branch || '—'}</Value></InspectorRow>

      <InspectorSubheader>View</InspectorSubheader>
      <InspectorRow label="View" alignField="end" rowTooltip="Switching reloads the page — camera and signal state are lost">
        <ToggleButtonGroup
          exclusive
          size="small"
          value={view}
          disabled={!host}
          onChange={(_e, next: ViewProfile | null) => { if (next && next !== view && host) void host.apply(next); }}
          sx={compactToggleGroupSx(ACCENT, '79,195,247')}
        >
          <ToggleButton value="dev" data-testid="dev-view-dev">Dev</ToggleButton>
          <ToggleButton value="delivered" data-testid="dev-view-delivered">Delivered</ToggleButton>
        </ToggleButtonGroup>
      </InspectorRow>
      {host && (
        <InspectorRow label="Delivered" fullWidthField>
          <Value>{describeViewConfig(host.deliveredConfig())}</Value>
        </InspectorRow>
      )}

      <InspectorSubheader>Snapshot</InspectorSubheader>
      <InspectorRow label="Spec" fullWidthField>
        <TextField size="small" value={spec} onChange={(e) => setSpec(e.target.value)} placeholder={DEFAULT_SNAPSHOT_SPEC}
          inputProps={{ 'aria-label': 'Golden spec folder', 'data-testid': 'dev-snapshot-spec' }} sx={textFieldSx} />
      </InspectorRow>
      <InspectorRow label="Step" fullWidthField>
        <TextField size="small" value={step} onChange={(e) => setStep(e.target.value)} placeholder="step name"
          inputProps={{ 'aria-label': 'Golden step name', 'data-testid': 'dev-snapshot-step' }} sx={textFieldSx} />
      </InspectorRow>
      <InspectorRow label="Overwrite" alignField="end">
        <Checkbox size="small" checked={overwrite} onChange={(e) => setOverwrite(e.target.checked)} sx={{ p: 0 }}
          inputProps={{ 'aria-label': 'Overwrite an existing golden' }} />
      </InspectorRow>
      <InspectorActionRow>
        <Button size="small" variant="outlined" disabled={saving || step.trim() === ''} onClick={() => { void save(); }}
          data-testid="dev-snapshot-save" sx={{ fontSize: FS.label, textTransform: 'none', py: 0, minHeight: 0 }}>
          {saving ? 'Saving…' : 'Save snapshot'}
        </Button>
      </InspectorActionRow>
      {saveResult && (
        <InspectorRow label={saveResult.ok ? 'Written' : 'Error'} fullWidthField labelColor={saveResult.ok ? SUCCESS : ERROR}>
          <Value color={saveResult.ok ? INK_HIGH : ERROR}>{saveResult.ok ? saveResult.path : saveResult.error}</Value>
        </InspectorRow>
      )}

      <InspectorSubheader>Status</InspectorSubheader>
      <InspectorRow label="Invariants" alignField="end" rowTooltip="Invariant-layer violations reported on this page (console.error)">
        <Value color={invariantReports > 0 ? WARN : INK_MID}>{String(invariantReports)}</Value>
      </InspectorRow>
      <InspectorRow label="Problems" alignField="end" rowTooltip="Problems entries with severity error">
        <Value color={problemErrors > 0 ? ERROR : INK_MID}>{String(problemErrors)}</Value>
      </InspectorRow>

      <InspectorSubheader>Flags</InspectorSubheader>
      {DEV_FLAGS.map((flag, i) => (
        <InspectorRow key={flag.key} label={flag.label} labelTitle={flag.key} alignField="end">
          <Switch size="small" checked={flags[i]} inputProps={{ 'aria-label': flag.label }}
            onChange={(e) => {
              writeFlagOn(flag, e.target.checked);
              setFlags((prev) => prev.map((v, j) => (j === i ? e.target.checked : v)));
              setFlagsChanged(true);
            }} />
        </InspectorRow>
      ))}
      <InspectorActionRow>
        <Typography component="span" sx={{ fontSize: FS.micro, color: flagsChanged ? WARN : INK_LOW }}>
          Read at load time
        </Typography>
        {flagsChanged && (
          <Button size="small" variant="text" onClick={() => window.location.reload()}
            sx={{ fontSize: FS.label, textTransform: 'none', py: 0, minHeight: 0 }}>
            Reload
          </Button>
        )}
      </InspectorActionRow>
    </Box>
  );
}
