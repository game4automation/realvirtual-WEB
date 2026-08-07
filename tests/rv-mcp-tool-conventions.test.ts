// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * MCP tool convention lint — enforces the agent-discoverability rules:
 *
 *  1. Names follow `web_<domain>_<action>` with an approved domain vocabulary
 *     (alphabetical clustering is how agents find tools).
 *  2. Descriptions are verb-first and fit the token budget (<= 110 words).
 *  3. No duplicate names across the delegate classes (also thrown at runtime).
 *  4. Every tool carries an explicit `readOnly` classification (plan-327 AP3).
 *
 * A failing test means a new tool degrades agent discovery — fix the name or
 * description, or (deliberately) extend the domain whitelist below AND the
 * domain table in webviewer.mcp.md.
 */

import { describe, it, expect } from 'vitest';
import { generateToolSchemasMulti } from '../src/core/engine/rv-mcp-tools';
import { McpBridgePlugin } from '../src/plugins/mcp-bridge-plugin';
import { McpViewTools } from '../src/plugins/mcp-bridge/rv-mcp-view-tools';
import { McpObserveTools } from '../src/plugins/mcp-bridge/rv-mcp-observe-tools';
import { McpEditorTools } from '../src/plugins/mcp-bridge/rv-mcp-editor-tools';
import { McpHelpTool } from '../src/plugins/mcp-bridge/rv-mcp-help-tool';

/** Approved domain vocabulary (second name segment). Extend deliberately. */
const DOMAINS = new Set([
  'node', 'component', 'view', 'camera', 'select', 'selection', 'screenshot',
  'drive', 'signal', 'sensor', 'sim', 'transport', 'logic', 'mode',
  'layout', 'library', 'scene', 'editor', 'des', 'plc',
]);

/**
 * Root-level tools allowed without a domain segment. `web_measure` and `web_render` come from
 * McpObserveTools, which was missing from this lint entirely until plan-327 AP3 added the
 * delegate below — four tools were unchecked, and one dead name (`web_find`) survived here for
 * exactly that reason.
 */
const ROOT_TOOLS = new Set([
  'web_status', 'web_logs', 'web_errors', 'web_help', 'web_measure', 'web_render',
]);

const MAX_DESCRIPTION_WORDS = 110;

/**
 * ALL five delegate instances — the same set `McpBridgePlugin._sendDiscover` announces. A missing
 * instance here means its tools are announced to agents but never linted.
 */
function allSchemas() {
  return generateToolSchemasMulti([
    new McpBridgePlugin(),
    new McpViewTools(() => undefined),
    new McpObserveTools(() => undefined),
    new McpEditorTools(() => undefined),
    new McpHelpTool(),
  ]);
}

