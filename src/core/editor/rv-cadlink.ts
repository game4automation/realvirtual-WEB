// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-cadlink — schema registration for the `CADLink` rv_extras component.
 *
 * CADLink is PURE METADATA on an imported CAD root: a reference to the
 * original CAD file (name + content hash) and the import parameters, mirroring
 * Unity's CADLink component (File / Quality / ImportScaleFactor / ZIsUpVector).
 * It enables the "Re-import CAD" flow — swap the geometry from a newer CAD
 * revision while every rv_extras component on matched subtree nodes survives.
 *
 * Schema-only registration: no factory, no live instance, no ticking. All
 * fields are read-only in the inspector (they are stamped by the import flow,
 * never hand-edited) and NOT authorable (never user-addable via Add Component).
 */

import { registerComponentSchema, loadSchemaFromSpec } from '../engine/rv-component-registry';

/** Purple-ish badge — distinct from drives (blue) and sensors. */
const CADLINK_BADGE_COLOR = '#7e57c2';

// Schema loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
registerComponentSchema('CADLink', loadSchemaFromSpec('CADLink'), {
  inspectorVisible: true,
  hierarchyVisible: true,
  hoverable: true,   // include the CAD subtree meshes in the grouped raycast BVH
  selectable: true,  // canvas click selects the import root
  hoverEnabledByDefault: true, // hover-type gate is snapshotted at model load
  badgeColor: CADLINK_BADGE_COLOR,
  filterLabel: null,
  authorable: false, // stamped by the import flow, never added by hand
});
