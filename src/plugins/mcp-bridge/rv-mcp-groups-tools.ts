// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * MCP tools for the Groups list of the Display panel (2026-09-24).
 *
 * The panel shows `GroupRegistry.getAll()` minus the persisted exclusion list
 * (`rv-group-visibility.excludedFromOverlay`). Until now nothing outside the
 * browser could say what the panel LISTS, so a group that was hidden by the
 * exclusion (the Festo `Cover`, auto-excluded by the old "every kinematic
 * group" rule) could only be diagnosed by hand. `web_group_list` reports the
 * registry, the kinematic flags and the panel's own filter together;
 * `web_group_set_visible` toggles a group exactly like the eye in the panel.
 */
import type { RVViewer } from '../../core/rv-viewer';
import { McpTool, McpParam } from '../../core/engine/rv-mcp-tools';
import { loadGroupVisibilitySettings, saveGroupVisibilitySettings } from '../../core/hmi/group-visibility-store';
import { collectKinematicGroupNamesLive } from '../../core/engine/rv-group-sync';

export interface GroupListRow {
  name: string;
  members: number;
  visible: boolean;
  /** Integrated by a `Kinematic` (structure or rigid group) — load-time mark OR live scan (plan-760 F14). */
  kinematic: boolean;
  /** In the Display panel's Groups list, or hidden by the exclusion filter. */
  listed: boolean;
}

export class McpGroupsTools {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined {
    return this.getViewer();
  }

  @McpTool(
    'Groups of the loaded model as the Display panel sees them: name, members, visible, kinematic, '
    + 'and `listed` (false = hidden by the panel\'s persisted exclusion filter, returned as `excluded`).',
    { readOnly: true },
  )
  async webGroupList(): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const groups = v.groups;
    if (!groups) return JSON.stringify({ error: 'No group registry (no model loaded)' });
    const settings = loadGroupVisibilitySettings();
    const excluded = settings.excludedFromOverlay ?? [];
    // plan-760 F14: the load-time flag OR the live Kinematic scan — the OR keeps
    // baked HMI models (loader-marked groups) as before and fixes the staleness
    // after a Kinematic added or a group renamed in this session.
    const live = collectKinematicGroupNamesLive(v.currentModelRoot ?? null, v.registry);
    const rows: GroupListRow[] = groups.getAll().map((g) => ({
      name: g.name,
      members: g.nodes.length,
      visible: g.visible,
      kinematic: groups.isKinematic(g.name) || live.has(g.name),
      listed: !excluded.includes(g.name),
    }));
    return JSON.stringify({
      count: rows.length,
      listed: rows.filter((r) => r.listed).length,
      excluded,
      autoExcludedKinematic: settings.autoExcludedKinematic ?? null,
      isolated: groups.isolatedGroupName,
      groups: rows,
    });
  }

  @McpTool(
    'Show or hide one group — the eye in the Display panel\'s Groups list. Names from web_group_list.',
    { readOnly: false },
  )
  async webGroupSetVisible(
    @McpParam('name', 'Group name as web_group_list reports it') name: string,
    @McpParam('visible', 'true = show, false = hide', 'boolean') visible: boolean,
  ): Promise<string> {
    const v = this.viewer;
    if (!v) return JSON.stringify({ error: 'No viewer' });
    const groups = v.groups;
    if (!groups) return JSON.stringify({ error: 'No group registry (no model loaded)' });
    const info = groups.get(name);
    if (!info) return JSON.stringify({ error: `Unknown group "${name}"`, known: groups.getGroupNames() });
    groups.setVisible(name, visible);
    // Exactly what the panel's eye does (GroupsListContent.handleToggle): an
    // active auto-filter isolation is dropped, both isolates are cleared in
    // the store, hidden names are persisted, so the state survives the next
    // model load (editor ↔ HMI). The store write refreshes an open panel.
    if (v.autoFilters?.isIsolateActive) v.autoFilters.showAll();
    v.markShadowsDirty();
    v.markRenderDirty();
    const settings = loadGroupVisibilitySettings();
    saveGroupVisibilitySettings({
      ...settings,
      hiddenGroups: groups.getAll().filter(g => !g.visible).map(g => g.name),
      isolatedGroup: null,
      isolatedAutoFilter: null,
    });
    return JSON.stringify({ ok: true, name, visible: groups.get(name)?.visible ?? visible, members: info.nodes.length });
  }

  @McpTool(
    'List a group in the Display panel again (remove it from the persisted exclusion filter) or '
    + 'exclude it; takes effect when the panel refreshes.',
    { readOnly: false },
  )
  async webGroupSetListed(
    @McpParam('name', 'Group name') name: string,
    @McpParam('listed', 'true = list it (remove from exclusion), false = exclude it', 'boolean') listed: boolean,
  ): Promise<string> {
    const settings = loadGroupVisibilitySettings();
    const excluded = new Set(settings.excludedFromOverlay ?? []);
    const auto = new Set(settings.autoExcludedKinematic ?? []);
    // Either direction is a MANUAL decision: the name leaves the auto-owned
    // set, so a later load neither re-adds nor releases it on its own.
    auto.delete(name);
    if (listed) excluded.delete(name); else excluded.add(name);
    settings.excludedFromOverlay = [...excluded];
    settings.autoExcludedKinematic = [...auto];
    saveGroupVisibilitySettings(settings);
    return JSON.stringify({ ok: true, name, listed, excluded: settings.excludedFromOverlay });
  }
}
