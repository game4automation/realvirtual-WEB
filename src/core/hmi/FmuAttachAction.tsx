// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * FmuAttachAction — the HMI half of the `Fmu` component (plan-498 Phase 1).
 *
 * Self-registers (side-effect imported by `App.tsx`, like every other field
 * renderer — without that import none of this exists in production):
 *  - editor context menu at a node: **Attach FMU…** / **Remove FMU**;
 *  - inspector actions on an `Fmu` section: attach / replace and remove;
 *  - the inspector field renderer of `Fmu.FmuEmbed` — the **Runtime** group
 *    (status pill, run line, last error, restart hint, lifecycle actions,
 *    unsupported variables). The package metadata (`FmuEmbedBlock`, "Package
 *    details", collapsed) is rendered at the END of the section by the
 *    `FmuVariables` renderer (`rv-fmu-parameters-field-renderer.tsx`), so the
 *    section reads Runtime → Parameters → Package details (plan-510);
 *  - the `fmu` tooltip (model + state);
 *  - (Phase 3) the lifecycle actions, live with the state: **Trust & start**
 *    (`needs-trust`), **Stop** (this tab holds a lease) and **Re-provision**
 *    (CONNECT is the transport) — they call the provisioning plugin
 *    (`fmu-provisioning-plugin.ts`);
 *  - (plan-502) the run line (`startGeneration`, `simTime` from CONNECT's
 *    `/status`) and "Restarting" while a restart is under way.
 *
 * Every row is an `InspectorRow` and every group heading an
 * `InspectorSubheader` (plan-510): the values sit on the same column as in
 * every other component section. The state itself is ALSO shown in the
 * section header (`getPrimaryDisplayValue` / `getSignalHeaderColor`).
 *
 * The attach flow: file picker (.fmu) → LAZY `readModelDescription` (the
 * `fflate` + `fast-xml-parser` chunk is fetched only here) → SHA-256 →
 * `attachFmu` (the document op, `rv-fmu-ops.ts`). A refusal lands in the
 * Problems panel as `fmu-attach-refused`.
 */

import { useState, useSyncExternalStore } from 'react';
import { Box, Button, Chip, Tooltip, Typography } from '@mui/material';
import type { Object3D } from 'three';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { componentActionRegistry } from './rv-component-action-registry';
import { contextMenuStore, type ContextMenuTarget } from './context-menu-store';
import { tooltipRegistry, type TooltipContentProps } from './tooltip/tooltip-registry';
import type { TooltipData } from './tooltip/tooltip-store';
import { reportProblem, clearProblem } from './problems-store';
import { getActiveAssetContext } from '../editor/active-asset-store';
import { attachFmu, detachFmu, type FmuPackage } from '../ops/rv-fmu-ops';
import { isFmuComponentKey } from '../engine/rv-binary-resources';
import { fmuOf, subscribeFmuInstances, getFmuInstances, FMU_STATE_COLORS, type FmuState, type RVFmu } from '../engine/rv-fmu';
import { getFmuProvisioning } from '../../plugins/fmu-provisioning-plugin';
import { InspectorRow } from './rv-inspector-row';
import { DetailsDisclosure, InspectorActionRow, InspectorSubheader, inspectorActionButtonSx } from './rv-inspector-blocks';
import { formatDecimal } from './rv-number-format';
import { FS, INK_HIGH, INK_LOW, INK_MID, MONO } from './shared-sx';

// ── Constants ─────────────────────────────────────────────────────────────

export const FMU_CONTEXT_MENU_ID = 'fmu-attach';
export const FMU_ATTACH_LABEL = 'Attach FMU…';
export const FMU_REPLACE_LABEL = 'Replace FMU…';
export const FMU_DETACH_LABEL = 'Remove FMU';
const ATTACH_REFUSED_CODE = 'fmu-attach-refused';

/** State → chip colour + label (ISA-101 calm: only errors shout). */
export const FMU_STATE_STYLE: Record<FmuState, { color: string; label: string }> = {
  standalone:    { color: FMU_STATE_COLORS.standalone, label: 'standalone — needs CONNECT' },
  unsupported:   { color: FMU_STATE_COLORS.unsupported, label: 'unsupported' },
  idle:          { color: FMU_STATE_COLORS.idle, label: 'idle' },
  uploading:     { color: FMU_STATE_COLORS.uploading, label: 'uploading' },
  'needs-trust': { color: FMU_STATE_COLORS['needs-trust'], label: 'needs trust' },
  starting:      { color: FMU_STATE_COLORS.starting, label: 'starting' },
  running:       { color: FMU_STATE_COLORS.running, label: 'running · CONNECT' },
  error:         { color: FMU_STATE_COLORS.error, label: 'error' },
};

export const FMU_TRUST_START_LABEL = 'Trust & start';
export const FMU_STOP_LABEL = 'Stop';
export const FMU_REPROVISION_LABEL = 'Re-provision';
/** plan-502 — shown while a restart waits for the next `startGeneration`. */
export const FMU_RESTARTING_LABEL = 'Restarting (start values changed)';
/** plan-510 — the group headings of the FMU section. */
export const FMU_RUNTIME_TITLE = 'Runtime';
export const FMU_PACKAGE_DETAILS_TITLE = 'Package details';

// ── The attach flow ───────────────────────────────────────────────────────

/** Let the user choose one `.fmu`. Resolves null on cancel. */
export function pickFmuFile(): Promise<File | null> {
  return pickLocalFile('.fmu');
}

/**
 * Let the user choose one local file matching `accept` (an `<input accept>`
 * value, e.g. `.aasx`). Resolves null on cancel. Shared by the FMU attach and
 * the AASLink "Import AASX…" action (plan-596).
 */
export function pickLocalFile(accept: string): Promise<File | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.style.display = 'none';
    let settled = false;
    const finish = (file: File | null): void => {
      if (settled) return;
      settled = true;
      input.remove();
      resolve(file);
    };
    input.addEventListener('change', () => finish(input.files?.[0] ?? null));
    input.addEventListener('cancel', () => finish(null));
    document.body.appendChild(input);
    input.click();
  });
}

