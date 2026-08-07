// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-jt-data — schema registration for the `JTData` rv_extras component (plan-335).
 *
 * JTData is CAD metadata the rv-jt reader extracts from a JT file: part name, mass, source
 * units, layer and the stable per-body uid. It is PURE IMPORT PROVENANCE — it describes the
 * geometry that was imported, not a decision the user made. Hence:
 *
 *   - schema-only registration (like `CADLink`): no factory, no live instance, no ticking.
 *     A factory would instantiate on EVERY matching node — 2441 of them in the reference
 *     assembly — for data that is only ever displayed.
 *   - every field read-only, and `authorable: false`: it is written by the importer, never
 *     added or edited by hand.
 *   - replaced, not merged, on CAD re-import (see rv-cadlink-reimport.ts) — the new revision
 *     always wins.
 *
 * Every field is optional. The reader omits what the source file does not provide rather than
 * emitting `0`/`null`, so a block carrying only `ContractVersion` and `Layer` is normal.
 *
 * NOTE: this module only takes effect through a side-effect import — see
 * `src/plugins/asset-editor/index.ts`. Without it the registration never runs.
 */

import { registerComponentSchema, loadSchemaFromSpec } from '../engine/rv-component-registry';

/** Slate/steel badge — metadata, deliberately quieter than functional components. */
const JTDATA_BADGE_COLOR = '#78909c';

// Schema loaded from the rv-ODT specification (schema/v1/rv-odt.json).
registerComponentSchema('JTData', loadSchemaFromSpec('JTData'), {
  inspectorVisible: true,
  hierarchyVisible: false, // metadata on many nodes — would flood the hierarchy filter
  hoverable: false,
  selectable: false,
  badgeColor: JTDATA_BADGE_COLOR,
  filterLabel: null,
  authorable: false, // stamped by the JT import, never added by hand
});
