// SPDX-License-Identifier: AGPL-3.0-only
// Copyright (C) 2026 realvirtual GmbH <https://realvirtual.io>
import type { Object3D } from 'three';

/**
 * plan-2059 D7: the `desAddresses` source of a headless/test host (no
 * NodeRegistry — `registry: null` keeps every other side effect off). Test
 * addresses are `#<name>` (`#<name>:2` for a repeated name), assigned by node
 * identity, never guessed from paths.
 *
 * Nodes under `root` (taken once, at construction) form the authored scene the
 * fingerprint hashes (`forEachNode`). Any other node asked for an address gets
 * one lazily (programmatic test instances) but is not part of that scene —
 * runtime-created nodes must never change the model hash between bind and
 * capture.
 */
export function testAddressRegistry(root?: Object3D): {
  getAddressForNode(node: Object3D): string;
  forEachNode(fn: (path: string, node: Object3D) => void): void;
} {
  const addresses = new Map<Object3D, string>();
  const used = new Set<string>();
  const assign = (node: Object3D): string => {
    let address = addresses.get(node);
    if (address) return address;
    const base = '#' + node.name;
    address = base;
    for (let suffix = 2; used.has(address); suffix++) address = `${base}:${suffix}`;
    addresses.set(node, address);
    used.add(address);
    return address;
  };
  const authored: Object3D[] = [];
  root?.traverse((node) => { authored.push(node); assign(node); });
  return {
    getAddressForNode: assign,
    forEachNode: (fn) => { for (const node of authored) fn(addresses.get(node)!, node); },
  };
}
