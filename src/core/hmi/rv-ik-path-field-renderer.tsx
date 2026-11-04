// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-ik-path-field-renderer.tsx — Custom inspector renderer for IKPath.Path.
 *
 * Shows the path's waypoints as a reusable ReorderableList: click a row to
 * select that IKTarget (which also triggers the 3D path visualizer), and reorder
 * with the up/down buttons. Reordering updates the runtime path order
 * through the shared scene commands; the asset editor keeps its field-op route.
 *
 * Below the list sits the robot program export (plan-773 F19): pick a vendor,
 * press Export, get the file(s) in the browser's downloads. It is a VIEW of the
 * `ik.program.export` command — the same command `web_robot_program_export`
 * dispatches — so the button has no export logic of its own, and the licence
 * gate (E3), the F21 forward-kinematics check and the E9 refusals cannot be
 * reached from one caller and skipped by the other.
 *
 * Self-registers with the fieldRendererRegistry on import.
 */

import { useCallback, useState, useEffect, useSyncExternalStore } from 'react';
import { Box, Button, Typography } from '@mui/material';
import { ReorderableList, type ReorderableListItem } from './ReorderableList';
import { fieldRendererRegistry, type FieldRendererProps } from './rv-field-renderer-registry';
import { persistFieldOp } from './scene/scene-field-ops';
import { getActivePersistenceTarget } from './rv-edit-target';
import { commandRegistry } from './rv-command-registry';
import { EnumEditor } from './rv-field-editors';
import { InspectorRow } from './rv-inspector-row';
import { ERROR, FS, INK_LOW, WARN } from './shared-sx';
import type { ComponentRef } from '../engine/rv-node-registry';
import { isComponentReference, storedReferenceLabel, storedReferenceValue } from '../engine/rv-node-path-rewrite.mjs';
import type { RVIKPath } from '../engine/rv-ik-path';
import { EMPTY_SNAPSHOT } from '../engine/rv-selection-manager';

function lastSeg(p: string): string {
  const i = p.lastIndexOf('/');
  return i >= 0 ? p.slice(i + 1) : p;
}

function isRef(v: unknown): v is ComponentRef {
  // plan-769 Phase 3: THE guard — every stored form (path, address, kept path).
  return isComponentReference(v);
}