/** Read and parse a package — the ONE place the lazy parser chunk is loaded. */
export async function readFmuPackage(file: Blob, fileName: string): Promise<FmuPackage> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const { readModelDescription, sha256OfPackage } = await import('../engine/rv-fmu-model-description');
  const [description, sha256] = await Promise.all([readModelDescription(bytes), sha256OfPackage(bytes)]);
  return { fileName, sha256, bytes, description };
}

function refusalId(nodePath: string): string {
  return `${ATTACH_REFUSED_CODE}:${nodePath}`;
}

/**
 * Attach a `.fmu` to the node at `nodePath` of the OPEN editor document.
 * `file` omitted → file picker. Returns true when the op ran.
 */
export async function runAttachFmu(nodePath: string, file?: File | null): Promise<boolean> {
  const active = getActiveAssetContext();
  if (!active) return false;
  const chosen = file === undefined ? await pickFmuFile() : file;
  if (!chosen) return false;
  try {
    const pkg = await readFmuPackage(chosen, chosen.name);
    await attachFmu(active.doc, nodePath, pkg);
    clearProblem(refusalId(nodePath));
    return true;
  } catch (e) {
    const message = (e as Error)?.message ?? String(e);
    console.warn(`[fmu] attach refused for ${nodePath}:`, e);
    reportProblem({
      id: refusalId(nodePath),
      severity: 'warning',
      code: ATTACH_REFUSED_CODE,
      title: `FMU could not be attached: ${chosen.name}`,
      detail: message,
      nodePath,
    });
    return false;
  }
}

/** Remove the FMU of the node at `nodePath` (open editor document). */
export async function runDetachFmu(nodePath: string, componentType?: string): Promise<boolean> {
  const active = getActiveAssetContext();
  if (!active) return false;
  return detachFmu(active.doc, nodePath, componentType);
}

function nodeHasFmu(node: Object3D | null | undefined): boolean {
  const rv = node?.userData?.realvirtual as Record<string, unknown> | undefined;
  return !!rv && Object.keys(rv).some(isFmuComponentKey);
}

/** Editing is possible: an editor document is open on the same viewer tree. */
function editorOpen(): boolean {
  return getActiveAssetContext() !== null;
}

