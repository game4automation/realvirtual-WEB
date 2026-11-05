// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2025 realvirtual GmbH <https://realvirtual.io>

import type { Mesh, Object3D } from 'three';
import type { NodeRegistry } from '../engine/rv-node-registry';
import { chunkMetaOf, RV_SYNTHETIC_KEY } from '../engine/rv-bake-chunk';
import { RV_ORIG_NAME_KEY } from '../engine/rv-authored-keys';

export type PrimIdentity = Readonly<Partial<Record<'address' | 'runtime' | 'origin' | 'partition' | 'template', string>>>;
export type PrimAddressRegistry = Pick<NodeRegistry, 'getAddressForNode'>;

/** Snapshot address table; runtime objects remain distinct from document nodes. */
export function primIdentityAddress(identity: PrimIdentity | undefined): string | null {
  if (!identity) return null;
  if (identity.runtime === 'partition') return `runtime:partition@${identity.origin ?? '-'}/${identity.partition}`;
  if (identity.runtime === 'chunk') return `runtime:chunk@${identity.origin ?? '-'}`;
  if (identity.runtime === 'mu') return `runtime:mu@${identity.address ?? identity.template ?? '-'}`;
  return identity.address ?? null;
}
export interface PrimIdentityOptions {
  writeAddresses?: boolean;
  /** MU identity comes from inventory, never from clone-carried userData. */
  mu?: { preplaced: boolean; template?: Object3D | null };
}

/** ID3: references come only from the registry; no names, ids, seeds or path guesses. */
export function primIdentityForNode(node: Object3D, registry: PrimAddressRegistry, options: PrimIdentityOptions = {}): PrimIdentity | undefined {
  if (options.writeAddresses === false) return undefined;
  if (options.mu) {
    if (options.mu.preplaced) {
      const address = registry.getAddressForNode(node);
      return address ? { runtime: 'mu', address } : undefined;
    }
    const template = options.mu.template ? registry.getAddressForNode(options.mu.template) : null;
    return template ? { runtime: 'mu', template } : undefined;
  }
  const mesh = node as Mesh;
  const chunk = mesh.isMesh && chunkMetaOf.has(mesh.geometry);
  const partition = node.userData[RV_SYNTHETIC_KEY] === true;
  if (chunk || partition) {
    let parent = node.parent;
    while (parent) {
      const parentMesh = parent as Mesh;
      if (!parent.userData[RV_SYNTHETIC_KEY] && !(parentMesh.isMesh && chunkMetaOf.has(parentMesh.geometry))) {
        const origin = registry.getAddressForNode(parent);
        if (origin) return chunk ? { runtime: 'chunk', origin } : {
          runtime: 'partition', origin, partition: node.userData[RV_ORIG_NAME_KEY] ?? node.name,
        };
      }
      parent = parent.parent;
    }
    return undefined;
  }
  const address = registry.getAddressForNode(node);
  return address ? { address } : undefined;
}