function IKPathTargetsRenderer({ value, fieldName, nodePath, viewer }: FieldRendererProps) {
  const initial = Array.isArray(value) ? (value as unknown[]).filter(isRef) : [];
  const [editStatus, setEditStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [order, setOrder] = useState<ComponentRef[]>(initial);

  // Re-sync when the underlying field changes (e.g. model reload).
  useEffect(() => {
    setOrder(Array.isArray(value) ? (value as unknown[]).filter(isRef) : []);
  }, [value]);

  // React to selection changes so the matching row highlights.
  const selection = useSyncExternalStore(
    viewer ? viewer.selectionManager.subscribe : noopSubscribe,
    viewer ? viewer.selectionManager.getSnapshot : emptySnapshot,
  );
  const primaryPath = selection.primaryPath;

  const registry = viewer?.registry ?? null;

  // Resolve each ref to its current node path (survives Three.js dedup renames),
  // so selection highlight + click selection use the registered path.
  // plan-769 Phase 3: an address-form ref (a web-saved file) is read by its owner's
  // document — its label stands in when nothing answers.
  const ownerNode = registry?.getNode(nodePath) ?? null;
  const resolved = order.map((ref) => {
    const written = ref.path ?? storedReferenceLabel(ref) ?? '';
    const node = typeof ref.path === 'string'
      ? (registry?.getNode(ref.path) ?? null)
      : (registry && ownerNode ? registry.storedNode(ownerNode, storedReferenceValue(ref)) : null);
    const cur = node ? (registry?.getPathForNode(node) ?? written) : written;
    return { ref, curPath: cur };
  });

  const items: ReorderableListItem[] = resolved.map((r) => ({ id: r.curPath, label: lastSeg(r.curPath) }));

  const handleSelect = (i: number) => {
    const cur = resolved[i]?.curPath;
    if (cur && viewer) viewer.selectionManager.select(cur);
  };

  // Load the same command family as MCP only when an author changes the list.
  const executeEdit = async (id: string, args: Record<string, unknown>): Promise<boolean> => {
    if (!viewer || busy) return false;
    setBusy(true);
    try {
      const mod = await import('../../plugins/mcp-bridge/rv-mcp-robot-tools');
      mod.ensureIkCommandsRegistered();
      const result = await commandRegistry.execute(id, args, { origin: 'ui', viewer });
      setEditStatus(result.ok ? '' : result.reason);
      return result.ok;
    } catch (error) {
      setEditStatus(`The waypoint edit failed: ${String(error)}. Inspect the path and retry.`);
      return false;
    } finally { setBusy(false); }
  };

  const handleReorder = async (from: number, to: number) => {
    if (busy) return;
    if (getActivePersistenceTarget() !== 'asset') {
      if (!await executeEdit('ik.target.reorder', { pathPath: nodePath, fromIndex: from, toIndex: to })) return;
      const next = [...order]; const [m] = next.splice(from, 1); next.splice(to, 0, m); setOrder(next);
      return;
    }
    const next = [...order];
    const [m] = next.splice(from, 1);
    next.splice(to, 0, m);
    setOrder(next);
    registry?.getByPath<RVIKPath>('IKPath', nodePath)?.reorderTargets(from, to);
    // Persist the new order to the GLB (rewrite IKPath.Path as a setField op).
    persistFieldOp(nodePath, 'IKPath', 'Path', next, order);
  };

  const handleRemove = async (i: number) => {
    if (busy) return;
    if (getActivePersistenceTarget() !== 'asset') {
      if (!await executeEdit('ik.target.remove', { pathPath: nodePath, index: i })) return;
      setOrder(order.filter((_ref, index) => index !== i));
      return;
    }
    const next = [...order];
    next.splice(i, 1);
    setOrder(next);
    registry?.getByPath<RVIKPath>('IKPath', nodePath)?.removeTarget(i);
    // Persist the shortened path to the GLB.
    persistFieldOp(nodePath, 'IKPath', 'Path', next, order);
  };

  return (
    <>
      <ReorderableList
        title={fieldName}
        items={items}
        onReorder={handleReorder}
        onSelect={handleSelect}
        onRemove={(i) => handleRemove(i)}
        selectedId={primaryPath}
        emptyText="No targets"
      />
      {editStatus && <Typography role="status" sx={{ fontSize: FS.micro, color: ERROR, px: 1 }}>{editStatus}</Typography>}
      <RobotProgramExportRow nodePath={nodePath} viewer={viewer} waypoints={items.length} />
    </>
  );
}

// ── Robot program export (plan-773 F19) ──────────────────────────────────

/** One vendor as the catalogue describes it, without loading its formatter. */
interface VendorChoice { id: string; displayName: string }

/** What the last export said — a sentence, never a silent nothing. */
type ExportStatus =
  | { kind: 'idle' }
  | { kind: 'busy' }
  | { kind: 'done'; text: string; warnings: number }
  | { kind: 'refused'; text: string };

/**
 * Vendor picker + Export button under the waypoint list.
 *
 * The vendor CATALOGUE is loaded lazily on first render of this row
 * (`rv-robot-vendors.ts` carries metadata only — no formatter), and the
 * formatter itself only when the button is pressed. Nothing of
 * `src/core/robot-program/` is in the default load (plan-773 §2.5).
 */
function RobotProgramExportRow({ nodePath, viewer, waypoints }: {
  nodePath: string; viewer: FieldRendererProps['viewer']; waypoints: number;
}) {
  const [vendors, setVendors] = useState<VendorChoice[]>([]);
  const [vendor, setVendor] = useState('');
  const [status, setStatus] = useState<ExportStatus>({ kind: 'idle' });

  useEffect(() => {
    let alive = true;
    void import('../robot-program/rv-robot-vendors').then((m) => {
      if (!alive) return;
      const list = Object.values(m.ROBOT_VENDORS).map((v) => ({ id: v.id, displayName: v.displayName }));
      setVendors(list);
      setVendor((cur) => cur || (list[0]?.id ?? ''));
    }).catch(() => { /* the row simply stays empty — nothing to export with */ });
    return () => { alive = false; };
  }, []);

  const onExport = useCallback(async () => {
    if (!viewer || !vendor) return;
    setStatus({ kind: 'busy' });
    // The command lives with the `web_robot_*` family; loading it here is what
    // makes this button and the MCP tool ONE implementation.
    const mod = await import('../../plugins/mcp-bridge/rv-mcp-robot-tools');
    mod.ensureIkCommandsRegistered();
    const res = await commandRegistry.execute<Record<string, unknown>>(
      mod.IK_PROGRAM_EXPORT_COMMAND,
      { vendor, pathPath: nodePath, download: true },
      { origin: 'ui', viewer },
    );
    if (!res.ok) { setStatus({ kind: 'refused', text: res.reason }); return; }
    const v = res.value;
    const refusal = v['refusal'] as { message?: string } | undefined;
    if (v['ok'] !== true) {
      setStatus({ kind: 'refused', text: refusal?.message ?? String(v['error'] ?? 'The export was refused.') });
      return;
    }
    const files = (v['files'] as { fileName: string }[] | undefined) ?? [];
    const warnings = ((v['warnings'] as unknown[] | undefined) ?? []).length;
    setStatus({
      kind: 'done',
      text: files.length === 0 ? 'Nothing was produced.' : `Downloaded ${files.map((f) => f.fileName).join(', ')}`,
      warnings,
    });
  }, [nodePath, vendor, viewer, waypoints]);

  if (vendors.length === 0) return null;

  return (
    <Box sx={{ mt: 0.5 }}>
      <InspectorRow label="Robot program">
        <EnumEditor
          value={vendor}
          onChange={setVendor}
          options={vendors.map((v) => v.id)}
          ariaLabel="Robot program vendor"
        />
      </InspectorRow>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1, py: 0.5 }}>
        <Button
          size="small"
          variant="outlined"
          disabled={status.kind === 'busy' || waypoints === 0 || !vendor}
          onClick={() => { void onExport(); }}
          sx={{ fontSize: FS.label, py: 0, minWidth: 0 }}
        >
          {status.kind === 'busy' ? 'Exporting…' : 'Export'}
        </Button>
        <Typography sx={{ fontSize: FS.micro, color: INK_LOW }}>
          {waypoints === 0 ? 'No waypoints to export' : 'Copy-paste template, not a ready-to-run program'}
        </Typography>
      </Box>
      {status.kind === 'refused' && (
        <Typography sx={{ fontSize: FS.micro, color: ERROR, px: 1, pb: 0.5 }}>{status.text}</Typography>
      )}
      {status.kind === 'done' && (
        <Typography sx={{ fontSize: FS.micro, color: status.warnings > 0 ? WARN : INK_LOW, px: 1, pb: 0.5 }}>
          {status.text}
          {status.warnings > 0 && ` · ${status.warnings} warning${status.warnings === 1 ? '' : 's'} (see web_robot_program_export for the text)`}
        </Typography>
      )}
    </Box>
  );
}

// Stable no-op store fns for when viewer is null (keeps hook order stable).
const noopSubscribe = () => () => {};
const emptySnapshot = () => EMPTY_SNAPSHOT;

// ── Self-registration ──
fieldRendererRegistry.register({
  componentType: 'IKPath',
  fieldName: 'Path',
  component: IKPathTargetsRenderer,
});