// ── Live instance hook ────────────────────────────────────────────────────

function useFmuInstances(): readonly RVFmu[] {
  return useSyncExternalStore(subscribeFmuInstances, getFmuInstances, getFmuInstances);
}

// ── Small value cells ─────────────────────────────────────────────────────

const valueSx = { fontSize: FS.label, color: INK_HIGH, minWidth: 0 } as const;
/** A message in the value column: wraps, never scrolls sideways. */
const messageSx = { fontSize: FS.label, color: INK_MID, minWidth: 0, whiteSpace: 'normal', overflowWrap: 'anywhere' } as const;

/** `<first 8>…<last 4>` of a long id (SHA-256, GUID); short ids unchanged. */
export function shortId(id: string): string {
  return id.length > 14 ? `${id.slice(0, 8)}…${id.slice(-4)}` : id;
}

/** A shortened value; a click copies the FULL value, a tooltip confirms. */
function CopyValue({ full, testId }: { full: string; testId?: string }) {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    try { void navigator.clipboard?.writeText(full); } catch { /* clipboard unavailable */ }
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1200);
  };
  return (
    <Tooltip title={copied ? 'Copied' : `${full} — click to copy`} placement="top">
      <Typography
        data-testid={testId}
        data-full={full}
        role="button"
        tabIndex={0}
        onClick={copy}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); copy(); } }}
        sx={{ ...valueSx, fontFamily: MONO, cursor: 'copy', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
      >
        {shortId(full)}
      </Typography>
    </Tooltip>
  );
}

// ── Runtime group (fmu-status) ────────────────────────────────────────────

