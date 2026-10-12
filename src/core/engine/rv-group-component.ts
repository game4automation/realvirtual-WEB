// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-group-component.ts — Schema registration for the Group component.
 *
 * Group mirrors Unity's realvirtual.Group: a pure-metadata component that tags
 * a node as belonging to a named group (GroupsOverlay visibility/isolate).
 * Multiple Group components per node are supported via the `_N` key dedup
 * convention (`Group`, `Group_1`, `Group_2`, …).
 *
 * Schema-only, no factory (CADLink pattern): the GroupRegistry — not a
 * per-node component instance — is the runtime representation. It is built at
 * scene load by buildGroups() and kept in sync during editing by
 * rv-group-sync.ts (asset-editor executor hook).
 */

import { registerComponentSchema } from './rv-component-registry';

/** Green badge — matches the "organization" role of groups. */
export const GROUP_BADGE_COLOR = '#66bb6a';

// Mirrors the rv-ODT structure `Group` $def in schema/v1/rv-odt.json.
registerComponentSchema('Group', {
  GroupName: { type: 'string', default: 'Group' },
  // Node-path reference resolved at load time (prefixNode.name + GroupName).
  // Readonly + no default: shown when present in the GLB, never stamped on
  // newly authored components.
  GroupNamePrefix: { type: 'string', readonly: true },
}, {
  authorable: true, // appears in the asset editor's "Add Component" list
  // plan-754 1c (Vincent 2026-09-21): a Group is pure metadata. The Mauser
  // carries 17456 of them, down to single solids — as `chunk` that made 10737
  // chunk meshes / ~10 fps, and as `select` a pick owner per solid. So it owns
  // no boundary (`bake: 'merge'`) and owns no segment (`pick: 'none'`).
  // Hide/isolate still work in a baked model, because a Group PARTITIONS the
  // chunk of its boundary instead (plan-755 D2): the `Group` pre-bake hook
  // (`onPreBakeGroup`, rv-pre-bake-hooks.ts) stamps the resolved group name as a
  // partition label (`RV_PARTITION_KEY`), the bake keys chunks by boundary ×
  // label combination × material, and the template gets one partition object
  // per boundary and combination carrying `Group` extras — which `GroupRegistry`
  // hides/isolates like any member. Labels on the boundary node itself do not
  // partition: the boundary is a member anyway (plan-755 D12).
  pick: 'none',
  bake: 'merge',
  // plan-755 D7: a Group alone does not keep its node alive through the bake
  // (12706 group-only nodes on the Mauser). The node survives only as reference
  // target (`GroupNamePrefix`), plugin claim, snap, keep mesh or ancestor of a
  // survivor — or because it ALSO carries a real component. Applies to the
  // `Group_N` dedup keys too (`claimsNodeOf`).
  claimsNode: false,
  ui: { badge: GROUP_BADGE_COLOR },
});
