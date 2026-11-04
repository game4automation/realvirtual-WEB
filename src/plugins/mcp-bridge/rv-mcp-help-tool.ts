// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-mcp-help-tool — progressive-disclosure docs for MCP agents.
 *
 * The always-loaded server instructions (webviewer.mcp.md) stay a compact map;
 * the deep how-to guides live in ./help/*.md and are served on demand
 * through `web_help(topic)` — agents pay for depth only when they need it.
 *
 * Adding a topic = add the md file + one entry in TOPICS. Keep each guide
 * focused (one workflow domain) and reference tools by their exact names.
 *
 * The guides sit next to this file, not under the repo's docs/ folder, and that
 * is deliberate: they are bundled source, not published documentation. While
 * they lived in docs/, Vite served them at /docs/… in dev mode — a path CONNECT
 * reserves for its diagnosis manuals, so the five imports 404'd through the
 * CONNECT dev proxy and the viewer never left its loading screen. CONNECT no
 * longer reserves the path unless something is mounted there; keeping the files
 * out of that namespace means the collision cannot come back.
 */

import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';

// Vite ?raw imports — embedded as strings at build time.
import HELP_ROBOT from './help/robot.md?raw';
import HELP_LAYOUT from './help/layout.md?raw';
import HELP_SIMULATION from './help/simulation.md?raw';
import HELP_PLC from './help/plc.md?raw';
import HELP_DES from './help/des.md?raw';
import HELP_SCRIPTING from './help/scripting.md?raw';
import HELP_OPERATOR_PANEL from './help/operator-panel.md?raw';
import HELP_COMMANDS from './help/commands.md?raw';
import HELP_SOLIDCRAFT from './help/solidcraft.md?raw';
// plan-650 Phase 6: the part-family recipe (lives in help/, so it travels with src/ into every delivery).
import HELP_PARAMETRIC from './help/parametric.md?raw';
// The kinematize topic serves the customer-facing recipe verbatim — single source,
// no copy in help/. It is the full workflow (perceive → knowledge folder → axes →
// verify → materials) that editor.md only summarizes.
import HELP_KINEMATIZE from '../../../recipes/kinematize-cad-import.md?raw';

const TOPICS: Record<string, { summary: string; content: string }> = {
  // plan-641: the reduced command interface and the macro recorder — one guide, two names.
  commands: {
    summary: 'Model changes as commands (web_commands → web_execute / web_batch → check → save), reasons (_reason/_source/_confidence), recording and replaying macros',
    content: HELP_COMMANDS,
  },
  macros: {
    summary: 'Recording and replaying macros of command calls (same guide as commands)',
    content: HELP_COMMANDS,
  },
  editor: {
    summary: 'Asset Editor: preparing a model from raw CAD (same guide as kinematize)',
    content: HELP_KINEMATIZE,
  },
  kinematize: {
    summary: 'The full CAD-to-kinematic-model recipe: perception, knowledge folder, axes with visual verification, materials — read before kinematizing a raw import',
    content: HELP_KINEMATIZE,
  },
  layout: {
    summary: 'Layout Planner: build connected conveyor lines, snap flow, conveyor heights, scenes',
    content: HELP_LAYOUT,
  },
  robot: { summary: 'Rig, author, check, run and export robot paths; TCP moves and waypoint grips', content: HELP_ROBOT },
  simulation: {
    summary: 'HMI runtime debugging: drives, signals, sensors, material flow, logic sequences',
    content: HELP_SIMULATION,
  },
  plc: {
    summary: 'Virtual PLC: deploy and run IEC 61131-3 Structured Text (internal builds)',
    content: HELP_PLC,
  },
  scripting: {
    summary: 'Component scripts: setup, self API, declared state, timers, randomness and code checks',
    content: HELP_SCRIPTING,
  },
  des: {
    summary: 'Discrete-event simulation: status, bottlenecks, stepping, modes',
    content: HELP_DES,
  },
  'operator-panel': {
    summary: 'Operator panel windows as JSON (WebOperatorPanel): schema, device types, IEC colour rules, status rules, examples, MCP steps',
    content: HELP_OPERATOR_PANEL,
  },
  solidcraft: {
    summary: 'Modelling CAD live in SolidCraft into the asset editor: sync check, one body per feature (patterns are skipped), colours/materials, recipe for a conical roller curve',
    content: HELP_SOLIDCRAFT,
  },
  parametric: {
    summary: 'Parametric part families: catalogue page → SolidCraft base design (each part once) → rule part generate(values, parts) → define, verify, save, place with own values; rule contract (stretch, bend, snaps), examples rm8110/rm8120/aluprofile',
    content: HELP_PARAMETRIC,
  },
};

/** Register an optional feature guide. Disposal cannot remove a newer registration. */
export function registerHelpTopic(name: string, entry: { summary: string; content: string }): () => void {
  const key = name.trim().toLowerCase();
  if (!key) throw new Error('Help topic name is required');
  const previous = TOPICS[key];
  const value = { ...entry };
  TOPICS[key] = value;
  return () => {
    if (TOPICS[key] !== value) return;
    if (previous) TOPICS[key] = previous;
    else delete TOPICS[key];
  };
}

export class McpHelpTool {
  @McpTool('Get the deep how-to guide for a workflow domain. Topics: robot (rig, paths, check, run, export), commands / macros, editor (kinematize/materialize CAD tool reference), kinematize (the full CAD-to-kinematic-model recipe incl. perception and verification), layout (build conveyor lines, heights), simulation (debugging drives/signals/flow), plc, des, scripting, operator-panel (build an operator panel window as JSON — WebOperatorPanel), solidcraft, parametric (build a parametric part family from a catalogue page). Call without topic to list them. Read the matching guide BEFORE starting a multi-step workflow.', { readOnly: true })
  async webHelp(
    @McpParam('topic', 'robot | commands | macros | editor | kinematize | layout | simulation | plc | des | scripting | operator-panel | solidcraft | parametric (omit to list topics).', 'string', false) topic: string,
  ): Promise<string> {
    const key = (topic || '').trim().toLowerCase();
    const entry = TOPICS[key];
    if (!entry) {
      return JSON.stringify({
        ...(key ? { error: `Unknown topic "${topic}"` } : {}),
        topics: Object.fromEntries(Object.entries(TOPICS).map(([k, v]) => [k, v.summary])),
      });
    }
    return JSON.stringify({ topic: key, guide: entry.content });
  }
}