/** Runtime rows: state pill, last error, restart hint, run line, lifecycle actions, unsupported variables. */
export function FmuStatusBlock({ fmu }: { fmu: RVFmu | null }) {
  useFmuInstances(); // re-render on state changes
  if (!fmu) {
    return (
      <Box data-testid="fmu-status">
        <InspectorRow label="Status" labelColor={INK_LOW}>
          <Typography sx={{ fontSize: FS.label, color: INK_LOW }}>FMU not initialised</Typography>
        </InspectorRow>
      </Box>
    );
  }
  const style = FMU_STATE_STYLE[fmu.state];
  return (
    <Box data-testid="fmu-status">
      <InspectorRow label="Status" labelColor={INK_LOW} alignField="stretch">
        <Tooltip title={fmu.lastError ?? ''} disableHoverListener={!fmu.lastError}>
          <Chip
            size="small"
            data-testid="fmu-state-chip"
            label={style.label}
            sx={{ height: 18, fontSize: FS.micro, color: style.color, border: `1px solid ${style.color}`, bgcolor: 'transparent', maxWidth: '100%' }}
          />
        </Tooltip>
      </InspectorRow>
      {fmu.lastError && (
        <InspectorRow label="" py={0.25}>
          <Typography data-testid="fmu-last-error" sx={messageSx}>{fmu.lastError}</Typography>
        </InspectorRow>
      )}
      {fmu.expectedGeneration !== undefined && (
        <InspectorRow label="" py={0.25}>
          <Typography data-testid="fmu-restarting" sx={{ ...messageSx, color: FMU_STATE_COLORS.starting }}>
            {FMU_RESTARTING_LABEL}
          </Typography>
        </InspectorRow>
      )}
      {(fmu.startGeneration !== undefined || fmu.simTime !== undefined) && (
        <InspectorRow label="Run" labelColor={INK_LOW}>
          <Typography data-testid="fmu-run-info" sx={{ ...valueSx, color: INK_MID, fontFamily: MONO, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {`start #${fmu.startGeneration ?? '—'} · t = ${fmu.simTime !== undefined ? formatDecimal(fmu.simTime, 2) : '—'} s`}
          </Typography>
        </InspectorRow>
      )}
      <FmuLifecycleButtons fmu={fmu} />
      {fmu.unsupportedVariables.length > 0 && (
        <InspectorRow label="Unsupported" labelColor={INK_LOW} py={0.25}>
          <Typography data-testid="fmu-unsupported" sx={messageSx}>
            {fmu.unsupportedVariables.join(', ')}
          </Typography>
        </InspectorRow>
      )}
    </Box>
  );
}

// ── Lifecycle actions (Phase 3) ───────────────────────────────────────────

/** Which lifecycle actions an instance offers right now. */
export function fmuLifecycleActions(fmu: RVFmu): { trust: boolean; stop: boolean; reprovision: boolean } {
  const plugin = getFmuProvisioning();
  if (!plugin || !fmu.embed || !fmu.hasPackage) return { trust: false, stop: false, reprovision: false };
  const connect = plugin.transport().kind === 'connect';
  return {
    trust: connect && fmu.state === 'needs-trust',
    stop: !!plugin.leaseOf(fmu),
    reprovision: connect,
  };
}

function FmuLifecycleButtons({ fmu }: { fmu: RVFmu }) {
  const plugin = getFmuProvisioning();
  const actions = fmuLifecycleActions(fmu);
  if (!plugin || (!actions.trust && !actions.stop && !actions.reprovision)) return null;
  return (
    <InspectorActionRow data-testid="fmu-lifecycle">
      {actions.trust && (
        <Button size="small" variant="contained" sx={inspectorActionButtonSx} onClick={() => plugin.trustAndStart(fmu)}>
          {FMU_TRUST_START_LABEL}
        </Button>
      )}
      {actions.stop && (
        <Button size="small" variant="outlined" sx={inspectorActionButtonSx} onClick={() => plugin.stop(fmu)}>
          {FMU_STOP_LABEL}
        </Button>
      )}
      {actions.reprovision && (
        <Button size="small" variant="outlined" sx={inspectorActionButtonSx} onClick={() => plugin.reprovision(fmu)}>
          {FMU_REPROVISION_LABEL}
        </Button>
      )}
    </InspectorActionRow>
  );
}

// ── Package details (fmu-embed) ───────────────────────────────────────────

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${formatDecimal(n / (1024 * 1024), 1)} MB`;
  if (n >= 1024) return `${formatDecimal(n / 1024, 1)} kB`;
  return `${n} B`;
}

/** The SHA of the attached package (`''` when none). */
function packageSha(fmu: RVFmu | null, value: unknown): string {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  return fmu?.embed?.sha256 ?? (typeof raw.sha256 === 'string' ? raw.sha256 : '');
}

/**
 * Package metadata as a collapsed `DetailsDisclosure` ("Package details":
 * Model, GUID, FMI, Package, SHA-256). Null when no package is attached.
 */
export function FmuEmbedBlock({ fmu, value }: { fmu: RVFmu | null; value: unknown }) {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const embed = fmu?.embed;
  const sha = packageSha(fmu, value);
  if (!sha) return null;
  const str = (k: string): string => (typeof raw[k] === 'string' ? (raw[k] as string) : '');
  const model = embed?.modelName || str('modelName') || '—';
  const guid = embed?.guid || str('guid');
  const bytes = embed?.byteLength ?? (typeof raw.byteLength === 'number' ? raw.byteLength : 0);
  const tool = embed?.generationTool ?? (str('generationTool') || undefined);
  return (
    <DetailsDisclosure
      data-testid="fmu-embed"
      title={FMU_PACKAGE_DETAILS_TITLE}
      summary={`${model} · ${formatBytes(bytes)}`}
    >
      <InspectorRow label="Model" labelColor={INK_LOW}>
        <Typography sx={{ ...valueSx, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{model}</Typography>
      </InspectorRow>
      <InspectorRow label="GUID" labelColor={INK_LOW}>
        {guid ? <CopyValue full={guid} testId="fmu-embed-guid" /> : <Typography sx={valueSx}>—</Typography>}
      </InspectorRow>
      <InspectorRow label="FMI" labelColor={INK_LOW}>
        <Typography sx={messageSx}>{`${embed?.fmiVersion ?? (str('fmiVersion') || '2.0')}${tool ? ` · ${tool}` : ''}`}</Typography>
      </InspectorRow>
      <InspectorRow label="Package" labelColor={INK_LOW}>
        <Typography sx={messageSx}>{embed?.fileName || str('fileName') || '—'}</Typography>
      </InspectorRow>
      <InspectorRow label="SHA-256" labelColor={INK_LOW}>
        <CopyValue full={sha} testId="fmu-embed-sha" />
      </InspectorRow>
    </DetailsDisclosure>
  );
}

/** The inspector renderer registered on `Fmu.FmuEmbed`: the Runtime group. */
export function FmuInspectorRenderer({ value, nodePath, viewer }: FieldRendererProps) {
  useFmuInstances();
  const node = viewer?.registry?.getNode(nodePath) ?? null;
  const fmu = fmuOf(node);
  const sha = packageSha(fmu, value);
  return (
    <Box data-testid="fmu-inspector">
      <InspectorSubheader>{FMU_RUNTIME_TITLE}</InspectorSubheader>
      <FmuStatusBlock fmu={fmu} />
      {!sha && (
        <InspectorRow label="" py={0.25}>
          <Typography data-testid="fmu-embed-missing" sx={messageSx}>
            No FMU package attached — use “{FMU_ATTACH_LABEL}”.
          </Typography>
        </InspectorRow>
      )}
    </Box>
  );
}

// ── Tooltip ───────────────────────────────────────────────────────────────

export interface FmuTooltipData extends TooltipData {
  type: 'fmu';
  nodePath: string;
}

export function FmuTooltipContent({ data, viewer }: TooltipContentProps<FmuTooltipData>) {
  useFmuInstances();
  const fmu = fmuOf(viewer?.registry?.getNode(data.nodePath) ?? null);
  if (!fmu) return null;
  const style = FMU_STATE_STYLE[fmu.state];
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 0.25 }}>
      <Typography sx={{ fontSize: FS.body, fontWeight: 600, color: INK_HIGH }}>
        FMU · {fmu.modelName || fmu.node.name}
      </Typography>
      <Typography sx={{ fontSize: FS.label, color: style.color }}>{style.label}</Typography>
      <Typography sx={{ fontSize: FS.label, color: INK_MID }}>{fmu.signalNames.length} signals</Typography>
    </Box>
  );
}

// ── Registrations ─────────────────────────────────────────────────────────

fieldRendererRegistry.register({ componentType: 'Fmu', fieldName: 'FmuEmbed', component: FmuInspectorRenderer });

componentActionRegistry.register('Fmu', [
  {
    id: 'fmu-attach',
    label: (ctx) => (fmuOf(ctx.node)?.embed ? FMU_REPLACE_LABEL : FMU_ATTACH_LABEL),
    tooltip: 'Choose a .fmu (FMI 2.0 Co-Simulation, win64) and attach it to this node',
    order: 10,
    // Package management, not an operation: the section header's ⋮ menu.
    placement: 'menu',
    visible: () => editorOpen(),
    onClick: (ctx) => { void runAttachFmu(ctx.nodePath); },
  },
  // No section "Remove FMU" action: it was the same `removeComponent` as the
  // editor's generic Remove in the ⋮ menu. The context menu keeps its item.
]);

contextMenuStore.register({
  pluginId: FMU_CONTEXT_MENU_ID,
  items: [
    {
      id: 'fmu-attach',
      label: FMU_ATTACH_LABEL,
      order: 400,
      dividerBefore: true,
      condition: (t: ContextMenuTarget) => editorOpen() && !!t.path && !nodeHasFmu(t.node),
      action: (t: ContextMenuTarget) => { void runAttachFmu(t.path); },
    },
    {
      id: 'fmu-detach',
      label: FMU_DETACH_LABEL,
      order: 401,
      danger: true,
      condition: (t: ContextMenuTarget) => editorOpen() && !!t.path && nodeHasFmu(t.node),
      action: (t: ContextMenuTarget) => { void runDetachFmu(t.path); },
    },
  ],
});

tooltipRegistry.register({
  contentType: 'fmu',
  component: FmuTooltipContent as never,
});

tooltipRegistry.registerDataResolver('fmu', (node, viewer) => {
  const path = viewer.registry?.getPathForNode(node) ?? '';
  if (!path || !fmuOf(node)) return null;
  return { type: 'fmu', nodePath: path } as FmuTooltipData;
});
