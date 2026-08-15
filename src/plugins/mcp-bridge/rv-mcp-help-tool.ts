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
import HELP_EDITOR from './help/editor.md?raw';
import HELP_LAYOUT from './help/layout.md?raw';
import HELP_SIMULATION from './help/simulation.md?raw';
import HELP_PLC from './help/plc.md?raw';
import HELP_DES from './help/des.md?raw';
// The kinematize topic serves the customer-facing recipe verbatim — single source,
// no copy in help/. It is the full workflow (perceive → knowledge folder → axes →
// verify → materials) that editor.md only summarizes.
import HELP_KINEMATIZE from '../../../recipes/kinematize-cad-import.md?raw';

const TOPICS: Record<string, { summary: string; content: string }> = {
  editor: {
    summary: 'Asset Editor: kinematize & materialize CAD (open → perceive → act → verify → save)',
    content: HELP_EDITOR,
  },
  kinematize: {
    summary: 'The full CAD-to-kinematic-model recipe: perception, knowledge folder, axes with visual verification, materials — read before kinematizing a raw import',
    content: HELP_KINEMATIZE,
  },
  layout: {
    summary: 'Layout Planner: build connected conveyor lines, snap flow, conveyor heights, scenes',
    content: HELP_LAYOUT,
  },
  simulation: {
    summary: 'HMI runtime debugging: drives, signals, sensors, material flow, logic sequences',
    content: HELP_SIMULATION,
  },
  plc: {
    summary: 'Virtual PLC: deploy and run IEC 61131-3 Structured Text (internal builds)',
    content: HELP_PLC,
  },
  des: {
    summary: 'Discrete-event simulation: status, bottlenecks, stepping, modes',
    content: HELP_DES,
  },
};

export class McpHelpTool {
  @McpTool('Get the deep how-to guide for a workflow domain. Topics: editor (kinematize/materialize CAD tool reference), kinematize (the full CAD-to-kinematic-model recipe incl. perception and verification), layout (build conveyor lines, heights), simulation (debugging drives/signals/flow), plc, des. Call without topic to list them. Read the matching guide BEFORE starting a multi-step workflow.', { readOnly: true })
  async webHelp(
    @McpParam('topic', 'editor | kinematize | layout | simulation | plc | des (omit to list topics).', 'string', false) topic: string,
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
