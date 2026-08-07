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
  inspectorVisible: true,
  hierarchyVisible: true,
  authorable: true, // appears in the asset editor's "Add Component" list
  badgeColor: GROUP_BADGE_COLOR,
});
