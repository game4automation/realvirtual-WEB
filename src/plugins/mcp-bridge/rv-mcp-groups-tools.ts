// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>

/**
 * MCP tools for the Groups list of the Display panel (2026-09-24).
 *
 * The panel shows `GroupRegistry.getAll()` minus the persisted exclusion list
 * (`rv-group-visibility.excludedFromOverlay`). Until now nothing outside the
 * browser could say what the panel LISTS, so a group that was hidden by the
 * exclusion (the pick-and-place cell `Cover`, auto-excluded by the old "every kinematic
 * group" rule) could only be diagnosed by hand. `web_group_list` reports the
 * registry, the kinematic flags and the panel's own filter together;
 * `web_group_set_visible` toggles a group exactly like the eye in the panel.
 */
import type { RVViewer } from '../../core/rv-viewer';
import { loadGroupVisibilitySettings } from '../../core/hmi/group-visibility-store';
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

export class GroupQueries {
  constructor(private readonly getViewer: () => RVViewer | undefined) {}

  private get viewer(): RVViewer | undefined {
    return this.getViewer();
  }

  /** Read-only command body; preserves the original JSON value contract. */
  async queryGroupList(): Promise<string> {
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


}
