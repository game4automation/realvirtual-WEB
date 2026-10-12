// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-sim-mode-tool — `web_sim_mode` (plan-539 F15): read or switch the
 * Simulation / PLC mode of the loaded model.
 *
 * Simulation = the viewer runs disconnected, so the model's virtual PLC
 * (logic roots with `Active: Disconnected`) drives the plant; PLC = connected,
 * a real PLC owns the outputs. A switch also writes `StartMode` into the
 * model's `ConnectionMode` component (the next document save keeps it). While
 * a live industrial interface is connected the mode is "PLC (interface)" and a
 * switch is refused.
 *
 * Delegate class of McpBridgePlugin (see rv-mcp-instances.ts).
 */

import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { connectionModeLabel } from '../../core/engine/rv-connection-mode';

export class McpSimModeTool {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  @McpTool('Simulation / PLC mode: Simulation runs the virtual PLC (Active Disconnected roots), PLC leaves the outputs to a real PLC. Omit mode to read. A set writes ConnectionMode.StartMode (saved with the document); refused while an interface writes model outputs (takeover).', { readOnly: false })
  async webSimMode(
    @McpParam('mode', 'Simulation | PLC; omit to read', 'string', false) mode?: string,
  ): Promise<string> {
    const viewer = this.getViewer();
    const controller = viewer?.connectionMode;
    if (!controller) return JSON.stringify({ error: 'No viewer' });
    if (mode === undefined || mode === null || mode === '') {
      const s = controller.state;
      return JSON.stringify({ ...s, label: connectionModeLabel(s) });
    }
    const wanted = String(mode).trim().toLowerCase();
    if (wanted !== 'simulation' && wanted !== 'plc') {
      return JSON.stringify({ error: `Unknown mode "${mode}" — use Simulation or PLC` });
    }
    const r = controller.setMode(wanted === 'plc' ? 'PLC' : 'Simulation');
    if ('error' in r) return JSON.stringify({ ...r, ...controller.state });
    return JSON.stringify({ ...r, label: connectionModeLabel(r) });
  }
}
