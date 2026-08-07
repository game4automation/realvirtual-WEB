// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

/**
 * aas-link.ts — attach a standard Asset Administration Shell (AAS) link to a
 * scene node at runtime, using the SAME representation the GLB loader emits for
 * an authored Unity `AASLink` component (rv-scene-loader.ts).
 *
 * Two userData fields make a node show AAS data — there is NO bespoke per-
 * component field involved:
 *   • node.userData.realvirtual.AASLink = { AASId, Description }
 *       → GenericTooltipController iterates realvirtual keys and matches
 *         getCapabilities('AASLink').tooltipType === 'aas'.
 *   • node.userData._rvAasLink = { aasId, description, serverUrl, gated }
 *       → the 'aas' data resolver reads this and the AAS panel / tooltip /
 *         sidebar / search / PDF-document UI all consume it unchanged.
 *
 * The AAS capability itself is registered by aas-link-plugin.tsx (a built-in
 * plugin), so the whole standard AAS UI lights up with no extra wiring.
 *
 * `gated: true` marks a library-attached drive datasheet (vs. an authored Unity
 * AASLink). The 'aas' resolver hides gated links while the layout planner is
 * active and documentation mode is off — outside the planner they are always
 * shown. The link is attached to the DRIVE / motorized nodes only (not the
 * component root), so the datasheet targets the motor and does not appear when
 * the whole component is selected. In plain viewing the drive node is the hover
 * target directly; in the planner a doc-mode raycast exception lets the drive
 * resolve to itself (instead of the whole placement) so its datasheet shows.
 */

import type { Object3D } from 'three';
import { markAasPending } from '../../plugins/aas-resolution';

/**
 * The standard gearmotor used by the transport library (conveyor / turntable /
 * chain-transfer drives). Resolves against public/aasx/index.json → the bundled
 * SEW AASX (26_SEW_KA47-DRN90M4.aasx) with its digital nameplate + datasheet.
 */
export const SEW_DRIVE_AAS = {
  aasId: 'https://demo.realvirtual.io/aas/sew/KA47-DRN90M4-Demo-0001',
  description: 'SEW KA47-DRN90M4',
} as const;

/**
 * Attach a gated (documentation-mode) AAS link to `node` (no-op for a null
 * node). Skips a node that already carries an AAS link so an explicit Unity
 * `AASLink` always wins over the library default. `_rvType` is intentionally
 * left untouched — these nodes are already typed (Drive / TransportSurface /
 * the LayoutObject root) and the AAS UI keys off the `realvirtual.AASLink`
 * map entry, not off `_rvType`.
 */
export function attachAasLink(node: Object3D | null, aasId: string, description: string): void {
  if (!node) return;

  const ud = node.userData as Record<string, unknown>;
  if (ud._rvAasLink) return; // respect an existing / authored AAS link

  const rv = (ud.realvirtual ?? (ud.realvirtual = {})) as Record<string, unknown>;
  if (rv.AASLink) return; // authored marker present — leave it
  rv.AASLink = { AASId: aasId, Description: description };

  ud._rvAasLink = { aasId, description, serverUrl: '', gated: true };
  // Synchronous, so an AAS node without a resolution marking never exists — an
  // unmarked node would be indistinguishable from a resolved one.
  markAasPending(node);
}

/**
 * True if a node's name marks it as motor / drive GEOMETRY that should carry the
 * drive datasheet (GLB-First naming contract). Matches "Motor"/"Antrieb" and the
 * library drive meshes ("DriveMesh", "DriveRotate", "DriveRolls") — but NOT the
 * `Drive-Lin/Rot-*` realvirtual Drive logic nodes, which contain the belt /
 * transport surface (tagging those would make the whole belt show the datasheet).
 */
export function isDriveDatasheetNode(name: string): boolean {
  return /motor|antrieb/i.test(name)
    || (/^drive/i.test(name) && !/^drive-(lin|rot)-[xyz]/i.test(name));
}

/**
 * Attach the standard SEW gearmotor datasheet to every motor/drive geometry node
 * (see isDriveDatasheetNode) in `root`. Used by BOTH load paths: the top-level
 * GLB loader (authored models) and the planner's placed-library-component scan —
 * since placed library items are loaded via a separate GLTFLoader path that does
 * not run the main scene loader.
 */
export function attachDriveDatasheets(root: Object3D): void {
  root.traverse((node) => {
    if (isDriveDatasheetNode(node.name || '')) {
      attachAasLink(node, SEW_DRIVE_AAS.aasId, SEW_DRIVE_AAS.description);
    }
  });
}
