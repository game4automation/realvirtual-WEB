// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-signal-automap-tools — `web_signal_automap` (plan-545): match the loaded
 * model's PLC signals against an S7 or PLCSIM Advanced interface of the connected
 * CONNECT gateway, and optionally write the mappable ones into it.
 *
 * Same report as the ConnectPanel's auto-map strip (both call
 * `checkAutoMap` / `applyAutoMap` in connect-store). Declared `readOnly: false`
 * because `mode: "apply"` writes the interface config; CONNECT's write gate
 * therefore fences the whole tool, a check included.
 *
 * Delegate class of McpBridgePlugin (see rv-mcp-instances.ts).
 */

import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import {
  applyAutoMap,
  autoMapProtocolOf,
  checkAutoMap,
  fetchInterfaces,
  getConnectSnapshot,
  getSignalSchema,
  isModelManagedInterfaceType,
} from '../../core/hmi/connect-store';
import { collectModelPlcSignals, summariseReport } from '../../core/import/rv-plc-automap';
import {
  RECONCILE_CATEGORIES,
  reconcileSignals,
  UNSUPPORTED_TYPE_HINT,
  type ReconcileCategory,
  type ReconcileEntry,
  type ReconcileReport,
} from '../../core/import/rv-signal-reconcile';

/** Entries per category before the payload says "+N more" — the report is a summary, not a dump. */
const RECONCILE_NAME_CAP = 50;

/** One interface's report, compacted for a tool payload. */
function summariseReconcile(report: ReconcileReport): Record<string, unknown> {
  const categories: Partial<Record<ReconcileCategory, unknown>> = {};
  for (const category of RECONCILE_CATEGORIES) {
    const rows = report.entries.filter((e) => e.category === category);
    if (rows.length === 0) continue;
    categories[category] = {
      count: rows.length,
      names: rows.slice(0, RECONCILE_NAME_CAP).map(describe),
      more: Math.max(0, rows.length - RECONCILE_NAME_CAP),
    };
  }
  return {
    interfaceId: report.interfaceId,
    interfaceType: report.interfaceType,
    total: report.entries.length,
    counts: report.counts,
    categories,
  };
}

/** `name`, plus whatever makes the row actionable (the other spelling, the topic, the hint). */
function describe(entry: ReconcileEntry): string {
  const parts: string[] = [entry.name];
  if (entry.slot?.topic) parts.push(`topic ${entry.slot.topic}`);
  if (entry.suggestion === UNSUPPORTED_TYPE_HINT) parts.push(UNSUPPORTED_TYPE_HINT);
  else if (entry.suggestion) parts.push(`model: ${entry.suggestion}`);
  if (entry.category === 'type-mismatch') {
    parts.push(`model ${entry.modelType ?? '?'}/${entry.modelDataType ?? '?'} vs `
      + `plc ${entry.slot?.type ?? '?'}/${entry.slot?.dataType ?? '?'}`);
  }
  return parts.join(' · ');
}

export class McpSignalAutoMapTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  @McpTool('PLC auto-map: match the model PLC signals (address = comment prefix "<address> · <text>") with a CONNECT S7 / PlcSimAdvanced interface. check (default) reports counts and names per category; apply adds/updates the mappable signals, then re-checks. Never removes signals or changes allowWebToPlc.', { readOnly: false })
  async webSignalAutomap(
    @McpParam('interfaceId', 'S7 / PlcSimAdvanced interface id; optional when there is only one', 'string', false) interfaceId?: string,
    @McpParam('mode', 'check | apply', 'string', false) mode?: string,
  ): Promise<string> {
    const viewer = this.getViewer();
    if (!viewer) return JSON.stringify({ error: 'No viewer' });
    const snap = getConnectSnapshot();
    if (snap.state !== 'connected') {
      return JSON.stringify({ error: 'Not connected to a CONNECT gateway — connect in the CONNECT panel first.' });
    }
    const wanted = (mode ?? 'check').trim().toLowerCase() || 'check';
    if (wanted !== 'check' && wanted !== 'apply') {
      return JSON.stringify({ error: `Unknown mode "${mode}" — use check or apply` });
    }

    await fetchInterfaces();
    const candidates = getConnectSnapshot().interfaces.filter((i) => autoMapProtocolOf(i.type) !== null);
    let id = interfaceId?.trim();
    if (!id) {
      if (candidates.length !== 1) {
        return JSON.stringify({
          error: candidates.length === 0
            ? 'No S7 or PlcSimAdvanced interface on the gateway — add one first.'
            : 'Several S7 / PlcSimAdvanced interfaces — pass interfaceId.',
          interfaces: candidates.map((i) => ({ id: i.id, type: i.type })),
        });
      }
      id = candidates[0].id;
    } else if (!candidates.some((i) => i.id === id)) {
      return JSON.stringify({
        error: `Interface "${id}" not found or not of type S7 / PlcSimAdvanced`,
        interfaces: candidates.map((i) => ({ id: i.id, type: i.type })),
      });
    }

    const model = collectModelPlcSignals(viewer);
    try {
      const report = wanted === 'apply' ? await applyAutoMap(id, model) : await checkAutoMap(id, model);
      return JSON.stringify({ mode: wanted, ...summariseReport(report, 100) });
    } catch (err) {
      return JSON.stringify({ error: err instanceof Error ? err.message : String(err) });
    }
  }

  @McpTool('Reconcile report: model PLC signals vs CONNECT interfaces per category (mapped, name-variant = a quoting variant and NOT coupled, missing-in-plc, plc-only, type-mismatch, no-address). Writes nothing.', { readOnly: true })
  async webSignalReconcile(
    @McpParam('interfaceId', 'One interface id; omit = all', 'string', false) interfaceId?: string,
  ): Promise<string> {
    const viewer = this.getViewer();
    if (!viewer) return JSON.stringify({ error: 'No viewer' });
    const snap = getConnectSnapshot();
    if (snap.state !== 'connected') {
      return JSON.stringify({ error: 'Not connected to a CONNECT gateway — connect in the CONNECT panel first.' });
    }
    const id = interfaceId?.trim();
    // Model-managed interfaces (FMI) are provisioned FROM the model, so a report about them would
    // only restate it (same rule as `reconcileInterfaces` in the store).
    const candidates = snap.interfaces.filter((i) => !isModelManagedInterfaceType(i.type));
    const wanted = id ? candidates.filter((i) => i.id === id) : candidates;
    if (wanted.length === 0) {
      return JSON.stringify({
        error: id ? `Interface "${id}" not found` : 'No CONNECT interface to reconcile',
        interfaces: candidates.map((i) => ({ id: i.id, type: i.type })),
      });
    }
    const model = collectModelPlcSignals(viewer);
    return JSON.stringify({
      modelSignals: model.length,
      interfaces: wanted.map((iface) => summariseReconcile(
        reconcileSignals(model, iface, getSignalSchema(iface.type)))),
    });
  }
}
