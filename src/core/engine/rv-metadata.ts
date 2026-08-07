// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * rv-metadata.ts — RuntimeMetadata component (Unity `RuntimeMetadata.cs`).
 *
 * Carries an XML-like `content` string that drives the hover tooltip (parsed by
 * MetadataTooltipContent). Authored on any object — typically an assembly/part
 * root — to annotate it with a name, values and links.
 *
 * This is a first-class factory component (like TransportSurface): it is
 * auto-discovered via `registerComponent`, gets an AABB (`needsAABB`) so the
 * standard hover/highlight + selection pipeline has correct bounds, and is
 * hoverable/selectable. Earlier this type was special-cased in the scene loader
 * (hand-stamped `_rvMetadata`, no AABB, no instance, registered under the wrong
 * type key) which produced wrong/oddly-bounded highlights.
 *
 * Tooltip + search keep resolving off `node.userData._rvMetadata` (see
 * MetadataTooltipContent) rather than this instance, because RuntimeMetadata
 * commonly COEXISTS with another component (Drive, Pipe, …) on the same node and
 * only one `_rvComponentInstance` wins. This component therefore still stamps
 * `_rvMetadata` so those consumers work regardless of which component owns the
 * instance.
 */

import type { Object3D } from 'three';
import {
  registerComponent,
  registerCapabilities,
  setComponentInstance,
  loadSchemaFromSpec,
  type RVComponent,
  type ComponentContext,
  type ComponentSchema,
} from './rv-component-registry';
import type { AABB } from './rv-aabb';
import { NodeRegistry } from './rv-node-registry';

//! RuntimeMetadata — tooltip/annotation content for an object in the WebViewer.
export class RVMetadata implements RVComponent {
  static readonly type = 'RuntimeMetadata';
  static readonly tooltipType = 'metadata';
  static readonly displayName = 'Metadata';

  // Loaded from the rv-ODT specification (schema/v1/rv-odt.json, plan-187).
  static readonly schema: ComponentSchema = loadSchemaFromSpec('RuntimeMetadata');

  readonly node: Object3D;
  readonly aabb: AABB | null;
  isOwner = true;

  /** XML-like annotation string exported from Unity's RuntimeMetadata. */
  content = '';

  constructor(node: Object3D, aabb: AABB | null) {
    this.node = node;
    this.aabb = aabb;
  }

  init(_context: ComponentContext): void {
    // Nothing to initialize — userData contract is stamped in afterCreate (below)
    // once applySchema has populated `content`.
  }

  /** Tooltip data for standalone lookups. The live hover tooltip resolves off
   *  `_rvMetadata` (see MetadataTooltipContent) so it also fires on nodes where
   *  another component owns `_rvComponentInstance`. */
  getTooltipData(): { type: 'metadata'; nodePath: string; content: string } {
    return { type: 'metadata', nodePath: NodeRegistry.computeNodePath(this.node), content: this.content };
  }
}

// Self-register for auto-discovery by the scene loader.
registerComponent({
  type: RVMetadata.type,
  displayName: RVMetadata.displayName,
  schema: RVMetadata.schema,
  needsAABB: true,
  capabilities: {
    authorable: true,   // addable in the asset editor (schema-complete)
    hoverable: true,
    selectable: true,
    tooltipType: 'metadata',
    badgeColor: '#ffb74d',
    filterLabel: 'Metadata',
    hoverEnabledByDefault: true,
    hoverPriority: 8,
    pinPriority: 3,
  },
  create: (node, aabb) => new RVMetadata(node, aabb),
  // Runs after applySchema — `content` is populated here. Keep the userData
  // contract other code depends on (_rvMetadata for tooltip/search/order-manager;
  // _rvType for display + raycast type resolution).
  afterCreate: (inst, node) => {
    const meta = inst as RVMetadata;
    node.userData._rvMetadata = { content: meta.content };
    setComponentInstance(node, meta);
    // Only claim the display type when no other component already set it —
    // RuntimeMetadata coexists with Drive/Pipe/etc. and must not clobber them.
    if (!node.userData._rvType) node.userData._rvType = 'Metadata';
  },
});

// registerComponent registers capabilities under `type` ('RuntimeMetadata') only.
// Also register under the display name so lookups keyed on `_rvType='Metadata'`
// (raycast geometry findContentAncestor, inspector helpers) resolve as hoverable.
registerCapabilities('Metadata', {
  hoverable: true,
  selectable: true,
  tooltipType: 'metadata',
  badgeColor: '#ffb74d',
  filterLabel: 'Metadata',
  hoverEnabledByDefault: true,
  hoverPriority: 8,
  pinPriority: 3,
});
