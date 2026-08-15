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
// The instance list moved to tests/helpers/mcp-schemas.ts with plan-707: three
// tests need it now, and three private copies is how one of them goes stale.
import { allSchemas } from './helpers/mcp-schemas';

/** Approved domain vocabulary (second name segment). Extend deliberately. */
const DOMAINS = new Set([
  'node', 'component', 'view', 'camera', 'select', 'selection', 'screenshot',
  'drive', 'signal', 'sensor', 'sim', 'transport', 'logic', 'mode',
  'layout', 'library', 'scene', 'editor', 'des', 'plc',
  // plan-394. Deliberately NOT folded into `node`: that domain means structural
  // navigation throughout (find/tree/bounds), and a durable note is not that.
  'knowledge',
  // plan-716 Phase 5 — `McpProjectTools` joined the shared instance list, and
  // its two domains came with it. They are genuinely two: a PROJECT decides
  // what project-relative paths resolve against, a MODEL is what is loaded in
  // the viewport, and `web_model_list` is THE one document list the older
  // `web_scene_*` aliases now forward agents to.
  'model', 'project',
]);

/**
 * Root-level tools allowed without a domain segment. `web_measure` and `web_render` come from
 * McpObserveTools, which was missing from this lint entirely until plan-327 AP3 added the
 * delegate below — four tools were unchecked, and one dead name (`web_find`) survived here for
 * exactly that reason.
 */
const ROOT_TOOLS = new Set([
  'web_status', 'web_logs', 'web_errors', 'web_help', 'web_measure', 'web_render',
  // plan-707: state-aware orientation. Root-level like web_status and web_help,
  // because "where am I" is not a question about one domain.
  'web_describe',
  // plan-716 Phase 5: the throttle probe. Root-level for the same reason —
  // "is the tab alive" is not a question about drives, scenes or projects, and
  // it is deliberately the one tool with no imports and no timers.
  'web_ping',
]);

const MAX_DESCRIPTION_WORDS = 110;

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
    // 105 → 111 with the six `web_editor_mechanism_*` tools (plan-404 Phase 5).
    // 111 → 115 with the four `web_signal_*` binding tools (plan-425 Phase 3).
    // 115 → 118 with the three `web_knowledge_*` tools (plan-394 Phase 2).
    // 118 → 119 with `web_describe` (plan-707 Phase 1).
    // 119 → 124 with the five `McpProjectTools` (plan-716 Phase 5): they were
    // ANNOUNCED all along and merely missing from the shared list, so this is a
    // coverage gain, not five new tools.
    // 124 → 136 with plan-706: ten more `web_editor_mechanism_*` (inspect,
    // snap_list, set_anchor_snap, set_axis, add_body, set_mass, set_limits,
    // forces, statics, fix) plus `web_editor_test_start` / `_stop`. Counted from
    // the code after the plan-707 merge, not taken from the plan — 705, 706 and
    // 707 all edit this line, and the second one to land must re-count.
    expect(schemas.length).toBe(137);
  });

  // plan-707 — the instance list is shared now, and the whole point of sharing it
  // is that a delegate cannot be announced, linted and documented from three
  // different lists. This pins the count of that ONE list.
  it('the shared instance list covers every linted delegate', () => {
    const names = new Set(schemas.map((s) => s.name));
    for (const t of ['web_status', 'web_view_pick', 'web_render', 'web_editor_open',
      'web_signal_bind', 'web_knowledge_set', 'web_describe', 'web_help',
      // plan-716 Phase 5 — the announced-but-unlinted delegate. `web_model_list`
      // is THE one document list; leaving it out of this list left it out of
      // the generated reference too, which is where an agent looks for it.
      'web_model_list', 'web_model_open', 'web_project_list', 'web_project_open',
      'web_ping']) {
      expect(names.has(t), `${t} must come from the shared allSchemas() list`).toBe(true);
    }
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
        'web_measure', 'web_node_shape', 'web_component_get', 'web_signal_list',
        // plan-394: reading a stored note observes nothing an operator can see.
        'web_knowledge_get', 'web_knowledge_list',
        // plan-707 F4: web_describe aggregates existing getters and moves
        // neither selection, panels nor camera — unlike web_node_bounds below.
        'web_describe']) {
        expect(readOnly.has(n), `${n} must be read-only`).toBe(true);
      }

      // Mutations, obviously.
      for (const n of ['web_signal_set_bool', 'web_drive_jog', 'web_sim_reset',
        'web_editor_import_cad', 'web_editor_save', 'web_layout_place', 'web_plc_run',
        // plan-394: writes rv_extras into the document and thence into the GLB.
        'web_knowledge_set']) {
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

  /**
   * plan-706 T6 / R1 — the Mechanism ↔ Kinematic name collision.
   *
   * Two unrelated systems share a vocabulary: the rigid-body MECHANISM is a
   * joint graph with loop closure, the `Kinematic` is an axis GROUP. An agent
   * that picks the wrong one builds an unsolvable joint graph where a single
   * axis was wanted — and gets no error, because both requests are legal. With
   * sixteen mechanism tools sitting next to four kinematic ones, review
   * discipline is not a mitigation; a machine check is.
   */
  describe('mechanism vs. kinematic — the names must disambiguate themselves', () => {
    const mechanismTools = schemas.filter((s) => s.name.includes('mechanism'));
    const kinematicTools = schemas.filter((s) => /kinemati/i.test(s.name));

    it('there are tools on both sides of the collision', () => {
      expect(mechanismTools.length).toBeGreaterThan(10);
      expect(kinematicTools.length).toBeGreaterThan(2);
    });

    it('every mechanism description carries the demarcation', () => {
      const bad = mechanismTools
        .filter((s) => !(s.description.includes('NOT')
          && (s.description.includes('Kinematic') || s.description.includes('axis-group'))))
        .map((s) => s.name);
      expect(
        bad,
        `add "NOT the axis-group Kinematic system" to: ${bad.join(', ')}`,
      ).toEqual([]);
    });

    it('no mechanism description points at kinematize as if it were a synonym', () => {
      // `web_editor_kinematize` CREATES axis groups. Naming it inside a
      // mechanism description reads as "the same thing, other spelling"; the
      // demarcation points at the read tool instead.
      const bad = mechanismTools
        .filter((s) => s.description.includes('kinematize'))
        .map((s) => s.name);
      expect(bad, `these must reference web_editor_list_kinematics instead: ${bad.join(', ')}`)
        .toEqual([]);
    });

    it('the kinematic tools only mention mechanisms to send you away', () => {
      for (const s of kinematicTools) {
        if (!/mechanism/i.test(s.description)) continue;
        expect(
          /not a? (rigid-body )?mechanism|NOT the .*mechanism/i.test(s.description),
          `${s.name} mentions "mechanism" outside a demarcation`,
        ).toBe(true);
      }
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