describe('MCP tool conventions', () => {
  const schemas = allSchemas();

  it('has a meaningful number of tools', () => {
    expect(schemas.length).toBeGreaterThan(50);
  });

  it('every name is web_<domain>_<action> with an approved domain', () => {
    const bad: string[] = [];
    for (const s of schemas) {
      if (ROOT_TOOLS.has(s.name)) continue;
      // web_<domain> alone is the domain's primary action (web_screenshot, web_select).
      const m = /^web_([a-z0-9]+)(?:_[a-z0-9_]+)?$/.exec(s.name);
      if (!m || !DOMAINS.has(m[1])) bad.push(s.name);
    }
    expect(bad, `Names outside the domain vocabulary: ${bad.join(', ')}`).toEqual([]);
  });

  it('web_find stays deleted (renamed to web_node_find)', () => {
    expect(schemas.some((s) => s.name === 'web_find')).toBe(false);
    expect(schemas.some((s) => s.name === 'web_node_find')).toBe(true);
  });

  it('covers every announced delegate, including McpObserveTools', () => {
    const names = new Set(schemas.map((s) => s.name));
    // These four were announced to agents but linted by nothing before plan-327 AP3.
    for (const observed of ['web_measure', 'web_node_shape', 'web_scene_query', 'web_render']) {
      expect(names.has(observed), `${observed} must be covered by this lint`).toBe(true);
    }
    expect(schemas.length).toBe(105);
  });

  // plan-327 AP3 — this is THE drift protection. `annotations.readOnlyHint` is the single
  // classification source: it feeds the write gate and tools/list in both bridges. There is no
  // second list to compare against on purpose (that comparison would be tautological), so the
  // guarantee has to be produced here, where the classification is authored.
  describe('side-effect classification', () => {
    it('every tool is classified explicitly — no implicit defaults', () => {
      const unclassified = schemas
        .filter((s) => s.annotations?.readOnlyHint === undefined)
        .map((s) => s.name);
      expect(
        unclassified,
        `Add { readOnly: true | false } to @McpTool for: ${unclassified.join(', ')}`,
      ).toEqual([]);
    });

    it('read-only means it changes nothing an operator can see', () => {
      const readOnly = new Set(
        schemas.filter((s) => s.annotations?.readOnlyHint === true).map((s) => s.name),
      );

      // Orientation and measurement must stay reachable for a read-only client: without these
      // it cannot obtain a single node path, which is what every other tool takes as input.
      for (const n of ['web_node_find', 'web_node_tree', 'web_help', 'web_status',
        'web_measure', 'web_node_shape', 'web_component_get', 'web_signal_list']) {
        expect(readOnly.has(n), `${n} must be read-only`).toBe(true);
      }

      // Mutations, obviously.
      for (const n of ['web_signal_set_bool', 'web_drive_jog', 'web_sim_reset',
        'web_editor_import_cad', 'web_editor_save', 'web_layout_place', 'web_plc_run']) {
        expect(readOnly.has(n), `${n} must NOT be read-only`).toBe(false);
      }

      // The transient/viewport group stays a write on purpose: it persists nothing, but a
      // watching operator sees the view jump — a surprise on a running plant, not a feature.
      for (const n of ['web_camera_set', 'web_camera_focus', 'web_camera_orbit',
        'web_camera_projection', 'web_view_isolate', 'web_view_pick', 'web_view_gaze',
        'web_select', 'web_select_similar', 'web_view_source_markers']) {
        expect(readOnly.has(n), `${n} is viewport-transient and must be gated as a write`).toBe(false);
      }

      // Reading the camera or the selection changes nothing.
      expect(readOnly.has('web_camera_get')).toBe(true);
      expect(readOnly.has('web_selection_get')).toBe(true);

      // web_node_bounds focuses the camera by default (focus=true) and an MCP annotation is per
      // tool, not per argument — so it cannot be advertised as read-only.
      expect(readOnly.has('web_node_bounds')).toBe(false);
    });
  });

  it('descriptions are verb-first and within the word budget', () => {
    const bad: string[] = [];
    for (const s of schemas) {
      const words = s.description.trim().split(/\s+/);
      const first = words[0] ?? '';
      if (words.length > MAX_DESCRIPTION_WORDS) bad.push(`${s.name}: ${words.length} words`);
      if (!/^[A-Z]/.test(first) || ['The', 'A', 'An', 'This'].includes(first)) {
        bad.push(`${s.name}: not verb-first ("${first}")`);
      }
    }
    expect(bad, bad.join('\n')).toEqual([]);
  });

  it('superseded tools are gone', () => {
    const names = new Set(schemas.map((s) => s.name));
    for (const gone of ['web_component_add', 'web_hierarchy', 'web_place', 'web_move',
      'web_remove', 'web_placement_list', 'web_snap_list', 'web_snap_suggest',
      'web_snap_attach', 'web_set_mode', 'web_set_source_markers', 'web_analyze_object',
      'web_components_by_type', 'web_view_bounds']) {
      expect(names.has(gone), `${gone} should be renamed/removed`).toBe(false);
    }
  });
});
