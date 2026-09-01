// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-desplc-tools — MCP tools for the two SUBSYSTEM runtimes: the
 * discrete-event simulation kernel (`web_des_*`) and the virtual IEC 61131-3
 * PLC (`web_plc_*`).
 *
 * Delegate class of McpBridgePlugin (multi-instance dispatcher — see
 * rv-mcp-tools.ts). Split out of the plugin by plan-713 Phase 1 as a pure code
 * move, proven against the frozen baseline by `rv-mcp-delegate-split.test.ts`.
 *
 * They share a file, and deliberately do not share a domain: both are optional
 * runtimes that may be absent from a build, both answer "not part of this build"
 * rather than throwing, and both are steered rather than observed. Keeping them
 * out of `McpRuntimeTools` keeps that file about the ONE always-present runtime.
 */

import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { getPlcControl } from '../../core/plc-control';

export class McpDesPlcTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined { return this.getViewer(); }

  // ═══════════════════════════════════════════════════════════════════
  // DES (Discrete Event Simulation) Tools — inspect + drive the event-based
  // material-flow simulation (plan-194). Only live in DES mode (?mode=des or
  // web_mode_set); return a clear hint otherwise.
  // ═══════════════════════════════════════════════════════════════════

  @McpTool('DES status: kernel mode, sub-mode, sim time and processed/pending event counts. The first check for "is the DES simulation running and advancing?" — if pending=0 and nextEventTime is null/Infinity the run has stalled or finished.', { readOnly: true })
  async webDesStatus(): Promise<string> {
    const kernel = this.viewer?.simulationKernel;
    if (!kernel) return JSON.stringify({ error: 'No simulation kernel' });
    const ctl = kernel.desControl?.();
    if (!ctl) {
      return JSON.stringify({ kernelMode: kernel.mode, des: false, hint: 'Not in DES mode — open ?mode=des or call web_mode_set("des").' });
    }
    const stats = ctl.eventStats?.() ?? null;
    return JSON.stringify({
      kernelMode: kernel.mode,
      des: true,
      subMode: ctl.subMode,
      multiplier: ctl.multiplier,
      simTime: ctl.simTime,
      events: stats,
      ffProgress: ctl.ffProgress ?? null,
    });
  }

  @McpTool('DES component states: per material-flow component the load / in-transit / blocked counts and the next/prev wiring. The go-to tool for diagnosing why parts are not flowing (deadlocks, full zones, missing or wrong connections). Pass busyOnly=true to list only components currently holding/transiting/blocking an MU.', { readOnly: true })
  async webDesComponents(
    @McpParam('busyOnly', 'Only list components currently holding/transiting/blocking an MU', 'boolean', false) busyOnly: boolean,
  ): Promise<string> {
    const ctl = this.viewer?.simulationKernel?.desControl?.();
    if (!ctl?.componentStates) return JSON.stringify({ error: 'DES not active — call web_mode_set(\"des\") first.' });
    let states = ctl.componentStates();
    const total = states.length;
    if (busyOnly) states = states.filter(s => s.load > 0 || s.inTransit > 0 || s.blocked > 0);
    return JSON.stringify({ total, shown: states.length, components: states });
  }

  @McpTool('DES per-component statistics: utilization (Working/Setup/Blocked/Empty/Failure %), output/h, current state and totalProcessed — in MATERIAL-FLOW order (sources first, sinks last) — plus aggregate mean utilization and throughput. Use to analyze line balance and where time is lost.', { readOnly: true })
  async webDesStats(): Promise<string> {
    const ctl = this.viewer?.simulationKernel?.desControl?.();
    if (!ctl?.statistics) return JSON.stringify({ error: 'DES not active — call web_mode_set(\"des\") first.' });
    return JSON.stringify(ctl.statistics());
  }

  @McpTool('Identify the DES bottleneck — the constraining component (highest Working%). Upstream of it parts pile up (Blocked); downstream they starve (Empty). Returns the bottleneck, the mean utilization, the throughput and a short diagnosis of how many upstream components are blocked vs downstream starved.', { readOnly: true })
  async webDesBottleneck(): Promise<string> {
    const ctl = this.viewer?.simulationKernel?.desControl?.();
    if (!ctl?.statistics) return JSON.stringify({ error: 'DES not active — call web_mode_set(\"des\") first.' });
    const st = ctl.statistics();
    if (!st.bottleneck) {
      return JSON.stringify({ bottleneck: null, hint: 'No flow components, or nothing has run yet — play the simulation first.' });
    }
    const idx = st.components.findIndex((c) => c.path === st.bottleneck!.path);
    const blockedUpstream = st.components.slice(0, idx).filter((c) => c.blocked > 30).length;
    const starvedDownstream = st.components.slice(idx + 1).filter((c) => c.empty > 50).length;
    return JSON.stringify({
      bottleneck: st.bottleneck,
      meanUtilization: st.meanUtilization,
      throughputPerHour: st.throughputPerHour,
      diagnosis: `'${st.bottleneck.name}' is the bottleneck — working ${st.bottleneck.working}% of the time. `
        + `${blockedUpstream} upstream component(s) are blocked behind it; ${starvedDownstream} downstream component(s) are starved.`,
    });
  }

  @McpTool('Advance the DES simulation by exactly N events (default 1) and return the new status. Use to step through the event queue when diagnosing flow — each step processes one scheduled event (arrival/generate/transfer).', { readOnly: false })
  async webDesStep(
    @McpParam('count', 'Number of events to step (default 1)', 'integer', false) count: number,
  ): Promise<string> {
    const ctl = this.viewer?.simulationKernel?.desControl?.();
    if (!ctl) return JSON.stringify({ error: 'DES not active — call web_mode_set(\"des\") first.' });
    const n = Math.max(1, count || 1);
    let stepped = 0;
    for (let i = 0; i < n; i++) { if (!ctl.step()) break; stepped++; }
    return JSON.stringify({ stepped, events: ctl.eventStats?.() ?? null });
  }

  @McpTool('Set the DES sub-mode: animated (1x real-time), hybrid (Nx), fastforward (max speed), step (manual). Optionally set the hybrid speed multiplier.', { readOnly: false })
  async webDesSetMode(
    @McpParam('subMode', 'animated | hybrid | fastforward | step') subMode: string,
    @McpParam('multiplier', 'Hybrid speed multiplier (>= 1)', 'number', false) multiplier: number,
  ): Promise<string> {
    const ctl = this.viewer?.simulationKernel?.desControl?.();
    if (!ctl) return JSON.stringify({ error: 'DES not active — call web_mode_set(\"des\") first.' });
    const valid = ['animated', 'hybrid', 'fastforward', 'step'];
    if (!valid.includes(subMode)) return JSON.stringify({ error: `Invalid subMode '${subMode}'`, valid });
    ctl.setSubMode(subMode as 'animated' | 'hybrid' | 'fastforward' | 'step');
    if (multiplier !== undefined && multiplier !== null && !Number.isNaN(multiplier)) {
      ctl.setMultiplier(multiplier);
    }
    return JSON.stringify({ subMode: ctl.subMode, multiplier: ctl.multiplier });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Virtual PLC tools — talk to the browser-side IEC 61131-3 soft PLC
  // exclusively through the public PlcControl surface (core/plc-control.ts).
  // The runtime ships only in internal dev builds; when it is absent the
  // tools answer with a clear not-available error.
  // ═══════════════════════════════════════════════════════════════════

  @McpTool('Virtual PLC status: run state (stopped/running/error), scan time in ms, last error, and the online watch values (VAR_EXTERNAL variables plus function-block outputs like tDelay.Q as of the last scan). Returns an error when the PLC runtime is not part of this build.', { readOnly: true })
  async webPlcStatus(): Promise<string> {
    const plc = getPlcControl();
    if (!plc) return JSON.stringify({ error: 'PLC not available in this build' });
    return JSON.stringify({
      state: plc.state,
      scanTimeMs: +plc.scanTimeMs.toFixed(3),
      lastError: plc.lastError,
      watch: Object.fromEntries(plc.watch()),
    });
  }

  @McpTool('Deploy an IEC 61131-3 Structured Text program to the virtual PLC: compile + COLD load (fresh function-block states and memory). Returns all diagnostics (compile errors/warnings + signal-binding warnings); with error diagnostics nothing is loaded and the PLC enters the error state. Deploying never starts scanning — call web_plc_run afterwards.', { readOnly: false })
  async webPlcDeploy(
    @McpParam('code', 'IEC 61131-3 Structured Text source (PROGRAM ... END_PROGRAM)') code: string,
  ): Promise<string> {
    const plc = getPlcControl();
    if (!plc) return JSON.stringify({ error: 'PLC not available in this build' });
    const diagnostics = await plc.deploy(code);
    return JSON.stringify({
      state: plc.state,
      errorCount: diagnostics.filter(d => d.severity === 'error').length,
      warningCount: diagnostics.filter(d => d.severity === 'warning').length,
      diagnostics,
    });
  }

  @McpTool('Start cyclic PLC scanning (one scan per 60 Hz sim tick: input snapshot → program pass → output batch write). After an error state this performs a COLD restart with a fresh sandbox and fresh function-block states.', { readOnly: false })
  async webPlcRun(): Promise<string> {
    const plc = getPlcControl();
    if (!plc) return JSON.stringify({ error: 'PLC not available in this build' });
    await plc.run();
    return JSON.stringify({ state: plc.state, lastError: plc.lastError });
  }

  @McpTool('Stop cyclic PLC scanning (WARM stop — program memory and function-block states are kept; outputs keep their last written values).', { readOnly: false })
  async webPlcStop(): Promise<string> {
    const plc = getPlcControl();
    if (!plc) return JSON.stringify({ error: 'PLC not available in this build' });
    plc.stop();
    return JSON.stringify({ state: plc.state });
  }

}
