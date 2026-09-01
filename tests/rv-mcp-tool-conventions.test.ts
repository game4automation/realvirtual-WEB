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
  'layout', 'scene', 'editor', 'des', 'plc',
  // plan-394. Deliberately NOT folded into `node`: that domain means structural
  // navigation throughout (find/tree/bounds), and a durable note is not that.
  'knowledge',
  // 2026-08-19 rework — asset = document = model, ONE concept. `document` is
  // the domain for the project's GLB documents (list/open/save/new/update);
  // `catalog` is the planner's placeable parts catalogue (the former
  // `web_library_*` pair). The old `model` and `library` domains are gone; a
  // PROJECT still decides what project-relative paths resolve against, a
  // DOCUMENT is what is loaded in the viewport.
  'document', 'catalog', 'project',
  // plan-437 — `web_link_compose` composes deep-link URLs INTO the viewer. Not
  // folded into `scene`/`model`: those domains OPEN something, and handing out
  // an address for it is the opposite direction. A domain rather than a root
  // tool because the name parses as domain+action anyway and leaves room for
  // later `web_link_*` tools.
  'link',
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
    // 137 → 138 with `web_link_compose` (plan-437 Phase 2).
    // 138 → 140 with `web_camera_fly` and `web_view_sweep` (plan-705). Counted
    // from the code, not taken from the plan — the plan was written when this
    // line still read 111, and 705/706/707 all edit it.
    // 140 → 143 with plan-713 Phase 2: `web_library_assets`, `web_library_update`
    // (McpSceneTools) and `web_editor_project_files` (McpEditorTools). Three NEW
    // tools, unlike the Phase-1 move, which left this line alone on purpose.
    // 143 → 145 → 143 with plan-713 Phase 3: `web_editor_descend` / `_back` added
    // (F10), `web_scene_open` / `web_scene_list` retired (F8). Net zero, and the
    // coincidence is worth stating so nobody reads the unchanged number as "no
    // Phase-3 change reached the roster".
    // 143 -> 144 with plan-713 Phase 4: `web_camera_view` (F9).
    // 144 -> 143 with the 2026-08-19 terminology rework: `web_library_assets`
    // merged INTO `web_document_list` (one list — asset = document = model);
    // everything else was a hard rename (model/scene → document, library
    // catalogue → catalog, web_scene_export → web_layout_export).
    // 143 -> 145 with the project-tree rework (same day): `web_project_tree`
    // (navigate folders/documents as the dashboard shows them) and
    // `web_project_folder` (create/rename/move folders through the dashboard's
    // own tree verdicts and `applyTreeMove`).
    // 145 -> 147 with plan-722: `web_editor_list_circles` /
    // `web_editor_pivot_to_circle` (McpEditorTools). NOT mechanism tools despite
    // sharing `mechanism-snap.ts` — they belong to the axis-group Kinematic
    // workflow, which is why they carry no `mechanism` segment and do not move
    // the roster count in mechanism-mcp-inspect.test.ts.
    // 147 -> 145 with plan-724: both of those are gone again. The circle
    // ENUMERATION they were built on is deleted — Pivot to Circle is a hover
    // now, and a hover has no agent-callable half. `web_editor_mechanism_snap_list`
    // still returns `circle-center` candidates from the same fit maths, but
    // cursor-bound: there is no longer a way to list every bore of a path.
    expect(schemas.length).toBe(145);
  });

  /**
   * plan-724 T3 — the retirement itself, not just the arithmetic.
   *
   * A count is satisfied by any two tools disappearing, or by two appearing
   * while two others go. The names have to be asserted, or a later change that
   * happened to balance out would leave a dead tool announced to agents.
   */
  it('the retired circle tools stay gone', () => {
    const names = schemas.map((s) => s.name);
    expect(names).not.toContain('web_editor_list_circles');
    expect(names).not.toContain('web_editor_pivot_to_circle');
  });

  /**
   * plan-713 F3 — `destructiveHint` is announced, and only where it is meant.
   *
   * The hint's whole value is that it is rare: a client that shows a
   * confirmation for it must be able to trust that a tool carrying it can
   * destroy something the caller did not name. If every write carried it the
   * client would have to ignore it, which is the same as not having it.
   */
  describe('destructive classification', () => {
    const destructive = schemas.filter((s) => s.annotations?.destructiveHint === true);

    it('web_document_update is a destructive write', () => {
      const t = schemas.find((s) => s.name === 'web_document_update');
      expect(t, 'web_document_update must exist').toBeTruthy();
      expect(t!.annotations?.readOnlyHint).toBe(false);
      expect(t!.annotations?.destructiveHint).toBe(true);
    });

    it('nothing read-only is marked destructive', () => {
      const bad = destructive.filter((s) => s.annotations?.readOnlyHint === true).map((s) => s.name);
      expect(bad, `read-only tools cannot be destructive: ${bad.join(', ')}`).toEqual([]);
    });

    it('the hint stays rare — every carrier is listed here deliberately', () => {
      expect(destructive.map((s) => s.name).sort()).toEqual(['web_document_update']);
    });
  });

  /**
   * plan-713 F2, renamed 2026-08-19 — the two listings answer different questions.
   *
   * `web_catalog_list` is the placeable PLANNER CATALOGUE (`catalogId` —
   * templates you can place); `web_document_list` is the project's own GLB
   * documents. They were a single tool in the plan until the review found the
   * double semantics, so the separation is pinned here rather than left to the
   * descriptions.
   */
  it('the catalogue listing and the document listing stay distinct', () => {
    const catalogue = schemas.find((s) => s.name === 'web_catalog_list');
    const documents = schemas.find((s) => s.name === 'web_document_list');
    expect(catalogue?.description).toContain('catalogId');
    expect(documents?.description).toContain('document');
    expect(Object.keys(documents!.inputSchema.properties)).not.toContain('catalogId');
    expect(documents!.annotations?.readOnlyHint).toBe(true);
  });

  // plan-707 — the instance list is shared now, and the whole point of sharing it
  // is that a delegate cannot be announced, linted and documented from three
  // different lists. This pins the count of that ONE list.
  it('the shared instance list covers every linted delegate', () => {
    const names = new Set(schemas.map((s) => s.name));
    for (const t of ['web_status', 'web_view_pick', 'web_render', 'web_editor_open',
      'web_signal_bind', 'web_knowledge_set', 'web_describe', 'web_help',
      // plan-716 Phase 5 — the announced-but-unlinted delegate. `web_document_list`
      // is THE one document list; leaving it out of this list left it out of
      // the generated reference too, which is where an agent looks for it.
      'web_document_list', 'web_document_open', 'web_project_list', 'web_project_open',
      'web_ping',
      // plan-437 — the link composer. Announced and documented from this one
      // list like everything else.
      'web_link_compose']) {
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
        'web_describe',
        // plan-437: composing a URL is string work over live getters — it opens
        // nothing, mints no share and moves no viewport.
        'web_link_compose']) {
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
      'web_components_by_type', 'web_view_bounds',
      // plan-713 F8 — the two genuine duplicate pairs. One implementation each,
      // reachable under a second name that bought nothing but a second thing
      // for an agent to choose between.
      'web_scene_open',   // → web_document_open
      'web_scene_list',   // → web_document_list
      // 2026-08-19 rework — asset = document = model, hard rename, no aliases.
      'web_model_list',      // → web_document_list
      'web_model_open',      // → web_document_open
      'web_scene_save',      // → web_document_save
      'web_scene_new',       // → web_document_new
      'web_scene_export',    // → web_layout_export (it exports the planner snapshot)
      'web_library_assets',  // merged into web_document_list
      'web_library_update',  // → web_document_update
      'web_library_list',    // → web_catalog_list
      'web_library_describe']) { // → web_catalog_describe
      expect(names.has(gone), `${gone} should be renamed/removed`).toBe(false);
    }
  });

  /**
   * What the retirements replaced the old names WITH must still be there.
   *
   * A superseded entry says a name is gone; on its own that is also satisfied by
   * deleting the capability. Pinning the replacements is what stops a later
   * cleanup pass from removing a capability in the belief it is removing an
   * alias.
   */
  it('the retired names have live replacements', () => {
    const names = new Set(schemas.map((s) => s.name));
    for (const kept of ['web_document_list', 'web_document_open', 'web_document_save',
      'web_document_new', 'web_document_update', 'web_catalog_list',
      'web_catalog_describe', 'web_layout_export']) {
      expect(names.has(kept), `${kept} replaces a retired name and must exist`).toBe(true);
    }
  });
});
